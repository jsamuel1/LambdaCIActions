/**
 * Runner-label allowlist comparison (ADR-050).
 *
 * A deliberate LEAF module: no imports, so the console can consume it without dragging
 * `src/mgmt/views.ts` and the flavor catalog into the browser bundle for a set comparison.
 *
 * Its only production caller is the Unclaimed screen (`web/src/screens/Unclaimed.tsx`), which is
 * where the comparison belongs: the Mgmt λ echoes the LIVE allowlist alongside each refusal's
 * stored snapshot and takes no view on whether they differ. It lives under `src/shared/` rather
 * than `web/src/` so the comparison is unit-testable off the built Lambda output like the rest of
 * the claim-gate logic, and so a future server-side consumer cannot fork it.
 */

/** Normalize an operator-edited label list the way the claim gate does. */
function normalize(labels: readonly string[]): Set<string> {
  return new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean));
}

/**
 * Whether the live allowlist differs from the snapshot taken when a job was refused.
 *
 * Case-, order- and duplicate-insensitive, to match the claim gate: `decideClaim` lower-cases both
 * the job labels and the allowlist before comparing, so `Lambda-CI-Node` and `lambda-ci-node` are
 * one entry as far as the platform is concerned. Comparing raw strings reported `config changed`
 * for an edit the gate cannot see, which sends the operator to re-run a job that is refused again
 * for exactly the same reason — the opposite of what the badge exists to tell them.
 *
 * `known: false` (the live read failed) yields `false`: an unread allowlist is not evidence that
 * anything changed.
 */
export function allowlistChanged(
  snapshot: readonly string[],
  live: readonly string[],
  known: boolean,
): boolean {
  if (!known) return false;
  const was = normalize(snapshot);
  const now = normalize(live);
  if (was.size !== now.size) return true;
  for (const l of was) if (!now.has(l)) return true;
  return false;
}
