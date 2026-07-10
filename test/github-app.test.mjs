// Unit tests for the GitHub App JWT signer (src/shared/github-app.ts → dist).
// We generate a throwaway RSA keypair, sign a JWT, and verify structure + signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAppJwt } from '../dist/src/shared/github-app.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

test('produces a three-part RS256 JWT', () => {
  const jwt = createAppJwt('12345', privateKey);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  const header = decodeSegment(parts[0]);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
});

test('claims: iss=appId, exp within 10 min, iat backdated', () => {
  const now = 1_700_000_000_000;
  const jwt = createAppJwt('999', privateKey, now);
  const payload = decodeSegment(jwt.split('.')[1]);
  assert.equal(payload.iss, '999');
  const nowSec = Math.floor(now / 1000);
  assert.ok(payload.iat <= nowSec, 'iat backdated');
  assert.ok(payload.exp - payload.iat <= 600, 'exp within 10-min ceiling');
  assert.ok(payload.exp > nowSec, 'not already expired');
});

test('signature verifies against the public key', () => {
  const jwt = createAppJwt('42', privateKey);
  const [h, p, sig] = jwt.split('.');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  verifier.end();
  const sigBuf = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(verifier.verify(publicKey, sigBuf), true);
});
