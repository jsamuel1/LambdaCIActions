// Custom-flavor WIRING tests (ADR-040/041).
//
// `test/custom-flavors.test.mjs` covers the pure library: the store's state machine, the
// resolver's precedence, the static gate's verdicts. Every one of those passed while the feature
// was unreachable, because nothing called them — so this file asserts the CONNECTIONS instead:
//
//   1. an unvalidated flavor is refused at the LAST gate before a VM boots, not just omitted
//      from the catalog (resolution and launch are separate reads);
//   2. config writes accept a routable custom flavor and refuse an unvalidated one, so the
//      console cannot save a choice the resolver would ignore;
//   3. the registration body validator enforces the ADR-038 honesty rule and the closed
//      capability vocabulary;
//   4. the new API surface is actually routable, including static-vs-parameter precedence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchableCustomImageArn } from '../dist/src/provision/handler.js';
import {
  validateCustomFlavor,
  validateRevalidateBody,
  validateFlavorMap,
  validateRepoPatch,
  advertisesVcpuShape,
  isMicrovmImageArn,
} from '../dist/src/mgmt/validate.js';
import { buildFlavorViews, flavorNames } from '../dist/src/mgmt/views.js';
import { matchRoute } from '../dist/src/mgmt/router.js';
import { needsCustomFlavors, resolveFlavor } from '../dist/src/provision/flavor.js';

const ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image/gpu-builder';

/** A registration body that passes every rule, so each test can break exactly one thing. */
function body(over = {}) {
  return {
    name: 'gpu',
    vcpu: 2,
    memoryMb: 4096,
    capabilities: ['docker'],
    description: 'GPU builder image with docker',
    imageArn: ARN,
    ...over,
  };
}

// ---- 1. the launch gate ----------------------------------------------------

test('launch refuses a custom flavor that is not valid — for EVERY non-valid state', () => {
  // The important half of ADR-041. Omission from the catalog is not sufficient on its own:
  // resolution and launch are separate DynamoDB reads, so a flavor invalidated (or deleted)
  // between them would otherwise get one last microVM from an unproven image.
  for (const state of ['pending', 'validating', 'invalid']) {
    assert.throws(
      () => launchableCustomImageArn('custom-gpu', { state, imageArn: ARN }, 42),
      /not validated \(state: .*\) — refusing to launch/,
      `state ${state} must not be launchable`,
    );
  }
  // A row written before `state` existed is not launchable either — absent is not valid.
  assert.throws(
    () => launchableCustomImageArn('custom-gpu', { imageArn: ARN }, 42),
    /not validated/,
  );
});

test('launch refuses a deleted flavor rather than falling back to base', () => {
  // Falling back would run the job on an image the workflow did not ask for, silently.
  assert.throws(
    () => launchableCustomImageArn('custom-gpu', undefined, 42),
    /has no record for installation 42/,
  );
});

test('launch refuses a valid flavor with no image ARN', () => {
  assert.throws(() => launchableCustomImageArn('custom-gpu', { state: 'valid' }, 42), /no imageArn/);
});

test('a valid custom flavor launches from the ARN on its own row, not from SSM', () => {
  // The ARN must come from the row: there is no `image-arn-custom-gpu` SSM parameter, so a
  // name-based lookup would fail every custom launch.
  assert.equal(launchableCustomImageArn('custom-gpu', { state: 'valid', imageArn: ARN }, 42), ARN);
});

// ---- 2. config writes ------------------------------------------------------

test('a routable custom flavor is selectable in a FlavorMap and as defaultFlavor', () => {
  const custom = [{ name: 'custom-gpu' }];
  const fm = validateFlavorMap({ 'ubuntu-latest': 'custom-gpu' }, custom);
  assert.equal(fm.ok, true);
  assert.deepEqual(fm.value, { 'ubuntu-latest': 'custom-gpu' });

  const patch = validateRepoPatch({ defaultFlavor: 'custom-gpu' }, custom);
  assert.equal(patch.ok, true);
  assert.equal(patch.value.defaultFlavor, 'custom-gpu');
});

test('an unvalidated custom flavor is NOT selectable in config', () => {
  // Accepting it would save config the resolver ignores: the job would land on `base` while the
  // console showed the operator's choice. The caller passes only routable rows, so an empty list
  // is what a `pending`/`invalid` flavor looks like here.
  const fm = validateFlavorMap({ 'ubuntu-latest': 'custom-gpu' }, []);
  assert.equal(fm.ok, false);
  assert.match(fm.errors.join(' '), /unknown flavor "custom-gpu"/);

  const patch = validateRepoPatch({ defaultFlavor: 'custom-gpu' }, []);
  assert.equal(patch.ok, false);
  assert.match(patch.errors.join(' '), /defaultFlavor must be a known flavor/);
});

test('config validation is unchanged when no custom flavors are passed', () => {
  // The no-custom-flavors path must behave exactly as it did before ADR-040.
  assert.deepEqual(flavorNames(), flavorNames(undefined));
  assert.equal(validateFlavorMap({ 'ubuntu-latest': 'base' }).ok, true);
  assert.equal(validateRepoPatch({ defaultFlavor: 'node' }).ok, true);
  assert.equal(validateRepoPatch({ defaultFlavor: 'custom-gpu' }).ok, false);
});

// ---- 3. registration body --------------------------------------------------

test('a well-formed registration body is accepted and the custom- prefix is NOT client-supplied', () => {
  const res = validateCustomFlavor(body());
  assert.equal(res.ok, true);
  // The base name only: `custom-` is added by the store, so a client cannot control the namespace.
  assert.equal(res.value.base, 'gpu');
  assert.equal(res.value.imageArn, ARN);
});

test('a description advertising a vCPU shape is refused (ADR-038)', () => {
  // Only memory is requestable, so "2 vCPU" promises a shape the API cannot be asked for. The
  // repo already forbids this for built-in descriptions; operator text reaches the same table.
  for (const description of [
    'Fast builder, 2 vCPU',
    'image with 4 vcpus',
    '8 cores for compiling',
    '2.5 vCPU burst',
    'now with 16 threads',
  ]) {
    const res = validateCustomFlavor(body({ description }));
    assert.equal(res.ok, false, `should refuse: ${description}`);
    assert.match(res.errors.join(' '), /must not advertise a vCPU shape/);
  }
  // ...while an honest toolchain description passes, including one that mentions memory.
  assert.equal(validateCustomFlavor(body({ description: 'Rust + sccache, 4 GB' })).ok, true);
  assert.equal(advertisesVcpuShape('Rust toolchain image'), false);
});

test('capabilities outside the closed vocabulary are refused, not silently inert', () => {
  const res = validateCustomFlavor(body({ capabilities: ['docker', 'cuda'] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /unknown: cuda/);
  // An absent list is legal — a flavor need not advertise a toolchain.
  assert.deepEqual(validateCustomFlavor(body({ capabilities: undefined })).value.capabilities, []);
});

test('memory is bounds-checked and a non-microVM image ARN is refused', () => {
  assert.match(validateCustomFlavor(body({ memoryMb: 512 })).errors.join(' '), /memoryMb must be/);
  assert.match(
    validateCustomFlavor(body({ memoryMb: 655360 })).errors.join(' '),
    /memoryMb must be/,
  );
  // A quota passed by the caller tightens the ceiling.
  assert.equal(validateCustomFlavor(body({ memoryMb: 16384 }), { maxMemoryMb: 8192 }).ok, false);

  for (const bad of [
    'not-an-arn',
    'arn:aws:lambda:us-east-1:123456789012:function/foo',
    'arn:aws:s3:::bucket/key',
  ]) {
    assert.equal(validateCustomFlavor(body({ imageArn: bad })).ok, false, bad);
  }
  assert.equal(isMicrovmImageArn(ARN), true);
});

test('a name that would collide with the custom namespace or is malformed is refused', () => {
  for (const name of ['custom-gpu', 'GPU', 'gpu--builder', '-gpu', 'gpu-', 'a'.repeat(33), '']) {
    assert.equal(validateCustomFlavor(body({ name })).ok, false, `should refuse name: ${name}`);
  }
});

test('unknown fields are refused rather than silently dropped', () => {
  const res = validateCustomFlavor(body({ state: 'valid' }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /unknown field "state"/);
});

test('a smoke workflow path is confined to .github/workflows', () => {
  // The value is handed to GitHub's workflow_dispatch API; a traversal-ish path is a request we
  // should never send.
  for (const p of ['../../etc/passwd', '.github/workflows/../../x.yml', 'build.yml']) {
    assert.equal(validateCustomFlavor(body({ smokeWorkflowPath: p })).ok, false, p);
  }
  assert.equal(
    validateCustomFlavor(body({ smokeWorkflowPath: '.github/workflows/lca-flavor-validate.yml' }))
      .ok,
    true,
  );
  assert.equal(validateCustomFlavor(body({ smokeRepoFullName: 'not-a-repo' })).ok, false);
  assert.equal(validateCustomFlavor(body({ smokeRepoFullName: 'acme/infra' })).ok, true);
});

test('the re-validate body accepts an absent or valid ARN and refuses anything else', () => {
  assert.deepEqual(validateRevalidateBody(undefined).value, {});
  assert.deepEqual(validateRevalidateBody({}).value, {});
  assert.deepEqual(validateRevalidateBody({ imageArn: ARN }).value, { imageArn: ARN });
  assert.equal(validateRevalidateBody({ imageArn: 'nope' }).ok, false);
  assert.equal(validateRevalidateBody({ force: true }).ok, false);
});

// ---- 4. views + routes -----------------------------------------------------

test('the console lists a custom flavor in every state but marks only `valid` routable', () => {
  // Unlike the resolver, the console must SHOW pending/invalid and why — routability is carried
  // per row rather than by omission, so the UI cannot disagree with the resolver.
  const custom = (state, reason) => ({
    name: 'custom-gpu',
    label: 'lambda-ci-custom-gpu',
    arch: 'arm64',
    vcpu: 2,
    memoryMb: 4096,
    capabilities: ['docker'],
    description: 'GPU builder',
    imageArn: ARN,
    state,
    reason,
  });
  for (const state of ['pending', 'validating', 'invalid']) {
    const views = buildFlavorViews({}, [custom(state, 'boom')]);
    const row = views.find((v) => v.name === 'custom-gpu');
    assert.equal(row.routable, false, `${state} must not be routable`);
    assert.equal(row.validationState, state);
    assert.equal(row.validationReason, 'boom');
    assert.equal(row.custom, true);
  }
  const valid = buildFlavorViews({}, [custom('valid')]).find((v) => v.name === 'custom-gpu');
  assert.equal(valid.routable, true);
  // Every built-in stays routable and unannotated.
  for (const v of buildFlavorViews({}).filter((v) => !v.custom)) {
    assert.equal(v.routable, true);
    assert.equal(v.validationState, undefined);
  }
});

test('buildFlavorViews with no custom flavors returns the pre-ADR-040 rows', () => {
  const before = buildFlavorViews({ base: true });
  const after = buildFlavorViews({ base: true }, []);
  assert.deepEqual(after, before);
});

test('the custom-flavor API routes are reachable and correctly scoped', () => {
  const cases = [
    ['POST', '/api/flavors', 'registerFlavor'],
    ['GET', '/api/flavors', 'listFlavors'],
    ['POST', '/api/flavors/preview', 'previewFlavor'],
    ['DELETE', '/api/flavors/custom-gpu', 'deleteFlavor'],
    ['POST', '/api/flavors/custom-gpu/revalidate', 'revalidateFlavor'],
  ];
  for (const [method, path, id] of cases) {
    const res = matchRoute(method, path);
    assert.equal(res.kind, 'match', `${method} ${path} should route`);
    assert.equal(res.match.route.id, id);
    assert.equal(res.match.route.authRequired, true, `${id} must require auth`);
  }
  // `preview` is a STATIC segment and must not be swallowed by `{name}`: a POST to it has to
  // reach the preview route, never a mutation on a flavor literally named "preview".
  assert.equal(matchRoute('POST', '/api/flavors/preview').match.route.id, 'previewFlavor');
  assert.equal(matchRoute('DELETE', '/api/flavors/custom-gpu').match.params.name, 'custom-gpu');
  // A wrong method is method-not-allowed, not not-found.
  assert.equal(matchRoute('PUT', '/api/flavors/custom-gpu').kind, 'method-not-allowed');
});

// ---- the no-I/O guarantee --------------------------------------------------

test('a job naming no custom flavor never triggers a custom-flavor read', () => {
  // This is what makes "no behavior change and no I/O when none are registered" true on the
  // provision hot path: the read is gated on the job being able to reach a custom flavor at all.
  assert.equal(needsCustomFlavors(['self-hosted', 'lambda-ci-node']), false);
  assert.equal(needsCustomFlavors(['ubuntu-latest'], { flavorMap: { 'ubuntu-latest': 'go' } }), false);
  assert.equal(needsCustomFlavors(['self-hosted'], { defaultFlavor: 'rust' }), false);
  // ...and each of the three ways a custom flavor can be named does trigger it.
  assert.equal(needsCustomFlavors(['lambda-ci-custom-gpu']), true);
  assert.equal(needsCustomFlavors(['x'], { flavorMap: { x: 'custom-gpu' } }), true);
  assert.equal(needsCustomFlavors(['x'], { defaultFlavor: 'custom-gpu' }), true);
});

// ---- 5. the claim→provision window (P0 regression) -------------------------
//
// Ingest claims a `lambda-ci-custom-*` job while the flavor is `valid`. Provision resolves LATER,
// from a separate read. If the flavor was deleted, reset to `pending` by a re-validate, or is
// unreadable by then, the composed catalog no longer contains it — and plain fall-through is
// actively dangerous rather than merely wrong: it lands on `base`, which resolves to a REAL
// built-in image ARN, while the JIT runner still advertises the original custom label from the
// claim. GitHub would assign the job and it would SUCCEED on an image the workflow never asked
// for. `unresolvedCustom` exists so the provisioner refuses instead.

test('a job naming a vanished custom flavor reports it rather than silently using base', () => {
  const res = resolveFlavor(['self-hosted', 'lambda-ci-custom-gpu'], { customFlavors: [] });
  // Resolution still returns a usable name...
  assert.equal(res.flavor, 'base');
  // ...but flags that the job's actual request could not be honored.
  assert.equal(res.unresolvedCustom, 'lambda-ci-custom-gpu');
});

test('every route that can name a custom flavor is covered', () => {
  // FlavorMap value pointing at an absent custom flavor.
  const viaMap = resolveFlavor(['ubuntu-latest'], {
    flavorMap: { 'ubuntu-latest': 'custom-gpu' },
    customFlavors: [],
  });
  assert.equal(viaMap.unresolvedCustom, 'custom-gpu');

  // defaultFlavor naming an absent custom flavor, when the fallback is actually taken.
  const viaDefault = resolveFlavor(['self-hosted'], {
    defaultFlavor: 'custom-gpu',
    customFlavors: [],
  });
  assert.equal(viaDefault.unresolvedCustom, 'custom-gpu');
});

test('a substituted built-in does NOT mask an unresolvable custom request', () => {
  // The dangerous shape: the job carries both labels, so resolution "succeeds" on `node` and
  // nothing looks wrong — but the operator asked for the custom image too.
  const res = resolveFlavor(['self-hosted', 'lambda-ci-custom-gpu', 'lambda-ci-node'], {
    customFlavors: [],
  });
  assert.equal(res.flavor, 'node');
  assert.equal(res.unresolvedCustom, 'lambda-ci-custom-gpu');
});

test('the refusal does NOT fire for legitimate resolutions', () => {
  // 1. No custom flavor named at all — the overwhelmingly common case, and the one that must stay
  //    byte-identical.
  assert.equal(resolveFlavor(['self-hosted', 'lambda-ci-node']).unresolvedCustom, undefined);
  assert.equal(resolveFlavor(['ubuntu-latest'], { mode: 'adopt' }).unresolvedCustom, undefined);

  // 2. The named custom flavor IS routable.
  const custom = [
    {
      name: 'custom-gpu',
      label: 'lambda-ci-custom-gpu',
      arch: 'arm64',
      vcpu: 2,
      memoryMb: 4096,
      capabilities: ['docker'],
      description: 'GPU builder',
    },
  ];
  const ok = resolveFlavor(['self-hosted', 'lambda-ci-custom-gpu'], { customFlavors: custom });
  assert.equal(ok.flavor, 'custom-gpu');
  assert.equal(ok.unresolvedCustom, undefined);

  // 3. A custom `defaultFlavor` that was never consulted, because an explicit label matched. This
  //    is why `defaultFlavor` is only checked on the fallback path: refusing here would break jobs
  //    that resolved correctly.
  const explicit = resolveFlavor(['self-hosted', 'lambda-ci-node'], {
    defaultFlavor: 'custom-gpu',
    customFlavors: [],
  });
  assert.equal(explicit.flavor, 'node');
  assert.equal(explicit.unresolvedCustom, undefined);

  // 4. A FlavorMap entry for a label this job does not carry.
  const otherLabel = resolveFlavor(['self-hosted', 'lambda-ci-go'], {
    flavorMap: { 'ubuntu-latest': 'custom-gpu' },
    customFlavors: [],
  });
  assert.equal(otherLabel.flavor, 'go');
  assert.equal(otherLabel.unresolvedCustom, undefined);
});

test('a signal upgrade away from a routable custom flavor is legitimate, not a refusal', () => {
  // `custom-nogpu` resolves fine but lacks docker, so the resolver upgrades to a built-in. That is
  // the documented ADR-039 replacement, and `replaced` already makes the toolchain loss visible —
  // it must not be confused with an unresolvable request.
  const custom = [
    {
      name: 'custom-nodocker',
      label: 'lambda-ci-custom-nodocker',
      arch: 'arm64',
      vcpu: 2,
      memoryMb: 4096,
      capabilities: [],
      description: 'no docker',
    },
  ];
  const res = resolveFlavor(['self-hosted', 'lambda-ci-custom-nodocker'], {
    customFlavors: custom,
    signals: { needs_docker: true },
  });
  assert.equal(res.replaced, 'custom-nodocker');
  assert.equal(res.unresolvedCustom, undefined);
});
