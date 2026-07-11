// Unit tests for the pure workflow parser (src/ingest/workflow-parser.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '../dist/src/ingest/workflow-parser.js';
import { WorkflowParseError } from '../dist/src/shared/types.js';

const PATH = '.github/workflows/ci.yml';

// 1. simple runs-on string → runs_on array, no docker.
test('runs-on string normalizes to a single-element array', () => {
  const wf = parseWorkflow(PATH, 'name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n');
  assert.equal(wf.name, 'CI');
  assert.equal(wf.jobs.length, 1);
  const job = wf.jobs[0];
  assert.equal(job.id, 'build');
  assert.deepEqual(job.runs_on, ['ubuntu-latest']);
  assert.equal(job.step_signals.needs_docker, false);
});

// 2. array runs-on preserved.
test('array runs-on is preserved as an array', () => {
  const wf = parseWorkflow(PATH, 'jobs:\n  build:\n    runs-on: [self-hosted, lambda-ci-docker]\n');
  assert.deepEqual(wf.jobs[0].runs_on, ['self-hosted', 'lambda-ci-docker']);
});

// 3. on: string / array / map all normalize to string[].
test('on: string form normalizes to string[]', () => {
  const wf = parseWorkflow(PATH, 'on: push\njobs: {}\n');
  assert.deepEqual(wf.on, ['push']);
});
test('on: array form normalizes to string[]', () => {
  const wf = parseWorkflow(PATH, 'on: [push, pull_request]\njobs: {}\n');
  assert.deepEqual(wf.on, ['push', 'pull_request']);
});
test('on: map form normalizes to its keys', () => {
  const wf = parseWorkflow(
    PATH,
    'on:\n  push:\n    branches: [main]\n  pull_request:\njobs: {}\n',
  );
  assert.deepEqual(wf.on, ['push', 'pull_request']);
});

// 4. container string + object form both populate container.
test('container: string form populates container', () => {
  const wf = parseWorkflow(PATH, 'jobs:\n  build:\n    runs-on: x\n    container: node:20\n');
  assert.equal(wf.jobs[0].container, 'node:20');
  assert.equal(wf.jobs[0].step_signals.needs_docker, true);
});
test('container: object form populates container', () => {
  const wf = parseWorkflow(
    PATH,
    'jobs:\n  build:\n    runs-on: x\n    container:\n      image: node:20\n      env:\n        FOO: bar\n',
  );
  assert.equal(wf.jobs[0].container, 'node:20');
  assert.equal(wf.jobs[0].step_signals.needs_docker, true);
});

// 5. services present → needs_docker + services keys.
test('services present implies needs_docker and lists keys', () => {
  const wf = parseWorkflow(
    PATH,
    'jobs:\n  build:\n    runs-on: x\n    services:\n      postgres:\n        image: postgres:16\n      redis:\n        image: redis:7\n',
  );
  const job = wf.jobs[0];
  assert.deepEqual(job.services.sort(), ['postgres', 'redis']);
  assert.equal(job.step_signals.needs_docker, true);
});

// 6. docker/* action → needs_docker + known_actions.
test('docker/* step action sets needs_docker and appears in known_actions', () => {
  const wf = parseWorkflow(
    PATH,
    'jobs:\n  build:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n      - uses: docker/build-push-action@v6\n',
  );
  const job = wf.jobs[0];
  assert.equal(job.step_signals.needs_docker, true);
  assert.deepEqual(job.step_signals.known_actions, [
    'actions/checkout@v4',
    'docker/build-push-action@v6',
  ]);
});

// 7. run: docker build → needs_docker.
test('run: docker build sets needs_docker', () => {
  const wf = parseWorkflow(
    PATH,
    'jobs:\n  build:\n    runs-on: x\n    steps:\n      - run: docker build .\n',
  );
  assert.equal(wf.jobs[0].step_signals.needs_docker, true);
});

// 8. matrix dims extracted, include/exclude ignored, values string-coerced.
test('strategy.matrix dims extracted and string-coerced, include/exclude ignored', () => {
  const wf = parseWorkflow(
    PATH,
    'jobs:\n  build:\n    runs-on: x\n    strategy:\n      matrix:\n        node: [18, 20]\n        os: [ubuntu-latest]\n        include:\n          - node: 22\n        exclude:\n          - node: 18\n',
  );
  assert.deepEqual(wf.jobs[0].matrix_dims, {
    node: ['18', '20'],
    os: ['ubuntu-latest'],
  });
});

// 9. matrix expr runs-on preserved verbatim.
test('unresolvable runs-on matrix expr is preserved verbatim', () => {
  const wf = parseWorkflow(PATH, 'jobs:\n  build:\n    runs-on: ${{ matrix.os }}\n');
  assert.deepEqual(wf.jobs[0].runs_on, ['${{ matrix.os }}']);
});

// 10. reusable workflow uses at job level.
test('reusable workflow job-level uses is populated', () => {
  const wf = parseWorkflow(
    PATH,
    'jobs:\n  call:\n    uses: org/repo/.github/workflows/x.yml@main\n',
  );
  assert.equal(wf.jobs[0].uses, 'org/repo/.github/workflows/x.yml@main');
  assert.deepEqual(wf.jobs[0].runs_on, []);
});

// 11. malformed → throws; empty/no-jobs → jobs:[].
test('malformed YAML throws WorkflowParseError', () => {
  assert.throws(
    () => parseWorkflow(PATH, 'a: [1, 2\nb: bad'),
    (err) => err instanceof WorkflowParseError && err.path === PATH,
  );
});
test('workflow with no jobs yields jobs: []', () => {
  const wf = parseWorkflow(PATH, 'name: Empty\non: push\n');
  assert.deepEqual(wf.jobs, []);
  assert.equal(wf.name, 'Empty');
});
test('empty document yields empty workflow, basename name', () => {
  const wf = parseWorkflow(PATH, '');
  assert.deepEqual(wf.jobs, []);
  assert.deepEqual(wf.on, []);
  assert.equal(wf.name, 'ci.yml');
});
test('non-mapping root throws WorkflowParseError', () => {
  assert.throws(
    () => parseWorkflow(PATH, '- just\n- a\n- list'),
    (err) => err instanceof WorkflowParseError,
  );
});

// arch_hints best-effort scan.
test('arch hints are collected from runs-on, container, and run text', () => {
  const wf = parseWorkflow(
    PATH,
    'jobs:\n  build:\n    runs-on: [self-hosted, arm64]\n    container: node:20-arm64\n    steps:\n      - run: docker buildx build --platform linux/x86_64 .\n',
  );
  assert.deepEqual(wf.jobs[0].step_signals.arch_hints.sort(), ['arm64', 'x86_64']);
});
