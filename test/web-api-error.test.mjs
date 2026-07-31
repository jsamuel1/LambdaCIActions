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
const { ApiError, relinkFailureFrom, relinkSubmitFailure, installationListState, api } = await import(`file://${modPath}`);
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

test('an opaque retry failure keeps the previous rollback handle', () => {
  // The failure this pins: `RelinkForm.submit` used to clear `result` before every attempt. On the
  // `allowHookDesync` retry that made the panel lose the ROLLBACK HANDLE whenever the retry itself
  // failed opaquely (503 lock contention, a proxy error page, a dropped connection) — none of which
  // say anything about the environment's credential state. Two things then broke at once, in the
  // one case the panel exists for: the "Roll back to previous App" button disappeared, and the
  // warning silently downgraded from "the rollback did not complete, parameters may still hold the
  // submitted values" to "nothing was changed", because that copy is chosen by `result.rolledBack`.
  const refusal = {
    applied: false,
    error: "credentials verified, but GitHub's webhook config could not be updated",
    hookSynced: false,
    rolledBack: false, // its own rollback FAILED — exactly the case that needs the button
    replacedVersions: { 'github/app-pem': 3 },
    createdParams: ['github/client-id'],
  };

  for (const opaque of [
    new ApiError(503, 'another platform configuration change is in progress', undefined, {
      error: 'busy',
    }),
    new ApiError(502, 'HTTP 502', undefined, undefined), // non-JSON gateway page
    new Error('network down'), // not an ApiError at all
  ]) {
    const next = relinkSubmitFailure(opaque, refusal);
    assert.ok(!('outcome' in next), 'an opaque failure is not a structured outcome');
    assert.equal(next.result, refusal, 'the previous outcome must survive verbatim');
    assert.equal(next.result.rolledBack, false, 'the failed-rollback warning must not be lost');
    assert.deepEqual(next.result.replacedVersions, { 'github/app-pem': 3 });
    assert.deepEqual(next.result.createdParams, ['github/client-id']);
    assert.ok(next.error.length > 0, 'and the new failure is still reported');
  }

  // A STRUCTURED refusal is an answer about the credential state, so it supersedes the previous
  // outcome rather than being merged with it.
  const superseded = relinkSubmitFailure(
    new ApiError(422, 'nope', undefined, { applied: false, error: 'nope', rolledBack: true }),
    refusal,
  );
  assert.ok('outcome' in superseded);
  assert.equal(superseded.outcome.rolledBack, true);
  assert.equal(superseded.outcome.replacedVersions, undefined);

  // With no previous outcome an opaque failure carries nothing forward — no phantom handle.
  const first = relinkSubmitFailure(new Error('network down'), undefined);
  assert.equal(first.result, undefined);
});

test('an empty installation list names WHICH fact made it empty', () => {
  // Three different facts arrive as the same empty array, and the screen's instruction differs for
  // each. Deciding from `installations.length` alone made a failed `/app/installations` call read
  // as "The App is not installed anywhere yet" — a claim the platform has no evidence for, on a
  // response that still shows a green "verified" badge (the App identity DID verify), sending the
  // operator to install an App that may already be installed everywhere it needs to be.
  const base = { installations: [], installationsHidden: 0, installationsEnumerated: true };

  assert.equal(installationListState(base), 'empty', 'GitHub authoritatively answered zero');
  assert.equal(
    installationListState({ ...base, installationsEnumerated: false }),
    'unenumerated',
    'a failed enumeration must not read as "installed nowhere"',
  );
  assert.equal(
    installationListState({ ...base, installationsHidden: 2 }),
    'scoped',
    'a withheld list is a fact about this session',
  );
  // Scoping outranks enumeration: a withheld list is true regardless of how the list was obtained.
  assert.equal(
    installationListState({ ...base, installationsHidden: 2, installationsEnumerated: false }),
    'scoped',
  );
  assert.equal(
    installationListState({ ...base, installations: [{ installationId: 1 }] }),
    'listed',
  );
  // An API predating the flag only ever sent enumerated lists, so absent must not become a
  // permanent "could not enumerate" banner.
  assert.equal(
    installationListState({ installations: [], installationsHidden: 0 }),
    'empty',
  );
});
