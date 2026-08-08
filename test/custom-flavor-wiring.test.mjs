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
    // A NUMBER WORD advertises capacity just as loudly as a digit, and a digit-only regex misses
    // it entirely.
    'builder with two vCPUs',
    'sixteen cores of compile',
    'eight-thread builder',
    // The built-in guard is `doesNotMatch(/vcpu/i)` — the word alone, no count. These two strings
    // render in the same console table, so a looser rule here would let operator text make exactly
    // the claim ADR-038 retracts while the catalog could not.
    'vCPU is indicative only',
    'more vcpu than base',
  ]) {
    const res = validateCustomFlavor(body({ description }));
    assert.equal(res.ok, false, `should refuse: ${description}`);
    assert.match(res.errors.join(' '), /must not advertise a vCPU shape/);
  }
  // ...while an honest toolchain description passes, including one that mentions memory, and one
  // that uses a core/thread word WITHOUT a count ("multi-core" is not a capacity claim).
  assert.equal(validateCustomFlavor(body({ description: 'Rust + sccache, 4 GB' })).ok, true);
  assert.equal(
    validateCustomFlavor(body({ description: 'multi-core friendly build image' })).ok,
    true,
  );
  assert.equal(advertisesVcpuShape('Rust toolchain image'), false);
  assert.equal(advertisesVcpuShape('thread sanitizer preinstalled'), false);
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

test('a custom label the FlavorMap explicitly remaps to a built-in is NOT refused', () => {
  // The FlavorMap is resolution step 1 — the highest-precedence rule — so an operator writing
  // `lambda-ci-custom-gpu → node` has stated what that label means for this repo. That is the
  // obvious workaround while a custom image is invalid or being re-validated, and refusing it
  // would veto the override resolution just honored. The refusal exists for a SILENT fall-through
  // onto an image the workflow never asked for; an explicit remap is the opposite of silent.
  const remapped = resolveFlavor(['self-hosted', 'ubuntu-latest', 'lambda-ci-custom-gpu'], {
    flavorMap: { 'lambda-ci-custom-gpu': 'node' },
    mode: 'adopt',
    customFlavors: [],
  });
  assert.equal(remapped.flavor, 'node');
  assert.equal(remapped.reason, "FlavorMap override: 'lambda-ci-custom-gpu' → 'node'");
  assert.equal(remapped.unresolvedCustom, undefined);

  // Suppression is per-LABEL, not per-job: a second custom label with no map entry of its own is
  // still an unresolved request, even though a different label on the job was remapped.
  const partial = resolveFlavor(
    ['self-hosted', 'lambda-ci-custom-gpu', 'lambda-ci-custom-fpga'],
    { flavorMap: { 'lambda-ci-custom-gpu': 'node' }, customFlavors: [] },
  );
  assert.equal(partial.flavor, 'node');
  assert.equal(partial.unresolvedCustom, 'lambda-ci-custom-fpga');

  // A remap whose TARGET does not exist is not an override at all — resolution ignores it, so the
  // custom label remains an unresolved request rather than being excused by a broken entry.
  const brokenTarget = resolveFlavor(['self-hosted', 'lambda-ci-custom-gpu'], {
    flavorMap: { 'lambda-ci-custom-gpu': 'no-such-flavor' },
    customFlavors: [],
  });
  assert.equal(brokenTarget.unresolvedCustom, 'lambda-ci-custom-gpu');

  // And a remap onto ANOTHER absent custom flavor is still refused. The label is what gets named:
  // it is what the workflow actually wrote, and the label loop is checked before map values.
  const remapToCustom = resolveFlavor(['self-hosted', 'lambda-ci-custom-gpu'], {
    flavorMap: { 'lambda-ci-custom-gpu': 'custom-fpga' },
    customFlavors: [],
  });
  assert.equal(remapToCustom.unresolvedCustom, 'lambda-ci-custom-gpu');
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

// ---- 6. the refusal must be CLASSIFIED, not a bare throw -------------------
//
// The custom-flavor read fails open to `[]`, so "the flavor is not in the catalog" has two causes
// that need opposite handling — and the routing layer cannot tell them apart on its own:
//
//   - deleted / no longer `valid`  ⇒ DETERMINISTIC. Retrying cannot fix it. The run must be marked
//     `failed` with a reason an operator can read, and the SQS message consumed. Throwing instead
//     burns three redeliveries into the DLQ and leaves the row in `provisioning`, which the console
//     renders as a healthy in-flight run — so the operator watches a job hang forever.
//   - the store faulted           ⇒ TRANSIENT. Rethrow so SQS redelivers, and write NO terminal
//     status: `failed` is terminal, so the redelivered message's queued→provisioning guard would
//     refuse to advance the row and return early — the retry would never reach the launch again.

test('the store reports a degraded read distinguishably from an empty one', async () => {
  const { loadRoutableCustomFlavorsResult, routableCustomFlavors } = await import(
    '../dist/src/shared/flavor-store.js'
  );
  // Unconfigured store (no TABLE_NAME) ⇒ the read throws internally ⇒ degraded, not "none".
  const res = await loadRoutableCustomFlavorsResult(42);
  assert.deepEqual(res.flavors, []);
  assert.equal(res.degraded, true, 'a faulted read must not look like an empty installation');
  // ...whereas a successful read of an installation with no valid rows is NOT degraded. Proven on
  // the pure projection the loader wraps, since the loader itself needs DynamoDB.
  assert.deepEqual(routableCustomFlavors([]), []);
  assert.deepEqual(routableCustomFlavors([{ name: 'custom-x', state: 'pending' }]), []);
});

test('the Flavors API keeps that distinction too, instead of showing an empty catalog', async () => {
  const { readFileSync } = await import('node:fs');
  // The console surface is deferred, but the API it will read must not collapse "this installation
  // has no custom flavors" into "we could not read them". An operator who has just registered one
  // would otherwise see it vanish during a DynamoDB blip and register it again — and the screen's
  // entire purpose here, reporting validation progress, would silently report nothing to report.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8'));
  const at = src.indexOf("case 'listFlavors'");
  assert.ok(at > 0, 'listFlavors route is gone');
  const block = src.slice(at, at + 1200);
  // The read is NOT swallowed into a default empty array...
  assert.ok(
    !/listCustomFlavors\(scoped\)\.catch\(\(\) => \[\]\)/.test(block),
    'a failed custom-flavor read is being reported as an empty catalog',
  );
  // ...and the response says which of the two happened.
  assert.match(block, /customFlavorsRead: custom \? 'ok' : 'degraded'/);
});

test('a malformed installation is refused, not silently answered unscoped', async () => {
  const { readFileSync } = await import('node:fs');
  // `asPositiveInt` maps an ABSENT param and a MALFORMED one to the same `undefined`, but they are
  // different requests. Absent is a valid unscoped call (the built-in catalog). Malformed used to
  // fall through to that same branch and return 200 with no custom rows and NO `customFlavorsRead`
  // field — so a client could not distinguish "your scope was dropped" from "this installation has
  // none", which is the exact conflation the degraded-read reporting above exists to prevent. It
  // also skipped `canAdminInstallation` entirely, so the reply shape depended on a typo.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(readFileSync(new URL('../src/mgmt/handler.ts', import.meta.url), 'utf8'));
  const at = src.indexOf("case 'listFlavors'");
  assert.ok(at > 0, 'listFlavors route is gone');
  const block = src.slice(at, at + 1600);

  const guard = block.search(
    /if \(q\.installation !== undefined && asPositiveInt\(q\.installation\) === undefined\)/,
  );
  assert.ok(guard >= 0, 'a malformed ?installation= is not refused');
  assert.match(
    block.slice(guard, guard + 220),
    /problem\(400,/,
    'the malformed-installation branch must return 400, not fall through',
  );
  // The guard has to run BEFORE the scope is resolved, or the unscoped branch answers first.
  const scopeAt = block.search(/const scoped = asPositiveInt\(q\.installation\)/);
  assert.ok(scopeAt > guard, 'the refusal must precede scope resolution');

  // And the semantics it relies on: only absence is a valid unscoped request.
  const { asPositiveInt } = await import('../dist/src/mgmt/router.js');
  assert.equal(asPositiveInt(undefined), undefined, 'absent stays unscoped');
  for (const bad of ['abc', '', '0', '-1', '1.5', '1e3', ' 7']) {
    assert.equal(asPositiveInt(bad), undefined, `${JSON.stringify(bad)} must not scope`);
  }
  assert.equal(asPositiveInt('42'), 42);
});

test('the provisioner marks the run failed on a confirmed-unroutable flavor, and retries a degraded read', async () => {
  const { readFileSync } = await import('node:fs');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(readFileSync(new URL('../src/provision/handler.ts', import.meta.url), 'utf8'));

  // The refusal consults the degraded flag...
  const refusal = src.indexOf('resolution.unresolvedCustom');
  assert.ok(refusal > 0, 'the unresolved-custom refusal is gone');
  const block = src.slice(refusal, refusal + 1600);
  assert.match(block, /if \(customReadDegraded\)/, 'the refusal no longer distinguishes a degraded read');
  // ...rethrows on the transient branch...
  assert.match(block, /throw new Error\(`\$\{detail\}/);
  // ...and writes a terminal `failed` with a reason on the deterministic branch.
  assert.match(block, /to: 'failed'/);
  assert.match(block, /reason,/);

  // The transient branch must NOT write a terminal status: the throw has to come before it.
  assert.ok(
    block.indexOf('if (customReadDegraded)') < block.indexOf("to: 'failed'"),
    'a degraded read must rethrow BEFORE any terminal transition, or the retry cannot advance the row',
  );

  // A lookup that threw outright never performed the custom read, so it is degraded too —
  // otherwise a `getRepo` fault permanently fails a job whose flavor is perfectly valid.
  const fallback = src.slice(src.indexOf('resolve-options lookup failed'));
  assert.match(
    fallback.slice(0, 200),
    /customReadDegraded: true/,
    'a thrown options lookup must count as degraded, not as evidence the flavor is gone',
  );

  // And the degraded signal has to come from the store rather than being assumed.
  assert.match(src, /loadRoutableCustomFlavorsResult/);
});

// ---- 6. the claim gate (ADR-040) -------------------------------------------
//
// Ingest's allowlist check runs BEFORE flavor resolution, so this is the FIRST place a custom
// flavor can be lost: a label absent from the effective allowlist means `claimed:false`, no
// provisioning, and a job that sits queued on GitHub with no error anywhere. The pure derivation
// (`requiredClaimLabels` / `routableCustomFlavors`) is covered in `custom-flavors.test.mjs`, but it
// has no production caller — the live augmentation is `claimLabelsWithCustom` in the ingest
// handler, and these assert THAT.
//
// `TABLE_NAME` is deliberately left unset: the default loader is never reached, because every case
// below injects one.
const { claimLabelsWithCustom } = await import('../dist/src/ingest/handler.js');
const { shouldClaim } = await import('../dist/src/ingest/filter.js');

const CLAIMED = ['lambda-ci', 'lambda-ci-node'];

/** A stored custom-flavor row, complete enough for the projection the augmentation applies. */
function row(over = {}) {
  return {
    pk: 'INSTALL#42',
    sk: 'FLAVOR#custom-gpu',
    entity: 'FLAVOR',
    installationId: 42,
    name: 'custom-gpu',
    base: 'gpu',
    label: 'lambda-ci-custom-gpu',
    arch: 'arm64',
    vcpu: 2,
    memoryMb: 4096,
    capabilities: ['docker'],
    description: 'operator image',
    imageArn: ARN,
    state: 'valid',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function loader(rows, { fail = false } = {}) {
  const state = { calls: 0 };
  return {
    state,
    load: async () => {
      state.calls += 1;
      if (fail) throw new Error('DynamoDB throttled');
      return rows;
    },
  };
}

test('a job naming no custom label performs NO custom-flavor read at claim time', async () => {
  // ADR-040's "no I/O when none are registered" property, at the gate that runs first. The check
  // has to be the JOB'S labels, not the installation's rows, because we cannot know whether rows
  // exist without reading — which is the cost being avoided.
  for (const labels of [
    ['self-hosted', 'lambda-ci'],
    ['ubuntu-latest'],
    [],
    ['self-hosted', 'lambda-ci-node'],
  ]) {
    const l = loader([row()]);
    const res = await claimLabelsWithCustom(labels, CLAIMED, 42, l.load);
    assert.equal(l.state.calls, 0, `read performed for ${JSON.stringify(labels)}`);
    assert.equal(res.read, 'skipped');
    assert.equal(res.labels, CLAIMED, 'the allowlist must be returned unchanged, not copied');
  }
});

test('a VALID custom flavor makes its label claimable for its own installation', async () => {
  const l = loader([row()]);
  const res = await claimLabelsWithCustom(
    ['self-hosted', 'lambda-ci-custom-gpu'],
    CLAIMED,
    42,
    l.load,
  );
  assert.equal(l.state.calls, 1);
  assert.equal(res.read, 'ok');
  assert.ok(res.labels.includes('lambda-ci-custom-gpu'));
  // ...and the gate itself accepts it, which is the property that actually matters.
  assert.equal(
    shouldClaim({ action: 'queued', workflow_job: { labels: ['self-hosted', 'lambda-ci-custom-gpu'], status: 'queued' } }, res.labels),
    true,
  );
  // The built-in allowlist is preserved, not replaced.
  for (const label of CLAIMED) assert.ok(res.labels.includes(label));
});

test('an UNVALIDATED custom flavor is never claimable — image/proof first, label second', async () => {
  // Label-before-proof is strictly worse than leaving the job queued: claiming it removes the
  // GitHub-hosted fallback, so the job then FAILS in provisioning instead of running elsewhere.
  for (const state of ['pending', 'validating', 'invalid']) {
    const l = loader([row({ state })]);
    const res = await claimLabelsWithCustom(
      ['self-hosted', 'lambda-ci-custom-gpu'],
      CLAIMED,
      42,
      l.load,
    );
    assert.equal(res.read, 'ok', state);
    assert.ok(!res.labels.includes('lambda-ci-custom-gpu'), `${state} contributed a label`);
    assert.equal(
      shouldClaim({ action: 'queued', workflow_job: { labels: ['self-hosted', 'lambda-ci-custom-gpu'], status: 'queued' } }, res.labels),
      false,
      `${state} was claimable`,
    );
  }
});

test('a store fault fails CLOSED — the label stays unclaimable rather than being assumed good', async () => {
  // The opposite of the repo-config gate above it, deliberately. Failing open would claim a job
  // whose flavor we could not confirm, and a claimed job can no longer run on GitHub-hosted; the
  // resolution would then land on a built-in image while the runner still advertised the custom
  // label, so the job would SUCCEED on an image it never asked for.
  const l = loader([], { fail: true });
  const res = await claimLabelsWithCustom(
    ['self-hosted', 'lambda-ci-custom-gpu'],
    CLAIMED,
    42,
    l.load,
  );
  assert.equal(l.state.calls, 1);
  assert.equal(res.read, 'degraded', 'a fault must be distinguishable from an empty installation');
  assert.equal(res.labels, CLAIMED, 'a fault must not augment the allowlist');
  assert.equal(
    shouldClaim({ action: 'queued', workflow_job: { labels: ['self-hosted', 'lambda-ci-custom-gpu'], status: 'queued' } }, res.labels),
    false,
  );
});

test('only the OWNING installation\u2019s flavors are consulted, and only their labels are added', async () => {
  // The whole reason this is not an entry in `/lca/<env>/config/runner-labels`: that parameter is
  // environment-scoped, so installation A's label would be claimable for B's jobs, and B would
  // resolve nothing and run the job on `base` having already given up the hosted fallback.
  const l = loader([row(), row({ name: 'custom-other', label: 'lambda-ci-custom-other', state: 'invalid' })]);
  const res = await claimLabelsWithCustom(
    ['self-hosted', 'lambda-ci-custom-gpu'],
    CLAIMED,
    42,
    l.load,
  );
  assert.deepEqual(res.labels, [...CLAIMED, 'lambda-ci-custom-gpu']);
  // The loader is called with the job's installation id, never a default or an ambient one.
  const seen = [];
  await claimLabelsWithCustom(['lambda-ci-custom-gpu'], CLAIMED, 99, async (id) => {
    seen.push(id);
    return [];
  });
  assert.deepEqual(seen, [99]);
});

test('the handler wires the seam rather than keeping a second inline copy', async () => {
  const { readFileSync } = await import('node:fs');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(readFileSync(new URL('../src/ingest/handler.ts', import.meta.url), 'utf8'));
  // `decideClaim` must consume the AUGMENTED set. An inline `claimedLabels` here would make every
  // test above vacuous while leaving custom labels unclaimable in production.
  const at = src.indexOf('const decision = decideClaim(');
  assert.ok(at > 0, 'the claim decision is gone');
  const block = src.slice(at, at + 300);
  assert.match(block, /claimedLabels: effectiveClaimedLabels/);
  assert.match(src, /await claimLabelsWithCustom\(/);
  // ...and the augmentation is not also duplicated inline.
  assert.ok(
    !/routableCustomFlavors\(await listCustomFlavors\(wf\.installation\.id\)\)/.test(src),
    'the inline augmentation is still present alongside the extracted seam',
  );
});

// ---- auto-rewrite must not touch a job that already targets a custom flavor ---------------

test('a job already carrying a custom LCA label needs no rewrite', async () => {
  const { rewriteTargets, planFileRewrite, labelForFlavor } = await import(
    '../dist/src/mgmt/rewrite.js'
  );
  const jobs = [{ id: 'build', runs_on: ['ubuntu-latest', 'lambda-ci-custom-gpu'] }];

  // The operator already targeted LCA with that label, so there is no hosted label we are
  // entitled to replace — regardless of what the STORED route says the job resolved to.
  for (const flavor of ['custom-gpu', 'base']) {
    assert.deepEqual(
      rewriteTargets(jobs, { build: { flavor } }),
      [],
      `a custom-labelled job became a rewrite target (stored route '${flavor}')`,
    );
  }

  // Authoring stays built-in only (a custom label is revocable, so we must never commit one):
  // `labelForFlavor` still refuses to name a custom flavor.
  assert.equal(labelForFlavor('custom-gpu'), undefined);

  // And the write path re-checks independently of `rewriteTargets`, because it plans against the
  // CURRENT file while the target list came from a possibly stale stored analysis. This is the
  // branch that actually authored the bad edit: with the route degraded to a built-in — discovery's
  // custom-flavor read fails open (ADR-040) — it produced
  // `[self-hosted, lambda-ci-custom-gpu, lambda-ci]`, a second LCA label in a customer's file.
  const yaml = [
    'name: ci',
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: [ubuntu-latest, lambda-ci-custom-gpu]',
    '      steps:',
    '        - run: echo hi',
    '',
  ].join('\n');
  for (const flavor of ['custom-gpu', 'base']) {
    const plan = planFileRewrite('.github/workflows/ci.yml', yaml, [{ jobId: 'build', flavor }]);
    assert.deepEqual(plan.edits, [], `an edit was authored for stored route '${flavor}'`);
    assert.equal(plan.skipped.length, 1);
    assert.match(
      plan.skipped[0].reason,
      /already carries an LCA label/,
      `skip reason should name the real cause, got: ${plan.skipped[0].reason}`,
    );
  }
});

test('a job routed to a custom flavor by FlavorMap is skipped, not relabelled to a built-in', async () => {
  const { rewriteTargets, planFileRewrite, planPreviewFromAnalyses } = await import(
    '../dist/src/mgmt/rewrite.js'
  );
  // The other reachable route to a custom flavor, and the one the label check above cannot cover:
  // the job's `runs-on` carries only a HOSTED label, and the repo's FlavorMap points that label at
  // a custom flavor. Inserting `lambda-ci` here does not merely add a label — it REMOVES
  // `ubuntu-latest`, the key the FlavorMap entry is on, so the job would be pinned to `base`
  // forever by an edit we made in the customer's own repository.
  const jobs = [{ id: 'build', runs_on: ['ubuntu-latest'] }];
  const yaml = [
    'name: ci',
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '      steps:',
    '        - run: echo hi',
    '',
  ].join('\n');

  // (a) The route RESOLVED to the custom flavor. Authoring stays built-in only, so the honest
  //     answer is a skip that names the flavor — not `unknown flavor 'custom-gpu'`, which would
  //     tell an operator their registered, validated flavor does not exist.
  const resolved = rewriteTargets(jobs, { build: { flavor: 'custom-gpu' } });
  assert.equal(resolved.length, 1, 'the job should still appear in the plan as a skip');
  assert.match(resolved[0].skip ?? '', /custom flavor 'custom-gpu'/);
  const resolvedPlan = planFileRewrite('.github/workflows/ci.yml', yaml, resolved);
  assert.deepEqual(resolvedPlan.edits, []);
  assert.match(resolvedPlan.skipped[0].reason, /per-installation and revocable/);
  assert.doesNotMatch(resolvedPlan.skipped[0].reason, /unknown flavor/);

  // (b) The route could NOT be resolved. Discovery's custom-flavor read fails OPEN (ADR-040), so a
  //     DynamoDB fault stores the identical route a genuinely deleted flavor would — `flavor:
  //     'base'` — with `unresolvedCustom` as the only evidence that `base` is a fall-through and
  //     not the operator's intent. Acting on `flavor` alone acts on a possible FALSE absence.
  const degraded = rewriteTargets(jobs, {
    build: { flavor: 'base', unresolvedCustom: 'custom-gpu' },
  });
  assert.equal(degraded.length, 1);
  assert.match(degraded[0].skip ?? '', /could not be resolved/);
  const degradedPlan = planFileRewrite('.github/workflows/ci.yml', yaml, degraded);
  assert.deepEqual(
    degradedPlan.edits,
    [],
    'an edit was authored over a route that could not be resolved — this silently discards the ' +
      "operator's custom-flavor routing in their own repository",
  );
  assert.match(degradedPlan.skipped[0].reason, /custom flavor 'custom-gpu'/);

  // The console dry run must agree with the λ, or the operator approves a plan that then differs.
  for (const routes of [
    { build: { flavor: 'custom-gpu' } },
    { build: { flavor: 'base', unresolvedCustom: 'custom-gpu' } },
  ]) {
    const preview = planPreviewFromAnalyses([
      { path: '.github/workflows/ci.yml', parsed: { jobs }, routes },
    ]);
    assert.equal(preview.changes, 0, `preview proposed an edit for ${JSON.stringify(routes)}`);
    assert.equal(preview.skipped, 1);
    assert.match(preview.jobs[0].skipped ?? '', /custom flavor 'custom-gpu'/);
    assert.doesNotMatch(preview.jobs[0].skipped ?? '', /unknown flavor/);
  }
});

test('an ordinary built-in route is still rewritten exactly as before', async () => {
  const { rewriteTargets, planFileRewrite, planPreviewFromAnalyses } = await import(
    '../dist/src/mgmt/rewrite.js'
  );
  // The guard above must not cost the built-in path anything: no custom flavor is named anywhere,
  // so nothing is skipped and the edit is authored as it was pre-ADR-040.
  const jobs = [{ id: 'build', runs_on: ['ubuntu-latest'] }];
  const yaml = [
    'name: ci',
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '      steps:',
    '        - run: echo hi',
    '',
  ].join('\n');
  for (const routes of [{}, { build: { flavor: 'node' } }]) {
    const targets = rewriteTargets(jobs, routes);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].skip, undefined);
    const plan = planFileRewrite('.github/workflows/ci.yml', yaml, targets);
    assert.equal(plan.edits.length, 1, `no edit authored for ${JSON.stringify(routes)}`);
    assert.deepEqual(plan.skipped, []);
    const preview = planPreviewFromAnalyses([
      { path: '.github/workflows/ci.yml', parsed: { jobs }, routes },
    ]);
    assert.equal(preview.changes, 1);
    assert.equal(preview.skipped, 0);
  }
});
