import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };

/**
 * The flavor catalog seam (ADR-040).
 *
 * This is the ONLY module that imports `microvm/flavors.json` at runtime. Before ADR-040 the
 * JSON was imported statically in five places (`src/provision/flavor.ts`, `src/mgmt/views.ts`,
 * `src/ingest/compat.ts`, `src/mgmt/rewrite.ts`, `src/shared/flavor-reconcile.ts`); composing
 * `builtin ++ custom` in five places would have given five chances to disagree about what a
 * flavor is. Everything that needs the catalog now derives it from here.
 *
 * The JSON stays **read-only and build-time**: it is compiled into each Lambda bundle, so it is
 * physically not writable at runtime. Custom flavors live in the store
 * (`src/shared/flavor-store.ts`) and are COMPOSED over the built-ins by the pure functions
 * below — this module performs no I/O of any kind, so the composition rules are unit-testable
 * without DynamoDB.
 *
 * ## Precedence (ADR-040)
 * Built-ins always win a name collision, and a colliding custom flavor is refused at
 * registration rather than silently shadowing (or being shadowed by) a built-in. `composeCatalog`
 * therefore drops a colliding custom row defensively — a row that predates the registration
 * check, or one written by a future bug, must not be able to redefine `lambda-ci-node`.
 *
 * ## Routability (ADR-041)
 * Only `valid` custom flavors are composed. A `pending` / `validating` / `invalid` flavor is
 * omitted entirely, so it resolves as if it did not exist and the job falls through the normal
 * chain instead of launching an unproven image.
 */

/** A flavor as the routing/pricing/compat layers see it. */
export interface CatalogFlavor {
  name: string;
  label: string;
  arch: string;
  /**
   * DESCRIPTIVE only — the GA `lambda-microvms` API exposes no vCPU request (ADR-038).
   * Never present this as provisioned capacity.
   */
  vcpu: number;
  /** Requested at image-build time as `--resources minimumMemoryInMiB` (ADR-038). */
  memoryMb: number;
  capabilities: string[];
  /** Extra guest OS capabilities requested at image-build time (ADR-020). */
  osCapabilities?: string[];
  description: string;
  /**
   * True for a store-backed custom flavor (ADR-040). Absent/false for a built-in.
   *
   * Load-bearing rather than cosmetic: `applySignalUpgrade` will not upgrade INTO a custom
   * flavor (see `smallestWithCapability` in `src/provision/flavor.ts`), and the console labels
   * the row's provenance. A caller that needs "is this operator-supplied?" must read this
   * instead of string-matching the name prefix.
   */
  custom?: boolean;
  /** The installation that owns a custom flavor. Absent for a built-in. */
  installationId?: number;
}

/** Namespace prefix for a custom flavor's NAME (ADR-040). */
export const CUSTOM_FLAVOR_PREFIX = 'custom-';
/** Namespace prefix for a custom flavor's runner LABEL (ADR-040). */
export const CUSTOM_LABEL_PREFIX = 'lambda-ci-custom-';

/**
 * Max length of the operator-chosen part of a custom flavor name. Bounds the sort key, the
 * runner label (GitHub caps a label at 256 chars) and the SSM parameter name derived from it.
 */
export const MAX_CUSTOM_FLAVOR_BASE_LENGTH = 32;

/** The built-in catalog (read-only; compiled in at build time). */
export function builtinFlavors(): readonly CatalogFlavor[] {
  return (flavorsCatalog as { flavors: CatalogFlavor[] }).flavors;
}

/** `custom-<base>` — the flavor name stored and routed. */
export function customFlavorName(base: string): string {
  return `${CUSTOM_FLAVOR_PREFIX}${base}`;
}

/** `lambda-ci-custom-<base>` — the runner label that selects a custom flavor. */
export function customFlavorLabel(base: string): string {
  return `${CUSTOM_LABEL_PREFIX}${base}`;
}

/** Whether a flavor NAME is in the custom namespace. */
export function isCustomFlavorName(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith(CUSTOM_FLAVOR_PREFIX);
}

/** Whether a runner LABEL is in the custom namespace (case-insensitive). */
export function isCustomFlavorLabel(label: string | undefined): boolean {
  return typeof label === 'string' && label.trim().toLowerCase().startsWith(CUSTOM_LABEL_PREFIX);
}

/**
 * Validate the operator-chosen part of a custom flavor name.
 *
 * Deliberately narrow: the base name becomes a DynamoDB sort key (`FLAVOR#custom-<base>`), a
 * GitHub runner label, and an SSM parameter name segment. A permissive name would be three
 * injection surfaces rather than one identifier.
 */
export function customFlavorBaseNameError(base: unknown): string | undefined {
  if (typeof base !== 'string' || base.length === 0) return 'name is required';
  if (base.length > MAX_CUSTOM_FLAVOR_BASE_LENGTH) {
    return `name is longer than ${MAX_CUSTOM_FLAVOR_BASE_LENGTH} characters`;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(base)) {
    return 'name must be lower-case alphanumeric with internal hyphens only (e.g. "gpu-builder")';
  }
  if (base.includes('--')) return 'name must not contain consecutive hyphens';
  // An operator writing `custom-foo` in the name field means `foo`; accepting it verbatim would
  // produce `custom-custom-foo` and a label nobody would guess.
  if (base.startsWith(CUSTOM_FLAVOR_PREFIX)) {
    return `name must not repeat the '${CUSTOM_FLAVOR_PREFIX}' prefix — it is added automatically`;
  }
  return undefined;
}

/**
 * Whether a composed custom flavor collides with a built-in (ADR-040 registration refusal).
 *
 * Derived from the catalog, never a hard-coded list, so the standard set growing from 3 to 7
 * flavors (ADR-039) — or to 8 — cannot leave this check behind. Compares BOTH the name and the
 * label: a custom flavor that reused a built-in label would reroute that label's jobs even
 * though its name differed, which is the same failure the name check exists to prevent.
 */
export function builtinCollision(
  name: string,
  label: string,
  builtin: readonly CatalogFlavor[] = builtinFlavors(),
): { field: 'name' | 'label'; collidesWith: string } | undefined {
  const lowerLabel = label.trim().toLowerCase();
  for (const f of builtin) {
    if (f.name === name) return { field: 'name', collidesWith: f.name };
    if (f.label.toLowerCase() === lowerLabel) return { field: 'label', collidesWith: f.name };
  }
  return undefined;
}

/**
 * Compose the effective catalog for an installation: `builtin ++ custom`.
 *
 * Pure and total. Custom rows that would collide with a built-in name/label are dropped (see
 * the precedence note above) — registration refuses them, and this is the defence in depth for
 * a row that got in anyway.
 *
 * Passing `[]`/`undefined` returns the built-in array ITSELF (same reference), which is the
 * ADR-040 "byte-identical when no custom flavors are registered" requirement expressed in code:
 * no copy, no re-sort, no allocation.
 */
export function composeCatalog(
  custom?: readonly CatalogFlavor[],
): readonly CatalogFlavor[] {
  const builtin = builtinFlavors();
  if (!custom || custom.length === 0) return builtin;
  const seenNames = new Set(builtin.map((f) => f.name));
  const seenLabels = new Set(builtin.map((f) => f.label.toLowerCase()));
  const out: CatalogFlavor[] = [...builtin];
  for (const f of custom) {
    if (seenNames.has(f.name) || seenLabels.has(f.label.toLowerCase())) continue;
    seenNames.add(f.name);
    seenLabels.add(f.label.toLowerCase());
    out.push({ ...f, custom: true });
  }
  return out;
}

/**
 * Every runner label that must be present in `/lca/<env>/config/runner-labels` for the BUILT-IN
 * catalog to be reachable.
 *
 * Ingest's claim gate (`shouldClaim` → `decideClaim`) runs BEFORE flavor resolution and only
 * accepts labels on that allowlist, so a label absent from it produces a successful webhook
 * response with `claimed:false` and a job that stays queued with no actionable error.
 *
 * ## What consumes this, precisely
 *
 * Nothing in `src/` calls it today, and that is worth stating rather than implying otherwise. The
 * operator-facing seed regression (`test/filter.test.mjs`) derives its expected label set by
 * reading `microvm/flavors.json` directly, and the built-in half of the live claim allowlist is
 * written by `scripts/build-images.mjs` one label at a time, after each image verifies (ADR-049) —
 * neither goes through a whole-catalog derivation. This function exists as the ONE place that
 * answers "which labels must be claimable for this catalog to be reachable", for a caller that
 * needs the composed set (a console health/reconciliation view), and it is tested directly so the
 * answer is a contract rather than an assumption.
 *
 * ## Why custom labels are NOT put in that parameter (ADR-040)
 *
 * The parameter is ENVIRONMENT-scoped; a custom flavor is per-installation. Adding
 * `lambda-ci-custom-gpu` here would make installation A's label claimable for installation B's
 * jobs, and B's resolution would find no such flavor and fall through to `base` — so B's job would
 * be claimed and run on the wrong image, having already given up the GitHub-hosted fallback.
 *
 * `src/ingest/handler.ts` therefore resolves custom labels against the JOB'S OWN installation at
 * claim time (`claimLabelsWithCustom`), gated on the job actually carrying a `lambda-ci-custom-*`
 * label so an installation with no custom flavors performs no extra I/O. A custom label is
 * claimable exactly where it is resolvable, and only while its flavor is `valid`.
 *
 * The optional `custom` argument is retained for callers that want the composed label set (e.g. a
 * console health view), NOT for seeding the parameter. Only `valid` flavors contribute, because
 * `composeCatalog` only admits valid ones: advertising an unproven flavor's label would convert a
 * silently-queued job into a CLAIMED job that then fails in provisioning — strictly worse, because
 * a claimed job can no longer fall back to GitHub-hosted.
 */
export function requiredClaimLabels(custom?: readonly CatalogFlavor[]): string[] {
  return composeCatalog(custom).map((f) => f.label);
}
