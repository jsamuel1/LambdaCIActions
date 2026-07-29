import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Platform config store (spec 04 § Settings) — the rows the Settings screen needs that are
 * neither runs nor installations, in the shared single table (ADR-009):
 *
 *   PK=`CONFIG#WEBHOOK`  SK=`LAST`             → last-received webhook delivery heartbeat
 *   PK=`CONFIG#AUDIT`    SK=`<iso>#<nonce>`    → operator config-change audit trail
 *
 * The heartbeat exists because "the webhook secret parameter is present" is not evidence
 * that GitHub can reach us (ADR-033). It is written by Ingest on every accepted delivery as
 * a single idempotent UpdateItem — a fixed-key row, so it costs one WCU per delivery and
 * never grows.
 *
 * Audit rows carry the ACTOR and WHAT CHANGED only; the values of secret parameters are
 * never part of a change record (AGENTS.md hard rule) — a credential relink records
 * "relinked to app 12345 by @alice", never the credentials.
 */

const client = DynamoDBClient ? new DynamoDBClient({}) : undefined;
const doc = client ? DynamoDBDocumentClient.from(client) : undefined;
const TABLE = process.env.TABLE_NAME;

export const WEBHOOK_PK = 'CONFIG#WEBHOOK';
export const WEBHOOK_LAST_SK = 'LAST';
export const AUDIT_PK = 'CONFIG#AUDIT';
export const LOCK_PK = 'CONFIG#LOCK';
export const LOCK_SK = 'PLATFORM';
export const STATUS_PK = 'CONFIG#STATUS';
export const STATUS_SK = 'LINKAGE';

function requireDoc(): DynamoDBDocumentClient {
  if (!doc || !TABLE) {
    throw new Error('config-store not configured: TABLE_NAME env + DynamoDB SDK required');
  }
  return doc;
}

/** Evidence that GitHub delivered to THIS environment, and when. */
export interface WebhookHeartbeat {
  /** GitHub event name of the most recent accepted delivery. */
  lastEvent: string;
  /** ISO timestamp we accepted it. */
  lastAt: string;
  /** `X-GitHub-Delivery` guid, so an operator can find it in GitHub's delivery log. */
  lastDeliveryId?: string;
  /** Monotonic count of accepted deliveries since the row was created. */
  deliveries?: number;
  /** ISO timestamp of the most recent delivery that FAILED signature verification. */
  lastRejectedAt?: string;
  /** Count of signature rejections — a non-zero value means a secret mismatch. */
  rejections?: number;
}

/**
 * Record an accepted delivery. Best-effort by contract: Ingest must ack GitHub fast, so the
 * caller swallows failures — a missed heartbeat degrades the Settings screen, it must never
 * drop a webhook.
 */
export async function recordWebhookDelivery(input: {
  event: string;
  deliveryId?: string;
  at?: string;
}): Promise<void> {
  const iso = input.at ?? new Date().toISOString();
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: WEBHOOK_PK, sk: WEBHOOK_LAST_SK },
      UpdateExpression:
        'SET entity = :e, lastEvent = :evt, lastAt = :now, lastDeliveryId = :did ' +
        'ADD deliveries :one',
      ExpressionAttributeValues: {
        ':e': 'WEBHOOK_HEARTBEAT',
        ':evt': input.event,
        ':now': iso,
        ':did': input.deliveryId ?? '',
        ':one': 1,
      },
    }),
  );
}

/**
 * Record a delivery that failed HMAC verification. Distinct from an accepted delivery on
 * purpose: "GitHub is reaching us but the signature doesn't match" is the exact symptom of a
 * half-finished credential rotation, and it must not look like silence.
 *
 * **Rate-bounded on purpose.** This is the one heartbeat write reachable BEFORE authentication:
 * the webhook endpoint is public and the signature check is what rejects an unauthenticated
 * caller, so an unconditional write here would let anyone drive unbounded WCUs by POSTing junk.
 * The conditional restricts it to one write per `windowMs` — enough to make the symptom visible
 * on the Settings screen (an operator needs "it is happening now", not a precise count) without
 * giving an anonymous caller a write amplifier.
 */
export async function recordWebhookRejection(at?: string, windowMs = 60_000): Promise<void> {
  const now = at ? Date.parse(at) : Date.now();
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const iso = new Date(nowMs).toISOString();
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: WEBHOOK_PK, sk: WEBHOOK_LAST_SK },
        UpdateExpression:
          'SET entity = :e, lastRejectedAt = :now, lastRejectedMs = :ms ADD rejections :one',
        ConditionExpression: 'attribute_not_exists(lastRejectedMs) OR lastRejectedMs < :cutoff',
        ExpressionAttributeValues: {
          ':e': 'WEBHOOK_HEARTBEAT',
          ':now': iso,
          ':ms': nowMs,
          ':one': 1,
          ':cutoff': nowMs - windowMs,
        },
      }),
    );
  } catch (err) {
    // Condition failure = already recorded inside the window; that is the throttle working.
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/** Read the heartbeat row (undefined when no delivery has ever been accepted). */
export async function getWebhookHeartbeat(): Promise<WebhookHeartbeat | undefined> {
  const res = await requireDoc().send(
    new GetCommand({ TableName: TABLE, Key: { pk: WEBHOOK_PK, sk: WEBHOOK_LAST_SK } }),
  );
  if (!res.Item) return undefined;
  const item = res.Item as Record<string, unknown>;
  return {
    lastEvent: String(item.lastEvent ?? ''),
    lastAt: String(item.lastAt ?? ''),
    lastDeliveryId: item.lastDeliveryId ? String(item.lastDeliveryId) : undefined,
    deliveries: typeof item.deliveries === 'number' ? item.deliveries : undefined,
    lastRejectedAt: item.lastRejectedAt ? String(item.lastRejectedAt) : undefined,
    rejections: typeof item.rejections === 'number' ? item.rejections : undefined,
  };
}

/** A platform-config change, for the Settings audit trail. */
export interface AuditRecord {
  at: string;
  actor: string;
  action: string;
  /** Operator-facing summary. Never contains a secret value. */
  detail?: string;
}

/**
 * Append an audit row. `sk` is `<iso>#<nonce>` so rows sort newest-last by time and two
 * changes in the same millisecond can't overwrite each other.
 */
export async function appendAudit(rec: AuditRecord & { nonce?: string }): Promise<void> {
  const nonce = rec.nonce ?? Math.random().toString(36).slice(2, 10);
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: AUDIT_PK, sk: `${rec.at}#${nonce}` },
      // `action` AND `at` are both DynamoDB reserved words, so both need aliases. An
      // unaliased `at = :at` makes every audit write fail with a ValidationException — and
      // because audit writes are best-effort (`.catch` at both call sites) the failure is
      // silent: the trail would simply always be empty. Pinned by test/config-store-lock.test.mjs.
      UpdateExpression:
        'SET entity = :e, actor = :actor, #action = :action, detail = :detail, #at = :at',
      ExpressionAttributeNames: { '#action': 'action', '#at': 'at' },
      ExpressionAttributeValues: {
        ':e': 'CONFIG_AUDIT',
        ':actor': rec.actor,
        ':action': rec.action,
        ':detail': rec.detail ?? '',
        ':at': rec.at,
      },
    }),
  );
}

/**
 * Serialize platform config MUTATIONS with a short-lived conditional lock.
 *
 * Concurrent relinks could interleave `PutParameter` calls and leave a mixed credential set
 * that no rollback snapshot describes. A Lambda-level concurrency cap of 1 would also serialize
 * the read path (`status`), which the Settings screen polls — two operators with the screen open
 * would throttle each other into a blank view. So mutual exclusion lives here, on the writes
 * only, as a conditional `UpdateItem`: acquired when no lock row exists or the existing one has
 * expired.
 *
 * `ttlMs` bounds a crashed holder: a broker that dies mid-relink must not wedge config changes
 * forever. It is set above the broker's own timeout so a still-running holder keeps the lock.
 */
export async function acquireConfigLock(
  holder: string,
  ttlMs = 90_000,
  now = Date.now(),
): Promise<boolean> {
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: LOCK_PK, sk: LOCK_SK },
        UpdateExpression: 'SET entity = :e, holder = :h, expiresAt = :exp, acquiredAt = :at',
        ConditionExpression: 'attribute_not_exists(expiresAt) OR expiresAt < :now',
        ExpressionAttributeValues: {
          ':e': 'CONFIG_LOCK',
          ':h': holder,
          ':exp': now + ttlMs,
          ':at': new Date(now).toISOString(),
          ':now': now,
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Release the lock, but only if WE still hold it — a holder whose TTL already lapsed and whose
 * lock was taken over must not release someone else's.
 */
export async function releaseConfigLock(holder: string): Promise<void> {
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: LOCK_PK, sk: LOCK_SK },
        UpdateExpression: 'SET expiresAt = :zero',
        ConditionExpression: 'holder = :h',
        ExpressionAttributeValues: { ':zero': 0, ':h': holder },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/**
 * Shared (cross-container) cache of the verified App linkage.
 *
 * A per-container cache alone does not bound the GitHub spend: `GET /api/settings` is readable
 * by ANY authenticated session (ADR-034 keeps it readable on purpose), each read invokes the
 * broker, and concurrent reads scale the broker out to fresh containers whose caches are all
 * cold. Since `status` costs four App-JWT calls against the App's 5,000/h budget — the same
 * budget Provision spends minting an installation token per job — an unprivileged poller could
 * otherwise starve job provisioning. This row makes the bound platform-wide instead of
 * per-container.
 *
 * Stores the already-redacted linkage payload (the broker asserts `assertNoSecrets` on it before
 * writing), so the row can hold no secret value.
 */
export async function getStatusCache<T>(
  maxAgeMs: number,
  now = Date.now(),
): Promise<T | undefined> {
  const res = await requireDoc().send(
    new GetCommand({ TableName: TABLE, Key: { pk: STATUS_PK, sk: STATUS_SK } }),
  );
  const item = res.Item as { at?: unknown; payload?: unknown } | undefined;
  if (!item || typeof item.at !== 'number' || item.payload === undefined) return undefined;
  if (now - item.at >= maxAgeMs) return undefined;
  return item.payload as T;
}

/**
 * The cache's invalidation generation. Incremented by `clearStatusCache`, so a reader can prove
 * no mutation happened while it was computing its answer.
 *
 * Needed because a `status` computation is not instantaneous (four GitHub round-trips): a read
 * that starts before a relink can finish after it and publish a PRE-change snapshot on top of the
 * invalidation, leaving every other container serving stale linkage for the full TTL. Comparing a
 * generation captured at read start closes that window — a timestamp cannot, since the stale
 * write is genuinely newer.
 */
export async function getStatusGeneration(): Promise<number> {
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: STATUS_PK, sk: STATUS_SK },
      ProjectionExpression: 'gen',
    }),
  );
  const gen = (res.Item as { gen?: unknown } | undefined)?.gen;
  return typeof gen === 'number' ? gen : 0;
}

/**
 * Publish a status answer, but ONLY if the invalidation generation still matches the one the
 * caller observed before it started computing. A mismatch means a mutation landed in between, so
 * the answer is stale and is dropped rather than written (the next poll recomputes).
 */
export async function putStatusCache<T>(
  payload: T,
  now = Date.now(),
  expectedGen?: number,
): Promise<void> {
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: STATUS_PK, sk: STATUS_SK },
        // `at` is a DynamoDB reserved word (see appendAudit).
        UpdateExpression: 'SET entity = :e, payload = :p, #at = :at',
        ExpressionAttributeNames: { '#at': 'at' },
        ExpressionAttributeValues: {
          ':e': 'CONFIG_STATUS',
          ':p': payload,
          ':at': now,
          ...(expectedGen === undefined ? {} : { ':gen': expectedGen }),
        },
        // An absent `gen` attribute is generation 0 — the state of a row that has never been
        // invalidated — so the guard must accept it when the caller observed 0.
        ...(expectedGen === undefined
          ? {}
          : {
              ConditionExpression:
                expectedGen === 0
                  ? 'attribute_not_exists(gen) OR gen = :gen'
                  : 'gen = :gen',
            }),
      }),
    );
  } catch (err) {
    // Generation moved on: a mutation invalidated the cache while we were computing. Dropping
    // the write is the point.
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/**
 * Drop the shared cache so the next read re-verifies (called after any mutation). Bumps the
 * generation so a status computation already in flight cannot publish its pre-mutation answer.
 */
export async function clearStatusCache(): Promise<void> {
  await requireDoc().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: STATUS_PK, sk: STATUS_SK },
      UpdateExpression: 'SET #at = :zero ADD gen :one',
      ExpressionAttributeNames: { '#at': 'at' },
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
    }),
  );
}

/** Most recent config changes, newest first. */
export async function listAudit(limit = 20): Promise<AuditRecord[]> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': AUDIT_PK },
      ScanIndexForward: false, // newest first
      Limit: Math.min(Math.max(limit, 1), 100),
    }),
  );
  return (res.Items ?? []).map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      at: String(item.at ?? ''),
      actor: String(item.actor ?? ''),
      action: String(item.action ?? ''),
      detail: item.detail ? String(item.detail) : undefined,
    };
  });
}
