import type { WorkflowJobEvent, ProvisionRequest, RepoRecord } from '../shared/types.js';

/**
 * Decide whether a `workflow_job` event is one LambdaCIActions should provision a runner
 * for (spec 01 label contract, ADR-005 `label` mode).
 *
 * A job is claimed iff:
 *   - action === 'queued' (the hot-path trigger; other actions are status updates), AND
 *   - the job's `runs-on` labels include at least one of our claimed labels.
 *
 * `claimedLabels` comes from config (`/lca/<env>/config/runner-labels`), defaulting to the
 * base flavor label. Matching is case-insensitive to match GitHub's label handling.
 */
export function shouldClaim(
  event: Pick<WorkflowJobEvent, 'action' | 'workflow_job'>,
  claimedLabels: string[],
): boolean {
  if (event.action !== 'queued') return false;
  const jobLabels = (event.workflow_job?.labels ?? []).map((l) => l.toLowerCase());
  const claims = claimedLabels.map((l) => l.toLowerCase());
  return jobLabels.some((l) => claims.includes(l));
}

/**
 * Whether the repo's stored config opts OUT of LambdaCIActions (spec 04 Repos screen,
 * ADR-025). The console writes `enabled` / `mode` on the repo row; this is the control-plane
 * enforcement point for them — without it the UI's Disable button would be cosmetic.
 *
 * Opt-out iff `enabled === false` (explicit disable, or `installation_repositories.removed`)
 * or `mode === 'off'`. A MISSING repo row is NOT an opt-out: rows predating M4 (and any
 * lookup failure the caller swallows) must fail OPEN so a config read can never stop a
 * labeled job (spec 03 § routing).
 */
export function isRepoOptedOut(repo: RepoRecord | undefined): boolean {
  if (!repo) return false;
  return repo.enabled === false || repo.mode === 'off';
}

/** Project a claimed webhook event into the SQS provisioning message. */
export function toProvisionRequest(event: WorkflowJobEvent): ProvisionRequest {
  return {
    installationId: event.installation.id,
    repoId: event.repository.id,
    repoFullName: event.repository.full_name,
    owner: event.repository.owner.login,
    repo: event.repository.name,
    runId: event.workflow_job.run_id,
    jobId: event.workflow_job.id,
    labels: event.workflow_job.labels,
    jobName: event.workflow_job.name,
    workflowName: event.workflow_job.workflow_name ?? null,
  };
}

/**
 * Stable idempotency / dedupe key for a job (spec 05, hot-path idempotency).
 * Shared by Ingest (SQS message dedup id) and Provision (dedupe guard).
 */
export function dedupeKey(repoId: number, runId: number, jobId: number): string {
  return `${repoId}:${runId}:${jobId}`;
}
