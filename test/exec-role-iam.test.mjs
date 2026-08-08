// Synth-level IAM assertions for the microVM execution role (ADR-021). The point of the
// tightening is negative: workflow code inside a VM must NOT be able to read the run table
// or terminate microVMs. Assert against the real synthesized LCA-Control template so a
// future `grantReadData(microvmExecRole)` / SelfTerminate statement can't creep back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ControlStack } from '../dist/lib/control-stack.js';
import { DataStack } from '../dist/lib/data-stack.js';
import { envConfig } from '../dist/lib/env-config.js';

function synth() {
  const app = new App();
  const env = { account: '111122223333', region: 'us-west-2' };
  const data = new DataStack(app, 'LCA-Data-test', { env, envName: 'test', ssmPrefix: '/lca/test' });
  const control = new ControlStack(app, 'LCA-Control-test', {
    env,
    envName: 'test',
    ssmPrefix: '/lca/test',
    tagPrefix: 'lca',
    table: data.table,
    config: envConfig('test'),
  });
  return Template.fromStack(control);
}

/** All inline policy statements attached to the microVM exec role. */
function execRoleStatements(template) {
  const roleId = Object.entries(template.findResources('AWS::IAM::Role')).find(
    ([, r]) => r.Properties?.RoleName === 'lca-test-microvm-exec',
  )?.[0];
  assert.ok(roleId, 'microvm exec role not found in template');

  const out = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const attachedToExecRole = (policy.Properties?.Roles ?? []).some(
      (r) => JSON.stringify(r) === JSON.stringify({ Ref: roleId }),
    );
    if (attachedToExecRole) out.push(...(policy.Properties.PolicyDocument.Statement ?? []));
  }
  return out;
}

function actionsOf(stmt) {
  return Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
}

test('microVM exec role cannot read DynamoDB at all', () => {
  const stmts = execRoleStatements(synth());
  const ddb = stmts.flatMap(actionsOf).filter((a) => typeof a === 'string' && a.startsWith('dynamodb:'));
  assert.deepEqual(ddb, [], `exec role must hold no dynamodb actions, got ${ddb.join(', ')}`);
});

test('microVM exec role cannot terminate microVMs', () => {
  const stmts = execRoleStatements(synth());
  const term = stmts
    .flatMap(actionsOf)
    .filter((a) => typeof a === 'string' && /Microvm/.test(a) && a !== 'lambda:InvokeFunction');
  assert.deepEqual(term, [], `exec role must hold no microVM control actions, got ${term.join(', ')}`);
});

test('microVM exec role holds only broker invoke + its own log group', () => {
  const stmts = execRoleStatements(synth());
  const actions = stmts.flatMap(actionsOf).sort();
  assert.deepEqual(actions, [
    'lambda:InvokeFunction',
    'logs:CreateLogGroup',
    'logs:CreateLogStream',
    'logs:PutLogEvents',
  ]);

  // The invoke must be pinned to the single hook-broker function ARN, never '*'.
  const invoke = stmts.find((s) => actionsOf(s).includes('lambda:InvokeFunction'));
  const resource = JSON.stringify(invoke.Resource);
  assert.match(resource, /HookBrokerFn/, `invoke should target the broker ARN, got ${resource}`);
  assert.doesNotMatch(resource, /^"\*"$/);
});

test('TerminateMicrovm lives on the broker role, region-scoped', () => {
  const template = synth();
  const stmts = brokerStatements(template);
  const term = stmts.find((s) => actionsOf(s).includes('lambda:TerminateMicrovm'));
  assert.ok(term, 'broker must be able to terminate the caller VM');
  assert.deepEqual(term.Condition, {
    StringEquals: { 'aws:RequestedRegion': 'us-west-2' },
  });
});

// The broker is the one role an untrusted VM can reach (indirectly, via InvokeFunction), so
// it must not itself hold table-wide enumeration. It does exactly two GetItems by primary
// key — `grantReadData` would re-introduce Query/Scan/BatchGetItem + `/index/*`, i.e. the
// harvesting primitive ADR-021 removed, one hop further out.
test('broker DynamoDB access is GetItem on the table only', () => {
  const stmts = brokerStatements(synth());
  const ddb = stmts.flatMap(actionsOf).filter((a) => typeof a === 'string' && a.startsWith('dynamodb:'));
  assert.deepEqual(ddb, ['dynamodb:GetItem'], `broker ddb actions: ${ddb.join(', ')}`);

  const read = stmts.find((s) => actionsOf(s).includes('dynamodb:GetItem'));
  const resources = JSON.stringify(read.Resource);
  assert.doesNotMatch(resources, /index/, `broker must not reach GSIs, got ${resources}`);
});

/** All inline policy statements attached to the hook broker's role. */
function brokerStatements(template) {
  const brokerRoleId = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) =>
    id.startsWith('HookBrokerFnServiceRole'),
  )?.[0];
  assert.ok(brokerRoleId, 'hook broker role not found');

  const stmts = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const attached = (policy.Properties?.Roles ?? []).some(
      (r) => JSON.stringify(r) === JSON.stringify({ Ref: brokerRoleId }),
    );
    if (attached) stmts.push(...(policy.Properties.PolicyDocument.Statement ?? []));
  }
  return stmts;
}

