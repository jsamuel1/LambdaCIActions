import { LambdaClient } from '@aws-sdk/client-lambda';
import type { RunHookPayload } from './types.js';

/**
 * microVM launch wrapper (ADR-012).
 *
 * The Lambda microVM control plane exposes `run-microvm` / `terminate-microvm` under the
 * `lambda:` service. The AWS SDK v3 command classes for these are NEW and may not be
 * present in every SDK minor, so we call them through the client's generic command
 * pipeline and keep the request/response shapes local. This isolates the one spot that
 * depends on the microVM API surface — if the SDK command names shift, only this file
 * changes.
 *
 * Launch is fire-and-forget in M1: we tag the VM `lca:run=<runId>` and rely on the
 * `workflow_job` status webhook + the Reaper λ for lifecycle, rather than health-checking
 * the per-VM endpoint (which would need a create-microvm-auth-token JWE).
 */

const RUN_HOOK_PAYLOAD_MAX = 16 * 1024;

export interface LaunchParams {
  imageArn: string;
  runId: number;
  jobId: number;
  tagPrefix: string; // e.g. 'lca'
  payload: RunHookPayload;
  executionRoleArn?: string;
}

export interface LaunchResult {
  microvmId: string;
}

/** A running microVM as returned by the tag-scoped list. */
export interface ManagedMicroVM {
  microvmId: string;
  runId?: number;
  jobId?: number;
  /** Epoch ms the VM entered RUNNING, if the API surfaces it. */
  launchedAt?: number;
  state?: string;
}

/**
 * Minimal structural type for the SDK command constructor so we don't hard-depend on an
 * export that may not exist at compile time. At runtime we resolve the real command from
 * the installed SDK; the cast is contained here.
 */
type CommandCtor = new (input: Record<string, unknown>) => object;

async function loadCommand(name: string): Promise<CommandCtor> {
  // Dynamic import keeps a missing export from breaking module load; we fail loudly only
  // when a launch is actually attempted against an SDK that lacks the command.
  const mod = (await import('@aws-sdk/client-lambda')) as Record<string, unknown>;
  const ctor = mod[name] as CommandCtor | undefined;
  if (!ctor) {
    throw new Error(
      `@aws-sdk/client-lambda is missing ${name}; upgrade the SDK to a version with microVM support (ADR-012)`,
    );
  }
  return ctor;
}

export async function launchMicroVM(
  client: LambdaClient,
  params: LaunchParams,
): Promise<LaunchResult> {
  const payloadJson = JSON.stringify(params.payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > RUN_HOOK_PAYLOAD_MAX) {
    throw new Error(
      `run-hook payload ${Buffer.byteLength(payloadJson)} bytes exceeds 16 KB cap (ADR-012)`,
    );
  }

  const RunMicroVMCommand = await loadCommand('RunMicroVMCommand');
  const input: Record<string, unknown> = {
    ImageIdentifier: params.imageArn,
    RunHookPayload: payloadJson,
    Tags: {
      [`${params.tagPrefix}:managed`]: 'true',
      [`${params.tagPrefix}:run`]: String(params.runId),
      [`${params.tagPrefix}:job`]: String(params.jobId),
    },
  };
  if (params.executionRoleArn) input.ExecutionRoleArn = params.executionRoleArn;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await client.send(new RunMicroVMCommand(input) as any)) as {
    MicroVMId?: string;
    MicrovmId?: string;
  };
  const microvmId = res.MicroVMId ?? res.MicrovmId;
  if (!microvmId) throw new Error('run-microvm returned no microVM id');
  return { microvmId };
}

/**
 * List microVMs this deployment manages (tagged `<prefix>:managed=true`), for the Reaper
 * (spec 02 § Reaping). Handles pagination + the two casings the API might use for ids /
 * tags. Returns a normalized shape so the Reaper doesn't depend on the raw response.
 */
export async function listManagedMicroVMs(
  client: LambdaClient,
  tagPrefix: string,
): Promise<ManagedMicroVM[]> {
  const ListMicroVMsCommand = await loadCommand('ListMicroVMsCommand');
  const out: ManagedMicroVM[] = [];
  let nextToken: string | undefined;

  do {
    const input: Record<string, unknown> = {
      Filters: { [`${tagPrefix}:managed`]: 'true' },
    };
    if (nextToken) input.NextToken = nextToken;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await client.send(new ListMicroVMsCommand(input) as any)) as {
      MicroVMs?: RawMicroVM[];
      Microvms?: RawMicroVM[];
      NextToken?: string;
    };
    const vms = res.MicroVMs ?? res.Microvms ?? [];
    for (const vm of vms) out.push(normalizeMicroVM(vm, tagPrefix));
    nextToken = res.NextToken;
  } while (nextToken);

  return out;
}

/**
 * Terminate a microVM by id (spec 02 teardown). Best-effort: a VM that already
 * self-terminated may 404 — the caller treats that as success.
 */
export async function terminateMicroVM(
  client: LambdaClient,
  microvmId: string,
): Promise<void> {
  const TerminateMicroVMCommand = await loadCommand('TerminateMicroVMCommand');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.send(new TerminateMicroVMCommand({ MicroVMId: microvmId } as any) as any);
}

interface RawMicroVM {
  MicroVMId?: string;
  MicrovmId?: string;
  State?: string;
  Tags?: Record<string, string>;
  LaunchTime?: string | number;
  CreatedTime?: string | number;
}

function normalizeMicroVM(vm: RawMicroVM, tagPrefix: string): ManagedMicroVM {
  const tags = vm.Tags ?? {};
  const runTag = tags[`${tagPrefix}:run`];
  const jobTag = tags[`${tagPrefix}:job`];
  const launch = vm.LaunchTime ?? vm.CreatedTime;
  let launchedAt: number | undefined;
  if (typeof launch === 'number') launchedAt = launch;
  else if (typeof launch === 'string') {
    const t = Date.parse(launch);
    if (!Number.isNaN(t)) launchedAt = t;
  }
  return {
    microvmId: (vm.MicroVMId ?? vm.MicrovmId) as string,
    runId: runTag !== undefined ? Number(runTag) : undefined,
    jobId: jobTag !== undefined ? Number(jobTag) : undefined,
    launchedAt,
    state: vm.State,
  };
}
