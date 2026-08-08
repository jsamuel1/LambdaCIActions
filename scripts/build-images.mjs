#!/usr/bin/env node
// @ts-nocheck
/**
 * build-images.mjs — phase 2 of the deploy (spec 05 / ADR-011), corrected for the GA
 * `lambda-microvms` API (2025-09-09).
 *
 * For each flavor in microvm/flavors.json:
 *   1. Stage the flavor's Dockerfile.<flavor> as `Dockerfile` in a temp build context.
 *   2. Zip the microvm/ context.
 *   3. Upload the zip to the image code bucket (from ImageStack; discovered via SSM).
 *   4. `aws lambda-microvms create-microvm-image` from the uploaded context (requires a
 *      base image ARN + build role ARN + code-artifact uri). An image that already exists is
 *      UPDATED instead (a rebuild adds a version) — see `--rebuild`.
 *   5. Poll `get-microvm-image` until state=CREATED/UPDATED; prune old versions (keep last N).
 *   6. Publish the resulting image ARN to SSM: <ssmPrefix>/config/image-arn-<flavor>.
 *   7. ONLY THEN add the flavor's label to <ssmPrefix>/config/runner-labels (ADR-051).
 *
 * ## Step 7 is an ordering guarantee, not a convenience (ADR-051)
 *
 * The claim allowlist and the image are two independent pieces of live state, and the order
 * in which they are written decides which failure an operator gets:
 *
 *   - image, then label  → the flavor is unreachable until it is ready, then works. The
 *     intermediate state is a job that stays queued on GitHub and can still be run by a
 *     GitHub-hosted runner.
 *   - label, then image  → ingest CLAIMS the job (`shouldClaim` passes), provisioning then
 *     fails because there is no image, and the job has already lost its GitHub-hosted
 *     fallback. Strictly worse.
 *
 * So this script writes the image ARN first and refuses to add a label whose image is not in
 * a usable state (`mayClaimLabel`, src/shared/flavor-reconcile.ts — the same predicate the
 * reconcile CLI uses, and the one the console health item must use when it lands, so they
 * cannot disagree).
 *
 * Requires AWS CLI >= 2.35.17 (ships the `lambda-microvms` service). See
 * docs/specs/05-infrastructure.md § Toolchain prerequisites.
 *
 * Zero npm deps — Node built-ins + AWS CLI (matches create-github-app.mjs conventions).
 *
 * Usage:
 *   node scripts/build-images.mjs --env dev --region us-west-2   # whole catalog
 *   node scripts/build-images.mjs --env dev --all                # explicit whole catalog
 *   node scripts/build-images.mjs --env dev --flavor python       # one flavor (build/rebuild)
 *   node scripts/build-images.mjs --env dev --flavor node --rebuild
 *   node scripts/build-images.mjs --env dev --flavor go --skip-label
 *   node scripts/build-images.mjs --env dev --flavor python --publish-label-only
 *   node scripts/build-images.mjs --dry-run                       # print plan, no side effects
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MICROVM_DIR = path.join(REPO_ROOT, 'microvm');
const KEEP_VERSIONS = 3;

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
const ONLY_FLAVOR = args.flavor || null;
const DRY_RUN = Boolean(args['dry-run']);
const ALL = Boolean(args.all);
/**
 * Rebuild an already-published flavor (patch day / base Dockerfile change). Functionally the
 * update path already runs when the image exists, so this flag exists to make the INTENT
 * explicit in a runbook line and in the log — and, unlike a fresh build, it must never remove
 * the label: the flavor stays claimable across the rebuild, which is the whole point of
 * repointing the ARN only after the new version verifies.
 */
const REBUILD = Boolean(args.rebuild);
/** Add the label for an image that ALREADY exists and verifies. No build. */
const PUBLISH_LABEL_ONLY = Boolean(args['publish-label-only']);
/**
 * Build + publish the ARN but do NOT touch the allowlist. For staging capacity ahead of
 * advertising it (or for an env whose allowlist is managed elsewhere). Leaves `label_missing`
 * drift, which `npm run flavors:reconcile` reports and can safely fix later.
 */
const SKIP_LABEL = Boolean(args['skip-label']);
const SSM_PREFIX = `/lca/${ENV}`;
const LABELS_PARAM = `${SSM_PREFIX}/config/runner-labels`;

if (PUBLISH_LABEL_ONLY && SKIP_LABEL) {
  console.error('ERROR: --publish-label-only and --skip-label are contradictory.');
  process.exit(2);
}
if (ONLY_FLAVOR && ALL) {
  console.error('ERROR: --flavor and --all are contradictory.');
  process.exit(2);
}
if (PUBLISH_LABEL_ONLY && !ONLY_FLAVOR) {
  console.error('ERROR: --publish-label-only requires --flavor <name>.');
  process.exit(2);
}

// Deploy-target pin (ADR-018): refuse to touch AWS unless .env.local pins the account +
// region AND the ambient credentials actually resolve to that account. Dry runs exempt.
// The guard is TypeScript (lib/deploy-env.ts) so the CDK app shares it — hence dist/.
async function guardDeployTarget() {
  if (DRY_RUN) return;
  let mod;
  try {
    mod = await import(path.join(REPO_ROOT, 'dist', 'lib', 'deploy-env.js'));
  } catch {
    console.error('ERROR: dist/lib/deploy-env.js not found — run `npm run build` first.');
    process.exit(1);
  }
  try {
    // `env: ENV` binds the selected environment to the pin (ADR-033): publishing
    // prod-namespaced image ARNs into the dev account is the same boundary violation as a
    // cross-account deploy.
    const target = mod.assertDeployTarget({ repoRoot: REPO_ROOT, region: REGION, env: ENV });
    REGION = target.region; // pin wins; all aws() calls get --region <pin>
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

function aws(cliArgs, { capture = true } = {}) {
  const full = REGION ? [...cliArgs, '--region', REGION] : cliArgs;
  if (DRY_RUN) {
    console.log(`  [dry-run] aws ${full.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`aws ${full.slice(0, 2).join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function ssmGet(name) {
  const r = aws(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text']);
  return DRY_RUN ? `<${name}>` : r.stdout.trim();
}

function ssmPut(name, value) {
  aws(['ssm', 'put-parameter', '--name', name, '--value', value, '--type', 'String', '--overwrite']);
  console.log(`  ✓ published ${name}`);
}

/** Read a parameter that may not exist yet. Returns `{ value, absent }` — `absent:false` with a
 *  `null` value means the read FAILED for some other reason (AccessDenied, expired token), which
 *  is a different fact from an absent parameter and must not be reported as one. */
function ssmGetOptional(name, reconcile) {
  if (DRY_RUN) return { value: `<${name}>`, absent: false };
  const full = REGION
    ? ['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text', '--region', REGION]
    : ['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'];
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status === 0) return { value: r.stdout.trim(), absent: false };
  const absent = reconcile
    ? reconcile.classifySsmReadFailure(r.stderr) === 'absent'
    : false;
  return { value: null, absent, stderr: (r.stderr || '').trim().split('\n')[0] };
}

/**
 * Concrete image state: a state string, `null` when the API says the image does not exist, or
 * `undefined` when we could not find out (AccessDenied, expired token, throttling, an AWS CLI
 * with no `lambda-microvms` service). The three are different facts, and `ensureLabel` must not
 * tell an operator their freshly built image is "absent" when the truth is that we never asked
 * successfully — see classifyImageProbeFailure in src/shared/flavor-reconcile.ts.
 */
function imageState(imageArn, reconcile) {
  if (DRY_RUN) return 'CREATED';
  const full = REGION
    ? ['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn, '--region', REGION]
    : ['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn];
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    return reconcile.classifyImageProbeFailure(r.stderr) === 'absent' ? null : undefined;
  }
  try {
    return JSON.parse(r.stdout).state ?? null;
  } catch {
    return undefined;
  }
}

/**
 * Add a flavor's label to the live claim allowlist — the SECOND half of the ordering contract
 * (ADR-051), and only ever after its image verifies.
 *
 * Refuses rather than warns. `mayClaimLabel` requires a published ARN AND a usable state, so
 * an unverifiable image cannot be talked into a label write by a caller in a hurry: adding the
 * label first is what turns a recoverable queued job into a claimed job that dies in
 * provisioning with its GitHub-hosted fallback already given away.
 *
 * Append-only and idempotent (`addRunnerLabel`), so it preserves non-catalog labels an
 * operator put there for a FlavorMap (`ubuntu-latest`, ADR-030) and rewrites nothing when the
 * label is already present.
 */
function ensureLabel(flavor, imageArn, reconcile) {
  const state = imageState(imageArn, reconcile);
  if (!reconcile.mayClaimLabel({ imageArn, imageState: state })) {
    // `undefined` and `null` both refuse, but they are different diagnoses and the message must
    // say which: "absent" sends an operator to rebuild an image that may be perfectly fine.
    const why =
      state === undefined
        ? 'could NOT be read (credential or AWS CLI problem — the microVM API is separate ' +
          'from SSM, and `lambda-microvms` needs aws >= 2.35.17)'
        : `${state ?? 'absent'}, not a usable state (${[...reconcile.USABLE_IMAGE_STATES].join('/')})`;
    throw new Error(
      `refusing to add '${flavor.label}' to ${LABELS_PARAM}: image ${imageArn} is ${why}. ` +
        'Label-before-image would make ingest claim jobs it cannot run (ADR-051).',
    );
  }
  const current = ssmGetOptional(LABELS_PARAM, reconcile);
  if (current.value === null) {
    if (current.absent) {
      console.log(
        `  ! ${LABELS_PARAM} does not exist — seed it first (docs/DEPLOY-M1.md phase 0). ` +
          'Not creating it here: the parameter is the whole claim allowlist, and creating it ' +
          'from one flavor would silently DROP every label an operator had seeded.',
      );
      return false;
    }
    // Unreadable is not absent. Telling an operator to seed a parameter that may already hold
    // a full allowlist invites exactly the overwrite the branch above exists to prevent.
    throw new Error(
      `could not read ${LABELS_PARAM} (${current.stderr}) — this is NOT the same as the ` +
        'parameter being absent, so refusing to guess. Fix the credential/region and re-run; ' +
        `the image ARN is already published, so \`--publish-label-only\` will finish the job.`,
    );
  }
  const { value, changed } = reconcile.addRunnerLabel(current.value, flavor.label);
  if (!changed) {
    console.log(`  ✓ '${flavor.label}' already claimed in ${LABELS_PARAM}`);
    return false;
  }
  ssmPut(LABELS_PARAM, value);
  console.log(`  ✓ claimed '${flavor.label}' (image ${state}) → ${value}`);
  return true;
}

/**
 * The shared catalog-vs-live derivation (src/shared/flavor-reconcile.ts, via dist/). Imported
 * rather than reimplemented so this script, `flavors:reconcile` and the console cannot form
 * three different opinions about whether a flavor is runnable.
 */
async function loadReconcile() {
  try {
    return await import(path.join(REPO_ROOT, 'dist', 'src', 'shared', 'flavor-reconcile.js'));
  } catch {
    console.error(
      'ERROR: dist/src/shared/flavor-reconcile.js not found — run `npm run build` first.',
    );
    process.exit(1);
  }
}

function loadFlavors() {
  const catalog = JSON.parse(fs.readFileSync(path.join(MICROVM_DIR, 'flavors.json'), 'utf8'));
  let flavors = catalog.flavors;
  if (ONLY_FLAVOR) flavors = flavors.filter((f) => f.name === ONLY_FLAVOR);
  if (flavors.length === 0) throw new Error(`no flavor matched --flavor ${ONLY_FLAVOR}`);
  return flavors;
}

// Stage <dockerfile> as `Dockerfile` in a temp copy of microvm/, then zip it.
function stageAndZip(flavor) {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `lca-img-${flavor.name}-`));
  // shallow copy of microvm/ (Dockerfiles + bootstrap + flavors.json)
  cpDir(MICROVM_DIR, stageDir);
  const src = path.join(stageDir, flavor.dockerfile);
  if (!fs.existsSync(src)) throw new Error(`missing ${flavor.dockerfile} for flavor ${flavor.name}`);
  fs.copyFileSync(src, path.join(stageDir, 'Dockerfile'));

  const zipPath = path.join(os.tmpdir(), `lca-${flavor.name}-${Date.now()}.zip`);
  const r = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: stageDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`zip failed for ${flavor.name}: ${r.stderr}`);
  return { zipPath, stageDir };
}

function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function buildFlavor(flavor, ctx) {
  // The operator-facing shape line. `vcpu` is DESCRIPTIVE only (ADR-038) — the API takes no
  // vCPU request — so label it, or this log reads as "provisioned 4 vCPU" and re-creates the
  // exact misattribution ADR-038 corrects in docs/VERIFY-M3.md.
  console.log(
    `\n=== flavor: ${flavor.name} (${flavor.arch}, ${flavor.memoryMb}MB requested; ` +
      `${flavor.vcpu} vCPU descriptive-only) ===`,
  );
  if (flavor.arch !== 'arm64') {
    // AGENTS.md hard rule — microVMs are Graviton only.
    throw new Error(`flavor ${flavor.name} arch=${flavor.arch}; microVMs are arm64 only`);
  }

  const { zipPath } = stageAndZip(flavor);
  const key = `image-contexts/${flavor.name}/${path.basename(zipPath)}`;
  console.log(`  staged + zipped → ${zipPath}`);

  aws(['s3', 'cp', zipPath, `s3://${ctx.bucket}/${key}`]);
  console.log(`  uploaded → s3://${ctx.bucket}/${key}`);

  // Trigger the snapshot build via the GA lambda-microvms API (ADR-015). create-microvm-image
  // is NOT idempotent — a name that already exists returns ValidationException. So: if the
  // image already exists, UPDATE it (adds a new version); otherwise CREATE it. Both take the
  // base image ARN + build role + code-artifact uri and return { imageArn, imageVersion,
  // state:CREATING }; poll get-microvm-image for CREATED.
  const imageName = `lca-${ENV}-${flavor.name}`;
  const imageArnFull = `arn:aws:lambda:${ctx.region}:${ctx.accountId}:microvm-image:${imageName}`;
  const exists = imageExists(imageArnFull);
  const commonArgs = [
    '--base-image-arn',
    ctx.baseImageArn,
    '--build-role-arn',
    ctx.buildRoleArn,
    '--code-artifact',
    `uri=s3://${ctx.bucket}/${key}`,
    '--description',
    `LambdaCIActions ${flavor.name} flavor (${ENV})`,
    // Declare the hooks (ADR-012): our run-hook server listens on :8080. The `run` hook
    // receives the launch's runHookPayload at POST /run. The API REQUIRES the `ready` image
    // hook whenever any lifecycle hook is enabled — /ready signals init-complete so the
    // snapshot is taken in a ready state. Without run: RunMicrovm rejects the payload.
    '--hooks',
    JSON.stringify({
      port: Number(flavor.runHookPort ?? 8080),
      microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: 120 },
      // 60 s, NOT 30 s — and 60 is the API MAXIMUM, not a preference
      // (`MicrovmHooksRunTimeoutInSecondsInteger`: min 1, max 60, lambda-microvms 2025-09-09;
      // the image hooks' readyTimeoutInSeconds is separate and allows up to 3600 s). The boot
      // path's first act is a `jitconfig` call through the AWS CLI, and in a snapshot-resumed
      // guest that CLI is cold: the 2026-07-28 dev verification saw attempts 1 and 2 time out
      // on all three flavors and burn ~22 s of a 30 s deadline to get one success — i.e. the
      // retry loop had no margin left for a single slow attempt. Take the whole ceiling and
      // derive the retry budget down from it (run-hook.mjs: 2 × 15 s + 2 s = 32 s worst case,
      // pinned by test/run-hook.test.mjs, which also pins this 60 s cap). This is a CEILING,
      // not a delay: a healthy boot still ACKs in ~1 s, and an unhealthy VM is still capped —
      // by the Reaper's own 2 h lifetime cap, which is what bounds the paid idle time.
      microvmHooks: { run: 'ENABLED', runTimeoutInSeconds: 60 },
    }),
    // Capture build + hook logs to CloudWatch so ready/run hook failures are diagnosable.
    '--logging',
    JSON.stringify({ cloudWatch: { logGroup: `/aws/lambda/microvms/lca-${ENV}-${flavor.name}` } }),
  ];

  // Resource + CPU shape (ADR-038). The GA API accepts memory ONLY:
  // `--resources minimumMemoryInMiB` (single-element list) and `--cpu-configurations
  // architecture=ARM_64` (whose only permitted value is ARM_64 — there is no vCPU knob, and
  // `run-microvm` has no sizing parameter at all, so a VM's shape is fixed by its image).
  // Before this was sent, every flavor was built at the service default and the catalog's
  // memoryMb was inert — including for the 8 GB flavors.
  if (flavor.memoryMb) {
    commonArgs.push('--resources', `minimumMemoryInMiB=${flavor.memoryMb}`);
  }
  commonArgs.push('--cpu-configurations', 'architecture=ARM_64');

  // Extra OS capabilities for the guest (ADR-020). Default microVMs boot with an empty
  // capability set, a read-only /sys and no writable cgroup hierarchy, so a rootful Docker
  // daemon cannot start ("failed to start daemon: Devices cgroup isn't mounted"). Flavors
  // that declare `osCapabilities` in the catalog get them here; only ALL is supported today.
  if (flavor.osCapabilities?.length) {
    commonArgs.push('--additional-os-capabilities', ...flavor.osCapabilities);
  }
  let imageArn;
  if (exists) {
    console.log(`  image ${imageName} exists → update-microvm-image (new version)`);
    const r = aws(['lambda-microvms', 'update-microvm-image', '--image-identifier', imageArnFull, ...commonArgs]);
    imageArn = DRY_RUN ? imageArnFull : JSON.parse(r.stdout).imageArn;
    console.log(`  update triggered → ${imageArn}`);
  } else {
    const r = aws(['lambda-microvms', 'create-microvm-image', '--name', imageName, ...commonArgs]);
    imageArn = DRY_RUN ? imageArnFull : JSON.parse(r.stdout).imageArn;
    console.log(`  build triggered → ${imageArn}`);
  }

  pollUntilCreated(imageArn);
  pruneOldVersions(imageArn);

  // Image ARN FIRST (ADR-051). A rebuild repoints this only after the new version verified,
  // so the flavor is never advertised against an image that does not exist.
  ssmPut(`${SSM_PREFIX}/config/image-arn-${flavor.name}`, imageArn);
  return imageArn;
}

// True if a microVM image already exists at this ARN (so we update vs create).
// get-microvm-image requires the FULL ARN (a bare name → ValidationException).
function imageExists(imageArn) {
  if (DRY_RUN) return false;
  const full = REGION
    ? ['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn, '--region', REGION]
    : ['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn];
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0;
}

function pollUntilCreated(imageArn) {
  if (DRY_RUN) {
    console.log('  [dry-run] would poll get-microvm-image until state=CREATED');
    return;
  }
  const deadline = Date.now() + 20 * 60 * 1000; // 20 min ceiling
  for (;;) {
    const r = aws(['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn]);
    const state = JSON.parse(r.stdout).state;
    console.log(`  state=${state}`);
    if (state === 'CREATED' || state === 'UPDATED') return;
    if (state === 'CREATE_FAILED' || state === 'UPDATE_FAILED') {
      throw new Error(`image build ${state} for ${imageArn}`);
    }
    if (Date.now() > deadline) throw new Error(`image build timed out for ${imageArn}`);
    spawnSync('sleep', ['15']);
  }
}

function pruneOldVersions(imageName) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would keep last ${KEEP_VERSIONS} versions of ${imageName}`);
    return;
  }
  try {
    // Each rebuild of the same image name adds a VERSION; prune old versions, keep last N.
    const r = aws([
      'lambda-microvms',
      'list-microvm-image-versions',
      '--image-identifier',
      imageName,
      '--output',
      'json',
    ]);
    const versions = (JSON.parse(r.stdout).items || [])
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    for (const stale of versions.slice(KEEP_VERSIONS)) {
      aws([
        'lambda-microvms',
        'delete-microvm-image-version',
        '--image-identifier',
        imageName,
        '--image-version',
        stale.imageVersion,
      ]);
      console.log(`  pruned old version ${imageName}:${stale.imageVersion}`);
    }
  } catch (e) {
    console.log(`  (prune skipped: ${e.message})`);
  }
}

function accountId() {
  const r = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  return r.stdout.trim();
}

function discoverBaseImageArn() {
  if (DRY_RUN) return `arn:aws:lambda:${REGION || 'REGION'}:aws:microvm-image:al2023-1`;
  // The managed arm64 AL2023 base image. list-managed-microvm-images is the source of truth
  // per region; pick the al2023 base (fall back to the first managed image).
  const r = aws(['lambda-microvms', 'list-managed-microvm-images', '--output', 'json']);
  const items = JSON.parse(r.stdout).items || [];
  if (items.length === 0) throw new Error('no managed microVM base images in this region');
  const al2023 = items.find((i) => /al2023/i.test(i.imageArn));
  return (al2023 || items[0]).imageArn;
}

async function main() {
  const reconcile = await loadReconcile();
  const flavors = loadFlavors();

  // --publish-label-only: no build at all. Reads the published ARN, verifies the image, then
  // adds the label. This is the safe half of `flavors:reconcile --fix` for the
  // `label_missing` case (built capacity that can never be selected).
  if (PUBLISH_LABEL_ONLY) {
    const flavor = flavors[0];
    const arn = ssmGetOptional(`${SSM_PREFIX}/config/image-arn-${flavor.name}`, reconcile).value;
    if (!arn) {
      throw new Error(
        `no ${SSM_PREFIX}/config/image-arn-${flavor.name} published — build the image first ` +
          `(\`npm run build:images -- --flavor ${flavor.name}\`). Adding '${flavor.label}' now ` +
          'would make ingest claim jobs that cannot be provisioned (ADR-051).',
      );
    }
    console.log(`\n=== flavor: ${flavor.name} (label publish only) ===`);
    console.log(`  published ARN: ${arn}`);
    ensureLabel(flavor, arn, reconcile);
    console.log('\nDone.');
    return;
  }

  console.log(
    `${REBUILD ? 'Rebuilding' : 'Building'} ${flavors.length} flavor(s) for env=${ENV}` +
      `${DRY_RUN ? ' (dry-run)' : ''}`,
  );

  const bucket = DRY_RUN ? '<image-code-bucket>' : ssmGet(`${SSM_PREFIX}/config/image-code-bucket`);
  const buildRoleArn = DRY_RUN
    ? '<image-build-role-arn>'
    : ssmGet(`${SSM_PREFIX}/config/image-build-role-arn`);
  const baseImageArn = discoverBaseImageArn();
  console.log(`code bucket:    ${bucket}`);
  console.log(`build role:     ${buildRoleArn}`);
  console.log(`base image ARN: ${baseImageArn}`);

  const ctx = {
    bucket,
    buildRoleArn,
    baseImageArn,
    region: REGION || 'us-west-2',
    accountId: DRY_RUN ? 'ACCOUNT' : accountId(),
  };
  const results = {};
  for (const flavor of flavors) {
    results[flavor.name] = buildFlavor(flavor, ctx);
    // Label SECOND, and only for a verified image (ADR-051). A rebuild leaves the label in
    // place (`ensureLabel` is idempotent) — removing and re-adding it would open a window in
    // which live jobs stop being claimed.
    if (SKIP_LABEL) {
      console.log(
        `  – --skip-label: '${flavor.label}' NOT added to ${LABELS_PARAM}; the flavor stays ` +
          'unclaimable until you add it (`npm run flavors:reconcile` reports this as drift)',
      );
    } else {
      ensureLabel(flavor, results[flavor.name], reconcile);
    }
  }

  console.log('\nDone. Image ARNs published to SSM:');
  for (const [name, arn] of Object.entries(results)) console.log(`  ${name}: ${arn}`);
  if (!SKIP_LABEL) {
    const shown = ssmGetOptional(LABELS_PARAM, reconcile);
    console.log(`Claim allowlist: ${shown.value ?? (shown.absent ? '(absent)' : '(unreadable)')}`);
  }
  console.log('\nNext: `npm run flavors:reconcile` to confirm catalog == live state.');
}

await guardDeployTarget();
await main();
