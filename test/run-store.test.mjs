// Unit tests for the run-store state machine + pure key/item helpers (src/shared/run-store.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  isTerminal,
  runPk,
  RUN_SK,
  statusGsiKeys,
  buildQueuedItem,
  buildStampUpdate,
} from '../dist/src/shared/run-store.js';

test('forward transitions are allowed', () => {
  assert.equal(canTransition('queued', 'provisioning'), true);
  assert.equal(canTransition('provisioning', 'running'), true);
  assert.equal(canTransition('running', 'completed'), true);
  assert.equal(canTransition('queued', 'running'), true); // skip is a forward move
  assert.equal(canTransition('provisioning', 'failed'), true);
});

test('same-status re-writes are idempotent (allowed)', () => {
  assert.equal(canTransition('running', 'running'), true);
  assert.equal(canTransition('completed', 'completed'), true);
});

test('backward transitions are rejected', () => {
  assert.equal(canTransition('running', 'queued'), false);
  assert.equal(canTransition('running', 'provisioning'), false);
  assert.equal(canTransition('provisioning', 'queued'), false);
});

test('terminal states are final', () => {
  assert.equal(canTransition('completed', 'running'), false);
  assert.equal(canTransition('failed', 'running'), false);
  assert.equal(canTransition('timed_out', 'completed'), false);
  // different terminal → different terminal is rejected
  assert.equal(canTransition('completed', 'failed'), false);
});

test('isTerminal identifies terminal states', () => {
  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('failed'), true);
  assert.equal(isTerminal('timed_out'), true);
  assert.equal(isTerminal('running'), false);
  assert.equal(isTerminal('queued'), false);
});

test('runPk combines the idempotency triple; SK is constant', () => {
  assert.equal(runPk(99, 7, 42), 'RUN#99#7#42');
  assert.equal(RUN_SK, 'RUN');
});

test('statusGsiKeys builds the status/time index keys', () => {
  const { gsi1pk, gsi1sk } = statusGsiKeys('running', '2026-07-11T00:00:00.000Z');
  assert.equal(gsi1pk, 'RUNSTATUS#running');
  assert.equal(gsi1sk, '2026-07-11T00:00:00.000Z');
});

test('buildQueuedItem produces a complete queued row with matching keys', () => {
  const now = new Date('2026-07-11T00:00:00.000Z');
  const item = buildQueuedItem(
    {
      repoId: 99,
      repoFullName: 'octo/repo',
      installationId: 555,
      runId: 7,
      jobId: 42,
      labels: ['lambda-ci'],
    },
    now,
  );
  assert.equal(item.pk, 'RUN#99#7#42');
  assert.equal(item.sk, 'RUN');
  assert.equal(item.status, 'queued');
  assert.equal(item.gsi1pk, 'RUNSTATUS#queued');
  assert.equal(item.gsi1sk, '2026-07-11T00:00:00.000Z');
  assert.equal(item.createdAt, item.updatedAt);
  assert.equal(item.entity, 'RUN');
  assert.deepEqual(item.labels, ['lambda-ci']);
});

// ADR-020: the stamp write is the ONLY place the hook capability token hash reaches the
// durable run row, and that row is what authorizes the brokered terminate at job end (the
// JIT config item carrying the same hash ages out after 30 min). Pin both shapes.
test('the stamp write mirrors the hook token hash onto the run row', () => {
  const { updateExpression, values } = buildStampUpdate('mvm-123', 'a'.repeat(64));
  assert.equal(updateExpression, 'SET microvmId = :mid, hookTokenHash = :hth');
  assert.deepEqual(values, { ':mid': 'mvm-123', ':hth': 'a'.repeat(64) });
});

test('a stamp with no token hash omits the attribute entirely', () => {
  // Not `:hth = undefined`: DynamoDB rejects a placeholder with no value, and an empty hash
  // would authorize nothing, stranding self-terminate on the Reaper (ADR-019 regression).
  const { updateExpression, values } = buildStampUpdate('mvm-123');
  assert.equal(updateExpression, 'SET microvmId = :mid');
  assert.deepEqual(values, { ':mid': 'mvm-123' });
  assert.ok(!(':hth' in values));
});
