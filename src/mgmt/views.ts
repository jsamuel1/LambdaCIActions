import type { RunRecord, RunStatus, WorkflowAnalysisRecord, RepoRecord } from '../shared/types.js';
import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };
import { isAdoptLabel, nonLinuxHostedLabel } from '../ingest/adopt.js';

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
  /** Estimated microVM cost in USD; undefined when the flavor is unknown (never launched). */
  costUsd?: number;
}

/**
 * Per-minute microVM price by flavor (spec 04 OQ-3). Sourced from the flavor catalog's
 * vCPU/memory footprint × the published Graviton microVM rate rather than a hand-maintained
 * table, so adding a flavor can't silently produce a missing rate.
 *
 * Reference point (README): 2 vCPU / 4 GB ≈ $0.0044/min. Splitting that across the two
 * dimensions with AWS's usual ~2:1 vCPU:GB weighting gives the per-unit rates below.
 */
export const VCPU_USD_PER_MINUTE = 0.0011;
export const GB_USD_PER_MINUTE = 0.00055;

interface FlavorDef {
  name: string;
  label: string;
  arch: string;
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

/**
 * Estimated cost of a run: billable minutes × flavor rate. Only the `running` phase is
 * billed by the microVM service, but we don't persist a `startedAt` per phase in v1, so
 * this uses total wall-clock as an upper bound and is labelled an estimate in the UI.
 */
export function estimateCostUsd(run: Pick<RunRecord, 'createdAt' | 'updatedAt' | 'flavor'>): number | undefined {
  const rate = flavorRatePerMinute(run.flavor);
  if (rate === undefined) return undefined;
  const minutes = durationSeconds(run) / 60;
  return Math.round(rate * minutes * 1e6) / 1e6;
}

/** Project a stored run row onto the API shape (adds derived duration + cost). */
export function toRunView(run: RunRecord): RunView {
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
    costUsd: estimateCostUsd(run),
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
   * Estimated spend over the sampled terminal runs (M5 — dashboard shows health + cost).
   * Unlike `counts` (platform-wide by design), this is scoped to the caller's installations.
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
  /** Number of runs the estimate is based on (the sampled window, not all history). */
  runs: number;
  /** Sum of per-run estimates, USD. */
  totalUsd: number;
  /** Mean per-run estimate, USD; 0 when no priced runs were sampled. */
  avgUsd: number;
  /** Per-flavor breakdown so an operator can see which flavor dominates spend. */
  byFlavor: Record<string, { runs: number; usd: number }>;
}

/**
 * Fold sampled runs into a cost summary.
 *
 * Skipped: runs with no flavor (never routed) AND runs that never launched a microVM. A
 * mint/launch failure stamps `flavor` on the row (Provision records it for support) but no VM
 * ever ran, so pricing it would bill wall-clock for compute that never existed — inflating the
 * dashboard estimate with the failures an operator is already looking at. `microvmId` is the
 * only evidence a VM existed, so it is the gate.
 */
export function summarizeCost(runs: RunRecord[]): CostSummary {
  const byFlavor: Record<string, { runs: number; usd: number }> = {};
  let totalUsd = 0;
  let priced = 0;
  for (const run of runs) {
    if (!run.microvmId) continue;
    const usd = estimateCostUsd(run);
    if (usd === undefined || !run.flavor) continue;
    priced += 1;
    totalUsd += usd;
    const bucket = (byFlavor[run.flavor] ??= { runs: 0, usd: 0 });
    bucket.runs += 1;
    bucket.usd = round6(bucket.usd + usd);
  }
  return {
    runs: priced,
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
    .map(toRunView);
  return {
    counts,
    active: counts.queued + counts.provisioning + counts.running,
    errorRate: terminal === 0 ? 0 : Math.round((bad / terminal) * 1000) / 1000,
    stuck,
    cost: summarizeCost(costRuns),
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
   * A job that ALSO carries a non-Linux hosted label (`[ubuntu-latest, windows-latest]`) is
   * NOT a candidate: `decideClaim` refuses it in every mode (arm64 Linux only) and
   * `rewriteTargets` excludes it. The predicate has to agree with those two, or the console
   * counts jobs adopt mode will never claim and the RepoDetail copy ("N job(s) … run on arm64
   * microVMs") states something false about a live repo.
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
        !lower.some((l) => nonLinuxHostedLabel(l)),
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
