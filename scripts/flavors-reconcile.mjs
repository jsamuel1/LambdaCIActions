#!/usr/bin/env node
// @ts-nocheck
/**
 * flavors-reconcile.mjs — `npm run flavors:reconcile` (ADR-049).
 *
 * Read-only drift report between the flavor CATALOG (`microvm/flavors.json`) and the LIVE
 * control plane of one environment:
 *
 *   catalog flavor ∙ live claim allowlist ∙ image-arn-<flavor> parameter ∙ real image state
 *
 * Why this exists: a catalog entry is a claim, not capacity. `microvm/flavors.json` defining
 * `python` and `docs/DEPLOY-M1.md` documenting its label prove nothing about the deployed
 * environment — on 2026-08-07 the dev plane advertised 7 flavors and could run 3, and the
 * only symptom was PRs sitting `QUEUED` for hours with no error in any log. There was no
 * command that would tell you. This is that command.
 *
 * Exit codes:
 *   0 — catalog and live state agree, and nothing is left to do
 *   1 — drift. With `--fix`, drift that REMAINS after remediating (verified by re-reading the
 *       plane, not by trusting that each build exited 0 — see the --fix block for why those are
 *       different facts)
 *   2 — usage error / could not read live state / a remediation failed. Includes an image probe
 *       we could not complete: an unreadable image is UNKNOWN, and reporting it as missing would
 *       be a confident verdict about a plane we never observed.
 *
 * The 1-vs-2 split is the whole point of this tool applied to itself: 1 means "I read the plane
 * and it disagrees with the catalog", 2 means "do not trust this report". A failure to read the
 * fleet or a failed build must never masquerade as ordinary drift.
 *
 * `--fix` moves in the SAFE direction ONLY:
 *   - `not_built` / `image_missing` / `image_failed` → build the image, then add the label
 *   - `label_missing`                                → add the label (image already verified)
 * It NEVER removes a label. Removing one takes routing away from jobs that may depend on it
 * right now, and "advertised but unbuildable" is a human decision (build it, or delete the
 * catalog entry) — see ADR-049.
 *
 * The verdicts come from src/shared/flavor-reconcile.ts (via dist/), which the console health
 * item on the Management API side must also consume when it lands, so the CLI and the UI cannot
 * disagree.
 *
 * Usage:
 *   npm run flavors:reconcile                       # dev, full check (needs the deploy pin)
 *   npm run flavors:reconcile -- --env dev --json
 *   npm run flavors:reconcile -- --no-image-check   # SSM params only, no microVM API calls
 *   npm run flavors:reconcile -- --fix              # deploy-touching; builds what is missing
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const ENV = args.env || 'dev';
let REGION = args.region || null;
const JSON_OUT = Boolean(args.json);
const FIX = Boolean(args.fix);
/**
 * Params-only mode: read the allowlist + `image-arn-*` parameters but do NOT call
 * `get-microvm-image`. For a caller whose credential has SSM read but not the microVM API
 * (the CD report step, ADR-049). Verdicts degrade to `image_unverified` rather than a falsely
 * confident `ok` — an unchecked image is unknown, not present.
 */
const NO_IMAGE_CHECK = Boolean(args['no-image-check']);
const SSM_PREFIX = `/lca/${ENV}`;
const LABELS_PARAM = `${SSM_PREFIX}/config/runner-labels`;

/**
 * Deploy-target pin (ADR-018/ADR-047), same rule as backfill-installs.mjs (ADR-037): this
 * reads LIVE state from one specific account+region, so an unpinned run against whatever
 * credentials happen to be ambient produces a confident report about the wrong environment.
 * A `ParameterNotFound` from the wrong region reads exactly like a missing flavor — that is
 * the misdiagnosis this pin prevents. There is no dry-run exemption: there is no dry run.
 */
async function guardDeployTarget() {
  let mod;
  try {
    mod = await import(path.join(REPO_ROOT, 'dist', 'lib', 'deploy-env.js'));
  } catch {
    console.error('ERROR: dist/lib/deploy-env.js not found — run `npm run build` first.');
    process.exit(2);
  }
  try {
    const target = mod.assertDeployTarget({ repoRoot: REPO_ROOT, region: REGION, env: ENV });
    REGION = target.region;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }
}

function awsJson(cliArgs) {
  const full = REGION ? [...cliArgs, '--region', REGION] : cliArgs;
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

function ssmGetOptional(name) {
  const r = awsJson(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text']);
  if (r.ok) return { value: r.stdout.trim(), absent: false };
  // `ParameterNotFound` is a fact about the parameter; anything else is a fact about our own
  // credential, and must NOT be reported as "nothing is claimed" (see classifySsmReadFailure).
  if (classifySsmRead(r.stderr) === 'absent') return { value: null, absent: true };
  console.error(
    `ERROR: could not read ${name} — ${(r.stderr || '').trim().split('\n')[0]}\n` +
      'This is NOT the same as an absent allowlist: an unreadable one would make every flavor ' +
      'report as unclaimed, which is a confident verdict about a parameter never read. Check the ' +
      'credential and the region.',
  );
  process.exit(2);
}

/**
 * Image probes we could not complete. Populated by `imageState`, and load-bearing: an
 * unreadable probe degrades that flavor to `image_unverified` instead of asserting the image is
 * gone, and it BLOCKS `--fix` (which would otherwise rebuild a healthy catalog on the strength
 * of an AccessDenied). Reported explicitly so the operator sees "could not check", never a
 * confident wrong verdict.
 */
const probeFailures = [];
let classifyProbe = () => 'unreadable';
/**
 * Same rule for the allowlist read. Defaults to `unreadable` so that a failure before the
 * shared module is loaded cannot be mistaken for an absent parameter.
 */
let classifySsmRead = () => 'unreadable';

/** All `/lca/<env>/config/image-arn-*` parameters, in one paged call. */
function readImageArns() {
  const out = {};
  let token = null;
  for (;;) {
    const cmd = ['ssm', 'get-parameters-by-path', '--path', `${SSM_PREFIX}/config/`, '--output', 'json'];
    if (token) cmd.push('--next-token', token);
    const r = awsJson(cmd);
    if (!r.ok) {
      console.error(`ERROR: could not read ${SSM_PREFIX}/config/ — ${r.stderr.trim()}`);
      process.exit(2);
    }
    const body = JSON.parse(r.stdout);
    for (const p of body.Parameters ?? []) {
      const m = /\/config\/image-arn-(.+)$/.exec(p.Name);
      if (m) out[m[1]] = p.Value;
    }
    token = body.NextToken ?? null;
    if (!token) return out;
  }
}

function imageState(imageArn) {
  const r = awsJson(['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn]);
  if (!r.ok) {
    // `absent` is a fact about the image; anything else is a fact about our own credential or
    // CLI, and must NOT be reported as a missing image (see classifyImageProbeFailure).
    if (classifyProbe(r.stderr) === 'absent') return null;
    probeFailures.push({ imageArn, stderr: (r.stderr || '').trim().split('\n')[0] });
    return undefined;
  }
  try {
    const state = JSON.parse(r.stdout).state;
    // Absence is a claim only `ResourceNotFoundException` can make. A 200 with no `state` is a
    // response we could not interpret, so it joins the probe failures and exits 2 with the
    // unparseable case — reporting it as `null` would render `image_missing`/`not_built`, which
    // carries safeFix:'build' and would have `--fix` rebuild a healthy image (ADR-049).
    if (typeof state === 'string' && state.length > 0) return state;
    probeFailures.push({ imageArn, stderr: 'get-microvm-image returned no `state` field' });
    return undefined;
  } catch {
    probeFailures.push({ imageArn, stderr: 'unparseable get-microvm-image response' });
    return undefined;
  }
}

/**
 * Enumerate ALL pages of non-terminated microVMs. `--fix` builds/updates images, and the
 * image-hook contract has a serialized skew window: a VM booting from an image being replaced
 * is the failure this refuses to race. Read-only reporting does not need this.
 *
 * Throws on a failed read — an unreadable fleet is not an empty one, and the caller maps that
 * to exit 2 rather than letting "could not look" read as ordinary drift.
 */
function nonTerminatedMicroVms(reconcile) {
  const live = [];
  let token = null;
  for (;;) {
    const cmd = ['lambda-microvms', 'list-microvms', '--output', 'json'];
    if (token) cmd.push('--next-token', token);
    const r = awsJson(cmd);
    if (!r.ok) throw new Error(`list-microvms failed: ${r.stderr.trim()}`);
    const body = JSON.parse(r.stdout);
    for (const vm of body.items ?? body.microvms ?? []) {
      // Same shared predicate the build script uses (src/shared/flavor-reconcile.ts): TERMINATED
      // is the only terminal `MicrovmState`, and an unrecognized state counts as live. Two copies
      // of this rule is how one of them stops matching the service model.
      if (reconcile.isLiveMicroVmState(vm.state)) live.push(vm);
    }
    token = body.nextToken ?? body.NextToken ?? null;
    if (!token) return live;
  }
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${r.status}`);
}

const SEV_MARK = { ok: '✓', warn: '!', blocked: '✗' };

function printTable(report, labels) {
  const w = (s, n) => String(s ?? '').padEnd(n);
  console.log(`\nLambdaCIActions flavor reconcile — env=${ENV} region=${REGION}`);
  console.log(
    `claim allowlist (${LABELS_PARAM}): ${labels.value ?? '(parameter absent — seed it: docs/DEPLOY-M1.md phase 0)'}`,
  );
  if (NO_IMAGE_CHECK) {
    console.log('mode: --no-image-check (SSM parameters only; image existence NOT verified)');
  }
  console.log('');
  console.log(`  ${w('flavor', 9)}${w('label', 20)}${w('claimed', 9)}${w('arn', 6)}${w('image', 14)}status`);
  console.log(`  ${'-'.repeat(9)}${'-'.repeat(20)}${'-'.repeat(9)}${'-'.repeat(6)}${'-'.repeat(14)}${'-'.repeat(18)}`);
  for (const r of report.rows) {
    const claimed = r.labelClaimed === undefined ? '?' : r.labelClaimed ? 'yes' : 'NO';
    const arn = r.imageArn ? 'yes' : 'NO';
    const state = r.imageState === undefined ? '(unchecked)' : (r.imageState ?? 'ABSENT');
    console.log(
      `${SEV_MARK[r.severity]} ${w(r.name, 9)}${w(r.label, 20)}${w(claimed, 9)}${w(arn, 6)}${w(state, 14)}${r.health}`,
    );
  }
  console.log('');
  for (const r of report.rows) {
    if (r.severity === 'ok') continue;
    console.log(`${SEV_MARK[r.severity]} ${r.name}: ${r.detail}`);
    if (r.fix) console.log(`    fix: ${r.fix}`);
  }
  if (report.extraLabels.length) {
    console.log(
      `\nnote: allowlist labels claimed by no catalog flavor: ${report.extraLabels.join(', ')}. ` +
        'Not drift — a repo FlavorMap may route these (e.g. ubuntu-latest in adopt mode, ADR-030).',
    );
  }
  console.log(
    `\n${report.counts.ok} ok · ${report.counts.warn} warn · ${report.counts.blocked} blocked`,
  );
}

/**
 * Read the live plane once and derive the report.
 *
 * Extracted so `--fix` can re-observe after remediating instead of reasoning about the plane
 * from a pre-fix snapshot plus a child process's exit code. Those two are not the same fact:
 * `build-images` deliberately exits 0 when the allowlist parameter is absent (it refuses to
 * CREATE the parameter, because doing so from one flavor would drop every other label), so a
 * remediation can succeed by its own lights while adding no label at all.
 */
function observe(reconcile) {
  const labels = ssmGetOptional(LABELS_PARAM);
  const liveLabels = reconcile.parseRunnerLabels(labels.value);
  const claimed = new Set(liveLabels.map((l) => l.toLowerCase()));
  const arns = readImageArns();

  const observations = reconcile.catalogFlavors().map((f) => {
    const arn = arns[f.name] ?? null;
    return {
      name: f.name,
      labelClaimed: claimed.has(f.label.toLowerCase()),
      imageArn: arn,
      // undefined (not checked) vs null (checked, absent) is load-bearing — see the module.
      imageState: NO_IMAGE_CHECK ? undefined : arn ? imageState(arn) : null,
    };
  });

  return { labels, liveLabels, report: reconcile.reconcileFlavors(observations, liveLabels) };
}

async function main() {
  await guardDeployTarget();
  const reconcile = await import(path.join(REPO_ROOT, 'dist', 'src', 'shared', 'flavor-reconcile.js'));
  classifyProbe = reconcile.classifyImageProbeFailure;
  classifySsmRead = reconcile.classifySsmReadFailure;

  const { labels, liveLabels, report } = observe(reconcile);

  // With `--fix` the interesting document is the state AFTER remediation, and emitting two JSON
  // documents on one stdout would break any parser. So `--json` prints exactly one report: the
  // post-fix one when fixing, this one otherwise.
  if (JSON_OUT) {
    if (!FIX) {
      console.log(
        JSON.stringify(
          { env: ENV, region: REGION, labels: liveLabels, ...report, probeFailures },
          null,
          2,
        ),
      );
    }
  } else {
    printTable(report, labels);
  }

  // An unreadable image probe is not evidence about the plane, so it can neither be reported as
  // agreement nor acted on. Exit 2 ("could not read live state"), the same code as a failed SSM
  // read — a wrong-region/AccessDenied run must not look like a clean 0 or a diagnosable 1.
  if (probeFailures.length) {
    console.error(
      `\nERROR: ${probeFailures.length} image state probe(s) could not be completed — this ` +
        'report is INCOMPLETE. `get-microvm-image` failed for a reason other than ' +
        'ResourceNotFoundException, so those flavors are reported `image_unverified` rather ' +
        'than as missing images. Check the credential (the microVM API is separate from SSM) ' +
        'and that `aws` is >= 2.35.17 (`aws lambda-microvms help`).',
    );
    for (const f of probeFailures.slice(0, 10)) console.error(`  ${f.imageArn}: ${f.stderr}`);
    process.exit(2);
  }

  if (!FIX) process.exit(report.drift ? 1 : 0);

  // ---- --fix: safe direction only ------------------------------------------
  if (NO_IMAGE_CHECK) {
    console.error(
      '\nERROR: --fix requires the real image state; it cannot run with --no-image-check. ' +
        'Adding a label on the strength of an unverified parameter is the exact ordering ' +
        'violation ADR-049 forbids.',
    );
    process.exit(2);
  }
  const actionable = report.rows.filter((r) => r.safeFix);
  if (actionable.length === 0) {
    // Still exactly one document. Nothing was remediated, so the report already read above IS
    // the post-fix state — but `--json` suppressed it on the way in (to avoid printing two), so
    // emitting nothing here would leave a `--json --fix` caller with prose on stdout and no
    // document to reconcile against the exit code. Reachable on a healthy environment (every
    // row ok, exit 0) and on `image_building` (warn, no safe fix, exit 1) alike. Same key shape
    // as the post-fix document, with an empty `fixed`, so a consumer parses one schema.
    if (JSON_OUT) {
      console.log(
        JSON.stringify(
          { env: ENV, region: REGION, fixed: [], labels: liveLabels, ...report, probeFailures },
          null,
          2,
        ),
      );
    } else {
      console.log('\n--fix: nothing safely fixable.');
    }
    process.exit(report.drift ? 1 : 0);
  }

  // Quiesce gate. Building/updating an image while VMs are booting from it races the
  // serialized image-hook window; adding a label is comparatively cheap but is still a live
  // routing change, so one gate covers both.
  let live;
  try {
    live = nonTerminatedMicroVms(reconcile);
  } catch (e) {
    // An unreadable fleet is not a quiescent one, and it is not drift either.
    console.error(`\nERROR: could not read the microVM fleet — ${e.message}`);
    process.exit(2);
  }
  if (live.length > 0) {
    console.error(
      `\nERROR: ${live.length} non-terminated microVM(s) — refusing to touch images or the ` +
        'control plane. Wait for the fleet to drain and re-run.',
    );
    for (const vm of live.slice(0, 10)) console.error(`  ${vm.microvmId ?? '?'} ${vm.state ?? '?'}`);
    process.exit(2);
  }

  console.log('\n--fix: fleet is quiescent; applying safe remediations.');
  for (const r of actionable) {
    const flags = ['--env', ENV, '--region', REGION, '--flavor', r.name];
    if (r.safeFix === 'add-label') flags.push('--publish-label-only');
    console.log(`\n→ ${r.name} (${r.health}): build-images ${flags.join(' ')}`);
    try {
      run(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build-images.mjs'), ...flags]);
    } catch (e) {
      // A half-applied fix leaves the plane in a state this report no longer describes, so stop
      // and say so. Exit 2, not 1: the operator's next action is to read the failure, not to
      // read a drift table.
      console.error(`\nERROR: remediation for ${r.name} failed — ${e.message}`);
      console.error(
        'Stopping: later flavors were NOT attempted. Re-run `npm run flavors:reconcile` to see ' +
          'the current state before retrying.',
      );
      process.exit(2);
    }
  }
  // Re-OBSERVE rather than trust the remediations' exit codes against the pre-fix report.
  //
  // A child that exited 0 has not necessarily fixed anything: `build-images` deliberately exits
  // 0 when `runner-labels` is ABSENT — it publishes the image ARN, warns, and refuses to create
  // the parameter, because creating it from one flavor would drop every other label. On an
  // environment that skipped the phase-0 seed, every row is `label_missing`/`not_built`, so the
  // pre-fix `unfixable` set is empty; scoring the run against that snapshot would have reported
  // success after adding no label at all, leaving the whole catalog unrunnable. That is exactly
  // the "partially-remediated run cannot exit 0" rule (ADR-049 § 4c) failing on its own terms.
  //
  // Re-reading is a handful of API calls and it generalises: any remediation that silently
  // no-ops is caught, not just this one.
  console.log('\n--fix applied; re-reading live state to verify.');
  let after;
  try {
    after = observe(reconcile);
  } catch (e) {
    console.error(`\nERROR: could not re-read live state after --fix — ${e?.message ?? e}`);
    process.exit(2);
  }
  if (probeFailures.length) {
    console.error(
      `\nERROR: ${probeFailures.length} image state probe(s) could not be completed on the ` +
        'post-fix read, so whether the remediation worked is UNKNOWN. Re-run ' +
        '`npm run flavors:reconcile` once the credential/region is fixed.',
    );
    process.exit(2);
  }
  if (!JSON_OUT) printTable(after.report, after.labels);
  else
    console.log(
      JSON.stringify(
        {
          env: ENV,
          region: REGION,
          fixed: actionable.map((r) => ({ name: r.name, was: r.health, action: r.safeFix })),
          labels: after.liveLabels,
          ...after.report,
          probeFailures,
        },
        null,
        2,
      ),
    );

  const remaining = after.report.rows.filter((r) => r.severity !== 'ok');
  if (remaining.length > 0) {
    console.error(
      `\n${remaining.length} flavor(s) still drifted after --fix: ` +
        `${remaining.map((r) => `${r.name} (${r.health})`).join(', ')}.`,
    );
    // One cause is common enough to name, because the remediation cannot fix it and said so only
    // in a child process's log: with no allowlist parameter there is nothing to append a label to.
    if (after.labels.absent) {
      console.error(
        `${LABELS_PARAM} does not exist, so no label could be added. Seed it first ` +
          "(docs/DEPLOY-M1.md phase 0 — `--value 'lambda-ci'`), then re-run --fix.",
      );
    }
    process.exit(1);
  }
  console.log('\n--fix complete: catalog and live state now agree.');
}

// A thrown error anywhere above is an operational failure, not drift: exit 2 so a caller can
// tell "this report is untrustworthy" from "the plane disagrees with the catalog".
try {
  await main();
} catch (e) {
  console.error(`\nERROR: ${e?.message ?? e}`);
  process.exit(2);
}
