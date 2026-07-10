import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { verifySignature } from '../shared/hmac.js';
import { shouldClaim, toProvisionRequest, dedupeKey } from './filter.js';
import type { WorkflowJobEvent } from '../shared/types.js';

/**
 * Ingest λ — API Gateway `POST /webhook` handler (spec 01 webhook handling).
 *
 * 1. Verify `X-Hub-Signature-256` HMAC over the RAW body (constant-time).
 * 2. Branch on `X-GitHub-Event`. For `workflow_job` + `queued` + our label → enqueue a
 *    provisioning request onto SQS. Everything else acks fast (best-effort / no-op in M1).
 * 3. Always return 2xx quickly so GitHub's delivery never times out; real work is async.
 *
 * Env: WEBHOOK_SECRET_PARAM, RUNNER_LABELS_PARAM, QUEUE_URL.
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

  // installation* / push / other events: M1 acks fast; later milestones persist state.
  return json(202, { ok: true, ignored: ghEvent });
}

async function handleWorkflowJob(
  wf: WorkflowJobEvent,
): Promise<APIGatewayProxyResultV2> {
  const claimedLabels = (await getParam(RUNNER_LABELS_PARAM))
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  if (!shouldClaim(wf, claimedLabels)) {
    return json(202, { ok: true, claimed: false });
  }

  const msg = toProvisionRequest(wf);
  const key = dedupeKey(msg.repoId, msg.runId, msg.jobId);

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
