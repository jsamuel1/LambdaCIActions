import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RunRecord, RunStatus } from './types.js';
import { asRawCursor, type RawCursor } from './cursor.js';

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

/**
 * Terminal run age-out (DynamoDB TTL), in seconds.
 *
 * Per-environment (ADR-033): the writers are given `RUN_RETENTION_DAYS` by CDK from
 * `envConfig` (dev 30 / prod 90). Falls back to 90 days when unset so a pre-M5 deployment,
 * or a caller that doesn't set the var, keeps today's behaviour rather than silently
 * shortening retention on existing run history.
 *
 * Read per call rather than captured at module load: the Lambda runtime sets env vars before
 * the handler runs either way, but this keeps the value testable and makes a misconfigured
 * value (`0`, `abc`) fall back instead of poisoning every write in the container's lifetime.
 */
export const DEFAULT_RUN_RETENTION_DAYS = 90;

export function terminalTtlSeconds(): number {
  const raw = process.env.RUN_RETENTION_DAYS;
  const days = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const effective = Number.isSafeInteger(days) && days > 0 ? days : DEFAULT_RUN_RETENTION_DAYS;
  return effective * 24 * 60 * 60;
}

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

/**
 * Run-row attribute that records first entry into a phase (ADR-042). Only the two phases
 * reporting needs are stamped: `provisioningAt` (claim → launch) and `runningAt` (the
 * queue-to-start boundary AND the start of billable microVM time). `createdAt` already
 * marks `queued` and `updatedAt` the terminal transition, so no third attribute is needed.
 */
const PHASE_WATERMARK: Partial<Record<RunStatus, string>> = {
  provisioning: 'provisioningAt',
  running: 'runningAt',
};

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

/**
 * GSI2 (repo/time) keys — the M4 run-history index (ADR-023). Written ONCE at row
 * creation and never touched by transitions, because both components are immutable
 * (`repoId`, `createdAt`). That keeps every status write a single SET with no extra
 * index churn while giving the UI a per-repo, newest-first run history without a scan.
 */
export function repoGsiKeys(repoId: number, createdAt: string): {
  gsi2pk: string;
  gsi2sk: string;
} {
  return { gsi2pk: `REPORUNS#${repoId}`, gsi2sk: createdAt };
}

/** Build the full item for a freshly-queued run. Pure — used by tests + the writer. */
export function buildQueuedItem(
  input: Pick<
    RunRecord,
    | 'repoId'
    | 'repoFullName'
    | 'installationId'
    | 'runId'
    | 'jobId'
    | 'labels'
    | 'workflowName'
    | 'jobName'
  >,
  now: Date = new Date(),
): Record<string, unknown> {
  const iso = now.toISOString();
  return {
    pk: runPk(input.repoId, input.runId, input.jobId),
    sk: RUN_SK,
    ...statusGsiKeys('queued', iso),
    ...repoGsiKeys(input.repoId, iso),
    entity: 'RUN',
    status: 'queued' satisfies RunStatus,
    repoId: input.repoId,
    repoFullName: input.repoFullName,
    installationId: input.installationId,
    runId: input.runId,
    jobId: input.jobId,
    labels: input.labels,
    // Tenant-controlled strings, stored so reports can group by workflow/job without a
    // second GitHub call. Omitted when absent rather than written as undefined (a DynamoDB
    // validation error), so pre-M5 rows and rows from an event without them stay valid.
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
    ...(input.jobName ? { jobName: input.jobName } : {}),
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
    | 'repoId'
    | 'repoFullName'
    | 'installationId'
    | 'runId'
    | 'jobId'
    | 'labels'
    | 'workflowName'
    | 'jobName'
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
 * Build the guarded transition write (pure, so the forward-only condition and the ADR-042
 * watermark semantics are unit-testable without AWS).
 */
export function buildTransitionUpdate(
  input: TransitionInput,
  now: Date = new Date(),
): {
  updateExpression: string;
  condition: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
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

  // Phase watermarks (ADR-042): stamped on the FIRST entry to a phase and never moved.
  // `if_not_exists` rather than a plain SET because a status can be re-written idempotently
  // (duplicate webhook delivery), and a moving watermark would corrupt both the
  // queue-to-start latency report and the billable-minutes cost basis. Written inside the
  // same guarded UpdateItem as the transition, so a watermark can never exist for a phase
  // the run did not actually enter.
  const phaseAttr = PHASE_WATERMARK[input.to];
  if (phaseAttr) {
    setParts.push(`${phaseAttr} = if_not_exists(${phaseAttr}, :now)`);
  }

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
    values[':ttl'] = Math.floor(now.getTime() / 1000) + terminalTtlSeconds();
  }

  // Build the allowed-status IN (...) list for the condition.
  const inNames = allowedFrom.map((_, i) => `:from${i}`);
  allowedFrom.forEach((s, i) => {
    values[`:from${i}`] = s;
  });

  return {
    updateExpression: `SET ${setParts.join(', ')}`,
    condition: `attribute_exists(pk) AND #s IN (${inNames.join(', ')})`,
    names,
    values,
  };
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
  const { updateExpression, condition, names, values } = buildTransitionUpdate(input);

  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: runPk(input.repoId, input.runId, input.jobId), sk: RUN_SK },
        UpdateExpression: updateExpression,
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
 * Unconditionally stamp the run↔VM mapping on a run row (ADR-015/019). Separate from
 * transitionRun because the mapping must be recorded even if the status already advanced
 * (e.g. an ultra-fast job whose `completed` webhook beat the `running` transition) — the
 * hook broker reads this back at job end to self-terminate on the VM's behalf, and the
 * Reaper correlates live VMs against it. Only requires the row to exist.
 *
 * Also mirrors the run's hook capability token hash (ADR-021) onto the row. The JIT config
 * item carrying the same hash ages out after 30 min (JITCONFIG_TTL_SECONDS), but a job may
 * legitimately run for hours (Reaper's cap is 2h), and self-terminate fires at job END — so
 * the durable run row, not the short-lived JIT item, has to be what authorizes `terminate`.
 */
export async function stampMicrovmId(input: {
  repoId: number;
  runId: number;
  jobId: number;
  microvmId: string;
  hookTokenHash?: string;
}): Promise<boolean> {
  const { updateExpression, values } = buildStampUpdate(input.microvmId, input.hookTokenHash);
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: runPk(input.repoId, input.runId, input.jobId), sk: RUN_SK },
        UpdateExpression: updateExpression,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) return false; // row missing — nothing to stamp
    throw err;
  }
}

/**
 * Build the stamp write's update expression (pure, so the ADR-021 mirror is unit-testable).
 * `hookTokenHash` is optional and must be OMITTED from the expression when absent rather
 * than written as undefined: a plain `SET hookTokenHash = :hth` with no value is a DynamoDB
 * validation error, and writing an empty value would strand the brokered terminate on a
 * hash that can never match (silently regressing ADR-019 to Reaper-only reaping).
 */
export function buildStampUpdate(
  microvmId: string,
  hookTokenHash?: string,
): { updateExpression: string; values: Record<string, unknown> } {
  const setParts = ['microvmId = :mid'];
  const values: Record<string, unknown> = { ':mid': microvmId };
  if (hookTokenHash) {
    setParts.push('hookTokenHash = :hth');
    values[':hth'] = hookTokenHash;
  }
  return { updateExpression: `SET ${setParts.join(', ')}`, values };
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

/**
 * Store-internal pagination cursor: base64url of a DynamoDB `LastEvaluatedKey`.
 *
 * **This value is NOT fit to hand a client.** The key names the last row SCANNED, which on a
 * post-query-authorized list is routinely a row the session may not see, and base64url is an
 * encoding rather than a protection. It is typed `RawCursor` so a declared response body
 * (`nextCursor: string | null`) rejects it; cross the boundary with `sealCursor` (ADR-052).
 */
export function encodeCursor(key: Record<string, unknown> | undefined): RawCursor | undefined {
  if (!key) return undefined;
  return asRawCursor(Buffer.from(JSON.stringify(key)).toString('base64url'));
}

export function decodeCursor(cursor: RawCursor | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor.raw, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // malformed cursor → start from the top rather than 500
  }
}

export interface RunPage {
  runs: RunRecord[];
  nextCursor?: RawCursor;
}

/**
 * Paginated per-repo run history, newest first, via GSI2 (ADR-023). Used by the M4 Runs
 * screen when a repo filter is applied and by Repo detail.
 */
export async function listRunsByRepo(
  repoId: number,
  opts: { limit?: number; cursor?: RawCursor } = {},
): Promise<RunPage> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :gpk',
      ExpressionAttributeValues: { ':gpk': `REPORUNS#${repoId}` },
      ScanIndexForward: false, // newest first
      Limit: opts.limit ?? 50,
      ExclusiveStartKey: decodeCursor(opts.cursor),
    }),
  );
  return {
    runs: (res.Items ?? []) as unknown as RunRecord[],
    nextCursor: encodeCursor(res.LastEvaluatedKey),
  };
}

/**
 * Paginated run list for a single status, newest first, via GSI1.
 * (The unfiltered "recent runs" view is a bounded fan-out over statuses — see mgmt/store.)
 */
export async function listRunsByStatusPaged(
  status: RunStatus,
  opts: { limit?: number; cursor?: RawCursor } = {},
): Promise<RunPage> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gpk',
      ExpressionAttributeValues: { ':gpk': `RUNSTATUS#${status}` },
      ScanIndexForward: false,
      Limit: opts.limit ?? 50,
      ExclusiveStartKey: decodeCursor(opts.cursor),
    }),
  );
  return {
    runs: (res.Items ?? []) as unknown as RunRecord[],
    nextCursor: encodeCursor(res.LastEvaluatedKey),
  };
}

/**
 * Count rows in a status without materializing them (dashboard aggregates).
 *
 * A single `Select: COUNT` query only counts what fits in one 1 MB scan pass, so a status
 * with a long history would silently under-report. We follow `LastEvaluatedKey` up to a
 * bounded number of pages; `exact: false` tells the caller the number is a floor.
 */
export async function countRunsByStatus(
  status: RunStatus,
  opts: { maxPages?: number } = {},
): Promise<{ count: number; exact: boolean }> {
  const maxPages = opts.maxPages ?? 10;
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await requireDoc().send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :gpk',
        ExpressionAttributeValues: { ':gpk': `RUNSTATUS#${status}` },
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

/** Read one run row (Run detail screen). */
export async function getRun(
  repoId: number,
  runId: number,
  jobId: number,
): Promise<RunRecord | undefined> {
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: runPk(repoId, runId, jobId), sk: RUN_SK },
    }),
  );
  return res.Item as unknown as RunRecord | undefined;
}

function isConditionalFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

// ---- JIT config side-store (ADR-016: run-hook payload cap is 4 KB) ---------
// The GA lambda-microvms `runHookPayload` hard cap is 4096 bytes, but a GitHub
// encoded_jit_config alone is ~4 KB — it does not fit inline. So Provision stashes the
// JIT config (+ minimal metadata) here, keyed by an opaque ref, and passes ONLY the ref
// in the launch payload; the microVM's /run hook fetches it. Short TTL so the secret-ish
// JIT config doesn't linger. Stored as a separate item under the run's pk.

/** JIT config item TTL: 30 min (a runner claims its JIT config within seconds of boot). */
const JITCONFIG_TTL_SECONDS = 30 * 60;

export const JITCONFIG_SK = 'JITCONFIG';

export interface JitConfigPayload {
  jitConfig: string;
  runId: number;
  jobId: number;
  repoFullName: string;
  labels: string[];
  /**
   * SHA-256 of the per-run hook capability token (ADR-021). Only the hash is stored; the
   * plaintext is handed to the microVM in its launch payload and never persisted. The hook
   * broker compares a presented token against this to authorize jitconfig/terminate on
   * THIS run only.
   */
  hookTokenHash?: string;
}

/** The opaque reference handed to the microVM (small; fits the 4 KB payload trivially). */
export function jitConfigRef(repoId: number, runId: number, jobId: number): string {
  return `${runPk(repoId, runId, jobId)}#${JITCONFIG_SK}`;
}

/** Stash the JIT config for a run; returns the ref to embed in runHookPayload. */
export async function putJitConfig(
  repoId: number,
  payload: JitConfigPayload,
  now: Date = new Date(),
): Promise<string> {
  const pk = runPk(repoId, payload.runId, payload.jobId);
  await requireDoc().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk,
        sk: JITCONFIG_SK,
        entity: 'JITCONFIG',
        jitConfig: payload.jitConfig,
        runId: payload.runId,
        jobId: payload.jobId,
        repoFullName: payload.repoFullName,
        labels: payload.labels,
        ...(payload.hookTokenHash ? { hookTokenHash: payload.hookTokenHash } : {}),
        ttl: Math.floor(now.getTime() / 1000) + JITCONFIG_TTL_SECONDS,
      },
    }),
  );
  return jitConfigRef(repoId, payload.runId, payload.jobId);
}

/** Fetch a stashed JIT config by ref (used by the microVM /run hook). */
export async function getJitConfigByRef(ref: string): Promise<JitConfigPayload | undefined> {
  const [pk] = ref.split(`#${JITCONFIG_SK}`);
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: `${pk}`, sk: JITCONFIG_SK },
    }),
  );
  if (!res.Item) return undefined;
  const i = res.Item;
  return {
    jitConfig: i.jitConfig as string,
    runId: i.runId as number,
    jobId: i.jobId as number,
    repoFullName: i.repoFullName as string,
    labels: (i.labels as string[]) ?? [],
    hookTokenHash: i.hookTokenHash as string | undefined,
  };
}

/**
 * Read the `microvmId` off a run row addressed by its EXPLICIT key (ADR-021). Used by the
 * hook broker, which derives the key from the caller's capability-token-bound ref rather
 * than from caller-supplied ids, so a microVM can never address another run's row.
 */
export async function getRunFieldsByKey(
  pk: string,
  sk: string = RUN_SK,
): Promise<{ microvmId?: string; status?: RunStatus; hookTokenHash?: string } | undefined> {
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk, sk },
      ProjectionExpression: 'microvmId, hookTokenHash, #s',
      ExpressionAttributeNames: { '#s': 'status' },
    }),
  );
  if (!res.Item) return undefined;
  return {
    microvmId: res.Item.microvmId as string | undefined,
    status: res.Item.status as RunStatus | undefined,
    hookTokenHash: res.Item.hookTokenHash as string | undefined,
  };
}
