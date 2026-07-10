import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };

/**
 * Resolve a job's `runs-on` labels to a flavor name (spec 02 / spec 03 routing).
 *
 * M1 is single-flavor: any claimed job maps to the flavor whose label appears in the
 * job's labels, defaulting to `base`. Later milestones add the per-repo FlavorMap and
 * richer `runs-on` → flavor routing (M3).
 */
interface FlavorDef {
  name: string;
  label: string;
}
const FLAVORS: FlavorDef[] = (flavorsCatalog as { flavors: FlavorDef[] }).flavors;
const DEFAULT_FLAVOR = 'base';

export function resolveFlavor(labels: string[]): string {
  const lower = labels.map((l) => l.toLowerCase());
  // Prefer the most specific flavor label present (e.g. lambda-ci-docker over lambda-ci).
  const match = [...FLAVORS]
    .sort((a, b) => b.label.length - a.label.length)
    .find((f) => lower.includes(f.label.toLowerCase()));
  return match?.name ?? DEFAULT_FLAVOR;
}
