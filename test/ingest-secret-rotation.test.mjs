// Ingest's webhook-secret rotation window (ADR-034 review follow-up).
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

const {
  verifyWithRotation,
  _resetSecretRecheck,
  RUNNER_LABELS_TTL_MS,
  WEBHOOK_SECRET_TTL_MS,
} = await import('../dist/src/ingest/handler.js');
const { cacheEntryUsable } = await import('../dist/src/shared/ssm.js');

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
// they just adopted would still go to GitHub-hosted. There is no failure signal to trigger a
// re-read from (an unclaimed job simply runs elsewhere), so the TTL itself is the bound.
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

// ---- the recovery signal is suppressible, so the TTL must be the real bound ----------------
//
// `verifyWithRotation` recovers from a rotation on the FIRST failing delivery, which is faster
// than any TTL — but its trigger is a request on a PUBLIC endpoint, and the re-read behind it is
// rate-limited per container so an anonymous flood cannot drive an SSM call per delivery. That
// rate limit is precisely what an attacker can consume: junk with a well-formed `sha256=` prefix,
// posted once per window, keeps it spent (asserted by the throttle test above). GitHub's real
// delivery then fails against the stale cached secret, finds the re-read throttled, and is
// rejected 401 — and GitHub does not retry a delivery that failed verification, so the
// `workflow_job` is lost rather than delayed, for as long as the cache holds it.
//
// So the secret read carries its own short TTL: worst-case staleness is bounded whether or not
// the recovery signal ever gets to fire.
test('the webhook-secret read is bounded by its own TTL, not only by the re-read signal', () => {
  assert.ok(
    WEBHOOK_SECRET_TTL_MS > 0 && WEBHOOK_SECRET_TTL_MS <= 60_000,
    `webhook-secret staleness must stay inside a minute, got ${WEBHOOK_SECRET_TTL_MS}ms`,
  );
  assert.ok(
    WEBHOOK_SECRET_TTL_MS < 5 * 60 * 1000,
    'the getParam default (5 min) leaves a suppressible window in which deliveries are lost',
  );
  // The re-read throttle is what an attacker spends; recovery must not be slower than it.
  assert.ok(
    WEBHOOK_SECRET_TTL_MS <= 30_000,
    'the TTL must not exceed the re-read throttle window it exists to back up',
  );
});

// ---- the uncached re-read leaves NO warm cache -----------------------------------------------
//
// A code comment previously claimed the rotation re-read "also refreshes the container's cache,
// so subsequent deliveries verify on the first attempt". The conclusion is right; the mechanism
// is not, and the difference is a real `GetParameter` on the PUBLIC `/webhook` path — which is
// the same read cost that forces the re-read to be throttled in the first place.
//
// `getParam(name, 0)` stores `expires: now + 0`, so the entry it writes is already expired. The
// next delivery therefore does a FRESH read (and that is what makes it observe the rotated
// secret); it is not served a warmed entry. Asserted against `getParam`'s own predicate rather
// than a re-implementation of it, so the two cannot drift apart.
test('a forced (ttlMs=0) read leaves an already-expired entry, not a warm cache', () => {
  const now = 1_000;
  // What `getParam(name, 0)` writes.
  const forced = { value: 'rotated-secret', expires: now + 0 };

  assert.equal(
    cacheEntryUsable(forced, WEBHOOK_SECRET_TTL_MS, now),
    false,
    'the entry a forced read writes must not serve a later cached read at the same instant',
  );
  assert.equal(
    cacheEntryUsable(forced, WEBHOOK_SECRET_TTL_MS, now + 1),
    false,
    'nor one instant later — the next delivery pays a fresh GetParameter',
  );
  // Control: an entry written by a NORMAL ttl read does serve within its window, so the
  // assertions above are about the forced read and not a broken predicate.
  const normal = { value: 'rotated-secret', expires: now + WEBHOOK_SECRET_TTL_MS };
  assert.equal(
    cacheEntryUsable(normal, WEBHOOK_SECRET_TTL_MS, now + 1),
    true,
    'a normal cached read is still served inside its TTL',
  );
  // And a forced read never consumes the cache on the way IN, whatever is stored.
  assert.equal(
    cacheEntryUsable(normal, 0, now + 1),
    false,
    'ttlMs=0 must bypass a live cache entry — that is what makes the re-read uncached',
  );
});
