import type { ManagedMicroVM } from '../shared/microvm.js';
import type { RunRecord } from '../shared/types.js';

/**
 * Pure reaping decisions (spec 02 \u00a7 Reaping & timeouts). No AWS here \u2014 the handler feeds
 * these functions the live microVM list + DB run rows and acts on the results. Keeps the
 * lifetime-cap / orphan / stuck logic unit-testable.
 */

export interface ReaperConfig {
  /** Hard lifetime cap; VMs older than this are terminated. */
  maxLifetimeMs: number;
  /** A run stuck in `provisioning`/`queued` past this age is failed (likely a quota wall). */
  stuckProvisioningMs: number;
  /** A `running` run whose microVM has vanished for this long is declared orphaned. */
  orphanGraceMs: number;
}

export const DEFAULT_REAPER_CONFIG: ReaperConfig = {
  maxLifetimeMs: 2 * 60 * 60 * 1000, // 2h — well under the 8h microVM ceiling (spec 02)
  stuckProvisioningMs: 15 * 60 * 1000, // 15m
  orphanGraceMs: 5 * 60 * 1000, // 5m
};

/** microVMs to terminate because they exceeded the lifetime cap. */
export function overCapVms(
  vms: ManagedMicroVM[],
  cfg: ReaperConfig,
  now: number,
): ManagedMicroVM[] {
  return vms.filter(
    (vm) => vm.launchedAt !== undefined && now - vm.launchedAt > cfg.maxLifetimeMs,
  );
}

export interface RunDisposition {
  run: RunRecord;
  to: 'timed_out' | 'failed';
  reason: string;
}

/**
 * Given the active (`provisioning`/`running`) runs and the set of run ids that STILL have
 * a live microVM, decide which run rows are ghosts and how to close them:
 *   - `running` with no live VM, older than the orphan grace  → timed_out (orphaned VM)
 *   - `provisioning`/`queued` older than the stuck threshold  → failed (never launched;
 *     likely a quota wall) \u2014 spec 05 stuck-queue signal.
 */
export function reconcileRuns(
  activeRuns: RunRecord[],
  liveRunIds: ReadonlySet<number>,
  cfg: ReaperConfig,
  now: number,
): RunDisposition[] {
  const out: RunDisposition[] = [];
  for (const run of activeRuns) {
    const ageMs = now - Date.parse(run.updatedAt);
    if (run.status === 'running') {
      if (!liveRunIds.has(run.runId) && ageMs > cfg.orphanGraceMs) {
        out.push({
          run,
          to: 'timed_out',
          reason: `orphaned: no live microVM for run ${run.runId} after ${Math.round(
            ageMs / 1000,
          )}s`,
        });
      }
    } else if (run.status === 'provisioning' || run.status === 'queued') {
      if (ageMs > cfg.stuckProvisioningMs) {
        out.push({
          run,
          to: 'failed',
          reason: `stuck in ${run.status} for ${Math.round(
            ageMs / 1000,
          )}s (possible microVM quota wall)`,
        });
      }
    }
  }
  return out;
}
