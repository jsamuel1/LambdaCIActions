/**
 * Control-plane secret redaction (ADR-020, extended by ADR-033).
 *
 * Two related jobs live here, both serving the AGENTS.md hard rule that no secret VALUE ever
 * reaches the UI, an API response, or a log:
 *
 *  1. `redactSecret` — scrub a KNOWN plaintext (the run-hook capability token) out of error
 *     text on the provisioning path.
 *  2. `scrubForOperator` / `assertNoSecrets` — scrub and then ASSERT on secret-SHAPED content
 *     for the management/settings surface, where the plaintext is not known to the caller
 *     (a GitHub or AWS error could quote an App PEM or a token we never held).
 */

/** Redaction placeholder — deliberately identical to the guest hook's. */
const MASK = '<redacted>';

/**
 * Scrub a secret out of arbitrary error/diagnostic text. Removes both the JSON field shape
 * (`"token":"…"`) and, when the caller knows the plaintext, every literal occurrence — the
 * SDK may echo the value alone, outside any JSON envelope.
 *
 * The run-hook capability token is a bearer secret: it authorizes that run's JIT config
 * fetch and self-terminate. The in-VM hook already redacts it from guest logs, but the
 * CONTROL plane holds the plaintext too — it builds the launch payload — and AWS SDK
 * validation errors quote the offending request value back (`Value '…' at
 * 'runHookPayload' failed to satisfy constraint`). Any such message that reaches a run
 * row's `reason` (durable for 90 days and surfaced in the management API / UI) or a Lambda
 * log would publish the token, so error text on the provisioning path is scrubbed here.
 */
export function redactSecret(text: string, secret?: string): string {
  let out = String(text).replace(/("token"\s*:\s*")[^"]*(")/g, `$1${MASK}$2`);
  // Guard against a short/empty secret masking innocuous substrings of the message.
  if (secret && secret.length >= 16) out = out.split(secret).join(MASK);
  return out;
}

// ---- secret-SHAPE guard (settings / App-config surface, ADR-033) -------------

/**
 * Structured secret shapes that must never appear in an operator-facing string.
 *
 * Deliberately pattern-based on *prefixed/structured* secrets only. A generic
 * "high-entropy string" heuristic would false-positive on legitimate ids (microVM ids, git
 * shas, pagination cursors) and would make the guard unusable — worse than a narrow guard.
 */
const SECRET_SHAPES: RegExp[] = [
  // Whole PEM block, not just the header: redacting the BEGIN line alone would leave the key
  // material AND the END marker in the string (caught by test/mgmt-settings.test.mjs).
  // `[\s\S]*?` is lazy so two concatenated keys don't merge into one match.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  // A truncated/partial PEM still must not survive — match a lone header or footer too.
  /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub PAT / OAuth / user-to-server token
  /\bv1\.[0-9a-f]{40}\b/, // GitHub App installation token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // fine-grained PAT
];

/**
 * Redact secret-shaped substrings out of an operator-facing string, flatten control
 * characters (no newlines ⇒ no forged JSON log records), and bound the length.
 */
export function scrubForOperator(text: string, max = 300): string {
  let out = text;
  for (const re of SECRET_SHAPES) out = out.replace(new RegExp(re.source, 'g'), '[redacted]');
  out = out.replace(/[^\x20-\x7e]+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * Redact KNOWN plaintext secrets out of arbitrary text by literal match.
 *
 * The shape guard above only recognizes *structured* secrets (PEM blocks, `ghp_…` prefixes).
 * A GitHub App webhook secret and an OAuth client secret are opaque high-entropy strings with
 * no recognizable shape, so nothing in `SECRET_SHAPES` can catch them — but on the relink path
 * we DO hold their plaintext, and GitHub (or an intermediary proxy) can quote a submitted value
 * back inside an error body. Literal redaction closes that gap; the shape guard remains as
 * defense in depth for values we never held.
 *
 * Values shorter than 8 chars are skipped: masking a short string would corrupt unrelated
 * substrings of the message and tell an attacker nothing useful anyway.
 */
export function redactLiterals(text: string, secrets: readonly (string | undefined)[]): string {
  let out = String(text);
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    out = out.split(s).join('[redacted]');
    // GitHub echoes values inside JSON, so a secret containing " or \ arrives escaped.
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped !== s) out = out.split(escaped).join('[redacted]');
  }
  return out;
}

/** True when a payload serializes to something containing a secret-shaped value. */
export function containsSecretShape(payload: unknown): boolean {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return SECRET_SHAPES.some((re) => re.test(json));
}

/**
 * Assert a payload about to cross a trust boundary carries no secret-shaped content. Throws
 * rather than returning tainted data: a leak must fail loudly (the caller answers 500), not
 * degrade into a partially-redacted response nobody notices.
 */
export function assertNoSecrets(payload: unknown, where: string): void {
  if (containsSecretShape(payload)) {
    throw new Error(`refusing to return secret-shaped content from ${where}`);
  }
}

/** Sanitize a caller-supplied value for a log line (printable ASCII, hard length cap). */
export function safeForLog(value: unknown, max = 40): string {
  const s = typeof value === 'string' ? value : typeof value;
  const clean = s.replace(/[^\x20-\x7e]/g, '.');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
