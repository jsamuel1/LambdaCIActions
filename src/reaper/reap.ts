import type { LiveMicroVM } from '../shared/microvm.js';
import type { RunRecord } from '../shared/types.js';

/**
 * Pure reaping decisions (spec 02 § Reaping & timeouts). No AWS here — the handler feeds
 * these functions the live microVM list + DB run rows and acts on the results. Keeps the
 * lifetime-cap / orphan / stuck logic unit-testable.
 *
 * Correction (ADR-015): the GA `lambda-microvms` API does not tag VMs, so we cannot read a
 * `runId` off a VM. The run↔VM mapping lives in the run store (`RunRecord.microvmId`). The
 * handler builds the set of live VM ids and the map of run→microvmId; these functions work
 * purely on microvm id, never on tags.
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

/** microVMs to terminate because they exceeded the lifetime cap (by `startedAt`). */
export function overCapVms(
  vms: LiveMicroVM[],
  cfg: ReaperConfig,
  now: number,
): LiveMicroVM[] {
  return vms.filter(
    (vm) => vm.startedAt !== undefined && now - vm.startedAt > cfg.maxLifetimeMs,
  );
}

export interface RunDisposition {
  run: RunRecord;
  to: 'timed_out' | 'failed';
  reason: string;
}

/**
 * Given the active (`provisioning`/`running`) runs and the set of microVM ids that are
 * CURRENTLY live, decide which run rows are ghosts and how to close them:
 *   - `running` with a persisted `microvmId` that is no longer live, older than the orphan
 *     grace  → timed_out (the VM vanished / self-terminated)
 *   - `running` with NO persisted `microvmId` at all, past the orphan grace → timed_out
 *     (launch never stamped an id — treat as lost)
 *   - `provisioning`/`queued` older than the stuck threshold  → failed (never launched;
 *     likely a quota wall) — spec 05 stuck-queue signal.
 *
 * The mapping is by microvm id (from the run store), NOT by tag — the GA API doesn't tag VMs.
 */
export function reconcileRuns(
  activeRuns: RunRecord[],
  liveMicrovmIds: ReadonlySet<string>,
  cfg: ReaperConfig,
  now: number,
): RunDisposition[] {
  const out: RunDisposition[] = [];
  for (const run of activeRuns) {
    const ageMs = now - Date.parse(run.updatedAt);
    if (run.status === 'running') {
      const vmLive = run.microvmId !== undefined && liveMicrovmIds.has(run.microvmId);
      if (!vmLive && ageMs > cfg.orphanGraceMs) {
        const detail = run.microvmId
          ? `microVM ${run.microvmId} no longer live`
          : 'no microVM id recorded';
        out.push({
          run,
          to: 'timed_out',
          reason: `orphaned: ${detail} for run ${run.runId} after ${Math.round(
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
