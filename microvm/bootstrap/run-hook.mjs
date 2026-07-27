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
 * Contract (ADR-015 — run-hook payload cap is 4 KB, so the JIT config is passed by
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

const PORT = parseInt(process.env.RUN_HOOK_PORT || '8080', 10);
const RUNNER_DIR = process.env.RUNNER_DIR || '/opt/actions-runner';
const RUNNER_USER = process.env.RUNNER_USER || 'runner';
const MAX_PAYLOAD_BYTES = 4096; // GA lambda-microvms run-hook payload hard cap (ADR-015)

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
  const res = callBroker('terminate');
  if (!res || res.ok !== true) {
    log('brokered terminate failed; Reaper will backstop', { error: res?.error ?? 'invoke failed' });
    return;
  }
  if (res.terminated === false) log('broker had no VM to terminate; Reaper will backstop', {});
}

// Invoke the hook broker λ via the baked-in AWS CLI (no npm deps in the image). The VM's
// execution role grants exactly one action — lambda:InvokeFunction on this function ARN.
// Retries cover the razor-thin window where Provision hasn't stamped microvmId yet.
function callBroker(action, attempts = 3, delayMs = 2000) {
  if (!runCtx?.ref || !runCtx?.broker || !runCtx?.token) {
    log('broker call skipped: no broker context', { action });
    return null;
  }
  const payload = JSON.stringify({ action, ref: runCtx.ref, token: runCtx.token });
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleepSync(delayMs);
    const outFile = `/tmp/broker-${action}-${i}.json`;
    const args = [
      'lambda', 'invoke',
      '--function-name', runCtx.broker,
      '--cli-binary-format', 'raw-in-base64-out',
      '--payload', payload,
      outFile,
    ];
    if (runCtx.region) args.push('--region', runCtx.region);
    const r = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) {
      log('broker invoke failed', { action, attempt: i + 1, stderr: (r.stderr || '').slice(0, 512) });
      continue;
    }
    let body;
    try {
      body = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (err) {
      log('broker response unreadable', { action, attempt: i + 1, error: err.message });
      continue;
    } finally {
      try { fs.unlinkSync(outFile); } catch { /* best-effort */ }
    }
    if (body?.ok !== true) {
      log('broker denied request', { action, attempt: i + 1, error: body?.error });
      return body ?? null; // an auth failure won't fix itself — don't burn retries
    }
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


// Blocking sleep — fine here: broker retries happen either before the job starts or after
// it finishes, with nothing else pending.
function sleepSync(ms) {
  try {
    spawnSync('sleep', [String(ms / 1000)]);
  } catch {
    /* best-effort */
  }
}


// Fetch the stashed JIT config through the hook broker (ADR-015 by-reference payload,
// ADR-021 brokered access). The VM has no DynamoDB permission at all — the broker validates
// the capability token and returns the config for THIS run only.
function fetchJitConfig() {
  const res = callBroker('jitconfig');
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
    if (path === '/ready') {
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
      // Resolve the JIT config through the broker (the payload can't hold it, ADR-015; the
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
      runCtx = { ref: ptr.ref, region: ptr.region, broker: ptr.broker, token: ptr.token };
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
