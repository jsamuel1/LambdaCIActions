import crypto from 'node:crypto';

/**
 * Operator session (spec 04 § Auth, ADR-022).
 *
 * v1 is **GitHub-OAuth-only with a server-signed stateless session** — no Cognito, no
 * session table. The session is a compact JSON payload, HMAC-SHA256 signed with a secret
 * from SSM (`/lca/<env>/mgmt/session-secret`) and delivered as a `HttpOnly; Secure;
 * SameSite=Lax` cookie. It carries:
 *
 *   - who the operator is (`login`), and
 *   - the installations they may administer (resolved from GitHub at login and cached).
 *
 * The GitHub **user token is never put in the cookie** — it is used once at login to
 * resolve installation admin rights, then discarded. That keeps a stolen cookie from
 * being replayed against the GitHub API, at the cost of re-login when access changes
 * (bounded by the session TTL).
 *
 * Everything here is pure (node:crypto only) so it is unit-testable without AWS.
 */

/** Session lifetime: 8 h — one working day, then the operator re-authenticates. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export const SESSION_COOKIE = 'lca_session';
export const OAUTH_STATE_COOKIE = 'lca_oauth_state';

/** An installation the session holder is allowed to administer. */
export interface SessionInstallation {
  installationId: number;
  accountLogin: string;
}

export interface SessionPayload {
  /** GitHub login of the operator. */
  login: string;
  /** Installations resolved as admin-visible at login time. */
  installations: SessionInstallation[];
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

/** Encode + sign a session. Format: `<base64url(json)>.<base64url(hmac)>`. */
export function encodeSession(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  secret: string,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const full: SessionPayload = { ...payload, iat, exp: iat + SESSION_TTL_SECONDS };
  const body = b64url(JSON.stringify(full));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify + decode a session token. Returns undefined for anything untrustworthy:
 * malformed, bad signature (constant-time compared), or expired.
 */
export function decodeSession(
  token: string | undefined,
  secret: string,
  now: Date = new Date(),
): SessionPayload | undefined {
  if (!token) return undefined;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return undefined;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  let parsed: SessionPayload;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return undefined;
  }
  if (typeof parsed?.login !== 'string' || !Array.isArray(parsed?.installations)) return undefined;
  if (typeof parsed.exp !== 'number' || parsed.exp <= Math.floor(now.getTime() / 1000)) {
    return undefined;
  }
  return parsed;
}

/**
 * Parse a `Cookie:` header into a map. Tolerates spaces + empty segments.
 *
 * Decoding is per-segment and fault-tolerant: a client can send an arbitrary cookie value,
 * and `decodeURIComponent` throws `URIError` on a malformed escape (e.g. `lca_session=%`).
 * Since this runs on the entry path for every request, a throw here would surface as an
 * unhandled 500 rather than the intended 401 — so an undecodable value is kept raw (it will
 * simply fail signature verification).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const raw = seg.slice(eq + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    out[seg.slice(0, eq).trim()] = value;
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  /** Cleared cookies set Max-Age=0. */
  clear?: boolean;
}

/**
 * Build a `Set-Cookie` value. Always `HttpOnly; Secure; SameSite=Lax; Path=/` — the SPA
 * and the API are same-origin behind one CloudFront distribution (ADR-024), so Lax is
 * sufficient for the OAuth redirect round-trip and no cross-site posting is possible.
 */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (opts.clear) parts.push('Max-Age=0');
  else if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join('; ');
}

/** Sign an OAuth `state` nonce so the callback can prove it issued the redirect. */
export function signState(nonce: string, secret: string): string {
  return `${nonce}.${sign(nonce, secret)}`;
}

/** Verify a signed OAuth state value against the nonce echoed back by GitHub. */
export function verifyState(state: string | undefined, secret: string): string | undefined {
  if (!state) return undefined;
  const dot = state.indexOf('.');
  if (dot <= 0) return undefined;
  const nonce = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = sign(nonce, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  return nonce;
}

/** Whether the session may administer an installation (authorization gate, spec 04). */
export function canAdminInstallation(session: SessionPayload, installationId: number): boolean {
  return session.installations.some((i) => i.installationId === installationId);
}

/**
 * Whether the session may perform **platform-wide** mutations (re-link the GitHub App,
 * change the environment's runner labels, trigger a webhook redelivery) — spec 04 § Settings,
 * ADR-034.
 *
 * Installation admin rights are NOT sufficient. GitHub's access model answers "may this
 * person administer this installation", which is the right question for repo config but the
 * wrong one here: an environment can host several installations, and any one of their admins
 * could otherwise re-point the whole platform's credentials or stop every other tenant's jobs
 * from being claimed. GitHub has no notion of "admin of this deployment", so the platform
 * keeps its own explicit allow-list (`/lca/<env>/config/platform-admins`, a comma-separated
 * list of GitHub logins).
 *
 * **Fails CLOSED**: an unset/empty allow-list authorizes nobody. Settings remains readable,
 * so a fresh environment shows its state and tells the operator to set the parameter, rather
 * than silently granting platform authority to the first person who logs in.
 */
export function canAdminPlatform(session: SessionPayload, admins: string[]): boolean {
  if (!admins.length) return false;
  const login = session.login.toLowerCase();
  return admins.some((a) => a.trim().toLowerCase() === login);
}

/** Parse the comma-separated platform-admin allow-list from config. */
export function parsePlatformAdmins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The installation ids this session holds a grant for (ADR-022). Named so the reconcile
 * candidate set `listInstallations` takes has ONE canonical source: an inline
 * `session.installations.map(...)` at the call site is indistinguishable from `[]` to a
 * reader, and `listInstallations([])` restores the pre-ADR-037 index-only blindness with no
 * type error. `test/install-store-gsi1.test.mjs` pins the route to this helper.
 */
export function grantedInstallationIds(session: SessionPayload): number[] {
  return session.installations.map((i) => i.installationId);
}
