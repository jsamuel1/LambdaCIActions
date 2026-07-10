// Unit tests for the webhook HMAC verifier (src/shared/hmac.ts → dist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature } from '../dist/src/shared/hmac.js';

const SECRET = 'topsecret-webhook';

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('accepts a correctly signed body', () => {
  const body = JSON.stringify({ action: 'queued' });
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test('rejects a tampered body', () => {
  const body = JSON.stringify({ action: 'queued' });
  const sig = sign(body);
  assert.equal(verifySignature(body + 'x', sig, SECRET), false);
});

test('rejects a signature made with the wrong secret', () => {
  const body = 'hello';
  assert.equal(verifySignature(body, sign(body, 'wrong'), SECRET), false);
});

test('rejects missing / malformed signature headers', () => {
  const body = 'hello';
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, 'md5=abc', SECRET), false);
  assert.equal(verifySignature(body, sign(body).slice(7), SECRET), false); // no sha256= prefix
});

test('works on Buffer bodies (base64-decoded API GW payloads)', () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }), 'utf8');
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});
