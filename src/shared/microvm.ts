import { LambdaClient } from '@aws-sdk/client-lambda';
import type { RunHookPayload } from './types.js';

/**
 * microVM launch wrapper (ADR-012, corrected for the GA `lambda-microvms` API 2025-09-09).
 *
 * The Lambda microVM control plane is a DISTINCT service — `@aws-sdk/client-lambda-microvms`
 * (CLI: `aws lambda-microvms ...`), NOT the base `lambda` service. Commands: RunMicrovm,
 * ListMicrovms, TerminateMicrovm, GetMicrovm. We call them through the client's generic
 * command pipeline and keep the request/response shapes local, so a single file owns the
 * dependency on the microVM API surface.
 *
 * IMPORTANT (correction vs the pre-GA design): the real API does NOT support tagging a
 * microVM at launch — `RunMicrovm` has no `tags`, `ListMicrovms` items carry no tags, and
 * microVMs are not a taggable resource. So we CANNOT tag `lca:run=<runId>` on the VM and
 * cannot filter/reconcile by tag. The run↔microVM mapping is instead persisted in the run
 * store (the provision handler stamps `microvmId` on the run record); the Reaper correlates
 * live VM ids against that stored mapping. IAM isolation likewise cannot use
 * aws:RequestTag/ResourceTag on the VM (see ADR-015).
 *
 * Launch is fire-and-forget: we hand the JIT config to the `/run` hook via runHookPayload
 * and rely on the `workflow_job` status webhook + the Reaper for lifecycle, rather than
 * health-checking the per-VM endpoint (which would need a CreateMicrovmAuthToken JWE).
 */

const RUN_HOOK_PAYLOAD_MAX = 4096; // GA lambda-microvms hard cap (service model), NOT 16KB

export interface LaunchParams {
  imageArn: string;
  runId: number;
  jobId: number;
  payload: RunHookPayload;
  executionRoleArn?: string;
  /** CloudWatch log group for the VM's runtime output (run-hook + runner). Without this
   *  a failed boot/job is a black box — always set in production (ADR-016). */
  logGroup?: string;
  /** Optional auto-suspend policy; single-use runners generally omit this (run once, terminate). */
  idlePolicy?: {
    maxIdleDurationSeconds: number;
    suspendedDurationSeconds: number;
    autoResumeEnabled: boolean;
  };
  /** Optional hard cap on total VM lifetime, seconds. */
  maximumDurationInSeconds?: number;
}

export interface LaunchResult {
  microvmId: string;
  state: string;
  endpoint: string;
}

/** A live microVM as returned by ListMicrovms — id + state + start time ONLY (no tags/runId). */
export interface LiveMicroVM {
  microvmId: string;
  state: string;
  imageArn?: string;
  /** Epoch ms the VM started, from `startedAt`. */
  startedAt?: number;
}

/**
 * Minimal structural type for the SDK command constructor so we don't hard-depend on an
 * export that may not exist at compile time. At runtime we resolve the real command from
 * the installed SDK; the cast is contained here.
 */
type CommandCtor = new (input: Record<string, unknown>) => object;

async function loadCommand(name: string): Promise<CommandCtor> {
  // The microVM commands live in a SEPARATE SDK package. Dynamic import keeps a missing
  // package/export from breaking module load; we fail loudly only when the operation is
  // actually attempted against an SDK that lacks microVM support.
  const mod = (await import('@aws-sdk/client-lambda-microvms')) as Record<string, unknown>;
  const ctor = mod[name] as CommandCtor | undefined;
  if (!ctor) {
    throw new Error(
      `@aws-sdk/client-lambda-microvms is missing ${name}; install/upgrade the microVM SDK (API 2025-09-09, ADR-012/015)`,
    );
  }
  return ctor;
}

export async function launchMicroVM(
  client: LambdaClient,
  params: LaunchParams,
): Promise<LaunchResult> {
  const payloadJson = JSON.stringify(params.payload);
  const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
  // The payload is now just a small reference (the JIT config lives in DynamoDB, ADR-016),
  // so it fits the 4 KB cap trivially. Keep the guard + a size log as a safety net against
  // an accidentally-oversized ref payload.
  console.log(
    JSON.stringify({
      msg: 'run-hook payload size',
      totalBytes: payloadBytes,
      cap: RUN_HOOK_PAYLOAD_MAX,
      runId: params.runId,
    }),
  );
  if (payloadBytes > RUN_HOOK_PAYLOAD_MAX) {
    throw new Error(
      `run-hook payload ${payloadBytes} bytes exceeds ${RUN_HOOK_PAYLOAD_MAX}-byte cap (ADR-016)`,
    );
  }

  const RunMicrovmCommand = await loadCommand('RunMicrovmCommand');
  const input: Record<string, unknown> = {
    imageIdentifier: params.imageArn,
    runHookPayload: payloadJson,
  };
  if (params.executionRoleArn) input.executionRoleArn = params.executionRoleArn;
  if (params.logGroup) input.logging = { cloudWatch: { logGroup: params.logGroup } };
  if (params.idlePolicy) input.idlePolicy = params.idlePolicy;
  if (params.maximumDurationInSeconds !== undefined) {
    input.maximumDurationInSeconds = params.maximumDurationInSeconds;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await client.send(new RunMicrovmCommand(input) as any)) as {
    microvmId?: string;
    state?: string;
    endpoint?: string;
  };
  if (!res.microvmId) throw new Error('RunMicrovm returned no microvmId');
  return {
    microvmId: res.microvmId,
    state: res.state ?? 'PENDING',
    endpoint: res.endpoint ?? '',
  };
}

/**
 * List live microVMs for the Reaper (spec 02 § Reaping). The GA API cannot filter by tag,
 * so this lists ALL microVMs in the account/region (optionally scoped by image ARN) and
 * returns a normalized id/state/startedAt shape. The Reaper correlates these ids against
 * the run store's persisted `microvmId` — the run store, not a VM tag, is the source of
 * truth for which run a VM belongs to.
 */
export async function listMicroVMs(
  client: LambdaClient,
  opts: { imageIdentifier?: string } = {},
): Promise<LiveMicroVM[]> {
  const ListMicrovmsCommand = await loadCommand('ListMicrovmsCommand');
  const out: LiveMicroVM[] = [];
  let nextToken: string | undefined;

  do {
    const input: Record<string, unknown> = {};
    if (opts.imageIdentifier) input.imageIdentifier = opts.imageIdentifier;
    if (nextToken) input.nextToken = nextToken;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await client.send(new ListMicrovmsCommand(input) as any)) as {
      items?: RawMicroVM[];
      nextToken?: string;
    };
    for (const vm of res.items ?? []) out.push(normalizeMicroVM(vm));
    nextToken = res.nextToken;
  } while (nextToken);

  return out;
}

/**
 * Terminate a microVM by id (spec 02 teardown). Best-effort: a VM that already
 * self-terminated may error — the caller treats that as success.
 */
export async function terminateMicroVM(
  client: LambdaClient,
  microvmId: string,
): Promise<void> {
  const TerminateMicrovmCommand = await loadCommand('TerminateMicrovmCommand');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId } as any) as any);
}

interface RawMicroVM {
  microvmId?: string;
  state?: string;
  imageArn?: string;
  startedAt?: string | number | Date;
}

function normalizeMicroVM(vm: RawMicroVM): LiveMicroVM {
  let startedAt: number | undefined;
  const s = vm.startedAt;
  if (s instanceof Date) startedAt = s.getTime();
  else if (typeof s === 'number') startedAt = s;
  else if (typeof s === 'string') {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) startedAt = t;
  }
  return {
    microvmId: vm.microvmId as string,
    state: vm.state ?? 'UNKNOWN',
    imageArn: vm.imageArn,
    startedAt,
  };
}
