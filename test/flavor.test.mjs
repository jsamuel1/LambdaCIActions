// Unit tests for label → flavor resolution (src/provision/flavor.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlavor } from '../dist/src/provision/flavor.js';

test('base label resolves to base flavor', () => {
  assert.equal(resolveFlavor(['lambda-ci']), 'base');
});

test('unknown labels fall back to base', () => {
  assert.equal(resolveFlavor(['ubuntu-latest']), 'base');
  assert.equal(resolveFlavor([]), 'base');
});

test('matching is case-insensitive', () => {
  assert.equal(resolveFlavor(['Lambda-CI']), 'base');
});
