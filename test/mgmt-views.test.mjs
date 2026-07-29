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
  rollupCompat,
  toWorkflowView,
  toRepoView,
  buildFlavorViews,
  flavorNames,
  sortRunsNewestFirst,
  toSecretStatus,
  STUCK_AFTER_SECONDS,
} from '../dist/src/mgmt/views.js';
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
  const two = estimateCostUsd(run());
  const four = estimateCostUsd(run({ updatedAt: '2026-07-01T00:04:00.000Z' }));
  assert.ok(four > two);
  assert.equal(estimateCostUsd(run({ flavor: undefined })), undefined);
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

test('GET /api/flavors surfaces every standard flavor with a rate + availability', () => {
  // Acceptance criterion for the expanded standard set (ADR-031): each new flavor must be
  // listed, priced, and reported as built once its image ARN is published to SSM.
  const expected = ['base', 'node', 'python', 'java', 'go', 'rust', 'docker'];
  const available = Object.fromEntries(expected.map((n) => [n, true]));
  const views = buildFlavorViews(available);
  assert.deepEqual(
    views.map((v) => v.name).sort(),
    [...expected].sort(),
    'catalog and expected standard set disagree',
  );
  for (const v of views) {
    assert.equal(v.imageAvailable, true, `${v.name} should report built`);
    assert.equal(v.arch, 'arm64', `${v.name} must be arm64`);
    assert.ok(v.usdPerMinute > 0, `${v.name} must be priced`);
    assert.ok(v.label.startsWith('lambda-ci'), `${v.name} label`);
    assert.ok(v.description.length > 0, `${v.name} needs an operator-facing description`);
  }
});

test('a flavor with no published image ARN reports not-built', () => {
  // The Flavors screen must distinguish "in the catalog" from "actually buildable" — a new
  // standard flavor is present in code before its image exists in an environment.
  const views = buildFlavorViews({});
  for (const v of views) assert.equal(v.imageAvailable, false, v.name);
});

test('flavorNames covers the expanded catalog so config writes accept the new flavors', () => {
  // validateFlavorMap / validateRepoPatch gate on this list; a missing name means the console
  // rejects a legitimate flavor choice.
  const names = flavorNames();
  for (const n of ['python', 'java', 'go', 'rust']) {
    assert.ok(names.includes(n), `flavorNames() is missing ${n}`);
  }
});

test('the java and rust flavors are priced above base (bigger memory footprint)', () => {
  // Sanity-check the derived rate actually tracks the catalog shape rather than a constant.
  assert.ok(flavorRatePerMinute('java') > flavorRatePerMinute('base'));
  assert.ok(flavorRatePerMinute('rust') > flavorRatePerMinute('base'));
  assert.equal(flavorRatePerMinute('python'), flavorRatePerMinute('base'));
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
