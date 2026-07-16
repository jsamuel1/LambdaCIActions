import type { DiscoveryRequest, InstallationEvent, PushEvent, RepoRef } from '../shared/types.js';

/**
 * Pure discovery-trigger helpers (spec 03 § Discovery). Decide WHEN a repo (re)scan fires;
 * the actual fetching/parsing happens in the Discovery λ. No I/O here.
 */

const WORKFLOWS_PREFIX = '.github/workflows/';

/**
 * Does a `push` event touch `.github/workflows/**`?
 *
 * Checks added/removed/modified across all commits (falling back to `head_commit` when
 * the commits array is empty, e.g. a force-push payload).
 */
export function pushTouchesWorkflows(evt: PushEvent): boolean {
  const commits = evt.commits && evt.commits.length > 0
    ? evt.commits
    : evt.head_commit
      ? [evt.head_commit]
      : [];
  for (const c of commits) {
    for (const list of [c.added, c.removed, c.modified]) {
      if (list?.some((p) => p.startsWith(WORKFLOWS_PREFIX))) return true;
    }
  }
  return false;
}

/** Project a workflow-touching push into a discovery request. */
export function pushToDiscoveryRequest(evt: PushEvent): DiscoveryRequest | undefined {
  if (!evt.installation) return undefined; // not delivered via an app installation
  const [owner, repo] = evt.repository.full_name.split('/');
  return {
    installationId: evt.installation.id,
    repoId: evt.repository.id,
    repoFullName: evt.repository.full_name,
    owner,
    repo,
    reason: 'push',
  };
}

/**
 * Discovery requests for repos granted by an installation event (installation.created /
 * installation_repositories.added) — parse all newly-granted repos (spec 03).
 */
export function installationToDiscoveryRequests(evt: InstallationEvent): DiscoveryRequest[] {
  let repos: RepoRef[] | undefined;
  if (evt.action === 'created') repos = evt.repositories;
  else if (evt.action === 'added') repos = evt.repositories_added;
  if (!repos) return [];
  return repos.map((r) => {
    const [owner, repo] = r.full_name.split('/');
    return {
      installationId: evt.installation.id,
      repoId: r.id,
      repoFullName: r.full_name,
      owner,
      repo,
      reason: 'installation' as const,
    };
  });
}
