// Adopt mode must resolve the SAME flavor+reason everywhere it is computed (M5, ADR-030).
//
// The flavor for a job is resolved in two places against two different inputs:
//   - Provision, at claim time, from the live repo row (`mode`) — what actually runs.
//   - Discovery, at scan time, stored as `routes[jobId]` — what the console renders and what
//     the auto-rewrite planner (ADR-031) reads to pick the label it writes into a customer PR.
//
// If Discovery omits `mode`, an adopt-mode repo's `ubuntu-latest` jobs miss the adopt map and
// land on the FALLBACK, so the stored reason reads `fallback to base (no matching label)` for a
// repo whose whole configuration is "claim these labels". Same flavor by luck (`base`), wrong
// explanation — and it stops being luck the moment a repo sets `defaultFlavor`, which the
// fallback honours and the adopt map does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFlavor } from '../dist/src/provision/flavor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const discoverSrc = fs.readFileSync(path.join(ROOT, 'src', 'discover', 'handler.ts'), 'utf8');
const mgmtSrc = fs.readFileSync(path.join(ROOT, 'src', 'mgmt', 'handler.ts'), 'utf8');

test('adopt mode routes a hosted label through the adopt map, not the fallback', () => {
  const r = resolveFlavor(['ubuntu-latest'], { mode: 'adopt' });
  assert.equal(r.flavor, 'base');
  assert.match(r.reason, /adopt-mode standard label/);
  assert.doesNotMatch(r.reason, /fallback/i);
});

test("adopt mode ignores defaultFlavor for a hosted label; the fallback does not", () => {
  // This is the case where the missing `mode` changes the FLAVOR, not just the wording: the
  // fallback honours the repo's operator-chosen defaultFlavor, the adopt map does not.
  assert.equal(resolveFlavor(['ubuntu-latest'], { mode: 'adopt', defaultFlavor: 'node' }).flavor, 'base');
  assert.equal(resolveFlavor(['ubuntu-latest'], { defaultFlavor: 'node' }).flavor, 'node');
});

test('Discovery resolves with the repo mode, so stored routes match what Provision will do', () => {
  assert.match(discoverSrc, /const mode = repoRecord\?\.mode;/);
  const resolveFn = discoverSrc.slice(
    discoverSrc.indexOf('const resolveFn ='),
    discoverSrc.indexOf('const compat ='),
  );
  assert.match(resolveFn, /mode/, 'discovery must thread the repo mode into resolveFlavor');
});

test('a mode change re-scans the repo so stored routes stop being stale', () => {
  // Without this the operator flips to adopt and the console still shows every hosted-label
  // job as `fallback to base (no matching label)` until someone happens to push a workflow.
  const patch = mgmtSrc.slice(
    mgmtSrc.indexOf("case 'patchRepo':"),
    mgmtSrc.indexOf("case 'listWorkflows':"),
  );
  assert.match(patch, /parsed\.value\.mode !== undefined/);
  assert.match(patch, /enqueueRescan\(/);
  // Best-effort: the config write already succeeded, so a failed enqueue must not 5xx it.
  assert.match(patch, /\.catch\(/);
});

// ---- runner groups (ADR-030) --------------------------------------------------
//
// `runs-on: { group: X, labels: [...] }` is a valid selector. GitHub dispatches a job only to
// a runner that is in the requested GROUP *and* carries every requested label, and we register
// JIT runners into the repo-level default group only (`runner_group_id: 1`, spec 01 OQ-1).
//
// The `workflow_job` webhook carries only the LABELS, so the group is invisible at claim time
// unless the parsed analysis preserves it. Without that, adopt mode claimed a
// `{ group: special, labels: [ubuntu-latest] }` job on the strength of `ubuntu-latest`, minted
// a runner in the default group, and the job waited forever — newly reachable in M5 because
// adopt mode claims the hosted label with no LCA label present anywhere.
test('the parser preserves the runner group from the object form', async () => {
  const { parseWorkflow } = await import('../dist/src/ingest/workflow-parser.js');
  const wf = parseWorkflow(
    '.github/workflows/ci.yml',
    [
      'name: ci',
      'on: push',
      'jobs:',
      '  grouped:',
      '    runs-on:',
      '      group: special',
      '      labels: [ubuntu-latest]',
      '  plain:',
      '    runs-on: ubuntu-latest',
      '  arrayform:',
      '    runs-on: [self-hosted, lambda-ci]',
    ].join('\n'),
  );
  const byId = Object.fromEntries(wf.jobs.map((j) => [j.id, j]));
  // The labels still come through (LCA routing labels can live under `labels`) …
  assert.deepEqual(byId.grouped.runs_on, ['ubuntu-latest']);
  // … and the group is recorded separately, because it is a routing REQUIREMENT, not a label.
  assert.equal(byId.grouped.runner_group, 'special');
  // Non-object forms have no group.
  assert.equal(byId.plain.runner_group, null);
  assert.equal(byId.arrayform.runner_group, null);
});

test('ingest refuses to claim a job that names a non-default runner group', () => {
  const ingestSrc = fs.readFileSync(path.join(ROOT, 'src', 'ingest', 'handler.ts'), 'utf8');
  // Anchored on the refusal EMITTER call rather than on the log line's prose: every refusal is
  // now emitted through one classifier (ADR-049), so the branch marker is the gate name, and the
  // operator-facing text is free to be reworded without disarming this guard.
  const gate = ingestSrc.indexOf("refuse('runner-group'");
  assert.ok(gate > 0, 'runner-group gate not found in ingest');
  // It reads the group off the MATCHED analysis (the webhook cannot carry it) …
  assert.match(ingestSrc, /match\?\.job\?\.runner_group/);
  // … refuses anything that is not the default group, via the SHARED predicate every other
  // group-aware call site uses …
  assert.match(ingestSrc, /unreachableRunnerGroup\(group\)/);
  // … and returns unclaimed rather than enqueuing.
  assert.match(ingestSrc.slice(gate, gate + 900), /claimed: false/);
  // The gate must sit BEFORE the enqueue that hands the job to Provision (the LAST
  // SendMessageCommand in the file; the earlier one belongs to a different route).
  assert.ok(
    gate < ingestSrc.lastIndexOf('SendMessageCommand'),
    'group gate must precede the provision enqueue',
  );
});

test('provision mints into the repo-level default group only', () => {
  // The refusal above is only correct while this stays true: if we ever registered into a
  // requested group, the claim gate would have to resolve the group id instead of refusing.
  const gh = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'github-app.ts'), 'utf8');
  assert.match(gh, /runner_group_id: 1/);
});

test('every predicate that predicts a claim excludes a non-default group', async () => {
  // Ingest refuses the claim, so the console's `adoptCandidate` count and the rewrite planner's
  // target list must agree — otherwise RepoDetail advertises jobs adopt mode always refuses,
  // and the rewrite PR edits a customer workflow for a job that still cannot run.
  const { unreachableRunnerGroup } = await import('../dist/src/ingest/adopt.js');
  const { rewriteTargets } = await import('../dist/src/mgmt/rewrite.js');
  const { toWorkflowView } = await import('../dist/src/mgmt/views.js');

  assert.equal(unreachableRunnerGroup('special'), true);
  assert.equal(unreachableRunnerGroup('default'), false);
  assert.equal(unreachableRunnerGroup('Default'), false);
  assert.equal(unreachableRunnerGroup(null), false);
  assert.equal(unreachableRunnerGroup(undefined), false);
  assert.equal(unreachableRunnerGroup('  '), false);

  const jobs = [
    { id: 'plain', name: null, runs_on: ['ubuntu-latest'], runner_group: null },
    { id: 'grouped', name: null, runs_on: ['ubuntu-latest'], runner_group: 'special' },
    { id: 'defaultgroup', name: null, runs_on: ['ubuntu-latest'], runner_group: 'default' },
  ];
  assert.deepEqual(
    rewriteTargets(jobs).map((t) => t.jobId),
    ['plain', 'defaultgroup'],
  );
  const view = toWorkflowView({
    path: '.github/workflows/ci.yml',
    name: 'ci',
    parsed: { path: '.github/workflows/ci.yml', name: 'ci', on: ['push'], jobs },
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(view.adoptCandidates, 2);
  assert.equal(view.jobs.find((j) => j.id === 'grouped').adoptCandidate, false);
});
