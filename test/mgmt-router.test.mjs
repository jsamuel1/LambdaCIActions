// Unit tests for the Management API route table (src/mgmt/router.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, asPositiveInt, ROUTES } from '../dist/src/mgmt/router.js';

test('static routes match exactly', () => {
  const r = matchRoute('GET', '/api/health');
  assert.equal(r.kind, 'match');
  assert.equal(r.match.route.id, 'health');
  assert.deepEqual(r.match.params, {});
});

test('trailing slashes are tolerated', () => {
  assert.equal(matchRoute('GET', '/api/runs/').kind, 'match');
});

test('path params are captured and URL-decoded', () => {
  const r = matchRoute('GET', '/api/runs/12/34/56');
  assert.equal(r.kind, 'match');
  assert.equal(r.match.route.id, 'getRun');
  assert.deepEqual(r.match.params, { repoId: '12', runId: '34', jobId: '56' });
});

test('logs route is distinct from run detail', () => {
  const detail = matchRoute('GET', '/api/runs/1/2/3');
  const logs = matchRoute('GET', '/api/runs/1/2/3/logs');
  assert.equal(detail.match.route.id, 'getRun');
  assert.equal(logs.match.route.id, 'getRunLogs');
});

test('same path with different methods resolves per method', () => {
  assert.equal(matchRoute('GET', '/api/repos/9/flavor-map').match.route.id, 'getFlavorMap');
  assert.equal(matchRoute('PUT', '/api/repos/9/flavor-map').match.route.id, 'putFlavorMap');
});

test('known path with wrong method is 405 with the allowed set', () => {
  const r = matchRoute('DELETE', '/api/repos/9/flavor-map');
  assert.equal(r.kind, 'method-not-allowed');
  assert.deepEqual(r.allow.sort(), ['GET', 'PUT']);
});

test('unknown path is not-found', () => {
  assert.equal(matchRoute('GET', '/api/nope').kind, 'not-found');
  assert.equal(matchRoute('GET', '/').kind, 'not-found');
});

test('empty path segments do not match a param route', () => {
  // `//workflows` must not resolve repoId to the empty string.
  assert.notEqual(matchRoute('GET', '/api/repos//workflows').kind, 'match');
});

test('only auth + nothing else is unauthenticated', () => {
  const open = ROUTES.filter((r) => !r.authRequired).map((r) => r.id).sort();
  assert.deepEqual(open, ['authCallback', 'authLogin', 'authLogout']);
});

test('every /api route requires auth', () => {
  for (const r of ROUTES) {
    if (r.template.startsWith('/api/')) assert.equal(r.authRequired, true, r.id);
  }
});

test('report routes resolve, and ask is POST-only', () => {
  assert.equal(matchRoute('GET', '/api/reports/catalog').match.route.id, 'reportCatalog');
  assert.equal(matchRoute('GET', '/api/reports/run').match.route.id, 'runReport');
  assert.equal(matchRoute('GET', '/api/reports/export').match.route.id, 'exportReport');
  assert.equal(matchRoute('POST', '/api/reports/ask').match.route.id, 'askReport');
  // A model invocation costs money — it must not be reachable as a prefetchable GET.
  assert.equal(matchRoute('GET', '/api/reports/ask').kind, 'method-not-allowed');
});

test('asPositiveInt rejects non-numeric, zero, and negatives', () => {
  assert.equal(asPositiveInt('42'), 42);
  assert.equal(asPositiveInt('0'), undefined);
  assert.equal(asPositiveInt('-1'), undefined);
  assert.equal(asPositiveInt('1e3'), undefined);
  assert.equal(asPositiveInt('12abc'), undefined);
  assert.equal(asPositiveInt(undefined), undefined);
});

test('a malformed percent-escape in a path param does not throw', () => {
  // decodeURIComponent('%') throws; matchRoute must degrade to the raw segment so the
  // handler answers 400 (asPositiveInt rejects it) rather than 500.
  const r = matchRoute('GET', '/api/runs/%/2/3');
  assert.equal(r.kind, 'match');
  assert.equal(asPositiveInt(r.match.params.repoId), undefined);
});
