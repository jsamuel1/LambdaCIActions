import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * Thin SSM Parameter Store reader with a per-container cache. Lambdas get path-scoped
 * `ssm:GetParameter` (spec 05 IAM posture); we only ever READ here.
 */
const client = new SSMClient({});
const cache = new Map<string, { value: string; expires: number }>();
const TTL_MS = 5 * 60 * 1000; // re-read secrets every 5 min at most

/**
 * Read a parameter (decrypting SecureStrings). Cached briefly to cut API calls on the hot
 * path. `ttlMs=0` forces a fresh read.
 */
export async function getParam(name: string, ttlMs = TTL_MS): Promise<string> {
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && hit.expires > now && ttlMs > 0) return hit.value;

  const res = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const value = res.Parameter?.Value;
  if (value === undefined) throw new Error(`SSM parameter ${name} has no value`);

  cache.set(name, { value, expires: now + ttlMs });
  return value;
}

/** Reset the cache — test hook. */
export function _clearCache(): void {
  cache.clear();
}
