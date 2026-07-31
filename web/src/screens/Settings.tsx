import { useState } from 'react';
import { api, installationListState, relinkSubmitFailure, type LabelImpact, type RelinkResult, type Settings as SettingsData } from '../api.js';
import { useApi } from '../hooks.js';
import { Badge, ErrorBox, Loading, formatTime } from '../components.js';

/**
 * Settings — what the environment is actually wired to, with evidence.
 *
 * Deliberately NOT a list of SSM parameters (spec 04 § Settings): an operator should never
 * have to reason about `/lca/dev/github/app-pem` to know whether their platform works. The
 * primary view answers four questions — which GitHub App is this linked to (verified live via
 * `GET /app`, so a green badge proves the stored PEM authenticates), who has it installed,
 * which labels do we claim, and is GitHub actually delivering to us. Parameter paths survive
 * only in a collapsed diagnostics section.
 *
 * Secrets: no field of this payload can carry a value, and the relink form is write-only
 * intake — form state lives in memory and is cleared on success (never localStorage).
 */
export function Settings(): JSX.Element {
  // Poll: the webhook heartbeat is the evidence a "Test delivery" round-trip landed.
  const s = useApi(() => api.settings(), [], 15000);
  if (s.error) return <ErrorBox message={s.error} />;
  if (!s.data) return <Loading what="settings" />;
  const d = s.data;

  return (
    <div className="stack">
      <GithubAppCard data={d} reload={s.reload} />
      <RunnerLabelsCard data={d} reload={s.reload} />
      <WebhookCard data={d} reload={s.reload} />
      <FlavorsCard data={d} />
      <ChangesCard data={d} />
      <DiagnosticsCard data={d} />
    </div>
  );
}

// ---- GitHub App linkage ----------------------------------------------------

function GithubAppCard({ data, reload }: { data: SettingsData; reload: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const app = data.app;
  // A stored app-id that disagrees with the App the PEM authenticates as means a half-finished
  // rotation — the platform will mint tokens for one App while config claims another.
  const idMismatch =
    app && data.configuredAppId !== undefined && String(app.appId) !== data.configuredAppId;

  return (
    <div className="card">
      <div className="row">
        <h3 className="tight">GitHub App</h3>
        {app ? <Badge kind="ok">verified</Badge> : <Badge kind="block">not verified</Badge>}
        <span className="spacer" />
        <span className="muted">
          {data.envName} · {data.region}
        </span>
        {data.canAdminPlatform && (
          <button onClick={() => setOpen((v) => !v)}>{open ? 'Cancel' : 'Re-link App…'}</button>
        )}
      </div>

      {!app && (
        <p className="error">
          {data.appVerifyError ??
            'This environment is not linked to a working GitHub App. Run `npm run app:create`, or re-link below.'}
        </p>
      )}

      {app && (
        <>
          <table>
            <tbody>
              <tr>
                <th>App</th>
                <td>
                  <a href={app.htmlUrl} target="_blank" rel="noreferrer">
                    {app.name}
                  </a>{' '}
                  <span className="muted">({app.slug})</span>
                </td>
              </tr>
              <tr>
                <th>App ID</th>
                <td>
                  {app.appId}
                  {idMismatch && (
                    <span className="error">
                      {' '}
                      — config records {data.configuredAppId}; the stored key authenticates as{' '}
                      {app.appId}
                    </span>
                  )}
                </td>
              </tr>
              <tr>
                <th>Owner</th>
                <td>{app.ownerLogin || '—'}</td>
              </tr>
              <tr>
                <th>Events</th>
                <td className="muted">{app.events.join(', ') || '—'}</td>
              </tr>
              <tr>
                <th>Permissions</th>
                <td className="muted">
                  {Object.entries(app.permissions)
                    .map(([k, v]) => `${k}:${v}`)
                    .join(', ') || '—'}
                </td>
              </tr>
            </tbody>
          </table>

          <h4>Installations</h4>
          {(() => {
            // Three different facts arrive as the same empty array (scoped / could-not-enumerate
            // / authoritatively none). `installationListState` picks between them so the screen
            // never asserts "not installed anywhere" from a list GitHub never answered.
            const state = installationListState(data);
            if (state === 'scoped') {
              return (
                <p className="muted">
                  {data.installationsHidden} installation(s) are not shown — they belong to accounts
                  you do not administer. Ask a platform administrator for the full list.
                </p>
              );
            }
            if (state === 'unenumerated') {
              return (
                <p className="error">
                  GitHub&apos;s installation list could not be read
                  {data.appVerifyError ? `: ${data.appVerifyError}` : ''}. The App itself
                  authenticates, so this is not evidence that it is uninstalled — retry, or check
                  the App&apos;s permissions at GitHub.
                </p>
              );
            }
            if (state === 'empty') {
              return (
                <p className="muted">
                  The App is not installed anywhere yet. Install it on an org or user account to
                  onboard repositories.
                </p>
              );
            }
            return (
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Installation ID</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.installations.map((i) => (
                    <tr key={i.installationId}>
                      <td>{i.accountLogin || '—'}</td>
                      <td className="muted">{i.installationId}</td>
                      <td>
                        {i.suspended ? (
                          <Badge kind="warn">suspended</Badge>
                        ) : (
                          <Badge kind="ok">active</Badge>
                        )}
                        {!i.known && (
                          <>
                            {' '}
                            <Badge kind="warn">not in run store</Badge>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
          {data.installations.length > 0 && data.installationsEnumerated === false && (
            <p className="error">
              GitHub&apos;s installation list could not be read
              {data.appVerifyError ? `: ${data.appVerifyError}` : ''}. The rows above come from this
              platform&apos;s own store, so an installation added or removed since the last webhook
              may be missing or stale.
            </p>
          )}
          {data.installations.length > 0 && (data.installationsHidden ?? 0) > 0 && (
            <p className="muted">
              {data.installationsHidden} further installation(s) are not shown — they belong to
              accounts you do not administer.
            </p>
          )}
        </>
      )}

      {open && (
        <RelinkForm
          reload={reload}
          onDone={() => {
            setOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

const EMPTY_CREDS = { appId: '', pem: '', webhookSecret: '', clientId: '', clientSecret: '' };

/**
 * Write-only credential intake. The values are POSTed once and dropped from component state
 * on success; nothing is written to localStorage/sessionStorage, and the API's response
 * carries only presence + verification outcome (AGENTS.md hard rule).
 */
function RelinkForm({
  onDone,
  reload,
}: {
  onDone: () => void;
  reload: () => void;
}): JSX.Element {
  const [creds, setCreds] = useState(EMPTY_CREDS);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RelinkResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  /**
   * Set when the server REFUSED because a rotated webhook secret could not be pushed to GitHub.
   * The credentials were valid and were rolled back; proceeding would stop every delivery, so it
   * requires a second, explicit confirmation rather than a silent retry.
   */
  const [desyncRefusal, setDesyncRefusal] = useState<string | undefined>();

  const set = (k: keyof typeof EMPTY_CREDS) => (e: { target: { value: string } }) =>
    setCreds((c) => ({ ...c, [k]: e.target.value }));

  async function submit(allowHookDesync = false): Promise<void> {
    setBusy(true);
    setError(undefined);
    if (!allowHookDesync) setDesyncRefusal(undefined);
    try {
      const res = await api.relinkGithubApp({ ...creds, ...(allowHookDesync ? { allowHookDesync } : {}) });
      applyRelinkOutcome(res);
    } catch (err) {
      // A refusal arrives as a rejected 422 carrying a structured body; an opaque failure (503
      // lock contention, a proxy error page, a dropped connection) must NOT discard the previous
      // outcome, because that outcome holds the rollback handle and the `rolledBack` flag the
      // desync panel below reads. `relinkSubmitFailure` owns that decision (and is unit-tested).
      const next = relinkSubmitFailure(err, result);
      if ('outcome' in next) applyRelinkOutcome(next.outcome);
      else {
        setError(next.error);
        setResult(next.result);
      }
    } finally {
      setBusy(false);
    }
  }

  /** Route a relink outcome (success, or a recovered 422 refusal) to the right UI state. */
  function applyRelinkOutcome(res: RelinkResult): void {
    setResult(res);
    if (res.applied) {
      setDesyncRefusal(undefined);
      setCreds(EMPTY_CREDS); // drop the plaintext as soon as it is no longer needed
      // A hook-sync failure needs the operator's attention here, so keep the panel open
      // rather than collapsing it — the warning would otherwise vanish on close.
      if (res.hookSynced !== false) onDone();
      else reload();
    } else if (res.hookSynced === false) {
      // Webhook-secret desync refusal: keep the (still-populated) form so the operator can
      // confirm after fixing the secret at GitHub, rather than re-typing every credential.
      setDesyncRefusal(res.error ?? 'GitHub webhook configuration could not be updated');
    } else {
      setError(res.error ?? 'relink failed');
    }
  }

  async function rollback(): Promise<void> {
    // A first-link has an EMPTY `replacedVersions` (nothing existed to replace) and undoes itself
    // through `createdParams` instead, so gating on the versions alone would make its rollback a
    // no-op.
    if (!result) return;
    const versions = result.replacedVersions ?? {};
    const created = result.createdParams ?? [];
    if (!Object.keys(versions).length && !created.length) return;
    setBusy(true);
    try {
      // `createdParams` matters as much as the versions: parameters this relink CREATED have no
      // prior version, so a rollback that omitted them would leave a first-link in place.
      const res = await api.rollbackGithubApp(versions, created);
      setResult(undefined);
      // A rollback whose GitHub hook re-sync failed leaves signing broken; keep the panel open
      // with the warning rather than closing on what looks like success.
      if (res.hookSynced === false) {
        setError(
          `Credentials restored, but GitHub's webhook configuration could not be re-pointed at the ` +
            `restored secret${res.hookError ? `: ${res.hookError}` : ''}. Set the webhook secret on ` +
            'the App at GitHub manually — until then every delivery will be rejected.',
        );
        reload();
      } else {
        onDone();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const complete = Object.values(creds).every((v) => v.trim().length > 0);
  /**
   * Whether a rollback is still meaningful. A relink that SUCCEEDED can be undone; a refusal
   * that already rolled itself back cannot (offering the button would re-restore the versions
   * that are already in effect and read as though the environment were still broken). A refusal
   * whose own rollback FAILED is exactly the case that needs the button.
   */
  const rollbackOffered =
    result !== undefined &&
    result.rolledBack !== true &&
    ((result.replacedVersions && Object.keys(result.replacedVersions).length > 0) ||
      (result.createdParams && result.createdParams.length > 0));

  return (
    <div className="subcard gap-top">
      <h4>Re-link this environment to a GitHub App</h4>
      <p className="muted">
        Credentials are verified against GitHub (App JWT → <code>GET /app</code>) before anything
        is written, and rolled back automatically if verification fails afterwards. Values are
        never returned, stored in the browser, or logged.
      </p>
      <div className="stack">
        <label className="field">
          <span>App ID</span>
          <input type="text" value={creds.appId} onChange={set('appId')} autoComplete="off" />
        </label>
        <label className="field">
          <span>OAuth client ID</span>
          <input type="text" value={creds.clientId} onChange={set('clientId')} autoComplete="off" />
        </label>
        <label className="field">
          <span>OAuth client secret</span>
          <input
            type="password"
            value={creds.clientSecret}
            onChange={set('clientSecret')}
            autoComplete="new-password"
          />
        </label>
        <label className="field">
          <span>Webhook secret</span>
          <input
            type="password"
            value={creds.webhookSecret}
            onChange={set('webhookSecret')}
            autoComplete="new-password"
          />
        </label>
        <label className="field">
          <span>Private key (PEM)</span>
          <textarea
            className="pem"
            value={creds.pem}
            onChange={set('pem')}
            placeholder="-----BEGIN RSA PRIVATE KEY-----"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="row gap-top">
        <button className="primary" disabled={busy || !complete} onClick={() => submit()}>
          {busy ? 'Verifying…' : 'Verify & re-link'}
        </button>
        {rollbackOffered && (
          <button disabled={busy} onClick={rollback}>
            Roll back to previous App
          </button>
        )}
      </div>
      {desyncRefusal && (
        <div className="subcard gap-top">
          <p className="error">{desyncRefusal}</p>
          <p className="muted">
            {result?.rolledBack === false ? (
              <>
                <strong>The rollback did not complete</strong> — some credential parameters may
                still hold the submitted values. Check CloudWatch, then use the rollback button
                above before retrying.{' '}
              </>
            ) : (
              <>Nothing was changed — the credentials were verified and then rolled back. </>
            )}
            Set the new webhook secret on the App at GitHub yourself (Settings → Webhook →
            Secret), then confirm below. Until GitHub and this environment agree on the secret,
            every delivery is rejected and no job is claimed.
          </p>
          <button className="danger" disabled={busy || !complete} onClick={() => submit(true)}>
            {busy ? 'Re-linking…' : 'I set the secret at GitHub — re-link anyway'}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {result?.applied && (
        <>
          <p className="muted">
            Linked to app {result.appId} ({result.appSlug}).{' '}
            {result.verified ? 'Verified against GitHub.' : 'Verification incomplete.'}
          </p>
          {result.hookSynced === false && (
            <p className="error">
              GitHub&apos;s webhook configuration could not be updated
              {result.hookError ? `: ${result.hookError}` : ''}. Set the webhook secret on the App
              at GitHub manually — until then GitHub signs deliveries with the previous secret and
              every delivery will be rejected.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ---- runner labels ---------------------------------------------------------

/**
 * Label editing is two-phase on purpose: a change takes effect on the very next
 * `workflow_job` delivery, so the operator previews the impact (which jobs stop/start being
 * claimed) and only then commits.
 */
function RunnerLabelsCard({ data, reload }: { data: SettingsData; reload: () => void }): JSX.Element {
  const [draft, setDraft] = useState(data.runnerLabels.labels.join(', '));
  const [allowHosted, setAllowHosted] = useState(false);
  const [impact, setImpact] = useState<LabelImpact | undefined>();
  /**
   * The exact label set the displayed `impact` was computed for. Apply is gated on this
   * matching the current draft — otherwise an operator could preview `lca-base`, edit the field
   * to `ubuntu-latest`, and apply the second while reading the first one's impact.
   */
  const [previewedFor, setPreviewedFor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [details, setDetails] = useState<string[] | undefined>();

  const parsed = draft
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const changed =
    parsed.join(',') !== data.runnerLabels.labels.map((l) => l.toLowerCase()).join(',');
  /** Canonical identity of a preview: the labels AND the hosted-label confirmation. */
  const draftKey = `${parsed.join(',')}|${allowHosted}`;
  const previewCurrent = impact !== undefined && previewedFor === draftKey;

  async function run(dryRun: boolean): Promise<void> {
    setBusy(true);
    setError(undefined);
    setDetails(undefined);
    const key = draftKey;
    try {
      const res = await api.putRunnerLabels({ labels: parsed, allowHostedLabels: allowHosted, dryRun });
      if (res.applied) {
        setImpact(undefined);
        setPreviewedFor(undefined);
        reload();
      } else {
        setImpact(res.impact);
        setPreviewedFor(key);
      }
    } catch (err) {
      setImpact(undefined);
      setPreviewedFor(undefined);
      const e = err as { message?: string; details?: unknown };
      setError(e.message ?? String(err));
      if (Array.isArray(e.details)) setDetails(e.details as string[]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <h3 className="tight">Runner labels</h3>
        {data.runnerLabels.unset ? (
          <Badge kind="block">unset — no jobs claimed</Badge>
        ) : (
          <Badge kind="ok">{data.runnerLabels.labels.length} claimed</Badge>
        )}
      </div>
      <p className="muted">
        Jobs whose <code>runs-on</code> includes any of these labels are claimed by this
        environment. Matching is case-insensitive.
      </p>
      <div className="row">
        {data.runnerLabels.labels.map((l) => (
          <Badge key={l} kind={data.runnerLabels.hostedLabels.includes(l) ? 'warn' : 'ok'}>
            {l}
          </Badge>
        ))}
        {!data.runnerLabels.labels.length && <span className="muted">none</span>}
      </div>
      {data.runnerLabels.hostedLabels.length > 0 && (
        <p className="muted">
          Claiming GitHub-hosted label name(s) {data.runnerLabels.hostedLabels.join(', ')} — jobs
          using them run here instead of on GitHub-hosted runners (adopt mode).
        </p>
      )}

      {data.canAdminPlatform && (
        <>
          <label className="field gap-top">
            <span>Labels (comma-separated)</span>
            <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <label className="row gap-top">
            <input
              type="checkbox"
              checked={allowHosted}
              onChange={(e) => setAllowHosted(e.target.checked)}
            />
            <span className="muted">
              Allow GitHub-hosted label names (e.g. <code>ubuntu-latest</code>) — takes over every
              job using them
            </span>
          </label>
          <div className="row gap-top">
            <button disabled={busy || !changed} onClick={() => run(true)}>
              Preview impact
            </button>
            <button
              className="primary"
              disabled={busy || !changed || !previewCurrent}
              onClick={() => run(false)}
            >
              Apply
            </button>
          </div>
          {!previewCurrent && changed && (
            <p className="muted">Preview the impact before applying.</p>
          )}
          {error && <p className="error">{error}</p>}
          {details?.map((d) => (
            <p key={d} className="error">
              {d}
            </p>
          ))}
          {previewCurrent && impact && <ImpactView impact={impact} />}
        </>
      )}
    </div>
  );
}

function ImpactView({ impact }: { impact: LabelImpact }): JSX.Element {
  return (
    <div className="subcard gap-top">
      <h4>Impact preview</h4>
      <p className="muted">
        {impact.added.length ? `adding ${impact.added.join(', ')}; ` : ''}
        {impact.removed.length ? `removing ${impact.removed.join(', ')}; ` : ''}
        {impact.losing.length} job(s) would stop being claimed, {impact.gaining.length} would
        start.
        {/*
          The two partial causes are reported separately: a repo-cap truncation hides repos past
          the bound, while an unverified App linkage can hide whole INSTALLATIONS. Printing the
          repo-cap wording for the second case would understate the blind spot on the operator's
          only warning before a change that affects every tenant.
        */}
        {impact.partial?.repoCap && ' Analysis covered the first 50 repositories only.'}
        {impact.partial?.unverifiedInstallations &&
          ' The GitHub App linkage could not be verified, so this scan may be missing whole' +
            ' installations — jobs in them are not listed.'}
        {impact.truncated &&
          !impact.partial &&
          ' Analysis is partial — some affected jobs may not be listed.'}
      </p>
      {[
        ['No longer claimed', impact.losing],
        ['Newly claimed', impact.gaining],
      ].map(([title, jobs]) =>
        (jobs as LabelImpact['losing']).length ? (
          <div key={title as string} className="workflow">
            <h4>{title as string}</h4>
            <table>
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Workflow</th>
                  <th>Job</th>
                  <th>runs-on</th>
                </tr>
              </thead>
              <tbody>
                {(jobs as LabelImpact['losing']).slice(0, 25).map((j, idx) => (
                  <tr key={`${j.repoId}-${j.workflowPath}-${j.jobId}-${idx}`}>
                    <td>{j.repoFullName}</td>
                    <td className="muted">{j.workflowPath}</td>
                    <td>{j.jobId}</td>
                    <td className="muted">{j.runsOn.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(jobs as LabelImpact['losing']).length > 25 && (
              <p className="muted">
                …and {(jobs as LabelImpact['losing']).length - 25} more
              </p>
            )}
          </div>
        ) : null,
      )}
    </div>
  );
}

// ---- webhook health --------------------------------------------------------

function WebhookCard({ data, reload }: { data: SettingsData; reload: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const w = data.webhook;

  async function test(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const res = await api.testWebhook();
      setNote(
        `Asked GitHub to re-deliver delivery ${res.deliveryId}. The "last received" timestamp ` +
          'below updates when it lands (this view polls every 15s).',
      );
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const kind = w.state === 'healthy' ? 'ok' : w.state === 'degraded' ? 'block' : 'warn';
  return (
    <div className="card">
      <div className="row">
        <h3 className="tight">Webhook delivery</h3>
        <Badge kind={kind}>{w.state}</Badge>
        <span className="spacer" />
        {data.canAdminPlatform && (
          <button disabled={busy} onClick={test}>
            {busy ? 'Requesting…' : 'Test delivery'}
          </button>
        )}
      </div>

      <table>
        <tbody>
          <tr>
            <th>Endpoint (this deployment)</th>
            <td className="muted">{w.deployedUrl ?? 'unknown'}</td>
          </tr>
          <tr>
            <th>Endpoint (configured at GitHub)</th>
            <td className={w.urlMismatch ? 'error' : 'muted'}>
              {w.configuredUrl ?? 'unknown'}
              {w.urlMismatch && ' — does not match the deployed endpoint'}
            </td>
          </tr>
          <tr>
            <th>Last received</th>
            <td>
              {w.lastReceivedAt ? (
                <>
                  {formatTime(w.lastReceivedAt)}{' '}
                  <span className="muted">
                    ({w.lastReceivedEvent}
                    {w.deliveries ? `, ${w.deliveries} total` : ''})
                  </span>
                </>
              ) : (
                <span className="muted">no delivery has reached this environment yet</span>
              )}
            </td>
          </tr>
          {w.rejections ? (
            <tr>
              <th>Signature failures</th>
              <td className="error">
                {w.rejections} rejected
                {w.lastRejectedAt ? `, last ${formatTime(w.lastRejectedAt)}` : ''} — the webhook
                secret at GitHub does not match the stored one
              </td>
            </tr>
          ) : null}
          <tr>
            <th>Secret configured at GitHub</th>
            <td>
              {w.secretConfigured === undefined ? (
                <span className="muted">unknown</span>
              ) : w.secretConfigured ? (
                <Badge kind="ok">yes</Badge>
              ) : (
                <Badge kind="block">no — deliveries are unsigned</Badge>
              )}
            </td>
          </tr>
          {w.insecureSsl && (
            <tr>
              <th>TLS verification</th>
              <td className="error">disabled at GitHub (insecure_ssl)</td>
            </tr>
          )}
        </tbody>
      </table>

      {w.error && <p className="muted">Delivery log unavailable: {w.error}</p>}
      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}

      {w.recentDeliveries.length > 0 && (
        <>
          <h4>
            Recent deliveries (GitHub){w.recentFailures ? ` — ${w.recentFailures} failed` : ''}
          </h4>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Result</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {w.recentDeliveries.slice(0, 10).map((d) => (
                <tr key={d.id}>
                  <td className="muted">{formatTime(d.deliveredAt)}</td>
                  <td>
                    {d.event}
                    {d.action ? `.${d.action}` : ''}
                    {d.redelivery && <span className="muted"> (redelivery)</span>}
                  </td>
                  <td>
                    <Badge kind={d.statusCode >= 200 && d.statusCode < 300 ? 'ok' : 'block'}>
                      {d.statusCode} {d.status}
                    </Badge>
                  </td>
                  <td className="muted">{d.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---- flavors / audit / diagnostics ----------------------------------------

function FlavorsCard({ data }: { data: SettingsData }): JSX.Element {
  return (
    <div className="card">
      <h3 className="tight">Flavors &amp; images</h3>
      <table>
        <thead>
          <tr>
            <th>Flavor</th>
            <th>Size</th>
            <th>$/min</th>
            <th>Image</th>
          </tr>
        </thead>
        <tbody>
          {data.flavors.map((f) => (
            <tr key={f.name}>
              <td>{f.name}</td>
              <td className="muted">
                {f.vcpu} vCPU / {Math.round(f.memoryMb / 1024)} GB · {f.arch}
              </td>
              <td className="muted">${f.usdPerMinute.toFixed(4)}</td>
              <td>
                {f.imageAvailable ? (
                  <Badge kind="ok">built</Badge>
                ) : (
                  <Badge kind="warn">not built</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangesCard({ data }: { data: SettingsData }): JSX.Element {
  if (!data.recentChanges.length) return <></>;
  return (
    <div className="card">
      <h3 className="tight">Recent platform changes</h3>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {data.recentChanges.map((c) => (
            <tr key={`${c.at}-${c.action}`}>
              <td className="muted">{formatTime(c.at)}</td>
              <td>{c.actor}</td>
              <td>
                {c.action}
                {c.detail && <div className="muted">{c.detail}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Advanced diagnostics: SSM parameter presence. Collapsed by default — an operator debugging a
 * deploy still wants it, but it is not how the platform's health is expressed. Presence only;
 * the API has no way to return a value (spec 04 hard rule).
 */
function DiagnosticsCard({ data }: { data: SettingsData }): JSX.Element {
  const [open, setOpen] = useState(false);
  const missing = data.diagnostics.secrets.filter((s) => !s.present);
  return (
    <div className="card">
      <div className="row">
        <h3 className="tight">Diagnostics</h3>
        {missing.length > 0 && <Badge kind="warn">{missing.length} parameter(s) missing</Badge>}
        <span className="spacer" />
        <button onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'} SSM parameters</button>
      </div>
      {open && (
        <>
          <p className="muted">
            Presence and health only — parameter values are never returned by the API.
          </p>
          <table>
            <thead>
              <tr>
                <th>Setting</th>
                <th>SSM parameter</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.diagnostics.secrets.map((sec) => (
                <tr key={sec.param}>
                  <td>{sec.label}</td>
                  <td className="muted">{sec.param}</td>
                  <td>
                    {sec.present ? <Badge kind="ok">set</Badge> : <Badge kind="block">missing</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
