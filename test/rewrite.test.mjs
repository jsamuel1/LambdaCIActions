// Auto-rewrite planner (spec 03 § Auto-rewrite, ADR-031, src/mgmt/rewrite.ts).
//
// The whole point of the line-level rewriter is that the diff stays reviewable, so the tests
// assert what is NOT touched as much as what is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRunsOnLines,
  labelForFlavor,
  planFileRewrite,
  planPreviewFromAnalyses,
  rewriteBranchName,
  rewritePrBody,
  rewriteRunsOnValue,
  rewriteTargets,
} from '../dist/src/mgmt/rewrite.js';

const SIMPLE = `name: CI
# keep this comment
on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  test:
    runs-on: [ubuntu-22.04]
    steps:
      - run: make test
`;

test('runs-on lines are located per job', () => {
  const lines = findRunsOnLines(SIMPLE);
  assert.equal(lines.get('build'), 7);
  assert.equal(lines.get('test'), 11);
});

test('scalar hosted label becomes an explicit self-hosted + LCA label list', () => {
  const r = rewriteRunsOnValue('ubuntu-latest', 'lambda-ci');
  assert.deepEqual(r, { ok: true, value: '[self-hosted, lambda-ci]' });
});

test('the hosted label is REMOVED, not kept alongside ours', () => {
  // Keeping `ubuntu-latest` would leave the job unroutable: our runner would have to
  // advertise the hosted label too, which is the dependency adopt mode exists to avoid.
  const r = rewriteRunsOnValue('[ubuntu-latest]', 'lambda-ci-node');
  assert.equal(r.ok, true);
  assert.equal(r.value.includes('ubuntu-latest'), false);
});

test('unrelated custom labels are preserved', () => {
  const r = rewriteRunsOnValue('[ubuntu-latest, big-disk]', 'lambda-ci');
  assert.deepEqual(r, { ok: true, value: '[self-hosted, big-disk, lambda-ci]' });
});

test('self-hosted is not duplicated', () => {
  const r = rewriteRunsOnValue('[self-hosted, ubuntu-latest]', 'lambda-ci');
  assert.equal(r.value, '[self-hosted, lambda-ci]');
});

test('an inline comment survives the rewrite, spacing included', () => {
  // Both the comment text AND the run of whitespace before `#` are reproduced byte-for-byte:
  // collapsing that run to one space silently reflowed a deliberately aligned comment, which
  // is exactly the kind of unrelated churn this rewriter exists to avoid.
  const r = rewriteRunsOnValue('ubuntu-latest  # pinned deliberately', 'lambda-ci');
  assert.equal(r.value, '[self-hosted, lambda-ci]  # pinned deliberately');
});

test('a job already carrying an LCA label is refused, not rewritten twice', () => {
  const r = rewriteRunsOnValue('[self-hosted, lambda-ci]', 'lambda-ci');
  assert.equal(r.ok, false);
  assert.match(r.reason, /already carries an LCA label/);
});

test('shapes we cannot edit safely are refused with a reason', () => {
  for (const [value, pattern] of [
    ['', /block sequence/],
    ['${{ matrix.os }}', /expression/],
    ['{ group: build, labels: [x] }', /runner-group object form/],
  ]) {
    const r = rewriteRunsOnValue(value, 'lambda-ci');
    assert.equal(r.ok, false, `${value} must be refused`);
    assert.match(r.reason, pattern);
  }
});

test('planFileRewrite touches only the runs-on lines', () => {
  const plan = planFileRewrite('.github/workflows/ci.yml', SIMPLE, [
    { jobId: 'build', flavor: 'base' },
    { jobId: 'test', flavor: 'node' },
  ]);
  assert.equal(plan.edits.length, 2);

  const before = SIMPLE.split('\n');
  const after = plan.content.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.filter((l, i) => l !== after[i]);
  assert.equal(changed.length, 2);
  // Comments and every other line are byte-identical.
  assert.ok(plan.content.includes('# keep this comment'));
  assert.ok(plan.content.includes('runs-on: [self-hosted, lambda-ci]'));
  assert.ok(plan.content.includes('runs-on: [self-hosted, lambda-ci-node]'));
  // Indentation is preserved exactly.
  assert.ok(plan.content.includes('    runs-on: [self-hosted, lambda-ci]'));
});

test('the diff is a unified diff naming the file', () => {
  const plan = planFileRewrite('.github/workflows/ci.yml', SIMPLE, [
    { jobId: 'build', flavor: 'base' },
  ]);
  assert.match(plan.diff, /^--- a\/\.github\/workflows\/ci\.yml/m);
  assert.match(plan.diff, /^\+\+\+ b\/\.github\/workflows\/ci\.yml/m);
  assert.match(plan.diff, /^-\s+runs-on: ubuntu-latest$/m);
  assert.match(plan.diff, /^\+\s+runs-on: \[self-hosted, lambda-ci\]$/m);
});

test('a no-op plan yields no content and an empty diff', () => {
  const plan = planFileRewrite('.github/workflows/ci.yml', SIMPLE, [
    { jobId: 'nonexistent', flavor: 'base' },
  ]);
  assert.equal(plan.edits.length, 0);
  assert.equal(plan.content, undefined);
  assert.equal(plan.diff, '');
  assert.equal(plan.skipped.length, 1);
});

test('an unknown flavor is skipped, not silently defaulted', () => {
  const plan = planFileRewrite('.github/workflows/ci.yml', SIMPLE, [
    { jobId: 'build', flavor: 'gpu-xl' },
  ]);
  assert.equal(plan.edits.length, 0);
  assert.match(plan.skipped[0].reason, /unknown flavor/);
});

test('rewriteTargets picks hosted-label jobs only', () => {
  const jobs = [
    { id: 'a', runs_on: ['ubuntu-latest'] },
    { id: 'b', runs_on: ['self-hosted', 'lambda-ci'] },
    { id: 'c', runs_on: ['windows-latest'] },
  ];
  const targets = rewriteTargets(jobs, { a: { flavor: 'docker' } });
  assert.deepEqual(targets, [{ jobId: 'a', flavor: 'docker' }]);
});

test('rewriteTargets defaults to base when no route was stored', () => {
  assert.deepEqual(rewriteTargets([{ id: 'a', runs_on: ['ubuntu-latest'] }]), [
    { jobId: 'a', flavor: 'base' },
  ]);
});

test('preview is derived from stored analyses (no file access)', () => {
  const preview = planPreviewFromAnalyses([
    {
      path: '.github/workflows/ci.yml',
      parsed: {
        jobs: [
          { id: 'build', runs_on: ['ubuntu-latest'] },
          { id: 'skip', runs_on: ['self-hosted', 'lambda-ci'] },
        ],
      },
      routes: { build: { flavor: 'node' } },
    },
  ]);
  assert.equal(preview.changes, 1);
  assert.equal(preview.skipped, 0);
  assert.equal(preview.jobs[0].after, '[self-hosted, lambda-ci-node]');
});

test('flavor labels come from the catalog', () => {
  assert.equal(labelForFlavor('base'), 'lambda-ci');
  assert.equal(labelForFlavor('node'), 'lambda-ci-node');
  assert.equal(labelForFlavor('docker'), 'lambda-ci-docker');
  assert.equal(labelForFlavor('nope'), undefined);
});

test('the PR body states the arm64 tradeoff and lists hand-edits', () => {
  const plan = planFileRewrite('.github/workflows/ci.yml', SIMPLE, [
    { jobId: 'build', flavor: 'base' },
    { jobId: 'nonexistent', flavor: 'base' },
  ]);
  const { title, body } = rewritePrBody([plan]);
  assert.match(title, /LambdaCIActions/);
  assert.match(body, /arm64/);
  assert.match(body, /Not rewritten/);
  assert.match(body, /nonexistent/);
});

test('the branch name is stable per env (re-run updates, never duplicates)', () => {
  assert.equal(rewriteBranchName('dev'), rewriteBranchName('dev'));
  assert.notEqual(rewriteBranchName('dev'), rewriteBranchName('prod'));
});

// ---- stale-analysis + CRLF guards (review fixes) ----------------------------

test('a value that no longer targets a hosted label is refused, not rewritten', () => {
  // The target list comes from the STORED analysis; the file may have changed since. Rewriting
  // `windows-latest` into `[self-hosted, windows-latest, lambda-ci]` would strand the job, and
  // rewriting someone else's `[self-hosted, gpu]` would hijack their fleet.
  for (const value of ['windows-latest', '[self-hosted, gpu]', '[macos-14]', 'my-runner']) {
    const r = rewriteRunsOnValue(value, 'lambda-ci');
    assert.equal(r.ok, false, `${value} must be refused`);
    assert.match(r.reason, /no longer targets a standard GitHub-hosted label/);
  }
});

test('a stale target whose live runs-on changed is skipped by planFileRewrite', () => {
  const live = `jobs:
  build:
    runs-on: windows-latest
    steps:
      - run: make
`;
  const plan = planFileRewrite('.github/workflows/ci.yml', live, [
    { jobId: 'build', flavor: 'base' },
  ]);
  assert.equal(plan.edits.length, 0);
  assert.equal(plan.content, undefined);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /no longer targets a standard GitHub-hosted label/);
});

test('CRLF workflows are rewritten and stay CRLF', () => {
  const crlf = 'jobs:\r\n  build:\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: make\r\n';
  assert.equal(findRunsOnLines(crlf).get('build'), 3);
  const plan = planFileRewrite('.github/workflows/ci.yml', crlf, [
    { jobId: 'build', flavor: 'base' },
  ]);
  assert.equal(plan.edits.length, 1);
  assert.ok(plan.content.includes('runs-on: [self-hosted, lambda-ci]\r\n'));
  // Every other terminator is untouched — no LF conversion sneaking into the diff.
  assert.equal(plan.content.split('\r\n').length, crlf.split('\r\n').length);
  assert.equal(/[^\r]\n/.test(plan.content), false);
});

test('a mixed Linux/non-Linux selector is refused, not half-rewritten', () => {
  // `[self-hosted, windows-latest, lambda-ci]` would queue forever: decideClaim refuses any
  // job carrying a windows label, and `self-hosted` stops GitHub-hosted taking it back.
  const r = rewriteRunsOnValue('[ubuntu-latest, windows-latest]', 'lambda-ci');
  assert.equal(r.ok, false);
  assert.match(r.reason, /never claims/);
});

test('rewriteTargets skips jobs that also target windows/macos', () => {
  const targets = rewriteTargets([
    { id: 'linux', runs_on: ['ubuntu-latest'] },
    { id: 'mixed', runs_on: ['ubuntu-latest', 'windows-latest'] },
    { id: 'mac', runs_on: ['macos-14'] },
  ]);
  assert.deepEqual(targets.map((t) => t.jobId), ['linux']);
});

// --- scanner anchoring (review fix) ------------------------------------------
// A `runs-on:` key nested BELOW the job body (a matrix dimension, or text inside a `run: |`
// block scalar) is not the job's selector. Rewriting one is worse than skipping the job: it
// commits a corrupted matrix into the customer's repo AND leaves the real selector unrouted.

const MATRIX_DIM = `name: CI
on: [push]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        runs-on: [ubuntu-latest]
        node: [20, 22]
    runs-on: \${{ matrix.runs-on }}
    steps:
      - run: make test
`;

test('a matrix `runs-on` DIMENSION is not mistaken for the job selector', () => {
  // The job's own selector is on line 11; the matrix dimension on line 9 must be invisible.
  assert.equal(findRunsOnLines(MATRIX_DIM).get('test'), 11);
});

test('a matrix-driven job is skipped, and its matrix values are left untouched', () => {
  const plan = planFileRewrite('ci.yml', MATRIX_DIM, [{ jobId: 'test', flavor: 'base' }]);
  assert.equal(plan.edits.length, 0);
  assert.equal(plan.content, undefined); // nothing to commit
  assert.match(plan.skipped[0].reason, /expression/);
});

test('a runs-on-looking line inside a block scalar is not the job selector', () => {
  const yaml = `jobs:
  gen:
    steps:
      - run: |
          echo 'runs-on: ubuntu-latest' >> generated.yml
    runs-on: ubuntu-latest
`;
  // The job's real selector is the last line (6), not the echoed text on line 5.
  assert.equal(findRunsOnLines(yaml).get('gen'), 6);
  const plan = planFileRewrite('gen.yml', yaml, [{ jobId: 'gen', flavor: 'base' }]);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].line, 6);
  assert.ok(plan.content.includes("echo 'runs-on: ubuntu-latest' >> generated.yml"));
});

test('a job whose runs-on sits after nested blocks is still found', () => {
  // Regression guard for the anchoring fix: learning the body column from the FIRST body key
  // must not stop us finding a `runs-on` that appears later at that same column.
  const yaml = `jobs:
  build:
    needs: [lint]
    strategy:
      matrix:
        node: [20]
    env:
      FOO: bar
    runs-on: ubuntu-latest
    steps:
      - run: make
`;
  assert.equal(findRunsOnLines(yaml).get('build'), 9);
});

test('multi-job files still resolve each job independently after a nested block', () => {
  const yaml = `jobs:
  a:
    strategy:
      matrix:
        runs-on: [ubuntu-latest]
    runs-on: ubuntu-latest
  b:
    runs-on: ubuntu-22.04
`;
  const lines = findRunsOnLines(yaml);
  assert.equal(lines.get('a'), 6);
  assert.equal(lines.get('b'), 8);
});

// ---------------------------------------------------------------------------
// Quoting: the rewritten line must MEAN the same thing, not just look similar.
//
// The first cut split the inline sequence on `,` and stripped surrounding quotes, then
// re-emitted every kept label BARE. That is a silent corruption of a customer's workflow in a
// PR we opened: `"team: infra"` re-emitted unquoted parses as a MAPPING (`{team: infra}`), a
// numeric label becomes a number, `"*special"` becomes an undefined YAML alias — which fails
// to parse at all — and a quoted label containing a comma was split into two labels. Since a
// runner must advertise EVERY label in `runs-on`, any of these leaves the job unroutable on
// top of being an invalid or wrong workflow.
//
// The assertions go through the production parser, so they test the MEANING of the output
// rather than its spelling.
import { parseWorkflow } from '../dist/src/ingest/workflow-parser.js';

/** Labels the parser sees for a single-job workflow whose selector is `value`. */
function parsedLabels(value) {
  const doc = `name: CI\non: push\njobs:\n  build:\n    runs-on: ${value}\n    steps:\n      - run: make\n`;
  return parseWorkflow('.github/workflows/ci.yml', doc).jobs[0].runs_on;
}

test('a kept label keeps its quoting, so the selector still means the same labels', () => {
  for (const [selector, extra] of [
    ['[ubuntu-latest, "team: infra"]', 'team: infra'],
    ['[ubuntu-latest, "123"]', '123'],
    ['[ubuntu-latest, "*special"]', '*special'],
    ['[ubuntu-latest, "a,b"]', 'a,b'],
    ['[ubuntu-latest, "yes"]', 'yes'],
  ]) {
    // Sanity: the ORIGINAL selector carries exactly the labels we think it does.
    assert.deepEqual(parsedLabels(selector), ['ubuntu-latest', extra], `input ${selector}`);
    const r = rewriteRunsOnValue(selector, 'lambda-ci');
    assert.equal(r.ok, true, `${selector} should be rewritable: ${r.ok ? '' : r.reason}`);
    // The rewritten selector must parse, and must carry the extra label UNCHANGED — plus our
    // two labels, minus the hosted one.
    assert.deepEqual(
      parsedLabels(r.value),
      ['self-hosted', extra, 'lambda-ci'],
      `rewritten ${r.value}`,
    );
  }
});

test('a quoted label containing a #-comment marker is not truncated', () => {
  // ` #` inside quotes is part of the label. Cutting there left `[ubuntu-latest, label`, which
  // then failed the hosted-label re-check and reported the job as "no longer targets a standard
  // GitHub-hosted label" — a wrong reason for a job that rewrites cleanly.
  const r = rewriteRunsOnValue('[ubuntu-latest, "label #1"]', 'lambda-ci');
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.deepEqual(parsedLabels(r.value), ['self-hosted', 'label #1', 'lambda-ci']);
});

test('a real trailing comment is still preserved verbatim', () => {
  const r = rewriteRunsOnValue('[ubuntu-latest, big-disk]  # keep me', 'lambda-ci');
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.equal(r.value, '[self-hosted, big-disk, lambda-ci]  # keep me');
  assert.deepEqual(parsedLabels(r.value), ['self-hosted', 'big-disk', 'lambda-ci']);
});

test('an unterminated quote is refused rather than guessed at', () => {
  const r = rewriteRunsOnValue('[ubuntu-latest, "oops]', 'lambda-ci');
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not be parsed as a label list/);
});

test('the whole-file rewrite emits a workflow that still parses', () => {
  const src = `name: CI
on: push
jobs:
  build:
    runs-on: [ubuntu-latest, "team: infra"]
    steps:
      - run: make
`;
  const plan = planFileRewrite('.github/workflows/ci.yml', src, [{ jobId: 'build', flavor: 'base' }]);
  assert.equal(plan.edits.length, 1);
  const parsed = parseWorkflow('.github/workflows/ci.yml', plan.content);
  assert.deepEqual(parsed.jobs[0].runs_on, ['self-hosted', 'team: infra', 'lambda-ci']);
});

test('the dry run re-quotes labels the analysis stored unquoted', () => {
  // Discovery stores PARSED (unquoted) labels, so the preview must re-quote what needs it —
  // otherwise the operator is shown a mapping-shaped selector the λ would never write.
  const preview = planPreviewFromAnalyses([
    {
      path: '.github/workflows/ci.yml',
      parsed: { jobs: [{ id: 'build', runs_on: ['ubuntu-latest', 'team: infra'] }] },
      routes: { build: { flavor: 'base' } },
    },
  ]);
  assert.equal(preview.changes, 1);
  assert.equal(preview.jobs[0].before, '[ubuntu-latest, "team: infra"]');
  assert.deepEqual(parsedLabels(preview.jobs[0].after), [
    'self-hosted',
    'team: infra',
    'lambda-ci',
  ]);
});
