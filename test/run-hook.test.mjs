// Contract tests: the microVM run-hook's self-terminate readback (ADR-018) must derive
// the SAME run-row key the control plane writes. Pins run-hook.mjs's runRowKeyFromRef
// against the run store's jitConfigRef/runPk so the two sides can't drift silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRowKeyFromRef } from '../microvm/bootstrap/run-hook.mjs';
import { runPk, RUN_SK, jitConfigRef } from '../dist/src/shared/run-store.js';

test('runRowKeyFromRef inverts jitConfigRef back to the run row key', () => {
  const ref = jitConfigRef(99, 7, 42); // what Provision embeds in the run-hook payload
  const key = runRowKeyFromRef(ref);
  assert.deepEqual(key, { pk: runPk(99, 7, 42), sk: RUN_SK });
});

test('runRowKeyFromRef matches the documented ref shape literally', () => {
  assert.deepEqual(runRowKeyFromRef('RUN#1#2#3#JITCONFIG'), { pk: 'RUN#1#2#3', sk: 'RUN' });
});

test('importing run-hook.mjs does not bind the port', () => {
  // The import above already succeeded — if the module called listen() on import, the
  // test runner would hang / EADDRINUSE on repeat runs. Assert the server exists but is
  // not listening.
  return import('../microvm/bootstrap/run-hook.mjs').then((m) => {
    assert.equal(m.server.listening, false);
  });
});
