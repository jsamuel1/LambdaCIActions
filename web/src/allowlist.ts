/**
 * Runner-label allowlist comparison, re-exported for the console.
 *
 * The comparison itself lives in `src/shared/allowlist.ts` — one pure module — so the
 * case/order/duplicate-insensitive semantics the claim gate actually applies are unit-tested once
 * against `dist/` (`test/refusal.test.mjs`) instead of being reimplemented inside a React
 * component where they cannot be tested. esbuild bundles it into the SPA; nothing AWS-shaped is
 * reachable from it.
 *
 * Same convention as `rollup.ts`: the SPA reaches into `src/` through a barrel in `web/src/`, never
 * with a deep relative path from a screen, so the whole console→API boundary is auditable from two
 * files.
 */
export { allowlistChanged } from '../../src/shared/allowlist.js';
