/**
 * Run-level rollup helpers, re-exported for the console.
 *
 * The fold rules live in `src/mgmt/run-rollup.ts` — one pure module shared by the API
 * package and the SPA — so the status fold, flavor rollup, duration totals and the
 * partial-window rule are unit-tested once against `dist/` (`test/run-rollup.test.mjs`)
 * instead of being reimplemented inside a React component where they cannot be tested.
 * esbuild bundles it into the SPA; nothing AWS-shaped is reachable from it.
 */
export {
  foldRunStatus,
  rollupFlavor,
  runDurations,
  windowComplete,
  groupRuns,
  runGroupKey,
  type RunGroup,
  type RunJobRow,
  type FlavorRollup,
  type RunDurations,
  type WindowShape,
} from '../../src/mgmt/run-rollup.js';
