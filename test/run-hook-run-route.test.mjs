// The guest run-hook's `/run` acceptance contract, driven over a real socket.
//
// ADR-041's live acceptance criterion could not be met and this is why. A validation smoke run has
// no GitHub `workflow_job`, so `src/shared/smoke-store.ts` deliberately stores `runId: 0, jobId: 0`
// — its own comment says they "must be present and numeric so the guest's own logging path behaves
// identically to a real job". The guest then validated them with `!payload.runId`, and zero is
// falsy: it answered 400 and returned WITHOUT logging anything. The only evidence was a guest log
// that stopped dead after the `/run` request line, and a control plane that concluded "the runner
// never registered with GitHub".
//
// Live evidence (2026-08-22): the PROVEN `lca-dev-node` image, registered unchanged as a custom
// flavor, was condemned `invalid` by this path. No image could ever have passed the smoke gate.
//
// Every other run-hook test imports pure helpers. This one exercises the request handler itself,
// because the defect was in the handler's guard and nothing else could see it. `aws` and `run.sh`
// are replaced with scripts on PATH / in RUNNER_DIR so no AWS call and no real runner agent occur.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-runhook-'));
const runnerDir = path.join(tmp, 'runner');
const binDir = path.join(tmp, 'bin');
fs.mkdirSync(runnerDir);
fs.mkdirSync(binDir);

/** The broker reply the fake `aws` returns, rewritten per test. */
const replyFile = path.join(tmp, 'reply.json');

// Stand-in AWS CLI: `aws lambda invoke ... <outfile> [--region R]` writes the scripted reply to
// <outfile>. The outfile is the sole POSITIONAL argument, so flag VALUES must be skipped too —
// scanning for "first non-dash token" picks up `us-west-2` from `--region us-west-2`.
fs.writeFileSync(
  path.join(binDir, 'aws'),
  `#!/usr/bin/env bash
out=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    --function-name|--payload|--region) skip=1 ;;
    -*|lambda|invoke) ;;
    *) out="$a" ;;
  esac
done
cp ${JSON.stringify(replyFile)} "$out"
`,
  { mode: 0o755 },
);
// Stand-in runner agent: exits 0 immediately, so `job starting` / `job finished` are reachable
// without a real Actions runner.
fs.writeFileSync(path.join(runnerDir, 'run.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

// Read at module scope by run-hook.mjs, so both must be set BEFORE the import below.
process.env.RUNNER_DIR = runnerDir;
process.env.PATH = `${binDir}:${process.env.PATH}`;

const { server: importedServer } = await import('../microvm/bootstrap/run-hook.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// `jobStarted` is module state implementing the ADR-003 single-use rule: the SECOND `/run` on one
// VM is answered 409 by design. Each case therefore needs a fresh module instance, obtained with a
// cache-busting query so the import is not deduplicated.
let instance = 0;
async function freshServer() {
  if (instance++ === 0) return importedServer;
  const m = await import(`../microvm/bootstrap/run-hook.mjs?i=${instance}`);
  return m.server;
}

/** POST /run once against a freshly listening server, returning status + captured stdout. */
async function postRun(reply, body) {
  fs.writeFileSync(replyFile, JSON.stringify(reply));
  const server = await freshServer();
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write(chunk, ...rest);
  };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/aws/lambda-microvms/runtime/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    // The job runs in the background AFTER the ACK; give its exit handler a tick to log.
    await new Promise((r) => setTimeout(r, 250));
    return { status: res.status, text, log: lines.join('') };
  } finally {
    process.stdout.write = write;
    await new Promise((resolve) => server.close(resolve));
  }
}

const SMOKE_POINTER = {
  ref: 'SMOKE#146431062#1787436000000#JITCONFIG',
  region: 'us-west-2',
  broker: 'lca-dev-hook-broker',
  token: 'capability-token',
};

test('a smoke run whose synthetic runId/jobId are ZERO is accepted and starts the agent', async () => {
  // The exact live shape. Before the fix this answered 400 silently and the agent never started,
  // which the control plane could only read as "the runner never registered".
  const r = await postRun(
    {
      ok: true,
      jitConfig: 'encoded-jit-config',
      runId: 0,
      jobId: 0,
      repoFullName: 'jsamuel1/lca-m3-verify',
      labels: ['lca-validate-abc123'],
    },
    SMOKE_POINTER,
  );

  assert.equal(r.status, 200);
  assert.match(r.log, /"msg":"job starting"/);
  // And the ids are carried through as the real zeros, not coerced away.
  assert.match(r.log, /"runId":0/);
  assert.match(r.log, /"jobId":0/);
});

test('a real job with nonzero ids is unaffected', async () => {
  const r = await postRun(
    {
      ok: true,
      jitConfig: 'encoded-jit-config',
      runId: 32366524247,
      jobId: 96417119067,
      repoFullName: 'jsamuel1/SauhsojVideo',
      labels: ['lambda-ci'],
    },
    { ...SMOKE_POINTER, ref: 'RUN#1#32366524247#96417119067#JITCONFIG' },
  );

  assert.equal(r.status, 200);
  assert.match(r.log, /"msg":"job starting"/);
});

test('a reply with a NON-NUMERIC id is still refused, and now says so in the log', async () => {
  // Widening the guard must not make it vacuous: a broker reply that genuinely lacks the ids is a
  // control-plane fault, and the silent 400 was itself part of what made the live defect so hard to
  // read — the guest logged nothing at all.
  const r = await postRun(
    { ok: true, jitConfig: 'encoded-jit-config', repoFullName: 'x/y', labels: [] },
    SMOKE_POINTER,
  );

  assert.equal(r.status, 400);
  assert.match(r.text, /resolved config missing/);
  assert.match(r.log, /"msg":"resolved config incomplete"/);
  assert.equal(/"msg":"job starting"/.test(r.log), false);
});

test('a reply with no jitConfig is refused even when the ids are valid', async () => {
  const r = await postRun({ ok: true, runId: 0, jobId: 0, repoFullName: 'x/y', labels: [] }, SMOKE_POINTER);

  assert.equal(r.status, 400);
  assert.equal(/"msg":"job starting"/.test(r.log), false);
});
