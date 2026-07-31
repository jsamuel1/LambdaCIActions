// Unit tests for compatibility analysis (src/ingest/compat.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCompat, analyzeWorkflowCompat } from '../dist/src/ingest/compat.js';
import { resolveFlavor } from '../dist/src/provision/flavor.js';

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

// 8c. The docker signal upgrade REPLACES the flavor, so a job that asked for a language
// toolchain by label and got `docker` has lost that toolchain. Warn instead of failing the job
// at its first `python`/`go` step with a command-not-found.
test('a labelled toolchain missing from the resolved flavor warns', () => {
  const r = analyzeCompat(
    job({ runs_on: ['self-hosted', 'lambda-ci-python'], needs_docker: true }),
    res('docker'), // what resolveFlavor's docker signal upgrade actually returns
  );
  assert.equal(r.level, 'warn');
  const m = r.messages.find((x) => x.code === 'toolchain-dropped');
  assert.ok(m, 'must warn that the requested toolchain is gone');
  assert.match(m.text, /'python'/);
  assert.match(m.text, /'docker'/);
  // ...and it must NOT also claim docker is missing — the flavor has it.
  assert.equal(
    r.messages.some((x) => x.code === 'docker-missing'),
    false,
  );
});

test('a FlavorMap override onto the wrong toolchain warns the same way', () => {
  // Nothing about this one involves an upgrade: an operator mapped a language label at a
  // flavor that does not carry that toolchain.
  const r = analyzeCompat(job({ runs_on: ['self-hosted', 'lambda-ci-go'] }), res('java'));
  const m = r.messages.find((x) => x.code === 'toolchain-dropped');
  assert.ok(m);
  assert.match(m.text, /'go'/);
});

test('every language label warns when resolved onto docker', () => {
  for (const [label, cap] of [
    ['lambda-ci-python', 'python'],
    ['lambda-ci-java', 'java'],
    ['lambda-ci-go', 'go'],
    ['lambda-ci-rust', 'rust'],
    ['lambda-ci-node', 'node'],
  ]) {
    const r = analyzeCompat(
      job({ runs_on: ['self-hosted', label], needs_docker: true }),
      res('docker'),
    );
    const m = r.messages.find((x) => x.code === 'toolchain-dropped');
    assert.ok(m, `${label} should warn`);
    assert.match(m.text, new RegExp(`'${cap}'`), `${label} names the lost capability`);
  }
});

test('a label whose toolchain the flavor HAS does not warn', () => {
  // The no-op case, so the check cannot become a blanket warning on every LCA label.
  for (const [label, flavor] of [
    ['lambda-ci-python', 'python'],
    ['lambda-ci-docker', 'docker'],
    ['lambda-ci', 'base'],
  ]) {
    const r = analyzeCompat(job({ runs_on: ['self-hosted', label] }), res(flavor));
    assert.equal(
      r.messages.some((x) => x.code === 'toolchain-dropped'),
      false,
      `${label} on ${flavor} must not warn`,
    );
  }
});

test('the resolver names the dropped toolchain in its reason', () => {
  // The compat warning is the operator-facing half; the resolution reason is the log/UI half.
  // Both must say it, or the Repo detail screen presents the upgrade as pure gain.
  const r = resolveFlavor(['self-hosted', 'lambda-ci-python'], { signals: { needs_docker: true } });
  assert.equal(r.flavor, 'docker');
  assert.match(r.reason, /drops 'python'/);
  // An upgrade off a flavor with nothing to lose stays quiet.
  assert.doesNotMatch(
    resolveFlavor(['lambda-ci'], { signals: { needs_docker: true } }).reason,
    /drops/,
  );
});

test('a toolchain selected WITHOUT a catalog label still warns when it is dropped', () => {
  // A label is not the only way a flavor gets requested. `resolveFlavor` also selects one from a
  // repo FlavorMap entry (`ubuntu-latest → python`) and from the repo's `defaultFlavor`, and
  // NEITHER puts a `lambda-ci-python` label in `runs_on`. Re-deriving "requested" from labels
  // alone therefore missed both: the job upgraded to `docker`, lost Python, and got no warning
  // at all — the exact silent failure `toolchain-dropped` exists to prevent, on two of the three
  // selection routes. The resolution now carries the flavor the upgrade REPLACED, which is the
  // only signal available on those paths.
  for (const [desc, labels, opts] of [
    ['FlavorMap', ['ubuntu-latest'], { flavorMap: { 'ubuntu-latest': 'python' } }],
    ['defaultFlavor', ['self-hosted'], { defaultFlavor: 'python' }],
  ]) {
    const r = resolveFlavor(labels, { ...opts, signals: { needs_docker: true } });
    assert.equal(r.flavor, 'docker', `${desc}: upgrades to docker`);
    assert.equal(r.replaced, 'python', `${desc}: records what it replaced`);
    const c = analyzeCompat(job({ runs_on: labels, needs_docker: true }), r);
    const m = c.messages.find((x) => x.code === 'toolchain-dropped');
    assert.ok(m, `${desc}: must warn that Python is gone`);
    assert.match(m.text, /'python'/, `${desc}: names the lost capability`);
  }
});

test('an upgrade off a flavor with nothing to lose raises no toolchain warning', () => {
  // The no-op case for the `replaced` path: base carries no capabilities, so upgrading it to
  // docker drops nothing and must stay quiet rather than warning on every docker job.
  const r = resolveFlavor(['lambda-ci'], { signals: { needs_docker: true } });
  assert.equal(r.flavor, 'docker');
  assert.equal(r.replaced, 'base');
  const c = analyzeCompat(job({ runs_on: ['lambda-ci'], needs_docker: true }), r);
  assert.equal(
    c.messages.some((x) => x.code === 'toolchain-dropped'),
    false,
  );
  assert.equal(c.level, 'ok');
});

test('no upgrade means no `replaced` field, and no warning from it', () => {
  const r = resolveFlavor(['self-hosted', 'lambda-ci-python']);
  assert.equal(r.flavor, 'python');
  assert.equal(r.replaced, undefined, 'nothing was replaced');
  const c = analyzeCompat(job({ runs_on: ['self-hosted', 'lambda-ci-python'] }), r);
  assert.equal(c.level, 'ok');
  assert.equal(c.messages.length, 0);
});

test('adopt mode never trips `toolchain-dropped`, on any standard label', () => {
  // The ADR-030 × ADR-039 interaction, pinned because the two shipped on separate branches and
  // nothing else asserts they compose. An adopt-mode job never named a toolchain, so it cannot
  // have one dropped, and the gate must stay silent on BOTH of its sources:
  //   - `ubuntu-latest` is not a catalog label → CAPABILITIES_BY_LABEL contributes nothing;
  //   - a docker upgrade sets `replaced: 'base'`, and base advertises [] → the `replaced`
  //     source contributes nothing either.
  // If this test fails, `ADOPT_LABEL_FLAVORS` has been pointed at a flavor that advertises a
  // capability, and every adopted repo with a `services:` block just went yellow for a
  // toolchain its workflow never asked for — destroying the compat signal spec 03 relies on.
  for (const label of ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'ubuntu-20.04']) {
    for (const needs_docker of [false, true]) {
      const r = resolveFlavor([label], { mode: 'adopt', signals: { needs_docker } });
      assert.equal(r.flavor, needs_docker ? 'docker' : 'base', `${label}: routes as expected`);
      const c = analyzeCompat(job({ runs_on: [label], needs_docker }), r);
      assert.equal(
        c.messages.some((x) => x.code === 'toolchain-dropped'),
        false,
        `${label} (needs_docker=${needs_docker}) must not warn about a dropped toolchain`,
      );
      assert.equal(c.level, 'ok', `${label} (needs_docker=${needs_docker}) stays green`);
    }
  }
});

test('adopt mode still warns when an explicit label DID name a toolchain', () => {
  // The counterpart: adopt mode is not a blanket suppression. A repo in adopt mode whose job
  // carries an explicit `lambda-ci-python` label resolves by the explicit-label rule (chain
  // step 2, above adopt's step 3), so a docker upgrade drops a toolchain that WAS requested
  // and must warn exactly as it does in label mode.
  const r = resolveFlavor(['ubuntu-latest', 'lambda-ci-python'], {
    mode: 'adopt',
    signals: { needs_docker: true },
  });
  assert.equal(r.flavor, 'docker');
  assert.equal(r.replaced, 'python', 'explicit label won over the adopt map');
  const c = analyzeCompat(
    job({ runs_on: ['ubuntu-latest', 'lambda-ci-python'], needs_docker: true }),
    r,
  );
  const m = c.messages.find((x) => x.code === 'toolchain-dropped');
  assert.ok(m, 'an explicitly requested toolchain that is dropped must still warn in adopt mode');
  assert.match(m.text, /'python'/);
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
