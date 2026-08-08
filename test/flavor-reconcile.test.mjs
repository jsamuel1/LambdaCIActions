// Flavor ⇄ control-plane reconciliation (ADR-049).
//
// The bug this file exists to prevent: `microvm/flavors.json` advertised seven flavors while
// the deployed dev plane could run three, and NOTHING in the repository could observe that.
// The symptom was eight PRs queued for ~7h with no error in any log, because `shouldClaim`
// refuses before flavor resolution and GitHub discards ingest's 202 response.
//
// Two properties are pinned here, and both are safety properties rather than preferences:
//   1. the (label, ARN, image-state) → verdict mapping, which the CLI and the console share,
//      so they cannot form different opinions about whether a flavor is runnable;
//   2. image-first / label-second ordering, enforced in code (`mayClaimLabel`) and asserted
//      at the source level in `scripts/build-images.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reconcileFlavors,
  catalogFlavors,
  parseRunnerLabels,
  serializeRunnerLabels,
  addRunnerLabel,
  allCatalogLabels,
  mayClaimLabel,
  classifyImageProbeFailure,
  classifySsmReadFailure,
  USABLE_IMAGE_STATES,
  PENDING_IMAGE_STATES,
} from '../dist/src/shared/flavor-reconcile.js';
import { shouldClaim } from '../dist/src/ingest/filter.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-images.mjs'), 'utf8');
const RECONCILE_SCRIPT = fs.readFileSync(
  path.join(REPO_ROOT, 'scripts', 'flavors-reconcile.mjs'),
  'utf8',
);

/** Strip line comments so a *comment* describing a rule cannot satisfy a behaviour assertion. */
function stripComments(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const BUILD_CODE = stripComments(BUILD_SCRIPT);
const RECONCILE_CODE = stripComments(RECONCILE_SCRIPT);

const ARN = 'arn:aws:lambda:us-west-2:111122223333:microvm-image:lca-dev-python';

function obs(over = {}) {
  return { name: 'python', labelClaimed: true, imageArn: ARN, imageState: 'CREATED', ...over };
}

function rowFor(observation, name = 'python') {
  return reconcileFlavors([observation]).rows.find((r) => r.name === name);
}

// --- the four live states, exactly as observed in dev on 2026-08-07 ----------

test('label claimed + usable image ⇒ ok', () => {
  const row = rowFor(obs());
  assert.equal(row.health, 'ok');
  assert.equal(row.severity, 'ok');
  assert.equal(row.safeFix, null);
});

test('UPDATED is as usable as CREATED — a rebuilt image is not drift', () => {
  // base/node/docker all sat at UPDATED in dev. Treating UPDATED as unusable would report
  // drift on every flavor that had ever been rebuilt, i.e. on a healthy environment.
  assert.equal(rowFor(obs({ imageState: 'UPDATED' })).health, 'ok');
  assert.ok(USABLE_IMAGE_STATES.has('CREATED') && USABLE_IMAGE_STATES.has('UPDATED'));
});

test('label absent + image absent ⇒ not_built, blocked (the SauhsojVideo failure)', () => {
  const row = rowFor(obs({ labelClaimed: false, imageArn: null, imageState: null }));
  assert.equal(row.health, 'not_built');
  assert.equal(row.severity, 'blocked');
  assert.equal(row.safeFix, 'build');
  assert.match(row.detail, /queue forever/);
  assert.match(row.fix, /build:images -- --flavor python/);
});

test('label claimed + no usable image ⇒ image_missing, and the detail names the lost fallback', () => {
  // This is the state label-before-image creates, and why the ordering is enforced: a claimed
  // job can no longer be picked up by a GitHub-hosted runner.
  const row = rowFor(obs({ labelClaimed: true, imageArn: ARN, imageState: null }));
  assert.equal(row.health, 'image_missing');
  assert.equal(row.severity, 'blocked');
  assert.match(row.detail, /fail in provisioning/);
  assert.match(row.detail, /fallback/);
  // Building is the safe direction even here: the label is already claimed, so a build can
  // only reduce harm.
  assert.equal(row.safeFix, 'build');
});

test('usable image + label absent ⇒ label_missing, warn, safely fixable by adding the label', () => {
  const row = rowFor(obs({ labelClaimed: false }));
  assert.equal(row.health, 'label_missing');
  assert.equal(row.severity, 'warn');
  assert.equal(row.safeFix, 'add-label');
  assert.match(row.fix, /--publish-label-only/);
  assert.match(row.detail, /never be selected/);
});

test('label absent + image UNCHECKED still reports drift, but claims no usable image', () => {
  // The console passes `imageState: undefined` by design, and so does `--no-image-check`. The
  // label gap is a verified fact (the allowlist was read), so this must stay drift — but the
  // image was never probed, so the row must not assert it is usable, and must not offer an
  // unattended consumer a label write on that non-evidence. `mayClaimLabel` would refuse it.
  const row = rowFor(obs({ labelClaimed: false, imageState: undefined }));
  assert.equal(row.health, 'label_missing');
  assert.equal(row.severity, 'warn', 'an unselectable catalog flavor is still drift');
  assert.equal(row.safeFix, null, 'unknown must never authorise a live routing change');
  assert.doesNotMatch(row.detail, /image is usable/, 'the image was never checked');
  assert.match(row.detail, /not checked from here/);
  // The command is still offered — it re-verifies and refuses on its own.
  assert.match(row.fix, /--publish-label-only/);
  assert.equal(reconcileFlavors([obs({ labelClaimed: false, imageState: undefined })]).drift, true);
});

test('a published ARN whose image is *_FAILED is blocked, not ok', () => {
  for (const state of ['CREATE_FAILED', 'UPDATE_FAILED']) {
    const row = rowFor(obs({ imageState: state }));
    assert.equal(row.health, 'image_failed', state);
    assert.equal(row.severity, 'blocked', state);
    assert.equal(row.safeFix, 'build', state);
  }
});

test('a mid-build image warns rather than blocking — it is transient', () => {
  for (const state of PENDING_IMAGE_STATES) {
    const row = rowFor(obs({ imageState: state }));
    assert.equal(row.health, 'image_building', state);
    assert.equal(row.severity, 'warn', state);
    assert.equal(row.safeFix, null, `${state} must not trigger a build — one is already running`);
  }
});

// --- unknown must never read as healthy -------------------------------------

test('an unchecked image is image_unverified, never ok', () => {
  // The CD report step (and the console) read SSM only. Presence of a parameter is not
  // evidence the image exists — the dev `python` ARN would have passed a presence check while
  // get-microvm-image returned ResourceNotFoundException.
  const row = rowFor(obs({ imageState: undefined }));
  assert.equal(row.health, 'image_unverified');
  assert.equal(row.severity, 'ok', 'unverified is not an alarm, but it is not `ok` either');
  assert.notEqual(row.health, 'ok');
});

test('an unchecked image does NOT earn a label (mayClaimLabel)', () => {
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: 'CREATED' }), true);
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: 'UPDATED' }), true);
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: undefined }), false);
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: null }), false);
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: 'CREATING' }), false);
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: 'CREATE_FAILED' }), false);
  assert.equal(mayClaimLabel({ imageArn: null, imageState: 'CREATED' }), false);
  assert.equal(mayClaimLabel({ imageArn: '', imageState: 'CREATED' }), false);
});

test('a flavor with no observation at all is blocked, not silently ok', () => {
  const report = reconcileFlavors([]);
  assert.equal(report.rows.length, catalogFlavors().length);
  for (const row of report.rows) assert.equal(row.severity, 'blocked', row.name);
  assert.equal(report.drift, true);
});

// --- an unreadable probe is not evidence of absence -------------------------

test('only ResourceNotFoundException means the image is absent', () => {
  // Everything else is a fact about our credential or CLI, not about the image. Reporting it as
  // absence would make a healthy catalog read `image_missing`/`blocked` — and `image_missing`
  // carries safeFix:'build', so --fix would rebuild the lot on the strength of a 403.
  assert.equal(
    classifyImageProbeFailure(
      'An error occurred (ResourceNotFoundException) when calling the GetMicrovmImage operation',
    ),
    'absent',
  );
  for (const stderr of [
    'An error occurred (AccessDeniedException) when calling the GetMicrovmImage operation',
    'An error occurred (ThrottlingException) when calling the GetMicrovmImage operation',
    'ExpiredTokenException: The security token included in the request is expired',
    "Invalid choice: 'lambda-microvms', maybe you meant: lambda", // aws < 2.35.17
    'An error occurred (ValidationException) when calling the GetMicrovmImage operation',
    '',
    undefined,
    null,
  ]) {
    assert.equal(classifyImageProbeFailure(stderr), 'unreadable', String(stderr));
  }
});

test('an unreadable probe degrades to image_unverified and earns no label', () => {
  // The whole point: unknown must not be reported as the WORST state either. A claimed label
  // plus an unreadable image is `image_unverified` (ok severity, honest), never `image_missing`.
  const row = rowFor(obs({ imageState: undefined }));
  assert.equal(row.health, 'image_unverified');
  assert.notEqual(row.health, 'image_missing');
  assert.equal(row.safeFix, null, 'unknown must never trigger a build');
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: undefined }), false);
});

// --- an unreadable ALLOWLIST is not an empty allowlist ----------------------

test('only ParameterNotFound means the allowlist is absent', () => {
  // Same rule as the image probe, for the other half of the live state. Reading an AccessDenied
  // as "no labels are claimed" would report every built flavor as `label_missing` and every
  // unbuilt one as `not_built` — a confident drift verdict about a parameter never read, from
  // the one tool whose whole purpose is to be trustworthy about exactly this.
  assert.equal(
    classifySsmReadFailure(
      'An error occurred (ParameterNotFound) when calling the GetParameter operation',
    ),
    'absent',
  );
  for (const stderr of [
    'An error occurred (AccessDeniedException) when calling the GetParameter operation',
    'An error occurred (ThrottlingException) when calling the GetParameter operation',
    'ExpiredTokenException: The security token included in the request is expired',
    'Could not connect to the endpoint URL',
    '',
    undefined,
    null,
  ]) {
    assert.equal(classifySsmReadFailure(stderr), 'unreadable', String(stderr));
  }
  // A ResourceNotFoundException is the IMAGE's absence signal, not a parameter's — the two
  // classifiers must not be interchangeable.
  assert.equal(classifySsmReadFailure('ResourceNotFoundException'), 'unreadable');
  assert.equal(classifyImageProbeFailure('ParameterNotFound'), 'unreadable');
});

test('an unreadable allowlist exits 2 rather than reporting every flavor unclaimed', () => {
  // Asserted at the source level: the CLI must classify the read, and the failure path must
  // exit 2 ("could not read live state") instead of falling through with an empty label list.
  assert.match(RECONCILE_CODE, /classifySsmReadFailure/);
  const fn = RECONCILE_CODE.slice(
    RECONCILE_CODE.indexOf('function ssmGetOptional('),
    RECONCILE_CODE.indexOf('const probeFailures = ['),
  );
  assert.ok(fn.length > 0, 'ssmGetOptional body not found');
  assert.match(fn, /classifySsmRead\(/, 'the allowlist read must be classified');
  assert.match(fn, /process\.exit\(2\)/, 'an unreadable allowlist must exit 2');
  // And the absent case must still be tolerated — a fresh environment legitimately has no
  // allowlist yet, and reporting every flavor unclaimed there is correct.
  assert.match(fn, /absent: true/);
});

test('build-images refuses an unreadable allowlist instead of advising a re-seed', () => {
  // The absent branch tells an operator to seed the parameter. Reaching that advice on an
  // AccessDenied would invite overwriting a full allowlist with one flavor's label — the exact
  // harm the absent branch itself refuses to cause.
  assert.match(BUILD_CODE, /classifySsmReadFailure\(/);
  const idx = BUILD_CODE.indexOf('does not exist');
  const guard = BUILD_CODE.lastIndexOf('current.absent', idx);
  assert.ok(guard > 0 && guard < idx, 'the seed advice must be gated on a genuinely absent read');
  assert.match(BUILD_CODE, /NOT the same as the/);
});

test('the CLI reports an incomplete probe as exit 2 and blocks --fix', () => {
  // Exit 2 is "could not read live state" — the same code as a failed SSM read. A wrong-region /
  // AccessDenied run must not look like a clean 0 or a diagnosable 1.
  assert.match(RECONCILE_CODE, /classifyImageProbeFailure/);
  assert.match(RECONCILE_CODE, /probeFailures\.push\(/);
  const probeExit = RECONCILE_CODE.indexOf('probeFailures.length');
  const fixGate = RECONCILE_CODE.indexOf('const actionable =');
  assert.ok(probeExit > 0 && fixGate > 0, 'expected both the probe check and the fix selection');
  assert.ok(probeExit < fixGate, 'the incomplete-probe exit must precede any remediation');
  assert.match(RECONCILE_CODE, /process\.exit\(2\)/);
});

test('build-images distinguishes an unreadable image from an absent one when refusing', () => {
  // "absent" sends an operator to rebuild an image that may be perfectly fine; the refusal must
  // name the real diagnosis.
  assert.match(BUILD_CODE, /classifyImageProbeFailure\(/);
  assert.match(BUILD_CODE, /could NOT be read/);
  assert.match(BUILD_CODE, /2\.35\.17/);
});

// --- report shape -----------------------------------------------------------

test('every catalog flavor appears in the report, in catalog order', () => {
  const report = reconcileFlavors([]);
  assert.deepEqual(
    report.rows.map((r) => r.name),
    catalogFlavors().map((f) => f.name),
  );
});

test('drift is false only when every row is ok/unverified', () => {
  const all = catalogFlavors().map((f) => ({
    name: f.name,
    labelClaimed: true,
    imageArn: `${ARN}-${f.name}`,
    imageState: 'CREATED',
  }));
  assert.equal(reconcileFlavors(all).drift, false);
  const one = [...all];
  one[2] = { ...one[2], labelClaimed: false };
  assert.equal(reconcileFlavors(one).drift, true, 'one label_missing must be drift');
});

test('counts sum to the catalog size', () => {
  const report = reconcileFlavors([obs()]);
  const { ok, warn, blocked } = report.counts;
  assert.equal(ok + warn + blocked, catalogFlavors().length);
});

test('non-catalog live labels are reported, never treated as drift', () => {
  // A repo FlavorMap can legitimately claim `ubuntu-latest` — adopt mode depends on it
  // (ADR-030). Reporting it as drift would push an operator toward deleting it.
  const all = catalogFlavors().map((f) => ({
    name: f.name,
    labelClaimed: true,
    imageArn: `${ARN}-${f.name}`,
    imageState: 'CREATED',
  }));
  const report = reconcileFlavors(all, [...allCatalogLabels(), 'ubuntu-latest']);
  assert.deepEqual(report.extraLabels, ['ubuntu-latest']);
  assert.equal(report.drift, false);
});

// --- allowlist string handling ----------------------------------------------

test('parseRunnerLabels tolerates the whitespace a hand-seeded parameter carries', () => {
  assert.deepEqual(parseRunnerLabels('lambda-ci, lambda-ci-node ,,lambda-ci-docker'), [
    'lambda-ci',
    'lambda-ci-node',
    'lambda-ci-docker',
  ]);
  assert.deepEqual(parseRunnerLabels(''), []);
  assert.deepEqual(parseRunnerLabels(undefined), []);
  assert.deepEqual(parseRunnerLabels(null), []);
});

test('addRunnerLabel appends, preserves order and non-catalog labels, and is idempotent', () => {
  const live = 'lambda-ci,ubuntu-latest,lambda-ci-node';
  const added = addRunnerLabel(live, 'lambda-ci-python');
  assert.equal(added.changed, true);
  assert.equal(added.value, 'lambda-ci,ubuntu-latest,lambda-ci-node,lambda-ci-python');

  const again = addRunnerLabel(added.value, 'lambda-ci-python');
  assert.equal(again.changed, false, 're-adding must be a no-op, not a rewrite');
  assert.equal(again.value, added.value);

  // Case-insensitive: the claim gate lowercases, so a differently-cased duplicate would be a
  // silent no-op there while looking like a change here.
  assert.equal(addRunnerLabel(added.value, 'LAMBDA-CI-PYTHON').changed, false);
});

test('a label added by addRunnerLabel is actually accepted by the claim gate', () => {
  // Closes the loop: the write path and the gate must agree on the serialization format.
  const { labels } = addRunnerLabel('lambda-ci', 'lambda-ci-python');
  const job = {
    action: 'queued',
    workflow_job: {
      id: 1,
      run_id: 1,
      labels: ['self-hosted', 'lambda-ci-python'],
      name: 'build',
      status: 'queued',
    },
  };
  assert.equal(shouldClaim(job, labels), true);
  assert.equal(shouldClaim(job, ['lambda-ci']), false);
});

// --- ordering, asserted at the source level ---------------------------------

test('build-images publishes the image ARN BEFORE touching the allowlist', () => {
  // Three orderings, one property (ADR-049): no allowlist write is reachable without a
  // verified image ahead of it.

  // (a) inside ensureLabel: the mayClaimLabel guard precedes the parameter write.
  const body = BUILD_CODE.slice(
    BUILD_CODE.indexOf('function ensureLabel('),
    BUILD_CODE.indexOf('async function loadReconcile('),
  );
  assert.ok(body.length > 0, 'ensureLabel body not found');
  const guard = body.indexOf('mayClaimLabel(');
  const write = body.indexOf('ssmPut(LABELS_PARAM');
  assert.ok(guard > 0 && write > 0, 'expected both a mayClaimLabel guard and a label write');
  assert.ok(guard < write, 'mayClaimLabel must gate the label write, not follow it');

  // (b) the build path: buildFlavor (which writes image-arn-<flavor>) runs before ensureLabel.
  const loop = BUILD_CODE.slice(BUILD_CODE.indexOf('for (const flavor of flavors) {'));
  const built = loop.indexOf('buildFlavor(flavor, ctx)');
  const labelled = loop.indexOf('ensureLabel(flavor');
  assert.ok(built > 0 && labelled > 0, 'expected buildFlavor + ensureLabel in the build loop');
  assert.ok(built < labelled, 'the image must be built and published before the label is added');

  // ...and buildFlavor's own last act is the ARN write, after the CREATED/UPDATED poll.
  const buildBody = BUILD_CODE.slice(
    BUILD_CODE.indexOf('function buildFlavor('),
    BUILD_CODE.indexOf('function imageExists('),
  );
  const poll = buildBody.indexOf('pollUntilCreated(');
  const arnWrite = buildBody.indexOf('config/image-arn-${flavor.name}');
  assert.ok(poll > 0 && arnWrite > 0, 'expected a poll and an ARN write in buildFlavor');
  assert.ok(arnWrite > poll, 'the ARN must be published only after the image reaches a usable state');

  // (c) the --publish-label-only path reads the published ARN before labelling, and refuses
  // when there is none.
  const only = BUILD_CODE.slice(
    BUILD_CODE.indexOf('if (PUBLISH_LABEL_ONLY) {'),
    BUILD_CODE.indexOf('const bucket ='),
  );
  const read = only.indexOf('ssmGetOptional(');
  const refuse = only.indexOf('throw new Error(');
  const label = only.indexOf('ensureLabel(flavor');
  assert.ok(read > 0 && refuse > 0 && label > 0, 'expected read, refusal and label in this path');
  assert.ok(read < refuse && refuse < label, 'must read the ARN and refuse before labelling');
});

test('build-images refuses a label whose image is not usable, via the shared predicate', () => {
  // Asserting the CALL, not a comment about it: `mayClaimLabel` is the same predicate the
  // reconcile CLI and the console use, so a local reimplementation here could drift.
  assert.match(BUILD_CODE, /mayClaimLabel\(/);
  assert.match(BUILD_CODE, /refusing to add/);
  assert.match(BUILD_CODE, /throw new Error\(/);
  // And it must come from dist/, not be re-derived.
  assert.match(BUILD_CODE, /flavor-reconcile\.js/);
});

test('build-images never creates the allowlist parameter from a single flavor', () => {
  // Creating it would DROP every label an operator had seeded (including non-catalog ones),
  // silently un-claiming live flavors — the opposite of this script's purpose.
  const idx = BUILD_CODE.indexOf('does not exist');
  assert.ok(idx > 0, 'expected the absent-parameter branch');
  // Scope to the branch body only: it must return before reaching any allowlist write.
  const branch = BUILD_CODE.slice(idx, BUILD_CODE.indexOf('return false;', idx));
  assert.doesNotMatch(branch, /ssmPut\(/, 'must not write the allowlist when it is absent');
  assert.match(branch, /seed it first/);
});

test('--publish-label-only refuses when no image ARN is published', () => {
  const idx = BUILD_CODE.indexOf('PUBLISH_LABEL_ONLY');
  assert.ok(idx > 0);
  assert.match(BUILD_CODE, /--publish-label-only requires --flavor/);
  assert.match(BUILD_CODE, /build the image first/);
});

test('--publish-label-only does not read an unreadable ARN param as an unpublished one', () => {
  // "not published" prescribes `build:images` — a slow, deploy-touching image build. Reaching
  // that advice from an AccessDenied/expired token is the same conflation ADR-049 removes from
  // the image probe and the allowlist read, and here it costs a real rebuild.
  const only = BUILD_CODE.slice(
    BUILD_CODE.indexOf('if (PUBLISH_LABEL_ONLY) {'),
    BUILD_CODE.indexOf('const bucket ='),
  );
  assert.ok(only.length > 0, 'publish-label-only branch not found');
  // It must consult `absent`, not merely the value...
  assert.match(only, /published\.absent/, 'must distinguish absent from unreadable');
  // ...and the unreadable branch must refuse BEFORE the "build the image first" advice.
  const unreadable = only.indexOf('NOT the same as the');
  const buildAdvice = only.indexOf('build the image first');
  assert.ok(unreadable > 0, 'expected an explicit unreadable refusal');
  assert.ok(
    unreadable < buildAdvice,
    'an unreadable read must refuse before the rebuild advice is reachable',
  );
  const unreadableBranch = only.slice(unreadable, buildAdvice);
  assert.doesNotMatch(
    unreadableBranch,
    /build:images/,
    'must not prescribe a rebuild on the strength of a failed read',
  );
});

test('imageExists refuses an unreadable probe instead of assuming the image is absent', () => {
  // `false` here means "create it", so an unreadable probe would send CREATE at an image that
  // already exists and surface a ValidationException blaming the NAME — telling the operator
  // their image name is wrong when the truth is that the probe never succeeded.
  const body = BUILD_CODE.slice(
    BUILD_CODE.indexOf('function imageExists('),
    BUILD_CODE.indexOf('function pollUntilCreated('),
  );
  assert.ok(body.length > 0, 'imageExists body not found');
  assert.match(body, /classifyImageProbeFailure\(/, 'must use the shared classifier');
  const absent = body.indexOf("=== 'absent'");
  const refuse = body.indexOf('throw new Error(');
  assert.ok(absent > 0 && refuse > 0, 'expected an absence check and a refusal');
  assert.ok(absent < refuse, 'only ResourceNotFoundException may return false');
  // The old behaviour — every non-zero exit collapsing to "does not exist" — must be gone.
  assert.doesNotMatch(body, /return r\.status === 0;/);
});

test('a rebuild repoints the ARN and leaves the label alone', () => {
  // Removing and re-adding the label across a rebuild would open a window where live jobs stop
  // being claimed — the exact harm ADR-049 is about. There must be no label-removal path.
  assert.doesNotMatch(BUILD_CODE, /removeRunnerLabel|delete-parameter/);
  assert.match(BUILD_CODE, /REBUILD/);
});

test('build-images refuses to build or replace an image on a live fleet', () => {
  // `flavors:reconcile --fix` gates on an idle fleet and then fixes drift by shelling out to
  // THIS script. Leaving the direct invocation ungated would make the DOCUMENTED primary
  // command (`npm run build:images -- --flavor <name>`) the only path that can race a booting
  // VM against the image being replaced — exactly backwards.
  assert.match(BUILD_CODE, /function assertQuiescentFleet\(/);
  assert.match(BUILD_CODE, /function nonTerminatedMicroVms\(/);

  // ALL pages: page 1 caps at 10, so a first-page read calls the window quiet while a live VM
  // sits on page 2 (docs/DEPLOY-M1.md phase 2). A partial read would license the swap.
  const lister = BUILD_CODE.slice(
    BUILD_CODE.indexOf('function nonTerminatedMicroVms('),
    BUILD_CODE.indexOf('function assertQuiescentFleet('),
  );
  assert.ok(lister.length > 0, 'nonTerminatedMicroVms body not found');
  assert.match(lister, /nextToken/, 'must follow the pagination token');
  assert.match(lister, /aws\(cmd\)/, 'must use aws(), which throws — unreadable is not empty');

  // The gate refuses; it does not warn and continue.
  const gate = BUILD_CODE.slice(
    BUILD_CODE.indexOf('function assertQuiescentFleet('),
    BUILD_CODE.indexOf('function ssmGet('),
  );
  assert.ok(gate.length > 0, 'assertQuiescentFleet body not found');
  assert.match(gate, /throw new Error\(/, 'a live fleet must refuse, not warn');

  // ...and it runs before ANY image side effect: before the bucket/role reads, before staging,
  // before create/update. Refusing after `update-microvm-image` would be too late by definition.
  const mainBody = BUILD_CODE.slice(BUILD_CODE.indexOf('async function main('));
  const gateCall = mainBody.indexOf('assertQuiescentFleet()');
  const firstBuild = mainBody.indexOf('buildFlavor(flavor, ctx)');
  const bucketRead = mainBody.indexOf('config/image-code-bucket');
  assert.ok(gateCall > 0, 'main() must call the quiesce gate');
  assert.ok(gateCall < firstBuild, 'the gate must precede any build');
  assert.ok(gateCall < bucketRead, 'the gate must precede the first AWS read of the build path');
});

test('the quiesce gate exempts --dry-run and the label-only path, and nothing else', () => {
  const gate = BUILD_CODE.slice(
    BUILD_CODE.indexOf('function assertQuiescentFleet('),
    BUILD_CODE.indexOf('function ssmGet('),
  );
  // A dry run makes no API call at all, so gating it would only make the preview need a
  // credential.
  assert.match(gate, /DRY_RUN/);

  // `--publish-label-only` writes one label and touches no image. Gating it on an idle fleet
  // would block the safe half of remediation during ordinary traffic, and a label add cannot
  // skew a running VM — it only changes which FUTURE jobs are claimed.
  //
  // Slice within main(): the function DEFINITION appears earlier in the file than this branch,
  // so a whole-file indexOf would find the definition and silently produce an empty range.
  const mainOnly = BUILD_CODE.slice(BUILD_CODE.indexOf('async function main('));
  const only = mainOnly.slice(
    mainOnly.indexOf('if (PUBLISH_LABEL_ONLY) {'),
    mainOnly.indexOf('assertQuiescentFleet()'),
  );
  assert.ok(only.length > 0, 'publish-label-only branch must precede the gate');
  assert.doesNotMatch(only, /assertQuiescentFleet\(/);
  assert.match(only, /return;/, 'the label-only path must return before the build path');
});

test('--force-unquiesced is an explicit, loud override rather than a silent default', () => {
  // The one case the gate cannot distinguish: a VM wedged non-terminal that the Reaper has not
  // collected, with every writer already frozen by hand. It must be opt-in and it must say so.
  assert.match(BUILD_CODE, /force-unquiesced/);
  const gate = BUILD_CODE.slice(
    BUILD_CODE.indexOf('function assertQuiescentFleet('),
    BUILD_CODE.indexOf('function ssmGet('),
  );
  const forced = gate.indexOf('FORCE_UNQUIESCED');
  const refusal = gate.indexOf('throw new Error(');
  assert.ok(forced > 0 && refusal > 0, 'expected both an override and a refusal');
  assert.ok(forced < refusal, 'the override must be checked before refusing, not after');
  assert.match(gate, /console\.warn\(/, 'an override must be logged, not silent');
  // Default is refuse: the flag has to be passed.
  assert.match(
    BUILD_CODE,
    /const FORCE_UNQUIESCED = Boolean\(args\['force-unquiesced'\]\)/,
    'the override must default to false',
  );
});

// --- reconcile CLI contract -------------------------------------------------

test('the reconcile CLI is pinned to a deploy target with no dry-run exemption', () => {
  // An unpinned read produces a confident report about the wrong environment, and a
  // ParameterNotFound from the wrong region is indistinguishable from a missing flavor. That
  // is how the SauhsojVideo diagnosis first went wrong.
  assert.match(RECONCILE_CODE, /assertDeployTarget/);
  assert.doesNotMatch(RECONCILE_CODE, /DRY_RUN/);
});

test('the reconcile CLI exits non-zero on drift', () => {
  assert.match(RECONCILE_CODE, /process\.exit\(report\.drift \? 1 : 0\)/);
});

test('--fix never removes a label and refuses a non-quiescent fleet', () => {
  assert.doesNotMatch(RECONCILE_CODE, /remove|delete-parameter/i);
  // All pages, not the first: a single-page check would pass while VMs sit on page 2.
  assert.match(RECONCILE_CODE, /nextToken/);
  assert.match(RECONCILE_CODE, /non-terminated microVM/);
  const fixIdx = RECONCILE_CODE.indexOf('--fix: fleet is quiescent');
  const gateIdx = RECONCILE_CODE.indexOf('nonTerminatedMicroVms()');
  assert.ok(gateIdx > 0 && fixIdx > gateIdx, 'the quiesce gate must precede any remediation');
});

test('--fix is rejected with --no-image-check', () => {
  // Adding a label on the strength of an unverified parameter is the ordering violation.
  assert.match(RECONCILE_CODE, /--fix requires the real image state/);
});

test('drift --fix could not remediate still exits non-zero', () => {
  // Exiting 0 because the FIXABLE half was fixed would claim an agreement the plane does not
  // have: an `image_building` row (or any state whose remedy is a human decision) carries no
  // safeFix, so a scheduled `--fix` would report success while a flavor stayed unrunnable.
  const fix = RECONCILE_CODE.slice(RECONCILE_CODE.indexOf('const actionable ='));
  assert.ok(fix.length > 0, '--fix block not found');
  assert.match(fix, /const unfixable = /, 'must compute the rows it will not touch');
  assert.match(
    fix,
    /unfixable\.length > 0[\s\S]{0,600}?process\.exit\(1\)/,
    'leftover drift must exit 1, not 0',
  );
  // And that check must come AFTER the remediation loop, or a fixable row would be counted
  // against the run it is about to fix.
  const loop = fix.indexOf('for (const r of actionable)');
  const leftover = fix.indexOf('unfixable.length > 0');
  assert.ok(loop > 0 && leftover > loop, 'the leftover check must follow the fix loop');
});

test('an operational failure exits 2, never 1 — it is not drift', () => {
  // The 1-vs-2 split is this tool applied to itself: 1 means "I read the plane and it
  // disagrees", 2 means "do not trust this report". An unreadable fleet or a failed build
  // reported as drift sends the operator to a table instead of to the error.
  assert.match(
    RECONCILE_CODE,
    /catch[\s\S]{0,200}?could not read the microVM fleet[\s\S]{0,200}?process\.exit\(2\)/,
    'an unreadable fleet must exit 2',
  );
  assert.match(
    RECONCILE_CODE,
    /remediation for \$\{r\.name\} failed[\s\S]{0,400}?process\.exit\(2\)/,
    'a failed remediation must exit 2 and stop',
  );
  // A throw anywhere else must not fall through to node's default exit 1.
  assert.match(
    RECONCILE_CODE,
    /try \{\s*await main\(\);\s*\} catch[\s\S]{0,200}?process\.exit\(2\)/,
    'main() must be wrapped so an unexpected throw exits 2',
  );
});

test('a failed remediation stops rather than continuing down the list', () => {
  // A half-applied fix leaves the plane in a state the printed report no longer describes.
  const fix = RECONCILE_CODE.slice(RECONCILE_CODE.indexOf('for (const r of actionable)'));
  assert.match(fix, /were NOT attempted/);
});

test('the CLI derives verdicts from the shared module, not its own copy', () => {
  assert.match(RECONCILE_CODE, /flavor-reconcile\.js/);
  assert.match(RECONCILE_CODE, /reconcile\.reconcileFlavors\(/);
  // No local re-derivation of the mapping.
  assert.doesNotMatch(RECONCILE_CODE, /not_built['"]\s*:/);
});

test('there is exactly ONE runner-label parser in the codebase', () => {
  // #28 landed `parseRunnerLabels` in src/mgmt/validate.ts for the Settings write path; this
  // module re-exports it rather than carrying a second copy. Two parsers for one hand-edited
  // parameter is how a label the UI shows as present becomes one the claim gate does not
  // accept — the same class of catalog-vs-live disagreement ADR-049 exists to close.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'flavor-reconcile.ts'), 'utf8');
  assert.doesNotMatch(
    src,
    /export function parseRunnerLabels/,
    'flavor-reconcile must re-export the validate.ts parser, not define its own',
  );
  assert.match(src, /export \{ parseRunnerLabels[^}]*\} from '\.\.\/mgmt\/validate\.js'/);

  // And the definition itself lives in exactly one place.
  const defs = [];
  for (const dir of ['src/shared', 'src/mgmt', 'src/ingest', 'src/provision']) {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, dir))) {
      if (!f.endsWith('.ts')) continue;
      const body = fs.readFileSync(path.join(REPO_ROOT, dir, f), 'utf8');
      if (/export function parseRunnerLabels/.test(body)) defs.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(defs, ['src/mgmt/validate.ts'], `parseRunnerLabels defined in ${defs.join(', ')}`);
});

test('addRunnerLabel round-trips through the same serializer the console writes', () => {
  const { value } = addRunnerLabel('lambda-ci,ubuntu-latest', 'lambda-ci-python');
  assert.deepEqual(parseRunnerLabels(value), [
    'lambda-ci',
    'ubuntu-latest',
    'lambda-ci-python',
  ]);
  assert.equal(serializeRunnerLabels(parseRunnerLabels(value)), value);
});

test("the console's imageAvailable is presence-only, so it must not be read as `ok`", () => {
  // `buildFlavorViews` derives `imageAvailable` from DescribeParameters (src/mgmt/handler.ts
  // `imageAvailability`), which is exactly the weak evidence that let dev's `python` ARN look
  // healthy while get-microvm-image returned ResourceNotFoundException. This module's
  // `image_unverified` is the honest projection of that same observation; a consumer wiring the
  // console to this derivation must pass `imageState: undefined`, not a boolean.
  const handler = fs.readFileSync(path.join(REPO_ROOT, 'src', 'mgmt', 'handler.ts'), 'utf8');
  const idx = handler.indexOf('async function imageAvailability(');
  assert.ok(idx > 0, 'imageAvailability not found — has the console changed its evidence?');
  const body = handler.slice(idx, idx + 500);
  assert.match(body, /paramExists\(/, 'still presence-based');
  assert.doesNotMatch(body, /get-microvm-image|GetMicrovmImage/, 'now checks real image state');
  // The projection of an unchecked image must stay non-`ok`.
  assert.equal(rowFor(obs({ imageState: undefined })).health, 'image_unverified');
});

test('npm exposes flavors:reconcile', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['flavors:reconcile'], 'node scripts/flavors-reconcile.mjs');
});

// --- CD stays report-only ---------------------------------------------------

test('CD runs reconcile report-only: no --fix, no build, never fails the deploy', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  // Strip YAML comments before behaviour assertions: a comment EXPLAINING that CD must never
  // build images would otherwise satisfy a raw text search for the build command, so the guard
  // would pass after the rule it documents was violated.
  const executable = wf
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\n\s*/g, ' ');
  assert.doesNotMatch(executable, /^\s*#/m, 'comment stripper failed');
  assert.ok(!executable.includes('Builds are a human'), 'comment text leaked into executable YAML');

  const calls = [...executable.matchAll(/npm run flavors:reconcile[^\n]*/g)].map((m) => m[0]);
  assert.equal(calls.length, 1, 'expected exactly one reconcile invocation in CD');
  assert.doesNotMatch(calls[0], /--fix/, 'CD must never remediate: image builds are human-run');
  assert.match(calls[0], /--no-image-check/, 'CD has SSM read only, not the microVM API');
  // A flavor gap must not fail a management-plane deploy.
  const stepIdx = wf.indexOf('Flavor reconcile (report only)');
  assert.ok(stepIdx > 0, 'reconcile step missing from CD');
  assert.match(wf.slice(stepIdx, stepIdx + 400), /continue-on-error:\s*true/);
  // And CD must not have grown an image build.
  assert.doesNotMatch(executable, /npm run build:images/, 'CD must never build images (ADR-047/049)');
  assert.doesNotMatch(executable, /create-microvm-image/, 'CD must never call the image API');
});

test('the CD deploy role can read config params but not secrets', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'deploy-stack.ts'), 'utf8');
  const idx = src.indexOf('ReadFlavorConfigForReconcile');
  assert.ok(idx > 0, 'reconcile grant missing from DeployStack');
  const stmt = src.slice(idx, idx + 900);
  assert.match(stmt, /parameter\/lca\/\$\{envName\}\/config/);
  // The secret subtrees must not be reachable from the CD credential.
  assert.doesNotMatch(stmt, /github|mgmt\//);
  assert.doesNotMatch(stmt, /ssm:PutParameter/, 'CD must not write control-plane config');
});
