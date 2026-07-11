import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RunRecord, RunStatus } from './types.js';

/**
 * Run store (ADR-009, spec 02 state machine). Persists + transitions run rows in the
 * shared DynamoDB table, keyed by the (repoId, runId, jobId) idempotency triple.
 *
 * The state machine is strictly forward:
 *   queued(0) \u2192 provisioning(1) \u2192 running(2) \u2192 completed|failed|timed_out(3, terminal)
 *
 * Every mutation is guarded by a conditional expression so:
 *   - a duplicate delivery of the same status is a no-op (idempotent), and
 *   - an out-of-order / late webhook can NEVER regress a run (e.g. a `running` webhook
 *     arriving after `completed` is dropped).
 *
 * The pure helpers (keys, ranks, canTransition) are exported for unit testing without AWS.
 */

const client = DynamoDBClient ? new DynamoDBClient({}) : undefined;
const doc = client ? DynamoDBDocumentClient.from(client) : undefined;

const TABLE = process.env.TABLE_NAME;

/** Terminal run age-out (DynamoDB TTL): 90 days. */
const TERMINAL_TTL_SECONDS = 90 * 24 * 60 * 60;

// ---- pure helpers (no AWS) -------------------------------------------------

/** Ordered rank of each status; forward-only transitions and idempotent re-writes. */
const STATUS_RANK: Record<RunStatus, number> = {
  queued: 0,
  provisioning: 1,
  running: 2,
  completed: 3,
  failed: 3,
  timed_out: 3,
};

const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'timed_out']);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Whether a transition from → to is allowed. Same-rank rewrites are only allowed when the
 * status is identical (idempotent). A move into a strictly higher rank is a real advance.
 * Moving backwards, or between two different terminal states, is rejected.
 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true; // idempotent re-write
  if (TERMINAL.has(from)) return false; // terminal is final
  return STATUS_RANK[to] > STATUS_RANK[from];
}

export function runPk(repoId: number, runId: number, jobId: number): string {
  return `RUN#${repoId}#${runId}#${jobId}`;
}
export const RUN_SK = 'RUN';

export function statusGsiKeys(status: RunStatus, updatedAt: string): {
  gsi1pk: string;
  gsi1sk: string;
} {
  return { gsi1pk: `RUNSTATUS#${status}`, gsi1sk: updatedAt };
}

/** Build the full item for a freshly-queued run. Pure — used by tests + the writer. */
export function buildQueuedItem(
  input: Pick<
    RunRecord,
    'repoId' | 'repoFullName' | 'installationId' | 'runId' | 'jobId' | 'labels'
  >,
  now: Date = new Date(),
): Record<string, unknown> {
  const iso = now.toISOString();
  return {
    pk: runPk(input.repoId, input.runId, input.jobId),
    sk: RUN_SK,
    ...statusGsiKeys('queued', iso),
    entity: 'RUN',
    status: 'queued' satisfies RunStatus,
    repoId: input.repoId,
    repoFullName: input.repoFullName,
    installationId: input.installationId,
    runId: input.runId,
    jobId: input.jobId,
    labels: input.labels,
    createdAt: iso,
    updatedAt: iso,
  };
}

// ---- DynamoDB operations ---------------------------------------------------

function requireDoc(): DynamoDBDocumentClient {
  if (!doc || !TABLE) {
    throw new Error('run-store not configured: TABLE_NAME env + DynamoDB SDK required');
  }
  return doc;
}

/**
 * Idempotently create a `queued` run row. If the row already exists (duplicate webhook
 * delivery), the conditional write fails and we treat it as a no-op.
 *
 * @returns true if a new row was written, false if it already existed.
 */
export async function putQueuedRun(
  input: Pick<
    RunRecord,
    'repoId' | 'repoFullName' | 'installationId' | 'runId' | 'jobId' | 'labels'
  >,
): Promise<boolean> {
  const item = buildQueuedItem(input);
  try {
    await requireDoc().send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) return false;
    throw err;
  }
}

export interface TransitionInput {
  repoId: number;
  runId: number;
  jobId: number;
  to: RunStatus;
  /** Optional fields to stamp alongside the transition. */
  flavor?: string;
  microvmId?: string;
  reason?: string;
}

/**
 * Advance a run to a new status, guarded so it can only move forward (or idempotently
 * re-write the same status). Returns true if the row moved (or a same-status idempotent
 * write applied), false if the guard rejected a regression / the row is missing.
 *
 * We express the forward-only rule as a condition on the stored status: the write applies
 * only if the current status is one from which `to` is reachable.
 */
export async function transitionRun(input: TransitionInput): Promise<boolean> {
  const now = new Date();
  const iso = now.toISOString();

  // Statuses from which `to` is a legal transition (per canTransition).
  const allowedFrom = (Object.keys(STATUS_RANK) as RunStatus[]).filter((s) =>
    canTransition(s, input.to),
  );

  const setParts = ['#s = :to', 'updatedAt = :now', 'gsi1pk = :gpk', 'gsi1sk = :now'];
  const names: Record<string, string> = { '#s': 'status' };
  const values: Record<string, unknown> = {
    ':to': input.to,
    ':now': iso,
    ':gpk': `RUNSTATUS#${input.to}`,
  };

  if (input.flavor !== undefined) {
    setParts.push('flavor = :flavor');
    values[':flavor'] = input.flavor;
  }
  if (input.microvmId !== undefined) {
    setParts.push('microvmId = :mid');
    values[':mid'] = input.microvmId;
  }
  if (input.reason !== undefined) {
    setParts.push('reason = :reason');
    values[':reason'] = input.reason;
  }
  if (TERMINAL.has(input.to)) {
    setParts.push('#ttl = :ttl');
    names['#ttl'] = 'ttl';
    values[':ttl'] = Math.floor(now.getTime() / 1000) + TERMINAL_TTL_SECONDS;
  }

  // Build the allowed-status IN (...) list for the condition.
  const inNames = allowedFrom.map((_, i) => `:from${i}`);
  allowedFrom.forEach((s, i) => {
    values[`:from${i}`] = s;
  });
  const condition = `attribute_exists(pk) AND #s IN (${inNames.join(', ')})`;

  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: runPk(input.repoId, input.runId, input.jobId), sk: RUN_SK },
        UpdateExpression: `SET ${setParts.join(', ')}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) return false; // regression / missing row → guarded no-op
    throw err;
  }
}

/**
 * List runs currently in a non-terminal status, for the Reaper's reconciliation sweep.
 * Uses GSI1 (status index) so it never scans the table.
 */
export async function listRunsByStatus(status: RunStatus, limit = 100): Promise<RunRecord[]> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gpk',
      ExpressionAttributeValues: { ':gpk': `RUNSTATUS#${status}` },
      Limit: limit,
    }),
  );
  return (res.Items ?? []) as unknown as RunRecord[];
}

function isConditionalFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}
