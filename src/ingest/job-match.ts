import type { CompatResult, ParsedJob, WorkflowAnalysisRecord } from '../shared/types.js';

/**
 * Match a `workflow_job` webhook back to a stored workflow analysis (M3-S4 wiring).
 *
 * The webhook carries the *rendered* job name (`workflow_job.name`) and the enclosing
 * workflow's name (`workflow_job.workflow_name`) — not the file path or job id — so
 * matching is heuristic and BEST-EFFORT:
 *
 *   - workflow: match `workflow_name` against the parsed `name`, the file path, or the
 *     basename — GitHub renders a nameless workflow's `workflow_name` as the file PATH
 *     (`.github/workflows/ci.yml`), while our parser falls back to the basename.
 *   - job: the rendered name is the job's custom `name:` if set, else its id; matrix jobs
 *     render as `<name> (<dim1>, <dim2>, …)` — matched by prefix.
 *
 * No match ⇒ undefined ⇒ callers fall back to label-only behavior (never block a claim on
 * a failed lookup — fail open, spec 03 § routing).
 *
 * Pure — no I/O.
 */

/**
 * Rendered-workflow-name match. GitHub sets `workflow_name` to the workflow's `name:`
 * when present, else the FILE PATH relative to the repo root — whereas our parser's
 * fallback is the basename. Accept any of the three so nameless workflows still match.
 */
function workflowNameMatches(a: WorkflowAnalysisRecord, rendered: string): boolean {
  if (a.name === rendered || a.path === rendered) return true;
  const base = a.path.split('/').pop();
  return base === rendered;
}

/** Rendered-name match for one parsed job (exact, or matrix `name (…)` prefix). */
function jobNameMatches(job: ParsedJob, rendered: string): boolean {
  const base = job.name ?? job.id;
  if (rendered === base) return true;
  // Matrix render: "base (val1, val2)". A custom name with expressions (`${{ … }}`)
  // won't literal-match — that's fine, we fail open.
  return rendered.startsWith(`${base} (`);
}

export interface JobMatch {
  workflow: WorkflowAnalysisRecord;
  job: ParsedJob;
  compat?: CompatResult;
}

/**
 * Find the stored analysis entry for a webhook job. `workflowName` narrows the candidate
 * workflows when present; a unique job-name match across all analyses also succeeds
 * (workflow_name can be absent on older payloads).
 */
export function matchJobAnalysis(
  analyses: WorkflowAnalysisRecord[],
  params: { workflowName?: string | null; jobName: string },
): JobMatch | undefined {
  const candidates = params.workflowName
    ? analyses.filter((a) => a.parsed && workflowNameMatches(a, params.workflowName!))
    : analyses.filter((a) => a.parsed);

  const matches: JobMatch[] = [];
  for (const wf of candidates) {
    for (const job of wf.parsed?.jobs ?? []) {
      if (jobNameMatches(job, params.jobName)) {
        matches.push({ workflow: wf, job, compat: wf.compat?.jobs[job.id] });
      }
    }
  }
  // Ambiguous (same rendered name in several workflows, no workflow_name to narrow) ⇒
  // fail open rather than guess wrong.
  return matches.length === 1 ? matches[0] : undefined;
}
