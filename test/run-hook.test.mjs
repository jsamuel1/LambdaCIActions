// Contract tests: the microVM run-hook's self-terminate readback (ADR-019) must derive
// the SAME run-row key the control plane writes. Pins run-hook.mjs's runRowKeyFromRef
// against the run store's jitConfigRef/runPk so the two sides can't drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRowKeyFromRef, redact } from '../microvm/bootstrap/run-hook.mjs';
import { runPk, RUN_SK, jitConfigRef } from '../dist/src/shared/run-store.js';

test('runRowKeyFromRef inverts jitConfigRef back to the run row key', () => {
  const ref = jitConfigRef(99, 7, 42); // what Provision embeds in the run-hook payload
  const key = runRowKeyFromRef(ref);
  assert.deepEqual(key, { pk: runPk(99, 7, 42), sk: RUN_SK });
});

test('runRowKeyFromRef matches the documented ref shape literally', () => {
  assert.deepEqual(runRowKeyFromRef('RUN#1#2#3#JITCONFIG'), { pk: 'RUN#1#2#3', sk: 'RUN' });
});

test('importing run-hook.mjs does not bind the port', () => {
  // The import above already succeeded — if the module called listen() on import, the
  // test runner would hang / EADDRINUSE on repeat runs. Assert the server exists but is
  // not listening.
  return import('../microvm/bootstrap/run-hook.mjs').then((m) => {
    assert.equal(m.server.listening, false);
  });
});

// The capability token (ADR-020) is a bearer secret. The two payload-diagnostic log lines
// in /run echo the raw body, and the platform delivers the pointer BOTH bare and wrapped
// (`{runHookPayload: "<json string>"}`), so redact must handle the escaped form too —
// otherwise the token lands in the run's CloudWatch stream, which outlives the VM.
test('redact strips the token from bare, wrapped and doubly-wrapped payloads', () => {
  const inner = JSON.stringify({
    ref: 'RUN#1#2#3#JITCONFIG',
    region: 'us-west-2',
    broker: 'lca-dev-hook-broker',
    token: 'SUPERSECRET',
  });
  for (const raw of [
    inner,
    JSON.stringify({ runHookPayload: inner }),
    JSON.stringify({ payload: inner }),
    JSON.stringify({ outer: JSON.stringify({ runHookPayload: inner }) }),
  ]) {
    const out = redact(raw);
    assert.doesNotMatch(out, /SUPERSECRET/, `token leaked from: ${raw}`);
    assert.match(out, /<redacted>/);
    // Everything else must survive — these lines exist to diagnose payload shape.
    assert.match(out, /RUN#1#2#3#JITCONFIG/);
  }
  // Whitespace-tolerant (hand-built / reformatted bodies).
  assert.equal(redact('{ "token" : "SUPERSECRET" }'), '{ "token" : "<redacted>" }');
});

test('redact leaves token-free payloads intact', () => {
  const raw = JSON.stringify({ ref: 'RUN#1#2#3#JITCONFIG', broker: 'b' });
  assert.equal(redact(raw), raw);
});
