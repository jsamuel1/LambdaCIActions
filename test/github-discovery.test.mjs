// Unit tests for the GitHub contents-API discovery helpers (src/shared/github-app.ts → dist).
// Mocks global fetch; generates a throwaway RSA key for the App JWT chain.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  listWorkflowFiles,
  getFileContent,
  _clearTokenCache,
} from '../dist/src/shared/github-app.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const AUTH = { appId: '1', pem: privateKey, installationId: 42, owner: 'octo', repo: 'repo' };

const realFetch = globalThis.fetch;
let routes;

beforeEach(() => {
  _clearTokenCache();
  routes = new Map();
  // Token mint endpoint always available.
  routes.set('/app/installations/42/access_tokens', {
    status: 201,
    body: { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() },
  });
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const route = routes.get(path);
    if (!route) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('lists only yml/yaml files from the workflows directory', async () => {
  routes.set('/repos/octo/repo/contents/.github/workflows', {
    body: [
      { type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml', sha: 'a1' },
      { type: 'file', name: 'deploy.yaml', path: '.github/workflows/deploy.yaml', sha: 'b2' },
      { type: 'file', name: 'README.md', path: '.github/workflows/README.md', sha: 'c3' },
      { type: 'dir', name: 'shared', path: '.github/workflows/shared', sha: 'd4' },
    ],
  });
  const files = await listWorkflowFiles(AUTH);
  assert.deepEqual(files, [
    { path: '.github/workflows/ci.yml', sha: 'a1' },
    { path: '.github/workflows/deploy.yaml', sha: 'b2' },
  ]);
});

test('missing workflows directory (404) → empty list, not an error', async () => {
  const files = await listWorkflowFiles(AUTH);
  assert.deepEqual(files, []);
});

test('fetches and decodes base64 file content with its sha', async () => {
  const yaml = 'name: CI\non: push\njobs: {}\n';
  routes.set('/repos/octo/repo/contents/.github/workflows/ci.yml', {
    body: { content: Buffer.from(yaml).toString('base64'), encoding: 'base64', sha: 'a1' },
  });
  const res = await getFileContent({ ...AUTH, path: '.github/workflows/ci.yml' });
  assert.equal(res.content, yaml);
  assert.equal(res.sha, 'a1');
});

test('non-base64 content encoding → clear error', async () => {
  routes.set('/repos/octo/repo/contents/.github/workflows/ci.yml', {
    body: { encoding: 'none', sha: 'a1' },
  });
  await assert.rejects(
    () => getFileContent({ ...AUTH, path: '.github/workflows/ci.yml' }),
    /not base64/,
  );
});
