/**
 * Flavor readiness — reconciling the built-in catalog against the LIVE control plane (ADR-050).
 *
 * `microvm/flavors.json` describes what the platform CAN route. It says nothing about whether a
 * given deployment can actually run it, and the two diverge in practice: `lambda-ci-python` was
 * in the catalog, documented in the seed command, and rendered `eligible` with `compat: ok` in
 * the console — while the deployed `/lca/dev/config/runner-labels` held only
 * `lambda-ci,lambda-ci-node,lambda-ci-docker` and no `image-arn-python` parameter existed. The
 * console told the operator the job routed to `python` and was fine; the control plane could not
 * claim it and never would.
 *
 * Two independent live facts decide runnability, and each failure mode fails at a DIFFERENT
 * point in the pipeline:
 *   - **allowlist** (`/lca/<env>/config/runner-labels`) — consulted by Ingest's claim gate
 *     BEFORE routing. Missing ⇒ the job is never claimed and queues forever with no error.
 *   - **image** (`/lca/<env>/config/image-arn-<flavor>`) — read by Provision. Missing ⇒ the job
 *     IS claimed and then fails in provisioning, which at least produces a run row.
 *
 * This module is PURE: it takes the catalog plus two live snapshots and derives per-flavor state.
 * The reads live in the callers (the Mgmt λ over SSM; the CLI reconcile command), so the same
 * derivation serves the console and the command line and the two cannot disagree — one
 * classification, two front ends.
 *
 * Deliberately independent of `src/mgmt/views.ts` (`FlavorView`, rates, cost) so a flavor's
 * readiness can be composed alongside other per-flavor axes — e.g. a custom flavor's validation
 * state — without this module or those views having to know about each other.
 */

/** The catalog fields readiness needs. Structural, so any catalog shape satisfying it works. */
export interface ReadinessFlavor {
  name: string;
  label: string;
}

/**
 * Per-flavor readiness state, worst-first:
 *   - `unroutable` — label absent AND image absent. Nothing about this flavor works; a job
 *     naming its label is silently unclaimed (the SauhsojVideo failure).
 *   - `unclaimable` — image published but the label is not allowlisted: built capacity that can
 *     never be selected. A job naming the label still queues forever.
 *   - `imageMissing` — label allowlisted but no image ARN: the job IS claimed and then fails in
 *     provisioning. Louder than `unclaimable` for the user, cheaper to diagnose.
 *   - `ready` — both present. (Note the residual below: a published ARN is not proof the image
 *     itself still exists.)
 */
export type FlavorReadinessState = 'ready' | 'imageMissing' | 'unclaimable' | 'unroutable';

export interface FlavorReadiness {
  flavor: string;
  label: string;
  /** Whether the flavor's routing label is in the live claim allowlist. */
  labelAllowlisted: boolean;
  /** Whether an `image-arn-<flavor>` parameter is published for it. */
  imagePublished: boolean;
  state: FlavorReadinessState;
  /** True only for `ready` — i.e. a job routed here can actually be claimed AND launched. */
  runnable: boolean;
  /** Operator-facing statement of the problem; absent when `ready`. */
  problem?: string;
  /** Actionable remedy; absent when `ready`. */
  fix?: string;
}

/** The live control-plane snapshot readiness is derived against. */
export interface ControlPlaneSnapshot {
  /** `/lca/<env>/config/runner-labels`, split + trimmed. */
  allowlist: string[];
  /** `flavor name → an image-arn-<name> parameter exists`. */
  imagePublished: Record<string, boolean>;
  /**
   * False when a live read failed and the snapshot is therefore not evidence of anything. Every
   * consumer must degrade to "unknown" rather than rendering a flavor as broken because SSM was
   * briefly unavailable — a false alarm on this surface teaches operators to ignore it.
   */
  live: boolean;
}

function fixFor(
  state: FlavorReadinessState,
  f: ReadinessFlavor,
): { problem: string; fix: string } | undefined {
  switch (state) {
    case 'unroutable':
      return {
        problem: `'${f.label}' is not in the live runner-label allowlist and no image is published for '${f.name}'.`,
        fix:
          `Build and publish the image (npm run build:images -- --flavor ${f.name}), then add ` +
          `'${f.label}' to /lca/<env>/config/runner-labels. A job naming this label is silently ` +
          'left queued until BOTH exist.',
      };
    case 'unclaimable':
      return {
        problem: `An image is published for '${f.name}' but '${f.label}' is not in the live runner-label allowlist.`,
        fix:
          `Add '${f.label}' to /lca/<env>/config/runner-labels. Until then the claim gate refuses ` +
          'the job before routing runs, so it queues with no error.',
      };
    case 'imageMissing':
      return {
        problem: `'${f.label}' is allowlisted but no image-arn-${f.name} parameter is published.`,
        fix:
          `Build and publish the image (npm run build:images -- --flavor ${f.name}). Jobs are ` +
          'claimed today and then fail during provisioning.',
      };
    case 'ready':
    default:
      return undefined;
  }
}

/**
 * Derive per-flavor readiness from the catalog + a live snapshot.
 *
 * Label matching is case-insensitive, matching GitHub's label semantics and Ingest's own
 * comparison — an allowlist entry of `Lambda-CI-Node` claims `lambda-ci-node` jobs, so treating
 * it as a miss here would report a flavor broken that in fact works.
 */
export function reconcileFlavors(
  flavors: readonly ReadinessFlavor[],
  snapshot: ControlPlaneSnapshot,
): FlavorReadiness[] {
  const allowed = new Set(snapshot.allowlist.map((l) => l.trim().toLowerCase()).filter(Boolean));
  return flavors.map((f) => {
    const labelAllowlisted = allowed.has(f.label.trim().toLowerCase());
    const imagePublished = snapshot.imagePublished[f.name] === true;
    const state: FlavorReadinessState = labelAllowlisted
      ? imagePublished
        ? 'ready'
        : 'imageMissing'
      : imagePublished
        ? 'unclaimable'
        : 'unroutable';
    const detail = fixFor(state, f);
    return {
      flavor: f.name,
      label: f.label,
      labelAllowlisted,
      imagePublished,
      state,
      runnable: state === 'ready',
      ...(detail ?? {}),
    };
  });
}

/**
 * Allowlist entries that are NOT any catalog flavor's label.
 *
 * Not an error: adopt mode needs `ubuntu-latest` and friends in the allowlist, and an operator
 * may allowlist a custom label routed by a repo FlavorMap. Reported so a reconcile view can show
 * the whole allowlist rather than only the part the catalog explains — an entry here that looks
 * like a typo of a catalog label (`lambda-ci-pyton`) is exactly the kind of thing an operator
 * needs to SEE, and a catalog-only view hides it.
 */
export function unmatchedAllowlistLabels(
  flavors: readonly ReadinessFlavor[],
  allowlist: readonly string[],
): string[] {
  const known = new Set(flavors.map((f) => f.label.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of allowlist) {
    const l = raw.trim().toLowerCase();
    if (!l || known.has(l) || out.includes(l)) continue;
    out.push(l);
  }
  return out;
}

/**
 * Readiness for ONE flavor name — the lookup a routing display needs.
 *
 * `undefined` for a flavor absent from the catalog (a stored route naming a flavor this
 * deployment's catalog no longer has). The caller decides how to render that; silently treating
 * it as `ready` would recreate the misleading green this module exists to remove.
 */
export function readinessFor(
  readiness: readonly FlavorReadiness[],
  flavor: string | undefined,
): FlavorReadiness | undefined {
  if (!flavor) return undefined;
  return readiness.find((r) => r.flavor === flavor);
}

/** Worst-first ordering used when folding several flavors' readiness into one headline. */
const STATE_RANK: Record<FlavorReadinessState, number> = {
  ready: 0,
  imageMissing: 1,
  unclaimable: 2,
  unroutable: 3,
};

/** The worst state in a set — `ready` when the set is empty (nothing to complain about). */
export function worstState(states: readonly FlavorReadinessState[]): FlavorReadinessState {
  return states.reduce<FlavorReadinessState>(
    (worst, s) => (STATE_RANK[s] > STATE_RANK[worst] ? s : worst),
    'ready',
  );
}
