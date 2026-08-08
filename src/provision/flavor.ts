import {
  builtinFlavors,
  composeCatalog,
  isCustomFlavorLabel,
  isCustomFlavorName,
  type CatalogFlavor,
} from '../shared/flavor-catalog.js';
import { adoptFlavorForLabel } from '../ingest/adopt.js';
import type { RepoMode } from '../shared/types.js';

/**
 * `runs-on` → flavor routing (spec 03 § routing).
 *
 * Resolution order (first match wins):
 *   1. Repo FlavorMap override (DynamoDB)   — explicit `label → flavor`.
 *   2. Explicit LCA label                   — `lambda-ci`, `lambda-ci-node`, `lambda-ci-docker`,
 *                                             `lambda-ci-python`, `lambda-ci-java`,
 *                                             `lambda-ci-go`, `lambda-ci-rust`
 *                                             (most-specific label wins; equally specific
 *                                             labels break the tie by flavor name — see
 *                                             `explicitLabelMatch`).
 *   3. Adopt-mode standard-label map        — `ubuntu-latest` & friends → `base` (M5, ADR-030).
 *                                             Only consulted when the repo is in `adopt` mode.
 *                                             Deliberately BELOW step 2: an adopt-mode job that
 *                                             also carries an explicit LCA label asked for that
 *                                             flavor, and above the fallback, which is the whole
 *                                             point of adopt mode.
 *   4. Signal-based upgrade                 — if the job needs a capability the resolved flavor
 *                                             lacks (e.g. Docker), upgrade to the smallest flavor
 *                                             that provides it. This REPLACES the flavor, so a
 *                                             language toolchain is lost — the reason names it and
 *                                             `compat` warns (`toolchain-dropped`). Applied to the
 *                                             winner of steps 1/2/3/5 alike, not just to a label
 *                                             match (see `applySignalUpgrade`).
 *   5. Fallback                             — the repo's operator-chosen `defaultFlavor`
 *                                             (console, spec 04) if set, else `base`; record a
 *                                             warning reason.
 *
 * Kept pure (no AWS calls) so it is trivially testable; wiring into ingest/provision (supplying
 * the per-repo FlavorMap + job signals) is done by the caller.
 *
 * ## Custom flavors (ADR-040/041)
 *
 * An installation's own `custom-*` flavors are composed OVER the built-in catalog by the caller
 * and passed in as `opts.customFlavors`. Three properties this module is responsible for:
 *
 *   1. **No behavior change when none are registered.** With `customFlavors` absent or empty the
 *      composed catalog is the built-in array itself, so every resolution below is byte-identical
 *      to the pre-ADR-040 code. This module never reads the store — the caller decides whether a
 *      read is even needed (`needsCustomFlavors`).
 *   2. **A custom label cannot reroute a built-in label.** The tie-break is longest-label-then-
 *      flavor-name-ascending and is independent of catalog ORDER, so appending custom entries
 *      cannot change which built-in wins. `lambda-ci-custom-*` is also strictly longer than every
 *      built-in label, so it only ever wins when it was named explicitly.
 *   3. **A signal upgrade never upgrades INTO a custom flavor.** See `smallestWithCapability`.
 */

export interface FlavorDef {
  name: string;
  label: string;
  arch: string;
  /**
   * DESCRIPTIVE only — the GA `lambda-microvms` API exposes no vCPU request (ADR-038).
   * Indicates the shape a flavor is intended for, and acts as the primary sort key when
   * picking the smallest flavor with a capability. Never present this as provisioned capacity.
   */
  vcpu: number;
  /** Requested at image-build time as `--resources minimumMemoryInMiB` (ADR-038). */
  memoryMb: number;
  capabilities: string[];
  /**
   * Extra guest OS capabilities requested at image-build time (ADR-020). Only `ALL` is
   * accepted by the GA `lambda-microvms` API today; scoped to docker-capable flavors so
   * `base`/`node` stay unprivileged. Consumed by `scripts/build-images.mjs`.
   */
  osCapabilities?: string[];
  description: string;
}

const FLAVORS: readonly FlavorDef[] = builtinFlavors();
const DEFAULT_FLAVOR = 'base';

/**
 * Compile-time proof that `FlavorDef` and the catalog seam's `CatalogFlavor` stay the same shape.
 *
 * `FlavorDef` is declared in full above rather than aliased to `CatalogFlavor` because
 * `test/image-content.test.mjs` asserts, by reading this file's TEXT, that every key present in
 * `microvm/flavors.json` appears in the `FlavorDef` declaration — an alias would satisfy the
 * type checker while letting a newly added catalog key silently bypass the routing type. These
 * two assignments make the duplication safe: if either type gains or loses a field, this file
 * stops compiling.
 */
const _flavorDefIsCatalogFlavor: CatalogFlavor = undefined as unknown as FlavorDef;
const _catalogFlavorIsFlavorDef: FlavorDef = undefined as unknown as CatalogFlavor;
void _flavorDefIsCatalogFlavor;
void _catalogFlavorIsFlavorDef;

/**
 * The closed capability vocabulary (ADR-041 static gate). Capabilities are not free-form
 * strings: they drive `smallestWithCapability` upgrades here and the `docker-missing` compat
 * message in `src/ingest/compat.ts`, so an unrecognized capability would be silently inert.
 * Registering a custom flavor validates against this list; adding a capability means teaching
 * the resolver and/or the compat gate what it means.
 */
export const KNOWN_CAPABILITIES: readonly string[] = [
  'docker',
  'node',
  'python',
  'java',
  'go',
  'rust',
];

/** True when every capability in `caps` is drawn from the known vocabulary. */
export function areCapabilitiesKnown(caps: readonly string[]): boolean {
  return caps.every((c) => KNOWN_CAPABILITIES.includes(c));
}

/**
 * Every BUILT-IN flavor (read-only view; the JSON is compiled in at build time).
 *
 * Deliberately built-in-only: custom flavors are per-installation (ADR-040), so there is no
 * single global answer to "every flavor" and a caller that wants one is asking the wrong
 * question. Installation-scoped consumers compose via `composeCatalog`/`effectiveFlavors`.
 */
export function allFlavors(): readonly FlavorDef[] {
  return FLAVORS;
}

/**
 * The catalog an installation actually sees: `builtin ++ custom` (ADR-040).
 *
 * Returns the built-in array itself when there are no custom flavors — no copy, no re-sort.
 */
export function effectiveFlavors(
  customFlavors?: readonly CatalogFlavor[],
): readonly FlavorDef[] {
  return composeCatalog(customFlavors);
}

/** Signals extracted from a job (spec 03 § parsing model → step_signals). */
export interface JobSignals {
  /** Job needs Docker (docker/* actions, `container:`, `services:`, DinD). */
  needs_docker?: boolean;
}

/** Per-repo explicit `label → flavor name` override map (spec 03 step 1). */
export type FlavorMap = Record<string, string>;

export interface ResolveOptions {
  /** Per-repo FlavorMap override (highest precedence). */
  flavorMap?: FlavorMap;
  /**
   * The installation's ROUTABLE custom flavors (ADR-040/041) — i.e. only those whose validation
   * state is `valid`. Composed over the built-in catalog for this resolution only.
   *
   * The caller is responsible for the routability filter (`routableCustomFlavors`); passing an
   * unvalidated flavor here would route jobs at an image nothing has executed, which is the
   * failure ADR-041 exists to prevent. Absent/empty ⇒ built-in catalog, byte-identical behavior.
   */
  customFlavors?: readonly CatalogFlavor[];
  /**
   * Per-repo operator-chosen fallback flavor (console `defaultFlavor`, spec 04). Used
   * instead of the catalog `base` when no map entry / explicit label matched. Ignored when
   * it does not name a catalog flavor.
   */
  defaultFlavor?: string;
  /** Signals derived from the job's steps (drive signal-based upgrade). */
  signals?: JobSignals;
  /**
   * The repo's onboarding mode (spec 03). When `'adopt'`, standard GitHub-hosted labels
   * (`ubuntu-latest`, …) resolve through the adopt map (step 3). Any other value leaves
   * those labels unmatched, so they fall through to the `defaultFlavor`/`base` fallback —
   * which is what `label` mode wants, since such a job was only claimed because it ALSO
   * carried an LCA label.
   */
  mode?: RepoMode;
}

export interface FlavorResolution {
  /** Resolved flavor name (always a valid catalog flavor; falls back to `base`). */
  flavor: string;
  /** Human-readable reason describing which rule matched. */
  reason: string;
  /**
   * The flavor selected BEFORE a signal upgrade replaced it, when one did (step 4). Absent
   * when no upgrade happened.
   *
   * Load-bearing for `compat`: the upgrade is a REPLACEMENT (flavors carry one toolchain
   * each, ADR-039), and `compat` can only re-derive what was requested from `runs_on` labels.
   * That misses every selection made WITHOUT a catalog label — a FlavorMap entry
   * (`ubuntu-latest → python`) or the repo's `defaultFlavor` — so a `services:` job on either
   * of those paths silently lost its toolchain with no `toolchain-dropped` warning. Carrying
   * the pre-upgrade name makes the loss visible regardless of which rule selected it.
   */
  replaced?: string;
  /**
   * A `custom-*` flavor this job explicitly NAMED that is not in the composed catalog — because it
   * was deleted, or its validation lapsed from `valid`, between the claim and this resolution.
   *
   * Load-bearing for the provisioner, which must REFUSE such a job rather than launch it. Without
   * this the fall-through is silent and actively dangerous: resolution lands on `base`, that name
   * resolves to a perfectly good built-in image ARN in SSM, and the JIT runner still advertises the
   * original `lambda-ci-custom-*` label from the claim — so GitHub assigns the job and it SUCCEEDS
   * on an image the workflow never asked for.
   *
   * Absent whenever no custom flavor was named, so a job that never mentions one is unaffected.
   * Also absent when the repo's FlavorMap explicitly remaps the custom label onto a flavor that
   * does exist — that is an operator override, not a silent substitution.
   */
  unresolvedCustom?: string;
}

function byName(catalog: readonly FlavorDef[], name: string): FlavorDef | undefined {
  return catalog.find((f) => f.name === name);
}

/**
 * A `custom-*` flavor THIS job named that the composed catalog does not contain.
 *
 * "Named" is deliberately narrow — only routes this job could actually have taken:
 *   - a `lambda-ci-custom-*` label on the job itself, and
 *   - a FlavorMap entry keyed by one of THIS job's labels whose value is a `custom-*` name.
 *
 * `defaultFlavor` is handled at the fallback instead, because a custom default is only a request
 * when no other rule matched; treating it as one unconditionally would refuse jobs that
 * legitimately resolved through an explicit built-in label.
 *
 * The FlavorMap gets the same treatment from the other direction: a custom LABEL that the map
 * explicitly redefines is not an unresolved request, because the map is resolution step 1 — the
 * HIGHEST-precedence rule — and an operator writing `lambda-ci-custom-gpu → node` has stated what
 * that label means for this repo. Refusing it anyway would veto the override that resolution just
 * honored, and it would break the obvious operator workaround: pinning a custom label to a
 * known-good built-in while the custom image is invalid or being re-validated. The refusal exists
 * for a SILENT fall-through onto an image the workflow never asked for; an explicit remap is the
 * opposite of silent. Suppression is per-label, so a custom label with no map entry of its own is
 * still refused even when some other label on the job is mapped.
 *
 * Pure, and undefined whenever no custom flavor is named — which is what keeps the
 * zero-custom-flavor path byte-identical.
 */
function unresolvedNamedCustom(
  catalog: readonly FlavorDef[],
  lower: readonly string[],
  opts: ResolveOptions,
): string | undefined {
  const mapLower = opts.flavorMap
    ? new Map(Object.entries(opts.flavorMap).map(([k, v]) => [k.toLowerCase(), v]))
    : undefined;
  const remappedToCatalogFlavor = (label: string): boolean => {
    const mapped = mapLower?.get(label);
    return mapped !== undefined && byName(catalog, mapped) !== undefined;
  };
  for (const label of lower) {
    if (
      isCustomFlavorLabel(label) &&
      !catalog.some((f) => f.label.toLowerCase() === label) &&
      !remappedToCatalogFlavor(label)
    ) {
      return label;
    }
  }
  if (mapLower) {
    for (const label of lower) {
      const mapped = mapLower.get(label);
      if (mapped && isCustomFlavorName(mapped) && !byName(catalog, mapped)) return mapped;
    }
  }
  return undefined;
}

/**
 * Whether resolving THIS job could possibly need the installation's custom flavors.
 *
 * ADR-040 requires that an installation with no custom flavors sees byte-identical behavior and
 * **no I/O**. The provisioner cannot know whether rows exist without reading, so the gate is the
 * other way round: it asks whether a custom flavor could win at all. A custom flavor is only ever
 * reachable by being NAMED — a `lambda-ci-custom-*` label on the job, a FlavorMap value in the
 * `custom-*` namespace, or a `custom-*` defaultFlavor — because signal upgrades never target
 * custom flavors and adopt-mode maps only to built-ins. If none of those are present, the read is
 * skipped entirely.
 *
 * Pure, and derived from the same namespace predicates the store uses, so a job that never
 * mentions a custom flavor costs exactly what it did before ADR-040.
 */
export function needsCustomFlavors(
  labels: readonly string[] | undefined,
  opts: Pick<ResolveOptions, 'flavorMap' | 'defaultFlavor'> = {},
): boolean {
  if (labels?.some((l) => isCustomFlavorLabel(l))) return true;
  if (opts.flavorMap && Object.values(opts.flavorMap).some((v) => isCustomFlavorName(v))) {
    return true;
  }
  return isCustomFlavorName(opts.defaultFlavor);
}

/**
 * Resolve the winning catalog flavor for a job's (lower-cased) `runs-on` labels.
 *
 * "Most specific wins" was a length comparison while the catalog held exactly one
 * `lambda-ci-<name>` label per length. With the expanded standard set (ADR-039) that is no
 * longer true: `lambda-ci-python` and `lambda-ci-docker` are both 16 characters, and
 * `lambda-ci-node`/`-java`/`-rust` are all 14. A pure length sort leaves those ties to
 * `Array#sort` stability, i.e. to the ORDER OF ENTRIES IN `flavors.json` — so
 * `runs-on: [self-hosted, lambda-ci-python, lambda-ci-docker]` routed to `python` only
 * because `python` happens to be listed before `docker`, and reordering the catalog (or
 * inserting a flavor) would silently re-route live jobs.
 *
 * So the tie-break is explicit and catalog-order-independent: longest label first, then
 * flavor NAME ascending. That also lands the safer side of the one collision that matters
 * today — a job labelled both `lambda-ci-python` and `lambda-ci-docker` gets `docker`, where
 * a missing daemon fails loudly at the first `docker` step, rather than `python`, where the
 * job's docker steps die with a socket error the labels said should work.
 *
 * Returns the match plus every equally specific label that also matched, so the caller can
 * record the ambiguity in the resolution reason instead of hiding it.
 */
function explicitLabelMatch(
  catalog: readonly FlavorDef[],
  lower: string[],
): { def: FlavorDef; ambiguousWith: string[] } | undefined {
  const matches = catalog.filter((f) => lower.includes(f.label.toLowerCase())).sort(
    (a, b) => b.label.length - a.label.length || a.name.localeCompare(b.name),
  );
  if (matches.length === 0) return undefined;
  const [def] = matches;
  const ambiguousWith = matches
    .slice(1)
    .filter((f) => f.label.length === def.label.length)
    .map((f) => f.label);
  return { def, ambiguousWith };
}

/**
 * Smallest (by vcpu, then memory) BUILT-IN flavor that advertises the given capability.
 *
 * Built-in-only on purpose (ADR-040/041). A signal upgrade is an implicit decision the job never
 * asked for: `runs-on: [self-hosted, lambda-ci]` plus a `services:` block silently becomes
 * `docker`. If custom flavors competed here, registering a small docker-capable `custom-*` image
 * would silently capture every docker-signal job in the installation — including jobs that named
 * a BUILT-IN label — and route them at an operator image on the strength of a `vcpu` number.
 * Custom flavors stay reachable only by being named explicitly.
 *
 * A job that genuinely wants a custom docker image says so with its label, a FlavorMap entry, or
 * `defaultFlavor`; because that flavor already advertises `docker`, no upgrade fires and the
 * explicit choice survives.
 */
function smallestWithCapability(cap: string): FlavorDef | undefined {
  return [...FLAVORS]
    .filter((f) => f.capabilities.includes(cap))
    .sort((a, b) => a.vcpu - b.vcpu || a.memoryMb - b.memoryMb)[0];
}

/**
 * Apply signal-based upgrade (resolution step 4): if the resolved flavor lacks a
 * capability the job needs, upgrade to the smallest flavor that provides it.
 */
function applySignalUpgrade(
  catalog: readonly FlavorDef[],
  current: FlavorResolution,
  signals?: JobSignals,
): FlavorResolution {
  if (!signals?.needs_docker) return current;
  const def = byName(catalog, current.flavor);
  if (def?.capabilities.includes('docker')) return current;
  const upgraded = smallestWithCapability('docker');
  if (!upgraded) return current;
  // The upgrade is a REPLACEMENT, not an addition: flavors are one-toolchain-per-image
  // (ADR-039), so upgrading `python` → `docker` for a `services:` block hands the job an
  // image with a daemon and NO Python. Name the capabilities the swap drops, so the reason
  // on the Repo detail screen and in the provision log says what happened instead of
  // presenting the upgrade as pure gain. `compat` raises the matching warning.
  const lost = (def?.capabilities ?? []).filter((c) => !upgraded.capabilities.includes(c));
  const lostNote = lost.length
    ? ` (drops ${lost.map((c) => `'${c}'`).join(', ')} — flavors carry one toolchain each)`
    : '';
  return {
    flavor: upgraded.name,
    reason: `${current.reason}; upgraded to '${upgraded.name}' for docker capability${lostNote}`,
    // Record what was replaced so `compat` can warn even when no catalog LABEL named it
    // (FlavorMap / defaultFlavor selections carry no `lambda-ci-<lang>` label to re-derive from).
    replaced: current.flavor,
  };
}

/**
 * Resolve a job's `runs-on` labels (plus optional per-repo overrides + signals) to a flavor.
 * Returns the resolved flavor name and a reason. Pure — no I/O.
 */
export function resolveFlavor(labels: string[], opts: ResolveOptions = {}): FlavorResolution {
  const lower = labels.map((l) => l.toLowerCase());
  // `builtin ++ custom` for this resolution only; the built-in array itself when none.
  const catalog = effectiveFlavors(opts.customFlavors);

  // Computed BEFORE the rules, because it must be reported no matter which rule ends up winning:
  // a job naming an absent custom flavor may still match a built-in label and resolve "fine",
  // and that silent substitution is exactly what the provisioner has to refuse.
  const unresolvedCustom = unresolvedNamedCustom(catalog, lower, opts);
  const stamp = (r: FlavorResolution): FlavorResolution =>
    unresolvedCustom ? { ...r, unresolvedCustom } : r;

  // 1. Repo FlavorMap override — explicit label → flavor. Case-insensitive on the label key.
  if (opts.flavorMap) {
    const mapLower = new Map(
      Object.entries(opts.flavorMap).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const label of lower) {
      const mapped = mapLower.get(label);
      if (mapped && byName(catalog, mapped)) {
        return stamp(
          applySignalUpgrade(
            catalog,
            { flavor: mapped, reason: `FlavorMap override: '${label}' → '${mapped}'` },
            opts.signals,
          ),
        );
      }
    }
  }

  // 2. Explicit LCA label — prefer the most specific (longest) matching label, breaking
  //    equal-length ties by flavor name so the outcome never depends on catalog order.
  const explicit = explicitLabelMatch(catalog, lower);
  if (explicit) {
    const ambiguity = explicit.ambiguousWith.length
      ? ` (equally specific label(s) ${explicit.ambiguousWith
          .map((l) => `'${l}'`)
          .join(', ')} also present; resolved by flavor name)`
      : '';
    return stamp(
      applySignalUpgrade(
        catalog,
        {
          flavor: explicit.def.name,
          reason: `explicit LCA label '${explicit.def.label}'${ambiguity}`,
        },
        opts.signals,
      ),
    );
  }

  // 3. Adopt-mode standard-label map (M5, ADR-030) — only when the repo opted into adopt.
  if (opts.mode === 'adopt') {
    for (const label of lower) {
      const mapped = adoptFlavorForLabel(label);
      if (mapped && byName(catalog, mapped)) {
        return stamp(
          applySignalUpgrade(
            catalog,
            { flavor: mapped, reason: `adopt-mode standard label '${label}' → '${mapped}'` },
            opts.signals,
          ),
        );
      }
    }
  }

  // 5. Fallback — the repo's operator-chosen defaultFlavor if set + valid, else base;
  //    record a warning. Signal upgrade still applies (e.g. docker needed).
  const repoDefault =
    opts.defaultFlavor && byName(catalog, opts.defaultFlavor) ? opts.defaultFlavor : undefined;
  // A custom `defaultFlavor` only counts as a request once we are actually taking the fallback —
  // above this point some other rule matched and the default was never consulted.
  const unresolvedDefault =
    !repoDefault && isCustomFlavorName(opts.defaultFlavor) ? opts.defaultFlavor : undefined;
  const fallback = applySignalUpgrade(
    catalog,
    repoDefault
      ? { flavor: repoDefault, reason: `fallback to repo defaultFlavor '${repoDefault}' (no matching label)` }
      : { flavor: DEFAULT_FLAVOR, reason: 'fallback to base (no matching label)' },
    opts.signals,
  );
  const unresolved = unresolvedCustom ?? unresolvedDefault;
  return unresolved ? { ...fallback, unresolvedCustom: unresolved } : fallback;
}
