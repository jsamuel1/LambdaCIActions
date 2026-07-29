// Contract tests: the microVM run-hook's self-terminate readback (ADR-019) must derive
// the SAME run-row key the control plane writes. Pins run-hook.mjs's runRowKeyFromRef
// against the run store's jitConfigRef/runPk so the two sides can't drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRowKeyFromRef, redact, isBrokerRefusal, safeErr, parseBrokerResponse, prewarmAwsCli } from '../microvm/bootstrap/run-hook.mjs';
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
  assert.match(spawn, /timeout: callTimeoutMs/);
  assert.match(spawn, /killSignal: 'SIGKILL'/);
  // A timeout/spawn failure sets `error` with a null status, so the failure log must report it
  // (otherwise the diagnostic line is empty for exactly this class).
  const at = src.indexOf("log('broker invoke failed'");
  const failLog = src.slice(at, at + 400);
  assert.match(failLog, /error: r\.error \? safeErr\(r\.error\) : undefined/);
});

// The BOOT fetch runs synchronously inside the `/run` request, and the platform abandons that
// hook after `runTimeoutInSeconds` (declared by the image build). A retry budget bigger than
// that deadline can never help: the platform has already given up while the hook is still
// sleeping between attempts, so the VM strands for the Reaper with the job unstarted. Keep the
// whole boot budget (invokes + backoff) under the declared hook timeout.
test('the boot fetch budget fits inside the platform /run hook timeout', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  const build = fs.readFileSync(new URL('../scripts/build-images.mjs', import.meta.url), 'utf8');
  const hookTimeoutS = Number(build.match(/runTimeoutInSeconds: (\d+)/)[1]);
  assert.ok(hookTimeoutS > 0, 'no runTimeoutInSeconds declared for the run hook');
  // Service constraint on microvmHooks.runTimeoutInSeconds (lambda-microvms 2025-09-09).
  assert.ok(hookTimeoutS <= 600, `runTimeoutInSeconds ${hookTimeoutS}s exceeds the 600s API max`);

  const bootMs = Number(src.match(/const BOOT_CALL_TIMEOUT_MS = (\d+);/)[1]);
  const bootAttempts = Number(src.match(/const BOOT_CALL_ATTEMPTS = (\d+);/)[1]);
  // Read the backoff from the JITCONFIG CALL SITE, not from callBroker's parameter default.
  // The boot path passes its own delay literal, so the default is not what boot actually uses:
  // sizing this invariant off the default would let a call-site change (2000 → 30000) blow the
  // hook deadline with every budget test still green.
  const delayMs = Number(
    src.match(/callBroker\('jitconfig', BOOT_CALL_ATTEMPTS, (\d+), BOOT_CALL_TIMEOUT_MS\)/)[1],
  );
  // Attempt i>0 sleeps delayMs * 2**(i-1) before its invoke (exponential backoff).
  let worstMs = bootAttempts * bootMs;
  for (let i = 1; i < bootAttempts; i++) worstMs += delayMs * 2 ** (i - 1);
  assert.ok(
    worstMs < hookTimeoutS * 1000,
    `boot budget ${worstMs}ms exceeds the ${hookTimeoutS}s /run hook timeout`,
  );
  // And the boot path must actually use that tighter bound, not the default.
  assert.match(src, /callBroker\('jitconfig', BOOT_CALL_ATTEMPTS, \d+, BOOT_CALL_TIMEOUT_MS\)/);
});

// The reason the above invariant is not sufficient on its own: the ORIGINAL budget satisfied it
// (24 s < 30 s) and still shipped a boot path with no retry margin. The 2026-07-28 dev deploy
// verification measured a COLD `aws` CLI in a snapshot-resumed guest exceeding the 6 s
// per-invoke bound on attempts 1 AND 2 of every boot, so the job only started because the LAST
// attempt landed — one more slow attempt would have blown the platform deadline, leaving `/run`
// un-ACKed, traffic gated and the VM stranded until the Reaper. So pin the margin itself: after
// the whole retry budget is spent, at least one further full-length invoke must still fit
// inside the hook deadline.
test('the boot budget leaves room for one more full-length attempt (no zero-margin boot)', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  const build = fs.readFileSync(new URL('../scripts/build-images.mjs', import.meta.url), 'utf8');
  const hookTimeoutMs = Number(build.match(/runTimeoutInSeconds: (\d+)/)[1]) * 1000;
  const bootMs = Number(src.match(/const BOOT_CALL_TIMEOUT_MS = (\d+);/)[1]);
  const bootAttempts = Number(src.match(/const BOOT_CALL_ATTEMPTS = (\d+);/)[1]);
  // Same reason as above: the boot path's backoff is the call-site literal, not the default.
  const delayMs = Number(
    src.match(/callBroker\('jitconfig', BOOT_CALL_ATTEMPTS, (\d+), BOOT_CALL_TIMEOUT_MS\)/)[1],
  );

  let worstMs = bootAttempts * bootMs;
  for (let i = 1; i < bootAttempts; i++) worstMs += delayMs * 2 ** (i - 1);
  const nextBackoffMs = delayMs * 2 ** (bootAttempts - 1);
  assert.ok(
    worstMs + nextBackoffMs + bootMs <= hookTimeoutMs,
    `boot budget ${worstMs}ms leaves no room for another ${bootMs}ms attempt inside ${hookTimeoutMs}ms`,
  );
  // The per-invoke bound must also exceed the MEASURED cold-CLI cost with headroom. Observed
  // in-guest: >6 s, consistently. 15 s is the floor that makes a cold call a non-event.
  assert.ok(bootMs >= 15000, `per-invoke boot bound ${bootMs}ms is under the measured cold-CLI cost`);
});

// Every attempt's duration is logged — including the SUCCESSFUL one, which is the number that
// actually validates the budget (a healthy boot must clear attempt 1 well inside the bound, and
// a regressed pre-warm shows up as a slow success, not a failure). The 6 s budget was defensible
// only because nobody had measured the real cold-call cost; the fix is worthless if the next
// person has to guess again.
test('broker invoke attempts log their measured duration', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  assert.match(src, /const startedAt = Date\.now\(\);/);
  assert.match(src, /const ms = Date\.now\(\) - startedAt;/);
  for (const line of ['broker invoke failed', 'broker invoke ok']) {
    const at = src.indexOf(`log('${line}'`);
    assert.ok(at > 0, `no ${line} log line`);
    assert.match(src.slice(at, at + 200), /\bms,?/, `${line} must carry the attempt duration`);
  }
  // The success line must not echo the response body — it holds the run's registration token.
  const okAt = src.indexOf("log('broker invoke ok'");
  const okLine = src.slice(okAt, src.indexOf('\n', okAt));
  assert.doesNotMatch(okLine, /body/, 'the success log must not include the broker response');
});

// The cold cost is paid at BUILD time, not boot time: the `ready` image hook is the last thing
// to run before the snapshot is captured, so a CLI warmed there is warm in every booted VM.
// The pre-warm must be credential-free and egress-free (the build guest has neither the run's
// execution role nor a reason to reach AWS), and must never fail the ready hook — a non-200
// there fails the whole image build with "Ready hook check failed".
test('the ready hook pre-warms the AWS CLI without credentials or egress', () => {
  const src = fs.readFileSync(
    new URL('../microvm/bootstrap/run-hook.mjs', import.meta.url),
    'utf8',
  );
  const ready = src.slice(src.indexOf("if (path === '/ready')"), src.indexOf("if (req.method === 'POST' && path === '/run')"));
  assert.match(ready, /prewarmAwsCli\(\)/, 'the ready hook must pre-warm the CLI');
  assert.match(ready, /\{"ready":true\}/);
  // Best-effort: a throwing warmup must not turn into a non-200 (that fails the image build).
  assert.match(ready, /try \{[\s\S]*prewarmAwsCli\(\)[\s\S]*\} catch/);

  const fn = src.slice(src.indexOf('export function prewarmAwsCli'), src.indexOf('// Fetch the stashed JIT config'));
  assert.match(fn, /--no-sign-request/, 'must not need credentials');
  assert.match(fn, /--endpoint-url/, 'must target a local endpoint, not a real AWS one');
  assert.match(fn, /AWS_EC2_METADATA_DISABLED/, 'must not hang on an IMDS probe');
  assert.match(fn, /timeout: PREWARM_TIMEOUT_MS/, 'a hung warmup must not eat the ready budget');
  // ...and that bound must actually FIT the ready-hook deadline it is protecting. The warmup
  // runs inside the `ready` image hook, so a PREWARM_TIMEOUT_MS above `readyTimeoutInSeconds`
  // would let a hung CLI fail the whole image build — which is the failure the `timeout` option
  // exists to prevent, so pin the relationship and not just the option's presence.
  const build = fs.readFileSync(new URL('../scripts/build-images.mjs', import.meta.url), 'utf8');
  const readyTimeoutMs = Number(build.match(/readyTimeoutInSeconds: (\d+)/)[1]) * 1000;
  const prewarmMs = Number(src.match(/const PREWARM_TIMEOUT_MS = (\d+);/)[1]);
  assert.ok(
    prewarmMs < readyTimeoutMs,
    `prewarm bound ${prewarmMs}ms does not fit the ${readyTimeoutMs}ms ready hook deadline`,
  );
  const endpoint = src.match(/const PREWARM_ENDPOINT = '([^']+)'/)[1];
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:/, `prewarm endpoint ${endpoint} is not loopback`);
  // A region must be passed EXPLICITLY. Without one the CLI aborts with `NoRegion` during
  // parameter validation — before endpoint resolution and HTTP-stack construction, which is
  // the expensive half of the cold path the warmup exists to pay. Measured on aws-cli 2.36.8:
  // 0.60 s and zero endpoint/urllib3 work with no region, vs 1.05 s reaching the connect
  // attempt with one. The guest images set no AWS_REGION, so inheriting it is not enough.
  assert.match(fn, /'--region', PREWARM_REGION/, 'the warmup must pass a region or it exits early');
  assert.match(
    src,
    /const PREWARM_REGION = process\.env\.AWS_REGION \|\| process\.env\.AWS_DEFAULT_REGION \|\| '[a-z0-9-]+'/,
    'PREWARM_REGION must fall back to a literal — the build guest sets no AWS_REGION',
  );
});

// The warmup runs on a real spawn in the guest; here, inject a fake so the invariants are
// checked without a CLI: it spawns `aws`, reports the measured duration, and is idempotent
// (the ready hook can be probed more than once during a build).
test('prewarmAwsCli spawns the CLI once and reports its duration', () => {
  const calls = [];
  const fake = (cmd, args) => {
    calls.push({ cmd, args });
    // The EXPECTED outcome: non-zero, having reached the connect attempt against loopback.
    return { status: 255, error: undefined, stderr: 'Could not connect to the endpoint URL: "http://127.0.0.1:1/"' };
  };
  const first = prewarmAwsCli(fake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'aws');
  assert.deepEqual(calls[0].args.slice(0, 2), ['lambda', 'invoke']);
  assert.equal(first.ran, true, 'a non-zero exit still warms the CLI');
  assert.equal(first.warmed, true, 'reaching the connect attempt means the cold path executed');
  assert.equal(typeof first.ms, 'number');
  // Idempotent: a second ready probe must not re-pay the cost.
  const second = prewarmAwsCli(fake);
  assert.equal(calls.length, 1);
  assert.equal(second.skipped, true);
});

// The failure mode that made the first cut of this warmup a no-op: the CLI exits non-zero
// having done only argument validation, so a `ran`-only signal reports success while endpoint
// resolution and the HTTP stack stayed cold. `warmed` must distinguish the two, or a silent
// regression here puts the boot path back on the full cold cost with nothing in the build log
// to show it. Checked through the module's own entry point rather than a re-implementation.
test('prewarmAwsCli reports warmed=false when the CLI exits before the connect attempt', async () => {
  const mod = await import(`../microvm/bootstrap/run-hook.mjs?early-exit-${Date.now()}`);
  const early = mod.prewarmAwsCli(() => ({
    status: 253,
    error: undefined,
    stderr: 'aws: [ERROR]: An error occurred (NoRegion): You must specify a region.',
  }));
  assert.equal(early.ran, true, 'the process did start');
  assert.equal(early.warmed, false, 'an early exit warms only the cheap half — not a success');
});

// The inverse false signal: botocore raises `ConnectTimeoutError` rather than
// `EndpointConnectionError` when the SYN is DROPPED instead of refused (a guest with a
// loopback firewall rule, say). That error is raised just as late — after endpoint resolution
// and HTTP-stack construction — so the cold path WAS paid and it must read as warmed. Matching
// only the refused-connection wording would report a failed warmup on a fully warm CLI and send
// the next reader chasing a regression that isn't there.
test('prewarmAwsCli counts a dropped-SYN connect timeout as warmed', async () => {
  const mod = await import(`../microvm/bootstrap/run-hook.mjs?connect-timeout-${Date.now()}`);
  const warm = mod.prewarmAwsCli(() => ({
    status: 255,
    error: undefined,
    stderr: 'Connect timeout on endpoint URL: "http://127.0.0.1:1/"',
  }));
  assert.equal(warm.warmed, true, 'a connect TIMEOUT is still past the expensive cold path');
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
  // stamp race and a throttle burst, so it asks for more attempts than the boot fetch.
  const bootAttempts = Number(src.match(/const BOOT_CALL_ATTEMPTS = (\d+);/)[1]);
  const terminateAttempts = Number(src.match(/callBroker\('terminate', (\d+)\)/)[1]);
  assert.ok(
    terminateAttempts > bootAttempts,
    `terminate budget ${terminateAttempts} <= boot ${bootAttempts}`,
  );
});
