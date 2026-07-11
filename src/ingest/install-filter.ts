import type { InstallationEvent } from '../shared/types.js';

/**
 * Normalize an `installation` / `installation_repositories` webhook into the concrete
 * store mutations the Ingest handler should apply (spec 01 \u00a7 Installation lifecycle).
 * Pure \u2014 unit-tested without AWS; the handler just executes the returned intents.
 */

export interface InstallIntent {
  /** Upsert the installation row (created / unsuspend). */
  upsertInstallation?: {
    installationId: number;
    accountLogin: string;
    accountId: number;
    suspended: boolean;
    deleted: boolean;
  };
  /** Flip suspended/deleted flags on an existing installation. */
  setFlags?: { installationId: number; suspended?: boolean; deleted?: boolean };
  /** Repos to enable (created / added). */
  enableRepos?: { installationId: number; repos: InstallationEvent['repositories'] };
  /** Repo ids to disable (removed). */
  disableRepoIds?: { installationId: number; repoIds: number[] };
}

export function planInstallation(evt: InstallationEvent): InstallIntent {
  const installationId = evt.installation.id;
  const accountLogin = evt.installation.account.login;
  const accountId = evt.installation.account.id;
  const intent: InstallIntent = {};

  switch (evt.action) {
    case 'created':
      intent.upsertInstallation = {
        installationId,
        accountLogin,
        accountId,
        suspended: false,
        deleted: false,
      };
      if (evt.repositories?.length) {
        intent.enableRepos = { installationId, repos: evt.repositories };
      }
      break;

    case 'deleted':
      intent.setFlags = { installationId, deleted: true };
      break;

    case 'suspend':
      intent.setFlags = { installationId, suspended: true };
      break;

    case 'unsuspend':
      intent.setFlags = { installationId, suspended: false };
      break;

    case 'added':
      if (evt.repositories_added?.length) {
        intent.enableRepos = { installationId, repos: evt.repositories_added };
      }
      break;

    case 'removed':
      if (evt.repositories_removed?.length) {
        intent.disableRepoIds = {
          installationId,
          repoIds: evt.repositories_removed.map((r) => r.id),
        };
      }
      break;

    // new_permissions_accepted and anything else: no state change.
    default:
      break;
  }
  return intent;
}
