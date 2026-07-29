import type { RunStatus } from '../shared/types.js';

/**
 * Run-level rollups for the Runs screen (spec 04 § Runs).
 *
 * The run store is **per job**: a row is keyed by the `(repoId, runId, jobId)` idempotency
 * triple (ADR-009) and every index (GSI1 status/time, GSI2 repo/time — ADR-023) pages over
 * job rows. The console shows a workflow RUN as the primary row, so the job rows have to be
 * folded client-side.
 *
 * That fold can lie: the API's cursor addresses an index PAGE, so a run's jobs can straddle
 * a page boundary and a rollup built from a partial job set would report a wrong duration
 * and a wrong status. Rather than guess, this module carries completeness explicitly, in two
 * halves: the server reports whether any row was DROPPED from a response
 * (`mergedResponseComplete` / `repoResponseComplete`), the client supplies index exhaustion,
 * and `windowComplete` combines them into "can the loaded window prove it holds every job of
 * every run in it". Each group is stamped `partial` when it cannot, and the UI renders a
 * partial rollup as a lower bound (`≥`), never as a fact. See ADR-029.
 *
 * Pure by construction (no AWS, no DOM) and shared by the API package and the SPA so the
 * fold rules are unit-tested once — `test/run-rollup.test.mjs`.
 */

/** The per-job fields a rollup needs. Structurally satisfied by `RunView` / the SPA's `Run`. */
export interface RunJobRow {
  repoId: number;
  repoFullName: string;
  runId: number;
  jobId: number;
  status: RunStatus;
  flavor?: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
}

/**
 * Status-fold precedence, highest first. Failure **dominates**: a run with one failed job
 * and one still running folds to `failed`, because the operator scanning this screen is
 * looking for breakage and the run's outcome is already decided (GitHub will not un-fail
 * it). Among non-failures the most advanced active status wins, so a run that is partly
 * queued and partly running reads as `running`. `completed` is last: it only surfaces when
 * every job completed.
 */
const FOLD_ORDER: RunStatus[] = [
  'failed',
  'timed_out',
  'running',
  'provisioning',
  'queued',
  'completed',
];

/** Fold a run's job statuses onto one run status. Empty input ⇒ `queued`. */
export function foldRunStatus(statuses: RunStatus[]): RunStatus {
  for (const candidate of FOLD_ORDER) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'queued';
}

export interface FlavorRollup {
  /** Display label: the single flavor, `node +2` when they differ, `—` when unknown. */
  label: string;
  /** Distinct flavor names, most frequent first (ties: alphabetical). */
  distinct: string[];
  mixed: boolean;
}

/**
 * Fold job flavors. One flavor ⇒ its name; several ⇒ `<most common> +<others>` so the row
 * stays scannable, with the full breakdown available on expand. Jobs with no flavor yet
 * (queued, never provisioned) are ignored rather than folded in as a pseudo-flavor.
 */
export function rollupFlavor(flavors: (string | undefined)[]): FlavorRollup {
  const counts = new Map<string, number>();
  for (const f of flavors) {
    if (!f) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const distinct = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  if (!distinct.length) return { label: '—', distinct: [], mixed: false };
  if (distinct.length === 1) return { label: distinct[0], distinct, mixed: false };
  return { label: `${distinct[0]} +${distinct.length - 1}`, distinct, mixed: true };
}

export interface RunDurations {
  /**
   * Earliest job queue → latest job transition. This is the human-visible "how long did the
   * run take", and the value the run row shows.
   */
  wallClockSeconds: number;
  /**
   * Sum of the per-job durations. Each of those is itself **queue → last transition**
   * (`durationSeconds` in `views.ts`), not billed microVM runtime — v1 stores no per-phase
   * timestamps (spec 04 OQ-5), so a job that sat queued for ten minutes contributes those
   * ten minutes here. It is therefore summed job wall-clock, an upper bound on compute, and
   * must NOT be labelled compute or used as a cost basis. It still answers a real question
   * (total job time across a run, which exceeds the run's own wall clock whenever jobs run in
   * parallel), so it is shown on expand under that name.
   */
  jobTimeSeconds: number;
}

/**
 * Both totals, because they answer different questions and differ a lot for parallel
 * matrices. Wall clock is derived from timestamps (not from summing) so parallelism cannot
 * inflate it; job time is the sum of the per-job durations the API already derives.
 */
export function runDurations(jobs: Pick<RunJobRow, 'createdAt' | 'updatedAt' | 'durationSeconds'>[]): RunDurations {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let jobTime = 0;
  for (const j of jobs) {
    jobTime += Math.max(0, j.durationSeconds);
    const start = Date.parse(j.createdAt);
    const end = Date.parse(j.updatedAt);
    if (Number.isFinite(start)) earliest = Math.min(earliest, start);
    if (Number.isFinite(end)) latest = Math.max(latest, end);
  }
  const span =
    Number.isFinite(earliest) && Number.isFinite(latest) && latest > earliest
      ? Math.round((latest - earliest) / 1000)
      : 0;
  return { wallClockSeconds: span, jobTimeSeconds: jobTime };
}

export interface RunGroup {
  /** Stable React key / expansion key. */
  key: string;
  repoId: number;
  repoFullName: string;
  runId: number;
  jobCount: number;
  status: RunStatus;
  flavor: FlavorRollup;
  durations: RunDurations;
  /** Earliest job `createdAt` in the group (ISO). */
  startedAt: string;
  /**
   * True when the loaded window cannot prove it holds every job of this run — the rollups
   * are then lower bounds and the UI must label them as such.
   */
  partial: boolean;
  jobs: RunJobRow[];
}

export interface WindowShape {
  /** A `status=` filter is active. */
  statusFiltered: boolean;
  /** The API's cursor for the next older page, `null` when the index is exhausted. */
  nextCursor: string | null;
  /**
   * The `complete` flag from every page the client loaded, ANDed. It answers a narrow
   * question — *did this response drop any job row that the client can never page back to?*
   * — and NOT "is the index exhausted", which is `nextCursor`'s job. Splitting the verdict
   * this way matters: a repo-filtered head page always has an open cursor while history
   * remains, so folding exhaustion into `complete` would leave such a window permanently
   * partial no matter how far the operator paged.
   *
   * The dropped-rows half cannot be derived client-side: the merged view queries each status
   * index for `limit` rows and only THEN applies the installation-visibility filter, so a
   * short response does not prove the indexes were not truncated. Only the server sees the
   * per-status cursors.
   */
  serverComplete: boolean;
}

/**
 * Can the loaded window prove completeness for every run inside it?
 *
 * - **status filter** ⇒ never. The index returns only jobs *in that status*, so a run row
 *   built from it is partial by construction (a failed job's sibling that passed is absent).
 *   The server also reports `complete: false` for these; this is belt-and-braces.
 * - **unexhausted cursor** ⇒ never. Older rows are unread, and a run's jobs are ordered by
 *   `createdAt`, not grouped, so any run in the window may continue past the boundary.
 *   Flagging only the run that owns the boundary row would be unsound: a straddling run's
 *   oldest LOADED job need not be the boundary row.
 * - otherwise the server's own verdict decides: no row was dropped on the way out
 *   (`mergedResponseComplete` for the merged view; unconditionally true for a repo-filtered
 *   page, which never slices).
 */
export function windowComplete(w: WindowShape): boolean {
  if (w.statusFiltered) return false;
  if (w.nextCursor !== null) return false;
  return w.serverComplete;
}

/**
 * Server-side completeness verdict for the unfiltered **merged** run view.
 *
 * That view queries every status index for `limit` rows, filters the union to the session's
 * installations, then slices to `limit`. It hands back no cursor, so a row dropped here is
 * unrecoverable. Two independent ways to lose a job:
 *  - an index page was truncated (`anyIndexTruncated`) — note this must be judged on the RAW
 *    index page, before the visibility filter, or a page filled with other tenants' rows
 *    reads as "short" while visible siblings sit unread past the boundary;
 *  - the visible union itself overflowed `limit` and was sliced (`returnedRows <
 *    visibleRows`).
 * Either one makes the response unable to prove it holds every job of every run it mentions.
 */
export function mergedResponseComplete(input: {
  anyIndexTruncated: boolean;
  visibleRows: number;
  returnedRows: number;
}): boolean {
  return !input.anyIndexTruncated && input.returnedRows === input.visibleRows;
}

/**
 * Server-side completeness verdict for a **repo-filtered** page (GSI2 repo/time).
 *
 * `collectVisible` never slices, so an unfiltered repo page drops nothing: every visible row
 * the query returned is in the response, and whatever lies past the boundary is reachable via
 * `nextCursor` — which is the CLIENT's half of the verdict (`windowComplete`). Folding index
 * exhaustion in here as well would make a repo-filtered window permanently partial, because
 * the head page always carries an open cursor while history remains and the client ANDs the
 * flag across every page it loads.
 *
 * A `status` predicate applied on top does drop sibling jobs, so it can never be complete.
 */
export function repoResponseComplete(statusFiltered: boolean): boolean {
  return !statusFiltered;
}

export function runGroupKey(repoId: number, runId: number): string {
  return `${repoId}-${runId}`;
}

/**
 * Group per-job rows into run rows, newest run first, jobs newest first inside a run.
 * `complete` comes from `windowComplete` and is stamped onto every group — grouping cannot
 * work it out for itself because it never sees the pagination state.
 */
export function groupRuns(rows: RunJobRow[], complete: boolean): RunGroup[] {
  const byRun = new Map<string, RunJobRow[]>();
  for (const row of rows) {
    const key = runGroupKey(row.repoId, row.runId);
    const bucket = byRun.get(key);
    if (bucket) bucket.push(row);
    else byRun.set(key, [row]);
  }
  const groups: RunGroup[] = [];
  for (const [key, jobs] of byRun) {
    const sorted = [...jobs].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.jobId - b.jobId,
    );
    const head = sorted[0];
    const durations = runDurations(sorted);
    groups.push({
      key,
      repoId: head.repoId,
      repoFullName: head.repoFullName,
      runId: head.runId,
      jobCount: sorted.length,
      status: foldRunStatus(sorted.map((j) => j.status)),
      flavor: rollupFlavor(sorted.map((j) => j.flavor)),
      durations,
      startedAt: sorted[sorted.length - 1].createdAt,
      partial: !complete,
      jobs: sorted,
    });
  }
  return groups.sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.runId - a.runId,
  );
}
