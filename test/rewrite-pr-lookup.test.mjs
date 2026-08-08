// Open-PR lookup used by the auto-rewrite flow (ADR-031, src/shared/github-app.ts → dist).
//
// A SECOND "Open rewrite PR" click legitimately produces no edits — the first run already
// rewrote every job, so `rewriteTargets` skips them all. The λ must still hand the operator
// the link to the PR that is sitting open, otherwise the console reports "nothing to do" for
// a request whose whole outcome is a pull request the operator now has to hunt for.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureBranch,
  ensurePullRequest,
  findOpenPullRequest,
  getBranchSha,
  getFileContent,
  githubErrorStatus,
  isNoCommitsBetween,
  putFileOnBranch,
  _clearTokenCache,
} from '../dist/src/shared/github-app.js';
import { rewritePrBody } from '../dist/src/mgmt/rewrite.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const AUTH = { appId: '1', pem: privateKey, installationId: 42, owner: 'octo', repo: 'repo' };
const BRANCH = 'lambda-ci-actions/adopt-labels-dev';

const realFetch = globalThis.fetch;
let routes;
let calls;

beforeEach(() => {
  _clearTokenCache();
  calls = [];
  routes = new Map();
  routes.set('POST /app/installations/42/access_tokens', {
    status: 201,
    body: { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() },
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, path: u.pathname, search: u.search });
    const route = routes.get(`${method} ${u.pathname}`);
    if (!route) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('finds the open PR for our branch and passes head=owner:branch', async () => {
  routes.set('GET /repos/octo/repo/pulls', {
    body: [{ number: 7, html_url: 'https://github.com/octo/repo/pull/7' }],
  });
  const pr = await findOpenPullRequest({ ...AUTH, branch: BRANCH });
  assert.deepEqual(pr, { url: 'https://github.com/octo/repo/pull/7', number: 7 });
  const query = calls.find((c) => c.path === '/repos/octo/repo/pulls').search;
  assert.match(query, /state=open/);
  assert.match(query, new RegExp(`head=${encodeURIComponent(`octo:${BRANCH}`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('no open PR → undefined, not a throw (the no-op path must not DLQ)', async () => {
  routes.set('GET /repos/octo/repo/pulls', { body: [] });
  assert.equal(await findOpenPullRequest({ ...AUTH, branch: BRANCH }), undefined);
});

test('ensurePullRequest reuses the existing PR and opens none', async () => {
  routes.set('GET /repos/octo/repo/pulls', {
    body: [{ number: 9, html_url: 'https://github.com/octo/repo/pull/9' }],
  });
  const pr = await ensurePullRequest({
    ...AUTH,
    branch: BRANCH,
    base: 'main',
    title: 't',
    body: 'b',
  });
  assert.deepEqual(pr, { url: 'https://github.com/octo/repo/pull/9', number: 9, created: false });
  assert.equal(
    calls.some((c) => c.method === 'POST' && c.path === '/repos/octo/repo/pulls'),
    false,
    'must not open a duplicate PR',
  );
});

test('ensurePullRequest opens one when the branch has no open PR', async () => {
  routes.set('GET /repos/octo/repo/pulls', { body: [] });
  routes.set('POST /repos/octo/repo/pulls', {
    status: 201,
    body: { number: 11, html_url: 'https://github.com/octo/repo/pull/11' },
  });
  const pr = await ensurePullRequest({
    ...AUTH,
    branch: BRANCH,
    base: 'main',
    title: 't',
    body: 'b',
  });
  assert.equal(pr.created, true);
  assert.equal(pr.number, 11);
});

// A stored analysis row can outlive its file: Discovery UPSERTS one row per workflow and never
// prunes rows for deleted/renamed files. Reading such a path 404s. Letting that throw fails the
// WHOLE request — SQS redelivers, 404s again, DLQs (alarming), and every other workflow in the
// repo goes unrewritten while the operator gets no PR at all. A vanished file is repo content
// changing under a stale row, not an infra fault.
test('a workflow that no longer exists is skipped, not a DLQ for the whole repo', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rewrite', 'handler.ts'),
    'utf8',
  );
  // The read must be guarded, and only a 404 may be swallowed — a 403 (missing contents:write)
  // or a 5xx still has to retry.
  const read = src.indexOf('await getFileContent({');
  assert.ok(read > 0, 'getFileContent call not found');
  const tryStart = src.lastIndexOf('try {', read);
  assert.ok(tryStart > 0 && tryStart < read, 'the file read must sit inside a try');
  const guard = src.slice(read, src.indexOf('const plan = planFileRewrite', read));
  assert.match(guard, /if \(!isNotFound\(err\)\) throw err;/, 'non-404 failures must rethrow');
  assert.match(guard, /continue;/, 'a 404 must skip only that file');
  assert.match(src, /function isNotFound[\s\S]*HTTP 404/);

  // And when EVERY candidate vanished, the no-op reason must say so (naming the paths) instead
  // of claiming no job needs a label — the jobs are gone, not routed.
  const noop = src.slice(src.indexOf('if (!plans.length) {'), src.indexOf('There ARE edits'));
  assert.match(noop, /missing\.length/);
  assert.match(noop, /deleted or renamed/);
  assert.match(noop, /missing\.join/, 'the reason must name the vanished paths');
  assert.match(noop, /re-scan the repo/, 'the reason must name the unblocking action');
});

// A no-op result with NO open PR is only benign on a first run. On a re-run the branch already
// exists, so the λ plans against IT (never resetting it — that would be a force-push, ADR-031)
// and `rewriteTargets` skips every already-labelled job. The reason must distinguish the cases,
// and where a PR can still be opened the λ must OPEN it rather than describe the impasse.
// Source-pinned: the λ reaches GitHub + DynamoDB through module imports, not injectable deps
// (same idiom as test/provision-config-guard.test.mjs).
test('the no-change reason distinguishes a fresh branch from a stale one with no PR', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rewrite', 'handler.ts'),
    'utf8',
  );
  const noop = src.slice(src.indexOf("if (!plans.length) {"), src.indexOf('There ARE edits'));
  assert.match(noop, /the rewrite PR is already open/, 'the open-PR case must still link the PR');
  assert.match(
    noop,
    /existingSha/,
    'the reason must branch on whether the branch already existed before this run',
  );
  assert.match(noop, /Delete that branch/, 'the unrecoverable case must name the unblocking action');
  // The branch name has to be IN the message: the operator cannot delete a branch we do not name.
  assert.match(noop, /\$\{branch\}/);
});

// The state that made the old "delete the branch" advice actively harmful: the commits landed
// and only `ensurePullRequest` failed (a 5xx, or an App granted `contents:write` but not
// `pull_requests:write`). The retry re-plans against the rewrite branch, whose jobs now all
// carry LCA labels, so `rewriteTargets` skips every one and the request is a permanent no-op.
// Telling the operator to delete that branch discards the rewrite AND cannot produce a PR — a
// fresh branch off the default branch would reach the same state again. So the no-edit path must
// try to open the PR for the existing branch, and report it as `opened` when it does.
test('an already-rewritten branch with no PR gets its PR opened, not a delete instruction', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rewrite', 'handler.ts'),
    'utf8',
  );
  const noop = src.slice(src.indexOf("if (!plans.length) {"), src.indexOf('There ARE edits'));
  assert.match(noop, /ensurePullRequest\(/, 'the no-edit path must be able to open the PR');
  assert.match(noop, /!open && existingSha/, 'only when the branch exists and no PR is open');
  assert.match(noop, /prCreated/, "a newly opened PR must not be reported as 'nothing-to-do'");
  assert.match(noop, /status: open && prCreated \? 'opened' : 'nothing-to-do'/);
  // Best-effort: a failed open must degrade to an honest no-op, never DLQ a request that
  // committed nothing on this delivery.
  const attempt = noop.slice(noop.indexOf('!open && existingSha'));
  assert.match(attempt, /try \{[\s\S]*\} catch/, 'the open attempt must not escape as a throw');
});

// The recovery PR is opened with NO plan (this delivery committed nothing), so the body must not
// claim "0 job(s) across 0 workflow file(s)" — that reads like an empty PR for a branch that
// really does carry the rewrite.
test('a PR body with no plan describes the earlier commits, not "0 job(s)"', () => {
  const empty = rewritePrBody([]);
  assert.doesNotMatch(empty.body, /0 job\(s\)/);
  assert.match(empty.body, /committed to this branch by an earlier request/);
  // The arm64 warning is the whole point of the body and must survive both shapes.
  assert.match(empty.body, /arm64 \(Graviton\) Linux only/);

  const planned = rewritePrBody([
    {
      path: '.github/workflows/ci.yml',
      edits: [{ jobId: 'build', line: 4, before: 'a', after: 'b' }],
      skipped: [],
      diff: '',
    },
  ]);
  assert.match(planned.body, /rewrites `runs-on` for 1 job\(s\) across 1 workflow file\(s\)/);
  assert.doesNotMatch(planned.body, /earlier request/);
});

// GitHub matches `GET /repos/{o}/{r}/git/ref/{ref}` as literal path segments and does NOT decode
// `%2F` into a separator. Our rewrite branch ALWAYS contains a slash (`rewriteBranchName`), so
// encoding the whole ref made the existence probe 404 for a branch that exists: the λ then read
// that as "absent", tried to create it, and GitHub answered `422 Reference already exists` —
// failing the request, redelivering, and DLQing. Every second "Open rewrite PR" click was
// therefore unfixable, and `planRef` would have pointed at the wrong ref regardless.
test('a slashed branch is probed with a literal slash, not %2F', async () => {
  routes.set(`GET /repos/octo/repo/git/ref/heads/${BRANCH}`, {
    body: { object: { sha: 'deadbeef' } },
  });
  assert.equal(await getBranchSha({ ...AUTH, branch: BRANCH }), 'deadbeef');
  const probe = calls.find((c) => c.path.startsWith('/repos/octo/repo/git/ref/'));
  assert.equal(probe.path, `/repos/octo/repo/git/ref/heads/${BRANCH}`);
  assert.ok(!probe.path.includes('%2F'), 'the ref separator must stay literal');
});

test('a missing branch probes to undefined; a non-404 still throws', async () => {
  // No route registered → the stub answers 404.
  assert.equal(await getBranchSha({ ...AUTH, branch: BRANCH }), undefined);

  routes.set(`GET /repos/octo/repo/git/ref/heads/${BRANCH}`, {
    status: 500,
    body: { message: 'boom' },
  });
  await assert.rejects(() => getBranchSha({ ...AUTH, branch: BRANCH }), /HTTP 500/);
});

test('ensureBranch resolves an existing slashed branch without creating a ref', async () => {
  routes.set(`GET /repos/octo/repo/git/ref/heads/${BRANCH}`, {
    body: { object: { sha: 'cafe1234' } },
  });
  const res = await ensureBranch({ ...AUTH, branch: BRANCH, fromBranch: 'main' });
  assert.deepEqual(res, { created: false, sha: 'cafe1234' });
  assert.equal(
    calls.some((c) => c.method === 'POST' && c.path === '/repos/octo/repo/git/refs'),
    false,
    'an existing branch must never be re-created (that would be a reset/force-push)',
  );
});

// Creating a ref is a visible, permanent change to the CUSTOMER's repository. A request that
// turns out to have nothing to rewrite (the normal second-click case, and any repo whose jobs
// are all already labelled) must leave no trace: previously the λ called `ensureBranch` before
// planning, so a no-op request still pushed a stray `lambda-ci-actions/adopt-labels-<env>`
// branch that no PR ever referenced.
test('the λ probes the branch before planning and only creates it once there are edits', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rewrite', 'handler.ts'),
    'utf8',
  );
  const probe = src.indexOf('getBranchSha(');
  const plan = src.indexOf('const plans:');
  const noop = src.indexOf("status: 'nothing-to-do'");
  const create = src.indexOf('ensureBranch(');
  const write = src.indexOf('putFileOnBranch(');
  assert.ok(probe > 0, 'the branch must be probed, not created, before planning');
  assert.ok(probe < plan, 'the probe decides planRef, so it comes before planning');
  assert.ok(create > noop, 'branch creation must sit AFTER the no-op return');
  assert.ok(create < write, 'the branch must exist before the first commit');
  assert.match(src, /const planRef = existingSha \? branch : baseBranch;/);
});

// The gates of ADR-031 are only worth anything if they sit AHEAD of every side effect. This λ
// is the enforcement point for the `contents:write` capability the project rule keeps off by
// default (AGENTS.md), and test/observability.test.mjs only proves the env var is WIRED —
// nothing pinned that a refused request reaches neither the App private key nor GitHub.
// Source-pinned: the λ reaches SSM/GitHub/DynamoDB through module imports, not injectable deps
// (same idiom as test/provision-config-guard.test.mjs).
test('both rewrite gates refuse BEFORE the App credentials or any GitHub call', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rewrite', 'handler.ts'),
    'utf8',
  );
  const deploymentGate = src.indexOf('if (!REWRITE_ENABLED) {');
  const repoGate = src.indexOf('if (repo?.rewriteEnabled !== true) {');
  const readPem = src.indexOf('getParam(APP_PEM_PARAM)');
  assert.ok(deploymentGate > 0, 'deployment gate not found');
  assert.ok(repoGate > 0, 'per-repo gate not found');
  assert.ok(readPem > 0, 'the App PEM read not found');
  assert.ok(deploymentGate < repoGate, 'the deployment kill switch must be checked first');
  assert.ok(repoGate < readPem, 'both gates must precede reading the App private key');

  // …and ahead of every call that touches the customer's repository, read or write.
  for (const call of [
    'getRepoDefaultBranch(',
    'getBranchSha(',
    'getFileContent(',
    'ensureBranch(',
    'putFileOnBranch(',
    'ensurePullRequest(',
    'findOpenPullRequest(',
  ]) {
    const at = src.indexOf(call);
    assert.ok(at > 0, `${call} not found`);
    assert.ok(repoGate < at, `both gates must precede ${call}`);
  }
});

// A capability that writes to a customer repository must not be enabled by a merely TRUTHY
// value. `validateRepoPatch` admits only a boolean, but this row is also writable out of band —
// RUNBOOK documents a break-glass `dynamodb update-item` on exactly this item for `mode` — so a
// stray `"false"` / `1` must not open a PR on a repo whose console toggle reads off. Both
// `toRepoView` and the management API's `repoOptedIn` test `=== true`; the enforcement point has
// to agree, or the console and the λ disagree about whether the repo consented.
test('the rewrite gates admit only the exact enabling value, not anything truthy', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rewrite', 'handler.ts'),
    'utf8',
  );
  assert.match(src, /process\.env\.REWRITE_ENABLED === 'true'/);
  assert.match(src, /repo\?\.rewriteEnabled !== true/);
});

// ---- structured API errors: only ONE 422 is benign ---------------------------
//
// The λ's no-edit recovery path opens a PR for a branch that already carries a rewrite (the
// state it lands in when the commits succeeded and only the PR call failed). That catch used to
// swallow EVERY failure and report `nothing-to-do`, whose reason tells the operator to DELETE
// the branch holding their un-PR'd rewrite. Only GitHub's "No commits between …" 422 means
// there is genuinely no PR to open; a 403 (App lacks `pull_requests:write`), a 429/secondary
// rate limit and a 5xx must fail loudly so SQS retries and the request ultimately DLQs.
test('githubErrorStatus exposes the HTTP status of an API failure', async () => {
  routes.set('GET /repos/octo/repo/pulls', { status: 403, body: { message: 'Resource not accessible by integration' } });
  const err = await findOpenPullRequest({ ...AUTH, branch: BRANCH }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'a 403 must reject');
  assert.equal(githubErrorStatus(err), 403);
  assert.equal(err.status, 403);
  // The legacy message shape is load-bearing: `isNotFound` and `classifyMintFailure` match it.
  assert.match(err.message, /failed HTTP 403/);
});

test('only GitHub\'s "no commits between" 422 counts as a benign PR-open failure', async () => {
  const cases = [
    { status: 422, message: 'Validation Failed: No commits between main and lambda-ci-actions/adopt-labels-dev', benign: true },
    { status: 422, message: 'Validation Failed: base branch does not exist', benign: false },
    { status: 403, message: 'Resource not accessible by integration', benign: false },
    { status: 403, message: 'You have exceeded a secondary rate limit', benign: false },
    { status: 429, message: 'Too Many Requests', benign: false },
    { status: 500, message: 'Server Error', benign: false },
    { status: 502, message: 'Bad gateway', benign: false },
  ];
  for (const c of cases) {
    routes.set('GET /repos/octo/repo/pulls', { body: [] });
    routes.set('POST /repos/octo/repo/pulls', { status: c.status, body: { message: c.message } });
    const err = await ensurePullRequest({ ...AUTH, branch: BRANCH, base: 'main', title: 't', body: 'b' }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `HTTP ${c.status} must reject`);
    assert.equal(githubErrorStatus(err), c.status);
    assert.equal(
      isNoCommitsBetween(err),
      c.benign,
      `HTTP ${c.status} "${c.message}" benign should be ${c.benign}`,
    );
  }
});

test('the recovery path rethrows every PR failure except the benign 422', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rewrite', 'handler.ts'),
    'utf8',
  );
  // The no-op recovery must rethrow anything that is not the one benign 422 …
  assert.match(src, /if \(!isNoCommitsBetween\(err\)\) throw err;/);
  // … and the open-PR LOOKUP must not conclude "no PR is open" from a failed call, or the
  // recovery below would open a SECOND pull request for a branch that already has one.
  const lookup = src.indexOf('rewrite PR lookup failed');
  assert.ok(lookup > 0, 'PR lookup catch not found');
  assert.match(src.slice(lookup, lookup + 400), /throw err;/);
});

// ---- contents API path encoding ---------------------------------------------
//
// `encodeURI` deliberately leaves `#` and `?` unescaped, so a workflow named
// `release#arm.yml` was sent as a URL FRAGMENT (dropped from the request path entirely) and
// `release?arm.yml` started a query string. The read then 404s and the λ misreports the
// workflow as deleted; the write targets the wrong resource.
test('workflow paths with #, ?, %, spaces and Unicode are encoded per segment', async () => {
  const paths = [
    '.github/workflows/release#arm.yml',
    '.github/workflows/release?arm.yml',
    '.github/workflows/100%-cov.yml',
    '.github/workflows/build ci.yml',
    '.github/workflows/ビルド.yml',
  ];
  for (const p of paths) {
    calls.length = 0;
    _clearTokenCache();
    const expected = `/repos/octo/repo/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
    routes.set(`GET ${expected}`, {
      body: { content: Buffer.from('name: x\n').toString('base64'), encoding: 'base64', sha: 'blob1' },
    });
    const got = await getFileContent({ ...AUTH, path: p });
    assert.equal(got.sha, 'blob1', `read failed for ${p}`);
    const read = calls.find((c) => c.method === 'GET' && c.path.startsWith('/repos/octo/repo/contents/'));
    // `#`/`?` must be percent-encoded IN THE PATH, never split off as fragment/query.
    assert.equal(read.path, expected, `wrong request path for ${p}`);
    assert.equal(read.search, '', `${p} must not leak a query string`);

    routes.set(`PUT ${expected}`, { status: 201, body: { commit: { sha: 'c1' } } });
    await putFileOnBranch({ ...AUTH, branch: BRANCH, path: p, content: 'name: y\n', sha: 'blob1', message: 'm' });
    const write = calls.find((c) => c.method === 'PUT');
    assert.equal(write.path, expected, `wrong write path for ${p}`);
  }
});
