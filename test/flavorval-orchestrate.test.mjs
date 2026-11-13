// Custom-flavor smoke-run orchestrator (ADR-041 gate 2).
//
// The predecessor card landed the DECISION logic — `staticGate`, `classifySmoke`, the state
// machine — and stopped at a safe seam where nothing could reach `valid`. This file pins the
// ORCHESTRATION that closes it, and the properties it pins are exactly the ones that cannot be
// read off the pure functions:
//
//   1. A static-gate failure about the image is terminal `invalid`.
//   2. An INCONCLUSIVE static gate (a probe that could not run) is `pending`, never `invalid`.
//   3. Every `classifySmoke` outcome is reachable through the real orchestration.
//   4. An orchestration error — a thrown GitHub/AWS fault — returns the row to `pending`.
//   5. The microVM is terminated on EVERY exit path, including the throwing ones.
//   6. Losing the `pending → validating` race writes NOTHING.
//
// 4 and 5 are the reason the orchestrator takes injected effects at all: they are control-flow
// properties, and a control flow wired to real clients could only be tested by deploying it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runValidation,
  splitRepoFullName,
  bounded,
  reserveFits,
  EffectTimeoutError,
  LaunchRejectedError,
  CLEANUP_STEPS,
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '../dist/src/flavorval/orchestrate.js';
import { smokeLabel, isSmokeLabel } from '../dist/src/flavorval/validate-core.js';
import { sweepExpiredFlavorClaims, SWEEP_ACTOR } from '../dist/src/flavorval/sweep.js';

const INSTALL = 42;
const NAME = 'custom-gpu';

/** A registered flavor that passes every static check. */
function goodFlavor(over = {}) {
  return {
    pk: `INSTALL#${INSTALL}`,
    sk: `FLAVOR#${NAME}`,
    entity: 'FLAVOR',
    installationId: INSTALL,
    name: NAME,
    base: 'gpu',
    label: 'lambda-ci-custom-gpu',
    arch: 'arm64',
    vcpu: 2,
    memoryMb: 4096,
    capabilities: ['python'],
    description: 'CUDA smoke image',
    imageArn: 'arn:aws:lambda:us-west-2:123456789012:microvm-image:gpu',
    smokeRepoFullName: 'acme/ci',
    smokeWorkflowPath: '.github/workflows/lca-flavor-validate.yml',
    state: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/**
 * A scripted scenario. Every effect records its calls so a test can assert on the SEQUENCE, and
 * the polling loop is driven by a virtual clock so a deadline test does not wait for one.
 */
function scenario(opts = {}) {
  const calls = [];
  const record = (name, arg) => calls.push(arg === undefined ? { name } : { name, arg });
  let clock = 1_700_000_000_000;
  let polls = 0;
  const transitions = [];
  const flavor = opts.flavor === null ? undefined : (opts.flavor ?? goodFlavor());

  const deps = {
    getFlavor: async () => {
      record('getFlavor');
      return flavor;
    },
    // The claim is recorded in `transitions` as `to: 'validating'` so a test reads the whole state
    // sequence from one list.
    claim: async (input) => {
      transitions.push({ ...input, to: 'validating' });
      record('transition', 'validating');
      return !opts.claimRefused;
    },
    fence: async () => record('fence'),
    transition: async (input) => {
      transitions.push(input);
      record('transition', input.to);
      if (opts.verdictRefused) return false;
      return true;
    },
    probeImage: async () => {
      record('probeImage');
      return opts.image ?? { usable: true, state: 'CREATED' };
    },
    defaultBranch: async () => {
      record('defaultBranch');
      if (opts.throwOn === 'defaultBranch') throw new Error('GitHub 500 on repo read');
      return 'main';
    },
    mintSmokeRunner: async (input) => {
      record('mintSmokeRunner', input.label);
      if (opts.throwOn === 'mint') throw new Error('GitHub 422 on jitconfig');
      return { jitConfig: 'encoded', runnerId: 777 };
    },
    beginSmoke: async (input) => {
      record('beginSmoke', input.seq);
      return { ref: `SMOKE#${INSTALL}#${input.seq}#JITCONFIG`, token: 'tok' };
    },
    launch: async (input) => {
      record('launch', input);
      if (opts.throwOn === 'launch') throw new LaunchRejectedError('RunMicrovm quota exceeded');
      return { microvmId: 'mvm-1' };
    },
    stampVm: async () => record('stampVm'),
    dispatch: async (input) => {
      record('dispatch', input.nonce);
      if (opts.dispatchDelayMs) clock += opts.dispatchDelayMs;
      if (opts.throwOn === 'dispatch') throw new Error('GitHub 404 on workflow dispatch');
    },
    listRunners: async () => {
      record('listRunners');
      return opts.runners?.(polls) ?? [];
    },
    listDispatchRuns: async () => {
      record('listDispatchRuns');
      return opts.runs?.(polls, clock) ?? [];
    },
    listRunJobs: async (input) => {
      record('listRunJobs', input.runId);
      if (opts.throwOn === 'listRunJobs') throw new Error('GitHub 500 on run jobs');
      // Default: the run carries our nonce label, i.e. it IS ours. A test that models a foreign
      // dispatch overrides this.
      return (
        opts.runJobs?.(input.runId) ?? [
          { id: 1, labels: ['self-hosted', smokeLabel('abc123')], runnerName: 'lca-validate-abc123' },
        ]
      );
    },
    listVms: async () => {
      record('listVms');
      return opts.vms?.(polls) ?? [{ microvmId: 'mvm-1', state: 'RUNNING' }];
    },
    terminateVm: async (id) => {
      record('terminateVm', id);
      if (opts.throwOn === 'terminate') throw new Error('already terminated');
    },
    deleteRunner: async (input) => record('deleteRunner', input.runnerId),
    cancelRun: async (input) => {
      record('cancelRun', input.runId);
      if (opts.throwOn === 'cancelRun') throw new Error('GitHub 500 on run cancel');
    },
    endSmoke: async (seq) => record('endSmoke', seq),
    now: () => clock,
    sleep: async (ms) => {
      polls += 1;
      clock += ms;
    },
    nonce: () => 'abc123',
    log: () => {},
  };
  return { deps, calls, transitions, names: () => calls.map((c) => c.name) };
}

/**
 * Make the named effects NEVER settle — and ignore their AbortSignal, which is the worst case: the
 * deadline must hold because `bounded` gives up on the effect, not because the effect cooperates.
 * Each hung call records the signal it was handed, so a test can also check it was aborted.
 *
 * `transition` is keyed by its target state (`transition:validating`, `transition:valid`, …) so a
 * test can hang the claim, the verdict or the release independently.
 */
function hang(s, effects) {
  const signals = [];
  const wanted = new Set(effects);
  for (const name of Object.keys(s.deps)) {
    if (name === 'transition' || name === 'claim' || !wanted.has(name)) continue;
    const original = s.deps[name];
    s.deps[name] = (...args) => {
      s.calls.push({ name, arg: 'HUNG' });
      signals.push({ name, signal: args.find((a) => a instanceof AbortSignal) });
      void original;
      return new Promise(() => {});
    };
  }
  const transition = s.deps.transition;
  s.deps.transition = (input, signal) => {
    if (wanted.has(`transition:${input.to}`)) {
      s.transitions.push(input);
      s.calls.push({ name: 'transition', arg: `${input.to}:HUNG` });
      signals.push({ name: `transition:${input.to}`, signal });
      return new Promise(() => {});
    }
    return transition(input, signal);
  };
  const claim = s.deps.claim;
  s.deps.claim = (input, signal) => {
    if (wanted.has('transition:validating')) {
      s.transitions.push({ ...input, to: 'validating' });
      s.calls.push({ name: 'transition', arg: 'validating:HUNG' });
      signals.push({ name: 'transition:validating', signal });
      return new Promise(() => {});
    }
    return claim(input, signal);
  };
  return signals;
}

/**
 * Real-time ceilings small enough that a hung effect costs milliseconds, against a virtual clock
 * whose main phase is long — so a test that passes proves the EFFECT ceiling bounded the run, not
 * the polling deadline.
 */
const HANG = {
  ...DEFAULT_ORCHESTRATOR_CONFIG,
  deadlineMs: 60_000,
  reserveMs: 5_000,
  pollIntervalMs: 1_000,
  selfTerminateWaitMs: 5_000,
  effectTimeoutMs: 25,
  verdictTimeoutMs: 25,
  cleanupStepTimeoutMs: 25,
};

/** Fail the test rather than hang the suite if the run does not end on its own. */
async function withinMs(ms, promise) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`run did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

const FAST = { ...DEFAULT_ORCHESTRATOR_CONFIG, deadlineMs: 60_000, reserveMs: 5_000, pollIntervalMs: 1_000, selfTerminateWaitMs: 5_000 };

/** A run that succeeds on the first poll: runner present, job green, VM gone. */
function happyOpts(over = {}) {
  return {
    // `status: 'online'` because minting the JIT config already registers the runner — see the
    // connected-runner test below.
    runners: () => [
      { id: 777, name: 'lca-validate-abc123', labels: ['lca-validate-abc123'], status: 'online' },
    ],
    runs: (_p, clock) => [{ id: 9001, status: 'completed', conclusion: 'success', createdAt: clock }],
    vms: () => [],
    ...over,
  };
}

test('a passing smoke run writes valid with the observed evidence', async () => {
  const s = scenario(happyOpts());
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.ran, true);
  assert.equal(res.state, 'valid');
  assert.equal(res.verdictWritten, true);
  assert.match(res.reason, /runner registered/);
  // Evidence must be what was OBSERVED, not what was hoped for.
  assert.equal(res.evidence.microvmId, 'mvm-1');
  assert.equal(res.evidence.runnerId, 777);
  assert.equal(res.evidence.workflowRunId, 9001);
  assert.equal(res.evidence.workflowConclusion, 'success');
  assert.equal(res.evidence.selfTerminated, true);
  assert.equal(res.evidence.imageArn, goodFlavor().imageArn);
  // The claim, then the verdict. Nothing else may write state.
  assert.deepEqual(
    s.transitions.map((t) => t.to),
    ['validating', 'valid'],
  );
});

test('the smoke runner is minted with ONLY the one-shot nonce label', async () => {
  const s = scenario(happyOpts());
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  const mint = s.calls.find((c) => c.name === 'mintSmokeRunner');
  assert.equal(mint.arg, smokeLabel('abc123'));
  // Outside the `lambda-ci*` namespace, so ingest's claim gate can never allowlist it and the
  // smoke runner can never take a real queued job.
  assert.equal(isSmokeLabel(mint.arg), true);
  assert.equal(mint.arg.startsWith('lambda-ci'), false);
});

test('a static-gate failure about the image is TERMINAL invalid and costs no microVM', async () => {
  const s = scenario({
    image: { usable: false, state: 'ABSENT' },
    ...happyOpts(),
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /static checks failed/);
  assert.match(res.reason, /not in a launchable state/);
  // The whole point of running the cheap gate first.
  assert.equal(s.names().includes('launch'), false);
  assert.equal(s.names().includes('mintSmokeRunner'), false);
});

test('a static gate that could not RUN is pending, never invalid', async () => {
  // `UNKNOWN` + error is `getMicroVMImageState`'s "the probe itself failed" answer. Spending
  // terminal `invalid` on it would permanently condemn a working image over a throttle.
  const s = scenario({
    image: { usable: false, state: 'UNKNOWN', error: 'ThrottlingException' },
    ...happyOpts(),
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'pending');
  assert.match(res.reason, /not a verdict about the image/);
  assert.match(res.reason, /ThrottlingException/);
  assert.equal(s.names().includes('launch'), false);
});

test('a flavor with no smoke repo is invalid with an actionable reason', async () => {
  const s = scenario({ flavor: goodFlavor({ smokeRepoFullName: undefined }), ...happyOpts() });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /smoke repository is required/);
  assert.equal(s.names().includes('launch'), false);
});

// ---- every classifySmoke outcome, reached through the real orchestration ----

test('the runner never registering is invalid — the ADR-019/020 docker failure mode', async () => {
  const s = scenario({
    runners: () => [],
    // Never concludes and never starts: the agent did not come up.
    runs: () => [],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /never registered with GitHub/);
  assert.equal(res.evidence.selfTerminated, false);
});

test('a registered runner whose job never concludes is invalid (timed out)', async () => {
  const s = scenario({
    runners: () => [
      { id: 777, name: 'r', labels: ['lca-validate-abc123'], status: 'online' },
    ],
    runs: (_p, clock) => [{ id: 9001, status: 'queued', conclusion: null, createdAt: clock }],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /never reached a conclusion/);
});

test('the job is dispatched with the LABEL the runner advertises, not the bare nonce', async () => {
  // The live defect that made every good image look broken. The smoke workflow interpolates its
  // `lca_nonce` input straight into `runs-on`, so the dispatched value IS the label GitHub matches
  // against the runner's advertised labels — and the runner advertises `smokeLabel(nonce)`.
  // Dispatching the bare hex leaves the job permanently unmatched: observed live on 2026-08-20 with
  // job labels `[self-hosted, <hex>]` that no runner could ever satisfy.
  const s = scenario(happyOpts());
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  const dispatched = s.calls.find((c) => c.name === 'dispatch')?.arg;
  assert.equal(dispatched, smokeLabel('abc123'));
  assert.equal(isSmokeLabel(dispatched), true);
  // And it is exactly what was minted, so the two sides cannot drift apart again.
  assert.equal(dispatched, s.calls.find((c) => c.name === 'mintSmokeRunner')?.arg);
});

test('a runner registration created by our own MINT is not evidence the agent started', async () => {
  // `generate-jitconfig` registers the runner as a side effect of minting it — verified live: the
  // row appears immediately with `status: "offline"`, before any agent connects. Matching on the
  // label alone therefore observes OUR OWN MINT, which scored the deliberately broken fixture
  // (`run.sh` exits 127) as `runnerRegistered: true` on 2026-08-20 and condemned it with the wrong
  // reason. Only `online`/`busy` is evidence about the image.
  const s = scenario({
    runners: () => [
      {
        id: 777,
        name: 'lca-validate-abc123',
        labels: ['lca-validate-abc123'],
        status: 'offline',
        busy: false,
      },
    ],
    runs: () => [],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /never registered with GitHub/);
});

test('a BUSY runner counts as registered even without an online status', async () => {
  // Mid-job, GitHub can report the runner busy while its status field lags. Demanding `online`
  // alone would fail a good image for taking the job too promptly.
  const s = scenario({
    ...happyOpts(),
    runners: () => [
      { id: 777, name: 'lca-validate-abc123', labels: ['lca-validate-abc123'], busy: true },
    ],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'valid');
  assert.equal(res.evidence.runnerId, 777);
});

test('a failing job is invalid and names the conclusion', async () => {
  const s = scenario({
    ...happyOpts(),
    runs: (_p, clock) => [{ id: 9001, status: 'completed', conclusion: 'failure', createdAt: clock }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /concluded 'failure'/);
});

test('a green job on a VM that never self-terminates is invalid (ADR-021 unproven)', async () => {
  const s = scenario({
    ...happyOpts(),
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /did not self-terminate/);
  assert.equal(res.evidence.workflowConclusion, 'success');
  assert.equal(res.evidence.selfTerminated, false);
});

test('a fast job seen only via the run status still counts as a registered runner', async () => {
  // A single-use JIT runner removes itself when its job ends, so a fast job can complete entirely
  // between two polls and NEVER appear in the runner list. GitHub does not execute a job without a
  // runner, so the run reaching `completed` is equally good proof. Without this the orchestrator
  // would fail a perfectly good fast image with "the runner never registered".
  const s = scenario({
    runners: () => [],
    runs: (_p, clock) => [{ id: 9001, status: 'completed', conclusion: 'success', createdAt: clock }],
    vms: () => [],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'valid');
});

test('a slow dispatch response cannot exclude the run created during the request', async () => {
  const dispatchedSecond = 1_700_000_000_000;
  const s = scenario({
    dispatchDelayMs: 1_500,
    runners: () => [],
    // GitHub created this while handling dispatch, before its 1.5 s response returned.
    runs: () => [
      { id: 9001, status: 'completed', conclusion: 'success', createdAt: dispatchedSecond },
    ],
    vms: () => [],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'valid');
  assert.equal(res.evidence.workflowRunId, 9001);
});

test('a run created BEFORE our dispatch is not ours', async () => {
  const s = scenario({
    runners: () => [
      { id: 777, name: 'r', labels: ['lca-validate-abc123'], status: 'online' },
    ],
    // An older workflow_dispatch run, green — must not be mistaken for this validation's job.
    runs: (_p, clock) => [
      { id: 8000, status: 'completed', conclusion: 'success', createdAt: clock - 3_600_000 },
    ],
    vms: () => [],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /never reached a conclusion/);
  assert.equal(res.evidence.workflowRunId, undefined);
  // Rejected on time alone — no need to fetch its jobs.
  assert.equal(s.names().includes('listRunJobs'), false);
});

test('a CONCURRENT foreign dispatch cannot lend its green conclusion to our image', async () => {
  // The misattribution hole: a manual or concurrent `workflow_dispatch` of the same workflow, in
  // the same second, satisfies the timestamp window. Accepting it would mark an image `valid` on
  // evidence from a run that never touched it — the exact outcome ADR-041 exists to prevent.
  // GitHub's runners are label-matched, not bound to the job they were minted for, so the nonce is
  // the only sound correlation.
  const s = scenario({
    runners: () => [],
    runs: (_p, clock) => [
      { id: 9999, status: 'completed', conclusion: 'success', createdAt: clock },
    ],
    // Someone else's dispatch: a real run, green, with no trace of our nonce.
    runJobs: () => [
      { id: 1, labels: ['self-hosted', 'lambda-ci'], runnerName: 'lca-31242242937-93065894535-ab' },
    ],
    vms: () => [],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.notEqual(res.state, 'valid');
  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /never registered with GitHub/);
  // The foreign run must not be recorded as ours in the evidence either.
  assert.equal(res.evidence.workflowRunId, undefined);
  assert.equal(res.evidence.workflowConclusion, undefined);
});

test('our run is confirmed by the nonce LABEL on its job', async () => {
  const s = scenario({
    runners: () => [],
    runs: (_p, clock) => [{ id: 9001, status: 'completed', conclusion: 'success', createdAt: clock }],
    runJobs: () => [{ id: 1, labels: ['self-hosted', smokeLabel('abc123')] }],
    vms: () => [],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'valid');
  assert.equal(res.evidence.workflowRunId, 9001);
});

test('our run is confirmed by the minted RUNNER NAME when labels are absent', async () => {
  // Second, independent evidence path: the AgentName we minted embeds the nonce, and it is what
  // GitHub reports as the runner that actually served the job.
  const s = scenario({
    runners: () => [],
    runs: (_p, clock) => [{ id: 9001, status: 'completed', conclusion: 'success', createdAt: clock }],
    runJobs: () => [{ id: 1, labels: [], runnerName: 'lca-validate-abc123' }],
    vms: () => [],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'valid');
});

test('a foreign run is not re-checked on every poll', async () => {
  const s = scenario({
    runners: () => [],
    runs: (_p, clock) => [{ id: 9999, status: 'completed', conclusion: 'success', createdAt: clock }],
    runJobs: () => [{ id: 1, labels: ['self-hosted'] }],
    vms: () => [],
  });
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  const jobFetches = s.calls.filter((c) => c.name === 'listRunJobs');
  assert.equal(jobFetches.length, 1, 'a rejected candidate is remembered, not re-fetched');
});

test('an unreachable jobs API fails CLOSED — no nonce evidence means not ours', async () => {
  // The cost of failing closed is a `pending` on a GitHub fault (retryable). The cost of failing
  // open would be a routable image that never ran anything.
  const s = scenario({ ...happyOpts(), throwOn: 'listRunJobs' });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.notEqual(res.state, 'valid');
  assert.equal(res.state, 'pending');
});

// ---- orchestration faults are OUR fault, not the image's --------------------

for (const stage of ['defaultBranch', 'mint', 'launch', 'dispatch']) {
  test(`an orchestration error at ${stage} returns the flavor to pending, NOT invalid`, async () => {
    const s = scenario({ ...happyOpts(), throwOn: stage });
    const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

    assert.equal(res.state, 'pending');
    assert.notEqual(res.state, 'invalid');
    assert.match(res.reason, /validation could not complete \(not a verdict about the image\)/);
    // `pending` is a legal transition out of `validating` and exists precisely for this, so the
    // row is left retryable rather than stuck.
    assert.deepEqual(
      s.transitions.map((t) => t.to),
      ['validating', 'pending'],
    );
  });
}

test('a launch failure is pending and reports the VM as never launched', async () => {
  const s = scenario({ ...happyOpts(), throwOn: 'launch' });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'pending');
  assert.equal(res.evidence.microvmId, undefined);
});

// ---- cleanup on every exit path -------------------------------------------

test('the microVM is terminated after a PASSING run', async () => {
  const s = scenario(happyOpts());
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  const term = s.calls.find((c) => c.name === 'terminateVm');
  assert.equal(term?.arg, 'mvm-1');
});

test('the microVM is terminated after a FAILING run', async () => {
  const s = scenario({ ...happyOpts(), vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }] });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'invalid');
  assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1');
});

test('the microVM is terminated when the orchestration THROWS after launch', async () => {
  // The path that would leak a VM if cleanup lived on the happy path: the launch succeeded, so a
  // real VM is alive, and the very next call blew up.
  const s = scenario({ ...happyOpts(), throwOn: 'dispatch' });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'pending');
  assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1');
});

test('the leftover runner registration and smoke rows are always cleaned up', async () => {
  const s = scenario({ ...happyOpts(), throwOn: 'dispatch' });
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(s.calls.find((c) => c.name === 'deleteRunner')?.arg, 777);
  assert.equal(s.names().includes('endSmoke'), true);
});

test('a failing terminate does not prevent the runner/smoke cleanup or the verdict', async () => {
  const s = scenario({ ...happyOpts(), throwOn: 'terminate' });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'valid');
  assert.equal(s.names().includes('deleteRunner'), true);
  assert.equal(s.names().includes('endSmoke'), true);
});

test('a smoke run that never concluded is CANCELLED, so no queued run is left behind', async () => {
  // A dispatched run nothing can serve sits `queued` in the operator's Actions tab until GitHub
  // expires it 24 hours later (live-observed: the 2026-08-20 run was auto-cancelled at 22:45 the
  // NEXT day). Condemning an image must not also leave residue in someone else's repository — the
  // same standard `deleteRunner` is held to.
  const s = scenario({
    ...happyOpts(),
    runs: (_p, clock) => [{ id: 9001, status: 'queued', conclusion: null, createdAt: clock }],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.equal(s.calls.find((c) => c.name === 'cancelRun')?.arg, 9001);
});

test('a run that CONCLUDED on its own is never cancelled', async () => {
  const s = scenario(happyOpts());
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'valid');
  assert.equal(s.names().includes('cancelRun'), false);
});

test('a run never CONFIRMED ours is not cancelled — cleanup cannot touch a bystander', async () => {
  // Only nonce-confirmed evidence may drive a cancel. A concurrent foreign dispatch satisfies the
  // timestamp window, and cancelling it would mean this validation reached into an unrelated run.
  const s = scenario({
    ...happyOpts(),
    runs: (_p, clock) => [{ id: 9999, status: 'queued', conclusion: null, createdAt: clock }],
    runJobs: () => [{ id: 1, labels: ['self-hosted', 'lambda-ci'], runnerName: 'someone-else' }],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(s.names().includes('cancelRun'), false);
});

test('a failing cancel does not prevent the terminate, runner delete or smoke cleanup', async () => {
  const s = scenario({
    ...happyOpts(),
    throwOn: 'cancelRun',
    runs: (_p, clock) => [{ id: 9001, status: 'queued', conclusion: null, createdAt: clock }],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'invalid');
  assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1');
  assert.equal(s.names().includes('endSmoke'), true);
});

test('cleanup runs AFTER the verdict is written, so a slow terminate cannot cost the verdict', async () => {
  const s = scenario(happyOpts());
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  const names = s.names();
  assert.ok(names.lastIndexOf('transition') < names.indexOf('terminateVm'));
});

// ---- concurrency + lifecycle guards ---------------------------------------

test('losing the pending → validating race writes NOTHING and launches nothing', async () => {
  const s = scenario({ ...happyOpts(), claimRefused: true });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.ran, false);
  assert.equal(res.skipped, 'not-pending');
  // Exactly one transition attempt — the refused claim. The winner's verdict is untouched.
  assert.equal(s.transitions.length, 1);
  assert.equal(s.names().includes('launch'), false);
  assert.equal(s.names().includes('probeImage'), false);
});

test('a deleted flavor is a no-op, not an error', async () => {
  const s = scenario({ flavor: null });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.ran, false);
  assert.equal(res.skipped, 'not-found');
  assert.equal(s.transitions.length, 0);
});

test('a verdict refused mid-run is reported, not retried', async () => {
  // The condition expression refuses precisely when the row moved underneath us (a manual
  // re-validate reopened `validating → pending`), in which case OUR verdict is the stale one.
  const s = scenario({ ...happyOpts(), verdictRefused: true });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'valid');
  assert.equal(res.verdictWritten, false);
  assert.equal(s.transitions.filter((t) => t.to === 'valid').length, 1);
  // Still cleaned up: the VM is ours regardless of who owns the record.
  assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1');
});

test('the deadline stops polling with enough budget left to write a verdict', async () => {
  // Nothing ever resolves. The run must still end with a recorded outcome rather than spinning
  // until the λ is killed — a λ killed by its timeout writes nothing and strands the row in
  // `validating`, inert until an operator re-validates.
  const s = scenario({ runners: () => [], runs: () => [], vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }] });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.ran, true);
  assert.equal(res.state, 'invalid');
  assert.equal(res.verdictWritten, true);
  assert.ok(res.evidence.finishedAt);
});

test('a validating row is claimed only from pending — the state itself is not re-derived', async () => {
  // The orchestrator does NOT inspect `rec.state` to decide whether to proceed: it asks for the
  // transition and believes the conditional write. A row already `validating` therefore refuses
  // the claim at the store, which is the only place the rule can be enforced atomically.
  const s = scenario({ flavor: goodFlavor({ state: 'validating' }), ...happyOpts(), claimRefused: true });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.skipped, 'not-pending');
});

// ---- helpers ---------------------------------------------------------------

test('splitRepoFullName accepts owner/repo and refuses anything else', () => {
  assert.deepEqual(splitRepoFullName('acme/ci'), { owner: 'acme', repo: 'ci' });
  for (const bad of ['acme', 'acme/', '/ci', 'a/b/c', '']) {
    assert.equal(splitRepoFullName(bad), undefined, `should refuse '${bad}'`);
  }
});

// ---- the HARD deadline: effects that never answer ---------------------------
//
// Review finding (verdict 1794537767378-d17ee2:2): the deadline used to be checked only between
// polls, so one GitHub/AWS call that never answered consumed the whole Lambda timeout, the λ was
// killed, and the row stayed `validating` with the VM and runner registration left behind. The
// deadline test above advances a fake clock through `sleep` and therefore could not see it. These
// make the effect itself never settle.

/** Every main-phase effect after the claim, in the order the run reaches them. */
const MAIN_PHASE_EFFECTS = [
  'probeImage',
  'defaultBranch',
  'mintSmokeRunner',
  'beginSmoke',
  'launch',
  'stampVm',
  'dispatch',
  'listRunners',
  'listDispatchRuns',
  'listRunJobs',
  'listVms',
];

for (const effect of MAIN_PHASE_EFFECTS) {
  test(`a ${effect} that NEVER answers ends in pending, with cleanup, inside the budget`, async () => {
    // `listVms` is only polled once the runner registered; keep the run going until then.
    const s = scenario({
      ...happyOpts(),
      vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
    });
    const signals = hang(s, [effect]);
    const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));

    assert.ok(s.calls.some((c) => c.name === effect && c.arg === 'HUNG'), `${effect} was not reached`);
    // A hung GitHub/AWS call says nothing about the image: `pending`, never `invalid`.
    assert.equal(res.state, 'pending');
    assert.equal(res.verdictWritten, true);
    assert.match(res.reason, new RegExp(`${effect} did not answer`));
    assert.equal(s.transitions.at(-1).to, 'pending');
    // The hung call was told to stop, so a real client drops its socket.
    for (const { signal } of signals) assert.equal(signal?.aborted, true);
    // Cleanup ran for whatever had been created by then.
    const at = MAIN_PHASE_EFFECTS.indexOf(effect);
    const launched = at > MAIN_PHASE_EFFECTS.indexOf('launch');
    assert.equal(
      s.calls.some((c) => c.name === 'terminateVm'),
      launched,
      'terminate iff a VM id is known (a hung launch is RETRIED, see below)',
    );
    if (effect === 'launch') {
      // The hung launch may have created a VM: cleanup re-issues it under the same clientToken.
      const launches = s.calls.filter((c) => c.name === 'launch');
      assert.equal(launches.length, 2, 'cleanup must retry a launch whose response was lost');
    }
    // From the mint on, the registration may exist — deleted by id, or found by its nonce name.
    const minted = at >= MAIN_PHASE_EFFECTS.indexOf('mintSmokeRunner');
    assert.equal(s.calls.some((c) => c.name === 'deleteRunner'), minted);
  });
}

test('a VERDICT write that never answers releases the row to pending, then still cleans up', async () => {
  const s = scenario(happyOpts());
  hang(s, ['transition:valid']);
  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));

  assert.equal(res.state, 'pending');
  assert.equal(res.verdictWritten, true);
  const release = s.transitions.at(-1);
  assert.equal(release.to, 'pending');
  // ONLY from `validating`: if the hung verdict did land after all, the release is refused and the
  // verdict stands.
  assert.deepEqual(release.from, ['validating']);
  assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1');
});

test('a hung verdict AND a hung release still return, still clean up', async () => {
  const s = scenario(happyOpts());
  hang(s, ['transition:valid', 'transition:pending']);
  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.verdictWritten, false);
  assert.ok(s.names().includes('terminateVm'));
  assert.ok(s.names().includes('deleteRunner'));
  assert.ok(s.names().includes('endSmoke'));
});

test('every cleanup step hanging cannot stop the next one, nor the run from returning', async () => {
  // A smoke run that never concluded, so cleanup has all four steps to do (including the cancel).
  const s = scenario({
    runners: () => [{ id: 777, name: 'lca-validate-abc123', labels: ['lca-validate-abc123'], status: 'online' }],
    runs: (_p, clock) => [{ id: 9001, status: 'in_progress', conclusion: null, createdAt: clock }],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const signals = hang(s, ['terminateVm', 'deleteRunner', 'cancelRun', 'endSmoke']);
  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));

  assert.equal(res.state, 'invalid');
  assert.equal(res.verdictWritten, true);
  assert.deepEqual(
    signals.map((x) => x.name),
    ['terminateVm', 'deleteRunner', 'cancelRun', 'endSmoke'],
  );
  for (const { signal } of signals) assert.equal(signal?.aborted, true);
});

test('a hung CLAIM fences its token, releases from validating only, and launches nothing', async () => {
  const s = scenario(happyOpts());
  hang(s, ['transition:validating']);
  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));

  assert.equal(res.ran, false);
  assert.equal(res.skipped, 'claim-unknown');
  const claim = s.transitions.find((t) => t.to === 'validating');
  // The fence comes BEFORE the release, which names the claim's own token.
  const names = s.names();
  assert.ok(names.includes('fence'));
  assert.ok(names.indexOf('fence') < names.lastIndexOf('transition'));
  // The claim was a CAS on the row this run READ.
  assert.deepEqual(claim.expect, {
    rev: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
    imageArn: 'arn:aws:lambda:us-west-2:123456789012:microvm-image:gpu',
  });
  const release = s.transitions.at(-1);
  assert.equal(release.to, 'pending');
  assert.deepEqual(release.from, ['validating']);
  assert.equal(release.runId, claim.runId);
  assert.equal(s.names().includes('launch'), false);
  assert.equal(s.names().includes('probeImage'), false);
});

test('a hung flavor READ ends the run without touching the row', async () => {
  const s = scenario(happyOpts());
  hang(s, ['getFlavor']);
  await assert.rejects(
    withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG)),
    EffectTimeoutError,
  );
  // Nothing was claimed, so nothing is ours to write: the async invoke's retry re-runs it.
  assert.equal(s.transitions.length, 0);
});

test('a main-phase effect is capped by what is left of the MAIN phase, not just its own ceiling', async () => {
  // The virtual clock jumps past the end of the main phase during dispatch. The next poll must not
  // be given a fresh effect ceiling that would eat into the reserve: it is not started at all, and
  // the run reports the timeout it actually had.
  const s = scenario({
    runners: () => [],
    runs: () => [],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
    dispatchDelayMs: 60_000,
  });
  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.verdictWritten, true);
  assert.equal(s.names().includes('listRunners'), false);
});

test('bounded() gives up on a never-settling effect and aborts its signal', async () => {
  let seen;
  await assert.rejects(
    bounded('probe', 20, (signal) => {
      seen = signal;
      return new Promise(() => {});
    }),
    (err) => err instanceof EffectTimeoutError && err.effect === 'probe' && err.ms === 20,
  );
  assert.equal(seen.aborted, true);
});

test('bounded() with no budget left does not start the effect', async () => {
  let started = false;
  await assert.rejects(
    bounded('late', 0, async () => {
      started = true;
    }),
    EffectTimeoutError,
  );
  assert.equal(started, false);
});

test('bounded() passes through a value and an error unchanged', async () => {
  assert.equal(await bounded('ok', 1_000, async () => 7), 7);
  await assert.rejects(
    bounded('boom', 1_000, async () => {
      throw new Error('GitHub 500');
    }),
    /GitHub 500/,
  );
});

test('the default reserve covers the verdict, its fallback and every cleanup step all hanging', () => {
  const c = DEFAULT_ORCHESTRATOR_CONFIG;
  assert.equal(CLEANUP_STEPS, 5);
  assert.ok(reserveFits(c));
  assert.ok(c.reserveMs >= 2 * c.verdictTimeoutMs + CLEANUP_STEPS * c.cleanupStepTimeoutMs);
  // And a config that does not fit is reported as such.
  assert.equal(reserveFits({ ...c, cleanupStepTimeoutMs: c.reserveMs }), false);
  // One main-phase call must not be able to eat the whole run on its own.
  assert.ok(c.effectTimeoutMs < c.deadlineMs - c.reserveMs);
});

test('the default deadline leaves a reserve inside it', () => {
  assert.ok(DEFAULT_ORCHESTRATOR_CONFIG.reserveMs > 0);
  assert.ok(DEFAULT_ORCHESTRATOR_CONFIG.reserveMs < DEFAULT_ORCHESTRATOR_CONFIG.deadlineMs);
  // The CDK function timeout is 12 minutes; the deadline must be comfortably inside it so the
  // verdict write always happens in-process.
  assert.ok(DEFAULT_ORCHESTRATOR_CONFIG.deadlineMs <= 11 * 60_000);
});

test('the claim lease outlives the λ timeout, and the VM cap outlives the run but not by much', () => {
  const c = DEFAULT_ORCHESTRATOR_CONFIG;
  // An expired lease is how a later run knows the claimer is gone — it must never expire while the
  // claiming λ (12 min timeout, lib/control-stack.ts) could still be writing.
  assert.ok(c.leaseMs > 12 * 60_000);
  // The platform cap must not kill a VM whose job is still being observed…
  assert.ok(c.vmMaxDurationSeconds * 1000 > c.deadlineMs);
  // …and is the smoke-specific backstop, far below the Reaper's job-sized lifetime cap.
  assert.ok(c.vmMaxDurationSeconds <= 15 * 60);
});

// ---- ambiguous side effects: the call landed, the answer did not -------------
//
// Review finding (verdict 1794540192020-d27a17): `bounded` stops WAITING, but a timed-out request
// can still have taken effect. A fake that merely never resolves models a call that did nothing;
// these fakes perform the effect on a shared model of DynamoDB / the fleet / GitHub and THEN lose
// the response, or settle it only after the orchestrator has moved on.

/**
 * A model of the flavor row that applies the same conditions as `claimFlavorValidation` /
 * `fenceFlavorValidationRun` / `transitionFlavorValidation` / `repointFlavorImage` (whose real
 * condition expressions are pinned on the wire in flavor-store-marshalling.test.mjs): every write
 * bumps a monotonic `rev`, and a claim is a compare-and-swap on the `rev`, `createdAt` and `imageArn`
 * its run READ.
 */
function rowModel(clock) {
  const IMAGE_A = goodFlavor().imageArn;
  let row = goodFlavor();
  const bump = () => (row.rev = (row.rev ?? 0) + 1);
  const m = {
    get row() {
      return row;
    },
    /** What `getFlavor` returns: a snapshot, as DynamoDB would. */
    read() {
      return row ? structuredClone(row) : undefined;
    },
    /** The `expect` a run that read the row NOW would send. */
    snap() {
      return { rev: row.rev, createdAt: row.createdAt, imageArn: row.imageArn };
    },
    claim(input) {
      if (!row) return false;
      const e = input.expect;
      if ((row.rev ?? 0) !== (e.rev ?? 0)) return false;
      if (row.createdAt !== e.createdAt || row.imageArn !== e.imageArn) return false;
      const expired =
        row.state === 'validating' &&
        (row.validationLeaseUntil === undefined || row.validationLeaseUntil < clock());
      if (row.state !== 'pending' && !expired) return false;
      Object.assign(row, {
        state: 'validating',
        validationRunId: input.runId,
        validationLeaseUntil: input.leaseUntil,
      });
      if (!input.autoRecovery) delete row.autoRecoveries;
      bump();
      return true;
    },
    /** `releaseExpiredFlavorClaim`: the reconciliation sweep's guarded release. */
    releaseExpired(input) {
      if (!row || row.state !== 'validating') return undefined;
      if (row.validationRunId !== input.runId) return undefined;
      if (!(row.validationLeaseUntil < input.nowMs)) return undefined;
      row.state = 'pending';
      row.reason = input.reason;
      delete row.validationRunId;
      delete row.validationLeaseUntil;
      row.autoRecoveries = (row.autoRecoveries ?? 0) + 1;
      bump();
      return { autoRecoveries: row.autoRecoveries };
    },
    /** What the live-claim index would return for `listExpiredFlavorClaims(nowMs)`. */
    expired(nowMs) {
      const claims =
        row && row.state === 'validating' && row.validationLeaseUntil < nowMs
          ? [
              {
                installationId: row.installationId,
                name: row.name,
                runId: row.validationRunId,
                leaseUntil: row.validationLeaseUntil,
                autoRecoveries: row.autoRecoveries ?? 0,
              },
            ]
          : [];
      return { claims, truncated: false };
    },
    fence() {
      if (row) bump();
    },
    transition(input) {
      if (!row) return false;
      const legal =
        row.state === 'validating'
          ? ['valid', 'invalid', 'pending'].includes(input.to)
          : input.to === 'pending';
      if (!legal) return false;
      if (input.from && !input.from.includes(row.state)) return false;
      if (input.runId !== undefined && row.validationRunId !== input.runId) return false;
      if (input.imageArn !== undefined && row.imageArn !== input.imageArn) return false;
      row.state = input.to;
      delete row.validationRunId;
      delete row.validationLeaseUntil;
      delete row.autoRecoveries;
      bump();
      return true;
    },
    /** The operator's re-validate with a NEW image ARN (`repointFlavorImage`). */
    repoint(imageArn) {
      Object.assign(row, { imageArn, state: 'pending' });
      delete row.validationRunId;
      delete row.validationLeaseUntil;
      delete row.evidence;
      bump();
    },
    /** DELETE then a fresh registration under the same name: `rev` starts over. */
    recreate(over = {}) {
      row = goodFlavor({ createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', ...over });
    },
    IMAGE_A,
  };
  return m;
}

/** Wire a scenario's row-touching effects to a {@link rowModel}. */
function useModel(s, m) {
  s.deps.getFlavor = async () => m.read();
  s.deps.claim = async (input) => m.claim(input);
  s.deps.fence = async () => m.fence();
  s.deps.transition = async (input) => m.transition(input);
}

/** A promise settled by hand, so a test chooses WHEN a lost write finally lands. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a claim that lands AFTER its own release cannot strand the row in validating', async () => {
  // The reviewer's reproduction: the claim times out, the release sees `pending` and does nothing,
  // then the claim settles and sets `validating` with nobody left to move it.
  const s = scenario(happyOpts());
  const m = rowModel(s.deps.now);
  useModel(s, m);
  const late = deferred();
  s.deps.claim = (input) =>
    // The request is in flight: it reaches DynamoDB only when the test says so.
    late.promise.then(() => m.claim(input));

  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.skipped, 'claim-unknown');
  assert.equal(m.row.state, 'pending', 'the release saw pending: nothing to undo yet');

  // NOW the timed-out claim lands.
  late.resolve();
  await settle();
  assert.equal(m.row.state, 'pending', 'the fence moved the revision, so the late claim fails');
  assert.equal(res.verdictWritten, true);

  // The fence refuses only claims based on an OLDER read: a run that reads the row now can claim.
  assert.equal(m.claim({ runId: 'next-run', leaseUntil: s.deps.now() + 1, expect: m.snap() }), true);
});

test('two generations of timed-out claims: a later fence never re-admits an older claim', async () => {
  // Review finding 1794543259290-b6c209:2. With a single overwritable fenced-token field, run B's
  // fence REPLACED run A's, and A's claim — still in flight — then landed after both runs returned.
  // Here A and B both time out with their claims in flight, B fences after A, and the claims land
  // in either order. Neither may ever land.
  for (const order of [['A', 'B'], ['B', 'A']]) {
    const m = rowModel(() => 1_700_000_000_000);
    const inFlight = {};
    const runOne = async (id) => {
      const s = scenario(happyOpts());
      useModel(s, m);
      s.deps.nonce = () => `run${id}`;
      const d = deferred();
      inFlight[id] = d;
      s.deps.claim = (input) => d.promise.then(() => m.claim(input));
      return withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
    };
    const a = await runOne('A');
    const b = await runOne('B');
    assert.equal(a.skipped, 'claim-unknown');
    assert.equal(b.skipped, 'claim-unknown');
    assert.equal(m.row.state, 'pending');

    for (const id of order) {
      inFlight[id].resolve();
      await settle();
      assert.equal(m.row.state, 'pending', `late claim ${id} (order ${order}) must not land`);
      assert.equal(m.row.validationRunId, undefined);
    }
  }
});

// ---- late-settling fence (review finding 1794546887390-27dea6:1) -----------------------------
//
// The fence is itself an ambiguous write. If one fence attempt times out and the run releases
// anyway, this order strands the row: release (sees `pending`) → claim lands → late fence (only
// bumps `rev`). The run must therefore not release until a fence is CONFIRMED.

/** Wire a model, then make the claim and the FIRST fence attempt land only when the test says. */
function lateClaimAndFirstFence() {
  const s = scenario(happyOpts());
  const m = rowModel(s.deps.now);
  useModel(s, m);
  const claim = deferred();
  const firstFence = deferred();
  const order = [];
  s.deps.claim = (input) => claim.promise.then(() => m.claim(input));
  let fences = 0;
  s.deps.fence = () => {
    fences += 1;
    if (fences === 1) return firstFence.promise.then(() => m.fence());
    order.push('fence-confirmed');
    m.fence();
    return Promise.resolve();
  };
  s.deps.transition = async (input) => {
    order.push(`transition:${input.to}`);
    return m.transition(input);
  };
  return { s, m, claim, firstFence, order, fenceCount: () => fences };
}

test('claim → fence → release, the fence settling LATE: the row is never left validating', async () => {
  // The reviewer's exact order: the claim is in flight, the first fence times out and is still in
  // flight, then the claim lands, then the late fence lands.
  const t = lateClaimAndFirstFence();
  const res = await withinMs(
    2_000,
    runValidation(t.s.deps, { installationId: INSTALL, name: NAME }, HANG),
  );
  assert.equal(res.skipped, 'claim-unknown');
  assert.ok(t.fenceCount() >= 2, 'the timed-out fence was retried');
  // The release never ran ahead of a confirmed fence.
  assert.deepEqual(t.order, ['fence-confirmed', 'transition:pending']);
  assert.equal(res.verdictWritten, true);

  t.claim.resolve();
  await settle();
  assert.equal(t.m.row.state, 'pending', 'the confirmed fence refuses the late claim');
  t.firstFence.resolve();
  await settle();
  assert.equal(t.m.row.state, 'pending', 'the late fence only bumps the revision');
  assert.equal(t.m.row.validationRunId, undefined);
});

test('claim lands while the first fence is in flight: the confirmed fence is followed by its release', async () => {
  const t = lateClaimAndFirstFence();
  // The claim lands BEFORE any fence takes effect — the case only the release can undo.
  t.s.deps.claim = (input) => {
    t.m.claim(input);
    return new Promise(() => {});
  };
  const res = await withinMs(
    2_000,
    runValidation(t.s.deps, { installationId: INSTALL, name: NAME }, HANG),
  );
  assert.equal(res.skipped, 'claim-unknown');
  assert.equal(res.verdictWritten, true);
  assert.equal(t.m.row.state, 'pending', 'our landed claim was released');
  t.firstFence.resolve();
  await settle();
  assert.equal(t.m.row.state, 'pending');
});

test('a fence that never answers: no release is sent ahead of it, and the run reports unsettled', async () => {
  const s = scenario(happyOpts());
  hang(s, ['transition:validating', 'fence']);
  // A short virtual budget so the retry loop gives up quickly in real time.
  const res = await withinMs(
    2_000,
    runValidation(s.deps, { installationId: INSTALL, name: NAME }, { ...HANG, deadlineMs: 10_000 }),
  );
  assert.equal(res.skipped, 'claim-unknown');
  assert.equal(res.verdictWritten, false, 'unproven settlement is never reported as settled');
  assert.ok(s.names().filter((n) => n === 'fence').length >= 2, 'the fence was retried');
  assert.equal(
    s.transitions.some((t) => t.to === 'pending'),
    false,
    'a release before a confirmed fence could be overtaken by the claim',
  );
  assert.equal(s.names().includes('launch'), false);
});

// ---- automatic recovery of an unsettled claim (review finding 1794555970246-5ee1de:1) ---------
//
// The run above ends with the row possibly `validating` and nobody coming back for it: the lease only
// PERMITS a later claim, and the only producers of runs were registration and an operator's
// re-validate. The Reaper's sweep is that producer. These tests drive the whole chain through the
// same row model: an unsettled run, the lease expiring, the sweep's release + re-trigger, and the
// re-triggered run reaching a verdict — with no operator action anywhere.

/** A run whose claim LANDS (answer lost) and whose DynamoDB then never answers again. */
async function strandingRun(m, nonce = 'dead01') {
  const s = scenario(happyOpts());
  useModel(s, m);
  s.deps.nonce = () => nonce;
  s.deps.claim = (input) => {
    m.claim(input);
    return new Promise(() => {});
  };
  s.deps.fence = () => new Promise(() => {});
  const res = await withinMs(
    2_000,
    runValidation(s.deps, { installationId: INSTALL, name: NAME }, { ...HANG, deadlineMs: 10_000 }),
  );
  assert.equal(res.verdictWritten, false);
  assert.equal(m.row.state, 'validating', 'precondition: this run strands the row');
  return s;
}

/** Sweep deps over the row model; `onTrigger` receives every re-trigger request. */
function sweepDeps(m, onTrigger) {
  return {
    listExpired: async (nowMs) => m.expired(nowMs),
    release: async (input) => m.releaseExpired(input),
    trigger: async (input) => {
      await onTrigger(input);
      return true;
    },
    log: () => {},
  };
}

test('an unsettled claim is released and re-validated automatically once its lease expires', async () => {
  let t = 1_700_000_000_000;
  const m = rowModel(() => t);
  const s1 = await strandingRun(m);
  const lease = m.row.validationLeaseUntil;
  assert.ok(lease > s1.deps.now(), 'the lease outlives the run that took it');

  // Before expiry the sweep must not touch the row: its run might still be alive.
  const early = await sweepExpiredFlavorClaims(
    sweepDeps(m, () => assert.fail('no re-trigger before the lease expires')),
    lease - 1,
    3,
  );
  assert.equal(early.released, 0);
  assert.equal(m.row.state, 'validating');

  // After expiry: released, then re-triggered, and the re-triggered run proves the image.
  const triggered = [];
  t = lease + 1;
  const res = await sweepExpiredFlavorClaims(
    sweepDeps(m, async (req) => {
      triggered.push(req);
      assert.equal(m.row.state, 'pending', 'released BEFORE the re-trigger, so the new claim can land');
      const s2 = scenario(happyOpts());
      useModel(s2, m);
      const out = await runValidation(s2.deps, req, FAST);
      assert.equal(out.state, 'valid');
    }),
    lease + 1,
    3,
  );
  assert.deepEqual(res, { expired: 1, released: 1, retriggered: 1, leftPending: 0, truncated: false });
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].actor, SWEEP_ACTOR);
  assert.equal(triggered[0].autoRecovery, true);
  assert.equal(m.row.state, 'valid', 'no operator action was needed to leave validating');
  assert.equal(m.row.autoRecoveries, undefined, 'a verdict resets the recovery counter');
});

test('the sweep never releases a claim a later run holds, even from a stale index read', async () => {
  let t = 1_700_000_000_000;
  const m = rowModel(() => t);
  await strandingRun(m, 'dead01');
  const stale = m.expired(m.row.validationLeaseUntil + 1);
  // A later run took the expired row over between the index read and the release.
  t = m.row.validationLeaseUntil + 1;
  assert.equal(
    m.claim({ runId: 'live02', leaseUntil: t + 900_000, expect: m.snap(), autoRecovery: false }),
    true,
  );
  const res = await sweepExpiredFlavorClaims(
    {
      listExpired: async () => stale,
      release: async (input) => m.releaseExpired(input),
      trigger: async () => assert.fail('nothing was released, so nothing is re-triggered'),
      log: () => {},
    },
    t,
    3,
  );
  assert.equal(res.released, 0);
  assert.equal(m.row.state, 'validating');
  assert.equal(m.row.validationRunId, 'live02', 'the live claim is untouched');
});

test('a flavor whose runs keep dying is re-triggered at most N times, then left pending for an operator', async () => {
  let t = 1_700_000_000_000;
  const m = rowModel(() => t);
  const strand = (autoRecovery) => {
    assert.equal(
      m.claim({ runId: `r${t}`, leaseUntil: t + 1000, expect: m.snap(), autoRecovery }),
      true,
    );
    t += 2000; // the run dies; its lease expires
  };
  let triggers = 0;
  const deps = sweepDeps(m, () => {
    triggers += 1;
  });

  strand(false); // the operator's registration
  for (let i = 1; i <= 3; i++) {
    const r = await sweepExpiredFlavorClaims(deps, t, 3);
    assert.equal(r.retriggered, 1, `recovery ${i} is re-triggered`);
    assert.equal(m.row.state, 'pending');
    strand(true); // the re-triggered run dies the same way
  }
  const last = await sweepExpiredFlavorClaims(deps, t, 3);
  assert.equal(last.released, 1, 'the row still leaves validating');
  assert.equal(last.retriggered, 0, 'but no fourth smoke VM is launched');
  assert.equal(last.leftPending, 1);
  assert.equal(triggers, 3);
  assert.equal(m.row.state, 'pending');
  assert.match(m.row.reason, /re-validate to try again/);

  // An operator's re-validate is a fresh decision: it resets the counter.
  strand(false);
  const after = await sweepExpiredFlavorClaims(deps, t, 3);
  assert.equal(after.retriggered, 1);
});

test('one row whose release throws does not stop the sweep releasing the others', async () => {
  const released = [];
  const res = await sweepExpiredFlavorClaims(
    {
      listExpired: async () => ({
        claims: [
          { installationId: 1, name: 'custom-a', runId: 'a', leaseUntil: 1, autoRecoveries: 0 },
          { installationId: 1, name: 'custom-b', runId: 'b', leaseUntil: 1, autoRecoveries: 0 },
        ],
        truncated: true,
      }),
      release: async (input) => {
        if (input.name === 'custom-a') throw new Error('ProvisionedThroughputExceeded');
        released.push(input.name);
        return { autoRecoveries: 1 };
      },
      trigger: async () => false,
      log: () => {},
    },
    10,
    3,
  );
  assert.deepEqual(released, ['custom-b']);
  assert.equal(res.released, 1);
  assert.equal(res.leftPending, 1, 'a trigger that could not be sent leaves the row pending, not validating');
  assert.equal(res.truncated, true);
});

test('a confirmed fence whose release times out is retried until the release answers', async () => {
  const s = scenario(happyOpts());
  const m = rowModel(s.deps.now);
  useModel(s, m);
  s.deps.claim = (input) => {
    m.claim(input); // landed; the answer is lost
    return new Promise(() => {});
  };
  let releases = 0;
  s.deps.transition = async (input) => {
    releases += 1;
    if (releases === 1) return new Promise(() => {});
    return m.transition(input);
  };
  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.verdictWritten, true);
  assert.equal(releases, 2);
  assert.equal(m.row.state, 'pending');
});

test('a repoint between the read and the claim: the stale run claims nothing and launches nothing', async () => {
  // Review finding 1794543259290-b6c209:1. The run reads image A; the operator repoints the row to
  // image B; the run's claim must not land, or it would launch A and mark the row — now naming B —
  // valid, making an image nothing has run routable.
  const s = scenario(happyOpts());
  const m = rowModel(s.deps.now);
  useModel(s, m);
  const IMAGE_B = 'arn:aws:lambda:us-west-2:123456789012:microvm-image:gpu-v2';
  s.deps.getFlavor = async () => {
    const snapshot = m.read();
    m.repoint(IMAGE_B); // lands after the read, before the claim
    return snapshot;
  };

  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.ran, false);
  assert.equal(res.skipped, 'not-pending');
  assert.equal(s.names().includes('launch'), false);
  assert.equal(s.names().includes('probeImage'), false);
  assert.equal(m.row.state, 'pending', 'B awaits its own validation');
  assert.equal(m.row.imageArn, IMAGE_B);
});

test('a repoint that is an image swap with the SAME revision count still fails the claim', async () => {
  // Defence in depth: the claim pins the ARN itself, not only the revision.
  const m = rowModel(() => 0);
  const stale = m.snap();
  m.repoint('arn:aws:lambda:us-west-2:123456789012:microvm-image:other');
  m.row.rev = stale.rev; // pretend the revision did not move
  assert.equal(m.claim({ runId: 'r', leaseUntil: 1, expect: stale }), false);
});

test('delete + re-register between the read and the claim: the stale run claims nothing', async () => {
  // A re-registered row starts its revision over, so it can carry the SAME `rev` (and even the same
  // ARN) as the row the run read. Only the record identity tells them apart.
  for (const imageArn of [undefined, 'arn:aws:lambda:us-west-2:123456789012:microvm-image:new']) {
    const s = scenario(happyOpts());
    const m = rowModel(s.deps.now);
    useModel(s, m);
    s.deps.getFlavor = async () => {
      const snapshot = m.read();
      m.recreate(imageArn ? { imageArn } : {});
      return snapshot;
    };
    const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
    assert.equal(res.skipped, 'not-pending');
    assert.equal(s.names().includes('launch'), false);
    assert.equal(m.row.state, 'pending');
    assert.equal(m.row.rev, undefined, 'the new row was not touched');
  }
});

test('a passing run against the model: the verdict names the launched image, and only that one', async () => {
  const s = scenario(happyOpts());
  const m = rowModel(s.deps.now);
  useModel(s, m);
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'valid');
  assert.equal(m.row.state, 'valid');
  assert.equal(m.row.imageArn, m.IMAGE_A);
  assert.equal(s.calls.find((c) => c.name === 'launch').arg.imageArn, m.IMAGE_A);

  // And a verdict for an image the row no longer names is refused at the store.
  const m2 = rowModel(() => 0);
  assert.equal(m2.claim({ runId: 'r', leaseUntil: 1, expect: m2.snap() }), true);
  m2.row.imageArn = 'arn:aws:lambda:us-west-2:123456789012:microvm-image:swapped';
  assert.equal(m2.transition({ to: 'valid', runId: 'r', imageArn: m2.IMAGE_A }), false);
});

test('a claim that landed BEFORE the release is undone by the token-guarded release', async () => {
  const s = scenario(happyOpts());
  const m = rowModel(s.deps.now);
  useModel(s, m);
  s.deps.claim = (input) => {
    m.claim(input); // it landed …
    return new Promise(() => {}); // … and the answer never came back
  };

  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.skipped, 'claim-unknown');
  assert.equal(m.row.state, 'pending');
  assert.equal(m.row.validationRunId, undefined);
});

test('a late VERDICT cannot land on a later run that claimed the row after our release', async () => {
  // Our verdict write times out; we release; a NEW run claims the row. Only then does our stale
  // verdict reach DynamoDB. The run token refuses it.
  const s = scenario(happyOpts());
  const m = rowModel(s.deps.now);
  useModel(s, m);
  const late = deferred();
  let staleVerdict;
  s.deps.transition = (input) => {
    if (input.to === 'valid') {
      staleVerdict = input;
      return late.promise.then(() => m.transition(input));
    }
    return Promise.resolve(m.transition(input));
  };

  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.state, 'pending');
  assert.equal(m.row.state, 'pending');

  assert.equal(
    m.claim({ runId: 'later-run', leaseUntil: s.deps.now() + 600_000, expect: m.snap() }),
    true,
  );
  late.resolve();
  await settle();
  assert.equal(m.row.state, 'validating', 'the later run still owns its claim');
  assert.equal(m.row.validationRunId, 'later-run');
  assert.ok(staleVerdict.runId && staleVerdict.runId !== 'later-run');
});

test('a validating row whose claimer is gone is reclaimed once its lease has expired', () => {
  let now = 1_000;
  const m = rowModel(() => now);
  assert.equal(m.claim({ runId: 'dead', leaseUntil: 2_000, expect: m.snap() }), true);
  // Still inside the lease: the claimer may be alive, so no takeover.
  assert.equal(m.claim({ runId: 'next', leaseUntil: 9_000, expect: m.snap() }), false);
  now = 2_001;
  assert.equal(m.claim({ runId: 'next', leaseUntil: 9_000, expect: m.snap() }), true);
  // The dead run's late writes are now refused.
  assert.equal(m.transition({ to: 'valid', runId: 'dead' }), false);
});

/** A fleet that honours RunMicrovm's clientToken idempotency, as the service does. */
function fleetModel() {
  const vms = new Map();
  const byToken = new Map();
  let n = 0;
  return {
    vms,
    create(input) {
      if (byToken.has(input.clientToken)) return byToken.get(input.clientToken);
      const id = `mvm-${++n}`;
      byToken.set(input.clientToken, id);
      vms.set(id, { state: 'RUNNING', maximumDurationInSeconds: input.maximumDurationInSeconds });
      return id;
    },
    terminate(id) {
      vms.delete(id);
    },
  };
}

for (const [loss, lose] of [
  ['times out', () => new Promise(() => {})],
  ['fails ambiguously (dropped connection)', () => Promise.reject(new Error('socket hang up'))],
]) {
  test(`a launch that CREATED the VM and then ${loss} still gets that VM terminated`, async () => {
    const s = scenario({ ...happyOpts(), vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }] });
    const fleet = fleetModel();
    let first = true;
    const launches = [];
    s.deps.launch = async (input) => {
      launches.push(input);
      const id = fleet.create(input); // the VM exists either way
      if (first) {
        first = false;
        return lose();
      }
      return { microvmId: id };
    };
    s.deps.terminateVm = async (id) => {
      s.calls.push({ name: 'terminateVm', arg: id });
      fleet.terminate(id);
    };

    const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
    assert.equal(res.state, 'pending');
    // The retry reused the SAME idempotency token and input, so it found the VM rather than making
    // a second one — and that VM is gone.
    assert.equal(launches.length, 2);
    assert.deepEqual(launches[1], launches[0]);
    assert.equal(fleet.vms.size, 0, 'no VM outlives the run');
    assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1');
  });
}

test('a DEFINITIVELY rejected launch is not retried — it proves no VM exists', async () => {
  const s = scenario({ ...happyOpts(), throwOn: 'launch' });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'pending');
  assert.equal(s.calls.filter((c) => c.name === 'launch').length, 1);
  assert.equal(s.names().includes('terminateVm'), false);
});

test('only a 4xx RunMicrovm answer counts as a definitive refusal', async () => {
  const { isDefinitiveLaunchRejection } = await import('../dist/src/shared/microvm.js');
  const svc = (status, fault) =>
    Object.assign(new Error('x'), { $metadata: { httpStatusCode: status }, $fault: fault });
  assert.equal(isDefinitiveLaunchRejection(svc(400, 'client')), true);
  assert.equal(isDefinitiveLaunchRejection(svc(429, 'client')), true);
  // A 5xx may have created the VM before failing; so may anything with no HTTP answer at all.
  assert.equal(isDefinitiveLaunchRejection(svc(500, 'server')), false);
  assert.equal(isDefinitiveLaunchRejection(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isDefinitiveLaunchRejection(new Error('socket hang up')), false);
  assert.equal(isDefinitiveLaunchRejection(Object.assign(new Error('q'), { $fault: 'client' })), true);
});

test('every launch carries a run-unique clientToken and the smoke-specific lifetime cap', async () => {
  const s = scenario(happyOpts());
  await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  const input = s.calls.find((c) => c.name === 'launch').arg;
  assert.match(input.clientToken, new RegExp(`^lca-validate-${INSTALL}-\\d+-abc123$`));
  assert.ok(input.clientToken.length <= 64, 'idempotency tokens are length-capped');
  assert.equal(input.maximumDurationInSeconds, FAST.vmMaxDurationSeconds);
});

test('a mint that REGISTERED the runner and then lost its response is found by name and deleted', async () => {
  const s = scenario(happyOpts());
  const registered = [];
  s.deps.mintSmokeRunner = (input) => {
    registered.push({ id: 4242, name: input.name, labels: [input.label], status: 'offline' });
    return new Promise(() => {});
  };
  s.deps.listRunners = async () => [
    { id: 1, name: 'someone-elses-runner', labels: ['self-hosted'] },
    ...registered,
  ];
  await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  const deleted = s.calls.filter((c) => c.name === 'deleteRunner').map((c) => c.arg);
  assert.deepEqual(deleted, [4242], 'ours, and only ours');
});

test('a dispatch that CREATED the run and then lost its response gets that run cancelled', async () => {
  const s = scenario({ ...happyOpts(), vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }] });
  const runs = [];
  s.deps.dispatch = () => {
    // A bystander's dispatch in the same second, plus ours.
    runs.push({ id: 5000, status: 'queued', conclusion: null, createdAt: s.deps.now() });
    runs.push({ id: 5001, status: 'queued', conclusion: null, createdAt: s.deps.now() });
    return new Promise(() => {});
  };
  s.deps.listDispatchRuns = async () => runs;
  s.deps.listRunJobs = async ({ runId }) =>
    runId === 5001
      ? [{ id: 1, labels: [smokeLabel('abc123')] }]
      : [{ id: 2, labels: ['self-hosted'], runnerName: 'someone-else' }];

  const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.equal(res.state, 'pending');
  const cancelled = s.calls.filter((c) => c.name === 'cancelRun').map((c) => c.arg);
  assert.deepEqual(cancelled, [5001], 'confirmed ours by nonce — never the bystander');
  assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1');
});

// A create-type effect that `bounded` never STARTED (the main phase was already spent) sent
// nothing, so cleanup must not try to recover it. For the launch this is not just wasted work:
// recovery RE-ISSUES the launch, so a recorded-but-unsent launch would make cleanup create a VM.
for (const [effect, before, recovery] of [
  ['mintSmokeRunner', 'defaultBranch', 'listRunners'],
  ['launch', 'beginSmoke', 'launch'],
  ['dispatch', 'stampVm', 'listDispatchRuns'],
]) {
  test(`a ${effect} never started for lack of budget is not "recovered" by cleanup`, async () => {
    const s = scenario(happyOpts());
    const original = s.deps[before];
    let clockJump = 0;
    const now = s.deps.now;
    s.deps.now = () => now() + clockJump;
    s.deps[before] = async (...args) => {
      const out = await original(...args);
      clockJump += 60_000; // past the end of the main phase
      return out;
    };
    const res = await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
    assert.equal(res.state, 'pending');
    assert.equal(
      s.calls.filter((c) => c.name === recovery).length,
      0,
      `${effect} was never sent, so cleanup has nothing to recover`,
    );
    assert.equal(s.names().includes(effect), false, `${effect} itself was not started`);
  });
}

// ---- complete GitHub listings (review finding 1794555970246-5ee1de:2) --------------------------

test('every runner lookup names our exact runner, and every run listing carries the dispatch floor', async () => {
  const s = scenario(happyOpts());
  const runnerArgs = [];
  const runArgs = [];
  const listRunners = s.deps.listRunners;
  s.deps.listRunners = async (repo, signal, name) => {
    runnerArgs.push(name);
    return listRunners(repo, signal, name);
  };
  const listDispatchRuns = s.deps.listDispatchRuns;
  s.deps.listDispatchRuns = async (input, signal) => {
    runArgs.push(input.createdAtOrAfterMs);
    return listDispatchRuns(input, signal);
  };
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
  assert.equal(res.state, 'valid');
  assert.ok(runnerArgs.length > 0 && runnerArgs.every((n) => n === 'lca-validate-abc123'));
  assert.ok(runArgs.length > 0 && runArgs.every((ms) => Number.isFinite(ms)));
});

test('the lost-mint recovery looks the runner up by its exact name', async () => {
  const s = scenario(happyOpts());
  s.deps.mintSmokeRunner = () => new Promise(() => {});
  const asked = [];
  s.deps.listRunners = async (_repo, _signal, name) => {
    asked.push(name);
    return name === 'lca-validate-abc123' ? [{ id: 4242, name, labels: [], status: 'offline' }] : [];
  };
  await withinMs(2_000, runValidation(s.deps, { installationId: INSTALL, name: NAME }, HANG));
  assert.deepEqual(asked, ['lca-validate-abc123']);
  assert.deepEqual(s.calls.filter((c) => c.name === 'deleteRunner').map((c) => c.arg), [4242]);
});

for (const effect of ['listRunners', 'listDispatchRuns', 'listRunJobs']) {
  test(`an incomplete ${effect} listing is an orchestration fault (pending), never a verdict`, async () => {
    const s = scenario({ ...happyOpts(), runners: () => [] });
    s.deps[effect] = async () => {
      const err = new Error(`GitHub ${effect} has more than 10 page(s); the listing was not read to its end`);
      err.name = 'GithubListingIncompleteError';
      throw err;
    };
    const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);
    assert.equal(res.state, 'pending', 'a partial read must not score "runner never registered"');
    assert.match(res.reason, /not a verdict about the image/);
    assert.equal(s.calls.find((c) => c.name === 'terminateVm')?.arg, 'mvm-1', 'cleanup still runs');
  });
}
