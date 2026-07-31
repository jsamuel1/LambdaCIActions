import type { RunRecord, RunStatus } from '../shared/types.js';
import { ALL_STATUSES, billableSeconds, isCostEligible, flavorRatePerMinute, flavorNames } from './views.js';

/**
 * Reporting read model (spec 04 § Reports, ADR-043/044/045).
 *
 * Everything here is **pure**: the closed report vocabulary, the spec validator, the folds
 * that turn run rows into series, the percentile maths and the CSV serializer. The DynamoDB
 * fan-out that supplies the rows lives in `report-store.ts`, and the Bedrock call that
 * *proposes* a spec lives in `nl-report.ts`.
 *
 * Two invariants this module exists to enforce:
 *
 *  1. **A report spec is a closed vocabulary, not code.** `validateReportSpec` is the ONLY
 *     way a spec is constructed — from query params (manual picker) or from a model
 *     response (Part C). It rejects anything outside the enumerated metrics / dimensions /
 *     chart types / filter fields, so a model can never widen the query surface, author a
 *     DynamoDB expression, or smuggle a renderable payload (ADR-045).
 *  2. **Authorization is never a spec field.** A spec carries `repoIds` as a *narrowing*
 *     filter only; the set of repos actually read is computed server-side from the session's
 *     installations (see `report-store.ts`) and then intersected. A spec asking for a repo
 *     the operator cannot see yields no rows, not a leak.
 */

// ---- closed vocabulary -----------------------------------------------------

/** Metrics a report can compute. Adding one here is the only way to add a report. */
export const METRICS = [
  'spend',
  'runCount',
  'duration',
  'failureRate',
  'queueLatency',
] as const;
export type ReportMetric = (typeof METRICS)[number];

/** Dimensions a metric can be grouped by. `time` buckets by the range's bucket size. */
export const DIMENSIONS = ['repo', 'flavor', 'workflow', 'status', 'time', 'none'] as const;
export type ReportDimension = (typeof DIMENSIONS)[number];

/**
 * Chart types the frontend can actually render. This list is the model's menu AND the
 * validator's allowlist, so it must never contain a type the renderer does not handle — a spec
 * the picker offers (or the model chooses) that falls through to a different chart is the exact
 * silent-wrong-answer failure the closed vocabulary exists to prevent. Adding a type here means
 * adding it to `CHART_RENDERING` in `web/src/screens/ReportChart.tsx`, which TypeScript and
 * `test/reports.test.mjs` both enforce.
 *
 * A duration/latency histogram was considered and left out: the distribution question is already
 * answered by the p50/p90 pair those metrics return, and shipping a `histogram` value that
 * rendered as a bar chart would be worse than not offering it.
 */
export const CHART_TYPES = ['bar', 'stackedBar', 'line', 'table'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Time-range presets. Bounded by run-row retention — see `MAX_RANGE_DAYS`. */
export const RANGE_PRESETS = ['24h', '7d', '30d', '90d'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/**
 * Hard ceiling on a report window: terminal run rows carry a 90-day DynamoDB TTL
 * (`TERMINAL_TTL_SECONDS` in run-store), so a wider window cannot return more data — it
 * would just cost more reads and imply a completeness the store cannot deliver.
 */
export const MAX_RANGE_DAYS = 90;

const PRESET_HOURS: Record<RangePreset, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };

/** Which chart types make sense for a metric+dimension pair (the UI and the model share this). */
export const DEFAULT_CHART: Record<ReportMetric, ChartType> = {
  spend: 'bar',
  runCount: 'stackedBar',
  duration: 'bar',
  failureRate: 'bar',
  queueLatency: 'bar',
};

export interface ReportFilters {
  repoIds?: number[];
  flavors?: string[];
  statuses?: RunStatus[];
}

export interface ReportSpec {
  metric: ReportMetric;
  dimension: ReportDimension;
  chart: ChartType;
  filters: ReportFilters;
  /** Inclusive ISO8601 window start. */
  from: string;
  /** Exclusive ISO8601 window end. */
  to: string;
  /** Preset the window came from, when it did — kept so the UI can round-trip the picker. */
  preset?: RangePreset;
}

/** Catalog entry describing a metric to operators (and to the model, verbatim). */
export interface MetricDoc {
  metric: ReportMetric;
  label: string;
  /** The counting unit — stated because "runs" is ambiguous (see `unitNote`). */
  unit: string;
  /** Precise definition of what is counted / summed, including exclusions. */
  definition: string;
  /** True when the value is a derived estimate rather than measured truth. */
  estimate: boolean;
}

/**
 * The report catalog. This is the operator-facing contract AND the model's menu — the same
 * text is embedded in the prompt, so a definition can't drift between the two.
 *
 * Counting unit, stated once: **every row is one workflow JOB**, not one workflow run. A
 * GitHub `workflow_run` with five jobs produces five rows (the store is keyed by
 * `(repoId, runId, jobId)`), because a job is what occupies a microVM. "Run count" therefore
 * means job count; the UI labels it "jobs".
 */
export const METRIC_CATALOG: readonly MetricDoc[] = [
  {
    metric: 'spend',
    label: 'Estimated spend (USD)',
    unit: 'USD',
    definition:
      'Sum of per-job estimated microVM cost: billable minutes × the flavor rate derived ' +
      'from its vCPU/GB footprint. Jobs with no flavor (never launched) contribute 0. ' +
      'ESTIMATE — not billing truth.',
    estimate: true,
  },
  {
    metric: 'runCount',
    label: 'Job count',
    unit: 'jobs',
    definition:
      'Number of workflow-job rows created in the window (one row per job, not per ' +
      'workflow run), counted by the job\'s queued timestamp.',
    estimate: false,
  },
  {
    metric: 'duration',
    label: 'Job duration (p50 / p90)',
    unit: 'seconds',
    definition:
      'Wall-clock seconds from queued to the last transition, over TERMINAL jobs only ' +
      '(in-flight jobs have no duration yet). Reported as p50/p90, not mean.',
    estimate: false,
  },
  {
    metric: 'failureRate',
    label: 'Failure rate',
    unit: 'ratio 0-1',
    definition:
      '(failed + timed_out) ÷ terminal jobs. Non-terminal jobs are excluded from BOTH ' +
      'numerator and denominator, so an in-flight job never depresses the rate.',
    estimate: false,
  },
  {
    metric: 'queueLatency',
    label: 'Queue-to-start latency (p50 / p90)',
    unit: 'seconds',
    definition:
      'Seconds from queued to first entry into `running`, over jobs that carry a ' +
      '`runningAt` watermark. Jobs without one are EXCLUDED and reported as coverage, never ' +
      'counted as zero. A watermark is missing on a pre-M5 row AND on a job whose terminal ' +
      'webhook beat the `running` transition, so the excluded rows skew FAST — read the ' +
      'percentiles as covering the jobs that were observably queued.',
    estimate: false,
  },
];

export function metricDoc(metric: ReportMetric): MetricDoc {
  const doc = METRIC_CATALOG.find((m) => m.metric === metric);
  if (!doc) throw new Error(`no catalog entry for metric ${metric}`);
  return doc;
}

// ---- spec validation -------------------------------------------------------

export type SpecResult = { ok: true; value: ReportSpec } | { ok: false; errors: string[] };

const MAX_FILTER_VALUES = 50;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseIso(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/** Resolve a preset into an explicit window ending at `now`. */
export function presetWindow(preset: RangePreset, now: Date = new Date()): { from: string; to: string } {
  const to = now.getTime();
  return {
    from: new Date(to - PRESET_HOURS[preset] * 3_600_000).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/**
 * Validate an untrusted report-spec object into a `ReportSpec`.
 *
 * Total and closed: unknown top-level fields, unknown filter fields, unknown enum values and
 * out-of-range windows are all rejected with operator-readable errors rather than coerced.
 * This is the single validator for BOTH the manual picker's query params and a model
 * response (ADR-045) — so the security boundary cannot be bypassed by the newer caller.
 */
export function validateReportSpec(input: unknown, now: Date = new Date()): SpecResult {
  if (!isPlainObject(input)) return { ok: false, errors: ['spec must be a JSON object'] };
  const errors: string[] = [];
  const allowed = new Set(['metric', 'dimension', 'chart', 'filters', 'from', 'to', 'preset']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  }

  const metric = input.metric;
  if (typeof metric !== 'string' || !(METRICS as readonly string[]).includes(metric)) {
    errors.push(`metric must be one of ${METRICS.join(', ')}`);
  }
  const dimension = input.dimension ?? 'none';
  if (typeof dimension !== 'string' || !(DIMENSIONS as readonly string[]).includes(dimension)) {
    errors.push(`dimension must be one of ${DIMENSIONS.join(', ')}`);
  }

  // Window: an explicit from/to pair wins; otherwise a preset; otherwise the 7d default.
  let from: string | undefined;
  let to: string | undefined;
  let preset: RangePreset | undefined;
  if (input.preset !== undefined) {
    if (typeof input.preset !== 'string' || !(RANGE_PRESETS as readonly string[]).includes(input.preset)) {
      errors.push(`preset must be one of ${RANGE_PRESETS.join(', ')}`);
    } else {
      preset = input.preset as RangePreset;
    }
  }
  if (input.from !== undefined || input.to !== undefined) {
    const fromMs = parseIso(input.from);
    const toMs = parseIso(input.to);
    if (fromMs === undefined) errors.push('from must be an ISO8601 timestamp');
    if (toMs === undefined) errors.push('to must be an ISO8601 timestamp');
    if (fromMs !== undefined && toMs !== undefined) {
      if (toMs <= fromMs) errors.push('to must be after from');
      else if (toMs - fromMs > MAX_RANGE_DAYS * 86_400_000) {
        errors.push(`window exceeds the ${MAX_RANGE_DAYS}-day run retention`);
      } else {
        from = new Date(fromMs).toISOString();
        to = new Date(toMs).toISOString();
        preset = undefined; // an explicit window is not a preset, even if one was also sent
      }
    }
  } else {
    const win = presetWindow(preset ?? '7d', now);
    from = win.from;
    to = win.to;
    preset = preset ?? '7d';
  }

  const filters: ReportFilters = {};
  if (input.filters !== undefined) {
    if (!isPlainObject(input.filters)) {
      errors.push('filters must be an object');
    } else {
      const fAllowed = new Set(['repoIds', 'flavors', 'statuses']);
      for (const key of Object.keys(input.filters)) {
        if (!fAllowed.has(key)) errors.push(`unknown filter "${key}"`);
      }
      const f = input.filters;
      if (f.repoIds !== undefined) {
        if (!Array.isArray(f.repoIds) || f.repoIds.length > MAX_FILTER_VALUES) {
          errors.push(`filters.repoIds must be an array of at most ${MAX_FILTER_VALUES} repo ids`);
        } else {
          const ids = f.repoIds.filter(
            (v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0,
          );
          if (ids.length !== f.repoIds.length) errors.push('filters.repoIds must be positive integers');
          else if (ids.length) filters.repoIds = ids;
        }
      }
      if (f.flavors !== undefined) {
        const known = new Set(flavorNames());
        if (!Array.isArray(f.flavors) || f.flavors.length > MAX_FILTER_VALUES) {
          errors.push(`filters.flavors must be an array of at most ${MAX_FILTER_VALUES} names`);
        } else {
          const bad = f.flavors.filter((v) => typeof v !== 'string' || !known.has(v));
          if (bad.length) errors.push(`unknown flavor(s): ${bad.map(String).join(', ')}`);
          else if (f.flavors.length) filters.flavors = f.flavors as string[];
        }
      }
      if (f.statuses !== undefined) {
        if (!Array.isArray(f.statuses)) {
          errors.push('filters.statuses must be an array');
        } else {
          const bad = f.statuses.filter(
            (v) => typeof v !== 'string' || !(ALL_STATUSES as readonly string[]).includes(v),
          );
          if (bad.length) errors.push(`unknown status(es): ${bad.map(String).join(', ')}`);
          else if (f.statuses.length) filters.statuses = f.statuses as RunStatus[];
        }
      }
    }
  }

  let chart: ChartType | undefined;
  if (input.chart === undefined) {
    if (typeof metric === 'string' && (METRICS as readonly string[]).includes(metric)) {
      chart = DEFAULT_CHART[metric as ReportMetric];
    }
  } else if (typeof input.chart !== 'string' || !(CHART_TYPES as readonly string[]).includes(input.chart)) {
    errors.push(`chart must be one of ${CHART_TYPES.join(', ')}`);
  } else {
    chart = input.chart as ChartType;
  }

  if (errors.length || !from || !to || !chart) {
    return { ok: false, errors: errors.length ? errors : ['spec could not be resolved'] };
  }
  return {
    ok: true,
    value: {
      metric: metric as ReportMetric,
      dimension: dimension as ReportDimension,
      chart,
      filters,
      from,
      to,
      ...(preset ? { preset } : {}),
    },
  };
}

/** Build a spec from the manual picker's query params (strings) via the same validator. */
export function specFromQuery(
  q: Record<string, string | undefined>,
  now: Date = new Date(),
): SpecResult {
  const csv = (raw: string | undefined): string[] | undefined =>
    raw === undefined ? undefined : raw.split(',').map((s) => s.trim()).filter(Boolean);
  const repoIds = csv(q.repos)?.map((s) => (/^\d+$/.test(s) ? Number(s) : Number.NaN));
  const filters: Record<string, unknown> = {};
  if (repoIds) filters.repoIds = repoIds;
  const flavors = csv(q.flavors);
  if (flavors) filters.flavors = flavors;
  const statuses = csv(q.statuses);
  if (statuses) filters.statuses = statuses;
  return validateReportSpec(
    {
      ...(q.metric !== undefined ? { metric: q.metric } : { metric: 'spend' }),
      ...(q.dimension !== undefined ? { dimension: q.dimension } : {}),
      ...(q.chart !== undefined ? { chart: q.chart } : {}),
      ...(q.preset !== undefined ? { preset: q.preset } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
    },
    now,
  );
}

// ---- cost model ------------------------------------------------------------

/**
 * Billable seconds + basis. Re-exported from `views.ts` rather than reimplemented: Run detail
 * and Reports must never disagree about what a single run cost, so there is exactly one
 * definition of billable time (ADR-042).
 */
export { billableSeconds } from './views.js';

/**
 * Estimated USD for one job. `0` when the row is not evidence a microVM ran — the same
 * `isCostEligible` gate Run detail and the Dashboard use, so a mint/launch-failure row (which
 * carries the intended `flavor` for support but never had a VM) is not priced here while being
 * unpriced there. ADR-042's "one definition of billable time" has to mean one *eligibility*
 * rule too, or the two screens disagree about the same job.
 */
export function jobCostUsd(
  run: Pick<
    RunRecord,
    'createdAt' | 'updatedAt' | 'runningAt' | 'flavor' | 'status' | 'microvmId'
  >,
  now: Date = new Date(),
): number {
  if (!isCostEligible(run)) return 0;
  const rate = flavorRatePerMinute(run.flavor)!;
  return (billableSeconds(run, now).seconds / 60) * rate;
}

// ---- folds -----------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'timed_out']);
const BAD_STATUSES: ReadonlySet<RunStatus> = new Set(['failed', 'timed_out']);

/** One plotted point. `value` is the metric; `secondary` carries p90 where a metric has one. */
export interface SeriesPoint {
  key: string;
  label: string;
  value: number;
  secondary?: number;
  /** Rows that contributed — shown so a point built from 3 jobs isn't read as a trend. */
  sampleSize: number;
}

export interface ReportResult {
  spec: ReportSpec;
  metric: MetricDoc;
  points: SeriesPoint[];
  /** Total across every point, when the metric is additive (spend, runCount). */
  total?: number;
  /** Rows read after filtering. */
  rowCount: number;
  /**
   * False when the underlying fan-out spent its page budget — the numbers are then a FLOOR
   * over a partial window, not a total. Surfaced in the API and the UI.
   */
  complete: boolean;
  /** Fraction of contributing rows whose value was measured rather than inferred (0-1). */
  coverage: number;
  /** Human note about what the coverage/estimate caveat means for this metric. */
  caveat?: string;
  generatedAt: string;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  // Nearest-rank: index = ceil(p × n) − 1. No interpolation — with tens of samples an
  // interpolated p90 invents a value between two real jobs.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function percentiles(values: number[]): { p50: number; p90: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: pct(sorted, 50), p90: pct(sorted, 90) };
}

/** Bucket size for the `time` dimension: hourly under 3 days, else daily. */
export function timeBucket(from: string, to: string): 'hour' | 'day' {
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) && span <= 3 * 86_400_000 ? 'hour' : 'day';
}

function bucketKey(iso: string, bucket: 'hour' | 'day'): string {
  return bucket === 'hour' ? `${iso.slice(0, 13)}:00` : iso.slice(0, 10);
}

function groupKey(run: RunRecord, spec: ReportSpec): { key: string; label: string } {
  switch (spec.dimension) {
    case 'repo':
      return { key: String(run.repoId), label: run.repoFullName };
    case 'flavor':
      return { key: run.flavor ?? '(not launched)', label: run.flavor ?? '(not launched)' };
    case 'workflow':
      return { key: run.workflowName ?? '(unknown)', label: run.workflowName ?? '(unknown)' };
    case 'status':
      return { key: run.status, label: run.status };
    case 'time': {
      const k = bucketKey(run.createdAt, timeBucket(spec.from, spec.to));
      return { key: k, label: k };
    }
    case 'none':
      return { key: 'all', label: 'All' };
  }
}

/** Apply a spec's non-authorization filters to fetched rows. */
export function applyFilters(runs: RunRecord[], spec: ReportSpec): RunRecord[] {
  const flavors = spec.filters.flavors ? new Set(spec.filters.flavors) : undefined;
  const statuses = spec.filters.statuses ? new Set(spec.filters.statuses) : undefined;
  const fromMs = Date.parse(spec.from);
  const toMs = Date.parse(spec.to);
  return runs.filter((r) => {
    const t = Date.parse(r.createdAt);
    if (!Number.isFinite(t) || t < fromMs || t >= toMs) return false;
    if (flavors && !flavors.has(r.flavor ?? '')) return false;
    if (statuses && !statuses.has(r.status)) return false;
    return true;
  });
}

/**
 * Fold filtered rows into a report result. Pure — the caller has already applied both
 * authorization (which repos were read) and `applyFilters`.
 */
export function computeReport(
  runs: RunRecord[],
  spec: ReportSpec,
  opts: { complete?: boolean; now?: Date } = {},
): ReportResult {
  const now = opts.now ?? new Date();
  const groups = new Map<string, { label: string; runs: RunRecord[] }>();
  for (const r of runs) {
    const { key, label } = groupKey(r, spec);
    const g = groups.get(key);
    if (g) g.runs.push(r);
    else groups.set(key, { label, runs: [r] });
  }

  let coverageNum = 0;
  let coverageDen = 0;
  const points: SeriesPoint[] = [];

  for (const [key, g] of groups) {
    switch (spec.metric) {
      case 'spend': {
        let usd = 0;
        for (const r of g.runs) {
          usd += jobCostUsd(r, now);
          // Coverage is over the rows that were actually PRICED, not every row in the group.
          // A queued / launch-failure row contributes 0 to spend (`isCostEligible`), so
          // counting it in the denominator understated coverage on exactly the metric whose
          // caveat then claimed the uncovered share was priced on overstating wall clock —
          // it was not priced at all. An unpriced row is silent in both, so the ratio means
          // what the caveat says it means.
          if (!isCostEligible(r)) continue;
          coverageDen += 1;
          if (billableSeconds(r, now).basis === 'measured') coverageNum += 1;
        }
        points.push({ key, label: g.label, value: round(usd, 6), sampleSize: g.runs.length });
        break;
      }
      case 'runCount':
        coverageDen += g.runs.length;
        coverageNum += g.runs.length;
        points.push({ key, label: g.label, value: g.runs.length, sampleSize: g.runs.length });
        break;
      case 'duration': {
        const terminal = g.runs.filter((r) => TERMINAL_STATUSES.has(r.status));
        coverageDen += g.runs.length;
        coverageNum += terminal.length;
        if (!terminal.length) break;
        const secs = terminal.map((r) => wallClockSeconds(r));
        const { p50, p90 } = percentiles(secs);
        points.push({ key, label: g.label, value: p50, secondary: p90, sampleSize: terminal.length });
        break;
      }
      case 'failureRate': {
        const terminal = g.runs.filter((r) => TERMINAL_STATUSES.has(r.status));
        coverageDen += g.runs.length;
        coverageNum += terminal.length;
        if (!terminal.length) break;
        const bad = terminal.filter((r) => BAD_STATUSES.has(r.status)).length;
        points.push({
          key,
          label: g.label,
          value: round(bad / terminal.length, 4),
          sampleSize: terminal.length,
        });
        break;
      }
      case 'queueLatency': {
        const withWatermark = g.runs.filter((r) => !!r.runningAt);
        coverageDen += g.runs.length;
        coverageNum += withWatermark.length;
        if (!withWatermark.length) break;
        const secs = withWatermark.map((r) => queueSeconds(r));
        const { p50, p90 } = percentiles(secs);
        points.push({
          key,
          label: g.label,
          value: p50,
          secondary: p90,
          sampleSize: withWatermark.length,
        });
        break;
      }
    }
  }

  // Time buckets sort chronologically; every other dimension sorts by magnitude so the
  // biggest spender / worst failure rate is the first bar rather than an alphabetical accident.
  points.sort((a, b) =>
    spec.dimension === 'time' ? a.key.localeCompare(b.key) : b.value - a.value || a.label.localeCompare(b.label),
  );

  const additive = spec.metric === 'spend' || spec.metric === 'runCount';
  const doc = metricDoc(spec.metric);
  return {
    spec,
    metric: doc,
    points,
    ...(additive ? { total: round(points.reduce((s, p) => s + p.value, 0), 6) } : {}),
    rowCount: runs.length,
    complete: opts.complete ?? true,
    coverage: coverageDen === 0 ? 1 : round(coverageNum / coverageDen, 4),
    caveat: caveatFor(spec.metric),
    generatedAt: now.toISOString(),
  };
}

function caveatFor(metric: ReportMetric): string | undefined {
  switch (metric) {
    case 'spend':
      return 'Estimate. Coverage is the share of PRICED jobs whose billable window was measured from the runningAt watermark; the remainder use queue-to-finish wall clock, which OVERSTATES cost. Jobs that never launched a microVM are priced at 0 and counted in neither share.';
    case 'duration':
      return 'Coverage is the share of jobs that reached a terminal status; in-flight jobs are excluded.';
    case 'failureRate':
      return 'Coverage is the share of jobs that reached a terminal status; in-flight jobs are excluded from numerator and denominator.';
    case 'queueLatency':
      return 'Coverage is the share of jobs carrying a runningAt watermark; the rest are excluded, not counted as zero. A watermark is absent on pre-M5 rows and on jobs that finished before the running transition landed, so the excluded rows are biased towards FAST jobs and these percentiles read slightly high.';
    case 'runCount':
      return undefined;
  }
}

function wallClockSeconds(run: Pick<RunRecord, 'createdAt' | 'updatedAt'>): number {
  const a = Date.parse(run.createdAt);
  const b = Date.parse(run.updatedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 1000);
}

function queueSeconds(run: Pick<RunRecord, 'createdAt' | 'runningAt'>): number {
  const a = Date.parse(run.createdAt);
  const b = run.runningAt ? Date.parse(run.runningAt) : Number.NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 1000);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ---- export ----------------------------------------------------------------

/** Row shape of a report export — the underlying jobs, not the aggregate. */
export const EXPORT_COLUMNS = [
  'repoId',
  'repoFullName',
  'runId',
  'jobId',
  'status',
  'flavor',
  'workflowName',
  'jobName',
  'createdAt',
  'runningAt',
  'updatedAt',
  'wallClockSeconds',
  'billableSeconds',
  'costBasis',
  'estimatedCostUsd',
] as const;

export interface ExportRow {
  [k: string]: string | number;
}

export function toExportRows(runs: RunRecord[], now: Date = new Date()): ExportRow[] {
  return runs.map((r) => {
    const billable = billableSeconds(r, now);
    return {
      repoId: r.repoId,
      repoFullName: r.repoFullName,
      runId: r.runId,
      jobId: r.jobId,
      status: r.status,
      flavor: r.flavor ?? '',
      workflowName: r.workflowName ?? '',
      jobName: r.jobName ?? '',
      createdAt: r.createdAt,
      runningAt: r.runningAt ?? '',
      updatedAt: r.updatedAt,
      wallClockSeconds: wallClockSeconds(r),
      billableSeconds: billable.seconds,
      costBasis: billable.basis,
      estimatedCostUsd: round(jobCostUsd(r, now), 6),
    };
  });
}

/**
 * Serialize export rows as CSV.
 *
 * Every field is quoted and inner quotes doubled (RFC 4180). Fields that begin with a
 * formula sigil are additionally prefixed with a single quote: run rows carry
 * tenant-controlled strings (repo / workflow / job names), and a name like `=cmd|'…'!A1`
 * pasted into Excel is a CSV-injection payload. The console must not hand an operator a
 * file that executes on open.
 */
export function toCsv(rows: ExportRow[], columns: readonly string[] = EXPORT_COLUMNS): string {
  const esc = (v: string | number): string => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = columns.map(esc).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c] ?? '')).join(','));
  return [head, ...body].join('\r\n');
}

/** Stable, shareable query string for a spec — the URL a report is pinned by (ADR-045). */
export function specToQuery(spec: ReportSpec): string {
  const p = new URLSearchParams();
  p.set('metric', spec.metric);
  p.set('dimension', spec.dimension);
  p.set('chart', spec.chart);
  if (spec.preset) p.set('preset', spec.preset);
  else {
    p.set('from', spec.from);
    p.set('to', spec.to);
  }
  if (spec.filters.repoIds?.length) p.set('repos', spec.filters.repoIds.join(','));
  if (spec.filters.flavors?.length) p.set('flavors', spec.filters.flavors.join(','));
  if (spec.filters.statuses?.length) p.set('statuses', spec.filters.statuses.join(','));
  return p.toString();
}
