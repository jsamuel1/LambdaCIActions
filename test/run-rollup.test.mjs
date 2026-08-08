// Unit tests for the pure run-level rollup/fold helpers used by the Runs screen
// (src/mgmt/run-rollup.ts). These are the rules an operator reads as fact, so the fold
// precedence, the two duration totals, and the partial/completeness rule are all pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldRunStatus,
  rollupFlavor,
  flavorLabel,
  startedAtLabel,
  durationLabel,
  runDurations,
  windowComplete,
  headSeamIntact,
  seamAfterHop,
  noSeam,
  jobRowKey,
  pageQueryKey,
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

test('a partial window cannot claim the jobs agree on a flavor', () => {
  // The run row is the one place a bare flavor name reads as "every job used this". On a
  // partial window an unread job may use a flavor the loaded jobs never mention, so a single
  // flavor weakens to `+?` and a mixed count to `+2?` rather than being stated as fact.
  const single = rollupFlavor(['node', 'node']);
  assert.equal(flavorLabel(single, false), 'node');
  assert.equal(flavorLabel(single, true), 'node +?');

  const mixed = rollupFlavor(['node', 'docker', 'node']);
  assert.equal(flavorLabel(mixed, false), 'node +1');
  assert.equal(flavorLabel(mixed, true), 'node +1?');

  // Nothing known stays an em dash either way — `— +?` would be nonsense.
  const none = rollupFlavor([undefined]);
  assert.equal(flavorLabel(none, false), '—');
  assert.equal(flavorLabel(none, true), '—');
});

// ---- start time ------------------------------------------------------------

test('a partial window renders the start time as an upper bound', () => {
  // `startedAt` is the earliest LOADED job, so an unread sibling may have been queued
  // earlier: the run started at or BEFORE the figure shown. This is the mirror of the
  // duration/job-count lower bounds, and the one other run-row value that would otherwise
  // read as fact.
  assert.equal(startedAtLabel('2026-07-01T00:00:00Z', '01/07/2026, 00:00', false), '01/07/2026, 00:00');
  assert.equal(startedAtLabel('2026-07-01T00:00:00Z', '01/07/2026, 00:00', true), '≤ 01/07/2026, 00:00');
});

test('an unparsable start time keeps its raw text on a partial window', () => {
  // `formatTime` echoes an unparsable ISO string verbatim, and `≤ <garbage>` would claim an
  // ordering against a value that has none.
  assert.equal(startedAtLabel('nope', 'nope', true), 'nope');
  assert.equal(startedAtLabel('', '', true), '');
});

// ---- durations -------------------------------------------------------------

test('a partial window renders a duration as a lower bound', () => {
  // Both totals fold only the LOADED jobs, so an unread sibling can only widen the span and
  // raise the sum: the figure shown is a floor.
  assert.equal(durationLabel(250, '4m 10s', false), '4m 10s');
  assert.equal(durationLabel(250, '4m 10s', true), '≥ 4m 10s');
});

test('a zero/unknown duration keeps its em dash even on a partial window', () => {
  // `formatDuration(0)` is an em dash and `≥ —` reads as "at least unknown". A run whose jobs
  // are all still queued has no elapsed span yet, partial or not.
  assert.equal(durationLabel(0, '—', true), '—');
  assert.equal(durationLabel(0, '—', false), '—');
  // A negative can only arrive from a corrupt row; it must not acquire a bound marker either.
  assert.equal(durationLabel(-5, '—', true), '—');
});

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
    windowComplete({
      statusFiltered: true,
      nextCursor: null,
      seamIntact: true,
      serverComplete: true,
    }),
    false,
  );
});

test('an unexhausted cursor makes every run in the window partial', () => {
  assert.equal(
    windowComplete({
      statusFiltered: false,
      nextCursor: 'abc',
      seamIntact: true,
      serverComplete: true,
    }),
    false,
  );
});

test('an exhausted unfiltered window follows the server verdict', () => {
  assert.equal(
    windowComplete({
      statusFiltered: false,
      nextCursor: null,
      seamIntact: true,
      serverComplete: true,
    }),
    true,
  );
  // Completeness is NOT inferable client-side: the server may know an index was truncated
  // upstream of the visibility filter even though the response came back short.
  assert.equal(
    windowComplete({
      statusFiltered: false,
      nextCursor: null,
      seamIntact: true,
      serverComplete: false,
    }),
    false,
  );
});

test('a drifted head/older seam makes an otherwise-exact window partial', () => {
  // Every other signal says exact — cursor spent, server dropped nothing — but the loaded
  // window has a hole where the polled head page shifted past the held older pages.
  assert.equal(
    windowComplete({
      statusFiltered: false,
      nextCursor: null,
      seamIntact: false,
      serverComplete: true,
    }),
    false,
  );
});

test('the head/older seam holds only while the boundary row is still on the head page', () => {
  // Never paged past the head page ⇒ no seam to break, whatever the head page looks like.
  assert.equal(headSeamIntact({ headKeys: [], pagedPastHead: false }), true);
  assert.equal(
    headSeamIntact({ boundaryKey: undefined, headKeys: ['1-1-1'], pagedPastHead: false }),
    true,
  );

  // The boundary row (the head row directly above older[0]) is still loaded ⇒ adjacent.
  assert.equal(
    headSeamIntact({ boundaryKey: '1-100-2', headKeys: ['1-101-1', '1-100-2'], pagedPastHead: true }),
    true,
  );

  // A newly queued job pushed the boundary row off the fixed-size head page: the row is in
  // neither half, so the window has a gap in the middle.
  assert.equal(
    headSeamIntact({ boundaryKey: '1-100-2', headKeys: ['1-102-1', '1-101-1'], pagedPastHead: true }),
    false,
  );

  // Paged past the head page but no boundary recorded ⇒ adjacency cannot be shown.
  assert.equal(
    headSeamIntact({ boundaryKey: undefined, headKeys: ['1-101-1'], pagedPastHead: true }),
    false,
  );
});

test('a hop that appends no rows still arms the seam', () => {
  // `collectVisible` can spend its page budget on other tenants' rows and hand back an empty
  // page WITH a live cursor. Keying the seam off appended rows would leave that hop
  // invisible: the boundary would then be recorded on the next hop, against a head snapshot
  // the 5 s poll has already moved on, and a window with a real hole would read as exact.
  const armed = seamAfterHop(noSeam, '1-100-2');
  assert.equal(armed.pagedPastHead, true);
  assert.equal(armed.boundaryKey, '1-100-2');
  assert.equal(
    headSeamIntact({ ...armed, headKeys: ['1-102-1', '1-101-1'] }),
    false,
    'the empty hop is still watched, so a shifted head page is caught',
  );
});

test('the boundary is captured on the first hop and never re-recorded', () => {
  // Later pages chain off stable index-position cursors, so the seam that can drift is the
  // FIRST one. Re-recording it from a later (fresher) head snapshot would silently repair a
  // window that really has a hole.
  const first = seamAfterHop(noSeam, '1-100-2');
  const second = seamAfterHop(first, '1-090-1');
  assert.equal(second, first, 'same object: a later hop is a no-op');
  assert.equal(second.boundaryKey, '1-100-2');
});

test('an empty head page at the first hop cannot prove adjacency', () => {
  // No head row to anchor the seam to ⇒ unprovable, so the window stays partial rather than
  // defaulting to exact.
  const armed = seamAfterHop(noSeam, undefined);
  assert.equal(armed.pagedPastHead, true);
  assert.equal(armed.boundaryKey, undefined);
  assert.equal(headSeamIntact({ ...armed, headKeys: ['1-101-1'] }), false);
});

test('noSeam is the untouched state: nothing paged, nothing to check', () => {
  assert.equal(noSeam.pagedPastHead, false);
  assert.equal(noSeam.boundaryKey, undefined);
  assert.equal(headSeamIntact({ ...noSeam, headKeys: ['1-101-1'] }), true);
});

test('jobRowKey identifies the idempotency triple', () => {
  assert.equal(jobRowKey(1, 100, 2), '1-100-2');
  // Distinct triples never collide into one key (row de-dup + seam identity depend on it).
  assert.notEqual(jobRowKey(1, 100, 2), jobRowKey(1, 1002, 0));
});

test('a paged read is identified by the filter it was requested under', () => {
  // A "Load older" response that lands after the operator changed the filter must be
  // discarded, or it appends the old repo's jobs and the old index's cursor into the new
  // window. The screen compares this key at request time against the live one on arrival.
  assert.equal(pageQueryKey(7, ''), pageQueryKey(7, ''));
  assert.notEqual(pageQueryKey(7, ''), pageQueryKey(8, ''));
  assert.notEqual(pageQueryKey(7, ''), pageQueryKey(undefined, ''));
  assert.notEqual(pageQueryKey(7, ''), pageQueryKey(7, 'failed'));
  assert.notEqual(pageQueryKey(undefined, 'failed'), pageQueryKey(undefined, 'completed'));
});

test('a repo id cannot be confused with a status by the window key', () => {
  // The separator must not be producible by either half, or two different filters could
  // share a key and a stale page would be applied as if it belonged.
  assert.notEqual(pageQueryKey(1, 'queued'), pageQueryKey(undefined, '1|queued'));
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
      seamIntact: true,
      serverComplete: repoResponseComplete(false),
    }),
    true,
  );
  // Mid-walk the cursor still gates it.
  assert.equal(
    windowComplete({
      statusFiltered: false,
      nextCursor: 'c1',
      seamIntact: true,
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
