// IAM-posture tests for MgmtStack (spec 04 § Non-functional → least privilege, ADR-025).
//
// These assert the management plane's boundary in the SYNTHESIZED template, not just in
// prose: the console λ must not be able to launch compute, read the GitHub App private key,
// or Put/Delete DynamoDB items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../dist/lib/data-stack.js';
import { MgmtStack, DEFAULT_REPORTS_MODEL_ID } from '../dist/lib/mgmt-stack.js';
import { DEFAULT_MODEL_ID } from '../dist/src/mgmt/nl-report.js';
import { envConfig } from '../dist/lib/env-config.js';

function synth(over = {}) {
  return Template.fromStack(stackFor('test', over));
}

/**
 * Build MgmtStack for a named environment. Split out of `synth` so a test can assert a
 * PER-ENVIRONMENT config value (run retention differs dev/prod) rather than only the dev shape.
 */
function stackFor(envName, over = {}) {
  const app = new App();
  const env = { account: '123456789012', region: 'us-west-2' };
  const data = new DataStack(app, 'Data', { env, envName, ssmPrefix: `/lca/${envName}` });
  return new MgmtStack(app, 'Mgmt', {
    env,
    envName,
    ssmPrefix: `/lca/${envName}`,
    table: data.table,
    discoveryQueueUrl: 'https://sqs.us-west-2.amazonaws.com/123456789012/lca-test-discovery',
    discoveryQueueArn: 'arn:aws:sqs:us-west-2:123456789012:lca-test-discovery',
    publicOrigin: 'https://console.example.com',
    // Reports-assistant knobs live in EnvConfig, not in stack props (ADR-033 wiring note): a
    // prop nothing passes is a knob no operator can reach, so the override goes through the
    // same path `bin/lca.ts` uses for `-c reportsNl=` / `-c reportsModel=`.
    config: envConfig(envName, over),
  });
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

test('the assistant knobs are reachable from EnvConfig, not just stack props', () => {
  // Regression guard for the defect ADR-033's wiring note names: the model id and the
  // enablement flag were MgmtStack props that `bin/lca.ts` never passed, so the ADR described
  // a per-env switch the deployment did not have. Only route to change either was editing
  // source — or hand-editing the λ's env, which silently breaks the IAM grant (pinned on the
  // CDK side) and produces a runtime 403.
  assert.equal(envConfig('dev').reportsNlEnabled, true);
  assert.equal(envConfig('prod').reportsNlEnabled, true);
  assert.equal(envConfig('dev').reportsModelId, DEFAULT_REPORTS_MODEL_ID);
  assert.equal(envConfig('prod', { reportsNlEnabled: false }).reportsNlEnabled, false);
  assert.equal(envConfig('dev', { reportsModelId: 'other.model-v1:0' }).reportsModelId, 'other.model-v1:0');
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
  // ...and a disabled env really reaches the handler as `false`, which is the string
  // `nlEnabled()` tests for. `true` here would leave the route live with no Bedrock grant.
  synth({ reportsNlEnabled: false }).hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ REPORTS_NL_ENABLED: 'false' }) },
  });
});

test('a custom model id reaches the λ env and the grant from the same value', () => {
  // One source (EnvConfig) feeds both, so they cannot drift into a 403.
  const custom = 'anthropic.claude-3-haiku-20240307-v1:0';
  const t = synth({ reportsModelId: custom });
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ REPORTS_MODEL_ID: custom }) },
  });
  assert.ok(JSON.stringify(t.findResources('AWS::IAM::Policy')).includes(custom));
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

test('the λ is given the run retention its report window cap depends on', () => {
  // `maxRangeDays()` in src/mgmt/reports.ts reads RUN_RETENTION_DAYS to cap a report window,
  // because terminal rows carry a TTL of exactly that many days (ADR-033: dev 30, prod 90).
  // Without this variable every environment silently falls back to 90, so a dev console offers
  // a 90-day report over a table that keeps 30 — and answers it as `complete`.
  const dev = Template.fromStack(stackFor('test'));
  dev.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ RUN_RETENTION_DAYS: '30' }) },
  });
  const prod = Template.fromStack(stackFor('prod'));
  prod.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ RUN_RETENTION_DAYS: '90' }) },
  });
  // Same value the control plane's writers stamp the TTL with — one config field, so the
  // reader and the writers cannot disagree about how long a row lives.
  assert.equal(String(envConfig('test').runRetentionDays), '30');
  assert.equal(String(envConfig('prod').runRetentionDays), '90');
});
