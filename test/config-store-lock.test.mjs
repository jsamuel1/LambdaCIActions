// The config store's two write-safety behaviours (ADR-034 review follow-up):
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

// `at` is a DynamoDB RESERVED WORD (as is `action`), so an audit write that names it
// literally fails with a ValidationException. Both call sites swallow audit failures on
// purpose (an audit write must never fail an operator action), which makes the breakage
// silent: "Recent platform changes" would simply always be empty. Assert every attribute
// name in the update expression is aliased.
test('the audit write aliases every reserved attribute name', async () => {
  const i = intercept();
  try {
    await store.appendAudit({
      at: '2026-07-29T00:00:00.000Z',
      actor: 'alice',
      action: 'runner-labels-change',
      detail: 'from [a] to [b]',
      nonce: 'fixed',
    });
  } finally {
    i.restore();
  }
  const input = i.sent[0];
  assert.equal(input.Key.sk, '2026-07-29T00:00:00.000Z#fixed');
  for (const reserved of ['action', 'at']) {
    assert.match(
      input.UpdateExpression,
      new RegExp(`#${reserved} = :${reserved}\\b`),
      `"${reserved}" is a DynamoDB reserved word and must be aliased`,
    );
    assert.equal(input.ExpressionAttributeNames[`#${reserved}`], reserved);
  }
  // A bare `<reserved> =` anywhere in the expression is the bug this test exists to catch.
  assert.doesNotMatch(input.UpdateExpression, /(^|[\s,])(at|action) =/);
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

// ---- shared status cache (review follow-up) --------------------------------
//
// The broker's in-memory `status` cache does not bound GitHub spend on its own: `GET
// /api/settings` is readable by ANY authenticated session (ADR-035), and concurrent reads scale
// the broker out to fresh containers whose caches are all cold. `status` costs four App-JWT
// calls against the App's 5,000/h budget — the same budget Provision spends minting a token per
// job — so the bound has to be platform-wide.

test('the shared status cache row is keyed CONFIG#STATUS and aliases the reserved `at`', async () => {
  const i = intercept();
  try {
    await store.putStatusCache({ ok: true }, 1_000_000);
  } finally {
    i.restore();
  }
  const input = i.sent[0];
  assert.equal(input.Key.pk, 'CONFIG#STATUS', 'must fall under the broker\u2019s CONFIG# key scope');
  assert.equal(input.ExpressionAttributeNames['#at'], 'at');
  assert.doesNotMatch(input.UpdateExpression, /(^|[\s,])at =/);
  assert.equal(input.ExpressionAttributeValues[':at'], 1_000_000);
});

test('a fresh shared cache row is reused; a stale one is ignored', async () => {
  const original = DynamoDBDocumentClient.prototype.send;
  DynamoDBDocumentClient.prototype.send = async () => ({
    Item: { pk: 'CONFIG#STATUS', sk: 'LINKAGE', at: 1_000_000, payload: { ok: true } },
  });
  try {
    assert.deepEqual(await store.getStatusCache(30_000, 1_010_000), { ok: true });
    // At/over the TTL the answer must be re-verified against GitHub, or a relink by another
    // operator would be invisible for longer than the window.
    assert.equal(await store.getStatusCache(30_000, 1_030_000), undefined);
  } finally {
    DynamoDBDocumentClient.prototype.send = original;
  }
});

test('a malformed or absent shared cache row is a miss, not a crash', async () => {
  const original = DynamoDBDocumentClient.prototype.send;
  const rows = [undefined, { at: 'nope', payload: {} }, { at: 1, /* no payload */ }];
  try {
    for (const Item of rows) {
      DynamoDBDocumentClient.prototype.send = async () => (Item ? { Item } : {});
      assert.equal(await store.getStatusCache(30_000, 1), undefined);
    }
  } finally {
    DynamoDBDocumentClient.prototype.send = original;
  }
});

test('invalidation zeroes the timestamp so every container re-verifies', async () => {
  const i = intercept();
  try {
    await store.clearStatusCache();
  } finally {
    i.restore();
  }
  assert.equal(i.sent[0].Key.pk, 'CONFIG#STATUS');
  assert.equal(i.sent[0].ExpressionAttributeValues[':zero'], 0);
  // ...and bumps the generation, so a status computation already in flight (four GitHub
  // round-trips) cannot publish its pre-mutation snapshot over this invalidation. A timestamp
  // cannot express that: the stale write is genuinely newer.
  assert.match(i.sent[0].UpdateExpression, /ADD gen :one/);
  assert.equal(i.sent[0].ExpressionAttributeValues[':one'], 1);
});

test('a publish is conditional on the generation the reader observed', async () => {
  const i = intercept();
  try {
    await store.putStatusCache({ ok: true }, 1_000_000, 4);
  } finally {
    i.restore();
  }
  assert.equal(i.sent[0].ConditionExpression, 'gen = :gen');
  assert.equal(i.sent[0].ExpressionAttributeValues[':gen'], 4);
});

test('generation 0 accepts a row that has never been invalidated', async () => {
  // A never-invalidated row has NO `gen` attribute, so a bare `gen = 0` condition would fail and
  // the very first publish would be dropped — leaving the shared bound permanently unarmed.
  const i = intercept();
  try {
    await store.putStatusCache({ ok: true }, 1_000_000, 0);
  } finally {
    i.restore();
  }
  assert.equal(i.sent[0].ConditionExpression, 'attribute_not_exists(gen) OR gen = :gen');
});

test('a publish with no observed generation is unconditional (back-compat)', async () => {
  const i = intercept();
  try {
    await store.putStatusCache({ ok: true }, 1_000_000);
  } finally {
    i.restore();
  }
  assert.equal(i.sent[0].ConditionExpression, undefined);
  assert.equal(i.sent[0].ExpressionAttributeValues[':gen'], undefined);
});

test('a generation-mismatch publish is swallowed, not thrown', async () => {
  // The write losing its race is the mechanism working; it must not surface as a broker fault.
  const original = DynamoDBDocumentClient.prototype.send;
  DynamoDBDocumentClient.prototype.send = async () => {
    throw Object.assign(new Error('conditional failed'), {
      name: 'ConditionalCheckFailedException',
    });
  };
  try {
    await store.putStatusCache({ ok: true }, 1_000_000, 2);
  } finally {
    DynamoDBDocumentClient.prototype.send = original;
  }
});

test('the generation read projects only `gen` and treats an absent row as 0', async () => {
  const original = DynamoDBDocumentClient.prototype.send;
  const seen = [];
  DynamoDBDocumentClient.prototype.send = async (cmd) => {
    seen.push(cmd.input);
    return {};
  };
  try {
    assert.equal(await store.getStatusGeneration(), 0);
  } finally {
    DynamoDBDocumentClient.prototype.send = original;
  }
  assert.equal(seen[0].ProjectionExpression, 'gen');
  assert.equal(seen[0].Key.pk, 'CONFIG#STATUS');

  DynamoDBDocumentClient.prototype.send = async () => ({ Item: { gen: 9 } });
  try {
    assert.equal(await store.getStatusGeneration(), 9);
  } finally {
    DynamoDBDocumentClient.prototype.send = original;
  }
});
