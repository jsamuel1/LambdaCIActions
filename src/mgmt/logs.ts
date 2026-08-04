import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogStreamsCommand,
  type LogStream,
} from '@aws-sdk/client-cloudwatch-logs';

/**
 * CloudWatch log reader for the Run detail screen (spec 04 § Management API →
 * `GET /api/runs/.../logs`).
 *
 * Runner + run-hook output for every job lands in ONE per-env log group
 * (`/aws/lambda/microvms/runs/lca-<env>`, set at launch — ADR-016), with one log STREAM
 * per microVM. So "the logs for this run" = the events in that group whose stream belongs
 * to the run's `microvmId` (persisted on the run row, ADR-019).
 *
 * The microVM id is a stream-name **suffix**, not a prefix — the service names the stream
 * `<YYYY/MM/DD>[<imageVersion>]<microvmId>` — so the stream has to be RESOLVED to its exact
 * name before it can be read (ADR-048). `logStreamNamePrefix` cannot express that and
 * silently matches nothing.
 *
 * Log bodies never touch DynamoDB (spec 04); we page through CloudWatch with its own
 * `nextToken`, which the API hands back to the client verbatim as an opaque cursor.
 */

export interface LogEvent {
  timestamp: number; // epoch ms
  message: string;
  stream: string;
}

export interface LogPage {
  events: LogEvent[];
  /** Opaque CloudWatch token for the next page; absent when caught up. */
  nextToken?: string;
  /**
   * True when there is nothing to read yet: no microVM (queued / launch failed), or the VM
   * has a row but no log stream — the UI shows a "waiting for logs" hint.
   */
  pending: boolean;
  /** Exact stream name once resolved. Surfaced by the API for operator triage. */
  logStream?: string;
}

export interface FetchLogsInput {
  logGroupName: string;
  /** microVM id from the run row; when absent the run never launched → `pending`. */
  microvmId?: string;
  /**
   * Run `createdAt` (ISO). The stream name is date-stamped, so the queue date bounds the
   * stream scan to one or two `DescribeLogStreams` pages instead of walking the group.
   */
  runCreatedAt?: string;
  limit?: number;
  nextToken?: string;
  /**
   * Tail watermark (epoch ms). Used when there is no `nextToken` to resume from: CloudWatch
   * omits `nextToken` once a filter is caught up, so re-sending the previous token would
   * replay the same events. The client instead asks for "everything after the newest event
   * I already have".
   */
  startTime?: number;
}

/** Max events per page. Keeps a single API response comfortably small. */
const DEFAULT_LIMIT = 200;

/** Streams per `DescribeLogStreams` page (CloudWatch's own maximum). */
const STREAM_PAGE_SIZE = 50;

/**
 * `DescribeLogStreams` calls one whole resolution attempt may spend, across every tier.
 *
 * A per-tier page cap is the wrong budget: it multiplies (two date prefixes plus a fallback
 * scan), so the miss path — a queued/booting VM, polled every 3 s — cost 9 describes/poll
 * ≈ 3 TPS from a single viewer against an account-wide 5 TPS quota. One shared budget makes
 * the worst case flat, and `STREAM_SCAN_BUDGET × STREAM_PAGE_SIZE` streams per day the
 * resolution horizon (see ADR-048 for what happens beyond it).
 */
const STREAM_SCAN_BUDGET = 12;

/**
 * Resolved `microvmId` → exact stream name, per Lambda container.
 *
 * The Run detail pane polls every 3 s, so without this every poll would re-scan the group.
 * Entries are immutable (a stream is never renamed), so positive results never expire.
 */
const streamNameCache = new Map<string, string>();

/**
 * microVMs whose stream did not exist yet, with the time the answer stops being trusted.
 *
 * A miss must stay retryable — "no stream yet" becomes "stream" seconds later while the VM
 * boots — but it must not be re-derived on every 3 s poll, or watching a queued run costs a
 * full group scan per poll. A TTL just over the poll interval collapses that to roughly one
 * scan per two polls while keeping the pane's worst-case lag to a few seconds.
 */
const streamMissCache = new Map<string, number>();

/** How long a "no stream yet" answer is reused before it is re-derived. */
const STREAM_MISS_TTL_MS = 5_000;

/** Keeps a long-lived container from growing either cache without bound. */
const STREAM_CACHE_MAX = 500;

/** Insertion-ordered FIFO eviction: the oldest entry is the least likely to still be polled. */
function evictOldest(cache: Map<string, unknown>): void {
  if (cache.size < STREAM_CACHE_MAX) return;
  const oldest = cache.keys().next();
  if (!oldest.done) cache.delete(oldest.value);
}

let cached: CloudWatchLogsClient | undefined;
function client(): CloudWatchLogsClient {
  cached ??= new CloudWatchLogsClient({});
  return cached;
}

/** Test hook: inject a stub client (kept out of the Lambda's hot path). */
export function _setClient(stub: Pick<CloudWatchLogsClient, 'send'> | undefined): void {
  cached = stub as CloudWatchLogsClient | undefined;
  // A different client is a different world: resolved names from the previous one are void.
  streamNameCache.clear();
  streamMissCache.clear();
}

/**
 * Whether a stream belongs to a microVM.
 *
 * Position-agnostic on purpose. The observed name is
 * `2026/08/03[10.0]microvm-98c2f28c-…` (id last), but the id is a UUID-shaped token that
 * cannot occur inside an unrelated stream's name, so containment is both sufficient and
 * immune to the service moving the date/version decoration around.
 */
export function streamBelongsTo(streamName: string, microvmId: string): boolean {
  return streamName.includes(microvmId);
}

/** `YYYY/MM/DD` in UTC — the date component the service stamps onto the stream name. */
function utcDatePrefix(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, '/');
}

/**
 * Date prefixes worth trying for a run queued at `runCreatedAt`: the queue date and the
 * next one, since a VM queued near midnight UTC launches on the following day.
 */
function datePrefixes(runCreatedAt: string | undefined): string[] {
  if (!runCreatedAt) return [];
  const at = new Date(runCreatedAt);
  if (Number.isNaN(at.getTime())) return [];
  const next = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  return [utcDatePrefix(at), utcDatePrefix(next)];
}

/** Outcome of one scan tier: what it found, and whether it ran out of budget doing so. */
interface ScanResult {
  found?: string;
  /** True when the scan reached the end of its listing — a miss here is authoritative. */
  exhausted: boolean;
  /** Describe calls spent, so the caller can debit one shared budget across tiers. */
  spent: number;
}

/**
 * Walk one scan until it matches, runs out of streams, or runs out of `budget` calls.
 *
 * `exhausted` is the load-bearing part: a scan that listed every stream under its prefix and
 * found nothing proves the stream does not exist, which lets the caller skip the fallback
 * tier entirely. That is what keeps the ordinary "VM has not written yet" poll at two
 * describes instead of a whole-group scan.
 */
async function scanForStream(
  input: { logGroupName: string; logStreamNamePrefix?: string; orderByLastEventTime?: boolean },
  microvmId: string,
  budget: number,
): Promise<ScanResult> {
  let nextToken: string | undefined;
  let spent = 0;
  while (spent < budget) {
    const res = await client().send(
      new DescribeLogStreamsCommand({
        logGroupName: input.logGroupName,
        limit: STREAM_PAGE_SIZE,
        ...(input.logStreamNamePrefix ? { logStreamNamePrefix: input.logStreamNamePrefix } : {}),
        // CloudWatch forbids combining `orderBy: LastEventTime` with a name prefix, so the
        // recency ordering is only available on the unbounded fallback scan — where it is
        // what makes the scan useful: a live run's stream is the most recently written.
        ...(input.orderByLastEventTime ? { orderBy: 'LastEventTime' as const, descending: true } : {}),
        ...(nextToken ? { nextToken } : {}),
      }),
    );
    spent++;
    const hit = (res.logStreams ?? []).find(
      (s: LogStream) => s.logStreamName && streamBelongsTo(s.logStreamName, microvmId),
    );
    if (hit?.logStreamName) return { found: hit.logStreamName, exhausted: false, spent };
    nextToken = res.nextToken;
    if (!nextToken) return { exhausted: true, spent };
  }
  // Budget spent with pages still unread: the miss is inconclusive, not authoritative.
  return { exhausted: false, spent };
}

/**
 * Resolve a microVM's exact log stream name, or `undefined` when it has none yet.
 *
 * Two tiers, sharing one describe budget: date-bounded prefix scans (cheap, exact for any
 * run whose queue date is known), then a recency-ordered scan of the group as a self-healing
 * fallback for rows with no/garbled `createdAt` or a stream stamped with an unexpected date.
 *
 * The fallback runs only when a date scan could not rule the stream out — no usable date, or
 * a scan truncated by the budget. Once a date prefix has been listed to its end, its miss is
 * final, and scanning the whole group again would just re-answer the same question at cost.
 */
export async function resolveLogStreamName(
  logGroupName: string,
  microvmId: string,
  runCreatedAt?: string,
): Promise<string | undefined> {
  const key = `${logGroupName}\u0000${microvmId}`;
  const hit = streamNameCache.get(key);
  if (hit) return hit;
  const missUntil = streamMissCache.get(key);
  if (missUntil !== undefined && Date.now() < missUntil) return undefined;
  streamMissCache.delete(key);

  let budget = STREAM_SCAN_BUDGET;
  let found: string | undefined;
  // Optimistic until every date prefix has been listed to its end: with no date prefix, or
  // with one the budget truncated, nothing has ruled the stream out and the fallback must run.
  let ruledOut = false;
  const prefixes = datePrefixes(runCreatedAt);
  for (const [i, prefix] of prefixes.entries()) {
    // Reserve one call for each prefix still to come, so a busy queue date cannot starve the
    // next-day scan — that is the only tier that can find a VM launched across midnight UTC.
    const reserve = prefixes.length - 1 - i;
    const scan = await scanForStream(
      { logGroupName, logStreamNamePrefix: prefix },
      microvmId,
      Math.max(1, budget - reserve),
    );
    budget -= scan.spent;
    ruledOut = scan.exhausted;
    if (scan.found) {
      found = scan.found;
      break;
    }
  }
  if (!found && !ruledOut && budget > 0) {
    const scan = await scanForStream({ logGroupName, orderByLastEventTime: true }, microvmId, budget);
    found = scan.found;
  }

  if (!found) {
    evictOldest(streamMissCache);
    streamMissCache.set(key, Date.now() + STREAM_MISS_TTL_MS);
    return undefined;
  }

  evictOldest(streamNameCache);
  streamNameCache.set(key, found);
  return found;
}

/**
 * Fetch one page of a run's logs.
 *
 * A missing log group (nothing has ever logged in this env), a run with no VM yet, and a VM
 * that has not written yet are all **normal** states, not errors — they return an empty
 * `pending` page so the UI renders "waiting for logs" instead of an error toast.
 */
export async function fetchRunLogs(input: FetchLogsInput): Promise<LogPage> {
  if (!input.microvmId) return { events: [], pending: true };

  try {
    const stream = await resolveLogStreamName(
      input.logGroupName,
      input.microvmId,
      input.runCreatedAt,
    );
    // No stream for this VM: it has not booted far enough to write, or the stream aged out.
    // Either way there is nothing to read and nothing to page — say so instead of handing
    // the UI an empty page it would render as "caught up".
    if (!stream) return { events: [], pending: true };

    const res = await client().send(
      new FilterLogEventsCommand({
        logGroupName: input.logGroupName,
        // Exact name, NOT a prefix: the id is a suffix of the stream name (ADR-048).
        logStreamNames: [stream],
        limit: input.limit ?? DEFAULT_LIMIT,
        // A token already encodes the window it was issued for — mixing in startTime would
        // contradict it, so the two are mutually exclusive.
        ...(input.nextToken
          ? { nextToken: input.nextToken }
          : input.startTime !== undefined
            ? { startTime: input.startTime }
            : {}),
      }),
    );
    const events = (res.events ?? []).map((e) => ({
      timestamp: e.timestamp ?? 0,
      message: e.message ?? '',
      stream: e.logStreamName ?? stream,
    }));
    return { events, nextToken: res.nextToken, pending: false, logStream: stream };
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') {
      return { events: [], pending: true };
    }
    throw err;
  }
}
