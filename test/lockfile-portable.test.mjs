// Every `resolved` URL in package-lock.json must point at the public npm registry over
// HTTPS. CI (and AGENTS.md) runs `npm ci`, which fetches exactly the URL the lockfile
// records; a URL pointing at an author's local npm proxy (a loopback address, a private
// mirror) installs fine on the machine that wrote it and fails everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/';

test('package-lock.json resolves every package from the public npm registry', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const offenders = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry || typeof entry.resolved !== 'string') continue;
    if (entry.link) continue;
    if (!entry.resolved.startsWith(REGISTRY)) offenders.push(`${key || '<root>'}: ${entry.resolved}`);
  }
  assert.deepEqual(offenders, [], `non-portable resolved URLs:\n${offenders.join('\n')}`);
});
