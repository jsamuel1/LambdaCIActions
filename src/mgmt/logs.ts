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

/** Pages walked per scan attempt. Bounds the worst case on a busy group. */
const MAX_STREAM_PAGES = 4;

/**
 * Resolved `microvmId` → exact stream name, per Lambda container.
 *
 * The Run detail pane polls every 3 s, so without this every poll would re-scan the group.
 * Entries are immutable (a stream is never renamed) and only ever positive — a miss must
 * stay retryable, because "no stream yet" becomes "stream" seconds later while the VM boots.
 */
const streamNameCache = new Map<string, string>();

/** Keeps a long-lived container from growing the cache without bound. */
const STREAM_CACHE_MAX = 500;

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

/** Walk up to `MAX_STREAM_PAGES` pages of one scan, returning the first matching stream. */
async function scanForStream(
  input: { logGroupName: string; logStreamNamePrefix?: string; orderByLastEventTime?: boolean },
  microvmId: string,
): Promise<string | undefined> {
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_STREAM_PAGES; page++) {
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
    const hit = (res.logStreams ?? []).find(
      (s: LogStream) => s.logStreamName && streamBelongsTo(s.logStreamName, microvmId),
    );
    if (hit?.logStreamName) return hit.logStreamName;
    nextToken = res.nextToken;
    if (!nextToken) return undefined;
  }
  return undefined;
}

/**
 * Resolve a microVM's exact log stream name, or `undefined` when it has none yet.
 *
 * Two tiers: date-bounded prefix scans (cheap, exact for any run whose queue date is
 * known), then a recency-ordered scan of the group as a self-healing fallback for rows with
 * no/garbled `createdAt` or a stream stamped with an unexpected date.
 */
export async function resolveLogStreamName(
  logGroupName: string,
  microvmId: string,
  runCreatedAt?: string,
): Promise<string | undefined> {
  const key = `${logGroupName}\u0000${microvmId}`;
  const hit = streamNameCache.get(key);
  if (hit) return hit;

  let found: string | undefined;
  for (const prefix of datePrefixes(runCreatedAt)) {
    found = await scanForStream({ logGroupName, logStreamNamePrefix: prefix }, microvmId);
    if (found) break;
  }
  found ??= await scanForStream({ logGroupName, orderByLastEventTime: true }, microvmId);
  if (!found) return undefined;

  if (streamNameCache.size >= STREAM_CACHE_MAX) {
    // FIFO: the oldest resolution is the least likely to still be polled.
    const oldest = streamNameCache.keys().next();
    if (!oldest.done) streamNameCache.delete(oldest.value);
  }
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
