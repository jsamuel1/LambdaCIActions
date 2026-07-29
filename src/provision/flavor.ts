import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };

/**
 * `runs-on` → flavor routing (spec 03 § routing).
 *
 * Resolution order (first match wins), per this slice (M3-S1):
 *   1. Repo FlavorMap override (DynamoDB)   — explicit `label → flavor`.
 *   2. Explicit LCA label                   — `lambda-ci`, `lambda-ci-node`, `lambda-ci-docker`,
 *                                             `lambda-ci-python`, `lambda-ci-java`,
 *                                             `lambda-ci-go`, `lambda-ci-rust`
 *                                             (most-specific label wins).
 *   3. Signal-based upgrade                 — if the job needs a capability the resolved flavor
 *                                             lacks (e.g. Docker), upgrade to the smallest flavor
 *                                             that provides it.
 *   4. Fallback                             — the repo's operator-chosen `defaultFlavor`
 *                                             (console, spec 04) if set, else `base`; record a
 *                                             warning reason.
 *
 * NOTE: the spec-03 **adopt-mode standard-label map** (mapping GitHub's `ubuntu-*` labels to
 * flavors for zero-YAML-edit onboarding) is intentionally deferred to **M5 — Drop-in & polish**.
 * It is not implemented here.
 *
 * Kept pure (no AWS calls) so it is trivially testable; wiring into ingest/provision (supplying
 * the per-repo FlavorMap + job signals) is done by the caller.
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

const FLAVORS: FlavorDef[] = (flavorsCatalog as { flavors: FlavorDef[] }).flavors;
const DEFAULT_FLAVOR = 'base';

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

/** Every flavor in the catalog (read-only view; the JSON is compiled in at build time). */
export function allFlavors(): readonly FlavorDef[] {
  return FLAVORS;
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
   * Per-repo operator-chosen fallback flavor (console `defaultFlavor`, spec 04). Used
   * instead of the catalog `base` when no map entry / explicit label matched. Ignored when
   * it does not name a catalog flavor.
   */
  defaultFlavor?: string;
  /** Signals derived from the job's steps (drive signal-based upgrade). */
  signals?: JobSignals;
}

export interface FlavorResolution {
  /** Resolved flavor name (always a valid catalog flavor; falls back to `base`). */
  flavor: string;
  /** Human-readable reason describing which rule matched. */
  reason: string;
}

function byName(name: string): FlavorDef | undefined {
  return FLAVORS.find((f) => f.name === name);
}

/** Smallest (by vcpu, then memory) flavor that advertises the given capability. */
function smallestWithCapability(cap: string): FlavorDef | undefined {
  return [...FLAVORS]
    .filter((f) => f.capabilities.includes(cap))
    .sort((a, b) => a.vcpu - b.vcpu || a.memoryMb - b.memoryMb)[0];
}

/**
 * Apply signal-based upgrade (resolution step 3): if the resolved flavor lacks a
 * capability the job needs, upgrade to the smallest flavor that provides it.
 */
function applySignalUpgrade(current: FlavorResolution, signals?: JobSignals): FlavorResolution {
  if (!signals?.needs_docker) return current;
  const def = byName(current.flavor);
  if (def?.capabilities.includes('docker')) return current;
  const upgraded = smallestWithCapability('docker');
  if (!upgraded) return current;
  return {
    flavor: upgraded.name,
    reason: `${current.reason}; upgraded to '${upgraded.name}' for docker capability`,
  };
}

/**
 * Resolve a job's `runs-on` labels (plus optional per-repo overrides + signals) to a flavor.
 * Returns the resolved flavor name and a reason. Pure — no I/O.
 */
export function resolveFlavor(labels: string[], opts: ResolveOptions = {}): FlavorResolution {
  const lower = labels.map((l) => l.toLowerCase());

  // 1. Repo FlavorMap override — explicit label → flavor. Case-insensitive on the label key.
  if (opts.flavorMap) {
    const mapLower = new Map(
      Object.entries(opts.flavorMap).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const label of lower) {
      const mapped = mapLower.get(label);
      if (mapped && byName(mapped)) {
        return applySignalUpgrade(
          { flavor: mapped, reason: `FlavorMap override: '${label}' → '${mapped}'` },
          opts.signals,
        );
      }
    }
  }

  // 2. Explicit LCA label — prefer the most specific (longest) matching label.
  const explicit = [...FLAVORS]
    .sort((a, b) => b.label.length - a.label.length)
    .find((f) => lower.includes(f.label.toLowerCase()));
  if (explicit) {
    return applySignalUpgrade(
      { flavor: explicit.name, reason: `explicit LCA label '${explicit.label}'` },
      opts.signals,
    );
  }

  // 4. Fallback — the repo's operator-chosen defaultFlavor if set + valid, else base;
  //    record a warning. Signal upgrade still applies (e.g. docker needed).
  const repoDefault = opts.defaultFlavor && byName(opts.defaultFlavor) ? opts.defaultFlavor : undefined;
  return applySignalUpgrade(
    repoDefault
      ? { flavor: repoDefault, reason: `fallback to repo defaultFlavor '${repoDefault}' (no matching label)` }
      : { flavor: DEFAULT_FLAVOR, reason: 'fallback to base (no matching label)' },
    opts.signals,
  );
}
