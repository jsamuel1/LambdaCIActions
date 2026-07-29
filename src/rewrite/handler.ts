import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import {
  ensureBranch,
  ensurePullRequest,
  findOpenPullRequest,
  getBranchSha,
  getFileContent,
  getRepoDefaultBranch,
  putFileOnBranch,
} from '../shared/github-app.js';
import { getRepo } from '../shared/install-store.js';
import { listWorkflowAnalyses } from '../shared/workflow-store.js';
import {
  planFileRewrite,
  rewriteBranchName,
  rewritePrBody,
  rewriteTargets,
  type FileRewrite,
} from '../mgmt/rewrite.js';
import type { RewriteRequest } from '../shared/types.js';

/**
 * Rewrite λ — opt-in auto-rewrite PR (spec 03 § Auto-rewrite, ADR-031, M5).
 *
 * Consumes one `RewriteRequest` per message (enqueued by the management API when an operator
 * clicks "Open rewrite PR"), re-plans the rewrite from the CURRENT file contents, commits the
 * changed workflows onto a dedicated branch, and opens (or reuses) a PR.
 *
 * ## Three independent gates — all must pass
 *
 * 1. **Deployment flag** `REWRITE_ENABLED` (CDK context `-c rewrite=true`). Off by default;
 *    when off this λ is still deployed but refuses every request. This is the deployment-wide
 *    kill switch for the `contents:write` capability (AGENTS.md hard rule).
 * 2. **Per-repo opt-in** `rewriteEnabled` on the repo row, set from the console.
 * 3. **GitHub App permission.** If the App was installed without `contents:write`, GitHub
 *    answers 403 and we record that as the failure reason — we never ask for the permission
 *    implicitly.
 *
 * Why a separate λ instead of the management API: the mgmt λ deliberately holds NO GitHub App
 * PEM and cannot mint installation tokens (ADR-025). Writing to a customer repo from the
 * read-mostly management plane would collapse that boundary. The API only enqueues; this
 * control-plane function holds the credential.
 *
 * Env: APP_ID_PARAM, APP_PEM_PARAM, TABLE_NAME, REWRITE_ENABLED.
 */

const APP_ID_PARAM = process.env.APP_ID_PARAM!;
const APP_PEM_PARAM = process.env.APP_PEM_PARAM!;
const LCA_ENV = process.env.LCA_ENV ?? 'dev';
/** Deployment kill switch. Anything but the exact string `true` means disabled. */
const REWRITE_ENABLED = process.env.REWRITE_ENABLED === 'true';

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await rewriteOne(JSON.parse(record.body) as RewriteRequest);
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: 'rewrite failed',
          messageId: record.messageId,
          error: errMsg(err),
        }),
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

export interface RewriteOutcome {
  status: 'disabled' | 'not-opted-in' | 'nothing-to-do' | 'opened' | 'updated';
  prUrl?: string;
  files: FileRewrite[];
  reason?: string;
}

async function rewriteOne(req: RewriteRequest): Promise<RewriteOutcome> {
  if (!REWRITE_ENABLED) {
    const out: RewriteOutcome = {
      status: 'disabled',
      files: [],
      reason: 'auto-rewrite is disabled for this deployment (contents:write is off by default)',
    };
    console.log(JSON.stringify({ msg: 'rewrite refused', repo: req.repoFullName, ...out }));
    return out;
  }

  const repo = await getRepo(req.installationId, req.repoId);
  // Strict `=== true`, matching the management API's own gate (`repoOptedIn` in
  // src/mgmt/handler.ts). The validator only admits a boolean, but this λ is the ENFORCEMENT
  // point for a `contents:write` capability and reads a row that a break-glass
  // `dynamodb update-item` can write directly — a truthiness test would accept a stray
  // `"false"` / `1` and open a PR on a repo the console still shows as opted out.
  if (repo?.rewriteEnabled !== true) {
    const out: RewriteOutcome = {
      status: 'not-opted-in',
      files: [],
      reason: 'repo has not opted into the auto-rewrite PR',
    };
    console.log(JSON.stringify({ msg: 'rewrite refused', repo: req.repoFullName, ...out }));
    return out;
  }

  const [appId, pem] = await Promise.all([getParam(APP_ID_PARAM), getParam(APP_PEM_PARAM)]);
  const creds = { appId, pem, installationId: req.installationId, owner: req.owner, repo: req.repo };

  // Establish which ref to PLAN against before writing anything. The branch is NOT created
  // here: creating a ref is a visible, permanent change to the customer's repository, and a
  // request that turns out to have nothing to rewrite (the common second-click case) must
  // leave no trace. So probe first, and create only once there is an edit to commit.
  const baseBranch = await getRepoDefaultBranch(creds);
  const branch = rewriteBranchName(LCA_ENV);
  const existingSha = await getBranchSha({ ...creds, branch });
  // Plan (and take blob shas) from the ref we are about to WRITE to. On a first run the
  // branch does not exist yet, so we plan against the default branch it will be cut from; on
  // a re-run the branch already holds our earlier rewrite, and reading the default branch
  // instead would hand us a stale blob sha — every write would then 409, retry, and DLQ (and
  // a partially-applied multi-file rewrite could never be completed).
  const planRef = existingSha ? branch : baseBranch;

  // Re-plan against the CURRENT file contents rather than trusting the dry run the operator
  // saw: the workflow may have changed since. `rewriteTargets` skips jobs that already carry
  // an LCA label, so a re-run naturally becomes a no-op for files we already rewrote.
  const analyses = await listWorkflowAnalyses(req.repoId);
  const plans: { plan: FileRewrite; sha: string }[] = [];
  const missing: string[] = [];
  for (const analysis of analyses) {
    if (!analysis.parsed) continue;
    const targets = rewriteTargets(analysis.parsed.jobs, analysis.routes ?? {});
    if (!targets.length) continue;
    // A stored analysis can outlive its file: Discovery UPSERTS one row per workflow and never
    // prunes rows for files that were deleted or renamed. Reading such a path 404s, and letting
    // that throw fails the whole request — SQS redelivers, 404s again, and the message DLQs
    // (alarming) while every OTHER workflow in the repo goes unrewritten and the operator gets
    // no PR. A vanished file is repo content changing under a stale row, not an infra fault, so
    // skip it and carry on with the files that do exist.
    let file: { content: string; sha: string };
    try {
      file = await getFileContent({ ...creds, path: analysis.path, ref: planRef });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      missing.push(analysis.path);
      console.log(
        JSON.stringify({
          msg: 'rewrite skipped a workflow that no longer exists (stale analysis row)',
          repo: req.repoFullName,
          path: analysis.path,
          ref: planRef,
        }),
      );
      continue;
    }
    const plan = planFileRewrite(analysis.path, file.content, targets);
    if (plan.edits.length) plans.push({ plan, sha: file.sha });
  }

  if (!plans.length) {
    // Nothing left to change. That is the NORMAL result of a second click: the first run
    // already rewrote every job, so `rewriteTargets` now skips them all. Reporting a bare
    // "nothing to do" would leave the operator hunting for the PR they just asked for, so
    // look for the open PR on our branch and return its URL when there is one. Only look when
    // the branch exists — on a first run with no candidates we never created one.
    let open = existingSha
      ? await findOpenPullRequest({ ...creds, branch }).catch((err) => {
          // Best-effort: the outcome is already "no change needed", and failing to decorate it
          // with a link must not turn a successful no-op into an SQS retry.
          console.error(JSON.stringify({ msg: 'rewrite PR lookup failed', error: errMsg(err) }));
          return undefined;
        })
      : undefined;

    // Branch exists, carries the rewrite, and no PR is open: OPEN ONE. This is not a rare
    // corner — it is the state the λ lands in whenever the commits succeeded and only the PR
    // call failed (a 5xx, or an App holding `contents:write` but not `pull_requests:write`).
    // The retry then re-plans against the rewrite branch, whose jobs now all carry LCA labels,
    // so `rewriteTargets` skips every one and the request degrades to a permanent no-op. Left
    // unhandled, the operator is told to DELETE the branch that holds their rewrite — advice
    // that discards the commits and still cannot produce a PR, because a fresh branch cut from
    // the default branch would just reach this same state again.
    //
    // The gates are already satisfied to get here, and opening the PR is literally the action
    // that was requested, so completing it is in scope. Best-effort: a failure must leave an
    // honest no-op rather than DLQ a request that changed nothing.
    let prCreated = false;
    if (!open && existingSha) {
      try {
        const pr = await ensurePullRequest({
          ...creds,
          branch,
          base: baseBranch,
          ...rewritePrBody([]),
        });
        open = { url: pr.url, number: pr.number };
        prCreated = pr.created;
      } catch (err) {
        // 422 is GitHub's "No commits between <base> and <branch>" — the branch's earlier
        // rewrite was merged (or is otherwise identical to base), so there is genuinely no PR
        // to open and deleting the stale branch IS the right advice. Anything else is a real
        // failure to report.
        console.error(
          JSON.stringify({
            msg: 'rewrite PR open on an existing branch failed',
            repo: req.repoFullName,
            branch,
            error: errMsg(err),
          }),
        );
      }
    }

    const out: RewriteOutcome = {
      status: open && prCreated ? 'opened' : 'nothing-to-do',
      files: [],
      ...(open ? { prUrl: open.url } : {}),
      reason: open
        ? prCreated
          ? `no workflow job needs an LCA label — branch '${branch}' already carried the rewrite, so its pull request was opened`
          : 'no workflow job needs an LCA label — the rewrite PR is already open'
        : missing.length
          ? // Every candidate workflow we held an analysis for has since been deleted or renamed.
            // Saying "no job needs a label" would be misleading — the jobs are gone, not routed —
            // so name the paths and the action that refreshes our view of the repo.
            `every rewrite candidate has been deleted or renamed since the last scan (${missing.join(', ')}); re-scan the repo to refresh its workflow analysis`
          : !existingSha
            ? 'no workflow job needs an LCA label'
            : // No edits, no open PR, and we could not open one: the branch's rewrite has already
              // been merged (GitHub refuses a PR with no commits between base and head), or the PR
              // call itself failed. We plan against that branch and never reset it (resetting would
              // be a force-push, ADR-031), so deleting it is the action that lets a fresh rewrite be
              // cut from the default branch.
              `no workflow job needs an LCA label on branch '${branch}', which already carries an earlier rewrite that could not be turned into a pull request (most likely already merged). ` +
              'Delete that branch in the repo to regenerate the PR from the default branch.',
    };
    console.log(JSON.stringify({ msg: 'rewrite no-op', repo: req.repoFullName, ...out }));
    return out;
  }

  // There ARE edits, so the branch is needed now. Idempotent: created on the first apply,
  // adopted (never reset — resetting would be a force-push, ADR-031) on a re-run.
  await ensureBranch({ ...creds, branch, fromBranch: baseBranch });

  for (const { plan, sha } of plans) {
    await putFileOnBranch({
      ...creds,
      branch,
      path: plan.path,
      content: plan.content!,
      sha,
      message: `ci: route ${plan.edits.map((e) => e.jobId).join(', ')} to LambdaCIActions runners`,
    });
  }

  const { title, body } = rewritePrBody(plans.map((p) => p.plan));
  const pr = await ensurePullRequest({ ...creds, branch, base: baseBranch, title, body });

  const out: RewriteOutcome = {
    status: pr.created ? 'opened' : 'updated',
    prUrl: pr.url,
    files: plans.map((p) => p.plan),
  };
  console.log(
    JSON.stringify({
      msg: 'rewrite PR ready',
      repo: req.repoFullName,
      actor: req.actor,
      status: out.status,
      pr: pr.url,
      files: plans.map((p) => p.plan.path),
    }),
  );
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a GitHub helper failure is a 404. `githubJson` throws
 * `GitHub <path> failed HTTP 404: …`, so the status is only available as text — matched on the
 * `HTTP 404` marker the same way `ensureBranch` does for its "branch does not exist" probe.
 */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('HTTP 404');
}
