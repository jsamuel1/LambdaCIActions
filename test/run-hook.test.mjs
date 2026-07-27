// Contract tests: the microVM run-hook's self-terminate readback (ADR-019) must derive
// the SAME run-row key the control plane writes. Pins run-hook.mjs's runRowKeyFromRef
// against the run store's jitConfigRef/runPk so the two sides can't drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRowKeyFromRef, redact, isBrokerRefusal, safeErr } from '../microvm/bootstrap/run-hook.mjs';
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

// `aws lambda invoke` echoes the offending --payload back on validation errors, so the
// broker-invoke failure log is a second token egress path (into the run's CloudWatch
// stream) — it goes through redact too.
test('redact scrubs the token out of AWS CLI error echoes', () => {
  const cliStderr =
    'Parameter validation failed:\nInvalid value for parameter Payload: ' +
    '{"action":"terminate","ref":"RUN#1#2#3#JITCONFIG","token":"SUPERSECRET"}';
  const out = redact(cliStderr);
  assert.doesNotMatch(out, /SUPERSECRET/);
  assert.match(out, /RUN#1#2#3#JITCONFIG/);
});

// `aws lambda invoke` exits 0 for a Lambda FUNCTION error too (broker timeout, DDB throttle,
// cold-start crash) and writes `{errorMessage, errorType}` instead of the broker's own
// `{ok:false,error}`. Treating that as a refusal would abandon the boot fetch / drop
// self-terminate to Reaper-only on a transient control-plane blip, so only a real refusal
// stops the retry loop.
test('only the broker own refusal is terminal; function errors stay retryable', () => {
  assert.equal(isBrokerRefusal({ ok: false, error: 'unauthorized' }), true);
  assert.equal(isBrokerRefusal({ ok: false, error: 'bad request' }), true);

  for (const transient of [
    { errorMessage: 'Task timed out after 30.00 seconds', errorType: 'Sandbox.Timedout' },
    { errorMessage: 'ProvisionedThroughputExceededException', errorType: 'Error' },
    {},
    null,
    undefined,
    { ok: false }, // non-ok with no structured error is not a decodable refusal
    { ok: false, error: { code: 'x' } }, // nor a non-string one
  ]) {
    assert.equal(
      isBrokerRefusal(transient),
      false,
      `must stay retryable: ${JSON.stringify(transient)}`,
    );
  }
});

test('safeErr renders a function error bounded and token-free', () => {
  assert.equal(safeErr({ errorType: 'Sandbox.Timedout' }), 'Sandbox.Timedout');
  assert.equal(safeErr({ errorMessage: 'boom' }), 'boom');
  assert.equal(safeErr({}), 'unexpected broker response');
  assert.equal(safeErr(null), 'unexpected broker response');
  assert.ok(safeErr({ errorMessage: 'z'.repeat(9000) }).length <= 200);
  assert.doesNotMatch(
    safeErr({ errorMessage: 'crash echoing {"token":"SUPERSECRET"}' }),
    /SUPERSECRET/,
  );
});
