import { LambdaClient } from '@aws-sdk/client-lambda';
import {
  listManagedMicroVMs,
  terminateMicroVM,
  type ManagedMicroVM,
} from '../shared/microvm.js';
import { listRunsByStatus, transitionRun } from '../shared/run-store.js';
import {
  reconcileRuns,
  overCapVms,
  DEFAULT_REAPER_CONFIG,
  type ReaperConfig,
} from './reap.js';
import type { RunRecord } from '../shared/types.js';

/**
 * Reaper \u03bb \u2014 EventBridge-scheduled sweep (spec 02 \u00a7 Reaping, spec 05 observability).
 *
 * Each tick:
 *   1. List our tagged microVMs. Terminate any past the lifetime cap.
 *   2. Load active (`provisioning`/`queued`/`running`) run rows from the status GSI.
 *   3. Reconcile: `running` runs with no live VM → `timed_out` (orphan); runs stuck in
 *      `queued`/`provisioning` → `failed` (likely a quota wall).
 *
 * Idempotent: transitions are guarded (forward-only) so re-running the sweep is safe, and
 * terminating an already-gone VM is treated as success.
 *
 * Env: TABLE_NAME, TAG_PREFIX, [MAX_LIFETIME_MS], [STUCK_PROVISIONING_MS], [ORPHAN_GRACE_MS].
 */

const lambda = new LambdaClient({});
const TAG_PREFIX = process.env.TAG_PREFIX ?? 'lca';

function configFromEnv(): ReaperConfig {
  const num = (v: string | undefined, d: number) => {
    const n = v !== undefined ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxLifetimeMs: num(process.env.MAX_LIFETIME_MS, DEFAULT_REAPER_CONFIG.maxLifetimeMs),
    stuckProvisioningMs: num(
      process.env.STUCK_PROVISIONING_MS,
      DEFAULT_REAPER_CONFIG.stuckProvisioningMs,
    ),
    orphanGraceMs: num(process.env.ORPHAN_GRACE_MS, DEFAULT_REAPER_CONFIG.orphanGraceMs),
  };
}

export async function handler(): Promise<{
  terminated: number;
  reconciled: number;
}> {
  const cfg = configFromEnv();
  const now = Date.now();

  // 1. lifetime-cap sweep
  const vms = await listManagedMicroVMs(lambda, TAG_PREFIX);
  const overCap = overCapVms(vms, cfg, now);
  let terminated = 0;
  for (const vm of overCap) {
    try {
      await terminateMicroVM(lambda, vm.microvmId);
      terminated++;
      console.log(
        JSON.stringify({ msg: 'reaper terminated over-cap microVM', microvmId: vm.microvmId, runId: vm.runId }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: 'reaper terminate failed',
          microvmId: vm.microvmId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // 2. active runs from the status GSI
  const active: RunRecord[] = [
    ...(await listRunsByStatus('running')),
    ...(await listRunsByStatus('provisioning')),
    ...(await listRunsByStatus('queued')),
  ];
  const liveRunIds = liveRunIdSet(vms);

  // 3. reconcile ghosts
  const dispositions = reconcileRuns(active, liveRunIds, cfg, now);
  let reconciled = 0;
  for (const d of dispositions) {
    const moved = await transitionRun({
      repoId: d.run.repoId,
      runId: d.run.runId,
      jobId: d.run.jobId,
      to: d.to,
      reason: d.reason,
    });
    if (moved) {
      reconciled++;
      console.log(
        JSON.stringify({
          msg: 'reaper closed ghost run',
          runId: d.run.runId,
          jobId: d.run.jobId,
          to: d.to,
          reason: d.reason,
        }),
      );
      // If a stuck/orphaned run still has a stray VM, terminate it too.
      const stray = vms.find((v) => v.runId === d.run.runId);
      if (stray) await terminateMicroVM(lambda, stray.microvmId).catch(() => {});
    }
  }

  return { terminated, reconciled };
}

function liveRunIdSet(vms: ManagedMicroVM[]): Set<number> {
  const s = new Set<number>();
  for (const vm of vms) if (vm.runId !== undefined) s.add(vm.runId);
  return s;
}
