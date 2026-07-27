// Behavioural tests for the hook broker handler's authorization wiring (ADR-020). The pure
// token/key helpers are covered in hook-broker.test.mjs; this pins the decisions the λ makes
// with them: which item authorizes which action, that a VM can only ever touch its own run
// partition, and that "no such run" and "wrong token" are indistinguishable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../dist/src/hook/handler.js';
import { hashHookToken } from '../dist/src/hook/broker-core.js';
import { jitConfigRef, runPk, RUN_SK } from '../dist/src/shared/run-store.js';

const TOKEN = 'a'.repeat(43);
const OTHER_TOKEN = 'b'.repeat(43);
const REF = jitConfigRef(9, 100, 200);
const PK = runPk(9, 100, 200);

function deps({ jit, row } = {}) {
  const calls = { jitRefs: [], runKeys: [], terminated: [] };
  return {
    calls,
    impl: {
      getJitConfigByRef: async (ref) => {
        calls.jitRefs.push(ref);
        return jit;
      },
      getRunFieldsByKey: async (pk, sk) => {
        calls.runKeys.push({ pk, sk });
        return row;
      },
      terminate: async (id) => {
        calls.terminated.push(id);
      },
    },
  };
}

const validJit = {
  jitConfig: 'eyJ0b2tlbiI6ICJ4In0=',
  runId: 100,
  jobId: 200,
  repoFullName: 'acme/app',
  labels: ['lca-arm64'],
  hookTokenHash: hashHookToken(TOKEN),
};

test('jitconfig returns the run config for a matching token', async () => {
  const d = deps({ jit: validJit });
  const res = await createHandler(d.impl)({ action: 'jitconfig', ref: REF, token: TOKEN });
  assert.equal(res.ok, true);
  assert.equal(res.jitConfig, validJit.jitConfig);
  assert.equal(res.runId, 100);
  assert.deepEqual(res.labels, ['lca-arm64']);
  // Keyed strictly by the caller's own ref — never by caller-supplied ids.
  assert.deepEqual(d.calls.jitRefs, [REF]);
});

test('jitconfig with a wrong token is unauthorized and leaks no config', async () => {
  const d = deps({ jit: validJit });
  const res = await createHandler(d.impl)({ action: 'jitconfig', ref: REF, token: OTHER_TOKEN });
  assert.deepEqual(res, { ok: false, error: 'unauthorized' });
});

test('an unknown ref is indistinguishable from a bad token', async () => {
  const missing = await createHandler(deps({ jit: undefined }).impl)({
    action: 'jitconfig',
    ref: REF,
    token: TOKEN,
  });
  const badToken = await createHandler(deps({ jit: validJit }).impl)({
    action: 'jitconfig',
    ref: REF,
    token: OTHER_TOKEN,
  });
  assert.deepEqual(missing, badToken);
});

test('terminate authorizes off the DURABLE run row, not the TTL-bounded JIT item', async () => {
  // The JIT config item has a 30-min TTL; a job may run for hours and self-terminate fires at
  // job END. If terminate consulted the JIT item, every long job would lose self-terminate.
  const d = deps({
    jit: undefined, // JIT item already aged out
    row: { microvmId: 'mvm-123', status: 'running', hookTokenHash: hashHookToken(TOKEN) },
  });
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(res, { ok: true, terminated: true });
  assert.deepEqual(d.calls.terminated, ['mvm-123']);
  // Read the caller's own run row only, keyed from the token-bound ref.
  assert.deepEqual(d.calls.runKeys, [{ pk: PK, sk: RUN_SK }]);
  assert.deepEqual(d.calls.jitRefs, []);
});

test('terminate with a wrong token never reaches TerminateMicrovm', async () => {
  const d = deps({
    row: { microvmId: 'mvm-victim', hookTokenHash: hashHookToken(TOKEN) },
  });
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: OTHER_TOKEN });
  assert.deepEqual(res, { ok: false, error: 'unauthorized' });
  assert.deepEqual(d.calls.terminated, []);
});

test('a run row with no token hash defers to a retry, authorized off the live JIT item', async () => {
  // Provision writes microvmId + hookTokenHash in ONE post-launch stamp, so an ultra-fast
  // job can hit terminate before the row has either. A terminal `unauthorized` here would
  // be unrecoverable (the hook does not retry auth failures) and would silently regress
  // ADR-019 self-terminate to Reaper-only reaping.
  const d = deps({ jit: validJit, row: { status: 'running' } });
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(res, { ok: true, terminated: false });
  assert.deepEqual(d.calls.terminated, []);
  assert.deepEqual(d.calls.jitRefs, [REF]);
});

test('a missing run row also defers to a retry when the capability is valid', async () => {
  const d = deps({ jit: validJit, row: undefined });
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(res, { ok: true, terminated: false });
  assert.deepEqual(d.calls.terminated, []);
});

test('an unstamped row with a bad token is still unauthorized', async () => {
  const d = deps({ jit: validJit, row: { status: 'running' } });
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: OTHER_TOKEN });
  assert.deepEqual(res, { ok: false, error: 'unauthorized' });
  assert.deepEqual(d.calls.terminated, []);
});

test('an unstamped row with no live JIT item is unauthorized (post-TTL, unforgeable)', async () => {
  const d = deps({ jit: undefined, row: { status: 'running' } });
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(res, { ok: false, error: 'unauthorized' });
});

test('the retry after the stamp lands terminates exactly once', async () => {
  // Same VM, same token: first call pre-stamp (defer), second call post-stamp (terminate).
  const state = { row: { status: 'running' } };
  const terminated = [];
  const impl = {
    getJitConfigByRef: async () => validJit,
    getRunFieldsByKey: async () => state.row,
    terminate: async (id) => {
      terminated.push(id);
    },
  };
  const handle = createHandler(impl);
  const first = await handle({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(first, { ok: true, terminated: false });
  state.row = { status: 'running', microvmId: 'mvm-123', hookTokenHash: hashHookToken(TOKEN) };
  const second = await handle({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(second, { ok: true, terminated: true });
  assert.deepEqual(terminated, ['mvm-123']);
});

test('an unstamped microvmId defers to the Reaper instead of failing', async () => {
  const d = deps({ row: { status: 'running', hookTokenHash: hashHookToken(TOKEN) } });
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(res, { ok: true, terminated: false });
  assert.deepEqual(d.calls.terminated, []);
});

test('an already-gone VM is success from the caller point of view', async () => {
  const d = deps({ row: { microvmId: 'mvm-gone', hookTokenHash: hashHookToken(TOKEN) } });
  d.impl.terminate = async () => {
    throw new Error('ResourceNotFoundException');
  };
  const res = await createHandler(d.impl)({ action: 'terminate', ref: REF, token: TOKEN });
  assert.deepEqual(res, { ok: true, terminated: false });
});

test('malformed requests are rejected before any store access', async () => {
  for (const bad of [
    { action: 'scan', ref: REF, token: TOKEN },
    { action: 'terminate', ref: `${PK}#${RUN_SK}`, token: TOKEN }, // not a JITCONFIG ref
    { action: 'terminate', ref: '*', token: TOKEN },
    { action: 'terminate', ref: REF, token: 'short' },
    {},
    null,
  ]) {
    const d = deps({ jit: validJit, row: { microvmId: 'mvm-1' } });
    const res = await createHandler(d.impl)(bad);
    assert.deepEqual(res, { ok: false, error: 'bad request' }, `expected reject: ${JSON.stringify(bad)}`);
    assert.deepEqual(d.calls.jitRefs, []);
    assert.deepEqual(d.calls.runKeys, []);
    assert.deepEqual(d.calls.terminated, []);
  }
});
