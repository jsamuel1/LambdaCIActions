import type { RunRecord, RunStatus } from '../shared/types.js';
import { ALL_STATUSES, billableSeconds, hasRunMicrovm, isCostEligible, flavorRatePerMinute, flavorNames } from './views.js';

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
  'billableMinutes',
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

/** Time-range presets. Bounded by run-row retention — see `maxRangeDays()`. */
export const RANGE_PRESETS = ['24h', '7d', '30d', '90d'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/**
 * Fallback ceiling on a report window, used when the λ was given no `RUN_RETENTION_DAYS`.
 * Matches `DEFAULT_RUN_RETENTION_DAYS` in run-store for the same reason it exists there: an
 * unset var must not silently shrink what an existing deployment can report on.
 */
export const DEFAULT_MAX_RANGE_DAYS = 90;

/**
 * Hard ceiling on a report window — the store's actual terminal-row retention.
 *
 * Terminal run rows carry a DynamoDB TTL of `RUN_RETENTION_DAYS` days (`terminalTtlSeconds`
 * in run-store), and that is **per-environment** (ADR-033: dev 30, prod 90). A window wider
 * than retention cannot return more data, so accepting one is not merely wasteful — the report
 * reads a partially aged-out window and still says `complete: true`, which is the silent-floor
 * failure every other budget path in this feature reports honestly. The same number is also the
 * AGE limit: `validateReportSpec` refuses an explicit window starting before `now − this`, since
 * a narrow window behind the horizon is aged out just as completely as a too-wide one. The
 * horizon is inclusive, so a window exactly retention-wide resolves at the moment it is built —
 * not forever after, because an absolute `from` necessarily crosses a moving horizon (that is
 * what the age check is for). Preset windows are immune: a preset is stored as a preset and
 * recomputed against `now` on every read. Read per call (not captured at module load) and
 * validated the same way run-store validates it, so a missing or malformed value falls back
 * instead of poisoning the container.
 */
export function maxRangeDays(): number {
  const raw = process.env.RUN_RETENTION_DAYS;
  const days = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(days) && days > 0 ? days : DEFAULT_MAX_RANGE_DAYS;
}

const PRESET_HOURS: Record<RangePreset, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };

/**
 * Presets retention can actually serve. A `90d` option in an environment that ages terminal
 * rows out at 30 days offers the operator a window the store cannot fill — the picker must not
 * list it, and `validateReportSpec` rejects it if something else asks for it anyway.
 */
export function availablePresets(max: number = maxRangeDays()): RangePreset[] {
  const allowed = RANGE_PRESETS.filter((p) => PRESET_HOURS[p] / 24 <= max);
  // Never offer nothing: a pathologically short retention still supports its narrowest window.
  return allowed.length ? allowed : [RANGE_PRESETS[0]];
}

/** Which chart types make sense for a metric+dimension pair (the UI and the model share this). */
export const DEFAULT_CHART: Record<ReportMetric, ChartType> = {
  spend: 'bar',
  // Same shape as `spend` for the same reason: an additive total per group, biggest first. It is
  // deliberately NOT `stackedBar` — a stack implies the bars compose into a meaningful whole per
  // category, which consumption per repo/flavor does not (the whole is the total, already printed).
  billableMinutes: 'bar',
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
    metric: 'billableMinutes',
    label: 'Billable compute minutes',
    unit: 'minutes',
    // Deliberately short, like `spend`'s: a definition says what the metric MEASURES and the
    // caveat carries the mechanics and the direction of the error. This one first restated the
    // whole caveat, which printed the same claim twice on the Reports panel (the definition and
    // the caveat render one after the other) and put every word of it into the assistant's
    // system prompt, which is built from this catalog (`buildSystemPrompt`).
    definition:
      'Sum of per-job billable microVM time in minutes — the same billable window `spend` is ' +
      'priced from, with the flavor rate taken out, so a job whose flavor has no rate in the ' +
      'catalog still counts its minutes. An ABSOLUTE figure, not a percentage of any capacity ' +
      'ceiling — the microVM concurrency quota is not read anywhere yet. ESTIMATE — see the ' +
      'caveat for which rows overstate.',
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
  const maxDays = maxRangeDays();
  const presets = availablePresets(maxDays);
  const allowed = new Set(['metric', 'dimension', 'chart', 'filters', 'from', 'to', 'preset']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  }

  const metric = input.metric;
  if (typeof metric !== 'string' || !(METRICS as readonly string[]).includes(metric)) {
    errors.push(`metric must be one of ${METRICS.join(', ')}`);
  }
  // `=== undefined` rather than `??`: an ABSENT dimension defaults to `none`, but an explicitly
  // supplied `null` (or any non-string) is rejected. Coercing it would repair a spec into a
  // different report than the one asked for, which is exactly what ADR-045 forbids — and the
  // `chart` branch below already behaves this way, so `??` was also an inconsistency.
  let dimension: ReportDimension | undefined;
  if (input.dimension === undefined) {
    dimension = 'none';
  } else if (
    typeof input.dimension !== 'string' ||
    !(DIMENSIONS as readonly string[]).includes(input.dimension)
  ) {
    errors.push(`dimension must be one of ${DIMENSIONS.join(', ')}`);
  } else {
    dimension = input.dimension as ReportDimension;
  }

  // Window: an explicit from/to pair wins; otherwise a preset; otherwise the 7d default.
  // Both forms are bounded by retention in TWO ways — width, and age of the window's start.
  let from: string | undefined;
  let to: string | undefined;
  let preset: RangePreset | undefined;
  if (input.preset !== undefined) {
    if (typeof input.preset !== 'string' || !(RANGE_PRESETS as readonly string[]).includes(input.preset)) {
      errors.push(`preset must be one of ${presets.join(', ')}`);
    } else if (!(presets as readonly string[]).includes(input.preset)) {
      // A preset wider than retention is REJECTED, not clamped: clamping would answer a
      // different question than the one asked while reporting `complete: true`. Reachable via a
      // shared 90d URL opened against an environment that keeps 30 days.
      errors.push(
        `preset ${input.preset} exceeds the ${maxDays}-day run retention of this environment ` +
          `(available: ${presets.join(', ')})`,
      );
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
      const horizonMs = now.getTime() - maxDays * 86_400_000;
      if (toMs <= fromMs) errors.push('to must be after from');
      else if (toMs - fromMs > maxDays * 86_400_000) {
        errors.push(`window exceeds the ${maxDays}-day run retention`);
      } else if (fromMs < horizonMs) {
        // WIDTH is not the whole cap: a NARROW window that starts before the retention horizon
        // is entirely (or partly) aged out of the table, so the report reads rows the store has
        // already deleted and answers `complete: true` over them — the same silent floor the
        // preset branch above refuses, reached by the other door. Not hypothetical: a report
        // pinned by URL carries `from`/`to` verbatim (`specToQuery`), so any bookmarked or
        // shared custom-window report becomes an aged-out one simply by the passage of time,
        // and the console then says "No jobs in this window" about jobs that did run.
        //
        // Rejected rather than clamped forward, for the reason the preset branch gives: a
        // clamped window answers a different question than the link names while still claiming
        // completeness. The error states the horizon so the operator can re-pick a window.
        errors.push(
          `from ${new Date(fromMs).toISOString()} predates the ${maxDays}-day run retention of ` +
            `this environment (no run history before ${new Date(horizonMs).toISOString()}; ` +
            `available presets: ${presets.join(', ')})`,
        );
      } else {
        from = new Date(fromMs).toISOString();
        to = new Date(toMs).toISOString();
        preset = undefined; // an explicit window is not a preset, even if one was also sent
      }
    }
  } else {
    // Default window: 7d where retention allows it, otherwise the widest preset it does.
    const fallback = presets.includes('7d') ? '7d' : presets[presets.length - 1];
    const chosen = preset ?? fallback;
    const win = presetWindow(chosen, now);
    from = win.from;
    to = win.to;
    preset = chosen;
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

  if (errors.length || !from || !to || !chart || !dimension) {
    return { ok: false, errors: errors.length ? errors : ['spec could not be resolved'] };
  }
  return {
    ok: true,
    value: {
      metric: metric as ReportMetric,
      dimension,
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
  /**
   * Total across every point, when the metric is additive — `spend`, `billableMinutes`,
   * `runCount`. Absent otherwise: summing p50 durations, failure ratios or queue latencies
   * across groups produces a number with no meaning, so the field is omitted rather than
   * computed and ignored. The predicate is in `computeReport`; keep this list with it.
   */
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
  /**
   * Rows in `coverage`'s DENOMINATOR — how many rows could have contributed to this metric at
   * all. Zero means the ratio is vacuous (0/0), which `coverage` reports as 1: without this a
   * report over 500 queued jobs claims "Coverage 100%" on a metric that measured NOTHING. The
   * UI reads this to say so instead, and to tell "no rows in the window" apart from "rows, but
   * none this metric can measure" — two states that both produce an empty series.
   */
  coverageSampleSize: number;
  /** Human note about what the coverage/estimate caveat means for this metric. */
  caveat?: string;
  /**
   * Rows a CSV/JSON export of this report will carry at most. Published so the console can warn
   * that a download will be capped BEFORE the operator clicks, rather than handing them a file
   * that is quietly shorter than `rowCount`.
   */
  exportRowLimit: number;
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

/**
 * The bucket a row falls into for a dimension, as a `{ key, label }` pair.
 *
 * `key` and `label` are NOT interchangeable for `workflow`. `workflowName` is copied verbatim
 * off the `workflow_job` webhook, so it is tenant-controlled and a repo may legitimately contain
 * a workflow literally named like the absent bucket's label. Keying the absent case by its own
 * display string would merge those rows into one bar and attribute real workflow activity to a
 * data gap (and vice versa), which is unfalsifiable from the chart. So the absent case gets a
 * key that no webhook value can produce, and every present name is namespaced under `name:`.
 *
 * `flavor` needs no such namespacing: every resolution path in `src/provision/flavor.ts` gates
 * the chosen name through `byName()`, so `run.flavor` is always a catalog entry — a tenant's
 * `runs-on:` label can select a flavor but can never become one. `(not launched)` is therefore
 * not a reachable value.
 */
function groupKey(run: RunRecord, spec: ReportSpec): { key: string; label: string } {
  switch (spec.dimension) {
    case 'repo':
      return { key: String(run.repoId), label: run.repoFullName };
    case 'flavor':
      return { key: run.flavor ?? '(not launched)', label: run.flavor ?? '(not launched)' };
    case 'workflow':
      // Labelled "no workflow name recorded", not "unknown": "(unknown)" reads like a real
      // workflow whose name could not be determined, which invites an operator to treat the
      // bucket as one workflow's activity. The label names the GAP and deliberately does NOT
      // name a cause, because there are two and only one of them is about age:
      //   - the row predates ingest persisting `workflowName` (M5), or
      //   - `workflow_job.workflow_name` was absent on the event itself — it is optional and
      //     nullable on the wire (`src/shared/types.ts`), both ingest paths coalesce it, and
      //     `run-store.ts` omits a falsy value, so a BRAND-NEW row lands here too.
      // Calling this bucket a pre-M5 row would repeat the `runningAt` mistake: numbers right,
      // explanation false for a reachable current row.
      return run.workflowName === undefined || run.workflowName === ''
        ? { key: 'workflow:unrecorded', label: '(no workflow name recorded)' }
        : { key: `name:${run.workflowName}`, label: run.workflowName };
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
      case 'spend':
      case 'billableMinutes': {
        // One arm for both, deliberately. They read the SAME billable window (ADR-042) and differ
        // only in whether the flavor rate is applied, so splitting them into two folds is how a
        // report could start claiming spend over a window it did not charge minutes for.
        //
        // They do NOT share the eligibility gate, because the two questions differ by exactly
        // the rate: money needs a price list, compute does not. `isCostEligible` = a microVM ran
        // AND its flavor has a rate; `hasRunMicrovm` is the launch evidence alone. Gating minutes
        // on the pricing predicate silently drops real compute (a flavor renamed or removed from
        // `microvm/flavors.json` orphans every historical row inside the retention window, and
        // custom flavors would make it routine) and then reports 100% coverage over a total
        // missing whole rows — the one number on this screen that must never overstate.
        const eligible = spec.metric === 'spend' ? isCostEligible : hasRunMicrovm;
        let value = 0;
        for (const r of g.runs) {
          // Coverage is over the rows the metric could actually MEASURE, not every row in the
          // group. A queued / launch-failure row contributes 0, so counting it in the denominator
          // understated coverage on exactly the metric whose caveat then claimed the uncovered
          // share was measured on overstating wall clock — it was not measured at all. An
          // ineligible row is silent in both, so the ratio means what the caveat says it means.
          if (!eligible(r)) continue;
          value +=
            spec.metric === 'spend' ? jobCostUsd(r, now) : billableSeconds(r, now).seconds / 60;
          coverageDen += 1;
          if (billableSeconds(r, now).basis === 'measured') coverageNum += 1;
        }
        points.push({ key, label: g.label, value: round(value, 6), sampleSize: g.runs.length });
        break;
      }
      case 'runCount':
        coverageDen += g.runs.length;
        coverageNum += g.runs.length;
        points.push({ key, label: g.label, value: g.runs.length, sampleSize: g.runs.length });
        break;
      case 'duration': {
        const terminal = g.runs.filter((r) => TERMINAL_STATUSES.has(r.status));
        // A terminal row whose span is unmeasurable (unparseable or inverted timestamps) is
        // EXCLUDED, not folded in as 0s. A fabricated zero is indistinguishable from a genuinely
        // instant job and drags p50/p90 down, which is the failure this metric's contract
        // explicitly rules out.
        const secs = terminal
          .map((r) => measuredSpanSeconds(r.createdAt, r.updatedAt))
          .filter((s): s is number => s !== undefined);
        coverageDen += g.runs.length;
        coverageNum += secs.length;
        if (!secs.length) break;
        const { p50, p90 } = percentiles(secs);
        points.push({ key, label: g.label, value: p50, secondary: p90, sampleSize: secs.length });
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
        // Same exclusion rule as `duration`: a row carrying a `runningAt` we cannot subtract
        // from `createdAt` (clock skew, unparseable value) is dropped from BOTH the sample and
        // the coverage numerator. Counting it as covered while contributing a 0s sample was the
        // one way this metric could still report a zero it had not measured.
        const secs = g.runs
          .map((r) => (r.runningAt ? measuredSpanSeconds(r.createdAt, r.runningAt) : undefined))
          .filter((s): s is number => s !== undefined);
        coverageDen += g.runs.length;
        coverageNum += secs.length;
        if (!secs.length) break;
        const { p50, p90 } = percentiles(secs);
        points.push({
          key,
          label: g.label,
          value: p50,
          secondary: p90,
          sampleSize: secs.length,
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

  const additive =
    spec.metric === 'spend' || spec.metric === 'billableMinutes' || spec.metric === 'runCount';
  const doc = metricDoc(spec.metric);
  return {
    spec,
    metric: doc,
    points,
    ...(additive ? { total: round(points.reduce((s, p) => s + p.value, 0), 6) } : {}),
    rowCount: runs.length,
    complete: opts.complete ?? true,
    coverage: coverageDen === 0 ? 1 : round(coverageNum / coverageDen, 4),
    coverageSampleSize: coverageDen,
    caveat: caveatFor(spec.metric),
    exportRowLimit: MAX_EXPORT_ROWS,
    generatedAt: now.toISOString(),
  };
}

function caveatFor(metric: ReportMetric): string | undefined {
  switch (metric) {
    case 'spend':
      return 'Estimate. Coverage is the share of PRICED jobs whose billable window was measured from the runningAt watermark; the remainder use queue-to-finish wall clock, which OVERSTATES cost. Jobs that never launched a microVM are priced at 0 and counted in neither share.';
    case 'billableMinutes':
      return 'Estimate, and an ABSOLUTE figure — not a share of any capacity ceiling. Coverage is the share of jobs that RAN a microVM whose billable window was measured from the runningAt watermark; the remainder use queue-to-finish wall clock, which OVERSTATES consumption by the queue and provisioning time it wrongly includes. Jobs that never launched a microVM contribute 0 and are counted in neither share.';
    case 'duration':
      return 'Coverage is the share of jobs that reached a terminal status AND whose span was measurable; in-flight jobs are excluded.';
    case 'failureRate':
      return 'Coverage is the share of jobs that reached a terminal status; in-flight jobs are excluded from numerator and denominator.';
    case 'queueLatency':
      return 'Coverage is the share of jobs carrying a measurable runningAt watermark; the rest are excluded, not counted as zero. A watermark is absent on pre-M5 rows and on jobs that finished before the running transition landed, so the excluded rows are biased towards FAST jobs and these percentiles read slightly high.';
    case 'runCount':
      return undefined;
  }
}

/**
 * Seconds between two ISO timestamps, or `undefined` when the span cannot be measured
 * (either endpoint unparseable, or end before start). Percentile metrics use this so an
 * unmeasurable row is excluded rather than contributing a fabricated 0 — `wallClockSeconds`
 * below deliberately clamps to 0 instead, because an EXPORT column has to carry a number.
 */
function measuredSpanSeconds(startIso: string, endIso: string): number | undefined {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined;
  return Math.round((b - a) / 1000);
}

function wallClockSeconds(run: Pick<RunRecord, 'createdAt' | 'updatedAt'>): number {
  return measuredSpanSeconds(run.createdAt, run.updatedAt) ?? 0;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ---- export ----------------------------------------------------------------

/**
 * Rows a single export response will carry.
 *
 * The fan-out budget (`MAX_TOTAL_ROWS` = 20 000) is far too large to serialize into one Lambda
 * reply: a synchronous Lambda response is capped at **6 MB**, and measured against these very
 * serializers 20 000 rows is 3.8 MiB of CSV with short tenant names, 6.5 MiB with realistic
 * long repo/workflow/job names, and 7.2–9.8 MiB as JSON. Exceeding the cap is not a truncated
 * download — it is a Lambda invocation error surfacing as an opaque 502, i.e. the export fails
 * hardest exactly for the operator with the most history.
 *
 * So an export is capped, and the cap is DISCLOSED rather than silent: the row limit is
 * published in the report result (`exportRowLimit`) so the console can warn before the operator
 * clicks, and a truncated export reports `complete: false` through the same channel a
 * budget-truncated report already uses (the JSON body, and `X-Report-Complete` for CSV).
 */
export const MAX_EXPORT_ROWS = 10_000;

/**
 * Byte backstop for an export body. `MAX_EXPORT_ROWS` alone is not a size guarantee — repo,
 * workflow and job names are tenant-controlled and unbounded, so a row has no fixed width. This
 * keeps the serialized body comfortably under the 6 MB Lambda ceiling even when every name is
 * pathological, and it is the limit that actually binds in that case.
 */
export const MAX_EXPORT_BYTES = 4_500_000;

/** Export rows trimmed to fit one response, plus whether anything was dropped. */
export interface ExportBody {
  /** The rows this response will actually carry. */
  rows: ExportRow[];
  /** False when the row cap or the byte backstop dropped rows from this response. */
  complete: boolean;
}

/**
 * Trim export rows to what one response can safely carry.
 *
 * Applies the row cap first, then — only if the survivors still exceed the byte backstop —
 * BISECTS for the largest prefix that fits. `measure` is injected because CSV and JSON have
 * materially different overheads per row, and guessing at one of them is how a "safe" cap ends
 * up unsafe for the other.
 *
 * The bisect matters, it is not tidiness. Repeated halving (the previous implementation) only
 * ever divides and never comes back up, so the first overshoot is permanent: measured against
 * these serializers, 10 000 rows of realistic long tenant names is ~4.9 MiB of JSON, one halving
 * ships 5 000 rows at 2.5 MiB — and 8 460 rows would have fit. That silently drops 41% of the
 * operator's data from a feature whose entire job is to hand them the underlying rows. Both
 * shapes cost O(log n) measurements; only one of them is tight, so `test/reports.test.mjs`
 * pins the result to within a row of optimal (a halving implementation fails it).
 *
 * A single row wider than the backstop yields ZERO rows, not that row: shipping an over-cap body
 * is a Lambda invocation error (an opaque 502 for the whole download), which is the exact failure
 * this bound exists to prevent. `complete: false` reports it either way.
 */
export function boundExportRows(
  rows: ExportRow[],
  measure: (rows: ExportRow[]) => number,
): ExportBody {
  const capped = rows.length > MAX_EXPORT_ROWS ? rows.slice(0, MAX_EXPORT_ROWS) : rows;
  if (measure(capped) <= MAX_EXPORT_BYTES) {
    return { rows: capped, complete: capped.length === rows.length };
  }
  // Largest k in [0, capped.length) whose prefix fits. Body size is monotonic in the row count
  // (every row adds bytes), so a prefix bisect is exact rather than a heuristic.
  let lo = 0;
  let hi = capped.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(capped.slice(0, mid)) <= MAX_EXPORT_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return { rows: capped.slice(0, lo), complete: false };
}

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

/**
 * Project run rows onto export rows.
 *
 * `billableSeconds` / `costBasis` are gated on `hasRunMicrovm`, the SAME predicate the
 * `billableMinutes` aggregate folds over — an export must reconcile with the report it was
 * downloaded from. Ungated, a launch-failure or queued row exported its whole queue-to-finish
 * wall clock as billable while contributing 0 to the on-screen total, so summing the column
 * overstated consumption (a 4-minute report exported as 9 minutes on two rows). That is the
 * same contradiction the priced column already avoids by going through `jobCostUsd`, and it is
 * worse in this column because there is no currency symbol to make the magnitude look wrong.
 *
 * A row that never ran a VM therefore exports `0` and an EMPTY basis, not `wallClock`: a basis
 * names which clock produced a billable window, and this row has no billable window to have
 * measured. Nothing is lost — `createdAt`/`updatedAt`/`wallClockSeconds` still carry the row's
 * real span, and `status` says why it has no compute.
 */
export function toExportRows(runs: RunRecord[], now: Date = new Date()): ExportRow[] {
  return runs.map((r) => {
    const ran = hasRunMicrovm(r);
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
      billableSeconds: ran ? billable.seconds : 0,
      costBasis: ran ? billable.basis : '',
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
