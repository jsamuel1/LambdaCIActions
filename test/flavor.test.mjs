// Unit tests for label → flavor resolution (src/provision/flavor.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFlavor,
  allFlavors,
  areCapabilitiesKnown,
  KNOWN_CAPABILITIES,
} from '../dist/src/provision/flavor.js';

// --- Explicit LCA labels (resolution step 2) ---

test('base label resolves to base flavor', () => {
  assert.equal(resolveFlavor(['lambda-ci']).flavor, 'base');
});

test('node label resolves to node flavor', () => {
  assert.equal(resolveFlavor(['lambda-ci-node']).flavor, 'node');
});

test('docker label resolves to docker flavor', () => {
  assert.equal(resolveFlavor(['lambda-ci-docker']).flavor, 'docker');
});

// --- Expanded standard set (ADR-031) ---

test('each standard language flavor resolves from its explicit label', () => {
  for (const [label, flavor] of [
    ['lambda-ci-python', 'python'],
    ['lambda-ci-java', 'java'],
    ['lambda-ci-go', 'go'],
    ['lambda-ci-rust', 'rust'],
  ]) {
    assert.equal(resolveFlavor([label]).flavor, flavor, `${label} → ${flavor}`);
  }
});

test('a language label alongside self-hosted still resolves (real-world runs-on)', () => {
  // `runs-on: [self-hosted, lambda-ci-python]` is the shape a repo actually writes.
  assert.equal(resolveFlavor(['self-hosted', 'lambda-ci-python']).flavor, 'python');
});

test('language labels are case-insensitive like the others', () => {
  assert.equal(resolveFlavor(['LAMBDA-CI-RUST']).flavor, 'rust');
  assert.equal(resolveFlavor(['Lambda-CI-Go']).flavor, 'go');
});

test('a language label is more specific than bare lambda-ci', () => {
  // Longest matching label wins — adding language flavors must not let `base` shadow them.
  assert.equal(resolveFlavor(['lambda-ci', 'lambda-ci-java']).flavor, 'java');
});

test('every catalog flavor is reachable from its own label', () => {
  // Guards against a catalog entry whose label is a prefix-collision casualty.
  for (const f of allFlavors()) {
    assert.equal(resolveFlavor([f.label]).flavor, f.name, `${f.label} → ${f.name}`);
  }
});

test('a language flavor still upgrades to docker when the job needs docker', () => {
  // A python job with `services:` must not silently run without a daemon.
  const r = resolveFlavor(['lambda-ci-python'], { signals: { needs_docker: true } });
  assert.equal(r.flavor, 'docker');
  assert.match(r.reason, /upgraded.*docker/i);
});

test('docker upgrade picks the smallest docker-capable flavor', () => {
  // Only `docker` advertises the capability today; pin the selection so adding a bigger
  // docker-capable flavor later can't silently become the upgrade target.
  const dockerCapable = allFlavors().filter((f) => f.capabilities.includes('docker'));
  const smallest = [...dockerCapable].sort((a, b) => a.vcpu - b.vcpu || a.memoryMb - b.memoryMb)[0];
  assert.equal(resolveFlavor(['lambda-ci'], { signals: { needs_docker: true } }).flavor, smallest.name);
});

test('language flavors are NOT docker-capable', () => {
  // They keep unprivileged entrypoints (ADR-020) — claiming docker would be a lie that the
  // resolver would act on.
  for (const name of ['python', 'java', 'go', 'rust', 'node', 'base']) {
    const def = allFlavors().find((f) => f.name === name);
    assert.ok(def, `catalog is missing ${name}`);
    assert.ok(!def.capabilities.includes('docker'), `${name} must not claim docker`);
  }
});

// --- Capability vocabulary (ADR-033 static gate) ---

test('every catalog capability is drawn from the known vocabulary', () => {
  for (const f of allFlavors()) {
    assert.ok(
      areCapabilitiesKnown(f.capabilities),
      `flavor ${f.name} declares an unknown capability: ${f.capabilities.join(', ')}`,
    );
  }
});

test('an unknown capability is rejected by the vocabulary check', () => {
  assert.equal(areCapabilitiesKnown(['docker']), true);
  assert.equal(areCapabilitiesKnown(['gpu']), false);
  assert.equal(areCapabilitiesKnown(['docker', 'gpu']), false);
  assert.equal(areCapabilitiesKnown([]), true);
});

test('each language flavor declares the capability named after it', () => {
  for (const name of ['node', 'python', 'java', 'go', 'rust', 'docker']) {
    const def = allFlavors().find((f) => f.name === name);
    assert.ok(def.capabilities.includes(name), `${name} should declare the '${name}' capability`);
    assert.ok(KNOWN_CAPABILITIES.includes(name));
  }
});

test('most-specific LCA label wins over base', () => {
  // Both lambda-ci and lambda-ci-docker present → docker (longer label).
  assert.equal(resolveFlavor(['self-hosted', 'lambda-ci', 'lambda-ci-docker']).flavor, 'docker');
});

test('matching is case-insensitive', () => {
  assert.equal(resolveFlavor(['Lambda-CI']).flavor, 'base');
  assert.equal(resolveFlavor(['LAMBDA-CI-DOCKER']).flavor, 'docker');
});

// --- Fallback (resolution step 4) ---

test('unknown labels fall back to base', () => {
  assert.equal(resolveFlavor(['ubuntu-latest']).flavor, 'base');
  assert.equal(resolveFlavor([]).flavor, 'base');
});

test('a near-miss language label does not resolve to that flavor', () => {
  // `lambda-ci-python3` is not a catalog label; it must fall back rather than fuzzy-match.
  assert.equal(resolveFlavor(['lambda-ci-python3']).flavor, 'base');
});

test('fallback reason is recorded', () => {
  const r = resolveFlavor(['ubuntu-latest']);
  assert.equal(r.flavor, 'base');
  assert.match(r.reason, /fallback/i);
});

// --- FlavorMap override (resolution step 1) ---

test('FlavorMap override takes precedence over explicit label', () => {
  const r = resolveFlavor(['lambda-ci'], { flavorMap: { 'lambda-ci': 'docker' } });
  assert.equal(r.flavor, 'docker');
  assert.match(r.reason, /FlavorMap/);
});

test('FlavorMap override matches custom repo labels', () => {
  const r = resolveFlavor(['big-runner'], { flavorMap: { 'big-runner': 'node' } });
  assert.equal(r.flavor, 'node');
});

test('FlavorMap can map a GitHub standard label onto a new language flavor', () => {
  // The zero-YAML-edit path an operator actually configures in the console.
  const r = resolveFlavor(['ubuntu-latest'], { flavorMap: { 'ubuntu-latest': 'python' } });
  assert.equal(r.flavor, 'python');
  assert.match(r.reason, /FlavorMap/);
});

test('repo defaultFlavor accepts a new language flavor', () => {
  assert.equal(resolveFlavor(['self-hosted'], { defaultFlavor: 'go' }).flavor, 'go');
});

test('FlavorMap override key match is case-insensitive', () => {
  assert.equal(resolveFlavor(['Big-Runner'], { flavorMap: { 'big-runner': 'node' } }).flavor, 'node');
});

test('FlavorMap override to an unknown flavor is ignored', () => {
  // Falls through to explicit-label handling.
  assert.equal(resolveFlavor(['lambda-ci-node'], { flavorMap: { 'lambda-ci-node': 'bogus' } }).flavor, 'node');
});

// --- Signal-based upgrade (resolution step 3) ---

test('base flavor upgrades to docker when docker signal present', () => {
  const r = resolveFlavor(['lambda-ci'], { signals: { needs_docker: true } });
  assert.equal(r.flavor, 'docker');
  assert.match(r.reason, /upgraded.*docker/i);
});

test('docker-capable flavor is not upgraded again', () => {
  const r = resolveFlavor(['lambda-ci-docker'], { signals: { needs_docker: true } });
  assert.equal(r.flavor, 'docker');
  assert.doesNotMatch(r.reason, /upgraded/i);
});

test('node flavor upgrades to docker when docker signal present', () => {
  // node lacks docker capability → upgrade to smallest docker-capable flavor.
  const r = resolveFlavor(['lambda-ci-node'], { signals: { needs_docker: true } });
  assert.equal(r.flavor, 'docker');
});

test('fallback base upgrades to docker under docker signal', () => {
  assert.equal(resolveFlavor(['ubuntu-latest'], { signals: { needs_docker: true } }).flavor, 'docker');
});

// --- Per-repo defaultFlavor fallback (console config, M4 review fix) ----------
// The console writes `defaultFlavor` on the repo row; before this fix nothing read it, so
// the operator's choice silently did nothing and every unlabeled job landed on `base`.

test('repo defaultFlavor replaces the base fallback', () => {
  const res = resolveFlavor(['self-hosted'], { defaultFlavor: 'node' });
  assert.equal(res.flavor, 'node');
  assert.match(res.reason, /defaultFlavor/);
});

test('an explicit LCA label still beats defaultFlavor', () => {
  assert.equal(resolveFlavor(['lambda-ci'], { defaultFlavor: 'node' }).flavor, 'base');
});

test('a FlavorMap entry still beats defaultFlavor', () => {
  const res = resolveFlavor(['big'], { flavorMap: { big: 'docker' }, defaultFlavor: 'node' });
  assert.equal(res.flavor, 'docker');
});

test('an unknown defaultFlavor falls back to base rather than an invalid flavor', () => {
  const res = resolveFlavor(['self-hosted'], { defaultFlavor: 'gpu-mega' });
  assert.equal(res.flavor, 'base');
});

test('signal upgrade still applies on top of defaultFlavor', () => {
  const res = resolveFlavor(['self-hosted'], {
    defaultFlavor: 'node',
    signals: { needs_docker: true },
  });
  assert.equal(res.flavor, 'docker');
});
