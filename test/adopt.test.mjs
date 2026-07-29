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
