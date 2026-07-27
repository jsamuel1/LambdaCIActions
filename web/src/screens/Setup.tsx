import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, formatTime } from '../components.js';

/**
 * Setup — the install/onboarding screen. Shown when the operator has no installations, and
 * reachable from the nav for adding more. The App install URL is derived from the App slug,
 * which the operator gets from `npm run app:create` output (spec 01).
 */
export function Setup(): JSX.Element {
  const installs = useApi(() => api.installations(), []);
  const settings = useApi(() => api.settings(), []);

  if (installs.error) return <ErrorBox message={installs.error} />;
  if (!installs.data) return <Loading what="installations" />;

  const missing = (settings.data?.secrets ?? []).filter((s) => !s.present);

  return (
    <div className="stack">
      <div className="card">
        <h3>Installations</h3>
        {!installs.data.installations.length ? (
          <p className="muted">
            You have no LambdaCIActions App installations. Install the GitHub App on an org or
            user account and grant it the repositories you want to run on CI, then reload this
            page.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Installation</th>
                <th>State</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {installs.data.installations.map((i) => (
                <tr key={i.installationId}>
                  <td>{i.accountLogin}</td>
                  <td className="muted">{i.installationId}</td>
                  <td>
                    {i.deleted ? (
                      <span className="badge block">uninstalled</span>
                    ) : i.suspended ? (
                      <span className="badge warn">suspended</span>
                    ) : (
                      <span className="badge ok">active</span>
                    )}
                  </td>
                  <td className="muted">{formatTime(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Platform readiness</h3>
        {settings.loading && <Loading what="settings" />}
        {missing.length === 0 && settings.data && (
          <p className="muted">All required parameters are present.</p>
        )}
        {missing.length > 0 && (
          <>
            <p className="error">{missing.length} required parameter(s) missing:</p>
            <ul className="muted">
              {missing.map((m) => (
                <li key={m.param}>
                  {m.label} — <code>{m.param}</code>
                </li>
              ))}
            </ul>
            <p className="muted">
              Create them out-of-band (ADR-008): `npm run app:create` writes the GitHub App
              credentials; the console session key is created by the M4 deploy steps in
              docs/DEPLOY-M4.md.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
