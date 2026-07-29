# Spec 03 — Workflow Ingestion

Status: **Draft** · Plane: Management (feeds Control)

The differentiator: LambdaCIActions **reads your existing GitHub Actions workflows**,
understands what they need, and routes jobs to the right microVM flavor — ideally with
**zero edits** to your YAML. This spec covers discovery, parsing, routing, compatibility
analysis, and the (optional) auto-rewrite.

## Contents
- [Goal: drop-in](#goal-drop-in)
- [Discovery](#discovery)
- [Parsing model](#parsing-model)
- [`runs-on` → flavor routing](#runs-on--flavor-routing)
- [Compatibility analysis](#compatibility-analysis)
- [Onboarding modes](#onboarding-modes)
- [Auto-rewrite (opt-in)](#auto-rewrite-opt-in)
- [Edge cases](#edge-cases)
- [Open questions](#open-questions)

---

## Goal: drop-in

A repo should switch to LambdaCIActions by either:

- **(A) Label mode** — add our label to `runs-on` (one-line change), or
- **(B) Adopt mode** — we map GitHub's standard labels (`ubuntu-latest`, etc.) to flavors so **no YAML changes** are needed; jobs route to us automatically.

Both require us to first *understand* the workflows. That's ingestion.

## Discovery

Triggered by:
- `installation.created` / `installation_repositories.added` → parse all repos.
- `push` touching `.github/workflows/**` → re-parse that repo.
- Manual "re-scan" button in the UI.

Mechanics:
1. Mint installation token ([01](01-github-app.md)).
2. `GET /repos/{o}/{r}/contents/.github/workflows` → list `*.yml|*.yaml`.
3. Fetch each file's content (record the commit `sha`).
4. Parse → upsert `Workflow` rows (keyed by path) with `last_parsed_sha`.

**Implementation (M3-S4, ADR-017)**: discovery runs in a dedicated λ behind a standard
SQS queue (`lca-<env>-discovery`), fed by the Ingest λ. Each scan upserts one
`WorkflowAnalysisRecord` per file (`pk=REPO#<repoId>`, `sk=WF#<path>`) holding the parse
output, per-job compat, and a routing preview computed with the repo's FlavorMap **and its
onboarding `mode`** — the same inputs Provision uses, so the stored `routes[jobId]` (flavor +
reason) is what will actually happen rather than a label-mode approximation. That row is not
just a console decoration: the auto-rewrite planner reads its flavor to choose the label it
writes into a customer's PR. Because the preview is mode-dependent, changing a repo's `mode`
from the console **enqueues a re-scan** instead of waiting for the next `push`.
Malformed YAML persists as a `parseError` row (surfaced in the UI, not retried).

Consumers correlate a `workflow_job` webhook to its analysis by **rendered name**
(`workflow_job.workflow_name` → workflow `name`, `workflow_job.name` → job `name:` or
id; matrix renders match by `"name ("` prefix) and **fail open**: Ingest skips a claim
only on an unambiguous `block` match; Provision degrades to label-only routing when no
analysis matches.

## Parsing model

Parse YAML into a normalized structure (don't attempt full GitHub semantics — extract what
routing/compat needs):

```jsonc
{
  "path": ".github/workflows/ci.yml",
  "name": "CI",
  "on": ["push", "pull_request"],
  "jobs": [
    {
      "id": "build",
      "runs_on": ["ubuntu-latest"],        // string | array | matrix expr
      "container": null,                    // job.container.image if present
      "services": [],                       // job.services.*
      "uses": null,                         // reusable workflow ref
      "matrix_dims": { "node": ["18","20"] },
      "step_signals": {                     // heuristics for compat + flavor
        "needs_docker": true,               // docker/build-push, services, DinD
        "arch_hints": ["arm64"],            // setup-* with arch, uname usage
        "known_actions": ["actions/checkout@v4", "docker/setup-buildx-action@v3"]
      }
    }
  ],
  "route": { "eligible": true, "flavor": "docker", "reason": "docker signals present" },
  "compat": { "level": "ok", "warnings": [] }
}
```

- `runs-on` may be a string, array, or expression (`${{ matrix.os }}`). Matrix is expanded where statically resolvable; otherwise flagged.
- `step_signals` come from a small rules table over `uses:`/`run:` (e.g. `docker/*` → `needs_docker`).

## `runs-on` → flavor routing

Resolution order (first match wins):

1. **Repo FlavorMap override** (DynamoDB) — explicit `label → flavor`.
2. **Explicit LCA label** — `lambda-ci`, `lambda-ci-docker`, `lambda-ci-node` → that flavor.
3. **Adopt-mode standard-label map** — implemented in M5 (ADR-030), consulted only when the
   repo's `mode` is `adopt`:
   | GitHub label | Flavor |
   |---|---|
   | `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-20.04` | `base`, then signal-upgraded to `docker` when the job's steps need it |
   | `windows-*`, `macos-*` | **never claimed, in any mode** — refused in the claim gate *above* the explicit-label rule, so even `runs-on: [windows-latest, lambda-ci]` stays on GitHub-hosted (compat fails open, so it cannot be the only guard) |
   | `x64`, `x86`, `x86_64`, `x86-64`, `amd64`, `i386`, `i686` | **never claimed, in any mode** — same gate, same reason, but the failure it prevents is worse: GitHub matches a runner on *advertised labels alone*, so registering a Graviton runner carrying `x64` would make the job **run on the wrong architecture** instead of staying queued. Exact tokens only (`x64-cache-warmer` is a custom label, not an arch claim); `arm64`/`aarch64` are ours and always allowed. Refused a second time pre-mint in Provision (ADR-030) |
   | `runs-on: { group: X, labels: […] }` where `X` ≠ `default` | **not claimed** — GitHub dispatches only to a runner that is in the requested group *and* carries the labels, and we register into the repo-level default group (`runner_group_id: 1`). The `workflow_job` webhook carries no group, so this is decided from the stored analysis's `runner_group`; with no analysis the group is invisible and the gate fails open, as the compat gate does |
   | `self-hosted` + a non-LCA label | not claimed — that is someone else's runner fleet |

   This settles OQ-3 as **signal-driven**: the label itself says nothing about what the job
   needs, so the flavor comes from `step_signals`, never from the label text. In v1 the only
   signal the parser emits is `needs_docker`, so `docker` is the only automatic upgrade; a job
   that wants the `node` flavor asks for it by label or FlavorMap entry (`base` already carries
   Node for the runner agent itself). A `needs_node`-style signal would be additive.
4. **Signal-based upgrade** — if resolved flavor lacks a needed capability (e.g. Docker), upgrade to the smallest flavor that has it.
5. **Fallback** — the repo's operator-chosen `defaultFlavor` (set from the console, [04](04-web-ui.md))
   if present and valid, else `base`; record a warning if uncertain.

The Ingest λ ([01](01-github-app.md)) only *claims* a `workflow_job` if routing says
`eligible` for that job's labels. Non-eligible jobs are ignored (GitHub-hosted still runs them).

**Repo config gate** (ADR-027, extended by ADR-030): Ingest reads the repo row **before** the
claim decision, because since M5 `mode` is an *input* to it, not only an opt-out. The row
supplies: `enabled=false` / `mode='off'` ⇒ drop; `mode='adopt'` ⇒ widen claiming to standard
hosted labels. The management plane only writes that config — this is where it takes effect.
The read fails **open to `label` mode**: a missing repo row (pre-M4 onboarding) or a DynamoDB
fault never blocks a labeled job, and equally never *starts* intercepting a repo's
`ubuntu-latest` jobs.

**Runner labels at registration**: the minted JIT runner advertises the **job's own** label
set, because GitHub matches jobs to runners by label-set containment (labels are cumulative).
In adopt mode that means the runner carries `ubuntu-latest`. See ADR-030, including the open
verification item on GitHub's reserved hosted-label names.

Unresolved `${{ … }}` entries are dropped from that set (an expression is not a label), so a
job whose `runs-on` is *entirely* expression-driven normalizes to nothing. Provision **refuses
such a job before minting**: a runner with no labels gets only GitHub's automatic defaults,
cannot match the job, and would strand a booted VM plus a consumed single-use JIT config. The
run fails with an actionable reason (add a literal LCA label beside the expression).

## Compatibility analysis

Because runners are **arm64-only** and single-use, ingestion computes a `compat.level`:

| Level | Meaning | Example triggers |
|---|---|---|
| `ok` | Should run unchanged | pure scripts, arm64-friendly actions |
| `warn` | Runs, watch out | long job (>cap), heavy caching assumptions, matrix explosion |
| `risk` | Likely needs attention | `runs-on: windows/macos`, x86-only binaries, `container:` with amd64-only image |
| `block` | We won't claim it | explicitly x86-required, unsupported OS |

Every finding carries a stable `code`, an operator-facing `text` stating the problem, and (M5)
a `fix` naming the remedy — rendered as a separate line in the console so the two are not
conflated (e.g. text: "container image `foo:amd64` looks x86-only"; fix: "push a multi-arch
manifest with `docker buildx build --platform linux/amd64,linux/arm64`").

**Adopt candidacy is not a compat finding.** A job targeting `ubuntu-latest` with no LCA label
is the normal state of an un-onboarded repo, so it is reported as `adoptCandidate` on the
workflow view rather than as a `warn`. Folding it into `compat.level` would turn every
un-adopted repo yellow and destroy the "nudge toward adopt once compat is green" signal below.

## Onboarding modes

Per-repo setting stored on the `Repo` row:

- `off` — we ignore the repo (also `enabled=false`).
- `label` — claim only jobs carrying an LCA label. Safest; opt-in per workflow.
- `adopt` — claim standard-label jobs too (drop-in, no YAML edits). Powerful; requires
  confidence in compat, and it is **all-or-nothing per repo**: GitHub offers no way to take
  some `ubuntu-latest` jobs and leave the rest on GitHub-hosted runners.

Default on install: `label` (safe). UI nudges toward `adopt` once compat is green. Switching
mode re-scans the repo, because the stored routing preview is resolved with the mode.

## Auto-rewrite (opt-in)

For teams that want explicit control in-repo, LCA can open a PR that adds LCA labels:

```diff
 jobs:
   build:
-    runs-on: ubuntu-latest
+    runs-on: [self-hosted, lambda-ci]
```

Implemented in M5 (ADR-031). Behaviour:

- **Three gates, all required**: the deployment flag (`cdk deploy -c rewrite=true`), the
  per-repo `rewriteEnabled` toggle, and the App actually holding `contents:write` (an
  **elevated** permission, off by default — see [01](01-github-app.md) OQ). Any one off ⇒ no
  write. The dry run works regardless.
- **Only `runs-on:` lines change.** Comments, formatting, quoting and key order are preserved
  byte-for-byte; the rewriter refuses shapes it cannot edit safely (block sequences, matrix
  expressions, the runner-group object form, and a job whose body is an inline flow mapping)
  and reports them for hand-editing instead of guessing. A job whose surrounding structure the
  line scanner cannot parse is likewise refused rather than attributed to a neighbouring job
  (ADR-031, seventh-review fix).
- The GitHub-hosted label is **removed** rather than kept alongside ours — leaving it would
  require a runner advertising it and defeat the rewrite (label containment, ADR-030).
- Branch + PR only: never a direct push, never a force-push, an existing PR is updated rather
  than duplicated, and nothing is auto-merged. Commits are `sha`-guarded so a concurrent edit
  is rejected rather than clobbered.
- A separate control-plane λ performs the write; the management API only enqueues, so the
  read-mostly console role never gains `contents:write` (ADR-025 boundary preserved).

## Edge cases

- **Reusable workflows** (`uses: org/repo/.github/workflows/x.yml@ref`) — parse the callee if in an installed repo; else mark `warn` (can't see it).
- **Matrix** — expand statically-known dims; dynamic dims (`fromJSON`) → `warn`, route by base labels.
- **`container:` jobs** — need Docker flavor + arm64-compatible image; check registry arch if possible.
- **Composite/`services:`** — imply Docker flavor.
- **Monorepo path filters** — irrelevant to routing (GitHub decides *whether* a job runs; we only handle jobs that *do* queue).

## Open questions

- **OQ-1**: How aggressively to expand matrices we can't fully resolve? (Risk: over/under-claiming jobs.)
- **OQ-2**: Registry arch inspection for `container:` images — worth the API cost, or defer to runtime failure + clear log?
- ~~**OQ-3**: Adopt-mode default flavor for bare `ubuntu-latest`~~ — **resolved (M5, ADR-030)**:
  signal-driven. Every standard label maps to `base`; the flavor upgrade comes from
  `step_signals` (v1 emits only `needs_docker`, so `docker` is the only automatic upgrade).
- **OQ-4** (M5): does `generate-jitconfig` accept `ubuntu-latest` as a runner label, or does
  GitHub reject reserved hosted-label names with HTTP 422? Adopt mode depends on it. Handled
  defensively today (permanent-failure classification + an actionable run reason) and closed
  by observing the M5 exit criterion against a live repo. See ADR-030.
