import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };
import { parseRunnerLabels as parse, serializeRunnerLabels as serialize } from '../mgmt/validate.js';

/**
 * Flavor ⇄ control-plane reconciliation (ADR-049).
 *
 * The catalog (`microvm/flavors.json`) is a *claim*. What a job can actually run on is
 * decided by two independent pieces of LIVE state:
 *
 *   1. `/lca/<env>/config/runner-labels` — the claim allowlist. `shouldClaim`
 *      (src/ingest/filter.ts) drops a `workflow_job` whose `runs-on` names none of these
 *      labels BEFORE flavor resolution runs. A missing label is a silent dead end: GitHub
 *      gets 202 `claimed:false`, nothing is provisioned, the job sits queued forever.
 *   2. `/lca/<env>/config/image-arn-<flavor>` → a microVM image that really exists in a
 *      usable state. A published ARN whose image was never built (or failed to build) means
 *      the job IS claimed and then dies in provisioning — and a claimed job can no longer
 *      fall back to a GitHub-hosted runner.
 *
 * Those two facts give the ordering that this module encodes as a safety property, not a
 * preference: **image first, label second.** Adding a label ahead of its image converts a
 * silent queue into a claimed job that fails, which is strictly worse.
 *
 * This module is PURE. It takes observations of live state and derives status; it performs
 * no I/O. Consumers derive from here so they cannot disagree:
 *   - `scripts/flavors-reconcile.mjs` (`npm run flavors:reconcile`) — operator CLI.
 *   - `scripts/build-images.mjs` — the `mayClaimLabel` ordering guard.
 *
 * The console health item is a separate card (the Management API does NOT import this yet).
 * When it lands it must consume this derivation rather than re-deriving one, and must pass
 * `imageState: undefined` — its evidence is `DescribeParameters` presence, not a real image
 * state, so its honest verdict is `image_unverified`.
 */

export interface ReconcileFlavorDef {
  name: string;
  label: string;
  memoryMb: number;
  capabilities: string[];
}

const FLAVORS: ReconcileFlavorDef[] = (
  flavorsCatalog as { flavors: ReconcileFlavorDef[] }
).flavors;

/** Catalog flavor definitions, in catalog order. */
export function catalogFlavors(): ReconcileFlavorDef[] {
  return FLAVORS.map((f) => ({
    name: f.name,
    label: f.label,
    memoryMb: f.memoryMb,
    capabilities: [...f.capabilities],
  }));
}

/**
 * microVM image states that can actually back a launch.
 *
 * `UPDATED` is as usable as `CREATED` — it is what a rebuilt image reports (a rebuild adds a
 * version to an existing image), and treating it as unusable would report drift on every
 * flavor that has ever been rebuilt. Verified against the live dev plane: base/node/docker
 * all sit at `UPDATED`.
 */
export const USABLE_IMAGE_STATES: ReadonlySet<string> = new Set(['CREATED', 'UPDATED']);

/** States that mean the image is mid-build — not usable yet, but not broken either. */
export const PENDING_IMAGE_STATES: ReadonlySet<string> = new Set([
  'CREATING',
  'UPDATING',
  'PENDING',
]);

/**
 * The only TERMINAL microVM state, per the deployed service model.
 *
 * `MicrovmState` in `lambda-microvms` 2025-09-09 is exactly
 * `PENDING | RUNNING | SUSPENDING | SUSPENDED | TERMINATING | TERMINATED`. There is no
 * `FAILED` microVM state — `FAILED` belongs to `BuildState`/`MicrovmImageVersionState`, which
 * describe an image BUILD, not a VM. Excluding it from the live set would widen "terminal"
 * beyond the model in the one direction a safety gate must never widen: a state the gate
 * treats as terminal is a VM it will happily replace an image underneath.
 *
 * `TERMINATING` is deliberately LIVE. The VM still exists and may still be resuming from the
 * image about to be swapped, which is the exact skew the quiesce gate exists to refuse.
 *
 * Lives here rather than in each script because both `build-images.mjs` and
 * `flavors:reconcile --fix` gate on it, and two copies of a safety predicate is how one of
 * them quietly stops matching the model (ADR-049 § one derivation).
 */
export const TERMINAL_MICROVM_STATES: ReadonlySet<string> = new Set(['TERMINATED']);

/**
 * Whether a microVM counts as live for the quiesce gate.
 *
 * Unknown counts as LIVE: an absent, empty or unrecognized state is not evidence the VM is
 * gone, and the safe reading of "I do not know what this VM is doing" is to refuse the image
 * swap. That is the same optional-by-ignorance rule the image/allowlist observations use, with
 * the bias pointed at refusing rather than proceeding.
 */
export function isLiveMicroVmState(state: string | undefined | null): boolean {
  return !TERMINAL_MICROVM_STATES.has(String(state ?? '').toUpperCase());
}

/**
 * What we observed about one flavor in one environment.
 *
 * Every field is optional-by-ignorance rather than optional-by-default: a consumer that
 * cannot see a piece of live state passes `undefined`, and the derivation degrades to a
 * weaker (never a falsely reassuring) verdict. That is why `imageState: undefined` with a
 * published ARN is `image_unverified` and not `ok` — the console reads parameter PRESENCE
 * via DescribeParameters and does not call the microVM API, so it must not claim an image
 * exists merely because a parameter names one.
 */
export interface FlavorObservation {
  /** Catalog flavor name (`python`). */
  name: string;
  /** Label present in the LIVE allowlist parameter. `undefined` = allowlist not read. */
  labelClaimed?: boolean;
  /** Image ARN published in SSM, or `undefined`/null when the parameter is absent. */
  imageArn?: string | null;
  /**
   * Concrete state from `get-microvm-image`. `undefined` = not checked (console);
   * `null` = checked and the image does NOT exist (e.g. ResourceNotFoundException).
   */
  imageState?: string | null;
}

/**
 * Per-flavor verdict. Ordered from "runnable" to "worse than not advertising it".
 *
 * - `ok`                  — label claimed, ARN published, image usable.
 * - `image_unverified`    — label + ARN present, image state not checked (console view).
 * - `label_unverified`    — image usable, but the allowlist was never read, so whether the flavor
 *                          is reachable is unknown. NOT `ok`: `ok` asserts a claimed label, and a
 *                          consumer that did not read `runner-labels` has not observed that. This
 *                          is the `image_unverified` rule applied to the other half of the live
 *                          state — unknown is neither health nor drift.
 * - `image_building`      — ARN present, image mid-build. Transient.
 * - `label_missing`       — the label is not claimed, so the flavor can never be selected. Safe
 *                          to fix by adding the label ONLY when the image was verified usable;
 *                          an unchecked image reports the same health with `safeFix: null`.
 * - `image_missing`       — label claimed but no usable image: jobs are claimed and then
 *                          fail in provisioning, having lost the GitHub-hosted fallback.
 *                          The worst state, and the one label-before-image creates.
 * - `not_built`           — neither label nor image. A catalog entry that silently queues
 *                          forever. Safe to fix by building.
 * - `image_failed`        — the image exists in a *_FAILED state.
 */
export type FlavorHealth =
  | 'ok'
  | 'image_unverified'
  | 'label_unverified'
  | 'image_building'
  | 'label_missing'
  | 'image_missing'
  | 'not_built'
  | 'image_failed';

/** How bad a health value is for an operator. `blocked` = this flavor cannot run a job. */
export type FlavorSeverity = 'ok' | 'warn' | 'blocked';

/**
 * The only remediation this tool will perform without a human deciding.
 *
 * - `build`     — build + publish the image, then add the label (in that order).
 * - `add-label` — the image already exists and is usable; add the label.
 *
 * There is deliberately no `remove-label`: removing a label from the live allowlist takes
 * routing away from jobs that may be depending on it right now, and the correct response to
 * "advertised but unbuildable" is a human decision (build it, or delete the catalog entry).
 */
export type SafeFix = 'build' | 'add-label' | null;

export interface FlavorReconcileRow {
  name: string;
  label: string;
  /** Always true here — every row comes from the catalog. Kept explicit for the UI/CLI table. */
  inCatalog: boolean;
  labelClaimed?: boolean;
  imageArn?: string | null;
  imageState?: string | null;
  health: FlavorHealth;
  severity: FlavorSeverity;
  /** One-line operator-facing explanation of the consequence, not just the state. */
  detail: string;
  /** The command that fixes it, or undefined when a human has to decide. */
  fix?: string;
  safeFix: SafeFix;
}

export interface FlavorReconcileReport {
  rows: FlavorReconcileRow[];
  /** True when any row is not `ok`/`image_unverified`/`label_unverified` — i.e. catalog and live
   *  state demonstrably disagree. An UNOBSERVED field is not disagreement, so it is not drift. */
  drift: boolean;
  counts: Record<FlavorSeverity, number>;
  /**
   * Labels in the live allowlist that no catalog flavor claims. NOT drift: a FlavorMap can
   * legitimately claim `ubuntu-latest`, and adopt mode depends on exactly that (ADR-030).
   * Reported so an operator can see the whole parameter, never auto-removed.
   */
  extraLabels: string[];
}

const SEVERITY: Record<FlavorHealth, FlavorSeverity> = {
  ok: 'ok',
  image_unverified: 'ok',
  // Unknown is not an alarm and not drift — the same treatment `image_unverified` gets. What it
  // must never be is `ok`, which claims a label this observation never looked at.
  label_unverified: 'ok',
  image_building: 'warn',
  label_missing: 'warn',
  image_missing: 'blocked',
  not_built: 'blocked',
  image_failed: 'blocked',
};

function healthOf(obs: FlavorObservation): FlavorHealth {
  const hasArn = typeof obs.imageArn === 'string' && obs.imageArn.length > 0;
  const state = obs.imageState;
  const claimed = obs.labelClaimed;

  // Image usability, as three-valued as the observation: usable / unusable / unknown.
  const usable = hasArn && (state === undefined || (state !== null && USABLE_IMAGE_STATES.has(state)));
  const building = hasArn && typeof state === 'string' && PENDING_IMAGE_STATES.has(state);
  const failed = hasArn && typeof state === 'string' && /_FAILED$/.test(state);

  if (failed) return 'image_failed';
  if (building) return 'image_building';

  if (!usable) {
    // No image an operator can launch. Which failure it is depends on the label: a claimed
    // label with no image is actively harmful, an unclaimed one is merely a dead catalog row.
    if (claimed === true) return 'image_missing';
    return 'not_built';
  }

  // Image is usable (or presumed so). The remaining question is reachability.
  if (claimed === false) return 'label_missing';
  // The allowlist was never read. `ok` would assert `label claimed` from an unobserved fact —
  // exactly the false confidence this module exists to remove, one field over from the image
  // probe. Report the ignorance instead; an unread allowlist is not a claimed one.
  if (claimed === undefined) return 'label_unverified';
  if (state === undefined) return 'image_unverified';
  return 'ok';
}

function detailOf(row: Omit<FlavorReconcileRow, 'detail' | 'fix' | 'safeFix'>): string {
  switch (row.health) {
    case 'ok':
      return `runnable — label claimed, image ${row.imageState}`;
    case 'image_unverified':
      return 'label claimed and an image ARN is published; image state not checked from here';
    case 'label_unverified':
      return (
        `image ${row.imageState ?? 'ARN published'} — but the live allowlist was not read, so ` +
        `whether '${row.label}' is claimed (and the flavor therefore selectable) is unknown`
      );
    case 'image_building':
      return `image is ${row.imageState} — not launchable until it reaches CREATED/UPDATED`;
    case 'label_missing':
      // Two different observations land here, and only one of them has earned the claim that the
      // image works. An unchecked image (`imageState: undefined` — the console's evidence, and
      // `--no-image-check`) must not be described as usable: that is the same false confidence
      // ADR-049 exists to remove, one field over. The label gap itself is a verified fact either
      // way, so this stays drift.
      return row.imageState === undefined
        ? `'${row.label}' is absent from the live allowlist — jobs are dropped by shouldClaim ` +
            'before routing, so this flavor can never be selected. An image ARN is published but ' +
            'its state was not checked from here, so the label is not yet earned'
        : `image is usable but '${row.label}' is absent from the live allowlist — jobs are ` +
            'dropped by shouldClaim before routing, so this capacity can never be selected';
    case 'image_missing':
      return `'${row.label}' IS claimed but there is no usable image — jobs get claimed and ` +
        'then fail in provisioning, with no GitHub-hosted fallback left';
    case 'not_built':
      return 'advertised by the catalog but neither built nor claimed — jobs queue forever ' +
        'with no error anywhere';
    case 'image_failed':
      return `image build ${row.imageState} — rebuild before this flavor can run anything`;
    default:
      return 'unknown';
  }
}

function fixOf(
  health: FlavorHealth,
  name: string,
  imageVerified: boolean,
): { fix?: string; safeFix: SafeFix } {
  switch (health) {
    case 'not_built':
    case 'image_failed':
      return { fix: `npm run build:images -- --flavor ${name}`, safeFix: 'build' };
    case 'image_missing':
      // The image is what is missing, so building it IS the safe direction — the label is
      // already claimed, so this strictly reduces harm.
      return { fix: `npm run build:images -- --flavor ${name}`, safeFix: 'build' };
    case 'label_missing':
      // The command is the same either way — `--publish-label-only` re-verifies the image via
      // `mayClaimLabel` and refuses if it cannot. But `safeFix` is what an automated consumer
      // acts on unattended, so an unverified image earns no automatic action: unknown must never
      // authorise a live routing change.
      return {
        fix: `npm run build:images -- --flavor ${name} --publish-label-only`,
        safeFix: imageVerified ? 'add-label' : null,
      };
    case 'image_building':
      return { fix: 'wait for the build to reach CREATED/UPDATED', safeFix: null };
    default:
      return { safeFix: null };
  }
}

/**
 * Derive the per-flavor reconciliation report.
 *
 * Observations are keyed by flavor name; a catalog flavor with no observation is treated as
 * fully unobserved (which lands on `not_built` — the safe reading, since an unobserved
 * flavor is certainly not proven runnable).
 */
export function reconcileFlavors(
  observations: FlavorObservation[],
  liveLabels?: string[],
): FlavorReconcileReport {
  const byName = new Map(observations.map((o) => [o.name, o]));
  const rows: FlavorReconcileRow[] = catalogFlavors().map((f) => {
    const obs = byName.get(f.name) ?? { name: f.name };
    const health = healthOf(obs);
    const base = {
      name: f.name,
      label: f.label,
      inCatalog: true,
      labelClaimed: obs.labelClaimed,
      imageArn: obs.imageArn,
      imageState: obs.imageState,
      health,
      severity: SEVERITY[health],
    };
    return {
      ...base,
      detail: detailOf(base),
      ...fixOf(health, f.name, mayClaimLabel(obs)),
    };
  });

  const counts: Record<FlavorSeverity, number> = { ok: 0, warn: 0, blocked: 0 };
  for (const r of rows) counts[r.severity] += 1;

  const catalogLabels = new Set(FLAVORS.map((f) => f.label.toLowerCase()));
  const extraLabels = (liveLabels ?? [])
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !catalogLabels.has(l.toLowerCase()));

  return {
    rows,
    drift: rows.some((r) => r.severity !== 'ok'),
    counts,
    extraLabels,
  };
}

// ---- allowlist string handling ---------------------------------------------

/**
 * Parse the `runner-labels` parameter value into the effective claim list.
 *
 * Re-exported from `src/mgmt/validate.ts` rather than reimplemented: the console's Settings
 * screen writes that parameter through `validateRunnerLabelsBody` + `serializeRunnerLabels`,
 * and this module's `addRunnerLabel` writes it from the build script. Two parsers for one
 * hand-edited parameter is precisely how a label that the UI shows as present becomes one the
 * gate does not accept.
 */
export { parseRunnerLabels, serializeRunnerLabels } from '../mgmt/validate.js';

/**
 * Add a label to an allowlist value, preserving existing order and any non-catalog labels.
 *
 * Append-only and case-insensitively idempotent. Order is preserved rather than sorted so
 * that re-running the tool does not rewrite an operator's parameter for cosmetic reasons —
 * a diffless no-op is what makes this safe to run from a reconcile loop.
 *
 * Case-insensitive because the claim gate lowercases before comparing (`shouldClaim`): a
 * differently-cased duplicate would be a silent no-op there while looking like a change here.
 */
export function addRunnerLabel(
  currentValue: string | undefined | null,
  label: string,
): { value: string; changed: boolean; labels: string[] } {
  const labels = parse(currentValue ?? undefined);
  const wanted = label.trim();
  if (!wanted) return { value: serialize(labels), changed: false, labels };
  if (labels.some((l) => l.toLowerCase() === wanted.toLowerCase())) {
    return { value: serialize(labels), changed: false, labels };
  }
  const next = [...labels, wanted];
  return { value: serialize(next), changed: true, labels: next };
}

/** Every catalog label — the value DEPLOY-M1's seed command must be a superset of. */
export function allCatalogLabels(): string[] {
  return FLAVORS.map((f) => f.label);
}

/**
 * Whether a label may be added to the allowlist given what we know about its image.
 *
 * This is the ordering guard, expressed once so the build script and the reconcile CLI
 * enforce the identical rule. `imageState === undefined` is NOT permission: a caller that
 * has not verified the image has not earned the label write.
 */
export function mayClaimLabel(obs: Pick<FlavorObservation, 'imageArn' | 'imageState'>): boolean {
  const hasArn = typeof obs.imageArn === 'string' && obs.imageArn.length > 0;
  return hasArn && typeof obs.imageState === 'string' && USABLE_IMAGE_STATES.has(obs.imageState);
}

// ---- image probe: absent is not the same fact as unreadable -----------------

/**
 * What a failed `get-microvm-image` call actually told us.
 *
 * - `absent`     — the API answered, and the image is not there (`ResourceNotFoundException`).
 *                  A real, reportable fact: `imageState: null`.
 * - `unreadable` — we never learned anything. AccessDenied, an expired token, throttling, a
 *                  wrong region, or an AWS CLI older than 2.35.17 (no `lambda-microvms`
 *                  service model at all). NOT a fact about the image: `imageState: undefined`.
 *
 * Collapsing the second case into the first is the whole bug ADR-049 exists to close, one
 * level down. A CLI that cannot call the microVM API would otherwise report every healthy
 * flavor as `image_missing`/`blocked` — a confident verdict about a plane it never observed,
 * exactly like the `ParameterNotFound` from the wrong region that misled the original
 * diagnosis. Worse, `image_missing` carries `safeFix: 'build'`, so `--fix` would rebuild a
 * whole healthy catalog on the strength of a permissions error.
 */
export type ImageProbeFailure = 'absent' | 'unreadable';

/**
 * Classify a non-zero `get-microvm-image` invocation from its stderr.
 *
 * Only the API's own not-found signal counts as absence. Everything else — including a
 * `ValidationException` on a malformed identifier, which says the request was wrong, not that
 * the image is missing — is unreadable, because the honest answer is "unknown".
 */
export function classifyImageProbeFailure(stderr: string | undefined | null): ImageProbeFailure {
  return /ResourceNotFoundException/i.test(stderr ?? '') ? 'absent' : 'unreadable';
}

/**
 * The same distinction for an SSM read, because the claim allowlist has the same failure modes.
 *
 * `get-parameter /lca/<env>/config/runner-labels` failing is two different facts:
 *
 * - `ParameterNotFound` — the allowlist genuinely does not exist yet (a fresh environment
 *   before DEPLOY-M1 phase 0). Nothing is claimed, and reporting every flavor as unclaimed is
 *   CORRECT.
 * - anything else — AccessDenied, an expired token, throttling. We learned nothing about the
 *   allowlist, and treating that as "no labels are claimed" would report every built flavor as
 *   `label_missing` and every unbuilt one as `not_built`: a confident drift verdict about a
 *   parameter never read, from a tool whose entire purpose is to be the trustworthy answer.
 *
 * This is deliberately the same shape as `classifyImageProbeFailure`. The image probe learned
 * it first; the allowlist read is the other half of the same live state, and an unreadable one
 * must reach the CLI's exit 2 ("could not read live state") rather than a diagnosable exit 1.
 */
export function classifySsmReadFailure(stderr: string | undefined | null): ImageProbeFailure {
  return /ParameterNotFound/i.test(stderr ?? '') ? 'absent' : 'unreadable';
}
