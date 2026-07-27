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
 * REFERENCE, not inline):
 *   POST /run        body = { ref, region, table }   (small; <4 KB)
 *                    -> hook fetches the JIT config from DynamoDB by ref, then
 *                       200 immediately; runner agent runs ONE job in the background
 *   POST /terminate  fires pre-teardown; best-effort final log flush
 *   GET  /healthz    liveness
 *
 * Single-use semantics (ADR-003/006): the JIT config is consumed by exactly one
 * `run.sh --jitconfig` invocation; on agent exit we self-terminate via `terminate-microvm`
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

function log(msg, extra) {
  // structured line → CloudWatch (the UI reads via log_ref, spec 05)
  const rec = { ts: new Date().toISOString(), src: 'run-hook', msg, ...extra };
  process.stdout.write(JSON.stringify(rec) + '\n');
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

// Self-terminate this microVM. The metadata endpoint hands us our own id; we call
// terminate-microvm so the VM disappears the instant the job is done (no idle billing).
function selfTerminate(reason) {
  const microvmId = process.env.MICROVM_ID || readMicrovmId();
  log('self-terminate', { reason, microvmId });
  if (!microvmId) {
    log('no microvm id available; relying on Reaper', {});
    return;
  }
  const r = spawnSync('aws', ['lambda-microvms', 'terminate-microvm', '--microvm-identifier', microvmId], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    log('terminate-microvm failed; Reaper will backstop', { stderr: r.stderr });
  }
}

// The microVM's own id is exposed to the guest via instance metadata. The exact location
// is undocumented — try the known candidates and log what exists so we can pin it down
// from runtime logs (ADR-016 diagnosability).
function readMicrovmId() {
  const candidates = [
    '/run/microvm/id',
    '/etc/microvm-id',
    '/proc/device-tree/microvm-id',
  ];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  // Env fallbacks the runtime may set.
  for (const k of ['MICROVM_ID', 'AWS_LAMBDA_MICROVM_ID', 'LAMBDA_MICROVM_ID']) {
    if (process.env[k]) return process.env[k];
  }
  try {
    log('microvm id discovery failed', {
      runDir: fs.existsSync('/run/microvm') ? fs.readdirSync('/run/microvm') : 'no /run/microvm',
      envKeys: Object.keys(process.env).filter((k) => /microvm|lambda/i.test(k)),
    });
  } catch {
    /* best-effort */
  }
  return null;
}

// Fetch the stashed JIT config from DynamoDB by ref (ADR-015). Uses the baked-in AWS CLI
// (no npm deps in the image). The ref encodes the item's pk; sk is the fixed JITCONFIG_SK.
function fetchJitConfig({ ref, region, table }) {
  const pk = ref.split('#JITCONFIG')[0];
  const key = JSON.stringify({ pk: { S: pk }, sk: { S: 'JITCONFIG' } });
  const args = ['dynamodb', 'get-item', '--table-name', table, '--key', key, '--output', 'json'];
  if (region) args.push('--region', region);
  const r = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`dynamodb get-item failed: ${r.stderr || r.stdout}`);
  const out = JSON.parse(r.stdout || '{}');
  if (!out.Item) throw new Error(`no JIT config item for ref ${ref}`);
  const it = out.Item;
  return {
    jitConfig: it.jitConfig?.S,
    runId: Number(it.runId?.N),
    jobId: Number(it.jobId?.N),
    repoFullName: it.repoFullName?.S,
    labels: (it.labels?.L ?? []).map((x) => x.S),
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
        log('run payload not JSON', { raw: raw.slice(0, 512) });
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
      if (!ptr || !ptr.ref || !ptr.table) {
        log('run payload missing ref/table', { raw: raw.slice(0, 512) });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"missing ref/table"}');
        return;
      }
      // Resolve the JIT config by reference (the payload itself can't hold it, ADR-015).
      let payload;
      try {
        payload = fetchJitConfig(ptr);
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

server.listen(PORT, () => log('run-hook listening', { port: PORT }));

export { server };
