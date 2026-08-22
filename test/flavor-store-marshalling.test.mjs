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
