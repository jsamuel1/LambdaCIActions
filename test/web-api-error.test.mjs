// Console API-client error contract (spec 04 § Settings, ADR-034).
//
// `web/src/api.ts` is bundled by esbuild for the browser and is NOT part of the `dist` tsc
// output the other tests import, so it is transformed here on the fly (esbuild is already a
// devDependency). It has no imports of its own, so a single-file transform is sufficient.
//
// What is load-bearing, and why a unit test rather than prose:
//
//   The relink route answers a REFUSAL with 422 plus a structured body. `request` rejects on
//   every non-2xx, so unless that body survives the throw, the only supported way out of a
//   webhook-secret desync — the explicit `allowHookDesync` retry — is unreachable, and so is
//   the rollback handle for a refusal that could not roll itself back. The operator would be
//   left with an error string and a form they cannot submit. That regression is invisible to
//   `tsc` and to every server-side test, because the server behaves correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(repoRoot, 'web', 'src', 'api.ts'), 'utf8');
const js = esbuild.transformSync(src, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-web-api-'));
const modPath = path.join(tmp, 'api.mjs');
fs.writeFileSync(modPath, js);
const { ApiError, relinkFailureFrom, api } = await import(`file://${modPath}`);
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/** Install a one-shot fake `fetch` and return the recorded request. */
function fakeFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return calls;
}

const DESYNC_BODY = {
  applied: false,
  error: "credentials verified, but GitHub's webhook configuration could not be updated",
  rolledBack: true,
  hookSynced: false,
  hookError: 'Not Found',
  replacedVersions: { 'github/app-pem': 3, 'github/webhook-secret': 2 },
  createdParams: ['github/client-id'],
};

test('a failing response keeps its parsed body on the thrown ApiError', async () => {
  fakeFetch(422, DESYNC_BODY);
  await assert.rejects(
    () => api.relinkGithubApp({ appId: '1', pem: 'x', webhookSecret: 'y', clientId: 'z', clientSecret: 'w' }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 422);
      // Without this the desync retry and the rollback handle are unreachable.
      assert.equal(err.body?.hookSynced, false);
      assert.equal(err.body?.rolledBack, true);
      assert.deepEqual(err.body?.replacedVersions, DESYNC_BODY.replacedVersions);
      return true;
    },
  );
});

test('a desync refusal is recovered into a RelinkResult the UI can act on', () => {
  const err = new ApiError(422, DESYNC_BODY.error, undefined, DESYNC_BODY);
  const res = relinkFailureFrom(err);
  assert.ok(res, 'refusal must be recoverable');
  assert.equal(res.applied, false);
  // `hookSynced === false` is the exact flag `RelinkForm` gates the allowHookDesync retry on.
  assert.equal(res.hookSynced, false);
  assert.equal(res.rolledBack, true);
  assert.equal(res.hookError, 'Not Found');
  assert.equal(res.error, DESYNC_BODY.error);
  // Rollback handle survives: versions AND the created-parameter list (a first-link has only
  // the latter, so dropping it would make its rollback a no-op).
  assert.deepEqual(res.replacedVersions, DESYNC_BODY.replacedVersions);
  assert.deepEqual(res.createdParams, ['github/client-id']);
});

test('a first-link refusal carries createdParams with no replacedVersions', () => {
  const res = relinkFailureFrom(
    new ApiError(422, 'nope', undefined, {
      applied: false,
      error: 'nope',
      hookSynced: false,
      replacedVersions: {},
      createdParams: ['github/app-id', 'github/app-pem'],
    }),
  );
  assert.deepEqual(res.replacedVersions, {});
  assert.deepEqual(res.createdParams, ['github/app-id', 'github/app-pem']);
});

test('non-relink failures are not misread as refusals', () => {
  // 403 problem+json from requirePlatformAdmin: no `applied` field ⇒ nothing structured to act on.
  assert.equal(
    relinkFailureFrom(new ApiError(403, 'not a platform administrator', undefined, { error: 'not a platform administrator' })),
    undefined,
  );
  // 503 lock contention: retryable, and must not render as a desync refusal.
  assert.equal(
    relinkFailureFrom(new ApiError(503, 'busy', undefined, { error: 'busy' })),
    undefined,
  );
  // A body with `applied: true` is a success, never a refusal.
  assert.equal(relinkFailureFrom(new ApiError(422, 'x', undefined, { applied: true })), undefined);
  // Not an ApiError at all (network fault) ⇒ caller falls back to plain error text.
  assert.equal(relinkFailureFrom(new Error('network down')), undefined);
  assert.equal(relinkFailureFrom(undefined), undefined);
});

test('a non-JSON error page does not become a phantom refusal', async () => {
  fakeFetch(502, '<html>gateway</html>');
  await assert.rejects(
    () => api.settings(),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 502);
      assert.equal(err.body, undefined);
      assert.equal(relinkFailureFrom(err), undefined);
      return true;
    },
  );
});

test('a successful relink still resolves normally', async () => {
  const calls = fakeFetch(200, { applied: true, verified: true, appId: 42, appSlug: 'x', hookSynced: true });
  const res = await api.relinkGithubApp({
    appId: '42',
    pem: 'p',
    webhookSecret: 's',
    clientId: 'c',
    clientSecret: 'cs',
    allowHookDesync: true,
  });
  assert.equal(res.applied, true);
  assert.equal(res.hookSynced, true);
  // The opt-in must actually reach the server, not just exist in the type.
  assert.equal(JSON.parse(calls[0].init.body).allowHookDesync, true);
  assert.equal(calls[0].url, '/api/settings/github-app/relink');
});
