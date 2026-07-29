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

export interface Settings {
  envName: string;
  region: string;
  secrets: { param: string; label: string; present: boolean }[];
  flavors: Flavor[];
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
    /**
     * `complete` is the server's verdict on whether this page holds every job of every run
     * it mentions — the client cannot work that out, because truncation happens on the raw
     * index pages before the installation-visibility filter (ADR-029). Absent (older API)
     * is treated as `false` by the caller: partial is the safe default.
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
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
};
