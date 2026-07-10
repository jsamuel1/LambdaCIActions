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
 * Contract:
 *   POST /run        body = { jitConfig, runId, jobId, repoFullName, labels }  (<=16 KB)
 *                    -> 200 immediately; runner agent runs ONE job in the background
 *   POST /terminate  fires pre-teardown; best-effort final log flush
 *   GET  /healthz    liveness
 *
 * Single-use semantics (ADR-003/006): the JIT config is consumed by exactly one
 * `run.sh --jitconfig` invocation; on agent exit we self-terminate via `terminate-microvm`
 * (the Reaper λ backstops orphans). Zero runtime deps — Node built-ins only.
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const PORT = parseInt(process.env.RUN_HOOK_PORT || '8080', 10);
const RUNNER_DIR = process.env.RUNNER_DIR || '/opt/actions-runner';
const MAX_PAYLOAD_BYTES = 16 * 1024; // run-hook payload hard cap

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
  const r = spawnSync('aws', ['lambda', 'terminate-microvm', '--microvm-id', microvmId], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    log('terminate-microvm failed; Reaper will backstop', { stderr: r.stderr });
  }
}

// The microVM's own id is exposed to the guest via the instance metadata file that the
// Lambda microVM runtime writes at boot. Path is stable per the runtime contract.
function readMicrovmId() {
  try {
    return fs.readFileSync('/run/microvm/id', 'utf8').trim();
  } catch {
    return null;
  }
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
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    if (req.method === 'POST' && req.url === '/run') {
      if (jobStarted) {
        // single-use guard — never accept a second job on the same VM
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end('{"error":"already ran a job"}');
        return;
      }
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid JSON payload"}');
        return;
      }
      if (!payload.jitConfig || !payload.runId || !payload.jobId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"missing jitConfig/runId/jobId"}');
        return;
      }
      jobStarted = true;
      // ACK fast so Lambda un-gates traffic; run the job in the background.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      runJob(payload);
      return;
    }

    if (req.method === 'POST' && req.url === '/terminate') {
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
