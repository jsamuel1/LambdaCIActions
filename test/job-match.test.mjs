// Unit tests for the webhook-job → stored-analysis matcher (src/ingest/job-match.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchJobAnalysis } from '../dist/src/ingest/job-match.js';

function job(id, overrides = {}) {
  return {
    id,
    name: null,
    runs_on: ['lambda-ci'],
    container: null,
    services: [],
    uses: null,
    matrix_dims: {},
    step_signals: { needs_docker: false, arch_hints: [], known_actions: [] },
    ...overrides,
  };
}

function analysis(path, name, jobs, compatJobs = {}) {
  return {
    repoId: 99,
    installationId: 1,
    repoFullName: 'octo/repo',
    path,
    name,
    parsed: { path, name, on: ['push'], jobs },
    compat: { level: 'ok', jobs: compatJobs },
    createdAt: 'x',
    updatedAt: 'x',
  };
}

test('matches by job id when the job has no custom name', () => {
  const analyses = [analysis('.github/workflows/ci.yml', 'CI', [job('build')])];
  const m = matchJobAnalysis(analyses, { workflowName: 'CI', jobName: 'build' });
  assert.ok(m);
  assert.equal(m.job.id, 'build');
  assert.equal(m.workflow.path, '.github/workflows/ci.yml');
});

test('matches by custom job name over id', () => {
  const analyses = [
    analysis('.github/workflows/ci.yml', 'CI', [job('b1', { name: 'Build & Test' })]),
  ];
  assert.ok(matchJobAnalysis(analyses, { workflowName: 'CI', jobName: 'Build & Test' }));
  assert.equal(matchJobAnalysis(analyses, { workflowName: 'CI', jobName: 'b1' }), undefined);
});

test('matches matrix-rendered names by prefix', () => {
  const analyses = [analysis('.github/workflows/ci.yml', 'CI', [job('test')])];
  const m = matchJobAnalysis(analyses, { workflowName: 'CI', jobName: 'test (18, ubuntu)' });
  assert.ok(m);
  assert.equal(m.job.id, 'test');
});

test('nameless workflow: webhook workflow_name is the FILE PATH → still matches', () => {
  // GitHub renders workflow_name as the path when the YAML has no `name:`; our parser
  // stores the basename fallback. Both renders must correlate.
  const analyses = [analysis('.github/workflows/ci.yml', 'ci.yml', [job('build')])];
  const byPath = matchJobAnalysis(analyses, {
    workflowName: '.github/workflows/ci.yml',
    jobName: 'build',
  });
  assert.ok(byPath, 'path render should match');
  const byBasename = matchJobAnalysis(analyses, { workflowName: 'ci.yml', jobName: 'build' });
  assert.ok(byBasename, 'basename render should match');
});

test('workflowName narrows candidates; wrong name → no match', () => {
  const analyses = [analysis('.github/workflows/ci.yml', 'CI', [job('build')])];
  assert.equal(
    matchJobAnalysis(analyses, { workflowName: 'Deploy', jobName: 'build' }),
    undefined,
  );
});

test('missing workflowName still matches when the job name is unique', () => {
  const analyses = [
    analysis('.github/workflows/ci.yml', 'CI', [job('build')]),
    analysis('.github/workflows/deploy.yml', 'Deploy', [job('release')]),
  ];
  const m = matchJobAnalysis(analyses, { workflowName: null, jobName: 'release' });
  assert.ok(m);
  assert.equal(m.workflow.name, 'Deploy');
});

test('ambiguous match (same job name in two workflows, no workflow_name) → undefined', () => {
  const analyses = [
    analysis('.github/workflows/a.yml', 'A', [job('build')]),
    analysis('.github/workflows/b.yml', 'B', [job('build')]),
  ];
  assert.equal(matchJobAnalysis(analyses, { workflowName: null, jobName: 'build' }), undefined);
});

test('returns the job compat result when stored', () => {
  const compat = {
    build: { level: 'block', eligible: false, messages: [{ level: 'block', code: 'unsupported-os', text: 'x' }] },
  };
  const analyses = [analysis('.github/workflows/ci.yml', 'CI', [job('build')], compat)];
  const m = matchJobAnalysis(analyses, { workflowName: 'CI', jobName: 'build' });
  assert.equal(m.compat.eligible, false);
});

test('parse-error rows (no parsed field) are skipped', () => {
  const analyses = [
    {
      repoId: 99,
      installationId: 1,
      repoFullName: 'octo/repo',
      path: '.github/workflows/bad.yml',
      name: 'bad.yml',
      parseError: 'malformed YAML',
      createdAt: 'x',
      updatedAt: 'x',
    },
  ];
  assert.equal(matchJobAnalysis(analyses, { workflowName: null, jobName: 'build' }), undefined);
});
