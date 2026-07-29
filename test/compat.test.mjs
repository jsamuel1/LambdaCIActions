// Unit tests for compatibility analysis (src/ingest/compat.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCompat, analyzeWorkflowCompat } from '../dist/src/ingest/compat.js';

/** Build a ParsedJob fixture with sane defaults; override any field. */
function job(overrides = {}) {
  return {
    id: overrides.id ?? 'build',
    runs_on: overrides.runs_on ?? ['ubuntu-latest'],
    container: overrides.container ?? null,
    services: overrides.services ?? [],
    uses: overrides.uses ?? null,
    matrix_dims: overrides.matrix_dims ?? {},
    step_signals: {
      needs_docker: overrides.needs_docker ?? false,
      arch_hints: overrides.arch_hints ?? [],
      known_actions: overrides.known_actions ?? [],
    },
  };
}

/** A resolution stub (compat only reads `.flavor`). */
function res(flavor) {
  return { flavor, reason: `test '${flavor}'` };
}

// 1. Pure-script job → ok, eligible, no messages.
test('pure-script job is ok and eligible with no messages', () => {
  const r = analyzeCompat(job(), res('base'));
  assert.equal(r.level, 'ok');
  assert.equal(r.eligible, true);
  assert.equal(r.messages.length, 0);
});

// 2. runs-on: windows-latest → block, not eligible, code names OS.
test('windows-latest blocks and is not eligible', () => {
  const r = analyzeCompat(job({ runs_on: ['windows-latest'] }), res('base'));
  assert.equal(r.level, 'block');
  assert.equal(r.eligible, false);
  assert.equal(r.messages[0].code, 'unsupported-os');
  assert.match(r.messages[0].text, /windows-latest/);
});

// 3. runs-on: macos-14 → block.
test('macos-14 blocks', () => {
  const r = analyzeCompat(job({ runs_on: ['macos-14'] }), res('base'));
  assert.equal(r.level, 'block');
  assert.equal(r.eligible, false);
});

// 4. arch hints.
test('amd64-only arch hint is risk', () => {
  const r = analyzeCompat(job({ arch_hints: ['amd64'] }), res('base'));
  assert.equal(r.level, 'risk');
  assert.equal(r.eligible, true);
  assert.equal(r.messages[0].code, 'x86-arch-hint');
});

test('mixed arm64 + amd64 arch hints is warn, not risk', () => {
  const r = analyzeCompat(job({ arch_hints: ['arm64', 'amd64'] }), res('base'));
  assert.equal(r.level, 'warn');
  assert.equal(r.messages[0].code, 'mixed-arch-hint');
});

// 5. container image arch.
test('container node:20-amd64 is risk', () => {
  const r = analyzeCompat(job({ container: 'node:20-amd64' }), res('base'));
  assert.equal(r.level, 'risk');
  assert.equal(r.messages[0].code, 'x86-container');
});

test('container node:20-x86_64 is risk', () => {
  const r = analyzeCompat(job({ container: 'node:20-x86_64' }), res('base'));
  assert.equal(r.level, 'risk');
});

test('container node:20 (arm-friendly) is ok', () => {
  const r = analyzeCompat(job({ container: 'node:20' }), res('node'));
  assert.equal(r.level, 'ok');
  assert.equal(r.messages.length, 0);
});

// 6. reusable workflows.
test('external reusable workflow warns', () => {
  const r = analyzeCompat(
    job({ uses: 'org/repo/.github/workflows/x.yml@main' }),
    res('base'),
  );
  assert.equal(r.level, 'warn');
  assert.equal(r.messages[0].code, 'external-reusable');
});

test('local reusable workflow does not warn', () => {
  const r = analyzeCompat(
    job({ uses: './.github/workflows/x.yml' }),
    res('base'),
  );
  assert.equal(r.level, 'ok');
  assert.equal(r.messages.length, 0);
});

// 7. unresolved matrix expression.
test('dynamic matrix runs_on warns', () => {
  const r = analyzeCompat(job({ runs_on: ['${{ matrix.os }}'] }), res('base'));
  assert.equal(r.level, 'warn');
  assert.equal(r.messages[0].code, 'dynamic-matrix');
});

// 8. needs_docker vs resolved flavor.
test('needs_docker on docker-less flavor warns', () => {
  const r = analyzeCompat(job({ needs_docker: true }), res('base'));
  assert.equal(r.level, 'warn');
  assert.equal(r.messages[0].code, 'docker-missing');
});

test('needs_docker on docker flavor does not warn', () => {
  const r = analyzeCompat(job({ needs_docker: true }), res('docker'));
  assert.equal(r.level, 'ok');
  assert.equal(r.messages.length, 0);
});

// 8b. The docker-capable set is DERIVED from the catalog, so adding language flavors must not
// accidentally make one of them count as docker-capable (which would suppress a real warning).
test('needs_docker warns on every new language flavor', () => {
  for (const flavor of ['python', 'java', 'go', 'rust', 'node']) {
    const r = analyzeCompat(job({ needs_docker: true }), res(flavor));
    assert.equal(r.level, 'warn', `${flavor} should warn`);
    assert.equal(r.messages[0].code, 'docker-missing', `${flavor} code`);
    assert.match(r.messages[0].text, new RegExp(`'${flavor}'`), `${flavor} named in message`);
  }
});

test('an unknown flavor name is still treated as docker-less', () => {
  // Fail loud rather than silently assuming a daemon exists.
  const r = analyzeCompat(job({ needs_docker: true }), res('not-a-flavor'));
  assert.equal(r.messages[0].code, 'docker-missing');
});

test('a language job with no docker need is clean on its own flavor', () => {
  for (const flavor of ['python', 'java', 'go', 'rust']) {
    const r = analyzeCompat(job({ runs_on: ['self-hosted', `lambda-ci-${flavor}`] }), res(flavor));
    assert.equal(r.level, 'ok', `${flavor} should be ok`);
    assert.equal(r.messages.length, 0);
  }
});

test('an arm64-hinted language job stays ok; an x86-hinted one is risk', () => {
  // The compat gate is arch-driven, not flavor-driven — adding flavors must not change it.
  assert.equal(analyzeCompat(job({ arch_hints: ['arm64'] }), res('rust')).level, 'ok');
  const x86 = analyzeCompat(job({ arch_hints: ['x86_64'] }), res('rust'));
  assert.equal(x86.level, 'risk');
  assert.equal(x86.messages[0].code, 'x86-arch-hint');
});

// 9. multiple rules → worst level wins, all messages present.
test('block + docker-missing folds to block with both messages', () => {
  const r = analyzeCompat(
    job({ runs_on: ['windows-latest'], needs_docker: true }),
    res('base'),
  );
  assert.equal(r.level, 'block');
  assert.equal(r.eligible, false);
  const codes = r.messages.map((m) => m.code);
  assert.ok(codes.includes('unsupported-os'));
  assert.ok(codes.includes('docker-missing'));
});

// 10. analyzeWorkflowCompat folds jobs to worst level.
test('analyzeWorkflowCompat folds mixed jobs to worst (block)', () => {
  const wf = {
    path: '.github/workflows/ci.yml',
    name: 'CI',
    on: ['push'],
    jobs: [
      job({ id: 'ok-job' }),
      job({ id: 'warn-job', uses: 'org/repo/.github/workflows/x.yml@main' }),
      job({ id: 'block-job', runs_on: ['macos-14'] }),
    ],
  };
  const r = analyzeWorkflowCompat(wf, () => res('base'));
  assert.equal(r.path, '.github/workflows/ci.yml');
  assert.equal(r.level, 'block');
  assert.equal(r.jobs['ok-job'].level, 'ok');
  assert.equal(r.jobs['warn-job'].level, 'warn');
  assert.equal(r.jobs['block-job'].level, 'block');
});
