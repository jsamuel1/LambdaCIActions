#!/usr/bin/env node
// @ts-nocheck
/**
 * run-hook.mjs — the microVM lifecycle-hook HTTP server (ADR-012).
 *
 * Baked into every flavor image and started as the container entrypoint. Lambda microVM
 * boots from the snapshot, then delivers the launch's `--run-hook-payload` to `POST /run`.
 * Traffic to the VM is gated until `/run` returns 200, so we ACK fast and run the actual
 * GitHub Actions job in the background.
 *
 * Contract (ADR-016 — run-hook payload cap is 4 KB, so the JIT config is passed by
 * REFERENCE, not inline; ADR-021 — the VM holds NO ambient AWS authority beyond invoking
 * the hook broker):
 *   POST /run        body = { ref, region, broker, token }   (small; <4 KB)
 *                    -> hook asks the broker λ for its JIT config (token-authorized to
 *                       this run only), then 200 immediately; runner agent runs ONE job
 *                       in the background
 *   POST /terminate  fires pre-teardown; best-effort final log flush
 *   GET  /healthz    liveness
 *
 * Single-use semantics (ADR-003/006): the JIT config is consumed by exactly one
 * `run.sh --jitconfig` invocation; on agent exit we ask the broker to terminate this VM
 * (the Reaper λ backstops orphans). Zero runtime deps — Node built-ins + the baked-in AWS CLI.
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const PORT = parseInt(process.env.RUN_HOOK_PORT || '8080', 10);
const RUNNER_DIR = process.env.RUNNER_DIR || '/opt/actions-runner';
const RUNNER_USER = process.env.RUNNER_USER || 'runner';
const MAX_PAYLOAD_BYTES = 4096; // GA lambda-microvms run-hook payload hard cap (ADR-016)

let jobStarted = false; // guard: this microVM runs exactly one job
// The {ref, region, broker, token} pointer delivered to /run — kept so selfTerminate can
// call the broker with the same per-run capability token (ADR-021).
let runCtx = null;

function log(msg, extra) {
  // structured line → CloudWatch (the UI reads via log_ref, spec 05)
  const rec = { ts: new Date().toISOString(), src: 'run-hook', msg, ...extra };
  process.stdout.write(JSON.stringify(rec) + '\n');
}

// The capability token is a bearer secret (ADR-021) — never log a payload verbatim.
// The platform may deliver the pointer JSON-in-JSON (`{"runHookPayload":"{\"token\":…}"}`),
// so the ESCAPED form has to be redacted too — the two diagnostic log lines below fire on
// exactly the malformed/wrapped payloads where that shape shows up, and a leaked token
// lands in the run's CloudWatch stream, which long outlives the VM.
export function redact(raw) {
  return String(raw)
    .replace(/("token"\s*:\s*")[^"]*(")/g, '$1<redacted>$2')
    .replace(/(\\+"token\\+"\s*:\s*\\+")(?:[^\\"]|\\.)*?(\\+")/g, '$1<redacted>$2');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_PAYLOAD_BYTES) {
        reject(new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Ask the control plane to terminate this microVM the instant the job is done (no idle
// billing). The VM does NOT hold `lambda:TerminateMicrovm` and never learns its own
// microvmId (ADR-021): it invokes the hook broker λ with its per-run capability token, and
// the broker resolves the id off this run's row (stamped by Provision post-launch, ADR-019)
// and terminates that VM. A VM therefore cannot target anyone else's VM.
function selfTerminate(reason) {
  log('self-terminate requested', { reason });
  // selfTerminate runs from the runner agent's `exit`/`error` handlers, i.e. OUTSIDE any
  // request scope: an exception thrown here is an uncaught exception that kills the hook
  // process. That is strictly worse than a missed terminate (the Reaper still reaps, but a
  // crashed hook also loses the final log flush), so treat every failure as "Reaper
  // backstops".
  let res = null;
  try {
    // More attempts than the boot fetch: this call has no `/run` ACK deadline behind it, and
    // it must survive both the post-launch stamp race and a broker throttle burst.
    res = callBroker('terminate', 4);
  } catch (err) {
    log('brokered terminate threw; Reaper will backstop', { error: safeErr(err) });
    return;
  }
  if (!res || res.ok !== true) {
    log('brokered terminate failed; Reaper will backstop', { error: res?.error ?? 'invoke failed' });
    return;
  }
  if (res.terminated === false) log('broker had no VM to terminate; Reaper will backstop', {});
}

// Hard wall-clock bound on one `aws lambda invoke`. The broker λ's own timeout is 30 s but it
// does at most two GetItems plus a terminate, so a call this slow is the CLI hanging (DNS /
// metadata / endpoint stall inside a guest whose network a workflow may have mangled) — not a
// slow broker. Without a bound, spawnSync waits forever: the retry loop below can never fire,
// `/run` never ACKs (Lambda gates traffic to the VM until it does, so the VM is stranded until
// the Reaper) and self-terminate hangs the hook process past the job, losing the final log
// flush and paying idle minutes.
const BROKER_CALL_TIMEOUT_MS = 15000;

// The BOOT fetch runs inside a platform deadline: the image declares `microvmHooks.run` with
// `runTimeoutInSeconds` (scripts/build-images.mjs), and this call is synchronous INSIDE the
// `/run` request — the ACK cannot be sent until it returns. A retry budget larger than the hook
// timeout is self-defeating: the platform gives up on `/run` while the hook is still retrying,
// so the extra attempts can never help and the VM is stranded for the Reaper anyway.
//
// The first cut of this budget was 6 s × 3 attempts, sized off the BROKER's latency (~50 ms of
// DynamoDB work). That was the wrong cost model: the call is dominated by the COLD `aws` CLI in
// a freshly snapshot-resumed guest. Live dev verification (2026-07-28, run 30407823249) had
// attempts 1 AND 2 fail `spawnSync aws ETIMEDOUT` on all three flavors — every boot survived on
// its LAST attempt, burning ~22 s of a 30 s hook deadline for one success, i.e. zero margin.
//
// The CLI in question is apt's aws-cli **v1** (1.22.34 / botocore 1.23.34 — see
// microvm/Dockerfile.base), NOT the deploy host's v2: the ≥2.35.17 floor in spec 05 is a
// deployer requirement for the `lambda-microvms` model, while the guest only calls plain
// `lambda invoke`. Reproduced in ubuntu:22.04: 6.36 s cold vs 2.50 s repeated — the cold figure
// sits right on the old 6 s bound, which is exactly why attempts 1 and 2 expired.
//
// The hook timeout is NOT ours to pick freely: the API caps
// `microvmHooks.runTimeoutInSeconds` at 60 s (`MicrovmHooksRunTimeoutInSecondsInteger`:
// min 1, max 60, in the lambda-microvms 2025-09-09 model — note this is a much tighter cap
// than the image hooks' `readyTimeoutInSeconds`, which allows 3600 s). So the image asks for
// the maximum 60 s and the retry budget is derived DOWN from that ceiling; we cannot buy our
// way out of a slow cold call with a bigger deadline.
//
// Two changes, because either alone is fragile:
//   * the image now declares the 60 s API maximum (was 30 s) and the budget is sized to leave
//     real margin inside it: a 15 s per-invoke bound × 2 attempts + 2 s backoff = 32 s worst
//     case, so a further full-length attempt (4 s backoff + 15 s invoke = 51 s total) still
//     fits. Attempts drop 3 → 2 deliberately: against a 60 s ceiling, per-invoke headroom for
//     a cold call is worth more than a third attempt, because the failure this fixes is one
//     SLOW call, not three flaky ones (each observed failure was the 6 s bound expiring, not
//     the broker refusing). 3 × 15 s would consume 51 s of the 60 s ceiling and leave the same
//     zero margin we are removing. test/run-hook.test.mjs pins the arithmetic, the margin AND
//     the 60 s API cap, so a future edit can't quietly return to a no-retry-margin budget or
//     declare a timeout the service will reject.
//   * `prewarmAwsCli()` pays the CLI's cold cost during the image build (see /ready below), so
//     a normal boot should resolve on attempt 1 and the raised bound is dead headroom rather
//     than added boot latency.
// Terminate keeps its own budget: it fires after the job, with no platform deadline behind it,
// so it keeps the larger attempt count the post-launch stamp race needs.
const BOOT_CALL_TIMEOUT_MS = 15000;
const BOOT_CALL_ATTEMPTS = 2;

// Cold-CLI pre-warm knobs (see prewarmAwsCli below). The warmup runs in the `ready` IMAGE hook,
// i.e. during the image build, before the snapshot is captured — so its cost is paid once at
// build time instead of on every VM's boot critical path. It needs no credentials and no
// egress: the target is a CLOSED loopback port, so the CLI does its whole import/model-load/
// endpoint-resolution work and then fails to connect, which is the expected outcome.
const PREWARM_TIMEOUT_MS = 30000;
const PREWARM_ENDPOINT = 'http://127.0.0.1:1'; // closed port — nothing leaves the guest
// A region is REQUIRED even though nothing leaves the guest: without one the CLI aborts at
// parameter validation (`NoRegion`) BEFORE it resolves an endpoint or builds its HTTP stack —
// i.e. before the expensive half of the cold path this warmup exists to pay. The build guest
// sets no AWS_REGION (see microvm/Dockerfile.*), so supply a default rather than inherit one.
// The value is inert: `--endpoint-url` points at loopback, so it never selects a real endpoint.
const PREWARM_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
// The connect failure the warmup MUST end at, having done all the import/model-load/endpoint/
// HTTP-client work. Reaching anything else (e.g. NoRegion) means it exited early and warmed
// only the cheap half — that has to read as a FAILED warmup, not a successful one.
//
// BOTH botocore connect-phase errors count, because both are raised only after the endpoint is
// resolved and the HTTP client is built: `EndpointConnectionError` ("Could not connect to the
// endpoint URL") is the refused-port case this warmup normally hits, and `ConnectTimeoutError`
// ("Connect timeout on endpoint URL") is what a guest that DROPS rather than refuses the
// loopback SYN produces. Matching only the first would report warmed=false on a warmup that
// did all the work — the exact false signal the `warmed` flag exists to prevent.
const PREWARM_REACHED_RE = /(Could not connect to the endpoint URL|Connect timeout on endpoint URL)/i;
let prewarmed = false;

// Invoke the hook broker λ via the baked-in AWS CLI (no npm deps in the image). The VM's
// execution role grants exactly one action — lambda:InvokeFunction on this function ARN.
// Retries cover the razor-thin window where Provision hasn't stamped microvmId yet AND the
// broker's reserved-concurrency throttle: the cap that stops an untrusted VM fleet draining
// the account pool also means a launch burst can get `TooManyRequestsException`, so the
// backoff is exponential (2s, 4s, 8s…) rather than flat — flat retries all land inside the
// same throttle window and fail the job at boot. Boot uses fewer attempts than terminate:
// `/run` cannot ACK until the fetch returns, and terminate has no such deadline.
function callBroker(action, attempts = 3, delayMs = 2000, callTimeoutMs = BROKER_CALL_TIMEOUT_MS) {
  if (!runCtx?.ref || !runCtx?.broker || !runCtx?.token) {
    log('broker call skipped: no broker context', { action });
    return null;
  }
  const payload = JSON.stringify({ action, ref: runCtx.ref, token: runCtx.token });
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleepSync(delayMs * 2 ** (i - 1));
    // `aws lambda invoke` can only write its response to a FILE, and the jitconfig response
    // carries the run's single-use GitHub registration credential. Keep it out of shared
    // /tmp: owner-only dir (mkdtemp is 0700), unlinked + removed in the same call, before
    // any workflow code runs. Nothing long-lived lands on disk (spec 02 / ADR-003).
    //
    // Every filesystem step here can fail for reasons outside our control (a workflow that
    // filled the disk, a read-only or missing TMPDIR): a raw throw would propagate out of
    // selfTerminate's exit handler and kill the hook, so treat it as one failed attempt.
    let outDir;
    let outFile;
    try {
      outDir = fs.mkdtempSync(`${os.tmpdir()}/lca-broker-`);
      outFile = `${outDir}/response.json`;
      // The token must NOT ride on argv: `/proc/<pid>/cmdline` is world-readable in the
      // guest, and the terminate call fires AFTER workflow code has run (it can leave a
      // background poller behind). Hand the payload to the CLI through a file in the same
      // owner-only dir.
      fs.writeFileSync(`${outDir}/payload.json`, payload, { mode: 0o600 });
    } catch (err) {
      log('broker scratch dir unavailable', { action, attempt: i + 1, error: safeErr(err) });
      if (outDir) cleanup(outDir);
      continue;
    }
    const args = [
      'lambda', 'invoke',
      '--function-name', runCtx.broker,
      '--payload', `fileb://${outDir}/payload.json`,
      outFile,
    ];
    if (runCtx.region) args.push('--region', runCtx.region);
    const startedAt = Date.now();
    const r = spawnSync('aws', args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: callTimeoutMs,
      killSignal: 'SIGKILL',
    });
    // Measure every attempt. The boot budget above is only defensible against a MEASURED
    // cold-call duration — the 6 s original was sized off an assumed one and ran a whole
    // milestone with no retry margin before a live deploy exposed it. `ms` is the number a
    // future verification reads back out of the run's log stream; it carries no payload bytes.
    const ms = Date.now() - startedAt;
    if (r.status !== 0) {
      // The CLI echoes offending parameter values on validation errors; the payload now
      // travels by file, but redact anyway — a future arg or an echoed file body must not
      // put the capability token in the run's log stream. A timeout/spawn failure surfaces
      // as `r.error` with a null status, so report that too or the line is empty.
      log('broker invoke failed', {
        action,
        attempt: i + 1,
        ms,
        status: r.status,
        error: r.error ? safeErr(r.error) : undefined,
        stderr: redact(r.stderr || '').slice(0, 512),
      });
      cleanup(outDir);
      continue;
    }
    let body;
    try {
      body = parseBrokerResponse(fs.readFileSync(outFile, 'utf8'));
    } catch (err) {
      // NEVER log the parse error verbatim: a `jitconfig` response body holds the run's
      // single-use registration credential, and Node's JSON errors quote a slice of the
      // offending input (`Unexpected token 'x', "<content>" is not valid JSON`). A
      // truncated response would therefore print credential bytes into the run's log
      // stream, which outlives the VM. parseBrokerResponse yields a content-free reason.
      log('broker response unreadable', { action, attempt: i + 1, error: safeErr(err) });
      continue;
    } finally {
      cleanup(outDir);
    }
    if (body?.ok !== true) {
      // Distinguish the broker's OWN structured refusal (`{ok:false, error}` — bad request /
      // unauthorized, which cannot fix itself) from a Lambda-level function error, which
      // `aws lambda invoke` reports with exit status 0 and an `{errorMessage, errorType}`
      // body (broker timeout, DDB throttle, cold-start crash). Retrying the former is
      // pointless; NOT retrying the latter would fail the whole job on a transient control-
      // plane blip, or silently drop self-terminate back to Reaper-only reaping.
      const brokerRefusal = isBrokerRefusal(body);
      log(brokerRefusal ? 'broker denied request' : 'broker invoke errored', {
        action,
        attempt: i + 1,
        ms,
        error: brokerRefusal ? body.error : safeErr(body),
      });
      if (brokerRefusal) return body; // an auth failure won't fix itself — don't burn retries
      continue;
    }
    // The SUCCESS path is the one that matters for sizing the budget: a healthy boot must show
    // attempt 1 completing well inside BOOT_CALL_TIMEOUT_MS, and that is also how a regressed
    // pre-warm is detected (attempt 1 succeeds, but slowly). Only the action/attempt/duration
    // are logged — never `body`, which carries the run's single-use registration credential.
    log('broker invoke ok', { action, attempt: i + 1, ms });
    // For terminate, an ok:true with terminated:false means "id not stamped yet" — retry.
    if (action === 'terminate' && body.terminated === false && i + 1 < attempts) continue;
    return body;
  }
  return null;
}

// Derive the run row key from the JIT config ref (`RUN#<repo>#<run>#<job>#JITCONFIG`).
// The VM no longer reads the run row itself (ADR-021 — the broker does, from the same ref
// bound to the capability token), but the derivation stays pinned by tests as the shared
// contract between the compute plane's ref and the control plane's run-row key.
export function runRowKeyFromRef(ref) {
  const pk = ref.split('#JITCONFIG')[0];
  return { pk, sk: 'RUN' };
}

// Remove a broker response scratch dir (and the credential-bearing file in it).
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// Render a Lambda function-error body (or a thrown Error) for the log without echoing an
// unbounded blob, and never the payload/response content — those carry the capability token
// and the single-use registration credential respectively.
export function safeErr(body) {
  const msg =
    body instanceof Error
      ? body.message
      : body?.errorType || body?.errorMessage || 'unexpected broker response';
  return redact(String(msg)).slice(0, 200);
}

/**
 * Parse a broker response file. Throws a CONTENT-FREE error on malformed JSON: the raw body
 * is credential-bearing (the `jitconfig` response carries the run's single-use GitHub
 * registration token) and Node's own JSON.parse messages quote a slice of their input, so
 * that message must never reach the run's log stream. Exported pure so the redaction
 * property is pinned by tests.
 */
export function parseBrokerResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`broker response is not valid JSON (${Buffer.byteLength(String(raw))} bytes)`);
  }
}

/**
 * True when a non-ok broker response is the broker's OWN deliberate refusal, i.e. terminal
 * for this VM. `aws lambda invoke` exits 0 for a Lambda FUNCTION error too (timeout, DDB
 * throttle, crash) and writes `{errorMessage, errorType}` — that IS retryable, so it must
 * not be mistaken for `unauthorized`. Exported pure so the classification is pinned by
 * tests without spawning the CLI.
 */
export function isBrokerRefusal(body) {
  return body?.ok === false && typeof body?.error === 'string';
}

// Blocking sleep — fine here: broker retries happen either before the job starts or after
// it finishes, with nothing else pending.
function sleepSync(ms) {
  try {
    spawnSync('sleep', [String(ms / 1000)]);
  } catch {
    /* best-effort */
  }
}

/**
 * Pay the `aws` CLI's cold-start cost ONCE, during the image build, so the snapshot carries
 * warm state and the boot-path `jitconfig` call is not the first CLI invocation in the guest.
 *
 * Why here: the CLI's first run costs Python interpreter startup + botocore service-model load
 * + endpoint resolution. In a snapshot-resumed guest that lands on the boot critical path,
 * INSIDE the platform's `/run` deadline — which is exactly how the 2026-07-28 verification
 * burned attempts 1 and 2 of the jitconfig fetch on every boot. The `ready` IMAGE hook runs
 * during `create/update-microvm-image` BEFORE the snapshot is captured, so warming there is
 * free at boot.
 *
 * The pre-warm deliberately needs no credentials and no network egress: the build guest holds
 * neither the run's execution role nor the broker's name. `--no-sign-request` skips credential
 * resolution, `--endpoint-url http://127.0.0.1:1` targets a closed loopback port, and IMDS is
 * disabled for the child — so the CLI executes its whole import/model-load/endpoint path and
 * then fails to connect. A NON-ZERO exit is the expected outcome; only the elapsed time
 * matters, and it is logged so the build record MEASURES the cold cost instead of assuming it
 * (the assumption is what produced the 6 s budget). Idempotent and best-effort: the `ready`
 * hook must answer 200 regardless, or the image build fails with "Ready hook check failed".
 *
 * Residual cold cost, stated so the next reader does not over-trust this: `--no-sign-request`
 * and the disabled IMDS mean the credential-provider chain and the SigV4 signing path are the
 * one part of the cold path this warmup CANNOT pay — the build guest has no role to resolve.
 * A real boot call signs, so attempt 1 still pays that fraction (the expensive terms — Python
 * start, service-model load, endpoint resolution, HTTP-stack construction — are all warm). That
 * is a second reason BOOT_CALL_TIMEOUT_MS stays sized for a cold-ish call rather than a warm one.
 *
 * The warmup is only worth anything if it reaches the CONNECT attempt: an early exit (most
 * plausibly `NoRegion`, since the build guest sets no AWS_REGION) returns non-zero after doing
 * only argument parsing, leaving endpoint resolution and the HTTP stack cold — exactly the
 * work the boot path would then pay for. So a region is always passed, and `warmed` reports
 * whether the expected connect failure was actually reached rather than merely that the CLI
 * ran. A false `warmed` in the build log means the boot path is back on the cold-cost path and
 * is relying on the raised BOOT_CALL_TIMEOUT_MS alone.
 */
export function prewarmAwsCli(spawn = spawnSync) {
  if (prewarmed) return { skipped: true };
  prewarmed = true;
  const startedAt = Date.now();
  const r = spawn(
    'aws',
    [
      'lambda', 'invoke',
      '--no-sign-request',
      '--region', PREWARM_REGION,
      '--endpoint-url', PREWARM_ENDPOINT,
      '--cli-connect-timeout', '1',
      '--cli-read-timeout', '1',
      '--function-name', 'lca-prewarm',
      '--payload', 'fileb:///dev/null',
      '/dev/null',
    ],
    {
      encoding: 'utf8',
      timeout: PREWARM_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      // No IMDS round-trips: there is no instance identity to find, and a hanging metadata
      // probe would be the one way this best-effort warmup could eat the ready-hook budget.
      env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' },
    },
  );
  const ms = Date.now() - startedAt;
  // `ran` = the CLI process started at all (a missing binary or a timeout surfaces as r.error).
  // `warmed` = it got as far as the connect attempt, which is the only outcome that proves the
  // expensive cold path executed. `stderr` is a fixed CLI diagnostic against a loopback
  // endpoint with no credentials — it carries no run data (there is no run yet at build time).
  const ran = !r.error;
  const stderr = String(r.stderr || '').trim().slice(0, 200);
  const warmed = ran && PREWARM_REACHED_RE.test(stderr);
  log('aws cli prewarm', { ms, ran, warmed, status: r.status ?? null, stderr: warmed ? undefined : stderr });
  return { ms, ran, warmed, skipped: false };
}

// Fetch the stashed JIT config through the hook broker (ADR-016 by-reference payload,
// ADR-021 brokered access). The VM has no DynamoDB permission at all — the broker validates
// the capability token and returns the config for THIS run only.
function fetchJitConfig() {
  const res = callBroker('jitconfig', BOOT_CALL_ATTEMPTS, 2000, BOOT_CALL_TIMEOUT_MS);
  if (!res || res.ok !== true) {
    throw new Error(`broker jitconfig failed: ${res?.error ?? 'invoke failed'}`);
  }
  return {
    jitConfig: res.jitConfig,
    runId: Number(res.runId),
    jobId: Number(res.jobId),
    repoFullName: res.repoFullName,
    labels: res.labels ?? [],
  };
}

function runJob(payload) {
  const { jitConfig, runId, jobId, repoFullName } = payload;
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  log('job starting', { runId, jobId, repoFullName, asRoot });

  // Optional per-flavor pre-hook (e.g. the docker flavor starts dockerd). No-op if absent.
  //
  // The guest runs with the kernel's `no_new_privs` flag set, so `sudo` inside the microVM
  // can NEVER escalate ("sudo: The "no new privileges" flag is set"). Any flavor whose
  // pre-hook needs root therefore runs its entrypoint AS root and we drop privileges for
  // the runner agent below (the agent refuses to run as root).
  const preHook = `${RUNNER_DIR}/pre-run.sh`;
  if (fs.existsSync(preHook)) {
    const pr = spawnSync('bash', [preHook], { stdio: 'inherit' });
    if (pr.status !== 0) log('pre-run hook nonzero exit', { code: pr.status });
  }

  // run.sh --jitconfig runs EXACTLY ONE job then exits (JIT runners auto-remove).
  // When the entrypoint is root, drop to RUNNER_USER — downward privilege changes are
  // allowed under no_new_privs. --init-groups keeps the supplementary groups (e.g. docker).
  const [cmd, args] = asRoot
    ? [
        'setpriv',
        [
          '--reuid',
          RUNNER_USER,
          '--regid',
          RUNNER_USER,
          '--init-groups',
          './run.sh',
          '--jitconfig',
          jitConfig,
        ],
      ]
    : ['./run.sh', ['--jitconfig', jitConfig]];

  const child = spawn(cmd, args, {
    cwd: RUNNER_DIR,
    stdio: 'inherit',
    env: asRoot
      ? { ...process.env, HOME: `/home/${RUNNER_USER}`, USER: RUNNER_USER, LOGNAME: RUNNER_USER }
      : process.env,
  });

  child.on('exit', (code, signal) => {
    log('job finished', { runId, jobId, code, signal });
    selfTerminate(`job_done code=${code} signal=${signal || 'none'}`);
  });
  child.on('error', (err) => {
    log('runner spawn error', { runId, jobId, error: err.message });
    selfTerminate('spawn_error');
  });
}

const server = http.createServer(async (req, res) => {
  // Log EVERY request (path + method) — essential for diagnosing platform hook probes.
  // Platform lifecycle hooks arrive under the runtime prefix, e.g.
  //   POST /aws/lambda-microvms/runtime/v1/ready | /run | /terminate
  // (observed from live build logs). Short aliases kept for local testing.
  const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1';
  const rawPath = (req.url || '').split('?')[0];
  const path = rawPath.startsWith(HOOK_PREFIX) ? rawPath.slice(HOOK_PREFIX.length) : rawPath;
  log('request', { method: req.method, url: req.url, hook: path });
  try {
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // The `ready` image hook: fires during image build once the app has finished
    // initializing, so the snapshot is captured in a ready state. Required whenever any
    // lifecycle hook is enabled. Match any method.
    //
    // Also where the AWS CLI is pre-warmed: this hook is the last thing to run before the
    // snapshot is taken, so the cold-start cost is paid at BUILD time instead of on the boot
    // critical path inside the `/run` deadline. Best-effort — a failed warmup must never
    // fail the ready hook (a non-200 here fails the whole image build).
    if (path === '/ready') {
      try {
        prewarmAwsCli();
      } catch (err) {
        log('aws cli prewarm threw; boot will pay the cold cost', { error: safeErr(err) });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ready":true}');
      return;
    }

    if (req.method === 'POST' && path === '/run') {
      if (jobStarted) {
        // single-use guard — never accept a second job on the same VM
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end('{"error":"already ran a job"}');
        return;
      }
      const raw = await readBody(req);
      let ptr;
      try {
        ptr = JSON.parse(raw);
      } catch {
        log('run payload not JSON', { raw: redact(raw).slice(0, 512) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid JSON payload"}');
        return;
      }
      // The platform may deliver the launch payload wrapped (observed empirically — log the
      // raw body to diagnose). Accept both the bare payload and common wrapper keys.
      if (ptr && typeof ptr.runHookPayload === 'string') {
        try { ptr = JSON.parse(ptr.runHookPayload); } catch { /* fall through */ }
      } else if (ptr && typeof ptr.payload === 'string') {
        try { ptr = JSON.parse(ptr.payload); } catch { /* fall through */ }
      }
      if (!ptr || !ptr.ref || !ptr.broker || !ptr.token) {
        log('run payload missing ref/broker/token', { raw: redact(raw).slice(0, 512) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"missing ref/broker/token"}');
        return;
      }
      // Resolve the JIT config through the broker (the payload can't hold it, ADR-016; the
      // VM can't read DynamoDB, ADR-021). runCtx must be set first — callBroker reads it.
      runCtx = { ref: ptr.ref, region: ptr.region, broker: ptr.broker, token: ptr.token };
      let payload;
      try {
        payload = fetchJitConfig();
      } catch (err) {
        log('jit config fetch failed', { error: err.message, ref: ptr.ref });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('{"error":"jit config fetch failed"}');
        return;
      }
      if (!payload.jitConfig || !payload.runId || !payload.jobId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"resolved config missing jitConfig/runId/jobId"}');
        return;
      }
      jobStarted = true;
      // ACK fast so Lambda un-gates traffic; run the job in the background.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      runJob(payload);
      return;
    }

    if (req.method === 'POST' && path === '/terminate') {
      log('terminate hook fired', {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  } catch (err) {
    log('hook error', { error: err.message });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"internal"}');
    }
  }
});

// Only bind the port when executed as the entrypoint — importing this module (tests)
// must not start a server.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => log('run-hook listening', { port: PORT }));
}

export { server };
