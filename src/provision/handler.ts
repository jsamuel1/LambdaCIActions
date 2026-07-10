import { LambdaClient } from '@aws-sdk/client-lambda';
import type { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { generateJitConfig } from '../shared/github-app.js';
import { launchMicroVM } from '../shared/microvm.js';
import type { ProvisionRequest, RunHookPayload } from '../shared/types.js';
import { resolveFlavor } from './flavor.js';

/**
 * Provision λ — SQS consumer (spec 02 provisioning lifecycle, ADR-012).
 *
 * Per message:
 *   1. Resolve the job's labels → flavor → image ARN (from SSM, published by build script).
 *   2. Mint a single-use JIT runner config via the GitHub App.
 *   3. `run-microvm` from the image ARN, passing the JIT config + metadata as the
 *      run-hook payload; tag the VM `lca:run=<runId>`.
 *
 * Failure → throw → the record is reported in `batchItemFailures` so SQS redelivers it
 * (visibility timeout) and, after maxReceiveCount, routes to the DLQ. We use partial batch
 * responses so one poison message doesn't fail its whole batch.
 *
 * Env: APP_ID_PARAM, APP_PEM_PARAM, IMAGE_ARN_PARAM_PREFIX, TAG_PREFIX, [RUNNER_ROLE_ARN].
 */

const lambda = new LambdaClient({});

const APP_ID_PARAM = process.env.APP_ID_PARAM!;
const APP_PEM_PARAM = process.env.APP_PEM_PARAM!;
const IMAGE_ARN_PARAM_PREFIX = process.env.IMAGE_ARN_PARAM_PREFIX!; // e.g. /lca/dev/config/image-arn-
const TAG_PREFIX = process.env.TAG_PREFIX ?? 'lca';
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

  // 1. flavor → image ARN
  const flavor = resolveFlavor(req.labels);
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

  // 3. launch the microVM with the JIT config as run-hook payload
  const payload: RunHookPayload = {
    jitConfig,
    runId: req.runId,
    jobId: req.jobId,
    repoFullName: req.repoFullName,
    labels: req.labels,
  };
  const { microvmId } = await launchMicroVM(lambda, {
    imageArn,
    runId: req.runId,
    jobId: req.jobId,
    tagPrefix: TAG_PREFIX,
    payload,
    executionRoleArn: RUNNER_ROLE_ARN,
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
