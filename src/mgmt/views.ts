import type { RunRecord, RunStatus, WorkflowAnalysisRecord, RepoRecord } from '../shared/types.js';
import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };
import { isAdoptLabel, incompatibleRunnerLabel, unreachableRunnerGroup } from '../ingest/adopt.js';

/**
 * Read-model helpers for the Management API (spec 04). Pure functions only — shaping,
 * folding and redaction. All AWS I/O lives in the shared stores + `logs.ts`, so the shapes
 * the UI depends on are unit-testable without AWS.
 */

// ---- run views -------------------------------------------------------------

export interface RunView {
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
  /** Wall-clock seconds from queue to last transition (terminal ⇒ total job time). */
  durationSeconds: number;
  /**
   * Estimated microVM cost in USD.
   *
   * Undefined when there is no evidence a microVM ran — an unknown flavor, or a row that
   * neither carries a `microvmId` nor ever reached a post-launch status. Provision stamps
   * `flavor` on a mint/launch FAILURE too (it records the intended flavor for support), so
   * flavor alone is not evidence of compute: pricing such a row showed spend for a job whose
   * own detail page says "microVM: (not launched)". See `isCostEligible` — it gates both this
   * and the dashboard rollup (`summarizeCost`) so the two can never disagree.
   */
  costUsd?: number;
}

/**
 * Per-minute microVM price by flavor (spec 04 OQ-3). Sourced from the flavor catalog's
 * vCPU/memory footprint × the published Graviton microVM rate rather than a hand-maintained
 * table, so adding a flavor can't silently produce a missing rate.
 *
 * Reference point (README): 2 vCPU / 4 GB ≈ $0.0044/min. Splitting that across the two
 * dimensions with AWS's usual ~2:1 vCPU:GB weighting gives the per-unit rates below.
 *
 * CAVEAT (ADR-038): only `memoryMb` is actually requested from the API; `vcpu` is
 * descriptive. This therefore remains an **estimate** — every surface that shows it must
 * label it as one, as `estimateCostUsd` does.
 */
export const VCPU_USD_PER_MINUTE = 0.0011;
export const GB_USD_PER_MINUTE = 0.00055;

interface FlavorDef {
  name: string;
  label: string;
  arch: string;
  /** DESCRIPTIVE only — the API exposes no vCPU request (ADR-038). */
  vcpu: number;
  memoryMb: number;
  capabilities: string[];
  description: string;
}

const FLAVORS: FlavorDef[] = (flavorsCatalog as { flavors: FlavorDef[] }).flavors;

/** Our routing labels, lowercased — a job carrying one already opted in explicitly. */
const LCA_LABELS = new Set(FLAVORS.map((f) => f.label.toLowerCase()));

/** Per-minute price of a flavor, or undefined for an unknown flavor name. */
export function flavorRatePerMinute(flavor: string | undefined): number | undefined {
  const def = FLAVORS.find((f) => f.name === flavor);
  if (!def) return undefined;
  return def.vcpu * VCPU_USD_PER_MINUTE + (def.memoryMb / 1024) * GB_USD_PER_MINUTE;
}

export function durationSeconds(run: Pick<RunRecord, 'createdAt' | 'updatedAt'>): number {
  const start = Date.parse(run.createdAt);
  const end = Date.parse(run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 1000);
}

/** Statuses after which a run row no longer changes. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'timed_out']);

/**
 * Billable seconds behind the cost estimate.
 *
 * For a TERMINAL row this is queue→last-transition, exactly as before. For a row still in
 * flight it runs to `now` instead: `updatedAt` is only written on a status TRANSITION, so an
 * hour-old `running` job kept reporting the seconds it took to reach `running` — the Run
 * detail page polls, reprojects the same row, and showed a frozen estimate that materially
 * understated live spend.
 */
function billableSeconds(
  run: Pick<RunRecord, 'createdAt' | 'updatedAt' | 'status'>,
  now: Date,
): number {
  if (TERMINAL_STATUSES.has(run.status)) return durationSeconds(run);
  const start = Date.parse(run.createdAt);
  const end = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    // A clock skew / unparseable timestamp must not invent negative spend; fall back to the
    // persisted window, which is itself clamped at 0.
    return durationSeconds(run);
  }
  return Math.round((end - start) / 1000);
}

/**
 * Whether a run row is evidence that a microVM actually ran, and can therefore be priced.
 *
 * Two independent signals, because neither alone is sufficient:
 *   - `microvmId` — the run↔VM mapping. Normally present, but Provision stamps it
 *     **best-effort**: a failed stamp is logged and the launch continues (the VM is already
 *     up, ADR-019), so requiring it alone would silently drop a real, billable run out of both
 *     the per-run estimate and the dashboard total.
 *   - a status only reachable AFTER a successful launch — `running` is written by Provision in
 *     the step after the launch returns, and `completed` requires the runner to have picked up
 *     the job inside the VM.
 *
 * `failed` and `timed_out` are deliberately NOT in that set: a mint/launch failure stamps
 * `flavor` on the row for support without any VM existing, and the Reaper times out a row that
 * never left `provisioning`. Pricing those billed wall-clock for compute that never ran and
 * inflated the estimate exactly when provisioning was broken — such a row is priced only if it
 * does carry a `microvmId`, which is real evidence.
 */
export function isCostEligible(
  run: Pick<RunRecord, 'microvmId' | 'flavor' | 'status'>,
): boolean {
  if (flavorRatePerMinute(run.flavor) === undefined) return false;
  return Boolean(run.microvmId) || LAUNCHED_STATUSES.has(run.status);
}

/** Statuses a run can only reach once a microVM has actually launched. */
const LAUNCHED_STATUSES: ReadonlySet<string> = new Set(['running', 'completed']);

/**
 * Estimated cost of a run: billable minutes × flavor rate, or undefined when the row is not
 * evidence of a microVM having run (see `isCostEligible` — a mint/launch failure carries a
 * flavor but no VM).
 *
 * Only the `running` phase is billed by the microVM service, but we don't persist a
 * `startedAt` per phase in v1, so this uses wall-clock as an UPPER BOUND and is labelled an
 * estimate in the UI. A non-terminal row is measured to `now`, so a live run's estimate grows
 * as it runs instead of freezing at its last transition.
 */
export function estimateCostUsd(
  run: Pick<RunRecord, 'createdAt' | 'updatedAt' | 'flavor' | 'status' | 'microvmId'>,
  now: Date = new Date(),
): number | undefined {
  if (!isCostEligible(run)) return undefined;
  const rate = flavorRatePerMinute(run.flavor)!;
  const minutes = billableSeconds(run, now) / 60;
  return Math.round(rate * minutes * 1e6) / 1e6;
}

/** Project a stored run row onto the API shape (adds derived duration + cost). */
export function toRunView(run: RunRecord, now: Date = new Date()): RunView {
  return {
    repoId: run.repoId,
    repoFullName: run.repoFullName,
    installationId: run.installationId,
    runId: run.runId,
    jobId: run.jobId,
    status: run.status,
    flavor: run.flavor,
    microvmId: run.microvmId,
    labels: run.labels ?? [],
    reason: run.reason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    durationSeconds: durationSeconds(run),
    costUsd: estimateCostUsd(run, now),
  };
}

/** Newest-first ordering used when merging per-status query results (Runs screen). */
export function sortRunsNewestFirst(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// ---- dashboard aggregates --------------------------------------------------

export const ALL_STATUSES: readonly RunStatus[] = [
  'queued',
  'provisioning',
  'running',
  'completed',
  'failed',
  'timed_out',
];

export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'provisioning', 'running'];

export interface HealthView {
  counts: Record<RunStatus, number>;
  active: number;
  /** failed+timed_out ÷ terminal over the sampled window; 0 when no terminal runs. */
  errorRate: number;
  /** Runs stuck in a non-terminal status longer than the stuck threshold. */
  stuck: RunView[];
  /**
   * Estimated spend over the sampled terminal run rows (M5 — dashboard shows health + cost).
   * Unlike `counts` (platform-wide by design), this is scoped to the caller's installations.
   * Counted per JOB (`CostSummary.jobs`), matching the run store's granularity.
   */
  cost: CostSummary;
  generatedAt: string;
}

/**
 * Rolling cost estimate for the dashboard (M5 exit criterion: "dashboard shows health +
 * cost"). Derived from the sampled run rows the health route already reads — no Cost Explorer
 * call, so it is free, instant, and consistent with the per-run estimate shown in Run detail.
 * Labelled an estimate in the UI for the same reason `estimateCostUsd` is.
 */
export interface CostSummary {
  /**
   * Number of **jobs** the estimate is based on (the sampled window, not all history).
   *
   * Jobs, not workflow runs: a run row is per-`(runId, jobId)` (spec 04 / ADR-029), so a
   * matrix workflow contributes one row per variant. Naming it `runs` made the Dashboard
   * print "3 finished runs" for one 3-job workflow and divide by 3 for a "mean per run" that
   * was really a mean per job. The total spend was right either way — the denominator was not.
   */
  jobs: number;
  /** Sum of per-job estimates, USD. */
  totalUsd: number;
  /** Mean per-JOB estimate, USD; 0 when no priced jobs were sampled. */
  avgUsd: number;
  /** Per-flavor breakdown so an operator can see which flavor dominates spend. */
  byFlavor: Record<string, { jobs: number; usd: number }>;
}

/**
 * Fold sampled run rows into a cost summary.
 *
 * Skipped: rows that are not evidence a microVM ran (`isCostEligible` — no flavor, and neither
 * a `microvmId` nor a post-launch status). A mint/launch failure stamps `flavor` on the row
 * (Provision records it for support) but no VM ever ran, so pricing it would bill wall-clock for
 * compute that never existed — inflating the dashboard estimate with the failures an operator is
 * already looking at. The same predicate gates `toRunView`, so per-run and rollup estimates
 * cannot diverge.
 *
 * The unit is a JOB, not a workflow run — see `CostSummary.jobs`.
 */
export function summarizeCost(runs: RunRecord[], now: Date = new Date()): CostSummary {
  const byFlavor: Record<string, { jobs: number; usd: number }> = {};
  let totalUsd = 0;
  let priced = 0;
  for (const run of runs) {
    const usd = estimateCostUsd(run, now);
    if (usd === undefined || !run.flavor) continue;
    priced += 1;
    totalUsd += usd;
    const bucket = (byFlavor[run.flavor] ??= { jobs: 0, usd: 0 });
    bucket.jobs += 1;
    bucket.usd = round6(bucket.usd + usd);
  }
  return {
    jobs: priced,
    totalUsd: round6(totalUsd),
    avgUsd: priced ? round6(totalUsd / priced) : 0,
    byFlavor,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** A non-terminal run older than this is "stuck" — the Reaper should have caught it. */
export const STUCK_AFTER_SECONDS = 15 * 60;

export function buildHealth(
  counts: Record<RunStatus, number>,
  activeRuns: RunRecord[],
  now: Date = new Date(),
  costRuns: RunRecord[] = [],
): HealthView {
  const terminal = counts.completed + counts.failed + counts.timed_out;
  const bad = counts.failed + counts.timed_out;
  const stuck = activeRuns
    .filter((r) => (now.getTime() - Date.parse(r.createdAt)) / 1000 > STUCK_AFTER_SECONDS)
    .map((r) => toRunView(r, now));
  return {
    counts,
    active: counts.queued + counts.provisioning + counts.running,
    errorRate: terminal === 0 ? 0 : Math.round((bad / terminal) * 1000) / 1000,
    stuck,
    cost: summarizeCost(costRuns, now),
    generatedAt: now.toISOString(),
  };
}

// ---- repo / workflow views -------------------------------------------------

export interface RepoView {
  installationId: number;
  repoId: number;
  repoFullName: string;
  enabled: boolean;
  mode: 'label' | 'adopt' | 'off';
  defaultFlavor?: string;
  flavorMap: Record<string, string>;
  /** Per-repo auto-rewrite opt-in (ADR-031); false when unset. */
  rewriteEnabled: boolean;
  updatedBy?: string;
  updatedAt: string;
}

export function toRepoView(repo: RepoRecord): RepoView {
  return {
    installationId: repo.installationId,
    repoId: repo.repoId,
    repoFullName: repo.repoFullName,
    enabled: repo.enabled,
    mode: repo.mode ?? 'label',
    defaultFlavor: repo.defaultFlavor,
    flavorMap: repo.flavorMap ?? {},
    rewriteEnabled: repo.rewriteEnabled === true,
    updatedBy: repo.updatedBy,
    updatedAt: repo.updatedAt,
  };
}

export interface CompatRollup {
  ok: number;
  warn: number;
  risk: number;
  block: number;
}

/** Count workflows by their folded compat level (Repos + Repo detail headline). */
export function rollupCompat(analyses: WorkflowAnalysisRecord[]): CompatRollup {
  const roll: CompatRollup = { ok: 0, warn: 0, risk: 0, block: 0 };
  for (const a of analyses) {
    const level = a.compat?.level ?? 'ok';
    roll[level] += 1;
  }
  return roll;
}

export interface WorkflowJobView {
  id: string;
  name: string | null;
  runsOn: string[];
  flavor?: string;
  flavorReason?: string;
  /**
   * True when the job targets a standard GitHub-hosted label and carries no LCA label — i.e.
   * it runs on GitHub-hosted runners today and would move to a microVM if the repo switched
   * to `adopt` mode (M5). Deliberately NOT a compat message: candidacy is the normal state of
   * an un-onboarded repo, and folding it into `compatLevel` would make every such workflow
   * look degraded (see src/ingest/compat.ts).
   *
   * A job that ALSO carries a non-Linux hosted label (`[ubuntu-latest, windows-latest]`) or an
   * x86 arch label, or that names a non-default runner GROUP, is NOT a candidate:
   * `decideClaim` / the Ingest group gate refuse it in every mode (arm64 Linux only, default
   * runner group only) and `rewriteTargets` excludes it. The predicate has to agree with those,
   * or the console counts jobs adopt mode will never claim and the RepoDetail copy ("N job(s) …
   * run on arm64 microVMs") states something false about a live repo.
   */
  adoptCandidate: boolean;
  compat: {
    level: 'ok' | 'warn' | 'risk' | 'block';
    messages: { level: string; code: string; text: string; fix?: string }[];
  };
}

export interface WorkflowView {
  path: string;
  name: string;
  compatLevel: 'ok' | 'warn' | 'risk' | 'block';
  parseError?: string;
  lastParsedSha?: string;
  updatedAt: string;
  /** Number of jobs in this workflow that adopt mode would claim (M5). */
  adoptCandidates: number;
  jobs: WorkflowJobView[];
}

/** Flatten a stored analysis into the per-job table the Workflow detail screen renders. */
export function toWorkflowView(a: WorkflowAnalysisRecord): WorkflowView {
  const jobs: WorkflowJobView[] = (a.parsed?.jobs ?? []).map((job) => {
    const compat = a.compat?.jobs?.[job.id];
    const route = a.routes?.[job.id];
    const lower = job.runs_on.map((l) => l.trim().toLowerCase());
    return {
      id: job.id,
      name: job.name,
      runsOn: job.runs_on,
      flavor: route?.flavor,
      flavorReason: route?.reason,
      adoptCandidate:
        lower.some((l) => isAdoptLabel(l)) &&
        !lower.some((l) => LCA_LABELS.has(l)) &&
        !incompatibleRunnerLabel(lower) &&
        !unreachableRunnerGroup(job.runner_group),
      compat: { level: compat?.level ?? 'ok', messages: compat?.messages ?? [] },
    };
  });
  return {
    path: a.path,
    name: a.name,
    compatLevel: a.compat?.level ?? 'ok',
    parseError: a.parseError,
    lastParsedSha: a.lastParsedSha,
    updatedAt: a.updatedAt,
    adoptCandidates: jobs.filter((j) => j.adoptCandidate).length,
    jobs,
  };
}

// ---- flavors + settings ----------------------------------------------------

export interface FlavorView {
  name: string;
  label: string;
  arch: string;
  vcpu: number;
  memoryMb: number;
  capabilities: string[];
  description: string;
  /** Per-minute estimate so the UI can show relative cost. */
  usdPerMinute: number;
  /** True when an image ARN for this flavor is published in SSM (i.e. it's buildable). */
  imageAvailable: boolean;
}

export function buildFlavorViews(available: Record<string, boolean>): FlavorView[] {
  return FLAVORS.map((f) => ({
    name: f.name,
    label: f.label,
    arch: f.arch,
    vcpu: f.vcpu,
    memoryMb: f.memoryMb,
    capabilities: f.capabilities,
    description: f.description,
    usdPerMinute: flavorRatePerMinute(f.name) ?? 0,
    imageAvailable: available[f.name] === true,
  }));
}

/** Names of every catalog flavor — used to validate operator flavor-map writes. */
export function flavorNames(): string[] {
  return FLAVORS.map((f) => f.name);
}

export interface SecretStatus {
  /** SSM parameter path (a path is not a secret; the VALUE is never returned). */
  param: string;
  /** Operator-facing label. */
  label: string;
  present: boolean;
}

// ---- settings: GitHub App linkage, runner labels, webhook health ------------

/** Live-verified App identity (from `GET /app` with the stored credentials). */
export interface AppLinkageAppView {
  appId: number;
  name: string;
  slug: string;
  htmlUrl: string;
  ownerLogin: string;
  events: string[];
  permissions: Record<string, string>;
}

export interface AppInstallationView {
  installationId: number;
  accountLogin: string;
  /** GitHub's own view (from the App JWT listing). */
  suspended: boolean;
  /** True when our install store also has a row for it. */
  known: boolean;
}

export interface WebhookDeliveryView {
  id: number;
  event: string;
  action: string | null;
  status: string;
  statusCode: number;
  deliveredAt: string;
  durationMs: number;
  redelivery: boolean;
}

/**
 * Webhook health. Deliberately evidence-based (spec 04 § webhook health): a green state
 * requires either a delivery we actually accepted (`lastReceivedAt`, from the Ingest
 * heartbeat) or a successful delivery in GitHub's own log — never merely "the webhook-secret
 * parameter exists".
 */
export interface WebhookHealthView {
  /** URL GitHub is configured to POST to, as reported by GitHub. */
  configuredUrl?: string;
  /** The receiver URL this deployment actually exposes. */
  deployedUrl?: string;
  /** True when both are known and differ — the post-redeploy failure mode. */
  urlMismatch: boolean;
  secretConfigured?: boolean;
  insecureSsl?: boolean;
  /** Heartbeat: when we last accepted a signature-verified delivery. */
  lastReceivedAt?: string;
  lastReceivedEvent?: string;
  lastDeliveryId?: string;
  deliveries?: number;
  /** Heartbeat: last delivery that FAILED signature verification (secret mismatch). */
  lastRejectedAt?: string;
  rejections?: number;
  /** GitHub's delivery log (most recent first). */
  recentDeliveries: WebhookDeliveryView[];
  /** Deliveries in that window GitHub could not deliver successfully. */
  recentFailures: number;
  /** Why webhook data is missing/partial (e.g. the App JWT lacks hook scope). */
  error?: string;
  /** Folded state for the badge. */
  state: 'healthy' | 'degraded' | 'unknown';
}

export interface RunnerLabelsView {
  /** The effective claim list, as Ingest reads it. */
  labels: string[];
  /** True when the parameter is missing entirely (nothing is claimed). */
  unset: boolean;
  /** Labels in the list that name GitHub-hosted images (adopt-mode takeover). */
  hostedLabels: string[];
}

export interface AuditEntryView {
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

export interface SettingsView {
  envName: string;
  region: string;
  /** Live GitHub App linkage — verified, not parroted from SSM. */
  app: AppLinkageAppView | null;
  /** Present when live verification failed; the UI shows it instead of a green badge. */
  appVerifyError?: string;
  /** App id recorded in config, so a mismatch with `app.appId` is visible. */
  configuredAppId?: string;
  installations: AppInstallationView[];
  /**
   * How many installations were withheld from `installations` because this session does not
   * administer them (ADR-035 scoping).
   *
   * Without it the client cannot tell "the App is installed nowhere" from "the App is installed,
   * but not on an account you administer" — and a zero-grant session (minted on purpose so Setup
   * is reachable) would be shown the first claim while the second is true.
   */
  installationsHidden: number;
  runnerLabels: RunnerLabelsView;
  webhook: WebhookHealthView;
  flavors: FlavorView[];
  recentChanges: AuditEntryView[];
  /**
   * Diagnostics: SSM parameter presence/health ONLY — spec 04 hard rule, never values. Kept
   * out of the primary view (collapsed "advanced" section) because SSM paths are an
   * implementation detail an operator should not have to reason about.
   */
  diagnostics: { secrets: SecretStatus[] };
}

/**
 * Redaction guard (spec 04 hard rule). Any settings payload leaving the API is built here;
 * the shape has no field that could carry a secret value, and this helper strips anything
 * a future caller mistakenly attaches to a secret status entry.
 */
export function toSecretStatus(param: string, label: string, present: boolean): SecretStatus {
  return { param, label, present };
}

/**
 * Fold webhook evidence into a state for the badge.
 *
 * `healthy` needs POSITIVE evidence and NO contradiction: no URL mismatch, no `insecure_ssl`,
 * no signature rejection newer than the last accepted delivery, no failed delivery in GitHub's
 * log newer than the last accepted delivery, and either an accepted delivery or a 2xx in
 * GitHub's log. Everything ambiguous is `unknown` rather than green — the whole point of this
 * screen is that a checkmark must mean something.
 */
export function foldWebhookState(
  h: Omit<WebhookHealthView, 'state' | 'urlMismatch' | 'recentFailures'> & {
    urlMismatch: boolean;
    recentFailures: number;
  },
): WebhookHealthView['state'] {
  if (h.urlMismatch) return 'degraded';
  if (h.insecureSsl) return 'degraded';
  const accepted = h.lastReceivedAt ? Date.parse(h.lastReceivedAt) : 0;
  const acceptedAt = Number.isFinite(accepted) ? accepted : 0;
  // A rejection newer than the newest accepted delivery ⇒ the secret no longer matches.
  if (h.lastRejectedAt) {
    const rejected = Date.parse(h.lastRejectedAt);
    if (Number.isFinite(rejected) && rejected >= acceptedAt) return 'degraded';
  }
  // A FAILED delivery in GitHub's log that is at least as recent as our newest accepted one is
  // current external evidence against health — a stale success must not mask it. (Older
  // failures are history: they were superseded by a delivery we accepted.)
  const failedRecently = h.recentDeliveries.some((d) => {
    if (d.statusCode >= 200 && d.statusCode < 300) return false;
    const at = Date.parse(d.deliveredAt);
    // An unparseable timestamp is treated as current: fail toward `degraded`, not green.
    return !Number.isFinite(at) || at >= acceptedAt;
  });
  if (failedRecently) return 'degraded';
  if (h.recentFailures > 0 && !h.lastReceivedAt) return 'degraded';
  const deliveredOk = h.recentDeliveries.some((d) => d.statusCode >= 200 && d.statusCode < 300);
  if (h.lastReceivedAt || deliveredOk) return 'healthy';
  return 'unknown';
}

/** Build the webhook health block from the heartbeat row + GitHub's delivery log. */
export function buildWebhookHealth(input: {
  configuredUrl?: string;
  deployedUrl?: string;
  secretConfigured?: boolean;
  insecureSsl?: boolean;
  heartbeat?: {
    lastEvent?: string;
    lastAt?: string;
    lastDeliveryId?: string;
    deliveries?: number;
    lastRejectedAt?: string;
    rejections?: number;
  };
  recentDeliveries?: WebhookDeliveryView[];
  error?: string;
}): WebhookHealthView {
  const recentDeliveries = input.recentDeliveries ?? [];
  const recentFailures = recentDeliveries.filter(
    (d) => !(d.statusCode >= 200 && d.statusCode < 300),
  ).length;
  const urlMismatch = Boolean(
    input.configuredUrl && input.deployedUrl && normalizeUrl(input.configuredUrl) !== normalizeUrl(input.deployedUrl),
  );
  const base = {
    configuredUrl: input.configuredUrl,
    deployedUrl: input.deployedUrl,
    urlMismatch,
    secretConfigured: input.secretConfigured,
    insecureSsl: input.insecureSsl,
    lastReceivedAt: input.heartbeat?.lastAt || undefined,
    lastReceivedEvent: input.heartbeat?.lastEvent || undefined,
    lastDeliveryId: input.heartbeat?.lastDeliveryId || undefined,
    deliveries: input.heartbeat?.deliveries,
    lastRejectedAt: input.heartbeat?.lastRejectedAt || undefined,
    rejections: input.heartbeat?.rejections,
    recentDeliveries,
    recentFailures,
    error: input.error,
  };
  return { ...base, state: foldWebhookState(base) };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Which repos/workflows reference labels that are about to stop (or start) being claimed.
 *
 * Shown BEFORE a label change is committed (spec 04 § Settings): changing the claim list
 * takes effect on the very next `workflow_job` webhook, so an operator needs to see whose
 * jobs move before they press the button, not after.
 */
export interface LabelImpactView {
  current: string[];
  proposed: string[];
  added: string[];
  removed: string[];
  /** Jobs that are claimed today but would NOT be after the change. */
  losing: LabelImpactJob[];
  /** Jobs that are not claimed today but WOULD be after the change. */
  gaining: LabelImpactJob[];
  /** True when the analysis is based on fewer workflows than exist (bounded scan). */
  truncated: boolean;
  /**
   * WHY the analysis is partial — the two causes are not interchangeable and the operator has to
   * be told them apart, because this preview is their only warning before a change that takes
   * effect for every tenant on the next webhook:
   *
   *  - `repoCap`: the scan stopped at the repo bound, so jobs in the repos past it are unlisted.
   *  - `unverifiedInstallations`: the App linkage could not be verified, so the installation
   *    enumeration fell back to the index plus this session's grants. Whole INSTALLATIONS may be
   *    missing, not merely repos past a cap — a materially larger blind spot.
   *
   * `truncated` stays as the single "do not read this as complete" flag; this says which caveat
   * to show.
   */
  partial: { repoCap: boolean; unverifiedInstallations: boolean };
}

export interface LabelImpactJob {
  repoId: number;
  repoFullName: string;
  workflowPath: string;
  jobId: string;
  runsOn: string[];
}

/**
 * Compute the claim-set delta over stored workflow analyses. Matching mirrors
 * `shouldClaim` exactly (case-insensitive membership of any `runs-on` label) — if these two
 * ever disagree, the preview lies, so the comparison logic is deliberately identical. Jobs the
 * control plane would refuse regardless of labels are excluded for the same reason: the caller
 * drops opted-out repos (`isRepoOptedOut`) and this drops compat-blocked jobs, matching Ingest's
 * two gates downstream of `shouldClaim`.
 */
export function buildLabelImpact(
  current: string[],
  proposed: string[],
  analyses: { repoId: number; repoFullName: string; analyses: WorkflowAnalysisRecord[] }[],
  partial: { repoCap: boolean; unverifiedInstallations: boolean } = {
    repoCap: false,
    unverifiedInstallations: false,
  },
): LabelImpactView {
  const cur = new Set(current.map((l) => l.toLowerCase()));
  const next = new Set(proposed.map((l) => l.toLowerCase()));
  const losing: LabelImpactJob[] = [];
  const gaining: LabelImpactJob[] = [];

  for (const repo of analyses) {
    for (const a of repo.analyses) {
      for (const job of a.parsed?.jobs ?? []) {
        // Ingest's compat gate refuses a job whose stored analysis says `block`, whatever its
        // labels (`matchJobAnalysis` → `compat.eligible`). Counting such a job as "newly
        // claimed" would promise a takeover that never happens; counting it as "no longer
        // claimed" would blame this change for a job that was already running on
        // GitHub-hosted. A job with NO stored compat result is claimable (Ingest fails open).
        const compat = a.compat?.jobs[job.id];
        if (compat && compat.eligible === false) continue;
        const labels = (job.runs_on ?? []).map((l) => l.toLowerCase());
        const claimedNow = labels.some((l) => cur.has(l));
        const claimedNext = labels.some((l) => next.has(l));
        if (claimedNow === claimedNext) continue;
        const entry: LabelImpactJob = {
          repoId: repo.repoId,
          repoFullName: repo.repoFullName,
          workflowPath: a.path,
          jobId: job.id,
          runsOn: job.runs_on ?? [],
        };
        (claimedNow ? losing : gaining).push(entry);
      }
    }
  }

  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  return {
    current,
    proposed,
    added: lower(proposed).filter((l) => !cur.has(l)),
    removed: lower(current).filter((l) => !next.has(l)),
    losing,
    gaining,
    truncated: partial.repoCap || partial.unverifiedInstallations,
    partial,
  };
}

/** Labels in an effective claim list that name GitHub-hosted runner images. */
export function hostedLabelsIn(labels: string[], hosted: readonly string[]): string[] {
  const set = new Set(hosted.map((l) => l.toLowerCase()));
  return labels.filter((l) => set.has(l.toLowerCase()));
}

/**
 * Narrow a settings view to what THIS session may see (ADR-035).
 *
 * Everything else on the screen is environment-level (which App this deployment authenticates
 * as, what it claims, whether GitHub reaches it) and stays readable — spec 04 requires a fresh
 * environment to be able to show its own state. Two blocks are NOT environment-level and are
 * scoped here instead:
 *
 *  - **installations** name other tenants (account login + installation id). Any GitHub user
 *    can complete the OAuth dance — a zero-grant session is minted on purpose so Setup is
 *    reachable — so returning the full list would let any authenticated stranger enumerate
 *    every org/user that installed the App. Filtered to the session's own grants, exactly like
 *    `GET /api/installations`; platform admins see all of them (they already hold
 *    platform-wide authority, and reviewing a relink needs the full picture).
 *  - **recentChanges** is the operator audit trail (who changed what). Platform admins only.
 *
 * Pure so the decision is unit-testable without AWS.
 */
export function scopeSettingsView<T extends SettingsView>(
  view: T,
  opts: { isPlatformAdmin: boolean; canSeeInstallation: (installationId: number) => boolean },
): T {
  if (opts.isPlatformAdmin) return { ...view, installationsHidden: 0 };
  const visible = view.installations.filter((i) => opts.canSeeInstallation(i.installationId));
  return {
    ...view,
    installations: visible,
    // The COUNT is not itself cross-tenant data (it names no account and no id), and withholding
    // it is what makes the screen lie: an operator whose grants cover none of this environment's
    // installations would otherwise be told the App is installed nowhere.
    installationsHidden: view.installations.length - visible.length,
    recentChanges: [],
  };
}
