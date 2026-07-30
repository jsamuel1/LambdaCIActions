// IAM-posture tests for MgmtStack (spec 04 § Non-functional → least privilege, ADR-025).
//
// These assert the management plane's boundary in the SYNTHESIZED template, not just in
// prose: the console λ must not be able to launch compute, read the GitHub App private key,
// or Put/Delete DynamoDB items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../dist/lib/data-stack.js';
import { MgmtStack, DEFAULT_REPORTS_MODEL_ID } from '../dist/lib/mgmt-stack.js';
import { DEFAULT_MODEL_ID } from '../dist/src/mgmt/nl-report.js';

function synth(over = {}) {
  const app = new App();
  const env = { account: '123456789012', region: 'us-west-2' };
  const data = new DataStack(app, 'Data', { env, envName: 'test', ssmPrefix: '/lca/test' });
  const mgmt = new MgmtStack(app, 'Mgmt', {
    env,
    envName: 'test',
    ssmPrefix: '/lca/test',
    table: data.table,
    discoveryQueueUrl: 'https://sqs.us-west-2.amazonaws.com/123456789012/lca-test-discovery',
    discoveryQueueArn: 'arn:aws:sqs:us-west-2:123456789012:lca-test-discovery',
    publicOrigin: 'https://console.example.com',
    ...over,
  });
  return Template.fromStack(mgmt);
}

/** Every action string granted by any policy in the template. */
function allActions(template) {
  const actions = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const a = stmt.Action;
      actions.push(...(Array.isArray(a) ? a : [a]));
    }
  }
  return actions;
}

test('mgmt λ is arm64 on the Node 22 runtime', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Lambda::Function', {
    Architectures: ['arm64'],
    Runtime: 'nodejs22.x',
  });
});

test('mgmt λ cannot launch or terminate microVMs', () => {
  const actions = allActions(synth());
  for (const forbidden of [
    'lambda:RunMicrovm',
    'lambda:TerminateMicrovm',
    'lambda:ListMicrovms',
    'lambda:GetMicrovm',
    'iam:PassRole',
  ]) {
    assert.equal(actions.includes(forbidden), false, `granted ${forbidden}`);
  }
});

test('mgmt λ cannot Put or Delete DynamoDB items (no forged runs, no history loss)', () => {
  const actions = allActions(synth());
  for (const forbidden of ['dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem']) {
    assert.equal(actions.includes(forbidden), false, `granted ${forbidden}`);
  }
  assert.ok(actions.includes('dynamodb:UpdateItem'), 'config patches require UpdateItem');
});

test('mgmt λ GetParameter is scoped to its own auth secrets — never the App PEM', () => {
  const t = synth();
  const resources = [];
  for (const policy of Object.values(t.findResources('AWS::IAM::Policy'))) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (!actions.includes('ssm:GetParameter')) continue;
      const res = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      resources.push(...res.map((r) => JSON.stringify(r)));
    }
  }
  assert.ok(resources.length > 0, 'no GetParameter grant found');
  const joined = resources.join('|');
  assert.ok(joined.includes('/lca/test/github/client-id'));
  assert.ok(joined.includes('/lca/test/mgmt/session-secret'));
  assert.equal(joined.includes('app-pem'), false, 'PEM must not be readable');
  assert.equal(joined.includes('webhook-secret'), false, 'webhook secret must not be readable');
  assert.equal(joined.includes('parameter/lca/test/*'), false, 'wildcard param read');
});

test('secret presence checks use DescribeParameters (metadata only, no values)', () => {
  assert.ok(allActions(synth()).includes('ssm:DescribeParameters'));
});

test('log access is read-only and scoped to the per-env run log group', () => {
  const t = synth();
  let found = false;
  for (const policy of Object.values(t.findResources('AWS::IAM::Policy'))) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (!actions.includes('logs:FilterLogEvents')) continue;
      found = true;
      assert.equal(actions.includes('logs:PutLogEvents'), false);
      const res = JSON.stringify(stmt.Resource);
      assert.ok(res.includes('/aws/lambda/microvms/runs/lca-test'));
    }
  }
  assert.ok(found, 'no log-read grant found');
});

test('rescan grants SendMessage only — not receive/delete on the discovery queue', () => {
  const actions = allActions(synth());
  assert.ok(actions.includes('sqs:SendMessage'));
  assert.equal(actions.includes('sqs:ReceiveMessage'), false);
  assert.equal(actions.includes('sqs:DeleteMessage'), false);
});

test('the Reports assistant grant is InvokeModel on exactly the configured model', () => {
  const t = synth();
  let found = false;
  for (const policy of Object.values(t.findResources('AWS::IAM::Policy'))) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (!actions.includes('bedrock:InvokeModel')) continue;
      found = true;
      // Streaming is not needed for a 400-token JSON spec and is deliberately withheld.
      assert.equal(actions.includes('bedrock:InvokeModelWithResponseStream'), false);
      const res = JSON.stringify(stmt.Resource);
      assert.ok(res.includes(DEFAULT_REPORTS_MODEL_ID), 'grant is not pinned to the model id');
      assert.equal(res.includes('foundation-model/*'), false, 'wildcard model grant');
    }
  }
  assert.ok(found, 'no Bedrock grant found — the Reports assistant would 403 at runtime');
});

test('no other Bedrock action is granted', () => {
  const actions = allActions(synth()).filter((a) => String(a).startsWith('bedrock:'));
  assert.deepEqual(actions, ['bedrock:InvokeModel']);
});

test('disabling the assistant removes the Bedrock grant entirely', () => {
  const actions = allActions(synth({ reportsNlEnabled: false }));
  assert.equal(actions.some((a) => String(a).startsWith('bedrock:')), false);
});

test('a custom model id moves the IAM grant with it', () => {
  const custom = 'anthropic.claude-3-haiku-20240307-v1:0';
  const t = synth({ reportsModelId: custom });
  const grants = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  assert.ok(grants.includes(custom));
  assert.equal(grants.includes(DEFAULT_REPORTS_MODEL_ID), false, 'stale default still granted');
});

test('the stack default model id matches the handler default (no split-brain grant)', () => {
  // If these drift, IAM authorizes one model while the λ invokes another → runtime 403.
  assert.equal(DEFAULT_REPORTS_MODEL_ID, DEFAULT_MODEL_ID);
});

test('the assistant model id and enablement reach the λ as env, not code', () => {
  synth().hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: {
        REPORTS_MODEL_ID: DEFAULT_REPORTS_MODEL_ID,
        REPORTS_NL_ENABLED: 'true',
      },
    },
  });
});

test('the API exposes only /api and /auth routes', () => {
  const t = synth();
  const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map(
    (r) => r.Properties.RouteKey,
  );
  assert.ok(routes.length > 0);
  for (const key of routes) {
    assert.match(key, /\s\/(api|auth)\/\{proxy\+\}$/, `unexpected route ${key}`);
  }
});

test('the run table exposes the M4 repo/time index (ADR-023)', () => {
  const app = new App();
  const data = new DataStack(app, 'Data', {
    env: { account: '123456789012', region: 'us-west-2' },
    envName: 'test',
    ssmPrefix: '/lca/test',
  });
  const t = Template.fromStack(data);
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    GlobalSecondaryIndexes: [
      { IndexName: 'gsi1' },
      {
        IndexName: 'gsi2',
        KeySchema: [
          { AttributeName: 'gsi2pk', KeyType: 'HASH' },
          { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
        ],
      },
    ],
  });
});
