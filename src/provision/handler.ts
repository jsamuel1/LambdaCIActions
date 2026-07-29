import { LambdaClient } from '@aws-sdk/client-lambda';
import { randomBytes } from 'node:crypto';
import type { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { generateJitConfig } from '../shared/github-app.js';
import { launchMicroVM } from '../shared/microvm.js';
import { transitionRun, putJitConfig, stampMicrovmId } from '../shared/run-store.js';
import { hashHookToken } from '../hook/broker-core.js';
import { redactSecret } from '../shared/redact.js';
import { listWorkflowAnalyses } from '../shared/workflow-store.js';
import { getRepo } from '../shared/install-store.js';
import { matchJobAnalysis } from '../ingest/job-match.js';
import type { ProvisionRequest, RunHookPayload } from '../shared/types.js';
import { resolveFlavor, type ResolveOptions } from './flavor.js';
import { jitRunnerLabels, classifyMintFailure, NoRunnerLabelsError, TooManyRunnerLabelsError, MAX_JIT_LABELS } from './labels.js';
import { emitMetrics, isQuotaError } from '../shared/metrics.js';

const LCA_ENV = process.env.LCA_ENV ?? 'dev';

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

  // Config guard FIRST, before anything irreversible (ADR-020). An unset broker name would
  // launch a VM whose /run hook 400s on the missing pointer field, stranding it until the
  // Reaper — and, worse, it would already have consumed a single-use GitHub JIT config.
  // Fail here (before the mint) so SQS retries and then DLQs with nothing burnt.
  const brokerName = process.env.HOOK_BROKER_NAME;
  if (!brokerName) throw new Error('HOOK_BROKER_NAME is not set (ADR-020 brokered run hook)');

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
  const via = req.claimVia ?? 'label';
  const metricDims = { env: LCA_ENV, flavor, via };
  const metricProps = {
    repo: req.repoFullName,
    runId: req.runId,
    jobId: req.jobId,
  };

  // 2. mint single-use JIT config (GitHub App chain). The runner must advertise the job's
  //    OWN labels or GitHub will never assign the job to it (labels are cumulative) — in
  //    adopt mode that includes the standard `ubuntu-*` label the workflow still carries.
  const runnerLabels = jitRunnerLabels(req.labels);
  const appId = await getParam(APP_ID_PARAM);
  const pem = await getParam(APP_PEM_PARAM);
  let jitConfig: string;
  try {
    // Refuse BEFORE the mint if nothing survived normalization: a runner with no labels gets
    // only GitHub's automatic defaults, can never match the job, and would strand a booted
    // VM plus a consumed single-use JIT config (see NoRunnerLabelsError).
    if (!runnerLabels.length) throw new NoRunnerLabelsError(req.labels ?? []);
    // …and refuse an over-cap set for the mirror-image reason: we cannot DROP a label either.
    // GitHub assigns a job only to a runner advertising every label in `runs-on`, so a
    // truncated set produces a VM the claimed job can never be assigned to.
    if (runnerLabels.length > MAX_JIT_LABELS) throw new TooManyRunnerLabelsError(runnerLabels);
    jitConfig = await generateJitConfig({
      appId,
      pem,
      installationId: req.installationId,
      owner: req.owner,
      repo: req.repo,
      runId: req.runId,
      jobId: req.jobId,
      labels: runnerLabels,
    });
  } catch (err) {
    // A rejected mint is usually PERMANENT (bad labels / revoked install), and retrying it
    // three times into the DLQ buys nothing but delay and noise. Classify: permanent ⇒ mark
    // the run failed with an actionable reason and return (message consumed); transient ⇒
    // rethrow so SQS redelivers. This is also the surface where an adopt-mode label refusal
    // becomes a readable console message instead of "launch failed".
    //
    // A transient failure must NOT write a terminal status: `failed` is terminal, and the
    // redelivered message's queued→provisioning idempotency guard would then refuse to
    // advance the row and return early — the retry we asked SQS for would never reach the
    // mint again. So the row stays `provisioning` (the Reaper backstops a run that never
    // recovers) and only the metric + log record the attempt.
    const { kind, reason } = classifyMintFailure(errMsg(err), runnerLabels);
    emitMetrics([{ name: 'ProvisionFailures', value: 1, unit: 'Count' }], { ...metricDims, kind: 'mint' }, metricProps);
    console.error(JSON.stringify({ msg: 'JIT mint failed', kind, reason, runId: req.runId, jobId: req.jobId }));
    if (kind === 'transient') throw new Error(reason);
    await transitionRun({
      repoId: req.repoId,
      runId: req.runId,
      jobId: req.jobId,
      to: 'failed',
      flavor,
      reason,
    }).catch(() => {});
    return;
  }

  // 3. stash the JIT config in DynamoDB (the 4 KB run-hook payload can't hold it inline,
  //    ADR-016) together with the HASH of a freshly minted per-run capability token
  //    (ADR-021). The plaintext token goes only to the VM, in its launch payload: it is
  //    what lets the VM ask the hook broker for its own JIT config and its own
  //    self-terminate, WITHOUT holding table-wide DDB read or region-wide
  //    TerminateMicrovm itself.
  const hookToken = randomBytes(32).toString('base64url');
  const hookTokenHash = hashHookToken(hookToken);
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
  const launchStartedAt = Date.now();
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
    //
    // REDACT FIRST (ADR-020): `payload` carries the plaintext capability token, and an SDK
    // validation/serialization error echoes the offending request value back ("Value '…' at
    // 'runHookPayload' failed to satisfy constraint"). Unscrubbed, that string lands in the
    // run row's `reason` — durable for 90 days and surfaced by the management API/UI — and in
    // the batch handler's log line, i.e. exactly the leak the guest-side redaction closes on
    // the other end of the same secret.
    const safeReason = redactSecret(errMsg(err), hookToken);
    const quota = isQuotaError(err);
    emitMetrics(
      [
        { name: 'ProvisionFailures', value: 1, unit: 'Count' },
        ...(quota ? [{ name: 'QuotaThrottles', value: 1, unit: 'Count' as const }] : []),
      ],
      { ...metricDims, kind: quota ? 'quota' : 'launch' },
      metricProps,
    );
    // A QUOTA refusal is transient — capacity, not correctness (spec 05 § Quotas). It must NOT
    // write a terminal status, for the same reason a transient mint failure doesn't: `failed`
    // is terminal, so the redelivered message's queued→provisioning guard would refuse to
    // advance the row and return early — the SQS retry we asked for would never reach
    // launchMicroVM again, and one throttle would permanently fail a job that only needed to
    // wait. Leaving the row in `provisioning` keeps redelivery working (a same-status write is
    // idempotent), and is what makes RUNBOOK's "jobs wait rather than fail" true. If every
    // redelivery throttles, the message DLQs (alarmed) and the Reaper fails the stuck row.
    //
    // COST of that choice, accepted deliberately: the redelivery re-runs step 2, so it MINTS A
    // FRESH JIT CONFIG and abandons this one. That is safe (a JIT config is single-use and its
    // side-store item TTLs out in 30 min unclaimed — ADR-016) and bounded (maxReceiveCount 3,
    // so at most 3 mints per job), and the alternative is worse: reusing the abandoned config
    // would mean persisting it across deliveries and risking a launch on a config another
    // delivery already consumed. It does mean a throttle storm spends GitHub API budget, which
    // is why `QuotaThrottles` is alarmed rather than silently retried forever.
    if (quota) {
      console.error(
        JSON.stringify({
          msg: 'launch throttled by quota (retrying)',
          runId: req.runId,
          jobId: req.jobId,
          flavor,
          reason: safeReason,
        }),
      );
      throw new Error(`launch throttled by quota (retrying): ${safeReason}`);
    }
    await transitionRun({
      repoId: req.repoId,
      runId: req.runId,
      jobId: req.jobId,
      to: 'failed',
      flavor,
      reason: `launch failed: ${safeReason}`,
    }).catch(() => {});
    throw new Error(`launch failed: ${safeReason}`);
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
      via,
      runId: req.runId,
      jobId: req.jobId,
      repo: req.repoFullName,
    }),
  );

  // Metrics (spec 05 § Observability): `ProvisionLatency` is the RunMicrovm call itself — the
  // part of boot we control — while end-to-end queue→running time is derivable from the run
  // row's timestamps, so it is not double-counted here.
  emitMetrics(
    [
      { name: 'RunsProvisioned', value: 1, unit: 'Count' },
      { name: 'ProvisionLatency', value: Date.now() - launchStartedAt, unit: 'Milliseconds' },
    ],
    metricDims,
    { ...metricProps, microvmId },
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Assemble ResolveOptions for a job: the repo's FlavorMap override + operator-chosen
 * defaultFlavor (repo row, written by the console — spec 04) + the job's parsed step signals
 * (stored workflow analysis, matched by rendered name). Any part may be absent —
 * resolveFlavor treats missing opts as label-only.
 */
async function lookupResolveOptions(req: ProvisionRequest): Promise<ResolveOptions> {
  const opts: ResolveOptions = {};

  const repo = await getRepo(req.installationId, req.repoId).catch(() => undefined);
  if (repo?.flavorMap) opts.flavorMap = repo.flavorMap;
  if (repo?.defaultFlavor) opts.defaultFlavor = repo.defaultFlavor;
  // Adopt-mode routing needs the repo's mode. Prefer the row (authoritative), but fall back
  // to the claim provenance stamped by Ingest so a DDB blip doesn't silently downgrade an
  // adopt-claimed job to the `base` fallback with a misleading "no matching label" reason.
  opts.mode = repo?.mode ?? (req.claimVia === 'adopt' ? 'adopt' : undefined);

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
