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

/**
 * GSI1 keys for an installation row. Pure so a test can assert every write path stamps
 * them — an unstamped row is invisible to `listInstallations` and the console shows an
 * empty Setup screen while the platform happily runs that installation's jobs.
 */
export function installGsi1Keys(accountLogin: string): { gsi1pk: string; gsi1sk: string } {
  return { gsi1pk: INSTALLS_GSI1PK, gsi1sk: accountLogin };
}

/**
 * Whether a row fetched BY PRIMARY KEY (`INSTALL#<id>` / `INSTALL`) still needs its GSI1
 * stamp. Deliberately does NOT check `entity`: the key already proves the row is an
 * installation, and `entity` is an optional attribute on the record type — gating the repair
 * on it would leave a row that lacks it permanently invisible. The backfill script selects
 * on the same signal (key shape, not `entity`) so the two paths repair the same row set.
 * `accountLogin` IS the `gsi1sk`, so a row without one cannot be indexed meaningfully.
 */
export function needsIndexRepair(row: { gsi1pk?: string; accountLogin?: string }): boolean {
  return row.gsi1pk !== INSTALLS_GSI1PK && Boolean(row.accountLogin);
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
  await requireDoc().send(new UpdateCommand(buildInstallUpsert(input, new Date())));
}

/**
 * Pure builder for the installation upsert. Extracted so a test can assert the write ALWAYS
 * carries the GSI1 keys — a write path that forgets them makes the installation invisible to
 * `listInstallations` (the M2 → M4 regression behind ADR-037).
 */
export function buildInstallUpsert(
  input: {
    installationId: number;
    accountLogin: string;
    accountId: number;
    suspended?: boolean;
    deleted?: boolean;
  },
  now: Date,
): {
  TableName: string | undefined;
  Key: Record<string, unknown>;
  UpdateExpression: string;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  const iso = now.toISOString();
  const gsi = installGsi1Keys(input.accountLogin);
  return {
    TableName: TABLE,
    Key: { pk: installPk(input.installationId), sk: INSTALL_SK },
    UpdateExpression:
      'SET entity = :e, installationId = :iid, accountLogin = :login, accountId = :aid, ' +
      'suspended = :susp, deleted = :del, updatedAt = :now, createdAt = if_not_exists(createdAt, :now), ' +
      'gsi1pk = :gpk, gsi1sk = :gsk',
    ExpressionAttributeValues: {
      ':e': 'INSTALL',
      ':iid': input.installationId,
      ':login': input.accountLogin,
      ':aid': input.accountId,
      ':susp': input.suspended ?? false,
      ':del': input.deleted ?? false,
      ':now': iso,
      ':gpk': gsi.gsi1pk,
      ':gsk': gsi.gsi1sk,
    },
  };
}

/**
 * Stamp GSI1 keys onto an installation row that lacks them (ADR-037 reconcile-on-read /
 * backfill). Conditional on the row existing so a stale id is a no-op, and on `gsi1pk` being
 * absent so a concurrent repair (or the backfill script) is a no-op rather than a clobber.
 * Returns true when this call actually repaired the row.
 */
export async function repairInstallationIndex(input: {
  installationId: number;
  accountLogin: string;
}): Promise<boolean> {
  const keys = installGsi1Keys(input.accountLogin);
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: INSTALL_SK },
        UpdateExpression: 'SET gsi1pk = :gpk, gsi1sk = :gsk',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(gsi1pk)',
        ExpressionAttributeValues: { ':gpk': keys.gsi1pk, ':gsk': keys.gsi1sk },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
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
 * Enumerate installations for the management UI (ADR-037).
 *
 * Primary path is the GSI1 `INSTALLS` partition — no table scan. But rows written before
 * M4 (commit 63069ff) carry no `gsi1pk`, so they are invisible to that query: the console
 * rendered "you have no installations" for an installation the platform was actively
 * serving. GitHub never re-sends `installation.created`, so it does not self-heal.
 *
 * Fix without a scan: the caller passes the installation ids the session is *already*
 * authorized for (resolved from GitHub at login, ADR-022). Any granted id missing from the
 * index result is fetched by PRIMARY KEY (bounded: one GetItem per grant, and the caller
 * only ever sees rows it is authorized for anyway) and, if found unindexed, repaired in
 * place so the next read hits the index.
 *
 * `reconcileIds` is REQUIRED, deliberately: a default of `[]` would let a future caller
 * write `listInstallations()` and silently reintroduce the exact M2→M4 blindness this
 * fixes. Pass `[]` only where a caller genuinely wants the raw index.
 *
 * Includes soft-deleted/suspended rows — the UI shows their state.
 */
export async function listInstallations(
  reconcileIds: readonly number[],
): Promise<InstallationRecord[]> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gpk',
      ExpressionAttributeValues: { ':gpk': INSTALLS_GSI1PK },
    }),
  );
  const indexed = (res.Items ?? []) as unknown as InstallationRecord[];
  return reconcileInstallations(indexed, reconcileIds, {
    get: getInstallation,
    repair: repairInstallationIndex,
  });
}

/** Injected IO for {@link reconcileInstallations} — the seam the unit test replaces. */
export interface ReconcileDeps {
  get: (installationId: number) => Promise<InstallationRecord | undefined>;
  repair: (input: { installationId: number; accountLogin: string }) => Promise<boolean>;
}

/**
 * Append any authorized-but-unindexed installation to the index result, repairing its index
 * keys as a side effect (ADR-037). Dependency-injected so the fix is unit-testable without
 * DynamoDB — this is the code path that decides whether the console can render an
 * installation the platform is already serving.
 *
 * The repair is guarded by {@link needsIndexRepair}: a row that already carries the stamp, or
 * that has no `accountLogin` to use as `gsi1sk`, is returned but not written.
 */
export async function reconcileInstallations(
  indexed: InstallationRecord[],
  candidateIds: readonly number[],
  deps: ReconcileDeps,
): Promise<InstallationRecord[]> {
  const missing = missingInstallationIds(indexed, candidateIds);
  if (missing.length === 0) return indexed;

  const recovered: InstallationRecord[] = [];
  for (const id of missing) {
    const row = await deps.get(id);
    if (!row) continue; // a grant for an installation we never stored — nothing to show
    recovered.push(row);
    // Only repair a row that is actually missing the stamp. An indexed row can legitimately
    // reach here (a truncated index page), and a row with no `accountLogin` must not be
    // written with an undefined sort key (the backfill script skips the same case). Both
    // leave the row in the response.
    if (!needsIndexRepair(row)) continue;
    // Self-heal so this path costs one GetItem once, not on every poll.
    try {
      const repaired = await deps.repair({
        installationId: id,
        accountLogin: row.accountLogin as string,
      });
      if (repaired) {
        console.log(
          JSON.stringify({
            msg: 'reconciled unindexed installation row',
            installationId: id,
            accountLogin: row.accountLogin,
          }),
        );
      }
    } catch (err) {
      // A failed repair must NOT fail the read — the row is already in the response.
      console.warn(
        JSON.stringify({
          msg: 'installation index repair failed',
          installationId: id,
          error: (err as Error).message,
        }),
      );
    }
  }
  // Sort the merged list by account login — the order GSI1 already returns. Appending
  // recovered rows raw would put a legacy installation last, then move it once the repair
  // lands and the next poll (ADR-026) reads it from the index: the console row would jump.
  return [...indexed, ...recovered].sort(byGsi1sk);
}

/**
 * Order two installation rows the way DynamoDB orders them in the GSI1 `INSTALLS` partition.
 * `gsi1sk` is the account login, and DynamoDB sorts String sort keys by their **UTF-8 bytes**
 * — so this is a byte comparison, deliberately NOT `localeCompare`. GitHub logins may be mixed
 * case, and locale collation puts `abc` before `Acme` while the index puts `Acme` first
 * (uppercase sorts below lowercase in ASCII). Locale order here would reintroduce exactly the
 * row-jump this sort exists to prevent: this response and the next index-served poll (ADR-026)
 * would disagree.
 */
export function byGsi1sk(a: InstallationRecord, b: InstallationRecord): number {
  const x = a.accountLogin ?? '';
  const y = b.accountLogin ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Which authorized installation ids the index did not return — pure, so the reconcile
 * trigger is unit-testable without DynamoDB. De-duplicated, order preserved.
 */
export function missingInstallationIds(
  indexed: readonly { installationId: number }[],
  candidateIds: readonly number[],
): number[] {
  const present = new Set(indexed.map((i) => i.installationId));
  const out: number[] = [];
  for (const id of candidateIds) {
    if (present.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
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
