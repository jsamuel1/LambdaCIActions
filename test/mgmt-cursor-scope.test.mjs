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
// Four invariants:
//   1. a sealed cursor carries no readable identifier, in any encoding a client can apply;
//   2. a cursor is inert outside the scope it was minted for (view / grants / repo / status);
//   3. forged, tampered, and pre-ADR-052 plaintext cursors are REFUSED, not restarted;
//   4. the routes actually seal — no `nextCursor` reaches a body straight off a store page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
// The type system stops a RAW cursor reaching a `string | null` body (`RawCursor` is a
// wrapper, not a branded string, precisely so `page.nextCursor ?? null` fails to compile).
// It cannot stop someone reaching through `.raw`, so pin the source shape too.

const HANDLER = readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8');

test('every route seals its outgoing cursor', () => {
  const assignments = [...HANDLER.matchAll(/nextCursor:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  assert.ok(assignments.length >= 3, 'expected the runs routes to be found');
  for (const rhs of assignments) {
    assert.ok(
      rhs === 'null' || rhs.startsWith('sealCursorOrNull(') || rhs.startsWith('sealCursor('),
      `nextCursor must be sealed or explicitly null, got: ${rhs}`,
    );
  }
});

test('no route reaches through the RawCursor wrapper or re-encodes a key itself', () => {
  // `Reply.raw` is an unrelated field (a pre-serialized response body), so match only
  // `.raw` reached off something cursor-shaped — that is the one way to defeat the wrapper
  // without a type error.
  const unwrap = /\b(\w*[Cc]ursor\w*|page\.nextCursor|opened\.cursor)\s*(\?\.|\.)raw\b/;
  assert.equal(unwrap.test(HANDLER), false, 'handler must not unwrap a RawCursor');
  assert.equal(/encodeCursor\s*\(/.test(HANDLER), false, 'cursor minting belongs to the store');
});

test('every route that accepts a cursor opens it before querying', () => {
  // `q.cursor` may only be consumed through `openCursor` — passing it to a store call
  // directly is the pre-ADR-052 behavior (and would not typecheck, but pin it anyway).
  for (const m of HANDLER.matchAll(/q\.cursor/g)) {
    const around = HANDLER.slice(Math.max(0, m.index - 120), m.index + 40);
    assert.ok(around.includes('openCursor('), `q.cursor must be opened, near: ${around.slice(-80)}`);
  }
  // And a failed open must refuse, not fall through to a head-page query.
  const opens = [...HANDLER.matchAll(/const opened = openCursor\([^)]*\);\n([^\n]*)\n/g)];
  assert.ok(opens.length >= 2, 'expected both runs branches to open a cursor');
  for (const [, nextLine] of opens) {
    assert.match(nextLine, /if \(!opened\.ok\) return problem\(400/);
  }
});

test('asRawCursor stays store-side', () => {
  // A route calling `asRawCursor(q.cursor)` would restore the plaintext-cursor hole while
  // satisfying the type checker.
  assert.equal(/asRawCursor\s*\(/.test(HANDLER), false);
});
