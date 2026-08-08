import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { decodeCursor, encodeCursor, terminalTtlSeconds } from './run-store.js';
import { type RawCursor } from './cursor.js';
import type { RefusalRecord, RepoMode } from './types.js';

/**
 * Refusal store (ADR-050) — the durable record of a job the platform declined to claim.
 *
 * Lives in the shared table (ADR-009) as its own entity rather than as a run row with a new
 * status, because a refusal is not a run: it has no microVM, no duration, no cost, and must
 * never appear in the active-run count, the health error rate, cost eligibility, or a report's
 * status vocabulary. Keeping it a separate partition means none of those consumers change.
 *
 * Volume control is upstream, in `classifyRefusal`: only ACTIONABLE refusals reach this store.
 * An un-onboarded repo's `ubuntu-latest` jobs answering "no LCA label" are the normal steady
 * state and are logged at debug without a row, so the platform-wide GSI1 partition below stays
 * low-cardinality by construction. That is the reason a single hot partition is acceptable here
 * and would not be for run rows.
 */

const client = DynamoDBClient ? new DynamoDBClient({}) : undefined;
const doc = client ? DynamoDBDocumentClient.from(client) : undefined;

const TABLE = process.env.TABLE_NAME;

export const REFUSAL_SK = 'REFUSAL';

/** Platform-wide GSI1 partition. Distinct from the run store's `RUNSTATUS#<status>` values. */
export const REFUSALS_GSI1PK = 'REFUSALS';

export function refusalPk(repoId: number, runId: number, jobId: number): string {
  return `REFUSAL#${repoId}#${runId}#${jobId}`;
}

/** Per-repo GSI2 partition. Distinct from the run store's `REPORUNS#<repoId>`. */
export function refusalRepoGsi2pk(repoId: number): string {
  return `REPOREFUSALS#${repoId}`;
}

export interface RecordRefusalInput {
  repoId: number;
  repoFullName: string;
  installationId: number;
  runId: number;
  jobId: number;
  code: string;
  reason: string;
  fix?: string;
  labels: string[];
  claimedLabels: string[];
  mode: RepoMode;
  workflowName?: string;
  jobName?: string;
  runnerGroup?: string;
}

/**
 * Build the upsert for a refusal (pure, so the write-once/accumulate semantics are testable
 * without AWS).
 *
 * An UpdateItem, not a Put, and the difference matters twice:
 *   - `firstSeenAt` is `if_not_exists`, so the row remembers when the problem started even as it
 *     keeps recurring. A Put would overwrite it and lose "this has been broken for 7 hours".
 *   - `occurrences` is an `ADD`, so the row distinguishes "this happened once an hour ago" from
 *     "this is still happening on every push" — the difference between a fixed problem and a live
 *     one, which a last-write-wins row cannot express.
 *
 * Both GSI sort keys track `lastSeenAt`, NOT `firstSeenAt`, and both indexes use the same clock.
 * The screen answers "what is broken NOW", so a still-recurring refusal must rise: keying the
 * index on first sight sank a refusal that started hours ago and is still firing below the head
 * page, where no amount of client-side sorting could retrieve it. Two different sort semantics
 * across the two indexes would be worse still — the same list would reorder itself when a repo
 * filter was applied.
 *
 * The cost is a GSI delete+insert per re-delivery instead of an in-place update. Acceptable here
 * only BECAUSE the store is restricted to actionable refusals (`classifyRefusal`): at un-onboarded
 * `ubuntu-latest` volumes it would not be.
 *
 * Everything else IS overwritten: the reason, fix, and especially `claimedLabels` describe the
 * MOST RECENT refusal, which is what an operator is diagnosing. That includes the OPTIONAL
 * attributes: an absent one is `REMOVE`d rather than left alone, because a row is re-written by a
 * later refusal of the SAME (repo, run, job) that can have reached a DIFFERENT gate. The stored
 * analysis is re-read on every delivery, so a re-scan between two deliveries of one queued job can
 * move it from the runner-group gate to the compat gate — and a retained `runnerGroup` would then
 * render "runner group: gpu" underneath a `compat-block` reason, asserting a cause that is no
 * longer the one that refused the job. `REMOVE` of an attribute that was never written is a no-op,
 * so first-write rows are unaffected.
 */
export function buildRefusalUpsert(
  input: RecordRefusalInput,
  now: Date = new Date(),
): {
  key: { pk: string; sk: string };
  updateExpression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  const iso = now.toISOString();
  const setParts = [
    'entity = :entity',
    'gsi1pk = :g1pk',
    'gsi1sk = :now',
    'gsi2pk = :g2pk',
    'gsi2sk = :now',
    'firstSeenAt = if_not_exists(firstSeenAt, :now)',
    'lastSeenAt = :now',
    'repoId = :repoId',
    'repoFullName = :repoFullName',
    'installationId = :installationId',
    'runId = :runId',
    'jobId = :jobId',
    'code = :code',
    'reason = :reason',
    '#labels = :labels',
    'claimedLabels = :claimedLabels',
    '#mode = :mode',
    '#ttl = :ttl',
  ];
  const names: Record<string, string> = {
    // `labels`, `mode` and `ttl` are DynamoDB reserved words.
    '#labels': 'labels',
    '#mode': 'mode',
    '#ttl': 'ttl',
  };
  const values: Record<string, unknown> = {
    ':entity': 'REFUSAL',
    ':g1pk': REFUSALS_GSI1PK,
    ':g2pk': refusalRepoGsi2pk(input.repoId),
    ':now': iso,
    ':repoId': input.repoId,
    ':repoFullName': input.repoFullName,
    ':installationId': input.installationId,
    ':runId': input.runId,
    ':jobId': input.jobId,
    ':code': input.code,
    ':reason': input.reason,
    ':labels': input.labels,
    ':claimedLabels': input.claimedLabels,
    ':mode': input.mode,
    ':ttl': Math.floor(now.getTime() / 1000) + terminalTtlSeconds(),
    ':one': 1,
  };
  // Optional strings are OMITTED from SET rather than written as undefined (a DynamoDB validation
  // error) — and omitted rather than written empty, so an absent workflow name stays absent
  // instead of rendering as a blank cell that looks like a bug in the console. They are then
  // REMOVEd, so this refusal's row cannot carry a previous refusal's leftovers (see the header).
  const removeParts: string[] = [];
  for (const [attr, value] of [
    ['fix', input.fix],
    ['workflowName', input.workflowName],
    ['jobName', input.jobName],
    ['runnerGroup', input.runnerGroup],
  ] as const) {
    if (value === undefined || value === '') {
      removeParts.push(attr);
      continue;
    }
    setParts.push(`${attr} = :${attr}`);
    values[`:${attr}`] = value;
  }
  return {
    key: { pk: refusalPk(input.repoId, input.runId, input.jobId), sk: REFUSAL_SK },
    updateExpression:
      `SET ${setParts.join(', ')}` +
      (removeParts.length ? ` REMOVE ${removeParts.join(', ')}` : '') +
      ' ADD occurrences :one',
    names,
    values,
  };
}

function requireDoc(): DynamoDBDocumentClient {
  if (!doc || !TABLE) {
    throw new Error('refusal-store not configured: TABLE_NAME env + DynamoDB SDK required');
  }
  return doc;
}

/** Upsert a refusal row. Callers treat a failure as best-effort — a webhook must still 2xx. */
export async function recordRefusal(input: RecordRefusalInput): Promise<void> {
  const { key, updateExpression, names, values } = buildRefusalUpsert(input);
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: key,
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * A page of refusals, shaped as `Page<RefusalRecord>` so `collectVisible` consumes it directly.
 *
 * The rows are named `runs` rather than `refusals` deliberately: an adapter in the route
 * (`{ runs: res.refusals, nextCursor: res.nextCursor }`) would have to READ the raw cursor in
 * route code, which is exactly the shape the ADR-052 source guards forbid there — and rightly,
 * since that read is one keystroke from a response body. Conforming to the shared page shape
 * keeps every raw-cursor read on the store side of the boundary.
 */
export interface RefusalPage {
  runs: RefusalRecord[];
  /**
   * The store's index position, typed `RawCursor` so it cannot reach a response body (ADR-052).
   *
   * It matters more here than on the run lists: a refusal key is
   * `REFUSAL#<repoId>#<runId>#<jobId>` plus `lastSeenAt`, and the unclaimed list is walked
   * platform-wide by an installation-filtered caller, so the boundary row this names belongs to
   * an installation the session may not administer as the NORMAL case rather than the edge one.
   */
  nextCursor?: RawCursor;
}

/** Platform-wide refusals, most recently refused first, via GSI1 (`lastSeenAt` sort key). */
export async function listRefusals(
  opts: { limit?: number; cursor?: RawCursor } = {},
): Promise<RefusalPage> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': REFUSALS_GSI1PK },
      ScanIndexForward: false,
      Limit: opts.limit ?? 50,
      ExclusiveStartKey: decodeCursor(opts.cursor),
    }),
  );
  return {
    runs: (res.Items ?? []) as unknown as RefusalRecord[],
    nextCursor: encodeCursor(res.LastEvaluatedKey),
  };
}

/** One repo's refusals, most recently refused first, via GSI2 (same clock as GSI1). */
export async function listRefusalsByRepo(
  repoId: number,
  opts: { limit?: number; cursor?: RawCursor } = {},
): Promise<RefusalPage> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :pk',
      ExpressionAttributeValues: { ':pk': refusalRepoGsi2pk(repoId) },
      ScanIndexForward: false,
      Limit: opts.limit ?? 50,
      ExclusiveStartKey: decodeCursor(opts.cursor),
    }),
  );
  return {
    runs: (res.Items ?? []) as unknown as RefusalRecord[],
    nextCursor: encodeCursor(res.LastEvaluatedKey),
  };
}

/**
 * Count refusal rows without materializing them (Dashboard badge).
 *
 * Paged like `countRunsByStatus`: a single `Select: COUNT` only counts one 1 MB pass, so a busy
 * environment would silently under-report. `exact: false` tells the caller the number is a floor
 * — the badge must not claim "3 unclaimed jobs" when it means "at least 3".
 *
 * `sinceIso` bounds the count by `lastSeenAt` (the GSI1 sort key), and the Dashboard passes it.
 * Without a window the count is every actionable refusal still inside the ADR-033 TTL — 90 days by
 * default — so a single misconfiguration fixed weeks ago would keep the badge red and its banner
 * asserting, in the present tense, that jobs "are not running". A permanently-red indicator is one
 * operators learn to ignore, which is the failure this whole surface exists to avoid. Because the
 * window is a sort-key range and not a filter, skipped rows are never read or paid for.
 */
export async function countRefusals(
  opts: { maxPages?: number; sinceIso?: string } = {},
): Promise<{ count: number; exact: boolean }> {
  const maxPages = opts.maxPages ?? 5;
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await requireDoc().send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'gsi1',
        KeyConditionExpression: opts.sinceIso
          ? 'gsi1pk = :pk AND gsi1sk >= :since'
          : 'gsi1pk = :pk',
        ExpressionAttributeValues: opts.sinceIso
          ? { ':pk': REFUSALS_GSI1PK, ':since': opts.sinceIso }
          : { ':pk': REFUSALS_GSI1PK },
        Select: 'COUNT',
        ExclusiveStartKey: startKey,
      }),
    );
    count += res.Count ?? 0;
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return { count, exact: true };
  }
  return { count, exact: false };
}
