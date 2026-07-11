// Unit tests for the installation lifecycle planner (src/ingest/install-filter.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInstallation } from '../dist/src/ingest/install-filter.js';

function evt(action, extra = {}) {
  return {
    action,
    installation: { id: 555, account: { login: 'octo', id: 1 } },
    ...extra,
  };
}

test('installation.created upserts the install and enables granted repos', () => {
  const repos = [{ id: 1, name: 'a', full_name: 'octo/a' }];
  const intent = planInstallation(evt('created', { repositories: repos }));
  assert.deepEqual(intent.upsertInstallation, {
    installationId: 555,
    accountLogin: 'octo',
    accountId: 1,
    suspended: false,
    deleted: false,
  });
  assert.equal(intent.enableRepos.installationId, 555);
  assert.deepEqual(intent.enableRepos.repos, repos);
});

test('installation.deleted soft-deletes the install', () => {
  const intent = planInstallation(evt('deleted'));
  assert.deepEqual(intent.setFlags, { installationId: 555, deleted: true });
  assert.equal(intent.upsertInstallation, undefined);
});

test('installation.suspend / unsuspend flip the suspended flag', () => {
  assert.deepEqual(planInstallation(evt('suspend')).setFlags, {
    installationId: 555,
    suspended: true,
  });
  assert.deepEqual(planInstallation(evt('unsuspend')).setFlags, {
    installationId: 555,
    suspended: false,
  });
});

test('installation_repositories.added enables the added repos', () => {
  const added = [{ id: 2, name: 'b', full_name: 'octo/b' }];
  const intent = planInstallation(evt('added', { repositories_added: added }));
  assert.deepEqual(intent.enableRepos.repos, added);
});

test('installation_repositories.removed disables the removed repo ids', () => {
  const removed = [{ id: 2, name: 'b', full_name: 'octo/b' }, { id: 3, name: 'c', full_name: 'octo/c' }];
  const intent = planInstallation(evt('removed', { repositories_removed: removed }));
  assert.deepEqual(intent.disableRepoIds, { installationId: 555, repoIds: [2, 3] });
});

test('new_permissions_accepted is a no-op', () => {
  assert.deepEqual(planInstallation(evt('new_permissions_accepted')), {});
});

test('created with no repositories only upserts the install', () => {
  const intent = planInstallation(evt('created'));
  assert.ok(intent.upsertInstallation);
  assert.equal(intent.enableRepos, undefined);
});
