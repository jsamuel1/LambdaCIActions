import { useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { CompatBadge, CompatRollupView, ErrorBox, Loading, formatTime } from '../components.js';

/**
 * Repo detail — the parsed workflow table (jobs → runs-on → resolved flavor → compat) plus
 * the flavor-override editor and a manual re-scan trigger (spec 04 wireframe).
 */
export function RepoDetail({
  installationId,
  repoId,
  navigate,
}: {
  installationId?: number;
  repoId: number;
  navigate: (to: string) => void;
}): JSX.Element {
  const wf = useApi(
    () =>
      installationId
        ? api.workflows(installationId, repoId)
        : Promise.reject(new Error('no installation selected')),
    [installationId, repoId],
  );
  const flavors = useApi(() => api.flavors(), []);
  const [msg, setMsg] = useState<string | undefined>(undefined);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Record<string, string> | undefined>(undefined);
  const [newLabel, setNewLabel] = useState('');

  if (wf.error) return <ErrorBox message={wf.error} />;
  if (!wf.data) return <Loading what="workflows" />;

  const repo = wf.data.repo;
  const map = draft ?? repo.flavorMap;

  async function saveMap(next: Record<string, string>): Promise<void> {
    setErr(undefined);
    try {
      await api.putFlavorMap(repo.installationId, repo.repoId, next);
      setDraft(undefined);
      setMsg('Flavor overrides saved.');
      wf.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function rescan(): Promise<void> {
    setErr(undefined);
    try {
      await api.rescan(repo.installationId, repo.repoId);
      setMsg('Re-scan queued — workflows refresh within a minute.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>{repo.repoFullName}</h2>
          <CompatRollupView roll={wf.data.compat} />
          <span className="spacer" style={{ flex: 1 }} />
          <button onClick={rescan}>Re-scan</button>
          <button onClick={() => navigate(`/runs?repo=${repo.repoId}`)}>Runs</button>
        </div>
        <p className="muted">
          mode: {repo.mode} · enabled: {String(repo.enabled)} · default flavor:{' '}
          {repo.defaultFlavor ?? '(catalog default)'}
        </p>
        {msg && <p className="muted">{msg}</p>}
        {err && <p className="error">{err}</p>}
      </div>

      <div className="card">
        <h3>Workflows</h3>
        {!wf.data.workflows.length && <p className="muted">No workflows parsed yet — run a re-scan.</p>}
        {wf.data.workflows.map((w) => (
          <div key={w.path} style={{ marginBottom: 18 }}>
            <div className="row">
              <strong>{w.path}</strong>
              <CompatBadge level={w.compatLevel} />
              <span className="muted">
                {w.name} · parsed {formatTime(w.updatedAt)}
              </span>
            </div>
            {w.parseError && <p className="error">parse error: {w.parseError}</p>}
            {w.jobs.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>runs-on</th>
                    <th>→ Flavor</th>
                    <th>Compat</th>
                    <th>Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {w.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>{j.name ?? j.id}</td>
                      <td className="muted">{j.runsOn.join(', ') || '—'}</td>
                      <td>
                        {j.flavor ?? '—'}
                        {j.flavorReason && <div className="muted">{j.flavorReason}</div>}
                      </td>
                      <td>
                        <CompatBadge level={j.compat.level} />
                      </td>
                      <td className="muted">
                        {j.compat.messages.map((m) => (
                          <div key={m.code}>
                            {m.code}: {m.text}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Flavor overrides</h3>
        <p className="muted">
          Explicit `label → flavor` mapping. Highest precedence in routing (spec 03 step 1).
        </p>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Flavor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.entries(map).map(([label, flavor]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  <select
                    value={flavor}
                    onChange={(e) => setDraft({ ...map, [label]: e.target.value })}
                  >
                    {(flavors.data?.flavors ?? []).map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    onClick={() => {
                      const next = { ...map };
                      delete next[label];
                      setDraft(next);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!Object.keys(map).length && (
              <tr>
                <td colSpan={3} className="muted">
                  No overrides — routing uses LCA labels + signals.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            type="text"
            placeholder="runner label, e.g. ubuntu-latest"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button
            disabled={!newLabel.trim() || !flavors.data?.flavors.length}
            onClick={() => {
              const first = flavors.data?.flavors[0]?.name;
              if (!first) return;
              setDraft({ ...map, [newLabel.trim()]: first });
              setNewLabel('');
            }}
          >
            Add override
          </button>
          <button className="primary" disabled={!draft} onClick={() => saveMap(map)}>
            Save
          </button>
          {draft && <button onClick={() => setDraft(undefined)}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}
