// Unit tests for the workflow_job claim filter + provision projection (src/ingest/filter.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldClaim, toProvisionRequest, dedupeKey } from '../dist/src/ingest/filter.js';

const CLAIMED = ['lambda-ci', 'lambda-ci-docker'];

function job(action, labels) {
  return { action, workflow_job: { labels } };
}

test('claims a queued job carrying our label', () => {
  assert.equal(shouldClaim(job('queued', ['lambda-ci']), CLAIMED), true);
});

test('claims case-insensitively', () => {
  assert.equal(shouldClaim(job('queued', ['LAMBDA-CI']), CLAIMED), true);
});

test('does not claim non-queued actions', () => {
  assert.equal(shouldClaim(job('in_progress', ['lambda-ci']), CLAIMED), false);
  assert.equal(shouldClaim(job('completed', ['lambda-ci']), CLAIMED), false);
});

test('does not claim jobs without our label', () => {
  assert.equal(shouldClaim(job('queued', ['ubuntu-latest']), CLAIMED), false);
  assert.equal(shouldClaim(job('queued', []), CLAIMED), false);
});

test('projects a webhook event into a provision request', () => {
  const event = {
    action: 'queued',
    workflow_job: {
      id: 42,
      run_id: 7,
      labels: ['lambda-ci'],
      name: 'build',
      status: 'queued',
      workflow_name: 'CI',
    },
    repository: { id: 99, name: 'repo', full_name: 'octo/repo', owner: { login: 'octo' } },
    installation: { id: 555 },
  };
  const req = toProvisionRequest(event);
  assert.deepEqual(req, {
    installationId: 555,
    repoId: 99,
    repoFullName: 'octo/repo',
    owner: 'octo',
    repo: 'repo',
    runId: 7,
    jobId: 42,
    labels: ['lambda-ci'],
    jobName: 'build',
    workflowName: 'CI',
  });
});

test('workflowName defaults to null when the webhook omits it', () => {
  const event = {
    action: 'queued',
    workflow_job: { id: 1, run_id: 2, labels: [], name: 'j', status: 'queued' },
    repository: { id: 3, name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    installation: { id: 4 },
  };
  assert.equal(toProvisionRequest(event).workflowName, null);
});

test('dedupe key is stable and combines repo/run/job', () => {
  assert.equal(dedupeKey(99, 7, 42), '99:7:42');
});

// --- Repo opt-out gate (console `enabled` / `mode`, M4 review fix) -------------
// The management API only WRITES repo config; Ingest is the enforcement point. Without
// this, the console's Disable button and `mode: off` were cosmetic.
import { isRepoOptedOut } from '../dist/src/ingest/filter.js';

test('a repo disabled from the console is opted out', () => {
  assert.equal(isRepoOptedOut({ enabled: false, mode: 'label' }), true);
});

test('mode=off opts a repo out even while enabled', () => {
  assert.equal(isRepoOptedOut({ enabled: true, mode: 'off' }), true);
});

test('an enabled repo in label/adopt mode is claimed', () => {
  assert.equal(isRepoOptedOut({ enabled: true, mode: 'label' }), false);
  assert.equal(isRepoOptedOut({ enabled: true, mode: 'adopt' }), false);
  assert.equal(isRepoOptedOut({ enabled: true }), false, 'absent mode ⇒ label default');
});

test('a missing repo row fails OPEN (pre-M4 rows must still run)', () => {
  assert.equal(isRepoOptedOut(undefined), false);
});
