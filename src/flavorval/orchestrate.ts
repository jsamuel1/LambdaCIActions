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

/**
 * A launch the service DEFINITIVELY refused (a 4xx: quota, validation, throttle).
 *
 * The only launch failure that proves no VM exists. Every other failure — a timeout, a dropped
 * connection, a 5xx — is ambiguous: `RunMicrovm` may have created the VM and lost the response, so
 * cleanup re-issues the launch with the same `clientToken` to learn its id and terminate it.
 */
export class LaunchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchRejectedError';
  }
}

/** A microVM as the orchestrator needs to see it. */
export interface OrchestratorVm {
  microvmId: string;
  state: string;
}

/**
 * An external effect did not answer inside the time the orchestrator could give it.
 *
 * Thrown by {@link bounded}, never by an effect itself. It is an ORCHESTRATION fault by definition
 * (a GitHub or AWS endpoint that hangs says nothing about the operator's image), so the catch in
 * {@link runValidation} turns it into `pending`, never `invalid`.
 */
export class EffectTimeoutError extends Error {
  constructor(
    readonly effect: string,
    readonly ms: number,
  ) {
    super(
      ms > 0
        ? `${effect} did not answer within ${ms}ms`
        : `${effect} not attempted — the validation budget was already spent`,
    );
    this.name = 'EffectTimeoutError';
  }
}

/**
 * Every effect the orchestrator performs. Named for what it means to the run, not for the AWS
 * or GitHub call behind it, so a fake reads as a scenario rather than as a mock script.
 *
 * Every external effect takes an optional trailing `signal`. The orchestrator aborts it when the
 * effect's time is up, so a real implementation can drop the socket instead of leaving it open —
 * but the deadline does NOT depend on an implementation honouring it: {@link bounded} races the
 * effect against its own timer and moves on regardless. A fake may ignore the signal entirely.
 */
export interface OrchestratorDeps {
  /** Read the flavor row. `undefined` when it was deleted mid-flight. */
  getFlavor(
    installationId: number,
    name: string,
    signal?: AbortSignal,
  ): Promise<CustomFlavorRecord | undefined>;
  /**
   * Claim the flavor for this run: `pending → validating`, stamped with `runId` and a lease. MUST be
   * the conditional-write form: `false` is how the orchestrator learns another run owns the flavor,
   * and is the only concurrency guard it has. MUST refuse a `runId` that {@link fence} has fenced.
   */
  claim(
    input: {
      installationId: number;
      name: string;
      runId: string;
      /** Epoch ms after which another run may take a stranded claim over. */
      leaseUntil: number;
      reason?: string;
      actor?: string;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Fence `runId` so a claim carrying it can never land (idempotent). */
  fence(
    input: { installationId: number; name: string; runId: string },
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Move the row out of `validating`. MUST be the conditional-write form and, given `runId`, MUST
   * require the row to still be held by that run — so a write that lands late can never touch a later
   * run's claim.
   */
  transition(
    input: {
      installationId: number;
      name: string;
      to: 'valid' | 'invalid' | 'pending';
      /**
       * Restrict the legal source states further than the state machine does. Used by the
       * `validating → pending` release, which must not overwrite a verdict that landed after all.
       */
      from?: readonly ('pending' | 'validating' | 'valid' | 'invalid')[];
      /** The claiming run's token; the write is refused unless the row is still ours. */
      runId?: string;
      reason?: string;
      evidence?: FlavorValidationEvidence;
      actor?: string;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Probe the candidate image (never throws — see `getMicroVMImageState`). */
  probeImage(imageArn: string, signal?: AbortSignal): Promise<MicroVMImageState>;
  /** Resolve the smoke repo's default branch, which the dispatch targets. */
  defaultBranch(repoFullName: string, signal?: AbortSignal): Promise<string>;
  /** Mint the nonce-labelled single-use JIT config. */
  mintSmokeRunner(
    input: {
      repoFullName: string;
      label: string;
      name: string;
    },
    signal?: AbortSignal,
  ): Promise<{ jitConfig: string; runnerId?: number }>;
  /** Write the `SMOKE#` rows the broker serves, returning the launch ref + the token to embed. */
  beginSmoke(
    input: {
      seq: number;
      jitConfig: string;
      repoFullName: string;
      labels: string[];
    },
    signal?: AbortSignal,
  ): Promise<{ ref: string; token: string }>;
  /**
   * Launch ONE microVM from the candidate image.
   *
   * MUST be idempotent on `clientToken` (RunMicrovm's own idempotency token): a second call with the
   * same token and input returns the VM the first one created. That is how cleanup learns the id of
   * a VM whose launch response was lost. MUST pass `maximumDurationInSeconds` to the service so the
   * platform itself terminates a VM nothing else could. A definitive refusal throws
   * {@link LaunchRejectedError}; anything else is treated as "may have been created".
   */
  launch(
    input: {
      imageArn: string;
      ref: string;
      token: string;
      clientToken: string;
      maximumDurationInSeconds: number;
    },
    signal?: AbortSignal,
  ): Promise<{ microvmId: string }>;
  /** Record the launched VM id on the smoke row so a brokered terminate can resolve it. */
  stampVm(input: { seq: number; microvmId: string }, signal?: AbortSignal): Promise<void>;
  /**
   * Dispatch the operator's validation workflow with the nonce LABEL as its input.
   *
   * `nonce` here is the full `lca-validate-<hex>` label, not the bare hex: the workflow interpolates
   * this value straight into `runs-on`, so it must be spelled exactly as the runner advertises it or
   * no runner can ever match the job.
   */
  dispatch(
    input: {
      repoFullName: string;
      workflow: string;
      ref: string;
      nonce: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Names + labels of the repo's currently registered runners, with their connection state.
   *
   * `status`/`busy` are part of the contract, not decoration. `generate-jitconfig` REGISTERS the
   * runner as a side effect of minting it (verified live: the row appears immediately with
   * `status: "offline"`), so a label match alone observes OUR OWN MINT and proves nothing about
   * the image. Only a runner that reached `online`/`busy` is evidence that the agent started.
   */
  listRunners(
    repoFullName: string,
    signal?: AbortSignal,
  ): Promise<
    {
      id: number;
      name: string;
      labels: string[];
      status?: string;
      busy?: boolean;
    }[]
  >;
  /** `workflow_dispatch` runs of the validation workflow, newest first. */
  listDispatchRuns(
    input: {
      repoFullName: string;
      workflow: string;
    },
    signal?: AbortSignal,
  ): Promise<
    {
      id: number;
      status?: string;
      conclusion?: string | null;
      createdAt: number;
    }[]
  >;
  /**
   * Jobs of a candidate run, carrying their resolved `runs-on` labels and runner name.
   *
   * This is the nonce-bearing evidence that a candidate run is OURS. A GitHub runner is matched by
   * label rather than bound to the job it was minted for, and the dispatch API returns no run id,
   * so a timestamp window alone cannot identify our run.
   */
  listRunJobs(
    input: {
      repoFullName: string;
      runId: number;
    },
    signal?: AbortSignal,
  ): Promise<{ id: number; labels: string[]; runnerName?: string }[]>;
  /** The live fleet, for observing self-termination. */
  listVms(signal?: AbortSignal): Promise<OrchestratorVm[]>;
  /** Terminate a VM. Best-effort: an already-gone VM is success. */
  terminateVm(microvmId: string, signal?: AbortSignal): Promise<void>;
  /** Remove a leftover runner registration. Must treat 404 as success. */
  deleteRunner(
    input: { repoFullName: string; runnerId: number },
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Cancel a smoke run that never reached a conclusion. Must treat "already terminal" as success.
   *
   * Residue cleanup, in the same class as `deleteRunner`: a dispatched run no runner could serve
   * stays `queued` in the operator's Actions tab for 24 hours (live-observed), so a validation that
   * condemns an image must not also leave a pending run in someone else's repository.
   */
  cancelRun(input: { repoFullName: string; runId: number }, signal?: AbortSignal): Promise<void>;
  /** Best-effort removal of the `SMOKE#` rows. */
  endSmoke(seq: number, signal?: AbortSignal): Promise<void>;
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
   * through the deliberate `validating → pending` escape.
   *
   * "Hard" means every awaited external effect, not just the polling loop: each one runs inside
   * {@link bounded}, which gives up on it at its own timer whether or not the effect ever answers.
   * A GitHub or AWS call that hangs therefore costs at most its slice of the budget, and the
   * verdict write + cleanup still happen in-process.
   */
  deadlineMs: number;
  /**
   * Time reserved for the verdict write + cleanup, ms. The main phase (claim → smoke run) must
   * finish by `deadline − reserve`; every main-phase effect is capped at whatever is left of that,
   * so the reserve is untouched when the verdict starts. MUST be at least
   * `2 × verdictTimeoutMs + CLEANUP_STEPS × cleanupStepTimeoutMs` (verdict, its pending fallback,
   * then every cleanup step) — see {@link reserveFits} — or a hung cleanup could run past the
   * deadline.
   */
  reserveMs: number;
  /**
   * Ceiling for ONE main-phase external call, ms (further capped by the remaining main budget).
   * Without it a single hung `defaultBranch` would silently consume the whole run before failing.
   */
  effectTimeoutMs: number;
  /** Ceiling for the verdict write, ms. Spent from the reserve. */
  verdictTimeoutMs: number;
  /**
   * Ceiling for EACH cleanup step (VM recovery, terminate, runner delete/recovery, run
   * cancel/recovery, smoke rows), ms.
   */
  cleanupStepTimeoutMs: number;
  /**
   * How long a claim holds the row, ms from the run's start. MUST exceed the λ's own timeout: an
   * expired lease is how a later run knows the claiming λ is gone and may take a stranded
   * `validating` row over (see `claimFlavorValidation`).
   */
  leaseMs: number;
  /**
   * Platform-enforced lifetime cap for the smoke VM, seconds (`maximumDurationInSeconds`). The last
   * backstop for a VM whose id cleanup could not learn: the service terminates it regardless. Must
   * outlast the main phase (the job runs on it) and is far below the Reaper's job-sized cap.
   */
  vmMaxDurationSeconds: number;
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

/**
 * How many independently bounded steps {@link cleanup} can perform — sizes the reserve: VM
 * recovery, terminate, runner delete (or recovery by name), run cancel (or recovery by nonce),
 * smoke rows.
 */
export const CLEANUP_STEPS = 5;

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  deadlineMs: 10 * 60_000,
  // Worst case every reserve-phase effect hangs: 2 × 8s (verdict + release) + 5 × 6s cleanup = 46s,
  // inside the 60s reserve. `reserveFits` below is the invariant; the tests pin it.
  reserveMs: 60_000,
  effectTimeoutMs: 30_000,
  verdictTimeoutMs: 8_000,
  cleanupStepTimeoutMs: 6_000,
  pollIntervalMs: 5_000,
  selfTerminateWaitMs: 90_000,
  // The λ timeout is 12 minutes (lib/control-stack.ts); 15 leaves margin for a cold start.
  leaseMs: 15 * 60_000,
  // Deadline + 2 minutes: the VM can never outlive the run that owns it by more than that.
  vmMaxDurationSeconds: 12 * 60,
};

/**
 * Whether the reserve covers the worst case: the verdict write AND its `pending` fallback both
 * hang, then every cleanup step hangs. False means a config could run past its own deadline.
 */
export function reserveFits(config: OrchestratorConfig): boolean {
  return (
    config.reserveMs >= 2 * config.verdictTimeoutMs + CLEANUP_STEPS * config.cleanupStepTimeoutMs
  );
}

/**
 * Run one external effect with a hard time limit.
 *
 * Races the effect against a timer rather than trusting it to time itself out: the GitHub client is
 * a bare `fetch` and the AWS SDK retries internally, and neither has a deadline of its own that is
 * tied to THIS λ's budget. On expiry the effect's `signal` is aborted (so a well-behaved
 * implementation releases its socket) and an {@link EffectTimeoutError} is thrown — whether or not
 * the effect ever settles. A late settlement is swallowed so it cannot surface as an unhandled
 * rejection after the run has moved on.
 *
 * `ms <= 0` means the budget is already spent: the effect is not started at all.
 */
export async function bounded<T>(
  effect: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!(ms > 0)) throw new EffectTimeoutError(effect, 0);
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new EffectTimeoutError(effect, ms);
      ctl.abort(err);
      reject(err);
    }, ms);
  });
  // `Promise.resolve().then` so a SYNCHRONOUS throw from `run` becomes a rejection like any other.
  const work = Promise.resolve().then(() => run(ctl.signal));
  work.catch(() => {});
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the run did, for the λ's own log/metric — the operator-facing outcome is on the row. */
export interface OrchestratorResult {
  /** False when another run owned the flavor (or it vanished) and this one did nothing. */
  ran: boolean;
  state?: ValidationVerdict['state'];
  reason?: string;
  evidence?: FlavorValidationEvidence;
  /** Set when the row could not be moved to a terminal state — the verdict is on the record. */
  verdictWritten?: boolean;
  /**
   * - `not-found` / `not-pending`: the row was not ours to touch.
   * - `claim-unknown`: the claim write did not answer in time, so whether it landed is unknown;
   *   the row was returned to `pending` (see the claim step for why that is safe either way).
   */
  skipped?: 'not-found' | 'not-pending' | 'no-smoke-repo' | 'claim-unknown';
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
 *
 * The deadline is HARD, and that is a property of every await below, not just of the polling loop:
 *
 *   |<----------- main phase: claim → smoke run ----------->|<-- reserve: verdict + cleanup -->|
 *   start                                   deadline − reserve                          deadline
 *
 * Every main-phase effect runs inside {@link bounded} with `min(effectTimeoutMs, time left in the
 * main phase)`, so a hung GitHub or AWS call becomes an {@link EffectTimeoutError} — an
 * orchestration fault, hence `pending` — no later than the end of the main phase. The verdict write
 * and each cleanup step have their own fixed ceilings, and the config invariant {@link reserveFits}
 * (`reserveMs ≥ 2 × verdictTimeoutMs + CLEANUP_STEPS × cleanupStepTimeoutMs`) keeps them inside
 * the deadline even when every one of them hangs.
 */
export async function runValidation(
  deps: OrchestratorDeps,
  req: FlavorValidationRequest,
  config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG,
): Promise<OrchestratorResult> {
  const startedAtMs = deps.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const deadlineAt = startedAtMs + config.deadlineMs;
  /** When the main phase must end so the verdict write + cleanup still fit in the budget. */
  const pollUntil = deadlineAt - config.reserveMs;
  /** One main-phase effect, capped by its own ceiling AND by what is left of the main phase. */
  const step = <T>(effect: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    bounded(effect, Math.min(config.effectTimeoutMs, pollUntil - deps.now()), run);

  const rec = await step('getFlavor', (signal) =>
    deps.getFlavor(req.installationId, req.name, signal),
  );
  if (!rec) {
    deps.log({
      msg: 'flavor validation skipped — flavor not found',
      ...idOf(req),
    });
    return { ran: false, skipped: 'not-found' };
  }

  // Claim the run. The conditional write IS the guard (ADR-041): only one of two concurrent
  // runs can win `pending → validating`, and losing means another run owns this flavor — so
  // exit WITHOUT touching the row, because writing anything would be writing over the winner.
  //
  // The claim carries THIS run's token. Every later write of ours (verdict, release) requires the
  // row to still hold it, and every transition out of `validating` removes it, so no write of ours
  // that lands late can ever touch a row some other actor has since moved — or a later run's claim.
  // One nonce serves as both the run token and the smoke label: both identify this one run.
  const nonce = deps.nonce();
  const runId = nonce;
  let claimed: boolean;
  try {
    claimed = await step('claim', (signal) =>
      deps.claim(
        {
          installationId: req.installationId,
          name: req.name,
          runId,
          leaseUntil: startedAtMs + config.leaseMs,
          reason: 'smoke run in progress',
          actor: req.actor,
        },
        signal,
      ),
    );
  } catch (err) {
    // The claim did not answer, so whether it LANDED is unknown — and it may still be in flight,
    // able to land AFTER anything we write now. Releasing alone is not enough: a release that runs
    // before the late claim sees `pending`, does nothing, and the claim then strands the row in
    // `validating` (reproduced by review). So, in order:
    //   1. FENCE our token. Once that lands, a claim carrying it fails its condition forever.
    //   2. Release `validating → pending` guarded by our token. It now only has the one case left to
    //      handle — a claim that landed before the fence — and DynamoDB orders the two writes.
    // If the fence itself cannot be confirmed, the claim's lease is the backstop: an expired lease
    // lets the next trigger take the row over (and an operator re-validate always can).
    const message = err instanceof Error ? err.message : String(err);
    deps.log({
      msg: 'flavor validation claim did not answer — fencing and releasing a possible claim',
      ...idOf(req),
      error: message,
    });
    const fenced = await fenceRun(deps, req, config, runId);
    const released = await releaseToPending(deps, req, config, runId, `claim failed: ${message}`);
    return {
      ran: false,
      skipped: 'claim-unknown',
      state: 'pending',
      // `released` is true only when our claim HAD landed. Otherwise the fence is what guarantees
      // the row cannot end up `validating`, so a confirmed fence counts as settled too.
      verdictWritten: released || fenced,
    };
  }
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
  /**
   * The exact launch request, once one was SENT. Kept so cleanup can re-issue it under the same
   * `clientToken` when the response never arrived: RunMicrovm is idempotent on that token, so the
   * retry returns the VM the lost call created (and only ever that one), which can then be
   * terminated by id. Cleared on a definitive {@link LaunchRejectedError}, which proves no VM.
   */
  let pendingLaunch: Parameters<OrchestratorDeps['launch']>[0] | undefined;
  /** Set once the mint was SENT: a lost mint response can still have registered our runner. */
  let mintSent = false;
  /** Lower bound for our run's `created_at`, once a dispatch was SENT (see `recoverRun`). */
  let dispatchSentAtMs: number | undefined;
  let workflow = DEFAULT_SMOKE_WORKFLOW_PATH;
  const label = smokeLabel(nonce);
  const runnerName = `lca-validate-${nonce}`;
  /**
   * Which run is CONFIRMED ours, and whether it concluded on its own. Shared with `observeSmoke`
   * and updated the moment each fact is learned — not when observation returns — so a fault in a
   * later poll still lets cleanup cancel our queued run, and never a bystander's.
   */
  const track: RunTrack = { concluded: false };
  const evidence: FlavorValidationEvidence = {
    imageArn: rec.imageArn,
    startedAt,
  };

  try {
    // ---- gate 1: static ----------------------------------------------------
    // Cheap, and first, so a flavor that is already known to be unrunnable never costs a microVM
    // launch or a GitHub registration. `requireSmokeRepo: true` because THIS path needs a repo to
    // register the throwaway runner against — unlike the console's pre-save preview, which runs
    // the same gate with the requirement off.
    const image = await step('probeImage', (signal) => deps.probeImage(rec.imageArn, signal));
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
      return await writeVerdict(deps, req, config, runId, verdict, {
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
        config,
        runId,
        {
          state: 'invalid',
          reason: formatStaticFailures([
            {
              code: 'missing-smoke-repo',
              message: 'a smoke repository is required',
            },
          ]),
        },
        evidence,
      );
    }
    const repo = rec.smokeRepoFullName;
    repoFullName = repo;
    workflow = rec.smokeWorkflowPath ?? DEFAULT_SMOKE_WORKFLOW_PATH;
    const wf = workflow;

    // ---- gate 2: the smoke run --------------------------------------------
    // `seq` discriminates the `SMOKE#<installationId>#<seq>` partition. Wall-clock ms rather than a
    // counter: it needs to be unique per run, not ordered, and a counter would need its own atomic
    // row for a value nothing reads.
    const runSeq = startedAtMs;
    seq = runSeq;

    const branch = await step('defaultBranch', (signal) => deps.defaultBranch(repo, signal));
    mintSent = true;
    const minted = await step('mintSmokeRunner', (signal) =>
      // A mint whose response is lost may still have REGISTERED the runner. Its name carries the
      // nonce, so cleanup finds it by name (`mintSent`) and deletes it rather than leaving it in
      // the operator's repository.
      deps.mintSmokeRunner(
        {
          repoFullName: repo,
          label,
          // Name carries the nonce so a leftover registration is identifiable in the operator's
          // repo, and so the run's `runner_name` is second, independent proof of which run was ours.
          name: runnerName,
        },
        signal,
      ),
    );
    runnerId = minted.runnerId;

    const smoke = await step('beginSmoke', (signal) =>
      deps.beginSmoke(
        {
          seq: runSeq,
          jitConfig: minted.jitConfig,
          repoFullName: repo,
          labels: [label],
        },
        signal,
      ),
    );

    // ONE VM (ADR-041). Launch AFTER the rows exist: the guest asks the broker for its JIT config
    // as its first act, and a fast image can do that before a post-launch write would have landed.
    //
    // A launch is an ambiguous side effect: a request that times out (or whose connection drops)
    // may still have created the VM. Two things make sure such a VM still dies:
    //   - `clientToken` is deterministic for this run, and `pendingLaunch` records the request, so
    //     cleanup re-issues it and the idempotent retry hands back the id the lost call created;
    //   - `maximumDurationInSeconds` makes the PLATFORM terminate it if even that retry fails.
    const launchRequest = {
      imageArn: rec.imageArn,
      ref: smoke.ref,
      token: smoke.token,
      clientToken: `lca-validate-${req.installationId}-${runSeq}-${nonce}`,
      maximumDurationInSeconds: config.vmMaxDurationSeconds,
    };
    pendingLaunch = launchRequest;
    let launched: { microvmId: string };
    try {
      launched = await step('launch', (signal) => deps.launch(launchRequest, signal));
    } catch (err) {
      // Only a definitive refusal proves there is no VM to find.
      if (err instanceof LaunchRejectedError) pendingLaunch = undefined;
      throw err;
    }
    pendingLaunch = undefined;
    const vmId = launched.microvmId;
    microvmId = vmId;
    evidence.microvmId = vmId;
    // Unconditionally and immediately, for the same reason as the real provision path: the broker
    // reads `microvmId` off this row to authorize a self-terminate, and a fast-failing image can
    // call terminate almost at once.
    await step('stampVm', (signal) => deps.stampVm({ seq: runSeq, microvmId: vmId }, signal));

    // Dispatch AFTER the launch so the runner is on its way before the job is queued. The reverse
    // order also works (GitHub queues the job), but this way a launch failure costs no dispatch.
    // Capture the lower bound BEFORE the API call. GitHub creates the run while processing the
    // dispatch, and `created_at` has only second granularity; sampling after a slow response can
    // move the floor into the next second and exclude the run we just created forever.
    const dispatchedAtMs = deps.now();
    dispatchSentAtMs = dispatchedAtMs;
    // The LABEL, not the bare nonce. The smoke workflow's `runs-on` is
    // `["${{ inputs.lca_nonce }}"]` (nonce ONLY — see `smokeWorkflowYaml`): the input IS the label
    // GitHub matches against the runner's advertised labels, and the runner advertises
    // `smokeLabel(nonce)`. Dispatching the bare hex leaves the job permanently unmatched: observed
    // live on 2026-08-20, where the job sat queued with no runner able to take it, and the run was
    // condemned for "never reached a conclusion" — a verdict about OUR dispatch, not the image.
    await step('dispatch', (signal) =>
      deps.dispatch({ repoFullName: repo, workflow: wf, ref: branch, nonce: label }, signal),
    );

    const obs = await observeSmoke(deps, config, step, track, {
      repoFullName: repo,
      workflow: wf,
      label,
      runnerName,
      microvmId: vmId,
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
    return await writeVerdict(deps, req, config, runId, verdict, {
      ...evidence,
      finishedAt: new Date(deps.now()).toISOString(),
    });
  } catch (err) {
    // OUR fault, not the image's. `classifySmoke` is given the error as `orchestrationError` so the
    // three-outcome rule has one implementation: it returns `pending`, which is a legal, retryable
    // transition out of `validating` and exists precisely for this. Writing `invalid` here would
    // permanently condemn an image because GitHub 500'd — or because GitHub hung, which is what an
    // `EffectTimeoutError` from `bounded` reports.
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
      timedOut: err instanceof EffectTimeoutError,
      microvmId,
    });
    return await writeVerdict(deps, req, config, runId, verdict, {
      ...evidence,
      ...(track.runId !== undefined ? { workflowRunId: track.runId } : {}),
      finishedAt: new Date(deps.now()).toISOString(),
    });
  } finally {
    // ALWAYS. A smoke VM that outlives its run is a leaked VM on the operator's quota, and a
    // leftover runner registration is residue we left in someone else's repository after
    // condemning their image. Neither may depend on the happy path being taken — nor on a response
    // having arrived: each create-type effect whose outcome is unknown is recovered here first.
    await cleanup(deps, config, {
      seq,
      microvmId,
      pendingLaunch,
      runnerId,
      runnerName: mintSent ? runnerName : undefined,
      repoFullName,
      // Only a run we CONFIRMED was ours, and only if it never concluded. Cancelling on the strength
      // of a timestamp window would let us cancel a bystander's dispatch of the same workflow.
      ...(track.runId !== undefined && !track.concluded ? { cancelRunId: track.runId } : {}),
      // A dispatch was sent but our run was never identified: find it by nonce (never by time
      // alone) and cancel it if it is still waiting.
      ...(track.runId === undefined && dispatchSentAtMs !== undefined
        ? { recoverRun: { workflow, label, runnerName, dispatchedAtMs: dispatchSentAtMs } }
        : {}),
    });
  }
}

/** The confirmed-ours run, as far as observation has got. Mutated by `observeSmoke`. */
interface RunTrack {
  runId?: number;
  concluded: boolean;
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
 *
 * Bounded by `verdictTimeoutMs`, and NEVER throws. A verdict write that hangs or fails is followed by
 * one bounded attempt to return the row to `pending` — conditional on it still being `validating`,
 * so a verdict that did land after all is never overwritten. That is the "never leave a row in
 * `validating`" guarantee in its last line of defence: it costs at most two verdict ceilings, both of
 * which the reserve is sized for.
 */
async function writeVerdict(
  deps: OrchestratorDeps,
  req: FlavorValidationRequest,
  config: OrchestratorConfig,
  runId: string,
  verdict: ValidationVerdict,
  evidence: FlavorValidationEvidence,
): Promise<OrchestratorResult> {
  let written: boolean;
  try {
    written = await bounded('verdict', config.verdictTimeoutMs, (signal) =>
      deps.transition(
        {
          installationId: req.installationId,
          name: req.name,
          to: verdict.state,
          // Ours, or nothing: a verdict that lands after our own release (which removes the token)
          // or after an operator re-validate is refused instead of overwriting the newer state.
          runId,
          reason: verdict.reason,
          evidence,
          actor: req.actor,
        },
        signal,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log({
      msg: 'flavor validation verdict write failed — releasing the row to pending',
      ...idOf(req),
      attempted: verdict.state,
      error: message,
    });
    // A `pending` verdict that failed is retried as the release itself; there is nothing else to
    // fall back to.
    const released = await releaseToPending(
      deps,
      req,
      config,
      runId,
      `verdict write failed (${verdict.state}): ${message}`,
    );
    return {
      ran: true,
      state: 'pending',
      reason: verdict.reason,
      evidence,
      verdictWritten: released,
    };
  }
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
 * Move the row `validating → pending`, ONLY from `validating` and ONLY while it is held by `runId`.
 * Bounded, never throws.
 *
 * Both guards are what make this safe to call when we do not know what the row looks like: a claim
 * that never landed leaves `pending` (refused — nothing to do), a verdict that landed leaves
 * `valid`/`invalid` (refused — the verdict stands), a row an operator re-opened or a later run
 * claimed carries no token or another one (refused — not ours), and only a row genuinely stranded
 * in `validating` by THIS run is released.
 */
async function releaseToPending(
  deps: OrchestratorDeps,
  req: FlavorValidationRequest,
  config: OrchestratorConfig,
  runId: string,
  reason: string,
): Promise<boolean> {
  try {
    return await bounded('release', config.verdictTimeoutMs, (signal) =>
      deps.transition(
        {
          installationId: req.installationId,
          name: req.name,
          to: 'pending',
          from: ['validating'],
          runId,
          reason,
          actor: req.actor,
        },
        signal,
      ),
    );
  } catch (err) {
    deps.log({
      msg: 'flavor validation could not release the row — the claim lease (or an operator re-validate) recovers it',
      ...idOf(req),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Fence `runId` against a late-landing claim. Bounded, never throws; true when confirmed. */
async function fenceRun(
  deps: OrchestratorDeps,
  req: FlavorValidationRequest,
  config: OrchestratorConfig,
  runId: string,
): Promise<boolean> {
  try {
    await bounded('fence', config.verdictTimeoutMs, (signal) =>
      deps.fence({ installationId: req.installationId, name: req.name, runId }, signal),
    );
    return true;
  } catch (err) {
    deps.log({
      msg: 'flavor validation could not fence its claim — the claim lease is the backstop',
      ...idOf(req),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Best-effort teardown. Every step is independently guarded AND independently bounded: a failure or
 * a hang deleting a runner must not prevent the VM from being terminated, which is the expensive
 * one, and must not push the run past its deadline. {@link CLEANUP_STEPS} counts these steps so the
 * reserve can be sized against them.
 *
 * Each create-type effect whose RESPONSE was lost is recovered before it is torn down, because a
 * lost response is not a failed create:
 *  - the VM, by re-issuing the launch under the same idempotency `clientToken` (it returns the VM
 *    the lost call created; if that call never reached the service, it creates one, which is
 *    terminated in the very next step — a few seconds of VM is the price of never leaking one);
 *  - the runner registration, by its nonce-bearing NAME;
 *  - the dispatched run, by the nonce on its job — never by its timestamp alone.
 */
async function cleanup(
  deps: OrchestratorDeps,
  config: OrchestratorConfig,
  input: {
    seq?: number;
    microvmId?: string;
    /** A launch that was sent but never answered (see `runValidation`). */
    pendingLaunch?: Parameters<OrchestratorDeps['launch']>[0];
    runnerId?: number;
    /** Set when a mint was sent: the registration can be found by this name. */
    runnerName?: string;
    repoFullName?: string;
    cancelRunId?: number;
    recoverRun?: { workflow: string; label: string; runnerName: string; dispatchedAtMs: number };
  },
): Promise<void> {
  const attempt = async (
    effect: string,
    run: (signal: AbortSignal) => Promise<void>,
    failure: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await bounded(effect, config.cleanupStepTimeoutMs, run);
    } catch (err) {
      deps.log({
        ...failure,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let vm = input.microvmId;
  const lost = input.pendingLaunch;
  if (!vm && lost) {
    await attempt(
      'recoverVm',
      async (signal) => {
        vm = (await deps.launch(lost, signal)).microvmId;
        deps.log({ msg: 'smoke VM recovered from a lost launch response', microvmId: vm });
      },
      {
        msg: 'smoke VM launch response lost and could not be recovered — maximumDurationInSeconds is the backstop',
        maximumDurationInSeconds: lost.maximumDurationInSeconds,
      },
    );
  }
  const vmId = vm;
  if (vmId) {
    // Unconditional, not "if still alive": a list-then-terminate would race the VM's own
    // shutdown, and terminating an already-terminated VM is the documented no-op.
    await attempt('terminateVm', (signal) => deps.terminateVm(vmId, signal), {
      msg: 'smoke VM terminate failed — maximumDurationInSeconds is the backstop',
      microvmId: vmId,
    });
  }
  const repo = input.repoFullName;
  const runner = input.runnerId;
  const name = input.runnerName;
  if (runner !== undefined && repo) {
    await attempt(
      'deleteRunner',
      (signal) => deps.deleteRunner({ repoFullName: repo, runnerId: runner }, signal),
      { msg: 'smoke runner registration delete failed', runnerId: runner },
    );
  } else if (name && repo) {
    await attempt(
      'recoverRunner',
      async (signal) => {
        const found = (await deps.listRunners(repo, signal)).find(
          (r) => r.name.toLowerCase() === name.toLowerCase(),
        );
        if (found) await deps.deleteRunner({ repoFullName: repo, runnerId: found.id }, signal);
      },
      { msg: 'smoke runner registration (mint response lost) could not be recovered', runnerName: name },
    );
  }
  const cancel = input.cancelRunId;
  const recover = input.recoverRun;
  if (cancel !== undefined && repo) {
    await attempt(
      'cancelRun',
      (signal) => deps.cancelRun({ repoFullName: repo, runId: cancel }, signal),
      {
        msg: 'smoke workflow run cancel failed — GitHub expires a queued run after 24h',
        runId: cancel,
      },
    );
  } else if (recover && repo) {
    await attempt(
      'recoverRun',
      async (signal) => {
        const floor = Math.floor(recover.dispatchedAtMs / 1000) * 1000;
        const runs = await deps.listDispatchRuns(
          { repoFullName: repo, workflow: recover.workflow },
          signal,
        );
        const wanted = recover.label.toLowerCase();
        const wantedRunner = recover.runnerName.toLowerCase();
        for (const r of runs) {
          // A concluded run is not residue, and one created before our dispatch is not ours.
          if (r.createdAt < floor || r.conclusion) continue;
          const jobs = await deps.listRunJobs({ repoFullName: repo, runId: r.id }, signal);
          const ours = jobs.some(
            (j) =>
              j.labels.some((l) => l.toLowerCase() === wanted) ||
              j.runnerName?.toLowerCase() === wantedRunner,
          );
          if (ours) {
            await deps.cancelRun({ repoFullName: repo, runId: r.id }, signal);
            return;
          }
        }
      },
      { msg: 'unidentified smoke workflow run could not be recovered — GitHub expires it after 24h' },
    );
  }
  const seq = input.seq;
  if (seq !== undefined) {
    await attempt('endSmoke', (signal) => deps.endSmoke(seq, signal), {
      msg: 'smoke row cleanup failed — the TTL is the backstop',
    });
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
 *    list alone would fail a perfectly good fast image. The list check demands a CONNECTED runner
 *    (`online`/`busy`), because minting the JIT config already created the registration.
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
  /**
   * The bounded-effect runner from `runValidation`. A poll that hangs past it throws
   * {@link EffectTimeoutError}, which propagates to the caller's catch as an orchestration fault
   * (`pending`): a GitHub that stops answering is not evidence that the image failed, so it must
   * never be scored as "runner never registered".
   */
  step: <T>(effect: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  /** Updated the moment our run is confirmed / concludes, so cleanup sees it even on a fault. */
  track: RunTrack,
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
    const jobs = await step('listRunJobs', (signal) =>
      deps.listRunJobs({ repoFullName: input.repoFullName, runId }, signal),
    );
    const wanted = input.label.toLowerCase();
    return jobs.some(
      (j) =>
        j.labels.some((l) => l.toLowerCase() === wanted) ||
        j.runnerName?.toLowerCase() === input.runnerName.toLowerCase(),
    );
  };

  for (;;) {
    if (!runnerRegistered) {
      const runners = await step('listRunners', (signal) =>
        deps.listRunners(input.repoFullName, signal),
      );
      const mine = runners.find(
        (r) =>
          r.labels.some((l) => l.toLowerCase() === input.label.toLowerCase()) &&
          // CONNECTED, not merely present. Minting the JIT config registers the runner up front
          // (live-verified: `status: "offline"` the instant `generate-jitconfig` returns), so
          // accepting any row carrying our label would score every image "the agent started" —
          // including one whose `run.sh` exits 127, which is precisely the ADR-019/020 defect this
          // observation exists to catch. Observed on 2026-08-20: the deliberately broken fixture
          // was recorded `runnerRegistered: true` and condemned with the WRONG reason.
          (r.status?.toLowerCase() === 'online' || r.busy === true),
      );
      if (mine) {
        runnerRegistered = true;
        runnerId = mine.id;
      }
    }

    if (workflowConclusion === undefined) {
      const runs = await step('listDispatchRuns', (signal) =>
        deps.listDispatchRuns(
          {
            repoFullName: input.repoFullName,
            workflow: input.workflow,
          },
          signal,
        ),
      );
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
          track.runId = candidate.id;
        }
        // A run GitHub has started or finished necessarily had a runner, which is why this counts
        // as registration evidence for an ephemeral JIT runner we may never see in the list.
        if (candidate.status === 'in_progress' || candidate.status === 'completed') {
          runnerRegistered = true;
        }
        if (candidate.conclusion) {
          workflowConclusion = candidate.conclusion;
          track.concluded = true;
        }
        break;
      }
    }

    if (workflowConclusion !== undefined && concludedAtMs === undefined) {
      concludedAtMs = deps.now();
    }

    if (!selfTerminated && (workflowConclusion !== undefined || runnerRegistered)) {
      const vms = await step('listVms', (signal) => deps.listVms(signal));
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

    // Never sleep past the end of the main phase: an uncapped final sleep would spend the reserve.
    await deps.sleep(Math.min(config.pollIntervalMs, Math.max(0, input.pollUntil - now)));
    // Re-check AFTER the sleep, before polling again: a poll started with no main-phase budget left
    // would be refused by `step` and reported as an orchestration fault, when the true outcome is
    // simply that the run timed out.
    if (deps.now() >= input.pollUntil) {
      timedOut = true;
      break;
    }
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
