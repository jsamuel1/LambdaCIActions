// Provision's config guard ordering (ADR-021). `HOOK_BROKER_NAME` is required to build the
// run-hook payload; without it every launched VM 400s its own /run. The guard therefore has
// to fire BEFORE the single-use GitHub JIT config is minted — otherwise a misconfigured
// deploy burns one registration credential per SQS delivery on VMs that can never start,
// and only DLQs after maxReceiveCount. Ordering is the whole property, so pin it on the
// source (the handler reaches AWS through module imports, not injectable deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'provision',
  'handler.ts',
);
const src = fs.readFileSync(SRC, 'utf8');

test('the broker-name guard runs before the JIT config is minted', () => {
  const guard = src.indexOf("if (!brokerName) throw new Error('HOOK_BROKER_NAME");
  const mint = src.indexOf('await generateJitConfig(');
  const stash = src.indexOf('await putJitConfig(');
  const launch = src.indexOf('await launchMicroVM(');
  const transition = src.indexOf('await transitionRun(');

  assert.ok(guard > 0, 'HOOK_BROKER_NAME guard not found');
  assert.ok(mint > 0 && stash > 0 && launch > 0, 'provision steps not found');
  assert.ok(guard < mint, 'guard must precede generateJitConfig (single-use credential)');
  assert.ok(guard < stash, 'guard must precede putJitConfig');
  assert.ok(guard < launch, 'guard must precede launchMicroVM');
  // Also ahead of the queued→provisioning transition: a config fault should not consume the
  // run's forward-only status budget (a retry after the transition can no longer re-advance).
  assert.ok(guard < transition, 'guard must precede the queued→provisioning transition');
});

test('the payload broker name comes from the guarded value, not a bare env read', () => {
  // `broker: process.env.HOOK_BROKER_NAME ?? ''` would defeat the guard by re-reading (and
  // silently defaulting) the value the payload actually ships.
  assert.match(src, /broker: brokerName,/);
  const envReads = src.match(/process\.env\.HOOK_BROKER_NAME/g) ?? [];
  assert.equal(envReads.length, 1, 'HOOK_BROKER_NAME should be read exactly once');
});

// ADR-021: the two brokered actions authorize against different items, so the SAME hash has
// to reach both — the JIT config item (jitconfig, TTL'd) and the run row (terminate, durable).
// Mint once, hash once, write the hash twice, and hand the PLAINTEXT only to the VM payload.
test('one token is minted per run and its hash is written to both items', () => {
  const mint = src.match(/const hookToken = randomBytes\(32\)\.toString\('base64url'\);/g) ?? [];
  assert.equal(mint.length, 1, 'exactly one token mint per provisioned run');
  const hashes = src.match(/hashHookToken\(/g) ?? [];
  assert.equal(hashes.length, 1, 'hash the token once, reuse the value');

  const stash = src.indexOf('await putJitConfig(');
  const stamp = src.indexOf('await stampMicrovmId({');
  const stashArgs = src.slice(stash, src.indexOf('});', stash));
  const stampArgs = src.slice(stamp, src.indexOf('})', stamp));
  assert.match(stashArgs, /hookTokenHash,/, 'JIT config item must carry the hash (jitconfig)');
  assert.match(stampArgs, /hookTokenHash,/, 'run row must mirror the hash (terminate)');
});

test('the plaintext token is never persisted, only shipped in the launch payload', () => {
  const plaintextUses = src.match(/\bhookToken\b(?!Hash)/g) ?? [];
  // mint + hash input + payload field + the launch-failure redaction input = 4; anything
  // more risks a write to the store.
  assert.equal(plaintextUses.length, 4, `unexpected hookToken uses: ${plaintextUses.length}`);
  assert.match(src, /token: hookToken,/);
  // The 4th use must be exactly the redaction of the launch error (ADR-021): the control
  // plane holds the plaintext, and an SDK error echoes the payload back into the run row's
  // `reason`. See test/provision-redaction.test.mjs.
  assert.match(src, /redactSecret\(errMsg\(err\), hookToken\)/);
  const stash = src.indexOf('await putJitConfig(');
  assert.doesNotMatch(
    src.slice(stash, src.indexOf('});', stash)),
    /\bhookToken\b(?!Hash)/,
    'the plaintext token must never be stored on the JIT config item',
  );
});

// A TRANSIENT mint failure must not write a terminal status. `failed` is terminal, so the
// redelivered message's queued→provisioning guard (canTransition) would refuse to advance the
// row and return early — the SQS retry we asked for would never reach generateJitConfig again.
test('a transient JIT mint failure rethrows before any terminal transition', () => {
  const mintCatch = src.indexOf('const { kind, reason } = classifyMintFailure(');
  assert.ok(mintCatch > 0, 'mint failure classification not found');
  const rethrow = src.indexOf("if (kind === 'transient') throw new Error(reason);", mintCatch);
  const failWrite = src.indexOf("to: 'failed',", mintCatch);
  assert.ok(rethrow > 0, 'transient rethrow not found');
  assert.ok(failWrite > 0, 'permanent failure transition not found');
  assert.ok(
    rethrow < failWrite,
    'the transient rethrow must precede the failed transition, or a retryable mint is terminalized',
  );
});

// The SAME invariant on the LAUNCH path, which had the opposite bug: a quota throttle is
// capacity, not correctness (spec 05 § Quotas), and RUNBOOK's quota-throttle entry promises
// "jobs wait rather than fail once the throttled message is redelivered". Writing `failed`
// before rethrowing broke that promise silently: the row is terminal, so the redelivered
// message's queued→provisioning guard returns early and the retry never re-attempts the
// launch. One throttle permanently failed a job that only needed to wait.
test('a quota-throttled launch rethrows WITHOUT writing a terminal status', () => {
  const launchCatch = src.indexOf('const quota = isQuotaError(err);');
  assert.ok(launchCatch > 0, 'launch-failure quota classification not found');
  const quotaRethrow = src.indexOf('if (quota) {', launchCatch);
  const failWrite = src.indexOf("to: 'failed',", launchCatch);
  assert.ok(quotaRethrow > 0, 'quota rethrow branch not found');
  assert.ok(failWrite > 0, 'launch-failure transition not found');
  assert.ok(
    quotaRethrow < failWrite,
    'the quota rethrow must precede the failed transition, or a retryable throttle is terminalized',
  );
  // The throttle must still be counted before it is rethrown, or the alarm never fires.
  const emit = src.indexOf("{ name: 'QuotaThrottles'", launchCatch);
  assert.ok(emit > 0 && emit < quotaRethrow, 'QuotaThrottles must be emitted before the rethrow');
});

// A job whose `runs-on` is entirely `${{ … }}` normalizes to NO labels (expressions are not
// labels). Minting with `labels: []` succeeds: GitHub gives the runner only its automatic
// defaults, which cannot match the job's real selector. The VM boots, consumes the single-use
// JIT config, matches nothing, and idles until the Reaper — paid compute that could never take
// the job. The refusal therefore has to happen BEFORE the mint, like the broker guard.
test('an empty normalized label set is refused before the JIT config is minted', () => {
  const guard = src.indexOf('if (!runnerLabels.length) throw new NoRunnerLabelsError(');
  const mint = src.indexOf('await generateJitConfig(');
  const stash = src.indexOf('await putJitConfig(');
  const launch = src.indexOf('await launchMicroVM(');

  assert.ok(guard > 0, 'empty-label guard not found');
  assert.ok(guard < mint, 'guard must precede generateJitConfig (single-use credential)');
  assert.ok(guard < stash, 'guard must precede putJitConfig');
  assert.ok(guard < launch, 'guard must precede launchMicroVM');

  // It must land inside the mint try/catch so `classifyMintFailure` turns it into an
  // actionable run reason (permanent) rather than an unhandled throw that SQS retries.
  const tryStart = src.lastIndexOf('try {', guard);
  const mintCatch = src.indexOf('const { kind, reason } = classifyMintFailure(');
  assert.ok(tryStart > 0 && tryStart < guard && guard < mintCatch, 'guard must sit in the mint try');
});

// The labels we advertise must be the NORMALIZED set, not the raw webhook labels: sending
// `${{ matrix.os }}` verbatim registers a junk label that matches nothing.
test('the mint is given the normalized label set, not req.labels', () => {
  const mintStart = src.indexOf('await generateJitConfig(');
  const mintCall = src.slice(mintStart, src.indexOf('});', mintStart));
  assert.match(mintCall, /labels: runnerLabels,/);
  assert.doesNotMatch(mintCall, /labels: req\.labels/);
});

// The MIRROR of the empty-label guard. `decideClaim` claims on the FULL webhook label set, so
// a job like `[l1 … l20, lambda-ci]` is claimed — and a normalization that silently TRUNCATED
// at MAX_JIT_LABELS would then register a runner that never advertises `lambda-ci`. GitHub
// matches cumulatively, so that runner can never be assigned the job it was launched for: the
// VM boots, burns the single-use JIT config, matches nothing, and idles until the Reaper —
// while the run row already says `running`. Refuse pre-mint instead, in the same try so the
// failure becomes an actionable permanent reason.
test('an over-cap label set is refused before the JIT config is minted', () => {
  const guard = src.indexOf('if (runnerLabels.length > MAX_JIT_LABELS) throw new TooManyRunnerLabelsError(');
  const mint = src.indexOf('await generateJitConfig(');
  const stash = src.indexOf('await putJitConfig(');
  const launch = src.indexOf('await launchMicroVM(');

  assert.ok(guard > 0, 'over-cap label guard not found');
  assert.ok(guard < mint, 'guard must precede generateJitConfig (single-use credential)');
  assert.ok(guard < stash, 'guard must precede putJitConfig');
  assert.ok(guard < launch, 'guard must precede launchMicroVM');

  const tryStart = src.lastIndexOf('try {', guard);
  const mintCatch = src.indexOf('const { kind, reason } = classifyMintFailure(');
  assert.ok(tryStart > 0 && tryStart < guard && guard < mintCatch, 'guard must sit in the mint try');
});
