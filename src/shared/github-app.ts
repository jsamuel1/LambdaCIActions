import crypto from 'node:crypto';

/**
 * GitHub App authentication chain (spec 01):
 *
 *   App PEM (SSM) → sign App JWT (RS256, <=10 min)
 *     → POST /app/installations/{id}/access_tokens → installation token (~60 min)
 *       → POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig → single-use JIT
 *
 * Zero external deps — node:crypto for RS256, global fetch for the API. Installation
 * tokens are cached per-installation until near expiry to respect rate limits.
 */

const GITHUB_API = 'https://api.github.com';
const UA = 'LambdaCIActions';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build a signed App JWT (RS256). `iat` is backdated 60s to tolerate clock skew; `exp` is
 * capped at GitHub's 10-minute maximum.
 */
export function createAppJwt(appId: string, pem: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const exp = iat + 9 * 60; // 9 min — safely under the 10-min ceiling
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: appId };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64url(signer.sign(pem));
  return `${signingInput}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<number, CachedToken>();

async function githubJson<T>(
  path: string,
  init: { method?: string; token: string; tokenType: 'Bearer' | 'token'; body?: unknown },
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `${init.tokenType} ${init.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: T;
  try {
    body = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    throw new Error(`GitHub ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status >= 400) {
    throw new Error(`GitHub ${path} failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body };
}

/**
 * Mint (or reuse a cached) installation token. Cached until 5 minutes before expiry to
 * cut API calls; a leaked token is short-lived anyway.
 */
export async function getInstallationToken(
  appId: string,
  pem: string,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;

  const jwt = createAppJwt(appId, pem);
  const { body } = await githubJson<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: 'POST', token: jwt, tokenType: 'Bearer' },
  );
  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: new Date(body.expires_at).getTime(),
  });
  return body.token;
}

/**
 * Generate a single-use JIT runner config for one repo (ADR-003). The returned
 * `encoded_jit_config` is consumed by `run.sh --jitconfig` inside the microVM; labels and
 * work dir are fixed at mint time so the runner can't self-relabel.
 */
export async function generateJitConfig(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  runId: number;
  jobId: number;
  labels: string[];
}): Promise<string> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  // Runner name must be unique per registration; scope it to the job.
  const name = `lca-${params.runId}-${params.jobId}-${crypto.randomBytes(4).toString('hex')}`;
  const { body } = await githubJson<{ encoded_jit_config: string }>(
    `/repos/${params.owner}/${params.repo}/actions/runners/generate-jitconfig`,
    {
      method: 'POST',
      token,
      tokenType: 'token',
      body: {
        name,
        runner_group_id: 1, // repo-level default group (spec 01 OQ-1: repo-level v1)
        labels: params.labels,
        work_folder: '_work',
      },
    },
  );
  return body.encoded_jit_config;
}

/** Test hook. */
export function _clearTokenCache(): void {
  tokenCache.clear();
}
