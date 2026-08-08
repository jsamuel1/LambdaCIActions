// Refusal classification + store + console read models (ADR-049), and the live control-plane
// reconciliation that kills the misleading green (ADR-050).
//
// Why this file exists: the bug it pins was INVISIBLE. Ingest computed a refusal reason, returned
// it in a 202 body GitHub discards, and logged nothing — so `test/adopt.test.mjs` could pass
// (`decideClaim` was correct!) while eight PRs sat queued for 7 h with no error anywhere. Every
// test here is therefore about the OBSERVABILITY of a decision, not the decision itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyRefusal,
  lcaShapedLabel,
  lcaShapedLabels,
} from '../dist/src/ingest/refusal.js';
import {
  buildRefusalUpsert,
  refusalPk,
  refusalRepoGsi2pk,
  REFUSALS_GSI1PK,
  REFUSAL_SK,
} from '../dist/src/shared/refusal-store.js';
import {
  reconcileFlavors,
  readinessFor,
  unmatchedAllowlistLabels,
  worstState,
} from '../dist/src/shared/flavor-readiness.js';
import { allowlistChanged } from '../dist/src/shared/allowlist.js';
import {
  countUnrunnableJobs,
  rollupRefusals,
  routeReadiness,
  sortRefusalsNewestFirst,
  toRefusalView,
  toWorkflowViewWithReadiness,
} from '../dist/src/mgmt/refusal-views.js';
import { statusGsiKeys, repoGsiKeys } from '../dist/src/shared/run-store.js';
import { ALL_STATUSES, ACTIVE_STATUSES, buildFlavorViews } from '../dist/src/mgmt/views.js';
import { ROUTES } from '../dist/src/mgmt/router.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'microvm', 'flavors.json'), 'utf8'),
).flavors;

/** The live dev allowlist as it actually was when the bug was observed. */
const DEV_ALLOWLIST = ['lambda-ci', 'lambda-ci-node', 'lambda-ci-docker'];

// ---- classification --------------------------------------------------------

test('every catalog label is LCA-shaped, and the prefix invariant holds', () => {
  // The `lambda-ci` prefix is written as a literal in refusal.ts because the heuristic rests on
  // it. If a catalog flavor ever stops sharing it, that heuristic silently narrows — so the
  // invariant is pinned here rather than left to a comment.
  for (const f of CATALOG) {
    assert.ok(lcaShapedLabel(f.label), `${f.label} is not LCA-shaped`);
    assert.ok(
      f.label === 'lambda-ci' || f.label.startsWith('lambda-ci-'),
      `${f.label} does not share the lambda-ci prefix the refusal heuristic assumes`,
    );
  }
});

test('LCA-shaped covers catalog labels, prefixed typos, and nothing else', () => {
  assert.ok(lcaShapedLabel('lambda-ci-python'));
  assert.ok(lcaShapedLabel('LAMBDA-CI-NODE'), 'matching is case-insensitive like GitHub labels');
  assert.ok(lcaShapedLabel('lambda-ci-pyton'), 'a typo of a catalog label still signals intent');
  assert.ok(!lcaShapedLabel('self-hosted'), 'self-hosted alone targets any fleet');
  assert.ok(!lcaShapedLabel('ubuntu-latest'));
  assert.ok(!lcaShapedLabel('gpu'));
  assert.ok(!lcaShapedLabel('lambda-cirrus'), 'prefix match requires the hyphen boundary');
  assert.ok(!lcaShapedLabel(''));
});

test('lcaShapedLabels de-dupes, lower-cases and preserves first-seen order', () => {
  assert.deepEqual(
    lcaShapedLabels(['self-hosted', 'LAMBDA-CI-Python', ' lambda-ci ', 'lambda-ci-python']),
    ['lambda-ci-python', 'lambda-ci'],
  );
});

test('THE BUG: an lambda-ci* label missing from the live allowlist is actionable and info-level', () => {
  const cls = classifyRefusal({
    gate: 'claim',
    jobLabels: ['self-hosted', 'lambda-ci-python'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
    reason: 'no LCA label (repo is in label mode)',
  });
  assert.equal(cls.code, 'label-not-allowlisted');
  assert.equal(cls.level, 'info');
  assert.equal(cls.actionable, true);
  assert.deepEqual(cls.lcaLabels, ['lambda-ci-python']);
  assert.match(cls.fix, /lambda-ci-python/);
  assert.match(cls.fix, /runner-labels/);
});

test('an ordinary no-LCA-label refusal is NOT actionable — this is the noise lane', () => {
  const label = classifyRefusal({
    gate: 'claim',
    jobLabels: ['ubuntu-latest'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
    reason: 'no LCA label (repo is in label mode)',
  });
  assert.equal(label.code, 'no-lca-label');
  assert.equal(label.level, 'debug');
  assert.equal(label.actionable, false);
  assert.equal(label.fix, undefined);

  // adopt mode's own miss (`[self-hosted, gpu]` — someone else's fleet) is equally expected.
  const adopt = classifyRefusal({
    gate: 'claim',
    jobLabels: ['self-hosted', 'gpu'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'adopt',
    reason: 'adopt mode: no standard GitHub-hosted label on the job',
  });
  assert.equal(adopt.code, 'no-standard-label');
  assert.equal(adopt.actionable, false);
});

test('the allowlist-miss and the no-label miss are distinguishable — the whole point of the split', () => {
  const miss = classifyRefusal({
    gate: 'claim',
    jobLabels: ['self-hosted', 'lambda-ci-python'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
  });
  const noise = classifyRefusal({
    gate: 'claim',
    jobLabels: ['self-hosted'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
  });
  assert.notEqual(miss.code, noise.code);
  assert.notEqual(miss.actionable, noise.actionable);
  assert.notEqual(miss.level, noise.level);
});

test('an allowlisted label is never classified as a miss (case-insensitively)', () => {
  const cls = classifyRefusal({
    gate: 'compat-block',
    jobLabels: ['self-hosted', 'LAMBDA-CI'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
  });
  // Reached the compat gate, so the claim already succeeded — the code must be the gate's, not a
  // spurious allowlist complaint about a label that IS allowlisted.
  assert.equal(cls.code, 'compat-block');
});

test('incompatible labels are noise alone, actionable when the job ALSO asked for us by name', () => {
  const matrix = classifyRefusal({
    gate: 'claim',
    jobLabels: ['windows-latest'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'adopt',
  });
  assert.equal(matrix.code, 'incompatible-label');
  assert.equal(matrix.actionable, false, 'a cross-platform matrix leg is normal, not an error');

  const mistake = classifyRefusal({
    gate: 'claim',
    jobLabels: ['x64', 'lambda-ci'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
  });
  assert.equal(mistake.code, 'incompatible-label');
  assert.equal(mistake.actionable, true);
  assert.match(mistake.fix, /arm64 Linux only/);
});

test('incompatible-label wins over the allowlist miss, matching decideClaim precedence', () => {
  // decideClaim refuses the non-Linux label FIRST, in every mode. The classification must agree,
  // or the console would tell the operator to allowlist a label that would still be refused.
  const cls = classifyRefusal({
    gate: 'claim',
    jobLabels: ['windows-latest', 'lambda-ci-python'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
  });
  assert.equal(cls.code, 'incompatible-label');
});

test('repo-disabled is surfaced only when the job carries an LCA label', () => {
  const labelled = classifyRefusal({
    gate: 'repo-disabled',
    jobLabels: ['self-hosted', 'lambda-ci'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'off',
  });
  assert.equal(labelled.actionable, true, 'a labelled job in an off repo is a contradiction');
  const unlabelled = classifyRefusal({
    gate: 'repo-disabled',
    jobLabels: ['ubuntu-latest'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'off',
  });
  assert.equal(unlabelled.actionable, false, 'that is exactly what "off" should look like');
});

test('runner-group and compat-block are always actionable — both are post-claim gates', () => {
  for (const gate of ['runner-group', 'compat-block']) {
    const cls = classifyRefusal({
      gate,
      jobLabels: ['self-hosted', 'lambda-ci'],
      claimedLabels: DEV_ALLOWLIST,
      mode: 'label',
      group: gate === 'runner-group' ? 'big-runners' : undefined,
    });
    assert.equal(cls.actionable, true, gate);
    assert.equal(cls.level, 'info', gate);
    assert.ok(cls.fix, `${gate} must carry a fix`);
  }
});

test('classification does not read decideClaim prose — reason is diagnostic only', () => {
  // Same labels, wildly different reason strings, identical classification: the codes survive a
  // reword of the operator-facing text, which is what made a prose-matching classifier unsafe.
  const a = classifyRefusal({
    gate: 'claim',
    jobLabels: ['lambda-ci-go'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
    reason: 'no LCA label (repo is in label mode)',
  });
  const b = classifyRefusal({
    gate: 'claim',
    jobLabels: ['lambda-ci-go'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
    reason: 'totally reworded refusal text',
  });
  assert.deepEqual(a, b);
});

// ---- store shape -----------------------------------------------------------

function upsertInput(over = {}) {
  return {
    repoId: 1326532617,
    repoFullName: 'jsamuel1/SauhsojVideo',
    installationId: 146431062,
    runId: 900,
    jobId: 901,
    code: 'label-not-allowlisted',
    reason: 'no LCA label (repo is in label mode)',
    fix: 'add lambda-ci-python to the allowlist',
    labels: ['self-hosted', 'lambda-ci-python'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
    workflowName: 'check',
    jobName: 'lint',
    ...over,
  };
}

test('a refusal row lives in partitions no run query can reach', () => {
  const up = buildRefusalUpsert(upsertInput(), new Date('2026-08-07T10:00:00.000Z'));
  assert.equal(up.key.pk, refusalPk(1326532617, 900, 901));
  assert.equal(up.key.sk, REFUSAL_SK);
  assert.equal(up.values[':g1pk'], REFUSALS_GSI1PK);
  assert.equal(up.values[':g2pk'], refusalRepoGsi2pk(1326532617));
  // The load-bearing isolation claim of ADR-049: refusals share GSI1/GSI2 with run rows, so their
  // partition VALUES must be disjoint or a status/repo run query would start returning refusals
  // (and vice versa) — which is precisely the aggregate corruption the card forbids.
  for (const status of ALL_STATUSES) {
    assert.notEqual(statusGsiKeys(status, 'x').gsi1pk, REFUSALS_GSI1PK);
  }
  assert.notEqual(repoGsiKeys(1326532617, 'x').gsi2pk, refusalRepoGsi2pk(1326532617));
  assert.notEqual(up.key.pk, `RUN#1326532617#900#901`);
});

test('a recurring refusal RISES in both indexes, and remembers when it started', () => {
  const up = buildRefusalUpsert(upsertInput());
  // Both sort keys track lastSeenAt. Keying them on firstSeenAt sank a refusal that started hours
  // ago and is still firing below the head page, where no client-side sort could recover it.
  assert.match(up.updateExpression, /gsi1sk = :now/);
  assert.match(up.updateExpression, /gsi2sk = :now/);
  assert.ok(
    !/gsi1sk = if_not_exists|gsi2sk = if_not_exists/.test(up.updateExpression),
    'a sort key pinned to first sight makes a live problem unreachable',
  );
  // …while `firstSeenAt` stays write-once, so "broken for 7 hours" survives every re-delivery.
  assert.match(up.updateExpression, /firstSeenAt = if_not_exists\(firstSeenAt, :now\)/);
  assert.match(up.updateExpression, /lastSeenAt = :now/);
  assert.match(up.updateExpression, /ADD occurrences :one$/);
  assert.equal(up.values[':one'], 1);
});

test('both refusal indexes sort on the SAME clock', () => {
  // Different sort semantics per index would make the same list reorder itself when a repo filter
  // was applied — worse than either ordering on its own.
  const up = buildRefusalUpsert(upsertInput(), new Date('2026-08-07T10:00:00.000Z'));
  const sortValue = up.values[':now'];
  assert.equal(sortValue, '2026-08-07T10:00:00.000Z');
  for (const key of ['gsi1sk', 'gsi2sk', 'lastSeenAt']) {
    assert.match(up.updateExpression, new RegExp(`${key} = :now`), key);
  }
});

test('reserved words are aliased and the live allowlist snapshot is stored', () => {
  const up = buildRefusalUpsert(upsertInput());
  // `labels`, `mode` and `ttl` are DynamoDB reserved words — an unaliased SET is a runtime
  // ValidationException, invisible to a typecheck.
  assert.equal(up.names['#labels'], 'labels');
  assert.equal(up.names['#mode'], 'mode');
  assert.equal(up.names['#ttl'], 'ttl');
  assert.ok(!/[^#a-zA-Z]labels = /.test(up.updateExpression), 'labels must be aliased');
  assert.deepEqual(up.values[':claimedLabels'], DEV_ALLOWLIST);
  assert.ok(typeof up.values[':ttl'] === 'number' && up.values[':ttl'] > 0);
});

test('absent optional fields are omitted, never written as undefined or empty', () => {
  const up = buildRefusalUpsert(
    upsertInput({ fix: undefined, workflowName: undefined, jobName: '', runnerGroup: undefined }),
  );
  for (const attr of ['fix', 'workflowName', 'jobName', 'runnerGroup']) {
    assert.ok(!(`:${attr}` in up.values), `${attr} must be omitted`);
    assert.ok(!up.updateExpression.includes(`${attr} = :`), `${attr} must not be SET`);
  }
});

// ---- console read models ---------------------------------------------------

function refusalRecord(over = {}) {
  return {
    repoId: 1326532617,
    repoFullName: 'jsamuel1/SauhsojVideo',
    installationId: 146431062,
    runId: 900,
    jobId: 901,
    code: 'label-not-allowlisted',
    reason: 'no LCA label (repo is in label mode)',
    labels: ['self-hosted', 'lambda-ci-python'],
    claimedLabels: DEV_ALLOWLIST,
    mode: 'label',
    firstSeenAt: '2026-08-07T03:00:00.000Z',
    lastSeenAt: '2026-08-07T10:00:00.000Z',
    occurrences: 8,
    ...over,
  };
}

test('a refusal view carries the GitHub deep link and defaults occurrences to 1', () => {
  const v = toRefusalView(refusalRecord());
  assert.equal(v.githubUrl, 'https://github.com/jsamuel1/SauhsojVideo/actions/runs/900');
  assert.equal(v.occurrences, 8);
  // A row written before the counter existed must not read as "never occurred" — the row only
  // exists because a refusal happened.
  assert.equal(toRefusalView(refusalRecord({ occurrences: undefined })).occurrences, 1);
});

test('refusals sort by MOST RECENT occurrence, so a recurring one cannot sink', () => {
  const old = refusalRecord({ jobId: 1, lastSeenAt: '2026-08-07T01:00:00.000Z' });
  const recent = refusalRecord({ jobId: 2, lastSeenAt: '2026-08-07T11:00:00.000Z' });
  assert.deepEqual(
    sortRefusalsNewestFirst([old, recent]).map((r) => r.jobId),
    [2, 1],
  );
});

test('rollupRefusals counts by code', () => {
  const roll = rollupRefusals(
    [refusalRecord(), refusalRecord({ jobId: 2 }), refusalRecord({ jobId: 3, code: 'runner-group' })].map(
      toRefusalView,
    ),
  );
  assert.deepEqual(roll, { 'label-not-allowlisted': 2, 'runner-group': 1 });
});

// ---- live reconciliation (ADR-050) ----------------------------------------

const READINESS_CATALOG = CATALOG.map((f) => ({ name: f.name, label: f.label }));

test('THE MISLEADING GREEN: the live dev state renders python unroutable, not ready', () => {
  // Exactly what was deployed: base/node/docker allowlisted and built, python neither.
  const readiness = reconcileFlavors(READINESS_CATALOG, {
    allowlist: DEV_ALLOWLIST,
    imagePublished: { base: true, node: true, docker: true },
    live: true,
  });
  const python = readinessFor(readiness, 'python');
  assert.equal(python.state, 'unroutable');
  assert.equal(python.runnable, false);
  assert.match(python.problem, /allowlist/);
  assert.match(python.fix, /runner-labels/);
  assert.equal(readinessFor(readiness, 'base').state, 'ready');
  assert.equal(readinessFor(readiness, 'base').runnable, true);
});

test('the four-way matrix is named, not collapsed', () => {
  const one = (allowlist, imagePublished) =>
    reconcileFlavors([{ name: 'python', label: 'lambda-ci-python' }], {
      allowlist,
      imagePublished,
      live: true,
    })[0];
  assert.equal(one([], {}).state, 'unroutable', 'label absent + image absent');
  assert.equal(one([], { python: true }).state, 'unclaimable', 'label absent + image present');
  assert.equal(one(['lambda-ci-python'], {}).state, 'imageMissing', 'label present + image absent');
  assert.equal(one(['lambda-ci-python'], { python: true }).state, 'ready', 'both present');
  // Only `ready` is runnable — an `unclaimable` flavor has capacity nothing can select.
  assert.deepEqual(
    [one([], {}), one([], { python: true }), one(['lambda-ci-python'], {})].map((r) => r.runnable),
    [false, false, false],
  );
});

test('allowlist matching is case-insensitive, like the claim gate itself', () => {
  const r = reconcileFlavors([{ name: 'node', label: 'lambda-ci-node' }], {
    allowlist: ['LAMBDA-CI-NODE'],
    imagePublished: { node: true },
    live: true,
  })[0];
  assert.equal(r.state, 'ready', 'a differently-cased allowlist entry does claim the job');
});

test('unmatched allowlist entries are reported, not treated as errors', () => {
  const extra = unmatchedAllowlistLabels(READINESS_CATALOG, [
    'lambda-ci',
    'ubuntu-latest',
    'lambda-ci-pyton',
    'LAMBDA-CI',
  ]);
  assert.ok(extra.includes('ubuntu-latest'), 'adopt-mode labels legitimately live here');
  assert.ok(extra.includes('lambda-ci-pyton'), 'a typo must be visible to the operator');
  assert.ok(!extra.includes('lambda-ci'), 'a real catalog label is matched');
  assert.equal(extra.filter((l) => l === 'lambda-ci').length, 0);
});

test('worstState folds worst-first and is ready on an empty set', () => {
  assert.equal(worstState([]), 'ready');
  assert.equal(worstState(['ready', 'imageMissing']), 'imageMissing');
  assert.equal(worstState(['unroutable', 'imageMissing', 'ready']), 'unroutable');
  assert.equal(worstState(['unclaimable', 'imageMissing']), 'unclaimable');
});

test('a failed live read is `unknown` — never green, never a false alarm', () => {
  assert.equal(routeReadiness('python', undefined).state, 'unknown');
  assert.equal(routeReadiness('python', undefined).runnable, false);
  // No resolved flavor at all is also unknown, not ready.
  assert.equal(routeReadiness(undefined, []).state, 'unknown');
  // A flavor that is not in this deployment's catalog is unknown WITH guidance.
  const gone = routeReadiness('atlantis', []);
  assert.equal(gone.state, 'unknown');
  assert.match(gone.problem, /catalog/);
});

function analysis(over = {}) {
  return {
    repoId: 1326532617,
    installationId: 146431062,
    repoFullName: 'jsamuel1/SauhsojVideo',
    path: '.github/workflows/check.yml',
    name: 'check',
    parsed: {
      path: '.github/workflows/check.yml',
      name: 'check',
      on: ['push'],
      jobs: [
        {
          id: 'offline',
          name: null,
          runs_on: ['self-hosted', 'lambda-ci-python'],
          runner_group: null,
          container: null,
          services: [],
          uses: null,
          matrix_dims: {},
          step_signals: { needs_docker: false, arch_hints: [], known_actions: [] },
        },
      ],
    },
    compat: { level: 'ok', jobs: { offline: { level: 'ok', eligible: true, messages: [] } } },
    routes: { offline: { flavor: 'python', reason: "explicit LCA label 'lambda-ci-python'" } },
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...over,
  };
}

test('a compat-ok job routing to an unrunnable flavor surfaces non-ok on the platform axis', () => {
  const readiness = reconcileFlavors(READINESS_CATALOG, {
    allowlist: DEV_ALLOWLIST,
    imagePublished: { base: true, node: true, docker: true },
    live: true,
  });
  const view = toWorkflowViewWithReadiness(analysis(), readiness);
  // The stored analysis is untouched-green: that is the whole failure mode.
  assert.equal(view.compatLevel, 'ok');
  assert.equal(view.jobs[0].compat.level, 'ok');
  // …and the platform axis is where the truth shows up.
  assert.equal(view.jobs[0].platform.state, 'unroutable');
  assert.equal(view.jobs[0].platform.runnable, false);
  assert.equal(view.platformLevel, 'unroutable');
  assert.equal(countUnrunnableJobs([view]), 1);
});

test('platform readiness does not leak into compat messages or the compat level', () => {
  const readiness = reconcileFlavors(READINESS_CATALOG, {
    allowlist: DEV_ALLOWLIST,
    imagePublished: {},
    live: true,
  });
  const view = toWorkflowViewWithReadiness(analysis(), readiness);
  assert.deepEqual(view.jobs[0].compat.messages, [], 'compat findings must stay compat findings');
  assert.equal(view.compatLevel, 'ok', 'publishing an image must not move rollupCompat counts');
});

test('an unknown platform verdict is not counted as unrunnable', () => {
  const view = toWorkflowViewWithReadiness(analysis(), undefined);
  assert.equal(view.jobs[0].platform.state, 'unknown');
  assert.equal(view.platformLevel, 'unknown');
  assert.equal(countUnrunnableJobs([view]), 0, 'a transient SSM failure must not light the badge');
});

test('a fully-ready control plane leaves every job runnable', () => {
  const readiness = reconcileFlavors(READINESS_CATALOG, {
    allowlist: CATALOG.map((f) => f.label),
    imagePublished: Object.fromEntries(CATALOG.map((f) => [f.name, true])),
    live: true,
  });
  const view = toWorkflowViewWithReadiness(analysis(), readiness);
  assert.equal(view.jobs[0].platform.state, 'ready');
  assert.equal(view.platformLevel, 'ready');
  assert.equal(countUnrunnableJobs([view]), 0);
});

test('readiness covers every catalog flavor the Flavors view lists', () => {
  // A flavor present in one surface and missing from the other is how a reconciliation view lies.
  const shown = buildFlavorViews({}).map((f) => f.name).sort();
  const reconciled = reconcileFlavors(READINESS_CATALOG, {
    allowlist: [],
    imagePublished: {},
    live: true,
  })
    .map((r) => r.flavor)
    .sort();
  assert.deepEqual(reconciled, shown);
});

// ---- aggregate safety ------------------------------------------------------

test('no refusal status was added to the run status vocabulary', () => {
  // ADR-049's central decision. If a refusal ever becomes a RunStatus, it must be a deliberate
  // change that audits cost eligibility, the health error rate and the report status filters —
  // not an accident that silently makes refusals billable.
  for (const forbidden of ['unclaimed', 'refused', 'rejected']) {
    assert.ok(!ALL_STATUSES.includes(forbidden), `${forbidden} must not be a RunStatus`);
    assert.ok(!ACTIVE_STATUSES.includes(forbidden));
  }
  assert.deepEqual([...ALL_STATUSES], [
    'queued',
    'provisioning',
    'running',
    'completed',
    'failed',
    'timed_out',
  ]);
});

test('unclaimed jobs are their own authenticated collection, not a runs filter', () => {
  const route = ROUTES.find((r) => r.id === 'listRefusals');
  assert.ok(route, 'the /api/unclaimed route must exist');
  assert.equal(route.method, 'GET');
  assert.equal(route.template, '/api/unclaimed');
  assert.equal(route.authRequired, true);
  assert.notEqual(route.template, '/api/runs', 'a refusal is not a run');
});

// ---------------------------------------------------------------------------------------
// Wiring pins (source-level, the repo's existing pattern — see test/mgmt-logs.test.mjs).
//
// Everything above tests pure modules with arguments the TEST supplies. That is precisely the
// blind spot that let this defect ship: `decideClaim` was correct and fully unit-tested, and the
// bug was entirely in what the CALL SITE did with its answer (nothing). A classification module
// nobody calls is worth exactly as much as the discarded 202 body it replaces.
// ---------------------------------------------------------------------------------------

const src = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

/** Strip line comments so a doc comment describing a requirement cannot satisfy an assertion. */
function stripComments(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

test('the comment stripper actually removes prose (guard on the guard)', () => {
  const stripped = stripComments(['// await refuse("claim", x);', 'await realCall();'].join('\n'));
  assert.ok(!stripped.includes('refuse('), 'commented code must not satisfy a behaviour assertion');
  assert.ok(stripped.includes('realCall()'));
});

test('EVERY claim-refusal branch in ingest calls the refusal emitter', () => {
  const handler = stripComments(src('src/ingest/handler.ts'));
  const job = handler.slice(
    handler.indexOf('async function handleWorkflowJob('),
    handler.indexOf('async function handleStatusUpdate('),
  );
  assert.ok(job.length > 0, 'handleWorkflowJob not found — update this test');

  // The four gates, each with the emitter call that makes it visible.
  for (const gate of ['repo-disabled', 'claim', 'runner-group', 'compat-block']) {
    assert.match(
      job,
      new RegExp(`refuse\\(\\s*'${gate}'`),
      `the ${gate} gate does not go through refuse() — its refusal would be invisible`,
    );
  }

  // The original defect, pinned precisely: `!decision.claim` returning without emitting.
  const claimGate = job.slice(job.indexOf('if (!decision.claim)'), job.indexOf('// Compat gate'));
  assert.ok(claimGate.length > 0, 'the decideClaim refusal branch moved — update this test');
  assert.match(claimGate, /await refuse\('claim', decision\.reason\)/);

  // No refusal path may return `claimed: false` without having emitted first. Counting is the
  // cheap invariant: one emitter call per `claimed: false` return in this function.
  const returns = job.match(/claimed:\s*false/g) ?? [];
  const emits = job.match(/await refuse\(/g) ?? [];
  // `ignored: wf.action` (a non-queued action) is a `claimed: false` that is NOT a refusal —
  // there is no claim decision to explain — so it is the single permitted excess.
  assert.equal(
    emits.length,
    returns.length - 1,
    `every claimed:false refusal must emit (found ${returns.length} returns, ${emits.length} emits)`,
  );
});

test('no refusal emit sits inside a fail-open try, where a throw would invert its gate', () => {
  const handler = stripComments(src('src/ingest/handler.ts'));
  const job = handler.slice(
    handler.indexOf('async function handleWorkflowJob('),
    handler.indexOf('async function handleStatusUpdate('),
  );
  assert.ok(job.length > 0, 'handleWorkflowJob not found — update this test');

  // Both remaining gates read state inside a try whose catch FAILS OPEN (a lookup fault must not
  // stop a labelled job). An `await refuse(...)` + `return` inside that try is therefore unsafe:
  // any throw from the emitter is swallowed as "lookup failed" and execution falls through to the
  // claim, so the observability fix would silently invert the gate it is reporting on — a disabled
  // repo's labelled job claimed, a non-default runner group claimed and stranded. The emit must
  // come AFTER the catch, driven by a flag the try set.
  for (const [gate, catchMarker] of [
    ['repo-disabled', "msg: 'repo config lookup failed"],
    ['runner-group', "msg: 'compat gate lookup failed"],
    ['compat-block', "msg: 'compat gate lookup failed"],
  ]) {
    const catchAt = job.indexOf(catchMarker);
    assert.ok(catchAt > 0, `fail-open catch for ${gate} not found — update this test`);
    const emitAt = job.search(new RegExp(`refuse\\(\\s*'${gate}'`));
    assert.ok(emitAt > 0, `${gate} does not emit a refusal at all`);
    assert.ok(
      emitAt > catchAt,
      `refuse('${gate}') is inside the fail-open try — a throw there would be caught as a ` +
        'lookup failure and the job would be claimed anyway',
    );
  }
});

test('the emitter logs unconditionally and stores only actionable refusals', () => {
  const handler = stripComments(src('src/ingest/handler.ts'));
  const emitter = handler.slice(
    handler.indexOf('async function refuse('),
    handler.indexOf('// Repo config gate FIRST'),
  );
  assert.ok(emitter.length > 0, 'refuse() not found — update this test');
  // The log line comes BEFORE the actionable gate, or the noise lane would be silent again.
  const logAt = emitter.indexOf('console.log(JSON.stringify(line))');
  const gateAt = emitter.indexOf('if (!cls.actionable) return');
  assert.ok(logAt > 0 && gateAt > logAt, 'the actionable gate must not skip the log line');
  // The diagnosis needs BOTH halves: what the job asked for and what the allowlist held.
  assert.match(emitter, /jobLabels,/);
  assert.match(emitter, /claimedLabels,/);
  assert.match(emitter, /recordRefusal\(/);
  // A store failure must not fail the webhook — GitHub would retry a final decision.
  assert.match(emitter, /catch \(err\)/);
});

test('mgmt reconciles workflows and flavors against the live control plane', () => {
  const handler = stripComments(src('src/mgmt/handler.ts'));
  const workflows = handler.slice(
    handler.indexOf("case 'listWorkflows':"),
    handler.indexOf("case 'rescanRepo':"),
  );
  assert.ok(workflows.length > 0, 'listWorkflows case not found — update this test');
  // Reading the catalog alone is the bug: `toWorkflowView` without readiness renders the same
  // misleading green the console showed while eight PRs sat queued.
  assert.match(workflows, /flavorReadinessOrUndefined\(\)/);
  assert.match(workflows, /toWorkflowViewWithReadiness\(a, readiness\)/);
  assert.match(workflows, /controlPlaneLive/);

  const flavors = handler.slice(
    handler.indexOf("case 'listFlavors':"),
    handler.indexOf("case 'health':"),
  );
  assert.match(flavors, /reconcileFlavors\(/);
  assert.match(flavors, /allowlist/);
});

test('mgmt reads the allowlist VALUE live, and only that one non-secret parameter', () => {
  const handler = stripComments(src('src/mgmt/handler.ts'));
  const snapshot = handler.slice(
    handler.indexOf('async function controlPlaneSnapshot('),
    handler.indexOf('async function flavorReadinessOrUndefined('),
  );
  assert.ok(snapshot.length > 0, 'controlPlaneSnapshot not found — update this test');
  const allowlist = handler.slice(
    handler.indexOf('async function allowlistSnapshot('),
    handler.indexOf('async function controlPlaneSnapshot('),
  );
  assert.match(allowlist, /getParam\(`\$\{SSM_PREFIX\}\/config\/runner-labels`\)/);
  assert.match(allowlist, /live: false/, 'the allowlist read must fail soft too');
  // The Unclaimed route renders no image state, so it must not pay a DescribeParameters per
  // catalog flavor on every page load.
  const unclaimed = handler.slice(
    handler.indexOf('async function listRefusalsRoute('),
    handler.indexOf('// ---- authorization helpers'),
  );
  assert.ok(unclaimed.length > 0, 'listRefusalsRoute not found — update this test');
  assert.match(unclaimed, /await allowlistSnapshot\(\)/);
  assert.ok(
    !unclaimed.includes('controlPlaneSnapshot('),
    'the unclaimed route must not probe image availability it does not render',
  );
  // Fail SOFT: a read error must yield `live: false`, not a page of false alarms.
  assert.match(snapshot, /live: false/);

  // Presence-only probing must remain the rule for every OTHER parameter (spec 04 hard rule).
  const getParamCalls = handler.match(/getParam\(/g) ?? [];
  const secretPaths = handler.match(/getParam\(`\$\{SSM_PREFIX\}\/github\//g) ?? [];
  assert.deepEqual(secretPaths, [], 'no GitHub App secret may be READ by the management plane');
  assert.ok(getParamCalls.length > 0);

  // …and IAM must actually allow the one path the code reads, or the console 500s in deploy.
  const iam = stripComments(src('lib/mgmt-stack.ts'));
  const grant = iam.slice(iam.indexOf("sid: 'ReadOwnAuthSecrets'"), iam.indexOf("sid: 'DescribeParamPresence'"));
  assert.match(grant, /config\/runner-labels/);
  assert.ok(!grant.includes('app-pem'), 'the App private key must never be readable here');
});

test('older refusals past the head page are reachable from the console', () => {
  const screen = stripComments(src('web/src/screens/Unclaimed.tsx'));
  // Rows exist in the store and would be unreachable from the console without this — the same
  // invisibility the screen exists to end.
  assert.match(screen, /Load older/);
  assert.match(screen, /api\.unclaimed\(\{ repo: repoFilter, limit: PAGE, cursor: nextCursor \}\)/);
  // A recurring refusal's sort key moves, so a held older row can reappear on the polled head page.
  assert.match(screen, /function dedupe\(/);
  // An in-flight page must not be applied to a different repo filter.
  assert.match(screen, /filterRef\.current !== requestedFor/);
});

test('the console exposes Unclaimed as its own destination', () => {
  const main = stripComments(src('web/src/main.tsx'));
  // A refused job is by definition absent from the run list, so it must be reachable without the
  // operator already knowing where to look.
  assert.match(main, /path: '\/unclaimed'/);
  assert.match(main, /case 'unclaimed':/);
  const dash = stripComments(src('web/src/screens/Dashboard.tsx'));
  assert.match(dash, /label=\{[\s\S]*unclaimedWindowDays/, 'the stat must name its window');
  // The count must not be folded into a run aggregate.
  assert.ok(!/active.*unclaimed|unclaimed.*errorRate/.test(dash));
});

test('the dashboard badge is windowed, and says so instead of claiming the present tense', () => {
  // A refusal row survives the full ADR-033 retention (90 days by default). An unwindowed count
  // therefore stays non-zero for months after the operator fixed the allowlist, and a headline that
  // can never return to zero is one operators stop reading.
  const mgmt = stripComments(src('src/mgmt/handler.ts'));
  const health = mgmt.slice(
    mgmt.indexOf('async function healthRoute('),
    mgmt.indexOf('// ---- reports'),
  );
  assert.ok(health.length > 0, 'healthRoute not found — update this test');
  assert.match(health, /countRefusals\(\{ sinceIso: since \}\)/, 'the badge count must be windowed');
  assert.match(health, /unclaimedWindowDays: UNCLAIMED_WINDOW_DAYS/);
  assert.match(mgmt, /const UNCLAIMED_WINDOW_DAYS = \d+;/);

  // …and the banner must not assert, in the present tense, that the jobs are still stuck.
  const dash = stripComments(src('web/src/screens/Dashboard.tsx'));
  const banner = dash.slice(dash.indexOf('were refused'), dash.indexOf('see why'));
  assert.ok(banner.length > 0, 'the unclaimed banner moved — update this test');
  assert.ok(
    !/are not running/.test(banner),
    'a windowed historical count must not claim the jobs are running nowhere right now',
  );
  assert.match(banner, /unclaimedWindowDays/, 'the banner must state the window it counted');
});

test('the window is a sort-key range on lastSeenAt, not a filter over rows already read', () => {
  const store = src('src/shared/refusal-store.ts');
  const fn = store.slice(store.indexOf('export async function countRefusals('), store.length);
  assert.match(fn, /gsi1pk = :pk AND gsi1sk >= :since/);
  // Unwindowed remains supported (the screen's own paging does not window).
  assert.match(fn, /opts\.sinceIso\s*\n?\s*\?/);
  assert.ok(!/FilterExpression/.test(fn), 'a filter would read and pay for rows outside the window');
});

test('a re-cased allowlist is NOT reported as a config change', () => {
  // The claim gate lower-cases both sides (`decideClaim`), so `Lambda-CI-Node` and `lambda-ci-node`
  // are one entry to the platform. Reporting a re-case as "config changed" sends the operator to
  // re-run a job that is refused again for exactly the same reason.
  assert.equal(allowlistChanged(['lambda-ci-node'], ['Lambda-CI-Node'], true), false);
  assert.equal(
    allowlistChanged(['lambda-ci', 'lambda-ci-node'], ['LAMBDA-CI', ' lambda-ci-node '], true),
    false,
  );
  // Order carries no meaning either.
  assert.equal(
    allowlistChanged(['lambda-ci', 'lambda-ci-node'], ['lambda-ci-node', 'lambda-ci'], true),
    false,
  );
  // A genuine addition or removal still shows.
  assert.equal(allowlistChanged(['lambda-ci'], ['lambda-ci', 'lambda-ci-python'], true), true);
  assert.equal(allowlistChanged(['lambda-ci', 'lambda-ci-python'], ['lambda-ci'], true), true);
  assert.equal(allowlistChanged(['lambda-ci'], ['lambda-ci-node'], true), true);
  // A failed live read cannot be evidence of anything.
  assert.equal(allowlistChanged(['lambda-ci'], [], false), false);
  // The screen must consume the shared helper, not re-implement the comparison.
  const screen = stripComments(src('web/src/screens/Unclaimed.tsx'));
  assert.match(screen, /import \{ allowlistChanged \} from '\.\.\/\.\.\/\.\.\/src\/shared\/allowlist\.js'/);
  assert.ok(
    !/liveAllowlist\.includes\(/.test(screen),
    'a raw-case comparison in the screen would re-introduce the false "config changed" badge',
  );
});
