// The config store's two write-safety behaviours (ADR-028 review follow-up):
//
//   1. `recordWebhookRejection` is the ONE heartbeat write reachable before authentication
//      (the /webhook endpoint is public; the signature check is what rejects an anonymous
//      caller). It must be rate-bounded so junk POSTs cannot drive unbounded WCUs.
//   2. `acquire/releaseConfigLock` serialize platform config MUTATIONS via a conditional
//      UpdateItem — chosen over a Lambda concurrency cap so the polled read path stays free.
//
// The DynamoDB seam is faked by intercepting the document client's `send`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'lca-test-table';

const store = await import('../dist/src/shared/config-store.js');
const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');

/** Capture commands; `conditionFails` models a failed ConditionExpression. */
function intercept({ conditionFails = false } = {}) {
  const sent = [];
  const original = DynamoDBDocumentClient.prototype.send;
  DynamoDBDocumentClient.prototype.send = async function (cmd) {
    sent.push(cmd.input);
    if (conditionFails) {
      throw Object.assign(new Error('conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      });
    }
    return {};
  };
  return { sent, restore: () => (DynamoDBDocumentClient.prototype.send = original) };
}

test('the pre-auth rejection heartbeat is guarded by a time-window condition', async () => {
  const i = intercept();
  try {
    await store.recordWebhookRejection('2026-07-29T00:00:00.000Z', 60_000);
  } finally {
    i.restore();
  }
  const input = i.sent[0];
  assert.ok(input.ConditionExpression, 'an unconditional write is an anonymous WCU amplifier');
  assert.match(input.ConditionExpression, /lastRejectedMs/);
  // The cutoff is the window applied to the event time, so a second junk POST inside the
  // window fails the condition instead of writing.
  assert.equal(input.ExpressionAttributeValues[':cutoff'], Date.parse('2026-07-29T00:00:00.000Z') - 60_000);
});

test('a throttled rejection write is swallowed, not surfaced as an error', async () => {
  const i = intercept({ conditionFails: true });
  try {
    // A rejection already recorded inside the window is the throttle working, not a fault —
    // and Ingest must still return 401 rather than 500.
    await store.recordWebhookRejection();
  } finally {
    i.restore();
  }
});

test('the accepted-delivery heartbeat stays unconditional (it is authenticated)', async () => {
  const i = intercept();
  try {
    await store.recordWebhookDelivery({ event: 'push', deliveryId: 'abc' });
  } finally {
    i.restore();
  }
  assert.equal(i.sent[0].ConditionExpression, undefined);
});

test('the config lock is acquired only when free or expired', async () => {
  const i = intercept();
  let ok;
  try {
    ok = await store.acquireConfigLock('alice:1', 90_000, 1_000_000);
  } finally {
    i.restore();
  }
  assert.equal(ok, true);
  const input = i.sent[0];
  assert.equal(input.ConditionExpression, 'attribute_not_exists(expiresAt) OR expiresAt < :now');
  assert.equal(input.ExpressionAttributeValues[':exp'], 1_090_000);
});

test('a held lock reports false rather than throwing', async () => {
  const i = intercept({ conditionFails: true });
  let ok;
  try {
    ok = await store.acquireConfigLock('bob:2');
  } finally {
    i.restore();
  }
  assert.equal(ok, false);
});

test('release is conditional on still being the holder', async () => {
  const i = intercept();
  try {
    await store.releaseConfigLock('alice:1');
  } finally {
    i.restore();
  }
  assert.equal(i.sent[0].ConditionExpression, 'holder = :h');
});
