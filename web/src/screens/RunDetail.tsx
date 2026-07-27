import { useEffect, useRef, useState } from 'react';
import { api, type LogPage } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, StatusBadge, formatCost, formatDuration, formatTime } from '../components.js';

const TERMINAL = new Set(['completed', 'failed', 'timed_out']);

/**
 * Run detail — state timeline, microVM identity, cost estimate, and the CloudWatch log
 * viewer. The run row polls every 3 s while non-terminal; logs tail by following
 * CloudWatch's `nextToken` (no log bodies in DynamoDB — spec 04).
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
  const tokenRef = useRef<string | undefined>(undefined);
  /** Newest event timestamp already rendered — the tail watermark when tokens run out. */
  const sinceRef = useRef<number | undefined>(undefined);
  const preRef = useRef<HTMLPreElement | null>(null);

  const status = run.data?.run.status;
  const terminal = status ? TERMINAL.has(status) : false;

  // Reset the log buffer when the run identity changes.
  useEffect(() => {
    setPages([]);
    tokenRef.current = undefined;
    sinceRef.current = undefined;
  }, [repoId, runId, jobId]);

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const page = await api.runLogs(repoId, runId, jobId, {
          nextToken: tokenRef.current,
          since: sinceRef.current,
        });
        if (cancelled) return;
        setLogErr(undefined);
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

  // Stop tailing once the job is terminal AND a page came back empty — nothing more to read.
  useEffect(() => {
    if (terminal && pages.length && pages[pages.length - 1].events.length === 0) setTailing(false);
  }, [terminal, pages]);

  if (run.error) return <ErrorBox message={run.error} />;
  if (!run.data) return <Loading what="run" />;
  const r = run.data.run;
  const events = pages.flatMap((p) => p.events);
  const pending = events.length === 0 && (pages.length === 0 || pages[pages.length - 1].pending);

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>{r.repoFullName}</h2>
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
          Cost is an estimate: wall-clock minutes × flavor rate (vCPU + GB). Actual billing counts
          microVM runtime only.
        </p>
      </div>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>Logs</h3>
          <span className="muted">{events.length} events</span>
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
