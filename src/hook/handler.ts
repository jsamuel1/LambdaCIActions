import { LambdaClient } from '@aws-sdk/client-lambda';
import { getJitConfigByRef, getRunFieldsByKey } from '../shared/run-store.js';
import { terminateMicroVM } from '../shared/microvm.js';
import { hookTokenMatches, keysFromRef, parseHookRequest } from './broker-core.js';

/**
 * Hook broker λ (ADR-021) — the control-plane mediator for microVM run-hook operations.
 *
 * A microVM runs UNTRUSTED workflow code. Previously its execution role carried
 * table-wide DynamoDB read + region-wide `lambda:TerminateMicrovm`, so a VM could enumerate
 * other runs' rows, harvest their `microvmId`s and terminate them (ADR-019 amplifier).
 * Neither grant was scopable by IAM (a single shared role can't express a per-VM
 * `dynamodb:LeadingKeys`; the GA microVM API has no per-VM ARNs — ADR-015).
 *
 * Now the VM holds ONE permission — `lambda:InvokeFunction` on this function — and a
 * per-run capability token. Two actions:
 *   jitconfig  → return the run's own stashed JIT config (ADR-016 by-reference payload)
 *   terminate  → look up the run's own `microvmId` and terminate THAT VM
 *
 * The item key is derived from the token-bound `ref`, never from free-form caller input, so
 * the authority granted to a VM is exactly one run partition. The `microvmId` never leaves
 * the control plane — the VM cannot learn even its own id, let alone anyone else's.
 *
 * Token lifetime differs by action ON PURPOSE. `jitconfig` is authorized against the JIT
 * config item, which carries a 30-minute TTL (it is only ever claimed seconds after boot).
 * `terminate` fires at job END — potentially hours later, up to the Reaper's 2h cap — so it
 * is authorized against the hash mirrored on the durable run row by `stampMicrovmId`. If
 * terminate had to read the TTL'd item, every job longer than 30 min would fail
 * authorization and fall back to Reaper-only reaping (~5 min of idle billing), silently
 * regressing ADR-019. The mirror-image race (an ultra-fast job finishing BEFORE Provision's
 * post-launch stamp) falls back to the JIT item so the caller gets a retryable
 * `terminated: false` instead of a terminal `unauthorized`.
 *
 * Env: TABLE_NAME.
 */

const lambda = new LambdaClient({});

export interface HookBrokerResult {
  ok: boolean;
  /** Present for action=jitconfig. */
  jitConfig?: string;
  runId?: number;
  jobId?: number;
  repoFullName?: string;
  labels?: string[];
  /** Present for action=terminate. */
  terminated?: boolean;
  error?: string;
}

/** AWS-facing seam, injected so the authorization logic is testable without AWS. */
export interface BrokerDeps {
  getJitConfigByRef: typeof getJitConfigByRef;
  getRunFieldsByKey: typeof getRunFieldsByKey;
  terminate: (microvmId: string) => Promise<void>;
}

const defaultDeps: BrokerDeps = {
  getJitConfigByRef,
  getRunFieldsByKey,
  terminate: (microvmId) => terminateMicroVM(lambda, microvmId),
};

export function createHandler(deps: BrokerDeps = defaultDeps) {
  return async function handle(event: unknown): Promise<HookBrokerResult> {
    let parsed;
    try {
      parsed = parseHookRequest(event);
    } catch (err) {
      // Never echo the caller's payload — it comes from inside an untrusted VM.
      console.warn(JSON.stringify({ msg: 'hook broker rejected request', error: errMsg(err) }));
      return { ok: false, error: 'bad request' };
    }
    const { action, ref, token } = parsed;
    const { pk, runSk } = keysFromRef(ref);

    if (action === 'jitconfig') {
      const item = await deps.getJitConfigByRef(ref);
      if (!item || !hookTokenMatches(token, item.hookTokenHash)) return denied(action, ref);
      return {
        ok: true,
        jitConfig: item.jitConfig,
        runId: item.runId,
        jobId: item.jobId,
        repoFullName: item.repoFullName,
        labels: item.labels,
      };
    }

    // action === 'terminate' — self-terminate on behalf of the caller's own run only.
    // Authorized off the DURABLE run row: the JIT config item's 30-min TTL is shorter than
    // a legitimate job, and this fires at job end (ADR-020 consequences).
    const row = await deps.getRunFieldsByKey(pk, runSk);
    if (!row || !row.hookTokenHash) {
      // Provision writes microvmId + the token hash in ONE post-launch stamp, so "row has
      // no hash" means the stamp hasn't landed yet — an ultra-fast job can finish first.
      // Falling straight to `unauthorized` would be terminal for the caller (the hook does
      // not retry auth failures — they can't fix themselves), silently regressing ADR-019
      // to Reaper-only reaping. Authorize the retry against the JIT config item instead
      // (same token, still live seconds after boot) and report "nothing to terminate yet"
      // so the hook's bounded retry can reach the stamped row. A caller with no valid
      // capability still gets the byte-identical `unauthorized`.
      const jit = await deps.getJitConfigByRef(ref);
      if (!jit || !hookTokenMatches(token, jit.hookTokenHash)) return denied(action, ref);
      console.log(JSON.stringify({ msg: 'run row not stamped yet; caller may retry', pk }));
      return { ok: true, terminated: false };
    }
    if (!hookTokenMatches(token, row.hookTokenHash)) return denied(action, ref);

    const microvmId = row.microvmId;
    if (!microvmId) {
      // Stamped hash but no id shouldn't happen (one write); Reaper backstops if it does.
      console.log(JSON.stringify({ msg: 'no microvmId on run row; Reaper will backstop', pk }));
      return { ok: true, terminated: false };
    }
    try {
      await deps.terminate(microvmId);
      console.log(JSON.stringify({ msg: 'self-terminate brokered', pk, microvmId }));
      return { ok: true, terminated: true };
    } catch (err) {
      // An already-gone VM is success from the caller's point of view.
      console.warn(
        JSON.stringify({ msg: 'brokered terminate failed', pk, microvmId, error: errMsg(err) }),
      );
      return { ok: true, terminated: false };
    }
  };
}

/**
 * Same response for "no such run" and "wrong token": a VM must not be able to probe which
 * run refs exist.
 */
function denied(action: string, ref: string): HookBrokerResult {
  console.warn(JSON.stringify({ msg: 'hook broker denied', action, ref }));
  return { ok: false, error: 'unauthorized' };
}

export const handler = createHandler();

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
