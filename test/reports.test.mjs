// Reporting read model: the closed report vocabulary, spec validation, the metric folds,
// percentile maths, and the CSV export (src/mgmt/reports.ts).
//
// The security-relevant assertions live here rather than in an integration test because the
// validator IS the boundary: a report spec is the only thing that crosses from untrusted
// input (query params OR a model response) into a DynamoDB read, and it must be a closed
// vocabulary in both directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  METRICS,
  DIMENSIONS,
  CHART_TYPES,
  METRIC_CATALOG,
  MAX_RANGE_DAYS,
  applyFilters,
  billableSeconds,
  computeReport,
  jobCostUsd,
  metricDoc,
  percentiles,
  presetWindow,
  specFromQuery,
  specToQuery,
  timeBucket,
  toCsv,
  toExportRows,
  validateReportSpec,
} from '../dist/src/mgmt/reports.js';

const NOW = new Date('2026-07-15T12:00:00.000Z');

function job(over = {}) {
  return {
    repoId: 1,
    repoFullName: 'acme/service',
    installationId: 11,
    runId: 100,
    jobId: 200,
    status: 'completed',
    flavor: 'base',
    labels: ['self-hosted'],
    workflowName: 'CI',
    jobName: 'build',
    createdAt: '2026-07-15T11:00:00.000Z',
    runningAt: '2026-07-15T11:01:00.000Z',
    updatedAt: '2026-07-15T11:06:00.000Z',
    ...over,
  };
}

const SPEC = (over = {}) => {
  const r = validateReportSpec({ metric: 'spend', dimension: 'repo', preset: '30d', ...over }, NOW);
  assert.ok(r.ok, `spec should validate: ${JSON.stringify(r.errors ?? [])}`);
  return r.value;
};

// ---- catalog ---------------------------------------------------------------

test('every metric has a catalog entry with a stated unit and definition', () => {
  for (const m of METRICS) {
    const doc = METRIC_CATALOG.find((d) => d.metric === m);
    assert.ok(doc, `no catalog entry for ${m}`);
    assert.ok(doc.unit.length > 0, `${m} has no unit`);
    assert.ok(doc.definition.length > 20, `${m} definition is too vague to be a counting unit`);
  }
  assert.equal(METRIC_CATALOG.length, METRICS.length, 'catalog and metric list disagree');
});

test('spend is flagged an estimate and every other metric is not', () => {
  const estimates = METRIC_CATALOG.filter((m) => m.estimate).map((m) => m.metric);
  assert.deepEqual(estimates, ['spend']);
});

// ---- spec validation (the security boundary) -------------------------------

test('a minimal spec resolves defaults rather than failing', () => {
  const r = validateReportSpec({ metric: 'runCount' }, NOW);
  assert.ok(r.ok);
  assert.equal(r.value.dimension, 'none');
  assert.equal(r.value.preset, '7d');
  assert.equal(r.value.chart, 'stackedBar'); // DEFAULT_CHART.runCount
});

test('unknown metric / dimension / chart are rejected, not coerced', () => {
  for (const bad of [
    { metric: 'profit' },
    { metric: 'spend', dimension: 'customer' },
    { metric: 'spend', chart: 'sankey' },
  ]) {
    const r = validateReportSpec(bad, NOW);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test('unknown top-level and filter fields are rejected', () => {
  const extra = validateReportSpec({ metric: 'spend', limit: 5 }, NOW);
  assert.equal(extra.ok, false);
  assert.match(extra.errors.join(' '), /unknown field "limit"/);

  const filter = validateReportSpec({ metric: 'spend', filters: { installationId: 11 } }, NOW);
  assert.equal(filter.ok, false);
  assert.match(filter.errors.join(' '), /unknown filter "installationId"/);
});

test('a spec cannot carry an installation, a query, or any authorization field', () => {
  // The scope of a report is derived from the session server-side. Anything that smells like
  // authorization or a raw query must be refused outright, whoever sent it.
  for (const field of [
    'installationId',
    'installations',
    'query',
    'KeyConditionExpression',
    'tableName',
    'sql',
  ]) {
    const r = validateReportSpec({ metric: 'spend', [field]: 'anything' }, NOW);
    assert.equal(r.ok, false, `spec accepted forbidden field ${field}`);
  }
});

test('a window wider than run retention is rejected', () => {
  const r = validateReportSpec(
    { metric: 'spend', from: '2020-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    NOW,
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), new RegExp(`${MAX_RANGE_DAYS}-day`));
});

test('an inverted window is rejected', () => {
  const r = validateReportSpec(
    { metric: 'spend', from: '2026-07-10T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
    NOW,
  );
  assert.equal(r.ok, false);
});

test('an explicit window wins over a preset and drops it', () => {
  const r = validateReportSpec(
    { metric: 'spend', preset: '24h', from: '2026-07-01T00:00:00.000Z', to: '2026-07-02T00:00:00.000Z' },
    NOW,
  );
  assert.ok(r.ok);
  assert.equal(r.value.preset, undefined);
  assert.equal(r.value.from, '2026-07-01T00:00:00.000Z');
});

test('unknown flavors and statuses in filters are rejected', () => {
  assert.equal(validateReportSpec({ metric: 'spend', filters: { flavors: ['gpu'] } }, NOW).ok, false);
  assert.equal(
    validateReportSpec({ metric: 'spend', filters: { statuses: ['exploded'] } }, NOW).ok,
    false,
  );
  assert.ok(validateReportSpec({ metric: 'spend', filters: { flavors: ['base', 'docker'] } }, NOW).ok);
});

test('repoIds must be positive integers and are capped', () => {
  assert.equal(validateReportSpec({ metric: 'spend', filters: { repoIds: ['1'] } }, NOW).ok, false);
  assert.equal(validateReportSpec({ metric: 'spend', filters: { repoIds: [-3] } }, NOW).ok, false);
  const many = Array.from({ length: 51 }, (_, i) => i + 1);
  assert.equal(validateReportSpec({ metric: 'spend', filters: { repoIds: many } }, NOW).ok, false);
});

test('non-object specs are rejected', () => {
  for (const bad of [null, 'spend by repo', 42, ['spend'], undefined]) {
    assert.equal(validateReportSpec(bad, NOW).ok, false);
  }
});

test('specFromQuery routes picker params through the same validator', () => {
  const ok = specFromQuery({ metric: 'failureRate', dimension: 'repo', preset: '24h' }, NOW);
  assert.ok(ok.ok);
  assert.equal(ok.value.metric, 'failureRate');
  const bad = specFromQuery({ metric: 'nonsense' }, NOW);
  assert.equal(bad.ok, false);
});

test('specToQuery round-trips through specFromQuery', () => {
  const spec = SPEC({ dimension: 'flavor', chart: 'line', filters: { flavors: ['base'] } });
  const round = specFromQuery(Object.fromEntries(new URLSearchParams(specToQuery(spec))), NOW);
  assert.ok(round.ok);
  assert.deepEqual(round.value, spec);
});

test('presetWindow spans the advertised duration', () => {
  const w = presetWindow('24h', NOW);
  assert.equal(Date.parse(w.to) - Date.parse(w.from), 24 * 3600_000);
});

// ---- cost model ------------------------------------------------------------

test('billable time uses the runningAt watermark when present', () => {
  const b = billableSeconds(job());
  assert.equal(b.basis, 'measured');
  assert.equal(b.seconds, 300); // 11:01 → 11:06
});

test('a job with no watermark falls back to wall clock and says so', () => {
  const b = billableSeconds(job({ runningAt: undefined }));
  assert.equal(b.basis, 'wallClock');
  assert.equal(b.seconds, 360); // 11:00 → 11:06, overstates by the queue time
});

test('an unknown flavor costs nothing rather than throwing', () => {
  assert.equal(jobCostUsd(job({ flavor: undefined })), 0);
});

// ADR-042's "one definition of billable time" has to include one definition of what is
// BILLABLE AT ALL, or the two screens disagree about the same job. Provision stamps the intended
// `flavor` on a mint/launch FAILURE for support, so flavor alone is not evidence a VM ran — and
// Reports reads the same rows Run detail does.
test('Reports does not price a row that never launched a microVM', () => {
  for (const status of ['failed', 'timed_out', 'queued', 'provisioning']) {
    assert.equal(
      jobCostUsd(job({ status, flavor: 'base', microvmId: undefined })),
      0,
      `${status} without a microvmId must not be priced`,
    );
  }
  // Evidence of compute — either signal — is priced. `microvmId` is stamped best-effort
  // (ADR-019), so a post-launch status has to count on its own.
  assert.ok(jobCostUsd(job({ status: 'failed', microvmId: 'mv-1' })) > 0);
  assert.ok(jobCostUsd(job({ status: 'running', microvmId: undefined })) > 0);
});

test('a spend report and its export agree with Run detail on the same row', () => {
  const launchFailure = job({ jobId: 9, status: 'failed', flavor: 'base', microvmId: undefined });
  const spec = SPEC({ metric: 'spend', dimension: 'none' });
  const res = computeReport([launchFailure], spec, { now: NOW });
  assert.equal(res.total, 0, 'the aggregate must not bill a VM that never existed');
  const [row] = toExportRows([launchFailure], NOW);
  assert.equal(row.estimatedCostUsd, 0, 'the export must not contradict the aggregate');
});

test('measured cost is strictly lower than the wall-clock fallback', () => {
  const measured = jobCostUsd(job());
  const fallback = jobCostUsd(job({ runningAt: undefined }));
  assert.ok(measured < fallback, 'the watermark must reduce the estimate, not inflate it');
});

// ---- percentiles -----------------------------------------------------------

test('percentiles use nearest-rank and never interpolate a value', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  const { p50, p90 } = percentiles(values);
  assert.ok(values.includes(p50));
  assert.ok(values.includes(p90));
  assert.equal(p90, 9);
});

test('percentiles of an empty set are zero, not NaN', () => {
  assert.deepEqual(percentiles([]), { p50: 0, p90: 0 });
});

// ---- folds -----------------------------------------------------------------

test('spend sums per group and reports a total', () => {
  const spec = SPEC({ dimension: 'repo' });
  const rows = [job(), job({ repoId: 2, repoFullName: 'acme/other', jobId: 201 })];
  const res = computeReport(rows, spec, { now: NOW });
  assert.equal(res.points.length, 2);
  assert.ok(res.total > 0);
  assert.equal(res.total, Math.round((res.points[0].value + res.points[1].value) * 1e6) / 1e6);
});

test('job count is per JOB row, not per workflow run', () => {
  const spec = SPEC({ metric: 'runCount', dimension: 'none' });
  // One workflow run (runId 100) with three jobs.
  const rows = [job({ jobId: 1 }), job({ jobId: 2 }), job({ jobId: 3 })];
  const res = computeReport(rows, spec, { now: NOW });
  assert.equal(res.total, 3);
  assert.match(res.metric.definition, /one row per job/);
});

test('failure rate excludes in-flight jobs from BOTH numerator and denominator', () => {
  const spec = SPEC({ metric: 'failureRate', dimension: 'none' });
  const rows = [
    job({ jobId: 1, status: 'completed' }),
    job({ jobId: 2, status: 'failed' }),
    job({ jobId: 3, status: 'running' }), // in flight — must not depress the rate
  ];
  const res = computeReport(rows, spec, { now: NOW });
  assert.equal(res.points[0].value, 0.5, 'a running job was counted as a success');
  assert.equal(res.points[0].sampleSize, 2);
  assert.equal(res.coverage, 0.6667);
});

test('duration reports p50 and p90 over terminal jobs only', () => {
  const spec = SPEC({ metric: 'duration', dimension: 'none' });
  const rows = [
    job({ jobId: 1, updatedAt: '2026-07-15T11:01:00.000Z' }), // 60s
    job({ jobId: 2, updatedAt: '2026-07-15T11:10:00.000Z' }), // 600s
    job({ jobId: 3, status: 'running', updatedAt: '2026-07-15T11:59:00.000Z' }),
  ];
  const res = computeReport(rows, spec, { now: NOW });
  assert.equal(res.points[0].sampleSize, 2);
  assert.equal(res.points[0].value, 60);
  assert.equal(res.points[0].secondary, 600);
  assert.equal(res.total, undefined, 'a percentile is not additive and must not report a total');
});

test('queue latency excludes rows with no watermark instead of counting them as zero', () => {
  const spec = SPEC({ metric: 'queueLatency', dimension: 'none' });
  const rows = [
    job({ jobId: 1 }), // 60s queue
    job({ jobId: 2, runningAt: undefined }), // pre-M5 row
  ];
  const res = computeReport(rows, spec, { now: NOW });
  assert.equal(res.points[0].value, 60, 'a missing watermark was folded in as 0s');
  assert.equal(res.points[0].sampleSize, 1);
  assert.equal(res.coverage, 0.5);
  assert.match(res.caveat, /watermark/);
});

test('a fast job that finished before the running transition is priced, and its caveat does not blame age', () => {
  // `stampMicrovmId` runs BEFORE the `running` transition (src/provision/handler.ts), and
  // `provisioning -> completed` is a legal forward move while `completed -> running` is
  // rejected. So an ultra-fast job whose terminal webhook wins that race is permanently
  // `completed` + `microvmId` + NO `runningAt` — a brand-new row, not a pre-M5 one.
  //
  // Two things must hold: it is still PRICED (it really did run a microVM), and nothing
  // describes its missing watermark as merely old data — the excluded rows here are the
  // FAST ones, so calling them stale would invert the bias an operator should read.
  const fast = job({
    jobId: 7,
    status: 'completed',
    microvmId: 'mv-fast',
    runningAt: undefined,
    createdAt: '2026-07-15T11:00:00.000Z',
    updatedAt: '2026-07-15T11:00:20.000Z',
  });

  const spend = computeReport([fast], SPEC({ metric: 'spend', dimension: 'none' }), { now: NOW });
  assert.ok(spend.total > 0, 'a job that ran a microVM must still be priced');
  assert.equal(spend.coverage, 0, 'it was priced on wall clock, so it is uncovered — not absent');

  const latency = computeReport([fast], SPEC({ metric: 'queueLatency', dimension: 'none' }), {
    now: NOW,
  });
  assert.equal(latency.points.length, 0, 'no watermark must not become a 0s queue time');
  assert.equal(latency.coverage, 0);
  // The caveat and the catalog definition must name this cause, not just "pre-M5".
  assert.doesNotMatch(
    latency.caveat,
    /predating it are excluded, not counted as zero\.$/,
    'caveat still attributes a missing watermark solely to age',
  );
  assert.match(latency.caveat, /before the running transition landed/);
  assert.match(metricDoc('queueLatency').definition, /terminal webhook beat the `running`/);
});

test('spend coverage reports the share priced from a measured window', () => {
  const spec = SPEC({ metric: 'spend', dimension: 'none' });
  const res = computeReport([job(), job({ jobId: 2, runningAt: undefined })], spec, { now: NOW });
  assert.equal(res.coverage, 0.5);
  assert.match(res.caveat, /OVERSTATES/);
});

test('spend coverage ignores rows that were never priced at all', () => {
  // Coverage on `spend` answers one question: of the jobs we PRICED, how many were priced from
  // a measured window rather than overstating wall clock? A queued / launch-failure row is
  // priced at 0 (`isCostEligible`), so folding it into the denominator dragged coverage down
  // and the caveat then described that share as wall-clock-overstated — it was not priced at
  // all. Both shares must ignore it.
  const spec = SPEC({ metric: 'spend', dimension: 'none' });
  const priced = job();
  const neverLaunched = job({ jobId: 2, status: 'queued', microvmId: undefined });
  const res = computeReport([priced, neverLaunched], spec, { now: NOW });
  assert.equal(res.total, computeReport([priced], spec, { now: NOW }).total, 'an unpriced row must not add spend');
  assert.equal(res.coverage, 1, 'an unpriced row must not understate coverage');
  assert.equal(res.points[0].sampleSize, 2, 'sampleSize still reports every row in the group');

  // …and a row that carries a watermark but never launched cannot inflate coverage either.
  const watermarkedFailure = job({ jobId: 3, status: 'failed', microvmId: undefined });
  const mixed = computeReport(
    [job({ runningAt: undefined }), watermarkedFailure],
    spec,
    { now: NOW },
  );
  assert.equal(mixed.coverage, 0, 'an unpriced row was counted as a measured price');
});

test('grouping by workflow labels rows with no workflow name rather than dropping them', () => {
  const spec = SPEC({ dimension: 'workflow' });
  const res = computeReport([job({ workflowName: undefined })], spec, { now: NOW });
  assert.equal(res.points[0].label, '(unknown)');
});

test('a time-dimension report sorts chronologically, others by magnitude', () => {
  const timeSpec = SPEC({ metric: 'runCount', dimension: 'time', preset: '30d' });
  const rows = [
    job({ jobId: 1, createdAt: '2026-07-14T01:00:00.000Z' }),
    job({ jobId: 2, createdAt: '2026-07-13T01:00:00.000Z' }),
    job({ jobId: 3, createdAt: '2026-07-13T02:00:00.000Z' }),
  ];
  const timed = computeReport(rows, timeSpec, { now: NOW });
  assert.deepEqual(timed.points.map((p) => p.key), ['2026-07-13', '2026-07-14']);

  const repoSpec = SPEC({ metric: 'runCount', dimension: 'repo' });
  const byRepo = computeReport(
    [job({ jobId: 1 }), job({ jobId: 2 }), job({ repoId: 9, repoFullName: 'a/small', jobId: 3 })],
    repoSpec,
    { now: NOW },
  );
  assert.equal(byRepo.points[0].value, 2, 'biggest group should sort first');
});

test('time bucket is hourly for short windows and daily for long ones', () => {
  assert.equal(timeBucket('2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z'), 'hour');
  assert.equal(timeBucket('2026-06-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z'), 'day');
});

test('incomplete fan-out propagates to the result', () => {
  const res = computeReport([job()], SPEC(), { complete: false, now: NOW });
  assert.equal(res.complete, false);
});

// ---- filters ---------------------------------------------------------------

test('applyFilters enforces the window half-open and honours flavor/status', () => {
  const spec = SPEC({
    from: '2026-07-15T11:00:00.000Z',
    to: '2026-07-15T12:00:00.000Z',
    filters: { flavors: ['base'] },
  });
  const rows = [
    job({ jobId: 1, createdAt: '2026-07-15T11:00:00.000Z' }), // inclusive start → kept
    job({ jobId: 2, createdAt: '2026-07-15T12:00:00.000Z' }), // exclusive end → dropped
    job({ jobId: 3, createdAt: '2026-07-15T10:59:59.000Z' }), // before → dropped
    job({ jobId: 4, createdAt: '2026-07-15T11:30:00.000Z', flavor: 'docker' }), // wrong flavor
  ];
  assert.deepEqual(applyFilters(rows, spec).map((r) => r.jobId), [1]);
});

// ---- export ----------------------------------------------------------------

test('export rows carry the cost basis so a reader can see which estimate they got', () => {
  const [measured, fallback] = toExportRows([job(), job({ jobId: 2, runningAt: undefined })]);
  assert.equal(measured.costBasis, 'measured');
  assert.equal(fallback.costBasis, 'wallClock');
});

test('CSV quotes every field and doubles inner quotes', () => {
  const csv = toCsv(toExportRows([job({ repoFullName: 'acme/say "hi"' })]));
  assert.match(csv, /"acme\/say ""hi"""/);
});

test('CSV neutralizes a formula-injection payload in a tenant-controlled name', () => {
  // Repo/workflow/job names come from GitHub and are attacker-controlled for a tenant. A
  // name starting with `=` is executed by Excel/Sheets on open unless it is defanged.
  const csv = toCsv(toExportRows([job({ workflowName: '=cmd|\' /c calc\'!A1' })]));
  const line = csv.split('\r\n')[1];
  assert.ok(line.includes('"\'=cmd'), `formula was not prefixed: ${line}`);
  assert.ok(!line.includes('"=cmd'), 'a raw =formula field reached the CSV');
});

test('CSV defangs every formula sigil, not just equals', () => {
  for (const sigil of ['=', '+', '-', '@']) {
    const csv = toCsv(toExportRows([job({ jobName: `${sigil}HYPERLINK("http://x")` })]));
    assert.ok(csv.includes(`"'${sigil}HYPERLINK`), `${sigil} was not defanged`);
  }
});

test('every chart type in the vocabulary is one the frontend actually renders', () => {
  // The vocabulary is the model's menu AND the picker's option list. A type here that the
  // renderer does not handle silently falls through to a different chart — a wrong answer that
  // looks right, which is the whole failure mode the closed vocabulary prevents. The renderer
  // declares an exhaustive `Record<ChartType, …>` so TypeScript catches it too; this pins the
  // backend vocabulary as the source of truth for that record's keys.
  const renderer = fs.readFileSync(
    new URL('../web/src/screens/ReportChart.tsx', import.meta.url),
    'utf8',
  );
  const map = renderer.slice(
    renderer.indexOf('CHART_RENDERING'),
    renderer.indexOf('};', renderer.indexOf('CHART_RENDERING')),
  );
  for (const chart of CHART_TYPES) {
    assert.ok(
      new RegExp(`\\b${chart}:`).test(map),
      `chart type "${chart}" is offered but CHART_RENDERING never maps it`,
    );
  }
});

test('every chart type and dimension in the vocabulary is a plain string enum', () => {
  // Guards against a future "chart" that carries options — the model picks from this list, so
  // anything structured here becomes model-controlled render input (ADR-045).
  for (const v of [...CHART_TYPES, ...DIMENSIONS, ...METRICS]) {
    assert.equal(typeof v, 'string');
  }
});

test('the chart host is unconditional and the empty series is gated by the caller', () => {
  // Regression guard. The ECharts instance is bound to ReportChart's host div and the mount
  // effect is keyed `[]`, so the host must exist for the instance's whole lifetime. An
  // empty-series early return inside ReportChart used to remove that host: going empty left a
  // detached instance, and empty -> non-empty never initialised (the mount effect does not
  // re-run), so setOption wrote into nothing and the panel rendered silently blank. `useApi`
  // keeps the previous `data` across a refetch, so the component stays mounted while the
  // operator changes metric/dimension — the transition is reachable.
  //
  // Source-level assertion because this repo has no DOM harness for the SPA; it pins the two
  // halves of the contract rather than the rendered output.
  const chart = fs.readFileSync(
    new URL('../web/src/screens/ReportChart.tsx', import.meta.url),
    'utf8',
  );
  // Bounded to ReportChart itself: ReportTable follows it and legitimately has its own
  // empty-row branch, which is fine — it owns no ECharts instance.
  const start = chart.indexOf('export function ReportChart');
  const body = chart.slice(start, chart.indexOf('export function ReportTable', start));
  assert.ok(start >= 0 && body.length > 0, 'could not isolate the ReportChart body');
  assert.ok(
    !/report\.points\.length/.test(body),
    'ReportChart returns early on an empty series again — that strands its ECharts instance',
  );

  const screen = fs.readFileSync(
    new URL('../web/src/screens/Reports.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    /!report\.points\.length/.test(screen),
    'Reports.tsx must gate the ReportChart mount on a non-empty series',
  );
});

test('the assistant provenance line is dropped once the picker moves off its spec', () => {
  // The "Resolved to …" line is a provenance claim about the report on screen. `ask` adopts the
  // model's spec as picker state, so it is true immediately after an ask — but the banner lives
  // in the Assistant while the picker mutates the parent's query, so a later metric/window/repo
  // change left the claim describing a report that is no longer rendered. Source-level assertion
  // (no DOM harness for the SPA): pins that the render is guarded by a staleness comparison
  // against the live query rather than by `resolved` alone.
  const screen = fs.readFileSync(
    new URL('../web/src/screens/Reports.tsx', import.meta.url),
    'utf8',
  );
  const start = screen.indexOf('function Assistant');
  const body = screen.slice(start, screen.indexOf('function specToQuery', start));
  assert.ok(start >= 0 && body.length > 0, 'could not isolate the Assistant body');
  assert.ok(
    /query:\s*ReportQuery/.test(body),
    'Assistant cannot detect staleness without seeing the live query',
  );
  assert.ok(
    /stale/.test(body) && /reportQueryString\(query\)/.test(body),
    'Assistant must compare its resolved spec against the live query',
  );
  assert.ok(
    /resolved && !refusal && !stale/.test(body),
    'the provenance line must be gated on staleness, not just on having a resolved report',
  );
});

test('a truncated CSV export declares its truncation, since the body cannot', () => {
  // The JSON export carries `complete` in its payload; CSV has nowhere to put it, so a
  // budget-truncated download would look like a full one and its row count would be read as a
  // total. The header is the only channel, and the UI has to say so next to the link — a header
  // no operator sees is not a disclosure. Source-level, matching the SPA assertions above:
  // this repo drives pure helpers in tests and has no handler/DOM harness.
  const handler = fs.readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8');
  const start = handler.indexOf('async function exportReportRoute');
  const body = handler.slice(start, handler.indexOf('async function askReportRoute', start));
  assert.ok(start >= 0 && body.length > 0, 'could not isolate exportReportRoute');
  assert.ok(
    /'X-Report-Complete': String\(fetched\.complete\)/.test(body),
    'the CSV export must publish its completeness in a header',
  );
  assert.ok(
    /complete: fetched\.complete/.test(body),
    'the JSON export must keep carrying `complete` in its body',
  );

  const screen = fs.readFileSync(
    new URL('../web/src/screens/Reports.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    screen,
    /export is\s*\n?\s*truncated/,
    'the partial-report notice must tell the operator the export is truncated too',
  );
});
