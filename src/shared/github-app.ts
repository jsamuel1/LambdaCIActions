import crypto from 'node:crypto';
import { redactLiterals } from './redact.js';

/**
 * GitHub App authentication chain (spec 01):
 *
 *   App PEM (SSM) → sign App JWT (RS256, <=10 min)
 *     → POST /app/installations/{id}/access_tokens → installation token (~60 min)
 *       → POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig → single-use JIT
 *
 * Zero external deps — node:crypto for RS256, global fetch for the API. Installation
 * tokens are cached per-installation until near expiry to respect rate limits.
 */

const GITHUB_API = 'https://api.github.com';
const UA = 'LambdaCIActions';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build a signed App JWT (RS256). `iat` is backdated 60s to tolerate clock skew; `exp` is
 * capped at GitHub's 10-minute maximum.
 */
export function createAppJwt(appId: string, pem: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const exp = iat + 9 * 60; // 9 min — safely under the 10-min ceiling
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: appId };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(pem));
  return `${signingInput}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<number, CachedToken>();

async function githubJson<T>(
  path: string,
  init: {
    method?: string;
    token: string;
    tokenType: 'Bearer' | 'token';
    body?: unknown;
    /**
     * Plaintext secrets present in THIS request, redacted by literal value from any error
     * text. GitHub (or a proxy in front of it) can quote a rejected request value back, and an
     * opaque secret like a webhook secret has no shape the pattern guard can recognize.
     */
    redactValues?: readonly (string | undefined)[];
  },
): Promise<{ status: number; body: T }> {
  const clean = (text: string): string => redactLiterals(text, init.redactValues ?? []);
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `${init.tokenType} ${init.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: T;
  let parsed = true;
  try {
    body = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    parsed = false;
    body = {} as T;
  }
  if (!parsed) {
    // Do NOT echo the raw body: a non-JSON response comes from an intermediary (proxy, WAF,
    // error page) which may reflect the request — including a submitted credential.
    throw new Error(
      `GitHub ${path} returned non-JSON (HTTP ${res.status}, ${text.length} bytes)` +
        requestIdOf(res),
    );
  }
  if (res.status >= 400) {
    // Only GitHub's own `message` field, never the raw body, and literal-redacted on top:
    // 422 validation errors quote the offending request value back.
    const message = (body as { message?: unknown }).message;
    const detail = typeof message === 'string' ? `: ${clean(message).slice(0, 200)}` : '';
    throw new Error(`GitHub ${path} failed HTTP ${res.status}${requestIdOf(res)}${detail}`);
  }
  return { status: res.status, body };
}

/** GitHub's request id, so an operator-facing error is still traceable in a support ticket. */
function requestIdOf(res: { headers: { get(name: string): string | null } }): string {
  const id = res.headers?.get?.('x-github-request-id');
  return id ? ` (request ${id.replace(/[^\x20-\x7e]/g, '').slice(0, 64)})` : '';
}

/**
 * Mint (or reuse a cached) installation token. Cached until 5 minutes before expiry to
 * cut API calls; a leaked token is short-lived anyway.
 */
export async function getInstallationToken(
  appId: string,
  pem: string,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;

  const jwt = createAppJwt(appId, pem);
  const { body } = await githubJson<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: 'POST', token: jwt, tokenType: 'Bearer' },
  );
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: new Date(body.expires_at).getTime(),
  });
  return body.token;
}

/**
 * Generate a single-use JIT runner config for one repo (ADR-003). The returned
 * `encoded_jit_config` is consumed by `run.sh --jitconfig` inside the microVM; labels and
 * work dir are fixed at mint time so the runner can't self-relabel.
 */
export async function generateJitConfig(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  runId: number;
  jobId: number;
  labels: string[];
}): Promise<string> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  // Runner name must be unique per registration; scope it to the job.
  const name = `lca-${params.runId}-${params.jobId}-${crypto.randomBytes(4).toString('hex')}`;
  const { body } = await githubJson<{ encoded_jit_config: string }>(
    `/repos/${params.owner}/${params.repo}/actions/runners/generate-jitconfig`,
    {
      method: 'POST',
      token,
      tokenType: 'token',
      body: {
        name,
        runner_group_id: 1, // repo-level default group (spec 01 OQ-1: repo-level v1)
        labels: params.labels,
        work_folder: '_work',
      },
    },
  );
  return body.encoded_jit_config;
}

/** Test hook. */
export function _clearTokenCache(): void {
  tokenCache.clear();
}

// ---- operator OAuth (spec 04 § Auth, M4) ------------------------------------

/** GitHub's OAuth authorize endpoint (web flow). */
export const OAUTH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Exchange an OAuth `code` for a **user** access token (spec 04 § Auth). The token is used
 * once — to identify the operator and enumerate the installations they may administer —
 * and is then discarded; it is never persisted or put in the session cookie (ADR-022).
 */
export async function exchangeOauthCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });
  const text = await res.text();
  let body: { access_token?: string; error?: string; error_description?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`GitHub OAuth token exchange returned non-JSON (HTTP ${res.status})`);
  }
  if (!body.access_token) {
    throw new Error(
      `GitHub OAuth token exchange failed: ${body.error ?? `HTTP ${res.status}`}` +
        (body.error_description ? ` — ${body.error_description}` : ''),
    );
  }
  return body.access_token;
}

/** The authenticated operator's GitHub login. */
export async function getOauthUser(userToken: string): Promise<{ login: string; id: number }> {
  const { body } = await githubJson<{ login: string; id: number }>('/user', {
    token: userToken,
    tokenType: 'Bearer',
  });
  return { login: body.login, id: body.id };
}

/**
 * Installations of THIS App that the user can see (`GET /user/installations`).
 *
 * Authorization for the whole management API derives from this list: GitHub only returns
 * installations on accounts/repos the user has access to, so we never have to interpret
 * org roles ourselves. Filtered to admin-capable accounts by GitHub's own semantics.
 */
export async function listUserInstallations(
  userToken: string,
): Promise<{ installationId: number; accountLogin: string }[]> {
  const { body } = await githubJson<{
    installations?: { id: number; account?: { login?: string } }[];
  }>('/user/installations?per_page=100', { token: userToken, tokenType: 'Bearer' });
  return (body.installations ?? []).map((i) => ({
    installationId: i.id,
    accountLogin: i.account?.login ?? '',
  }));
}

// ---- App identity + webhook introspection (spec 04 Settings, ADR-034) --------

/** Identity of the App the environment's stored credentials actually authenticate as. */
export interface AppIdentity {
  appId: number;
  name: string;
  slug: string;
  htmlUrl: string;
  ownerLogin: string;
  events: string[];
  permissions: Record<string, string>;
}

/**
 * `GET /app` with an App JWT — the live proof that the stored `app-id` + `app-pem` pair is
 * valid and which App it belongs to. The Settings screen shows THIS rather than parroting
 * SSM back, so "App linked" can never be green while the credentials are broken.
 */
export async function getAppIdentity(appId: string, pem: string): Promise<AppIdentity> {
  const jwt = createAppJwt(appId, pem);
  const { body } = await githubJson<{
    id: number;
    name: string;
    slug: string;
    html_url: string;
    owner?: { login?: string };
    events?: string[];
    permissions?: Record<string, string>;
  }>('/app', { token: jwt, tokenType: 'Bearer' });
  return {
    appId: body.id,
    name: body.name,
    slug: body.slug,
    htmlUrl: body.html_url,
    ownerLogin: body.owner?.login ?? '',
    events: body.events ?? [],
    permissions: body.permissions ?? {},
  };
}

/** Every installation of the App, from GitHub (not our store) — App JWT scoped. */
export async function listAppInstallations(
  appId: string,
  pem: string,
): Promise<{ installationId: number; accountLogin: string; suspended: boolean }[]> {
  const jwt = createAppJwt(appId, pem);
  const { body } = await githubJson<
    { id: number; account?: { login?: string }; suspended_at?: string | null }[]
  >('/app/installations?per_page=100', { token: jwt, tokenType: 'Bearer' });
  if (!Array.isArray(body)) return [];
  return body.map((i) => ({
    installationId: i.id,
    accountLogin: i.account?.login ?? '',
    suspended: Boolean(i.suspended_at),
  }));
}

/**
 * The App's webhook configuration (`GET /app/hook/config`, App JWT).
 *
 * GitHub returns the webhook `secret` field as a masked placeholder, never the real value —
 * we drop the field entirely anyway and report only whether one is configured, so no code
 * path can carry it toward the UI (AGENTS.md hard rule).
 */
export interface AppHookConfig {
  url: string;
  contentType: string;
  insecureSsl: boolean;
  secretConfigured: boolean;
}

export async function getAppHookConfig(appId: string, pem: string): Promise<AppHookConfig> {
  const jwt = createAppJwt(appId, pem);
  const { body } = await githubJson<{
    url?: string;
    content_type?: string;
    insecure_ssl?: string | number;
    secret?: string;
  }>('/app/hook/config', { token: jwt, tokenType: 'Bearer' });
  return {
    url: body.url ?? '',
    contentType: body.content_type ?? '',
    insecureSsl: String(body.insecure_ssl ?? '0') !== '0',
    secretConfigured: typeof body.secret === 'string' && body.secret.length > 0,
  };
}

/**
 * Point the App's webhook at this deployment and set the signing secret
 * (`PATCH /app/hook/config`, App JWT).
 *
 * This is REQUIRED for a relink to be coherent, not a convenience. Storing a new
 * `webhook-secret` in SSM without telling GitHub means GitHub keeps signing with the old one
 * and Ingest's HMAC check rejects every subsequent delivery (401) — a rotation would silently
 * take the environment offline. Same for the URL: a freshly created App points wherever its
 * manifest said, which is not necessarily this deployment.
 *
 * The secret travels OUT to GitHub only; nothing is read back (GitHub masks it anyway) and
 * this function returns no value.
 */
export async function updateAppHookConfig(
  appId: string,
  pem: string,
  config: { url?: string; secret?: string },
): Promise<void> {
  const body: Record<string, string> = { content_type: 'json', insecure_ssl: '0' };
  if (config.url) body.url = config.url;
  if (config.secret) body.secret = config.secret;
  const jwt = createAppJwt(appId, pem);
  await githubJson<unknown>('/app/hook/config', {
    method: 'PATCH',
    token: jwt,
    tokenType: 'Bearer',
    body,
    // The webhook secret is the one plaintext we send to GitHub on this path; if GitHub
    // rejects the request and quotes it back, it must not survive into `hookError`.
    redactValues: [config.secret],
  });
}

/** One row of GitHub's own delivery log for the App's webhook. */
export interface AppHookDelivery {
  id: number;
  guid: string;
  event: string;
  action: string | null;
  status: string;
  statusCode: number;
  deliveredAt: string;
  durationMs: number;
  redelivery: boolean;
}

/**
 * `GET /app/hook/deliveries` — GitHub's view of whether it can actually reach us. This is
 * the only *external* evidence of webhook health: our own heartbeat row proves deliveries
 * that arrived, this proves the ones that did not (wrong URL after a redeploy, 5xx, TLS).
 */
export async function listAppHookDeliveries(
  appId: string,
  pem: string,
  perPage = 20,
): Promise<AppHookDelivery[]> {
  const jwt = createAppJwt(appId, pem);
  const { body } = await githubJson<
    {
      id: number;
      guid: string;
      event: string;
      action: string | null;
      status: string;
      status_code: number;
      delivered_at: string;
      duration: number;
      redelivery: boolean;
    }[]
  >(`/app/hook/deliveries?per_page=${Math.min(Math.max(perPage, 1), 100)}`, {
    token: jwt,
    tokenType: 'Bearer',
  });
  if (!Array.isArray(body)) return [];
  return body.map((d) => ({
    id: d.id,
    guid: d.guid,
    event: d.event,
    action: d.action ?? null,
    status: d.status,
    statusCode: d.status_code,
    deliveredAt: d.delivered_at,
    // GitHub reports duration in seconds (float).
    durationMs: Math.round((d.duration ?? 0) * 1000),
    redelivery: Boolean(d.redelivery),
  }));
}

/**
 * Ask GitHub to re-deliver a past delivery (`POST /app/hook/deliveries/{id}/attempts`).
 * This is the "Test webhook delivery" round-trip: GitHub re-sends a real, signature-signed
 * payload, so a success proves URL + TLS + our webhook secret all still agree.
 */
export async function redeliverAppHook(
  appId: string,
  pem: string,
  deliveryId: number,
): Promise<void> {
  const jwt = createAppJwt(appId, pem);
  await githubJson<unknown>(`/app/hook/deliveries/${deliveryId}/attempts`, {
    method: 'POST',
    token: jwt,
    tokenType: 'Bearer',
  });
}

// ---- workflow discovery (spec 03 § Discovery) -------------------------------

/** A workflow file listed under `.github/workflows` (subset of the contents API shape). */
export interface WorkflowFileRef {
  path: string;
  sha: string;
}

/**
 * List `*.yml|*.yaml` files under `.github/workflows` for a repo (contents:read).
 * A repo without the directory (404) yields `[]` — not an error.
 */
export async function listWorkflowFiles(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
}): Promise<WorkflowFileRef[]> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  let body: { type: string; path: string; sha: string; name: string }[];
  try {
    ({ body } = await githubJson<{ type: string; path: string; sha: string; name: string }[]>(
      `/repos/${params.owner}/${params.repo}/contents/.github/workflows`,
      { token, tokenType: 'token' },
    ));
  } catch (err) {
    // No workflows directory → nothing to ingest.
    if (err instanceof Error && err.message.includes('HTTP 404')) return [];
    throw err;
  }
  if (!Array.isArray(body)) return [];
  return body
    .filter((f) => f.type === 'file' && /\.ya?ml$/i.test(f.name))
    .map((f) => ({ path: f.path, sha: f.sha }));
}

/**
 * Fetch one file's raw contents (contents:read). The contents API returns base64 for
 * files ≤ 1 MB — plenty for workflow YAML.
 */
export async function getFileContent(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  path: string;
}): Promise<{ content: string; sha: string }> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  const { body } = await githubJson<{ content?: string; encoding?: string; sha: string }>(
    `/repos/${params.owner}/${params.repo}/contents/${encodeURI(params.path)}`,
    { token, tokenType: 'token' },
  );
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error(`GitHub contents for '${params.path}' not base64 (encoding=${body.encoding})`);
  }
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}
