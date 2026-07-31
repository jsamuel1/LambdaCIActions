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
  /**
   * The parsed JSON body of the failing response, when there was one.
   *
   * Some API failures are *structured refusals the UI must act on*, not just messages to print.
   * The relink route is the load-bearing case: a webhook-secret desync answers **422** with
   * `{ applied: false, hookSynced: false, rolledBack, replacedVersions, createdParams }`, and
   * both the only legitimate way forward (the explicit `allowHookDesync` retry) and the rollback
   * handle live in that body. Discarding it at the throw makes those controls unreachable.
   */
  readonly body?: Record<string, unknown>;
  constructor(
    status: number,
    message: string,
    details?: unknown,
    body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.body = body;
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
    throw new ApiError(res.status, String(body.error ?? `HTTP ${res.status}`), body.details, body);
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
  /** Per-repo auto-rewrite opt-in (ADR-031). */
  rewriteEnabled: boolean;
  updatedBy?: string;
  updatedAt: string;
  compat?: CompatRollup;
}

export interface CompatMessage {
  level: string;
  code: string;
  text: string;
  /** Actionable remedy (M5) — what the operator should change. */
  fix?: string;
}

export interface WorkflowJob {
  id: string;
  name: string | null;
  runsOn: string[];
  flavor?: string;
  flavorReason?: string;
  /** Job runs on GitHub-hosted runners today; adopt mode would claim it (M5). */
  adoptCandidate: boolean;
  compat: { level: CompatLevel; messages: CompatMessage[] };
}

export interface Workflow {
  path: string;
  name: string;
  compatLevel: CompatLevel;
  parseError?: string;
  lastParsedSha?: string;
  updatedAt: string;
  adoptCandidates: number;
  jobs: WorkflowJob[];
}

/** Dry-run of the auto-rewrite PR (ADR-031). */
export interface RewritePreview {
  repo: Repo;
  /** Deployment-wide flag (`-c rewrite=true`). */
  deploymentEnabled: boolean;
  repoOptedIn: boolean;
  canApply: boolean;
  changes: number;
  skipped: number;
  jobs: { path: string; jobId: string; before: string; after?: string; skipped?: string }[];
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

export interface CostSummary {
  /** Sampled **jobs** (run rows are per-job — a matrix workflow contributes one each). */
  jobs: number;
  totalUsd: number;
  avgUsd: number;
  byFlavor: Record<string, { jobs: number; usd: number }>;
}

export interface Health {
  counts: Record<RunStatus, number>;
  active: number;
  errorRate: number;
  stuck: Run[];
  /** Rolling spend estimate over the sampled terminal runs (M5). */
  cost: CostSummary;
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
   * Parameters this relink CREATED (they had no prior version). Part of the rollback handle:
   * undoing them means deletion, so a rollback that only restored versions would leave a
   * first-link in place.
   */
  createdParams?: string[];
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

/**
 * Turn a thrown relink failure back into a `RelinkResult`.
 *
 * `request` rejects on every non-2xx, and the relink route answers a *refusal* with 422 plus a
 * structured body. That body is not decoration: a webhook-secret desync refusal carries
 * `hookSynced: false` (the console's cue to offer the explicit `allowHookDesync` retry) and the
 * `replacedVersions` / `createdParams` rollback handle for a refusal that could NOT roll itself
 * back. Treating the rejection as a bare message would strand the operator with no supported way
 * forward — they would have to hand-craft the retry.
 *
 * Returns undefined when the failure carries no relink body (a 500, an edge error page, a
 * non-`ApiError` network fault), so the caller falls back to plain error text. Pure, so the
 * decision is testable without a DOM.
 */
export function relinkFailureFrom(err: unknown): RelinkResult | undefined {
  if (!(err instanceof ApiError) || !err.body) return undefined;
  const body = err.body;
  // `applied` is the field the route always sets on a refusal; its absence means this is not a
  // relink refusal (a generic 403/503 problem+json, say) and there is nothing structured to act on.
  if (body.applied !== false) return undefined;
  const versions = body.replacedVersions;
  const created = body.createdParams;
  return {
    applied: false,
    error: typeof body.error === 'string' ? body.error : err.message,
    rolledBack: body.rolledBack === true,
    ...(body.hookSynced === false ? { hookSynced: false } : {}),
    ...(typeof body.hookError === 'string' ? { hookError: body.hookError } : {}),
    ...(versions && typeof versions === 'object' && !Array.isArray(versions)
      ? { replacedVersions: versions as Record<string, number> }
      : {}),
    ...(Array.isArray(created) ? { createdParams: created.filter((p) => typeof p === 'string') } : {}),
  };
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
  /** Dry run — always available, writes nothing. */
  rewritePreview: (installationId: number, repoId: number) =>
    request<RewritePreview>(`/api/repos/${repoId}/rewrite-pr?installation=${installationId}`),
  /** Open the PR. 409s unless the deployment flag AND the repo opt-in are both on. */
  rewritePr: (installationId: number, repoId: number) =>
    request<{ queued: boolean }>(`/api/repos/${repoId}/rewrite-pr?installation=${installationId}`, {
      method: 'POST',
    }),
  runs: (query: { repo?: number; status?: RunStatus; limit?: number; cursor?: string } = {}) => {
    const p = new URLSearchParams();
    if (query.repo !== undefined) p.set('repo', String(query.repo));
    if (query.status) p.set('status', query.status);
    if (query.limit) p.set('limit', String(query.limit));
    if (query.cursor) p.set('cursor', query.cursor);
    const qs = p.toString();
    /**
     * `complete` is the server's answer to "were any job rows dropped from this response?" —
     * NOT "is the index exhausted" (that is `nextCursor`). The client cannot derive the
     * dropped-rows half, because truncation happens on the raw index pages before the
     * installation-visibility filter (ADR-029). Absent (older API) is treated as `false` by
     * the caller: partial is the safe default.
     */
    return request<{ runs: Run[]; nextCursor: string | null; complete?: boolean }>(
      `/api/runs${qs ? `?${qs}` : ''}`,
    );
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
    /**
     * Proceed even if GitHub's own hook config cannot be updated to the new webhook secret. Off
     * by default: the server REFUSES and rolls back that case, because GitHub would keep signing
     * with the previous secret while this environment verifies the new one — every delivery
     * rejected, no job claimed. Only set once the operator has set the secret at GitHub by hand.
     */
    allowHookDesync?: boolean;
  }) =>
    request<RelinkResult>('/api/settings/github-app/relink', {
      method: 'POST',
      body: JSON.stringify(creds),
    }),
  rollbackGithubApp: (restore: Record<string, number>, remove: string[] = []) =>
    request<{
      rolledBack: boolean;
      verified: boolean;
      appId?: number;
      /**
       * Whether GitHub's hook config was re-pointed at the restored webhook secret. False means
       * GitHub keeps signing with the relinked App's secret and every delivery fails its HMAC
       * check until the operator fixes it at GitHub.
       */
      hookSynced?: boolean;
      hookError?: string;
    }>('/api/settings/github-app/rollback', {
      method: 'POST',
      body: JSON.stringify({ restore, ...(remove.length ? { remove } : {}) }),
    }),
  testWebhook: (deliveryId?: number) =>
    request<{ requested: boolean; deliveryId?: number; lastReceivedAtBefore: string | null }>(
      '/api/settings/webhook/test',
      { method: 'POST', body: JSON.stringify(deliveryId ? { deliveryId } : {}) },
    ),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};
