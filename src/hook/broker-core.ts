import { createHash, timingSafeEqual } from 'node:crypto';
import { JITCONFIG_SK, RUN_SK } from '../shared/run-store.js';
import type { HookBrokerRequest } from '../shared/types.js';

/**
 * Pure logic for the hook broker (ADR-021) — the control-plane mediator that stands
 * between an UNTRUSTED microVM and the run store / microVM control API.
 *
 * Before ADR-021 the microVM's execution role held table-wide `dynamodb:GetItem`
 * (`grantReadData`) plus region-wide `lambda:TerminateMicrovm`, so workflow code inside a
 * VM could read any other run's row, harvest its `microvmId`, and terminate it
 * (cross-tenant DoS — the amplifier recorded in ADR-019). Neither could be scoped by IAM:
 * DynamoDB `dynamodb:LeadingKeys` only matches literal partition-key values (no
 * per-VM prefix in a role shared by every VM), and the GA `lambda-microvms` API exposes no
 * VM-level resource ARNs or tags (ADR-015).
 *
 * So authority moves OUT of the VM: the VM now holds only `lambda:InvokeFunction` on this
 * single broker ARN, and presents a per-run capability token minted at provision time. The
 * broker derives the run key from the token's own `ref` — a VM can never name another
 * run's row, because the row it can touch is a function of the secret it holds.
 *
 * These helpers are AWS-free so the token/key contract is unit-testable.
 */

/** Actions a microVM may ask the broker to perform on its own run. */
export const HOOK_ACTIONS = ['jitconfig', 'terminate'] as const;
export type HookAction = (typeof HOOK_ACTIONS)[number];

/** Hash a capability token for at-rest storage (the plaintext only ever lives in the VM). */
export function hashHookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare of a presented token against the stored hash. */
export function hookTokenMatches(token: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashHookToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Derive the two item keys a run's VM is allowed to touch from its JIT config ref
 * (`RUN#<repoId>#<runId>#<jobId>#JITCONFIG`). This is the whole authorization surface:
 * the ref is bound to the token, so the VM cannot address any other partition.
 */
export function keysFromRef(ref: string): {
  pk: string;
  jitSk: string;
  runSk: string;
} {
  const pk = ref.split(`#${JITCONFIG_SK}`)[0];
  return { pk, jitSk: JITCONFIG_SK, runSk: RUN_SK };
}

export interface ParsedHookRequest {
  action: HookAction;
  ref: string;
  token: string;
}

/**
 * Validate an inbound broker request. Rejects anything that isn't a known action on a
 * well-formed run ref — a VM must not be able to steer the broker at arbitrary items.
 */
export function parseHookRequest(raw: unknown): ParsedHookRequest {
  const req = (raw ?? {}) as HookBrokerRequest;
  const action = req.action;
  if (!action || !(HOOK_ACTIONS as readonly string[]).includes(action)) {
    // The caller is untrusted workflow code and this message is logged by the λ, so quote
    // only a short, sanitized slice — an unbounded echo would let a VM write arbitrary
    // content (or forged JSON log lines) into the control plane's log group.
    throw new Error(`unsupported action: ${safeForLog(action)}`);
  }
  if (typeof req.ref !== 'string' || !isRunRef(req.ref)) {
    throw new Error('malformed ref');
  }
  if (typeof req.token !== 'string' || req.token.length < 16) {
    throw new Error('missing token');
  }
  return { action: action as HookAction, ref: req.ref, token: req.token };
}

/** `RUN#<repoId>#<runId>#<jobId>#JITCONFIG` with numeric ids and no extra segments. */
export function isRunRef(ref: string): boolean {
  return new RegExp(`^RUN#\\d+#\\d+#\\d+#${JITCONFIG_SK}$`).test(ref);
}

/**
 * Render a caller-supplied value safe to put in a control-plane log line: printable ASCII
 * only (no newlines → no forged log records) and hard-capped in length.
 */
export function safeForLog(value: unknown, max = 40): string {
  const s = typeof value === 'string' ? value : typeof value;
  const clean = s.replace(/[^\x20-\x7e]/g, '.');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
