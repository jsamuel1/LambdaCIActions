// Flavor-validation λ infrastructure (ADR-041) — the deploy-touching half of custom flavors.
//
// These assert the SYNTHESIZED template, because every property here is one that unit tests and a
// green `cdk synth` cannot see. The predecessor card learned this the expensive way: the Mgmt
// custom-flavor routes were fully unit-tested through injected seams and would have failed at
// runtime with `AccessDeniedException`, because the role had no `PutItem`. So the checks below are
// specifically the ones whose absence is invisible until a deployed operator hits them:
//
//   - the λ can actually launch, observe and terminate a microVM, and probe an image;
//   - the Mgmt λ can INVOKE it (without which registration silently stays `pending` forever)
//     and still cannot do any of those things itself;
//   - the smoke VM's logs go to their OWN group, not the customer-facing run group;
//   - the λ's own deadline is inside its Lambda timeout, so a verdict is always written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../dist/lib/data-stack.js';
import { ControlStack } from '../dist/lib/control-stack.js';
import { MgmtStack } from '../dist/lib/mgmt-stack.js';
import { envConfig } from '../dist/lib/env-config.js';
import { DEFAULT_ORCHESTRATOR_CONFIG } from '../dist/src/flavorval/orchestrate.js';

const ENV = { account: '123456789012', region: 'us-west-2' };

function controlStack(envName = 'test') {
  const app = new App();
  const data = new DataStack(app, 'Data', { env: ENV, envName, ssmPrefix: `/lca/${envName}` });
  const control = new ControlStack(app, 'Control', {
    env: ENV,
    envName,
    ssmPrefix: `/lca/${envName}`,
    tagPrefix: 'lca',
    table: data.table,
    config: envConfig(envName),
  });
  return { control, template: Template.fromStack(control) };
}

/** The flavorval function's synthesized properties, found by its function name. */
function flavorvalFn(template, envName = 'test') {
  const fns = Object.values(template.findResources('AWS::Lambda::Function')).filter(
    (f) => f.Properties.FunctionName === `lca-${envName}-flavorval`,
  );
  assert.equal(fns.length, 1, 'exactly one flavorval function');
  return fns[0].Properties;
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

test('the flavor-validation λ exists, arm64 on Node 22', () => {
  const { template } = controlStack();
  const fn = flavorvalFn(template);
  assert.deepEqual(fn.Architectures, ['arm64']);
  assert.equal(fn.Runtime, 'nodejs22.x');
});

test('ControlStack publishes the flavorval coordinates for MgmtStack', () => {
  const { control, template } = controlStack();
  // The props are CDK tokens before synth, so assert they exist here and that the SYNTHESIZED
  // function carries the expected name — the `Ref` in the output resolves to exactly that, and
  // `bin/lca.ts` threads the same token into MgmtStack.
  assert.ok(control.flavorvalFunctionName);
  assert.ok(control.flavorvalFunctionArn);
  assert.equal(flavorvalFn(template).FunctionName, 'lca-test-flavorval');
  const outputs = template.toJSON().Outputs ?? {};
  assert.ok(outputs.FlavorValFunctionName, 'the function name must be a stack output');
});

test('the λ deadline is inside its Lambda timeout, so a verdict is always written', () => {
  // A λ killed by its own timeout writes nothing and strands the row in `validating` — inert until
  // an operator re-validates. The orchestrator therefore stops polling with a reserve remaining,
  // and that only helps if the configured deadline is genuinely below the function timeout.
  const { template } = controlStack();
  const fn = flavorvalFn(template);
  const deadlineMs = Number(fn.Environment.Variables.FLAVORVAL_DEADLINE_MS);
  assert.ok(Number.isFinite(deadlineMs) && deadlineMs > 0, 'FLAVORVAL_DEADLINE_MS must be set');
  assert.ok(
    deadlineMs + DEFAULT_ORCHESTRATOR_CONFIG.reserveMs < fn.Timeout * 1000,
    `deadline ${deadlineMs}ms + reserve must fit inside the ${fn.Timeout}s function timeout`,
  );
});

test('the λ is capped at one concurrent smoke run — it spends the same quota as real jobs', () => {
  // A smoke run launches a real microVM against the region's microVM memory quota, so an operator
  // bulk-registering flavors must not be able to starve customer jobs of capacity.
  const { template } = controlStack();
  assert.equal(flavorvalFn(template).ReservedConcurrentExecutions, 1);
});

test('the λ can launch, observe and terminate a microVM, and probe an image', () => {
  const { template } = controlStack();
  // Each of these is a step the orchestrator performs unconditionally on the happy path; a missing
  // grant fails at runtime only, long after synth and unit tests are green.
  for (const action of [
    'lambda:RunMicrovm',
    'lambda:ListMicrovms',
    'lambda:TerminateMicrovm',
    'lambda:GetMicrovmImage',
    'iam:PassRole',
    'lambda:PassNetworkConnector',
  ]) {
    assert.ok(
      statementsWith(template, action).length > 0,
      `flavorval needs ${action} — the orchestrator calls it on the happy path`,
    );
  }
});

test('the λ reads the App PEM (it mints a real JIT runner) but no other secret', () => {
  const { template } = controlStack();
  const stmts = statementsWith(template, 'ssm:GetParameter').filter(
    (s) => s.Sid === 'ReadAppCredentialsForValidation',
  );
  assert.equal(stmts.length, 1);
  const resources = JSON.stringify(stmts[0].Resource);
  assert.match(resources, /github\/app-id/);
  assert.match(resources, /github\/app-pem/);
  // Notably absent: the session secret (forging it forges operator sessions), the OAuth client
  // secret, and the webhook secret. Validation needs none of them.
  assert.doesNotMatch(resources, /session-secret/);
  assert.doesNotMatch(resources, /client-secret/);
  assert.doesNotMatch(resources, /webhook-secret/);
});

test('the λ never gains ssm:PutParameter — validation writes a row, not config', () => {
  const { template } = controlStack();
  const puts = statementsWith(template, 'ssm:PutParameter');
  // The appcfg broker (ADR-034) is the platform's ONLY PutParameter grant. Adding a second one
  // here would put an image-ARN / allowlist write in reach of the validation path, whose whole
  // contract is that it records evidence and nothing else.
  for (const stmt of puts) {
    assert.equal(
      stmt.Sid,
      'WriteAppCredentials',
      'only the appcfg broker may hold ssm:PutParameter',
    );
  }
});

test('the smoke VM logs to its own group, not the customer-facing run group', () => {
  const { template } = controlStack();
  const group = flavorvalFn(template).Environment.Variables.SMOKE_LOG_GROUP;
  assert.equal(group, '/aws/lambda/microvms/validate/lca-test');
  // A validation attempt is not a customer job, and the console's log pane reads the run group by
  // run id — a smoke stream in there would be un-attributable output in a customer-facing view.
  assert.notEqual(group, '/aws/lambda/microvms/runs/lca-test');
  // Retention is set, so the group is not left NEVER_EXPIRE by the launch path (ADR-033).
  const retentions = Object.values(template.findResources('Custom::LogRetention')).map(
    (r) => r.Properties.LogGroupName,
  );
  assert.ok(
    retentions.includes('/aws/lambda/microvms/validate/lca-test'),
    'the validate log group needs a retention policy',
  );
});

test('the λ is wired to the broker and exec role the guest contract needs', () => {
  const { template } = controlStack();
  const env = flavorvalFn(template).Environment.Variables;
  // Without HOOK_BROKER_NAME the launched VM's /run hook 400s on a missing pointer and the VM
  // strands — after a single-use JIT config was already consumed (ADR-021).
  assert.ok(env.HOOK_BROKER_NAME, 'HOOK_BROKER_NAME must be set');
  assert.ok(env.RUNNER_ROLE_ARN, 'RUNNER_ROLE_ARN must be set');
  assert.ok(env.TABLE_NAME, 'TABLE_NAME must be set');
  assert.ok(env.APP_PEM_PARAM, 'APP_PEM_PARAM must be set');
});

// ---- the Mgmt side of the seam ---------------------------------------------

function mgmtTemplate(withFlavorval = true) {
  const app = new App();
  const data = new DataStack(app, 'Data', { env: ENV, envName: 'test', ssmPrefix: '/lca/test' });
  const mgmt = new MgmtStack(app, 'Mgmt', {
    env: ENV,
    envName: 'test',
    ssmPrefix: '/lca/test',
    table: data.table,
    config: envConfig('test'),
    ...(withFlavorval
      ? {
          flavorvalFunctionName: 'lca-test-flavorval',
          flavorvalFunctionArn: 'arn:aws:lambda:us-west-2:123456789012:function:lca-test-flavorval',
        }
      : {}),
  });
  return Template.fromStack(mgmt);
}

test('the Mgmt λ receives the flavorval name and may invoke exactly that ARN', () => {
  const t = mgmtTemplate();
  // Without the env var, `triggerFlavorValidation` returns false and every registration reports
  // that validation could not be started — nothing ever reaches `valid`.
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { FLAVORVAL_FUNCTION_NAME: 'lca-test-flavorval' } },
  });
  const invokes = statementsWith(t, 'lambda:InvokeFunction').filter(
    (s) => s.Sid === 'InvokeFlavorValidation',
  );
  assert.equal(invokes.length, 1);
  assert.equal(
    invokes[0].Resource,
    'arn:aws:lambda:us-west-2:123456789012:function:lca-test-flavorval',
  );
});

test('invoking the validator does NOT give the Mgmt λ the validator’s authority', () => {
  // The whole reason validation lives in the control plane (mirroring ADR-034): the console can
  // ASK for a smoke run and nothing more.
  const actions = allActions(mgmtTemplate());
  for (const forbidden of [
    'lambda:RunMicrovm',
    'lambda:TerminateMicrovm',
    'lambda:ListMicrovms',
    'lambda:GetMicrovmImage',
    'iam:PassRole',
  ]) {
    assert.equal(actions.includes(forbidden), false, `Mgmt must not hold ${forbidden}`);
  }
});

test('an unwired validator is a supported state, not a broken template', () => {
  // Deploy ordering: MgmtStack must synth before ControlStack has ever been deployed. Absent means
  // registration stays `pending` and says so — nothing custom becomes routable, which is safe.
  const t = mgmtTemplate(false);
  t.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { FLAVORVAL_FUNCTION_NAME: '' } },
  });
  assert.equal(
    statementsWith(t, 'lambda:InvokeFunction').filter((s) => s.Sid === 'InvokeFlavorValidation')
      .length,
    0,
  );
});
