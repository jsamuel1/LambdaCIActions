/**
 * Reconciliation sweep for custom-flavor validation that is owed but not happening (ADR-041).
 *
 * The smoke λ moves its row out of `validating` on every path it controls. Two paths it cannot
 * control leave the row claimed: DynamoDB unreachable for the run's whole budget (its fence and
 * release never answer, see `settleUnknownClaim`), and the λ killed outright (OOM, a platform
 * fault). The claim's lease marks such a row as abandoned once it expires, but a lease is only a
 * PERMISSION for a later claim to take the row over: the only producers of runs are registration
 * and an operator's re-validate, so nothing would ever come back. This sweep is that something.
 *
 * Starting a run is itself an asynchronous invoke that can fail: refused by the Lambda API,
 * accepted and then dropped after Lambda's own retries (the smoke λ has reserved concurrency 1, so a
 * burst is throttled), or never sent because the Reaper died between two writes. So the sweep does
 * not treat "the invoke was sent" as "the restart happened". The restart is a durable RETRIGGER
 * MARKER on the row, in the same sparse index as live claims, and only a run's CLAIM consumes it.
 * Until then every tick that finds the marker due sends the restart again.
 *
 * Each tick enumerates due index entries and, for each:
 *
 *   - an EXPIRED CLAIM is released `validating → pending`, conditional on the same token, an
 *     expired lease and the recovery count the decision was based on. That one write also turns the
 *     row's index entry into a retrigger marker, unless the flavor has already been auto-recovered
 *     `MAX_FLAVOR_AUTO_RECOVERIES` times with no verdict in between: each attempt launches a
 *     microVM, so a run that dies deterministically must not become one VM per sweep forever. Past
 *     the cap the row stays `pending` with a reason telling the operator to re-validate.
 *   - a DUE RETRIGGER MARKER is sent: the attempt is recorded and the marker pushed out by a
 *     backoff FIRST, then the async invoke is sent. A refused invoke re-arms the marker for the next
 *     tick without spending the attempt. An accepted invoke that never produces a claim falls due
 *     again after the backoff. After `MAX_FLAVOR_RETRIGGER_SENDS` accepted sends with no claim the
 *     marker is abandoned with an operator-facing reason, so a λ that cannot start is not invoked
 *     forever.
 *
 * Hosted by the Reaper's existing 5-minute schedule rather than by the smoke λ itself: the smoke λ
 * has reserved concurrency 1, so a scheduled sweep there would be throttled behind the very run it
 * is meant to recover. The effects are injected so the whole recovery is unit-testable.
 */

/** A due index entry, as the sweep reads it (see `listDueFlavorRecoveries`). */
export type SweepEntry =
  | {
      kind: 'claim';
      installationId: number;
      name: string;
      runId: string;
      leaseUntil: number;
      autoRecoveries: number;
    }
  | {
      kind: 'retrigger';
      installationId: number;
      name: string;
      token: string;
      attempts: number;
      autoRecoveries: number;
    };

export interface SweepDeps {
  listDue(nowMs: number): Promise<{ claims: SweepEntry[]; truncated: boolean }>;
  /**
   * Conditional release of an expired claim. With `retrigger`, the same write leaves a retrigger
   * marker. `undefined` when the row was not (or no longer) that expired claim.
   */
  release(input: {
    installationId: number;
    name: string;
    runId: string;
    nowMs: number;
    reason: string;
    expectAutoRecoveries: number;
    retrigger?: { token: string; dueAtMs: number };
  }): Promise<{ autoRecoveries: number } | undefined>;
  /** Record a send of restart `token` before sending it. False: the row no longer owes it. */
  markSent(input: {
    installationId: number;
    name: string;
    token: string;
    attempts: number;
    nextDueAtMs: number;
  }): Promise<boolean>;
  /** Undo {@link markSent} after a refused send, due again at `dueAtMs`. */
  rearm(input: {
    installationId: number;
    name: string;
    token: string;
    attempts: number;
    dueAtMs: number;
  }): Promise<boolean>;
  /** Drop restart `token` with an operator-facing reason. */
  abandon(input: {
    installationId: number;
    name: string;
    token: string;
    reason: string;
    nowMs: number;
  }): Promise<boolean>;
  /**
   * Send the restart (an async invoke of the smoke λ). `autoRecovery: true` keeps the row's recovery
   * counter across the new claim. False, or a throw, when the invoke was REFUSED or not sent.
   */
  trigger(input: {
    installationId: number;
    name: string;
    actor: string;
    autoRecovery: true;
  }): Promise<boolean>;
  /** A fresh, unguessable restart token. */
  token(): string;
  log(record: Record<string, unknown>): void;
}

export interface SweepConfig {
  maxAutoRecoveries: number;
  maxSends: number;
  backoffMs: number;
}

export interface SweepResult {
  /** Due index entries read this tick (expired claims + due retrigger markers). */
  expired: number;
  /** Expired claims released `validating → pending`. */
  released: number;
  /** Restarts whose invoke was accepted this tick. */
  retriggered: number;
  /** Restarts whose invoke was refused or could not be recorded: still due, retried next tick. */
  deferred: number;
  /** Released past the auto-recovery cap, or a marker abandoned past the send cap: operator's turn. */
  leftPending: number;
  truncated: boolean;
}

/** The actor stamped on sweep-issued triggers, so the λ's log and the row's `updatedBy` say why. */
export const SWEEP_ACTOR = 'reconciliation-sweep';

export async function sweepExpiredFlavorClaims(
  deps: SweepDeps,
  nowMs: number,
  config: SweepConfig,
): Promise<SweepResult> {
  const { claims, truncated } = await deps.listDue(nowMs);
  if (truncated) {
    deps.log({
      msg: 'flavor claim sweep read a partial page set — the rest are handled on the next tick',
      found: claims.length,
    });
  }
  const result: SweepResult = {
    expired: claims.length,
    released: 0,
    retriggered: 0,
    deferred: 0,
    leftPending: 0,
    truncated,
  };
  for (const c of claims) {
    try {
      if (c.kind === 'claim') await recoverClaim(deps, c, nowMs, config, result);
      else await sendRestart(deps, c, nowMs, config, result);
    } catch (err) {
      // One row's fault must not stop the others. Every write above is conditional and the row's
      // index entry is only ever replaced, never dropped, before its restart is accepted, so the
      // next tick finds this row again.
      deps.log({
        msg: 'flavor claim sweep could not process a due entry — retried next tick',
        kind: c.kind,
        installationId: c.installationId,
        flavor: c.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

async function recoverClaim(
  deps: SweepDeps,
  c: Extract<SweepEntry, { kind: 'claim' }>,
  nowMs: number,
  config: SweepConfig,
  result: SweepResult,
): Promise<void> {
  // Decided BEFORE the write, and the write is conditional on the count this decision used, so the
  // stored reason always matches what the sweep does.
  const willRetrigger = c.autoRecoveries + 1 <= config.maxAutoRecoveries;
  const token = willRetrigger ? deps.token() : undefined;
  const reason = willRetrigger
    ? 'validation run ended without a verdict (its claim expired); an automatic restart is scheduled'
    : `validation run ended without a verdict ${c.autoRecoveries + 1} times in a row; ` +
      'not restarted automatically — re-validate to try again';
  const released = await deps.release({
    installationId: c.installationId,
    name: c.name,
    runId: c.runId,
    nowMs,
    reason,
    expectAutoRecoveries: c.autoRecoveries,
    ...(token ? { retrigger: { token, dueAtMs: nowMs } } : {}),
  });
  if (!released) return; // moved on its own since the index read: nothing to recover
  result.released += 1;
  deps.log({
    msg: 'flavor claim sweep released a stranded claim',
    installationId: c.installationId,
    flavor: c.name,
    autoRecoveries: released.autoRecoveries,
    restartScheduled: Boolean(token),
  });
  if (!token) {
    result.leftPending += 1;
    return;
  }
  // The restart is durable from here: if anything below fails, the marker is due now.
  await sendRestart(
    deps,
    {
      kind: 'retrigger',
      installationId: c.installationId,
      name: c.name,
      token,
      attempts: 0,
      autoRecoveries: released.autoRecoveries,
    },
    nowMs,
    config,
    result,
  );
}

async function sendRestart(
  deps: SweepDeps,
  c: Extract<SweepEntry, { kind: 'retrigger' }>,
  nowMs: number,
  config: SweepConfig,
  result: SweepResult,
): Promise<void> {
  const ids = { installationId: c.installationId, name: c.name, token: c.token };
  if (c.attempts >= config.maxSends) {
    const abandoned = await deps.abandon({
      ...ids,
      nowMs,
      reason:
        `validation was restarted automatically ${c.attempts} times but no run started; ` +
        'not restarted again — re-validate to try again',
    });
    if (abandoned) {
      result.leftPending += 1;
      deps.log({ msg: 'flavor claim sweep abandoned a restart that never started', ...ids });
    }
    return;
  }
  // Recorded FIRST: a sweep that dies after this line leaves the marker due again after the backoff,
  // never consumed. Conditional on the attempt count read, so two sweeps cannot both send it.
  const marked = await deps.markSent({
    ...ids,
    attempts: c.attempts,
    nextDueAtMs: nowMs + config.backoffMs,
  });
  if (!marked) return; // a claim took the marker, or another sweep already sent this attempt
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
  if (sent) {
    result.retriggered += 1;
    deps.log({ msg: 'flavor claim sweep sent a restart', ...ids, attempt: c.attempts + 1 });
    return;
  }
  result.deferred += 1;
  // Nothing ran, so the attempt is not spent and the marker is due on the very next tick. If this
  // write fails too, the marker is still due after the backoff — later, never lost.
  await deps
    .rearm({ ...ids, attempts: c.attempts + 1, dueAtMs: nowMs })
    .catch(() => false);
  deps.log({ msg: 'flavor claim sweep could not send a restart — retried next tick', ...ids });
}
