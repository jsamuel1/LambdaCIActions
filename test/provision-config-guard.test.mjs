// Provision's config guard ordering (ADR-020). `HOOK_BROKER_NAME` is required to build the
// run-hook payload; without it every launched VM 400s its own /run. The guard therefore has
// to fire BEFORE the single-use GitHub JIT config is minted — otherwise a misconfigured
// deploy burns one registration credential per SQS delivery on VMs that can never start,
// and only DLQs after maxReceiveCount. Ordering is the whole property, so pin it on the
// source (the handler reaches AWS through module imports, not injectable deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'provision',
  'handler.ts',
);
const src = fs.readFileSync(SRC, 'utf8');

test('the broker-name guard runs before the JIT config is minted', () => {
  const guard = src.indexOf("if (!brokerName) throw new Error('HOOK_BROKER_NAME");
  const mint = src.indexOf('await generateJitConfig(');
  const stash = src.indexOf('await putJitConfig(');
  const launch = src.indexOf('await launchMicroVM(');

  assert.ok(guard > 0, 'HOOK_BROKER_NAME guard not found');
  assert.ok(mint > 0 && stash > 0 && launch > 0, 'provision steps not found');
  assert.ok(guard < mint, 'guard must precede generateJitConfig (single-use credential)');
  assert.ok(guard < stash, 'guard must precede putJitConfig');
  assert.ok(guard < launch, 'guard must precede launchMicroVM');
});

test('the payload broker name comes from the guarded value, not a bare env read', () => {
  // `broker: process.env.HOOK_BROKER_NAME ?? ''` would defeat the guard by re-reading (and
  // silently defaulting) the value the payload actually ships.
  assert.match(src, /broker: brokerName,/);
  const envReads = src.match(/process\.env\.HOOK_BROKER_NAME/g) ?? [];
  assert.equal(envReads.length, 1, 'HOOK_BROKER_NAME should be read exactly once');
});

// ADR-020: the two brokered actions authorize against different items, so the SAME hash has
// to reach both — the JIT config item (jitconfig, TTL'd) and the run row (terminate, durable).
// Mint once, hash once, write the hash twice, and hand the PLAINTEXT only to the VM payload.
test('one token is minted per run and its hash is written to both items', () => {
  const mint = src.match(/const hookToken = randomBytes\(32\)\.toString\('base64url'\);/g) ?? [];
  assert.equal(mint.length, 1, 'exactly one token mint per provisioned run');
  const hashes = src.match(/hashHookToken\(/g) ?? [];
  assert.equal(hashes.length, 1, 'hash the token once, reuse the value');

  const stash = src.indexOf('await putJitConfig(');
  const stamp = src.indexOf('await stampMicrovmId({');
  const stashArgs = src.slice(stash, src.indexOf('});', stash));
  const stampArgs = src.slice(stamp, src.indexOf('})', stamp));
  assert.match(stashArgs, /hookTokenHash,/, 'JIT config item must carry the hash (jitconfig)');
  assert.match(stampArgs, /hookTokenHash,/, 'run row must mirror the hash (terminate)');
});

test('the plaintext token is never persisted, only shipped in the launch payload', () => {
  const plaintextUses = src.match(/\bhookToken\b(?!Hash)/g) ?? [];
  // mint + hash input + payload field = 3; anything more risks a write to the store.
  assert.equal(plaintextUses.length, 3, `unexpected hookToken uses: ${plaintextUses.length}`);
  assert.match(src, /token: hookToken,/);
  const stash = src.indexOf('await putJitConfig(');
  assert.doesNotMatch(
    src.slice(stash, src.indexOf('});', stash)),
    /\bhookToken\b(?!Hash)/,
    'the plaintext token must never be stored on the JIT config item',
  );
});
