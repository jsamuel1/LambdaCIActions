// The ADR-041 smoke λ's GitHub calls must be abortable (review finding: a bare `fetch` has no
// deadline of its own, so a stalled socket could consume the whole Lambda timeout). This pins that
// the caller's AbortSignal reaches `fetch` for every helper the smoke run uses, including the
// installation-token mint that precedes each of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const gh = await import('../dist/src/shared/github-app.js');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function stubFetch() {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), signal: init?.signal });
    const body = String(url).includes('/access_tokens')
      ? { token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }
      : String(url).includes('generate-jitconfig')
        ? { encoded_jit_config: 'e', runner: { id: 1 } }
        : { default_branch: 'main', workflow_runs: [], jobs: [], runners: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { seen, restore: () => (globalThis.fetch = original) };
}

const base = { appId: '1', pem: PEM, owner: 'acme', repo: 'ci' };
const calls = {
  getRepoDefaultBranch: (p) => gh.getRepoDefaultBranch(p),
  generateSmokeJitConfig: (p) => gh.generateSmokeJitConfig({ ...p, label: 'lca-validate-x', name: 'n' }),
  dispatchWorkflow: (p) => gh.dispatchWorkflow({ ...p, workflow: 'w.yml', ref: 'main' }),
  listWorkflowDispatchRuns: (p) => gh.listWorkflowDispatchRuns({ ...p, workflow: 'w.yml' }),
  listRunJobs: (p) => gh.listRunJobs({ ...p, runId: 1 }),
  listRepoRunners: (p) => gh.listRepoRunners(p),
  cancelWorkflowRun: (p) => gh.cancelWorkflowRun({ ...p, runId: 1 }),
  deleteRepoRunner: (p) => gh.deleteRepoRunner({ ...p, runnerId: 1 }),
};

let installationId = 1000;
for (const [name, call] of Object.entries(calls)) {
  test(`${name} passes the caller's AbortSignal to fetch, token mint included`, async () => {
    gh._clearTokenCache();
    const f = stubFetch();
    const ctl = new AbortController();
    try {
      // A fresh installation id per test so the token mint is never a cache hit.
      await call({ ...base, installationId: installationId++, signal: ctl.signal });
    } finally {
      f.restore();
    }
    assert.ok(f.seen.length >= 2, 'expected the token mint and the API call');
    for (const req of f.seen) assert.equal(req.signal, ctl.signal, `${req.url} lost the signal`);
  });
}
