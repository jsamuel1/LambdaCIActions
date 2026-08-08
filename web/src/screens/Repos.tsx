import { useState } from 'react';
import { api, type Repo } from '../api.js';
import { useApi } from '../hooks.js';
import { CompatRollupView, ErrorBox, Loading, formatTime } from '../components.js';

/**
 * Repos — list the repos granted to the selected installation; enable/disable and set
 * onboarding mode + default flavor. Config writes are audited server-side with the
 * operator's login (spec 04 § auditability).
 */
export function Repos({
  installationId,
  navigate,
}: {
  installationId?: number;
  navigate: (to: string) => void;
}): JSX.Element {
  const repos = useApi(
    () => (installationId ? api.repos(installationId) : Promise.resolve({ repos: [] })),
    [installationId],
  );
  const flavors = useApi(() => api.flavors(), []);
  const [busy, setBusy] = useState<number | undefined>(undefined);
  const [err, setErr] = useState<string | undefined>(undefined);

  if (!installationId) return <ErrorBox message="Select an installation first." />;
  if (repos.error) return <ErrorBox message={repos.error} />;
  if (!repos.data) return <Loading what="repos" />;

  async function patch(repo: Repo, patchBody: Record<string, unknown>): Promise<void> {
    setBusy(repo.repoId);
    setErr(undefined);
    try {
      await api.patchRepo(repo.installationId, repo.repoId, patchBody);
      repos.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="stack">
      {err && <ErrorBox message={err} />}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Repository</th>
              <th>Enabled</th>
              <th>Mode</th>
              <th>Default flavor</th>
              <th>Compat</th>
              <th>Last change</th>
            </tr>
          </thead>
          <tbody>
            {repos.data.repos.map((r) => (
              <tr key={r.repoId}>
                <td>
                  <a href={`#/repos/${r.repoId}`} onClick={() => navigate(`/repos/${r.repoId}`)}>
                    {r.repoFullName}
                  </a>
                </td>
                <td>
                  <button
                    disabled={busy === r.repoId}
                    onClick={() => patch(r, { enabled: !r.enabled })}
                  >
                    {r.enabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
                <td>
                  <select
                    value={r.mode}
                    disabled={busy === r.repoId}
                    onChange={(e) => patch(r, { mode: e.target.value })}
                  >
                    <option value="label">label</option>
                    <option value="adopt">adopt</option>
                    <option value="off">off</option>
                  </select>
                </td>
                <td>
                  <select
                    value={r.defaultFlavor ?? ''}
                    disabled={busy === r.repoId || !flavors.data}
                    onChange={(e) =>
                      // Empty selection clears the override (API accepts null → REMOVE).
                      patch(r, { defaultFlavor: e.target.value === '' ? null : e.target.value })
                    }
                  >
                    <option value="">(catalog default)</option>
                    {(flavors.data?.flavors ?? []).map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <CompatRollupView roll={r.compat} />
                </td>
                <td className="muted">
                  {formatTime(r.updatedAt)}
                  {r.updatedBy ? ` · ${r.updatedBy}` : ''}
                </td>
              </tr>
            ))}
            {!repos.data.repos.length && (
              <tr>
                <td colSpan={6} className="muted">
                  No repos granted to this installation yet. Add repositories to the GitHub App
                  installation, then reload.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Disabling a repo (or setting mode <code>off</code>) stops LambdaCIActions claiming its jobs
        — GitHub runs them on its own runners instead. <code>adopt</code> mode claims jobs that use
        standard GitHub-hosted labels (<code>ubuntu-latest</code> and friends) with no YAML edits;
        those runners are <strong>arm64 only</strong>, so check each repo's compatibility findings
        before switching it on.
      </p>
    </div>
  );
}
