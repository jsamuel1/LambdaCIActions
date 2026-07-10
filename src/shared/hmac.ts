import crypto from 'node:crypto';

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header (spec 01).
 *
 * GitHub HMAC-SHA256s the RAW request body with the shared webhook secret and sends
 * `sha256=<hex>`. We recompute and compare in CONSTANT TIME to avoid leaking via timing.
 *
 * @param rawBody   the exact bytes GitHub sent (do NOT re-serialize parsed JSON)
 * @param signature the full header value, e.g. `sha256=abc123...`
 * @param secret    the webhook secret from SSM
 */
export function verifySignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first (length isn't secret).
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
