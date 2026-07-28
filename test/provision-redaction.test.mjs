// The control plane holds the plaintext run-hook capability token (ADR-020) — it builds the
// launch payload — so its own error paths are a token egress route, symmetrical to the
// guest-side redaction in run-hook.mjs. An SDK validation/serialization failure echoes the
// offending request value ("Value '…' at 'runHookPayload' failed to satisfy constraint"), and
// Provision writes launch failures into the run row's `reason`: durable for 90 days (terminal
// TTL) and surfaced by the management API/UI, which must never carry secret values (AGENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecret } from '../dist/src/shared/redact.js';

const TOKEN = 'Zm9vYmFyYmF6cXV1eA'.repeat(2) + 'AA'; // 38 chars, > the 16-char floor

test('an SDK error echoing the payload loses the token', () => {
  const raw =
    `1 validation error detected: Value '{"ref":"RUN#1#2#3#JITCONFIG","region":"us-west-2",` +
    `"broker":"lca-dev-hook-broker","token":"${TOKEN}"}' at 'runHookPayload' failed to ` +
    `satisfy constraint`;
  const out = redactSecret(raw, TOKEN);
  assert.doesNotMatch(out, new RegExp(TOKEN));
  assert.match(out, /<redacted>/);
  // The diagnostic value of the message survives.
  assert.match(out, /RUN#1#2#3#JITCONFIG/);
  assert.match(out, /runHookPayload/);
});

test('a bare token echo is scrubbed even outside a JSON envelope', () => {
  assert.equal(redactSecret(`token ${TOKEN} rejected`, TOKEN), 'token <redacted> rejected');
});

test('the JSON field shape is scrubbed without knowing the plaintext', () => {
  assert.equal(redactSecret('{"token":"whatever"}'), '{"token":"<redacted>"}');
});

test('a short or absent secret cannot mask innocuous text', () => {
  // Never let a degenerate value turn the whole message into <redacted> noise.
  assert.equal(redactSecret('boot failed for run 12', 'a'), 'boot failed for run 12');
  assert.equal(redactSecret('boot failed for run 12'), 'boot failed for run 12');
});

// Ordering property: the redaction has to happen before BOTH sinks — the persisted `reason`
// and the rethrow the batch handler logs. Rethrowing the original error would still publish
// the token in the Provision log group.
test('Provision redacts the launch error before persisting or rethrowing it', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'provision', 'handler.ts'),
    'utf8',
  );
  const redacted = src.indexOf('const safeReason = redactSecret(errMsg(err), hookToken);');
  assert.ok(redacted > 0, 'launch failure is not redacted');
  const reason = src.indexOf('reason: `launch failed: ${safeReason}`');
  assert.ok(reason > redacted, 'the persisted reason must use the redacted text');
  assert.doesNotMatch(src, /throw err;/, 'the raw launch error must not be rethrown');
});
