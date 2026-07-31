// Custom metrics (EMF) + quota detection — spec 05 § Observability, ADR-032.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRIC_NAMESPACE,
  emfPayload,
  isQuotaError,
} from '../dist/src/shared/metrics.js';

test('EMF payload carries the namespace, unit and value', () => {
  const p = emfPayload(
    [{ name: 'ProvisionLatency', value: 1234, unit: 'Milliseconds' }],
    { env: 'dev', flavor: 'base', via: 'label' },
    {},
    1700000000000,
  );
  const meta = p._aws.CloudWatchMetrics[0];
  assert.equal(meta.Namespace, METRIC_NAMESPACE);
  assert.deepEqual(meta.Metrics, [{ Name: 'ProvisionLatency', Unit: 'Milliseconds' }]);
  assert.equal(p.ProvisionLatency, 1234);
  assert.equal(p._aws.Timestamp, 1700000000000);
});

test('an env-only dimension set is published so alarms have something to read', () => {
  // CloudWatch does not aggregate across dimensions: an alarm on {env} would sit at
  // INSUFFICIENT_DATA forever if only {env,flavor,via} were published.
  const p = emfPayload([{ name: 'QuotaThrottles', value: 1, unit: 'Count' }], {
    env: 'prod',
    flavor: 'docker',
    via: 'adopt',
  });
  const sets = p._aws.CloudWatchMetrics[0].Dimensions;
  assert.deepEqual(sets, [['env', 'flavor', 'via'], ['env']]);
});

test('a single-dimension datum publishes exactly one set (no duplicate)', () => {
  const p = emfPayload([{ name: 'RunsQueued', value: 1, unit: 'Count' }], { env: 'dev' });
  assert.deepEqual(p._aws.CloudWatchMetrics[0].Dimensions, [['env']]);
});

test('undefined/empty dimensions are dropped', () => {
  const p = emfPayload([{ name: 'X', value: 1 }], { env: 'dev', flavor: undefined, kind: '' });
  assert.deepEqual(p._aws.CloudWatchMetrics[0].Dimensions[0], ['env']);
  assert.equal('flavor' in p, false);
  assert.equal('kind' in p, false);
});

test('high-cardinality context rides as properties, never dimensions', () => {
  const p = emfPayload(
    [{ name: 'ProvisionFailures', value: 1, unit: 'Count' }],
    { env: 'dev', flavor: 'base', via: 'label', kind: 'quota' },
    { repo: 'acme/service', runId: 42, jobId: 99 },
  );
  const dims = p._aws.CloudWatchMetrics[0].Dimensions.flat();
  for (const key of ['repo', 'runId', 'jobId']) {
    assert.equal(dims.includes(key), false, `${key} must not be a dimension`);
    assert.ok(key in p, `${key} must still be queryable as a property`);
  }
});

test('throttle / quota errors are detected across SDK shapes', () => {
  assert.ok(isQuotaError({ name: 'ThrottlingException' }));
  assert.ok(isQuotaError({ name: 'TooManyRequestsException' }));
  assert.ok(isQuotaError({ name: 'ServiceQuotaExceededException' }));
  assert.ok(isQuotaError({ message: 'Rate exceeded: limit exceeded for RunMicrovm' }));
  assert.ok(isQuotaError({ $metadata: { httpStatusCode: 429 } }));
});

test('ordinary failures are not misreported as quota throttles', () => {
  assert.equal(isQuotaError(new Error('ValidationException: bad image arn')), false);
  assert.equal(isQuotaError({ name: 'AccessDeniedException' }), false);
  assert.equal(isQuotaError(undefined), false);
});
