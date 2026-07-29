// Unit tests for the Management API read models + validation
// (src/mgmt/views.ts, src/mgmt/validate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toRunView,
  durationSeconds,
  estimateCostUsd,
  flavorRatePerMinute,
  buildHealth,
  summarizeCost,
  rollupCompat,
  toWorkflowView,
  toRepoView,
  buildFlavorViews,
  flavorNames,
  sortRunsNewestFirst,
  toSecretStatus,
  STUCK_AFTER_SECONDS,
} from '../dist/src/mgmt/views.js';
import { decideClaim } from '../dist/src/ingest/adopt.js';
import { rewriteTargets } from '../dist/src/mgmt/rewrite.js';
import {
  validateRepoPatch,
  validateFlavorMap,
  parseLimit,
  MAX_FLAVOR_MAP_ENTRIES,
} from '../dist/src/mgmt/validate.js';

function run(over = {}) {
  return {
    repoId: 1,
    repoFullName: 'acme/service',
    installationId: 111,
    runId: 10,
    jobId: 20,
    status: 'completed',
    flavor: 'base',
    labels: ['self-hosted', 'lambda-ci'],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:02:00.000Z',
    ...over,
  };
}

test('duration is derived from createdAt → updatedAt', () => {
  assert.equal(durationSeconds(run()), 120);
});

test('duration is 0 for inverted or unparseable timestamps', () => {
  assert.equal(durationSeconds(run({ updatedAt: '2026-06-01T00:00:00.000Z' })), 0);
  assert.equal(durationSeconds(run({ updatedAt: 'not-a-date' })), 0);
});

test('flavor rates come from the catalog footprint, every flavor priced', () => {
  for (const name of flavorNames()) {
    const rate = flavorRatePerMinute(name);
    assert.ok(rate > 0, `${name} has no rate`);
  }
  assert.equal(flavorRatePerMinute('nope'), undefined);
  // base = 2 vCPU / 4 GB → matches the README reference point (~$0.0044/min).
  assert.ok(Math.abs(flavorRatePerMinute('base') - 0.0044) < 0.0002);
});

test('cost estimate scales with duration; unknown flavor has no estimate', () => {
  // A priced row needs BOTH a known flavor and evidence a microVM ran (`microvmId`).
  const launched = (over = {}) => run({ microvmId: 'mv-1', ...over });
  const two = estimateCostUsd(launched());
  const four = estimateCostUsd(launched({ updatedAt: '2026-07-01T00:04:00.000Z' }));
  assert.ok(four > two);
  assert.equal(estimateCostUsd(launched({ flavor: undefined })), undefined);
});

test('a launched VM whose microvmId stamp failed is still priced', () => {
  // `stampMicrovmId` is best-effort by design (ADR-019): the VM is already up when it runs, and
  // a failed stamp is logged and the launch continues. Requiring `microvmId` as the SOLE proof
  // of compute therefore dropped real, billable runs out of both the per-run figure and the
  // dashboard total — understating spend. A post-launch STATUS is the second signal.
  for (const status of ['running', 'completed']) {
    const stampFailed = run({ status, flavor: 'base', microvmId: undefined });
    assert.ok(estimateCostUsd(stampFailed) > 0, `${status} must still be priced`);
    assert.equal(summarizeCost([stampFailed]).jobs, 1);
  }
  // …but a pre-launch failure still has no evidence and stays unpriced.
  for (const status of ['queued', 'provisioning', 'failed', 'timed_out']) {
    assert.equal(
      estimateCostUsd(run({ status, flavor: 'base', microvmId: undefined })),
      undefined,
      `${status} without a microvmId must not be priced`,
    );
  }
});

test('a run that never launched a microVM is not priced, even with a flavor', () => {
  // Provision stamps the intended `flavor` on a mint/launch FAILURE for support, so flavor is
  // not evidence of compute. Run detail showed "microVM: (not launched)" next to a non-zero
  // estimated cost, billing queue wall-clock for a VM that never existed. `summarizeCost`
  // already gated on `microvmId`; the per-run projection must agree or the dashboard total and
  // the Run detail page disagree about the same job.
  const failedBeforeLaunch = run({ status: 'failed', flavor: 'base', microvmId: undefined });
  assert.equal(estimateCostUsd(failedBeforeLaunch), undefined);
  assert.equal(toRunView(failedBeforeLaunch).costUsd, undefined);
  // …and one that DID launch is still priced.
  assert.ok(toRunView(run({ microvmId: 'mv-7' })).costUsd > 0);
});

test("a running job's estimate advances with now; terminal rows stay pinned to updatedAt", () => {
  // `updatedAt` is only written on a status TRANSITION, so a live row's timestamp is when it
  // reached `running`. Measuring to `updatedAt` froze the estimate there: an hour-old running
  // microVM kept reporting the seconds it took to start, understating live spend.
  const live = run({ status: 'running', microvmId: 'mv-1' });
  const atStart = estimateCostUsd(live, new Date('2026-07-01T00:02:00.000Z'));
  const anHourIn = estimateCostUsd(live, new Date('2026-07-01T01:00:00.000Z'));
  assert.ok(anHourIn > atStart, `${anHourIn} should exceed ${atStart}`);

  // A terminal row is unaffected by `now` — its billing window closed.
  const done = run({ status: 'completed', microvmId: 'mv-1' });
  assert.equal(
    estimateCostUsd(done, new Date('2026-07-01T00:02:00.000Z')),
    estimateCostUsd(done, new Date('2026-07-01T09:00:00.000Z')),
  );

  // Clock skew (now before createdAt) must not invent negative spend.
  assert.ok(estimateCostUsd(live, new Date('2026-06-30T00:00:00.000Z')) >= 0);
});

test('run view exposes only run fields (no jit config, no secrets)', () => {
  const view = toRunView(run({ ttl: 123, someInternal: 'x' }));
  assert.deepEqual(
    Object.keys(view).sort(),
    [
      'costUsd',
      'createdAt',
      'durationSeconds',
      'flavor',
      'installationId',
      'jobId',
      'labels',
      'microvmId',
      'reason',
      'repoFullName',
      'repoId',
      'runId',
      'status',
      'updatedAt',
    ],
  );
});

test('health folds counts, error rate, and stuck runs', () => {
  const now = new Date('2026-07-01T01:00:00.000Z');
  const counts = { queued: 1, provisioning: 0, running: 2, completed: 6, failed: 3, timed_out: 1 };
  const stuckRun = run({ status: 'running', createdAt: '2026-07-01T00:00:00.000Z' });
  const freshRun = run({ status: 'queued', createdAt: '2026-07-01T00:59:30.000Z' });
  const h = buildHealth(counts, [stuckRun, freshRun], now);
  assert.equal(h.active, 3);
  assert.equal(h.errorRate, 0.4); // (3+1)/10
  assert.equal(h.stuck.length, 1);
  assert.equal(h.stuck[0].status, 'running');
  assert.ok(STUCK_AFTER_SECONDS > 0);
});

test('error rate is 0 when nothing is terminal (no divide by zero)', () => {
  const counts = { queued: 2, provisioning: 0, running: 1, completed: 0, failed: 0, timed_out: 0 };
  assert.equal(buildHealth(counts, []).errorRate, 0);
});

test('cost summary prices launched jobs and breaks down per flavor', () => {
  const a = run({ microvmId: 'mv-1' });
  const b = run({ microvmId: 'mv-2', flavor: 'docker' });
  const s = summarizeCost([a, b]);
  assert.equal(s.jobs, 2);
  assert.ok(s.totalUsd > 0);
  assert.equal(s.totalUsd, Math.round((estimateCostUsd(a) + estimateCostUsd(b)) * 1e6) / 1e6);
  assert.deepEqual(Object.keys(s.byFlavor).sort(), ['base', 'docker']);
  assert.equal(s.byFlavor.base.jobs, 1);
  assert.ok(Math.abs(s.avgUsd - s.totalUsd / 2) < 1e-9);
});

test('the cost denominator counts JOBS, not workflow runs (matrix workflow)', () => {
  // Run rows are per-(runId, jobId) (ADR-029), so ONE 3-variant matrix workflow is three
  // rows. The field is named `jobs` because calling it `runs` made the Dashboard print
  // "3 finished runs" for one workflow and divide the total by 3 for a "mean per run" that
  // was really a mean per job. Total spend is unaffected; the denominator was the bug.
  const sameRun = [1, 2, 3].map((j) => run({ runId: 77, jobId: 1000 + j, microvmId: `mv-${j}` }));
  const s = summarizeCost(sameRun);
  assert.equal(s.jobs, 3);
  assert.equal(s.byFlavor.base.jobs, 3);
  assert.ok(Math.abs(s.avgUsd - s.totalUsd / 3) < 1e-9);
  assert.equal(s.runs, undefined, 'the misleading `runs` field must not come back');
});

test('a run that never launched a microVM is not priced, even though it has a flavor', () => {
  // Regression guard: Provision stamps `flavor` on its mint- and launch-failure paths (for
  // support), so a failed run carries a priced flavor while NO VM ever existed. Pricing it
  // billed wall-clock — including the whole queued wait — for compute that never ran, so the
  // dashboard estimate grew every time provisioning broke. `microvmId` is the only evidence
  // a VM existed, so it gates the sample.
  const failedBeforeLaunch = run({
    status: 'failed',
    flavor: 'base',
    microvmId: undefined,
    reason: 'GitHub rejected the runner labels for this job (HTTP 422)',
    updatedAt: '2026-07-01T00:30:00.000Z',
  });
  const s = summarizeCost([failedBeforeLaunch]);
  assert.equal(s.jobs, 0);
  assert.equal(s.totalUsd, 0);
  assert.equal(s.avgUsd, 0);
  assert.deepEqual(s.byFlavor, {});
  // A run that DID launch and then failed is still real spend.
  assert.equal(summarizeCost([{ ...failedBeforeLaunch, microvmId: 'mv-9' }]).jobs, 1);
});

test('an unpriceable flavor is skipped without poisoning the totals', () => {
  const s = summarizeCost([run({ microvmId: 'mv-1', flavor: 'nope' })]);
  assert.equal(s.jobs, 0);
  assert.equal(s.totalUsd, 0);
});

test('health carries a cost summary (empty when no sample was supplied)', () => {
  const counts = { queued: 0, provisioning: 0, running: 0, completed: 1, failed: 0, timed_out: 0 };
  assert.deepEqual(buildHealth(counts, []).cost, {
    jobs: 0,
    totalUsd: 0,
    avgUsd: 0,
    byFlavor: {},
  });
  const withSample = buildHealth(counts, [], new Date(), [run({ microvmId: 'mv-1' })]);
  assert.equal(withSample.cost.jobs, 1);
});

test('runs sort newest-first when merged across status indexes', () => {
  const a = run({ runId: 1, createdAt: '2026-07-01T00:00:00.000Z' });
  const b = run({ runId: 2, createdAt: '2026-07-02T00:00:00.000Z' });
  assert.deepEqual(sortRunsNewestFirst([a, b]).map((r) => r.runId), [2, 1]);
});

test('compat rollup counts workflows by folded level, defaulting to ok', () => {
  const roll = rollupCompat([
    { compat: { level: 'ok', jobs: {} } },
    { compat: { level: 'warn', jobs: {} } },
    { compat: { level: 'block', jobs: {} } },
    {}, // parse failure → no compat → counts as ok
  ]);
  assert.deepEqual(roll, { ok: 2, warn: 1, risk: 0, block: 1 });
});

test('workflow view flattens jobs with routing + compat', () => {
  const view = toWorkflowView({
    repoId: 1,
    path: '.github/workflows/ci.yml',
    name: 'CI',
    updatedAt: '2026-07-01T00:00:00.000Z',
    parsed: {
      path: '.github/workflows/ci.yml',
      name: 'CI',
      on: ['push'],
      jobs: [
        {
          id: 'build',
          name: 'Build',
          runs_on: ['self-hosted', 'lambda-ci-node'],
          container: null,
          services: [],
          uses: null,
          matrix_dims: {},
          step_signals: { needs_docker: false, arch_hints: [], known_actions: [] },
        },
      ],
    },
    compat: {
      level: 'warn',
      jobs: { build: { level: 'warn', eligible: true, messages: [{ level: 'warn', code: 'X', text: 'y' }] } },
    },
    routes: { build: { flavor: 'node', reason: 'explicit label' } },
  });
  assert.equal(view.compatLevel, 'warn');
  assert.equal(view.jobs[0].flavor, 'node');
  assert.equal(view.jobs[0].compat.level, 'warn');
  assert.equal(view.jobs[0].compat.messages[0].code, 'X');
});

// `adoptCandidate` drives a COUNT the console states as fact ("N job(s) … run on arm64
// microVMs") and the operator's decision to flip a repo to adopt mode. It has to agree with the
// two things that actually act on it: `decideClaim` (which refuses ANY job carrying a
// windows/macos label, in every mode) and `rewriteTargets` (which excludes the same jobs). A
// predicate that only asked "hosted label AND no LCA label" counted mixed selectors like
// `[ubuntu-latest, windows-latest]` that adopt mode will never claim.
function jobView(runsOn) {
  return toWorkflowView({
    repoId: 1,
    path: '.github/workflows/ci.yml',
    name: 'CI',
    updatedAt: '2026-07-01T00:00:00.000Z',
    parsed: {
      path: '.github/workflows/ci.yml',
      name: 'CI',
      on: ['push'],
      jobs: [
        {
          id: 'build',
          name: 'Build',
          runs_on: runsOn,
          container: null,
          services: [],
          uses: null,
          matrix_dims: {},
          step_signals: { needs_docker: false, arch_hints: [], known_actions: [] },
        },
      ],
    },
  });
}

test('adopt candidacy matches what the claim gate would actually claim', () => {
  assert.equal(jobView(['ubuntu-latest']).jobs[0].adoptCandidate, true);
  assert.equal(jobView(['ubuntu-latest']).adoptCandidates, 1);
  // Already opted in explicitly — not a candidate.
  assert.equal(jobView(['self-hosted', 'lambda-ci']).jobs[0].adoptCandidate, false);
  // No hosted label at all (someone else's fleet) — not a candidate.
  assert.equal(jobView(['self-hosted', 'gpu']).jobs[0].adoptCandidate, false);
});

test('a mixed hosted selector is NOT an adopt candidate (decideClaim refuses it)', () => {
  for (const runsOn of [
    ['ubuntu-latest', 'windows-latest'],
    ['macos-14', 'ubuntu-22.04'],
  ]) {
    const view = jobView(runsOn);
    // Cross-check against the real gate rather than restating its rule here.
    const decision = decideClaim({ jobLabels: runsOn, claimedLabels: ['lambda-ci'], mode: 'adopt' });
    assert.equal(decision.claim, false, `decideClaim should refuse ${runsOn.join(',')}`);
    assert.equal(
      view.jobs[0].adoptCandidate,
      false,
      `${runsOn.join(',')} must not be advertised as an adopt candidate`,
    );
    assert.equal(view.adoptCandidates, 0);
    // ...and the rewrite planner agrees, so the three surfaces cannot disagree.
    assert.deepEqual(rewriteTargets([{ id: 'build', runs_on: runsOn }]), []);
  }
});

test('workflow view survives a parse failure', () => {
  const view = toWorkflowView({ path: 'x.yml', name: 'x.yml', parseError: 'bad yaml', updatedAt: 'now' });
  assert.deepEqual(view.jobs, []);
  assert.equal(view.parseError, 'bad yaml');
  assert.equal(view.compatLevel, 'ok');
});

test('repo view defaults mode to label and flavorMap to {}', () => {
  const v = toRepoView({
    installationId: 1,
    repoId: 2,
    repoFullName: 'a/b',
    enabled: true,
    createdAt: 'x',
    updatedAt: 'y',
  });
  assert.equal(v.mode, 'label');
  assert.deepEqual(v.flavorMap, {});
});

test('flavor views mark image availability from SSM presence', () => {
  const views = buildFlavorViews({ base: true });
  const base = views.find((f) => f.name === 'base');
  const node = views.find((f) => f.name === 'node');
  assert.equal(base.imageAvailable, true);
  assert.equal(node.imageAvailable, false);
  assert.equal(base.arch, 'arm64');
});

test('secret status carries presence only — never a value', () => {
  const s = toSecretStatus('/lca/dev/github/app-pem', 'PEM', true);
  assert.deepEqual(Object.keys(s).sort(), ['label', 'param', 'present']);
  assert.equal(JSON.stringify(s).includes('BEGIN'), false);
});

// ---- validation ------------------------------------------------------------

test('repo patch accepts the config surface', () => {
  const r = validateRepoPatch({ enabled: false, mode: 'adopt', defaultFlavor: 'node' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { enabled: false, mode: 'adopt', defaultFlavor: 'node' });
});

// M4 review fix: without an explicit clear, a defaultFlavor override would be permanent —
// the validator rejects every non-flavor value, and the store only ever SETs the attribute.
test('repo patch accepts defaultFlavor:null as "clear the override"', () => {
  const r = validateRepoPatch({ defaultFlavor: null });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { defaultFlavor: null });
});

test('repo patch rejects unknown fields (no privilege creep via body)', () => {
  const r = validateRepoPatch({ enabled: true, status: 'completed', microvmId: 'mv-1' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('status')));
  assert.ok(r.errors.some((e) => e.includes('microvmId')));
});

test('repo patch rejects bad types, bad modes, unknown flavors, and empty bodies', () => {
  assert.equal(validateRepoPatch({ enabled: 'yes' }).ok, false);
  assert.equal(validateRepoPatch({ mode: 'whatever' }).ok, false);
  assert.equal(validateRepoPatch({ defaultFlavor: 'gpu' }).ok, false);
  assert.equal(validateRepoPatch({}).ok, false);
  assert.equal(validateRepoPatch(null).ok, false);
  assert.equal(validateRepoPatch([1, 2]).ok, false);
});

test('flavor map requires known flavors', () => {
  const good = validateFlavorMap({ 'ubuntu-latest': 'node' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value, { 'ubuntu-latest': 'node' });
  const bad = validateFlavorMap({ 'ubuntu-latest': 'gigantic' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0].includes('unknown flavor'));
});

test('flavor map rejects empty labels and oversized maps', () => {
  assert.equal(validateFlavorMap({ '  ': 'base' }).ok, false);
  const big = {};
  for (let i = 0; i <= MAX_FLAVOR_MAP_ENTRIES; i++) big[`l${i}`] = 'base';
  assert.equal(validateFlavorMap(big).ok, false);
});

test('limit parsing clamps and falls back', () => {
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit('99999'), 200);
  assert.equal(parseLimit('abc'), 50);
  assert.equal(parseLimit('0'), 50);
});
