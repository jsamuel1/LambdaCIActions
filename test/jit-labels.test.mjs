// JIT runner labels + mint-failure classification (ADR-030, src/provision/labels.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_JIT_LABELS,
  NoRunnerLabelsError,
  TooManyRunnerLabelsError,
  classifyMintFailure,
  jitRunnerLabels,
} from '../dist/src/provision/labels.js';

test('label-mode labels pass through unchanged (order preserved)', () => {
  assert.deepEqual(jitRunnerLabels(['self-hosted', 'lambda-ci-node']), [
    'self-hosted',
    'lambda-ci-node',
  ]);
});

test('adopt-mode keeps the hosted label — GitHub matches on the job\u2019s own label set', () => {
  // If we stripped `ubuntu-latest` the runner would never be assigned the job: labels are
  // cumulative, so the runner must advertise every label in runs-on.
  assert.deepEqual(jitRunnerLabels(['ubuntu-latest']), ['ubuntu-latest']);
});

test('duplicates are removed case-insensitively, first spelling wins', () => {
  assert.deepEqual(jitRunnerLabels(['Lambda-CI', 'lambda-ci', 'LAMBDA-CI']), ['Lambda-CI']);
});

test('unresolved matrix expressions are dropped, not registered as labels', () => {
  assert.deepEqual(jitRunnerLabels(['self-hosted', '${{ matrix.os }}', 'lambda-ci']), [
    'self-hosted',
    'lambda-ci',
  ]);
});

test('blank labels are dropped; the full normalized set is returned (no silent truncation)', () => {
  assert.deepEqual(jitRunnerLabels(['', '  ', 'lambda-ci']), ['lambda-ci']);
  // Normalization must NOT cap: truncating at MAX_JIT_LABELS would drop a REQUIRED label from
  // a job that `decideClaim` already claimed on the full set, and GitHub matches cumulatively
  // — the runner could never be assigned the job it was launched for. The over-cap case is a
  // pre-mint REFUSAL in Provision instead (TooManyRunnerLabelsError).
  const many = Array.from({ length: MAX_JIT_LABELS + 10 }, (_, i) => `l${i}`);
  assert.equal(jitRunnerLabels(many).length, MAX_JIT_LABELS + 10);
  // The specific shape that made truncation dangerous: the LCA label sits past the cap.
  const buried = [...Array.from({ length: MAX_JIT_LABELS }, (_, i) => `l${i}`), 'lambda-ci'];
  assert.ok(jitRunnerLabels(buried).includes('lambda-ci'));
});

test('an over-cap label set is a PERMANENT refusal, not a truncated mint', () => {
  const labels = Array.from({ length: MAX_JIT_LABELS + 1 }, (_, i) => `l${i}`);
  const c = classifyMintFailure(new TooManyRunnerLabelsError(labels).message, labels);
  assert.equal(c.kind, 'permanent');
  assert.match(c.reason, /more runner labels than we can register/);
  // Actionable: states the observed count, the cap, and what to change.
  assert.match(c.reason, new RegExp(String(labels.length)));
  assert.match(c.reason, new RegExp(String(MAX_JIT_LABELS)));
  assert.match(c.reason, /reduce this job's runs-on/);
});

test('an entirely expression-driven runs-on normalizes to NOTHING (must not be minted)', () => {
  // Regression guard: expressions are dropped as non-labels, so these yield an empty set.
  // Minting with `labels: []` is accepted by GitHub and produces a runner carrying only the
  // automatic defaults (self-hosted/linux/ARM64) — which cannot satisfy the job's real
  // selector. The VM would boot, consume the single-use JIT config, match nothing, and idle
  // until the Reaper: paid compute that could never take the job. Provision refuses BEFORE
  // the mint on this condition.
  assert.deepEqual(jitRunnerLabels(['${{ matrix.os }}']), []);
  assert.deepEqual(jitRunnerLabels(['${{ matrix.os }}', '  ']), []);
  assert.deepEqual(jitRunnerLabels([]), []);
});

test('the empty-label refusal is classified PERMANENT, not a transient network error', () => {
  // It never reaches GitHub, so it carries no `HTTP <status>` — the status-based rule would
  // otherwise read it as transient and retry a request that can never succeed.
  const err = new NoRunnerLabelsError(['${{ matrix.os }}']);
  const c = classifyMintFailure(err.message, []);
  assert.equal(c.kind, 'permanent');
  assert.match(c.reason, /no usable runner label/);
  // The reason must tell the operator what to change.
  assert.match(c.reason, /lambda-ci|matrix values/);
});

test('5xx and 429 are transient — worth a redelivery', () => {
  assert.equal(classifyMintFailure('GitHub /x failed HTTP 500: boom').kind, 'transient');
  assert.equal(classifyMintFailure('GitHub /x failed HTTP 502').kind, 'transient');
  assert.equal(classifyMintFailure('GitHub /x failed HTTP 429: rate limited').kind, 'transient');
});

test('a network error with no status is treated as transient', () => {
  assert.equal(classifyMintFailure('fetch failed').kind, 'transient');
});

test('4xx is permanent — retrying the same request cannot help', () => {
  const c = classifyMintFailure('GitHub /x failed HTTP 404: Not Found');
  assert.equal(c.kind, 'permanent');
  assert.match(c.reason, /rejected by GitHub/);
});

test('a 422 on a hosted label explains the adopt-mode fix', () => {
  const c = classifyMintFailure('GitHub /x failed HTTP 422: Validation Failed', [
    'ubuntu-latest',
  ]);
  assert.equal(c.kind, 'permanent');
  assert.match(c.reason, /GitHub-hosted runner label/);
  assert.match(c.reason, /`label` mode/);
  assert.match(c.reason, /auto-rewrite/);
});

test('a 422 without a hosted label gets the generic permanent message', () => {
  const c = classifyMintFailure('GitHub /x failed HTTP 422: Validation Failed', ['lambda-ci']);
  assert.equal(c.kind, 'permanent');
  assert.match(c.reason, /rejected by GitHub/);
});
