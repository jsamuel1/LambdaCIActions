import { useState } from 'react';
import { api, type RunStatus } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, StatusBadge, formatCost, formatDuration, formatTime } from '../components.js';

const STATUSES: RunStatus[] = ['queued', 'provisioning', 'running', 'completed', 'failed', 'timed_out'];

/** Runs — filterable run history (spec 04). Polls every 5 s so live runs advance in place. */
export function Runs({
  repoFilter,
  navigate,
}: {
  repoFilter?: number;
  navigate: (to: string) => void;
}): JSX.Element {
  const [status, setStatus] = useState<RunStatus | ''>('');
  const runs = useApi(
    () => api.runs({ repo: repoFilter, status: status || undefined, limit: 50 }),
    [repoFilter, status],
    5000,
  );

  if (runs.error) return <ErrorBox message={runs.error} />;

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
              {runs.data.runs.map((r) => (
                <tr
                  key={`${r.repoId}-${r.runId}-${r.jobId}`}
                  style={{ cursor: 'pointer' }}
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
              {!runs.data.runs.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    No runs match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
