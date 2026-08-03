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
  DEFAULT_CHART,
  METRIC_CATALOG,
  DEFAULT_MAX_RANGE_DAYS,
  MAX_EXPORT_BYTES,
  MAX_EXPORT_ROWS,
  applyFilters,
  availablePresets,
  billableSeconds,
  boundExportRows,
  computeReport,
  jobCostUsd,
  maxRangeDays,
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
import { flavorRatePerMinute, toRunView } from '../dist/src/mgmt/views.js';

const NOW = new Date('2026-07-15T12:00:00.000Z');

/**
 * Slice a source file between two anchors, FAILING if either is missing.
 *
 * `String.prototype.indexOf` returns -1 for a missing anchor, and `s.slice(start, -1)` is a
 * perfectly valid call that returns almost the whole file. So the obvious guard
 * (`start >= 0 && body.length > 0`) passes on a slice that is silently unbounded, and every
 * `!/pattern/.test(body)` assertion below it then searches the entire file instead of the
 * function it meant to pin — a rename of the terminating function turns a regression guard into
 * a no-op without failing. Assert both anchors and a plausible size instead.
 */
function sliceBetween(source, startAnchor, endAnchor, maxChars) {
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, `start anchor not found: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `end anchor not found after the start anchor: ${endAnchor}`);
  const body = source.slice(start, end);
  assert.ok(body.length > 0, `empty slice between ${startAnchor} and ${endAnchor}`);
  if (maxChars !== undefined) {
    assert.ok(
      body.length <= maxChars,
      `slice from ${startAnchor} is ${body.length} chars (> ${maxChars}) — it likely ran past its terminator, which would make the assertions below unbounded`,
    );
  }
  return body;
}

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

test('spend and billableMinutes are flagged estimates and every other metric is not', () => {
  const estimates = METRIC_CATALOG.filter((m) => m.estimate).map((m) => m.metric);
  assert.deepEqual(estimates, ['spend', 'billableMinutes']);
});

test('every metric has a default chart the renderer can draw', () => {
  for (const m of METRICS) {
    assert.ok(CHART_TYPES.includes(DEFAULT_CHART[m]), `${m} defaults to a chart outside the vocabulary`);
  }
});

// ---- utilisation (billableMinutes) ----------------------------------------

test('billableMinutes is spend with the flavor rate taken out', () => {
  // The card's utilisation question is "how much microVM compute did we consume", and the only
  // honest answer shares ADR-042's billable window with the cost estimate. Pinning the two
  // together is what stops a future edit from measuring consumption over one window and
  // charging for another.
  const rows = [job(), job({ jobId: 2, runningAt: '2026-07-15T11:02:00.000Z' })];
  const minutes = computeReport(rows, SPEC({ metric: 'billableMinutes', dimension: 'none' }), { now: NOW });
  const usd = computeReport(rows, SPEC({ metric: 'spend', dimension: 'none' }), { now: NOW });

  const expected = rows.reduce((s, r) => s + billableSeconds(r, NOW).seconds / 60, 0);
  assert.equal(minutes.total, expected, 'billable minutes must fold billableSeconds/60');
  assert.equal(minutes.metric.unit, 'minutes');

  // Same flavor for both rows, so spend is exactly minutes x that flavor's rate.
  const rate = jobCostUsd(rows[0], NOW) / (billableSeconds(rows[0], NOW).seconds / 60);
  assert.ok(Math.abs(usd.total - minutes.total * rate) < 1e-6, 'spend and minutes disagree about the window');
});

test('billableMinutes charts on every dimension', () => {
  // A metric that only works on `none` is a metric the picker offers and cannot draw. Every
  // dimension must produce a point per group, with the group totals summing to the whole.
  const rows = [
    job({ jobId: 1 }),
    job({ jobId: 2, repoId: 9, repoFullName: 'acme/other', flavor: 'large', workflowName: 'Release', status: 'failed' }),
    job({ jobId: 3, createdAt: '2026-07-14T11:00:00.000Z', runningAt: '2026-07-14T11:01:00.000Z', updatedAt: '2026-07-14T11:09:00.000Z' }),
  ];
  const whole = computeReport(rows, SPEC({ metric: 'billableMinutes', dimension: 'none' }), { now: NOW });
  assert.ok(whole.total > 0);

  for (const dimension of DIMENSIONS) {
    const res = computeReport(rows, SPEC({ metric: 'billableMinutes', dimension, preset: '30d' }), { now: NOW });
    assert.ok(res.points.length >= 1, `no points for dimension ${dimension}`);
    const summed = res.points.reduce((s, p) => s + p.value, 0);
    assert.ok(
      Math.abs(summed - whole.total) < 1e-6,
      `dimension ${dimension} groups sum to ${summed}, whole-window total is ${whole.total}`,
    );
    assert.equal(res.total, res.points.reduce((s, p) => s + p.value, 0), `${dimension} total must be additive`);
  }
});

test('a wallClock-basis row lowers billableMinutes coverage and the caveat says which way it errs', () => {
  const spec = SPEC({ metric: 'billableMinutes', dimension: 'none' });
  const measured = job();
  // No watermark -> the window starts at `createdAt`, so queue + provisioning time is counted
  // as compute. That OVERSTATES consumption, and the caveat must say so rather than presenting
  // the figure as measured.
  const wallClock = job({ jobId: 2, runningAt: undefined });
  assert.equal(billableSeconds(wallClock, NOW).basis, 'wallClock');

  const res = computeReport([measured, wallClock], spec, { now: NOW });
  assert.equal(res.coverage, 0.5, 'a wallClock-basis row must not count as measured');
  assert.equal(res.coverageSampleSize, 2);
  assert.ok(res.metric.estimate, 'billableMinutes is an estimate, not measured truth');
  assert.match(res.caveat, /OVERSTATES/);
  // The caveat must name the coverage DENOMINATOR, and it is jobs that ran a microVM — not
  // "measured jobs", which is the numerator's own criterion and reads as a tautology
  // ("the share of measured jobs that were measured"). `spend` says PRICED for the same reason.
  assert.match(res.caveat, /share of jobs that RAN a microVM/);
  assert.doesNotMatch(res.caveat, /share of MEASURED jobs/);

  // The overstatement is real, not just documented: the same job priced without a watermark
  // reports MORE minutes than one that has it.
  const measuredOnly = computeReport([measured], spec, { now: NOW }).total;
  const wallClockOnly = computeReport([job({ runningAt: undefined })], spec, { now: NOW }).total;
  assert.ok(wallClockOnly > measuredOnly, 'wall-clock basis should include the queue time it wrongly bills');

  // All-measured is 100%, so the caveat cannot become permanent.
  assert.equal(computeReport([measured], spec, { now: NOW }).coverage, 1);
});

test('billableMinutes does not credit compute to a job that never ran a microVM', () => {
  const spec = SPEC({ metric: 'billableMinutes', dimension: 'none' });
  // A mint/launch failure carries the intended flavor for support but never had a VM
  // (`hasRunMicrovm`). Counting its wall clock as consumed compute would report utilisation
  // that physically did not happen — worst, exactly when provisioning is broken.
  const launchFailure = job({ jobId: 2, status: 'failed', microvmId: undefined });
  const queued = job({ jobId: 3, status: 'queued', microvmId: undefined, runningAt: undefined });
  const real = job();

  const res = computeReport([real, launchFailure, queued], spec, { now: NOW });
  assert.equal(res.total, computeReport([real], spec, { now: NOW }).total, 'an ineligible row added minutes');
  assert.equal(res.coverage, 1, 'an ineligible row must not understate coverage');
  assert.equal(res.coverageSampleSize, 1, 'only the row that ran is measurable');
  assert.equal(res.points[0].sampleSize, 3, 'sampleSize still reports every row in the group');
});

test('billableMinutes counts compute on a flavor spend cannot price', () => {
  // Minutes are measured from timestamps; a PRICE needs the flavor's rate. Gating consumption on
  // the pricing predicate (`isCostEligible`, which also demands a rate) drops real compute out of
  // the total AND out of its own coverage denominator — so the screen reports 100% coverage over
  // a number missing whole rows, which is the one thing a coverage figure must never do.
  //
  // Reachable with no new feature: `flavorRatePerMinute` resolves against the static
  // `microvm/flavors.json`, so renaming or removing an entry orphans every historical row still
  // inside the retention window that stored the old name. Custom flavors (ADR-040/041) make it
  // routine. The row below is exactly that shape: a real microVM, a flavor with no rate.
  const orphaned = job({ jobId: 2, flavor: 'retired-flavor-name', microvmId: 'vm-real-1' });
  assert.equal(flavorRatePerMinute(orphaned.flavor), undefined, 'this row must be unpriceable to be the case under test');
  assert.ok(orphaned.microvmId, 'and it must be real evidence a microVM ran');

  const minutes = computeReport([orphaned], SPEC({ metric: 'billableMinutes', dimension: 'none' }), { now: NOW });
  assert.equal(
    minutes.total,
    round6(billableSeconds(orphaned, NOW).seconds / 60),
    'compute on an unpriceable flavor vanished from the utilisation total',
  );
  assert.equal(minutes.coverage, 1, 'the row was measured from a watermark, so coverage is honest at 1');
  assert.equal(minutes.coverageSampleSize, 1, 'an unpriceable-but-real row belongs in the minutes denominator');

  // Spend keeps the rate requirement: there is no honest price without one, so the row is silent
  // in both shares rather than priced at a guess.
  const usd = computeReport([orphaned], SPEC({ metric: 'spend', dimension: 'none' }), { now: NOW });
  assert.equal(usd.total, 0, 'an unpriceable row must not be given a price');
  assert.equal(usd.coverageSampleSize, 0, 'and must not enter the spend coverage denominator');

  // The two denominators genuinely differ on this row — that difference IS the fix.
  assert.ok(
    minutes.coverageSampleSize > usd.coverageSampleSize,
    'minutes and spend share the pricing gate again',
  );
});

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

test('billableMinutes is an absolute figure, never a share of a capacity ceiling', () => {
  // Utilisation-as-a-ratio needs the microVM concurrency quota as a denominator, which nothing
  // reads yet (Settings/quotas work). A ratio invented from a guessed ceiling is worse than an
  // absolute number, so the catalog text and the caveat must both refuse to imply one.
  const doc = metricDoc('billableMinutes');
  assert.match(doc.definition, /ABSOLUTE figure/);
  assert.match(doc.definition, /concurrency quota is not read/);
  assert.equal(doc.unit, 'minutes', 'a ratio unit would be a capacity claim');
  const res = computeReport([job()], SPEC({ metric: 'billableMinutes', dimension: 'none' }), { now: NOW });
  assert.ok(res.total > 1, 'a 5-minute job must report ~5, not a 0-1 fraction');
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
  assert.match(r.errors.join(' '), new RegExp(`${maxRangeDays()}-day`));
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

  // This test named Run detail and never asked it, so the surface it claimed to pin was the one
  // surface left ungated: `toRunView` reported this row's whole queue-to-finish wall clock as
  // `billableSeconds` on a `wallClock` basis while the aggregate and the export both said 0, and
  // the detail page's prose then explained a price the row never had. All three now agree.
  const view = toRunView(launchFailure, NOW);
  assert.equal(view.costUsd, undefined, 'Run detail must not price a VM that never existed');
  assert.equal(view.billableSeconds, 0, 'Run detail billed a window the report did not');
  assert.equal(
    view.costBasis,
    undefined,
    'Run detail claimed a billable clock for a row with no billable window',
  );
  assert.equal(view.billableSeconds, row.billableSeconds);
  assert.equal(view.costBasis ?? '', row.costBasis, 'the export and Run detail disagree on basis');

  // And the row that DID run reconciles across all three, so the gate is not just zeroing.
  const ran = job({ jobId: 1, microvmId: 'mv-1' });
  const ranView = toRunView(ran, NOW);
  const [ranRow] = toExportRows([ran], NOW);
  assert.equal(ranView.billableSeconds, ranRow.billableSeconds);
  assert.equal(ranView.costBasis, 'measured');
  assert.equal(
    round6(ranView.billableSeconds / 60),
    computeReport([ran], SPEC({ metric: 'billableMinutes', dimension: 'none' }), { now: NOW }).total,
    'Run detail and the utilisation aggregate disagree about one row',
  );
});

test('summing an export column reproduces the aggregate it was downloaded from', () => {
  // The export is the report's own drill-down, so an operator summing a column must land on the
  // headline figure. `estimatedCostUsd` already held this (it goes through `jobCostUsd`, which
  // gates on eligibility); `billableSeconds` did NOT, so a launch-failure row exported its whole
  // queue-to-finish wall clock as billable while contributing 0 to the on-screen total — a
  // 4-minute report downloaded as 9 minutes across these two rows. Unlike a leaked price there
  // is no currency symbol to make the magnitude look wrong, and it errs upward on the one figure
  // that must never overstate.
  const real = job({ jobId: 1, microvmId: 'mv-1' });
  const launchFailure = job({ jobId: 9, status: 'failed', microvmId: undefined });
  const queued = job({ jobId: 3, status: 'queued', microvmId: undefined, runningAt: undefined });
  const rows = [real, launchFailure, queued];
  const exported = toExportRows(rows, NOW);

  assert.equal(exported.length, rows.length, 'every row in the window must still be exported');

  for (const [metric, column, scale] of [
    ['billableMinutes', 'billableSeconds', 60],
    ['spend', 'estimatedCostUsd', 1],
  ]) {
    const report = computeReport(rows, SPEC({ metric, dimension: 'none' }), { now: NOW });
    const summed = exported.reduce((s, r) => s + r[column] / scale, 0);
    assert.ok(
      Math.abs(summed - report.total) < 1e-6,
      `${column} sums to ${summed} but the ${metric} report totals ${report.total}`,
    );
    assert.ok(report.total > 0, `${metric} must measure the real row, or this proves nothing`);
  }

  // The rows that contribute nothing say so, and do not claim a basis for a window they never
  // had: a `costBasis` names which clock measured billable time, and there is none here.
  for (const r of exported.filter((e) => e.jobId !== 1)) {
    assert.equal(r.billableSeconds, 0, `job ${r.jobId} exported compute it never used`);
    assert.equal(r.costBasis, '', `job ${r.jobId} claims a billable clock it never started`);
    assert.equal(r.estimatedCostUsd, 0);
    // Nothing is lost: the row's real span is still exported, under a column that means it.
    assert.ok(r.wallClockSeconds > 0, 'the row still carries its real elapsed span');
    assert.equal(r.createdAt, real.createdAt);
  }

  // And the row that DID run is untouched — the gate must not flatten real compute.
  const [ran] = exported.filter((e) => e.jobId === 1);
  assert.equal(ran.billableSeconds, billableSeconds(real, NOW).seconds);
  assert.equal(ran.costBasis, 'measured');
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

test('grouping by workflow labels rows with no workflow name honestly and without collision', () => {
  const spec = SPEC({ dimension: 'workflow' });
  const res = computeReport([job({ workflowName: undefined })], spec, { now: NOW });
  // "(unknown)" read like a real workflow whose name could not be determined, so the label
  // names the GAP. It must not name a CAUSE either: the field is absent both on a pre-M5 row
  // and on a current row whose `workflow_job` event carried no `workflow_name` (optional and
  // nullable on the wire, coalesced by both ingest paths, omitted when falsy by the run store).
  // Dating the bucket would repeat the `runningAt` error — right number, false explanation.
  assert.match(res.points[0].label, /no workflow name recorded/);
  assert.doesNotMatch(res.points[0].label, /unknown/i);
  assert.doesNotMatch(res.points[0].label, /pre-M5|predates|older|old row/i);
  // Same for the operator-facing prose, which is where the claim would actually be read.
  const groupKeySrc = sliceBetween(
    fs.readFileSync(new URL('../src/mgmt/reports.ts', import.meta.url), 'utf8'),
    'function groupKey',
    "\n    case 'status':",
    2000,
  );
  assert.match(
    groupKeySrc,
    /workflow_name.*(optional|absent)|absent on the event/s,
    'the workflow gap is documented as a pre-M5 artefact only — a current event can omit the name',
  );

  // `workflowName` is copied verbatim off the webhook, so a repo may contain a workflow
  // literally named like the empty bucket's label. Keying the absent case by its display
  // string merged the two into one bar — real activity attributed to a data gap, unfalsifiable
  // from the chart.
  const collide = computeReport(
    [job({ jobId: 1, workflowName: undefined }), job({ jobId: 2, workflowName: '(no workflow name recorded)' })],
    SPEC({ metric: 'runCount', dimension: 'workflow' }),
    { now: NOW },
  );
  assert.equal(collide.points.length, 2, 'a tenant-named workflow was merged into the unrecorded bucket');
  assert.deepEqual(collide.points.map((p) => p.value), [1, 1]);

  // An empty-string name is a gap too, not a workflow with a blank name.
  const blank = computeReport([job({ workflowName: '' })], spec, { now: NOW });
  assert.match(blank.points[0].label, /no workflow name recorded/);
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
  const map = sliceBetween(renderer, 'CHART_RENDERING', '};', 400);
  for (const chart of CHART_TYPES) {
    assert.ok(
      new RegExp(`\\b${chart}:`).test(map),
      `chart type "${chart}" is offered but CHART_RENDERING never maps it`,
    );
  }
});

test('every unit in the catalog is one the frontend actually renders', () => {
  // Same contract as the chart-type guard above, for the OTHER half of what the renderer is
  // handed. `MetricDoc.unit` is a free-form string, `formatValue` dispatches on its literal
  // value, and the fallthrough is `String(value)` — so a metric introducing a unit the renderer
  // does not know prints a bare number on the axis, the tooltip, the table cell AND the headline
  // total. That is not a visibly broken chart; it is a figure whose unit silently disappeared,
  // which on a cost/utilisation screen is a wrong answer that looks right.
  //
  // `billableMinutes` is the first metric to add a unit since the vocabulary was written, and it
  // needed a new `formatValue` branch to render at all. Pinning only the `'minutes'` literal (as
  // this file did) re-opens the gap for the next one, so the check is over the whole catalog.
  //
  // A unit MAY render as a plain number, but only deliberately: `jobs` needs no suffix because
  // the metric label already reads "Job count". Adding a unit here is therefore a two-line
  // decision — give it a renderer, or say in this list that a bare number is the intended output.
  const RENDERED_AS_PLAIN_NUMBER = ['jobs'];

  const renderer = fs.readFileSync(
    new URL('../web/src/screens/ReportChart.tsx', import.meta.url),
    'utf8',
  );
  const fmt = sliceBetween(renderer, 'function formatValue', '\n}', 600);
  for (const unit of new Set(METRIC_CATALOG.map((m) => m.unit))) {
    if (RENDERED_AS_PLAIN_NUMBER.includes(unit)) continue;
    assert.ok(
      fmt.includes(`'${unit}'`),
      `unit "${unit}" has no formatValue branch, so its figures print as a bare number with no unit`,
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
  const body = sliceBetween(chart, 'export function ReportChart', 'export function ReportTable', 2000);
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
  const body = sliceBetween(screen, 'function Assistant', 'function specToQuery', 4000);
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

test('an explicit null dimension is rejected, not coerced to a default', () => {
  // `input.dimension ?? 'none'` silently repaired this into a different report than the one
  // asked for. ADR-045 promises ill-typed spec input is REJECTED; the `chart` branch already
  // behaved that way, so the coercion was also an internal inconsistency. An ABSENT dimension
  // still defaults — that is the documented shorthand.
  for (const bad of [null, 42, ['repo'], { d: 'repo' }]) {
    const r = validateReportSpec({ metric: 'spend', dimension: bad }, NOW);
    assert.equal(r.ok, false, `dimension ${JSON.stringify(bad)} was accepted`);
    assert.ok(r.errors.some((e) => e.includes('dimension must be one of')));
  }
  const absent = validateReportSpec({ metric: 'spend' }, NOW);
  assert.ok(absent.ok);
  assert.equal(absent.value.dimension, 'none');
});

test('an unmeasurable span is excluded from percentiles rather than folded in as zero', () => {
  // A fabricated 0s is indistinguishable from a genuinely instant job and drags p50/p90 down,
  // which is precisely what both percentile metrics promise not to do. `runningAt` and
  // `createdAt` are written by different λ invocations, so an inverted pair is reachable.
  const spec = SPEC({ metric: 'queueLatency', dimension: 'none' });
  const good = [
    job({ jobId: 1, createdAt: '2026-07-15T11:00:00.000Z', runningAt: '2026-07-15T11:00:30.000Z' }),
    job({ jobId: 2, createdAt: '2026-07-15T11:00:00.000Z', runningAt: '2026-07-15T11:00:40.000Z' }),
  ];
  const skewed = job({
    jobId: 3,
    createdAt: '2026-07-15T11:00:00.000Z',
    runningAt: '2026-07-15T10:59:00.000Z', // watermark BEFORE queued
  });
  const unparseable = job({ jobId: 4, createdAt: '2026-07-15T11:00:00.000Z', runningAt: 'nope' });

  const clean = computeReport(good, spec, { now: NOW });
  const dirty = computeReport([...good, skewed, unparseable], spec, { now: NOW });

  assert.equal(dirty.points[0].sampleSize, 2, 'an unmeasurable row entered the sample');
  assert.equal(dirty.points[0].value, clean.points[0].value, 'p50 was dragged down by a fake 0');
  assert.equal(dirty.points[0].secondary, clean.points[0].secondary);
  // And it is reported as uncovered, not silently covered: 2 of 4 rows measured.
  assert.equal(dirty.coverage, 0.5);
});

test('duration excludes a terminal row whose span cannot be measured', () => {
  const spec = SPEC({ metric: 'duration', dimension: 'none' });
  const rows = [
    job({ jobId: 1, createdAt: '2026-07-15T11:00:00.000Z', updatedAt: '2026-07-15T11:01:00.000Z' }),
    // Terminal, but updatedAt precedes createdAt — no measurable span.
    job({ jobId: 2, createdAt: '2026-07-15T11:00:00.000Z', updatedAt: '2026-07-15T10:00:00.000Z' }),
  ];
  const res = computeReport(rows, spec, { now: NOW });
  assert.equal(res.points[0].sampleSize, 1);
  assert.equal(res.points[0].value, 60);
  assert.equal(res.coverage, 0.5, 'the unmeasurable row must count as uncovered');
});

test('the assistant route returns a spec and never executes the report itself', () => {
  // Two full authorization fan-outs per question (once in `ask`, once when the console adopts
  // the spec and fetches /api/reports/run) is up to 2 x MAX_TOTAL_ROWS of DynamoDB reads for one
  // answer, with the first result discarded. Source-level, matching the other handler/SPA
  // assertions in this file — this repo drives pure helpers and has no handler harness.
  const handler = fs.readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8');
  const body = sliceBetween(
    handler,
    'async function askReportRoute',
    'async function settingsRoute',
    3000,
  );
  assert.ok(
    !/executeReport/.test(body),
    'askReportRoute executes the report again — that doubles the fan-out per question',
  );
  assert.ok(/spec: proposal\.spec/.test(body), 'ask must hand back the validated spec');

  // …and the client must render from the deterministic route, not from the ask response.
  const screen = fs.readFileSync(
    new URL('../web/src/screens/Reports.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    /onSpec\(specToQuery\(res\.spec\)\)/.test(screen),
    'the console must adopt the returned spec as picker state',
  );
  const viewStart = screen.indexOf('function ReportView');
  assert.ok(viewStart >= 0, 'could not find ReportView');
  const view = screen.slice(viewStart);
  assert.ok(view.length > 0, 'could not isolate ReportView');
  assert.ok(
    !/resolved\.points|resolved\.total/.test(view),
    'the rendered view must come from /api/reports/run, not the ask response',
  );
});

test('a truncated CSV export declares its truncation, since the body cannot', () => {
  // The JSON export carries `complete` in its payload; CSV has nowhere to put it, so a
  // budget-truncated download would look like a full one and its row count would be read as a
  // total. The header is the only channel, and the UI has to say so next to the link — a header
  // no operator sees is not a disclosure. Source-level, matching the SPA assertions above:
  // this repo drives pure helpers in tests and has no handler/DOM harness.
  const handler = fs.readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8');
  const body = sliceBetween(
    handler,
    'async function exportReportRoute',
    'async function askReportRoute',
    4000,
  );
  assert.ok(
    /'X-Report-Complete': String\(fetched\.complete && bounded\.complete\)/.test(body),
    'the CSV export must publish its completeness in a header',
  );
  assert.ok(
    /complete: fetched\.complete && bounded\.complete/.test(body),
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

// ---- export size bound -----------------------------------------------------

test('an export is bounded to what one Lambda response can carry', () => {
  // The fan-out budget is MAX_TOTAL_ROWS = 20 000, but a CSV/JSON export is a single
  // SYNCHRONOUS Lambda response and those are capped at 6 MB. Measured against these exact
  // serializers, 20 000 rows is ~3.8 MiB of CSV with short tenant names, ~6.5 MiB with realistic
  // long repo/workflow/job names, and 7.2-9.8 MiB as JSON. Over the cap is not a short file: the
  // invocation errors and the operator gets an opaque 502 — worst for whoever has most history.
  const rows = toExportRows(
    Array.from({ length: 20_000 }, (_, i) => job({ jobId: i + 1 })),
    NOW,
  );
  const csv = boundExportRows(rows, (r) => Buffer.byteLength(toCsv(r)));
  const jsonForm = boundExportRows(rows, (r) => Buffer.byteLength(JSON.stringify(r)));

  for (const [name, bounded, measure] of [
    ['csv', csv, (r) => Buffer.byteLength(toCsv(r))],
    ['json', jsonForm, (r) => Buffer.byteLength(JSON.stringify(r))],
  ]) {
    assert.ok(bounded.rows.length <= MAX_EXPORT_ROWS, `${name} exceeded the row cap`);
    assert.equal(bounded.complete, false, `${name} dropped rows but claimed to be complete`);
    assert.ok(
      measure(bounded.rows) <= MAX_EXPORT_BYTES,
      `${name} body is ${measure(bounded.rows)} bytes, over the backstop`,
    );
    // The whole point: comfortably inside Lambda's hard limit, not merely near it.
    assert.ok(measure(bounded.rows) < 6_000_000, `${name} body would still fail the 6 MB cap`);
  }
});

test('the byte backstop binds before the row cap when tenant names are pathological', () => {
  // MAX_EXPORT_ROWS alone is NOT a size guarantee: repo / workflow / job names are
  // tenant-controlled and unbounded, so a row has no fixed width. A repo that names itself 400
  // characters makes the row cap irrelevant, and only the byte budget keeps the response legal.
  const wide = 'x'.repeat(400);
  const rows = toExportRows(
    Array.from({ length: MAX_EXPORT_ROWS }, (_, i) =>
      job({ jobId: i + 1, repoFullName: `acme/${wide}`, workflowName: wide, jobName: wide }),
    ),
    NOW,
  );
  const measure = (r) => Buffer.byteLength(toCsv(r));
  assert.ok(measure(rows) > MAX_EXPORT_BYTES, 'fixture is not actually oversized');
  const bounded = boundExportRows(rows, measure);
  assert.ok(
    bounded.rows.length < MAX_EXPORT_ROWS,
    'the byte backstop did not trim a row-cap-legal but oversized body',
  );
  assert.ok(measure(bounded.rows) <= MAX_EXPORT_BYTES);
  assert.equal(bounded.complete, false);
});

test('an export inside both budgets is returned whole and reported complete', () => {
  // Mutation guard the other way: the bound must not trim a normal export or report a
  // truncation that did not happen, which would put a permanent false caveat on every download.
  const rows = toExportRows(Array.from({ length: 25 }, (_, i) => job({ jobId: i + 1 })), NOW);
  const bounded = boundExportRows(rows, (r) => Buffer.byteLength(toCsv(r)));
  assert.equal(bounded.rows.length, 25);
  assert.equal(bounded.complete, true);
  assert.deepEqual(bounded.rows, rows);
});

test('an empty export is complete, not truncated', () => {
  const bounded = boundExportRows([], (r) => Buffer.byteLength(toCsv(r)));
  assert.deepEqual(bounded.rows, []);
  assert.equal(bounded.complete, true);
});

test('the byte backstop ships every row that fits, not the first power-of-two that does', () => {
  // The bound used to halve repeatedly and never come back up, so the first overshoot was
  // permanent: 10 000 rows of realistic long tenant names is ~4.9 MiB of JSON, one halving
  // shipped 5 000 rows at 2.5 MiB, and 8 460 rows would have fit. It reported `complete: false`,
  // so it was not a silent lie — it just threw away 41% of the data the operator asked for from
  // the one feature whose job is to hand them the underlying rows. Both shapes cost O(log n)
  // measurements, so tightness is free.
  //
  // Asserting "within a row of the true optimum" rather than a magic number: it pins the
  // property (maximal prefix under the backstop) and a halving implementation fails it by
  // thousands of rows.
  const wide = 'y'.repeat(120);
  const rows = toExportRows(
    Array.from({ length: MAX_EXPORT_ROWS }, (_, i) =>
      job({ jobId: i + 1, repoFullName: `acme/${wide}-${i}`, workflowName: wide, jobName: wide }),
    ),
    NOW,
  );

  for (const [name, measure] of [
    ['csv', (r) => Buffer.byteLength(toCsv(r))],
    ['json', (r) => Buffer.byteLength(JSON.stringify(r))],
  ]) {
    assert.ok(measure(rows) > MAX_EXPORT_BYTES, `${name} fixture is not actually oversized`);
    const bounded = boundExportRows(rows, measure);

    // Independent bisect for the true largest fitting prefix.
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(rows.slice(0, mid)) <= MAX_EXPORT_BYTES) lo = mid;
      else hi = mid - 1;
    }

    assert.ok(measure(bounded.rows) <= MAX_EXPORT_BYTES, `${name} body is over the backstop`);
    assert.equal(bounded.complete, false, `${name} dropped rows but claimed complete`);
    assert.ok(
      bounded.rows.length >= lo - 1,
      `${name} shipped ${bounded.rows.length} rows when ${lo} fit — ${lo - bounded.rows.length} rows were discarded for nothing`,
    );
    // And it must not overshoot the optimum either — that would mean an over-cap body.
    assert.ok(bounded.rows.length <= lo, `${name} shipped more rows than actually fit`);
  }
});

test('a single row wider than the backstop yields no rows rather than an illegal body', () => {
  // Shipping it anyway is a Lambda invocation error — an opaque 502 for the whole download,
  // which is precisely what the bound exists to prevent. Zero rows plus `complete: false` is
  // the honest answer.
  const rows = toExportRows([job({ jobName: 'z'.repeat(64) })], NOW);
  const bounded = boundExportRows(rows, () => MAX_EXPORT_BYTES + 1);
  assert.deepEqual(bounded.rows, []);
  assert.equal(bounded.complete, false);
});

test('the export cap is published in the report so the UI can warn before the click', () => {
  // A download that comes back quietly shorter than the `rowCount` shown above it is the same
  // class of failure as a silently truncated report. The limit rides in the result, and the
  // screen compares it against rowCount rather than waiting for the file to be wrong.
  const res = computeReport([job()], SPEC({ dimension: 'none' }), { now: NOW });
  assert.equal(res.exportRowLimit, MAX_EXPORT_ROWS);

  const screen = fs.readFileSync(
    new URL('../web/src/screens/Reports.tsx', import.meta.url),
    'utf8',
  );
  assert.match(
    screen,
    /report\.rowCount > report\.exportRowLimit/,
    'the screen must warn when a download will be capped',
  );
  // The row limit is a CEILING, not a promise: the byte backstop can bind first when tenant
  // names are long, so the notice must not claim the file will carry exactly that many rows.
  assert.match(
    screen,
    /carries at most/,
    'the export notice must state the row limit as a maximum',
  );
  assert.match(
    screen,
    /size-capped/,
    'the export notice must say a long-name export can be shorter than the row limit',
  );
});

test('both export formats fold the export cap into the completeness they publish', () => {
  // `complete` already meant "the read budget was not spent". It must now ALSO mean "no row was
  // dropped on the way out", or a capped export reports itself as a full one through the exact
  // channel built to disclose truncation. Source-level, matching the other handler assertions.
  const handler = fs.readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8');
  const body = sliceBetween(
    handler,
    'async function exportReportRoute',
    'async function askReportRoute',
    4000,
  );

  // Both formats bound before serializing...
  assert.equal(
    (body.match(/boundExportRows\(/g) ?? []).length,
    2,
    'both the CSV and JSON export paths must bound their rows',
  );
  // ...and both publish the conjunction, not just the fan-out's verdict.
  assert.equal(
    (body.match(/fetched\.complete && bounded\.complete/g) ?? []).length,
    2,
    'a capped export must report itself incomplete in both formats',
  );
  assert.ok(
    /'X-Report-Complete': String\(fetched\.complete && bounded\.complete\)/.test(body),
    'the CSV header must reflect the export cap as well as the read budget',
  );
});

// ---- window cap follows real retention -------------------------------------

/** Run a body with RUN_RETENTION_DAYS set, restoring whatever was there before. */
function withRetention(days, fn) {
  const prev = process.env.RUN_RETENTION_DAYS;
  if (days === undefined) delete process.env.RUN_RETENTION_DAYS;
  else process.env.RUN_RETENTION_DAYS = String(days);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.RUN_RETENTION_DAYS;
    else process.env.RUN_RETENTION_DAYS = prev;
  }
}

test('the report window cap is the environment\'s real run retention, not a hardcoded 90', () => {
  // Terminal rows carry a TTL of RUN_RETENTION_DAYS days, and that is PER-ENVIRONMENT
  // (ADR-033: dev 30, prod 90). A 90-day cap in a 30-day environment accepts a window most of
  // which has already aged out of the table — and the report then answers over a partially
  // deleted span while reporting `complete: true`, which is precisely the silent floor every
  // other budget path in this feature discloses.
  assert.equal(withRetention(30, () => maxRangeDays()), 30);
  assert.equal(withRetention(90, () => maxRangeDays()), 90);
  // Unset / malformed falls back rather than shrinking an existing deployment's reports.
  assert.equal(withRetention(undefined, () => maxRangeDays()), DEFAULT_MAX_RANGE_DAYS);
  assert.equal(withRetention('abc', () => maxRangeDays()), DEFAULT_MAX_RANGE_DAYS);
  assert.equal(withRetention(0, () => maxRangeDays()), DEFAULT_MAX_RANGE_DAYS);
});

test('a preset wider than retention is REJECTED, not silently clamped', () => {
  // Reachable without any hostile input: a `90d` report URL shared from prod, opened against a
  // 30-day environment. Clamping would answer a different question than the link names while
  // still reporting itself complete, so it has to be an error the operator can read.
  withRetention(30, () => {
    const r = validateReportSpec({ metric: 'spend', preset: '90d' }, NOW);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /30-day run retention/);
    // …and the error names what IS available, so the message is actionable.
    assert.match(r.errors.join(' '), /24h, 7d, 30d/);
  });
  // The same preset is fine where retention actually covers it.
  withRetention(90, () => {
    const r = validateReportSpec({ metric: 'spend', preset: '90d' }, NOW);
    assert.equal(r.ok, true);
  });
});

test('an explicit window is capped by retention too', () => {
  withRetention(30, () => {
    const r = validateReportSpec(
      { metric: 'spend', from: '2026-05-01T00:00:00.000Z', to: '2026-07-15T00:00:00.000Z' },
      NOW,
    );
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /30-day run retention/);
  });
});

test('an explicit window that STARTS before retention is rejected, however narrow it is', () => {
  // The width check alone does not cap a window: a 10-day window 200 days ago is well inside
  // the 30-day WIDTH limit while lying entirely behind the retention horizon, so the fan-out
  // reads partitions the TTL has already emptied and the report answers `complete: true` over
  // deleted rows. That is the same silent floor the preset branch refuses, reached by the
  // other door — and the console then prints "No jobs in this window" about jobs that did run.
  withRetention(30, () => {
    const r = validateReportSpec(
      { metric: 'spend', from: '2026-01-13T00:00:00.000Z', to: '2026-01-23T00:00:00.000Z' },
      NOW,
    );
    assert.equal(r.ok, false, 'an aged-out window must not be answered as a complete report');
    assert.match(r.errors.join(' '), /predates the 30-day run retention/);
    // Actionable: the error states the horizon and what the picker can still offer.
    assert.match(r.errors.join(' '), /no run history before 2026-06-15T12:00:00\.000Z/);
    assert.match(r.errors.join(' '), /24h, 7d, 30d/);
  });
});

test('a pinned custom-window report ages out into a refusal rather than a false empty', () => {
  // The reachable path, with no hostile input at all: `specToQuery` pins a non-preset spec as
  // `from`/`to` verbatim, so a bookmarked or shared custom-window report is re-executed with
  // the SAME absolute window weeks later. It must stop being answerable, not quietly answer
  // zero. Same URL, two different `now`s.
  const pinned = { metric: 'spend', from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' };
  withRetention(30, () => {
    const fresh = validateReportSpec(pinned, NOW);
    assert.equal(fresh.ok, true, 'a window inside retention must still resolve');
    const later = validateReportSpec(pinned, new Date('2026-09-15T12:00:00.000Z'));
    assert.equal(later.ok, false, 'the same pinned window is aged out 2 months later');
    assert.match(later.errors.join(' '), /predates the 30-day run retention/);
  });
});

test('the retention horizon is inclusive, so a preset-width explicit window still resolves', () => {
  // A `30d` window in a 30-day environment is the widest LEGAL report, and the picker resolves
  // exactly that window through the preset branch. The explicit branch must agree with it at
  // the boundary, or a shared link built from the preset's own `from`/`to` would be refused.
  withRetention(30, () => {
    const boundary = validateReportSpec(
      { metric: 'spend', from: '2026-06-15T12:00:00.000Z', to: '2026-07-15T12:00:00.000Z' },
      NOW,
    );
    assert.equal(boundary.ok, true, JSON.stringify(boundary.errors ?? []));
    // One millisecond older is not.
    const past = validateReportSpec(
      { metric: 'spend', from: '2026-06-15T11:59:59.999Z', to: '2026-07-15T11:59:59.999Z' },
      NOW,
    );
    assert.equal(past.ok, false);
  });
});

test('an inverted window reports only the ordering error, not an age error too', () => {
  // Error messages are the operator's only handle on a refused spec: reporting an aged-out
  // horizon for a window whose real defect is `to` before `from` sends them to fix the wrong
  // control.
  withRetention(30, () => {
    const r = validateReportSpec(
      { metric: 'spend', from: '2026-01-10T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
      NOW,
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ['to must be after from']);
  });
});

test('the picker and the model are only offered presets retention can fill', () => {
  assert.deepEqual(withRetention(30, () => availablePresets()), ['24h', '7d', '30d']);
  assert.deepEqual(withRetention(90, () => availablePresets()), ['24h', '7d', '30d', '90d']);
  assert.deepEqual(withRetention(1, () => availablePresets()), ['24h']);
  // Never empty: a pathologically short retention still serves its narrowest window, or the
  // screen would have no window control at all.
  assert.deepEqual(withRetention(0, () => availablePresets(0)), ['24h']);
});

test('the default window degrades when retention cannot serve 7d', () => {
  withRetention(1, () => {
    const r = validateReportSpec({ metric: 'spend' }, NOW);
    assert.equal(r.ok, true);
    assert.equal(r.value.preset, '24h');
  });
});

test('the Mgmt λ is actually given the retention it caps windows with', () => {
  // `maxRangeDays()` reads RUN_RETENTION_DAYS. If MgmtStack never passes it, the knob is
  // unreachable and every environment silently gets the 90-day fallback — the defect class
  // ADR-033 names ("a config knob that nothing reads is worse than no knob"). Asserted at the
  // source because the stack test suite covers the synthesized template separately.
  const stack = fs.readFileSync(new URL('../lib/mgmt-stack.ts', import.meta.url), 'utf8');
  assert.match(
    stack,
    /RUN_RETENTION_DAYS: String\(config\.runRetentionDays\)/,
    'MgmtStack must pass the env config retention to the λ',
  );
});

// ---- coverage over an empty sample -----------------------------------------

test('a metric that measured nothing does not report 100% coverage', () => {
  // `coverage` is num/den and den can legitimately be 0 — a spend report over jobs that never
  // launched, or a duration report over jobs still queued. Reported as the ratio it would be
  // "100%", i.e. the screen claims everything was measured about a metric that measured
  // nothing. `coverageSampleSize` is the denominator, so the UI can say so instead.
  const queued = [
    job({ jobId: 1, status: 'queued', flavor: undefined, runningAt: undefined }),
    job({ jobId: 2, status: 'queued', flavor: undefined, runningAt: undefined }),
  ];
  const spend = computeReport(queued, SPEC({ metric: 'spend' }), { now: NOW });
  assert.equal(spend.coverageSampleSize, 0, 'no row was priced, so the ratio is vacuous');
  assert.equal(spend.total, 0);
  assert.equal(spend.rowCount, 2, 'the rows are still counted — they exist');

  // A priced row makes the denominator real again.
  const priced = computeReport([...queued, job({ jobId: 3 })], SPEC({ metric: 'spend' }), { now: NOW });
  assert.equal(priced.coverageSampleSize, 1);
  assert.equal(priced.coverage, 1);
});

test('rows in the window with nothing measurable are not reported as "no jobs"', () => {
  // A duration report over 2 queued jobs produces an EMPTY series while `rowCount` is 2. The
  // panel used to render one flat "No jobs in this window." for both the genuinely empty window
  // and this one, contradicting the job count printed directly above it.
  const inflight = [
    job({ jobId: 1, status: 'queued', runningAt: undefined }),
    job({ jobId: 2, status: 'running' }),
  ];
  const r = computeReport(inflight, SPEC({ metric: 'duration' }), { now: NOW });
  assert.equal(r.points.length, 0, 'no terminal row, so no point');
  assert.equal(r.rowCount, 2, 'but the rows are there');
  assert.equal(r.coverageSampleSize, 2, 'they COULD have contributed — none did');
  assert.equal(r.coverage, 0);

  // A truly empty window is the distinguishable case: no rows at all.
  const empty = computeReport([], SPEC({ metric: 'duration' }), { now: NOW });
  assert.equal(empty.rowCount, 0);
  assert.equal(empty.coverageSampleSize, 0);

  // The screen must branch on both, not print one sentence for all three states.
  const screen = fs.readFileSync(
    new URL('../web/src/screens/Reports.tsx', import.meta.url),
    'utf8',
  );
  const view = sliceBetween(screen, 'function ReportView', '\n}\n', 6000);
  assert.ok(
    /coverageSampleSize === 0/.test(view),
    'the coverage line must not print a ratio over an empty sample',
  );
  assert.ok(
    /rowCount === 0/.test(view),
    'the empty panel must tell an empty window apart from an unmeasurable one',
  );

  // ...and the COVERAGE sentence has the same three states as the empty-series line, not two.
  // An empty denominator has two causes and only one of them is "jobs that could not
  // contribute": on an empty window there were no jobs to contribute at all, so the two-branch
  // form told the operator that none of 0 jobs could be measured while the line below it said
  // "No jobs in this window" and the header said `0 jobs`. That is the default view of any
  // environment with no run history, under the default metric — the first coverage sentence a
  // new operator ever reads — and it is the same conflation this test's subject corrected for
  // the series.
  const coverageLine = sliceBetween(view, '{report.caveat && (', '{report.caveat}', 2000);
  assert.ok(
    /rowCount === 0/.test(coverageLine),
    'the coverage sentence claims an empty window\u2019s jobs could not contribute; there were none',
  );
  assert.ok(
    /coverageSampleSize === 0/.test(coverageLine),
    'the coverage sentence lost its vacuous-ratio branch',
  );
  assert.ok(
    coverageLine.indexOf('rowCount === 0') < coverageLine.indexOf('coverageSampleSize === 0'),
    'the empty-window branch must be tested FIRST — an empty window also has an empty sample, so the sample branch would swallow it',
  );
});

test('the default report window comes from real retention, not a compile-time constant', () => {
  // `DEFAULT_QUERY.preset` in the SPA is a constant; the servable preset list is a per-
  // environment fact (RUN_RETENTION_DAYS, ADR-033) only the catalog knows. Where they disagree
  // the screen opened on a spec the server refuses — a 400 on first paint, before the operator
  // touched anything, on the one screen whose design rule is never to offer a window retention
  // cannot fill. The server already degrades its own default; this pins the client half.
  //
  // Source-level, per this file's convention for SPA logic (no DOM harness). It pins the three
  // properties that make the substitution correct, since each inversion is a different defect.
  const screen = fs.readFileSync(
    new URL('../web/src/screens/Reports.tsx', import.meta.url),
    'utf8',
  );
  const fn = sliceBetween(screen, 'function effectiveQuery(', '\n}\n', 900);

  // 1. It substitutes the widest SERVABLE preset, not a second hardcoded one.
  assert.match(
    fn,
    /presets\[presets\.length - 1\]/,
    'the substituted default is not derived from the catalog\u2019s own list',
  );
  // 2. A window named in the URL is passed through untouched: rewriting a shared link would
  //    answer a different question than the link names, which is why the validator rejects
  //    rather than clamps. The picker's `(beyond retention)` option depends on this.
  //    Asserted on the GUARD, not on the identifier: `windowFromUrl` stays in the signature
  //    when it is dropped from the condition, so a name check passes the exact inversion.
  assert.match(
    fn,
    /if \(windowFromUrl \|\|/,
    'a URL-named window is not exempt from substitution — a shared link would be silently rewritten',
  );
  // 3. A servable preset is left exactly as it is.
  assert.match(fn, /presets\.includes\(query\.preset\)/, 'a servable preset is not passed through');

  // And it is a PURE derivation, not a normalising effect: an effect would fetch the refused
  // default first and correct it on the next render, so the operator sees a 400 that vanishes
  // and the fan-out is spent on it.
  assert.ok(
    !/setQuery/.test(fn),
    'the substitution mutates state, so the unservable default is still what the first fetch uses',
  );
  const component = sliceBetween(screen, 'export function Reports()', '\n}\n', 3000);
  assert.match(
    component,
    /effectiveQuery\(query, presets, windowFromUrl\)/,
    'the screen does not report on the substituted query',
  );
  // The report must not be fetched before the catalog says which windows are servable.
  assert.match(
    component,
    /presets\?\.length \? api\.report/,
    'the report is fetched before retention is known, so the refused default goes out anyway',
  );
  // The permalink, the picker, the assistant and the result all read the SAME substituted
  // query. Each is asserted through its own component, because a shared substring (both the
  // Picker and the Assistant are passed `catalog={catalog.data} query=…`) lets one of them keep
  // the unsubstituted state while a loose match still passes. A picker reading `7d` while the
  // chart reports `24h` is precisely the drift this substitution would otherwise introduce.
  for (const [tag, attr] of [
    ['Assistant', 'query={active}'],
    ['Picker', 'query={active}'],
    ['ReportView', 'query={active}'],
  ]) {
    const el = component.slice(component.indexOf(`<${tag} `));
    assert.ok(
      el.slice(0, el.indexOf('/>') + 2).includes(attr),
      `<${tag}> is rendered from the unsubstituted query, so it can disagree with the report`,
    );
  }
  assert.match(component, /reportQueryString\(active\)/, 'the permalink is built from the unsubstituted query');
});

test('USD is rendered by exactly one formatter in the console', () => {
  // The card's requirement, and a real divergence before it: ReportChart carried a private
  // `formatValue` USD branch while Run detail used `formatCost`, so the SAME job's estimated
  // cost could print with different precision on two screens. Documenting a precision rule in
  // two places does not keep them equal — one of them being the only implementation does.
  //
  // Source-level assertion because this repo has no DOM harness for the SPA (same convention as
  // the chart-host guard above). It pins BOTH halves: the rule lives in formatCost, and every
  // other money renderer delegates to it.
  const components = fs.readFileSync(new URL('../web/src/components.tsx', import.meta.url), 'utf8');
  const formatter = sliceBetween(components, 'export function formatCost', '\n}', 300);
  assert.match(formatter, /toFixed\(/, 'formatCost no longer owns the precision rule');
  assert.match(formatter, /< 1 \? 4 : 2/, 'the magnitude rule (4dp under $1, else 2dp) is not stated in code');

  // Two lists, because "renders money" and "may not carry a precision rule" are different
  // claims. `Reports.tsx` prints the aggregate total through the chart's `formatValue` rather
  // than touching `formatCost` itself, so demanding the identifier there would force a
  // pointless import; but it is still a money screen and must not grow its own `toFixed`.
  const DELEGATES_TO_FORMAT_COST = [
    'screens/ReportChart.tsx',
    'screens/RunDetail.tsx',
    'screens/Dashboard.tsx',
    'screens/Platform.tsx',
  ];
  const NO_INLINE_PRECISION = [...DELEGATES_TO_FORMAT_COST, 'screens/Reports.tsx'];

  for (const file of DELEGATES_TO_FORMAT_COST) {
    const src = fs.readFileSync(new URL(`../web/src/${file}`, import.meta.url), 'utf8');
    assert.match(src, /formatCost/, `${file} renders money without the shared formatter`);
  }

  for (const file of NO_INLINE_PRECISION) {
    const src = fs.readFileSync(new URL(`../web/src/${file}`, import.meta.url), 'utf8');

    // Any `toFixed` in a money screen is a precision rule, and the rule is supposed to live in
    // exactly one place. Matching on the currency SYMBOL cannot enforce that: a template literal
    // spells it `` `$${x.toFixed(4)}` `` but JSX spells the identical output `~${x.toFixed(4)}`,
    // where the `$` is literal text and the braces are a JSX expression — indistinguishable from
    // the non-currency `${(v * 100).toFixed(1)}%`. A symbol-shaped regex therefore passes the
    // exact form this change removed from `Platform.tsx`.
    //
    // So the rule is structural instead: a money screen may not call `toFixed` at all, except on
    // a line that names a unit which is explicitly NOT currency. That is one line today
    // (`ratio 0-1` in the chart's unit renderer), and it catches both inversions — re-inlining
    // the chart's USD branch, and re-introducing a JSX-inline `~${…toFixed(4)}` money cell.
    const offending = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes('toFixed') && !/'ratio 0-1'/.test(line));
    assert.deepEqual(
      offending,
      [],
      `${file} formats a figure inline instead of delegating to formatCost: ${offending
        .map(([n, l]) => `L${n}: ${l.trim()}`)
        .join(' / ')}`,
    );
  }

  // And the chart's USD branch is the delegation, not a copy.
  const renderer = fs.readFileSync(
    new URL('../web/src/screens/ReportChart.tsx', import.meta.url),
    'utf8',
  );
  const fmt = sliceBetween(renderer, 'function formatValue', '\n}', 600);
  assert.match(fmt, /'USD'\)\s*return formatCost\(/, 'the chart re-implements USD formatting');
  assert.match(fmt, /'minutes'/, 'the minutes unit has no renderer, so billableMinutes axes print raw numbers');
});
