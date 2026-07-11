// Unit tests for the reaper's pure decision logic (src/reaper/reap.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  overCapVms,
  reconcileRuns,
  DEFAULT_REAPER_CONFIG,
} from '../dist/src/reaper/reap.js';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const cfg = DEFAULT_REAPER_CONFIG;

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

test('overCapVms terminates only VMs past the lifetime cap', () => {
  const vms = [
    { microvmId: 'young', launchedAt: NOW - 60_000 }, // 1m old
    { microvmId: 'old', launchedAt: NOW - cfg.maxLifetimeMs - 1000 }, // past cap
    { microvmId: 'unknown-age' }, // no launchedAt → skipped
  ];
  const over = overCapVms(vms, cfg, NOW);
  assert.deepEqual(over.map((v) => v.microvmId), ['old']);
});

test('reconcileRuns times out running runs with no live VM past the grace period', () => {
  const runs = [
    { repoId: 1, runId: 100, jobId: 1, status: 'running', updatedAt: iso(cfg.orphanGraceMs + 60_000), labels: [] },
  ];
  const live = new Set(); // no live VM for run 100
  const out = reconcileRuns(runs, live, cfg, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].to, 'timed_out');
  assert.equal(out[0].run.runId, 100);
});

test('reconcileRuns leaves running runs that still have a live VM', () => {
  const runs = [
    { repoId: 1, runId: 100, jobId: 1, status: 'running', updatedAt: iso(cfg.orphanGraceMs + 60_000), labels: [] },
  ];
  const live = new Set([100]);
  assert.equal(reconcileRuns(runs, live, cfg, NOW).length, 0);
});

test('reconcileRuns keeps recently-updated running runs within the grace window', () => {
  const runs = [
    { repoId: 1, runId: 100, jobId: 1, status: 'running', updatedAt: iso(30_000), labels: [] },
  ];
  assert.equal(reconcileRuns(runs, new Set(), cfg, NOW).length, 0);
});

test('reconcileRuns fails runs stuck in provisioning past the threshold', () => {
  const runs = [
    { repoId: 1, runId: 200, jobId: 1, status: 'provisioning', updatedAt: iso(cfg.stuckProvisioningMs + 1000), labels: [] },
  ];
  const out = reconcileRuns(runs, new Set(), cfg, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].to, 'failed');
  assert.match(out[0].reason, /quota wall/);
});

test('reconcileRuns fails runs stuck in queued past the threshold', () => {
  const runs = [
    { repoId: 1, runId: 300, jobId: 1, status: 'queued', updatedAt: iso(cfg.stuckProvisioningMs + 1000), labels: [] },
  ];
  const out = reconcileRuns(runs, new Set(), cfg, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].to, 'failed');
});

test('reconcileRuns leaves fresh provisioning runs alone', () => {
  const runs = [
    { repoId: 1, runId: 200, jobId: 1, status: 'provisioning', updatedAt: iso(60_000), labels: [] },
  ];
  assert.equal(reconcileRuns(runs, new Set(), cfg, NOW).length, 0);
});
