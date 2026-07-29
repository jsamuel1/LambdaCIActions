// Ingest's webhook-secret rotation window (ADR-033 review follow-up).
//
// `getParam` caches for 5 minutes, so after a relink rotates `github/webhook-secret` a WARM
// Ingest container keeps verifying against the PREVIOUS secret while GitHub already signs with
// the new one. GitHub does NOT retry a delivery that failed verification, so every
// `workflow_job` in that window is silently lost — and the Settings screen would read `degraded`
// for a rotation that actually succeeded. Ingest therefore re-reads the secret uncached once
// before rejecting a signed-but-unverified delivery.
//
// The re-read is itself an amplification risk (`/webhook` is public and the signature check is
// what rejects an anonymous caller), so it is throttled per container and only reachable for a
// well-formed `sha256=` signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Read by the module at import time; set before importing the handler.
process.env.WEBHOOK_SECRET_PARAM = '/lca/test/github/webhook-secret';
process.env.RUNNER_LABELS_PARAM = '/lca/test/config/runner-labels';
process.env.QUEUE_URL = 'https://sqs.test/queue';
process.env.TABLE_NAME = 'lca-test-table';

const { verifyWithRotation, _resetSecretRecheck, RUNNER_LABELS_TTL_MS } = await import(
  '../dist/src/ingest/handler.js'
);

const OLD_SECRET = 'old-webhook-secret-value';
const NEW_SECRET = 'new-webhook-secret-value';
const BODY = JSON.stringify({ zen: 'keep it simple' });

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Counting uncached-read seam (what `getParam(name, 0)` is in production). */
function reader(value, { fail = false } = {}) {
  const state = { calls: 0 };
  return {
    state,
    read: async () => {
      state.calls += 1;
      if (fail) throw new Error('SSM throttled');
      return value;
    },
  };
}

test('a delivery signed with a freshly-rotated secret is accepted, not dropped', async () => {
  _resetSecretRecheck();
  const r = reader(NEW_SECRET);
  const ok = await verifyWithRotation(BODY, sign(BODY, NEW_SECRET), OLD_SECRET, r.read);
  assert.equal(ok, true, 'a rotation must not silently lose deliveries GitHub will never retry');
  assert.equal(r.state.calls, 1, 'exactly one uncached re-read');
});

test('the common case (no rotation) costs no extra read at all', async () => {
  _resetSecretRecheck();
  const r = reader(OLD_SECRET);
  const ok = await verifyWithRotation(BODY, sign(BODY, OLD_SECRET), OLD_SECRET, r.read);
  assert.equal(ok, true);
  assert.equal(r.state.calls, 0, 'the cached secret verifying must short-circuit');
});

test('a genuinely bad signature is still rejected', async () => {
  _resetSecretRecheck();
  const r = reader(NEW_SECRET);
  const ok = await verifyWithRotation(BODY, sign(BODY, 'attacker-secret'), OLD_SECRET, r.read);
  assert.equal(ok, false);
});

test('the re-read is throttled — a junk flood cannot drive an SSM call per request', async () => {
  _resetSecretRecheck();
  const r = reader(NEW_SECRET);
  const bad = sign(BODY, 'attacker-secret');
  for (let i = 0; i < 5; i += 1) {
    // Same clock instant: every call after the first is inside the throttle window.
    await verifyWithRotation(BODY, bad, OLD_SECRET, r.read, 1_000_000);
  }
  assert.equal(r.state.calls, 1, 'the uncached re-read must be rate-bounded per container');
});

test('the throttle reopens after its window', async () => {
  _resetSecretRecheck();
  const r = reader(NEW_SECRET);
  const good = sign(BODY, NEW_SECRET);
  assert.equal(await verifyWithRotation(BODY, good, OLD_SECRET, r.read, 1_000_000), true);
  // Inside the window a second rotation would have to wait — that is the accepted trade.
  assert.equal(await verifyWithRotation(BODY, good, OLD_SECRET, r.read, 1_010_000), false);
  assert.equal(await verifyWithRotation(BODY, good, OLD_SECRET, r.read, 1_040_000), true);
  assert.equal(r.state.calls, 2);
});

test('an absent or malformed signature never reaches the re-read', async () => {
  for (const signature of [undefined, '', 'sha1=deadbeef', 'garbage']) {
    _resetSecretRecheck();
    const r = reader(NEW_SECRET);
    assert.equal(await verifyWithRotation(BODY, signature, OLD_SECRET, r.read), false);
    assert.equal(r.state.calls, 0, `re-read spent on signature "${signature}"`);
  }
});

test('a failed re-read degrades to rejection rather than throwing', async () => {
  _resetSecretRecheck();
  const r = reader(NEW_SECRET, { fail: true });
  // An SSM fault must surface as a 401 to GitHub (which retries nothing either way), never a
  // 5xx from an unhandled rejection inside the handler.
  const ok = await verifyWithRotation(BODY, sign(BODY, NEW_SECRET), OLD_SECRET, r.read);
  assert.equal(ok, false);
  assert.equal(r.state.calls, 1);
});

test('an unchanged stored value short-circuits instead of re-verifying', async () => {
  _resetSecretRecheck();
  const r = reader(OLD_SECRET);
  const ok = await verifyWithRotation(BODY, sign(BODY, 'attacker-secret'), OLD_SECRET, r.read);
  assert.equal(ok, false);
  assert.equal(r.state.calls, 1);
});

// ---- claimed-label config staleness (same class of defect, no recovery signal) ------------
//
// A label change from the Settings screen is presented as taking effect on the very NEXT
// `workflow_job` delivery — that is exactly what the mandatory impact preview describes. With
// `getParam`'s 5-minute default TTL a warm container would keep claiming against the PREVIOUS
// label set, so jobs the operator just stopped claiming would still be provisioned here and jobs
// they just adopted would still go to GitHub-hosted. Unlike the webhook secret there is no
// failure signal to trigger a re-read from (an unclaimed job simply runs elsewhere), so the TTL
// itself is the bound.
test('the claimed-label read is bounded well below the default SSM cache TTL', () => {
  assert.ok(
    RUNNER_LABELS_TTL_MS > 0 && RUNNER_LABELS_TTL_MS <= 60_000,
    `label config staleness must stay inside a minute, got ${RUNNER_LABELS_TTL_MS}ms`,
  );
  assert.ok(
    RUNNER_LABELS_TTL_MS < 5 * 60 * 1000,
    'the getParam default (5 min) is far longer than the "next delivery" the UI promises',
  );
});
