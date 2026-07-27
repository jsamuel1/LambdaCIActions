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
const MAX_PAYLOAD_BYTES = 4096; // GA lambda-microvms run-hook payload hard cap (ADR-015)

let jobStarted = false; // guard: this microVM runs exactly one job
// The {ref, region, table} pointer delivered to /run — kept so selfTerminate can read the
// run row (which Provision stamps with our microvmId post-launch, ADR-019).
let runCtx = null;

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

// Self-terminate this microVM so it disappears the instant the job is done (no idle
// billing). There is NO reliable in-guest id source (ADR-016: no /run/microvm/id, env
// only carries AWS_LAMBDA_MICROVM_IMAGE_*), so the authoritative path is the RUN ROW
// READBACK (ADR-019): Provision stamps `microvmId` on the run record seconds after
// RunMicrovm returns; by job end (minutes later) it is there — fetch it by the same
// {ref, region, table} pointer we resolved the JIT config with.
function selfTerminate(reason) {
  const microvmId = process.env.MICROVM_ID || readMicrovmId() || readMicrovmIdFromRunStore();
  log('self-terminate', { reason, microvmId });
  if (!microvmId) {
    log('no microvm id available; relying on Reaper', {});
    return;
  }
  const args = ['lambda-microvms', 'terminate-microvm', '--microvm-identifier', microvmId];
  if (runCtx?.region) args.push('--region', runCtx.region);
  const r = spawnSync('aws', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    log('terminate-microvm failed; Reaper will backstop', { stderr: r.stderr });
  }
}

// Derive the run row key from the JIT config ref (`RUN#<repo>#<run>#<job>#JITCONFIG`).
// Exported pure so tests can pin the contract with the run store (ADR-019).
export function runRowKeyFromRef(ref) {
  const pk = ref.split('#JITCONFIG')[0];
  return { pk, sk: 'RUN' };
}

// Read our own microvmId back from the run row (ADR-019). Provision writes it right
// after launch; selfTerminate fires at job end, so it is present in all but a razor-thin
// race — retry a few times to cover a slow `running` transition write.
function readMicrovmIdFromRunStore(attempts = 3, delayMs = 2000) {
  if (!runCtx?.ref || !runCtx?.table) return null;
  const { pk, sk } = runRowKeyFromRef(runCtx.ref);
  const key = JSON.stringify({ pk: { S: pk }, sk: { S: sk } });
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleepSync(delayMs);
    const args = [
      'dynamodb', 'get-item',
      '--table-name', runCtx.table,
      '--key', key,
      '--projection-expression', 'microvmId',
      '--output', 'json',
    ];
    if (runCtx.region) args.push('--region', runCtx.region);
    const r = spawnSync('aws', args, { encoding: 'utf8' });
    if (r.status !== 0) {
      log('run row microvmId fetch failed', { attempt: i + 1, stderr: (r.stderr || '').slice(0, 512) });
      continue;
    }
    try {
      const id = JSON.parse(r.stdout || '{}').Item?.microvmId?.S;
      if (id) return id;
    } catch {
      /* malformed output — retry */
    }
    log('run row has no microvmId yet', { attempt: i + 1 });
  }
  return null;
}

// Blocking sleep — fine here: selfTerminate runs after the job, nothing else is pending.
function sleepSync(ms) {
  try {
    spawnSync('sleep', [String(ms / 1000)]);
  } catch {
    /* best-effort */
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
  log('job starting', { runId, jobId, repoFullName });

  // Optional per-flavor pre-hook (e.g. DinD starts dockerd). No-op if absent.
  const preHook = `${RUNNER_DIR}/pre-run.sh`;
  if (fs.existsSync(preHook)) {
    const pr = spawnSync('bash', [preHook], { stdio: 'inherit' });
    if (pr.status !== 0) log('pre-run hook nonzero exit', { code: pr.status });
  }

  // run.sh --jitconfig runs EXACTLY ONE job then exits (JIT runners auto-remove).
  const child = spawn('./run.sh', ['--jitconfig', jitConfig], {
    cwd: RUNNER_DIR,
    stdio: 'inherit',
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
      runCtx = { ref: ptr.ref, region: ptr.region, table: ptr.table }; // for selfTerminate readback
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
