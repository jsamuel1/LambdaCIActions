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
  DEFAULT_ORCHESTRATOR_CONFIG,
} from '../dist/src/flavorval/orchestrate.js';
import { smokeLabel, isSmokeLabel } from '../dist/src/flavorval/validate-core.js';

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
    imageArn: 'arn:aws:lambda:us-west-2:1:microvm-image/gpu',
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
    transition: async (input) => {
      transitions.push(input);
      record('transition', input.to);
      if (input.to === 'validating' && opts.claimRefused) return false;
      if (input.to !== 'validating' && opts.verdictRefused) return false;
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
    launch: async () => {
      record('launch');
      if (opts.throwOn === 'launch') throw new Error('RunMicrovm quota exceeded');
      return { microvmId: 'mvm-1' };
    },
    stampVm: async () => record('stampVm'),
    dispatch: async () => {
      record('dispatch');
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

const FAST = { ...DEFAULT_ORCHESTRATOR_CONFIG, deadlineMs: 60_000, reserveMs: 5_000, pollIntervalMs: 1_000, selfTerminateWaitMs: 5_000 };

/** A run that succeeds on the first poll: runner present, job green, VM gone. */
function happyOpts(over = {}) {
  return {
    runners: () => [{ id: 777, name: 'lca-validate-abc123', labels: ['lca-validate-abc123'] }],
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
    runners: () => [{ id: 777, name: 'r', labels: ['lca-validate-abc123'] }],
    runs: (_p, clock) => [{ id: 9001, status: 'queued', conclusion: null, createdAt: clock }],
    vms: () => [{ microvmId: 'mvm-1', state: 'RUNNING' }],
  });
  const res = await runValidation(s.deps, { installationId: INSTALL, name: NAME }, FAST);

  assert.equal(res.state, 'invalid');
  assert.match(res.reason, /never reached a conclusion/);
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

test('a run created BEFORE our dispatch is not ours', async () => {
  const s = scenario({
    runners: () => [{ id: 777, name: 'r', labels: ['lca-validate-abc123'] }],
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

test('the default deadline leaves a reserve inside it', () => {
  assert.ok(DEFAULT_ORCHESTRATOR_CONFIG.reserveMs > 0);
  assert.ok(DEFAULT_ORCHESTRATOR_CONFIG.reserveMs < DEFAULT_ORCHESTRATOR_CONFIG.deadlineMs);
  // The CDK function timeout is 12 minutes; the deadline must be comfortably inside it so the
  // verdict write always happens in-process.
  assert.ok(DEFAULT_ORCHESTRATOR_CONFIG.deadlineMs <= 11 * 60_000);
});
