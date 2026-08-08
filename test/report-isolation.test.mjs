// Tenant isolation for reporting aggregates (src/mgmt/report-store.ts).
//
// This is the test the Reports feature exists to satisfy. Every other management read queries
// a status/repo index and filters by installation AFTERWARDS; for a LIST a missed filter leaks
// a row, for an AGGREGATE it silently turns a tenant total into a platform total — a number
// that looks perfectly plausible. So reporting resolves the visible repo set FIRST and only
// ever queries those partitions. These tests assert that ordering, not just the outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PAGES_PER_REPO,
  MAX_TOTAL_ROWS,
  PAGE_SIZE,
  fetchReportRuns,
  resolveVisibleRepos,
} from '../dist/src/mgmt/report-store.js';
import { applyFilters, computeReport, validateReportSpec } from '../dist/src/mgmt/reports.js';

const NOW = new Date('2026-07-15T12:00:00.000Z');

function session(installations) {
  return { login: 'operator', installations, iat: 0, exp: 2 ** 40 };
}

const MINE = session([{ installationId: 11, accountLogin: 'mine' }]);

function spec(over = {}) {
  const r = validateReportSpec({ metric: 'spend', dimension: 'repo', preset: '30d', ...over }, NOW);
  assert.ok(r.ok, JSON.stringify(r.errors ?? []));
  return r.value;
}

function job(repoId, over = {}) {
  return {
    repoId,
    repoFullName: repoId === 1 ? 'mine/service' : 'theirs/service',
    installationId: repoId === 1 ? 11 : 22,
    runId: 100,
    jobId: repoId * 1000,
    status: 'completed',
    flavor: 'base',
    labels: [],
    createdAt: '2026-07-15T11:00:00.000Z',
    runningAt: '2026-07-15T11:01:00.000Z',
    updatedAt: '2026-07-15T11:06:00.000Z',
    ...over,
  };
}

/** Fake GSI2: a map of repoId → newest-first pages. Records which repos were queried. */
function fakeIndex(byRepo) {
  const queried = [];
  const listRunsByRepo = async (repoId, opts = {}) => {
    queried.push(repoId);
    const pages = byRepo[repoId] ?? [[]];
    const page = Number(opts.cursor ?? 0);
    return {
      runs: pages[page] ?? [],
      nextCursor: page + 1 < pages.length ? String(page + 1) : undefined,
    };
  };
  return { listRunsByRepo, queried };
}

test('an aggregate reads ONLY the operator\'s repos — a foreign partition is never queried', async () => {
  const idx = fakeIndex({ 1: [[job(1)]], 2: [[job(2)]] });
  const res = await fetchReportRuns(MINE, spec(), {
    // Repo 2 belongs to installation 22, which this session does not administer.
    listRepos: async () => [{ repoId: 1, repoFullName: 'mine/service' }],
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.deepEqual(idx.queried, [1], 'a repo outside the session grant was queried');
  assert.deepEqual(res.runs.map((r) => r.repoId), [1]);
  assert.deepEqual(res.repoIds, [1]);
});

test('the computed total contains no contribution from another tenant', async () => {
  const idx = fakeIndex({ 1: [[job(1)]], 2: [[job(2), job(2, { jobId: 2001 })]] });
  const s = spec({ dimension: 'none' });
  const mine = await fetchReportRuns(MINE, s, {
    listRepos: async () => [{ repoId: 1, repoFullName: 'mine/service' }],
    listRunsByRepo: idx.listRunsByRepo,
  });
  const mineReport = computeReport(applyFilters(mine.runs, s), s, { complete: mine.complete });

  // Same window computed over BOTH tenants: the platform total must be strictly larger, which
  // is what a forgotten filter would have produced.
  const both = await fetchReportRuns(session([
    { installationId: 11, accountLogin: 'mine' },
    { installationId: 22, accountLogin: 'theirs' },
  ]), s, {
    listRepos: async () => [
      { repoId: 1, repoFullName: 'mine/service' },
      { repoId: 2, repoFullName: 'theirs/service' },
    ],
    listRunsByRepo: idx.listRunsByRepo,
  });
  const bothReport = computeReport(applyFilters(both.runs, s), s, { complete: both.complete });

  assert.equal(mineReport.rowCount, 1);
  assert.equal(bothReport.rowCount, 3);
  assert.ok(bothReport.total > mineReport.total, 'the isolation test is not actually isolating');
});

test('a spec naming a foreign repo NARROWS to nothing rather than widening scope', async () => {
  const idx = fakeIndex({ 1: [[job(1)]], 2: [[job(2)]] });
  // Exercises the REAL resolveVisibleRepos: the installation lister is stubbed (that is the
  // DynamoDB boundary), but the intersection with spec.filters.repoIds is the shipped code.
  const res = await fetchReportRuns(MINE, spec({ filters: { repoIds: [2] } }), {
    listRepos: (session, s) =>
      resolveVisibleRepos(session, s, {
        listRepos: async (installationId) =>
          installationId === 11 ? [{ repoId: 1, repoFullName: 'mine/service' }] : [],
      }),
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.deepEqual(idx.queried, [], 'a foreign repo id in the spec caused a query');
  assert.equal(res.runs.length, 0);
});

test('resolveVisibleRepos intersects rather than unions a spec repo filter', async () => {
  // Directly pins the narrowing property of the real function: one visible repo is kept, the
  // foreign id in the spec is dropped instead of being added to the read set.
  const visible = await resolveVisibleRepos(MINE, spec({ filters: { repoIds: [1, 2] } }), {
    listRepos: async () => [
      { repoId: 1, repoFullName: 'mine/service' },
      { repoId: 3, repoFullName: 'mine/other' },
    ],
  });
  assert.deepEqual(visible.map((r) => r.repoId), [1], 'scope was widened by a spec filter');
});

test('a zero-grant session reads nothing at all', async () => {
  const idx = fakeIndex({ 1: [[job(1)]] });
  const res = await fetchReportRuns(session([]), spec(), {
    listRepos: async () => [],
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.deepEqual(idx.queried, []);
  assert.equal(res.runs.length, 0);
  assert.equal(res.complete, true, 'an empty scope is complete, not partial');
});

test('a repo granted via two installations is not double-counted', async () => {
  // Double-reading a shared repo would DOUBLE its spend, so the de-dupe is a correctness
  // property, not a tidiness one. This drives the REAL resolveVisibleRepos with a lister that
  // returns the same repo under both installations the operator administers.
  const both = session([
    { installationId: 11, accountLogin: 'a' },
    { installationId: 22, accountLogin: 'b' },
  ]);
  const idx = fakeIndex({ 1: [[job(1)]] });
  const res = await fetchReportRuns(both, spec({ dimension: 'none' }), {
    listRepos: (s, sp) =>
      resolveVisibleRepos(s, sp, {
        listRepos: async () => [{ repoId: 1, repoFullName: 'shared/repo' }],
      }),
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.deepEqual(idx.queried, [1], 'a shared repo was queried once per installation');
  assert.equal(res.runs.length, 1);
  assert.deepEqual(res.repoIds, [1]);
});

test('paging stops as soon as a page predates the window', async () => {
  const inWindow = job(1, { createdAt: '2026-07-15T11:00:00.000Z' });
  const old = job(1, { jobId: 999, createdAt: '2026-01-01T00:00:00.000Z' });
  const idx = fakeIndex({ 1: [[inWindow, old], [old], [old]] });
  const res = await fetchReportRuns(MINE, spec({ preset: '24h' }), {
    listRepos: async () => [{ repoId: 1, repoFullName: 'mine/service' }],
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.equal(idx.queried.length, 1, 'kept paging past the window boundary');
  assert.deepEqual(res.runs.map((r) => r.jobId), [1000]);
  assert.equal(res.complete, true);
});

test('spending the per-repo page budget reports incomplete instead of a silent floor', async () => {
  const pages = Array.from({ length: MAX_PAGES_PER_REPO + 5 }, () => [job(1)]);
  const idx = fakeIndex({ 1: pages });
  const res = await fetchReportRuns(MINE, spec(), {
    listRepos: async () => [{ repoId: 1, repoFullName: 'mine/service' }],
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.equal(idx.queried.length, MAX_PAGES_PER_REPO);
  assert.equal(res.complete, false);
});

test('budget constants are coherent', () => {
  assert.ok(PAGE_SIZE > 0 && MAX_PAGES_PER_REPO > 0);
  assert.ok(MAX_TOTAL_ROWS >= PAGE_SIZE * MAX_PAGES_PER_REPO / 4, 'row cap would fire before the page cap is useful');
});

test('a row-budget cut reports the repos READ, not the whole authorization scope', async () => {
  // The row cap stops the workers, so repos still queued are never queried at all. Reporting the
  // resolved scope as the read set would tell the operator a partial number covered every repo
  // they administer — an overstatement of coverage precisely when the report is least complete.
  const repoCount = 24;
  const repos = Array.from({ length: repoCount }, (_, i) => ({
    repoId: i + 1,
    repoFullName: `mine/r${i + 1}`,
  }));
  // Each repo returns one page big enough that a handful of them exhausts MAX_TOTAL_ROWS.
  const perRepo = Math.ceil(MAX_TOTAL_ROWS / 3);
  const byRepo = {};
  for (const r of repos) {
    byRepo[r.repoId] = [
      Array.from({ length: perRepo }, (_, n) => job(1, { repoId: r.repoId, jobId: n + 1 })),
    ];
  }
  const idx = fakeIndex(byRepo);
  const res = await fetchReportRuns(MINE, spec(), {
    listRepos: async () => repos,
    listRunsByRepo: idx.listRunsByRepo,
  });

  assert.equal(res.complete, false, 'the row budget did not actually trip');
  assert.equal(res.repoIds.length, repoCount, 'the authorization scope should be the full set');
  assert.ok(
    res.repoIdsRead.length < res.repoIds.length,
    'repoIdsRead must exclude repos the budget never reached',
  );
  assert.deepEqual(
    res.repoIdsRead,
    res.repoIdsRead.filter((id) => res.repoIds.includes(id)),
    'a repo was reported read that is not even in scope',
  );
  // Every repo counted as read was genuinely queried.
  const queried = new Set(idx.queried);
  for (const id of res.repoIdsRead) {
    assert.ok(queried.has(id), `repo ${id} counted as read but never queried`);
  }
});

test('a complete read reports scope and read set as equal', async () => {
  const idx = fakeIndex({ 1: [[job(1)]], 3: [[]] });
  const res = await fetchReportRuns(MINE, spec(), {
    listRepos: async () => [
      { repoId: 1, repoFullName: 'mine/service' },
      { repoId: 3, repoFullName: 'mine/other' },
    ],
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.equal(res.complete, true);
  assert.deepEqual(res.repoIdsRead, res.repoIds, 'a complete read must not understate coverage');
});

test('billableMinutes carries no foreign tenant compute', async () => {
  // Asserted independently of `spend` rather than trusting it. The two metrics share a fold and
  // a window, but the leak this file exists to catch happens BEFORE the fold — and a metric
  // added later inherits the isolation only if it is actually driven through the same read path.
  // A consumption figure that silently included another tenant's microVM minutes is exactly as
  // plausible-looking as a leaked spend total, and here there is no currency symbol to make an
  // implausible magnitude obvious.
  const idx = fakeIndex({ 1: [[job(1)]], 2: [[job(2), job(2, { jobId: 2001 })]] });
  const s = spec({ metric: 'billableMinutes', dimension: 'none' });

  const mine = await fetchReportRuns(MINE, s, {
    listRepos: async () => [{ repoId: 1, repoFullName: 'mine/service' }],
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.deepEqual(idx.queried, [1], 'a foreign partition was queried for a utilisation report');
  const mineReport = computeReport(applyFilters(mine.runs, s), s, { complete: mine.complete, now: NOW });

  const both = await fetchReportRuns(
    session([
      { installationId: 11, accountLogin: 'mine' },
      { installationId: 22, accountLogin: 'theirs' },
    ]),
    s,
    {
      listRepos: async () => [
        { repoId: 1, repoFullName: 'mine/service' },
        { repoId: 2, repoFullName: 'theirs/service' },
      ],
      listRunsByRepo: idx.listRunsByRepo,
    },
  );
  const bothReport = computeReport(applyFilters(both.runs, s), s, { complete: both.complete, now: NOW });

  assert.equal(mineReport.rowCount, 1);
  assert.equal(bothReport.rowCount, 3);
  assert.ok(mineReport.total > 0, 'the tenant report must measure something to be worth isolating');
  assert.ok(
    bothReport.total > mineReport.total,
    'the platform-wide compute total is not larger than the tenant one — this test is not isolating',
  );
  // Every minute in the tenant report belongs to a repo the tenant can see.
  assert.deepEqual([...new Set(applyFilters(mine.runs, s).map((r) => r.repoId))], [1]);
});

test('a spec naming a foreign repo yields no utilisation, not a platform figure', async () => {
  const idx = fakeIndex({ 1: [[job(1)]], 2: [[job(2)]] });
  const s = spec({ metric: 'billableMinutes', dimension: 'repo', filters: { repoIds: [2] } });
  const res = await fetchReportRuns(MINE, s, {
    listRepos: (sess, sp) =>
      resolveVisibleRepos(sess, sp, {
        listRepos: async (installationId) =>
          installationId === 11 ? [{ repoId: 1, repoFullName: 'mine/service' }] : [],
      }),
    listRunsByRepo: idx.listRunsByRepo,
  });
  assert.deepEqual(idx.queried, [], 'a foreign repo id in a utilisation spec caused a query');
  const report = computeReport(applyFilters(res.runs, s), s, { complete: res.complete, now: NOW });
  assert.equal(report.total, 0);
  assert.equal(report.points.length, 0);
});
