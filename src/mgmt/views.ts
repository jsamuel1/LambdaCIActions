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
  /**
   * Which clock the cost came from: `measured` (the `runningAt` watermark, ADR-042) or
   * `wallClock` (a pre-watermark row, which overstates). Exposed so the UI states the bias
   * instead of presenting both kinds of estimate as equally tight.
   */
  costBasis: CostBasis;
  /** Seconds counted as billable for the cost figure. */
  billableSeconds: number;
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

/** Which clock a cost estimate was derived from — surfaced so the UI can state the bias. */
export type CostBasis = 'measured' | 'wallClock';

/** Statuses after which a run row no longer changes. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'timed_out']);

/**
 * Billable seconds for a job, and which clock produced them.
 *
 * Two independent axes, because they answer different questions:
 *
 * - **Which clock starts the window** (the `basis`). The microVM service bills only while the
 *   VM RUNS, so queue + provisioning time is not chargeable. Prefers the `runningAt` watermark
 *   (ADR-042); falls back to `createdAt` for rows written before it existed, which OVERSTATES
 *   cost. The basis is returned rather than hidden so Run detail and Reports label the estimate
 *   the same way — this is the one definition of billable time in the codebase, so the two
 *   screens cannot disagree about what the same run cost.
 * - **Which clock ends it.** A TERMINAL row ends at its last transition. A row still in flight
 *   runs to `now` instead: `updatedAt` is only written on a status TRANSITION, so an hour-old
 *   `running` job kept reporting the seconds it took to REACH `running` — Run detail polls,
 *   reprojects the same row, and showed a frozen estimate that materially understated live
 *   spend. `now` is injected so it is deterministic in tests and one instant per API response.
 */
export function billableSeconds(
  run: Pick<RunRecord, 'createdAt' | 'updatedAt' | 'runningAt' | 'status'>,
  now: Date = new Date(),
): { seconds: number; basis: CostBasis } {
  const watermark = run.runningAt ? Date.parse(run.runningAt) : Number.NaN;
  const measured = Number.isFinite(watermark);
  const start = measured ? watermark : Date.parse(run.createdAt);
  const end = TERMINAL_STATUSES.has(run.status) ? Date.parse(run.updatedAt) : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    // Clock skew / an unparseable timestamp must not invent negative spend, and must not
    // claim a `measured` basis it could not actually measure. `durationSeconds` clamps at 0.
    return { seconds: durationSeconds(run), basis: 'wallClock' };
  }
  return { seconds: Math.round((end - start) / 1000), basis: measured ? 'measured' : 'wallClock' };
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
 * Estimated cost of a run: billable minutes × flavor rate. An ESTIMATE in two ways — the rate
 * is derived from the flavor's vCPU/GB footprint rather than a bill (spec 04 OQ-3), and rows
 * with no `runningAt` watermark are priced on wall clock, which overstates.
 *
 * `undefined` when the row is not evidence of a microVM having run (see `isCostEligible` — a
 * mint/launch failure carries a flavor but no VM). The gate lives HERE, not in a caller, so the
 * per-run figure and the dashboard total cannot diverge again.
 */
export function estimateCostUsd(
  run: Pick<RunRecord, 'createdAt' | 'updatedAt' | 'runningAt' | 'flavor' | 'status' | 'microvmId'>,
  now: Date = new Date(),
): number | undefined {
  if (!isCostEligible(run)) return undefined;
  const rate = flavorRatePerMinute(run.flavor)!;
  const minutes = billableSeconds(run, now).seconds / 60;
  return Math.round(rate * minutes * 1e6) / 1e6;
}

/** Project a stored run row onto the API shape (adds derived duration + cost). */
export function toRunView(run: RunRecord, now: Date = new Date()): RunView {
  const billable = billableSeconds(run, now);
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
    costBasis: billable.basis,
    billableSeconds: billable.seconds,
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

export interface SettingsView {
  envName: string;
  region: string;
  /** Presence/health ONLY — spec 04: never return SecureString values. */
  secrets: SecretStatus[];
  flavors: FlavorView[];
}

/**
 * Redaction guard (spec 04 hard rule). Any settings payload leaving the API is built here;
 * the shape has no field that could carry a secret value, and this helper strips anything
 * a future caller mistakenly attaches to a secret status entry.
 */
export function toSecretStatus(param: string, label: string, present: boolean): SecretStatus {
  return { param, label, present };
}
