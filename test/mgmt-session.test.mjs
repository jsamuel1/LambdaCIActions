// Unit tests for the operator session cookie + OAuth state signing (src/mgmt/session.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSession,
  decodeSession,
  parseCookies,
  serializeCookie,
  signState,
  verifyState,
  canAdminInstallation,
  SESSION_TTL_SECONDS,
} from '../dist/src/mgmt/session.js';

const SECRET = 'test-session-secret-abc123';
const payload = {
  login: 'octocat',
  installations: [
    { installationId: 111, accountLogin: 'acme' },
    { installationId: 222, accountLogin: 'globex' },
  ],
};

test('round-trips a session', () => {
  const token = encodeSession(payload, SECRET);
  const decoded = decodeSession(token, SECRET);
  assert.equal(decoded.login, 'octocat');
  assert.equal(decoded.installations.length, 2);
  assert.equal(decoded.exp - decoded.iat, SESSION_TTL_SECONDS);
});

test('rejects a session signed with a different secret', () => {
  const token = encodeSession(payload, SECRET);
  assert.equal(decodeSession(token, 'other-secret'), undefined);
});

test('rejects a tampered payload (privilege escalation attempt)', () => {
  const token = encodeSession(payload, SECRET);
  const [body, mac] = token.split('.');
  const evil = Buffer.from(
    JSON.stringify({
      login: 'octocat',
      installations: [{ installationId: 999, accountLogin: 'victim' }],
      iat: 0,
      exp: 9999999999,
    }),
  ).toString('base64url');
  assert.equal(decodeSession(`${evil}.${mac}`, SECRET), undefined);
  assert.ok(body.length > 0);
});

test('rejects an expired session', () => {
  const past = new Date(Date.now() - (SESSION_TTL_SECONDS + 60) * 1000);
  const token = encodeSession(payload, SECRET, past);
  assert.equal(decodeSession(token, SECRET), undefined);
});

test('rejects malformed tokens without throwing', () => {
  for (const bad of [undefined, '', 'nodot', '.only-mac', 'body.', 'a.b.c']) {
    assert.equal(decodeSession(bad, SECRET), undefined);
  }
});

test('session never carries a GitHub token (ADR-022)', () => {
  const token = encodeSession(payload, SECRET);
  const json = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
  const obj = JSON.parse(json);
  assert.deepEqual(Object.keys(obj).sort(), ['exp', 'iat', 'installations', 'login']);
});

test('authorization is scoped to the session installations', () => {
  const s = decodeSession(encodeSession(payload, SECRET), SECRET);
  assert.equal(canAdminInstallation(s, 111), true);
  assert.equal(canAdminInstallation(s, 222), true);
  assert.equal(canAdminInstallation(s, 333), false);
});

test('OAuth state signing round-trips and rejects forgery', () => {
  const state = signState('nonce123', SECRET);
  assert.equal(verifyState(state, SECRET), 'nonce123');
  assert.equal(verifyState('nonce123.deadbeef', SECRET), undefined);
  assert.equal(verifyState(signState('nonce123', 'other'), SECRET), undefined);
  assert.equal(verifyState(undefined, SECRET), undefined);
});

test('cookies are HttpOnly + Secure + SameSite=Lax', () => {
  const c = serializeCookie('lca_session', 'v', { maxAgeSeconds: 60 });
  assert.match(c, /^lca_session=v;/);
  assert.ok(c.includes('HttpOnly'));
  assert.ok(c.includes('Secure'));
  assert.ok(c.includes('SameSite=Lax'));
  assert.ok(c.includes('Max-Age=60'));
});

test('cleared cookies set Max-Age=0', () => {
  assert.ok(serializeCookie('lca_session', '', { clear: true }).includes('Max-Age=0'));
});

test('parseCookies handles spacing, encoding, and junk segments', () => {
  const map = parseCookies('a=1; lca_session=ab%2Fc;; broken ; b=2');
  assert.equal(map.a, '1');
  assert.equal(map.lca_session, 'ab/c');
  assert.equal(map.b, '2');
  assert.equal(parseCookies(undefined).x, undefined);
});
