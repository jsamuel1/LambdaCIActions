import { useEffect, useState } from 'react';
import { api, type Run, type RunStatus } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, StatusBadge, formatCost, formatDuration, formatTime } from '../components.js';

const STATUSES: RunStatus[] = ['queued', 'provisioning', 'running', 'completed', 'failed', 'timed_out'];
const PAGE = 50;

/**
 * Runs — filterable run history (spec 04). The head page polls every 5 s so live runs advance
 * in place; "Load older" walks the API's opaque cursor (ADR-023) and appends, so history is
 * not capped at one page. Deeper paging requires a repo or status filter — the unfiltered
 * merged view has no coherent cursor, so the button is hidden there.
 */
export function Runs({
  repoFilter,
  navigate,
}: {
  repoFilter?: number;
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
   * Older-pages cursor. THREE states, not two: `undefined` = no older page loaded yet
   * (fall back to the head page's cursor), a string = resume here, `null` = the index is
   * exhausted. Conflating `null` with `undefined` would make an exhausted history fall
   * back to the head cursor — the button would never disappear and clicking it would
   * re-walk the same pages forever.
   */
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreErr, setMoreErr] = useState<string | undefined>(undefined);

  // A filter change invalidates every appended page and its cursor.
  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
    setMoreErr(undefined);
  }, [repoFilter, status]);

  if (runs.error) return <ErrorBox message={runs.error} />;

  const headCursor = runs.data?.nextCursor ?? null;
  const nextCursor = cursor === undefined ? headCursor : cursor;
  const seen = new Set<string>();
  const rows = [...(runs.data?.runs ?? []), ...older].filter((r) => {
    const key = `${r.repoId}-${r.runId}-${r.jobId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  async function loadOlder(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreErr(undefined);
    try {
      const page = await api.runs({
        repo: repoFilter,
        status: status || undefined,
        limit: PAGE,
        cursor: nextCursor,
      });
      setOlder((prev) => [...prev, ...page.runs]);
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
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
          {repoFilter && (
            <>
              <span className="muted">repo #{repoFilter}</span>
              <button onClick={() => navigate('/runs')}>Clear repo filter</button>
            </>
          )}
          <button onClick={runs.reload}>Refresh</button>
        </div>
      </div>

      <div className="card">
        {!runs.data ? (
          <Loading what="runs" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Run / job</th>
                <th>Status</th>
                <th>Flavor</th>
                <th>Duration</th>
                <th>Est. cost</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.repoId}-${r.runId}-${r.jobId}`}
                  className="clickable"
                  onClick={() => navigate(`/runs/${r.repoId}/${r.runId}/${r.jobId}`)}
                >
                  <td>{r.repoFullName}</td>
                  <td>
                    {r.runId} / {r.jobId}
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>{r.flavor ?? '—'}</td>
                  <td>{formatDuration(r.durationSeconds)}</td>
                  <td>{formatCost(r.costUsd)}</td>
                  <td>{formatTime(r.createdAt)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    No runs match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {moreErr && <p className="error">{moreErr}</p>}
        {nextCursor && (
          <div className="row">
            <button onClick={() => void loadOlder()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older'}
            </button>
            <span className="muted">{rows.length} shown</span>
          </div>
        )}
      </div>
    </div>
  );
}
