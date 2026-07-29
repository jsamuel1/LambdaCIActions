// Unit tests for the pure run-level rollup/fold helpers used by the Runs screen
// (src/mgmt/run-rollup.ts). These are the rules an operator reads as fact, so the fold
// precedence, the two duration totals, and the partial/completeness rule are all pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldRunStatus,
  rollupFlavor,
  runDurations,
  windowComplete,
  mergedResponseComplete,
  repoResponseComplete,
  groupRuns,
  runGroupKey,
} from '../dist/src/mgmt/run-rollup.js';

const job = (over = {}) => ({
  repoId: 1,
  repoFullName: 'acme/service',
  runId: 100,
  jobId: 1,
  status: 'completed',
  flavor: 'node',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:01:00.000Z',
  durationSeconds: 60,
  ...over,
});

// ---- status fold -----------------------------------------------------------

test('failure dominates the status fold', () => {
  assert.equal(foldRunStatus(['completed', 'running', 'failed']), 'failed');
  assert.equal(foldRunStatus(['queued', 'timed_out']), 'timed_out');
  // failed outranks timed_out so a run with both reads as failed.
  assert.equal(foldRunStatus(['timed_out', 'failed']), 'failed');
});

test('among non-failures the most advanced active status wins', () => {
  assert.equal(foldRunStatus(['queued', 'running']), 'running');
  assert.equal(foldRunStatus(['queued', 'provisioning']), 'provisioning');
  assert.equal(foldRunStatus(['provisioning', 'running']), 'running');
  // completed only surfaces when nothing is still moving.
  assert.equal(foldRunStatus(['completed', 'queued']), 'queued');
  assert.equal(foldRunStatus(['completed', 'completed']), 'completed');
});

test('an empty job set folds to queued, not completed', () => {
  // "all jobs completed" must never be inferred from no jobs at all.
  assert.equal(foldRunStatus([]), 'queued');
});

// ---- flavor rollup ---------------------------------------------------------

test('a single agreed flavor rolls up to its own name', () => {
  const r = rollupFlavor(['node', 'node', 'node']);
  assert.equal(r.label, 'node');
  assert.equal(r.mixed, false);
  assert.deepEqual(r.distinct, ['node']);
});

test('mixed flavors roll up to most-common +n with the full breakdown', () => {
  const r = rollupFlavor(['node', 'docker', 'node', 'base']);
  assert.equal(r.label, 'node +2');
  assert.equal(r.mixed, true);
  assert.deepEqual(r.distinct, ['node', 'base', 'docker']); // count desc, then alphabetical
});

test('jobs with no flavor yet are ignored, not folded in as a pseudo-flavor', () => {
  assert.deepEqual(rollupFlavor([undefined, 'node', undefined]), {
    label: 'node',
    distinct: ['node'],
    mixed: false,
  });
  assert.deepEqual(rollupFlavor([undefined, undefined]), {
    label: '—',
    distinct: [],
    mixed: false,
  });
});

// ---- durations -------------------------------------------------------------

test('wall clock is the span, job time is the sum — parallel jobs diverge', () => {
  // Two jobs, each 60 s, started together: 60 s wall clock but 120 s of summed job time.
  const d = runDurations([
    { createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:01:00Z', durationSeconds: 60 },
    { createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:01:00Z', durationSeconds: 60 },
  ]);
  assert.equal(d.wallClockSeconds, 60);
  assert.equal(d.jobTimeSeconds, 120);
});

test('sequential jobs give a wall clock spanning both', () => {
  const d = runDurations([
    { createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:01:00Z', durationSeconds: 60 },
    { createdAt: '2026-07-01T00:01:00Z', updatedAt: '2026-07-01T00:03:00Z', durationSeconds: 120 },
  ]);
  assert.equal(d.wallClockSeconds, 180);
  assert.equal(d.jobTimeSeconds, 180);
});

test('unparsable or inverted timestamps produce 0, never NaN or a negative span', () => {
  const bad = runDurations([
    { createdAt: 'nope', updatedAt: 'nope', durationSeconds: 0 },
  ]);
  assert.equal(bad.wallClockSeconds, 0);
  assert.equal(bad.jobTimeSeconds, 0);
  const inverted = runDurations([
    { createdAt: '2026-07-01T00:05:00Z', updatedAt: '2026-07-01T00:00:00Z', durationSeconds: -9 },
  ]);
  assert.equal(inverted.wallClockSeconds, 0);
  assert.equal(inverted.jobTimeSeconds, 0, 'a negative job duration cannot shrink the sum');
});

// ---- completeness ----------------------------------------------------------

test('a status filter can never prove completeness', () => {
  // status=failed returns only failed JOBS, so a run row from it is partial by construction —
  // even if the server somehow claimed otherwise.
  assert.equal(
    windowComplete({ statusFiltered: true, nextCursor: null, serverComplete: true }),
    false,
  );
});

test('an unexhausted cursor makes every run in the window partial', () => {
  assert.equal(
    windowComplete({ statusFiltered: false, nextCursor: 'abc', serverComplete: true }),
    false,
  );
});

test('an exhausted unfiltered window follows the server verdict', () => {
  assert.equal(
    windowComplete({ statusFiltered: false, nextCursor: null, serverComplete: true }),
    true,
  );
  // Completeness is NOT inferable client-side: the server may know an index was truncated
  // upstream of the visibility filter even though the response came back short.
  assert.equal(
    windowComplete({ statusFiltered: false, nextCursor: null, serverComplete: false }),
    false,
  );
});

test('the merged view is complete only when no index truncated and nothing was sliced', () => {
  assert.equal(
    mergedResponseComplete({ anyIndexTruncated: false, visibleRows: 9, returnedRows: 9 }),
    true,
  );
  // A truncated per-status index hides jobs even when the VISIBLE union came back short —
  // the page can be filled by another tenant's rows, whose removal shortens the response
  // without proving this operator's siblings were all read.
  assert.equal(
    mergedResponseComplete({ anyIndexTruncated: true, visibleRows: 3, returnedRows: 3 }),
    false,
  );
  // The visible union itself overflowed `limit` and was sliced.
  assert.equal(
    mergedResponseComplete({ anyIndexTruncated: false, visibleRows: 80, returnedRows: 50 }),
    false,
  );
});

test('a repo page drops nothing, so its verdict ignores the cursor', () => {
  // `complete` answers "were rows dropped?", NOT "is the index exhausted?". Conflating the
  // two made a repo-filtered window permanently partial: the head page always carries an
  // open cursor while history remains, and the client ANDs the flag across loaded pages, so
  // paging to the end could never clear the badge.
  assert.equal(repoResponseComplete(false), true);
  // A status predicate on top of the repo index drops sibling jobs of a run.
  assert.equal(repoResponseComplete(true), false);
});

test('an exhausted repo window folds exactly, matching ADR-029', () => {
  // End-to-end of the two halves: server says nothing was dropped, client says the cursor is
  // spent ⇒ exact rollups. This is the case the old server verdict could never reach.
  assert.equal(
    windowComplete({
      statusFiltered: false,
      nextCursor: null,
      serverComplete: repoResponseComplete(false),
    }),
    true,
  );
  // Mid-walk the cursor still gates it.
  assert.equal(
    windowComplete({
      statusFiltered: false,
      nextCursor: 'c1',
      serverComplete: repoResponseComplete(false),
    }),
    false,
  );
});

// ---- grouping --------------------------------------------------------------

test('jobs group into run rows, newest run first, and carry the fold', () => {
  const rows = [
    job({ runId: 200, jobId: 1, createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T00:02:00Z', durationSeconds: 120, status: 'running', flavor: 'docker' }),
    job({ runId: 100, jobId: 1, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:01:00Z', durationSeconds: 60, status: 'completed' }),
    job({ runId: 100, jobId: 2, createdAt: '2026-07-01T00:00:30Z', updatedAt: '2026-07-01T00:03:00Z', durationSeconds: 150, status: 'failed', flavor: 'docker' }),
  ];
  const groups = groupRuns(rows, true);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].runId, 200, 'newest run first');
  assert.equal(groups[0].jobCount, 1);

  const run100 = groups[1];
  assert.equal(run100.key, runGroupKey(1, 100));
  assert.equal(run100.jobCount, 2);
  assert.equal(run100.status, 'failed');
  assert.equal(run100.flavor.label, 'docker +1');
  assert.equal(run100.durations.wallClockSeconds, 180);
  assert.equal(run100.durations.jobTimeSeconds, 210);
  assert.equal(run100.startedAt, '2026-07-01T00:00:00Z', 'earliest job start');
  assert.equal(run100.partial, false);
  assert.deepEqual(run100.jobs.map((j) => j.jobId), [2, 1], 'jobs newest first inside a run');
});

test('the same runId in two repos stays two run rows', () => {
  const groups = groupRuns(
    [job({ repoId: 1, runId: 7 }), job({ repoId: 2, repoFullName: 'acme/other', runId: 7 })],
    true,
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.key).sort(), ['1-7', '2-7']);
});

test('an incomplete window stamps every group partial', () => {
  const groups = groupRuns([job(), job({ runId: 101 })], false);
  assert.deepEqual(groups.map((g) => g.partial), [true, true]);
});

test('grouping an empty window yields no rows', () => {
  assert.deepEqual(groupRuns([], true), []);
});
