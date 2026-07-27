import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import { useApi, useHashRoute, useInstallation } from './hooks.js';
import { Dashboard } from './screens/Dashboard.js';
import { Repos } from './screens/Repos.js';
import { RepoDetail } from './screens/RepoDetail.js';
import { Runs } from './screens/Runs.js';
import { RunDetail } from './screens/RunDetail.js';
import { Flavors, Settings } from './screens/Platform.js';
import { Setup } from './screens/Setup.js';
import './styles.css';

const NAV: { path: string; label: string }[] = [
  { path: '/', label: 'Dashboard' },
  { path: '/repos', label: 'Repos' },
  { path: '/runs', label: 'Runs' },
  { path: '/flavors', label: 'Flavors' },
  { path: '/settings', label: 'Settings' },
  { path: '/setup', label: 'Setup' },
];

/**
 * App shell (spec 04). Hash routing keeps hosting trivial (any path serves index.html) and
 * makes the CloudFront SPA fallback unnecessary for in-app navigation.
 *
 * Session: `GET /api/me` is the gate. A 401 renders the login prompt, which is a plain link
 * to `/auth/login` — the OAuth round-trip is entirely server-side (ADR-022), so the SPA never
 * touches a GitHub token.
 */
function App(): JSX.Element {
  const { segments, navigate } = useHashRoute();
  const me = useApi(() => api.me(), []);
  const [installationId, setInstallation] = useInstallation();

  // Default the installation selector to the operator's first grant.
  useEffect(() => {
    if (!installationId && me.data?.installations.length) {
      setInstallation(me.data.installations[0].installationId);
    }
  }, [installationId, me.data, setInstallation]);

  if (me.unauthorized) return <Login />;
  if (me.error) {
    return (
      <div className="login">
        <div className="card">
          <p className="error">{me.error}</p>
          <button onClick={me.reload}>Retry</button>
        </div>
      </div>
    );
  }
  if (!me.data) {
    return (
      <div className="login">
        <div className="card">
          <p className="muted">Loading console…</p>
        </div>
      </div>
    );
  }

  const active = `/${segments[0] ?? ''}`;
  const repoQuery = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const repoFilter = repoQuery.get('repo');

  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">LambdaCIActions</div>
        {NAV.map((n) => (
          <a
            key={n.path}
            href={`#${n.path}`}
            className={active === n.path || (n.path === '/' && active === '/') ? 'active' : ''}
          >
            {n.label}
          </a>
        ))}
      </nav>
      <main>
        <header className="page">
          <h1>{titleFor(segments)}</h1>
          <div className="spacer" />
          {me.data.installations.length > 1 && (
            <select
              value={installationId ?? ''}
              onChange={(e) => setInstallation(Number(e.target.value))}
            >
              {me.data.installations.map((i) => (
                <option key={i.installationId} value={i.installationId}>
                  {i.accountLogin}
                </option>
              ))}
            </select>
          )}
          <span className="muted">{me.data.login}</span>
          <button
            onClick={async () => {
              await api.logout().catch(() => undefined);
              window.location.reload();
            }}
          >
            Sign out
          </button>
        </header>
        {renderRoute(segments, { installationId, navigate, repoFilter })}
      </main>
    </div>
  );
}

function titleFor(segments: string[]): string {
  switch (segments[0]) {
    case undefined:
      return 'Dashboard';
    case 'repos':
      return segments[1] ? 'Repo detail' : 'Repos';
    case 'runs':
      return segments[1] ? 'Run detail' : 'Runs';
    case 'flavors':
      return 'Flavors';
    case 'settings':
      return 'Settings';
    case 'setup':
      return 'Setup';
    default:
      return 'Not found';
  }
}

function renderRoute(
  segments: string[],
  ctx: { installationId?: number; navigate: (to: string) => void; repoFilter: string | null },
): JSX.Element {
  const [head, a, b, c] = segments;
  switch (head) {
    case undefined:
      return <Dashboard installationId={ctx.installationId} navigate={ctx.navigate} />;
    case 'repos':
      return a ? (
        <RepoDetail installationId={ctx.installationId} repoId={Number(a)} navigate={ctx.navigate} />
      ) : (
        <Repos installationId={ctx.installationId} navigate={ctx.navigate} />
      );
    case 'runs':
      return a && b && c ? (
        <RunDetail repoId={Number(a)} runId={Number(b)} jobId={Number(c)} />
      ) : (
        <Runs
          repoFilter={ctx.repoFilter ? Number(ctx.repoFilter) : undefined}
          navigate={ctx.navigate}
        />
      );
    case 'flavors':
      return <Flavors />;
    case 'settings':
      return <Settings />;
    case 'setup':
      return <Setup />;
    default:
      return <p className="muted">Not found.</p>;
  }
}

function Login(): JSX.Element {
  return (
    <div className="login">
      <div className="card">
        <h2>LambdaCIActions</h2>
        <p className="muted">Sign in with GitHub to manage runners, repos, and runs.</p>
        <p>
          <a className="badge" href="/auth/login">
            Sign in with GitHub
          </a>
        </p>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
