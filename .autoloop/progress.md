# Progress

## Completed milestones
- **M1** — Spike: one microVM runs one job. Merged `f88a504` (#3). Do not redo.
- **M2** — Robust control plane (state machine, reaper, DLQ, install lifecycle). Merged `225fc18` (#4). Do not redo.

## Current milestone
**M3 — Flavors & ingestion** (plan step 1).

### Builder iteration 15 — DONE, awaiting review (`review.ready`)
**M3-S2: Workflow discovery + parser (pure, testable).** Commit `4f9e073` (LOCAL main, unpushed).

**What changed:**
- **`src/ingest/workflow-parser.ts` (NEW, pure — no network/AWS/fs):** `parseWorkflow(path,
  yamlText): ParsedWorkflow` producing the spec-03 normalized shape — `path`, `name`
  (`name:` or basename), `on` (string|array|map → `string[]`), and `jobs[]` each with `id`,
  `runs_on` (string|array|matrix-expr; unresolvable `${{...}}` preserved verbatim), `container`
  (string or `{image}` form → string|null), `services` (keys), `uses` (reusable ref|null),
  `matrix_dims` (static `strategy.matrix`, string-coerced, `include`/`exclude` ignored), and
  `step_signals` = `{ needs_docker, arch_hints, known_actions }`. `needs_docker` true on
  `container:`/`services:`/`docker/*` action `uses:`/`docker`|`docker-compose` in `run:`.
  No `route`/`compat` fields yet (that's M3-S3), keeping the surface minimal + honest.
- **`src/shared/types.ts`:** added `ParsedWorkflow`/`ParsedJob`/`StepSignals` interfaces +
  `WorkflowParseError` class (carries `path`, catchable by callers).
- **`package.json` + lockfile:** new runtime dep `js-yaml@5.2.1` (pinned exact). NOTE deviation
  from the slice's stated dep list: `@types/js-yaml` was NOT added — js-yaml 5.x ships its own
  bundled `.d.ts` and is ESM-named-exports-only (no default export), so the separate `@types`
  package (which targets the 4.x CommonJS API) would conflict, not help. Import is
  `import { load, YAMLException } from 'js-yaml'`.
- **`test/workflow-parser.test.mjs` (NEW):** 18 cases covering spec cases 1–11 (runs-on
  string/array, on: 3 forms, container 2 forms, services, docker action, docker run, matrix
  dims incl/excl ignored, matrix-expr preserved, reusable uses, malformed throw, no-jobs → [])
  plus arch-hints scan, empty-document, and non-mapping-root edge cases.

**Robustness / gotchas handled (js-yaml 5.x differs from 4.x):**
- 5.x uses YAML 1.2 `CORE_SCHEMA` — the bare key `on:` is NOT coerced to boolean `true`
  (verified empirically), so no `'true'`-key workaround is needed. Scalars like `18` stay
  numeric and are string-coerced in `matrix_dims`.
- 5.x `load('')` THROWS on empty input (4.x returned `undefined`). Guarded: whitespace-only
  file → empty workflow (`jobs: []`), not a `WorkflowParseError`.
- Malformed YAML / non-mapping root → `WorkflowParseError` (typed, catchable). No `any`
  leakage across the module boundary (internal `Unknown` record narrowing only).

**Verification (full gate, all green):**
- `npm ci` → clean install with pinned `js-yaml@5.2.1` (the 1 moderate audit finding is
  PRE-EXISTING esbuild GHSA-67mh-4wv8-2f99, dev-only, not from js-yaml — out of scope).
- `npm run build` (`tsc`) → clean, no errors.
- `node --test test/*.test.mjs` → **75 pass / 0 fail** (57 prior + 18 new).
- `npx cdk synth` → OK.
- No arch assumptions introduced; parser is arch-agnostic (arch_hints are best-effort detection only).

**Known risk / uncertainty:**
- `arch_hints` / `needs_docker` are heuristic substring/rules scans (best-effort per spec) —
  they intentionally don't parse `${{...}}` expressions or resolve dynamic matrices. Routing +
  compat wiring (M3-S3) will decide how much to trust them.
- js-yaml 5.x is a relatively new major; pinned exact to avoid surprise. If a reviewer prefers
  the more battle-tested 4.x line, that's a one-line dep change (would then re-add `@types/js-yaml`).

## Active slice — NEW (planner, iteration 14 → builder)
**M3-S2: Workflow discovery + parser (pure, testable).**
M3-S1 (flavor catalog + spec-03 routing resolution + Dockerfiles) is DONE + review.passed
(commits `e824f2e`, `2c08091`, `b8e4fa6` on LOCAL main, unpushed). M3-S2 is the next of the
4 M3 exit-criteria pieces: turn raw GitHub Actions workflow YAML into the normalized model
from spec 03 § Parsing model, extracting `runs-on` labels + capability signals. Keep it PURE
(no network / no AWS) so it's trivially unit-testable; discovery-over-the-network and wiring
into ingest/provision come in later M3 slices (M3-S3).

### Slice spec (M3-S2)
- **Add a YAML parser dependency:** `js-yaml` (pinned exact version) + `@types/js-yaml`
  (devDependency, pinned). `npm ci` must still pass. GitHub Actions workflows are YAML;
  hand-rolling a YAML parser is out of scope and error-prone. This is the one new runtime dep.
- **New pure module `src/ingest/workflow-parser.ts`:** export `parseWorkflow(path: string,
  yamlText: string): ParsedWorkflow` producing the spec-03 normalized shape:
  - `path`, `name` (from `name:` or basename), `on` (normalized to `string[]` — accept string,
    array, or map form `{ push: {...}, pull_request: {...} }` → keys).
  - `jobs[]`: each with `id`, `runs_on` (normalize string | array | matrix expr `${{...}}` to
    `string[]`, preserving the raw expr string when unresolvable), `container` (job.container.image
    or null; accept both string and `{ image }` object forms), `services` (keys of `job.services`),
    `uses` (reusable-workflow ref or null), `matrix_dims` (statically-resolvable `strategy.matrix`
    dims as `Record<string,string[]>`, excluding `include`/`exclude`), and `step_signals`.
  - `step_signals`: `{ needs_docker: boolean, arch_hints: string[], known_actions: string[] }`.
    Compute via a small rules table over each step's `uses:` and `run:`:
    - `needs_docker` = true if the job has `container:`, any `services:`, any step `uses:` matching
      `docker/*` (e.g. `docker/setup-buildx-action`, `docker/build-push-action`), or a `run:` line
      invoking `docker ` / `docker-compose`.
    - `known_actions` = de-duped list of every step `uses:` value.
    - `arch_hints` = any explicit `arm64` / `aarch64` / `amd64` / `x86_64` tokens seen in
      `runs-on`, `container` image tags, or `run:` text (best-effort substring scan).
- **Types:** add the `ParsedWorkflow` / `ParsedJob` / `StepSignals` interfaces to
  `src/shared/types.ts` (co-located with the other domain types). Do NOT yet add `route`/`compat`
  fields to the emitted object — routing + compat wiring is M3-S3 (keep this slice's surface minimal
  and honest; the parser only produces the raw normalized model + signals).
- **Robustness:** malformed YAML → throw a typed error the caller can catch (do not crash the
  Lambda later); a workflow with no `jobs:` → `jobs: []`, not a throw. No `any` leakage across the
  module boundary.
- **Unit tests `test/workflow-parser.test.mjs`** (node:test, against compiled `dist/`), covering:
  1. simple `runs-on: ubuntu-latest` string → `runs_on: ['ubuntu-latest']`, `needs_docker:false`.
  2. array `runs-on: [self-hosted, lambda-ci-docker]` → preserved as array.
  3. `on:` in string / array / map forms all normalize to `string[]`.
  4. `container: node:20` and `container: { image: ... }` object form both populate `container`.
  5. `services:` present → `needs_docker:true` and `services` lists the keys.
  6. step `uses: docker/build-push-action@v6` → `needs_docker:true` + appears in `known_actions`.
  7. `run: docker build .` → `needs_docker:true`.
  8. `strategy.matrix: { node: [18,20], os: [ubuntu-latest] }` → `matrix_dims` with both dims
     (string-coerced), `include`/`exclude` ignored.
  9. matrix/expr `runs-on: ${{ matrix.os }}` → preserved as the raw expr string in `runs_on`.
  10. reusable `uses: org/repo/.github/workflows/x.yml@main` at job level → `uses` populated.
  11. malformed YAML → `parseWorkflow` throws; empty/no-jobs workflow → `jobs: []`, no throw.

**Verification target:** full repo gate — `npm ci && npm run build && npm test && npx cdk synth`.
Slice-specific: `test/workflow-parser.test.mjs` cases 1–11 pass; `npm ci` succeeds with the new
pinned `js-yaml` dep; no arch assumptions introduced.

---

## Prior slice — DONE (review.passed)
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

## Fix slice (builder, iteration 6) — DONE, awaiting review
**Resolve critic rejection: missing Dockerfile.node / Dockerfile.docker.** Commit `2c08091`.
- Added `microvm/Dockerfile.node` — self-contained arm64 (mirrors Dockerfile.base) + Corepack
  (pnpm/yarn) + latest npm. capabilities:[node].
- Added `microvm/Dockerfile.docker` — self-contained arm64 (mirrors Dockerfile.base) + Docker CE
  engine from Docker's arm64 apt repo; runner added to docker group; 4 vCPU / 8 GB per catalog.
- Both are self-contained because `create-microvm-image` builds a snapshot from a single staged
  `Dockerfile`, not a registry base. README layout diagram updated.
- **Verified:** `node scripts/build-images.mjs --dry-run` stages all 3 flavors (base/node/docker)
  with NO `missing Dockerfile.<flavor>` error (also proven per-flavor). Gate green — `npm run build` ✓,
  `node --test test/*.test.mjs` → 57 pass / 0 fail ✓, `npx cdk synth` ✓. All flavors arch=arm64.

## Fix slice (builder, iteration 9) — DONE, awaiting review
**Resolve critic rejection (iter 8): false "rootless" security claim.** Commit `b8e4fa6`.
- `microvm/flavors.json` docker flavor description said "rootless, DinD" but `Dockerfile.docker`
  installs standard ROOTFUL docker-ce (runner in docker group, dockerd started per-job as root,
  sudo NOPASSWD). The description is operator-facing (M4 Flavors screen, spec 04), so the claim
  was a false security-trust signal.
- Chose to align METADATA to the actual posture (not re-engineer to rootless): single-use
  ephemeral microVMs make rootful acceptable — each VM is its own isolation boundary. New text:
  "base + Docker engine (rootful daemon started per-job, runner in docker group) for
  container:/services: jobs and docker build/run, arm64 images. Larger footprint (4 vCPU / 8 GB)."
- **Verified:** flavors.json valid JSON; full gate green — `npm run build` ✓,
  `node --test test/*.test.mjs` → 57 pass / 0 fail ✓, `npx cdk synth` ✓,
  `node scripts/build-images.mjs --dry-run` stages all 3 flavors ✓. No other false rootless
  claim remains (remaining DinD refs in specs/run-hook are accurate — a dockerd does run in-VM).

## Finalizer verdict (iteration 13) — queue.advance
Re-issue of the iteration-12 verdict (iter 12 decided correctly but emitted no topology event).
M3-S1 (flavor catalog + spec-03 routing resolution + Dockerfiles, `b8e4fa6`) passed critic review
(iter 11 `review.passed`) and is good work, but **M3 is NOT complete** — only 1 of 4 exit-criteria
pieces is done. Gate re-verified green this iteration: `npm run build` ✓, `node --test test/*.test.mjs`
→ 57/57 ✓. NOT landing M3 (no PR) — a milestone lands only when all its exit criteria are met.
Routing back via `queue.advance` for the next slice.

### Prior finalizer verdict (iteration 12) — queue.advance (no event emitted; superseded by iter 13)
M3-S1 passed critic review and is good work, but
**M3 is NOT complete** — only 1 of 4 exit-criteria pieces is done. Not landing M3 yet; routing
back for the next slice.

M3 milestone completion checklist:
- [x] Flavor catalog (`base`/`node`/`docker`) + per-repo `FlavorMap` routing — DONE
      (`e824f2e`, `2c08091`, `b8e4fa6`, all on LOCAL main, unpushed).
- [ ] **Workflow discovery + parser** — `.github/workflows/**` -> normalized model; `push` re-parse.
      No module exists. `src/ingest/handler.ts:69` still says "workflow re-parse lands in M3".
- [ ] **`runs-on` -> flavor routing wired into the provision path** — `resolveFlavor` is pure and
      NOT yet consumed with real per-repo FlavorMap + workflow signals in ingest/provision.
- [ ] **Compatibility analysis** (`ok`/`warn`/`risk`/`block`) — no module exists.
- [ ] Exit demo: a repo with docker + node jobs routes each to the right flavor with no YAML
      edits beyond LCA labels — not demonstrable until the above land.

Landing note (for when M3 IS done): the 3 M3 commits are on LOCAL `main` only (origin/main is at
`225fc18`, 3 behind). M1/M2 landed via PR (#3/#4). When M3 exit criteria are met, the finalizer
must branch these commits off updated origin/main and land via `gh pr` per harness landing rule —
do NOT push straight to origin/main. Suggested next slice: **M3-S2 workflow discovery + parser**
(pure, testable: raw workflow YAML -> normalized job model with `runs-on` labels + capability
signals like `container:`/`services:` => needs_docker), then M3-S3 wire routing into ingest +
compat analysis.

## Relevant Issues
- **False "rootless" docker-flavor description** (`fix-now` → **RESOLVED** iteration 9, commit `b8e4fa6`):
  Corrected `flavors.json` docker description to state the real rootful posture. The gate does NOT
  catch metadata↔impl mismatches like this — only human/critic review does.
- **Missing Dockerfile.node / Dockerfile.docker** (`fix-now` → **RESOLVED** iteration 6, commit `2c08091`):
  Added both arm64 Dockerfiles; `scripts/build-images.mjs --dry-run` now stages all 3 flavors without
  error. Note: the gate does NOT exercise the build script, so future catalog↔Dockerfile drift won't be
  caught by `npm run build && npm test && npx cdk synth` alone — the `--dry-run` staging check is the
  guard for that.
