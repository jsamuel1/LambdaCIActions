// Sealed, scope-bound pagination cursors (src/shared/cursor.ts, ADR-052).
//
// The leak this pins: every paginated mgmt list authorizes with a POST-QUERY installation
// filter — the run indexes are keyed by status/repo/time, never by installation (ADR-023) —
// and then returned DynamoDB's `LastEvaluatedKey` as `nextCursor`. That key names the last
// row SCANNED, not the last row RETURNED. When the boundary row belonged to an installation
// the session may not administer, its `RUN#<repoId>#<runId>#<jobId>` identifiers rode out in
// the cursor next to a body they had been filtered out of, in plain base64url that any
// authenticated operator could decode. (A `REFUSAL#…` row is the same shape; that list is
// still unlanded — see PR #34 — so only the run keys are exercised here.)
//
// Five invariants:
//   1. a sealed cursor carries no readable identifier, in any encoding a client can apply;
//   2. a cursor is inert outside the scope it was minted for (view / grants / repo / status);
//   3. forged, tampered, and pre-ADR-052 plaintext cursors are REFUSED, not restarted;
//   4. the routes actually seal — no `nextCursor` reaches a body straight off a store page;
//   5. and if one ever did, it would THROW rather than serialize — the invariant that does not
//      depend on a route being written the way the guards expect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import {
  asRawCursor,
  canonicalScope,
  openCursor,
  sealCursor,
  sealCursorOrNull,
} from '../dist/src/shared/cursor.js';
import { encodeCursor } from '../dist/src/shared/run-store.js';

const SECRET = 'session-secret-under-test';

/** The scope of the tenant whose page we are legitimately walking. */
const MINE = { view: 'runs:status', installationIds: [11], status: 'failed' };

/**
 * A real GSI1 boundary key for a row owned by installation 99 — the shape the store hands
 * back when the last row scanned belongs to somebody else.
 *
 * The ids are deliberately GitHub-scale (9–11 digits) rather than toy values. The absence
 * assertions below scan the sealed blob's `hex` and `latin1` renderings, which are
 * effectively random bytes, so a SHORT id would collide there by chance: a 4-digit decimal
 * string has a ~1-in-150 chance of appearing somewhere in ~460 hex characters, which is a
 * flaky test rather than a leak. At 9+ digits the false-positive probability is ~1e-8.
 */
const OTHER_TENANT_KEY = {
  pk: 'RUN#987654321#15432198765#43219876543',
  sk: 'RUN',
  gsi1pk: 'RUNSTATUS#failed',
  gsi1sk: '2026-08-01T00:00:00.000Z#987654321#15432198765#43219876543',
};

/** Every identifier from the other tenant's row that must not escape. */
const SECRETS = [
  '987654321',
  '15432198765',
  '43219876543',
  'RUN#987654321',
  'RUNSTATUS#failed',
];

test('a sealed cursor exposes none of the scanned row identifiers', () => {
  const raw = encodeCursor(OTHER_TENANT_KEY);
  // Precondition: the RAW cursor really does leak — otherwise this test proves nothing.
  const rawDecoded = Buffer.from(raw.raw, 'base64url').toString('utf8');
  for (const s of SECRETS) {
    assert.ok(rawDecoded.includes(s), `raw cursor should contain ${s} (precondition)`);
  }

  const sealed = sealCursor(raw, MINE, SECRET);
  // Every representation a client can reach for: the token itself, its base64url payload
  // decoded as bytes, and as latin1 in case an identifier straddles the JSON encoding.
  const payload = Buffer.from(sealed.slice('c1.'.length), 'base64url');
  const views = [sealed, payload.toString('utf8'), payload.toString('latin1'), payload.toString('hex')];
  for (const s of SECRETS) {
    for (const view of views) {
      assert.ok(!view.includes(s), `sealed cursor must not expose ${s}`);
    }
  }
  // And it is not merely re-encoded JSON.
  assert.throws(() => JSON.parse(payload.toString('utf8')));
});

test('a sealed cursor round-trips under its own scope', () => {
  const raw = encodeCursor(OTHER_TENANT_KEY);
  const opened = openCursor(sealCursor(raw, MINE, SECRET), MINE, SECRET);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.cursor, raw, 'the walk must resume at the same index position');
});

test('sealing is non-deterministic, so a cursor is not a stable row fingerprint', () => {
  const raw = encodeCursor(OTHER_TENANT_KEY);
  const a = sealCursor(raw, MINE, SECRET);
  const b = sealCursor(raw, MINE, SECRET);
  assert.notEqual(a, b, 'a fresh GCM nonce per seal');
  // Both still open to the same position.
  assert.deepEqual(openCursor(a, MINE, SECRET).cursor, openCursor(b, MINE, SECRET).cursor);
});

test('an absent cursor is a first page, not a failure', () => {
  for (const c of [undefined, '']) {
    const opened = openCursor(c, MINE, SECRET);
    assert.equal(opened.ok, true);
    assert.equal(opened.cursor, undefined);
  }
  assert.equal(sealCursor(undefined, MINE, SECRET), undefined);
  assert.equal(sealCursorOrNull(undefined, MINE, SECRET), null, 'JSON bodies get null');
});

test('a cursor is refused outside the scope it was minted for', () => {
  const sealed = sealCursor(encodeCursor(OTHER_TENANT_KEY), MINE, SECRET);
  const foreign = [
    // Replayed against a different list.
    { ...MINE, view: 'runs:repo' },
    { ...MINE, view: 'unclaimed' },
    // Replayed under a different filter of the SAME list: the visible sequence differs, so
    // resuming here would skip or repeat rows.
    { ...MINE, status: 'completed' },
    { view: MINE.view, installationIds: MINE.installationIds },
    { ...MINE, repoId: 987654321 },
    // Replayed by another operator, or by the same operator after their grants changed.
    { ...MINE, installationIds: [99] },
    { ...MINE, installationIds: [11, 99] },
    { ...MINE, installationIds: [] },
  ];
  for (const scope of foreign) {
    assert.equal(
      openCursor(sealed, scope, SECRET).ok,
      false,
      `must refuse under ${JSON.stringify(scope)}`,
    );
  }
});

test('scope equality is structural, not literal-order dependent', () => {
  const sealed = sealCursor(encodeCursor(OTHER_TENANT_KEY), MINE, SECRET);
  // Same scope, written differently: key order flipped, grant list reordered, optional field
  // spelled as an explicit undefined. All must still open — otherwise a caller would get a
  // spurious 400 depending on how it built the object literal.
  const equivalent = {
    status: 'failed',
    installationIds: [11],
    view: 'runs:status',
    repoId: undefined,
  };
  assert.equal(canonicalScope(equivalent), canonicalScope(MINE));
  assert.equal(openCursor(sealed, equivalent, SECRET).ok, true);

  const multi = { view: 'runs:status', installationIds: [11, 22, 99], status: 'failed' };
  const shuffled = { view: 'runs:status', installationIds: [99, 11, 22], status: 'failed' };
  assert.equal(canonicalScope(multi), canonicalScope(shuffled), 'grant order is not scope');
  assert.equal(openCursor(sealCursor(encodeCursor(OTHER_TENANT_KEY), multi, SECRET), shuffled, SECRET).ok, true);
});

test('a cursor minted under another secret is refused', () => {
  const sealed = sealCursor(encodeCursor(OTHER_TENANT_KEY), MINE, SECRET);
  assert.equal(openCursor(sealed, MINE, 'a-rotated-secret').ok, false);
});

test('the bound principal is the grant SET, not the operator', () => {
  // Two DIFFERENT operators who administer exactly the same installations produce the same
  // canonical scope, so their cursors are interchangeable. That is the design, not a gap: the
  // scope pins every input to the visibility filter, so such a cursor can only resume a walk
  // over rows both sessions were already entitled to see.
  //
  // Pinned because the docs previously claimed a cursor was inert in "another operator's
  // session", which is false here and only accidentally true when grant sets differ. Nothing
  // session-specific is bound (no login, no per-session nonce); if that ever changes, this
  // test is where the claim gets upgraded.
  const alice = { view: 'runs:status', installationIds: [11], status: 'failed' };
  const bob = { view: 'runs:status', installationIds: [11], status: 'failed' };
  const sealed = sealCursor(encodeCursor(OTHER_TENANT_KEY), alice, SECRET);
  assert.equal(openCursor(sealed, bob, SECRET).ok, true, 'equal grants ⇒ equal scope');
  // The boundary that IS enforced: any difference in the visible row set refuses.
  const carol = { view: 'runs:status', installationIds: [11, 22], status: 'failed' };
  assert.equal(openCursor(sealed, carol, SECRET).ok, false, 'a wider grant set is a new scope');
});

test('forged, tampered and plaintext cursors are refused rather than restarted', () => {
  const raw = encodeCursor(OTHER_TENANT_KEY);
  const sealed = sealCursor(raw, MINE, SECRET);

  const hostile = [
    // A pre-ADR-052 bare key: the whole point is that a caller cannot hand us an arbitrary
    // ExclusiveStartKey and walk an index we would never have queried on their behalf.
    raw.raw,
    'c1.' + raw.raw,
    // Structurally plausible but unauthenticated.
    'c1.' + Buffer.from(JSON.stringify(OTHER_TENANT_KEY)).toString('base64url'),
    // Wrong/missing version tag.
    sealed.slice('c1.'.length),
    'c2.' + sealed.slice('c1.'.length),
    // Truncated below iv+tag, and empty payload.
    'c1.' + Buffer.alloc(20).toString('base64url'),
    'c1.',
    // Garbage.
    'c1.!!!!',
    '{}',
  ];
  for (const c of hostile) {
    assert.equal(openCursor(c, MINE, SECRET).ok, false, `must refuse ${c.slice(0, 24)}`);
  }

  // Single-bit flips anywhere in the blob must fail the GCM tag — nonce, ciphertext, or tag.
  const blob = Buffer.from(sealed.slice('c1.'.length), 'base64url');
  for (const i of [0, 11, 12, blob.length - 17, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[i] ^= 0x01;
    assert.equal(openCursor('c1.' + bad.toString('base64url'), MINE, SECRET).ok, false, `flip at ${i}`);
  }
});

test('openCursor never throws on hostile input', () => {
  for (const c of ['c1.\u0000\u0000', 'c1.' + '='.repeat(500), 'c1.' + 'A'.repeat(100000)]) {
    assert.doesNotThrow(() => openCursor(c, MINE, SECRET));
  }
});

// ---- route wiring ----------------------------------------------------------
//
// THREE layers hold the boundary, and it is worth being exact about which does what, because
// the first two are weaker than they look:
//
//   - The TYPE layer works only where a response body is declared. `json()` takes `unknown`,
//     so the `RawCursor` wrapper alone would NOT stop `nextCursor: page.nextCursor ?? null`
//     from compiling — it would serialize the plaintext key one level deeper, as
//     `"nextCursor":{"raw":"eyJwayI6…"}`. `RunListBody` declares `nextCursor: string | null`,
//     which is what makes that line a type error (`RawCursor | null` is not assignable).
//   - The SOURCE layer below covers what the types cannot see: reaching through `.raw`,
//     minting a cursor inside a route, dropping the 400, spreading a store page into a body,
//     or adding a paginated route with an UNTYPED body — where the compiler has no contract.
//   - The RUNTIME layer is the only one that is a property of the VALUE: `asRawCursor` installs
//     a throwing `toJSON`, so a raw cursor that reaches `JSON.stringify` fails closed however
//     it got there. That is what makes the seam safe for routes nobody has written yet, and it
//     is pinned by `cursor.test`-style assertions in this file rather than by a scan.
//
// The source scan walks every route-bearing source file, not just `handler.ts`: a new list
// route in a new file is exactly the case the type layer cannot catch on its own.
//
// These guards match SHAPES, not spellings — twice earned. An earlier revision keyed them on
// `nextCursor: <expr>` and on the literal line `const opened = openCursor(…);`, and four
// ordinary ways of writing a route walked past all of them: ES shorthand, a renamed binding, a
// scope argument containing a call, and a prettier-wrapped multi-line call. A later revision
// still keyed the seal rule on the FIELD NAME `nextCursor`, and two more walked past: an object
// SPREAD of the page (no field name exists to match) and a field simply renamed to `cursor`.
// Each is probed below the assertion that now catches it.

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Files that legitimately handle a raw store cursor: `cursor.ts` defines the wrapper,
 * `run-store.ts` mints it, and `paging.ts` is the shared collector whose contract is to hand
 * one back to its SERVER-side caller (`collectVisible` returns `{ runs, nextCursor }`). None of
 * them build a response body. Everything else under `src/` is treated as route code.
 */
const CURSOR_OWNERS = ['shared/cursor.ts', 'shared/run-store.ts', 'mgmt/paging.ts'];

/**
 * Strip comments before scanning. The guards below match on shapes like
 * `nextCursor: <rhs>`, and good documentation QUOTES the unsafe shape it is warning about —
 * this module's own header does. Scanning prose would make every such comment a build
 * failure, which teaches the next author to delete the warning rather than heed it.
 *
 * Block comments go first; line comments only when `//` opens the line, so a `'https://…'`
 * inside a string literal cannot swallow the code that follows it on the same line.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Strip TYPE declarations, so the value-assignment guard cannot confuse a type member with a
 * response field. `RunListBody` legitimately contains `nextCursor: string | null;`.
 *
 * Two wrong ways to write this, both probed:
 *
 *   - Skipping any right-hand side that ends in `;` also skips a single-line object literal
 *     closing `} };` — which silently stops guarding the exact leak this exists to catch.
 *   - Matching to the next COLUMN-0 `}` mis-handles a single-line declaration
 *     (`interface Tiny { a: string }`): the scan runs past its own closing brace to the next
 *     top-level one, taking real code with it. One injected single-line interface stripped
 *     2893 bytes of `handler.ts` instead of 28. It did not blind the guards *today*, which is
 *     the problem — coverage would depend on where a future type happened to be declared.
 *
 * So match a same-line closing brace first, and only then fall back to a column-0 one.
 */
function stripTypeDecls(src) {
  return src
    .replace(/^(?:export )?(?:interface|type)\s+\w+[^{\n]*\{[^{}\n]*\}[^\n]*$/gm, '')
    .replace(/^(?:export )?(?:interface|type)\s+\w+[^{]*\{[\s\S]*?^\}/gm, '');
}

/**
 * Index just past the `)` that closes the call whose `(` sits at `open`.
 *
 * The guards below used to be written as line-shaped regexes — `openCursor\([^)]*\);\n` and
 * friends. Probing them showed why that is not good enough: `[^)]*` stops at the FIRST close
 * paren, so a scope argument containing a call (`{ ...s, repoId: Number(q.repo) }`) or a
 * prettier-wrapped multi-line call slid straight past the guard, and a route that dropped its
 * 400 refusal stayed green. Match the call's real extent instead of a plausible spelling of it.
 */
function endOfCall(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function routeSources() {
  const out = [];
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const rel = relative(SRC, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/');
    if (CURSOR_OWNERS.includes(rel)) continue;
    out.push([rel, stripComments(readFileSync(join(SRC, rel), 'utf8'))]);
  }
  return out;
}

const SOURCES = routeSources();
const HANDLER = stripComments(readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8'));

test('the scan actually covers the route sources', () => {
  // Guard the guard: a broken walk would make every assertion below vacuously pass.
  const names = SOURCES.map(([rel]) => rel);
  assert.ok(names.includes('mgmt/handler.ts'), 'handler must be scanned');
  assert.ok(SOURCES.length >= 10, `expected the src tree, got ${SOURCES.length} files`);
  for (const owner of CURSOR_OWNERS) {
    assert.ok(!names.includes(owner), `${owner} owns the raw cursor and is exempt by design`);
  }
  // …and that stripping removed prose without eating code.
  assert.ok(!HANDLER.includes('ADR-052'), 'comments should be stripped');
  assert.ok(HANDLER.includes('sealCursorOrNull('), 'code must survive stripping');
});

test('every route seals a cursor it puts in a body, whatever the field is called', () => {
  // Judged by what the RHS READS, not by what the field is named. The previous rule matched
  // `nextCursor:` specifically, so `cursor: page.nextCursor ?? null` — an ordinary rename —
  // walked straight past it and shipped the same plaintext key. Any field whose value reads a
  // raw cursor (`….nextCursor`, `opened.cursor`) must either seal it, or reduce it to a boolean.
  //
  // The boolean escape is load-bearing, not a loophole: `anyIndexTruncated:
  // pages.some((p) => p.nextCursor !== undefined)` legitimately asks whether an index was
  // truncated. A comparison yields `true`/`false`, which carries no identifier.
  const readsCursor = /(?:\.nextCursor|\bopened\.cursor)\b/;
  let sealed = 0;
  for (const [rel, src] of SOURCES) {
    for (const m of stripTypeDecls(src).matchAll(/(\w+):\s*([^,\n]+(?:\n[^,\n]*)??)(?=,|\n\s*[}\])])/g)) {
      const [field, rhsRaw] = [m[1], m[2]];
      const rhs = rhsRaw.trim().replace(/[\s;}]+$/, '');
      if (!readsCursor.test(rhs)) continue;
      if (/seal(?:Cursor|CursorOrNull)\(/.test(rhs)) {
        sealed++;
        continue;
      }
      // A comparison reduces the cursor to a boolean before it can be serialized.
      assert.match(
        rhs,
        /(?:!==|===|!=|==)\s*(?:undefined|null)|\.nextCursor\s*(?:!==|===)/,
        `${rel}: field \`${field}\` reads a raw cursor without sealing it: ${rhs}`,
      );
    }
  }
  assert.ok(sealed >= 2, `expected both runs branches to seal, found ${sealed}`);
});

test('a route cannot spread a store page into a response body', () => {
  // `return json(200, { ...page, complete: false })` has NO field name for the rule above to
  // judge, typechecks clean against `json(body: unknown)`, and ships
  // `{"nextCursor":{"raw":"eyJwayI6…"}}`. It was probed against the previous guard set and
  // passed every one of them.
  //
  // A store page is not a response body — they differ by exactly the field that must not be
  // copied — so spreading one is never the right call in route code. Name the fields.
  const pageBindings = /(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*await\s+(?:collectVisible|listRunsBy\w+|fetchPage)\b/g;
  for (const [rel, src] of SOURCES) {
    const bound = [...src.matchAll(pageBindings)].map((m) => m[1]);
    for (const name of bound) {
      assert.doesNotMatch(
        src,
        new RegExp(`\\.\\.\\.\\s*${name}\\b`),
        `${rel}: spreading \`${name}\` copies its raw cursor into the body — name the fields ` +
          `and seal the cursor`,
      );
    }
  }
  // Guard the guard: the binding pattern must actually find the routes' pages, or the loop
  // above iterates nothing and the assertion is vacuous.
  const found = [...HANDLER.matchAll(pageBindings)].map((m) => m[1]);
  assert.deepEqual(found, ['page', 'page'], `expected both collectVisible pages, got ${found}`);
});

test('a raw cursor refuses to serialize, however it reaches a body', () => {
  // The layer that does not depend on how the route was written. `toJSON` is consulted by
  // `JSON.stringify` for any reachable value at any depth under any key — which is the set of
  // paths a spelling-based scan cannot enumerate. `handler.ts` serializes exactly once
  // (`JSON.stringify(reply.body)`), inside the try/catch that logs and returns a sanitized
  // error, so a leak on an unsealed route is a caught 500 rather than plaintext.
  const raw = encodeCursor(OTHER_TENANT_KEY);
  const bodies = [
    // The three shapes probed against the source guards, two of which passed them.
    { runs: [], nextCursor: raw, complete: false }, // named field / untyped body
    { runs: [], cursor: raw, complete: false }, // renamed field
    { runs: [], nextCursor: raw }, // spread of a store page
    // …and depth, which no field-name rule could reach at all.
    { page: { nextCursor: raw } },
    { list: [{ c: raw }] },
  ];
  for (const body of bodies) {
    assert.throws(
      () => JSON.stringify(body),
      /must be sealed before it reaches a response body/,
      `serializing ${Object.keys(body).join(',')} must fail closed`,
    );
  }
  // A sealed cursor is an ordinary string and serializes normally — the backstop must not
  // break the correct path.
  const ok = JSON.stringify({ nextCursor: sealCursorOrNull(raw, MINE, SECRET) });
  assert.match(ok, /^\{"nextCursor":"c1\./);
  for (const s of SECRETS) assert.ok(!ok.includes(s), `sealed body must not expose ${s}`);
});

test('the backstop does not change how a raw cursor otherwise behaves', () => {
  // Non-enumerable, so the wrapper is still the plain `{ raw }` value every store-side seam
  // treats it as. If `toJSON` were enumerable, `deepEqual` would compare unequal and the
  // round-trip assertions above would be testing something else.
  const raw = encodeCursor(OTHER_TENANT_KEY);
  assert.deepEqual(Object.keys(raw), ['raw']);
  assert.deepEqual({ ...raw }, { raw: raw.raw });
  assert.equal(Object.prototype.propertyIsEnumerable.call(raw, 'toJSON'), false);
  // And it cannot be defused by overwriting it.
  assert.throws(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    /** @type {any} */ (raw).toJSON = () => 'defused';
  });
  assert.throws(() => JSON.stringify(raw));
  // `asRawCursor` (used by `decodeCursor`'s round trip) carries the same protection.
  assert.throws(() => JSON.stringify(asRawCursor('abc')));
});

test('a route cannot smuggle a cursor into a body by shorthand', () => {
  // The rule above judges `nextCursor: <expression>`. ES shorthand has no expression to judge:
  //
  //     const nextCursor = page.nextCursor ?? null;
  //     return { body: { runs, nextCursor, complete } };
  //
  // That was probed against the previous guard set and passed every one of them, in a NEW file
  // with an untyped body — where the declared-body type layer has no contract to enforce
  // either. It ships the same plaintext key as `"nextCursor":{"raw":"eyJwayI6…"}`.
  //
  // So require the field to be written out. `nextCursor` may appear only as an explicit field
  // name (followed by `:`, judged above) or as a property read (`page.nextCursor`, preceded by
  // a dot) — never as a bare identifier a shorthand could pick up. Type members are stripped
  // first, since `RunListBody`/`WindowShape` legitimately declare the field.
  const shorthand = /(?<![.\w$])nextCursor\b(?!\s*:)/;
  for (const [rel, src] of SOURCES) {
    const m = shorthand.exec(stripTypeDecls(src));
    assert.equal(
      m,
      null,
      `${rel}: write \`nextCursor: sealCursorOrNull(…)\` explicitly rather than binding it — ` +
        `shorthand hides the expression from the seal guard`,
    );
  }
});

test('a paginated response body types its cursor as string | null', () => {
  // The type layer only bites where a body is declared. If a route hands `nextCursor` to an
  // untyped `json()` body, `RawCursor` is assignable and the leak compiles — so pin that the
  // runs list keeps its declared contract.
  assert.match(HANDLER, /interface RunListBody \{[^}]*nextCursor: string \| null;/s);
  const sealed = [...HANDLER.matchAll(/nextCursor: sealCursorOrNull\(/g)];
  assert.equal(sealed.length, 2, 'both paginated runs branches seal');
  // …and that they return through the typed helper rather than a bare `json(200, {…})`.
  assert.equal([...HANDLER.matchAll(/return runList\(\{/g)].length, 3, 'all three via runList');
});

test('no route reaches through the RawCursor wrapper or re-encodes a key itself', () => {
  // `Reply.raw` is an unrelated field (a pre-serialized response body), so match only
  // `.raw` reached off something cursor-shaped — that is the one way to defeat the wrapper
  // without a type error.
  const unwrap = /\b(\w*[Cc]ursor\w*|page\.nextCursor|opened\.cursor)\s*(\?\.|\.)raw\b/;
  for (const [rel, src] of SOURCES) {
    assert.equal(unwrap.test(src), false, `${rel} must not unwrap a RawCursor`);
    assert.equal(/encodeCursor\s*\(/.test(src), false, `${rel}: cursor minting belongs to the store`);
    // A route calling `asRawCursor(q.cursor)` would restore the plaintext-cursor hole while
    // satisfying the type checker.
    assert.equal(/asRawCursor\s*\(/.test(src), false, `${rel}: asRawCursor stays store-side`);
  }
});

test('every route that accepts a cursor opens it before querying', () => {
  for (const [rel, src] of SOURCES) {
    // `q.cursor` may only be consumed through `openCursor` — passing it to a store call
    // directly is the pre-ADR-052 behavior (and would not typecheck, but pin it anyway).
    for (const m of src.matchAll(/q\.cursor/g)) {
      const around = src.slice(Math.max(0, m.index - 120), m.index + 40);
      assert.ok(around.includes('openCursor('), `${rel}: q.cursor must be opened, near: ${around.slice(-80)}`);
    }
  }
  assert.ok(guardedOpens(HANDLER) >= 2, 'expected both runs branches to open a cursor');
});

test('a failed open refuses with 400 rather than restarting the walk', () => {
  // Keyed on the call's balanced extent and on whatever the route named the result, not on
  // `const opened = openCursor(…);` followed by one line. Three spellings that a route would
  // plausibly reach for — a renamed binding, a scope argument containing a call, and a
  // prettier-wrapped multi-line call — each defeated the previous line-shaped regex, so a
  // silent restart from the head page passed review.
  for (const [rel, src] of SOURCES) {
    if (!src.includes('openCursor(')) continue;
    assert.ok(guardedOpens(src, rel) > 0, `${rel}: openCursor call found but none guarded`);
  }
});

/**
 * Count `openCursor(` calls in `src`, asserting each one binds its result and refuses with a
 * 400 before doing anything else. An unbound result cannot be checked at all, so that is a
 * failure in itself.
 *
 * Both binding styles are accepted, because rejecting a correct one would teach the next
 * author to delete the guard rather than heed it: `const opened = openCursor(…)` checked as
 * `!opened.ok`, and `const { ok, cursor } = openCursor(…)` — including a renamed `ok:` —
 * checked as `!ok`.
 */
function guardedOpens(src, rel = 'mgmt/handler.ts') {
  let count = 0;
  for (const m of src.matchAll(/openCursor\(/g)) {
    const end = endOfCall(src, m.index + 'openCursor'.length);
    assert.notEqual(end, -1, `${rel}: unbalanced openCursor( call`);
    const before = src.slice(0, m.index);
    // What the route must negate to detect a failed open. `[\s\S]` so a wrapped
    // `const x =\n  openCursor(` still resolves its binding.
    const plain = /(?:const|let)\s+(\w+)\s*=[\s\S]{0,20}$/.exec(before);
    const destructured = /(?:const|let)\s*\{([^}]*)\}\s*=[\s\S]{0,20}$/.exec(before);
    let checked;
    if (destructured) {
      // `{ ok, cursor }` or `{ ok: renamed, cursor }` — the guard is on whatever `ok` became.
      const okBind = /\bok\s*(?::\s*(\w+))?/.exec(destructured[1]);
      assert.ok(okBind, `${rel}: an openCursor result must destructure \`ok\` so it can be checked`);
      checked = okBind[1] ?? 'ok';
    } else {
      assert.ok(plain, `${rel}: an openCursor result must be bound so it can be checked`);
      checked = `${plain[1]}.ok`;
    }
    // Everything up to the next statement boundary must be the refusal. 400 specifically:
    // a 500 would read as our bug, and a silent fall-through re-serves the head page.
    const after = src.slice(end, end + 300);
    assert.match(
      after,
      new RegExp(`if\\s*\\(\\s*!\\s*${checked.replace('.', '\\.')}\\s*\\)[\\s\\S]{0,40}?problem\\(\\s*400`),
      `${rel}: a failed open must \`return problem(400, …)\`, not fall through — after the ` +
        `call: ${after.slice(0, 120)}`,
    );
    count++;
  }
  return count;
}
