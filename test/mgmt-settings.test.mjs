// Settings surface tests (spec 04 § Settings, ADR-028).
//
// Three things are load-bearing here and each is asserted against behavior, not prose:
//   1. runner-label validation — a bad label set silently breaks claiming for every repo,
//      and a GitHub-hosted label name is a takeover that must be opted into;
//   2. the label-impact preview — it must agree with Ingest's claim rule exactly, or the
//      preview lies about whose jobs move;
//   3. the redaction guard — no secret-shaped value may leave the API, ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOSTED_LABELS,
  MAX_RUNNER_LABELS,
  RESERVED_LABELS,
  parseRunnerLabels,
  serializeRunnerLabels,
  validateRelinkBody,
  validateRollbackBody,
  validateRunnerLabels,
  validateWebhookTestBody,
} from '../dist/src/mgmt/validate.js';
import {
  buildLabelImpact,
  buildWebhookHealth,
  foldWebhookState,
  hostedLabelsIn,
  scopeSettingsView,
} from '../dist/src/mgmt/views.js';
import { canAdminPlatform, parsePlatformAdmins } from '../dist/src/mgmt/session.js';
import {
  assertNoSecrets,
  containsSecretShape,
  scrubForOperator,
  redactLiterals,
} from '../dist/src/shared/redact.js';
import {
  parseAppcfgRequest,
  validateAppCredentials,
  validateVersionSnapshot,
} from '../dist/src/appcfg/broker-core.js';
import { shouldClaim } from '../dist/src/ingest/filter.js';

// ---- runner labels ---------------------------------------------------------

test('runner labels are normalized to lower case and de-duped', () => {
  const res = validateRunnerLabels({ labels: ['LCA-Base', 'lca-base', ' lca-docker '] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.labels, ['lca-base', 'lca-docker']);
});

test('an empty label list is rejected — it would silently claim nothing', () => {
  const res = validateRunnerLabels({ labels: [] });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /must not be empty/);
});

test('GitHub-reserved labels are rejected with no opt-in escape hatch', () => {
  for (const label of RESERVED_LABELS) {
    const res = validateRunnerLabels({ labels: [label], allowHostedLabels: true });
    assert.equal(res.ok, false, `${label} should be rejected`);
    assert.match(res.errors.join(' '), /reserved by GitHub/);
  }
});

test('GitHub-hosted label names need an explicit opt-in (adopt-mode takeover)', () => {
  for (const label of HOSTED_LABELS.slice(0, 4)) {
    const denied = validateRunnerLabels({ labels: [label] });
    assert.equal(denied.ok, false, `${label} should require opt-in`);
    assert.match(denied.errors.join(' '), /allowHostedLabels=true/);

    const allowed = validateRunnerLabels({ labels: [label], allowHostedLabels: true });
    assert.equal(allowed.ok, true, `${label} should be accepted with opt-in`);
  }
});

test('labels with commas or whitespace are rejected (they would split in SSM)', () => {
  for (const bad of ['a,b', 'has space']) {
    const res = validateRunnerLabels({ labels: [bad] });
    assert.equal(res.ok, false, `${bad} should be rejected`);
  }
});

test('unknown fields and over-long label sets are rejected', () => {
  assert.equal(validateRunnerLabels({ labels: ['lca-base'], nope: 1 }).ok, false);
  const many = Array.from({ length: MAX_RUNNER_LABELS + 1 }, (_, i) => `lca-${i}`);
  assert.equal(validateRunnerLabels({ labels: many }).ok, false);
});

test('label serialization round-trips through the SSM representation Ingest reads', () => {
  const labels = ['lca-base', 'lca-docker'];
  assert.deepEqual(parseRunnerLabels(serializeRunnerLabels(labels)), labels);
  assert.deepEqual(parseRunnerLabels(' lca-base , lca-docker '), labels);
  assert.deepEqual(parseRunnerLabels(undefined), []);
});

// ---- label impact ----------------------------------------------------------

function analysis(path, jobs) {
  return { path, name: path, parsed: { path, name: path, on: ['push'], jobs } };
}
function job(id, runsOn) {
  return { id, name: null, runs_on: runsOn, container: null, services: [], uses: null, matrix_dims: {}, step_signals: {} };
}

test('label impact reports which jobs stop and start being claimed', () => {
  const repos = [
    {
      repoId: 1,
      repoFullName: 'acme/svc',
      analyses: [
        analysis('ci.yml', [job('build', ['lca-base']), job('test', ['ubuntu-latest'])]),
        analysis('rel.yml', [job('ship', ['lca-docker'])]),
      ],
    },
  ];
  const impact = buildLabelImpact(['lca-base'], ['ubuntu-latest'], repos);
  assert.deepEqual(impact.added, ['ubuntu-latest']);
  assert.deepEqual(impact.removed, ['lca-base']);
  assert.deepEqual(
    impact.losing.map((j) => j.jobId),
    ['build'],
  );
  assert.deepEqual(
    impact.gaining.map((j) => j.jobId),
    ['test'],
  );
});

test('label impact matching agrees with Ingest shouldClaim (case-insensitive)', () => {
  const runsOn = ['LCA-Base'];
  const repos = [{ repoId: 1, repoFullName: 'a/b', analyses: [analysis('ci.yml', [job('j', runsOn)])] }];
  // Ingest's view: claimed under lca-base, not under lca-docker.
  const evt = { action: 'queued', workflow_job: { labels: runsOn } };
  assert.equal(shouldClaim(evt, ['lca-base']), true);
  assert.equal(shouldClaim(evt, ['lca-docker']), false);
  // The preview must reach the same conclusion — otherwise it lies to the operator.
  const impact = buildLabelImpact(['lca-base'], ['lca-docker'], repos);
  assert.deepEqual(
    impact.losing.map((j) => j.jobId),
    ['j'],
  );
  assert.equal(impact.gaining.length, 0);
});

test('unchanged jobs appear in neither impact list', () => {
  const repos = [
    { repoId: 1, repoFullName: 'a/b', analyses: [analysis('ci.yml', [job('j', ['lca-base'])])] },
  ];
  const impact = buildLabelImpact(['lca-base'], ['lca-base', 'lca-docker'], repos);
  assert.equal(impact.losing.length, 0);
  assert.equal(impact.gaining.length, 0);
  assert.deepEqual(impact.added, ['lca-docker']);
});

test('hostedLabelsIn flags claimed GitHub-hosted names', () => {
  assert.deepEqual(hostedLabelsIn(['lca-base', 'Ubuntu-Latest'], HOSTED_LABELS), ['Ubuntu-Latest']);
});

// ---- webhook health --------------------------------------------------------

test('webhook health is unknown without evidence — presence alone is not green', () => {
  const h = buildWebhookHealth({ secretConfigured: true });
  assert.equal(h.state, 'unknown');
  assert.equal(h.urlMismatch, false);
});

test('an accepted delivery makes webhook health healthy', () => {
  const h = buildWebhookHealth({
    heartbeat: { lastAt: '2026-07-29T00:00:00.000Z', lastEvent: 'workflow_job' },
  });
  assert.equal(h.state, 'healthy');
  assert.equal(h.lastReceivedEvent, 'workflow_job');
});

test('a URL mismatch is degraded even when deliveries are landing', () => {
  const h = buildWebhookHealth({
    configuredUrl: 'https://old.example.com/webhook',
    deployedUrl: 'https://new.example.com/webhook',
    heartbeat: { lastAt: '2026-07-29T00:00:00.000Z', lastEvent: 'push' },
  });
  assert.equal(h.urlMismatch, true);
  assert.equal(h.state, 'degraded');
});

test('trailing slashes and case do not count as a URL mismatch', () => {
  const h = buildWebhookHealth({
    configuredUrl: 'https://API.example.com/webhook/',
    deployedUrl: 'https://api.example.com/webhook',
  });
  assert.equal(h.urlMismatch, false);
});

test('a signature rejection newer than the last accepted delivery is degraded', () => {
  const h = buildWebhookHealth({
    heartbeat: {
      lastAt: '2026-07-29T00:00:00.000Z',
      lastEvent: 'push',
      lastRejectedAt: '2026-07-29T01:00:00.000Z',
      rejections: 3,
    },
  });
  assert.equal(h.state, 'degraded');
});

test('an older rejection does not mask a currently-working webhook', () => {
  const h = buildWebhookHealth({
    heartbeat: {
      lastAt: '2026-07-29T02:00:00.000Z',
      lastEvent: 'push',
      lastRejectedAt: '2026-07-29T01:00:00.000Z',
      rejections: 1,
    },
  });
  assert.equal(h.state, 'healthy');
});

test("GitHub's own successful delivery counts as evidence when we have no heartbeat", () => {
  const h = buildWebhookHealth({
    recentDeliveries: [
      { id: 1, event: 'push', action: null, status: 'OK', statusCode: 202, deliveredAt: '2026-07-29T00:00:00.000Z', durationMs: 10, redelivery: false },
    ],
  });
  assert.equal(h.state, 'healthy');
  assert.equal(h.recentFailures, 0);
});

test('failed deliveries with no heartbeat are degraded and counted', () => {
  const h = buildWebhookHealth({
    recentDeliveries: [
      { id: 1, event: 'push', action: null, status: 'Err', statusCode: 502, deliveredAt: '2026-07-29T00:00:00.000Z', durationMs: 10, redelivery: false },
    ],
  });
  assert.equal(h.recentFailures, 1);
  assert.equal(h.state, 'degraded');
});

test('a delivery failure NEWER than the last accepted one degrades a stale-healthy webhook', () => {
  const h = buildWebhookHealth({
    heartbeat: { lastAt: '2026-07-29T00:00:00.000Z', lastEvent: 'push' },
    recentDeliveries: [
      { id: 2, event: 'push', action: null, status: 'Err', statusCode: 502, deliveredAt: '2026-07-29T01:00:00.000Z', durationMs: 5, redelivery: false },
    ],
  });
  assert.equal(h.state, 'degraded');
});

test('a delivery failure OLDER than the last accepted one is history, not a contradiction', () => {
  const h = buildWebhookHealth({
    heartbeat: { lastAt: '2026-07-29T02:00:00.000Z', lastEvent: 'push' },
    recentDeliveries: [
      { id: 2, event: 'push', action: null, status: 'Err', statusCode: 502, deliveredAt: '2026-07-29T01:00:00.000Z', durationMs: 5, redelivery: false },
    ],
  });
  assert.equal(h.state, 'healthy');
});

test('an unparseable delivery timestamp fails toward degraded, not green', () => {
  const state = foldWebhookState({
    urlMismatch: false,
    recentFailures: 1,
    lastReceivedAt: '2026-07-29T00:00:00.000Z',
    recentDeliveries: [
      { id: 1, event: 'push', action: null, status: 'Err', statusCode: 500, deliveredAt: 'nonsense', durationMs: 1, redelivery: false },
    ],
  });
  assert.equal(state, 'degraded');
});

test('insecure_ssl at GitHub is degraded regardless of delivery success', () => {
  const state = foldWebhookState({
    insecureSsl: true,
    urlMismatch: false,
    recentFailures: 0,
    recentDeliveries: [],
    lastReceivedAt: '2026-07-29T00:00:00.000Z',
  });
  assert.equal(state, 'degraded');
});

// ---- platform-admin gate ---------------------------------------------------

test('platform admin gate fails CLOSED when the allow-list is unset', () => {
  const session = { login: 'alice', installations: [{ installationId: 1, accountLogin: 'acme' }] };
  assert.equal(canAdminPlatform(session, parsePlatformAdmins(undefined)), false);
  assert.equal(canAdminPlatform(session, parsePlatformAdmins('')), false);
});

test('platform admin gate matches logins case-insensitively', () => {
  const session = { login: 'Alice', installations: [] };
  assert.equal(canAdminPlatform(session, parsePlatformAdmins('bob, alice')), true);
  assert.equal(canAdminPlatform(session, parsePlatformAdmins('bob,carol')), false);
});

test('installation admin rights alone do not grant platform authority', () => {
  const session = { login: 'mallory', installations: [{ installationId: 7, accountLogin: 'x' }] };
  assert.equal(canAdminPlatform(session, ['alice']), false);
});

// ---- redaction guard -------------------------------------------------------

const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';

test('secret-shaped content is detected in nested payloads', () => {
  assert.equal(containsSecretShape({ a: { b: FAKE_PEM } }), true);
  assert.equal(containsSecretShape({ err: 'token ghp_' + 'a'.repeat(20) }), true);
  assert.equal(containsSecretShape({ err: 'v1.' + 'a'.repeat(40) }), true);
  assert.equal(containsSecretShape({ microvmId: 'mvm-0123456789abcdef' }), false);
});

test('assertNoSecrets throws rather than returning tainted content', () => {
  assert.throws(() => assertNoSecrets({ detail: FAKE_PEM }, 'test'), /secret-shaped/);
  assert.doesNotThrow(() => assertNoSecrets({ appId: 12345, slug: 'lca-dev' }, 'test'));
});

test('scrubForOperator redacts secrets, flattens newlines and bounds length', () => {
  const out = scrubForOperator(`failed:\n${FAKE_PEM}`);
  assert.equal(out.includes('PRIVATE KEY'), false);
  assert.ok(out.includes('[redacted]'));
  assert.equal(out.includes('\n'), false);
  assert.ok(scrubForOperator('x'.repeat(1000)).length <= 301);
});

test('redactLiterals masks opaque secrets the shape guard cannot recognize', () => {
  // A webhook secret and an OAuth client secret are unstructured high-entropy strings: no
  // pattern can identify them, so the only defense on the relink path is literal redaction
  // against the values we were just handed.
  const secret = 'w'.repeat(24);
  const out = redactLiterals(`GitHub rejected "${secret}" as invalid`, [secret]);
  assert.equal(out.includes(secret), false);
  assert.ok(out.includes('[redacted]'));
  // Escaped-in-JSON occurrences are covered too (GitHub echoes values inside JSON bodies).
  const quoted = 'ab"cd' + 'e'.repeat(20);
  assert.equal(
    redactLiterals(JSON.stringify({ message: quoted }), [quoted]).includes('cd'),
    false,
  );
  // Short values are skipped: masking them would corrupt unrelated text.
  assert.equal(redactLiterals('the id is 42', ['42']), 'the id is 42');
  assert.equal(redactLiterals('untouched', [undefined]), 'untouched');
});

// ---- relink intake ---------------------------------------------------------

const GOOD_CREDS = {
  appId: '123456',
  pem: FAKE_PEM,
  webhookSecret: 'w'.repeat(24),
  clientId: 'Iv1.abcdef1234567890',
  clientSecret: 'c'.repeat(40),
};

test('relink body requires every credential field and rejects extras', () => {
  assert.equal(validateRelinkBody(GOOD_CREDS).ok, true);
  assert.equal(validateRelinkBody({ ...GOOD_CREDS, extra: 'x' }).ok, false);
  const { pem, ...missing } = GOOD_CREDS;
  assert.equal(validateRelinkBody(missing).ok, false);
});

test('broker credential validation checks PEM shape and secret lengths', () => {
  assert.equal(validateAppCredentials(GOOD_CREDS).ok, true);
  assert.equal(validateAppCredentials({ ...GOOD_CREDS, pem: 'not-a-pem' }).ok, false);
  assert.equal(validateAppCredentials({ ...GOOD_CREDS, appId: 'abc' }).ok, false);
  assert.equal(validateAppCredentials({ ...GOOD_CREDS, webhookSecret: 'short' }).ok, false);
  assert.equal(validateAppCredentials({ ...GOOD_CREDS, clientSecret: 'short' }).ok, false);
});

test('credential validation errors never quote a submitted secret value', () => {
  const res = validateAppCredentials({ ...GOOD_CREDS, pem: `${FAKE_PEM}corrupt`, appId: 'nope' });
  assert.equal(res.ok, false);
  const joined = res.errors.join(' ');
  assert.equal(joined.includes('PRIVATE KEY'), false);
  assert.equal(joined.includes(GOOD_CREDS.clientSecret), false);
  assert.equal(joined.includes(GOOD_CREDS.webhookSecret), false);
});

test('rollback snapshots accept known parameters with positive versions only', () => {
  assert.equal(validateVersionSnapshot({ 'github/app-pem': 3 }).ok, true);
  assert.equal(validateVersionSnapshot({ 'github/app-pem': 0 }).ok, false);
  assert.equal(validateVersionSnapshot({ 'mgmt/session-secret': 1 }).ok, false);
  assert.equal(validateVersionSnapshot({}).ok, false);
  assert.equal(validateRollbackBody({ restore: { 'github/app-id': 2 } }).ok, true);
  assert.equal(validateRollbackBody({ restore: {} }).ok, false);
});

test('webhook test body accepts nothing or a positive delivery id', () => {
  assert.equal(validateWebhookTestBody({}).ok, true);
  assert.equal(validateWebhookTestBody({ deliveryId: 42 }).ok, true);
  assert.equal(validateWebhookTestBody({ deliveryId: -1 }).ok, false);
  assert.equal(validateWebhookTestBody({ nope: 1 }).ok, false);
});

// ---- broker request contract ----------------------------------------------

test('broker rejects unknown actions and missing actors', () => {
  assert.throws(() => parseAppcfgRequest({ action: 'exfiltrate', actor: 'alice' }), /unsupported action/);
  assert.throws(() => parseAppcfgRequest({ action: 'status' }), /actor required/);
});

test('broker relink requires structurally valid credentials', () => {
  assert.throws(
    () => parseAppcfgRequest({ action: 'relink', actor: 'alice', credentials: { appId: 'x' } }),
    /pem|appId/,
  );
  const ok = parseAppcfgRequest({ action: 'relink', actor: 'alice', credentials: GOOD_CREDS });
  assert.equal(ok.credentials.appId, '123456');
});

test('broker setRunnerLabels re-validates the serialized value it is asked to write', () => {
  const ok = parseAppcfgRequest({ action: 'setRunnerLabels', actor: 'alice', labels: 'lca-base,lca-docker' });
  assert.equal(ok.labels, 'lca-base,lca-docker');
  for (const bad of ['', 'UPPER', 'has space', 'trailing,']) {
    assert.throws(
      () => parseAppcfgRequest({ action: 'setRunnerLabels', actor: 'alice', labels: bad }),
      /labels/,
      `"${bad}" should be rejected`,
    );
  }
});

test('broker redeliver accepts an optional positive delivery id', () => {
  assert.equal(parseAppcfgRequest({ action: 'redeliver', actor: 'a' }).deliveryId, undefined);
  assert.equal(parseAppcfgRequest({ action: 'redeliver', actor: 'a', deliveryId: 9 }).deliveryId, 9);
  assert.throws(() => parseAppcfgRequest({ action: 'redeliver', actor: 'a', deliveryId: 0 }), /positive/);
});

// ---- cross-tenant scoping of the settings payload (ADR-029) ----------------

const SETTINGS_FIXTURE = {
  envName: 'dev',
  region: 'ap-southeast-2',
  app: { appId: 1, name: 'LCA', slug: 'lca', htmlUrl: '', ownerLogin: 'acme', events: [], permissions: {} },
  installations: [
    { installationId: 11, accountLogin: 'acme', suspended: false, known: true },
    { installationId: 22, accountLogin: 'rival-corp', suspended: false, known: true },
  ],
  runnerLabels: { labels: ['lca-base'], unset: false, hostedLabels: [] },
  webhook: buildWebhookHealth({}),
  flavors: [],
  recentChanges: [{ at: '2026-07-29T00:00:00.000Z', actor: 'alice', action: 'runner-labels-change' }],
  diagnostics: { secrets: [] },
};

test('a non-admin session only sees installations it administers', () => {
  // Any GitHub user can complete the OAuth dance (a zero-grant session is minted on purpose so
  // Setup is reachable), so an unscoped list would let a stranger enumerate every org that
  // installed the App.
  const scoped = scopeSettingsView(SETTINGS_FIXTURE, {
    isPlatformAdmin: false,
    canSeeInstallation: (id) => id === 11,
  });
  assert.deepEqual(
    scoped.installations.map((i) => i.installationId),
    [11],
  );
});

test('a zero-grant session sees no installations and no audit trail', () => {
  const scoped = scopeSettingsView(SETTINGS_FIXTURE, {
    isPlatformAdmin: false,
    canSeeInstallation: () => false,
  });
  assert.deepEqual(scoped.installations, []);
  assert.deepEqual(scoped.recentChanges, [], 'the operator audit trail is admin-only');
});

test('environment-level facts stay visible to every session', () => {
  // Spec 04: Settings stays readable so a fresh environment can show its own state.
  const scoped = scopeSettingsView(SETTINGS_FIXTURE, {
    isPlatformAdmin: false,
    canSeeInstallation: () => false,
  });
  assert.deepEqual(scoped.app, SETTINGS_FIXTURE.app);
  assert.deepEqual(scoped.runnerLabels, SETTINGS_FIXTURE.runnerLabels);
  assert.equal(scoped.webhook.state, SETTINGS_FIXTURE.webhook.state);
  assert.equal(scoped.envName, 'dev');
});

test('a platform admin sees the full installation list and audit trail', () => {
  const scoped = scopeSettingsView(SETTINGS_FIXTURE, {
    isPlatformAdmin: true,
    canSeeInstallation: () => false,
  });
  assert.equal(scoped.installations.length, 2);
  assert.equal(scoped.recentChanges.length, 1);
});
