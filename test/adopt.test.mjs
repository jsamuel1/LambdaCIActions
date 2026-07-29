// Adopt mode — standard-label claim decision + label map (spec 03 § Onboarding modes, ADR-030).
//
// The claim decision is the highest-consequence pure function in the platform: a false
// positive intercepts jobs a repo never offered us (and strands them if we can't run them),
// a false negative silently leaves a repo on GitHub-hosted runners. So the negative cases
// are asserted as carefully as the positive ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADOPT_LABEL_FLAVORS,
  adoptFlavorForLabel,
  decideClaim,
  isAdoptLabel,
} from '../dist/src/ingest/adopt.js';
import { rewriteTargets } from '../dist/src/mgmt/rewrite.js';

const CLAIMED = ['lambda-ci', 'lambda-ci-node', 'lambda-ci-docker'];

test('standard hosted labels map to base (signal upgrade handles node/docker)', () => {
  assert.equal(adoptFlavorForLabel('ubuntu-latest'), 'base');
  assert.equal(adoptFlavorForLabel('ubuntu-24.04'), 'base');
  assert.equal(adoptFlavorForLabel('ubuntu-22.04'), 'base');
  // Every entry in the map is a real flavor decision, not a placeholder.
  for (const flavor of Object.values(ADOPT_LABEL_FLAVORS)) {
    assert.equal(typeof flavor, 'string');
    assert.ok(flavor.length > 0);
  }
});

test('label matching is case-insensitive and trims', () => {
  assert.ok(isAdoptLabel('Ubuntu-Latest'));
  assert.ok(isAdoptLabel('  ubuntu-latest '));
  assert.equal(isAdoptLabel('lambda-ci'), false);
  assert.equal(isAdoptLabel('self-hosted'), false);
});

test('explicit LCA label is claimed in label mode', () => {
  const d = decideClaim({ jobLabels: ['self-hosted', 'lambda-ci'], claimedLabels: CLAIMED });
  assert.equal(d.claim, true);
  assert.equal(d.via, 'label');
});

test('label mode does NOT claim a bare ubuntu-latest job', () => {
  const d = decideClaim({ jobLabels: ['ubuntu-latest'], claimedLabels: CLAIMED, mode: 'label' });
  assert.equal(d.claim, false);
  assert.match(d.reason, /label mode/);
});

test('undefined mode behaves as label mode (fail-safe default)', () => {
  const d = decideClaim({ jobLabels: ['ubuntu-latest'], claimedLabels: CLAIMED });
  assert.equal(d.claim, false);
});

test('adopt mode claims a bare ubuntu-latest job', () => {
  const d = decideClaim({ jobLabels: ['ubuntu-latest'], claimedLabels: CLAIMED, mode: 'adopt' });
  assert.equal(d.claim, true);
  assert.equal(d.via, 'adopt');
  assert.match(d.reason, /standard label/);
});

test('adopt mode still prefers an explicit LCA label when both are present', () => {
  const d = decideClaim({
    jobLabels: ['ubuntu-latest', 'lambda-ci-docker'],
    claimedLabels: CLAIMED,
    mode: 'adopt',
  });
  assert.equal(d.claim, true);
  assert.equal(d.via, 'label');
});

test('windows/macos jobs are NEVER claimed, in any mode', () => {
  for (const label of ['windows-latest', 'macos-14', 'macOS-latest', 'windows-2022']) {
    for (const mode of ['adopt', 'label', undefined]) {
      const d = decideClaim({ jobLabels: [label], claimedLabels: CLAIMED, mode });
      assert.equal(d.claim, false, `${label} must not be claimed in ${mode ?? 'default'} mode`);
      assert.match(d.reason, /arm64 Linux only/);
    }
  }
});

test('adopt mode does not hijack someone else\u2019s self-hosted fleet', () => {
  const d = decideClaim({
    jobLabels: ['self-hosted', 'gpu'],
    claimedLabels: CLAIMED,
    mode: 'adopt',
  });
  assert.equal(d.claim, false);
  assert.match(d.reason, /no standard GitHub-hosted label/);
});

test('a windows job carrying an LCA label is refused, not claimed', () => {
  // Regression: the non-Linux refusal must sit ABOVE the explicit-label rule. Claiming
  // `[windows-latest, lambda-ci]` strands the job — GitHub assigns it to a runner that can
  // never execute it — and the compat gate cannot be the only guard because it fails open.
  const d = decideClaim({
    jobLabels: ['windows-latest', 'lambda-ci'],
    claimedLabels: CLAIMED,
    mode: 'adopt',
  });
  assert.equal(d.claim, false);
  assert.match(d.reason, /arm64 Linux only/);
});

test('empty / whitespace labels are ignored', () => {
  const d = decideClaim({ jobLabels: ['', '   '], claimedLabels: CLAIMED, mode: 'adopt' });
  assert.equal(d.claim, false);
});

// Regression: the three surfaces that decide "is this an adopt job" must agree for EVERY
// label string, including Object-prototype names. `decideClaim` and `views.ts` use a Set;
// `rewriteTargets` used `label in ADOPT_LABEL_FLAVORS`, which walks the prototype chain — so a
// job with `runs-on: constructor` was refused by the claim gate yet offered as a rewrite
// candidate, and `adoptFlavorForLabel` returned a FUNCTION from a `string | undefined`
// signature. The console states the candidate count as fact, so a disagreement is a lie.
test('Object-prototype label names are not adopt labels on ANY surface', () => {
  for (const label of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(isAdoptLabel(label), false, `${label} must not be an adopt label`);
    assert.equal(
      adoptFlavorForLabel(label),
      undefined,
      `${label} must map to no flavor (got ${typeof adoptFlavorForLabel(label)})`,
    );
    const d = decideClaim({ jobLabels: [label], claimedLabels: CLAIMED, mode: 'adopt' });
    assert.equal(d.claim, false, `${label} must not be claimed`);
    assert.deepEqual(
      rewriteTargets([{ id: 'build', runs_on: [label] }]),
      [],
      `${label} must not be a rewrite candidate`,
    );
  }
});

// ---- architecture refusal (arm64 only, ADR-007) -------------------------------
//
// microVMs are Graviton-only. GitHub matches a runner to a job on ADVERTISED LABELS ALONE, so
// passing `x64` through to `generate-jitconfig` mints an arm64 runner that CLAIMS to be x86 —
// and the job then EXECUTES on the wrong architecture instead of waiting for a runner that
// could serve it. That is worse than the stranded-job failure the windows/macos refusal
// prevents, so it is refused by the same gate, above the explicit-label rule.
const X86 = ['x64', 'x86', 'x86_64', 'x86-64', 'amd64', 'i386', 'i686'];

test('an x86 architecture label is refused in every mode', () => {
  for (const arch of X86) {
    for (const mode of ['label', 'adopt', undefined]) {
      // …alongside an EXPLICIT LCA label: a mistake in the workflow, not consent.
      const explicit = decideClaim({
        jobLabels: ['self-hosted', 'linux', arch, 'lambda-ci'],
        claimedLabels: CLAIMED,
        mode,
      });
      assert.equal(explicit.claim, false, `${arch} claimed in ${mode} mode via explicit label`);
      assert.match(explicit.reason, new RegExp(arch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
    // …and mixed with an adoptable hosted label in adopt mode.
    const adopt = decideClaim({
      jobLabels: ['ubuntu-latest', arch],
      claimedLabels: CLAIMED,
      mode: 'adopt',
    });
    assert.equal(adopt.claim, false, `[ubuntu-latest, ${arch}] claimed in adopt mode`);
  }
});

test('arch refusal is case-insensitive and matches whole tokens only', () => {
  assert.equal(
    decideClaim({ jobLabels: ['self-hosted', 'X64', 'lambda-ci'], claimedLabels: CLAIMED, mode: 'label' }).claim,
    false,
  );
  // arm64/aarch64 are true of us — never refused.
  for (const ours of ['arm64', 'ARM64', 'aarch64']) {
    assert.equal(
      decideClaim({ jobLabels: ['self-hosted', ours, 'lambda-ci'], claimedLabels: CLAIMED, mode: 'label' }).claim,
      true,
      `${ours} must still claim`,
    );
  }
  // A custom label that merely CONTAINS an arch token is not an arch assertion.
  for (const custom of ['x64-cache-warmer', 'amd64builder', 'my-i386-runner']) {
    assert.equal(
      decideClaim({ jobLabels: ['self-hosted', custom, 'lambda-ci'], claimedLabels: CLAIMED, mode: 'label' }).claim,
      true,
      `${custom} must not be read as an arch label`,
    );
  }
});

test('the rewrite planner agrees with the claim gate about x86 labels', () => {
  // If the planner rewrote an x86 job, the result would be a selector `decideClaim` refuses
  // AND that GitHub-hosted can no longer serve (we added `self-hosted`) — a job queued forever.
  const targets = rewriteTargets([
    { id: 'ok', runs_on: ['ubuntu-latest'] },
    { id: 'x86', runs_on: ['ubuntu-latest', 'x64'] },
    { id: 'amd', runs_on: ['ubuntu-latest', 'amd64'] },
  ]);
  assert.deepEqual(
    targets.map((t) => t.jobId),
    ['ok'],
  );
});
