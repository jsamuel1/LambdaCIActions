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
3. **Adopt-mode standard-label map** (if adopt enabled for the repo):
   | GitHub label | Default flavor |
   |---|---|
   | `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04` | `base` (or `node`/`docker` per signals) |
   | any + docker signals | `docker` |
   | `self-hosted` + our labels | matched flavor |
4. **Signal-based upgrade** — if resolved flavor lacks a needed capability (e.g. Docker), upgrade to the smallest flavor that has it.
5. **Fallback** — `base`; record a warning if uncertain.

The Ingest λ ([01](01-github-app.md)) only *claims* a `workflow_job` if routing says
`eligible` for that job's labels. Non-eligible jobs are ignored (GitHub-hosted still runs them).

## Compatibility analysis

Because runners are **arm64-only** and single-use, ingestion computes a `compat.level`:

| Level | Meaning | Example triggers |
|---|---|---|
| `ok` | Should run unchanged | pure scripts, arm64-friendly actions |
| `warn` | Runs, watch out | long job (>cap), heavy caching assumptions, matrix explosion |
| `risk` | Likely needs attention | `runs-on: windows/macos`, x86-only binaries, `container:` with amd64-only image |
| `block` | We won't claim it | explicitly x86-required, unsupported OS |

Surfaced in the UI per workflow/job with actionable messages (e.g. "image `foo:amd64` is
x86-only; publish an arm64 variant or exclude this job").

## Onboarding modes

Per-repo setting stored on the `Repo` row:

- `disabled` — we ignore the repo.
- `label` — claim only jobs carrying an LCA label. Safest; opt-in per workflow.
- `adopt` — claim standard-label jobs too (drop-in, no YAML edits). Powerful; requires confidence in compat.

Default on install: `label` (safe). UI nudges toward `adopt` once compat is green.

## Auto-rewrite (opt-in)

For teams that want explicit control in-repo, LCA can open a PR that adds LCA labels:

```diff
 jobs:
   build:
-    runs-on: ubuntu-latest
+    runs-on: [self-hosted, lambda-ci]
```

- Generated as a branch + PR via the App (`contents:write` would be required — an **elevated** permission, off by default; see [01](01-github-app.md) OQ).
- Never force-pushed; always a reviewable PR. Dry-run diff shown in UI first.

## Edge cases

- **Reusable workflows** (`uses: org/repo/.github/workflows/x.yml@ref`) — parse the callee if in an installed repo; else mark `warn` (can't see it).
- **Matrix** — expand statically-known dims; dynamic dims (`fromJSON`) → `warn`, route by base labels.
- **`container:` jobs** — need Docker flavor + arm64-compatible image; check registry arch if possible.
- **Composite/`services:`** — imply Docker flavor.
- **Monorepo path filters** — irrelevant to routing (GitHub decides *whether* a job runs; we only handle jobs that *do* queue).

## Open questions

- **OQ-1**: How aggressively to expand matrices we can't fully resolve? (Risk: over/under-claiming jobs.)
- **OQ-2**: Registry arch inspection for `container:` images — worth the API cost, or defer to runtime failure + clear log?
- **OQ-3**: Adopt-mode default flavor for bare `ubuntu-latest` — `base` vs signal-driven `node`/`docker`? (Leaning signal-driven.)
