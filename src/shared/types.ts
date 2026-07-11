/**
 * Shared types for the LambdaCIActions control + compute plane.
 */

/** A GitHub `workflow_job` webhook payload (subset we consume). */
export interface WorkflowJobEvent {
  action: 'queued' | 'in_progress' | 'completed' | 'waiting';
  workflow_job: {
    id: number;
    run_id: number;
    labels: string[];
    name: string;
    status: string;
    conclusion?: string | null; // set on action=completed
  };
  repository: {
    id: number;
    name: string;
    full_name: string; // owner/repo
    owner: { login: string };
  };
  installation: { id: number };
}

/**
 * A GitHub `installation` / `installation_repositories` webhook payload (subset).
 * Drives the installation lifecycle (spec 01 § Installation lifecycle).
 */
export interface InstallationEvent {
  action:
    | 'created'
    | 'deleted'
    | 'suspend'
    | 'unsuspend'
    | 'new_permissions_accepted'
    | 'added' // installation_repositories
    | 'removed'; // installation_repositories
  installation: {
    id: number;
    account: { login: string; id: number };
  };
  // Present on installation.created: the repos granted at install time.
  repositories?: RepoRef[];
  // Present on installation_repositories.*: repos added / removed from the install.
  repositories_added?: RepoRef[];
  repositories_removed?: RepoRef[];
}

/** A repository reference as it appears in installation webhooks. */
export interface RepoRef {
  id: number;
  name: string;
  full_name: string; // owner/repo
}

/** The message Ingest λ enqueues onto SQS for Provision λ. */
export interface ProvisionRequest {
  installationId: number;
  repoId: number;
  repoFullName: string; // owner/repo
  owner: string;
  repo: string;
  runId: number;
  jobId: number;
  labels: string[];
}

/** The JSON we hand to `run-microvm --run-hook-payload` (delivered to /run). Keep <16 KB. */
export interface RunHookPayload {
  jitConfig: string;
  runId: number;
  jobId: number;
  repoFullName: string;
  labels: string[];
}

/** GitHub App credentials read from SSM. */
export interface GithubAppCredentials {
  appId: string;
  pem: string;
  webhookSecret: string;
}

/**
 * Run lifecycle state machine (spec 02 § Provisioning lifecycle).
 *
 *   queued → provisioning → running → completed | failed | timed_out
 *
 * `queued` is written by Ingest when it claims a job; `provisioning`/`running` by
 * Provision; terminal states by the status webhook, Provision (on launch error), or the
 * Reaper (`timed_out` / `failed` for orphans).
 */
export type RunStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out';

/**
 * A run record persisted in DynamoDB (ADR-009 single-table design). One row per
 * (repoId, runId, jobId) — the same idempotency triple used for SQS dedupe.
 *
 * Keys (single-table): PK = `RUN#<repoId>#<runId>#<jobId>`, SK = `RUN`.
 * GSI1 (status/time index): GSI1PK = `RUNSTATUS#<status>`, GSI1SK = `<updatedAt ISO>` —
 * lets the Reaper + UI scan active runs by status without a table scan.
 */
export interface RunRecord {
  repoId: number;
  repoFullName: string;
  installationId: number;
  runId: number;
  jobId: number;
  status: RunStatus;
  flavor?: string;
  microvmId?: string;
  labels: string[];
  /** Reason string for failed / timed_out. */
  reason?: string;
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
  /** Epoch seconds — DynamoDB TTL to age out terminal rows per retention policy. */
  ttl?: number;
}

/**
 * An installation record (spec 01). One row per GitHub App installation; repos are
 * separate rows keyed under the same installation.
 *
 * Keys: PK = `INSTALL#<installationId>`, SK = `INSTALL` (installation) or
 * `REPO#<repoId>` (a granted repo).
 */
export interface InstallationRecord {
  installationId: number;
  accountLogin: string;
  accountId: number;
  suspended: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A repo granted to an installation. `enabled=false` ⇒ we stop claiming its jobs. */
export interface RepoRecord {
  installationId: number;
  repoId: number;
  repoFullName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Capability/compat signals heuristically extracted from a job's steps (spec 03 §
 * Parsing model → `step_signals`). Feeds `runs-on` → flavor routing (signal-based
 * upgrade) and compatibility analysis. All best-effort; never authoritative.
 */
export interface StepSignals {
  /**
   * True if the job needs a Docker-capable flavor: has `container:`, any `services:`,
   * a step `uses:` matching `docker/*`, or a `run:` line invoking `docker`/`docker-compose`.
   */
  needs_docker: boolean;
  /** Explicit arch tokens seen (`arm64`/`aarch64`/`amd64`/`x86_64`) across runs-on, container, run text. */
  arch_hints: string[];
  /** De-duped list of every step `uses:` value, in first-seen order. */
  known_actions: string[];
}

/**
 * A single normalized job from a parsed workflow (spec 03 § Parsing model).
 * Raw model only — `route`/`compat` are added by later M3 routing/compat wiring, not here.
 */
export interface ParsedJob {
  id: string;
  /**
   * `runs-on` normalized to a string[]. Unresolvable matrix expressions (`${{ matrix.os }}`)
   * are preserved verbatim as the raw expression string.
   */
  runs_on: string[];
  /** `job.container.image` (accepts string or `{ image }` object form); null if absent. */
  container: string | null;
  /** Keys of `job.services`; empty if none. */
  services: string[];
  /** Reusable-workflow ref (`job.uses`); null if not a reusable-workflow call. */
  uses: string | null;
  /**
   * Statically-resolvable `strategy.matrix` dimensions, string-coerced. Excludes the
   * `include`/`exclude` keys. Empty object if no static matrix.
   */
  matrix_dims: Record<string, string[]>;
  step_signals: StepSignals;
}

/**
 * A parsed GitHub Actions workflow file, normalized for routing + compat (spec 03 §
 * Parsing model). Produced by `parseWorkflow`. `route`/`compat` fields are intentionally
 * NOT present yet — routing + compat wiring is a later M3 slice.
 */
export interface ParsedWorkflow {
  path: string;
  name: string;
  /** `on:` normalized to trigger-name string[] (accepts string, array, or map forms). */
  on: string[];
  jobs: ParsedJob[];
}

/** Thrown by `parseWorkflow` when the YAML is malformed / not a mapping. Catchable by callers. */
export class WorkflowParseError extends Error {
  readonly path: string;
  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(`${path}: ${message}`, options);
    this.name = 'WorkflowParseError';
    this.path = path;
  }
}
