import { LambdaClient } from '@aws-sdk/client-lambda';
import { listMicroVMs, terminateMicroVM } from '../shared/microvm.js';
import { listRunsByStatus, transitionRun } from '../shared/run-store.js';
import {
  reconcileRuns,
  overCapVms,
  DEFAULT_REAPER_CONFIG,
  type ReaperConfig,
} from './reap.js';
import type { RunRecord } from '../shared/types.js';

/**
 * Reaper λ — EventBridge-scheduled sweep (spec 02 § Reaping, spec 05 observability).
 *
 * Each tick:
 *   1. List live microVMs (GA API cannot filter by tag, so this is all VMs in the region).
 *      Terminate any past the lifetime cap (by startedAt).
 *   2. Load active (`provisioning`/`queued`/`running`) run rows from the status GSI.
 *   3. Reconcile via the run store's persisted `microvmId` (NOT tags — the GA API doesn't
 *      tag VMs, ADR-015): `running` runs whose VM id is no longer live → `timed_out`
 *      (orphan); runs stuck in `queued`/`provisioning` → `failed` (likely a quota wall).
 *   4. If a closed ghost run still has a live VM (by its stored id), terminate it.
 *
 * Idempotent: transitions are guarded (forward-only) so re-running the sweep is safe, and
 * terminating an already-gone VM is treated as success.
 *
 * Env: TABLE_NAME, [MAX_LIFETIME_MS], [STUCK_PROVISIONING_MS], [ORPHAN_GRACE_MS].
 */

const lambda = new LambdaClient({});

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

  // 1. lifetime-cap sweep over all live VMs
  const vms = await listMicroVMs(lambda);
  const liveMicrovmIds = new Set<string>(vms.map((v) => v.microvmId));
  const overCap = overCapVms(vms, cfg, now);
  let terminated = 0;
  for (const vm of overCap) {
    try {
      await terminateMicroVM(lambda, vm.microvmId);
      terminated++;
      console.log(
        JSON.stringify({ msg: 'reaper terminated over-cap microVM', microvmId: vm.microvmId }),
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

  // 3. reconcile ghosts by persisted microvm id (run store is the source of truth)
  const dispositions = reconcileRuns(active, liveMicrovmIds, cfg, now);
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
      // 4. If the closed run still has a live VM (by its recorded id), terminate it too.
      if (d.run.microvmId && liveMicrovmIds.has(d.run.microvmId)) {
        await terminateMicroVM(lambda, d.run.microvmId).catch(() => {});
      }
    }
  }

  return { terminated, reconciled };
}
