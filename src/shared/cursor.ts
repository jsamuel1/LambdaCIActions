import crypto from 'node:crypto';

/**
 * Sealed, scope-bound pagination cursors (ADR-052).
 *
 * ## What went wrong
 *
 * Every paginated mgmt list authorizes with a POST-QUERY installation filter — the run
 * indexes are keyed by status/repo/time, never by installation (ADR-023), so
 * `collectVisible` can only drop rows after DynamoDB has returned them. The store then
 * handed the raw `LastEvaluatedKey` straight out as `nextCursor`, base64url of plain JSON.
 *
 * That key names the LAST ROW SCANNED, which is frequently a row the session may not see:
 * `RUN#<repoId>#<runId>#<jobId>` plus a timestamp. The row was filtered out of the response
 * body and then leaked in the cursor beside it. base64url is an encoding, not a protection —
 * any authenticated operator could decode it and read another tenant's repo/run/job ids.
 * (The unclaimed/refusal list is the same seam with `REFUSAL#…` keys; it is still unlanded —
 * PR #34 — and inherits this module structurally when it arrives.)
 *
 * ## Why sealing, and not just signing
 *
 * An HMAC over the same base64url payload fixes tampering, not disclosure: the plaintext is
 * still right there for the client to read. Confidentiality is the actual requirement here,
 * so the key is **encrypted** (AES-256-GCM), and the scope it was minted under is bound as
 * additional authenticated data. One primitive then buys three properties:
 *
 *   - **confidentiality** — the DynamoDB key never leaves the Lambda in readable form;
 *   - **integrity** — a forged or edited cursor fails the GCM tag and is refused, so a
 *     caller cannot hand us an arbitrary `ExclusiveStartKey` and walk an index we would
 *     never have queried for them;
 *   - **scope binding** — the AAD covers `(route, installation grants, repo, status)`, so a
 *     cursor minted for one list cannot be replayed against another, and one operator's
 *     cursor is inert in another operator's session.
 *
 * Binding the grant set means a cursor stops working when the operator's installations
 * change (a re-login after access changes). That is the conservative direction: the cursor's
 * whole purpose is to resume a walk whose visibility filter was computed from those grants.
 *
 * ## Why refuse rather than silently restart
 *
 * `decodeCursor` deliberately tolerates garbage — a malformed cursor starts from the top
 * instead of 500ing. A cursor that fails to OPEN is different: it is either forged, replayed
 * across scopes, or minted under a different secret. Restarting the walk from the head would
 * quietly re-serve the first page under a "load older" click, which reads as duplicate rows
 * rather than as the refusal it is. Callers therefore surface a 400.
 *
 * Deploys that roll the session secret invalidate outstanding cursors; the console recovers
 * on the next unpaginated fetch. Same blast radius as the session cookie, which is signed
 * with the same secret and already re-issued on rotation.
 *
 * ## What sealing does NOT hide
 *
 * AES-GCM is length-preserving, so the sealed blob's length still reveals the plaintext key's
 * length — i.e. roughly how many DIGITS the scanned row's ids have, in ~3-byte steps once
 * base64 is accounted for. That bounds an id's magnitude; it names no id, and repo/run/job
 * ids are not secrets in themselves (GitHub numbers them sequentially and publishes them for
 * public repos). Padding to a fixed width would close it, at the cost of a fixed-size cursor
 * on every response; not worth it for a magnitude hint, but it is the mitigation if a future
 * key shape makes length meaningful.
 *
 * Pure `node:crypto`, no AWS types — unit-testable (see `test/mgmt-cursor-scope.test.mjs`).
 */

/**
 * A cursor as the STORE speaks it: base64url of a DynamoDB `LastEvaluatedKey`, readable by
 * anyone who holds it.
 *
 * Deliberately **not** a branded `string`. A branded string is still assignable to `string`,
 * so `nextCursor: page.nextCursor ?? null` would still typecheck against a `string | null`
 * response contract — exactly the leak this module exists to prevent. Wrapping the value in
 * an object makes that line a compile error, so the raw key can only reach a client if
 * someone reaches through `.raw` on purpose.
 */
export interface RawCursor {
  readonly raw: string;
}

/** Wrap a store-internal cursor string. Store-side only. */
export function asRawCursor(s: string): RawCursor {
  return { raw: s };
}

/**
 * The scope a cursor is minted under and may only be replayed under. Every field that
 * changes WHICH rows a page walk can see belongs here.
 */
export interface CursorScope {
  /** Logical list the cursor belongs to, e.g. `runs:repo`, `runs:status`, `unclaimed`. */
  view: string;
  /** Installation ids the minting session held a grant for (order-insensitive). */
  installationIds: number[];
  /** Repo filter, when the list is repo-scoped. */
  repoId?: number;
  /** Status filter, when the list is status-scoped. */
  status?: string;
}

/** Version tag: lets the format change without a sealed blob being misread as the new one. */
const PREFIX = 'c1.';
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = 'lca-cursor-v1';

/**
 * Derive the cursor key from the session secret. A separate HKDF label keeps cursor sealing
 * cryptographically independent of session-cookie and OAuth-state signing, which use the
 * same secret directly — one purpose per derived key, so a weakness in one construction
 * cannot be pivoted into another.
 */
function cursorKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), HKDF_SALT, 'cursor-aead', KEY_BYTES),
  );
}

/**
 * Canonical scope bytes for the AAD. Field order and number normalization are fixed here so
 * two structurally identical scopes always produce byte-identical AAD — otherwise a cursor
 * would fail to open against its own scope depending on how the object literal was written.
 * Installation ids are sorted numerically for the same reason.
 */
export function canonicalScope(scope: CursorScope): string {
  return JSON.stringify({
    view: scope.view,
    installationIds: [...scope.installationIds].sort((a, b) => a - b),
    repoId: scope.repoId ?? null,
    status: scope.status ?? null,
  });
}

/**
 * Seal a store cursor for a client. `undefined` in ⇒ `undefined` out, so "the index is
 * exhausted" stays expressible without a sentinel.
 */
export function sealCursor(
  raw: RawCursor | undefined,
  scope: CursorScope,
  secret: string,
): string | undefined {
  if (!raw) return undefined;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', cursorKey(secret), iv);
  cipher.setAAD(Buffer.from(canonicalScope(scope), 'utf8'));
  const ct = Buffer.concat([cipher.update(raw.raw, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
}

/** `sealCursor` shaped for a JSON body: absent cursor ⇒ `null`, never `undefined`. */
export function sealCursorOrNull(
  raw: RawCursor | undefined,
  scope: CursorScope,
  secret: string,
): string | null {
  return sealCursor(raw, scope, secret) ?? null;
}

/**
 * Open a client cursor under the scope it must have been minted for.
 *
 * Returns `{ ok: true, cursor: undefined }` for an absent cursor — a first page is not a
 * failure. Anything present but unopenable is `{ ok: false }`: wrong scope, wrong secret,
 * tampered ciphertext, or a bare pre-ADR-052 plaintext key. Never throws; a caller on the
 * request path must not turn a hostile string into a 500.
 */
export function openCursor(
  cursor: string | undefined,
  scope: CursorScope,
  secret: string,
): { ok: true; cursor: RawCursor | undefined } | { ok: false } {
  if (cursor === undefined || cursor === '') return { ok: true, cursor: undefined };
  if (!cursor.startsWith(PREFIX)) return { ok: false };
  let blob: Buffer;
  try {
    blob = Buffer.from(cursor.slice(PREFIX.length), 'base64url');
  } catch {
    return { ok: false };
  }
  if (blob.length <= IV_BYTES + TAG_BYTES) return { ok: false };
  const iv = blob.subarray(0, IV_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cursorKey(secret), iv);
    decipher.setAAD(Buffer.from(canonicalScope(scope), 'utf8'));
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    if (!raw) return { ok: false };
    return { ok: true, cursor: asRawCursor(raw) };
  } catch {
    // GCM tag mismatch — wrong scope, wrong key, or tampering. Indistinguishable by design.
    return { ok: false };
  }
}
