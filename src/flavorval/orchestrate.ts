import {
  DEFAULT_SMOKE_WORKFLOW_PATH,
  classifySmoke,
  formatStaticFailures,
  smokeLabel,
  staticFailureVerdict,
  staticGate,
  type SmokeObservations,
  type ValidationVerdict,
} from './validate-core.js';
import type { CustomFlavorRecord, FlavorValidationEvidence } from '../shared/flavor-store.js';
import type { MicroVMImageState } from '../shared/microvm.js';

/**
 * The ADR-041 smoke-run orchestrator — the half that DECIDES, with every side effect injected.
 *
 * This is where the ADR's second gate actually happens: one real microVM, launched from the
 * operator's image, must register an Actions runner, execute a trivial job and self-terminate
 * through the ADR-021 broker. `validate-core.ts` owns the verdict RULES; this file owns the
 * sequencing, the deadline and the cleanup, and it is separated from `handler.ts` for one specific
 * reason: the acceptance criteria on this work include "an orchestration error returns the flavor to
 * `pending`, never terminal `invalid`" and "the VM is terminated on every exit path". Those are
 * properties of the CONTROL FLOW, and a control flow that only exists inside a λ wired to real
 * DynamoDB/GitHub/microVM clients can only be tested by deploying it. Injecting the effects makes
 * them ordinary unit tests, and the live run then confirms the wiring rather than the logic.
 *
 * What it deliberately does NOT do: decide anything about the image on its own. Every verdict comes
 * from `staticFailureVerdict` or `classifySmoke`, so the three-outcome rule (ADR-041: terminal
 * `invalid` is only ever spent on evidence about the IMAGE) has exactly one implementation.
 */

/** The request the Mgmt λ sends (fire-and-forget `InvocationType: 'Event'`). */
export interface FlavorValidationRequest {
  installationId: number;
  name: string;
  actor?: string;
}

/** A microVM as the orchestrator needs to see it. */
export interface OrchestratorVm {
  microvmId: string;
  state: string;
}

/**
 * Every effect the orchestrator performs. Named for what it means to the run, not for the AWS
 * or GitHub call behind it, so a fake reads as a scenario rather than as a mock script.
 */
export interface OrchestratorDeps {
  /** Read the flavor row. `undefined` when it was deleted mid-flight. */
  getFlavor(installationId: number, name: string): Promise<CustomFlavorRecord | undefined>;
  /**
   * Attempt a state transition. MUST be the conditional-write form: a `false` return is how the
   * orchestrator learns another run owns this flavor, and is the only concurrency guard it has.
   */
  transition(input: {
    installationId: number;
    name: string;
    to: 'validating' | 'valid' | 'invalid' | 'pending';
    reason?: string;
    evidence?: FlavorValidationEvidence;
    actor?: string;
  }): Promise<boolean>;
  /** Probe the candidate image (never throws — see `getMicroVMImageState`). */
  probeImage(imageArn: string): Promise<MicroVMImageState>;
  /** Resolve the smoke repo's default branch, which the dispatch targets. */
  defaultBranch(repoFullName: string): Promise<string>;
  /** Mint the nonce-labelled single-use JIT config. */
  mintSmokeRunner(input: {
    repoFullName: string;
    label: string;
    name: string;
  }): Promise<{ jitConfig: string; runnerId?: number }>;
  /** Write the `SMOKE#` rows the broker serves, returning the launch ref + the token to embed. */
  beginSmoke(input: {
    seq: number;
    jitConfig: string;
    repoFullName: string;
    labels: string[];
  }): Promise<{ ref: string; token: string }>;
  /** Launch ONE microVM from the candidate image. */
  launch(input: { imageArn: string; ref: string; token: string }): Promise<{ microvmId: string }>;
  /** Record the launched VM id on the smoke row so a brokered terminate can resolve it. */
  stampVm(input: { seq: number; microvmId: string }): Promise<void>;
  /** Dispatch the operator's validation workflow with the nonce as its input. */
  dispatch(input: {
    repoFullName: string;
    workflow: string;
    ref: string;
    nonce: string;
  }): Promise<void>;
  /** Names + labels of the repo's currently registered runners. */
  listRunners(repoFullName: string): Promise<{ id: number; name: string; labels: string[] }[]>;
  /** `workflow_dispatch` runs of the validation workflow, newest first. */
  listDispatchRuns(input: {
    repoFullName: string;
    workflow: string;
  }): Promise<{ id: number; status?: string; conclusion?: string | null; createdAt: number }[]>;
  /**
   * Jobs of a candidate run, carrying their resolved `runs-on` labels and runner name.
   *
   * This is the nonce-bearing evidence that a candidate run is OURS. A GitHub runner is matched by
   * label rather than bound to the job it was minted for, and the dispatch API returns no run id,
   * so a timestamp window alone cannot identify our run.
   */
  listRunJobs(input: {
    repoFullName: string;
    runId: number;
  }): Promise<{ id: number; labels: string[]; runnerName?: string }[]>;
  /** The live fleet, for observing self-termination. */
  listVms(): Promise<OrchestratorVm[]>;
  /** Terminate a VM. Best-effort: an already-gone VM is success. */
  terminateVm(microvmId: string): Promise<void>;
  /** Remove a leftover runner registration. Must treat 404 as success. */
  deleteRunner(input: { repoFullName: string; runnerId: number }): Promise<void>;
  /** Best-effort removal of the `SMOKE#` rows. */
  endSmoke(seq: number): Promise<void>;
  /** Epoch ms. Injected so a deadline is testable without waiting. */
  now(): number;
  /** Sleep between polls. A fake resolves immediately. */
  sleep(ms: number): Promise<void>;
  /** Random hex for the nonce/runner name. */
  nonce(): string;
  /** Structured log sink. */
  log(record: Record<string, unknown>): void;
}

export interface OrchestratorConfig {
  /**
   * Hard wall-clock budget for the whole run, ms. MUST be comfortably inside the λ's own timeout:
   * the orchestrator's last act is to write a verdict, and a λ killed by its timeout writes
   * nothing — leaving the row in `validating`, which no later run can transition out of except
   * through the deliberate `validating → pending` escape. Every polling loop is bounded by this,
   * and the reserve below is what keeps the final write inside the budget.
   */
  deadlineMs: number;
  /**
   * Time reserved for the verdict write + cleanup, ms. Polling stops this early so that hitting
   * the deadline still produces a recorded outcome rather than a silent timeout.
   */
  reserveMs: number;
  /** Poll interval, ms. */
  pollIntervalMs: number;
  /**
   * How long to keep watching for the VM to disappear AFTER the job concluded, ms.
   *
   * Self-termination is a positive requirement (ADR-041), so this is not merely a courtesy wait:
   * an image that runs jobs but never self-terminates leaks a VM per job until the Reaper's cap,
   * which is the ADR-019 regression this gate exists to catch. But `TERMINATING` is a real state
   * the fleet passes through, so the window must be long enough not to condemn a healthy image for
   * being slow to disappear.
   */
  selfTerminateWaitMs: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  deadlineMs: 10 * 60_000,
  reserveMs: 45_000,
  pollIntervalMs: 5_000,
  selfTerminateWaitMs: 90_000,
};

/** What the run did, for the λ's own log/metric — the operator-facing outcome is on the row. */
export interface OrchestratorResult {
  /** False when another run owned the flavor (or it vanished) and this one did nothing. */
  ran: boolean;
  state?: ValidationVerdict['state'];
  reason?: string;
  evidence?: FlavorValidationEvidence;
  /** Set when the row could not be moved to a terminal state — the verdict is on the record. */
  verdictWritten?: boolean;
  skipped?: 'not-found' | 'not-pending' | 'no-smoke-repo';
}

/** Split `owner/repo`. */
export function splitRepoFullName(full: string): { owner: string; repo: string } | undefined {
  const parts = full.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Run one validation.
 *
 * Ordering is load-bearing throughout, and each step's comment says why. The shape is:
 *
 *   claim (`pending → validating`, conditional — the concurrency guard)
 *     → static gate (cheap, so a known-broken flavor never costs a microVM)
 *       → smoke run (one VM, nonce-bound job, three observations)
 *         → verdict + evidence
 *   …with a `finally` that terminates the VM, removes the runner registration and drops the
 *   `SMOKE#` rows, and a `catch` that returns the row to `pending` rather than condemning an
 *   image for our own fault.
 */
export async function runValidation(
  deps: OrchestratorDeps,
  req: FlavorValidationRequest,
  config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG,
): Promise<OrchestratorResult> {
  const startedAtMs = deps.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const deadlineAt = startedAtMs + config.deadlineMs;
  /** When polling must stop so the verdict write still fits in the budget. */
  const pollUntil = deadlineAt - config.reserveMs;

  const rec = await deps.getFlavor(req.installationId, req.name);
  if (!rec) {
    deps.log({ msg: 'flavor validation skipped — flavor not found', ...idOf(req) });
    return { ran: false, skipped: 'not-found' };
  }

  // Claim the run. The conditional write IS the guard (ADR-041): only one of two concurrent
  // runs can win `pending → validating`, and losing means another run owns this flavor — so
  // exit WITHOUT touching the row, because writing anything would be writing over the winner.
  const claimed = await deps.transition({
    installationId: req.installationId,
    name: req.name,
    to: 'validating',
    reason: 'smoke run in progress',
    actor: req.actor,
  });
  if (!claimed) {
    deps.log({
      msg: 'flavor validation skipped — another run owns this flavor',
      ...idOf(req),
      state: rec.state,
    });
    return { ran: false, skipped: 'not-pending' };
  }

  // From here the row is `validating`, and it is OUR responsibility to move it out of that state
  // before returning. `validating` is not routable, so a row stuck there is fail-safe rather than
  // dangerous — but it is also inert until an operator re-validates, so every path below writes a
  // verdict, including the catch.
  let seq: number | undefined;
  let microvmId: string | undefined;
  let runnerId: number | undefined;
  let repoFullName: string | undefined;
  const evidence: FlavorValidationEvidence = { imageArn: rec.imageArn, startedAt };

  try {
    // ---- gate 1: static ----------------------------------------------------
    // Cheap, and first, so a flavor that is already known to be unrunnable never costs a microVM
    // launch or a GitHub registration. `requireSmokeRepo: true` because THIS path needs a repo to
    // register the throwaway runner against — unlike the console's pre-save preview, which runs
    // the same gate with the requirement off.
    const image = await deps.probeImage(rec.imageArn);
    const gate = staticGate({
      flavor: rec,
      image,
      requireSmokeRepo: true,
    });
    if (!gate.ok) {
      // `staticFailureVerdict`, not a hardcoded `invalid`: a probe that could not RUN (throttle,
      // an SDK without the command) is not evidence about the image, and spending terminal
      // `invalid` on it would permanently condemn a working image over a transient fault.
      const verdict = staticFailureVerdict(gate.failures);
      deps.log({
        msg: 'flavor validation static gate failed',
        ...idOf(req),
        state: verdict.state,
        inconclusive: gate.inconclusive,
        failures: gate.failures.map((f) => f.code),
      });
      return await writeVerdict(deps, req, verdict, {
        ...evidence,
        finishedAt: new Date(deps.now()).toISOString(),
      });
    }

    // The gate guarantees this (`requireSmokeRepo`), but the narrowing has to be explicit for the
    // compiler and the guard is cheap insurance against a future gate reordering.
    if (!rec.smokeRepoFullName) {
      return await writeVerdict(
        deps,
        req,
        {
          state: 'invalid',
          reason: formatStaticFailures([
            { code: 'missing-smoke-repo', message: 'a smoke repository is required' },
          ]),
        },
        evidence,
      );
    }
    repoFullName = rec.smokeRepoFullName;
    const workflow = rec.smokeWorkflowPath ?? DEFAULT_SMOKE_WORKFLOW_PATH;

    // ---- gate 2: the smoke run --------------------------------------------
    const nonce = deps.nonce();
    const label = smokeLabel(nonce);
    // `seq` discriminates the `SMOKE#<installationId>#<seq>` partition. Wall-clock ms rather than a
    // counter: it needs to be unique per run, not ordered, and a counter would need its own atomic
    // row for a value nothing reads.
    seq = startedAtMs;

    const branch = await deps.defaultBranch(repoFullName);
    const minted = await deps.mintSmokeRunner({
      repoFullName,
      label,
      // Name carries the nonce so a leftover registration is identifiable in the operator's repo,
      // and so the run's `runner_name` is second, independent proof of which run was ours.
      name: `lca-validate-${nonce}`,
    });
    runnerId = minted.runnerId;

    const smoke = await deps.beginSmoke({
      seq,
      jitConfig: minted.jitConfig,
      repoFullName,
      labels: [label],
    });

    // ONE VM (ADR-041). Launch AFTER the rows exist: the guest asks the broker for its JIT config
    // as its first act, and a fast image can do that before a post-launch write would have landed.
    const launched = await deps.launch({
      imageArn: rec.imageArn,
      ref: smoke.ref,
      token: smoke.token,
    });
    microvmId = launched.microvmId;
    evidence.microvmId = microvmId;
    // Unconditionally and immediately, for the same reason as the real provision path: the broker
    // reads `microvmId` off this row to authorize a self-terminate, and a fast-failing image can
    // call terminate almost at once.
    await deps.stampVm({ seq, microvmId });

    // Dispatch AFTER the launch so the runner is on its way before the job is queued. The reverse
    // order also works (GitHub queues the job), but this way a launch failure costs no dispatch.
    await deps.dispatch({ repoFullName, workflow, ref: branch, nonce });
    const dispatchedAtMs = deps.now();

    const obs = await observeSmoke(deps, config, {
      repoFullName,
      workflow,
      label,
      runnerName: `lca-validate-${nonce}`,
      microvmId,
      dispatchedAtMs,
      pollUntil,
    });
    evidence.runnerId = obs.runnerId ?? runnerId;
    evidence.workflowRunId = obs.workflowRunId;
    evidence.workflowConclusion = obs.observations.workflowConclusion;
    evidence.selfTerminated = obs.observations.selfTerminated;

    const verdict = classifySmoke(obs.observations);
    deps.log({
      msg: 'flavor validation smoke run finished',
      ...idOf(req),
      state: verdict.state,
      microvmId,
      workflowRunId: obs.workflowRunId,
      conclusion: obs.observations.workflowConclusion,
      runnerRegistered: obs.observations.runnerRegistered,
      selfTerminated: obs.observations.selfTerminated,
      timedOut: obs.observations.timedOut,
    });
    return await writeVerdict(deps, req, verdict, {
      ...evidence,
      finishedAt: new Date(deps.now()).toISOString(),
    });
  } catch (err) {
    // OUR fault, not the image's. `classifySmoke` is given the error as `orchestrationError` so the
    // three-outcome rule has one implementation: it returns `pending`, which is a legal, retryable
    // transition out of `validating` and exists precisely for this. Writing `invalid` here would
    // permanently condemn an image because GitHub 500'd.
    const message = err instanceof Error ? err.message : String(err);
    const verdict = classifySmoke({
      launched: Boolean(microvmId),
      runnerRegistered: false,
      selfTerminated: false,
      orchestrationError: message,
    });
    deps.log({
      msg: 'flavor validation orchestration failed — returning flavor to pending',
      ...idOf(req),
      error: message,
      microvmId,
    });
    return await writeVerdict(deps, req, verdict, {
      ...evidence,
      finishedAt: new Date(deps.now()).toISOString(),
    });
  } finally {
    // ALWAYS. A smoke VM that outlives its run is a leaked VM on the operator's quota, and a
    // leftover runner registration is residue we left in someone else's repository after
    // condemning their image. Neither may depend on the happy path being taken.
    await cleanup(deps, { seq, microvmId, runnerId, repoFullName });
  }
}

function idOf(req: FlavorValidationRequest): Record<string, unknown> {
  return { installationId: req.installationId, flavor: req.name };
}

/**
 * Write the verdict, and say whether the write landed.
 *
 * A refused write is not an error to retry: the condition expression refuses precisely when the
 * row moved underneath us (a manual re-validate reopened `validating → pending`), in which case the
 * winner's verdict is the correct one and ours is stale by definition.
 */
async function writeVerdict(
  deps: OrchestratorDeps,
  req: FlavorValidationRequest,
  verdict: ValidationVerdict,
  evidence: FlavorValidationEvidence,
): Promise<OrchestratorResult> {
  const written = await deps.transition({
    installationId: req.installationId,
    name: req.name,
    to: verdict.state,
    reason: verdict.reason,
    evidence,
    actor: req.actor,
  });
  if (!written) {
    deps.log({
      msg: 'flavor validation verdict refused — the row moved during the run',
      ...idOf(req),
      attempted: verdict.state,
    });
  }
  return {
    ran: true,
    state: verdict.state,
    reason: verdict.reason,
    evidence,
    verdictWritten: written,
  };
}

/**
 * Best-effort teardown. Every step is independently guarded: a failure to delete a runner must not
 * prevent the VM from being terminated, which is the expensive one.
 */
async function cleanup(
  deps: OrchestratorDeps,
  input: {
    seq?: number;
    microvmId?: string;
    runnerId?: number;
    repoFullName?: string;
  },
): Promise<void> {
  if (input.microvmId) {
    try {
      // Unconditional, not "if still alive": a list-then-terminate would race the VM's own
      // shutdown, and terminating an already-terminated VM is the documented no-op.
      await deps.terminateVm(input.microvmId);
    } catch (err) {
      deps.log({
        msg: 'smoke VM terminate failed — the Reaper lifetime cap is the backstop',
        microvmId: input.microvmId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (input.runnerId !== undefined && input.repoFullName) {
    try {
      await deps.deleteRunner({ repoFullName: input.repoFullName, runnerId: input.runnerId });
    } catch (err) {
      deps.log({
        msg: 'smoke runner registration delete failed',
        runnerId: input.runnerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (input.seq !== undefined) {
    try {
      await deps.endSmoke(input.seq);
    } catch (err) {
      deps.log({
        msg: 'smoke row cleanup failed — the TTL is the backstop',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

interface ObserveResult {
  observations: SmokeObservations;
  runnerId?: number;
  workflowRunId?: number;
}

/**
 * Poll for the three facts ADR-041 requires, until they are all known or the budget runs out.
 *
 * The observations are deliberately independent — each answers a different question about the
 * image, and `classifySmoke` needs all three to distinguish the failure modes:
 *
 *  - **runner registered**: did the agent start at all? This is the ADR-019/020 `docker` case, and
 *    it is observed two ways because a single-use JIT runner is EPHEMERAL: it appears in the repo's
 *    runner list while connected and removes itself when its job ends, so a fast job can complete
 *    entirely between two polls. OUR CONFIRMED run reaching `in_progress` or a conclusion is
 *    therefore equally good proof — GitHub does not execute a job without a runner. Relying on the
 *    list alone would fail a perfectly good fast image.
 *  - **job conclusion**: can the image actually RUN a job, as opposed to merely boot one?
 *  - **self-terminated**: is the ADR-021 hook path wired? Only observable after the job ends, so it
 *    gets its own bounded window rather than being demanded at the same instant.
 *
 * Every one of those depends on having identified the RIGHT run, which is why `isOurRun` below is a
 * safety property and not a nicety.
 */
async function observeSmoke(
  deps: OrchestratorDeps,
  config: OrchestratorConfig,
  input: {
    repoFullName: string;
    workflow: string;
    label: string;
    /** AgentName minted for this run — independent confirmation of which run was ours. */
    runnerName: string;
    microvmId: string;
    dispatchedAtMs: number;
    pollUntil: number;
  },
): Promise<ObserveResult> {
  let runnerRegistered = false;
  let runnerId: number | undefined;
  let workflowRunId: number | undefined;
  let workflowConclusion: string | undefined;
  let selfTerminated = false;
  let timedOut = false;
  /** Set once the job concludes, bounding the self-terminate watch separately. */
  let concludedAtMs: number | undefined;
  /** Candidate run ids already checked and rejected, so we do not re-fetch their jobs each poll. */
  const notOurs = new Set<number>();

  /**
   * Whether a candidate run is the one THIS validation dispatched.
   *
   * A timestamp window narrows the candidates; it cannot identify one. GitHub's JIT runners are
   * matched by LABEL rather than bound to the job they were minted for, and the dispatch API returns
   * no run id — so a concurrent or manual `workflow_dispatch` of the same workflow in the same
   * second would satisfy the window. Accepting it would let another run's green conclusion mark an
   * unproven image `valid`, which is the exact outcome ADR-041 exists to prevent.
   *
   * The nonce is observable two independent ways: the job's resolved `runs-on` labels contain it
   * (the workflow's `runs-on` IS the nonce), and the runner that served it is the AgentName we
   * minted. Either is positive evidence.
   *
   * FAILS CLOSED: no nonce evidence means "not confirmed ours", not "probably ours". The cost is a
   * false `invalid` on an unreachable jobs API; the cost of the other direction is a routable image
   * that never ran anything.
   */
  const isOurRun = async (runId: number): Promise<boolean> => {
    const jobs = await deps.listRunJobs({ repoFullName: input.repoFullName, runId });
    const wanted = input.label.toLowerCase();
    return jobs.some(
      (j) =>
        j.labels.some((l) => l.toLowerCase() === wanted) ||
        j.runnerName?.toLowerCase() === input.runnerName.toLowerCase(),
    );
  };

  for (;;) {
    if (!runnerRegistered) {
      const runners = await deps.listRunners(input.repoFullName);
      const mine = runners.find((r) =>
        r.labels.some((l) => l.toLowerCase() === input.label.toLowerCase()),
      );
      if (mine) {
        runnerRegistered = true;
        runnerId = mine.id;
      }
    }

    if (workflowConclusion === undefined) {
      const runs = await deps.listDispatchRuns({
        repoFullName: input.repoFullName,
        workflow: input.workflow,
      });
      // Narrow by time first (a run created BEFORE our dispatch is never ours — `>=` because
      // GitHub's `created_at` has second granularity and can equal our millisecond timestamp's
      // second), then CONFIRM by nonce. Only a run we already confirmed, or one we confirm now,
      // may contribute an observation.
      const floor = Math.floor(input.dispatchedAtMs / 1000) * 1000;
      const candidates = runs.filter((r) => r.createdAt >= floor && !notOurs.has(r.id));
      for (const candidate of candidates) {
        if (workflowRunId !== undefined && candidate.id !== workflowRunId) continue;
        if (workflowRunId === undefined) {
          if (!(await isOurRun(candidate.id))) {
            notOurs.add(candidate.id);
            continue;
          }
          workflowRunId = candidate.id;
        }
        // A run GitHub has started or finished necessarily had a runner, which is why this counts
        // as registration evidence for an ephemeral JIT runner we may never see in the list.
        if (candidate.status === 'in_progress' || candidate.status === 'completed') {
          runnerRegistered = true;
        }
        if (candidate.conclusion) workflowConclusion = candidate.conclusion;
        break;
      }
    }

    if (workflowConclusion !== undefined && concludedAtMs === undefined) {
      concludedAtMs = deps.now();
    }

    if (!selfTerminated && (workflowConclusion !== undefined || runnerRegistered)) {
      const vms = await deps.listVms();
      const vm = vms.find((v) => v.microvmId === input.microvmId);
      // Gone from the fleet, or reported TERMINATED, both mean it shut itself down: nothing else
      // terminates it while the run is in flight (our own terminate is in `finally`, after this).
      if (!vm || vm.state === 'TERMINATED') selfTerminated = true;
    }

    if (workflowConclusion !== undefined && selfTerminated) break;

    const now = deps.now();
    if (now >= input.pollUntil) {
      timedOut = true;
      break;
    }
    // Once the job has concluded, stop waiting for self-termination after its own window rather
    // than burning the whole remaining budget: the answer is already `false` and reporting it early
    // leaves time for the verdict write.
    if (concludedAtMs !== undefined && now - concludedAtMs >= config.selfTerminateWaitMs) break;

    await deps.sleep(config.pollIntervalMs);
  }

  return {
    observations: {
      launched: true,
      runnerRegistered,
      workflowConclusion,
      selfTerminated,
      ...(timedOut ? { timedOut } : {}),
    },
    runnerId,
    workflowRunId,
  };
}
