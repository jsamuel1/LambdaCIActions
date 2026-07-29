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

/**
 * Line indices (0-based) inside DECISIONS.md that belong to an explicit **ADR numbering
 * note** blockquote — the one place that deliberately discusses numbers owned by OTHER
 * branches (the renumbering rationale), which are not defined here by definition.
 *
 * Scoped to that note rather than "any blockquote in DECISIONS.md": blockquoted
 * `**Amended by [ADR-0NN](#adr-0nn)**` cross-references are an existing convention in this
 * file, and a blanket blockquote skip would silently exempt them from the check — disarming
 * the guard exactly where ADR cross-references are densest.
 */
function numberingNoteLines(text) {
  const lines = text.split('\n');
  const exempt = new Set();
  let inNote = false;
  lines.forEach((line, i) => {
    const isQuote = /^\s*>/.test(line);
    if (!isQuote) {
      inNote = false;
      return;
    }
    if (/ADR numbering note/i.test(line)) inNote = true;
    if (inNote) exempt.add(i);
  });
  return exempt;
}

test('every ADR-NNN citation in the repo resolves to a real ADR', () => {
  const defined = new Set(definedAdrs());
  const decisionsRel = path.join('docs', 'DECISIONS.md');
  const stale = [];
  for (const file of walk(REPO_ROOT)) {
    const rel = path.relative(REPO_ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const exempt = rel === decisionsRel ? numberingNoteLines(text) : new Set();
    lines.forEach((line, i) => {
      if (exempt.has(i)) return;
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

test('the numbering-note exemption does not extend to other blockquotes', () => {
  // The exemption is a deliberate hole; prove it is the SHAPE of hole intended. A blockquoted
  // amendment cross-reference elsewhere in the file must still be checked, or a renumbering
  // sweep could leave a stale citation in the densest cross-reference region of the repo.
  //
  // The fixture builds its citations at runtime: this test file is itself scanned by the
  // guard above, so a literal `ADR-<undefined-number>` here would (correctly) fail it.
  const cite = (n) => `ADR-${n}`;
  const text = [
    `## ${cite('001')} — thing`,
    `> **ADR numbering note.** vacating ${cite('999')} claimed by another branch.`,
    `> still the same note, mentioning ${cite('998')}.`,
    '',
    `> **Amended by ${cite('997')}** — an ordinary blockquoted cross-reference.`,
  ].join('\n');
  const exempt = numberingNoteLines(text);
  assert.ok(exempt.has(1), 'the numbering-note line itself is exempt');
  assert.ok(exempt.has(2), 'continuation lines of the same note are exempt');
  assert.ok(!exempt.has(4), 'an unrelated blockquote must NOT be exempt');
  assert.ok(!exempt.has(0), 'headings are never exempt');
});
