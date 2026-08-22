import { LambdaClient } from '@aws-sdk/client-lambda';
import { randomBytes } from 'node:crypto';
import { getParam } from '../shared/ssm.js';
import {
  cancelWorkflowRun,
  deleteRepoRunner,
  dispatchWorkflow,
  generateSmokeJitConfig,
  getRepoDefaultBranch,
  listRepoRunners,
  listRunJobs,
  listWorkflowDispatchRuns,
} from '../shared/github-app.js';
import {
  getMicroVMImageState,
  launchMicroVM,
  listMicroVMs,
  terminateMicroVM,
} from '../shared/microvm.js';
import { getCustomFlavor, transitionFlavorValidation } from '../shared/flavor-store.js';
import { beginSmokeRun, deleteSmokeRun, stampSmokeMicrovmId } from '../shared/smoke-store.js';
import { hashHookToken } from '../hook/broker-core.js';
import { redactSecret } from '../shared/redact.js';
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  runValidation,
  splitRepoFullName,
  type FlavorValidationRequest,
  type OrchestratorConfig,
  type OrchestratorDeps,
  type OrchestratorResult,
} from './orchestrate.js';

/**
 * Flavor-validation λ (ADR-041) — the deploy-touching half of custom flavors.
 *
 * Invoked fire-and-forget by the Mgmt λ (`InvocationType: 'Event'`) with
 * `{ installationId, name, actor }` after a registration or a manual re-validate. It runs the two
 * ADR-041 gates and writes the verdict onto the flavor row; nothing else can move a custom flavor to
 * `valid`, so until this function is deployed no custom flavor is routable at all.
 *
 * This file is deliberately thin. All sequencing, deadline and cleanup logic lives in
 * `orchestrate.ts` behind injected effects, because the properties that matter here — the VM is
 * terminated on EVERY exit path, an orchestration fault returns the row to `pending` rather than
 * spending terminal `invalid` — are control-flow properties, and they are only unit-testable if the
 * effects are injectable. What remains here is the wiring, which the live smoke run verifies.
 *
 * Env: TABLE_NAME, APP_ID_PARAM, APP_PEM_PARAM, HOOK_BROKER_NAME, [RUNNER_ROLE_ARN],
 *      [SMOKE_LOG_GROUP], [FLAVORVAL_DEADLINE_MS], [LCA_ENV].
 */

const lambda = new LambdaClient({});

const APP_ID_PARAM = process.env.APP_ID_PARAM ?? '';
const APP_PEM_PARAM = process.env.APP_PEM_PARAM ?? '';
const LCA_ENV = process.env.LCA_ENV ?? 'dev';
/**
 * Log group for the smoke VM's guest output.
 *
 * Its OWN group, not the per-run group real jobs write to. A validation attempt is not a customer
 * job, and the run log group is what the console's log pane reads by run id — mixing a smoke VM's
 * output into it would put un-attributable streams in a customer-facing view. It is also the first
 * place an operator looks when a verdict says "the runner never registered", so it must be
 * findable by flavor rather than buried among job logs.
 */
const SMOKE_LOG_GROUP =
  process.env.SMOKE_LOG_GROUP ?? `/aws/lambda/microvms/validate/lca-${LCA_ENV}`;

function orchestratorConfig(): OrchestratorConfig {
  const fromEnv = Number(process.env.FLAVORVAL_DEADLINE_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? { ...DEFAULT_ORCHESTRATOR_CONFIG, deadlineMs: fromEnv }
    : DEFAULT_ORCHESTRATOR_CONFIG;
}

/** Parse + validate the async invoke payload. */
function parseRequest(event: unknown): FlavorValidationRequest {
  const e = (event ?? {}) as { installationId?: unknown; name?: unknown; actor?: unknown };
  const installationId = Number(e.installationId);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error('flavor validation request: installationId must be a positive integer');
  }
  if (typeof e.name !== 'string' || !e.name) {
    throw new Error('flavor validation request: name is required');
  }
  return {
    installationId,
    name: e.name,
    ...(typeof e.actor === 'string' && e.actor ? { actor: e.actor } : {}),
  };
}

/** Build the real deps. Exported for the live-wiring smoke of the λ itself. */
export function awsDeps(): OrchestratorDeps {
  const brokerName = process.env.HOOK_BROKER_NAME ?? '';
  const runnerRoleArn = process.env.RUNNER_ROLE_ARN;
  /**
   * Plaintext capability tokens minted during this invocation, redacted from any error text.
   *
   * Same reason as the provision path (ADR-021): an SDK validation error echoes the offending
   * request value back, and `runHookPayload` CONTAINS the token. Unredacted, that string reaches
   * the flavor row's `reason` — operator-visible in the console — and the λ's own log.
   */
  const tokens: string[] = [];
  const scrub = (text: string): string =>
    tokens.reduce((acc, t) => redactSecret(acc, t), text);

  /** App credentials, resolved once per invocation and cached by `getParam`. */
  const creds = async (): Promise<{ appId: string; pem: string }> => {
    if (!APP_ID_PARAM || !APP_PEM_PARAM) {
      throw new Error('APP_ID_PARAM / APP_PEM_PARAM are not set');
    }
    const [appId, pem] = await Promise.all([getParam(APP_ID_PARAM), getParam(APP_PEM_PARAM)]);
    return { appId, pem };
  };

  const repoParts = (repoFullName: string): { owner: string; repo: string } => {
    const parts = splitRepoFullName(repoFullName);
    if (!parts) throw new Error(`smoke repo '${repoFullName}' is not in owner/repo form`);
    return parts;
  };

  return {
    getFlavor: (installationId, name) => getCustomFlavor(installationId, name),
    transition: (input) => transitionFlavorValidation(input),
    probeImage: (imageArn) => getMicroVMImageState(lambda, imageArn),
    defaultBranch: async (repoFullName) => {
      const { appId, pem } = await creds();
      return getRepoDefaultBranch({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(repoFullName),
      });
    },
    mintSmokeRunner: async (input) => {
      const { appId, pem } = await creds();
      return generateSmokeJitConfig({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(input.repoFullName),
        label: input.label,
        name: input.name,
      });
    },
    beginSmoke: async (input) => {
      // Minted here rather than passed in, so the plaintext exists in exactly one place: this
      // closure, which hands the hash to DynamoDB and the plaintext to the VM's launch payload.
      const token = randomBytes(32).toString('base64url');
      tokens.push(token);
      const { ref } = await beginSmokeRun({
        installationId: currentInstallationId,
        seq: input.seq,
        flavorName: currentFlavorName,
        jitConfig: input.jitConfig,
        repoFullName: input.repoFullName,
        labels: input.labels,
        hookTokenHash: hashHookToken(token),
      });
      return { ref, token };
    },
    launch: async (input) => {
      if (!brokerName) throw new Error('HOOK_BROKER_NAME is not set (ADR-021 brokered run hook)');
      try {
        const res = await launchMicroVM(lambda, {
          imageArn: input.imageArn,
          // A smoke run has no GitHub run/job. Zeros keep the guest's logging path identical to a
          // real job's rather than introducing a second shape for it to handle.
          runId: 0,
          jobId: 0,
          payload: {
            ref: input.ref,
            region: process.env.AWS_REGION ?? 'us-west-2',
            broker: brokerName,
            token: input.token,
          },
          ...(runnerRoleArn ? { executionRoleArn: runnerRoleArn } : {}),
          logGroup: SMOKE_LOG_GROUP,
        });
        return { microvmId: res.microvmId };
      } catch (err) {
        // REDACT FIRST: this error text can quote the launch payload, token included, and it flows
        // into the row's operator-visible `reason` via the orchestrator's catch.
        throw new Error(scrub(err instanceof Error ? err.message : String(err)));
      }
    },
    stampVm: (input) =>
      stampSmokeMicrovmId({
        installationId: currentInstallationId,
        seq: input.seq,
        microvmId: input.microvmId,
      }),
    dispatch: async (input) => {
      const { appId, pem } = await creds();
      await dispatchWorkflow({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(input.repoFullName),
        workflow: input.workflow,
        ref: input.ref,
        inputs: { lca_nonce: input.nonce },
      });
    },
    listRunners: async (repoFullName) => {
      const { appId, pem } = await creds();
      return listRepoRunners({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(repoFullName),
      });
    },
    listDispatchRuns: async (input) => {
      const { appId, pem } = await creds();
      return listWorkflowDispatchRuns({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(input.repoFullName),
        workflow: input.workflow,
      });
    },
    listRunJobs: async (input) => {
      const { appId, pem } = await creds();
      return listRunJobs({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(input.repoFullName),
        runId: input.runId,
      });
    },
    listVms: () => listMicroVMs(lambda),    terminateVm: (microvmId) => terminateMicroVM(lambda, microvmId),
    deleteRunner: async (input) => {
      const { appId, pem } = await creds();
      await deleteRepoRunner({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(input.repoFullName),
        runnerId: input.runnerId,
      });
    },
    cancelRun: async (input) => {
      const { appId, pem } = await creds();
      await cancelWorkflowRun({
        appId,
        pem,
        installationId: currentInstallationId,
        ...repoParts(input.repoFullName),
        runId: input.runId,
      });
    },
    endSmoke: (seq) => deleteSmokeRun(currentInstallationId, seq),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nonce: () => randomBytes(8).toString('hex'),
    log: (record) => console.log(JSON.stringify(record)),
  };
}

/**
 * The installation + flavor the current invocation is validating.
 *
 * Module-scoped because the deps interface is intentionally free of AWS/GitHub identifiers — the
 * orchestrator passes the flavor's `smokeRepoFullName`, not an installation id, so its fake deps
 * stay readable. Safe because Lambda runs ONE invocation per container at a time; both are set from
 * the request before `runValidation` is called.
 */
let currentInstallationId = 0;
let currentFlavorName = '';

export async function handler(event: unknown): Promise<OrchestratorResult> {
  const req = parseRequest(event);
  currentInstallationId = req.installationId;
  currentFlavorName = req.name;

  const result = await runValidation(awsDeps(), req, orchestratorConfig());
  console.log(
    JSON.stringify({
      msg: 'flavor validation complete',
      installationId: req.installationId,
      flavor: req.name,
      ran: result.ran,
      state: result.state,
      skipped: result.skipped,
      verdictWritten: result.verdictWritten,
    }),
  );
  return result;
}
