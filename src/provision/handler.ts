import { LambdaClient } from '@aws-sdk/client-lambda';
import { randomBytes } from 'node:crypto';
import type { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { generateJitConfig } from '../shared/github-app.js';
import { launchMicroVM } from '../shared/microvm.js';
import { transitionRun, putJitConfig, stampMicrovmId } from '../shared/run-store.js';
import { hashHookToken } from '../hook/broker-core.js';
import { listWorkflowAnalyses } from '../shared/workflow-store.js';
import { getRepo } from '../shared/install-store.js';
import { matchJobAnalysis } from '../ingest/job-match.js';
import type { ProvisionRequest, RunHookPayload } from '../shared/types.js';
import { resolveFlavor, type ResolveOptions } from './flavor.js';

/**
 * Provision λ — SQS consumer (spec 02 provisioning lifecycle, ADR-012).
 *
 * Per message:
 *   1. Resolve the job's labels → flavor → image ARN (from SSM, published by build script).
 *      Resolution consumes the repo's FlavorMap override + the parsed job's step signals
 *      from the stored workflow analysis when available (M3-S4) — label-only otherwise.
 *   2. Mint a single-use JIT runner config via the GitHub App.
 *   3. `RunMicrovm` from the image ARN, passing the JIT config + metadata as the
 *      run-hook payload. The run↔VM mapping is persisted via the run store's `microvmId`
 *      (the GA API can't tag VMs — ADR-015), not a VM tag.
 *
 * Failure → throw → the record is reported in `batchItemFailures` so SQS redelivers it
 * (visibility timeout) and, after maxReceiveCount, routes to the DLQ. We use partial batch
 * responses so one poison message doesn't fail its whole batch.
 *
 * Env: APP_ID_PARAM, APP_PEM_PARAM, IMAGE_ARN_PARAM_PREFIX, TABLE_NAME, HOOK_BROKER_NAME,
 *      [RUNNER_ROLE_ARN].
 */

const lambda = new LambdaClient({});

const APP_ID_PARAM = process.env.APP_ID_PARAM!;
const APP_PEM_PARAM = process.env.APP_PEM_PARAM!;
const IMAGE_ARN_PARAM_PREFIX = process.env.IMAGE_ARN_PARAM_PREFIX!; // e.g. /lca/dev/config/image-arn-
const RUNNER_ROLE_ARN = process.env.RUNNER_ROLE_ARN; // optional microVM execution role

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await provisionOne(record);
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: 'provision failed',
          messageId: record.messageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

async function provisionOne(record: SQSRecord): Promise<void> {
  const req = JSON.parse(record.body) as ProvisionRequest;

  // Idempotency guard (spec 05): move queued→provisioning. A duplicate delivery whose run
  // already advanced (running/terminal) is rejected by the forward-only guard — skip the
  // launch so we never double-provision a microVM for the same job.
  const advanced = await transitionRun({
    repoId: req.repoId,
    runId: req.runId,
    jobId: req.jobId,
    to: 'provisioning',
  }).catch((err) => {
    // A DB fault shouldn't silently drop the launch; log and proceed (launch is still
    // idempotency-protected by the SQS FIFO dedup id upstream).
    console.error(JSON.stringify({ msg: 'provisioning transition failed', error: errMsg(err) }));
    return true;
  });
  if (!advanced) {
    console.log(
      JSON.stringify({ msg: 'skip provision — run already advanced', runId: req.runId, jobId: req.jobId }),
    );
    return;
  }

  // 1. flavor → image ARN. FlavorMap override + parsed step signals are best-effort: a
  //    missing analysis / DB fault degrades to label-only routing, never a failed launch.
  const resolveOpts = await lookupResolveOptions(req).catch((err) => {
    console.error(JSON.stringify({ msg: 'resolve-options lookup failed (label-only)', error: errMsg(err) }));
    return {} as ResolveOptions;
  });
  const { flavor, reason: flavorReason } = resolveFlavor(req.labels, resolveOpts);
  console.log(JSON.stringify({ msg: 'flavor resolved', runId: req.runId, jobId: req.jobId, flavor, reason: flavorReason }));
  const imageArn = await getParam(`${IMAGE_ARN_PARAM_PREFIX}${flavor}`);

  // 2. mint single-use JIT config (GitHub App chain)
  const appId = await getParam(APP_ID_PARAM);
  const pem = await getParam(APP_PEM_PARAM);
  const jitConfig = await generateJitConfig({
    appId,
    pem,
    installationId: req.installationId,
    owner: req.owner,
    repo: req.repo,
    runId: req.runId,
    jobId: req.jobId,
    labels: req.labels,
  });

  // 3. stash the JIT config in DynamoDB (the 4 KB run-hook payload can't hold it inline,
  //    ADR-015) together with the HASH of a freshly minted per-run capability token
  //    (ADR-021). The plaintext token goes only to the VM, in its launch payload: it is
  //    what lets the VM ask the hook broker for its own JIT config and its own
  //    self-terminate, WITHOUT holding table-wide DDB read or region-wide
  //    TerminateMicrovm itself.
  const hookToken = randomBytes(32).toString('base64url');
  const hookTokenHash = hashHookToken(hookToken);
  // Fail BEFORE minting a single-use JIT config / launching: an unset broker name would
  // launch a VM whose /run hook 400s on the missing pointer field, burning the JIT config
  // and stranding the VM until the Reaper. Failing here lets SQS retry, then DLQ.
  const brokerName = process.env.HOOK_BROKER_NAME;
  if (!brokerName) throw new Error('HOOK_BROKER_NAME is not set (ADR-020 brokered run hook)');
  const ref = await putJitConfig(req.repoId, {
    jitConfig,
    runId: req.runId,
    jobId: req.jobId,
    repoFullName: req.repoFullName,
    labels: req.labels,
    hookTokenHash,
  });
  const payload: RunHookPayload = {
    ref,
    region: process.env.AWS_REGION ?? 'us-west-2',
    broker: brokerName,
    token: hookToken,
  };

  let microvmId: string;
  try {
    ({ microvmId } = await launchMicroVM(lambda, {
      imageArn,
      runId: req.runId,
      jobId: req.jobId,
      payload,
      executionRoleArn: RUNNER_ROLE_ARN,
      // Per-run runtime logs (run-hook + runner agent) — diagnosable failures (ADR-016).
      logGroup: `/aws/lambda/microvms/runs/lca-${process.env.LCA_ENV ?? 'dev'}`,
    }));
  } catch (err) {
    // Launch failed — record the failure so the run isn't a ghost, then rethrow so SQS
    // retries → DLQ after maxReceiveCount.
    await transitionRun({
      repoId: req.repoId,
      runId: req.runId,
      jobId: req.jobId,
      to: 'failed',
      flavor,
      reason: `launch failed: ${errMsg(err)}`,
    }).catch(() => {});
    throw err;
  }

  // 4. stamp the run↔VM mapping FIRST and unconditionally (ADR-019): the hook broker reads
  //    `microvmId` off this row to self-terminate on the VM's behalf (ADR-021), and the
  //    Reaper correlates against it — it must land even if the status already raced ahead
  //    (an ultra-fast job's `completed` webhook can beat this write; transitionRun's
  //    forward-only guard would then drop the mapping on the floor). The same write mirrors
  //    the capability token hash onto the row: the JIT config item ages out after 30 min but
  //    the brokered terminate fires at job END, so terminate authorizes off this row.
  await stampMicrovmId({
    repoId: req.repoId,
    runId: req.runId,
    jobId: req.jobId,
    microvmId,
    hookTokenHash,
  }).catch((err) => {
    console.error(JSON.stringify({ msg: 'microvmId stamp failed', error: errMsg(err) }));
  });

  // 5. mark running
  await transitionRun({
    repoId: req.repoId,
    runId: req.runId,
    jobId: req.jobId,
    to: 'running',
    flavor,
  }).catch((err) => {
    console.error(JSON.stringify({ msg: 'running transition failed', error: errMsg(err) }));
  });

  console.log(
    JSON.stringify({
      msg: 'microVM launched',
      microvmId,
      flavor,
      runId: req.runId,
      jobId: req.jobId,
      repo: req.repoFullName,
    }),
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Assemble ResolveOptions for a job: the repo's FlavorMap override (repo row) + the
 * job's parsed step signals (stored workflow analysis, matched by rendered name).
 * Either half may be absent — resolveFlavor treats missing opts as label-only.
 */
async function lookupResolveOptions(req: ProvisionRequest): Promise<ResolveOptions> {
  const opts: ResolveOptions = {};

  const repo = await getRepo(req.installationId, req.repoId).catch(() => undefined);
  if (repo?.flavorMap) opts.flavorMap = repo.flavorMap;

  if (req.jobName) {
    const analyses = await listWorkflowAnalyses(req.repoId).catch(() => []);
    const match = matchJobAnalysis(analyses, {
      workflowName: req.workflowName,
      jobName: req.jobName,
    });
    if (match) opts.signals = match.job.step_signals;
  }

  return opts;
}
