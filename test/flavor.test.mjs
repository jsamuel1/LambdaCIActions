// Unit tests for label → flavor resolution (src/provision/flavor.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlavor } from '../dist/src/provision/flavor.js';

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
