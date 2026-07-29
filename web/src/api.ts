/**
 * Typed client for the Management API (spec 04).
 *
 * Same-origin by construction: the console and the API share one CloudFront distribution
 * (ADR-024), so requests are relative and the session cookie rides along automatically.
 * A 401 anywhere means the session expired → callers surface the login prompt.
 */

export class UnauthorizedError extends Error {
  constructor() {
    super('not authenticated');
    this.name = 'UnauthorizedError';
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new UnauthorizedError();
  const text = await res.text();
  // The API always answers JSON, but an edge/proxy error page might not — don't turn that
  // into an unhelpful SyntaxError.
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
      throw new ApiError(res.status, 'unexpected non-JSON response');
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, String(body.error ?? `HTTP ${res.status}`), body.details);
  }
  return body as T;
}

// ---- shapes (mirror src/mgmt/views.ts) -------------------------------------

export type RunStatus = 'queued' | 'provisioning' | 'running' | 'completed' | 'failed' | 'timed_out';
export type CompatLevel = 'ok' | 'warn' | 'risk' | 'block';

export interface Me {
  login: string;
  installations: { installationId: number; accountLogin: string }[];
  expiresAt: string;
}

export interface Installation {
  installationId: number;
  accountLogin: string;
  suspended: boolean;
  deleted: boolean;
  updatedAt: string;
}

export interface CompatRollup { ok: number; warn: number; risk: number; block: number }

export interface Repo {
  installationId: number;
  repoId: number;
  repoFullName: string;
  enabled: boolean;
  mode: 'label' | 'adopt' | 'off';
  defaultFlavor?: string;
  flavorMap: Record<string, string>;
  updatedBy?: string;
  updatedAt: string;
  compat?: CompatRollup;
}

export interface WorkflowJob {
  id: string;
  name: string | null;
  runsOn: string[];
  flavor?: string;
  flavorReason?: string;
  compat: { level: CompatLevel; messages: { level: string; code: string; text: string }[] };
}

export interface Workflow {
  path: string;
  name: string;
  compatLevel: CompatLevel;
  parseError?: string;
  lastParsedSha?: string;
  updatedAt: string;
  jobs: WorkflowJob[];
}

export interface Run {
  repoId: number;
  repoFullName: string;
  installationId: number;
  runId: number;
  jobId: number;
  status: RunStatus;
  flavor?: string;
  microvmId?: string;
  labels: string[];
  reason?: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  costUsd?: number;
}

export interface Health {
  counts: Record<RunStatus, number>;
  active: number;
  errorRate: number;
  stuck: Run[];
  generatedAt: string;
  /** False when a status count hit the paging budget and is a floor, not a total. */
  countsExact?: boolean;
}

export interface Flavor {
  name: string;
  label: string;
  arch: string;
  vcpu: number;
  memoryMb: number;
  capabilities: string[];
  description: string;
  usdPerMinute: number;
  imageAvailable: boolean;
}

export interface AppLinkage {
  appId: number;
  name: string;
  slug: string;
  htmlUrl: string;
  ownerLogin: string;
  events: string[];
  permissions: Record<string, string>;
}

export interface AppInstallation {
  installationId: number;
  accountLogin: string;
  suspended: boolean;
  /** True when our install store also knows it (a false means a missed webhook). */
  known: boolean;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  action: string | null;
  status: string;
  statusCode: number;
  deliveredAt: string;
  durationMs: number;
  redelivery: boolean;
}

export interface WebhookHealth {
  configuredUrl?: string;
  deployedUrl?: string;
  urlMismatch: boolean;
  secretConfigured?: boolean;
  insecureSsl?: boolean;
  lastReceivedAt?: string;
  lastReceivedEvent?: string;
  lastDeliveryId?: string;
  deliveries?: number;
  lastRejectedAt?: string;
  rejections?: number;
  recentDeliveries: WebhookDelivery[];
  recentFailures: number;
  error?: string;
  state: 'healthy' | 'degraded' | 'unknown';
}

export interface RunnerLabels {
  labels: string[];
  unset: boolean;
  hostedLabels: string[];
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

export interface LabelImpactJob {
  repoId: number;
  repoFullName: string;
  workflowPath: string;
  jobId: string;
  runsOn: string[];
}

export interface LabelImpact {
  current: string[];
  proposed: string[];
  added: string[];
  removed: string[];
  losing: LabelImpactJob[];
  gaining: LabelImpactJob[];
  truncated: boolean;
}

/**
 * Settings payload. Note the absence of any secret VALUE field — the API answers with App
 * identity, effective labels and delivery evidence; SSM paths live only in `diagnostics`
 * (spec 04 hard rule).
 */
export interface Settings {
  envName: string;
  region: string;
  app: AppLinkage | null;
  appVerifyError?: string;
  configuredAppId?: string;
  installations: AppInstallation[];
  runnerLabels: RunnerLabels;
  webhook: WebhookHealth;
  flavors: Flavor[];
  recentChanges: AuditEntry[];
  diagnostics: { secrets: { param: string; label: string; present: boolean }[] };
  /** Whether THIS session may use the mutating actions. */
  canAdminPlatform: boolean;
}

/** Result of a runner-label write (or dry-run preview). */
export interface RunnerLabelsResult {
  dryRun: boolean;
  applied: boolean;
  labels: string[];
  impact: LabelImpact;
}

/**
 * Result of a relink. `replacedVersions` is the rollback handle — SSM parameter VERSION
 * numbers, never values.
 */
export interface RelinkResult {
  applied: boolean;
  verified?: boolean;
  appId?: number;
  appSlug?: string;
  replacedVersions?: Record<string, number>;
  /**
   * Whether GitHub's webhook config was updated to match the stored secret/URL. False means the
   * operator must set the secret at GitHub manually — otherwise every delivery fails its HMAC
   * check even though the credentials verified.
   */
  hookSynced?: boolean;
  hookError?: string;
  error?: string;
  rolledBack?: boolean;
}

export interface LogPage {
  logGroup: string;
  microvmId: string | null;
  pending: boolean;
  events: { timestamp: number; message: string; stream: string }[];
  nextToken: string | null;
}

// ---- endpoints -------------------------------------------------------------

export const api = {
  me: () => request<Me>('/api/me'),
  installations: () => request<{ installations: Installation[] }>('/api/installations'),
  repos: (installationId: number) =>
    request<{ repos: Repo[] }>(`/api/repos?installation=${installationId}`),
  patchRepo: (installationId: number, repoId: number, patch: Record<string, unknown>) =>
    request<{ repo: Repo }>(`/api/repos/${repoId}?installation=${installationId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  workflows: (installationId: number, repoId: number) =>
    request<{ repo: Repo; compat: CompatRollup; workflows: Workflow[] }>(
      `/api/repos/${repoId}/workflows?installation=${installationId}`,
    ),
  rescan: (installationId: number, repoId: number) =>
    request<{ queued: boolean }>(`/api/repos/${repoId}/rescan?installation=${installationId}`, {
      method: 'POST',
    }),
  putFlavorMap: (installationId: number, repoId: number, flavorMap: Record<string, string>) =>
    request<{ flavorMap: Record<string, string> }>(
      `/api/repos/${repoId}/flavor-map?installation=${installationId}`,
      { method: 'PUT', body: JSON.stringify({ flavorMap }) },
    ),
  runs: (query: { repo?: number; status?: RunStatus; limit?: number; cursor?: string } = {}) => {
    const p = new URLSearchParams();
    if (query.repo !== undefined) p.set('repo', String(query.repo));
    if (query.status) p.set('status', query.status);
    if (query.limit) p.set('limit', String(query.limit));
    if (query.cursor) p.set('cursor', query.cursor);
    const qs = p.toString();
    return request<{ runs: Run[]; nextCursor: string | null }>(`/api/runs${qs ? `?${qs}` : ''}`);
  },
  run: (repoId: number, runId: number, jobId: number) =>
    request<{ run: Run }>(`/api/runs/${repoId}/${runId}/${jobId}`),
  /**
   * One page of a run's logs. Pass `nextToken` while CloudWatch keeps issuing one; once it
   * stops (caught up), pass `since` = newest event timestamp + 1 ms so the tail resumes
   * instead of replaying the last page.
   */
  runLogs: (
    repoId: number,
    runId: number,
    jobId: number,
    opts: { nextToken?: string; since?: number } = {},
  ) => {
    const p = new URLSearchParams();
    if (opts.nextToken) p.set('nextToken', opts.nextToken);
    else if (opts.since !== undefined) p.set('since', String(opts.since));
    const qs = p.toString();
    return request<LogPage>(`/api/runs/${repoId}/${runId}/${jobId}/logs${qs ? `?${qs}` : ''}`);
  },
  flavors: () => request<{ flavors: Flavor[] }>('/api/flavors'),
  health: () => request<Health>('/api/health'),
  settings: () => request<Settings>('/api/settings'),
  /**
   * Replace the environment's claimed runner labels. Always call with `dryRun: true` first —
   * the response carries the impact analysis (which jobs stop/start being claimed), which the
   * operator must see before committing (spec 04 § Settings).
   */
  putRunnerLabels: (body: { labels: string[]; allowHostedLabels?: boolean; dryRun?: boolean }) =>
    request<RunnerLabelsResult>('/api/settings/runner-labels', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /**
   * Write-only credential intake: submit new App credentials, receive presence + verification
   * outcome. The API never echoes a submitted value back, and the browser must not persist
   * one — callers keep the form state in memory and clear it on success.
   */
  relinkGithubApp: (creds: {
    appId: string;
    pem: string;
    webhookSecret: string;
    clientId: string;
    clientSecret: string;
  }) =>
    request<RelinkResult>('/api/settings/github-app/relink', {
      method: 'POST',
      body: JSON.stringify(creds),
    }),
  rollbackGithubApp: (restore: Record<string, number>) =>
    request<{ rolledBack: boolean; verified: boolean; appId?: number }>(
      '/api/settings/github-app/rollback',
      { method: 'POST', body: JSON.stringify({ restore }) },
    ),
  testWebhook: (deliveryId?: number) =>
    request<{ requested: boolean; deliveryId?: number; lastReceivedAtBefore: string | null }>(
      '/api/settings/webhook/test',
      { method: 'POST', body: JSON.stringify(deliveryId ? { deliveryId } : {}) },
    ),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};
