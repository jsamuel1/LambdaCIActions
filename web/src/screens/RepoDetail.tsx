import { useState } from 'react';
import { api, type RouteReadiness } from '../api.js';
import { useApi } from '../hooks.js';
import { CompatBadge, CompatRollupView, ErrorBox, Loading, formatTime } from '../components.js';

/**
 * Live control-plane verdict on a job's route (ADR-050).
 *
 * Rendered as its own column rather than folded into the compat badge, because the two answer
 * different questions and only one of them moves when an operator publishes an image. A route can
 * be `compat: ok` and still unrunnable — the state that left eight PRs queued with a reassuring
 * green console.
 *
 * `unknown` renders as "unchecked", never as OK: a live read that failed is not evidence the route
 * works, and claiming it is would recreate exactly the misleading green this column exists to kill.
 */
function PlatformBadge({ platform }: { platform?: RouteReadiness }): JSX.Element {
  if (!platform || platform.state === 'unknown') {
    return (
      <span className="badge queued" title="Could not reconcile against the live control plane.">
        unchecked
      </span>
    );
  }
  if (platform.runnable) return <span className="badge ok">runnable</span>;
  // `unroutable`/`unclaimable` strand the job silently at the claim gate; `imageMissing` at least
  // produces a run row that fails, so it is the less severe of the two.
  const kind = platform.state === 'imageMissing' ? 'risk' : 'block';
  return (
    <span className={`badge ${kind}`} title={platform.problem}>
      {platform.state}
    </span>
  );
}

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
  const rewrite = useApi(
    () =>
      installationId
        ? api.rewritePreview(installationId, repoId)
        : Promise.reject(new Error('no installation selected')),
    [installationId, repoId],
  );
  const [msg, setMsg] = useState<string | undefined>(undefined);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<Record<string, string> | undefined>(undefined);
  const [newLabel, setNewLabel] = useState('');

  if (wf.error) return <ErrorBox message={wf.error} />;
  if (!wf.data) return <Loading what="workflows" />;

  const repo = wf.data.repo;
  const map = draft ?? repo.flavorMap;
  const adoptCandidates = wf.data.workflows.reduce((n, w) => n + (w.adoptCandidates ?? 0), 0);
  /** Jobs the live control plane cannot run — counted server-side from the same readiness data. */
  const unrunnableJobs = wf.data.unrunnableJobs ?? 0;

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

  /** Switch onboarding mode (M5). `adopt` starts claiming this repo's `ubuntu-*` jobs. */
  async function setMode(mode: 'label' | 'adopt' | 'off'): Promise<void> {
    setErr(undefined);
    try {
      await api.patchRepo(repo.installationId, repo.repoId, { mode });
      setMsg(
        mode === 'adopt'
          ? 'Adopt mode on — new jobs with standard GitHub-hosted labels will run on microVMs (arm64).'
          : `Mode set to ${mode}.`,
      );
      wf.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Toggle the per-repo auto-rewrite opt-in (ADR-031). */
  async function setRewriteOptIn(on: boolean): Promise<void> {
    setErr(undefined);
    try {
      await api.patchRepo(repo.installationId, repo.repoId, { rewriteEnabled: on });
      setMsg(on ? 'Auto-rewrite opt-in enabled for this repo.' : 'Auto-rewrite opt-in disabled.');
      wf.reload();
      rewrite.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Enqueue the rewrite PR. Refused (409) unless both gates are on. */
  async function openRewritePr(): Promise<void> {
    setErr(undefined);
    try {
      await api.rewritePr(repo.installationId, repo.repoId);
      setMsg('Rewrite PR queued — it appears in the repo shortly. Nothing is merged for you.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 className="tight">{repo.repoFullName}</h2>
          <CompatRollupView roll={wf.data.compat} />
          <span className="spacer" />
          <button onClick={rescan}>Re-scan</button>
          <button onClick={() => navigate(`/runs?repo=${repo.repoId}`)}>Runs</button>
        </div>
        <p className="muted">
          mode: {repo.mode} · enabled: {String(repo.enabled)} · default flavor:{' '}
          {repo.defaultFlavor ?? '(catalog default)'}
        </p>
        <div className="row">
          <label htmlFor="repo-mode">Onboarding mode</label>
          <select
            id="repo-mode"
            value={repo.mode}
            onChange={(e) => void setMode(e.target.value as 'label' | 'adopt' | 'off')}
          >
            <option value="label">label — only jobs carrying an LCA label</option>
            <option value="adopt">adopt — also claim ubuntu-* jobs (no YAML edits)</option>
            <option value="off">off — never claim this repo</option>
          </select>
        </div>
        <p className="muted">
          {repo.mode === 'adopt'
            ? `Adopt mode is on: ${adoptCandidates} job(s) targeting standard GitHub-hosted labels run on arm64 microVMs. Jobs that need x86 will fail — check the compat findings below.`
            : `${adoptCandidates} job(s) target standard GitHub-hosted labels and still run on GitHub-hosted runners. Switch to adopt mode to run them unchanged (arm64 only).`}
        </p>
        {msg && <p className="muted">{msg}</p>}
        {err && <p className="error">{err}</p>}
      </div>

      {unrunnableJobs > 0 && (
        <div className="card">
          <p className="error tight">
            {unrunnableJobs} job{unrunnableJobs === 1 ? '' : 's'} route to a flavor this deployment
            cannot run.
          </p>
          <p className="muted tight">
            The workflow analysis below is computed from the catalog; these jobs were reconciled
            against the LIVE control plane and their flavor's routing label is missing from the
            claim allowlist, or its image is not published. A job in that state is left{' '}
            <code>queued</code> by GitHub with no error — see the Platform column, and{' '}
            <a href="#/unclaimed">Unclaimed</a> for jobs already refused.
          </p>
        </div>
      )}
      {wf.data.controlPlaneLive === false && (
        <div className="card">
          <p className="muted tight">
            Could not read the live control plane, so the Platform column below reads{' '}
            <em>unchecked</em> rather than green. Routing shown is catalog-only.
          </p>
        </div>
      )}

      <div className="card">
        <h3>Workflows</h3>
        {!wf.data.workflows.length && <p className="muted">No workflows parsed yet — run a re-scan.</p>}
        {wf.data.workflows.map((w) => (
          <div key={w.path} className="workflow">
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
                    <th>Platform</th>
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
                      <td>
                        <PlatformBadge platform={j.platform} />
                      </td>
                      <td className="muted">
                        {j.platform && j.platform.state !== 'unknown' && !j.platform.runnable && (
                          <div>
                            <strong>not runnable here</strong>: {j.platform.problem}
                            {j.platform.fix && <div className="fix">Fix: {j.platform.fix}</div>}
                          </div>
                        )}
                        {j.adoptCandidate && (
                          <div>
                            <strong>adopt candidate</strong>: runs on GitHub-hosted runners unless
                            this repo is in adopt mode.
                          </div>
                        )}
                        {j.compat.messages.map((m) => (
                          <div key={m.code}>
                            {m.code}: {m.text}
                            {m.fix && <div className="fix">Fix: {m.fix}</div>}
                          </div>
                        ))}
                        {!j.adoptCandidate &&
                          !j.compat.messages.length &&
                          (j.platform?.runnable !== false || j.platform?.state === 'unknown') &&
                          '—'}
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
        <h3>Auto-rewrite PR</h3>
        <p className="muted">
          Opens a pull request that adds LCA labels to <code>runs-on</code>, so jobs route here
          explicitly instead of relying on adopt mode. Only <code>runs-on</code> lines change —
          comments and formatting are preserved. Always a reviewable PR: never a direct push,
          never a force-push, and nothing is merged for you.
        </p>
        {rewrite.error && <p className="error">{rewrite.error}</p>}
        {!rewrite.data && !rewrite.error && <Loading what="rewrite preview" />}
        {rewrite.data && (
          <>
            <p className="muted">
              Deployment capability:{' '}
              <strong>{rewrite.data.deploymentEnabled ? 'enabled' : 'disabled'}</strong> · repo
              opt-in: <strong>{rewrite.data.repoOptedIn ? 'on' : 'off'}</strong>
            </p>
            {!rewrite.data.deploymentEnabled && (
              <p className="muted">
                This deployment has auto-rewrite turned off. It needs the GitHub App to hold
                <code> contents:write</code> (off by default) and a redeploy with{' '}
                <code>-c rewrite=true</code>. The dry run below still works.
              </p>
            )}
            <div className="row">
              <label htmlFor="rewrite-optin">
                <input
                  id="rewrite-optin"
                  type="checkbox"
                  checked={rewrite.data.repoOptedIn}
                  onChange={(e) => void setRewriteOptIn(e.target.checked)}
                />{' '}
                Allow LambdaCIActions to open a rewrite PR on this repo
              </label>
              <span className="spacer" />
              <button
                className="primary"
                disabled={!rewrite.data.canApply || rewrite.data.changes === 0}
                onClick={() => void openRewritePr()}
              >
                Open rewrite PR
              </button>
            </div>
            <p className="muted">
              {rewrite.data.changes} job(s) would change
              {rewrite.data.skipped > 0 && `, ${rewrite.data.skipped} need a hand edit`}.
            </p>
            {rewrite.data.jobs.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Job</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rewrite.data.jobs.map((j) => (
                    <tr key={`${j.path}:${j.jobId}`}>
                      <td className="muted">{j.path}</td>
                      <td>{j.jobId}</td>
                      <td>
                        {j.after ? (
                          <pre className="diff">
                            {`- runs-on: ${j.before}\n+ runs-on: ${j.after}`}
                          </pre>
                        ) : (
                          <span className="muted">skipped: {j.skipped}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
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
        <div className="row gap-top">
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
