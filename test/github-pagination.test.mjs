// Smoke-run GitHub listings are read to completion (review finding 1794555970246-5ee1de:2).
//
// Every smoke-run caller of these listings looks for ONE specific item — our nonce runner, our
// dispatched run, the job carrying our nonce — so a first-page-only read turns "not on page 1" into
// "not there": a busy repo hides our run (never cancelled, never attributed) and a repo with many
// runners hides a registration whose mint response was lost (residue left behind). These tests put
// the target BEYOND the first page and assert it is found, and that a listing too long to finish
// fails closed instead of returning what it read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

const gh = await import('../dist/src/shared/github-app.js');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const API = 'https://api.github.com';

/**
 * A fake GitHub that serves `pages[path-without-page]` as a `Link`-paginated listing. Records every
 * request URL. `endless` keeps advertising a next page forever.
 */
function fakeGithub(pagesFor, { endless = false } = {}) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 200 },
      );
    }
    const parsed = new URL(u);
    const page = Number(parsed.searchParams.get('page') ?? '1');
    parsed.searchParams.delete('page');
    const pages = pagesFor(parsed);
    const body = pages[page - 1] ?? pages.at(-1);
    const headers = new Headers();
    if (endless || page < pages.length) {
      const next = new URL(parsed);
      next.searchParams.set('page', String(page + 1));
      headers.set('link', `<${next}>; rel="next", <${API}/x?page=99>; rel="last"`);
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  return { seen, restore: () => (globalThis.fetch = original) };
}

let inst = 5000;
const base = () => ({ appId: '1', pem: PEM, installationId: inst++, owner: 'acme', repo: 'ci' });

const runnersPage = (from, n) => ({
  total_count: 250,
  runners: Array.from({ length: n }, (_, i) => ({
    id: from + i,
    name: `bystander-${from + i}`,
    status: 'online',
    labels: [{ name: 'self-hosted' }],
  })),
});

test('nextPagePath follows rel="next" and only ever on the GitHub API host', () => {
  assert.equal(
    gh.nextPagePath(`<${API}/repos/a/b/actions/runners?per_page=100&page=2>; rel="next", <${API}/x>; rel="last"`),
    '/repos/a/b/actions/runners?per_page=100&page=2',
  );
  assert.equal(gh.nextPagePath(`<${API}/x?page=1>; rel="prev"`), undefined);
  assert.equal(gh.nextPagePath(undefined), undefined);
  // A Link header is response data: never send an installation token to another host.
  assert.equal(gh.nextPagePath('<https://evil.example/steal?page=2>; rel="next"'), undefined);
});

test('the runner lookup asks GitHub for the exact name and finds a runner past page 1', async () => {
  const ours = { id: 9001, name: 'lca-validate-abc', status: 'offline', labels: [{ name: 'lca-validate-abc' }] };
  const f = fakeGithub((u) =>
    u.searchParams.get('name') === 'lca-validate-abc'
      ? // Even a server-side filtered listing is paged to its end.
        [{ total_count: 2, runners: [] }, { total_count: 2, runners: [ours] }]
      : [runnersPage(1, 100), runnersPage(101, 100), { total_count: 250, runners: [ours] }],
  );
  let found;
  try {
    found = await gh.listRepoRunners({ ...base(), name: 'lca-validate-abc' });
  } finally {
    f.restore();
  }
  const listing = f.seen.filter((u) => u.includes('/actions/runners'));
  assert.match(listing[0], /[?&]name=lca-validate-abc(&|$)/, 'filtered server-side by exact name');
  assert.equal(listing.length, 2, 'followed the Link header to page 2');
  assert.deepEqual(found.map((r) => r.id), [9001]);
});

test('an unfiltered runner listing is read across every page', async () => {
  const f = fakeGithub(() => [runnersPage(1, 100), runnersPage(101, 100), runnersPage(201, 50)]);
  let all;
  try {
    all = await gh.listRepoRunners(base());
  } finally {
    f.restore();
  }
  assert.equal(all.length, 250);
});

test('the name filter is re-checked exactly: a prefix match from GitHub is never accepted', async () => {
  const f = fakeGithub(() => [
    {
      runners: [
        { id: 1, name: 'lca-validate-abc-imposter', labels: [] },
        { id: 2, name: 'LCA-VALIDATE-ABC', labels: [] },
      ],
    },
  ]);
  let found;
  try {
    found = await gh.listRepoRunners({ ...base(), name: 'lca-validate-abc' });
  } finally {
    f.restore();
  }
  assert.deepEqual(found.map((r) => r.id), [2]);
});

test('a dispatched run behind more than one page of newer runs is still listed', async () => {
  const floorMs = Date.parse('2026-11-13T08:00:00.000Z');
  const at = (s) => new Date(floorMs + s * 1000).toISOString();
  // 150 later dispatches by someone else, newest first, then ours, then one from before the floor.
  const newer = Array.from({ length: 150 }, (_, i) => ({ id: 2000 + i, created_at: at(300 - i), status: 'queued' }));
  const ours = { id: 1500, created_at: at(0), status: 'queued' };
  const older = { id: 1, created_at: at(-60), status: 'completed', conclusion: 'success' };
  const all = [...newer, ours, older];
  const f = fakeGithub(() => [
    { workflow_runs: all.slice(0, 100) },
    { workflow_runs: all.slice(100, 200) },
  ]);
  let runs;
  try {
    runs = await gh.listWorkflowDispatchRuns({ ...base(), workflow: 'v.yml', createdAtOrAfterMs: floorMs + 400 });
  } finally {
    f.restore();
  }
  const listing = f.seen.filter((u) => u.includes('/runs?'));
  assert.match(decodeURIComponent(listing[0]), /created=>=2026-11-13T08:00:00Z/, 'second-floored server-side window');
  assert.match(listing[0], /per_page=100/);
  assert.ok(runs.some((r) => r.id === 1500), 'our run is found on page 2');
  assert.equal(runs.some((r) => r.id === 1), false, 'a run before the floor is never returned');
});

test('a job listing longer than one page is followed to the nonce-bearing job', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, labels: ['ubuntu-latest'] }));
  const f = fakeGithub(() => [{ jobs: filler }, { jobs: [{ id: 999, labels: ['lca-validate-abc'], runner_name: 'lca-validate-abc' }] }]);
  let jobs;
  try {
    jobs = await gh.listRunJobs({ ...base(), runId: 7 });
  } finally {
    f.restore();
  }
  assert.equal(jobs.length, 101);
  assert.ok(jobs.some((j) => j.labels.includes('lca-validate-abc')));
});

for (const [name, call] of [
  ['listRepoRunners', (p) => gh.listRepoRunners({ ...p, name: 'n', maxPages: 3 })],
  ['listWorkflowDispatchRuns', (p) => gh.listWorkflowDispatchRuns({ ...p, workflow: 'v.yml', maxPages: 3 })],
  ['listRunJobs', (p) => gh.listRunJobs({ ...p, runId: 1, maxPages: 3 })],
]) {
  test(`${name}: a listing that does not end within the page cap FAILS instead of returning a partial set`, async () => {
    const f = fakeGithub(() => [{ runners: [], workflow_runs: [], jobs: [] }], { endless: true });
    try {
      await assert.rejects(call(base()), (err) => {
        assert.ok(err instanceof gh.GithubListingIncompleteError, String(err));
        return true;
      });
    } finally {
      f.restore();
    }
    assert.equal(f.seen.filter((u) => !u.includes('/access_tokens')).length, 3, 'exactly the cap was spent');
  });
}
