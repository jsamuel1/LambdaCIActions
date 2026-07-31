import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { verifySignature } from '../shared/hmac.js';
import { toProvisionRequest, dedupeKey, isRepoOptedOut } from './filter.js';
import { decideClaim, unreachableRunnerGroup } from './adopt.js';
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
import { recordWebhookDelivery, recordWebhookRejection } from '../shared/config-store.js';
import type {
  WorkflowJobEvent,
  InstallationEvent,
  PushEvent,
  DiscoveryRequest,
  RepoMode,
  RunStatus,
} from '../shared/types.js';

/**
 * Ingest λ — API Gateway `POST /webhook` handler (spec 01 webhook handling).
 *
 * 1. Verify `X-Hub-Signature-256` HMAC over the RAW body (constant-time).
 * 2. Branch on `X-GitHub-Event`. For `workflow_job` + `queued`, the claim decision combines
 *    the repo's onboarding mode with the job's labels (`label` → explicit LCA label only;
 *    `adopt` → standard `ubuntu-*` labels too, M5/ADR-030), then compat-gates against the
 *    stored workflow analysis (block ⇒ don't claim, spec 03) → enqueues a provisioning
 *    request onto SQS. `push` touching `.github/workflows/**` and installation repo grants
 *    → enqueue discovery scans (M3-S4). Everything else acks fast.
 * 3. Always return 2xx quickly so GitHub's delivery never times out; real work is async.
 *
 * Env: WEBHOOK_SECRET_PARAM, RUNNER_LABELS_PARAM, QUEUE_URL, DISCOVERY_QUEUE_URL,
 *      TABLE_NAME.
 */

const sqs = new SQSClient({});

const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM!;
const RUNNER_LABELS_PARAM = process.env.RUNNER_LABELS_PARAM!;

/**
 * Cache TTL for the claimed-label config, deliberately much shorter than `getParam`'s 5-minute
 * default (ADR-034).
 *
 * A label change from the Settings screen is presented as taking effect on the very NEXT
 * `workflow_job` delivery — that is what the mandatory impact preview describes, and the whole
 * point of previewing which jobs move. With the default TTL a warm container would keep claiming
 * against the PREVIOUS label set for up to 5 minutes: jobs the operator just stopped claiming
 * would still be provisioned here, and jobs they just adopted would still go to GitHub-hosted,
 * with nothing on the screen saying so. Unlike the webhook secret there is no recovery signal to
 * trigger a re-read from (an unclaimed job simply runs elsewhere), so the bound has to be the TTL
 * itself. Labels are a non-secret String, so the cost is one extra `GetParameter` per container
 * per 30 s on the webhook path.
 */
export const RUNNER_LABELS_TTL_MS = 30_000;
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
  const verified = await verifyWithRotation(rawBody, signature, secret, () =>
    getParam(WEBHOOK_SECRET_PARAM, 0),
  );
  if (!verified) {
    // Record the rejection (best-effort): GitHub reaching us with a signature we can't
    // verify is the signature of a half-finished secret rotation, and the Settings screen
    // must be able to distinguish it from silence (spec 04 § webhook health).
    await recordWebhookRejection().catch((err) =>
      console.error(JSON.stringify({ msg: 'webhook rejection heartbeat failed', error: errMsg(err) })),
    );
    return json(401, { error: 'invalid signature' });
  }

  // Delivery heartbeat (spec 04 § webhook health): real evidence that GitHub is delivering
  // to THIS environment, recorded for every verified delivery regardless of event type.
  // One fixed-key UpdateItem, and best-effort — a failed heartbeat must never drop a webhook.
  //
  // NOT awaited before the claim decision: Ingest must ack GitHub fast (a slow ack means
  // redelivery), and this write is diagnostics. It is awaited at the END of the request via
  // `heartbeat`, so the Lambda is not frozen mid-write, but it never sits in front of the
  // enqueue latency.
  const heartbeat = recordWebhookDelivery({
    event: ghEvent ?? 'unknown',
    deliveryId: headers['x-github-delivery'] ?? headers['X-GitHub-Delivery'],
  }).catch((err) =>
    console.error(JSON.stringify({ msg: 'webhook heartbeat failed', error: errMsg(err) })),
  );

  try {
    return await dispatch(rawBody, ghEvent);
  } finally {
    await heartbeat;
  }
}

/**
 * At most one uncached secret re-read per container per window. `/webhook` is public and the
 * signature check is what rejects an anonymous caller, so an unthrottled re-read would let
 * anyone drive an SSM `GetParameter` per request.
 */
const SECRET_RECHECK_MS = 30_000;
let lastSecretRecheck = 0;

/**
 * Verify a delivery, tolerating an in-flight webhook-secret rotation (ADR-034).
 *
 * `getParam` caches for 5 minutes, so a WARM container keeps verifying against the PREVIOUS
 * secret for up to that long after a relink rotated it — while GitHub already signs with the new
 * one. GitHub does NOT retry a delivery that failed verification, so every `workflow_job` in that
 * window would be silently lost, and the Settings screen would read `degraded` for a rotation
 * that actually succeeded. One bounded uncached re-read closes the window; because it goes
 * through `getParam(name, 0)` it also refreshes the container's cache, so subsequent deliveries
 * verify on the first attempt.
 *
 * Guards, in order: an absent/malformed signature never triggers a re-read (nothing to rotate
 * toward), the re-read is rate-bounded per container, a read fault degrades to rejection rather
 * than a 5xx, and an unchanged value short-circuits. Exported for tests — `readFresh` is the
 * uncached-read seam.
 */
export async function verifyWithRotation(
  rawBody: string,
  signature: string | undefined,
  cachedSecret: string,
  readFresh: () => Promise<string>,
  now = Date.now(),
): Promise<boolean> {
  if (verifySignature(rawBody, signature, cachedSecret)) return true;
  // Only a well-formed signature is worth a re-read; `verifySignature` requires the `sha256=`
  // prefix, so mirror that check rather than spending a read on arbitrary junk.
  if (!signature || !signature.startsWith('sha256=')) return false;
  if (now - lastSecretRecheck < SECRET_RECHECK_MS) return false;
  lastSecretRecheck = now;
  let fresh: string;
  try {
    fresh = await readFresh();
  } catch (err) {
    console.error(JSON.stringify({ msg: 'webhook secret re-read failed', error: errMsg(err) }));
    return false;
  }
  if (fresh === cachedSecret) return false;
  return verifySignature(rawBody, signature, fresh);
}

/** Test hook: reset the re-read throttle. */
export function _resetSecretRecheck(): void {
  lastSecretRecheck = 0;
}

/** Route a signature-verified delivery to its handler. */
async function dispatch(
  rawBody: string,
  ghEvent: string | undefined,
): Promise<APIGatewayProxyResultV2> {
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

  // Only `queued` is a claim trigger. `waiting` (deployment-gate) jobs are not runnable yet;
  // GitHub re-delivers them as `queued` once approved.
  if (wf.action !== 'queued') {
    return json(202, { ok: true, claimed: false, ignored: wf.action });
  }

  const claimedLabels = (await getParam(RUNNER_LABELS_PARAM, RUNNER_LABELS_TTL_MS))
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  // Repo config gate FIRST (was: after the label check). Adopt mode (M5, ADR-030) makes the
  // repo's `mode` an INPUT to the claim decision, not just an opt-out — a job with no LCA
  // label is claimed iff the repo opted into adopt. So the row is read before deciding.
  //
  // Fails OPEN on a lookup error, but "open" here means `label` mode (the safe default):
  // a DDB fault must never silently start intercepting a repo's `ubuntu-latest` jobs.
  let repoMode: RepoMode | undefined;
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
    repoMode = repo?.mode;
  } catch (err) {
    console.error(
      JSON.stringify({
        msg: 'repo config lookup failed (defaulting to label mode)',
        error: errMsg(err),
      }),
    );
  }

  const decision = decideClaim({
    jobLabels: wf.workflow_job?.labels ?? [],
    claimedLabels,
    mode: repoMode,
  });
  if (!decision.claim) {
    return json(202, { ok: true, claimed: false, reason: decision.reason });
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
    // Runner-GROUP gate (ADR-030). `runs-on: { group: X, labels: [...] }` requires a runner
    // that is in group X *and* carries the labels; we mint into the repo-level default group
    // only (`runner_group_id: 1`, spec 01 OQ-1). The `workflow_job` webhook carries just the
    // labels, so the group is invisible at claim time unless the stored analysis holds it —
    // and claiming such a job strands it forever (GitHub assigns it to nobody we control,
    // while our added participation stops it going anywhere else).
    //
    // Evidence-based, like the compat gate: refuse only when the matched analysis NAMES a
    // non-default group. With no analysis we cannot see the group at all, so the pre-existing
    // fail-open posture stands (recorded as the residual gap in ADR-030).
    const group = match?.job?.runner_group;
    if (unreachableRunnerGroup(group)) {
      console.log(
        JSON.stringify({
          msg: 'job not claimed — runs-on names a non-default runner group',
          repo: wf.repository.full_name,
          job: wf.workflow_job.name,
          workflow: match?.workflow.path,
          group,
        }),
      );
      return json(202, {
        ok: true,
        claimed: false,
        reason:
          `runs-on requests runner group '${group}'; LambdaCIActions registers runners in the ` +
          'repository default group only, so this job would never be assigned to one',
      });
    }
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

  const msg = toProvisionRequest(wf, decision.via);
  const key = dedupeKey(msg.repoId, msg.runId, msg.jobId);
  console.log(
    JSON.stringify({
      msg: 'job claimed',
      key,
      repo: msg.repoFullName,
      via: decision.via,
      reason: decision.reason,
    }),
  );

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
