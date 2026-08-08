// Behavioural tests for the App-config broker's write path (ADR-034). The pure request
// contract + credential validation live in mgmt-settings.test.mjs; this pins the decisions the
// λ makes with real (faked) SSM + GitHub seams:
//
//   - nothing is written until the submitted credentials verify against GitHub;
//   - a partial write is undone — restoring prior VERSIONS where they existed and DELETING
//     parameters this attempt created (the first-link case, which has no version to restore);
//   - GitHub's own hook config is updated so a rotated webhook secret can't silently make every
//     delivery fail its HMAC check;
//   - no response, audit row, or error string ever carries a secret value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../dist/src/appcfg/handler.js';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';
const CREDS = {
  appId: '424242',
  pem: PEM,
  webhookSecret: 'w'.repeat(24),
  clientId: 'Iv1.abcdef1234567890',
  clientSecret: 'c'.repeat(40),
};
const PREFIX = '/lca/dev';
const CRED_SUFFIXES = [
  'github/app-id',
  'github/app-pem',
  'github/webhook-secret',
  'github/client-id',
  'github/client-secret',
];

/**
 * A fake SSM + GitHub environment. `existing` seeds parameter versions (so we can model both a
 * rotation and a fresh first-link); `failOn` makes one PutParameter throw.
 */
function harness({ existing = {}, failOn, identityAppId = 424242, hookFails = false, hookError, lockHeld = false, sharedCache, sharedGen = 0, failRestoreRead } = {}) {
  const store = new Map(Object.entries(existing)); // name → { value, version }
  const calls = { puts: [], deletes: [], audits: [], hookUpdates: [], identities: [], locks: [], releases: [], cacheReads: 0, cacheWrites: [], cacheClears: 0, genReads: 0, restoreReads: [] };
  // Models the shared `CONFIG#STATUS` row: `sharedCache` seeds a warm row written by ANOTHER
  // container, which is the case a per-container cache cannot cover. `gen` models the
  // invalidation generation that fences a stale in-flight publish.
  const shared = { row: sharedCache, gen: sharedGen };

  const deps = {
    getParam: async (name) => {
      const hit = store.get(name);
      if (!hit) throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
      return hit.value;
    },
    paramVersion: async (name) => store.get(name)?.version,
    getParamVersion: async (name, version) => {
      calls.restoreReads.push(`${name}:${version}`);
      if (failRestoreRead && name.endsWith(failRestoreRead)) {
        throw new Error(`version ${version} of ${name} is not retrievable`);
      }
      const hit = store.get(name);
      // Model SSM's parameter history: only the seeded prior version is retrievable.
      if (!hit || hit.history?.[version] === undefined) {
        if (hit?.priorValue !== undefined) return hit.priorValue;
        throw new Error(`no version ${version} of ${name}`);
      }
      return hit.history[version];
    },
    putParam: async (name, value) => {
      calls.puts.push(name);
      if (failOn && name.endsWith(failOn)) throw new Error('AccessDenied writing ' + name);
      const prev = store.get(name);
      const version = (prev?.version ?? 0) + 1;
      store.set(name, {
        value,
        version,
        priorValue: prev?.value,
        history: { ...(prev?.history ?? {}), ...(prev ? { [prev.version]: prev.value } : {}) },
      });
      return version;
    },
    deleteParam: async (name) => {
      calls.deletes.push(name);
      store.delete(name);
    },
    appendAudit: async (rec) => {
      calls.audits.push(rec);
    },
    getAppIdentity: async (appId, pem) => {
      calls.identities.push({ appId, pem });
      return {
        appId: identityAppId,
        name: 'LambdaCIActions-dev',
        slug: 'lca-dev',
        htmlUrl: 'https://github.com/apps/lca-dev',
        ownerLogin: 'acme',
        events: ['workflow_job'],
        permissions: { actions: 'read' },
      };
    },
    listAppInstallations: async () => [
      { installationId: 1, accountLogin: 'acme', suspended: false },
    ],
    getAppHookConfig: async () => ({
      url: 'https://api.example.com/webhook',
      contentType: 'json',
      insecureSsl: false,
      secretConfigured: true,
    }),
    updateAppHookConfig: async (appId, pem, config) => {
      calls.hookUpdates.push({ appId, config });
      if (hookError) throw new Error(hookError);
      if (hookFails) throw new Error('403 app does not own its hook config');
    },
    listAppHookDeliveries: async () => [
      { id: 77, event: 'push', action: null, status: 'OK', statusCode: 202, deliveredAt: 'now', durationMs: 5, redelivery: false },
    ],
    redeliverAppHook: async () => {},
    acquireConfigLock: async (holder) => {
      calls.locks.push(holder);
      return !lockHeld;
    },
    releaseConfigLock: async (holder) => {
      calls.releases.push(holder);
    },
    getStatusCache: async () => {
      calls.cacheReads += 1;
      return shared.row;
    },
    getStatusGeneration: async () => {
      calls.genReads += 1;
      return shared.gen;
    },
    putStatusCache: async (payload, _now, expectedGen) => {
      // Model the conditional write: a generation that moved on drops the (stale) payload.
      if (expectedGen !== undefined && expectedGen !== shared.gen) return;
      calls.cacheWrites.push(payload);
      shared.row = payload;
    },
    clearStatusCache: async () => {
      calls.cacheClears += 1;
      shared.row = undefined;
      shared.gen += 1;
    },
  };
  return { deps, store, calls, shared, handle: createHandler(deps) };
}

/** Seed a fully-linked environment (the rotation case). */
function linkedStore() {
  const out = {};
  for (const s of CRED_SUFFIXES) {
    out[`${PREFIX}/${s}`] = { value: `old-${s}`, version: 3, history: { 3: `old-${s}` } };
  }
  return out;
}

// ---- verify before write ---------------------------------------------------

test('relink writes nothing when the submitted key authenticates as a different App', async () => {
  const h = harness({ existing: linkedStore(), identityAppId: 999999 });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.match(res.error, /does not match/);
  assert.deepEqual(h.calls.puts, [], 'nothing may be written before verification passes');
});

test('a successful relink writes every credential and syncs GitHub hook config', async () => {
  const h = harness({ existing: linkedStore() });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
  assert.equal(res.appId, 424242);
  for (const s of CRED_SUFFIXES) {
    assert.ok(h.calls.puts.includes(`${PREFIX}/${s}`), `did not write ${s}`);
  }
  // Rotating the stored webhook secret without telling GitHub would 401 every delivery.
  assert.equal(h.calls.hookUpdates.length, 1);
  assert.equal(h.calls.hookUpdates[0].config.secret, CREDS.webhookSecret);
  assert.equal(res.hookSynced, true);
});

test('the rollback handle reports the versions that were replaced', async () => {
  const h = harness({ existing: linkedStore() });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.deepEqual(res.replacedVersions, {
    'github/app-id': 3,
    'github/app-pem': 3,
    'github/webhook-secret': 3,
    'github/client-id': 3,
    'github/client-secret': 3,
  });
  // Nothing was created, so there is nothing for a rollback to delete.
  assert.equal(res.createdParams, undefined);
});

test('a first-link reports the parameters it CREATED as part of the rollback handle', async () => {
  // Empty environment: every credential parameter is created, so `replacedVersions` is empty and
  // the ONLY way to undo the link is to delete what it made. Without `createdParams` the
  // operator's rollback button would have nothing to act on and silently no-op.
  const h = harness({ existing: {} });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, true);
  assert.deepEqual(res.replacedVersions, {});
  assert.deepEqual(res.createdParams, CRED_SUFFIXES);
});

test('an explicit rollback deletes the parameters a first-link created', async () => {
  const h = harness({ existing: {} });
  const linked = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.deepEqual(linked.createdParams, CRED_SUFFIXES);

  const res = await h.handle({
    action: 'rollback',
    actor: 'alice',
    restore: {},
    remove: linked.createdParams,
  });
  assert.equal(res.ok, true);
  assert.equal(res.rolledBack, true);
  for (const s of CRED_SUFFIXES) {
    assert.ok(h.calls.deletes.includes(`${PREFIX}/${s}`), `${s} was not removed`);
    assert.equal(h.store.has(`${PREFIX}/${s}`), false, `${s} still present after rollback`);
  }
});

test('a rollback naming neither a version nor a removal is refused', async () => {
  const h = harness({ existing: linkedStore() });
  const res = await h.handle({ action: 'rollback', actor: 'alice', restore: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /at least one parameter version or removal/);
  assert.deepEqual(h.calls.puts, []);
  assert.deepEqual(h.calls.deletes, []);
});

test('a rollback whose history read fails writes nothing at all', async () => {
  // Every historical value is read BEFORE any write, so a purged/inaccessible version aborts
  // while the environment is still wholly on the replacement credentials. A read-then-write loop
  // would have restored the earlier parameters and left a mixed credential set behind.
  const h = harness({ existing: linkedStore(), failRestoreRead: 'client-secret' });
  const res = await h.handle({
    action: 'rollback',
    actor: 'alice',
    restore: {
      'github/app-id': 3,
      'github/app-pem': 3,
      'github/webhook-secret': 3,
      'github/client-id': 3,
      'github/client-secret': 3,
    },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(h.calls.puts, [], 'a failed pre-read must leave SSM untouched');
  assert.deepEqual(h.calls.deletes, []);
});

test('a hook-config failure is reported but does not fail a relink that kept the same secret', async () => {
  // Same webhook secret ⇒ GitHub and Ingest still agree, so a failed hook PATCH is advisory:
  // deliveries keep verifying and the operator only needs to know the URL may be stale.
  const existing = linkedStore();
  existing[`${PREFIX}/github/webhook-secret`] = {
    value: CREDS.webhookSecret,
    version: 3,
    history: { 3: CREDS.webhookSecret },
  };
  const h = harness({ existing, hookFails: true });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, true);
  assert.equal(res.hookSynced, false);
  assert.match(res.hookError, /hook config/);
});

test('a hook-config failure on a ROTATED secret is refused and rolled back', async () => {
  // The wedge case: GitHub keeps signing with the old secret while Ingest verifies the new one,
  // so every delivery is rejected 401 and no job is ever claimed. GitHub does not retry a
  // delivery that failed verification, so that work is lost, not deferred. Fail closed.
  const h = harness({ existing: linkedStore(), hookFails: true });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.equal(res.hookSynced, false);
  assert.equal(res.rolledBack, true);
  assert.match(res.error, /rolled back/);
  for (const s of CRED_SUFFIXES) {
    assert.equal(h.store.get(`${PREFIX}/${s}`).value, `old-${s}`, `${s} not restored`);
  }
});

test('an operator may accept a hook desync explicitly', async () => {
  const h = harness({ existing: linkedStore(), hookFails: true });
  const res = await h.handle({
    action: 'relink',
    actor: 'alice',
    credentials: CREDS,
    allowHookDesync: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.hookSynced, false);
  // The new credentials stay in place — the operator said they would fix GitHub by hand.
  assert.equal(h.store.get(`${PREFIX}/github/app-id`).value, CREDS.appId);
});

// ---- partial-write rollback ------------------------------------------------

test('a partial write on a linked environment is rolled back to the prior versions', async () => {
  const h = harness({ existing: linkedStore(), failOn: 'client-secret' });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  // Each successfully-written parameter is restored to its seeded old value.
  for (const s of ['github/app-id', 'github/app-pem', 'github/webhook-secret', 'github/client-id']) {
    assert.equal(h.store.get(`${PREFIX}/${s}`).value, `old-${s}`, `${s} not restored`);
  }
  assert.deepEqual(h.calls.deletes, [], 'nothing was created, so nothing should be deleted');
});

test('a partial FIRST link deletes the parameters it created instead of stranding them', async () => {
  // Fresh environment: only app-id/app-pem exist (enough for verification reads), the rest are
  // absent — so a failure part-way has no prior version to restore for the created ones.
  const existing = {
    [`${PREFIX}/github/app-id`]: { value: 'seed', version: 1, history: { 1: 'seed' } },
    [`${PREFIX}/github/app-pem`]: { value: PEM, version: 1, history: { 1: PEM } },
  };
  const h = harness({ existing, failOn: 'client-secret' });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true, 'rollback must succeed on a first-link failure');
  // webhook-secret + client-id did not exist before → deleted, not left half-written.
  assert.deepEqual(h.calls.deletes.sort(), [
    `${PREFIX}/github/client-id`,
    `${PREFIX}/github/webhook-secret`,
  ]);
  assert.equal(h.store.has(`${PREFIX}/github/webhook-secret`), false);
  assert.equal(h.store.has(`${PREFIX}/github/client-id`), false);
  // app-id/app-pem existed → restored to their seeded values.
  assert.equal(h.store.get(`${PREFIX}/github/app-id`).value, 'seed');
});

test('a hook-config failure does NOT trigger a rollback when the secret is unchanged', async () => {
  // Unchanged webhook secret ⇒ GitHub and Ingest still agree, so deliveries keep verifying and a
  // failed hook PATCH is advisory. (The ROTATED case fails closed — covered above.)
  const existing = linkedStore();
  existing[`${PREFIX}/github/webhook-secret`] = {
    value: CREDS.webhookSecret,
    version: 3,
    history: { 3: CREDS.webhookSecret },
  };
  const h = harness({ existing, hookFails: true });
  await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.deepEqual(h.calls.deletes, []);
  assert.equal(h.store.get(`${PREFIX}/github/app-id`).value, CREDS.appId);
});

// ---- no secret ever leaves --------------------------------------------------

test('no relink response or audit row contains a submitted credential value', async () => {
  for (const opts of [
    { existing: linkedStore() },
    { existing: linkedStore(), failOn: 'client-secret' },
    { existing: linkedStore(), identityAppId: 999999 },
  ]) {
    const h = harness(opts);
    const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
    const serialized = JSON.stringify({ res, audits: h.calls.audits });
    assert.equal(serialized.includes('PRIVATE KEY'), false, 'PEM leaked');
    assert.equal(serialized.includes(CREDS.clientSecret), false, 'client secret leaked');
    assert.equal(serialized.includes(CREDS.webhookSecret), false, 'webhook secret leaked');
  }
});

test('status never returns a credential value even though it reads the PEM', async () => {
  const h = harness({ existing: linkedStore() });
  const res = await h.handle({ action: 'status', actor: 'system' });
  assert.equal(res.ok, true);
  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes('PRIVATE KEY'), false);
  assert.equal(res.linkage.app.appId, 424242);
  assert.equal(res.linkage.webhook.secretConfigured, true);
});

test('status degrades with a message when the credentials are unreadable', async () => {
  const h = harness({ existing: {} });
  const res = await h.handle({ action: 'status', actor: 'system' });
  assert.equal(res.ok, true);
  assert.equal(res.linkage.app, null);
  assert.match(res.linkage.verifyError, /not readable/);
});

// ---- other actions ---------------------------------------------------------

test('setRunnerLabels writes the parameter and audits the transition', async () => {
  const h = harness({
    existing: { [`${PREFIX}/config/runner-labels`]: { value: 'lca-base', version: 1 } },
  });
  const res = await h.handle({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-base,lca-docker' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.labels, ['lca-base', 'lca-docker']);
  assert.equal(h.store.get(`${PREFIX}/config/runner-labels`).value, 'lca-base,lca-docker');
  const audit = h.calls.audits.find((a) => a.action === 'runner-labels-change');
  assert.ok(audit, 'no audit row for the label change');
  assert.match(audit.detail, /lca-docker/);
});

test('redeliver defaults to the most recent delivery and audits it', async () => {
  const h = harness({ existing: linkedStore() });
  const res = await h.handle({ action: 'redeliver', actor: 'alice' });
  assert.equal(res.ok, true);
  assert.equal(res.deliveryId, 77);
  assert.ok(h.calls.audits.some((a) => a.action === 'webhook-redeliver'));
});

test('a malformed request is rejected without touching SSM', async () => {
  const h = harness({ existing: linkedStore() });
  const res = await h.handle({ action: 'nope', actor: 'alice' });
  assert.equal(res.ok, false);
  assert.deepEqual(h.calls.puts, []);
  assert.deepEqual(h.calls.deletes, []);
});

test('operator-driven rollback restores the requested versions and re-verifies', async () => {
  const h = harness({ existing: linkedStore() });
  const relink = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  const res = await h.handle({
    action: 'rollback',
    actor: 'alice',
    restore: relink.replacedVersions,
  });
  assert.equal(res.ok, true);
  assert.equal(res.rolledBack, true);
  assert.equal(h.store.get(`${PREFIX}/github/app-id`).value, 'old-github/app-id');
});

// ---- literal-secret redaction (submitted values have no recognizable shape) --------------

test('a GitHub error quoting the submitted webhook secret never reaches the result', async () => {
  // GitHub's 422 bodies quote the offending request value back, and a webhook secret is an
  // opaque high-entropy string — the shape guard cannot recognize it, so the broker must
  // redact it by literal value. This runs on the REFUSAL path (a rotated secret whose hook sync
  // failed), which is precisely where GitHub's quoted-back body ends up in operator-facing text.
  const h = harness({
    existing: linkedStore(),
    hookError: `Invalid request. "${CREDS.webhookSecret}" is not a valid secret.`,
  });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false, 'a rotated secret that GitHub never received must fail closed');
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(CREDS.webhookSecret), 'webhook secret leaked into the result');
  assert.ok(res.hookError.includes('[redacted]'), 'expected the value to be masked');
  // ...and equally on the accepted-desync path, where the same text is returned with ok:true.
  const accepted = harness({
    existing: linkedStore(),
    hookError: `Invalid request. "${CREDS.webhookSecret}" is not a valid secret.`,
  });
  const ok = await accepted.handle({
    action: 'relink',
    actor: 'alice',
    credentials: CREDS,
    allowHookDesync: true,
  });
  assert.equal(ok.ok, true);
  assert.ok(!JSON.stringify(ok).includes(CREDS.webhookSecret), 'webhook secret leaked');
  assert.ok(ok.hookError.includes('[redacted]'));
});

test('a thrown error quoting the submitted client secret is redacted from the error field', async () => {
  const h = harness({ existing: linkedStore() });
  // The verification call itself failing is the realistic case: GitHub 422s and quotes the
  // rejected value back, and this error is what the operator sees.
  h.deps.getAppIdentity = async () => {
    throw new Error(`upstream rejected client_secret=${CREDS.clientSecret}`);
  };
  const handle = createHandler(h.deps);
  const res = await handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(CREDS.clientSecret), 'client secret leaked into the error');
  assert.ok(res.error.includes('[redacted]'), 'expected the value to be masked');
});

// ---- write serialization (lock, not a concurrency cap) -----------------------------------

test('a mutating action is refused when the config lock is already held', async () => {
  const h = harness({ existing: linkedStore(), lockHeld: true });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.match(res.error, /in progress/);
  assert.deepEqual(h.calls.puts, [], 'nothing may be written without the lock');
});

test('the lock is released even when the action fails', async () => {
  const h = harness({ existing: linkedStore(), failOn: 'github/client-id' });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.equal(h.calls.locks.length, 1);
  assert.deepEqual(h.calls.releases, h.calls.locks, 'a failed relink must not wedge the lock');
});

test('status runs WITHOUT the lock so a polling Settings screen cannot block a write', async () => {
  const h = harness({ existing: linkedStore(), lockHeld: true });
  const res = await h.handle({ action: 'status', actor: 'system' });
  assert.equal(res.ok, true);
  assert.deepEqual(h.calls.locks, [], 'the read path must not take the config lock');
});

test('setRunnerLabels is serialized by the same lock', async () => {
  const h = harness({ existing: linkedStore(), lockHeld: true });
  const res = await h.handle({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-base' });
  assert.equal(res.ok, false);
  assert.deepEqual(h.calls.puts, []);
});

// ---- rollback must restore GitHub's hook config too ---------------------------------------

test('rollback re-points GitHub at the RESTORED webhook secret', async () => {
  // Restoring SSM alone would leave GitHub signing with the relinked App's secret while Ingest
  // verifies against the restored one — every delivery 401s, which is the exact silent outage
  // the relink path synchronizes to avoid.
  const h = harness({ existing: linkedStore() });
  const relink = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  const before = h.calls.hookUpdates.length;
  const res = await h.handle({
    action: 'rollback',
    actor: 'alice',
    restore: relink.replacedVersions,
  });
  assert.equal(res.ok, true);
  assert.equal(res.hookSynced, true);
  assert.equal(h.calls.hookUpdates.length, before + 1, 'rollback must re-sync the hook config');
  assert.equal(
    h.calls.hookUpdates[before].config.secret,
    'old-github/webhook-secret',
    'the RESTORED secret must be pushed, not the relinked one',
  );
});

test('a rollback whose hook re-sync fails still reports the restore, with hookSynced false', async () => {
  const h = harness({ existing: linkedStore() });
  const relink = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  // Only the ROLLBACK's hook update fails (some Apps don't own their hook config).
  h.deps.updateAppHookConfig = async () => {
    throw new Error('403 app does not own its hook config');
  };
  const res = await createHandler(h.deps)({
    action: 'rollback',
    actor: 'alice',
    restore: relink.replacedVersions,
  });
  assert.equal(res.ok, true);
  assert.equal(res.rolledBack, true);
  assert.equal(res.hookSynced, false);
  assert.match(res.hookError, /hook config/);
});

// ---- lock holder identity ----------------------------------------------------------------

test('two mutations by the same actor in the same millisecond get distinct lock holders', async () => {
  // A holder string of `actor:Date.now()` collides on a double-submitted form, and the first
  // release would then free the lock the second call is still working under.
  const h = harness({ existing: linkedStore() });
  await h.handle({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-base' });
  await h.handle({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-docker' });
  assert.equal(h.calls.locks.length, 2);
  assert.notEqual(h.calls.locks[0], h.calls.locks[1]);
  assert.deepEqual(h.calls.releases, h.calls.locks, 'each holder releases its own lock');
});

test('lock contention is reported as retryable busy, not a plain failure', async () => {
  const h = harness({ existing: linkedStore(), lockHeld: true });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.equal(res.busy, true, 'the management API answers 503 off this flag');
});

// ---- status caching (the App's JWT rate budget is shared with job provisioning) -----------

test('polled status is served from a per-container cache', async () => {
  // `status` costs four App-JWT GitHub calls, and the whole App shares a 5,000/h budget with
  // Provision's installation-token minting. A polling console must not drain it.
  const h = harness({ existing: linkedStore() });
  await h.handle({ action: 'status', actor: 'system' });
  const afterFirst = h.calls.identities.length;
  assert.ok(afterFirst > 0);
  await h.handle({ action: 'status', actor: 'system' });
  assert.equal(h.calls.identities.length, afterFirst, 'a second poll must not re-hit GitHub');
});

test('a mutation invalidates the status cache so the next poll sees the new state', async () => {
  const h = harness({ existing: linkedStore() });
  await h.handle({ action: 'status', actor: 'system' });
  const cached = h.calls.identities.length;
  await h.handle({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-base' });
  await h.handle({ action: 'status', actor: 'system' });
  assert.ok(h.calls.identities.length > cached, 'stale linkage must not survive a write');
});

// ---- app-slug ordering -------------------------------------------------------------------

test('the app-slug is written only after post-write verification succeeds', async () => {
  // Written before verification, a rolled-back environment would keep advertising the slug of
  // an App whose credentials are no longer stored.
  const h = harness({ existing: linkedStore() });
  // The submitted-credential verification passes; the post-write re-read verification fails.
  let calls = 0;
  h.deps.getAppIdentity = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        appId: 424242,
        name: 'LCA',
        slug: 'lca-dev',
        htmlUrl: '',
        ownerLogin: 'acme',
        events: [],
        permissions: {},
      };
    }
    throw new Error('stored credentials do not authenticate');
  };
  const res = await createHandler(h.deps)({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.equal(
    h.calls.puts.includes(`${PREFIX}/github/app-slug`),
    false,
    'a failed relink must not leave the new slug behind',
  );
});

test('a hook-desync rollback must not leave the new slug behind either', async () => {
  // The desync refusal (rotated webhook secret + failed hook PATCH) is a rollback like any
  // other: every credential parameter goes back to its prior version. `app-slug` carries no
  // version in that snapshot, so `undoWrites` cannot restore it — which means it must not be
  // written until the relink is past the fail-closed gate. Written earlier, a refused relink
  // leaves the environment advertising the slug of an App whose credentials are gone, and the
  // Setup screen's install URL points at the wrong App.
  const h = harness({ existing: linkedStore(), hookFails: true });
  h.store.set(`${PREFIX}/github/app-slug`, { value: 'lca-old', version: 1, history: { 1: 'lca-old' } });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.equal(
    h.store.get(`${PREFIX}/github/app-slug`).value,
    'lca-old',
    'a refused relink must leave the previous slug in place',
  );
  assert.equal(
    h.calls.puts.includes(`${PREFIX}/github/app-slug`),
    false,
    'the slug must not be written before the hook-desync gate',
  );
});

test('an accepted hook desync still records the new slug', async () => {
  // The mirror case: once the operator accepts the desync the relink stands, so the slug MUST
  // be updated — moving the write later must not skip it on the surviving path.
  const h = harness({ existing: linkedStore(), hookFails: true });
  const res = await h.handle({
    action: 'relink',
    actor: 'alice',
    credentials: CREDS,
    allowHookDesync: true,
  });
  assert.equal(res.ok, true);
  assert.equal(h.store.get(`${PREFIX}/github/app-slug`).value, 'lca-dev');
});

test('rollback re-points app-slug at the App the restored credentials authenticate as', async () => {
  // `app-slug` is not a credential and carries no version in the rollback snapshot, so
  // restoring versions alone would leave the environment advertising the slug of the App it
  // just rolled away from (the same stale-slug hazard the relink path avoids by ordering).
  const h = harness({ existing: linkedStore() });
  h.store.set(`${PREFIX}/github/app-slug`, { value: 'lca-old', version: 1, history: { 1: 'lca-old' } });
  let call = 0;
  h.deps.getAppIdentity = async () => {
    call += 1;
    // Relink + its post-write re-verify see the NEW App; the post-rollback verify sees the old.
    const slug = call <= 2 ? 'lca-new' : 'lca-old';
    return {
      appId: 424242,
      name: 'LCA',
      slug,
      htmlUrl: '',
      ownerLogin: 'acme',
      events: [],
      permissions: {},
    };
  };
  const handle = createHandler(h.deps);
  const relink = await handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(relink.ok, true);
  assert.equal(h.store.get(`${PREFIX}/github/app-slug`).value, 'lca-new');

  const res = await handle({ action: 'rollback', actor: 'alice', restore: relink.replacedVersions });
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
  assert.equal(
    h.store.get(`${PREFIX}/github/app-slug`).value,
    'lca-old',
    'a rolled-back environment must not keep advertising the relinked App slug',
  );
});

test('an unverifiable rollback leaves the slug alone rather than guessing', async () => {
  const h = harness({ existing: linkedStore() });
  h.store.set(`${PREFIX}/github/app-slug`, { value: 'lca-old', version: 1, history: { 1: 'lca-old' } });
  let call = 0;
  h.deps.getAppIdentity = async () => {
    call += 1;
    if (call <= 2) {
      return { appId: 424242, name: 'LCA', slug: 'lca-new', htmlUrl: '', ownerLogin: 'acme', events: [], permissions: {} };
    }
    throw new Error('restored credentials do not authenticate');
  };
  const handle = createHandler(h.deps);
  const relink = await handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  const res = await handle({ action: 'rollback', actor: 'alice', restore: relink.replacedVersions });
  assert.equal(res.ok, true);
  assert.equal(res.verified, false);
  assert.equal(
    h.store.get(`${PREFIX}/github/app-slug`).value,
    'lca-new',
    'with nothing verified there is no authoritative slug to write — verified:false is the signal',
  );
});

// ---- shared (cross-container) status cache ---------------------------------
//
// The in-memory cache above only bounds ONE container. `GET /api/settings` is readable by any
// authenticated session (ADR-035) and concurrent reads scale the broker out, so a cold container
// must be able to reuse an answer another container already paid four App-JWT calls for.

test('a cold container reuses a warm shared cache row instead of calling GitHub', async () => {
  const warm = { ok: true, linkage: { app: { appId: 424242, name: 'LCA', slug: 'lca-dev', htmlUrl: '', ownerLogin: 'acme', events: [], permissions: {} }, installations: [], webhook: null } };
  const h = harness({ existing: linkedStore(), sharedCache: warm });
  const res = await h.handle({ action: 'status', actor: 'system' });
  assert.equal(res.ok, true);
  assert.equal(res.linkage.app.appId, 424242);
  assert.equal(h.calls.identities.length, 0, 'a warm shared row must not cost a GitHub call');
});

test('a cold container with no shared row publishes its answer for the others', async () => {
  const h = harness({ existing: linkedStore() });
  await h.handle({ action: 'status', actor: 'system' });
  assert.equal(h.calls.cacheReads, 1);
  assert.equal(h.calls.cacheWrites.length, 1, 'the paid-for answer must be shared');
  assert.ok(h.calls.cacheWrites[0].linkage, 'the shared row carries the linkage view');
  const serialized = JSON.stringify(h.calls.cacheWrites[0]);
  assert.equal(serialized.includes('PRIVATE KEY'), false, 'the shared row must hold no secret');
});

test('a mutation clears the SHARED row too, not just this container', async () => {
  const h = harness({ existing: linkedStore(), sharedCache: { ok: true, linkage: { app: null, installations: [], webhook: null } } });
  await h.handle({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-base' });
  assert.ok(h.calls.cacheClears >= 1, 'other containers would otherwise serve pre-change state');
  assert.equal(h.shared.row, undefined);
});

test('a status read that races a mutation cannot leave a pre-change row behind', async () => {
  // The generation fence only covers a read that STARTED before the mutation's invalidation. A
  // read that starts just AFTER it observes the already-bumped generation, so its publish is
  // legitimate — yet it can still be computing PRE-change data while the writes are landing. If
  // the mutation only invalidated on the way IN, that stale row would then survive for the full
  // TTL and every container would serve the old App/labels. Invalidating again after the writes
  // land bumps the generation past any such in-flight publish.
  const h = harness({ existing: linkedStore() });
  let racingRead;
  const original = h.deps.putParam;
  h.deps.putParam = async (name, value, opts) => {
    // Mid-write: a poll arrives on another container, reads the (current) generation and starts
    // computing. It resolves before this mutation returns.
    racingRead ??= createHandler(h.deps)({ action: 'status', actor: 'system' });
    return original(name, value, opts);
  };
  const fresh = createHandler(h.deps);
  const res = await fresh({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-new' });
  await racingRead;
  assert.equal(res.ok, true);
  assert.equal(
    h.shared.row,
    undefined,
    'the racing read must not leave a pre-change snapshot in the shared row',
  );
});

test('a shared-cache fault degrades to a live GitHub read, it does not fail the request', async () => {
  const h = harness({ existing: linkedStore() });
  h.deps.getStatusCache = async () => {
    throw new Error('DDB unavailable');
  };
  h.deps.putStatusCache = async () => {
    throw new Error('DDB unavailable');
  };
  const fresh = createHandler(h.deps);
  const res = await fresh({ action: 'status', actor: 'system' });
  assert.equal(res.ok, true);
  assert.equal(res.linkage.app.appId, 424242);
});

test('a status computation overtaken by a mutation does not publish its stale answer', async () => {
  // `statusAction` makes four GitHub round-trips, so a relink/label change can land while it is
  // still running. Publishing unconditionally would overwrite that mutation's invalidation with a
  // PRE-change snapshot and serve it to every container for the full TTL. The generation captured
  // before the computation fences that.
  const h = harness({ existing: linkedStore() });
  h.deps.getAppIdentity = async () => {
    // Simulate a mutation landing mid-computation (this is exactly what clearStatusCache does).
    await h.deps.clearStatusCache();
    return { appId: 424242, name: 'LCA', slug: 'lca-dev', htmlUrl: '', ownerLogin: 'acme', events: [], permissions: {} };
  };
  const fresh = createHandler(h.deps);
  const res = await fresh({ action: 'status', actor: 'system' });
  assert.equal(res.ok, true, 'the caller still gets an answer');
  assert.equal(h.calls.genReads, 1, 'the generation is captured before computing');
  assert.deepEqual(h.calls.cacheWrites, [], 'the stale answer must not reach the shared row');
  assert.equal(h.shared.row, undefined, 'the invalidation stands');
});

test('an uncontended status computation still publishes to the shared row', async () => {
  // The negative control for the fence: with no mutation in flight the generation matches and the
  // answer is published, so the bound on GitHub JWT spend still holds.
  const h = harness({ existing: linkedStore(), sharedGen: 7 });
  const res = await h.handle({ action: 'status', actor: 'system' });
  assert.equal(res.ok, true);
  assert.equal(h.calls.cacheWrites.length, 1);
  assert.ok(h.shared.row, 'the row is populated for other containers');
});
