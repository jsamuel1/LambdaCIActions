import { api, type Repo } from '../api.js';
import { useApi } from '../hooks.js';
import {
  CompatRollupView,
  ErrorBox,
  Loading,
  StatusBadge,
  Stat,
  formatDuration,
  formatTime,
} from '../components.js';

/**
 * Dashboard — platform health at a glance (spec 04 Screens). Polls every 5 s while the tab
 * is visible; polling is the v1 live-update mechanism (ADR-026).
 */
export function Dashboard({
  installationId,
  navigate,
}: {
  installationId?: number;
  navigate: (to: string) => void;
}): JSX.Element {
  const health = useApi(() => api.health(), [], 5000);
  const runs = useApi(() => api.runs({ limit: 15 }), [], 5000);
  const repos = useApi<{ repos: Repo[] }>(
    () => (installationId ? api.repos(installationId) : Promise.resolve({ repos: [] })),
    [installationId],
  );

  if (health.error) return <ErrorBox message={health.error} />;
  if (!health.data) return <Loading what="health" />;

  const h = health.data;
  const enabled = (repos.data?.repos ?? []).filter((r) => r.enabled).length;

  return (
    <div className="stack">
      <div className="grid">
        <Stat label="Active" value={h.active} />
        <Stat label="Queued" value={h.counts.queued} />
        <Stat label="Running" value={h.counts.running} />
        <Stat label="Error rate" value={`${Math.round(h.errorRate * 100)}%`} />
        <Stat label="Repos enabled" value={enabled} />
      </div>

      {h.stuck.length > 0 && (
        <div className="card">
          <h2>Stuck runs ({h.stuck.length})</h2>
          <p className="muted">
            Non-terminal for more than 15 minutes — the Reaper should have swept these.
          </p>
          <RunTable runs={h.stuck} navigate={navigate} />
        </div>
      )}

      <div className="card">
        <h2>Recent runs</h2>
        {runs.error && <p className="error">{runs.error}</p>}
        {runs.data ? (
          <RunTable runs={runs.data.runs} navigate={navigate} />
        ) : (
          <Loading what="runs" />
        )}
      </div>
    </div>
  );
}

function RunTable({
  runs,
  navigate,
}: {
  runs: { repoId: number; runId: number; jobId: number; repoFullName: string; status: 'queued' | 'provisioning' | 'running' | 'completed' | 'failed' | 'timed_out'; flavor?: string; durationSeconds: number; createdAt: string }[];
  navigate: (to: string) => void;
}): JSX.Element {
  if (!runs.length) return <p className="muted">No runs yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Repo</th>
          <th>Run / job</th>
          <th>Status</th>
          <th>Flavor</th>
          <th>Duration</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
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
            <td>{formatTime(r.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export { RunTable };
export { CompatRollupView };
