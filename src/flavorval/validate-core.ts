import {
  KNOWN_CAPABILITIES,
  areCapabilitiesKnown,
} from '../provision/flavor.js';
import { builtinCollision, customFlavorBaseNameError, customFlavorLabel, customFlavorName } from '../shared/flavor-catalog.js';
import type { CustomFlavorRecord } from '../shared/flavor-store.js';
import type { MicroVMImageState } from '../shared/microvm.js';

/**
 * Custom-flavor validation logic (ADR-041) — the pure half.
 *
 * ADR-041's rule is that a custom flavor is **not routable until a smoke run proves it**, in two
 * gates: static checks, then one real microVM that must register a runner, execute a trivial job
 * and self-terminate through the ADR-021 broker. Everything in this file is I/O-free so both gates'
 * DECISION logic is unit-testable; the AWS/GitHub orchestration lives in `handler.ts`.
 *
 * The gates are deliberately asymmetric in strength, and the ADR is emphatic about why: the
 * ADR-019/020 `docker` flavor **passed every static check**. It built, published its ARN, resolved
 * correctly from its label — and failed every single job because nothing in the guest could start
 * `dockerd`. So the static gate exists only to avoid wasting a microVM on something already known
 * to be broken. It is never sufficient evidence, and `staticGate` returning `pass` must never be
 * reported to an operator as validation.
 */

/** Memory floor. Below this the runner agent + a trivial job will not fit. */
export const MIN_MEMORY_MB = 1024;

/**
 * Default memory ceiling, used when the region's real quota is unknown.
 *
 * ADR-040 requires `minimumMemoryInMiB` to be bounds-checked against the region's microVM memory
 * quota (spec 02: the quota is total memory of `RUNNING`/`SUSPENDED` VMs). That quota is an account
 * + region fact the control plane cannot derive locally, so the caller passes it when known. This
 * fallback is a SANITY ceiling, not the quota: it stops an obvious typo (`memoryMb: 655360`) from
 * reaching the service, while a real quota check still needs the live figure.
 */
export const DEFAULT_MAX_MEMORY_MB = 32768;

/** A single failed static check, in operator-facing language. */
export interface StaticGateFailure {
  code:
    | 'bad-name'
    | 'builtin-collision'
    | 'not-arm64'
    | 'unknown-capability'
    | 'memory-out-of-bounds'
    | 'missing-image-arn'
    | 'image-unusable'
    | 'image-unreadable'
    | 'image-probe-failed'
    | 'missing-smoke-repo';
  message: string;
}

/**
 * Failure codes that are NOT a verdict about the flavor — the check could not be performed.
 *
 * `classifySmoke` already refuses to spend terminal `invalid` on our own transient fault; the
 * static gate needs the same three-outcome shape for the same reason. `getMicroVMImageState`
 * deliberately distinguishes an ANSWER (`ABSENT` / `FORBIDDEN`) from a probe that could not run
 * (throttle, missing SDK command, an unmodelled error), and that distinction is worthless if the
 * gate collapses it: a throttled `GetMicrovmImage` would permanently condemn a working image and
 * force a manual re-validate to recover.
 */
const INCONCLUSIVE_CODES: ReadonlySet<StaticGateFailure['code']> = new Set(['image-probe-failed']);

/**
 * Whether these failures are all "could not check" rather than "is broken".
 *
 * A caller must map this to `pending` (retry later), never to `invalid` — which is terminal.
 * Mixed failures are NOT inconclusive: a real defect alongside a failed probe is still a real
 * defect, and the operator should be told about it now rather than after a retry.
 */
export function isInconclusive(failures: readonly StaticGateFailure[]): boolean {
  return failures.length > 0 && failures.every((f) => INCONCLUSIVE_CODES.has(f.code));
}

export type StaticGateResult =
  | { ok: true }
  | {
      ok: false;
      failures: StaticGateFailure[];
      /**
       * True when every failure is a "could not check" (see {@link isInconclusive}). The caller
       * must route this to `pending`, not to terminal `invalid`.
       */
      inconclusive: boolean;
    };

export interface StaticGateInput {
  /** The flavor as registered (or as proposed, for a pre-save preview). */
  flavor: Pick<
    CustomFlavorRecord,
    'base' | 'name' | 'label' | 'arch' | 'vcpu' | 'memoryMb' | 'capabilities' | 'imageArn'
  > &
    Partial<Pick<CustomFlavorRecord, 'smokeRepoFullName'>>;
  /**
   * Result of probing the image ARN, when it was probed. Absent means "not probed yet" — the gate
   * then checks everything it can WITHOUT the probe rather than inventing a verdict, so a
   * pre-save preview can run the cheap checks with no AWS calls.
   */
  image?: MicroVMImageState;
  /** The region's microVM memory quota in MiB, when known (ADR-040 bounds check). */
  maxMemoryMb?: number;
  /** Whether a smoke repo is required. True for a real validation run. */
  requireSmokeRepo?: boolean;
}

/**
 * Run the ADR-041 static gate. Collects EVERY failure rather than short-circuiting: an operator
 * fixing a registration wants the whole list, not one error per round-trip.
 *
 * A failed result carries `inconclusive` — true when nothing it found was a verdict about the
 * flavor (only a probe that could not run). Route that to `pending`, never terminal `invalid`;
 * {@link staticFailureVerdict} does it for you.
 */
export function staticGate(input: StaticGateInput): StaticGateResult {
  const f = input.flavor;
  const failures: StaticGateFailure[] = [];

  const nameError = customFlavorBaseNameError(f.base);
  if (nameError) failures.push({ code: 'bad-name', message: nameError });

  // Recompute name + label from `base` rather than trusting the stored strings. A row whose
  // `name`/`label` disagreed with its `base` — hand-edited, or written by an older/buggier writer
  // — would otherwise slip past the collision check that registration applied to the derived
  // values, which is exactly the shadowing ADR-040 forbids.
  if (!nameError) {
    const expectedName = customFlavorName(f.base);
    const expectedLabel = customFlavorLabel(f.base);
    if (f.name !== expectedName || f.label.toLowerCase() !== expectedLabel) {
      failures.push({
        code: 'bad-name',
        message: `stored name/label ('${f.name}' / '${f.label}') do not match the namespaced form derived from '${f.base}' ('${expectedName}' / '${expectedLabel}')`,
      });
    }
    const collision = builtinCollision(expectedName, expectedLabel);
    if (collision) {
      failures.push({
        code: 'builtin-collision',
        message: `collides with built-in flavor '${collision.collidesWith}' on ${collision.field}`,
      });
    }
  }

  // arm64 is a hard platform rule (AGENTS.md / ADR-007): microVMs are Graviton-only, so a non-arm64
  // flavor is not a preference mismatch, it is unrunnable.
  if (f.arch !== 'arm64') {
    failures.push({
      code: 'not-arm64',
      message: `arch must be 'arm64' (microVMs are Graviton-only); got '${f.arch}'`,
    });
  }

  // Capabilities feed `smallestWithCapability` upgrades AND the compat gate, so an unrecognized
  // string is not merely cosmetic — it is SILENTLY INERT, which is worse than rejected.
  if (!Array.isArray(f.capabilities) || !areCapabilitiesKnown(f.capabilities)) {
    const unknown = (f.capabilities ?? []).filter((c) => !KNOWN_CAPABILITIES.includes(c));
    failures.push({
      code: 'unknown-capability',
      message: `capabilities must be drawn from the closed vocabulary (${KNOWN_CAPABILITIES.join(', ')}); unknown: ${unknown.join(', ') || '(not an array)'}`,
    });
  }

  const max = input.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
  if (!Number.isFinite(f.memoryMb) || f.memoryMb < MIN_MEMORY_MB || f.memoryMb > max) {
    failures.push({
      code: 'memory-out-of-bounds',
      message: `memoryMb must be between ${MIN_MEMORY_MB} and ${max} MiB${input.maxMemoryMb ? ' (region microVM memory quota)' : ''}; got ${String(f.memoryMb)}`,
    });
  }

  if (!f.imageArn) {
    failures.push({ code: 'missing-image-arn', message: 'imageArn is required' });
  } else if (input.image) {
    if (input.image.state === 'UNKNOWN') {
      // The probe itself did not run (throttle, an SDK without the command, an unmodelled error).
      // That is not evidence about the image, so it must not become a terminal verdict — see
      // `INCONCLUSIVE_CODES`. `UNKNOWN` is the one state `getMicroVMImageState` uses for exactly
      // this case; `ABSENT` and `FORBIDDEN` are real answers and fall through below.
      failures.push({
        code: 'image-probe-failed',
        message:
          `could not determine the state of image ${f.imageArn}` +
          (input.image.error ? `: ${input.image.error}` : '') +
          ' — this is not a verdict about the image; retry validation',
      });
    } else if (input.image.state === 'FORBIDDEN') {
      // Distinguished from "broken" because the remedy is completely different: the operator must
      // grant the provisioner's role read access, not rebuild anything.
      failures.push({
        code: 'image-unreadable',
        message: `image ${f.imageArn} is not readable by the provisioner's role — grant it access to the image`,
      });
    } else if (!input.image.usable) {
      failures.push({
        code: 'image-unusable',
        message:
          `image ${f.imageArn} is not in a launchable state (state: ${input.image.state})` +
          (input.image.latestFailedImageVersion
            ? `; latest failed version ${input.image.latestFailedImageVersion}`
            : '') +
          (input.image.error ? `; probe error: ${input.image.error}` : ''),
      });
    }
  }

  if (input.requireSmokeRepo && !f.smokeRepoFullName) {
    failures.push({
      code: 'missing-smoke-repo',
      message:
        'a smoke repository is required: the ADR-041 smoke run registers a throwaway runner ' +
        'against a real repo and dispatches a trivial job there',
    });
  }

  return failures.length
    ? { ok: false, failures, inconclusive: isInconclusive(failures) }
    : { ok: true };
}

/** Render static-gate failures into the single `reason` string stored on an `invalid` flavor. */
export function formatStaticFailures(failures: readonly StaticGateFailure[]): string {
  return `static checks failed: ${failures.map((f) => f.message).join('; ')}`;
}

/**
 * Turn a failed static gate into the state to store, so no caller has to re-derive the
 * inconclusive rule (ADR-041: `invalid` is terminal and must never be spent on our own fault).
 */
export function staticFailureVerdict(failures: readonly StaticGateFailure[]): ValidationVerdict {
  if (isInconclusive(failures)) {
    return {
      state: 'pending',
      reason: `validation could not complete (not a verdict about the image): ${failures
        .map((f) => f.message)
        .join('; ')}`,
    };
  }
  return { state: 'invalid', reason: formatStaticFailures(failures) };
}

// ---- smoke run (ADR-041 gate 2) ---------------------------------------------

/** Default path of the operator-supplied smoke workflow. */
export const DEFAULT_SMOKE_WORKFLOW_PATH = '.github/workflows/lca-flavor-validate.yml';

/** Prefix of the one-shot label that binds a smoke runner to its own dispatched job. */
export const SMOKE_LABEL_PREFIX = 'lca-validate-';

/**
 * The nonce label for one smoke run.
 *
 * A single-use label is what makes the smoke run *safe to run in a live installation*. It is the
 * only label the throwaway runner advertises besides GitHub's automatic defaults, so:
 *   - the dispatched validation job can only be taken by THIS runner, and
 *   - this runner can only take THAT job — it cannot accidentally claim a real queued CI job and
 *     run someone's production workflow on an unvalidated image.
 *
 * It must also be absent from `/lca/<env>/config/runner-labels`, so ingest's claim gate ignores the
 * smoke job entirely and no second microVM is provisioned for it. `SMOKE_LABEL_PREFIX` is outside
 * the `lambda-ci*` namespace precisely so it can never be on that allowlist.
 */
export function smokeLabel(nonce: string): string {
  return `${SMOKE_LABEL_PREFIX}${nonce}`;
}

/** Whether a label is a smoke nonce label (used to assert it is never in the claim allowlist). */
export function isSmokeLabel(label: string): boolean {
  return label.trim().toLowerCase().startsWith(SMOKE_LABEL_PREFIX);
}

/** What a smoke run observed. Every field is control-plane observed unless noted. */
export interface SmokeObservations {
  /** The VM launched (RunMicrovm returned an id). */
  launched: boolean;
  /** A runner carrying the nonce label appeared in GitHub's runner list for the repo. */
  runnerRegistered: boolean;
  /** GitHub's conclusion for the dispatched validation run (`success`, `failure`, …). */
  workflowConclusion?: string;
  /** The VM was gone from ListMicrovms within the deadline (i.e. it self-terminated). */
  selfTerminated: boolean;
  /** Set when the run hit its wall-clock deadline before a conclusion. */
  timedOut?: boolean;
  /** Set when an orchestration step itself failed (not a verdict about the image). */
  orchestrationError?: string;
}

/**
 * A validation verdict: the state to store, plus the operator-facing reason.
 *
 * Three outcomes, not two, and the third is the important one. `invalid` is TERMINAL (ADR-041),
 * so it must only ever be spent on evidence ABOUT THE IMAGE. Anything that says nothing about the
 * image — a GitHub 500, a throttle, a probe that could not run, the λ losing its remaining time —
 * returns to `pending`, because permanently condemning a working image on our own transient fault
 * would force a manual re-validate to recover.
 */
export type ValidationVerdict =
  | { state: 'valid'; reason: string }
  | { state: 'invalid'; reason: string }
  /** The run could not be completed for reasons that say nothing about the image. */
  | { state: 'pending'; reason: string };

/** A smoke run's verdict. Same three outcomes as every other gate — see {@link ValidationVerdict}. */
export type SmokeVerdict = ValidationVerdict;

/**
 * Classify a smoke run's observations into a validation verdict.
 *
 * Three outcomes — see {@link ValidationVerdict} for why the third exists. `staticFailureVerdict`
 * applies the same rule to the static gate, so neither gate can spend terminal `invalid` on our
 * own fault.
 *
 * Everything the ADR requires must be positively observed. In particular a `success` conclusion is
 * NOT sufficient on its own: without `selfTerminated` the ADR-021 hook path is unproven, and an
 * image that runs jobs but never self-terminates leaks a VM per job until the Reaper's 2h cap —
 * which is precisely the ADR-019 regression this gate exists to catch.
 */
export function classifySmoke(obs: SmokeObservations): SmokeVerdict {
  if (obs.orchestrationError) {
    return {
      state: 'pending',
      reason: `validation could not complete (not a verdict about the image): ${obs.orchestrationError}`,
    };
  }
  if (!obs.launched) {
    return { state: 'invalid', reason: 'smoke run failed: the microVM could not be launched from this image' };
  }
  if (!obs.runnerRegistered) {
    return {
      state: 'invalid',
      reason:
        'smoke run failed: the Actions runner never registered with GitHub. The image booted but ' +
        'its entrypoint/run-hook did not start the agent — check the run log group for the VM.',
    };
  }
  if (obs.timedOut && !obs.workflowConclusion) {
    return {
      state: 'invalid',
      reason:
        'smoke run failed: the runner registered but the trivial job never reached a conclusion ' +
        'before the deadline. The agent came up without being able to execute a job (the ' +
        'ADR-019/020 docker-flavor failure mode).',
    };
  }
  if (obs.workflowConclusion !== 'success') {
    return {
      state: 'invalid',
      reason: `smoke run failed: the trivial validation job concluded '${obs.workflowConclusion ?? 'unknown'}'`,
    };
  }
  if (!obs.selfTerminated) {
    return {
      state: 'invalid',
      reason:
        'smoke run failed: the job succeeded but the microVM did not self-terminate through the ' +
        'hook broker. Every job on this image would leak a VM until the Reaper backstop (ADR-021).',
    };
  }
  return {
    state: 'valid',
    reason: 'smoke run passed: runner registered, trivial job succeeded, microVM self-terminated',
  };
}

/**
 * The workflow an operator must add to their smoke repo.
 *
 * Generated from a template rather than committed by us on the operator's behalf: writing to
 * someone's default branch to validate a flavor is a side effect nobody asked for, and the
 * auto-rewrite path (ADR-031) already establishes that we propose file changes rather than push
 * them. The console shows this text for the operator to commit.
 *
 * `runs-on` carries ONLY the nonce label (plus `self-hosted`), so this workflow is inert until a
 * validation run dispatches it with a matching nonce — it cannot be triggered into running on
 * ordinary infrastructure, and it cannot be claimed by ingest.
 */
export function smokeWorkflowYaml(): string {
  return `# LambdaCIActions custom-flavor validation (ADR-041).
#
# Commit this file to the repository you nominate as the smoke repo. A validation run dispatches
# it with a one-shot nonce; the job is only ever taken by the throwaway runner that validation
# launches from the candidate image, and is inert otherwise.
name: LCA flavor validate
on:
  workflow_dispatch:
    inputs:
      lca_nonce:
        description: One-shot label minted by LambdaCIActions for this validation run
        required: true
jobs:
  validate:
    # Only the runner carrying this exact nonce can take the job, and that runner advertises
    # nothing else — so it can never pick up a real CI job from this repo.
    runs-on: [self-hosted, "\${{ inputs.lca_nonce }}"]
    timeout-minutes: 10
    steps:
      - name: Prove the runner can execute a job
        run: |
          echo "flavor validation job running on $(uname -m)"
          test "$(uname -m)" = "aarch64"
`;
}
