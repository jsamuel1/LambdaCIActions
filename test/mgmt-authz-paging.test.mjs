// Visibility-filtered pagination + tenant scoping in the Management API's read model
// (spec 04 § Authorization, M4 review fixes).
//
// Run indexes (GSI1 status/time, GSI2 repo/time — ADR-021) are NOT keyed by installation,
// so every list is filtered after the query. Two bugs live in that gap:
//   1. a page that filters down to a handful of rows must keep paging, or an operator whose
//      installation is a minority of traffic sees "no runs" plus a cursor;
//   2. dashboard `stuck` runs must be filtered, or one tenant sees another's repo names.
// These tests exercise the same pure helpers the handler uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAdminInstallation } from '../dist/src/mgmt/session.js';
import { collectVisible, MAX_FILTER_PAGES } from '../dist/src/mgmt/paging.js';
import { buildHealth, sortRunsNewestFirst } from '../dist/src/mgmt/views.js';

const session = {
  login: 'operator',
  installations: [{ installationId: 11, accountLogin: 'mine' }],
  iat: 0,
  exp: 2 ** 40,
};

function run(i, installationId, createdAt = '2026-07-01T00:00:00.000Z') {
  return {
    repoId: 100 + i,
    repoFullName: `${installationId === 11 ? 'mine' : 'theirs'}/repo-${i}`,
    installationId,
    runId: i,
    jobId: i,
    status: 'running',
    labels: [],
    createdAt,
    updatedAt: createdAt,
  };
}

const visible = (runs) => runs.filter((r) => canAdminInstallation(session, r.installationId));

test('a page of foreign runs keeps paging instead of returning empty', async () => {
  const pages = [
    { runs: [run(1, 99), run(2, 99)], nextCursor: 'c1' },
    { runs: [run(3, 99), run(4, 11)], nextCursor: 'c2' },
    { runs: [run(5, 11)], nextCursor: undefined },
  ];
  let i = 0;
  const res = await collectVisible(async () => pages[i++], visible, 3);
  assert.deepEqual(
    res.runs.map((r) => r.runId),
    [4, 5],
  );
  assert.equal(res.nextCursor, undefined, 'index exhausted → no cursor');
});

test('paging stops as soon as the visible page is full', async () => {
  const pages = [
    { runs: [run(1, 11), run(2, 11)], nextCursor: 'c1' },
    { runs: [run(3, 11)], nextCursor: 'c2' },
  ];
  let calls = 0;
  const res = await collectVisible(
    async () => {
      calls += 1;
      return pages[calls - 1];
    },
    visible,
    2,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    res.runs.map((r) => r.runId),
    [1, 2],
  );
  assert.equal(res.nextCursor, 'c1', 'more may remain → cursor preserved');
});

test('the page budget bounds a hostile ratio of foreign rows', async () => {
  let calls = 0;
  const res = await collectVisible(
    async () => {
      calls += 1;
      return { runs: [run(calls, 99)], nextCursor: `c${calls}` };
    },
    visible,
    50,
  );
  assert.equal(calls, MAX_FILTER_PAGES, 'must not walk the index forever inside one request');
  assert.deepEqual(res.runs, []);
  assert.equal(res.nextCursor, `c${MAX_FILTER_PAGES}`, 'the client can resume rather than losing history');
});

test('surplus visible rows in the final page are returned, not dropped', async () => {
  // The cursor is an index-PAGE cursor: resuming at it skips everything the page contained.
  // Truncating to `limit` would therefore lose run 3 permanently.
  const pages = [
    { runs: [run(1, 11), run(2, 99)], nextCursor: 'c1' },
    { runs: [run(2, 11), run(3, 11)], nextCursor: 'c2' },
  ];
  let i = 0;
  const res = await collectVisible(async () => pages[i++], visible, 2);
  assert.deepEqual(
    res.runs.map((r) => r.runId),
    [1, 2, 3],
    'a row collected inside the last fetched page must not be sliced away',
  );
  assert.equal(res.nextCursor, 'c2');
});

test('a caller-supplied cursor is honoured on the first fetch', async () => {
  const seen = [];
  await collectVisible(
    async (cursor) => {
      seen.push(cursor);
      return { runs: [run(1, 11)], nextCursor: undefined };
    },
    visible,
    50,
    'resume-here',
  );
  assert.deepEqual(seen, ['resume-here']);
});

test('dashboard stuck runs never expose another tenant', () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const counts = { queued: 1, provisioning: 0, running: 1, completed: 0, failed: 0, timed_out: 0 };
  const active = [run(1, 11, old), run(2, 99, old)];
  const health = buildHealth(counts, visible(active));
  assert.equal(health.stuck.length, 1);
  assert.equal(health.stuck[0].installationId, 11);
  assert.equal(
    health.stuck.some((r) => r.repoFullName.startsWith('theirs/')),
    false,
    'foreign repo name leaked into the dashboard',
  );
});

test('merged multi-status views stay newest-first after filtering', () => {
  const merged = sortRunsNewestFirst(
    visible([
      run(1, 11, '2026-07-01T00:00:00.000Z'),
      run(2, 99, '2026-07-03T00:00:00.000Z'),
      run(3, 11, '2026-07-02T00:00:00.000Z'),
    ]),
  );
  assert.deepEqual(
    merged.map((r) => r.runId),
    [3, 1],
  );
});

test('a foreign run and a missing run are indistinguishable (404, no existence oracle)', async () => {
  // Run detail/logs can only check the grant AFTER the row read; a 403 there would tell an
  // authenticated foreign operator that the guessed run id triple exists.
  const { gateRunRecord } = await import('../dist/src/mgmt/handler.js');
  const foreign = gateRunRecord(session, run(1, 99));
  const missing = gateRunRecord(session, undefined);
  assert.ok('reply' in foreign && 'reply' in missing);
  assert.equal(foreign.reply.statusCode, 404);
  assert.equal(missing.reply.statusCode, 404);
  assert.deepEqual(foreign.reply.body, missing.reply.body, 'bodies must not differ either');
  const mine = gateRunRecord(session, run(1, 11));
  assert.ok('record' in mine);
});
