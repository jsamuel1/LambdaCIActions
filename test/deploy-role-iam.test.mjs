// Synth-level IAM assertions for the CI deploy identity (ADR-047). Same shape as
// exec-role-iam.test.mjs and the same reason: the security property here is NEGATIVE, and
// nothing about a passing deploy would tell you it had been widened. The two ways this role
// goes wrong in the wild are (a) `AdministratorAccess` or a `Resource: "*"` IAM write bolted
// on to make a deploy work, and (b) a trust policy loosened to `StringLike` with a wildcard
// ref — which silently lets ANY fork's pull-request workflow assume it, i.e. any GitHub user.
// Both are asserted against the real synthesized template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DeployStack } from '../dist/lib/deploy-stack.js';

const ACCOUNT = '111122223333';
const REGION = 'us-west-2';
const PROVIDER_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

function synth(overrides = {}) {
  const app = new App();
  const stack = new DeployStack(app, 'LCA-Deploy-test', {
    env: { account: ACCOUNT, region: REGION },
    envName: 'test',
    githubRepo: 'jsamuel1/LambdaCIActions',
    githubRefs: ['refs/heads/main'],
    existingProviderArn: PROVIDER_ARN,
    ...overrides,
  });
  return { template: Template.fromStack(stack), stack };
}

function deployRole(template) {
  const entry = Object.entries(template.findResources('AWS::IAM::Role')).find(
    ([, r]) => r.Properties?.RoleName === 'lca-test-github-deploy',
  );
  assert.ok(entry, 'deploy role not found in template');
  return { id: entry[0], props: entry[1].Properties };
}

/** Inline policy statements attached to the deploy role. */
function deployRoleStatements(template) {
  const { id } = deployRole(template);
  const out = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const attached = (policy.Properties?.Roles ?? []).some(
      (r) => JSON.stringify(r) === JSON.stringify({ Ref: id }),
    );
    if (attached) out.push(...(policy.Properties.PolicyDocument.Statement ?? []));
  }
  return out;
}

const actionsOf = (stmt) => (Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]);
const resourcesOf = (stmt) => (Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource]);

// --- trust policy -----------------------------------------------------------

test('trust is pinned to this repo + refs/heads/main with StringEquals', () => {
  const { props } = deployRole(synth().template);
  const stmts = props.AssumeRolePolicyDocument.Statement;
  assert.equal(stmts.length, 1, 'exactly one trust statement');
  const [trust] = stmts;

  assert.equal(trust.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(trust.Principal, { Federated: PROVIDER_ARN });
  assert.deepEqual(trust.Condition, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:jsamuel1/LambdaCIActions:ref:refs/heads/main',
    },
  });
  // StringLike is how a `sub` claim gets a wildcard smuggled into it.
  assert.equal(trust.Condition.StringLike, undefined, 'no StringLike on the sub/aud claims');
});

test('a wildcard repo or ref is refused at synth, not documented as a hazard', () => {
  for (const repo of ['jsamuel1/*', '*/LambdaCIActions', '*', 'noslash']) {
    assert.throws(() => synth({ githubRepo: repo }), /githubRepo must be "owner\/repo"/, repo);
  }
  for (const refs of [['refs/heads/*'], ['refs/*'], ['*'], ['refs/heads/ma?n']]) {
    assert.throws(() => synth({ githubRefs: refs }), /must be exact refs, not patterns/, String(refs));
  }
  // A bare branch name is not a ref path — `sub` carries the full `refs/heads/...`, so a
  // bare name would build a claim that never matches (a deploy that mysteriously 403s).
  assert.throws(() => synth({ githubRefs: ['main'] }), /must be full ref paths/);
  assert.throws(() => synth({ githubRefs: [] }), /at least one ref/);
});

test('multiple exact refs are allowed and stay exact', () => {
  const { template } = synth({ githubRefs: ['refs/heads/main', 'refs/heads/release'] });
  const { props } = deployRole(template);
  const sub = props.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[
    'token.actions.githubusercontent.com:sub'
  ];
  assert.deepEqual(sub, [
    'repo:jsamuel1/LambdaCIActions:ref:refs/heads/main',
    'repo:jsamuel1/LambdaCIActions:ref:refs/heads/release',
  ]);
});

// --- permissions ------------------------------------------------------------

test('no managed policies at all (never AdministratorAccess)', () => {
  const { props } = deployRole(synth().template);
  assert.deepEqual(props.ManagedPolicyArns ?? [], []);
});

test('the role holds exactly assume-bootstrap-roles + DescribeStacks', () => {
  const stmts = deployRoleStatements(synth().template);
  const actions = [...new Set(stmts.flatMap(actionsOf))].sort();
  assert.deepEqual(actions, ['cloudformation:DescribeStacks', 'sts:AssumeRole']);
});

test('assume-role targets the four bootstrap roles in this account/region only', () => {
  const stmts = deployRoleStatements(synth().template);
  const assume = stmts.find((s) => actionsOf(s).includes('sts:AssumeRole'));
  const resources = resourcesOf(assume).map((r) => JSON.stringify(r));
  assert.equal(resources.length, 4, `expected 4 bootstrap roles, got ${resources.join(', ')}`);
  for (const kind of ['deploy', 'file-publishing', 'image-publishing', 'lookup']) {
    assert.ok(
      resources.some((r) => r.includes(`cdk-hnb659fds-${kind}-role-${ACCOUNT}-${REGION}`)),
      `missing bootstrap role ${kind}: ${resources.join(', ')}`,
    );
  }
});

test('a cross-region deploy adds only the named extra region', () => {
  const { template } = synth({ additionalBootstrapRegions: ['us-east-1'] });
  const assume = deployRoleStatements(template).find((s) => actionsOf(s).includes('sts:AssumeRole'));
  const resources = resourcesOf(assume).map((r) => JSON.stringify(r));
  assert.equal(resources.length, 8);
  assert.ok(resources.some((r) => r.includes(`-role-${ACCOUNT}-us-east-1`)));
});

test('no IAM write actions, and no wildcard resource anywhere', () => {
  // Scanned across the WHOLE template, not just the deploy role: the point is that this stack
  // introduces no wildcard IAM write at all, and the provider-creating path would add one via
  // its custom-resource role.
  const { template } = synth();
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    for (const stmt of policy.Properties.PolicyDocument.Statement ?? []) {
      for (const action of actionsOf(stmt)) {
        assert.doesNotMatch(String(action), /^iam:/, `no iam: action expected (${action})`);
        assert.notEqual(String(action), '*', 'no wildcard action');
      }
      for (const resource of resourcesOf(stmt)) {
        assert.notEqual(resource, '*', `statement ${stmt.Sid ?? '(unnamed)'} must not use Resource "*"`);
        assert.doesNotMatch(JSON.stringify(resource), /"\*"/, 'no wildcard resource');
      }
      assert.notEqual(stmt.Effect, 'Deny', 'unexpected Deny — this role is allow-only by design');
    }
  }
  for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
    for (const inline of role.Properties.Policies ?? []) {
      const json = JSON.stringify(inline.PolicyDocument);
      assert.doesNotMatch(json, /"iam:[A-Za-z]+"/, `inline policy holds an iam: write: ${json}`);
    }
  }
});

test('DescribeStacks is scoped to this env\u2019s two CD-deployed stacks', () => {
  const stmts = deployRoleStatements(synth().template);
  const describe = stmts.find((s) => actionsOf(s).includes('cloudformation:DescribeStacks'));
  const resources = resourcesOf(describe).map((r) => JSON.stringify(r));
  assert.equal(resources.length, 2);
  assert.ok(resources.some((r) => r.includes('stack/LCA-Mgmt-test/')));
  assert.ok(resources.some((r) => r.includes('stack/LCA-Web-test/')));
  // The control plane and image/data stacks are not readable, let alone deployable, from CI.
  for (const forbidden of ['LCA-Control', 'LCA-Image', 'LCA-Data']) {
    assert.ok(
      !resources.some((r) => r.includes(forbidden)),
      `${forbidden} must not be reachable from the CD role`,
    );
  }
});

test('the role description is ASCII — IAM rejects the repo’s usual em dash', () => {
  // IAM validates `description` against [\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]. An em
  // dash (U+2014) synths fine and fails at CreateRole, which is a deploy-time surprise for a
  // stack that is deployed by hand once per environment. Caught here instead.
  const { props } = deployRole(synth().template);
  assert.doesNotMatch(props.Description, /[^\t\n\r\x20-\x7E\u00A1-\u00FF]/, props.Description);
});

// --- provider reference vs creation -----------------------------------------

test('the provider is referenced by default — no wildcard-IAM custom resource', () => {
  // Referencing is the safe default: the provider is an account-level singleton, so creating a
  // second one fails at deploy, AND the creating path synthesizes a custom-resource role
  // holding iam:CreateOpenIDConnectProvider on Resource "*" — a wildcard IAM write inside the
  // stack whose whole purpose is least privilege.
  const { template } = synth({ existingProviderArn: undefined });
  assert.deepEqual(template.findResources('Custom::AWSCDKOpenIdConnectProvider'), {});
  assert.deepEqual(template.findResources('AWS::Lambda::Function'), {});

  const federated = deployRole(template).props.AssumeRolePolicyDocument.Statement[0].Principal
    .Federated;
  // The canonical ARN is derived from the account, not configured — there is only one shape.
  assert.match(JSON.stringify(federated), /oidc-provider\/token\.actions\.githubusercontent\.com/);
});

test('an explicit provider ARN is referenced as given', () => {
  const { template } = synth();
  assert.deepEqual(template.findResources('Custom::AWSCDKOpenIdConnectProvider'), {});
  const { props } = deployRole(template);
  assert.deepEqual(props.AssumeRolePolicyDocument.Statement[0].Principal, { Federated: PROVIDER_ARN });
});

test('creation is opt-in only (fresh-account path)', () => {
  const { template } = synth({ existingProviderArn: undefined, createProvider: true });
  const created = Object.values(template.findResources('Custom::AWSCDKOpenIdConnectProvider'));
  assert.equal(created.length, 1, 'a fresh account must be able to get a provider');
  assert.equal(created[0].Properties.Url, 'https://token.actions.githubusercontent.com');
  assert.deepEqual(created[0].Properties.ClientIDList, ['sts.amazonaws.com']);
});

test('createProvider + existingProviderArn is refused rather than silently ignored', () => {
  assert.throws(() => synth({ createProvider: true }), /mutually exclusive/);
});
