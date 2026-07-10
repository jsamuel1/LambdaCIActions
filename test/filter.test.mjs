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
    workflow_job: { id: 42, run_id: 7, labels: ['lambda-ci'], name: 'build', status: 'queued' },
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
  });
});

test('dedupe key is stable and combines repo/run/job', () => {
  assert.equal(dedupeKey(99, 7, 42), '99:7:42');
});
