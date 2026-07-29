/**
 * Pure logic for the GitHub App config broker (ADR-029).
 *
 * The management plane must be able to (a) show the operator which GitHub App this
 * environment is actually linked to and whether GitHub can reach our webhook, and (b)
 * re-link the environment to a rotated/replacement App. Both need the App private key,
 * and (b) needs `ssm:PutParameter` on SecureString paths.
 *
 * Handing either to the Mgmt λ would break ADR-025 (the console λ deliberately cannot read
 * the App PEM, so no console bug can leak it) and would put write authority over every
 * platform secret behind an internet-facing, cookie-authenticated surface. So the authority
 * stays in the control plane behind ONE brokered function — exactly the shape ADR-021 uses
 * for microVMs — and the Mgmt λ holds nothing but `lambda:InvokeFunction` on that ARN.
 *
 * Everything here is AWS-free + side-effect-free so the request contract, the credential
 * validation and (critically) the response redaction are unit-testable.
 */
import { assertNoSecrets, redactLiterals, safeForLog, scrubForOperator } from '../shared/redact.js';

export { assertNoSecrets, redactLiterals, safeForLog, scrubForOperator };

/** Operations the management plane may ask the broker to perform. */
export const APPCFG_ACTIONS = [
  'status',
  'relink',
  'rollback',
  'redeliver',
  'setRunnerLabels',
] as const;
export type AppcfgAction = (typeof APPCFG_ACTIONS)[number];

/** Credentials an operator submits when re-linking (write-only intake — never echoed). */
export interface AppCredentialsInput {
  appId: string;
  pem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

export interface AppcfgRequest {
  action: AppcfgAction;
  /** GitHub login of the operator, for the audit row. */
  actor: string;
  /** action=relink only. */
  credentials?: AppCredentialsInput;
  /** action=rollback only — the parameter versions to restore (from a prior relink). */
  restore?: ParameterVersionSnapshot;
  /** action=redeliver only; omitted ⇒ re-deliver the most recent delivery. */
  deliveryId?: number;
  /** action=setRunnerLabels only — the serialized (comma-separated) claim list. */
  labels?: string;
}

/**
 * The SSM parameter versions in effect BEFORE a relink. Rollback re-reads those exact
 * versions and re-puts them, so we never keep a copy of a secret value anywhere — SSM's own
 * parameter history is the only store (`GetParameter Name:version`).
 */
export type ParameterVersionSnapshot = Record<string, number>;

/** The credential parameters a relink replaces, relative to the env's SSM prefix. */
export const APP_CREDENTIAL_PARAMS = [
  'github/app-id',
  'github/app-pem',
  'github/webhook-secret',
  'github/client-id',
  'github/client-secret',
] as const;

/** Which of those are SecureString (values never leave SSM except into this broker). */
export const SECURE_CREDENTIAL_PARAMS: readonly string[] = [
  'github/app-pem',
  'github/webhook-secret',
  'github/client-secret',
];

export class AppcfgRequestError extends Error {}

/**
 * Validate an inbound broker request. The caller is the Mgmt λ (trusted-ish: it is our own
 * code, but it is the surface an operator's browser reaches), so this is an allow-list, not
 * a formality — an unrecognized action or a malformed credential set is a hard reject before
 * any GitHub call or SSM write happens.
 */
export function parseAppcfgRequest(raw: unknown): AppcfgRequest {
  const req = (raw ?? {}) as Partial<AppcfgRequest>;
  const action = req.action;
  if (!action || !(APPCFG_ACTIONS as readonly string[]).includes(action)) {
    throw new AppcfgRequestError(`unsupported action: ${safeForLog(action)}`);
  }
  const actor = typeof req.actor === 'string' ? req.actor.trim() : '';
  if (!actor || actor.length > 64) throw new AppcfgRequestError('actor required');

  if (action === 'relink') {
    const creds = validateAppCredentials(req.credentials);
    if (!creds.ok) throw new AppcfgRequestError(creds.errors.join('; '));
    return { action, actor, credentials: creds.value };
  }
  if (action === 'rollback') {
    const restore = validateVersionSnapshot(req.restore);
    if (!restore.ok) throw new AppcfgRequestError(restore.errors.join('; '));
    return { action, actor, restore: restore.value };
  }
  if (action === 'redeliver') {
    const id = req.deliveryId;
    if (id !== undefined && !(Number.isSafeInteger(id) && id > 0)) {
      throw new AppcfgRequestError('deliveryId must be a positive integer');
    }
    return { action, actor, ...(id === undefined ? {} : { deliveryId: id }) };
  }
  if (action === 'setRunnerLabels') {
    // The management API validates labels field-by-field before forwarding; re-check the
    // serialized form here so the broker never writes a value it hasn't inspected itself.
    const labels = typeof req.labels === 'string' ? req.labels.trim() : '';
    if (!labels) throw new AppcfgRequestError('labels required');
    if (!/^[a-z0-9][a-z0-9._-]*(,[a-z0-9][a-z0-9._-]*)*$/.test(labels)) {
      throw new AppcfgRequestError('labels must be a comma-separated list of normalized labels');
    }
    if (labels.length > 512) throw new AppcfgRequestError('labels value too long');
    return { action, actor, labels };
  }
  return { action, actor };
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const PEM_HEAD = /^-----BEGIN (RSA )?PRIVATE KEY-----/;
const PEM_TAIL = /-----END (RSA )?PRIVATE KEY-----\s*$/;

/**
 * Shape-check submitted App credentials.
 *
 * Deliberately structural only — the real gate is the live verification (mint an App JWT,
 * `GET /app`) the broker performs BEFORE writing anything. Error strings must never quote a
 * submitted value, or a validation failure would echo a secret back through the API.
 */
export function validateAppCredentials(input: unknown): Validated<AppCredentialsInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['credentials must be an object'] };
  }
  const c = input as Record<string, unknown>;
  const errors: string[] = [];
  const allowed = new Set(['appId', 'pem', 'webhookSecret', 'clientId', 'clientSecret']);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) errors.push(`unknown credential field "${safeForLog(key)}"`);
  }

  const appId = typeof c.appId === 'string' ? c.appId.trim() : String(c.appId ?? '');
  if (!/^\d{1,12}$/.test(appId)) errors.push('appId must be a numeric GitHub App id');

  const pem = typeof c.pem === 'string' ? c.pem.trim() : '';
  if (!pem) errors.push('pem is required');
  else if (!PEM_HEAD.test(pem) || !PEM_TAIL.test(pem)) {
    // Wording avoids the literal PEM marker text on purpose: every validation error is
    // operator-facing, and the redaction guard treats that marker as secret-shaped, so an
    // error quoting it would be indistinguishable from a leak.
    errors.push('pem must be a PEM-encoded RSA key, including its BEGIN and END delimiter lines');
  } else if (pem.length > 16384) errors.push('pem is implausibly large');

  const webhookSecret = typeof c.webhookSecret === 'string' ? c.webhookSecret : '';
  // GitHub generates 20+ char secrets; anything short is almost certainly a paste error and
  // would silently make every future delivery fail its HMAC check.
  if (webhookSecret.length < 16) errors.push('webhookSecret must be at least 16 characters');
  if (webhookSecret.length > 512) errors.push('webhookSecret is implausibly large');

  const clientId = typeof c.clientId === 'string' ? c.clientId.trim() : '';
  if (!/^(Iv1\.[A-Za-z0-9]+|Iv23li[A-Za-z0-9]+|[A-Za-z0-9._-]{8,64})$/.test(clientId)) {
    errors.push('clientId must be a GitHub App OAuth client id');
  }

  const clientSecret = typeof c.clientSecret === 'string' ? c.clientSecret : '';
  if (clientSecret.length < 20) errors.push('clientSecret must be at least 20 characters');
  if (clientSecret.length > 512) errors.push('clientSecret is implausibly large');

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { appId, pem, webhookSecret, clientId, clientSecret } };
}

/** Validate a rollback snapshot: known parameter suffixes → positive SSM version numbers. */
export function validateVersionSnapshot(input: unknown): Validated<ParameterVersionSnapshot> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['restore must be an object of parameter → version'] };
  }
  const known = new Set<string>(APP_CREDENTIAL_PARAMS);
  const out: ParameterVersionSnapshot = {};
  const errors: string[] = [];
  for (const [name, version] of Object.entries(input as Record<string, unknown>)) {
    if (!known.has(name)) {
      errors.push(`restore contains unknown parameter "${safeForLog(name)}"`);
      continue;
    }
    if (!Number.isSafeInteger(version) || (version as number) < 1) {
      errors.push(`restore["${name}"] must be a positive SSM version`);
      continue;
    }
    out[name] = version as number;
  }
  if (!errors.length && Object.keys(out).length === 0) {
    errors.push('restore must name at least one parameter version');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/**
 * Response shapes. Note what is ABSENT: no PEM, no webhook secret, no client secret, no
 * masked-secret placeholder from GitHub. The broker's contract is that a relink answers with
 * *presence + verification outcome* only (AGENTS.md hard rule).
 */
export interface AppLinkageView {
  /** Verified live from GitHub with the stored credentials, or null when that failed. */
  app: {
    appId: number;
    name: string;
    slug: string;
    htmlUrl: string;
    ownerLogin: string;
    events: string[];
    permissions: Record<string, string>;
  } | null;
  /** Why verification failed (sanitized), when `app` is null. */
  verifyError?: string;
  /** App id recorded in SSM — shown alongside `app.appId` so a mismatch is visible. */
  configuredAppId?: string;
  installations: { installationId: number; accountLogin: string; suspended: boolean }[];
  webhook: {
    /** URL GitHub is configured to deliver to (from GitHub, not from our config). */
    configuredUrl: string;
    contentType: string;
    insecureSsl: boolean;
    secretConfigured: boolean;
    recentDeliveries: {
      id: number;
      event: string;
      action: string | null;
      status: string;
      statusCode: number;
      deliveredAt: string;
      durationMs: number;
      redelivery: boolean;
    }[];
  } | null;
  webhookError?: string;
}

export interface AppcfgResult {
  ok: boolean;
  error?: string;
  /** True when the action was refused because another config change holds the lock. */
  busy?: boolean;
  /** action=status. */
  linkage?: AppLinkageView;
  /** action=relink / rollback. */
  verified?: boolean;
  appId?: number;
  appSlug?: string;
  /** Whether GitHub's own hook config was updated to match the stored secret/URL. */
  hookSynced?: boolean;
  /** Why the hook-config update failed (the App may not own its hook config). */
  hookError?: string;
  /**
   * Versions replaced by a relink — the operator's rollback handle. Version NUMBERS are not
   * secrets; the values behind them stay in SSM.
   */
  replacedVersions?: ParameterVersionSnapshot;
  /** True when a failed relink was rolled back to the previous versions. */
  rolledBack?: boolean;
  /** action=redeliver. */
  redelivered?: boolean;
  deliveryId?: number;
  /** action=setRunnerLabels — the labels now in effect. */
  labels?: string[];
}
