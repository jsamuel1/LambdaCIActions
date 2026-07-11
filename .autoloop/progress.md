# Progress

## Completed milestones
- **M1** — Spike: one microVM runs one job. Merged `f88a504` (#3). Do not redo.
- **M2** — Robust control plane (state machine, reaper, DLQ, install lifecycle). Merged `225fc18` (#4). Do not redo.

## Current milestone
**M3 — Flavors & ingestion** (plan step 1).

## Active slice — DONE (builder, awaiting review)
**M3-S1: Flavor catalog + routing resolution (pure, testable).**
- Expanded `microvm/flavors.json`: `base` (caps `[]`) + `node` (`lambda-ci-node`, caps `[node]`) +
  `docker` (`lambda-ci-docker`, caps `[docker]`, 4 vcpu/8GB). All arm64.
- Rewrote `src/provision/flavor.ts` `resolveFlavor(labels, opts?)` to return `{flavor, reason}` per
  spec-03 order: step 1 FlavorMap override → step 2 explicit LCA label (most-specific-wins) → step 3
  signal-based docker upgrade → step 4 fallback base. Adopt-mode standard-label map explicitly
  deferred to M5 (documented in a comment). `opts = { flavorMap?, signals?: { needs_docker? } }`.
- Updated `src/provision/handler.ts` to consume the new `{flavor, reason}` shape (logs the reason;
  no behaviour regression — same image-ARN lookup).
- Updated `test/flavor.test.mjs`: 15 cases — explicit base/node/docker labels, most-specific-wins,
  case-insensitivity, FlavorMap precedence + case-insensitive key + unknown-flavor guard,
  signal-based docker upgrade (base/node/fallback), docker-already-capable no-op, fallback→base.

**Verification:** full gate green — `npm run build` ✓, `node --test test/*.test.mjs` → 57 pass / 0 fail ✓,
`npx cdk synth` ✓. Every flavor stays arch=arm64.

**Original slice spec:**
- Expand `microvm/flavors.json` from `base`-only to `base` + `docker` + `node` (arm64, with
  capability metadata — e.g. `capabilities: ["docker"]` on the docker flavor, node toolchain on node).
- Rewrite `src/provision/flavor.ts` `resolveFlavor` into the spec-03 resolution order (steps 1–5),
  taking an optional per-repo FlavorMap override + adopt flag, returning `{ flavor, reason }`.
- Add signal-based upgrade hook (labels/signals that require docker → upgrade to a docker-capable flavor).
- Unit tests in `test/flavor.test.mjs` covering: explicit LCA labels (base/docker/node),
  FlavorMap override precedence, signal-based docker upgrade, and fallback→base.
- Keep it pure (no AWS calls) so it's trivially testable; wiring into ingest/provision comes in a later slice.

## Verification notes
- Gate: `npm ci && npm run build && npm test && npx cdk synth`.
- Slice-specific: `test/flavor.test.mjs` cases above must pass; `flavors.json` stays arm64-only.

## Relevant Issues
- (none yet)
