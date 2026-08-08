#!/usr/bin/env node
// @ts-nocheck
/**
 * flavors-reconcile.mjs — `npm run flavors:reconcile` (ADR-051).
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
 *   0 — catalog and live state agree (or every difference is a `warn` cleared by --fix)
 *   1 — drift
 *   2 — usage error / could not read live state (including an image probe we could not
 *       complete: an unreadable image is UNKNOWN, and reporting it as missing would be a
 *       confident verdict about a plane we never observed)
 *
 * `--fix` moves in the SAFE direction ONLY:
 *   - `not_built` / `image_missing` / `image_failed` → build the image, then add the label
 *   - `label_missing`                                → add the label (image already verified)
 * It NEVER removes a label. Removing one takes routing away from jobs that may depend on it
 * right now, and "advertised but unbuildable" is a human decision (build it, or delete the
 * catalog entry) — see ADR-051.
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
 * (the CD report step, ADR-051). Verdicts degrade to `image_unverified` rather than a falsely
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
    return JSON.parse(r.stdout).state ?? null;
  } catch {
    probeFailures.push({ imageArn, stderr: 'unparseable get-microvm-image response' });
    return undefined;
  }
}

/**
 * Enumerate ALL pages of non-terminated microVMs. `--fix` builds/updates images, and the
 * image-hook contract has a serialized skew window: a VM booting from an image being replaced
 * is the failure this refuses to race. Read-only reporting does not need this.
 */
function nonTerminatedMicroVms() {
  const live = [];
  let token = null;
  for (;;) {
    const cmd = ['lambda-microvms', 'list-microvms', '--output', 'json'];
    if (token) cmd.push('--next-token', token);
    const r = awsJson(cmd);
    if (!r.ok) throw new Error(`list-microvms failed: ${r.stderr.trim()}`);
    const body = JSON.parse(r.stdout);
    for (const vm of body.items ?? body.microvms ?? []) {
      const state = String(vm.state ?? '').toUpperCase();
      if (state !== 'TERMINATED' && state !== 'FAILED') live.push(vm);
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

async function main() {
  await guardDeployTarget();
  const reconcile = await import(path.join(REPO_ROOT, 'dist', 'src', 'shared', 'flavor-reconcile.js'));
  classifyProbe = reconcile.classifyImageProbeFailure;
  classifySsmRead = reconcile.classifySsmReadFailure;

  const labels = ssmGetOptional(LABELS_PARAM);
  const labelsValue = labels.value;
  const liveLabels = reconcile.parseRunnerLabels(labelsValue);
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

  const report = reconcile.reconcileFlavors(observations, liveLabels);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { env: ENV, region: REGION, labels: liveLabels, ...report, probeFailures },
        null,
        2,
      ),
    );
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
        'violation ADR-051 forbids.',
    );
    process.exit(2);
  }
  const actionable = report.rows.filter((r) => r.safeFix);
  if (actionable.length === 0) {
    console.log('\n--fix: nothing safely fixable.');
    process.exit(report.drift ? 1 : 0);
  }

  // Quiesce gate. Building/updating an image while VMs are booting from it races the
  // serialized image-hook window; adding a label is comparatively cheap but is still a live
  // routing change, so one gate covers both.
  const live = nonTerminatedMicroVms();
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
    run(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build-images.mjs'), ...flags]);
  }
  console.log('\n--fix complete. Re-run `npm run flavors:reconcile` to confirm.');
}

await main();
