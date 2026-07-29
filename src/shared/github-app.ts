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

// ---- operator OAuth (spec 04 § Auth, M4) ------------------------------------

/** GitHub's OAuth authorize endpoint (web flow). */
export const OAUTH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Exchange an OAuth `code` for a **user** access token (spec 04 § Auth). The token is used
 * once — to identify the operator and enumerate the installations they may administer —
 * and is then discarded; it is never persisted or put in the session cookie (ADR-022).
 */
export async function exchangeOauthCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });
  const text = await res.text();
  let body: { access_token?: string; error?: string; error_description?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`GitHub OAuth token exchange returned non-JSON (HTTP ${res.status})`);
  }
  if (!body.access_token) {
    throw new Error(
      `GitHub OAuth token exchange failed: ${body.error ?? `HTTP ${res.status}`}` +
        (body.error_description ? ` — ${body.error_description}` : ''),
    );
  }
  return body.access_token;
}

/** The authenticated operator's GitHub login. */
export async function getOauthUser(userToken: string): Promise<{ login: string; id: number }> {
  const { body } = await githubJson<{ login: string; id: number }>('/user', {
    token: userToken,
    tokenType: 'Bearer',
  });
  return { login: body.login, id: body.id };
}

/**
 * Installations of THIS App that the user can see (`GET /user/installations`).
 *
 * Authorization for the whole management API derives from this list: GitHub only returns
 * installations on accounts/repos the user has access to, so we never have to interpret
 * org roles ourselves. Filtered to admin-capable accounts by GitHub's own semantics.
 */
export async function listUserInstallations(
  userToken: string,
): Promise<{ installationId: number; accountLogin: string }[]> {
  const { body } = await githubJson<{
    installations?: { id: number; account?: { login?: string } }[];
  }>('/user/installations?per_page=100', { token: userToken, tokenType: 'Bearer' });
  return (body.installations ?? []).map((i) => ({
    installationId: i.id,
    accountLogin: i.account?.login ?? '',
  }));
}

// ---- workflow discovery (spec 03 § Discovery) -------------------------------

/** A workflow file listed under `.github/workflows` (subset of the contents API shape). */
export interface WorkflowFileRef {
  path: string;
  sha: string;
}

/**
 * List `*.yml|*.yaml` files under `.github/workflows` for a repo (contents:read).
 * A repo without the directory (404) yields `[]` — not an error.
 */
export async function listWorkflowFiles(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
}): Promise<WorkflowFileRef[]> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  let body: { type: string; path: string; sha: string; name: string }[];
  try {
    ({ body } = await githubJson<{ type: string; path: string; sha: string; name: string }[]>(
      `/repos/${params.owner}/${params.repo}/contents/.github/workflows`,
      { token, tokenType: 'token' },
    ));
  } catch (err) {
    // No workflows directory → nothing to ingest.
    if (err instanceof Error && err.message.includes('HTTP 404')) return [];
    throw err;
  }
  if (!Array.isArray(body)) return [];
  return body
    .filter((f) => f.type === 'file' && /\.ya?ml$/i.test(f.name))
    .map((f) => ({ path: f.path, sha: f.sha }));
}

/**
 * Fetch one file's raw contents (contents:read). The contents API returns base64 for
 * files ≤ 1 MB — plenty for workflow YAML.
 *
 * `ref` (branch, tag or commit sha) selects which version to read. It matters for the
 * rewrite flow: the blob sha returned here is what guards the subsequent write, so reading
 * the default branch while writing to an existing rewrite branch would always 409.
 */
export async function getFileContent(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<{ content: string; sha: string }> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  const query = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : '';
  const { body } = await githubJson<{ content?: string; encoding?: string; sha: string }>(
    `/repos/${params.owner}/${params.repo}/contents/${encodeURI(params.path)}${query}`,
    { token, tokenType: 'token' },
  );
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error(`GitHub contents for '${params.path}' not base64 (encoding=${body.encoding})`);
  }
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}

// ---- auto-rewrite PR (spec 03 § Auto-rewrite, ADR-031, M5) -------------------
//
// These are the ONLY functions in the codebase that write to a customer repository, and they
// need the App's elevated `contents:write` + `pull_requests:write` permissions. They are
// therefore:
//   - reachable only from the dedicated rewrite λ (never the management API),
//   - gated by a deployment flag AND a per-repo opt-in (ADR-031),
//   - branch + PR only: no direct commit to the default branch, never a force-push.

/** Repo metadata we need to branch from (`default_branch`). */
export async function getRepoDefaultBranch(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
}): Promise<string> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  const { body } = await githubJson<{ default_branch?: string }>(
    `/repos/${params.owner}/${params.repo}`,
    { token, tokenType: 'token' },
  );
  if (!body.default_branch) throw new Error('GitHub repo response has no default_branch');
  return body.default_branch;
}

/**
 * Encode a ref for use in a URL PATH, keeping `/` as a literal separator.
 *
 * `encodeURIComponent` on the whole ref is wrong here: `GET /repos/{o}/{r}/git/ref/{ref}`
 * matches the ref as literal path segments and does NOT decode `%2F` back into a separator,
 * so `heads/lambda-ci-actions%2Fadopt-labels-dev` 404s even though the branch exists. Our
 * rewrite branch always contains a slash (`rewriteBranchName`), so this was the normal case,
 * not an edge one:
 *   - the existence probe 404s, which `ensureBranch` reads as "branch absent",
 *   - the create then fails `422 Reference already exists` (its BODY is unencoded, so the
 *     first run really did create the branch),
 *   - the whole rewrite request errors, SQS redelivers, and it DLQs — i.e. the second
 *     "Open rewrite PR" click could never succeed, and `planRef` would have read the wrong
 *     ref even if it had.
 * Per-segment encoding keeps a `#`/`?`/space in a branch name escaped while leaving the
 * hierarchy intact.
 */
function encodeRefPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/**
 * The tip sha of a branch, or undefined when it does not exist.
 *
 * Separate from `ensureBranch` because the rewrite λ must know whether the branch exists
 * WITHOUT creating it: creating a branch is a visible, permanent change to the customer's
 * repository, and it must not happen for a request that turns out to have nothing to rewrite.
 */
export async function getBranchSha(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
}): Promise<string | undefined> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  try {
    const { body } = await githubJson<{ object?: { sha?: string } }>(
      `/repos/${params.owner}/${params.repo}/git/ref/heads/${encodeRefPath(params.branch)}`,
      { token, tokenType: 'token' },
    );
    return body.object?.sha;
  } catch (err) {
    if (err instanceof Error && err.message.includes('HTTP 404')) return undefined;
    throw err;
  }
}

/**
 * Ensure a branch exists at the tip of `fromBranch`.
 *
 * If the branch already exists it is left ALONE (not reset): the operator may have pushed
 * review fixes onto our PR branch, and resetting it would be a force-push — explicitly out
 * of bounds (spec 03: "never force-pushed").
 */
export async function ensureBranch(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  fromBranch: string;
}): Promise<{ created: boolean; sha: string }> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  const base = `/repos/${params.owner}/${params.repo}`;

  try {
    const { body } = await githubJson<{ object?: { sha?: string } }>(
      `${base}/git/ref/heads/${encodeRefPath(params.branch)}`,
      { token, tokenType: 'token' },
    );
    if (body.object?.sha) return { created: false, sha: body.object.sha };
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('HTTP 404'))) throw err;
  }

  const { body: from } = await githubJson<{ object?: { sha?: string } }>(
    `${base}/git/ref/heads/${encodeRefPath(params.fromBranch)}`,
    { token, tokenType: 'token' },
  );
  const sha = from.object?.sha;
  if (!sha) throw new Error(`cannot resolve '${params.fromBranch}' tip`);

  await githubJson(`${base}/git/refs`, {
    method: 'POST',
    token,
    tokenType: 'token',
    body: { ref: `refs/heads/${params.branch}`, sha },
  });
  return { created: true, sha };
}

/** Commit one file's new content onto a branch (contents:write). */
export async function putFileOnBranch(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  /** Blob sha of the version we rewrote — GitHub rejects the write if the file moved on. */
  sha: string;
  message: string;
}): Promise<void> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  await githubJson(`/repos/${params.owner}/${params.repo}/contents/${encodeURI(params.path)}`, {
    method: 'PUT',
    token,
    tokenType: 'token',
    body: {
      message: params.message,
      content: Buffer.from(params.content, 'utf8').toString('base64'),
      branch: params.branch,
      // Optimistic concurrency: the sha is the blob we planned against. If someone edited the
      // workflow between plan and apply, GitHub 409s instead of us clobbering their change.
      sha: params.sha,
    },
  });
}

/**
 * The open PR from `branch`, if any. Extracted so both `ensurePullRequest` and the rewrite
 * λ's no-change path can use it: a second apply legitimately produces no edits (the first one
 * already rewrote every job), and the operator still needs the link to the PR that is waiting
 * for them.
 */
export async function findOpenPullRequest(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
}): Promise<{ url: string; number: number } | undefined> {
  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  const { body } = await githubJson<{ number: number; html_url: string }[]>(
    `/repos/${params.owner}/${params.repo}/pulls?state=open&head=${encodeURIComponent(`${params.owner}:${params.branch}`)}`,
    { token, tokenType: 'token' },
  );
  if (!Array.isArray(body) || body.length === 0) return undefined;
  return { url: body[0].html_url, number: body[0].number };
}

/**
 * Open a PR from `branch` into `base`, or return the existing open one. Idempotent: a second
 * apply for the same repo updates the branch and reuses the PR rather than opening a dupe.
 */
export async function ensurePullRequest(params: {
  appId: string;
  pem: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<{ url: string; number: number; created: boolean }> {
  const existing = await findOpenPullRequest(params);
  if (existing) return { ...existing, created: false };

  const token = await getInstallationToken(params.appId, params.pem, params.installationId);
  const repoPath = `/repos/${params.owner}/${params.repo}`;
  const { body: pr } = await githubJson<{ number: number; html_url: string }>(`${repoPath}/pulls`, {
    method: 'POST',
    token,
    tokenType: 'token',
    body: { title: params.title, body: params.body, head: params.branch, base: params.base },
  });
  return { url: pr.html_url, number: pr.number, created: true };
}
