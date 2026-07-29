// Every `ADR-NNN` reference in the repo must point at an ADR that actually exists in
// docs/DECISIONS.md, and no number may be defined twice.
//
// Why this test exists: ADR numbers are a SHARED MUTABLE NAMESPACE across concurrent
// branches, so a milestone's ADR block sometimes has to be renumbered before it lands (see
// the numbering note in DECISIONS.md). When that happens, the code/spec comments that cite
// those ADRs are the easy thing to miss — and a stale citation is invisible: it points at a
// real-looking ADR that either does not exist or, worse, belongs to an unrelated subject on
// another branch. Nothing enforced this before; nine Dockerfile comments survived a
// renumbering pointing at the vacated range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECISIONS = path.join(REPO_ROOT, 'docs', 'DECISIONS.md');

/** Directories that are generated, vendored or scratch — never a source of truth. */
const SKIP_DIRS = new Set([
  '.git',
  '.agents',
  '.kermes-worktrees',
  'node_modules',
  'dist',
  'cdk.out',
  'coverage',
]);

/** Files we scan for citations. Dockerfiles have no extension, so match by prefix too. */
const SCAN_EXT = new Set(['.md', '.ts', '.tsx', '.mjs', '.js', '.json', '.sh', '.yml', '.yaml']);
const isScannable = (name) => SCAN_EXT.has(path.extname(name)) || name.startsWith('Dockerfile');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && isScannable(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** ADR numbers with an `## ADR-NNN` heading in DECISIONS.md. */
function definedAdrs() {
  const text = fs.readFileSync(DECISIONS, 'utf8');
  return [...text.matchAll(/^## ADR-(\d{3})\b/gm)].map((m) => m[1]);
}

test('every ADR heading number is defined exactly once', () => {
  const nums = definedAdrs();
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate ADR headings in DECISIONS.md: ${[...new Set(dupes)]}`);
  assert.ok(nums.length > 0, 'no ADR headings found — has DECISIONS.md moved?');
});

test('every ADR-NNN citation in the repo resolves to a real ADR', () => {
  const defined = new Set(definedAdrs());
  const stale = [];
  for (const file of walk(REPO_ROOT)) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // DECISIONS.md's own blockquote notes deliberately discuss numbers held by OTHER
      // branches (the renumbering rationale), which are not defined here by definition.
      if (rel === path.join('docs', 'DECISIONS.md') && /^\s*>/.test(line)) return;
      for (const m of line.matchAll(/ADR-(\d{3})/g)) {
        if (!defined.has(m[1])) stale.push(`${rel}:${i + 1}: ADR-${m[1]} — ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    stale,
    [],
    `citations point at ADRs that do not exist in docs/DECISIONS.md ` +
      `(renumbered or typo'd):\n  ${stale.join('\n  ')}`,
  );
});
