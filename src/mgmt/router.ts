/**
 * Pure request router for the Management API (spec 04 § Management API).
 *
 * Kept free of AWS + I/O so the whole route table — including path-param extraction and
 * method mismatch behavior — is unit-testable. The Lambda handler maps API Gateway HTTP
 * API v2 events onto `matchRoute` and then executes the matched route's logic.
 */

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Every route the Mgmt API serves. `authRequired: false` only for login/callback/health. */
export interface RouteDef {
  id: RouteId;
  method: Method;
  /** Path template; `{name}` segments are captured as params. */
  template: string;
  authRequired: boolean;
}

export type RouteId =
  | 'me'
  | 'authLogin'
  | 'authCallback'
  | 'authLogout'
  | 'listInstallations'
  | 'listRepos'
  | 'patchRepo'
  | 'listWorkflows'
  | 'rescanRepo'
  | 'getFlavorMap'
  | 'putFlavorMap'
  | 'rewritePreview'
  | 'rewritePr'
  | 'listRuns'
  | 'getRun'
  | 'getRunLogs'
  | 'listFlavors'
  | 'health'
  | 'settings'
  | 'putRunnerLabels'
  | 'relinkGithubApp'
  | 'rollbackGithubApp'
  | 'testWebhook';

export const ROUTES: readonly RouteDef[] = [
  // --- auth (unauthenticated by definition) ---
  { id: 'authLogin', method: 'GET', template: '/auth/login', authRequired: false },
  { id: 'authCallback', method: 'GET', template: '/auth/callback', authRequired: false },
  { id: 'authLogout', method: 'POST', template: '/auth/logout', authRequired: false },
  // --- session introspection ---
  { id: 'me', method: 'GET', template: '/api/me', authRequired: true },
  // --- installations + repos ---
  { id: 'listInstallations', method: 'GET', template: '/api/installations', authRequired: true },
  { id: 'listRepos', method: 'GET', template: '/api/repos', authRequired: true },
  { id: 'patchRepo', method: 'PATCH', template: '/api/repos/{repoId}', authRequired: true },
  { id: 'listWorkflows', method: 'GET', template: '/api/repos/{repoId}/workflows', authRequired: true },
  { id: 'rescanRepo', method: 'POST', template: '/api/repos/{repoId}/rescan', authRequired: true },
  { id: 'getFlavorMap', method: 'GET', template: '/api/repos/{repoId}/flavor-map', authRequired: true },
  { id: 'putFlavorMap', method: 'PUT', template: '/api/repos/{repoId}/flavor-map', authRequired: true },
  // Auto-rewrite (M5, ADR-031). GET is a pure dry-run diff — always available, writes nothing.
  // POST enqueues the PR and is refused unless the deployment flag AND the repo opt-in are on.
  { id: 'rewritePreview', method: 'GET', template: '/api/repos/{repoId}/rewrite-pr', authRequired: true },
  { id: 'rewritePr', method: 'POST', template: '/api/repos/{repoId}/rewrite-pr', authRequired: true },
  // --- runs ---
  { id: 'listRuns', method: 'GET', template: '/api/runs', authRequired: true },
  { id: 'getRun', method: 'GET', template: '/api/runs/{repoId}/{runId}/{jobId}', authRequired: true },
  { id: 'getRunLogs', method: 'GET', template: '/api/runs/{repoId}/{runId}/{jobId}/logs', authRequired: true },
  // --- platform ---
  { id: 'listFlavors', method: 'GET', template: '/api/flavors', authRequired: true },
  { id: 'health', method: 'GET', template: '/api/health', authRequired: true },
  { id: 'settings', method: 'GET', template: '/api/settings', authRequired: true },
  // --- settings mutations (spec 04 § Settings, ADR-034) ---
  {
    id: 'putRunnerLabels',
    method: 'PUT',
    template: '/api/settings/runner-labels',
    authRequired: true,
  },
  {
    id: 'relinkGithubApp',
    method: 'POST',
    template: '/api/settings/github-app/relink',
    authRequired: true,
  },
  {
    id: 'rollbackGithubApp',
    method: 'POST',
    template: '/api/settings/github-app/rollback',
    authRequired: true,
  },
  {
    id: 'testWebhook',
    method: 'POST',
    template: '/api/settings/webhook/test',
    authRequired: true,
  },
];

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
}

export type MatchResult =
  | { kind: 'match'; match: RouteMatch }
  /** Path exists but not for this method — 405 with the allowed set. */
  | { kind: 'method-not-allowed'; allow: Method[] }
  | { kind: 'not-found' };

function splitPath(p: string): string[] {
  return p.replace(/\/+$/, '').split('/').filter((s) => s.length > 0);
}

function matchTemplate(
  template: string,
  segments: string[],
): Record<string, string> | undefined {
  const tSegs = splitPath(template);
  if (tSegs.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < tSegs.length; i++) {
    const t = tSegs[i];
    if (t.startsWith('{') && t.endsWith('}')) {
      const name = t.slice(1, -1);
      // A malformed percent-escape (`/api/runs/%/2/3`) makes decodeURIComponent throw. This
      // runs before the handler's error boundary, so swallow it and keep the raw segment —
      // every param is subsequently validated (asPositiveInt) and will 400, not 500.
      let value: string;
      try {
        value = decodeURIComponent(segments[i]);
      } catch {
        value = segments[i];
      }
      if (value.length === 0) return undefined;
      params[name] = value;
    } else if (t !== segments[i]) {
      return undefined;
    }
  }
  return params;
}

/** Resolve (method, path) against the route table. */
export function matchRoute(method: string, path: string): MatchResult {
  const segments = splitPath(path);
  const pathMatches: RouteDef[] = [];
  for (const route of ROUTES) {
    const params = matchTemplate(route.template, segments);
    if (!params) continue;
    pathMatches.push(route);
    if (route.method === method.toUpperCase()) {
      return { kind: 'match', match: { route, params } };
    }
  }
  if (pathMatches.length > 0) {
    return { kind: 'method-not-allowed', allow: pathMatches.map((r) => r.method) };
  }
  return { kind: 'not-found' };
}

/** Parse a positive-integer path/query param; undefined when absent or malformed. */
export function asPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
