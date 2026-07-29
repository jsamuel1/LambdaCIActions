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
    /** Name of the enclosing workflow (GitHub adds this to workflow_job payloads). */
    workflow_name?: string | null;
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
  /** Rendered job name from the webhook (matches stored analyses; M3-S4). */
  jobName?: string;
  /** Enclosing workflow name from the webhook (matches stored analyses; M3-S4). */
  workflowName?: string | null;
  /**
   * How Ingest came to claim this job (M5, ADR-030): `'label'` = explicit LCA label,
   * `'adopt'` = standard GitHub-hosted label under adopt mode. Provision uses it to route
   * (adopt-mode label map) and to emit the right metric dimension; absent on messages
   * enqueued before M5, which are treated as `'label'`.
   */
  claimVia?: 'label' | 'adopt';
}

/**
 * A GitHub `push` webhook payload (subset). Only used to detect pushes touching
 * `.github/workflows/**` so Discovery can re-parse the repo (spec 03 § Discovery).
 */
export interface PushEvent {
  ref: string;
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: { login: string };
  };
  installation?: { id: number };
  commits?: { added?: string[]; removed?: string[]; modified?: string[] }[];
  head_commit?: { added?: string[]; removed?: string[]; modified?: string[] } | null;
}

/**
 * The message Ingest enqueues onto the discovery queue — one per repo to (re)scan
 * (spec 03 § Discovery). Consumed by the Discovery λ.
 */
export interface DiscoveryRequest {
  installationId: number;
  repoId: number;
  repoFullName: string; // owner/repo
  owner: string;
  repo: string;
  /** Why the scan fired (logging / debugging only). */
  reason: 'push' | 'installation' | 'manual';
}

/**
 * The message the Management API enqueues to request an auto-rewrite PR (spec 03 §
 * Auto-rewrite, ADR-031). Consumed by the rewrite λ, which holds the App credentials the
 * management plane deliberately lacks (ADR-025).
 */
export interface RewriteRequest {
  installationId: number;
  repoId: number;
  repoFullName: string; // owner/repo
  owner: string;
  repo: string;
  /** GitHub login of the operator who requested it (audit trail). */
  actor: string;
}

/**
 * The JSON we hand to `run-microvm --run-hook-payload` (delivered to /run). HARD cap 4096
 * bytes (GA lambda-microvms). The JIT config alone exceeds this, so it is NOT inlined — we
 * pass only a small reference; the /run hook resolves it through the hook broker λ, which is
 * the only AWS surface the VM can reach (ADR-016 by-reference payload, ADR-020 brokered
 * access).
 */
export interface RunHookPayload {
  /** DynamoDB ref to the stashed JIT config (see run-store jitConfigRef). */
  ref: string;
  /** AWS region so the in-microVM hook can reach the broker. */
  region: string;
  /**
   * Hook broker function name/ARN the VM invokes for its JIT config + self-terminate
   * (ADR-021). The VM has NO direct DynamoDB or TerminateMicrovm permission.
   */
  broker: string;
  /**
   * Per-run capability token (plaintext, VM-only). The broker authorizes actions on this
   * run by comparing its SHA-256 against the hash stored on the JIT config item.
   */
  token: string;
}

/** What a microVM asks the hook broker λ to do on its own run (ADR-021). */
export interface HookBrokerRequest {
  action: 'jitconfig' | 'terminate';
  /** The run's JIT config ref — the ONLY partition this request can touch. */
  ref: string;
  /** Per-run capability token issued at launch. */
  token: string;
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
  /**
   * SHA-256 of the run's hook capability token (ADR-020), mirrored here by `stampMicrovmId`
   * because the brokered self-terminate fires at job end, after the JIT config item carrying
   * the same hash has TTL'd away. Control-plane only: it is the verifier for a bearer
   * secret, so it must never be serialized into a management-API response or the UI
   * (AGENTS.md — no secret values in the UI/API).
   */
  hookTokenHash?: string;
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

/**
 * Onboarding mode for a repo (spec 03). `label` = workflows opt in with explicit LCA
 * labels (v1 default). `adopt` = standard-label mapping (M5, ADR-030) — jobs carrying
 * GitHub's standard `ubuntu-*` labels are claimed with no YAML edits. `off` = never claim.
 */
export type RepoMode = 'label' | 'adopt' | 'off';

/** A repo granted to an installation. `enabled=false` ⇒ we stop claiming its jobs. */
export interface RepoRecord {
  installationId: number;
  repoId: number;
  repoFullName: string;
  enabled: boolean;
  /** Onboarding mode; absent ⇒ `label` (the v1 default). Set from the M4 UI. */
  mode?: RepoMode;
  /** Operator-chosen fallback flavor for this repo; absent ⇒ catalog default (`base`). */
  defaultFlavor?: string;
  /**
   * Per-repo explicit `label → flavor` override map (spec 03 routing step 1). Set via
   * the management UI (M4); consumed by Provision when resolving a job's flavor.
   */
  flavorMap?: Record<string, string>;
  /**
   * Per-repo opt-in to the auto-rewrite PR (M5, ADR-031). Absent ⇒ OFF. Even when true the
   * platform only opens a PR when the deployment also enabled the feature — two independent
   * gates, because auto-rewrite is the one capability that writes to a customer repo
   * (AGENTS.md hard rule: `contents:write` off by default).
   */
  rewriteEnabled?: boolean;
  /** GitHub login of the operator who last changed config (M4 audit, spec 04). */
  updatedBy?: string;
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
   * The job's custom `name:` if set (string-coerced), else null. Needed to match a
   * `workflow_job` webhook (which carries the RENDERED name) back to the parsed job.
   */
  name: string | null;
  /**
   * `runs-on` normalized to a string[]. Unresolvable matrix expressions (`${{ matrix.os }}`)
   * are preserved verbatim as the raw expression string. The runner-group object form
   * `{ group, labels }` contributes its `labels` (where LCA routing labels live).
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

/**
 * Compatibility level for a job/workflow (spec 03 § Compatibility analysis), worst-wins:
 * `ok` < `warn` < `risk` < `block`. `block` ⇒ Ingest won't claim the job.
 */
export type CompatLevel = 'ok' | 'warn' | 'risk' | 'block';

/** A single compat finding. `code` is a stable machine tag; `text` is operator-facing. */
export interface CompatMessage {
  level: 'warn' | 'risk' | 'block';
  code: string;
  text: string;
  /**
   * Actionable remedy the operator can apply (M5, spec 03 § Compatibility analysis —
   * "surfaced in the UI with actionable fixes"). Separated from `text` (which states the
   * problem) so the console can render the two differently and a fix can be reworded
   * without changing a finding's meaning.
   */
  fix?: string;
}

/**
 * Result of analyzing one job's compatibility (spec 03). `level` is the worst rule that
 * fired (default `ok`); `eligible` is `level !== 'block'` (spec 03 § routing — Ingest only
 * claims a job when routing says eligible).
 */
export interface CompatResult {
  level: CompatLevel;
  eligible: boolean;
  messages: CompatMessage[];
}

/**
 * A persisted per-workflow analysis row (M3-S4 wiring; ADR-009 single table).
 *
 * Keys: PK = `REPO#<repoId>`, SK = `WF#<path>` — one item per workflow file, upserted by
 * the Discovery λ, read by Ingest (claim-time compat) and Provision (signals).
 */
export interface WorkflowAnalysisRecord {
  repoId: number;
  installationId: number;
  repoFullName: string;
  path: string;
  /** Workflow `name:` (falls back to file basename). */
  name: string;
  /** Normalized parse output; absent when the file failed to parse. */
  parsed?: ParsedWorkflow;
  /** Per-job compat results + folded workflow level; absent when parse failed. */
  compat?: { level: CompatLevel; jobs: Record<string, CompatResult> };
  /** Per-job flavor resolution (routing preview for the UI); absent when parse failed. */
  routes?: Record<string, { flavor: string; reason: string }>;
  /** Parse failure detail (WorkflowParseError message); analysis fields absent. */
  parseError?: string;
  /** Git blob sha of the parsed content (spec 03 `last_parsed_sha`). */
  lastParsedSha?: string;
  createdAt: string;
  updatedAt: string;
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
