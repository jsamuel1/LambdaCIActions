import {
  SSMClient,
  GetParameterCommand,
  DescribeParametersCommand,
  DeleteParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';

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

/**
 * Whether a parameter exists — WITHOUT reading its value. Used by the management API's
 * settings screen, which reports secret **presence/health only** (spec 04 hard rule).
 * Uses DescribeParameters (a metadata API) so the Mgmt λ never needs `GetParameter` on
 * secret paths at all, and a bug there cannot leak a SecureString.
 */
export async function paramExists(name: string): Promise<boolean> {
  const res = await client.send(
    new DescribeParametersCommand({
      ParameterFilters: [{ Key: 'Name', Option: 'Equals', Values: [name] }],
      MaxResults: 1,
    }),
  );
  return (res.Parameters ?? []).length > 0;
}

/**
 * Current version number of a parameter, or undefined when it doesn't exist. Version
 * numbers are metadata, not secrets — they are the rollback handle for a credential relink
 * (ADR-034): SSM's parameter history holds the previous VALUES, so we never copy one.
 */
export async function paramVersion(name: string): Promise<number | undefined> {
  try {
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
    return res.Parameter?.Version;
  } catch (err) {
    if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

/**
 * Read a specific historical version of a parameter (`Name:version`). Only the App-config
 * broker holds the IAM grant for this on secret paths (ADR-034) — it is how rollback
 * restores the pre-relink credentials without the platform ever storing a second copy.
 */
export async function getParamVersion(name: string, version: number): Promise<string> {
  const res = await client.send(
    new GetParameterCommand({ Name: `${name}:${version}`, WithDecryption: true }),
  );
  const value = res.Parameter?.Value;
  if (value === undefined) throw new Error(`SSM parameter ${name}:${version} has no value`);
  return value;
}

/**
 * Write a parameter, returning the new version. Reserved for the App-config broker; the
 * management λ has NO `ssm:PutParameter` grant of any kind (ADR-025 + ADR-034).
 *
 * The per-container read cache is invalidated for the name so a subsequent verification read
 * in the same container can't observe the pre-write value.
 */
export async function putParam(
  name: string,
  value: string,
  opts: { secure: boolean; description?: string },
): Promise<number> {
  const res = await client.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: opts.secure ? 'SecureString' : 'String',
      Overwrite: true,
      ...(opts.description ? { Description: opts.description } : {}),
    }),
  );
  cache.delete(name);
  const version = res.Version;
  if (version === undefined) throw new Error(`SSM put for ${name} returned no version`);
  return version;
}

/**
 * Delete a parameter. Used ONLY to undo a failed first-link: a parameter this attempt created
 * has no prior version to restore, so leaving it behind would strand a partial credential set
 * (ADR-034). A missing parameter is treated as already-undone.
 */
export async function deleteParam(name: string): Promise<void> {
  try {
    await client.send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ParameterNotFound') throw err;
  }
  cache.delete(name);
}
