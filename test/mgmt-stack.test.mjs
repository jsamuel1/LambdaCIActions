// IAM-posture tests for MgmtStack (spec 04 § Non-functional → least privilege, ADR-025).
//
// These assert the management plane's boundary in the SYNTHESIZED template, not just in
// prose: the console λ must not be able to launch compute, read the GitHub App private key,
// or reach a run row with a Put/Delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../dist/lib/data-stack.js';
import { MgmtStack, DEFAULT_REPORTS_MODEL_ID } from '../dist/lib/mgmt-stack.js';
import { DEFAULT_MODEL_ID } from '../dist/src/mgmt/nl-report.js';
import { ControlStack } from '../dist/lib/control-stack.js';
import { envConfig } from '../dist/lib/env-config.js';
import { runPk } from '../dist/src/shared/run-store.js';


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
    appcfgBrokerName: 'lca-test-appcfg',
    appcfgBrokerArn: 'arn:aws:lambda:us-west-2:123456789012:function:lca-test-appcfg',
    webhookUrl: 'https://api.example.com/webhook',
    publicOrigin: 'https://console.example.com',
    // Reports-assistant knobs live in EnvConfig, not in stack props (ADR-033 wiring note): a
    // prop nothing passes is a knob no operator can reach, so the override goes through the
    // same path `bin/lca.ts` uses for `-c reportsNl=` / `-c reportsModel=`.
    config: envConfig(envName, over),
  });
}

/** ControlStack template — home of the App-config broker (ADR-034). */
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
    config: envConfig('test'),
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

test('mgmt λ Put/Delete cannot reach a run row (no forged runs, no history loss)', () => {
  const t = synth();
  const actions = allActions(t);
  // `BatchWriteItem` stays forbidden outright: it is a multi-row write with no `LeadingKeys`
  // scoping in the handler's vocabulary, and nothing needs it.
  assert.equal(actions.includes('dynamodb:BatchWriteItem'), false, 'granted BatchWriteItem');
  assert.ok(actions.includes('dynamodb:UpdateItem'), 'config patches require UpdateItem');

  // Put/Delete ARE granted, for custom-flavor rows (ADR-040) — the one entity the Mgmt API
  // creates and destroys. What must remain true is that they cannot address a RUN row: run
  // history is what Reports, cost and failure-rate aggregation are computed from, so a forged or
  // deleted run is the failure this test exists to prevent.
  const stmts = [];
  for (const policy of Object.values(t.findResources('AWS::IAM::Policy'))) {
    stmts.push(...policy.Properties.PolicyDocument.Statement);
  }
  const writeStmts = stmts.filter((s) => {
    const a = Array.isArray(s.Action) ? s.Action : [s.Action];
    return a.includes('dynamodb:PutItem') || a.includes('dynamodb:DeleteItem');
  });
  assert.equal(writeStmts.length, 1, 'exactly one statement may grant Put/Delete');
  const keys = writeStmts[0].Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];
  assert.deepEqual(
    keys,
    ['INSTALL#*'],
    'flavor writes must be confined to installation partitions, so a RUN# row is unaddressable',
  );
  // The scoping is only meaningful if a run row genuinely lives outside that prefix.
  assert.equal(
    runPk(1, 2, 3).startsWith('INSTALL#'),
    false,
    'run rows must not share the granted partition prefix',
  );
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

test('mgmt λ holds NO ssm:PutParameter — config writes go through the broker (ADR-034)', () => {
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

// ---- App-config broker posture (ADR-034) -----------------------------------
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
    'dynamodb:Scan',
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

test("the broker's DynamoDB access is scoped to CONFIG# leading keys", () => {
  // It writes audit rows + the config lock + the shared status-cache row, and READS that cache
  // row. Without a LeadingKeys condition an UpdateItem/GetItem grant on the whole table could
  // patch run rows or read installation config.
  const t = synthControl();
  const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify(p.Properties.Roles ?? '').includes('AppConfigFnServiceRole'),
  );
  const stmts = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
  const ddb = stmts.find((s) => JSON.stringify(s.Action).includes('dynamodb:UpdateItem'));
  assert.ok(ddb, 'broker has no DynamoDB write grant');
  const actions = Array.isArray(ddb.Action) ? ddb.Action : [ddb.Action];
  assert.ok(actions.includes('dynamodb:GetItem'), 'broker cannot read the shared status cache');
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
