// Behavioural tests for the App-config broker's write path (ADR-028). The pure request
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
function harness({ existing = {}, failOn, identityAppId = 424242, hookFails = false } = {}) {
  const store = new Map(Object.entries(existing)); // name → { value, version }
  const calls = { puts: [], deletes: [], audits: [], hookUpdates: [], identities: [] };

  const deps = {
    getParam: async (name) => {
      const hit = store.get(name);
      if (!hit) throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
      return hit.value;
    },
    paramVersion: async (name) => store.get(name)?.version,
    getParamVersion: async (name, version) => {
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
      if (hookFails) throw new Error('403 app does not own its hook config');
    },
    listAppHookDeliveries: async () => [
      { id: 77, event: 'push', action: null, status: 'OK', statusCode: 202, deliveredAt: 'now', durationMs: 5, redelivery: false },
    ],
    redeliverAppHook: async () => {},
  };
  return { deps, store, calls, handle: createHandler(deps) };
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
});

test('a hook-config failure is reported but does not fail an otherwise-verified relink', async () => {
  const h = harness({ existing: linkedStore(), hookFails: true });
  const res = await h.handle({ action: 'relink', actor: 'alice', credentials: CREDS });
  assert.equal(res.ok, true);
  assert.equal(res.hookSynced, false);
  assert.match(res.hookError, /hook config/);
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

test('a hook-config failure does NOT trigger a rollback (credentials verified)', async () => {
  const h = harness({ existing: linkedStore(), hookFails: true });
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
