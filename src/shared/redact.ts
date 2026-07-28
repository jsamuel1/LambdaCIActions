/**
 * Control-plane secret redaction (ADR-020).
 *
 * The run-hook capability token is a bearer secret: it authorizes that run's JIT config
 * fetch and self-terminate. The in-VM hook already redacts it from guest logs, but the
 * CONTROL plane holds the plaintext too — it builds the launch payload — and AWS SDK
 * validation errors quote the offending request value back (`Value '…' at
 * 'runHookPayload' failed to satisfy constraint`). Any such message that reaches a run
 * row's `reason` (durable for 90 days and surfaced in the management API / UI) or a Lambda
 * log would publish the token, so error text on the provisioning path is scrubbed here.
 */

/** Redaction placeholder — deliberately identical to the guest hook's. */
const MASK = '<redacted>';

/**
 * Scrub a secret out of arbitrary error/diagnostic text. Removes both the JSON field shape
 * (`"token":"…"`) and, when the caller knows the plaintext, every literal occurrence — the
 * SDK may echo the value alone, outside any JSON envelope.
 */
export function redactSecret(text: string, secret?: string): string {
  let out = String(text).replace(/("token"\s*:\s*")[^"]*(")/g, `$1${MASK}$2`);
  // Guard against a short/empty secret masking innocuous substrings of the message.
  if (secret && secret.length >= 16) out = out.split(secret).join(MASK);
  return out;
}
