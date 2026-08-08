// The CD workflow's stack allowlist is a security control, and it is the kind that rots
// silently: a future "just add --all so it picks up the new stack" edit reads like a
// convenience and is not. A CD run that can deploy LCA-Control-dev can kill the runner plane
// executing that very job — leaving no runner to deploy the fix — and one that can deploy
// LCA-Deploy-dev can widen its own trust policy. So assert the shape of the workflow file.
//
// Parsed as text on purpose: the repo has no YAML dependency for tests (js-yaml is a runtime
// dep of the workflow parser, but the properties asserted here are lexical anyway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');
const text = fs.readFileSync(WORKFLOW, 'utf8');

/** `cdk deploy ...` invocations, flattened across YAML line continuations. */
function cdkDeployCommands() {
  const joined = text.replace(/\\\n\s*/g, ' ');
  return [...joined.matchAll(/npx cdk deploy[^\n]*/g)].map((m) => m[0]);
}

test('CD deploys only LCA-Mgmt-dev and LCA-Web-dev', () => {
  const cmds = cdkDeployCommands();
  assert.ok(cmds.length >= 1, 'expected at least one cdk deploy');
  const forbidden = ['LCA-Image', 'LCA-Control', 'LCA-Data', 'LCA-Deploy', 'LCA-Cert'];
  for (const cmd of cmds) {
    assert.doesNotMatch(cmd, /--all\b/, `CD must never deploy --all: ${cmd}`);
    for (const stack of forbidden) {
      assert.ok(!cmd.includes(stack), `CD must not deploy ${stack} from CI: ${cmd}`);
    }
    // A stack selector is mandatory: a bare `cdk deploy` with a single-stack app would be
    // fine, but this app synthesizes six stacks and would prompt/deploy the wrong thing.
    assert.match(cmd, /LCA-(Mgmt|Web)-dev/, `no stack selector in: ${cmd}`);
  }
});

test('every CD deploy passes --exclusively', () => {
  // LCA-Mgmt-dev declares CDK dependencies on LCA-Data-dev and LCA-Control-dev, and
  // `cdk deploy <stack>` deploys a stack's dependencies by default. Without --exclusively the
  // allowlist above is cosmetic: naming only Mgmt+Web would still redeploy the control plane.
  for (const cmd of cdkDeployCommands()) {
    assert.match(cmd, /(--exclusively|\s-e\b)/, `missing --exclusively: ${cmd}`);
  }
});

test('CD runs on our own microVM runners, never a GitHub-hosted one', () => {
  const runsOn = [...text.matchAll(/runs-on:\s*(.+)/g)].map((m) => m[1].trim());
  assert.ok(runsOn.length > 0, 'no runs-on found');
  for (const target of runsOn) {
    assert.match(target, /self-hosted/, `CD job must be self-hosted (got ${target})`);
    // node flavor specifically: npm ci + esbuild (`build:web`) are required.
    assert.match(target, /lambda-ci-node/, `CD needs the node flavor (got ${target})`);
    assert.doesNotMatch(target, /ubuntu-|windows-|macos-/, `GitHub-hosted runner: ${target}`);
  }
});

test('CD requests id-token: write and no more than contents: read', () => {
  const block = text.match(/^permissions:\n((?:\s+\S+:.*\n)+)/m);
  assert.ok(block, 'no top-level permissions block');
  const perms = Object.fromEntries(
    block[1]
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/:\s*/)),
  );
  assert.equal(perms['id-token'], 'write', 'id-token: write is what mints the OIDC JWT');
  assert.equal(perms.contents, 'read');
  // A CD workflow has no reason to write to the repo; `contents: write` here would let a
  // compromised deploy step push to main, which is also the ref its own role trusts.
  for (const [scope, level] of Object.entries(perms)) {
    if (scope === 'id-token') continue;
    assert.notEqual(level, 'write', `${scope}: write is not needed by CD`);
  }
});

test('CD is manual-only for now (no push trigger yet)', () => {
  const on = text.match(/^on:\n((?:\s+.*\n)+?)(?=^\S)/m);
  assert.ok(on, 'no on: block');
  assert.match(on[1], /workflow_dispatch:/);
  assert.doesNotMatch(on[1], /^\s+push:/m, 'the push trigger is a deliberate follow-up, not this card');
});

test('the deploy-target pin is declared inline and is not a secret reference', () => {
  assert.match(text, /LCA_DEPLOY_ACCOUNT:\s*'?863638663908'?/);
  assert.match(text, /LCA_DEPLOY_REGION:\s*us-west-2/);
  // An account id and a region are not secrets, and hiding them in `secrets.` makes the
  // deploy target invisible in review — the exact thing ADR-018 exists to prevent.
  assert.doesNotMatch(text, /LCA_DEPLOY_(ACCOUNT|REGION):\s*\$\{\{\s*secrets\./);
});

test('credentials come from the OIDC role, never long-lived keys', () => {
  assert.match(text, /aws-actions\/configure-aws-credentials@v4/);
  assert.match(text, /role-to-assume:\s*arn:aws:iam::863638663908:role\/lca-dev-github-deploy/);
  assert.doesNotMatch(text, /aws-access-key-id/, 'no static access keys in CD');
  assert.doesNotMatch(text, /aws-secret-access-key/);
});
