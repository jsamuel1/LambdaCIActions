import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { InstallationRecord, RepoRecord, RepoRef } from './types.js';

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
        'suspended = :susp, deleted = :del, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: {
        ':e': 'INSTALL',
        ':iid': input.installationId,
        ':login': input.accountLogin,
        ':aid': input.accountId,
        ':susp': input.suspended ?? false,
        ':del': input.deleted ?? false,
        ':now': iso,
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
