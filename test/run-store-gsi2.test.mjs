// Unit tests for the M4 run-history index keys (src/shared/run-store.ts GSI2, ADR-023)
// and the opaque pagination cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repoGsiKeys,
  statusGsiKeys,
  buildQueuedItem,
  encodeCursor,
  decodeCursor,
  runPk,
  RUN_SK,
} from '../dist/src/shared/run-store.js';

test('repo/time index keys are immutable components', () => {
  const keys = repoGsiKeys(42, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(keys, { gsi2pk: 'REPORUNS#42', gsi2sk: '2026-07-01T00:00:00.000Z' });
});

test('a queued run row carries BOTH indexes', () => {
  const item = buildQueuedItem(
    {
      repoId: 7,
      repoFullName: 'acme/service',
      installationId: 1,
      runId: 100,
      jobId: 200,
      labels: ['lambda-ci'],
    },
    new Date('2026-07-01T00:00:00.000Z'),
  );
  assert.equal(item.pk, runPk(7, 100, 200));
  assert.equal(item.sk, RUN_SK);
  assert.equal(item.gsi1pk, 'RUNSTATUS#queued');
  assert.equal(item.gsi2pk, 'REPORUNS#7');
  // GSI2 sort key is createdAt, NOT updatedAt — status transitions must not move it.
  assert.equal(item.gsi2sk, item.createdAt);
  assert.equal(item.gsi1sk, item.updatedAt);
});

test('status index and repo index use different partitions', () => {
  const s = statusGsiKeys('running', 'now');
  const r = repoGsiKeys(1, 'now');
  assert.notEqual(s.gsi1pk, r.gsi2pk);
});

test('cursors round-trip and tolerate garbage', () => {
  const key = { pk: 'RUN#1#2#3', sk: 'RUN', gsi2pk: 'REPORUNS#1', gsi2sk: 'x' };
  const cursor = encodeCursor(key);
  assert.deepEqual(decodeCursor(cursor), key);
  assert.equal(encodeCursor(undefined), undefined);
  assert.equal(decodeCursor(undefined), undefined);
  assert.equal(decodeCursor('!!!not-base64!!!'), undefined);
  assert.equal(decodeCursor(Buffer.from('"a string"').toString('base64url')), undefined);
});
