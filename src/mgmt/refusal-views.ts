import type { RefusalRecord, WorkflowAnalysisRecord } from '../shared/types.js';
import {
  readinessFor,
  worstState,
  type FlavorReadiness,
  type FlavorReadinessState,
} from '../shared/flavor-readiness.js';
import { toWorkflowView, type WorkflowJobView, type WorkflowView } from './views.js';

/**
 * Read models for the two console surfaces this milestone adds (ADR-050, ADR-051):
 * the **Unclaimed** job list, and the live-control-plane readiness overlay on routing.
 *
 * Deliberately its own module rather than more of `views.ts`. `views.ts` owns the run/cost/compat
 * projections, all of which are keyed off a run row; neither of these is. Keeping them apart also
 * keeps the concurrent per-flavor validation work in `views.ts` from colliding with this.
 */

// ---- unclaimed (refused) jobs ----------------------------------------------

export interface RefusalView {
  repoId: number;
  repoFullName: string;
  installationId: number;
  runId: number;
  jobId: number;
  code: string;
  reason: string;
  fix?: string;
  labels: string[];
  /** The live allowlist as it was AT REFUSAL TIME — not as it is now. */
  claimedLabels: string[];
  mode: string;
  workflowName?: string;
  jobName?: string;
  runnerGroup?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Deliveries seen. >1 ⇒ still recurring, not a one-off. */
  occurrences: number;
  /** GitHub URL for the workflow run, so the operator can go straight to the stuck job. */
  githubUrl: string;
}

/**
 * Project a stored refusal onto the API shape.
 *
 * `occurrences` defaults to 1 rather than 0: the row only exists because a refusal happened, and
 * a row written before the counter existed would otherwise read as "never occurred".
 */
export function toRefusalView(r: RefusalRecord): RefusalView {
  return {
    repoId: r.repoId,
    repoFullName: r.repoFullName,
    installationId: r.installationId,
    runId: r.runId,
    jobId: r.jobId,
    code: r.code,
    reason: r.reason,
    fix: r.fix,
    labels: r.labels ?? [],
    claimedLabels: r.claimedLabels ?? [],
    mode: r.mode ?? 'label',
    workflowName: r.workflowName,
    jobName: r.jobName,
    runnerGroup: r.runnerGroup,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    occurrences: r.occurrences ?? 1,
    githubUrl: `https://github.com/${r.repoFullName}/actions/runs/${r.runId}`,
  };
}

/**
 * Newest-first by most recent occurrence.
 *
 * Both refusal indexes already sort by `lastSeenAt`, so this is a merge-order tie-breaker rather
 * than the primary ordering — `collectVisible` can concatenate several index pages, and an
 * unordered join of ordered pages is not itself ordered.
 */
export function sortRefusalsNewestFirst(refusals: RefusalRecord[]): RefusalRecord[] {
  return [...refusals].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

// ---- routing readiness overlay --------------------------------------------

/**
 * Live-control-plane verdict attached to a job's stored route (ADR-051).
 *
 * Computed at READ time, never stored on the analysis row. The stored route is a function of the
 * workflow YAML plus the catalog and is correct whenever it was written; runnability is a
 * function of the deployment's allowlist and published images, which change without any push to
 * re-trigger discovery. Persisting this would produce a row that says `ready` about a control
 * plane that has since lost the image — the exact class of stale green this exists to kill.
 */
export interface RouteReadiness {
  flavor?: string;
  state: FlavorReadinessState | 'unknown';
  runnable: boolean;
  problem?: string;
  fix?: string;
}

/**
 * Deliberately SEPARATE from `compat` on the job view.
 *
 * `compat` is the workflow-versus-arm64-Linux verdict: it is stored, rolled up by
 * `rollupCompat`, and its `block` level is what Ingest's compat gate refuses on. Folding a
 * live platform gap into it would (a) make `rollupCompat` counts move when an operator publishes
 * an image with no workflow change, and (b) imply Ingest refuses the job for a compat reason
 * when in fact the claim gate never sees it. So platform readiness rides alongside as its own
 * axis, and the UI renders it as a platform warning rather than a compat finding.
 */
export interface WorkflowJobViewWithReadiness extends WorkflowJobView {
  platform: RouteReadiness;
}

export interface WorkflowViewWithReadiness extends Omit<WorkflowView, 'jobs'> {
  jobs: WorkflowJobViewWithReadiness[];
  /** Worst platform state across the workflow's jobs (`unknown` if any route is unknown). */
  platformLevel: FlavorReadinessState | 'unknown';
}

/**
 * Attach live readiness to one job's route.
 *
 * `unknown` — not `ready` — whenever the verdict cannot be established: no resolved flavor, a
 * flavor absent from this deployment's catalog, or a snapshot whose live read failed. Defaulting
 * to `ready` is precisely the bug (a reassuring green over a control plane that cannot run the
 * job); defaulting to a failure state would cry wolf on a transient SSM error.
 */
export function routeReadiness(
  flavor: string | undefined,
  readiness: readonly FlavorReadiness[] | undefined,
): RouteReadiness {
  if (!flavor) return { state: 'unknown', runnable: false };
  if (!readiness) return { flavor, state: 'unknown', runnable: false };
  const hit = readinessFor(readiness, flavor);
  if (!hit) {
    return {
      flavor,
      state: 'unknown',
      runnable: false,
      problem: `'${flavor}' is not in this deployment's flavor catalog.`,
      fix: 'Re-scan the repo so routing is recomputed against the current catalog.',
    };
  }
  return {
    flavor,
    state: hit.state,
    runnable: hit.runnable,
    ...(hit.problem ? { problem: hit.problem } : {}),
    ...(hit.fix ? { fix: hit.fix } : {}),
  };
}

/**
 * Flatten a stored analysis and overlay live readiness per job.
 *
 * `readiness === undefined` means the live read failed: every job reports `unknown`, and the
 * workflow's `platformLevel` is `unknown` too, so the UI says "could not check" instead of
 * either a false green or a false alarm.
 */
export function toWorkflowViewWithReadiness(
  a: WorkflowAnalysisRecord,
  readiness: readonly FlavorReadiness[] | undefined,
): WorkflowViewWithReadiness {
  const base = toWorkflowView(a);
  const jobs: WorkflowJobViewWithReadiness[] = base.jobs.map((j) => ({
    ...j,
    platform: routeReadiness(j.flavor, readiness),
  }));
  const states = jobs.map((j) => j.platform.state);
  return {
    ...base,
    jobs,
    platformLevel: states.some((s) => s === 'unknown')
      ? 'unknown'
      : worstState(states as FlavorReadinessState[]),
  };
}

/**
 * How many of a repo's jobs route somewhere the live control plane cannot run.
 *
 * Counted from the readiness overlay rather than from compat, so the Repos list can badge a repo
 * whose workflows are all `compat: ok` and yet cannot run — the state that produced this card.
 */
export function countUnrunnableJobs(workflows: readonly WorkflowViewWithReadiness[]): number {
  let n = 0;
  for (const wf of workflows) {
    for (const job of wf.jobs) {
      // `unknown` is NOT counted: an unresolved route is not evidence of a broken platform, and
      // a badge that lights up on a transient SSM failure is a badge operators learn to ignore.
      if (job.platform.state !== 'unknown' && !job.platform.runnable) n += 1;
    }
  }
  return n;
}
