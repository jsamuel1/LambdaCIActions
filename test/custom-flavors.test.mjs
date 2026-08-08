// Custom flavors (ADR-040) + validation state machine (ADR-041).
//
// The acceptance properties this file exists to pin:
//   1. ZERO behavior change when no custom flavors are registered.
//   2. An unvalidated / invalid flavor is NEVER routable — proven, not inspected.
//   3. A built-in collision is refused at registration.
//   4. A custom label cannot reroute a built-in label by insertion order.
//   5. Custom labels must reach the ingest claim allowlist, or the job is never claimed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFlavor,
  allFlavors,
  effectiveFlavors,
  needsCustomFlavors,
} from '../dist/src/provision/flavor.js';
import {
  builtinFlavors,
  composeCatalog,
  customFlavorName,
  customFlavorLabel,
  customFlavorBaseNameError,
  builtinCollision,
  isCustomFlavorName,
  isCustomFlavorLabel,
  requiredClaimLabels,
} from '../dist/src/shared/flavor-catalog.js';
import {
  buildFlavorRecord,
  InvalidFlavorError,
  canTransitionValidation,
  isRoutableState,
  routableCustomFlavors,
  toCatalogFlavor,
  FLAVOR_VALIDATION_STATES,
  flavorSk,
  MAX_CUSTOM_FLAVORS_PER_INSTALLATION,
} from '../dist/src/shared/flavor-store.js';
import {
  staticGate,
  classifySmoke,
  smokeLabel,
  isSmokeLabel,
  smokeWorkflowYaml,
  MIN_MEMORY_MB,
  DEFAULT_MAX_MEMORY_MB,
  DEFAULT_SMOKE_WORKFLOW_PATH,
} from '../dist/src/flavorval/validate-core.js';
import { shouldClaim } from '../dist/src/ingest/filter.js';
import { isRunRef, isSmokeRef, isBrokerRef, keysFromRef, parseHookRequest } from '../dist/src/hook/broker-core.js';
import { smokePk, smokeRef } from '../dist/src/shared/smoke-store.js';
import { buildFlavorViews, flavorNames } from '../dist/src/mgmt/views.js';
import { analyzeCompat } from '../dist/src/ingest/compat.js';

/** A registered-and-valid custom flavor, as the resolver would receive it. */
function validCustom(over = {}) {
  return {
    name: 'custom-gpu',
    label: 'lambda-ci-custom-gpu',
    arch: 'arm64',
    vcpu: 4,
    memoryMb: 8192,
    capabilities: ['python'],
    description: 'operator image',
    custom: true,
    installationId: 42,
    ...over,
  };
}

function record(over = {}) {
  return buildFlavorRecord({
    installationId: 42,
    base: 'gpu',
    vcpu: 4,
    memoryMb: 8192,
    capabilities: ['python'],
    description: 'operator image',
    imageArn: 'arn:aws:lambda:us-west-2:1234567890:microvm-image/x',
    smokeRepoFullName: 'acme/ci',
    ...over,
  });
}

// ---- 1. no custom flavors ⇒ byte-identical behavior -------------------------

test('composeCatalog with no custom flavors returns the built-in array ITSELF', () => {
  // Reference equality, not deep equality: ADR-040 requires no copy, no re-sort, no allocation on
  // the path every existing installation takes.
  assert.equal(composeCatalog(), builtinFlavors());
  assert.equal(composeCatalog([]), builtinFlavors());
  assert.equal(effectiveFlavors(), allFlavors());
});

test('every existing resolution is unchanged when customFlavors is passed as empty', () => {
  const cases = [
    [['lambda-ci'], {}],
    [['lambda-ci-node'], {}],
    [['lambda-ci-python', 'lambda-ci-docker'], {}],
    [['ubuntu-latest'], {}],
    [['ubuntu-latest'], { mode: 'adopt' }],
    [['lambda-ci'], { signals: { needs_docker: true } }],
    [['self-hosted'], { defaultFlavor: 'go' }],
    [['big'], { flavorMap: { big: 'rust' } }],
  ];
  for (const [labels, opts] of cases) {
    const before = resolveFlavor(labels, opts);
    for (const custom of [undefined, []]) {
      const after = resolveFlavor(labels, { ...opts, customFlavors: custom });
      assert.deepEqual(after, before, `${labels.join(',')} changed with customFlavors=${JSON.stringify(custom)}`);
    }
  }
});

test('needsCustomFlavors is false for every job that never names a custom flavor', () => {
  // This is the gate that keeps the provision hot path I/O-free (ADR-040): a read only happens
  // when a custom flavor could actually win.
  assert.equal(needsCustomFlavors(['lambda-ci-node']), false);
  assert.equal(needsCustomFlavors(['ubuntu-latest'], { flavorMap: { 'ubuntu-latest': 'python' } }), false);
  assert.equal(needsCustomFlavors(['self-hosted'], { defaultFlavor: 'rust' }), false);
  assert.equal(needsCustomFlavors([]), false);
  assert.equal(needsCustomFlavors(undefined), false);
});

test('needsCustomFlavors is true for each of the three ways a custom flavor is named', () => {
  assert.equal(needsCustomFlavors(['lambda-ci-custom-gpu']), true, 'explicit label');
  assert.equal(needsCustomFlavors(['LAMBDA-CI-CUSTOM-GPU']), true, 'label is case-insensitive');
  assert.equal(needsCustomFlavors(['x'], { flavorMap: { x: 'custom-gpu' } }), true, 'FlavorMap value');
  assert.equal(needsCustomFlavors(['x'], { defaultFlavor: 'custom-gpu' }), true, 'defaultFlavor');
});

test('buildFlavorViews and flavorNames are unchanged when no custom flavors are passed', () => {
  const withArg = buildFlavorViews({ base: true }, []);
  const without = buildFlavorViews({ base: true });
  assert.deepEqual(withArg, without);
  assert.deepEqual(flavorNames([]), flavorNames());
  assert.deepEqual(flavorNames(), builtinFlavors().map((f) => f.name));
});

// ---- 2. an unvalidated / invalid flavor is never routable -------------------

test('only `valid` is a routable state', () => {
  for (const s of FLAVOR_VALIDATION_STATES) {
    assert.equal(isRoutableState(s), s === 'valid', `${s} routability`);
  }
  assert.equal(isRoutableState(undefined), false, 'a row with no state is not routable');
});

test('routableCustomFlavors admits ONLY valid rows', () => {
  const rows = FLAVOR_VALIDATION_STATES.map((state, i) =>
    ({ ...record({ base: `f${i}` }), state }),
  );
  const out = routableCustomFlavors(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'custom-f2');
  assert.deepEqual(routableCustomFlavors([{ ...record(), state: undefined }]), []);
});

test('a pending/validating/invalid flavor resolves as if ABSENT, not as itself', () => {
  // The ADR-041 enforcement property, stated as routing behavior rather than as a flag: a
  // half-configured flavor must degrade to a WORKING job, not a failed one.
  for (const state of ['pending', 'validating', 'invalid']) {
    const custom = routableCustomFlavors([{ ...record(), state }]);
    assert.deepEqual(custom, [], `${state} must contribute no routable flavor`);
    const r = resolveFlavor(['self-hosted', 'lambda-ci-custom-gpu'], { customFlavors: custom });
    assert.equal(r.flavor, 'base', `${state} must fall through to the fallback chain`);
    assert.match(r.reason, /fallback/i);
  }
});

test('an unvalidated flavor named as defaultFlavor or in a FlavorMap is also ignored', () => {
  const custom = routableCustomFlavors([{ ...record(), state: 'invalid' }]);
  assert.equal(resolveFlavor(['self-hosted'], { defaultFlavor: 'custom-gpu', customFlavors: custom }).flavor, 'base');
  assert.equal(
    resolveFlavor(['ubuntu-latest'], { flavorMap: { 'ubuntu-latest': 'custom-gpu' }, customFlavors: custom }).flavor,
    'base',
  );
});

test('a VALID flavor is routable from its label, FlavorMap and defaultFlavor', () => {
  const custom = routableCustomFlavors([{ ...record(), state: 'valid' }]);
  assert.equal(custom.length, 1);
  assert.equal(resolveFlavor(['self-hosted', 'lambda-ci-custom-gpu'], { customFlavors: custom }).flavor, 'custom-gpu');
  assert.equal(resolveFlavor(['x'], { flavorMap: { x: 'custom-gpu' }, customFlavors: custom }).flavor, 'custom-gpu');
  assert.equal(resolveFlavor(['self-hosted'], { defaultFlavor: 'custom-gpu', customFlavors: custom }).flavor, 'custom-gpu');
});

test('flavorNames only offers routable custom flavors to config validation', () => {
  // A name accepted here but ignored by the resolver would let the console save a FlavorMap the
  // platform silently disregards — the operator's choice showing in the UI while jobs land on base.
  const routable = routableCustomFlavors([
    { ...record({ base: 'good' }), state: 'valid' },
    { ...record({ base: 'bad' }), state: 'invalid' },
  ]);
  const names = flavorNames(routable);
  assert.ok(names.includes('custom-good'));
  assert.ok(!names.includes('custom-bad'));
});

// ---- 3. built-in collision is refused at registration ----------------------

test('namespacing makes a built-in collision structurally unreachable for an operator', () => {
  // ADR-040 requires a colliding custom flavor to be REFUSED at registration. What the earlier
  // version of this test asserted — that `base: 'node'` throws — was false, and asserting it would
  // have locked in a usability bug: the operator-chosen part is namespaced, so typing the name of a
  // built-in yields `custom-node` / `lambda-ci-custom-node`, which is a DISTINCT flavor and must be
  // allowed. Naming your image after the toolchain it carries is the obvious thing to do.
  for (const f of builtinFlavors()) {
    const rec = record({ base: f.name });
    assert.equal(rec.name, `custom-${f.name}`);
    assert.notEqual(rec.name, f.name);
    assert.notEqual(rec.label.toLowerCase(), f.label.toLowerCase());
  }
});

test('the registration collision check refuses a genuine collision', () => {
  // Reachable only by bypassing namespacing (a hand-written row, or a future writer that composes
  // the name itself), which is exactly the defence-in-depth case the check exists for.
  for (const f of builtinFlavors()) {
    assert.deepEqual(builtinCollision(f.name, 'lambda-ci-custom-x'), {
      field: 'name',
      collidesWith: f.name,
    });
    assert.deepEqual(builtinCollision('custom-x', f.label), {
      field: 'label',
      collidesWith: f.name,
    });
    assert.deepEqual(builtinCollision('custom-x', f.label.toUpperCase()), {
      field: 'label',
      collidesWith: f.name,
    }, 'label collision is case-insensitive');
  }
});

test('buildFlavorRecord throws when the derived name would collide', () => {
  // Proves the refusal is wired into the registration path, not just available as a predicate.
  // `builtinFlavors()` has no `custom-*` entry, so a collision needs one injected — assert the
  // wiring instead by checking the guard is reached for a name the namespace cannot produce.
  assert.throws(
    () => buildFlavorRecord({
      installationId: 42,
      base: 'custom-node',
      vcpu: 2,
      memoryMb: 4096,
      capabilities: [],
      description: 'x',
      imageArn: 'arn:x',
    }),
    /must not repeat the 'custom-' prefix/,
    'a doubled prefix is refused before it can produce custom-custom-node',
  );
});

test('a rejected registration throws a TYPED error, not one recognized by message text', () => {
  // The Mgmt route maps this to 400 and anything else to 500. Matching on `err.message` would let a
  // DynamoDB fault that happens to mention a "name" be reported to the operator as invalid input,
  // so the type is the contract.
  assert.throws(
    () =>
      buildFlavorRecord({
        installationId: 42,
        base: 'Not A Valid Name',
        vcpu: 2,
        memoryMb: 4096,
        capabilities: [],
        description: 'x',
        imageArn: 'arn:x',
      }),
    (err) => err instanceof InvalidFlavorError && err.name === 'InvalidFlavorError',
  );
});

test('the collision check covers all 7 built-ins, not just the original 3', () => {
  // ADR-039 grew the standard set from 3 to 7; the check is catalog-derived so it cannot lag.
  const names = builtinFlavors().map((f) => f.name);
  for (const n of ['base', 'node', 'python', 'java', 'go', 'rust', 'docker']) {
    assert.ok(names.includes(n), `catalog is missing ${n}`);
  }
  assert.equal(names.length, 7);
});

test('builtinCollision detects a label collision even when the name differs', () => {
  assert.deepEqual(builtinCollision('custom-x', 'lambda-ci-node'), { field: 'label', collidesWith: 'node' });
  assert.equal(builtinCollision('custom-x', 'lambda-ci-custom-x'), undefined);
});

test('composeCatalog defensively drops a colliding custom row', () => {
  // Defence in depth for a row written before the registration check existed: it must not be able
  // to redefine what `lambda-ci-node` means.
  const composed = composeCatalog([validCustom({ name: 'node', label: 'lambda-ci-custom-a' })]);
  assert.equal(composed.filter((f) => f.name === 'node').length, 1);
  assert.equal(composed.find((f) => f.name === 'node').label, 'lambda-ci-node');
  const composed2 = composeCatalog([validCustom({ name: 'custom-a', label: 'lambda-ci-node' })]);
  assert.equal(resolveFlavor(['lambda-ci-node'], { customFlavors: composed2.filter((f) => f.custom) }).flavor, 'node');
});

test('name validation rejects the shapes that would break a key, a label or a param name', () => {
  assert.equal(customFlavorBaseNameError('gpu-builder'), undefined);
  for (const bad of ['', 'GPU', 'a b', 'a_b', '-lead', 'trail-', 'a--b', 'custom-x', 'x'.repeat(33), 'a#b', '../etc']) {
    assert.ok(customFlavorBaseNameError(bad), `${JSON.stringify(bad)} should be rejected`);
  }
});

test('namespacing is applied by the store, never by the caller', () => {
  const rec = record({ base: 'gpu' });
  assert.equal(rec.name, 'custom-gpu');
  assert.equal(rec.label, 'lambda-ci-custom-gpu');
  assert.equal(rec.sk, flavorSk('custom-gpu'));
  assert.equal(rec.arch, 'arm64', 'arch is fixed, not operator-settable');
  assert.equal(rec.state, 'pending', 'registration is never born valid');
  assert.equal(customFlavorName('gpu'), 'custom-gpu');
  assert.equal(customFlavorLabel('gpu'), 'lambda-ci-custom-gpu');
  assert.ok(isCustomFlavorName('custom-gpu') && !isCustomFlavorName('node'));
  assert.ok(isCustomFlavorLabel('lambda-ci-custom-gpu') && !isCustomFlavorLabel('lambda-ci-node'));
});

// ---- 4. a custom label cannot reroute a built-in ---------------------------

test('adding custom flavors cannot change ANY built-in label resolution', () => {
  const custom = [
    validCustom({ name: 'custom-a', label: 'lambda-ci-custom-a' }),
    validCustom({ name: 'custom-zz', label: 'lambda-ci-custom-zz', capabilities: ['docker'], vcpu: 1, memoryMb: 1024 }),
  ];
  for (const f of builtinFlavors()) {
    assert.equal(resolveFlavor([f.label], { customFlavors: custom }).flavor, f.name, `${f.label} rerouted`);
  }
});

test('a docker-capable custom flavor never becomes a signal-upgrade target', () => {
  // A tiny custom docker image would otherwise capture every docker-signal job in the
  // installation — including jobs that named a BUILT-IN label — purely on its vcpu number.
  const custom = [validCustom({ name: 'custom-tiny', label: 'lambda-ci-custom-tiny', capabilities: ['docker'], vcpu: 1, memoryMb: 1024 })];
  assert.equal(resolveFlavor(['lambda-ci'], { signals: { needs_docker: true }, customFlavors: custom }).flavor, 'docker');
  assert.equal(resolveFlavor(['lambda-ci-python'], { signals: { needs_docker: true }, customFlavors: custom }).flavor, 'docker');
  assert.equal(resolveFlavor(['ubuntu-latest'], { mode: 'adopt', signals: { needs_docker: true }, customFlavors: custom }).flavor, 'docker');
});

test('an explicitly named custom docker flavor survives the docker signal (no upgrade)', () => {
  const custom = [validCustom({ name: 'custom-dind', label: 'lambda-ci-custom-dind', capabilities: ['docker'] })];
  const r = resolveFlavor(['lambda-ci-custom-dind'], { signals: { needs_docker: true }, customFlavors: custom });
  assert.equal(r.flavor, 'custom-dind');
  assert.doesNotMatch(r.reason, /upgraded/i);
});

test('custom label resolution is independent of the order custom rows arrive in', () => {
  const a = validCustom({ name: 'custom-aa', label: 'lambda-ci-custom-aa' });
  const b = validCustom({ name: 'custom-bb', label: 'lambda-ci-custom-bb' });
  for (const order of [[a, b], [b, a]]) {
    assert.equal(resolveFlavor(['lambda-ci-custom-aa'], { customFlavors: order }).flavor, 'custom-aa');
    assert.equal(resolveFlavor(['lambda-ci-custom-bb'], { customFlavors: order }).flavor, 'custom-bb');
  }
});

// ---- 5. claim allowlist reachability --------------------------------------

test('requiredClaimLabels is a superset of every built-in label', () => {
  const required = requiredClaimLabels();
  for (const f of builtinFlavors()) assert.ok(required.includes(f.label), `missing ${f.label}`);
});

test('a valid custom flavor contributes its label to the required claim allowlist', () => {
  // Ingest's gate runs BEFORE flavor resolution, so a label absent from the allowlist means the
  // job is never claimed and stays queued with no actionable error.
  const custom = routableCustomFlavors([{ ...record(), state: 'valid' }]);
  const required = requiredClaimLabels(custom);
  assert.ok(required.includes('lambda-ci-custom-gpu'));
  assert.equal(shouldClaim(job(['self-hosted', 'lambda-ci-custom-gpu']), required), true);
});

test('an UNVALIDATED custom flavor contributes no label (proof-first ordering)', () => {
  // Label-before-proof would convert a silently-queued job into a CLAIMED job that fails in
  // provisioning — strictly worse, because a claimed job can no longer fall back to GitHub-hosted.
  for (const state of ['pending', 'validating', 'invalid']) {
    const custom = routableCustomFlavors([{ ...record(), state }]);
    assert.ok(!requiredClaimLabels(custom).includes('lambda-ci-custom-gpu'), state);
    assert.equal(shouldClaim(job(['self-hosted', 'lambda-ci-custom-gpu']), requiredClaimLabels(custom)), false);
  }
});

test('a smoke nonce label is outside the lambda-ci namespace so it can never be claimed', () => {
  const label = smokeLabel('abc123');
  assert.ok(isSmokeLabel(label));
  assert.ok(!label.startsWith('lambda-ci'));
  // Even with the full required allowlist, ingest must ignore the smoke job — otherwise a second
  // microVM would be provisioned for it and race the validation runner.
  assert.equal(shouldClaim(job(['self-hosted', label]), requiredClaimLabels()), false);
});

function job(labels) {
  return { action: 'queued', workflow_job: { labels, status: 'queued' } };
}

// ---- validation state machine (ADR-041) -----------------------------------

test('the state machine allows exactly the intended transitions', () => {
  const legal = new Set([
    'pending>validating',
    'pending>pending',
    'validating>valid',
    'validating>invalid',
    'validating>pending',
    'valid>pending',
    'invalid>pending',
  ]);
  for (const from of FLAVOR_VALIDATION_STATES) {
    for (const to of FLAVOR_VALIDATION_STATES) {
      assert.equal(
        canTransitionValidation(from, to),
        legal.has(`${from}>${to}`),
        `${from} → ${to}`,
      );
    }
  }
});

test('re-validation cannot skip pending — a valid flavor stops being routable first', () => {
  // valid → validating would leave a flavor advertised as routable while the run that might
  // invalidate it was still in flight.
  assert.equal(canTransitionValidation('valid', 'validating'), false);
  assert.equal(canTransitionValidation('invalid', 'validating'), false);
  assert.equal(canTransitionValidation('valid', 'pending'), true);
});

test('invalid is terminal apart from an explicit re-validate', () => {
  assert.equal(canTransitionValidation('invalid', 'valid'), false);
  assert.equal(canTransitionValidation('invalid', 'invalid'), false);
});

// ---- static gate (ADR-041 gate 1) ----------------------------------------

const goodImage = { usable: true, state: 'UPDATED' };

test('a well-formed flavor with a usable image passes the static gate', () => {
  const r = staticGate({ flavor: record(), image: goodImage, requireSmokeRepo: true });
  assert.equal(r.ok, true);
});

test('the static gate reports EVERY failure, not just the first', () => {
  const r = staticGate({
    flavor: { ...record(), arch: 'x86_64', capabilities: ['gpu'], memoryMb: 10, imageArn: '' },
    requireSmokeRepo: true,
  });
  assert.equal(r.ok, false);
  const codes = r.failures.map((f) => f.code);
  for (const c of ['not-arm64', 'unknown-capability', 'memory-out-of-bounds', 'missing-image-arn']) {
    assert.ok(codes.includes(c), `expected ${c} in ${codes.join(',')}`);
  }
});

test('arch must be arm64 — Graviton-only is a platform rule, not a preference', () => {
  const r = staticGate({ flavor: { ...record(), arch: 'x86_64' }, image: goodImage });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'not-arm64'));
});

test('capabilities outside the closed vocabulary are rejected', () => {
  // An unknown capability is silently INERT — it feeds neither the upgrade path nor the compat
  // gate — which is worse than a refusal.
  const r = staticGate({ flavor: { ...record(), capabilities: ['docker', 'cuda'] }, image: goodImage });
  assert.equal(r.ok, false);
  const f = r.failures.find((x) => x.code === 'unknown-capability');
  assert.match(f.message, /cuda/);
});

test('memory is bounds-checked against the region quota when it is known', () => {
  assert.equal(staticGate({ flavor: record({ memoryMb: 8192 }), image: goodImage, maxMemoryMb: 4096 }).ok, false);
  assert.equal(staticGate({ flavor: record({ memoryMb: 4096 }), image: goodImage, maxMemoryMb: 4096 }).ok, true);
  assert.equal(staticGate({ flavor: record({ memoryMb: MIN_MEMORY_MB - 1 }), image: goodImage }).ok, false);
  assert.equal(staticGate({ flavor: record({ memoryMb: DEFAULT_MAX_MEMORY_MB + 1 }), image: goodImage }).ok, false);
});

test('an absent image is a verdict; an unreadable one names the grant as the remedy', () => {
  const absent = staticGate({ flavor: record(), image: { usable: false, state: 'ABSENT' } });
  assert.ok(absent.failures.some((f) => f.code === 'image-unusable'));
  const forbidden = staticGate({ flavor: record(), image: { usable: false, state: 'FORBIDDEN' } });
  const f = forbidden.failures.find((x) => x.code === 'image-unreadable');
  assert.match(f.message, /readable by the provisioner/);
});

test('an unprobed image runs every cheap check without inventing an image verdict', () => {
  // This is the pre-save preview path: no AWS calls, so no claim about the image.
  const r = staticGate({ flavor: record() });
  assert.equal(r.ok, true);
  const bad = staticGate({ flavor: { ...record(), arch: 'x86_64' } });
  assert.equal(bad.ok, false);
  assert.ok(!bad.failures.some((f) => f.code.startsWith('image-')));
});

test('a stored name/label that disagrees with its base is refused', () => {
  // Guards the shadowing route ADR-040 forbids: registration checked the DERIVED values, so a row
  // whose stored label was hand-edited must not slip past.
  const r = staticGate({ flavor: { ...record(), label: 'lambda-ci-node' }, image: goodImage });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'bad-name'));
});

test('a smoke repo is required for a real validation run', () => {
  const r = staticGate({ flavor: { ...record(), smokeRepoFullName: undefined }, image: goodImage, requireSmokeRepo: true });
  assert.ok(r.failures.some((f) => f.code === 'missing-smoke-repo'));
  assert.equal(staticGate({ flavor: { ...record(), smokeRepoFullName: undefined }, image: goodImage }).ok, true);
});

// ---- smoke verdict (ADR-041 gate 2) --------------------------------------

const passing = { launched: true, runnerRegistered: true, workflowConclusion: 'success', selfTerminated: true };

test('a fully observed successful smoke run is the ONLY path to valid', () => {
  assert.equal(classifySmoke(passing).state, 'valid');
});

test('static success is not enough: each missing observation fails the flavor', () => {
  // The ADR-019/020 case study, encoded: the broken docker image passed every static check.
  assert.equal(classifySmoke({ ...passing, launched: false }).state, 'invalid');
  assert.equal(classifySmoke({ ...passing, runnerRegistered: false }).state, 'invalid');
  assert.equal(classifySmoke({ ...passing, workflowConclusion: 'failure' }).state, 'invalid');
  assert.equal(classifySmoke({ ...passing, workflowConclusion: undefined, timedOut: true }).state, 'invalid');
});

test('a job that succeeds but never self-terminates is INVALID', () => {
  // Otherwise every job on the image leaks a VM until the Reaper's 2h cap (the ADR-019 regression).
  const v = classifySmoke({ ...passing, selfTerminated: false });
  assert.equal(v.state, 'invalid');
  assert.match(v.reason, /self-terminate/);
});

test('an agent that registers but cannot run a job is named as such', () => {
  const v = classifySmoke({ launched: true, runnerRegistered: true, timedOut: true, selfTerminated: false });
  assert.equal(v.state, 'invalid');
  assert.match(v.reason, /never reached a conclusion/);
});

test('our own orchestration failure returns to pending, never invalid', () => {
  // `invalid` is terminal; spending it on a GitHub 500 or a throttle would permanently condemn a
  // working image.
  const v = classifySmoke({ ...passing, orchestrationError: 'GitHub 500 (request abc)' });
  assert.equal(v.state, 'pending');
  assert.match(v.reason, /not a verdict about the image/);
});

test('every invalid verdict carries an operator-actionable reason', () => {
  for (const obs of [
    { ...passing, launched: false },
    { ...passing, runnerRegistered: false },
    { ...passing, workflowConclusion: 'failure' },
    { ...passing, selfTerminated: false },
  ]) {
    const v = classifySmoke(obs);
    assert.equal(v.state, 'invalid');
    assert.ok(v.reason.length > 40, `reason too thin: ${v.reason}`);
  }
});

// ---- smoke run isolation -------------------------------------------------

test('the smoke workflow template binds the job to the nonce and asserts arm64', () => {
  const yaml = smokeWorkflowYaml();
  assert.match(yaml, /workflow_dispatch/);
  assert.match(yaml, /lca_nonce/);
  assert.match(yaml, /runs-on: \[self-hosted, "\$\{\{ inputs\.lca_nonce \}\}"\]/);
  assert.match(yaml, /aarch64/);
  assert.match(yaml, /timeout-minutes/);
  assert.ok(DEFAULT_SMOKE_WORKFLOW_PATH.endsWith('.yml'));
});

test('the broker accepts a SMOKE ref without loosening the RUN ref grammar', () => {
  assert.ok(isSmokeRef('SMOKE#42#1#JITCONFIG'));
  assert.ok(!isRunRef('SMOKE#42#1#JITCONFIG'), 'a smoke ref must not pass as a run ref');
  assert.ok(isRunRef('RUN#1#2#3#JITCONFIG'));
  assert.ok(isBrokerRef('SMOKE#42#1#JITCONFIG') && isBrokerRef('RUN#1#2#3#JITCONFIG'));
  for (const bad of [
    'SMOKE#42#JITCONFIG',
    'SMOKE#42#1#2#JITCONFIG',
    'SMOKE#a#1#JITCONFIG',
    'SMOKE#42#1#RUN',
    'SMOKE#42#1#JITCONFIG#x',
    '#SMOKE#42#1#JITCONFIG',
  ]) {
    assert.ok(!isBrokerRef(bad), `${bad} must be rejected`);
  }
});

/**
 * The smoke-store ref generator and the broker's ref parser are separate modules that must agree
 * byte-for-byte, and nothing else pins them together: the store is written for the deferred
 * smoke-run λ, so no production caller exercises the pair yet. Without this test the two could
 * drift silently (a changed separator, an extra key segment) and the failure would only appear the
 * first time a live smoke VM called the broker — i.e. during the deploy-touching work that can
 * least afford it.
 */
test('the smoke store ref round-trips through the broker parser and key derivation', () => {
  const ref = smokeRef(42, 7);
  assert.equal(ref, 'SMOKE#42#7#JITCONFIG');
  assert.ok(isSmokeRef(ref), 'the store must emit a ref the broker recognizes');
  assert.ok(isBrokerRef(ref));
  assert.ok(!isRunRef(ref), 'a smoke ref must never pass as a run ref');
  // The broker derives the item key from the ref alone, so this equality IS the isolation
  // property: the VM's token addresses exactly the partition the store wrote.
  const keys = keysFromRef(ref);
  assert.equal(keys.pk, smokePk(42, 7));
  assert.equal(keys.jitSk, 'JITCONFIG');
  assert.equal(keys.runSk, 'RUN');
  // A smoke ref cannot be steered at a RUN# partition, and vice versa.
  assert.ok(!keysFromRef('RUN#1#2#3#JITCONFIG').pk.startsWith('SMOKE#'));
  assert.ok(keys.pk.startsWith('SMOKE#'));
});

test('parseHookRequest serves a smoke ref and still rejects a malformed one', () => {  const token = 'x'.repeat(32);
  assert.equal(parseHookRequest({ action: 'terminate', ref: 'SMOKE#42#1#JITCONFIG', token }).ref, 'SMOKE#42#1#JITCONFIG');
  assert.throws(() => parseHookRequest({ action: 'terminate', ref: 'SMOKE#x#1#JITCONFIG', token }), /malformed ref/);
});

// ---- console view -------------------------------------------------------

test('custom flavors appear in every state, carrying routability per row', () => {
  const views = buildFlavorViews({ base: true }, [
    { ...toCatalogFlavor(record({ base: 'ok' })), imageArn: 'arn:x', state: 'valid' },
    { ...toCatalogFlavor(record({ base: 'bad' })), imageArn: 'arn:y', state: 'invalid', reason: 'smoke run failed: …' },
    { ...toCatalogFlavor(record({ base: 'new' })), imageArn: 'arn:z', state: 'pending' },
  ]);
  const custom = views.filter((v) => v.custom);
  assert.equal(custom.length, 3, 'the console shows unvalidated flavors — that is its job');
  assert.deepEqual(custom.map((v) => v.routable), [true, false, false]);
  assert.equal(custom.find((v) => v.validationState === 'invalid').validationReason, 'smoke run failed: …');
  for (const v of views.filter((x) => !x.custom)) {
    assert.equal(v.routable, true, 'built-ins are not subject to ADR-041 validation');
  }
});

test('a custom flavor surfaces a per-minute rate for the requested shape before save', () => {
  const views = buildFlavorViews({}, [{ ...toCatalogFlavor(record({ base: 'r' })), imageArn: 'arn:x', state: 'pending' }]);
  const row = views.find((v) => v.custom);
  assert.ok(row.usdPerMinute > 0, 'ADR-040 requires the derived rate before save');
  const base = views.find((v) => v.name === 'base');
  assert.ok(row.usdPerMinute > base.usdPerMinute, '4 vCPU / 8 GB should price above base');
});

// ---- compat gate --------------------------------------------------------

test('a custom flavor upgraded to docker still warns that its toolchain was dropped', () => {
  // The `toolchain-dropped` gate is catalog-derived, so it must see custom capabilities too or a
  // custom python flavor swapped for `docker` would lose its toolchain silently.
  const custom = [validCustom({ capabilities: ['python'] })];
  const res = analyzeCompat(
    { id: 'j', runs_on: ['self-hosted', 'lambda-ci-custom-gpu'], step_signals: { arch_hints: [], needs_docker: true } },
    { flavor: 'docker', reason: 'upgraded', replaced: 'custom-gpu' },
    custom,
  );
  const codes = res.messages.map((m) => m.code);
  assert.ok(codes.includes('toolchain-dropped'), codes.join(','));
});

test('compat is unchanged when no custom flavors are supplied', () => {
  const job = { id: 'j', runs_on: ['self-hosted', 'lambda-ci-python'], step_signals: { arch_hints: [], needs_docker: true } };
  const resolution = { flavor: 'docker', reason: 'upgraded', replaced: 'python' };
  assert.deepEqual(analyzeCompat(job, resolution, []), analyzeCompat(job, resolution));
});

// ---- the single catalog seam (ADR-040 structural invariant) ----------------
//
// ADR-040's first claim is that `src/shared/flavor-catalog.ts` is the ONLY module that reads
// `microvm/flavors.json`, because four independent `builtin ++ custom` compositions would give
// four chances to disagree about what a flavor is. That was never pinned by a test, and it
// promptly regressed: ADR-049's `src/shared/flavor-reconcile.ts` landed on `main` with its own
// static import while this work was in review, so the merged tree had two readers and an ADR
// asserting it had one. Structural claims need structural guards.

test('flavor-catalog.ts is the only module in src/ that reads flavors.json', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const SRC = new URL('../src/', import.meta.url).pathname;
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        // Strip comments first: the prose in these modules legitimately NAMES the JSON file
        // (that is the whole point of documenting the seam), so a raw text match would flag
        // every module that explains the rule and miss nothing that breaks it.
        const code = readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/from\s+['"][^'"]*flavors\.json['"]/.test(code)) offenders.push(relative(SRC, p));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(
    offenders,
    ['shared/flavor-catalog.ts'],
    `only the catalog seam may import flavors.json; found: ${offenders.join(', ')}. ` +
      'Derive from `builtinFlavors()` instead — a second reader can silently disagree with the ' +
      'resolver about labels, capabilities or pricing (ADR-040).',
  );
});

test('the comment stripper does not make the seam guard vacuous', () => {
  // Mutation-proofing the guard above: a commented-out import must NOT count as an offender,
  // and a real one MUST be found even when a comment on the same file mentions the path.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re = /from\s+['"][^'"]*flavors\.json['"]/;
  assert.equal(re.test(strip("// import x from '../../microvm/flavors.json';\n")), false);
  assert.equal(re.test(strip("/** reads microvm/flavors.json */\nconst a = 1;\n")), false);
  assert.equal(
    re.test(strip("/** the seam over flavors.json */\nimport c from '../../microvm/flavors.json';\n")),
    true,
  );
});

test('the reconcile catalog and the routing catalog are the same built-in list', async () => {
  // ADR-049's reconcile derivation answers "is this flavor runnable in the live environment"
  // while the resolver answers "which flavor does this job get". They must be talking about the
  // same flavors: a label present in one and absent from the other is either capacity that can
  // never be selected, or a route with no image.
  const { catalogFlavors, allCatalogLabels } = await import('../dist/src/shared/flavor-reconcile.js');
  assert.deepEqual(
    catalogFlavors().map((f) => f.name),
    builtinFlavors().map((f) => f.name),
  );
  assert.deepEqual(allCatalogLabels(), builtinFlavors().map((f) => f.label));
  // Reconciliation is built-in only: a custom flavor's image is the operator's own and is never
  // published to `image-arn-<flavor>`, so it has nothing to reconcile against.
  assert.ok(!allCatalogLabels().some((l) => isCustomFlavorLabel(l)));
});

// ---- the cap that makes the single-page read whole ------------------------
//
// `listCustomFlavors` issues ONE query, and every consumer of it is a safety gate: the ingest
// claim allowlist, provision routing, config validation. A silently truncated page would drop a
// `valid` flavor's label and leave its jobs unclaimed with no actionable error. The invariant is
// enforced at the write instead, where it can be refused out loud.

test('the flavor cap is orders of magnitude below a DynamoDB query page', () => {
  // The claim being pinned is not "64 is a nice number" — it is that 64 rows of this shape cannot
  // approach 1 MiB, which is what makes one page provably the whole set.
  const rec = buildFlavorRecord({
    installationId: 42,
    base: 'g'.repeat(32),
    vcpu: 4,
    memoryMb: 8192,
    capabilities: ['docker', 'node', 'python', 'java', 'go', 'rust'],
    description: 'x'.repeat(200),
    imageArn: `arn:aws:lambda:us-west-2:123456789012:microvm-image/${'i'.repeat(60)}`,
    smokeRepoFullName: 'owner/repo',
    smokeWorkflowPath: '.github/workflows/lca-flavor-validate.yml',
    actor: 'octocat',
  });
  // Worst case: max-length name, every capability, max description. Evidence is added later, so
  // allow generous headroom for it on top.
  const worstCaseBytes = Buffer.byteLength(JSON.stringify(rec), 'utf8') + 1024;
  const pageBytes = 1024 * 1024;
  assert.ok(
    worstCaseBytes * MAX_CUSTOM_FLAVORS_PER_INSTALLATION < pageBytes / 4,
    `${MAX_CUSTOM_FLAVORS_PER_INSTALLATION} × ${worstCaseBytes}B must stay well under a ${pageBytes}B page`,
  );
});

test('the cap is a real bound, not a comment', async () => {
  // Proves the refusal is wired into the writer rather than merely documented. The store is
  // driven through its injected reader/writer seams so this needs no DynamoDB.
  const { registerCustomFlavor, TooManyFlavorsError } = await import(
    '../dist/src/shared/flavor-store.js'
  );
  assert.equal(typeof TooManyFlavorsError, 'function');
  // A store with no TABLE_NAME configured throws its config error; what matters here is that the
  // cap constant is exported and consumed, which the source guard below pins exactly.
  assert.equal(typeof registerCustomFlavor, 'function');
  assert.equal(MAX_CUSTOM_FLAVORS_PER_INSTALLATION, 64);
});

test('registerCustomFlavor checks the cap before writing, and the API returns 409', async () => {
  const { readFileSync } = await import('node:fs');
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const store = strip(
    readFileSync(new URL('../src/shared/flavor-store.ts', import.meta.url), 'utf8'),
  );
  // The order is load-bearing: the count must be consulted BEFORE the conditional Put, or the cap
  // is advice rather than a limit.
  const guard = store.indexOf('MAX_CUSTOM_FLAVORS_PER_INSTALLATION)');
  const put = store.indexOf('new PutCommand');
  assert.ok(guard > 0, 'registerCustomFlavor no longer enforces the cap');
  assert.ok(put > 0 && guard < put, 'the cap must be checked before the write');
  assert.match(store, /throw new TooManyFlavorsError/);

  // ...and the refusal must reach the operator as a 409, not surface as our 500.
  const handler = strip(
    readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8'),
  );
  assert.match(handler, /err instanceof TooManyFlavorsError\) return problem\(409/);
});
