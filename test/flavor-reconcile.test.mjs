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
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
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
  isLiveMicroVmState,
  TERMINAL_MICROVM_STATES,
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

test('the comment stripper actually removes comments (it guards every source assertion)', () => {
  // Every source-level assertion below runs against stripped text, so a broken stripper would
  // silently turn all of them into prose searches — and both scripts carry long comment blocks
  // that DESCRIBE the very rules being asserted. That is the exact failure mode: a guard passing
  // on the comment explaining a deleted instruction.
  const stripped = stripComments(
    ['// throw new Error(commented);', ' * throw new Error(jsdoc);', '/* throw new Error(block);', 'const real = 1;'].join(
      '\n',
    ),
  );
  assert.doesNotMatch(stripped, /commented|jsdoc|block/, 'stripper left comment text behind');
  assert.match(stripped, /const real = 1;/, 'stripper removed real code');

  // And it is demonstrably doing work on the real inputs: these phrases exist ONLY in the
  // scripts' comments, so their absence proves the strip ran against the actual files.
  assert.ok(
    BUILD_SCRIPT.includes('Strictly worse.') && !BUILD_CODE.includes('Strictly worse.'),
    'build-images comments were not stripped',
  );
  assert.ok(
    RECONCILE_SCRIPT.includes('do not trust this report') &&
      !RECONCILE_CODE.includes('do not trust this report'),
    'flavors-reconcile comments were not stripped',
  );
});

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

test('an UNREAD allowlist is never reported as a claimed label', () => {
  // The other half of the same rule. `labelClaimed: undefined` means the allowlist was not read;
  // `ok` asserts "label claimed", so returning it here would state an unobserved fact as health —
  // the identical false confidence this module removes from the image probe, one field over. A
  // consumer reading `image-arn-*` without `runner-labels` must not be told the flavor is runnable.
  const row = rowFor({ name: 'python', imageArn: ARN, imageState: 'CREATED' });
  assert.equal(row.health, 'label_unverified');
  assert.notEqual(row.health, 'ok', 'an unread allowlist must not read as a claimed label');
  assert.equal(row.severity, 'ok', 'unknown is not an alarm...');
  // ...and unknown is not drift either — only an observed disagreement is. Asserted over the WHOLE
  // catalog, because `reconcileFlavors` always emits a row per flavor and an unobserved flavor is
  // legitimately `not_built`/blocked; a single-observation report would be drift for that reason
  // rather than this one.
  const allUnread = catalogFlavors().map((f) => ({
    name: f.name,
    imageArn: `${ARN}-${f.name}`,
    imageState: 'CREATED',
  }));
  const unreadReport = reconcileFlavors(allUnread);
  assert.deepEqual(
    [...new Set(unreadReport.rows.map((r) => r.health))],
    ['label_unverified'],
  );
  assert.equal(unreadReport.drift, false);
  assert.equal(row.safeFix, null, 'unknown must never authorise an unattended action');
  assert.doesNotMatch(row.detail, /label claimed/, 'the detail must not assert the claim');
  assert.match(row.detail, /allowlist was not read/);

  // Both halves unobserved is still not `ok`.
  assert.notEqual(rowFor({ name: 'python', imageArn: ARN }).health, 'ok');

  // ...and `ok` remains reachable only when BOTH facts were actually observed.
  assert.equal(rowFor(obs()).health, 'ok');
});

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

test('not_built with an UNREAD allowlist does not claim the label was observed absent', () => {
  // The console's exact position: it reads `image-arn-*` presence via DescribeParameters and no
  // label VALUE at all, so every unbuilt flavor reaches this row with `labelClaimed: undefined`.
  // The absent image is decisive on its own, so `not_built`/`blocked`/`build` all stand — but the
  // detail must not report an unobserved allowlist as a second finding. Same optional-by-ignorance
  // split `label_missing` already carries, one health value over.
  const row = rowFor({ name: 'python', imageArn: null });
  assert.equal(row.health, 'not_built');
  assert.equal(row.severity, 'blocked', 'a flavor with no image is still blocked');
  assert.equal(row.safeFix, 'build', 'building is safe regardless of what the allowlist says');
  assert.doesNotMatch(
    row.detail,
    /nor claimed/,
    'the allowlist was never read, so its state must not be asserted',
  );
  assert.match(row.detail, /not observed/);
  assert.match(row.detail, /queue forever/, 'the real consequence must still be stated');

  // And an allowlist that WAS read and is genuinely missing the label keeps the stronger wording.
  const observed = rowFor({ name: 'python', labelClaimed: false, imageArn: null, imageState: null });
  assert.equal(observed.health, 'not_built');
  assert.match(observed.detail, /neither built nor claimed/);
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

  // Assert the BRANCH, not merely that the words appear somewhere. `probeFailures.length` also
  // occurs inside the block's own diagnostic message, and `process.exit(2)` occurs elsewhere in
  // the file — so an `indexOf` pair plus a file-wide `process.exit(2)` match stays green after
  // the guard is neutered to `if (false)`: the exit dies, `--fix` is no longer blocked by an
  // AccessDenied, and nothing fails.
  const guard = /if \(probeFailures\.length\)\s*\{[\s\S]{0,1200}?process\.exit\(2\);/.exec(
    RECONCILE_CODE,
  );
  assert.ok(
    guard,
    'expected a live `if (probeFailures.length) { … process.exit(2) }` branch, not just the words',
  );

  // ...and it must be reachable BEFORE `--fix` selects any action, or an unreadable probe could
  // still authorise a rebuild of a healthy catalog.
  const fixGate = RECONCILE_CODE.indexOf('const actionable =');
  assert.ok(fixGate > 0, 'fix selection not found');
  assert.ok(
    guard.index < fixGate,
    'the incomplete-probe exit must precede any remediation selection',
  );
});

test('build-images distinguishes an unreadable image from an absent one when refusing', () => {
  // "absent" sends an operator to rebuild an image that may be perfectly fine; the refusal must
  // name the real diagnosis.
  assert.match(BUILD_CODE, /classifyImageProbeFailure\(/);
  assert.match(BUILD_CODE, /could NOT be read/);
  assert.match(BUILD_CODE, /2\.35\.17/);
});

// --- the quiesce gate's state vocabulary must match the service model -------

test('TERMINATED is the only terminal MicrovmState — FAILED is not one at all', () => {
  // `MicrovmState` in the deployed model (lambda-microvms 2025-09-09) is exactly
  // PENDING|RUNNING|SUSPENDING|SUSPENDED|TERMINATING|TERMINATED. `FAILED` belongs to
  // `BuildState`/`MicrovmImageVersionState` — an image BUILD, not a VM — so treating it as
  // terminal would widen the terminal set beyond the model in the one direction a safety gate
  // must never widen: a state the gate calls terminal is a VM it will replace an image under.
  assert.deepEqual([...TERMINAL_MICROVM_STATES], ['TERMINATED']);
  for (const state of ['PENDING', 'RUNNING', 'SUSPENDING', 'SUSPENDED', 'TERMINATING']) {
    assert.equal(isLiveMicroVmState(state), true, `${state} is live and must block an image swap`);
  }
  assert.equal(isLiveMicroVmState('TERMINATED'), false);
  assert.equal(isLiveMicroVmState('terminated'), false, 'case must not defeat the gate');

  // FAILED is not a MicrovmState, so a VM reporting it is a VM we do not understand — live.
  assert.equal(isLiveMicroVmState('FAILED'), true, 'FAILED must not be treated as terminal');

  // Unknown counts as LIVE in every form: absent, empty, or a state the model gains later. The
  // safe reading of "I do not know what this VM is doing" is to refuse the swap.
  for (const state of [undefined, null, '', 'SOME_FUTURE_STATE']) {
    assert.equal(isLiveMicroVmState(state), true, `unknown (${String(state)}) must count as live`);
  }

  // TERMINATING deserves its own line: the VM still exists and may still be resuming from the
  // image about to be replaced, which is precisely the skew window the gate refuses.
  assert.equal(isLiveMicroVmState('TERMINATING'), true);
});

// --- a successful probe with no state is unknown, not absent -----------------

test('a 200 get-microvm-image with no `state` is unknown in both scripts, never absent', () => {
  // Third member of the same family as the `classifyImageProbeFailure` /
  // `classifySsmReadFailure` rules, and the one a non-zero exit does not cover: the CLI exited
  // 0, so nothing was "classified", but the body carried no state. `null` there means ABSENT,
  // which renders `image_missing`/`not_built` — verdicts carrying safeFix:'build', so `--fix`
  // would rebuild a healthy image on the strength of a response it merely failed to read.
  for (const [label, code] of [
    ['build-images', BUILD_CODE],
    ['flavors-reconcile', RECONCILE_CODE],
  ]) {
    const body = code.slice(
      code.indexOf('function imageState('),
      code.indexOf('function imageState(') + 1400,
    );
    assert.ok(body.includes('JSON.parse'), `${label}: imageState body not found`);
    assert.doesNotMatch(
      body,
      /JSON\.parse\(r\.stdout\)\.state \?\? null/,
      `${label}: a shapeless response must not collapse to absent`,
    );
    assert.match(
      body,
      /typeof state === 'string'/,
      `${label}: must require an actual state string before believing it`,
    );
  }

  // And in the CLI it must reach the incomplete-probe exit, not pass as a clean report: the
  // whole 1-vs-2 split is "the plane disagrees" vs "do not trust this report".
  const cliBody = RECONCILE_CODE.slice(
    RECONCILE_CODE.indexOf('function imageState('),
    RECONCILE_CODE.indexOf('function nonTerminatedMicroVms('),
  );
  assert.match(
    cliBody,
    /no `state` field[\s\S]{0,80}?\}\);\s*return undefined;/,
    'a stateless response must be recorded as a probe failure and returned as unknown',
  );
  const failures = [...cliBody.matchAll(/probeFailures\.push\(/g)];
  assert.equal(
    failures.length,
    3,
    'all three unknown routes must be recorded: unreadable exit, stateless body, unparseable body',
  );
  assert.match(cliBody, /stderr: 'unparseable get-microvm-image response'/);

  // The verdict that unknown produces is the honest one, end to end.
  assert.equal(rowFor(obs({ imageState: undefined })).health, 'image_unverified');
  assert.equal(mayClaimLabel({ imageArn: ARN, imageState: undefined }), false);
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
  // Assert the token is SENT, not merely read back. `/nextToken/` alone matches the response
  // parse (`token = body.nextToken ?? …`), so deleting the `--next-token` push leaves this guard
  // green while every iteration silently re-requests page 1.
  assert.match(
    lister,
    /cmd\.push\('--next-token', token\)/,
    'must SEND the pagination token, not only read it back',
  );
  assert.match(lister, /token = body\.nextToken/, 'must read the next token from the response');
  assert.match(lister, /aws\(cmd\)/, 'must use aws(), which throws — unreadable is not empty');
  // The vocabulary comes from the shared module, not a literal pair in this script (see the
  // MicrovmState test below). A local `state !== 'TERMINATED' && state !== 'FAILED'` would be a
  // second copy of a safety predicate, and `FAILED` is not a MicrovmState at all.
  assert.match(
    lister,
    /reconcile\.isLiveMicroVmState\(/,
    'the live/terminal decision must come from the shared predicate',
  );
  assert.doesNotMatch(lister, /'FAILED'|"FAILED"/, 'FAILED is not a MicrovmState');

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
  const gateCall = mainBody.indexOf('assertQuiescentFleet(reconcile)');
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
    mainOnly.indexOf('assertQuiescentFleet(reconcile)'),
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
  // All pages, not the first: a single-page check would pass while VMs sit on page 2. Scope to
  // the fleet lister and assert the token is SENT — a file-wide `/nextToken/` also matches
  // `readImageArns`, and matching only the response parse survives deleting the request push.
  const lister = RECONCILE_CODE.slice(
    RECONCILE_CODE.indexOf('function nonTerminatedMicroVms('),
    RECONCILE_CODE.indexOf('function run('),
  );
  assert.ok(lister.length > 0, 'nonTerminatedMicroVms body not found');
  assert.match(
    lister,
    /cmd\.push\('--next-token', token\)/,
    'the fleet check must SEND the pagination token, not only read it back',
  );
  assert.match(lister, /token = body\.nextToken/);
  assert.match(
    lister,
    /reconcile\.isLiveMicroVmState\(/,
    'both gates must share one live/terminal predicate',
  );
  assert.doesNotMatch(lister, /'FAILED'|"FAILED"/, 'FAILED is not a MicrovmState');
  assert.match(RECONCILE_CODE, /non-terminated microVM/);
  const fixIdx = RECONCILE_CODE.indexOf('--fix: fleet is quiescent');
  const gateIdx = RECONCILE_CODE.indexOf('nonTerminatedMicroVms(reconcile)');
  assert.ok(gateIdx > 0 && fixIdx > gateIdx, 'the quiesce gate must precede any remediation');
});

test('--fix is rejected with --no-image-check', () => {
  // Adding a label on the strength of an unverified parameter is the ordering violation.
  //
  // Assert the live branch. The refusal MESSAGE lives INSIDE the block, so matching only that
  // text stays green after the condition is neutered to `if (false)` — which silently re-enables
  // exactly the `--fix --no-image-check` combination ADR-049 forbids.
  const refusal =
    /if \(NO_IMAGE_CHECK\)\s*\{[\s\S]{0,800}?--fix requires the real image state[\s\S]{0,600}?process\.exit\(2\);/.exec(
      RECONCILE_CODE,
    );
  assert.ok(
    refusal,
    'expected a live `if (NO_IMAGE_CHECK) { … --fix requires the real image state … exit(2) }`',
  );
  // And it must refuse before any action is chosen, not after.
  const fixGate = RECONCILE_CODE.indexOf('const actionable =');
  assert.ok(fixGate > 0 && refusal.index < fixGate, 'the refusal must precede fix selection');
});

test('--fix scores itself on a RE-READ of live state, not on child exit codes', () => {
  // Exiting 0 because every remediation returned 0 would claim an agreement the plane does not
  // have. `build-images` exits 0 when `runner-labels` is ABSENT: it publishes the image ARN,
  // warns, and refuses to CREATE the parameter (creating it from one flavor would drop every
  // other label). On an environment that skipped the phase-0 seed, every row is
  // `label_missing`/`not_built`, so a pre-fix "unfixable" snapshot is EMPTY — and scoring the run
  // against that snapshot reported success after adding no label at all, leaving the entire
  // catalog unrunnable. That is ADR-049 § 4c failing on its own terms, so the verdict has to come
  // from re-observing the plane.
  const fix = RECONCILE_CODE.slice(RECONCILE_CODE.indexOf('const actionable ='));
  assert.ok(fix.length > 0, '--fix block not found');

  // The observation must be a real second read, positioned AFTER the remediation loop...
  const loop = fix.indexOf('for (const r of actionable)');
  const reread = fix.indexOf('after = observe(reconcile)');
  assert.ok(loop > 0, 'remediation loop not found');
  assert.ok(reread > loop, 'the post-fix read must follow the remediation loop');

  // ...and the exit must be derived from THAT read, not from the pre-fix report.
  const verdict = /const remaining = after\.report\.rows\.filter\([\s\S]{0,900}?process\.exit\(1\);/.exec(
    fix,
  );
  assert.ok(
    verdict,
    'expected leftover drift to be computed from the post-fix report and exit 1',
  );
  assert.ok(verdict.index > reread, 'the verdict must be computed after re-reading');

  // The stale-snapshot verdict must be gone entirely, or it could be restored by accident.
  assert.doesNotMatch(
    fix,
    /const unfixable =/,
    'the pre-fix snapshot verdict must not survive alongside the re-read',
  );

  // A post-fix read that cannot complete its probes is UNKNOWN, not success. Match the live
  // BRANCH: `probeFailures.length` also appears in the diagnostic INSIDE that block, so a laxer
  // pattern stays green after the condition is neutered to `if (false)` — which silently lets an
  // AccessDenied on the second read pass as a verified fix.
  const postProbe = /if \(probeFailures\.length\) \{[\s\S]{0,600}?process\.exit\(2\);/.exec(fix);
  assert.ok(
    postProbe,
    'expected a live `if (probeFailures.length) { … process.exit(2) }` on the post-fix read',
  );
  assert.ok(
    postProbe.index > reread,
    'the post-fix probe check must follow the re-read, not precede it',
  );
  assert.ok(
    postProbe.index < verdict.index,
    'an incomplete post-fix probe must exit 2 before any drift verdict is reached',
  );

  // And the absent-allowlist cause is named, because the child only logged it.
  assert.match(fix, /after\.labels\.absent/, 'must diagnose an absent allowlist explicitly');
  assert.match(fix, /Seed it first/);
});

test('--fix emits exactly one JSON document, describing the post-fix state', () => {
  // Two JSON documents on one stdout breaks every parser, and the document a `--json --fix`
  // consumer needs is the state AFTER remediation — the same state the exit code describes.
  const pre = RECONCILE_CODE.slice(
    RECONCILE_CODE.indexOf('if (JSON_OUT) {'),
    RECONCILE_CODE.indexOf('const actionable ='),
  );
  assert.ok(pre.length > 0, 'pre-fix output block not found');
  assert.match(pre, /if \(!FIX\) \{/, 'the pre-fix JSON must be suppressed when fixing');
  const post = RECONCILE_CODE.slice(RECONCILE_CODE.indexOf('after = observe(reconcile)'));
  assert.match(post, /JSON\.stringify\(/, 'the post-fix path must emit the JSON document');
});

test('--json --fix still emits a document when nothing is safely fixable', () => {
  // `--json` suppresses the pre-fix document on the way in so that only one is printed. The
  // no-op branch therefore has to print one itself, or a `--json --fix` caller gets prose on
  // stdout and NO document to reconcile against the exit code — unparseable, and
  // indistinguishable from a crash. Both exits are reachable without any drift being fixable: a
  // healthy environment (every row `ok`, exit 0) and an in-flight build (`image_building` is
  // warn with `safeFix: null`, exit 1).
  const branch = /if \(actionable\.length === 0\) \{[\s\S]{0,1400}?process\.exit\(report\.drift \? 1 : 0\);/.exec(
    RECONCILE_CODE,
  );
  assert.ok(branch, 'the nothing-fixable branch was not found');
  // The document must be emitted INSIDE that branch, gated on --json...
  assert.match(
    branch[0],
    /if \(JSON_OUT\) \{[\s\S]{0,400}?JSON\.stringify\(/,
    'the no-op fix path must emit its own JSON document',
  );
  // ...and carry the same keys as the post-fix document, so a consumer parses one schema.
  const doc = /JSON\.stringify\(\s*\{([\s\S]{0,400}?)\}/.exec(branch[0]);
  assert.ok(doc, 'no JSON payload found in the no-op fix branch');
  for (const key of ['env', 'region', 'fixed', 'labels', 'probeFailures']) {
    assert.match(doc[1], new RegExp(`\\b${key}\\b`), `the no-op document omits ${key}`);
  }
  assert.match(doc[1], /fixed: \[\]/, 'nothing was fixed, so `fixed` must be empty');
  // The human-readable line stays for a non-JSON run.
  assert.match(branch[0], /nothing safely fixable/);
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

// --- `--json` stdout really is one parseable document (ADR-049) --------------
//
// The source-level assertions above prove the no-op `--fix` branch CONTAINS a
// `JSON.stringify`. They cannot prove that what lands on stdout parses, and it did not: the
// deploy-target pin printed `✓ deploy target verified: …` to stdout ahead of every document, so
// `JSON.parse(stdout)` threw on all four --json paths while ADR-049 and the RUNBOOK promised a
// consumer exactly one document matching the exit code. These tests run the CLI for real
// against a stub `aws` and parse its stdout, which is the only way that claim can be checked.

/** A stub `aws` on PATH, so the CLI's real spawnSync calls resolve to a scripted plane. */
function stubAws(dir, { labels, imageStates }) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const params = catalogFlavors().map((f) => ({
    Name: `/lca/dev/config/image-arn-${f.name}`,
    Value: `arn:fake:${f.name}`,
  }));
  const script = `#!/usr/bin/env node
const a = process.argv.slice(2);
const has = (s) => a.includes(s);
if (a[0] === 'sts') { console.log(process.env.LCA_DEPLOY_ACCOUNT); process.exit(0); }
if (a[0] === 'ssm' && a[1] === 'get-parameter') {
  const name = a[a.indexOf('--name') + 1];
  const m = /image-arn-(.+)$/.exec(name);
  if (m) { console.log('arn:fake:' + m[1]); process.exit(0); }
  console.log(${JSON.stringify(labels)}); process.exit(0);
}
if (a[0] === 'ssm' && a[1] === 'get-parameters-by-path') {
  console.log(JSON.stringify({ Parameters: ${JSON.stringify(params)} })); process.exit(0);
}
if (a[0] === 'lambda-microvms' && a[1] === 'get-microvm-image') {
  const arn = a[a.indexOf('--image-identifier') + 1];
  const states = ${JSON.stringify(imageStates)};
  console.log(JSON.stringify({ state: states[arn.replace('arn:fake:', '')] ?? 'UPDATED' }));
  process.exit(0);
}
if (a[0] === 'lambda-microvms' && a[1] === 'list-microvms') { console.log('{"microvms":[]}'); process.exit(0); }
process.exit(1);
`;
  const p = path.join(bin, 'aws');
  fs.writeFileSync(p, script, { mode: 0o755 });
  return bin;
}

/**
 * Run the CLI with a stubbed plane. The pin is supplied through the process environment
 * (ADR-047) so the test does not depend on a gitignored `.env.local`; the stub echoes the same
 * account back from `sts get-caller-identity`, so the identity comparison is still exercised.
 */
function runReconcile(args, plane) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-reconcile-cli-'));
  const bin = stubAws(dir, plane);
  const account = '863638663908';
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'flavors-reconcile.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      LCA_DEPLOY_ACCOUNT: account,
      LCA_DEPLOY_REGION: 'us-west-2',
      LCA_DEPLOY_ENV: '',
    },
    cwd: REPO_ROOT,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ALL_LABELS = catalogFlavors()
  .map((f) => f.label)
  .join(',');

test('--json: stdout is exactly one parseable document on a healthy plane (exit 0)', () => {
  const r = runReconcile(['--json'], { labels: ALL_LABELS, imageStates: {} });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
  const doc = JSON.parse(r.stdout); // throws if anything else reached stdout
  assert.equal(doc.drift, false);
  assert.equal(doc.rows.length, catalogFlavors().length);
  // The pin confirmation is still emitted — on stderr, where it cannot corrupt the document.
  assert.match(r.stderr, /deploy target verified/);
  assert.doesNotMatch(r.stdout, /deploy target verified/);
});

test('--json --fix: one parseable document with an empty `fixed` when nothing is fixable', () => {
  // Exit 0 flavour of the no-op branch: healthy plane, so no row carries a safeFix.
  const r = runReconcile(['--json', '--fix'], { labels: ALL_LABELS, imageStates: {} });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.fixed, [], 'nothing was remediated');
  assert.equal(doc.drift, false);
});

test('--json --fix: one parseable document on the exit-1 no-op branch (build in flight)', () => {
  // `image_building` is warn with safeFix null: drift, but nothing safe to do. Before the fix
  // this path printed prose and no document at all, so a consumer could not tell it from a
  // crash.
  const r = runReconcile(['--json', '--fix'], {
    labels: ALL_LABELS,
    imageStates: { rust: 'CREATING' },
  });
  assert.equal(r.status, 1, `expected exit 1 (drift), got ${r.status}\n${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.fixed, []);
  assert.equal(doc.drift, true);
  const rust = doc.rows.find((row) => row.name === 'rust');
  assert.equal(rust.health, 'image_building');
  assert.equal(rust.safeFix, null);
});

test('--json and --json --fix documents share one schema', () => {
  const plain = JSON.parse(runReconcile(['--json'], { labels: ALL_LABELS, imageStates: {} }).stdout);
  const fixed = JSON.parse(
    runReconcile(['--json', '--fix'], { labels: ALL_LABELS, imageStates: {} }).stdout,
  );
  // `fixed` is the only key --fix adds; everything a consumer reads is present in both.
  assert.deepEqual(
    Object.keys(fixed).filter((k) => k !== 'fixed').sort(),
    Object.keys(plain).sort(),
  );
});

test('--fix progress narration and the child build go to stderr under --json', () => {
  // Even with the document emitted, the remediation path wrote three progress lines to stdout
  // and ran `build-images` with stdio:'inherit', so a successful fix produced prose AND a
  // document on the same stream. Both are gated now.
  const fixBlock = RECONCILE_CODE.slice(
    RECONCILE_CODE.indexOf('fleet is quiescent'),
    RECONCILE_CODE.indexOf('let after;'),
  );
  assert.ok(fixBlock.length > 0, 'remediation block not found');
  assert.ok(
    fixBlock.includes('build-images.mjs'),
    'the slice must actually cover the remediation loop',
  );
  assert.doesNotMatch(
    fixBlock,
    /console\.log\(/,
    'the remediation path must not write to stdout — use note(), which respects --json',
  );
  // `note` must actually route on JSON_OUT rather than being an alias for console.log.
  assert.match(
    RECONCILE_CODE,
    /const note = \(msg\) => \(JSON_OUT \? console\.error\(msg\) : console\.log\(msg\)\)/,
    'note() must send narration to stderr under --json',
  );
  // And the child's stdout must not land on ours.
  const runFn = RECONCILE_CODE.slice(
    RECONCILE_CODE.indexOf('function run(cmd, cmdArgs)'),
    RECONCILE_CODE.indexOf('const SEV_MARK'),
  );
  assert.match(runFn, /JSON_OUT \?/, 'run() must redirect the child under --json');
  assert.doesNotMatch(runFn, /spawnSync\(cmd, cmdArgs, \{ stdio: 'inherit' \}\)/);
});
