// The flavor store's DOCUMENT-CLIENT MARSHALLING contract (ADR-041 live-defect regression).
//
// Every other flavor-store test fakes `send` and therefore asserts on the command INPUT — which is
// exactly the layer above the defect this file exists for. On 2026-08-20 a live validation run of
// `custom-brokenagent` produced a verdict and then failed to store it:
//
//   Pass options.removeUndefinedValues=true to remove undefined values from map/array/set.
//
// The evidence map is assembled from OBSERVATIONS, and an observation that was never made is
// `undefined` — a run whose job never concluded has no `workflowConclusion`. The document client
// refused the whole write, and because the refusal happened INSIDE the orchestrator's verdict write
// it also defeated the `pending` fallback: the row was stranded in `validating`, which nothing but a
// manual re-validate can leave. That violates the card's "never leave a row in `validating`"
// requirement, and no test could see it because no test marshalled anything.
//
// So this file intercepts at the HTTP handler instead: everything above it — the document client's
// marshalling included — has really run, and the assertion is on the DynamoDB wire bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TABLE_NAME = 'lca-test-table';
process.env.AWS_REGION = 'us-west-2';
// Static dummies: the request never leaves the process, but the signer still demands credentials.
process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const store = await import('../dist/src/shared/flavor-store.js');
const { NodeHttpHandler } = await import('@smithy/node-http-handler');
const { Readable } = await import('node:stream');

/** Capture the marshalled request bodies DynamoDB would have received. */
function interceptWire() {
  const bodies = [];
  const original = NodeHttpHandler.prototype.handle;
  NodeHttpHandler.prototype.handle = async function (req) {
    bodies.push(JSON.parse(req.body));
    return {
      response: {
        statusCode: 200,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
        body: Readable.from([Buffer.from('{}')]),
      },
    };
  };
  return { bodies, restore: () => (NodeHttpHandler.prototype.handle = original) };
}

test('a verdict whose evidence has UNMADE observations still writes', async () => {
  // The exact live shape: the job never concluded, so `workflowConclusion` is absent. Before the
  // fix this threw, the verdict was lost and the row stayed `validating`.
  const w = interceptWire();
  let wrote;
  try {
    wrote = await store.transitionFlavorValidation({
      installationId: 42,
      name: 'custom-brokenagent',
      to: 'invalid',
      reason: 'smoke run failed: the Actions runner never registered with GitHub',
      evidence: {
        imageArn: 'arn:aws:lambda:us-west-2:123456789012:microvm-image:broken',
        microvmId: 'microvm-1',
        startedAt: '2026-08-20T22:45:14.000Z',
        finishedAt: '2026-08-20T22:54:30.000Z',
        workflowConclusion: undefined,
        workflowRunId: undefined,
        runnerId: undefined,
        selfTerminated: false,
      },
    });
  } finally {
    w.restore();
  }

  assert.equal(wrote, true);
  const evidence = w.bodies[0]?.ExpressionAttributeValues?.[':evidence'];
  // An absent observation is DROPPED, not stored as null: the field is optional on
  // `FlavorValidationEvidence`, so its absence and its emptiness are the same fact — whereas
  // failing the write loses the verdict entirely.
  assert.deepEqual(Object.keys(evidence.M).sort(), [
    'finishedAt',
    'imageArn',
    'microvmId',
    'selfTerminated',
    'startedAt',
  ]);
  // A FALSE observation is a real observation and must survive: `selfTerminated: false` is the
  // difference between "the VM leaked" and "we never looked".
  assert.deepEqual(evidence.M.selfTerminated, { BOOL: false });
});

test('a fully-observed verdict marshals every field', async () => {
  const w = interceptWire();
  try {
    await store.transitionFlavorValidation({
      installationId: 42,
      name: 'custom-good',
      to: 'valid',
      reason: 'smoke run passed',
      evidence: {
        imageArn: 'arn:aws:lambda:us-west-2:123456789012:microvm-image:good',
        microvmId: 'microvm-2',
        runnerId: 777,
        workflowRunId: 9001,
        workflowConclusion: 'success',
        selfTerminated: true,
        startedAt: '2026-08-23T00:00:00.000Z',
        finishedAt: '2026-08-23T00:03:00.000Z',
      },
    });
  } finally {
    w.restore();
  }

  const evidence = w.bodies[0]?.ExpressionAttributeValues?.[':evidence'];
  assert.deepEqual(evidence.M.workflowConclusion, { S: 'success' });
  assert.deepEqual(evidence.M.selfTerminated, { BOOL: true });
  assert.deepEqual(evidence.M.runnerId, { N: '777' });
  assert.deepEqual(evidence.M.workflowRunId, { N: '9001' });
});

test('a `from`-restricted release can only leave validating — a landed verdict is never overwritten', async () => {
  // The smoke λ's last line of defence: after a verdict write that did not answer, it releases the
  // row to `pending`. Without `from` the state machine would also accept `valid|invalid → pending`,
  // so a verdict that landed after all would be silently reset. The guard must be IN the condition
  // expression — a read-then-write could race the late verdict.
  const w = interceptWire();
  try {
    await store.transitionFlavorValidation({
      installationId: 42,
      name: 'custom-good',
      to: 'pending',
      from: ['validating'],
      reason: 'verdict write failed',
    });
  } finally {
    w.restore();
  }
  const req = w.bodies[0];
  const fromValues = Object.entries(req.ExpressionAttributeValues)
    .filter(([k]) => k.startsWith(':from'))
    .map(([, v]) => v.S);
  assert.deepEqual(fromValues, ['validating']);
  // And the pre-field-row allowance (`attribute_not_exists(#state)`) is gone: that branch means
  // "treat as pending", which is not a source this release may write from.
  assert.doesNotMatch(req.ConditionExpression, /attribute_not_exists\(#state\)/);
});

test('a transition hands its AbortSignal to the HTTP layer, where the SDK honours it', async () => {
  // The signal is what lets the smoke λ's `bounded` effect actually drop the request rather than
  // merely stop waiting for it. The node HTTP handler is the layer that acts on `abortSignal`, so
  // the assertion is that the caller's signal arrives THERE, through the document client's
  // middleware stack, rather than being dropped on the way.
  const original = NodeHttpHandler.prototype.handle;
  let seen;
  NodeHttpHandler.prototype.handle = async function (_req, opts) {
    seen = opts?.abortSignal;
    return {
      response: {
        statusCode: 200,
        headers: { 'content-type': 'application/x-amz-json-1.0' },
        body: Readable.from([Buffer.from('{}')]),
      },
    };
  };
  const ctl = new AbortController();
  try {
    await store.transitionFlavorValidation(
      { installationId: 42, name: 'custom-good', to: 'pending' },
      ctl.signal,
    );
  } finally {
    NodeHttpHandler.prototype.handle = original;
  }
  assert.equal(seen, ctl.signal);
});

// ---- run ownership (review finding 1794540192020-d27a17:2) ------------------
//
// A timed-out claim can still land AFTER the run released the row. The fence against that lives in
// these condition expressions, so they are pinned on the wire rather than only in the orchestrator's
// row model.

test('the claim stamps a run token + lease and refuses a fenced token', async () => {
  const w = interceptWire();
  try {
    await store.claimFlavorValidation({
      installationId: 42,
      name: 'custom-good',
      runId: 'run-a',
      leaseUntil: 1_700_000_900_000,
      now: new Date(1_700_000_000_000),
    });
  } finally {
    w.restore();
  }
  const req = w.bodies[0];
  assert.match(req.UpdateExpression, /validationRunId = :runId/);
  assert.match(req.UpdateExpression, /validationLeaseUntil = :lease/);
  assert.deepEqual(req.ExpressionAttributeValues[':runId'], { S: 'run-a' });
  // A fenced token can never claim: this is what stops a late-landing claim stranding the row.
  assert.match(req.ConditionExpression, /fencedRunId <> :runId/);
  // Only from pending — or from a validating claim whose lease has EXPIRED (its λ is gone).
  assert.match(req.ConditionExpression, /#state = :pending/);
  assert.match(req.ConditionExpression, /validationLeaseUntil < :nowMs/);
  assert.deepEqual(req.ExpressionAttributeValues[':nowMs'], { N: '1700000000000' });
  assert.match(req.ConditionExpression, /attribute_exists\(pk\)/);
});

test('the fence records the token and nothing else', async () => {
  const w = interceptWire();
  try {
    await store.fenceFlavorValidationRun({ installationId: 42, name: 'custom-good', runId: 'run-a' });
  } finally {
    w.restore();
  }
  const req = w.bodies[0];
  assert.equal(req.UpdateExpression, 'SET fencedRunId = :runId');
  assert.deepEqual(req.ExpressionAttributeValues[':runId'], { S: 'run-a' });
});

test('a run-owned verdict requires the token, and every transition drops ownership', async () => {
  const w = interceptWire();
  try {
    await store.transitionFlavorValidation({
      installationId: 42,
      name: 'custom-good',
      to: 'valid',
      runId: 'run-a',
      reason: 'smoke run passed',
    });
    // An operator re-validate (no token) must also end any run's ownership, so a stale verdict from
    // that run is refused afterwards.
    await store.transitionFlavorValidation({ installationId: 42, name: 'custom-good', to: 'pending' });
  } finally {
    w.restore();
  }
  const [owned, operator] = w.bodies;
  assert.match(owned.ConditionExpression, /AND validationRunId = :runId$/);
  assert.deepEqual(owned.ExpressionAttributeValues[':runId'], { S: 'run-a' });
  for (const req of [owned, operator]) {
    assert.match(req.UpdateExpression, /REMOVE .*validationRunId, validationLeaseUntil/);
  }
  assert.doesNotMatch(operator.ConditionExpression, /validationRunId/);
});
