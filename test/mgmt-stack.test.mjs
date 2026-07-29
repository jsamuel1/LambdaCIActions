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
import { MgmtStack } from '../dist/lib/mgmt-stack.js';
import { ControlStack } from '../dist/lib/control-stack.js';

function synth() {
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
    appcfgBrokerName: 'lca-test-appcfg',
    appcfgBrokerArn: 'arn:aws:lambda:us-west-2:123456789012:function:lca-test-appcfg',
    webhookUrl: 'https://api.example.com/webhook',
    publicOrigin: 'https://console.example.com',
  });
  return Template.fromStack(mgmt);
}

/** ControlStack template — home of the App-config broker (ADR-028). */
function synthControl() {
  const app = new App();
  const env = { account: '123456789012', region: 'us-west-2' };
  const data = new DataStack(app, 'Data', { env, envName: 'test', ssmPrefix: '/lca/test' });
  const control = new ControlStack(app, 'Control', {
    env,
    envName: 'test',
    ssmPrefix: '/lca/test',
    tagPrefix: 'lca',
    table: data.table,
  });
  return Template.fromStack(control);
}

/** Statements from any policy in the template that grant `action`. */
function statementsWith(template, action) {
  const out = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (actions.includes(action)) out.push(stmt);
    }
  }
  return out;
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

test('mgmt λ holds NO ssm:PutParameter — config writes go through the broker (ADR-028)', () => {
  const actions = allActions(synth());
  for (const forbidden of ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameters']) {
    assert.equal(actions.includes(forbidden), false, `granted ${forbidden}`);
  }
});

test('mgmt λ may read the non-secret config params it reports as effective values', () => {
  const t = synth();
  const joined = statementsWith(t, 'ssm:GetParameter')
    .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))
    .map((r) => JSON.stringify(r))
    .join('|');
  assert.ok(joined.includes('/lca/test/config/runner-labels'));
  assert.ok(joined.includes('/lca/test/config/platform-admins'));
});

test('mgmt λ can invoke ONLY the App-config broker, by exact ARN', () => {
  const stmts = statementsWith(synth(), 'lambda:InvokeFunction');
  assert.equal(stmts.length, 1, 'expected exactly one InvokeFunction grant');
  const res = Array.isArray(stmts[0].Resource) ? stmts[0].Resource : [stmts[0].Resource];
  assert.deepEqual(res, ['arn:aws:lambda:us-west-2:123456789012:function:lca-test-appcfg']);
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

// ---- App-config broker posture (ADR-028) -----------------------------------
//
// The broker is the ONE place in the platform with `ssm:PutParameter` on secret paths. Its
// blast radius is therefore asserted explicitly: exactly the credential + label parameters,
// no wildcard, and specifically NOT the console session key (writing that would let it forge
// operator sessions) or the microVM image ARNs.

const PUT_ALLOWED = [
  '/lca/test/github/app-id',
  '/lca/test/github/app-pem',
  '/lca/test/github/webhook-secret',
  '/lca/test/github/client-id',
  '/lca/test/github/client-secret',
  '/lca/test/github/app-slug',
  '/lca/test/config/runner-labels',
];

test('the App-config broker is the only PutParameter holder, scoped to exact paths', () => {
  const stmts = statementsWith(synthControl(), 'ssm:PutParameter');
  assert.equal(stmts.length, 1, 'expected exactly one PutParameter grant in the control plane');
  const res = (Array.isArray(stmts[0].Resource) ? stmts[0].Resource : [stmts[0].Resource]).map((r) =>
    JSON.stringify(r),
  );
  assert.equal(res.length, PUT_ALLOWED.length, 'unexpected number of writable parameters');
  for (const path of PUT_ALLOWED) {
    assert.ok(res.some((r) => r.includes(`parameter${path}`)), `missing write grant for ${path}`);
  }
  const joined = res.join('|');
  assert.equal(joined.includes('session-secret'), false, 'must not be able to forge sessions');
  assert.equal(joined.includes('image-arn'), false, 'must not be able to repoint microVM images');
  assert.equal(joined.includes('parameter/lca/test/*'), false, 'wildcard write grant');
});

test('DeleteParameter is scoped to the same set as PutParameter (undo path only)', () => {
  const stmts = statementsWith(synthControl(), 'ssm:DeleteParameter');
  assert.equal(stmts.length, 1, 'expected exactly one DeleteParameter grant');
  const res = (Array.isArray(stmts[0].Resource) ? stmts[0].Resource : [stmts[0].Resource]).map((r) =>
    JSON.stringify(r),
  );
  assert.equal(res.length, PUT_ALLOWED.length);
  const joined = res.join('|');
  assert.equal(joined.includes('session-secret'), false);
  assert.equal(joined.includes('parameter/lca/test/*'), false, 'wildcard delete grant');
});

test('the App-config broker cannot launch compute or destroy data', () => {
  const actions = allActions(synthControl());
  // These are held by OTHER control-plane functions; assert the broker's own policy is clean
  // by checking the statements attached to the appcfg role specifically.
  const t = synthControl();
  const brokerPolicies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify(p.Properties.Roles ?? '').includes('AppConfigFnServiceRole'),
  );
  assert.ok(brokerPolicies.length > 0, 'no policy found for the App-config broker role');
  const brokerActions = brokerPolicies.flatMap((p) =>
    p.Properties.PolicyDocument.Statement.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    ),
  );
  for (const forbidden of [
    'lambda:RunMicrovm',
    'lambda:TerminateMicrovm',
    'iam:PassRole',
    'dynamodb:PutItem',
    'dynamodb:DeleteItem',
    'dynamodb:Query',
  ]) {
    assert.equal(brokerActions.includes(forbidden), false, `broker granted ${forbidden}`);
  }
  assert.ok(brokerActions.includes('dynamodb:UpdateItem'), 'broker needs UpdateItem for audit rows');
  // Sanity: the control plane as a whole still launches microVMs (we filtered correctly).
  assert.ok(actions.includes('lambda:RunMicrovm'));
});

test('the App-config broker is arm64 and finishes inside the console integration timeout', () => {
  synthControl().hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'lca-test-appcfg',
    Architectures: ['arm64'],
    // MUST stay below the Mgmt λ's 29 s API Gateway cap: a broker that outlived it would
    // complete a relink whose `replacedVersions` rollback handle the operator never received.
    Timeout: 25,
  });
});

test('the broker is NOT concurrency-capped (that would serialize the polled read path)', () => {
  // Write serialization is a conditional DynamoDB lock around the mutating actions. A
  // function-level cap would also throttle `status`, which Settings polls every 15 s — two
  // operators with the screen open would block each other into a blank view.
  const fns = synthControl().findResources('AWS::Lambda::Function');
  const appcfg = Object.values(fns).find(
    (f) => f.Properties.FunctionName === 'lca-test-appcfg',
  );
  assert.ok(appcfg, 'appcfg function not synthesized');
  assert.equal(appcfg.Properties.ReservedConcurrentExecutions, undefined);
});

test("the broker's DynamoDB write is scoped to CONFIG# leading keys", () => {
  // It writes audit rows + the config lock. Without a LeadingKeys condition an UpdateItem
  // grant on the whole table could patch run rows or installation config.
  const t = synthControl();
  const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify(p.Properties.Roles ?? '').includes('AppConfigFnServiceRole'),
  );
  const stmts = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
  const ddb = stmts.find((s) => JSON.stringify(s.Action).includes('dynamodb:UpdateItem'));
  assert.ok(ddb, 'broker has no DynamoDB write grant');
  assert.deepEqual(ddb.Condition, {
    'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONFIG#*'] },
  });
});

test('ingest can write the webhook heartbeat row (spec 04 webhook health)', () => {
  // The heartbeat is a DynamoDB UpdateItem on a fixed key; ingest already holds
  // read/write on the table, so assert that grant still exists rather than a new one.
  const t = synthControl();
  const ingestPolicies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify(p.Properties.Roles ?? '').includes('IngestFnServiceRole'),
  );
  const actions = ingestPolicies.flatMap((p) =>
    p.Properties.PolicyDocument.Statement.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    ),
  );
  assert.ok(actions.includes('dynamodb:UpdateItem'), 'ingest cannot write the heartbeat');
});
