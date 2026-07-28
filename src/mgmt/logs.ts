import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogStreamsCommand,
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
  /** True when the run has no microVM yet (queued / launch failed) — UI shows a hint. */
  pending: boolean;
}

export interface FetchLogsInput {
  logGroupName: string;
  /** microVM id from the run row; when absent the run never launched → `pending`. */
  microvmId?: string;
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

let cached: CloudWatchLogsClient | undefined;
function client(): CloudWatchLogsClient {
  cached ??= new CloudWatchLogsClient({});
  return cached;
}

/** Test hook: inject a stub client (kept out of the Lambda's hot path). */
export function _setClient(stub: Pick<CloudWatchLogsClient, 'send'> | undefined): void {
  cached = stub as CloudWatchLogsClient | undefined;
}

/**
 * Fetch one page of a run's logs.
 *
 * A missing log group (nothing has ever logged in this env) or a run with no VM yet are
 * both **normal** states, not errors — they return an empty `pending`/empty page so the
 * UI renders "waiting for logs" instead of an error toast.
 */
export async function fetchRunLogs(input: FetchLogsInput): Promise<LogPage> {
  if (!input.microvmId) return { events: [], pending: true };

  try {
    const res = await client().send(
      new FilterLogEventsCommand({
        logGroupName: input.logGroupName,
        logStreamNamePrefix: input.microvmId,
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
      stream: e.logStreamName ?? '',
    }));
    // A cold first page (no token, no watermark, nothing returned) is ambiguous: the VM may
    // not have written yet, or the stream may be gone. One DescribeLogStreams resolves it so
    // the UI can say "waiting for logs" honestly instead of showing an empty pane forever.
    const pending =
      events.length === 0 && !input.nextToken && input.startTime === undefined
        ? !(await hasLogStream(input.logGroupName, input.microvmId))
        : false;
    return { events, nextToken: res.nextToken, pending };
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') {
      return { events: [], pending: true };
    }
    throw err;
  }
}

/**
 * Whether any stream exists for a microVM — used to distinguish "no logs yet" from
 * "logs expired". Cheap (one DescribeLogStreams with a prefix).
 */
export async function hasLogStream(logGroupName: string, microvmId: string): Promise<boolean> {
  try {
    const res = await client().send(
      new DescribeLogStreamsCommand({
        logGroupName,
        logStreamNamePrefix: microvmId,
        limit: 1,
      }),
    );
    return (res.logStreams ?? []).length > 0;
  } catch {
    return false;
  }
}
