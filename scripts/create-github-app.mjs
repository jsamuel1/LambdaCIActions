#!/usr/bin/env node
// @ts-nocheck
/**
 * create-github-app.mjs — Register the LambdaCIActions GitHub App via the
 * App Manifest flow, then persist the generated credentials to SSM.
 *
 * Zero runtime dependencies (Node >= 18 built-ins only). Shells out to the
 * AWS CLI for the SSM writes so we don't need the AWS SDK for a bootstrap step.
 *
 * The GitHub App Manifest flow CANNOT be fully headless — GitHub requires one
 * human click on the "Create GitHub App" screen. This script automates
 * everything else: it renders the manifest into an auto-submitting form, opens
 * it in your browser, catches the redirect `code`, exchanges it for the app
 * credentials, and writes app_id / pem / webhook_secret / client_secret to SSM.
 *
 * Usage:
 *   node scripts/create-github-app.mjs \
 *     --console-url https://console.example.com \
 *     --webhook-url https://api.example.com/webhook \
 *     [--org my-org]              # omit to create under your personal account
 *     [--env dev]                 # SSM namespace: /lca/<env>/github/*  (default: dev)
 *     [--region us-west-2]        # AWS region for SSM (default: from env/CLI config)
 *     [--port 8976]               # local callback port (default: 8976)
 *     [--dry-run]                 # print the manifest + planned SSM writes, don't call AWS
 *
 * Prereqs: gh is NOT required. The AWS CLI must be configured (unless --dry-run).
 *
 * See docs/specs/01-github-app.md for the permission/event rationale.
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true; // boolean flag
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONSOLE_URL = args['console-url'];
const WEBHOOK_URL = args['webhook-url'];
const ORG = args['org'] || null;
const ENV = args['env'] || 'dev';
let REGION = args['region'] || null;
const PORT = parseInt(args['port'] || '8976', 10);
const DRY_RUN = Boolean(args['dry-run']);

// Deploy-target pin (ADR-018): this script writes SecureStrings to SSM — it must not run
// against an unintended account. Dry runs exempt (no AWS calls). Guard lives in
// lib/deploy-env.ts (shared with the CDK app), hence the dist/ import.
async function guardDeployTarget() {
  if (DRY_RUN) return;
  let mod;
  try {
    mod = await import(path.join(REPO_ROOT, 'dist', 'lib', 'deploy-env.js'));
  } catch {
    console.error('ERROR: dist/lib/deploy-env.js not found — run `npm run build` first.');
    process.exit(1);
  }
  try {
    // `env: ENV` binds the selected environment to the pin (ADR-033): this script writes App
    // credentials to `/lca/<env>/github/*`, so an unbound selector could stash prod secrets in
    // the dev account's parameter store.
    const target = mod.assertDeployTarget({ repoRoot: REPO_ROOT, region: REGION, env: ENV });
    REGION = target.region; // pin wins — SSM writes always carry --region <pin>
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

function assertArgs() {
  if (!DRY_RUN && (!CONSOLE_URL || !WEBHOOK_URL)) {
    console.error(
      'ERROR: --console-url and --webhook-url are required.\n' +
        'These are the App homepage URL and the webhook receiver URL.\n' +
        'In a real deploy the webhook URL is the API Gateway /webhook endpoint\n' +
        '(exists after ControlStack deploys — see docs/specs/05-infrastructure.md).\n\n' +
        'Run with --dry-run to preview the manifest without those.',
    );
    process.exit(1);
  }
}

const REDIRECT_URL = `http://localhost:${PORT}/callback`;
const SSM_PREFIX = `/lca/${ENV}/github`;

// ---------------------------------------------------------------------------
// the App manifest — mirrors docs/specs/01-github-app.md
// ---------------------------------------------------------------------------
function buildManifest() {
  return {
    name: `LambdaCIActions${ENV === 'prod' ? '' : `-${ENV}`}`,
    url: CONSOLE_URL || 'https://example.com',
    hook_attributes: {
      url: WEBHOOK_URL || 'https://example.com/webhook',
      active: true,
    },
    redirect_url: REDIRECT_URL,
    public: false,
    default_permissions: {
      actions: 'read', // read workflow/run metadata
      administration: 'write', // register/remove self-hosted JIT runners
      contents: 'read', // read .github/workflows for ingestion
      metadata: 'read', // mandatory baseline
    },
    default_events: [
      'workflow_job', // hot-path trigger
      'push', // re-parse workflows on .github/workflows change
    ],
    // NOTE: `installation` and `installation_repositories` are App LIFECYCLE events that
    // GitHub delivers to every App automatically — they are NOT subscribable via
    // default_events (and aren't gated by a permission). Listing them makes the manifest
    // invalid ("Default events unsupported"). The webhook still receives them at runtime.
  };
}

// ---------------------------------------------------------------------------
// HTML page that auto-POSTs the manifest to GitHub
// ---------------------------------------------------------------------------
function manifestFormPage(manifest, state) {
  const action = ORG
    ? `https://github.com/organizations/${encodeURIComponent(ORG)}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;
  const manifestJson = JSON.stringify(manifest).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create LambdaCIActions GitHub App</title>
<style>body{font-family:system-ui;margin:3rem auto;max-width:40rem;line-height:1.5}
button{font-size:1rem;padding:.6rem 1.2rem;cursor:pointer}code{background:#f4f4f4;padding:.1rem .3rem}</style>
</head><body>
<h1>Create the LambdaCIActions GitHub App</h1>
<p>Target: <code>${ORG ? `org: ${ORG}` : 'your personal account'}</code> · env: <code>${ENV}</code></p>
<p>Click below. GitHub will show a confirmation screen — press <b>Create GitHub App</b>.
You'll be redirected back here and the credentials will be captured automatically.</p>
<form id="f" action="${action}" method="post">
  <input type="hidden" name="manifest" value='${manifestJson}'>
  <button type="submit">Create GitHub App on GitHub →</button>
</form>
<script>/* auto-submit for convenience; button is the fallback */ document.getElementById('f').submit();</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// exchange the manifest code for app credentials
// ---------------------------------------------------------------------------
function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.github.com',
        path: `/app-manifests/${encodeURIComponent(code)}/conversions`,
        headers: {
          'User-Agent': 'LambdaCIActions-app-bootstrap',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 201) {
            reject(new Error(`conversion failed HTTP ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// persist to SSM via AWS CLI
// ---------------------------------------------------------------------------
function putParam(name, value, secure) {
  const cliArgs = [
    'ssm',
    'put-parameter',
    '--name',
    name,
    '--value',
    value,
    '--type',
    secure ? 'SecureString' : 'String',
    '--overwrite',
  ];
  if (REGION) cliArgs.push('--region', REGION);
  if (DRY_RUN) {
    console.log(`  [dry-run] aws ${cliArgs.slice(0, 6).join(' ')} --value <${secure ? 'secret' : value}> ...`);
    return;
  }
  const r = spawnSync('aws', cliArgs, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`aws ssm put-parameter failed for ${name}: ${r.stderr || r.stdout}`);
  }
  console.log(`  ✓ ${name} (${secure ? 'SecureString' : 'String'})`);
}

function persistCredentials(creds) {
  console.log(`\nWriting credentials to SSM under ${SSM_PREFIX}/ ...`);
  putParam(`${SSM_PREFIX}/app-id`, String(creds.id), false);
  putParam(`${SSM_PREFIX}/client-id`, creds.client_id, false);
  putParam(`${SSM_PREFIX}/client-secret`, creds.client_secret, true);
  putParam(`${SSM_PREFIX}/webhook-secret`, creds.webhook_secret, true);
  putParam(`${SSM_PREFIX}/app-pem`, creds.pem, true);
  putParam(`${SSM_PREFIX}/app-slug`, creds.slug, false);
}

// ---------------------------------------------------------------------------
// open a URL in the default browser (best-effort, cross-platform)
// ---------------------------------------------------------------------------
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* fall through to manual instruction */
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  assertArgs();
  await guardDeployTarget();
  const manifest = buildManifest();

  if (DRY_RUN) {
    console.log('=== App manifest (dry-run) ===');
    console.log(JSON.stringify(manifest, null, 2));
    console.log('\n=== SSM writes that WOULD happen ===');
    for (const [k, secure] of [
      ['app-id', false],
      ['client-id', false],
      ['client-secret', true],
      ['webhook-secret', true],
      ['app-pem', true],
      ['app-slug', false],
    ]) {
      console.log(`  ${SSM_PREFIX}/${k}  (${secure ? 'SecureString' : 'String'})`);
    }
    console.log('\nNo browser opened, no AWS calls made. Drop --dry-run to run for real.');
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  let resolveCode;
  const codePromise = new Promise((res) => (resolveCode = res));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(manifestFormPage(manifest, state));
      return;
    }
    if (u.pathname === '/callback') {
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      if (gotState && gotState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>State mismatch — aborting.</h1>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>✓ Received. You can close this tab.</h1>');
      resolveCode(code);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => server.listen(PORT, r));
  const startUrl = `http://localhost:${PORT}/`;
  console.log(`\nLocal helper listening on ${startUrl}`);
  console.log('Opening your browser — approve the "Create GitHub App" screen on GitHub.');
  console.log(`(If it doesn't open, visit: ${startUrl} )\n`);
  openBrowser(startUrl);

  const code = await codePromise;
  server.close();
  if (!code) throw new Error('no code received from GitHub redirect');

  console.log('Exchanging manifest code for credentials...');
  const creds = await exchangeCode(code);
  console.log(`✓ Created GitHub App: ${creds.slug} (id ${creds.id})`);
  console.log(`  Manage: ${creds.html_url}`);

  persistCredentials(creds);

  console.log(
    `\nDone. Install the app on your repos: ${creds.html_url}/installations/new\n` +
      `Secrets live under ${SSM_PREFIX}/ — referenced (not created) by CDK per ADR-008.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('\n✗ ' + e.message);
    process.exit(1);
  });
}

export { buildManifest, manifestFormPage };
