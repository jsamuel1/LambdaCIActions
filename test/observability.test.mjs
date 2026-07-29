// Per-env config + M5 infra posture (ADR-032 observability, ADR-033 dev/prod separation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ControlStack } from '../dist/lib/control-stack.js';
import { DataStack } from '../dist/lib/data-stack.js';
import { envConfig } from '../dist/lib/env-config.js';

function synth(envName, overrides = {}) {
  const app = new App();
  const env = { account: '111122223333', region: 'us-west-2' };
  const data = new DataStack(app, `LCA-Data-${envName}`, { env, envName, ssmPrefix: `/lca/${envName}` });
  const control = new ControlStack(app, `LCA-Control-${envName}`, {
    env,
    envName,
    ssmPrefix: `/lca/${envName}`,
    tagPrefix: 'lca',
    table: data.table,
    config: envConfig(envName, overrides),
  });
  return Template.fromStack(control);
}

test('prod hardens retention and retains log groups; dev stays cheap', () => {
  const prod = envConfig('prod');
  const dev = envConfig('dev');
  assert.equal(prod.isProd, true);
  assert.equal(dev.isProd, false);
  assert.equal(prod.logRemovalPolicy, RemovalPolicy.RETAIN);
  assert.equal(dev.logRemovalPolicy, RemovalPolicy.DESTROY);
  assert.ok(prod.runRetentionDays > dev.runRetentionDays);
  assert.ok(prod.provisionConcurrency >= dev.provisionConcurrency);
  assert.ok(prod.provisionFailureThreshold <= dev.provisionFailureThreshold);
});

test('an unknown env name gets the dev shape, not prod', () => {
  const sandbox = envConfig('jsam-sandbox');
  assert.equal(sandbox.isProd, false);
  assert.equal(sandbox.logRemovalPolicy, RemovalPolicy.DESTROY);
});

test('auto-rewrite is OFF by default in every environment', () => {
  // contents:write is off by default (AGENTS.md hard rule) — including prod.
  assert.equal(envConfig('dev').rewriteEnabled, false);
  assert.equal(envConfig('prod').rewriteEnabled, false);
  assert.equal(envConfig('prod', { rewriteEnabled: true }).rewriteEnabled, true);
});

test('the rewrite \u03bb ships disabled unless explicitly enabled', () => {
  const off = synth('test');
  off.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'lca-test-rewrite',
    Environment: { Variables: Match.objectLike({ REWRITE_ENABLED: 'false' }) },
  });
  const on = synth('test', { rewriteEnabled: true });
  on.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'lca-test-rewrite',
    Environment: { Variables: Match.objectLike({ REWRITE_ENABLED: 'true' }) },
  });
});

test('the rewrite \u03bb cannot write our own table (it writes the customer repo, not our data)', () => {
  const t = synth('test', { rewriteEnabled: true });
  const roleId = Object.entries(t.findResources('AWS::IAM::Role')).find(([id]) =>
    id.startsWith('RewriteFnServiceRole'),
  )?.[0];
  assert.ok(roleId, 'rewrite role must exist');
  const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify(p.Properties?.Roles ?? []).includes(roleId),
  );
  const actions = JSON.stringify(policies);
  for (const forbidden of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']) {
    assert.equal(actions.includes(forbidden), false, `${forbidden} must not be granted`);
  }
  // …and it must not be able to launch compute either.
  assert.equal(actions.includes('lambda:RunMicrovm'), false);
});

test('X-Ray active tracing is on for the hot path', () => {
  const t = synth('test');
  for (const fn of ['lca-test-ingest', 'lca-test-provision']) {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: fn,
      TracingConfig: { Mode: 'Active' },
    });
  }
});

test('every DLQ and the custom quota/failure metrics are alarmed', () => {
  const t = synth('test');
  const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')).map(
    (a) => a.Properties?.AlarmName,
  );
  for (const name of [
    'lca-test-provision-dlq-depth',
    'lca-test-discovery-dlq-depth',
    // A rewrite request that DLQs means an operator's requested PR never opened, and nothing
    // else surfaces it: the λ writes to GitHub, not to a run row or a queue we watch.
    'lca-test-rewrite-dlq-depth',
    'lca-test-quota-throttles',
    'lca-test-provision-failures',
    'lca-test-provision-backlog-age',
  ]) {
    assert.ok(alarms.includes(name), `missing alarm ${name}`);
  }
});

test('per-λ error alarms carry a literal, runbook-matching name', () => {
  // Regression guard: the names were built from `fn.functionName`, which is a CloudFormation
  // token, so the deployed alarms were called `lca-test-lca-test-ingest-errors` — a name no
  // runbook lookup or `describe-alarms --alarm-names` call could ever find.
  const alarms = Object.values(synth('test').findResources('AWS::CloudWatch::Alarm')).map(
    (a) => a.Properties?.AlarmName,
  );
  for (const name of [
    'lca-test-ingest-errors',
    'lca-test-provision-errors',
    'lca-test-hook-broker-errors',
    'lca-test-reaper-errors',
  ]) {
    assert.ok(alarms.includes(name), `missing alarm ${name} (got ${JSON.stringify(alarms)})`);
  }
  for (const name of alarms) {
    assert.equal(typeof name, 'string', `alarm name must be a literal, got ${JSON.stringify(name)}`);
  }
});

test('custom-metric alarms bind to the env-only dimension the emitter publishes', () => {
  const t = synth('test');
  const quota = Object.values(t.findResources('AWS::CloudWatch::Alarm')).find(
    (a) => a.Properties?.AlarmName === 'lca-test-quota-throttles',
  );
  assert.equal(quota.Properties.Namespace, 'LambdaCIActions');
  assert.equal(quota.Properties.MetricName, 'QuotaThrottles');
  assert.deepEqual(quota.Properties.Dimensions, [{ Name: 'env', Value: 'test' }]);
});

test('alarms do not fire on an idle platform', () => {
  const t = synth('test');
  for (const alarm of Object.values(t.findResources('AWS::CloudWatch::Alarm'))) {
    assert.equal(
      alarm.Properties.TreatMissingData,
      'notBreaching',
      `${alarm.Properties.AlarmName} must treat missing data as OK`,
    );
  }
});

test('every alarm publishes to the env alarm topic', () => {
  const t = synth('test');
  const topicId = Object.keys(t.findResources('AWS::SNS::Topic'))[0];
  assert.ok(topicId);
  for (const alarm of Object.values(t.findResources('AWS::CloudWatch::Alarm'))) {
    assert.ok(
      JSON.stringify(alarm.Properties.AlarmActions ?? []).includes(topicId),
      `${alarm.Properties.AlarmName} has no alarm action`,
    );
  }
});

test('the alarm topic has no subscription unless an email was supplied', () => {
  assert.equal(Object.keys(synth('test').findResources('AWS::SNS::Subscription')).length, 0);
  const withEmail = synth('test', { alarmEmail: 'oncall@example.com' });
  withEmail.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email',
    Endpoint: 'oncall@example.com',
  });
});

test('provision concurrency follows the env config (quota protection)', () => {
  synth('prod').hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'lca-prod-provision',
    ReservedConcurrentExecutions: envConfig('prod').provisionConcurrency,
  });
});

test('run-row TTL is driven by the env config, not hardcoded', async () => {
  // Regression guard: env-config documented dev=30/prod=90 while run-store hardcoded 90, so
  // dev retained run history three times longer than the spec table claimed.
  const { terminalTtlSeconds, DEFAULT_RUN_RETENTION_DAYS } = await import(
    '../dist/src/shared/run-store.js'
  );
  const prev = process.env.RUN_RETENTION_DAYS;
  try {
    process.env.RUN_RETENTION_DAYS = '30';
    assert.equal(terminalTtlSeconds(), 30 * 24 * 60 * 60);
    process.env.RUN_RETENTION_DAYS = '90';
    assert.equal(terminalTtlSeconds(), 90 * 24 * 60 * 60);
    // Unset / malformed values fall back rather than shortening retention silently.
    for (const bogus of [undefined, '', '0', 'abc', '-5']) {
      if (bogus === undefined) delete process.env.RUN_RETENTION_DAYS;
      else process.env.RUN_RETENTION_DAYS = bogus;
      assert.equal(terminalTtlSeconds(), DEFAULT_RUN_RETENTION_DAYS * 24 * 60 * 60);
    }
  } finally {
    if (prev === undefined) delete process.env.RUN_RETENTION_DAYS;
    else process.env.RUN_RETENTION_DAYS = prev;
  }
});

test('every run-row writer gets the same RUN_RETENTION_DAYS', () => {
  // If the writers disagreed, a row's retention would depend on which λ wrote it last.
  const t = synth('prod');
  const expected = String(envConfig('prod').runRetentionDays);
  for (const fn of ['lca-prod-ingest', 'lca-prod-provision', 'lca-prod-reaper']) {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: fn,
      Environment: { Variables: Match.objectLike({ RUN_RETENTION_DAYS: expected }) },
    });
  }
});

test('the per-run microVM log group gets the env retention WITHOUT being re-created', () => {
  // The microVM exec role may CreateLogGroup, so every env deployed before M5 ALREADY has
  // `/aws/lambda/microvms/runs/lca-<env>` — the launch path made it. Declaring it as an
  // AWS::Logs::LogGroup would fail the ControlStack update with ResourceAlreadyExistsException
  // and roll M5 back, i.e. M5 would be undeployable to dev without deleting live job logs by
  // hand. `LogRetention` sets the policy and adopts an existing group, which is what we need;
  // without any policy the group sits at NEVER_EXPIRE and the documented retention is fiction.
  for (const [envName, expected] of [
    ['prod', 30],
    ['test', 14],
  ]) {
    const t = synth(envName);
    const created = Object.values(t.findResources('AWS::Logs::LogGroup')).map(
      (g) => g.Properties?.LogGroupName,
    );
    assert.equal(
      created.includes(`/aws/lambda/microvms/runs/lca-${envName}`),
      false,
      'the run log group must not be a CREATE-ed LogGroup resource',
    );
    t.hasResourceProperties('Custom::LogRetention', {
      LogGroupName: `/aws/lambda/microvms/runs/lca-${envName}`,
      RetentionInDays: expected,
    });
    assert.equal(expected, envConfig(envName).runLogRetention);
  }
});
