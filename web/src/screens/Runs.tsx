import { useEffect, useState } from 'react';
import { api, type Repo, type Run, type RunStatus } from '../api.js';
import { useApi } from '../hooks.js';
import { durationLabel, flavorLabel, groupRuns, headSeamIntact, jobRowKey, noSeam, seamAfterHop, startedAtLabel, windowComplete, type RunGroup, type SeamState } from '../rollup.js';
import {
  Badge,
  CopyId,
  ErrorBox,
  Loading,
  StatusBadge,
  formatDuration,
  formatTime,
} from '../components.js';

const STATUSES: RunStatus[] = ['queued', 'provisioning', 'running', 'completed', 'failed', 'timed_out'];
const PAGE = 50;
const COLS = 6;

/**
 * Duration with a lower-bound marker on a partial window. The bound rule itself lives in the
 * tested rollup module (`durationLabel`) alongside its `flavorLabel` / `startedAtLabel`
 * siblings; this only supplies the locale/format half.
 */
function lowerBound(seconds: number, partial: boolean): string {
  return durationLabel(seconds, formatDuration(seconds), partial);
}

/**
 * Runs — run-primary history (spec 04 § Runs). The store is per JOB, so job rows are folded
 * into run rows by `src/mgmt/run-rollup.ts` (fold rules + partial semantics: ADR-029) and
 * expanded on demand.
 *
 * The head page polls every 5 s so live runs advance in place; expansion is component state
 * keyed by `repoId-runId`, so a poll never collapses an open run. "Load older" walks the
 * API's opaque cursor (ADR-021) and appends — deeper paging requires a repo or status filter,
 * because the unfiltered merged view has no coherent cursor.
 *
 * Cost is deliberately absent: a per-run cost total belongs on a Reports screen with a time
 * window and grouping, not on a history list (`formatCost` / `flavorRatePerMinute` stay).
 */
export function Runs({
  repoFilter,
  installations,
  navigate,
}: {
  repoFilter?: number;
  installations: { installationId: number; accountLogin: string }[];
  navigate: (to: string) => void;
}): JSX.Element {
  const [status, setStatus] = useState<RunStatus | ''>('');
  const runs = useApi(
    () => api.runs({ repo: repoFilter, status: status || undefined, limit: PAGE }),
    [repoFilter, status],
    5000,
  );
  const [older, setOlder] = useState<Run[]>([]);
  /**
   * Completeness of the appended older pages, ANDed. A single incomplete page poisons the
   * whole window: its unread siblings could belong to any run on screen.
   */
  const [olderComplete, setOlderComplete] = useState(true);
  /**
   * Older-pages cursor. THREE states, not two: `undefined` = no older page loaded yet
   * (fall back to the head page's cursor), a string = resume here, `null` = the index is
   * exhausted. Conflating `null` with `undefined` would make an exhausted history fall
   * back to the head cursor — the button would never disappear and clicking it would
   * re-walk the same pages forever.
   */
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  /**
   * Head/older seam bookkeeping: whether a cursor has been walked off the live head page,
   * and the key of the head row that sat directly above the first older row when it was.
   * The head page is re-polled every 5 s while the older pages stay in state, and GSI2 is
   * sorted by the immutable `createdAt`, so a newly queued job pushes a row off the bottom
   * of the head page into a gap the older pages do not cover. While the boundary key is
   * still in the head page the two halves are adjacent; once it is gone the window has a
   * hole and its rollups are only bounds (`headSeamIntact`). Tracked per HOP rather than by
   * appended row count: a hop can append nothing and still advance the cursor.
   */
  const [seam, setSeam] = useState<SeamState>(noSeam);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreErr, setMoreErr] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // A filter change invalidates every appended page and its cursor.
  useEffect(() => {
    setOlder([]);
    setOlderComplete(true);
    setCursor(undefined);
    setSeam(noSeam);
    setMoreErr(undefined);
  }, [repoFilter, status]);

  if (runs.error) return <ErrorBox message={runs.error} />;

  const headCursor = runs.data?.nextCursor ?? null;
  const nextCursor = cursor === undefined ? headCursor : cursor;
  const headRows = runs.data?.runs ?? [];
  const seen = new Set<string>();
  const rows = [...headRows, ...older].filter((r) => {
    const key = jobRowKey(r.repoId, r.runId, r.jobId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Whether the loaded window can prove it holds every job of every run in it. The verdict
  // comes from the SERVER (`complete`): truncation is judged on the raw index pages, before
  // the installation-visibility filter, so a short response proves nothing client-side. When
  // the window cannot prove completeness, each run row is labelled `partial` and its rollups
  // read as lower bounds — a wrong duration/status shown as fact is worse than no rollup
  // (ADR-029).
  const complete = windowComplete({
    statusFiltered: status !== '',
    nextCursor,
    // The polled head page and the held older pages are snapshots taken at different times,
    // so their join can silently lose a row when new jobs are queued.
    seamIntact: headSeamIntact({
      boundaryKey: seam.boundaryKey,
      headKeys: headRows.map((r) => jobRowKey(r.repoId, r.runId, r.jobId)),
      pagedPastHead: seam.pagedPastHead,
    }),
    // Absent `complete` (older API) ⇒ false: partial is the safe default. `olderComplete`
    // ANDs every appended page, since one page that dropped rows poisons the whole window.
    serverComplete: (runs.data?.complete ?? false) && olderComplete,
  });
  const groups = groupRuns(rows, complete);

  async function loadOlder(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreErr(undefined);
    // The boundary must come from the SAME head snapshot the cursor was read from, so it is
    // captured before the await rather than from whatever the 5 s poll has replaced it with
    // by the time the response lands. `seamAfterHop` keeps the first hop's value.
    const last = headRows[headRows.length - 1];
    const headTailKey = last ? jobRowKey(last.repoId, last.runId, last.jobId) : undefined;
    try {
      const page = await api.runs({
        repo: repoFilter,
        status: status || undefined,
        limit: PAGE,
        cursor: nextCursor,
      });
      // Every hop that moved the cursor counts, including one that appended no rows: a repo
      // page can come back empty with a live cursor when `collectVisible` walked its page
      // budget through other tenants' rows, and the head page is no longer adjacent to the
      // resume point either way.
      setSeam((prev) => seamAfterHop(prev, headTailKey));
      setOlder((prev) => [...prev, ...page.runs]);
      setOlderComplete((prev) => prev && (page.complete ?? false));
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <RepoPicker installations={installations} repoFilter={repoFilter} navigate={navigate} />
          <label className="muted" htmlFor="status">
            Status
          </label>
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value as RunStatus | '')}>
            <option value="">all (active first)</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button onClick={runs.reload}>Refresh</button>
        </div>
        {status !== '' && (
          <p className="muted gap-top tight">
            A status filter selects <em>jobs</em>, so each run below shows only its {status} jobs —
            rollups are marked partial. Clear the status filter for whole-run rollups.
          </p>
        )}
      </div>

      <div className="card">
        {!runs.data ? (
          <Loading what="runs" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Run</th>
                <th>Status</th>
                <th>Flavor</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <RunRows
                  key={g.key}
                  group={g}
                  open={expanded.has(g.key)}
                  onToggle={() => toggle(g.key)}
                  navigate={navigate}
                />
              ))}
              {!groups.length && (
                <tr>
                  <td colSpan={COLS} className="muted">
                    No runs match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {moreErr && <p className="error">{moreErr}</p>}
        <div className="row gap-top">
          {nextCursor && (
            <button onClick={() => void loadOlder()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older'}
            </button>
          )}
          <span className="muted">
            {groups.length} run{groups.length === 1 ? '' : 's'} · {rows.length} job
            {rows.length === 1 ? '' : 's'} shown
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One run row plus its job rows when expanded. Clicking the run row toggles expansion
 * (a run has no detail route of its own — the detail route is per job); clicking a job row
 * opens that job's detail.
 */
function RunRows({
  group,
  open,
  onToggle,
  navigate,
}: {
  group: RunGroup;
  open: boolean;
  onToggle: () => void;
  navigate: (to: string) => void;
}): JSX.Element {
  const { durations } = group;
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td>{group.repoFullName}</td>
        <td>
          <span className="row">
            <button
              type="button"
              className="expander"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} jobs for run ${group.runId}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
            >
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
            <Badge kind="queued">
              {group.partial ? '≥ ' : ''}
              {group.jobCount} job{group.jobCount === 1 ? '' : 's'}
            </Badge>
            <CopyId label="run id" value={String(group.runId)} />
          </span>
        </td>
        <td>
          <span className="row">
            <StatusBadge status={group.status} />
            {group.partial && (
              <span
                className="badge warn"
                title="Some of this run's jobs are outside the loaded window — excluded by the status filter, past the page boundary, or lost where the live head page has shifted past the older pages. Status, flavor, job count and totals are lower bounds; the start time is an upper bound (an unread job may have been queued earlier)."
              >
                partial
              </span>
            )}
          </span>
        </td>
        <td>{flavorLabel(group.flavor, group.partial)}</td>
        <td>{lowerBound(durations.wallClockSeconds, group.partial)}</td>
        <td>{startedAtLabel(group.startedAt, formatTime(group.startedAt), group.partial)}</td>
      </tr>
      {open && (
        <>
          <tr className="jobrow">
            <td className="jobs-head">
              {group.flavor.mixed
                ? `flavors: ${group.flavor.distinct.join(', ')}${group.partial ? ' (loaded jobs)' : ''}`
                : 'jobs'}
            </td>
            <td className="jobs-head" colSpan={COLS - 1}>
              wall clock {lowerBound(durations.wallClockSeconds, group.partial)} · job time{' '}
              {lowerBound(durations.jobTimeSeconds, group.partial)}
              {group.partial ? ' (lower bounds)' : ''}
            </td>
          </tr>
          {group.jobs.map((j) => (
            <tr
              key={j.jobId}
              className="jobrow clickable"
              onClick={() => navigate(`/runs/${j.repoId}/${j.runId}/${j.jobId}`)}
            >
              <td className="muted">job</td>
              <td>
                <CopyId label="job id" value={String(j.jobId)} />
              </td>
              <td>
                <StatusBadge status={j.status} />
              </td>
              <td>{j.flavor ?? '—'}</td>
              <td>{formatDuration(j.durationSeconds)}</td>
              <td>{formatTime(j.createdAt)}</td>
            </tr>
          ))}
        </>
      )}
    </>
  );
}

/**
 * In-screen repo filter. `GET /api/repos` is installation-scoped, so the picker fans out
 * over the session's installations client-side rather than adding an aggregated repos read
 * (ADR-029). The selection lives in the URL
 * (`#/runs?repo=<id>`), so a filtered view stays shareable and the Repo-detail deep link
 * into `/runs?repo=` keeps working unchanged.
 */
function RepoPicker({
  installations,
  repoFilter,
  navigate,
}: {
  installations: { installationId: number; accountLogin: string }[];
  repoFilter?: number;
  navigate: (to: string) => void;
}): JSX.Element {
  const ids = installations.map((i) => i.installationId).join(',');
  const repos = useApi(
    async () => {
      const pages = await Promise.all(
        installations.map((i) =>
          // One installation failing (revoked grant mid-session) must not blank the picker.
          api.repos(i.installationId).catch(() => ({ repos: [] as Repo[] })),
        ),
      );
      return pages
        .flatMap((p) => p.repos)
        .sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
    },
    [ids],
  );

  const known = repos.data?.some((r) => r.repoId === repoFilter) ?? false;
  return (
    <>
      <label className="muted" htmlFor="repo">
        Repo
      </label>
      <select
        id="repo"
        value={repoFilter ?? ''}
        disabled={!repos.data}
        onChange={(e) => navigate(e.target.value ? `/runs?repo=${e.target.value}` : '/runs')}
      >
        <option value="">all repos</option>
        {/*
          A deep link can carry a repo the picker has not loaded (or one the operator can no
          longer admin). Keep it selectable rather than silently resetting the filter.
        */}
        {repoFilter !== undefined && !known && <option value={repoFilter}>#{repoFilter}</option>}
        {(repos.data ?? []).map((r) => (
          <option key={r.repoId} value={r.repoId}>
            {r.repoFullName}
          </option>
        ))}
      </select>
      {repoFilter !== undefined && <button onClick={() => navigate('/runs')}>Clear</button>}
    </>
  );
}
