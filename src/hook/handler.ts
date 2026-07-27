import { LambdaClient } from '@aws-sdk/client-lambda';
import { getJitConfigByRef, getRunFieldsByKey } from '../shared/run-store.js';
import { terminateMicroVM } from '../shared/microvm.js';
import {
  hookTokenMatches,
  keysFromRef,
  parseHookRequest,
} from './broker-core.js';

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
 *   jitconfig  → return the run's own stashed JIT config (ADR-015 by-reference payload)
 *   terminate  → look up the run's own `microvmId` and terminate THAT VM
 *
 * The item key is derived from the token-bound `ref`, never from free-form caller input, so
 * the authority granted to a VM is exactly one run partition. The `microvmId` never leaves
 * the control plane — the VM cannot learn even its own id, let alone anyone else's.
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

export async function handler(event: unknown): Promise<HookBrokerResult> {
  let parsed;
  try {
    parsed = parseHookRequest(event);
  } catch (err) {
    // Never echo the caller's payload — it comes from inside an untrusted VM.
    console.warn(JSON.stringify({ msg: 'hook broker rejected request', error: errMsg(err) }));
    return { ok: false, error: 'bad request' };
  }
  const { action, ref, token } = parsed;

  const item = await getJitConfigByRef(ref);
  if (!item || !hookTokenMatches(token, item.hookTokenHash)) {
    // Same response for "no such run" and "wrong token": a VM must not be able to probe
    // which run refs exist.
    console.warn(JSON.stringify({ msg: 'hook broker denied', action, ref }));
    return { ok: false, error: 'unauthorized' };
  }

  if (action === 'jitconfig') {
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
  const { pk, runSk } = keysFromRef(ref);
  const row = await getRunFieldsByKey(pk, runSk);
  const microvmId = row?.microvmId;
  if (!microvmId) {
    // Provision stamps the id seconds after launch; if it's absent the Reaper backstops.
    console.log(JSON.stringify({ msg: 'no microvmId on run row; Reaper will backstop', pk }));
    return { ok: true, terminated: false };
  }
  try {
    await terminateMicroVM(lambda, microvmId);
    console.log(JSON.stringify({ msg: 'self-terminate brokered', pk, microvmId }));
    return { ok: true, terminated: true };
  } catch (err) {
    // An already-gone VM is success from the caller's point of view.
    console.warn(
      JSON.stringify({ msg: 'brokered terminate failed', pk, microvmId, error: errMsg(err) }),
    );
    return { ok: true, terminated: false };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
