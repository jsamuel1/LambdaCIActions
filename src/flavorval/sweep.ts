/**
 * Reconciliation sweep for stranded custom-flavor validation claims (ADR-041).
 *
 * The smoke λ moves its row out of `validating` on every path it controls. Two paths it cannot
 * control leave the row claimed: DynamoDB unreachable for the run's whole budget (its fence and
 * release never answer, see `settleUnknownClaim`), and the λ killed outright (OOM, a platform
 * fault). The claim's lease marks such a row as abandoned once it expires, but a lease is only a
 * PERMISSION for a later claim to take the row over: the only producers of runs are registration
 * and an operator's re-validate, so nothing would ever come back. This sweep is that something.
 *
 * Each tick it enumerates expired claims from the sparse live-claim index and, for each:
 *
 *   1. RELEASES it `validating → pending`, conditional on the same token and an expired lease, so
 *      a row a later run has claimed, or a run still inside its budget, is never touched. This is
 *      what satisfies "never leave a row in `validating`": it does not depend on the re-trigger.
 *   2. RE-TRIGGERS validation, unless the flavor has already been auto-recovered
 *      `MAX_FLAVOR_AUTO_RECOVERIES` times with no verdict in between. Each attempt launches a
 *      microVM, so a run that dies deterministically must not become one VM per sweep forever; past
 *      the cap the row stays `pending` with a reason telling the operator to re-validate.
 *
 * Hosted by the Reaper's existing 5-minute schedule rather than by the smoke λ itself: the smoke λ
 * has reserved concurrency 1, so a scheduled sweep there would be throttled behind the very run it
 * is meant to recover. The effects are injected so the whole recovery is unit-testable.
 */

export interface SweepClaim {
  installationId: number;
  name: string;
  runId: string;
  leaseUntil: number;
  autoRecoveries: number;
}

export interface SweepDeps {
  listExpired(nowMs: number): Promise<{ claims: SweepClaim[]; truncated: boolean }>;
  /** Conditional release; `undefined` when the row was not (or no longer) an expired claim. */
  release(input: {
    installationId: number;
    name: string;
    runId: string;
    nowMs: number;
    reason: string;
  }): Promise<{ autoRecoveries: number } | undefined>;
  /**
   * Fire-and-forget validation trigger (an async invoke of the smoke λ). `autoRecovery: true` keeps
   * the row's recovery counter across the new claim. False when the invoke could not be sent.
   */
  trigger(input: {
    installationId: number;
    name: string;
    actor: string;
    autoRecovery: true;
  }): Promise<boolean>;
  log(record: Record<string, unknown>): void;
}

export interface SweepResult {
  expired: number;
  released: number;
  retriggered: number;
  /** Released but not re-triggered: past the auto-recovery cap, or the trigger failed. */
  leftPending: number;
  truncated: boolean;
}

/** The actor stamped on sweep-issued triggers, so the λ's log and the row's `updatedBy` say why. */
export const SWEEP_ACTOR = 'reconciliation-sweep';

export async function sweepExpiredFlavorClaims(
  deps: SweepDeps,
  nowMs: number,
  maxAutoRecoveries: number,
): Promise<SweepResult> {
  const { claims, truncated } = await deps.listExpired(nowMs);
  if (truncated) {
    deps.log({
      msg: 'flavor claim sweep read a partial page set — the rest are released on the next tick',
      found: claims.length,
    });
  }
  const result: SweepResult = {
    expired: claims.length,
    released: 0,
    retriggered: 0,
    leftPending: 0,
    truncated,
  };
  for (const c of claims) {
    // Decided BEFORE the write so the stored reason matches what the sweep will actually do.
    const willRetrigger = c.autoRecoveries + 1 <= maxAutoRecoveries;
    const reason = willRetrigger
      ? 'validation run ended without a verdict (its claim expired); validation was restarted automatically'
      : `validation run ended without a verdict ${c.autoRecoveries + 1} times in a row; ` +
        'not restarted automatically — re-validate to try again';
    let released: { autoRecoveries: number } | undefined;
    try {
      released = await deps.release({
        installationId: c.installationId,
        name: c.name,
        runId: c.runId,
        nowMs,
        reason,
      });
    } catch (err) {
      // One row's fault must not stop the others; the next tick retries this one.
      deps.log({
        msg: 'flavor claim sweep could not release an expired claim',
        installationId: c.installationId,
        flavor: c.name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!released) continue; // moved on its own since the index read: nothing to recover
    result.released += 1;
    // The authoritative count is the one the write returned, not the possibly stale index copy.
    if (released.autoRecoveries > maxAutoRecoveries) {
      result.leftPending += 1;
      deps.log({
        msg: 'flavor claim sweep released a stranded claim; auto-recovery cap reached, not re-triggering',
        installationId: c.installationId,
        flavor: c.name,
        autoRecoveries: released.autoRecoveries,
      });
      continue;
    }
    let sent = false;
    try {
      sent = await deps.trigger({
        installationId: c.installationId,
        name: c.name,
        actor: SWEEP_ACTOR,
        autoRecovery: true,
      });
    } catch {
      sent = false;
    }
    if (sent) result.retriggered += 1;
    else result.leftPending += 1;
    deps.log({
      msg: 'flavor claim sweep released a stranded claim',
      installationId: c.installationId,
      flavor: c.name,
      autoRecoveries: released.autoRecoveries,
      retriggered: sent,
    });
  }
  return result;
}
