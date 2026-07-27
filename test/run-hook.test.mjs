// Contract tests: the microVM run-hook's self-terminate readback (ADR-019) must derive
// the SAME run-row key the control plane writes. Pins run-hook.mjs's runRowKeyFromRef
// against the run store's jitConfigRef/runPk so the two sides can't drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRowKeyFromRef, redact, isBrokerRefusal, safeErr, parseBrokerResponse } from '../microvm/bootstrap/run-hook.mjs';
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

// The capability token must never appear in a process argument: `/proc/<pid>/cmdline` is
// world-readable inside the guest, and the terminate invoke happens AFTER workflow code has
// run (a leftover background process could poll for it). The CLI payload therefore travels
// as `fileb://` out of the owner-only mkdtemp dir, not as `--payload <json>`.
test('the broker payload never rides on argv', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  assert.match(src, /'--payload', `fileb:\/\/\$\{outDir\}\/payload\.json`/);
  assert.doesNotMatch(src, /'--payload',\s*payload\b/);
  // Written owner-only, into the same dir that is rm -rf'd in the same call.
  assert.match(src, /writeFileSync\(`\$\{outDir\}\/payload\.json`, payload, \{ mode: 0o600 \}\)/);
});

// selfTerminate is called from the runner agent's `exit`/`error` handlers, outside any
// request scope, so anything it throws is an UNCAUGHT exception that kills the hook process
// (losing the /terminate final log flush on top of the missed terminate). Every failure path
// must degrade to "Reaper backstops" instead.
test('selfTerminate survives a broker call that throws', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  const body = src.slice(src.indexOf('function selfTerminate('), src.indexOf('function callBroker('));
  assert.match(body, /try \{\s*(?:\/\/[^\n]*\n\s*)*res = callBroker\('terminate'(?:, \d+)?\);/);
  assert.match(body, /brokered terminate threw; Reaper will backstop/);
  // The scratch-dir setup inside callBroker is likewise guarded (a workflow can fill the
  // disk or clobber TMPDIR before the terminate call runs).
  assert.match(src, /broker scratch dir unavailable/);
});

// The `jitconfig` response body carries the run's SINGLE-USE GitHub registration credential.
// Node's JSON.parse error messages quote a slice of their input, so logging a raw parse
// failure would print credential bytes into the run's CloudWatch stream (which outlives the
// VM). The parse must fail with a content-free reason.
test('a malformed broker response never leaks its body into the log', () => {
  const credentialish = '{"jitConfig":"eyJ0b2tlbiI6IkFCQ0RTRUNSRVQifQ==","runId":1';
  assert.throws(
    () => parseBrokerResponse(credentialish),
    (err) => {
      assert.doesNotMatch(err.message, /ABCDSECRET/);
      assert.doesNotMatch(err.message, /jitConfig/);
      assert.match(err.message, /not valid JSON \(\d+ bytes\)/);
      // And the rendering that actually reaches the log line is bounded + token-redacted.
      assert.doesNotMatch(safeErr(err), /ABCDSECRET/);
      return true;
    },
  );
  assert.deepEqual(parseBrokerResponse('{"ok":true}'), { ok: true });
});

// `aws lambda invoke` is spawned SYNCHRONOUSLY from the hook. With no timeout, a CLI that
// hangs (broken guest DNS/network after a workflow has messed with it, stalled endpoint)
// blocks forever: the retry loop can never fire, `/run` never ACKs — and Lambda gates traffic
// to the VM until it does, so the VM is stranded until the Reaper — and at job end the hook
// process hangs past the job, losing the /terminate log flush and paying idle minutes.
test('every broker invoke is wall-clock bounded and hard-killed', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  const timeout = src.match(/const BROKER_CALL_TIMEOUT_MS = (\d+);/);
  assert.ok(timeout, 'no per-invoke timeout constant');
  const ms = Number(timeout[1]);
  assert.ok(ms > 0 && ms <= 30000, `implausible invoke timeout: ${ms}ms`);
  // The bound has to be ON the spawnSync that runs the CLI, with SIGKILL so a CLI ignoring
  // SIGTERM can't outlive it.
  const spawn = src.slice(src.indexOf("spawnSync('aws', args"), src.indexOf('if (r.status !== 0)'));
  assert.match(spawn, /timeout: BROKER_CALL_TIMEOUT_MS/);
  assert.match(spawn, /killSignal: 'SIGKILL'/);
  // A timeout/spawn failure sets `error` with a null status, so the failure log must report it
  // (otherwise the diagnostic line is empty for exactly this class).
  const at = src.indexOf("log('broker invoke failed'");
  const failLog = src.slice(at, at + 400);
  assert.match(failLog, /error: r\.error \? safeErr\(r\.error\) : undefined/);
});

// The broker's reserved-concurrency cap (20) exists to stop an untrusted VM fleet draining
// the account pool — but it also means a launch burst can legitimately get
// TooManyRequestsException. Flat retries would all land inside the same throttle window and
// fail the job at boot, so the backoff must grow.
test('broker retries back off exponentially, with a bigger budget for terminate', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  assert.match(src, /sleepSync\(delayMs \* 2 \*\* \(i - 1\)\)/);
  // Terminate has no `/run` ACK deadline behind it and must survive both the post-launch
  // stamp race and a throttle burst, so it asks for more attempts than the default.
  const attempts = Number(src.match(/function callBroker\(action, attempts = (\d+)/)[1]);
  const terminateAttempts = Number(src.match(/callBroker\('terminate', (\d+)\)/)[1]);
  assert.ok(terminateAttempts > attempts, `terminate budget ${terminateAttempts} <= default ${attempts}`);
});
