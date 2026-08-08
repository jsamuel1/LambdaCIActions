import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { JITCONFIG_SK, RUN_SK } from './run-store.js';

/**
 * Smoke-run store for custom-flavor validation (ADR-041).
 *
 * A smoke run launches a real microVM with a real JIT-registered runner, so the hook broker must
 * be able to serve it `jitconfig` and `terminate` exactly as it does a real job — the whole point
 * is to exercise the SAME guest contract, since validating a different one would prove nothing.
 * That means two items with the shapes the broker already reads:
 *
 *   PK=`SMOKE#<installationId>#<seq>`  SK=`JITCONFIG`  → the JIT config + token hash
 *   PK=`SMOKE#<installationId>#<seq>`  SK=`RUN`        → `microvmId` + token hash (terminate auth)
 *
 * Its own `SMOKE#` namespace rather than synthetic `RUN#` ids, because `RUN#` rows are what the
 * console lists, the dashboard counts as active and Reports aggregates cost/failure over — a
 * validation attempt must not appear as somebody's CI job, and a failing smoke run must not
 * inflate the execution failure rate. See `isSmokeRef` in `src/hook/broker-core.ts` for why this
 * does not widen any VM's authority: the broker derives the key from the token-bound ref, so a
 * smoke VM can address only its own partition and cannot name a `RUN#` row (or vice versa).
 *
 * Both rows carry a TTL. A smoke run is minutes long, but the row must outlive it far enough for
 * the Reaper's backstop (2h cap) to still resolve `microvmId` for a VM that never self-terminated
 * — otherwise a broken image's VM would be orphaned by the very cleanup meant to catch it.
 */

const client = DynamoDBClient ? new DynamoDBClient({}) : undefined;
const doc = client ? DynamoDBDocumentClient.from(client) : undefined;
const TABLE = process.env.TABLE_NAME;

/** 6h — comfortably past the Reaper's 2h cap, short enough to leave no lasting residue. */
const SMOKE_TTL_SECONDS = 6 * 60 * 60;

function requireDoc(): DynamoDBDocumentClient {
  if (!doc || !TABLE) {
    throw new Error('smoke-store not configured: TABLE_NAME env + DynamoDB SDK required');
  }
  return doc;
}

/** `SMOKE#<installationId>#<seq>` — the partition a single smoke run owns. */
export function smokePk(installationId: number, seq: number): string {
  return `SMOKE#${installationId}#${seq}`;
}

/** The ref handed to the microVM in its launch payload (guest echoes it back to the broker). */
export function smokeRef(installationId: number, seq: number): string {
  return `${smokePk(installationId, seq)}#${JITCONFIG_SK}`;
}

export interface SmokeRunInit {
  installationId: number;
  /** Monotonic-ish discriminator so concurrent//repeat validations never share a partition. */
  seq: number;
  flavorName: string;
  jitConfig: string;
  repoFullName: string;
  labels: string[];
  /** SHA-256 of the per-run capability token; the plaintext only ever lives in the VM. */
  hookTokenHash: string;
}

/**
 * Write both smoke rows and return the ref to embed in the launch payload.
 *
 * The `RUN`-shaped row is written UP FRONT with the token hash (unlike the real path, which
 * stamps it post-launch): terminate authorizes against that row, and a smoke run that finished
 * before a post-launch stamp landed would fall back to the TTL'd JIT item and report
 * `terminated:false` — which the validator would read as "did not self-terminate" and fail a
 * perfectly good image on a race.
 */
export async function beginSmokeRun(
  init: SmokeRunInit,
  now: Date = new Date(),
): Promise<{ ref: string; pk: string }> {
  const pk = smokePk(init.installationId, init.seq);
  const ttl = Math.floor(now.getTime() / 1000) + SMOKE_TTL_SECONDS;
  const d = requireDoc();
  await d.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk,
        sk: JITCONFIG_SK,
        entity: 'SMOKE_JITCONFIG',
        jitConfig: init.jitConfig,
        // The broker returns these to the guest verbatim. They are cosmetic for a smoke run (no
        // GitHub run exists), but must be present and numeric so the guest's own logging path
        // behaves identically to a real job.
        runId: 0,
        jobId: 0,
        repoFullName: init.repoFullName,
        labels: init.labels,
        hookTokenHash: init.hookTokenHash,
        flavorName: init.flavorName,
        installationId: init.installationId,
        ttl,
      },
    }),
  );
  await d.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk,
        sk: RUN_SK,
        entity: 'SMOKE_RUN',
        hookTokenHash: init.hookTokenHash,
        flavorName: init.flavorName,
        installationId: init.installationId,
        createdAt: now.toISOString(),
        ttl,
      },
    }),
  );
  return { ref: smokeRef(init.installationId, init.seq), pk };
}

/**
 * Stamp the launched VM id onto the smoke `RUN` row so the brokered self-terminate can resolve it.
 *
 * Same ordering rule as the real provision path (ADR-019): the mapping is written immediately
 * after launch and unconditionally, because the broker reads `microvmId` off this row and a
 * fast-failing image can call terminate almost at once.
 */
export async function stampSmokeMicrovmId(input: {
  installationId: number;
  seq: number;
  microvmId: string;
}): Promise<void> {
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: smokePk(input.installationId, input.seq), sk: RUN_SK },
      UpdateExpression: 'SET microvmId = :id',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':id': input.microvmId },
    }),
  );
}

/** Best-effort cleanup once a verdict is recorded; the TTL is the real guarantee. */
export async function deleteSmokeRun(installationId: number, seq: number): Promise<void> {
  const pk = smokePk(installationId, seq);
  const d = requireDoc();
  await Promise.all([
    d.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk: JITCONFIG_SK } })).catch(() => {}),
    d.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk: RUN_SK } })).catch(() => {}),
  ]);
}
