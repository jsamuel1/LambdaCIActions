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
