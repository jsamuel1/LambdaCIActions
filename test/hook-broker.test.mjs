// Unit tests for the hook broker's pure authorization logic (ADR-021). These pin the
// property that matters for the exec-role tightening: a microVM can only ever address its
// OWN run partition, because the key is derived from the capability-token-bound ref.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashHookToken,
  hookTokenMatches,
  keysFromRef,
  parseHookRequest,
  isRunRef,
  safeForLog,
} from '../dist/src/hook/broker-core.js';
import { runPk, RUN_SK, JITCONFIG_SK, jitConfigRef } from '../dist/src/shared/run-store.js';

const TOKEN = 'a'.repeat(43); // base64url of 32 random bytes is 43 chars

test('token hash is stable and compares only against itself', () => {
  const h = hashHookToken(TOKEN);
  assert.equal(h, hashHookToken(TOKEN));
  assert.ok(hookTokenMatches(TOKEN, h));
  assert.equal(hookTokenMatches('b'.repeat(43), h), false);
});

test('a missing or malformed stored hash never authorizes', () => {
  assert.equal(hookTokenMatches(TOKEN, undefined), false);
  assert.equal(hookTokenMatches(TOKEN, ''), false);
  assert.equal(hookTokenMatches(TOKEN, 'deadbeef'), false); // wrong length
});

test('keysFromRef derives exactly the run + jitconfig items of that ref', () => {
  const ref = jitConfigRef(99, 7, 42);
  assert.deepEqual(keysFromRef(ref), {
    pk: runPk(99, 7, 42),
    jitSk: JITCONFIG_SK,
    runSk: RUN_SK,
  });
});

test('parseHookRequest accepts only known actions on well-formed refs', () => {
  const ref = jitConfigRef(1, 2, 3);
  assert.deepEqual(parseHookRequest({ action: 'jitconfig', ref, token: TOKEN }), {
    action: 'jitconfig',
    ref,
    token: TOKEN,
  });
  assert.equal(parseHookRequest({ action: 'terminate', ref, token: TOKEN }).action, 'terminate');

  // Unknown / absent action.
  assert.throws(() => parseHookRequest({ action: 'scan', ref, token: TOKEN }), /unsupported action/);
  assert.throws(() => parseHookRequest({ ref, token: TOKEN }), /unsupported action/);
  // A VM must not be able to steer the broker at another entity or a wildcard.
  for (const bad of [
    'INSTALL#1#INSTALL',
    'RUN#1#2#3#RUN',
    'RUN#1#2#3',
    'RUN#1#2#3#JITCONFIG#extra',
    'RUN#a#b#c#JITCONFIG',
    '*',
  ]) {
    assert.throws(
      () => parseHookRequest({ action: 'terminate', ref: bad, token: TOKEN }),
      /malformed ref/,
      `expected ${bad} to be rejected`,
    );
  }
  // No token, or a token too short to be the minted 32-byte value.
  assert.throws(() => parseHookRequest({ action: 'terminate', ref }), /missing token/);
  assert.throws(() => parseHookRequest({ action: 'terminate', ref, token: 'short' }), /missing token/);
});

test('isRunRef matches the ref shape the run store emits', () => {
  assert.ok(isRunRef(jitConfigRef(1234567, 890, 1)));
  assert.equal(isRunRef(`${runPk(1, 2, 3)}#${RUN_SK}`), false);
});

// The rejection message is logged by the broker λ, and its input comes from untrusted
// workflow code. An unbounded echo would let a VM write arbitrary content — including
// forged JSON log records — into the control plane's log group.
test('a rejected action is not echoed verbatim into the broker log', () => {
  const ref = jitConfigRef(1, 2, 3);
  const nasty = `x\n{"msg":"self-terminate brokered","pk":"RUN#9#9#9"}\n${'A'.repeat(5000)}`;
  assert.throws(
    () => parseHookRequest({ action: nasty, ref, token: TOKEN }),
    (err) => {
      assert.doesNotMatch(err.message, /\n/, 'no newline → no forged log record');
      assert.ok(err.message.length < 120, `message too long: ${err.message.length}`);
      return true;
    },
  );
  // Non-string actions must not stringify into the message either.
  assert.throws(
    () => parseHookRequest({ action: { toString: () => 'x'.repeat(500) }, ref, token: TOKEN }),
    /unsupported action: object/,
  );
});

test('safeForLog caps length and drops control characters', () => {
  assert.equal(safeForLog('jitconfig'), 'jitconfig');
  assert.equal(safeForLog('a\nb\tc'), 'a.b.c');
  assert.equal(safeForLog('y'.repeat(100)).length, 41); // 40 + ellipsis
  assert.equal(safeForLog(undefined), 'undefined');
  assert.equal(safeForLog(42), 'number');
});
