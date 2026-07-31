import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

/**
 * Custom-metric emission (spec 05 § Observability, M5/ADR-032).
 *
 * Spec 05 § Observability names the metrics this module emits today: `RunsProvisioned`,
 * `ProvisionLatency`, `ProvisionFailures` and `QuotaThrottles`. (`BootLatency` and
 * `JobDuration` are NOT emitted — boot and job wall-clock are derivable from the run row's
 * timestamps, which the console already renders; adding them as metrics would double-count.)
 * They are emitted as **CloudWatch
 * Embedded Metric Format (EMF)** log lines rather than `PutMetricData` calls:
 *
 *   - no extra API call on the hot path (a `PutMetricData` round trip adds latency to every
 *     provision, and its throttles would then need their own handling),
 *   - no `cloudwatch:PutMetricData` grant on the Lambdas (least privilege, spec 05),
 *   - the datapoint and the log line that explains it share a timestamp + request id, which
 *     is what you actually want at 3am.
 *
 * A metric therefore costs one `console.log`. `putMetrics` (PutMetricData) is exported for
 * callers that are NOT inside a CloudWatch-Logs-backed Lambda; nothing uses it on the hot
 * path today.
 *
 * Pure formatting lives in `emfPayload` so the wire shape is unit-testable.
 */

export const METRIC_NAMESPACE = 'LambdaCIActions';

export type MetricUnit = 'Count' | 'Milliseconds' | 'Seconds' | 'None';

export interface MetricDatum {
  name: string;
  value: number;
  unit?: MetricUnit;
}

/** Dimensions we allow. Kept SMALL and bounded — every combination is a billed metric. */
export interface MetricDimensions {
  /** Deployment environment (`dev` / `prod`). Always present. */
  env: string;
  /** Flavor name, when the datapoint is per-flavor. */
  flavor?: string;
  /** `label` | `adopt` — how the job was claimed (M5). */
  via?: string;
  /** Failure classification for `ProvisionFailures` (`quota`, `mint`, `launch`, `other`). */
  kind?: string;
}

/**
 * Build a CloudWatch EMF log record.
 *
 * Two dimension SETS are published for every datum: the full set (`env` + whichever of
 * `flavor`/`via`/`kind` apply) and an `env`-only rollup.
 *
 * The rollup is not redundant — it is what alarms bind to. CloudWatch does NOT aggregate a
 * metric across dimensions automatically: `LambdaCIActions/QuotaThrottles{env=prod}` and
 * `…{env=prod,flavor=docker,via=label}` are different metrics, so an alarm on the former
 * would sit at INSUFFICIENT_DATA forever if only the latter were published. Publishing both
 * gives per-flavor drill-down in the console AND an alarmable per-env total.
 *
 * IMPORTANT: repo names, run ids and job ids are attached as **properties, not dimensions**.
 * They are unbounded-cardinality values — as dimensions they would create one custom metric
 * per repo/run (billed, and useless for alarming) while as properties they remain queryable
 * in Logs Insights.
 */
export function emfPayload(
  metrics: MetricDatum[],
  dimensions: MetricDimensions,
  properties: Record<string, string | number> = {},
  now: number = Date.now(),
): Record<string, unknown> {
  const dims = Object.entries(dimensions).filter(([, v]) => v !== undefined && v !== '') as [
    string,
    string,
  ][];
  const values: Record<string, number> = {};
  for (const m of metrics) values[m.name] = m.value;

  const fullSet = dims.map(([k]) => k);
  const dimensionSets = fullSet.length > 1 ? [fullSet, ['env']] : [fullSet];

  return {
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: dimensionSets,
          Metrics: metrics.map((m) => ({ Name: m.name, Unit: m.unit ?? 'None' })),
        },
      ],
    },
    ...Object.fromEntries(dims),
    ...properties,
    ...values,
  };
}

/**
 * Emit metrics via EMF on stdout. Never throws: telemetry must not be able to fail a
 * provision (a swallowed metric is an inconvenience, a failed launch is an outage).
 */
export function emitMetrics(
  metrics: MetricDatum[],
  dimensions: MetricDimensions,
  properties: Record<string, string | number> = {},
): void {
  try {
    if (!metrics.length) return;
    console.log(JSON.stringify(emfPayload(metrics, dimensions, properties)));
  } catch {
    /* telemetry is best-effort by design */
  }
}

/**
 * Direct `PutMetricData` (needs `cloudwatch:PutMetricData`). For callers outside a
 * CloudWatch-Logs-backed runtime. Best-effort, same rationale as `emitMetrics`.
 */
export async function putMetrics(
  metrics: MetricDatum[],
  dimensions: MetricDimensions,
): Promise<void> {
  try {
    if (!metrics.length) return;
    const cw = new CloudWatchClient({});
    await cw.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: metrics.map((m) => ({
          MetricName: m.name,
          Value: m.value,
          Unit: m.unit ?? 'None',
          Dimensions: Object.entries(dimensions)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([Name, Value]) => ({ Name, Value: String(Value) })),
        })),
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: 'putMetrics failed (ignored)',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Whether an AWS error is a quota/throttle refusal — the signal behind `QuotaThrottles`,
 * which spec 05 calls the platform's primary concurrency ceiling. microVM launch quota
 * exhaustion surfaces as a throttling/limit-exceeded error from `RunMicrovm`.
 */
export function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? '';
  const msg = e?.message ?? '';
  if (/Throttl|TooManyRequests|LimitExceeded|QuotaExceeded|ServiceQuota/i.test(name)) return true;
  if (/throttl|quota|too many requests|limit exceeded/i.test(msg)) return true;
  return e?.$metadata?.httpStatusCode === 429;
}
