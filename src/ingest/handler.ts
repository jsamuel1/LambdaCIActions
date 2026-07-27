import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { verifySignature } from '../shared/hmac.js';
import { shouldClaim, toProvisionRequest, dedupeKey, isRepoOptedOut } from './filter.js';
import { planInstallation } from './install-filter.js';
import { matchJobAnalysis } from './job-match.js';
import {
  pushTouchesWorkflows,
  pushToDiscoveryRequest,
  installationToDiscoveryRequests,
} from '../discover/filter.js';
import { putQueuedRun, transitionRun } from '../shared/run-store.js';
import { listWorkflowAnalyses } from '../shared/workflow-store.js';
import {
  upsertInstallation,
  setInstallationFlags,
  enableRepo,
  disableRepo,
  getRepo,
} from '../shared/install-store.js';
import type {
  WorkflowJobEvent,
  InstallationEvent,
  PushEvent,
  DiscoveryRequest,
  RunStatus,
} from '../shared/types.js';

/**
 * Ingest λ — API Gateway `POST /webhook` handler (spec 01 webhook handling).
 *
 * 1. Verify `X-Hub-Signature-256` HMAC over the RAW body (constant-time).
 * 2. Branch on `X-GitHub-Event`. For `workflow_job` + `queued` + our label → compat-gate
 *    against the stored workflow analysis (block ⇒ don't claim, spec 03) → enqueue a
 *    provisioning request onto SQS. `push` touching `.github/workflows/**` and
 *    installation repo grants → enqueue discovery scans (M3-S4). Everything else acks fast.
 * 3. Always return 2xx quickly so GitHub's delivery never times out; real work is async.
 *
 * Env: WEBHOOK_SECRET_PARAM, RUNNER_LABELS_PARAM, QUEUE_URL, DISCOVERY_QUEUE_URL,
 *      TABLE_NAME.
 */

const sqs = new SQSClient({});

const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM!;
const RUNNER_LABELS_PARAM = process.env.RUNNER_LABELS_PARAM!;
const QUEUE_URL = process.env.QUEUE_URL!;
const DISCOVERY_QUEUE_URL = process.env.DISCOVERY_QUEUE_URL;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  // API GW may base64-encode the body; verify HMAC over the exact bytes GitHub sent.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body ?? '';

  const headers = event.headers ?? {};
  const signature = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'];
  const ghEvent = headers['x-github-event'] ?? headers['X-GitHub-Event'];

  const secret = await getParam(WEBHOOK_SECRET_PARAM);
  if (!verifySignature(rawBody, signature, secret)) {
    return json(401, { error: 'invalid signature' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'invalid JSON' });
  }

  if (ghEvent === 'workflow_job') {
    return handleWorkflowJob(payload as WorkflowJobEvent);
  }

  if (ghEvent === 'installation' || ghEvent === 'installation_repositories') {
    return handleInstallation(payload as InstallationEvent);
  }

  if (ghEvent === 'push') {
    return handlePush(payload as PushEvent);
  }

  // other events: acked fast.
  return json(202, { ok: true, ignored: ghEvent });
}

/** Enqueue one discovery scan (best-effort — a lost scan is recovered by the next push). */
async function enqueueDiscovery(req: DiscoveryRequest): Promise<void> {
  if (!DISCOVERY_QUEUE_URL) return; // discovery not wired in this env
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: DISCOVERY_QUEUE_URL,
      MessageBody: JSON.stringify(req),
    }),
  );
}

/** `push` touching `.github/workflows/**` → re-scan the repo (spec 03 § Discovery). */
async function handlePush(evt: PushEvent): Promise<APIGatewayProxyResultV2> {
  if (!pushTouchesWorkflows(evt)) {
    return json(202, { ok: true, ignored: 'push (no workflow changes)' });
  }
  const req = pushToDiscoveryRequest(evt);
  if (!req) return json(202, { ok: true, ignored: 'push (no installation)' });
  try {
    await enqueueDiscovery(req);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'discovery enqueue failed', error: errMsg(err) }));
  }
  return json(202, { ok: true, discovery: req.repoFullName });
}

async function handleWorkflowJob(
  wf: WorkflowJobEvent,
): Promise<APIGatewayProxyResultV2> {
  // Status webhooks (in_progress / completed) advance the run record; best-effort so a
  // failed DB write never fails the webhook (the Reaper backstops lost transitions).
  if (wf.action === 'in_progress' || wf.action === 'completed') {
    await handleStatusUpdate(wf);
    return json(202, { ok: true, status: wf.action });
  }

  const claimedLabels = (await getParam(RUNNER_LABELS_PARAM))
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  if (!shouldClaim(wf, claimedLabels)) {
    return json(202, { ok: true, claimed: false });
  }

  // Repo opt-out gate (spec 04 Repos screen / ADR-025): the console's `enabled=false` and
  // `mode='off'` are enforced HERE — the management plane only writes config. Fails OPEN:
  // a missing row (pre-M4 repos) or a DDB fault must never stop a labeled job.
  try {
    const repo = await getRepo(wf.installation.id, wf.repository.id);
    if (isRepoOptedOut(repo)) {
      console.log(
        JSON.stringify({
          msg: 'job not claimed — repo opted out',
          repo: wf.repository.full_name,
          enabled: repo?.enabled,
          mode: repo?.mode ?? 'label',
        }),
      );
      return json(202, { ok: true, claimed: false, disabled: true });
    }
  } catch (err) {
    console.error(
      JSON.stringify({ msg: 'repo opt-out lookup failed (failing open)', error: errMsg(err) }),
    );
  }

  // Compat gate (spec 03 § routing): a job whose stored analysis says `block` is not
  // eligible — don't claim it (GitHub-hosted still runs it). Fail OPEN: no stored
  // analysis / no unambiguous match / a DB fault must never stop a labeled job.
  try {
    const analyses = await listWorkflowAnalyses(wf.repository.id);
    const match = matchJobAnalysis(analyses, {
      workflowName: wf.workflow_job.workflow_name,
      jobName: wf.workflow_job.name,
    });
    if (match?.compat && !match.compat.eligible) {
      console.log(
        JSON.stringify({
          msg: 'job not claimed — compat block',
          repo: wf.repository.full_name,
          job: wf.workflow_job.name,
          workflow: match.workflow.path,
          messages: match.compat.messages.map((m) => m.code),
        }),
      );
      return json(202, { ok: true, claimed: false, blocked: true });
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: 'compat gate lookup failed (failing open)', error: errMsg(err) }));
  }

  const msg = toProvisionRequest(wf);
  const key = dedupeKey(msg.repoId, msg.runId, msg.jobId);

  // Persist a `queued` run row BEFORE enqueue so the UI + Reaper see the run even if the
  // enqueue or Provision fails. Idempotent: a duplicate delivery is a no-op.
  try {
    await putQueuedRun({
      repoId: msg.repoId,
      repoFullName: msg.repoFullName,
      installationId: msg.installationId,
      runId: msg.runId,
      jobId: msg.jobId,
      labels: msg.labels,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ msg: 'putQueuedRun failed (continuing to enqueue)', key, error: errMsg(err) }),
    );
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(msg),
      // FIFO dedupe by (repo,run,job) — a duplicate delivery within the dedup window is a
      // no-op (spec 05 idempotency). MessageGroupId keeps per-repo ordering loose.
      MessageDeduplicationId: key,
      MessageGroupId: String(msg.repoId),
    }),
  );

  return json(202, { ok: true, claimed: true, key });
}

/** Map a `workflow_job` status webhook to a run transition. */
async function handleStatusUpdate(wf: WorkflowJobEvent): Promise<void> {
  let to: RunStatus | undefined;
  if (wf.action === 'in_progress') to = 'running';
  else if (wf.action === 'completed') {
    // conclusion is success | failure | cancelled | skipped | timed_out | …
    to = wf.workflow_job.conclusion === 'success' ? 'completed' : 'failed';
  }
  if (!to) return;
  try {
    await transitionRun({
      repoId: wf.repository.id,
      runId: wf.workflow_job.run_id,
      jobId: wf.workflow_job.id,
      to,
      reason: to === 'failed' ? `job ${wf.workflow_job.conclusion ?? 'failed'}` : undefined,
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: 'status transition failed', error: errMsg(err) }));
  }
}

/** Apply an installation / installation_repositories lifecycle event (spec 01). */
async function handleInstallation(
  evt: InstallationEvent,
): Promise<APIGatewayProxyResultV2> {
  const intent = planInstallation(evt);
  try {
    if (intent.upsertInstallation) await upsertInstallation(intent.upsertInstallation);
    if (intent.setFlags) await setInstallationFlags(intent.setFlags.installationId, intent.setFlags);
    if (intent.enableRepos?.repos) {
      for (const r of intent.enableRepos.repos) {
        await enableRepo(intent.enableRepos.installationId, r);
      }
    }
    if (intent.disableRepoIds) {
      for (const rid of intent.disableRepoIds.repoIds) {
        await disableRepo(intent.disableRepoIds.installationId, rid);
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: 'installation lifecycle failed', action: evt.action, error: errMsg(err) }));
    // Still 202 — GitHub retries on 5xx would just replay; our writes are idempotent, but
    // a persistent DB fault shouldn't wedge GitHub's delivery queue.
  }

  // Newly-granted repos get an initial workflow scan (spec 03 § Discovery). Best-effort.
  for (const req of installationToDiscoveryRequests(evt)) {
    try {
      await enqueueDiscovery(req);
    } catch (err) {
      console.error(
        JSON.stringify({ msg: 'install discovery enqueue failed', repo: req.repoFullName, error: errMsg(err) }),
      );
    }
  }
  return json(202, { ok: true, action: evt.action });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
