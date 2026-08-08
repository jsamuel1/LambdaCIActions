import { useEffect, useRef, useState } from 'react';
import { api, type Unclaimed as UnclaimedJob } from '../api.js';
import { allowlistChanged } from '../../../src/shared/allowlist.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, formatTime } from '../components.js';

const PAGE = 50;

/**
 * Unclaimed — jobs the claim gate refused (ADR-049).
 *
 * This screen exists because a refused job used to be invisible everywhere. Ingest returned
 * `claimed: false` with a reason in the 202 body, GitHub discarded it, nothing was logged, and no
 * row was written — so a repo whose workflow named `lambda-ci-python` while the live allowlist held
 * only `lambda-ci,lambda-ci-node,lambda-ci-docker` had eight PRs sit `QUEUED` for ~7 h with no
 * error in the console, the run list, or CloudWatch.
 *
 * Deliberately its own screen, not a status in the Runs list: a refusal has no microVM, no
 * duration and no cost, so folding it into the run store would put a never-launched job into the
 * active count, the error rate and the spend estimate.
 *
 * The screen pairs each refusal's stored allowlist snapshot with the LIVE allowlist, because that
 * comparison is the whole diagnosis: same ⇒ still broken; different ⇒ probably fixed, re-run the
 * job. Without both, "I already added the label" and "the label is still missing" look identical.
 *
 * Ordering is by MOST RECENT refusal (both server indexes sort on `lastSeenAt`), so a problem that
 * started hours ago and is still firing stays at the top instead of sinking below the head page.
 * Older history is reachable through the cursor — without that button the rows past the first page
 * would exist in the store and be unreachable from the console, which is the same invisibility
 * this screen exists to end.
 */
export function Unclaimed({
  repoFilter,
  navigate,
}: {
  repoFilter?: number;
  navigate: (to: string) => void;
}): JSX.Element {
  const page = useApi(
    () => api.unclaimed({ repo: repoFilter, limit: PAGE }),
    [repoFilter],
    15000,
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** Appended older pages. The head page keeps polling; these are held snapshots. */
  const [older, setOlder] = useState<UnclaimedJob[]>([]);
  /**
   * Three states, as on the Runs screen: `undefined` = nothing walked yet (fall back to the head
   * page's cursor), a string = resume there, `null` = the index is exhausted. Conflating `null`
   * with `undefined` would make an exhausted history fall back to the head cursor, so the button
   * would never disappear and would re-walk the same pages forever.
   */
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreErr, setMoreErr] = useState<string | undefined>(undefined);
  /**
   * Which filter the appended pages belong to. "Load older" is async, so a response can land after
   * the operator changed the repo filter; applying it then would append another repo's refusals.
   * Held in a ref because the in-flight closure captured the OLD filter.
   */
  const filterRef = useRef(repoFilter);
  filterRef.current = repoFilter;

  // A filter change invalidates every appended page and its cursor.
  useEffect(() => {
    setOlder([]);
    setCursor(undefined);
    setMoreErr(undefined);
  }, [repoFilter]);

  if (page.error) return <ErrorBox message={page.error} />;
  if (!page.data) return <Loading what="unclaimed jobs" />;

  const rows = dedupe([...(page.data.unclaimed ?? []), ...older]);
  const live = page.data.allowlist;
  const headCursor = page.data.nextCursor;
  const nextCursor = cursor === undefined ? headCursor : cursor;

  async function loadOlder(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreErr(undefined);
    const requestedFor = repoFilter;
    try {
      const next = await api.unclaimed({ repo: repoFilter, limit: PAGE, cursor: nextCursor });
      if (filterRef.current !== requestedFor) return; // window no longer exists
      setOlder((prev) => [...prev, ...next.unclaimed]);
      setCursor(next.nextCursor);
    } catch (e) {
      if (filterRef.current !== requestedFor) return;
      setMoreErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h3 className="tight">Unclaimed jobs</h3>
          <span className="spacer" />
          {repoFilter !== undefined && (
            <button onClick={() => navigate('/unclaimed')}>Clear repo filter</button>
          )}
          <button onClick={page.reload}>Refresh</button>
        </div>
        <p className="muted">
          Jobs LambdaCIActions declined to claim. GitHub leaves these <code>queued</code> — nothing
          runs them here, and unless the repo also has GitHub-hosted capacity they wait forever.
          Only actionable refusals are recorded: an un-onboarded repo's ordinary{' '}
          <code>ubuntu-latest</code> jobs are expected and are not listed.
        </p>
        <p className="muted tight">
          Live runner-label allowlist:{' '}
          {page.data.controlPlaneLive ? (
            live.length ? (
              <code>{live.join(', ')}</code>
            ) : (
              <span className="badge block">empty — nothing can be claimed</span>
            )
          ) : (
            <span className="badge warn">could not read</span>
          )}
        </p>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>Job</th>
              <th>Reason</th>
              <th>Seen</th>
              <th>Last</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = `${r.repoId}-${r.runId}-${r.jobId}`;
              return (
                <UnclaimedRow
                  key={key}
                  row={r}
                  liveAllowlist={live}
                  liveKnown={page.data!.controlPlaneLive}
                  open={expanded.has(key)}
                  onToggle={() => toggle(key)}
                  navigate={navigate}
                />
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No unclaimed jobs recorded. A job refused for an ordinary reason (no LCA label on
                  an un-onboarded repo) is logged but not listed here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {moreErr && <p className="error">{moreErr}</p>}
        <div className="row gap-top">
          {nextCursor && (
            <button onClick={() => void loadOlder()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older'}
            </button>
          )}
          <span className="muted">
            {rows.length} refused job{rows.length === 1 ? '' : 's'} shown, most recent first
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * De-duplicate the polled head page against the held older pages by refusal identity.
 *
 * A recurring refusal's sort key moves (`lastSeenAt`), so a row that was on an older page can
 * reappear on the re-polled head page. Without this it would render twice.
 */
function dedupe(rows: UnclaimedJob[]): UnclaimedJob[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.repoId}-${r.runId}-${r.jobId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function UnclaimedRow({
  row,
  liveAllowlist,
  liveKnown,
  open,
  onToggle,
  navigate,
}: {
  row: UnclaimedJob;
  liveAllowlist: string[];
  liveKnown: boolean;
  open: boolean;
  onToggle: () => void;
  navigate: (to: string) => void;
}): JSX.Element {
  /**
   * Whether the allowlist has CHANGED since the refusal. Compared as case-insensitive sets,
   * because the parameter is an operator-edited comma list whose order, spacing and CASE carry no
   * meaning to the claim gate (`decideClaim` lower-cases both sides). A re-ordered or re-cased
   * list is not a fix, and reporting it as one would send the operator to re-run a job that will
   * be refused again for exactly the same reason.
   */
  const changed = allowlistChanged(row.claimedLabels, liveAllowlist, liveKnown);
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td>{row.repoFullName}</td>
        <td>
          {row.jobName ?? `job ${row.jobId}`}
          <div className="muted">{row.workflowName ?? '—'}</div>
        </td>
        <td>
          <span className="row">
            <span className={`badge ${row.code === 'label-not-allowlisted' ? 'block' : 'warn'}`}>
              {row.code}
            </span>
            {changed && (
              <span
                className="badge ok"
                title="The runner-label allowlist has changed since this refusal — re-run the job to see whether it is now claimed."
              >
                config changed
              </span>
            )}
          </span>
        </td>
        <td>{row.occurrences}×</td>
        <td>{formatTime(row.lastSeenAt)}</td>
      </tr>
      {open && (
        <tr className="jobrow">
          <td colSpan={5}>
            <div className="stack tight">
              <div>{row.reason}</div>
              {row.fix && <div className="fix">Fix: {row.fix}</div>}
              <div className="muted">
                runs-on: <code>{row.labels.join(', ') || '—'}</code>
                {row.runnerGroup ? (
                  <>
                    {' '}
                    · runner group: <code>{row.runnerGroup}</code>
                  </>
                ) : null}
              </div>
              <div className="muted">
                allowlist when refused: <code>{row.claimedLabels.join(', ') || '(empty)'}</code>
              </div>
              <div className="muted">
                mode: {row.mode} · first seen {formatTime(row.firstSeenAt)}
              </div>
              <div className="row">
                <a href={row.githubUrl} target="_blank" rel="noreferrer">
                  Open the run on GitHub
                </a>
                <button onClick={() => navigate(`/repos/${row.repoId}`)}>Repo settings</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
