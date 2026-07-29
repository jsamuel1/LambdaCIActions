// Adopt mode must resolve the SAME flavor+reason everywhere it is computed (M5, ADR-030).
//
// The flavor for a job is resolved in two places against two different inputs:
//   - Provision, at claim time, from the live repo row (`mode`) — what actually runs.
//   - Discovery, at scan time, stored as `routes[jobId]` — what the console renders and what
//     the auto-rewrite planner (ADR-031) reads to pick the label it writes into a customer PR.
//
// If Discovery omits `mode`, an adopt-mode repo's `ubuntu-latest` jobs miss the adopt map and
// land on the FALLBACK, so the stored reason reads `fallback to base (no matching label)` for a
// repo whose whole configuration is "claim these labels". Same flavor by luck (`base`), wrong
// explanation — and it stops being luck the moment a repo sets `defaultFlavor`, which the
// fallback honours and the adopt map does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFlavor } from '../dist/src/provision/flavor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const discoverSrc = fs.readFileSync(path.join(ROOT, 'src', 'discover', 'handler.ts'), 'utf8');
const mgmtSrc = fs.readFileSync(path.join(ROOT, 'src', 'mgmt', 'handler.ts'), 'utf8');

test('adopt mode routes a hosted label through the adopt map, not the fallback', () => {
  const r = resolveFlavor(['ubuntu-latest'], { mode: 'adopt' });
  assert.equal(r.flavor, 'base');
  assert.match(r.reason, /adopt-mode standard label/);
  assert.doesNotMatch(r.reason, /fallback/i);
});

test("adopt mode ignores defaultFlavor for a hosted label; the fallback does not", () => {
  // This is the case where the missing `mode` changes the FLAVOR, not just the wording: the
  // fallback honours the repo's operator-chosen defaultFlavor, the adopt map does not.
  assert.equal(resolveFlavor(['ubuntu-latest'], { mode: 'adopt', defaultFlavor: 'node' }).flavor, 'base');
  assert.equal(resolveFlavor(['ubuntu-latest'], { defaultFlavor: 'node' }).flavor, 'node');
});

test('Discovery resolves with the repo mode, so stored routes match what Provision will do', () => {
  assert.match(discoverSrc, /const mode = repoRecord\?\.mode;/);
  const resolveFn = discoverSrc.slice(
    discoverSrc.indexOf('const resolveFn ='),
    discoverSrc.indexOf('const compat ='),
  );
  assert.match(resolveFn, /mode/, 'discovery must thread the repo mode into resolveFlavor');
});

test('a mode change re-scans the repo so stored routes stop being stale', () => {
  // Without this the operator flips to adopt and the console still shows every hosted-label
  // job as `fallback to base (no matching label)` until someone happens to push a workflow.
  const patch = mgmtSrc.slice(
    mgmtSrc.indexOf("case 'patchRepo':"),
    mgmtSrc.indexOf("case 'listWorkflows':"),
  );
  assert.match(patch, /parsed\.value\.mode !== undefined/);
  assert.match(patch, /enqueueRescan\(/);
  // Best-effort: the config write already succeeded, so a failed enqueue must not 5xx it.
  assert.match(patch, /\.catch\(/);
});
