import { useEffect, useRef, useState } from 'react';
import { api, type LogPage } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, StatusBadge, formatCost, formatDuration, formatTime } from '../components.js';

const TERMINAL = new Set(['completed', 'failed', 'timed_out']);

/**
 * Run detail — state timeline, microVM identity, cost estimate, and the CloudWatch log
 * viewer. The run row polls every 3 s while non-terminal; the log tail polls every 4 s,
 * following CloudWatch's `nextToken` (no log bodies in DynamoDB — spec 04).
 */
export function RunDetail({
  repoId,
  runId,
  jobId,
}: {
  repoId: number;
  runId: number;
  jobId: number;
}): JSX.Element {
  const run = useApi(() => api.run(repoId, runId, jobId), [repoId, runId, jobId], 3000);
  const [pages, setPages] = useState<LogPage[]>([]);
  const [logErr, setLogErr] = useState<string | undefined>(undefined);
  const [tailing, setTailing] = useState(true);
  /** True when the newest poll returned no events (the tail is caught up). */
  const [caughtUp, setCaughtUp] = useState(false);
  /** The newest poll's `pending` flag — the API's "no stream yet" signal. */
  const [pendingFlag, setPendingFlag] = useState(true);
  /**
   * The resolved CloudWatch stream name (ADR-048).
   *
   * Tracked per POLL, not derived from `pages`: `pages` only holds pages that carried
   * events, so deriving it from them would hide the name in exactly the case it is for — an
   * empty pane, where it is the difference between "resolved, nothing written" and
   * "resolution failed". Sticky once set: a later caught-up page reports the same stream.
   */
  const [logStream, setLogStream] = useState<string | null>(null);
  const tokenRef = useRef<string | undefined>(undefined);
  /** Newest event timestamp already rendered — the tail watermark when tokens run out. */
  const sinceRef = useRef<number | undefined>(undefined);
  /**
   * In-flight guard: the 4 s interval fires regardless of how long a pull takes, and two
   * overlapping pulls would send the SAME nextToken/watermark — CloudWatch answers both
   * with the same page, which appends every line twice. One pull at a time.
   */
  const pullingRef = useRef(false);
  const preRef = useRef<HTMLPreElement | null>(null);

  const status = run.data?.run.status;
  const terminal = status ? TERMINAL.has(status) : false;

  // Reset the log buffer when the run identity changes.
  useEffect(() => {
    setPages([]);
    setCaughtUp(false);
    setPendingFlag(true);
    setLogStream(null);
    setTailing(true);
    tokenRef.current = undefined;
    sinceRef.current = undefined;
  }, [repoId, runId, jobId]);

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      if (pullingRef.current) return;
      pullingRef.current = true;
      try {
        const page = await api.runLogs(repoId, runId, jobId, {
          nextToken: tokenRef.current,
          since: sinceRef.current,
        });
        if (cancelled) return;
        setLogErr(undefined);
        setCaughtUp(page.events.length === 0);
        setPendingFlag(page.pending);
        if (page.logStream) setLogStream(page.logStream);
        if (page.events.length) {
          setPages((prev) => [...prev, page]);
          const newest = page.events.reduce((max, e) => (e.timestamp > max ? e.timestamp : max), 0);
          if (newest) sinceRef.current = newest + 1;
          if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
        }
        // CloudWatch drops the token once caught up; from then on the watermark drives the
        // tail (re-sending a stale token would replay the same page forever).
        tokenRef.current = page.nextToken ?? undefined;
      } catch (e) {
        if (!cancelled) setLogErr(e instanceof Error ? e.message : String(e));
      } finally {
        pullingRef.current = false;
      }
    }
    void pull();
    if (!tailing) return () => {
      cancelled = true;
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void pull();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [repoId, runId, jobId, tailing]);

  // Stop tailing once the job is terminal AND a poll came back empty — nothing more to read.
  // (`pages` only holds non-empty pages, so the caught-up signal has to be tracked separately.)
  useEffect(() => {
    if (terminal && caughtUp) setTailing(false);
  }, [terminal, caughtUp]);

  if (run.error) return <ErrorBox message={run.error} />;
  if (!run.data) return <Loading what="run" />;
  const r = run.data.run;
  const events = pages.flatMap((p) => p.events);
  // The API's `pending` flag is authoritative: an empty first page with a live stream is
  // "caught up", not "waiting for the microVM".
  const pending = events.length === 0 && pendingFlag;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 className="tight">{r.repoFullName}</h2>
          <StatusBadge status={r.status} />
          <span className="muted">
            run {r.runId} · job {r.jobId}
          </span>
        </div>
        <table>
          <tbody>
            <tr>
              <th>Flavor</th>
              <td>{r.flavor ?? '—'}</td>
              <th>Labels</th>
              <td>{r.labels.join(', ') || '—'}</td>
            </tr>
            <tr>
              <th>microVM</th>
              <td>{r.microvmId ?? '(not launched)'}</td>
              <th>Duration</th>
              <td>{formatDuration(r.durationSeconds)}</td>
            </tr>
            <tr>
              <th>Queued</th>
              <td>{formatTime(r.createdAt)}</td>
              <th>Last update</th>
              <td>{formatTime(r.updatedAt)}</td>
            </tr>
            <tr>
              <th>Est. cost</th>
              <td>{formatCost(r.costUsd)}</td>
              <th>Reason</th>
              <td>{r.reason ?? '—'}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          Cost is an estimate: billable minutes × flavor rate (vCPU + GB), where the rate is
          derived from the flavor footprint rather than a bill.{' '}
          {/*
            Three cases, not two. `costBasis` is absent when no microVM ran (a mint/launch
            failure carries the intended flavor but never had a VM), and this row is not priced
            at all — the previous two-branch form fell through to the wallClock sentence and told
            an operator the run was "priced on total wall clock", explaining a number that does
            not exist. Reports and the CSV export report 0 billable seconds and no basis for the
            same row, so this sentence is what keeps the three surfaces telling one story.
          */}
          {r.costBasis === undefined
            ? 'No microVM ran for this job, so there is no billable time to price and no cost is estimated — the duration above is the time it spent queued or failing to launch, which is not billed.'
            : r.costBasis === 'wallClock'
              ? 'This run carries no start watermark — it predates per-phase timestamps, or it finished before the running transition landed — so it is priced on total wall clock, an overstatement, since queue and provisioning time are not billed.'
              : 'Billable time is measured from when the microVM started running, so queue and provisioning time are excluded.'}{' '}
          See Reports for spend over a window.
        </p>
      </div>

      <div className="card">
        <div className="row">
          <h3 className="tight">Logs</h3>
          <span className="muted">{events.length} events</span>
          {logStream && (
            <span className="muted" title={`CloudWatch log stream: ${logStream}`}>
              {logStream}
            </span>
          )}
          <button onClick={() => setTailing((t) => !t)}>{tailing ? 'Pause tail' : 'Resume tail'}</button>
        </div>
        {logErr && <p className="error">{logErr}</p>}
        {pending && !events.length && (
          <p className="muted">
            No log stream yet — the microVM has not started writing. Logs appear once the runner
            boots.
          </p>
        )}
        <pre className="logs" ref={preRef}>
          {events.map((e, i) => (
            <div key={`${e.timestamp}-${i}`}>
              <span className="ts">{new Date(e.timestamp).toISOString()}</span> {e.message.trimEnd()}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
