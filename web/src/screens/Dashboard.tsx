import { api, type Repo } from '../api.js';
import { useApi } from '../hooks.js';
import {
  CompatRollupView,
  ErrorBox,
  Loading,
  StatusBadge,
  Stat,
  formatCost,
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
        <Stat label="Est. spend" value={formatCost(h.cost?.totalUsd)} />
        {/*
          Unclaimed is a THIRD axis, not a run status (ADR-050): a refused job never launched, so it
          contributes nothing to Active, Error rate or spend. Shown here because it is the one
          failure a user reports as "my PR is stuck" and which produces no run row to click.
          Windowed (see `unclaimedWindowDays`) — refusal rows are retained for 90 days, and a stat
          that can never return to zero is one an operator stops reading.
        */}
        <Stat
          label={
            h.unclaimedWindowDays ? `Unclaimed (${h.unclaimedWindowDays}d)` : 'Unclaimed'
          }
          value={
            h.unclaimed === undefined
              ? '—'
              : `${h.unclaimedExact === false ? '≥ ' : ''}${h.unclaimed}`
          }
        />
      </div>
      {(h.unclaimed ?? 0) > 0 && (
        <p className="error">
          {h.unclaimed} job{h.unclaimed === 1 ? '' : 's'} were refused
          {h.unclaimedWindowDays ? ` in the last ${h.unclaimedWindowDays} days` : ''} and did not run
          anywhere on this platform — <a href="#/unclaimed">see why</a>.
        </p>
      )}
      {h.countsExact === false && (
        <p className="muted">
          Run counts are a lower bound — history in at least one status exceeds the count paging
          budget.
        </p>
      )}
      <p className="muted">
        Counts are platform-wide; run lists and stuck runs are scoped to your installations.
      </p>

      {h.cost && (
        <div className="card">
          <h2>Cost estimate</h2>
          <p className="muted">
            Estimated microVM spend over the {h.cost.jobs} most recent finished job(s) in your
            installations that actually launched a VM — wall-clock minutes × flavor rate, so an
            upper bound. Counted per JOB, not per workflow run: a matrix workflow contributes
            one row per variant. A sample, not a complete window, and not a billing report: use
            Cost Explorer for actuals.
          </p>
          <table>
            <thead>
              <tr>
                <th>Flavor</th>
                <th>Jobs</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(h.cost.byFlavor).map(([flavor, b]) => (
                <tr key={flavor}>
                  <td>{flavor}</td>
                  <td>{b.jobs}</td>
                  <td>{formatCost(b.usd)}</td>
                </tr>
              ))}
              {!Object.keys(h.cost.byFlavor).length && (
                <tr>
                  <td colSpan={3} className="muted">
                    No finished jobs to price yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="muted">Mean per job: {formatCost(h.cost.avgUsd)}</p>
        </div>
      )}

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
            <td>{formatTime(r.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export { RunTable };
export { CompatRollupView };
