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
        {settings.data && (
          <>
            {/*
              Readiness is expressed as *linkage + claim + delivery*, not "are the SSM
              parameters present" (spec 04 § Settings): a first-run operator needs to know
              whether the App authenticates and whether GitHub can reach us — parameter
              presence proves neither.
            */}
            <table>
              <tbody>
                <tr>
                  <th>GitHub App</th>
                  <td>
                    {settings.data.app ? (
                      <>
                        <span className="badge ok">verified</span> {settings.data.app.name} (id{' '}
                        {settings.data.app.appId})
                      </>
                    ) : (
                      <>
                        <span className="badge block">not verified</span>{' '}
                        <span className="muted">
                          {settings.data.appVerifyError ??
                            'run `npm run app:create`, or re-link from Settings'}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Runner labels</th>
                  <td>
                    {settings.data.runnerLabels.unset ? (
                      <>
                        <span className="badge block">unset</span>{' '}
                        <span className="muted">no jobs will be claimed</span>
                      </>
                    ) : (
                      <span className="muted">
                        {settings.data.runnerLabels.labels.join(', ')}
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Webhook</th>
                  <td>
                    <span
                      className={`badge ${
                        settings.data.webhook.state === 'healthy'
                          ? 'ok'
                          : settings.data.webhook.state === 'degraded'
                            ? 'block'
                            : 'warn'
                      }`}
                    >
                      {settings.data.webhook.state}
                    </span>{' '}
                    <span className="muted">
                      {settings.data.webhook.lastReceivedAt
                        ? `last delivery ${formatTime(settings.data.webhook.lastReceivedAt)}`
                        : 'no delivery received yet'}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted">
              Full linkage detail, label editing and a webhook delivery test live on the{' '}
              <a href="#/settings">Settings</a> screen.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
