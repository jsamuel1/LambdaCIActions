// Unit tests for the pure discovery triggers (src/discover/filter.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushTouchesWorkflows,
  pushToDiscoveryRequest,
  installationToDiscoveryRequests,
} from '../dist/src/discover/filter.js';

function push(overrides = {}) {
  return {
    ref: 'refs/heads/main',
    repository: { id: 99, name: 'repo', full_name: 'octo/repo', owner: { login: 'octo' } },
    installation: { id: 555 },
    commits: [],
    head_commit: null,
    ...overrides,
  };
}

test('detects workflow changes in any commit list (added/removed/modified)', () => {
  for (const key of ['added', 'removed', 'modified']) {
    const evt = push({ commits: [{ [key]: ['.github/workflows/ci.yml'] }] });
    assert.equal(pushTouchesWorkflows(evt), true, key);
  }
});

test('ignores pushes not touching .github/workflows/', () => {
  const evt = push({
    commits: [{ modified: ['src/app.ts', '.github/dependabot.yml'], added: ['README.md'] }],
  });
  assert.equal(pushTouchesWorkflows(evt), false);
});

test('falls back to head_commit when commits array is empty (force push)', () => {
  const evt = push({ commits: [], head_commit: { modified: ['.github/workflows/ci.yaml'] } });
  assert.equal(pushTouchesWorkflows(evt), true);
});

test('no commits at all → no workflow change', () => {
  assert.equal(pushTouchesWorkflows(push()), false);
});

test('projects a push into a discovery request', () => {
  const req = pushToDiscoveryRequest(push());
  assert.deepEqual(req, {
    installationId: 555,
    repoId: 99,
    repoFullName: 'octo/repo',
    owner: 'octo',
    repo: 'repo',
    reason: 'push',
  });
});

test('push without installation → undefined (not app-delivered)', () => {
  assert.equal(pushToDiscoveryRequest(push({ installation: undefined })), undefined);
});

test('installation.created fans out one request per granted repo', () => {
  const reqs = installationToDiscoveryRequests({
    action: 'created',
    installation: { id: 7, account: { login: 'octo', id: 1 } },
    repositories: [
      { id: 1, name: 'a', full_name: 'octo/a' },
      { id: 2, name: 'b', full_name: 'octo/b' },
    ],
  });
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs[0], {
    installationId: 7,
    repoId: 1,
    repoFullName: 'octo/a',
    owner: 'octo',
    repo: 'a',
    reason: 'installation',
  });
});

test('installation_repositories.added uses repositories_added', () => {
  const reqs = installationToDiscoveryRequests({
    action: 'added',
    installation: { id: 7, account: { login: 'octo', id: 1 } },
    repositories_added: [{ id: 3, name: 'c', full_name: 'octo/c' }],
  });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].repoId, 3);
});

test('removal / unrelated actions produce no discovery requests', () => {
  for (const action of ['removed', 'deleted', 'suspend']) {
    const reqs = installationToDiscoveryRequests({
      action,
      installation: { id: 7, account: { login: 'octo', id: 1 } },
      repositories_removed: [{ id: 4, name: 'd', full_name: 'octo/d' }],
    });
    assert.equal(reqs.length, 0, action);
  }
});
