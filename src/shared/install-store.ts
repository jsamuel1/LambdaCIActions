import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { InstallationRecord, RepoRecord, RepoRef, RepoMode } from './types.js';

/**
 * Installation store (spec 01 \u00a7 Installation lifecycle, ADR-009). Upserts installation +
 * granted-repo rows in the shared table, sharing the installation partition:
 *
 *   PK=`INSTALL#<installationId>`  SK=`INSTALL`         \u2192 the installation
 *   PK=`INSTALL#<installationId>`  SK=`REPO#<repoId>`   \u2192 a granted repo
 *
 * Suspension / uninstall are soft state (`suspended`, `deleted`, `enabled=false`) so the
 * hot path can cheaply gate claiming without deleting run history.
 */

const client = DynamoDBClient ? new DynamoDBClient({}) : undefined;
const doc = client ? DynamoDBDocumentClient.from(client) : undefined;
const TABLE = process.env.TABLE_NAME;

// ---- pure key helpers ------------------------------------------------------

export function installPk(installationId: number): string {
  return `INSTALL#${installationId}`;
}
export const INSTALL_SK = 'INSTALL';
export function repoSk(repoId: number): string {
  return `REPO#${repoId}`;
}

/**
 * GSI1 keys for installation rows (M4). GSI1 is otherwise the run status/time index; the
 * management UI needs to ENUMERATE installations, and a single fixed partition
 * (`INSTALLS`) sorted by account login gives that without a table scan. Installations are
 * few (one per GitHub org/user that installed the App), so one partition is fine.
 */
export const INSTALLS_GSI1PK = 'INSTALLS';

function requireDoc(): DynamoDBDocumentClient {
  if (!doc || !TABLE) {
    throw new Error('install-store not configured: TABLE_NAME env + DynamoDB SDK required');
  }
  return doc;
}

// ---- operations ------------------------------------------------------------

/** Upsert the installation row (created / unsuspend / reactivation). */
export async function upsertInstallation(input: {
  installationId: number;
  accountLogin: string;
  accountId: number;
  suspended?: boolean;
  deleted?: boolean;
}): Promise<void> {
  const iso = new Date().toISOString();
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: installPk(input.installationId), sk: INSTALL_SK },
      UpdateExpression:
        'SET entity = :e, installationId = :iid, accountLogin = :login, accountId = :aid, ' +
        'suspended = :susp, deleted = :del, updatedAt = :now, createdAt = if_not_exists(createdAt, :now), ' +
        'gsi1pk = :gpk, gsi1sk = :login',
      ExpressionAttributeValues: {
        ':e': 'INSTALL',
        ':iid': input.installationId,
        ':login': input.accountLogin,
        ':aid': input.accountId,
        ':susp': input.suspended ?? false,
        ':del': input.deleted ?? false,
        ':now': iso,
        ':gpk': INSTALLS_GSI1PK,
      },
    }),
  );
}

/** Flip an installation's suspended / deleted flags (suspend/unsuspend/uninstall). */
export async function setInstallationFlags(
  installationId: number,
  flags: { suspended?: boolean; deleted?: boolean },
): Promise<void> {
  const iso = new Date().toISOString();
  const sets = ['updatedAt = :now'];
  const values: Record<string, unknown> = { ':now': iso };
  if (flags.suspended !== undefined) {
    sets.push('suspended = :susp');
    values[':susp'] = flags.suspended;
  }
  if (flags.deleted !== undefined) {
    sets.push('deleted = :del');
    values[':del'] = flags.deleted;
  }
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: INSTALL_SK },
      UpdateExpression: `SET ${sets.join(', ')}`,
      // Only touch a row that exists; a flag flip for an unknown install is a no-op.
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: values,
    }),
  ).catch((err) => {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  });
}

/** Upsert a granted repo as enabled (install.created / repositories.added). */
export async function enableRepo(installationId: number, repo: RepoRef): Promise<void> {
  const iso = new Date().toISOString();
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: repoSk(repo.id) },
      UpdateExpression:
        'SET entity = :e, installationId = :iid, repoId = :rid, repoFullName = :name, ' +
        'enabled = :enabled, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: {
        ':e': 'REPO',
        ':iid': installationId,
        ':rid': repo.id,
        ':name': repo.full_name,
        ':enabled': true,
        ':now': iso,
      },
    }),
  );
}

/** Disable a repo (repositories.removed) \u2014 stop claiming its jobs, keep the row. */
export async function disableRepo(installationId: number, repoId: number): Promise<void> {
  const iso = new Date().toISOString();
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: repoSk(repoId) },
      UpdateExpression: 'SET enabled = :false, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':false': false, ':now': iso },
    }),
  ).catch((err) => {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  });
}

/** Read the installation record (or undefined). */
export async function getInstallation(
  installationId: number,
): Promise<InstallationRecord | undefined> {
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: INSTALL_SK },
    }),
  );
  return res.Item as unknown as InstallationRecord | undefined;
}

/** Read a repo record (or undefined). */
export async function getRepo(
  installationId: number,
  repoId: number,
): Promise<RepoRecord | undefined> {
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: repoSk(repoId) },
    }),
  );
  return res.Item as unknown as RepoRecord | undefined;
}

// ---- M4 management reads / config writes -----------------------------------

/**
 * Enumerate every installation (management UI). Uses the GSI1 `INSTALLS` partition, so no
 * table scan. Includes soft-deleted/suspended rows — the UI shows their state.
 */
export async function listInstallations(): Promise<InstallationRecord[]> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gpk',
      ExpressionAttributeValues: { ':gpk': INSTALLS_GSI1PK },
    }),
  );
  return (res.Items ?? []) as unknown as InstallationRecord[];
}

/** List the repos granted to one installation (Repos screen). */
export async function listRepos(installationId: number): Promise<RepoRecord[]> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :repo)',
      ExpressionAttributeValues: { ':pk': installPk(installationId), ':repo': 'REPO#' },
    }),
  );
  return (res.Items ?? []) as unknown as RepoRecord[];
}

/** Config fields an operator may change from the UI (spec 04 `PATCH /api/repos/{id}`). */
export interface RepoConfigPatch {
  enabled?: boolean;
  mode?: RepoMode;
  /** A known flavor name, or `null` to clear the override (revert to catalog default). */
  defaultFlavor?: string | null;
  flavorMap?: Record<string, string>;
}

/**
 * Apply an operator config patch to a repo row, recording the actor + timestamp
 * (spec 04 § Non-functional → auditability). Returns the updated row, or undefined when
 * the repo row doesn't exist (the caller answers 404 rather than creating config for a
 * repo the App was never granted).
 */
export async function patchRepoConfig(
  installationId: number,
  repoId: number,
  patch: RepoConfigPatch,
  actor: string,
): Promise<RepoRecord | undefined> {
  const iso = new Date().toISOString();
  const sets = ['updatedAt = :now', 'updatedBy = :actor'];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ':now': iso, ':actor': actor };

  if (patch.enabled !== undefined) {
    sets.push('enabled = :enabled');
    values[':enabled'] = patch.enabled;
  }
  if (patch.mode !== undefined) {
    sets.push('#mode = :mode');
    values[':mode'] = patch.mode;
  }
  if (patch.defaultFlavor !== undefined) {
    if (patch.defaultFlavor === null) {
      // Clear the override — REMOVE the attribute so provisioning's `repo?.defaultFlavor`
      // falls back to the catalog default rather than reading a stale value.
      removes.push('defaultFlavor');
    } else {
      sets.push('defaultFlavor = :df');
      values[':df'] = patch.defaultFlavor;
    }
  }
  if (patch.flavorMap !== undefined) {
    sets.push('flavorMap = :fm');
    values[':fm'] = patch.flavorMap;
  }

  try {
    const res = await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(installationId), sk: repoSk(repoId) },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: 'attribute_exists(pk)',
        ...(patch.mode !== undefined
          ? { ExpressionAttributeNames: { '#mode': 'mode' } }
          : {}),
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return res.Attributes as unknown as RepoRecord | undefined;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return undefined;
    throw err;
  }
}
