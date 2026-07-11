import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { verifySignature } from '../shared/hmac.js';
import { shouldClaim, toProvisionRequest, dedupeKey } from './filter.js';
import { planInstallation } from './install-filter.js';
import { putQueuedRun, transitionRun } from '../shared/run-store.js';
import {
  upsertInstallation,
  setInstallationFlags,
  enableRepo,
  disableRepo,
} from '../shared/install-store.js';
import type { WorkflowJobEvent, InstallationEvent, RunStatus } from '../shared/types.js';

/**
 * Ingest λ — API Gateway `POST /webhook` handler (spec 01 webhook handling).
 *
 * 1. Verify `X-Hub-Signature-256` HMAC over the RAW body (constant-time).
 * 2. Branch on `X-GitHub-Event`. For `workflow_job` + `queued` + our label → enqueue a
 *    provisioning request onto SQS. Everything else acks fast (best-effort / no-op in M1).
 * 3. Always return 2xx quickly so GitHub's delivery never times out; real work is async.
 *
 * Env: WEBHOOK_SECRET_PARAM, RUNNER_LABELS_PARAM, QUEUE_URL, TABLE_NAME.
 */

const sqs = new SQSClient({});

const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM!;
const RUNNER_LABELS_PARAM = process.env.RUNNER_LABELS_PARAM!;
const QUEUE_URL = process.env.QUEUE_URL!;

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

  // push / other events: acked fast; workflow re-parse lands in M3.
  return json(202, { ok: true, ignored: ghEvent });
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
  return json(202, { ok: true, action: evt.action });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
