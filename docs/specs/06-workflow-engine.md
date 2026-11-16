# Spec 06 — Workflow Engine (our own definition + scheduler)

Status: **Proposed (design only — no implementation)** · Plane: Control (new: **Execution plane**)

Today GitHub is the scheduler and we are only compute: we read `.github/workflows/**` to *route*
a job GitHub already decided to run ([03](03-workflow-ingestion.md)), and the `actions/runner`
agent inside our microVM talks to **GitHub's** Actions service, not to us. This spec designs the
opposite: **we** evaluate triggers, plan the job DAG, dispatch each job to a microVM we drive, and
report results back. It reverses [ADR-004](../DECISIONS.md#adr-004) and is the largest single
change proposed in this project, so its most important content is the **boundary** — what v1 will
not do, and what it refuses outright.

> **Nothing in this spec is implemented.** It exists so the follow-on implementation cards can be
> filed safely. See [ROADMAP § M6](../ROADMAP.md#m6--our-own-workflow-engine--review-integration)
> for the phasing.

## Contents
- [Why: what GitHub Free actually withholds](#why-what-github-free-actually-withholds)
- [Engine strategy (Q1)](#engine-strategy-q1)
- [Grammar support matrix](#grammar-support-matrix)
  - [Recursive key census](#recursive-key-census)
- [Expression language subset](#expression-language-subset)
- [Planning: trigger → run → job list](#planning-trigger--run--job-list)
- [Trigger sources & idempotency (Q3)](#trigger-sources--idempotency-q3)
  - [Path filters: the changed-file set](#path-filters-the-changed-file-set)
- [Trigger trust: forks, bots and re-runs](#trigger-trust-forks-bots-and-re-runs)
- [Coexistence with the `workflow_job` path (Q2)](#coexistence-with-the-workflow_job-path-q2)
- [Run identity, keys & attempts](#run-identity-keys--attempts)
- [Dispatch without `generate-jitconfig`](#dispatch-without-generate-jitconfig)
- [Agent protocol](#agent-protocol)
  - [In-VM trust boundary](#in-vm-trust-boundary)
- [`uses:` resolution & supply chain (Q4)](#uses-resolution--supply-chain-q4)
- [Server APIs we would have to host](#server-apis-we-would-have-to-host)
- [Secret custody](#secret-custody)
- [Per-job token & OIDC](#per-job-token--oidc)
- [Run-state model](#run-state-model)
- [Data model (Q6)](#data-model-q6)
  - [Item bounds](#item-bounds)
- [Blast radius (Q7)](#blast-radius-q7)
- [Refusal is a first-class outcome](#refusal-is-a-first-class-outcome)
- [Provider abstraction](#provider-abstraction)
- [Open questions](#open-questions)

---

## Why: what GitHub Free actually withholds

The filing's motivation was "so we can operate on the free tier". **That reading is wrong on cost
and right on governance**, and the difference changes the scope, so it is pinned here with
citations before any design follows from it.

| Claim | Verdict | Evidence |
|---|---|---|
| Actions **minutes** are metered for our runners on Free | ❌ **No — free on every plan** | "GitHub Actions usage is **free** for **self-hosted runners** and for **public repositories** that use standard GitHub-hosted runners." — [billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| Minute quota (2,000/mo on Free) applies to us | ❌ No — GitHub-hosted only | "For **private repositories**, each GitHub account receives a quota of free minutes … for use with GitHub-hosted runners." — [billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| **Protected branches** on a Free *private* repo | ✅ **Withheld** | Listed as what **Pro** adds "in addition to GitHub Free … in private repositories: … Protected branches" — [plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) |
| **Required approving reviewers** on a Free private repo | ✅ **Withheld** | Same list: "Required pull request reviewers / Multiple pull request reviewers" — [plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) |
| **CODEOWNERS**-required review on a Free private repo | ✅ **Withheld** | Same list: "Code owners" — [plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) |
| Actions **environment protection rules** (required reviewers, wait timer) on Free | ✅ **Withheld for private** | "Users with GitHub Free plans can only configure environments for **public** repositories. If you convert a repository from public to private, any configured protection rules or environment secrets will be ignored" — [environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) |
| **Merge queue** on Free | ⚠️ **Not stated as a plan gate** | The merge-queue page states only the mechanism: "Repository administrators can require a merge queue by enabling the branch protection setting" — [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue). It is *reached through* branch protection, which is withheld (above), but no plan matrix is published for the queue itself. Recorded as **OQ-6**, not asserted. |
| Repo-level **rulesets** route around the branch-protection gate on Free | ⚠️ **Not stated** | The rulesets page gates only the *multi-repo* case: "applies to a repository or to multiple repositories in an organization for customers on GitHub Team and GitHub Enterprise plans" — [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets). The plans page lists "repository rules" under Enterprise. Those do not settle repo-level rulesets on Free+private ⇒ **OQ-6**. |

**Conclusion, stated plainly: minutes are not the gap.** Our runners are self-hosted and cost the
customer nothing in GitHub minutes today. The two real gaps are:

1. **PR governance on private repos** — required reviews, protected branches, code owners and
   environment approvals are all paid features. A team on Free with private repos has *no*
   enforceable merge gate. That is what [07](07-review-integration.md) addresses.
2. **Portability** — a non-GitHub host (GitLab, Bitbucket, CodeCommit, Gitea) has no GitHub
   Actions at all, so there is no `workflow_job` webhook to claim and nothing to route. Serving
   those hosts *requires* owning the definition and the scheduler.

Limits that do **not** go away by being self-hosted, and which the planner must respect
([limits](https://docs.github.com/en/actions/reference/limits)): job execution time **5 days**
self-hosted; a job matrix may generate at most **256 jobs per workflow run** ("This limit applies
to both GitHub-hosted and self-hosted runners"); workflow-run queuing **500 runs / 10 seconds**.
Our own ceilings are stricter anyway — the Reaper caps microVM lifetime well under the 8-hour
platform maximum ([02](02-microvm-runners.md)).

## Engine strategy (Q1)

**Decision: build our own planner + our own agent, and adopt the *shape* of Gitea's runner
protocol rather than GitHub's.** Recorded as [ADR-055](../DECISIONS.md#adr-055).

The four options, with the licence and protocol findings that decide it:

| Option | Licence | Is the server contract specified? | Verdict |
|---|---|---|---|
| **(d) Keep `actions/runner`, emulate GitHub's Actions service** | Runner is **MIT** ("The MIT License (MIT) / Copyright (c) 2019 GitHub", [LICENSE](https://raw.githubusercontent.com/actions/runner/main/LICENSE)) | **No.** Documented nowhere. Its README covers install/use only, and states "right now we are not taking contributions" ([README](https://raw.githubusercontent.com/actions/runner/main/README.md)) | ❌ **Rejected.** MIT lets us *read* the client; it does not make the server a stable contract. We would be reverse-engineering an unversioned, unannounced protocol that GitHub may change in any runner release, with no deprecation channel and a repo that will not take our patches. This is the card's top feasibility risk and it is real. |
| **(b) `nektos/act` semantics** | **MIT** ([LICENSE](https://raw.githubusercontent.com/nektos/act/master/LICENSE)) | n/a — `act` interprets workflow YAML itself; it is a local executor, not a protocol implementation | ⚠️ **Reference, not dependency.** Useful as prior art for *interpreting* the grammar. Note its README publishes **no** "limitations"/"not supported" section, so there is no vendor fidelity claim to lean on — any compatibility statement we make must be our own, tested. |
| **(c) Gitea/Forgejo runner protocol** | **MIT**, both runner and protocol ([runner](https://gitea.com/gitea/runner/raw/branch/main/LICENSE), [proto](https://gitea.com/gitea/actions-proto-def/raw/branch/main/LICENSE)) | **Yes — published Protocol Buffer schema.** The whole server obligation is five RPCs: `Register`, `Declare`, `FetchTask`, `UpdateTask`, `UpdateLog` ([services.proto](https://gitea.com/gitea/actions-proto-def/raw/branch/main/proto/runner/v1/services.proto)) | ✅ **Adopted as the model.** |
| **(a) Our own agent + engine** | ours | ours to define | ✅ **Adopted for the agent**, because our dispatch is not a poll. |

**Why the winner wins — the asymmetry, not preference.** Compare the two server obligations
honestly: GitHub's is *unbounded and unpublished*; Gitea's is *five RPCs and published*. That is
the entire argument. A protocol we can read in one file is a protocol we can implement, test and
keep working; one we must infer from a client's source is a permanent maintenance liability whose
breakage arrives without warning and lands on customer CI.

We take Gitea's **shape** (a small register/declare/fetch/update/log surface) but not its wire
protocol verbatim, for one concrete reason: `FetchTask` is a **poll**, and our runners are
single-use microVMs booted per job by Provision. The task is already decided before the VM exists,
so v1 hands the job down at boot and the agent only reports upward — see
[Agent protocol](#agent-protocol). Staying deliberately close to Gitea's surface keeps the
Gitea/Forgejo provider ([Provider abstraction](#provider-abstraction)) cheap later.

**Where we run third-party action code we do not reimplement its semantics from scratch**: `act`
and the Gitea runner both prove the interpretation is tractable, and both are MIT, so lifting
*algorithms* (expression evaluation, matrix expansion) with attribution is open to us. What we
refuse is depending on an unspecified protocol.

## Grammar support matrix

The card's hard requirement: **no "full featureset" hand-waving.** Every construct lands in exactly
one of four classes, and the class decides the behaviour mechanically, so the matrix is testable:

| Class | Plan-time behaviour | Can it cause a partial execution? |
|---|---|---|
| **Supported** | planned normally | no |
| **Supported with declared degradation** | planned; the degradation is stated in every affected job's check-run summary and on the console before the first job starts | no — admitted only where the degraded behaviour is an outcome the construct can legitimately produce on GitHub too |
| **Refused in v1** | the **whole run** is refused at plan time, before any VM boots, with a refusal code, a reason and a fix ([Refusal](#refusal-is-a-first-class-outcome)) | no — nothing was dispatched |
| **Out of scope** | refused exactly like the row above; the fix says the construct is not coming | no |

**Default-deny.** A key or construct that is not in the Supported or Degraded tables is Refused. The
parser treats an unknown key as refused, never as ignored, so a construct GitHub adds later cannot
slip through as a silent no-op. A refusal is always for the **whole run**: refusing one job and
running its siblings is itself a partial execution, which is the failure this milestone is judged on.

**Every key GitHub defines is classified, at every depth.** Default-deny turns an omission into a
refusal of every real workflow (an earlier draft never classified `runs-on`), and a census that
stops at parent keys turns an unknown *nested* key into a silent no-op (an earlier draft listed
`container:` but not `container.options`). So classification is recursive: the tables above name
constructs, and the [recursive key census](#recursive-key-census) below gives every schema
position, from the root down to each leaf, its own disposition and, where GitHub defines one,
its closed value set. The parser walks the whole document against that census, never against a
list of top-level labels.

**Triggers are matched, not executed.** An event the engine does not support (`schedule`,
`merge_group`, `pull_request_target`, any other) simply never matches, so no run is created for it.
A workflow with `on: [push, schedule]` runs on push and never on schedule, and the console lists the
unmatched trigger on the workflow's analysis. No run is half-executed by this, because the unmatched
event never produces a run at all.

**What is not a refusal.** A supported construct failing at runtime the way it would on GitHub (a
step exiting non-zero, `hashFiles` over a missing path, `fromJSON` of a malformed output) fails that
step or job faithfully. The contract is narrower and checkable: **no run is ever dispatched that
contains a construct from the Refused or Out-of-scope classes.** The one residual runtime path is an
allowlisted action that turns out to need a service we do not host; it fails as it would with no
server, and the remedy is adding it to the refused list. That residual is why the `uses:` allowlist
is default-deny ([Q4](#uses-resolution--supply-chain-q4)).

### Supported in v1

| Feature | Notes |
|---|---|
| `on: push` / `on: pull_request` | with `branches`/`tags`/`paths` filters (incl. `-ignore` forms), the commit-message skip instructions, and trust class per [Trigger trust](#trigger-trust-forks-bots-and-re-runs). Path filters are evaluated over a changed-file set computed with GitHub's diff semantics and limits, by the rules in [Path filters: the changed-file set](#path-filters-the-changed-file-set) |
| `on: workflow_dispatch` | with typed `inputs` (each `<input_id>` with `description`, `required`, `default`, and `type` one of `boolean`, `choice` (+ `options`), `number`, `string`; type `environment` is Refused), within GitHub's limits of 25 inputs and 65,535 characters of payload ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs)); from our console only |
| `on.pull_request.types` | absent (GitHub's default: `opened`, `synchronize`, `reopened`), or a subset of those three. Any other activity type in the list never matches, like an unsupported trigger; a delivery whose action is outside the three creates no trigger batch |
| `name`, `run-name`, `jobs.<id>.name` | display; `run-name` and `name` evaluated at plan time over the plan-time contexts (`github` properties of the [event projection](#the-github-context-and-the-event-projection), `inputs`, `matrix`). The rendered job name is part of the check-run name ([07](07-review-integration.md#check-run-names-one-authority-per-name)) |
| `jobs.<id>.runs-on` | a string, a list of strings, or `labels:` alone; each entry a literal or an expression over plan-time contexts. Resolved per matrix leg **at plan time** to one flavor, stored in the plan, by the rules in [`runs-on` in engine mode](#runs-on-in-engine-mode-flavor-selection) |
| `permissions`, `jobs.<id>.permissions` | **required**, at workflow level or on every job, and only with an effective set our token can satisfy: `{}`, or a map whose only non-`none` scope is `contents: read`. The effective set is computed as on GitHub (job level replaces workflow level; "all of those that are not specified are set to `none`"), and the token minted matches it exactly ([Per-job token](#per-job-token--oidc)). Every other form, and omission, is in the Refused table |
| `jobs.<id>.steps[].run` | `bash` default; `shell:` honoured for `bash`/`sh`/`python` (any other shell is Refused) |
| `jobs.<id>.steps[].uses` (+ `with`) | JS actions at a resolved SHA, owner-allowlisted — see [Q4](#uses-resolution--supply-chain-q4) |
| `jobs.<id>.steps[].id`, `.name`, `.env`, `.working-directory` | as on GitHub |
| `needs:` | full DAG ordering, cycle detection (cycle ⇒ Refused), transitive skip propagation |
| `if:` on job and step | over the [expression subset](#expression-language-subset) |
| `strategy.matrix` | **static** dims, `include`, `exclude`; ≤256 jobs. `fail-fast` (default `true`, as on GitHub) and `max-parallel` are executed by a durable matrix group ([Matrix groups](#matrix-groups-max-parallel-and-fail-fast)); each must be a literal or decidable at plan time, else Refused |
| `env:` at workflow / job / step | with documented precedence |
| `defaults.run` | `shell`, `working-directory` |
| `outputs` | step → job → run, via `$GITHUB_OUTPUT`. GitHub's limits are kept, with GitHub's accounting: "Outputs can be a maximum of 1 MB per job. The total of all outputs in a workflow run can be a maximum of 50 MB. Size is approximated based on UTF-16 encoding" ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)). No other limit applies: a dependent can read up to the full 50 MB, because outputs reach the VM in bounded pages, never in one response. A matrix job's outputs are combined across its legs as on GitHub ([Deadlines and outputs](#deadlines-and-outputs)) |
| `timeout-minutes` | job and step, enforced by the agent with a durable job deadline the Reaper enforces if the agent does not ([Deadlines and outputs](#deadlines-and-outputs)). Absent ⇒ the platform ceiling, stated on the check run. An explicit value above the ceiling is Refused (a silent cap would kill the job earlier than its author declared) |
| `continue-on-error` | step level fully; job level on a job no other job `needs` (with dependents it is Refused, next table). A literal, or an expression decidable at plan time (matrix values included), else Refused. Every engine surface reads the same two fields per job attempt, the raw conclusion and the effective result ([continue-on-error](#continue-on-error-raw-and-effective-results)) |
| `container:` / `services:` | `container.image` (or the string shorthand), `.env`, `.ports`, `.volumes`; `services.<service_id>.image`, `.env`, `.ports`, `.volumes`, `.command`, `.entrypoint`. Every image's manifest is verified arm64 **at plan time**; routes to a Docker-capable flavor as today. `credentials` and `options` are Refused (next table) |
| Contexts | `github` (the enumerated properties in [The `github` context](#the-github-context-and-the-event-projection) only), `env`, `job`, `steps`, `runner` (with `os` = `Linux` and `arch` = `ARM64`), `matrix`, `needs`, `inputs`, `secrets` (empty for untrusted triggers). `vars` is Refused (next table) |
| Commands | `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_PATH`, `$GITHUB_STEP_SUMMARY`, `::error`/`::warning`/`::notice`, `::add-mask::`, `::group::` |

### Supported with declared degradation in v1

| Feature | Degradation | Admission rule |
|---|---|---|
| `actions/cache` (and its `restore`/`save` sub-actions) at an **evidence-listed SHA** | no cache server until phase 6: every restore is a miss (`cache-hit` is `false`), every save is skipped | Admitted only for an action SHA whose fail-open behaviour is recorded by a phase-1 fixture: the step exits 0 and the only observable difference is the miss. A cache miss is a legitimate outcome on GitHub too, and a correct workflow already handles it, so this changes speed, not results. A SHA without that evidence is Refused (next table). |
| `cache-mode`, `jobs.<id>.cache-mode` with one of GitHub's four values, `read`, `write`, `write-only` or `none` | every value behaves as `none` until phase 6; any other value is Refused (a typo is a validation error on GitHub, not a mode) | GitHub documents that a restore the mode does not permit "is treated as a cache miss; a skipped save is simply not performed" and "The job and workflow do not fail" ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#cache-mode)), which is exactly the cache row's behaviour |

This class is deliberately tiny. Anything whose degraded form could change a job's *result* rather
than its speed does not qualify.

### Refused in v1 — planned, and the whole run refuses until then

| Feature | Why deferred | Detected at plan time by |
|---|---|---|
| Reusable workflows (`jobs.<id>.uses`) | needs cross-repo fetch + `secrets: inherit` custody | the key |
| Composite actions | needs nested step expansion + its own `inputs` context | `action.yml` fetched during SHA resolution: "**Required** You must set this value to `'composite'`" — [metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax) |
| Docker container actions (`runs.using: docker`) | needs a build/pull path on arm64 | `action.yml` |
| `environment:` on any job | this is [07](07-review-integration.md)'s approval gate, phase 4. The first draft refused *the job*, which would have run its siblings: a partial execution | the key |
| `permissions` omitted (no workflow-level key and some job without one), `read-all`, `write-all`, any `write`, `id-token`, or `read` on any scope but `contents` | we cannot mint a per-job GitHub token beyond contents-read in v1 ([Per-job token](#per-job-token--oidc)). Omission is refused, not defaulted: GitHub's default "is initially set to the default setting for the enterprise, organization, or repository" ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#how-permissions-are-calculated-for-a-workflow-job)), which may be permissive (write) or restricted (which includes `packages: read`); neither is a set we can mint, and a setting read at plan time could change before a re-run. The fix is one line, added during the file move: `permissions: { contents: read }` | the key's values; code `engine-permissions-unsatisfiable` |
| `container.credentials`, `services.<id>.credentials` | the plan-time arm64 manifest check would need the registry secret, which the Planner never holds ([Secret custody](#secret-custody)) | the key |
| `container.options`, `services.<id>.options` | free-form `docker create` flags (`--privileged`, `--network host`, …) are an unbounded surface we cannot classify | the key |
| `workflow_dispatch` input of `type: environment` | environments are phase 4 ([07](07-review-integration.md#the-approval-gate-q5)) | the key's value |
| `vars` (configuration variables), anywhere | no source exists: GitHub's variables need an App permission we do not request, and other hosts have none. Resolving `vars.X` to `''` would silently change `if:` results (OQ-11) | static parse of every expression |
| A `github` property or `github.event` path not in the [enumerated set](#the-github-context-and-the-event-projection), including `github.run_number` | the plan does not persist it, so a re-run could not reproduce it and the check-name claim could not account for it | static parse of every expression |
| `runs-on` that resolves to no flavor: an unknown or non-valid custom label, a `group:`, a non-Linux or x86 label, an expression over a runtime context, an empty result, or a signal upgrade that would drop a toolchain the job named | [`runs-on` in engine mode](#runs-on-in-engine-mode-flavor-selection); code `engine-runner-unsupported` | plan-time resolution |
| Step-level `background`, `wait`, `wait-all`, `cancel`, `parallel` | concurrent steps inside one job need a step scheduler in the agent, which is not designed | the key |
| Artifact actions (`actions/upload-artifact`, `actions/download-artifact`, any version) | no artifact server until phase 6, and stock clients may refuse a third-party server even then (OQ-2). A download in a later job would fail after earlier jobs ran, which is a partial execution | owner/name |
| `actions/cache` at a SHA **not** on the evidence list | fail-open behaviour unproven for that SHA | owner/name + SHA |
| Dynamic matrices (`strategy.matrix` from `fromJSON(needs.*.outputs…)`), and a `fail-fast`, `max-parallel` or `continue-on-error` expression not decidable at plan time | the plan would not be deterministic | expression in `strategy` / `continue-on-error` |
| Job-level `continue-on-error` that can be `true` for any leg, on a job another job `needs` | what a dependent sees for a tolerated job failure (`needs.<id>.result`, and whether a default `if:` runs it) is not documented, and a guess would change which jobs run ([continue-on-error](#continue-on-error-raw-and-effective-results), OQ-10) | the plan's `needs` graph and its `continue-on-error` values |
| `concurrency`, at workflow or job level, in any form (string, or `group`, `cancel-in-progress`, `queue`) | it is **cross-run** state: "at most one running job or workflow in a concurrency group at any time", a newer queued member cancels an older pending one, and `cancel-in-progress` cancels a running one ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)). That needs a group-ownership item per repo and group name, a one-slot pending queue, and the [cancellation](#cancellation) protocol applied across plans; none is designed yet (OQ-9). Silently ignoring it would run two deploys at once | the key |
| A matrix that expands to zero jobs, or a workflow with no jobs | nothing would run, and an empty run must never read as a pass (GitHub errors on an empty matrix too) | expansion; code `engine-empty-plan` |
| A matrix expanding to >256 jobs | GitHub's own limit ([limits](https://docs.github.com/en/actions/reference/limits)) | expansion |
| A workflow whose jobs, summed over every job and matrix, exceed 256 | **our** declared limit, not GitHub's: GitHub states its 256 for "a job matrix", and states no limit on a run's total job count. Every per-plan structure is sized against 256 ([Item bounds](#item-bounds)), so a larger plan is refused rather than half-planned | expansion; code `engine-plan-too-large` |
| Expression syntax or functions outside the [subset](#expression-language-subset) | not implemented | static parse of every `${{ }}` and `if:` |
| `uses:` not allowlisted, or pointing at a private repo we hold no grant for | [Q4](#uses-resolution--supply-chain-q4) | resolution |
| `container:` / `services:` image with no verifiable arm64 manifest | [ADR-007](../DECISIONS.md#adr-007) | registry manifest read |
| Any key or value not listed in the Supported or Degraded tables, or in the [recursive census](#recursive-key-census) as Supported, **at any depth** | default-deny | the parser's recursive walk |

### Deliberately out of scope — not a roadmap item (refused the same way)

`pull_request_target`, `schedule` and `merge_group` are not listed here or above, because they are
**triggers**: an unsupported trigger never matches, so it creates no run to refuse
([Trigger sources](#trigger-sources--idempotency-q3), OQ-1, OQ-7).

| Feature | Why never |
|---|---|
| Windows / macOS runners | microVMs are Graviton-only ([ADR-001](../DECISIONS.md#adr-001), [ADR-007](../DECISIONS.md#adr-007)). Already refused above the claim gate today ([03](03-workflow-ingestion.md)) |
| x86_64 execution / emulation | [ADR-007](../DECISIONS.md#adr-007) — surface compat, never silently emulate |
| `runs-on` **groups** semantics (`runs-on: { group: … }`) | we register into the repo-level default group only ([ADR-030](../DECISIONS.md#adr-030)); our own engine has no group concept at all |
| `jobs.<id>.snapshot` (custom image generation) | a GitHub larger-runner feature; our images are built by `build:images`, not by a job |
| GitHub-hosted **larger runners**, GPU labels | not our compute model |
| Self-hosted runner **groups/labels as an access-control boundary** | our tenancy boundary is the installation + repo row, not a label |
| Being a general-purpose GitHub Actions *service* for repos that are happy on GitHub | the point is governance-on-Free and non-GitHub hosts; a repo well served by GitHub's own scheduler should keep using it (see [Q2](#coexistence-with-the-workflow_job-path-q2)) |

### Recursive key census

The census is a versioned data file the parser and its tests share (`census-2026-11-13`), derived
from GitHub's
[workflow-syntax reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
as retrieved on that date: every section heading (96 key paths) plus every subkey and value set
the reference defines only in prose (`concurrency.queue`, the 17 `permissions` scopes,
`workflow_dispatch` input fields, the `cache-mode` values, and the rest below). It distinguishes
two kinds of map, because a census that treated user data as schema would refuse every workflow:

- **Schema objects** have a fixed key set. Each key has a disposition, and any key not in the
  census refuses the run.
- **User-named maps** (`jobs`, `env`, `outputs`, `with`, `strategy.matrix` dimensions,
  `services`, `inputs`, `container.env`) take any key matching the name grammar GitHub states
  for that map; the census classifies the map's *values*, never its key names. A user key that
  breaks the grammar (a job id not matching `^[A-Za-z_][A-Za-z0-9_-]*$`, for example) refuses,
  as GitHub rejects it.

| Position | Kind | Disposition, and closed value set where one exists |
|---|---|---|
| root | schema | `name`, `run-name`, `on`, `permissions`, `env`, `defaults`, `jobs` Supported; `cache-mode` Degraded; `concurrency` Refused |
| `on` (string, list, or map) | schema, keyed by event name | `push`, `pull_request`, `workflow_dispatch` Supported; **every other event name GitHub defines** never matches (below), and its subtree is not interpreted; a name GitHub does not define refuses |
| `on.push` | schema | `branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore` Supported (each a list of strings; `x` and `x-ignore` together refuse, as GitHub rejects them) |
| `on.pull_request` | schema | `types` (values `opened`, `synchronize`, `reopened` Supported; GitHub's other `pull_request` activity types never match), `branches`, `branches-ignore`, `paths`, `paths-ignore` Supported |
| `on.workflow_dispatch` | schema | `inputs` Supported |
| `on.workflow_dispatch.inputs` | user-named (≤ 25) | each value a schema object: `description`, `required` (boolean), `default`, `type` (`boolean`, `choice`, `number`, `string` Supported; `environment` Refused), `options` (with `choice` only) |
| `on.<unsupported event>.*` (`schedule`, `workflow_call`, `workflow_run`, `merge_group`, `pull_request_target`, …) | not interpreted | the event never matches, so nothing under it can affect a run; a workflow whose `on` contains **only** `workflow_call` is a reusable workflow and is Refused like `jobs.<id>.uses` |
| `permissions` | `{}`, a scope map, or `read-all`/`write-all` | scope keys, each `read`, `write` or `none` except `id-token` and `copilot-requests` (`write`, `none`) and `vulnerability-alerts` (`read`, `none`): `actions`, `artifact-metadata`, `attestations`, `checks`, `code-quality`, `contents`, `copilot-requests`, `deployments`, `discussions`, `id-token`, `issues`, `packages`, `pages`, `pull-requests`, `security-events`, `statuses`, `vulnerability-alerts`. Supported only as stated in the Supported table; a scope not on this list refuses |
| `env`, `jobs.<id>.env`, `steps[*].env` | user-named | values: strings, numbers, booleans, or expressions over the contexts the reference allows at that position |
| `defaults`, `jobs.<id>.defaults` | schema | `run` only |
| `defaults.run`, `jobs.<id>.defaults.run` | schema | `shell` (values `bash`, `sh`, `python` Supported; `pwsh`, `powershell`, `cmd` and custom `{0}` templates Refused), `working-directory` Supported |
| `concurrency`, `jobs.<id>.concurrency` | string or schema | Refused whole; its schema keys (`group`, `cancel-in-progress`, `queue` with `single`/`max`) are listed so OQ-9's closing design starts from the census |
| `cache-mode`, `jobs.<id>.cache-mode` | enum | `read`, `write`, `write-only`, `none` Degraded |
| `jobs` | user-named (job-id grammar) | each value a job schema object |
| `jobs.<id>` | schema | `name`, `permissions`, `needs`, `if`, `runs-on`, `outputs`, `env`, `defaults`, `steps`, `timeout-minutes`, `strategy`, `continue-on-error`, `container`, `services` Supported; `cache-mode` Degraded; `environment`, `concurrency`, `uses`, `with`, `secrets` Refused; `snapshot` Out of scope |
| `jobs.<id>.outputs` | user-named | values: strings or expressions |
| `jobs.<id>.strategy` | schema | `matrix`, `fail-fast`, `max-parallel` Supported (as stated) |
| `jobs.<id>.strategy.matrix` | user-named dims plus `include`, `exclude` | dim values: lists of scalars or objects; a matrix that is itself an expression is Refused (dynamic) |
| `jobs.<id>.container` | string or schema | `image`, `env`, `ports`, `volumes` Supported; `credentials`, `options` Refused |
| `jobs.<id>.services` | user-named | each value a schema object: `image`, `env`, `ports`, `volumes`, `command`, `entrypoint` Supported; `credentials`, `options` Refused |
| `jobs.<id>.steps[*]` | schema | `id`, `if`, `name`, `uses`, `run`, `working-directory`, `shell` (same value set as `defaults.run.shell`), `with`, `env`, `continue-on-error`, `timeout-minutes` Supported; `background`, `wait`, `wait-all`, `cancel`, `parallel` Refused; exactly one of `uses` and `run` |
| `steps[*].with` | user-named | values: strings or expressions. `with.args` and `with.entrypoint` exist only for Docker container actions, which are Refused, so they never reach execution |

**Pinning and drift.** The census file records the reference URL, the retrieval date and the
heading list it was built from. A scheduled job (part of phase 1's tooling, not the engine)
re-fetches the reference and fails when its heading set or any listed value set differs, so a key
GitHub adds reaches the census as an explicit Refused entry before anyone can rely on it being
ignored.

**Phase-1 census tests.** The census's heading set equals the reference's; a mutation suite takes
every fixture workflow and, at **every schema-object position the walk visits** (root, each
trigger map, each job, `strategy`, `container`, each service, each step, each `defaults.run`,
`permissions`, each input), inserts an unknown key and asserts the run refuses with
`engine-unsupported-construct` naming that path; it repeats with an out-of-set value at every
enum position (`shell: fish`, `cache-mode: always`, `permissions: { contents: admin }`,
`type: secret`); and it asserts that the same insertion under a user-named map (an extra `env`
variable, an extra matrix dimension) still plans.

### `runs-on` in engine mode: flavor selection

On GitHub, `runs-on` selects a runner: "your workflow will execute on any runner that matches all
of the specified `runs-on` values"
([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idruns-on)).
In engine mode there is no runner pool to match against; the only machines are our flavors. So the
engine reads `runs-on` as a request for a flavor, resolves it once at plan time, and refuses the
run whenever no flavor can honestly satisfy every label. It never ignores a label and never picks
a machine the labels did not ask for.

1. **Shape.** A string, a list of strings, or `{ labels: … }` with no `group`. Each entry is a
   literal or an expression; an expression may read only the plan-time contexts (`matrix`,
   `inputs`, and the enumerated `github` properties below), because the flavor must be known
   before release. An expression over `needs`, `steps`, `env`, `secrets` or `runner` is Refused.
   Each matrix leg is evaluated separately, so `runs-on: ${{ matrix.os }}` resolves per leg.
2. **Labels after evaluation.** Entries are trimmed and lower-cased; empty strings are dropped.
   An empty set is Refused (on GitHub such a job could match no runner).
3. **Architecture and OS gate, first.** The same tokens spec 03's claim gate refuses in every
   mode (`windows-*`, `macos-*`, and the exact x86 tokens `x64`, `x86`, `x86_64`, `x86-64`,
   `amd64`, `i386`, `i686`; `incompatibleRunnerLabel` in `src/ingest/adopt.ts`) refuse the
   **whole run** here. On the `workflow_job` path a refused job stays with GitHub-hosted; under
   the engine nothing else will run a `.lca/workflows` file, so refusal is the only honest outcome.
4. **Every remaining label must be one we satisfy.** Accepted: `self-hosted`, `linux`, `arm64`,
   `aarch64` (true of every flavor, so they select nothing); an explicit LCA label
   (`lambda-ci`, `lambda-ci-<flavor>`); a key of the repo's `FlavorMap`; and the standard hosted
   labels of adopt mode (`ADOPT_LABEL_FLAVORS`: `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`,
   `ubuntu-20.04`), which in engine mode need no `adopt` setting because the repo opted into the
   engine. Any other label refuses the run: on GitHub it would wait for a runner carrying that
   label, and we cannot stand in for someone else's fleet (`gpu`, a custom label).
5. **Flavor.** Spec 03's resolution order, unchanged: `FlavorMap` override, then the most
   specific explicit LCA label (ties by flavor name), then the standard-label map (`base`), then
   the signal upgrade to `docker`, then the repo's valid `defaultFlavor`, else `base`
   ([03 § `runs-on` → flavor routing](03-workflow-ingestion.md#runs-on--flavor-routing)).
   Three deliberate deltas, each because the `workflow_job` path's lenient choice would make a
   planned job run somewhere it did not ask for:
   - a label that names a custom flavor that is not `valid` ([ADR-041](../DECISIONS.md#adr-041))
     refuses the run, instead of degrading to the fallback chain;
   - a signal upgrade that would drop a toolchain the job named (spec 03's `toolchain-dropped`,
     for example `lambda-ci-python` plus `services:`) refuses the run, instead of warning;
   - the resolved flavor must be in the catalog with a published image at plan time, else the
     run is refused (an image deleted later fails that attempt at Provision, as today).
   The `/lca/<env>/config/runner-labels` allowlist is not consulted: it gates `workflow_job`
   claims, and the engine claims nothing from GitHub.
6. **Stored, never re-resolved.** The leg's labels, flavor and resolution reason go into its
   compiled job definition in the plan input, so Provision boots exactly that flavor, a re-run
   uses the same one even if the repo's `FlavorMap` changed since, and the check-run summary and
   console show the reason. Refusal code: `engine-runner-unsupported`, naming the label.

Phase-1 fixtures pin each rule: `ubuntu-latest` → `base`; `[self-hosted, lambda-ci-java]` →
`java`; `labels: [lambda-ci]` → `base`; `${{ matrix.os }}` over `[ubuntu-latest,
ubuntu-22.04]` → two `base` legs; the same matrix with a `windows-latest` leg refuses the whole
run; `[self-hosted, linux, x64, lambda-ci]` refuses; `runs-on: gpu` refuses;
`${{ needs.a.outputs.r }}` refuses; `{ group: big }` refuses as out of scope; an expression that
evaluates to `''` refuses; `lambda-ci-python` with `services:` refuses; a `FlavorMap` edit after
planning does not change a re-run's flavor.

### The `github` context and the event projection

Every `github` property a job can read is either persisted with the run, so planning, release,
the agent and a re-run all see the same value, or Refused. A property the engine cannot
reproduce, or that the check-name claim key cannot account for, is not admitted as an empty
string.

- **The delivered event is persisted verbatim, before anything is planned.** Ingest (or the
  dispatch λ) writes the provider's delivered JSON payload as immutable chunks
  `TRIGGER#<repoKey>#<triggerId>` / `EVENT#<n>` (≤ 300 KB each, at most 3) in the same
  transaction as the trigger batch `Put`, with `eventHash` (SHA-256 of the stored bytes) on the
  batch. A console `workflow_dispatch` stores the payload GitHub would send for that event
  (`inputs`, `ref`, `repository`, `sender`, `workflow`). A payload over 900 KB is refused for
  the whole delivery with `engine-event-too-large`, through the trigger refusal path
  ([Refusal](#refusal-is-a-first-class-outcome)): the batch is `Put` directly as `sealed` with
  `refused: true`, beside its refusal record and `REPORT`, in that one transaction. That limit
  is a stated refusal, never a truncation; most `push` and `pull_request` payloads are tens of
  kilobytes, and the large ones are pushes carrying up to 2048 commits
  ([webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
- **Every delivery size is accounted for, including those the front door rejects.** GitHub caps
  a delivery at 25 MB, but the webhook path is API Gateway HTTP API (10 MB request payload,
  [HTTP API quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html))
  into a synchronous Lambda invoke (6 MB request,
  [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)), so
  three size tiers exist and each has a defined outcome:

  | Delivered size | Reaches Ingest? | Outcome |
  |---|---|---|
  | ≤ 900 KB | yes | normal path |
  | 900 KB to the Lambda ceiling (6 MB less the HTTP API event envelope; the phase-2 boundary test measures the real figure) | yes | Ingest verifies HMAC and refuses `engine-event-too-large`, as above |
  | above the Lambda ceiling, up to 25 MB | **no**: API Gateway answers 413 or 5xx and GitHub records a failed delivery | the **delivery reconciler** below writes the same trigger refusal |
  | above 25 MB | GitHub does not deliver | nothing reaches us, from any path; a residual stated in OQ-13 |

  The **delivery reconciler**, `lca-<env>-deliveryreconciler`, is a scheduled λ (every 5 minutes)
  that reads GitHub's own delivery log for our App, `GET /app/hook/deliveries` with
  `status=failure` ("a status_code in the 400-599 range") and a stored cursor
  (`CONFIG#DELIVERYRECON`), authenticating with the App JWT read from the App PEM parameter
  Provision already reads ([01](01-github-app.md)). GitHub keeps deliveries for 3 days
  ([viewing deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries)),
  and the 5-minute cadence plus a `DeliveryReconcilerStale` alarm at 1 hour keep the cursor well
  inside that. For each failed `push` or `pull_request` delivery whose `repository_id` is a repo
  in `engine` mode and which has no `TRIGGER#` item (the `triggerId` is derived from the
  delivery `guid`, exactly as Ingest derives it), it fetches `GET /app/hook/deliveries/{id}`,
  whose `request.payload` is the payload GitHub tried to send. That read is authenticated by
  TLS and the App JWT, so no HMAC is involved. If the payload is ≤ 900 KB (a delivery that
  failed for another reason, such as an outage) it runs the ordinary Ingest logic; otherwise it
  writes the sealed refused batch, refusal record and `REPORT`, whose check run lands on the
  payload's head sha. Every write is `attribute_not_exists` on the `triggerId`, so the
  reconciler racing a GitHub redelivery, or itself, writes once. If GitHub does not return a
  payload for a delivery, the reconciler records a console-only refusal keyed on the delivery
  id and raises `DeliveryUnrecoverable`, because without a head sha there is no commit to
  report on.

  The reconciler is a provider capability (`listFailedDeliveries` on the port). A provider
  without one gets a stated ceiling equal to its front-door limit, and an alarm on the HTTP API's
  4xx/5xx count for the webhook route, so an over-limit delivery is at least never silent.
- **`github.event` and `GITHUB_EVENT_PATH` are that payload, whole.** The planner evaluates
  plan-time expressions over it, the agent writes it to the event file before step 1, and a
  script that reads any field of the file sees what it would on GitHub. Chunks reach the VM
  through the broker's `event` action, one item per call by keys fixed in the JobSpec, like
  `needs-outputs` ([Agent protocol](#agent-protocol)).
- **The other properties, enumerated.** Supported: `event_name`, `event_path`, `sha`, `ref`,
  `ref_name`, `ref_type`, `base_ref`, `head_ref`, `actor`, `actor_id`, `triggering_actor`
  (the actor who started the attempt, as GitHub defines it, which can differ on a re-run),
  `repository`, `repository_id`, `repository_owner`, `repository_owner_id`, `repositoryUrl`,
  `server_url`, `api_url`, `graphql_url`, `workflow`, `workflow_ref`, `workflow_sha`, `job`,
  `run_id` (our `runId`), `run_attempt`, `token` (the read-only checkout token, a secret to the
  masker), and the in-VM paths `workspace`, `env`, `path`, `action`, `action_path`,
  `action_ref`, `action_repository`. Each is derived from the stored event, the stored plan, or
  the attempt. The matching `GITHUB_*` default environment variables carry the same values.
  **Refused** (the [contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)
  lists them, and nothing in the plan can reproduce them): `run_number` (a per-workflow counter
  we do not keep), `ref_protected`, `secret_source`, `retention_days`, `artifacts`,
  `artifacts_list` and `action_status`. `secrets` is not available in `run-name`, `name` or
  `runs-on`, as on GitHub, so plan-time strings never hold one.
- **What the claim key covers.** The check-name claim key
  ([07 § Check-run names](07-review-integration.md#check-run-names-one-authority-per-name))
  carries `eventHash` and the leg's `jobDefHash` (SHA-256 of its compiled job definition:
  steps, env, resolved action SHAs, flavor). Those two, plus the attempt, determine every input
  above except `run_id`, which a different delivery always changes along with `eventHash`;
  `run_attempt` and `triggering_actor`, which differ only between attempts of one plan, the
  case the claim exists to let replace its predecessor; and secret values, which GitHub too
  reads fresh on a re-run. So two attempts compare equal only when nothing a job can observe
  from its trigger differs.

Phase-1 fixtures: `if: github.event.action == 'reopened'` evaluated over stored `opened` and
`reopened` payloads for one head; `github.run_number` and `github.ref_protected` refuse; a
950 KB payload refuses the delivery with one report. Phase-2 transport boundary tests, against
the deployed webhook route: a delivery just under and just over the measured Lambda ceiling, and
a 9 MB one, each end in exactly one `engine-event-too-large` report (the latter two through the
reconciler, with GitHub's failed delivery as input); a reconciler run racing a GitHub
redelivery of the same `guid` writes one batch; a failed sub-900 KB delivery is planned
normally by the reconciler.

## Expression language subset

`if:` and `${{ }}` need a real evaluator, and this is the part most likely to be subtly wrong, so
the subset is explicit. **Supported**: literals; `[]`/`.`/`*` property and index access;
`!`, `<`, `<=`, `>`, `>=`, `==`, `!=`, `&&`, `||`; and the functions `contains`, `startsWith`,
`endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles`, plus the status checks
`success()`, `always()`, `failure()`, `cancelled()`.

Two rules that prevent the classic fidelity bugs:

- **GitHub's loose equality is copied deliberately**, including its type coercion — `'1' == 1` is
  true there. Implementing strict equality instead would silently change customers' `if:`
  outcomes. Coercion is unit-tested against fixture workflows, not assumed.
- **Syntax or a function we do not implement is a plan-time refusal of the whole run, never a
  guess.** Every `${{ }}` and `if:` is parsed statically during planning, so an unsupported
  construct is found before anything runs. Today's parser drops unresolved `${{ … }}` from a label
  set and Provision refuses such a job pre-mint ([03](03-workflow-ingestion.md)); the engine keeps
  that posture. A *supported* expression that errors at runtime (for example on a malformed
  output) fails its step exactly as on GitHub. `hashFiles` needs a checked-out tree, so it
  evaluates **in-VM at step time**, not at plan time — a planner that pretended to know it would
  produce a wrong `if:`.

## Planning: trigger → run → job list

```
provider event (push / PR / dispatch)
        │
        ▼
 ⓪ activation gates      all five must hold (see Q2) — else no run
        │
        ▼
 ① match workflows       .lca/workflows/** ONLY, at the event's sha (never .github/workflows)
        │                 evaluate `on:` + branch/tag/path filters; twin check vs .github/workflows
        ▼
 ①b classify trust       trusted | fork | restricted-bot, from the event, never from YAML
        │
        ▼
 ② parse + classify      execution-grade parse (spec 03's parser, promoted); every construct
        │                 lands in one matrix class; any Refused construct ⇒ REFUSE the run
        ▼
 ③ expand matrix         static dims × include − exclude, ≤256 jobs per matrix (GitHub), ≤256 per plan (ours)
        │
        ▼
 ④ order DAG             `needs:` topological sort; cycle ⇒ refuse
        │
        ▼
 ⑤ evaluate job `if:`    with `github`/`inputs` known at plan time
        │                 (`needs.*.outputs` are NOT known yet — re-evaluated at release)
        ▼
 ⑥+⑦ persist PlanInput   the complete planning input + job manifest AND the RunPlan,
      + RunPlan          in ONE transaction: both exist or neither does
        │
        ▼
 ⑧ release ready jobs    a job is dispatchable when every `needs` is terminal
                          and the activation gates still hold (see Release)
```

**The plan is computed once and persisted, then jobs are released against it.** Two properties
make this safe:

- **Deterministic given its resolved inputs.** The planner is a pure function of (workflow blob,
  event projection, action resolution): the same three yield a byte-identical plan. The action
  resolution is **not** a function of the workflow and event, because a tag or branch ref such as
  `actions/checkout@v4` can move between two evaluations ([Q4](#uses-resolution--supply-chain-q4)).
  So the plan is keyed by the *delivery* ([Trigger sources](#trigger-sources--idempotency-q3)),
  not by its content, and once stored it is never recomputed: whoever finishes or re-reads a plan
  uses the stored input. Phase 1 is still testable entirely offline, with no AWS and no GitHub,
  because a fixture supplies the action resolution — the card's phase-1 exit criterion.
- **Two-stage `if:` evaluation.** Job-level `if:` referencing `needs.*.outputs` cannot be decided
  at plan time, so step ⑤ decides only what is decidable and the rest is re-evaluated at release
  (⑧). A planner that evaluated everything up-front would be wrong for exactly the workflows that
  use outputs to gate jobs — the common case.

## Trigger sources & idempotency (Q3)

**Decision** ([ADR-056](../DECISIONS.md#adr-056)): the engine is driven by
`push`, `pull_request` and `workflow_dispatch` from our own console. `pull_request_target` is
deliberately **not** in v1: it runs base-repo code with a writable token against fork content,
which is the fork-PR escalation this design must not open. Ordinary `pull_request` from a fork is
supported, but under a separate trust class with no secrets ([Trigger trust](#trigger-trust-forks-bots-and-re-runs)).
**Cron is out of v1** and remains an OQ: owning `schedule` means owning a distributed timer with
catch-up-vs-skip semantics after an outage, and getting it wrong silently double-runs deploy
workflows.

**Identity, and why the M2 triple is not enough.** Today idempotency is
`(repo, run_id, job_id)`, where `run_id` and `job_id` are **GitHub's** numeric ids. With GitHub no
longer dispatching, nobody issues them, so *we* do. The full key design, including attempts, is in
[Run identity, keys & attempts](#run-identity-keys--attempts); the trigger-side rules are:

- **Every run starts from a delivery with a durable identity.** `deliveryId` is the provider's own
  delivery id for a webhook (`X-GitHub-Delivery` on GitHub). A console `workflow_dispatch` has no
  provider delivery, so the console issues one ([Console dispatch identity](#console-dispatch-identity)):
  `deliveryId = lca-dispatch:<dispatchId>`. No run is planned from an event without one.
- **`runId` is derived from the delivery, not counted.** It is a fixed-length hash of
  `(provider, repoKey, workflowPath, deliveryId)`. A redelivered webhook or a retried dispatch
  therefore produces the same `runId`, and the plan write's `attribute_not_exists` condition makes
  the second one a no-op. A monotonic counter cannot give that property without a separate dedupe
  table.
- **One delivery is one trigger batch, with its membership fixed before any plan exists**
  ([Trigger batch](#trigger-batch)). A single push can start several workflows, so "every run for
  this sha is terminal" means nothing unless the set of runs the delivery started is itself
  durable and closed. The batch records it.
- **A plan's input and the plan are written in one transaction.** A plan is one `RunPlan`, up to
  256 `PlannedJob` items and their first attempt rows: more than one transaction holds. Whoever
  finishes an interrupted plan, including the Reaper, must be able to do it with no access to the
  original webhook or console request, because GitHub "does not automatically redeliver failed
  deliveries"
  ([failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)).
  And whoever retries a plan must not recompute any of it: `uses: actions/checkout@v4` names a tag
  that can move between two evaluations ([Q4](#uses-resolution--supply-chain-q4)), so two
  computations of "the same" plan can resolve different action SHAs. So the Planner computes the
  whole plan in memory and writes it in this order:
  1. **Plan commit (one transaction).** `Put` the plan-input chunks `PLAN#<repoKey>#<runId>` /
     `INPUT#<n>` (each under 300 KB; at most 4), `Put` the `RunPlan` in state `planning` carrying
     `inputChunks` and `inputHash`, `Put` the plan's `RELEASE` obligation item
     ([Release](#release)), `Put` the run's output counter `OUTBYTES` with `bytes = 0`
     ([Deadlines and outputs](#deadlines-and-outputs)), `Update` this workflow's `MEMBER#<n>` row
     `pending → planned` (condition `state = pending`) and decrement the batch's `remaining`
     ([Trigger batch](#trigger-batch)), every `Put` with
     `attribute_not_exists`. DynamoDB's item limit is 400 KB and a transaction's aggregate item
     size "can't exceed 4 MB"
     ([transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)),
     so four 300 KB chunks plus five small items fit with room to spare, and a plan whose input
     needs a fifth chunk is Refused with `engine-plan-too-large`. The input holds the canonical
     event projection (provider, event type, sha, ref, base and head repo ids, sender, PR number,
     delivery id, and for a console `workflow_dispatch` the typed `inputs` and the requesting
     login) and the `eventHash` of the delivered payload, which stays in the trigger batch's
     `EVENT#` chunks ([The `github` context](#the-github-context-and-the-event-projection)), the
     trust class, the workflow blob sha and content hash, every resolved action SHA,
     and the **job manifest**: one entry per job with `jobId`, `jobKey`, `matrixIndex`, matrix
     values, `needs` as job ids and the plan-time `if:` result, plus each distinct `jobKey`'s
     compiled job definition, stored once. `inputHash` is computed over the exact bytes being
     committed. Either the whole input and the plan exist, or nothing does: a crash before the
     commit leaves no chunk behind, and a crash after it leaves a complete plan.
  2. **Materialise**, one 2-action transaction per job: `PlannedJob` with `latestAttempt = 1`, and
     the attempt-1 row in release state `waiting` ([Release](#release)), both `attribute_not_exists`;
     plus one `Put` per matrix job definition of its `GROUP#<hash(jobKey)>` item
     ([Matrix groups](#matrix-groups-max-parallel-and-fail-fast)), also `attribute_not_exists`.
  3. `planning → planned`, which arms the plan's release obligation in the same transaction.

  **A retry never compares a fresh computation with the stored one; it adopts the stored one.** A
  redelivery or Reaper pass that recomputes the plan and fails step 1's condition (the `RunPlan`
  exists) discards its in-memory plan, reads the stored chunks by primary key, verifies
  `inputHash`, and resumes step 2 **from the stored manifest alone**. A recomputation that saw a
  moved tag therefore cannot mix its resolution into the stored plan, and cannot wedge on a hash
  mismatch either, because it never writes. A plan left `planning` past its due time is found by
  the Reaper through GSI1 partition `PLANS#planning` (re-stamped to `PLANS#<repoKey>` at
  `planned`, the re-stamp-on-transition pattern run rows use, [ADR-014](../DECISIONS.md#adr-014)),
  and finished the same way; it never re-fetches the workflow and never needs the event. Nothing is
  released from a `planning` plan, so a crash mid-write can delay a run but never run half of one.
  A crash before step 1 commits is recovered through the trigger batch, whose `pending` member is
  planned afresh: no input for it was ever persisted, so planning it later, with whatever the tag
  resolves to then, is simply planning it once.
- **Dispatch reads the same stored input.** Provision builds each JobSpec from the `PlannedJob` and
  the stored job definition, never from the git host and never from the queue message beyond the
  attempt key. A force-push, a deleted fork or an edited workflow file after planning therefore
  cannot change what runs, and a Reaper re-enqueue ([Release](#release)) rebuilds exactly the same
  JobSpec.
- **`jobId` is a deterministic hash of `(runId, jobKey, matrixIndex)`.** A retried plan release
  computes the same id, so it cannot mint a second row for the same logical job.
- **Retries are attempts, not new jobs.** A re-run keeps `jobId` and increments `attempt`
  ([below](#run-identity-keys--attempts)).

### Trigger batch

A delivery can match several workflows (`ci.yml` and `lint.yml` both on `push`), and the planner
writes one `RunPlan` per workflow, in separate transactions. Anything that judges the delivery as
a whole (the PR verdict in [07](07-review-integration.md#when-we-submit-a-review)) needs to know
when it has seen every plan the delivery will ever create. Counting the plans that exist cannot
tell it: the first plan can finish before the second is written. So membership is recorded first
and closed explicitly.

- **Item.** `TRIGGER#<repoKey>#<triggerId>` / `TRIGGER`, where `triggerId` is a fixed-length
  hash of `(provider, repoKey, deliveryId)`. It holds the canonical event projection (the same
  fields the plan input carries) and `eventHash`, with the delivered payload itself beside it as
  immutable `EVENT#<n>` chunks written in the same transaction
  ([The `github` context](#the-github-context-and-the-event-projection)), a state
  `matching | planning | sealed`, and, once matched, `remaining` (the count of `pending`
  members) and the `diff` summary of [Path filters](#path-filters-the-changed-file-set) when one
  was computed. **Members are rows, not a list on the batch**:
  `TRIGGER#<repoKey>#<triggerId>` / `MEMBER#<n>` (n = 0..63), each with its workflow path
  (≤ 512 bytes, else the delivery is refused `engine-workflow-path-too-long`), its blob sha at
  the event's sha, its `runId`, its path-filter decision and a state
  `pending | planned | refused`, so the batch item's size does not grow with the delivery. A
  matching workflow that fails to parse or is refused is still a member; it ends `refused`,
  never absent.
- **Written by whoever first receives the event, before anything is enqueued.** Ingest `Put`s the
  batch in state `matching` (event projection, `eventHash`, no members) and its `EVENT#<n>`
  payload chunks, all with `attribute_not_exists` in one transaction, then
  enqueues the `triggerId` to the Planner; for a console dispatch the dispatch λ does the same
  ([Console dispatch identity](#console-dispatch-identity)). A redelivered webhook fails the
  condition and only re-enqueues. From this point on the event exists in the table, so nothing
  downstream depends on a queue message surviving.
- **Membership is fixed once.** The Planner lists `.lca/workflows/**` at the event's sha, evaluates
  `on:` and its filters (step ①, path filters over the changed-file set below), and writes the
  `MEMBER#<n>` rows, `remaining`, `diff` and `matching → planning` in one transaction on
  condition `state = matching` (≤ 64 member Puts plus the batch Update, inside DynamoDB's 100-item
  transaction limit). A retry that finds the batch already `planning` uses the stored
  member set and never re-matches, so the set cannot change after it is written. A delivery that
  matches no workflow goes straight to `sealed` with no members; an empty batch judges nothing,
  and a PR whose batches are all empty gets no verdict at all
  ([07 § When we submit a review](07-review-integration.md#when-we-submit-a-review)). A delivery matching more than 64
  workflows is refused whole (`engine-too-many-workflows`, with its own refusal record and report
  obligation keyed on the trigger, [Refusal](#refusal-is-a-first-class-outcome)) and sealed with
  `refused: true` in that same transaction, which moves the batch from `matching` straight to
  `sealed` with no members, so a PR verdict reads it as a failure, never as empty.
- **Each member is closed by its own plan commit.** Step 1 above decrements `remaining` and sets
  the member `planned` in the same transaction that creates the plan (condition: member
  `pending`). A refused member is closed by the transaction that writes its refusal record.
- **Sealing is the barrier.** When `remaining = 0`, an `Update` sets `state = sealed` on that
  condition. Whoever closes the last member seals; sealing is idempotent, so two racing closers
  both succeed or one no-ops. A sealed batch's plan set is final. For a pull-request batch the
  sealing transaction also marks the PR's head projection as owing a reporter pass
  ([07 rule 2](07-review-integration.md#when-we-submit-a-review)).
- **Durable while open.** The batch carries the sparse GSI1 key `TRIGGERS#open` / `dueAt`
  until sealed. The Reaper re-enqueues any batch still open past its `dueAt`; the Planner resumes
  it from its stored state (matching it if `matching`, planning its `pending` members from the
  stored event projection and member blob shas if `planning`) and seals it.
- **A batch for a pull request is known to the PR before it is planned.** For a `pull_request`
  delivery, Ingest's batch `Put`, a `HEADTRIG#<headSha>#<triggerId>` row under the PR, and its
  update of the PR's head projection ([07 rule 1](07-review-integration.md#when-we-submit-a-review))
  are one transaction: a new head sha sets `headSha` and resets the projection's batch count and
  `triggersSeq`, the same sha increments them, and an out-of-order delivery for an older sha
  writes the batch but neither the row nor the projection. A batch the Planner has not planned
  yet is therefore already a member of the PR's verdict, and reads as not sealed. The batch ids
  are rows rather than a list on the projection because close/reopen and redelivery add batches
  to one head without bound.
- **What a PR verdict covers.** The `pull_request` batches for the head sha, and nothing else.
  GitHub also sends a `push` for the PR's branch, and its runs get check runs on the same sha, but
  a `push` delivery is not tied to a PR when it arrives, so it is not a verdict member. That is a
  deliberate, stated boundary: the verdict judges the workflows the PR event started.

### Path filters: the changed-file set

`paths` and `paths-ignore` are evaluated over a set of changed files, and the event payload does
not contain that set: a push's `commits` array "includes a maximum of 2048 commits" and a
`pull_request` payload lists no files
([webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)). So the
Planner computes it from the repository, with GitHub's documented semantics
([git diff comparisons](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons)),
through one provider operation, and records what it decided.

**Which diff.** All SHAs come from the stored event, never from a live ref, so the answer is a
function of immutable commits.

| Event | Diff | Source of `base` / `head` |
|---|---|---|
| `push` to an existing branch | two-dot: tree of `base` vs tree of `head` | `before` / `after` (a forced push is handled the same way; a tree diff does not need ancestry) |
| `push` creating a branch (`created: true`), `commits` non-empty | two-dot against "the parent of the ancestor of the deepest commit pushed" | first parent of the oldest entry in `commits` (≤ 1,000 entries here, so the array is complete) / `after` |
| `push` creating a branch, `commits` empty | not determinable from the payload | outcome `undetermined` ⇒ run (below); pinned by a conformance fixture (OQ-12) |
| `push` of a tag | none: "Path filters are not evaluated for pushes of tags" | path filters ignored, as on GitHub |
| `push` deleting a ref (`deleted: true`) | none | the delivery is refused for any workflow its branch/tag filters match (`engine-push-delete-unsupported`); GitHub's run SHA for a deleted branch "reverts to the default branch" ([events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)), which is a second, undesigned context (OQ-12) |
| `pull_request` | three-dot: tree of `mergeBase` vs tree of `head` | `pull_request.base.sha` / `pull_request.head.sha`; `mergeBase` from the provider's merge-base of the two |

**GitHub's limits, reproduced.**

- A push with more than 1,000 commits always runs. `commits` holds up to 2048 entries, so
  `commits.length > 1000` detects it exactly. Outcome `too-many-commits`.
- "If generating the diff times out, the workflow will **always** run." Our diff has a budget
  (60 s of wall time and 500 provider calls); exceeding it is outcome `timeout`. A persistent
  provider failure after bounded retries (404 for a garbage-collected sha, repeated 5xx) is
  also treated as `timeout`, so every failure lands on an outcome GitHub can produce: the
  workflow runs. Rate-limit and 5xx responses are retried with backoff inside the budget.
- Only the first 3,000 changed files are evaluated. GitHub does not document the order, so we
  fix one: byte-wise ascending path order. A workflow whose only matching file sorts past
  position 3,000 does not run, which is GitHub's stated behaviour for that case; whether
  GitHub's own order would have included it is a declared conformance gap (OQ-12).
- `outcome = ok` with zero changed files means no path filter matches: "If there are no files
  changed, the workflow will not run."

**How the GitHub provider computes it.** The compare API is unsuitable as the file source: its
response "will return up to 300 files for the entire comparison"
([commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits)), below the
3,000 GitHub evaluates. It is used only for `merge_base_commit` on a pull request. The files come
from the Git trees API: `GET …/git/trees/{sha}?recursive=1` for both sides, compared by path and
blob sha. A recursive response is capped at "100,000 entries with a maximum size of 7 MB"
([trees](https://docs.github.com/en/rest/git/trees)) and says so with `truncated: true`; then the
provider walks non-recursively, descending only into subtrees whose sha differs between the two
sides, within the same budget. A rename is a delete plus an add, so both paths are in the set;
GitHub's treatment of a rename's old path is pinned by a fixture (OQ-12).

**Computed lazily, recorded once.** The diff is computed only if some workflow that passes its
event, type and branch/tag filters has a path filter. Its summary is written on the batch with
the membership, in the same transaction: `diff = { kind, base, head, mergeBase, commitCount,
outcome, total, evaluated, filesHash }`, where `filesHash` is the SHA-256 of the evaluated,
ordered path list. Each member row records its decision (`matched` with the first matching
path, `unmatched`, `not-evaluated` for a tag push, or `forced` with the outcome that forced the
run). The full file list is not stored: membership is written once, so no later step needs it,
and recomputation before that point reads immutable commits. A retry that recomputes and gets a
different `outcome` (a transient timeout the first time) can only happen before membership
commits, so whichever computation commits is the decision. The console's batch view shows the
summary, so an unexpected run or skip is explainable.

**Provider operation.** `changedFiles(repo, spec, budget)` on the port
([Provider abstraction](#provider-abstraction)), with `spec` one of
`{ kind: 'two-dot', base, head }` or `{ kind: 'three-dot', base, head }`, returning the outcome,
the evaluated paths (≤ 3,000, ordered), `total` and `mergeBase`. A provider that cannot
implement it declares `supportsPathFilters: false`, and every workflow with a path filter in a
repo on that provider is refused (`engine-path-filter-unsupported`) rather than run or skipped
by guess.

Phase-1 conformance fixtures, each also run on GitHub-hosted runners to record GitHub's answer:
push to an existing branch touching a matching and a non-matching file; forced push; new branch
with commits; new branch at an existing commit (`commits` empty); tag push with `paths`; 1,001
commits; an injected diff timeout and a 404 on `before`; 3,001 changed files with the only
matching file sorting last; a fork PR whose base advanced after branching (the three-dot diff
excludes the base's changes); a rename across a `paths` boundary; a branch deletion.

### Console dispatch identity

A webhook arrives with a provider delivery id; a console `workflow_dispatch` does not, and a lost
HTTP response followed by a retry must not plan the same intended run twice. So the console request
carries a client idempotency key, and the control plane turns it into a durable dispatch record
before anything is enqueued.

1. **Client key.** The SPA mints a UUIDv4 `clientRequestId` when the operator submits the dispatch
   form and reuses it for every retry of that submission (it is kept with the form state until a
   response arrives, and discarded after 24 hours). A new submission is a new key.
2. **Durable record before enqueue.** The console authenticates the operator and checks they
   administer the installation ([ADR-022](../DECISIONS.md#adr-022)), then invokes a single-purpose
   control-plane λ, `lca-<env>-dispatch`, on its exact ARN (the appcfg broker pattern,
   [ADR-034](../DECISIONS.md#adr-034); the console never writes engine rows). In one transaction
   the λ `Put`s `DISPATCH#<repoKey>#<hash(login, clientRequestId)>` / `DISPATCH` and the trigger
   batch for `deliveryId = lca-dispatch:<dispatchId>` ([Trigger batch](#trigger-batch)), both with
   `attribute_not_exists`. The dispatch record holds the requesting login, `workflowPath`, `ref`,
   the typed `inputs`, `requestHash` (a hash of those four), a server-issued `dispatchId` (random,
   128 bits), the `triggerId`, and a TTL of 7 days. Scoping the key by login means one operator's
   key can never collide with another's.
3. **Replay returns the original.** If the transaction fails its condition (a retry, or two
   concurrent submissions of one key), the λ reads the stored record. Same `requestHash`: it
   returns the stored `dispatchId` and re-enqueues the stored `triggerId`, which is safe because
   the delivery id, and so every `runId`, is the same. Different `requestHash`: it refuses with
   `dispatch-key-reused` and plans nothing.
4. **Enqueue.** The λ then enqueues the `triggerId` to the Planner and returns the `dispatchId`. A
   crash between the transaction and the enqueue leaves an open batch, which the Reaper re-drives
   through `TRIGGERS#open`; a lost response is answered by the retry in step 3.
5. **Retention.** The record outlives any client retry: the SPA retries a key for at most 24
   hours, and the record is kept for 7 days. A replay after expiry would be a new dispatch; the
   client never sends one, because it discarded the key.
6. **Grants, matched to those operations.** The dispatch λ holds `PutItem` and `GetItem` on the
   table with `dynamodb:LeadingKeys` limited to `DISPATCH#*` and `TRIGGER#*` (the transaction's
   `Put`s, the batch's `EVENT#` chunks among them since they share its `TRIGGER#` key, and the
   replay read), `GetItem` on `INSTALL#*` (the repo row's `mode`/`engineEnabled`),
   and `sqs:SendMessage` on the Planner queue; nothing else. The console λ gains only
   `lambda:InvokeFunction` on its exact ARN.

## Trigger trust: forks, bots and re-runs

GitHub deliberately withholds secrets from untrusted triggers: "With the exception of
`GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from a forked
repository", and "Secrets are not available to workflows triggered by Dependabot events"
([using secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#using-secrets-in-a-workflow)).
An engine that resolved every named secret into every job would hand a tenant's secrets to anyone
who can open a pull request. So every run gets a **trust class** at plan time, before any secret is
looked up, and the class is computed from the event, never from the workflow YAML (which the
untrusted party may have written).

| Class | Assigned when | Secrets | `vars` | Repo token | OIDC | Workflow definition read from |
|---|---|---|---|---|---|---|
| `trusted` | `push` to the repo; `pull_request` whose head repo **is** the base repo and whose sender is not a restricted bot; console `workflow_dispatch` by an installation admin ([ADR-022](../DECISIONS.md#adr-022)) | named secrets only ([Secret custody](#secret-custody)) | Refused in v1 for every class (OQ-11) | read-only, single repo | phase 6 issuer only | the event's sha |
| `fork` | `pull_request` whose `head.repo.id` differs from `base.repo.id`, **or** whose head repo is absent (deleted fork) | **none**; `secrets.*` evaluates to `''`, as on GitHub | **none** | read-only, single repo (the base repo; the fork's commits are reachable from `refs/pull/<n>/head`) | **never** | the event's sha |
| `restricted-bot` | sender login is `dependabot[bot]`, or is on the installation's restricted-bot list | **none** | **none** | read-only | **never** | the event's sha |

Rules that close the gaps the class alone would leave:

1. **Fork detection compares repository ids, never names.** A fork can be renamed to the base's
   name; ids cannot be forged in a signed webhook. An absent head repo is treated as `fork`
   (fail closed).
2. **The class is fixed at plan time and stored on the plan.** Releases, retries and re-runs
   inherit it. **A re-run never upgrades trust**, even if a trusted user clicks the button: GitHub
   documents that "Re-runs use the privileges of the actor who initially triggered the workflow,
   not the privileges of the actor who initiated the re-run"
   ([re-running](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)),
   and we copy that rule deliberately.
3. **Untrusted runs do not run by default.** Each repo has a `forkPolicy`:
   - `skip` (default): the run is recorded as `refused` with code `engine-untrusted-trigger`, and a
     neutral check run named `LCA: fork approval · <workflowKey> · <context>` (system namespace, never a job's name, because
     `neutral` satisfies a required check, [07](07-review-integration.md#check-run-names-one-authority-per-name)),
     delivered through the refusal's report obligation ([Refusal](#refusal-is-a-first-class-outcome)), explains that an
     installation admin can approve it;
   - `approve`: the run is planned, held before any dispatch, and released only after an
     installation admin approves **that head sha** in the console. A new push to the PR produces a
     new run that needs a new approval;
   - `run`: untrusted runs dispatch without approval, still with no secrets.
   Approval never changes the class: an approved fork run still gets no secrets, no `vars`, no OIDC.
4. **No write token ever reaches an untrusted run.** The checkout token is read-only for every
   class. Unlike GitHub, we do not give fork runs any write scope at all, so a fork cannot use our
   token to push, label, or comment.
5. **Workflow source for `pull_request` is the PR's merge or head sha**, as on GitHub, so the PR
   author controls the YAML. That is safe only because of rules 3 and 4: the author can change what
   runs, never what it receives.
6. **`pull_request_target` stays out of v1**, because its whole purpose is to give base-repo
   privileges to a run that touches fork content. Supporting it would mean running the *base* sha's
   workflow with secrets while never checking out fork code by default; that needs its own design
   and is not needed to close the governance gap.

## Coexistence with the `workflow_job` path (Q2)

**Decision** ([ADR-056](../DECISIONS.md#adr-056)): coexist, per repo, via a **new `RepoMode`
value, `engine`**, and make dual execution impossible by **where the engine reads workflows
from**, not by asking GitHub not to schedule.

`RepoMode` is `'label' | 'adopt' | 'off'` today (`src/shared/types.ts`); v1 adds `'engine'`.

| Mode | Who schedules | Who executes |
|---|---|---|
| `off` | GitHub | GitHub-hosted |
| `label` | GitHub | us, for LCA-labelled jobs |
| `adopt` | GitHub | us, for standard-label jobs too ([ADR-030](../DECISIONS.md#adr-030)) |
| **`engine`** | **us**, for files under `.lca/workflows/` | **us** |

### Why claim-gate guards alone could not prevent dual execution

The first draft relied on two guards inside LCA: Ingest refuses `workflow_job` in `engine` mode,
and the planner refuses non-`engine` repos. Both are correct, and neither is enough. GitHub
schedules any workflow under `.github/workflows` itself: "GitHub searches the `.github/workflows`
directory in the root of your repository for workflow files" when an event occurs
([workflows](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows)). If the
engine also read that directory, one push would start the same workflow twice: once on our engine,
once on GitHub-hosted runners that LCA never sees. A deploy workflow would deploy twice.

### The fix: the engine reads only `.lca/workflows/`

**In `engine` mode the planner reads workflow definitions from `.lca/workflows/**` and never from
`.github/workflows/**`.** GitHub's scheduler searches only `.github/workflows`, so a file under
`.lca/workflows` is invisible to it. Each file therefore has exactly one scheduler:

| File location | GitHub schedules it? | LCA engine schedules it? |
|---|---|---|
| `.github/workflows/x.yml` | yes, as today | **never** |
| `.lca/workflows/x.yml` | **never** (outside the directory GitHub searches) | yes, when every activation gate below holds |

That is the proof the review asked for. It needs no customer action on GitHub and no assumption
that Actions is disabled. It does have a cost, stated plainly: adopting `engine` mode is a file
move (`git mv .github/workflows/ci.yml .lca/workflows/ci.yml`), not a toggle. The YAML grammar is
unchanged, so moving back is equally cheap. On non-GitHub hosts the same directory is used, so a
repo's workflows mean the same thing on every host.

### Activation gates (`engineEnabled` semantics)

A run is planned only when **all five** hold at plan time. Any failure means no run, which is the
fail-closed direction: a missed engine run is visible and recoverable, a doubled deploy is not.

1. `RepoRecord.mode === 'engine'`.
2. `RepoRecord.engineEnabled === true`. This is a kill switch, independent of `mode`, in the same
   shape as `rewriteEnabled` ([ADR-031](../DECISIONS.md#adr-031)). Absent means `false`. Turning it
   off stops new plans and new releases at once; jobs already running finish, and their reports
   still post.
3. The deployment was synthesised with the engine flag (`-c engine=true`); absent, the Planner λ
   does not exist.
4. The repo is not on the platform deny list. `jsamuel1/LambdaCIActions` is on it permanently
   ([ADR-059](../DECISIONS.md#adr-059)).
5. **Twin check.** No file under `.github/workflows/` at the same sha has the same basename as the
   engine file. A twin is the signature of a half-finished migration (the file was copied, not
   moved) and would run on GitHub too, so the whole run is refused with code
   `engine-twin-workflow` and the refusal names both paths. This is a guard against a
   configuration mistake, not the proof: the proof is the directory split above.

The gates are re-checked at **every job release**, not only at plan time, so flipping
`engineEnabled` off mid-run stops the jobs that have not started.

### The remaining guards, kept for defence in depth

- **The claim gate refuses `workflow_job` in `engine` mode.** `decideClaim` (`src/ingest/adopt.ts`)
  gains an early refusal with code `engine-mode-conflict`, recorded on the Unclaimed screen
  ([ADR-050](../DECISIONS.md#adr-050)). In `engine` mode the only `workflow_job` events are from
  files still under `.github/workflows`, which GitHub schedules and its own runners execute; we
  must not *also* claim them, because then a GitHub-scheduled job would land on our compute without
  the operator having chosen `label`/`adopt` for it.
- **The planner refuses any repo not in `engine` mode**, so a mis-routed event cannot create a
  shadow run.

A repo can therefore mix paths safely: files under `.github/workflows` keep running on GitHub's
scheduler and GitHub-hosted runners, files under `.lca/workflows` run on ours, and no file runs on
both.

## Run identity, keys & attempts

The first draft gave engine rows an `ERUN#` prefix but left every existing writer deriving
`RUN#`, so the Reaper would discover an engine row through the status index and then write its
terminal state to a `RUN#` key that does not exist. It also had no attempt dimension, so a re-run
could only overwrite the attempt it replaced. This section fixes both by giving every engine row
one key, derived by one function, used by every writer and reader.

### One key type, one derivation

```ts
type RunKey =
  | { source: 'github'; repoId: number; runId: number; jobId: number }          // shipped path
  | { source: 'engine'; repoKey: string; runId: string; jobId: string; attempt: number };

function runRowKey(k: RunKey): { pk: string; sk: 'RUN' };
```

| Source | Partition key | Unchanged? |
|---|---|---|
| `github` | `RUN#<repoId>#<runId>#<jobId>` | **yes**, byte for byte |
| `engine` | `ERUN#<repoKey>#<runId>#<jobId>#<attempt>` | new |

- **`repoKey`** is `<provider>-<repoId>` (`gh-42`, `gitea-17`). Provider repo ids are only unique
  within a provider, so a bare numeric id would let a Gitea repo collide with a GitHub repo. For
  GitHub it is still derived from the numeric id, so GitHub engine rows sort beside their repo.
- **`runId`** and **`jobId`** are 20 lowercase base32 characters each (100 bits of the hashes
  above). Fixed length and a fixed alphabet make the ref grammar a strict regex.
- **`attempt`** starts at 1 and is a decimal integer.

### Every direct reader and writer, and what it uses

The rule: **a writer never re-derives a key from loose ids.** Each one is handed a `RunKey`, or
reads the stored `pk` off a row it already holds.

| Today's helper / caller | Engine behaviour |
|---|---|
| `runPk`, `buildQueuedItem`, `putQueuedRun` | replaced by `runRowKey(k)`; the GitHub branch returns the same string as `runPk` today |
| `transitionRun`, `stampMicrovmId`, `getRun` | take a `RunKey` instead of `(repoId, runId, jobId)` |
| Ingest `handleStatusUpdate` | builds a `{source:'github'}` key from the webhook; it can never name an engine row, because engine runs have no `workflow_job` |
| **Reaper** reconciliation (`src/reaper/handler.ts`) | **writes by the row's stored `pk`**, which it already fetched through GSI1 (projection `ALL`). It never rebuilds a key from `repoId/runId/jobId`, so it cannot mis-target either source |
| JIT ref (`jitConfigRef`, `putJitConfig`) | GitHub only, unchanged |
| JobSpec ref (new) | `<engine pk>#SPEC`, stored under the engine row's partition, TTL'd like the JIT item |
| Broker ref grammar (`isRunRef`) | a third arm: `^ERUN#[a-z]+-\d+#[a-z2-7]{20}#[a-z2-7]{20}#\d+#SPEC$`. `keysFromRef` gains the matching split on `#SPEC` (today it splits on `#JITCONFIG` only), so a VM's token still addresses exactly its own partition |
| Provision queue message | `ProvisionRequest` gains `source` and an engine variant carrying `repoKey`, string `runId`/`jobId` and `attempt`. Absent `source` means `github`, so in-flight messages from before the change stay valid |
| SQS `MessageDeduplicationId` | engine: the engine pk (which includes the attempt), so a re-run is not deduplicated against the first attempt |
| Refusal rows | engine refusals key on the **plan**, `REFUSAL#ERUN#<repoKey>#<runId>`, because a refused run has no jobs; GitHub refusals unchanged |
| Console API + SPA | separate engine routes; see below |
| Reports, cost, dashboard counts | read rows through GSI1/GSI2, unchanged; they group by the stored `source` |

### Attempts

A re-run creates a **new row** with `attempt + 1`. The earlier row is never mutated, so its logs,
conclusion and cost stay as evidence of the flake.

- **What a re-run of one job re-runs.** As on GitHub, the jobs that depend on it re-run too; jobs
  that are not re-run keep their outputs from the previous attempt: "When you re-run failed jobs or
  a specific job, GitHub also re-runs the jobs that depend on them. Jobs that aren't included keep
  their outputs from the previous attempt"
  ([re-running](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)).
  Each re-run job gets its own new attempt row. A re-run is accepted only while the plan is
  terminal and no other re-run of it is allocating; otherwise it is a no-op logged `rerun-busy`.
- **Latest-attempt projection.** Each `PlannedJob` stores `latestAttempt`. Invariant: **it never
  names an attempt row that does not exist.** A posted latest-attempt URL, the stale-click check and
  dependent release all read it, so a projection that ran ahead of its row would strand all three.

### Re-run allocation

A re-run touches one projection and one new row per job in the re-run set (the clicked job plus its
transitive dependents, up to the 256-job plan cap). That is up to 512 writes, and
`TransactWriteItems` "groups up to 100 action requests"
([TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)),
so the set cannot be one transaction. Allocation is therefore a durable record followed by
idempotent per-job steps, each of which is atomic:

1. **Reserve (one transaction, 3 actions).** `ConditionCheck` the clicked `PlannedJob`
   (`latestAttempt = :clicked`); `Update` the `RunPlan` (`rerunSeq = :seen`, plan terminal,
   `activeRerun` absent, attempt cap not reached) to set `rerunSeq = :seen + 1`,
   `activeRerun = :seq` and the plan state back to `running`; `Put` an allocation item
   `PLAN#<repoKey>#<runId>` / `RERUN#<seq>` with `attribute_not_exists`. The allocation item lists
   every `{jobId, attempt}` in the set, with each attempt fixed as that job's `latestAttempt + 1`,
   plus the clicking login and `state: allocating`. Those `latestAttempt` values are read before
   the transaction, and they cannot move under it: only an allocation advances them, and the
   `RunPlan` condition admits one allocation at a time. The item carries the sparse GSI1 key
   `RERUNS#allocating` / `dueAt`. A double click, a redelivery or an older attempt's button
   fails a condition and is a no-op (`rerun-stale`), so one click yields one allocation. Moving the
   plan to `running` here, not later, also keeps the review evaluator
   ([07](07-review-integration.md#when-we-submit-a-review)) from judging the sha mid-allocation.
2. **Materialise (one transaction per job, 2 actions).** `Put` the attempt row
   `ERUN#…#<attempt>` in release state `waiting` ([Release](#release)), recording the allocation's
   `rerunSeq` (which scopes its matrix group's fail-fast, [Matrix groups](#matrix-groups-max-parallel-and-fail-fast)), with
   `attribute_not_exists(pk)`, and `Update` that job's
   `PlannedJob` to `latestAttempt = :attempt` on condition `latestAttempt = :prev`, where the
   writer supplies `:prev = :attempt − 1` (a condition expression has no arithmetic). The row
   and its projection move together or not at all, so the invariant holds after every crash. A
   step whose row already exists is skipped, which makes the whole pass safe to repeat.
3. **Complete and arm release (one transaction, 3 actions).** Set the allocation item to
   `state: done` and remove its GSI1 key; on the `RunPlan`, clear `activeRerun`; and arm the
   plan's `RELEASE` obligation item ([Release](#release)). Clearing the allocation obligation
   and recording the release obligation are one write, so no crash point loses both.
4. **Release** is the ordinary release pass ([Release](#release)), driven by that obligation. It
   releases jobs in the set whose `needs` are satisfied (a need outside the set keeps its previous
   attempt's result and outputs); the rest stay `waiting` until their needs finish.

**Recovery is deterministic, because the record fixes every attempt number before any row is
written.** Whoever finds an allocation still `allocating` (a webhook redelivery that finds
`RunPlan.activeRerun` set, or the Reaper querying GSI1 `RERUNS#allocating` for items older than
a threshold) re-runs steps 2–3 from the stored set. A crash after the reservation, or between any
two jobs of a multi-job fan-out, therefore leaves at most some jobs not yet materialised, never a
projection pointing at nothing, and is finished by the next pass rather than stranded. A crash
after step 3 leaves the release obligation armed, which the release pass or the Reaper consumes.

### Release

An attempt row exists before it may run: plan materialisation and re-run allocation both create
every attempt they will need up front, including dependents whose `needs` have not finished. So
"this row exists and is not running" cannot mean "this row should be dispatched", and recovery
must never infer dispatch from row presence. Each engine attempt row carries a **release state**
beside its unchanged `RunStatus`:

| Release state | Meaning | `RunStatus` | GSI1 key |
|---|---|---|---|
| `waiting` | created; some `need` is not terminal, the plan is `held`, its matrix group has no free slot, or it was just approved and awaits the release pass | `queued` | **none** (sparse) |
| `held` | needs satisfied; waiting for an installation admin (an `environment:` job, [07](07-review-integration.md#the-approval-gate-q5)). Approval returns it to `waiting` with `gateApproved`, never straight to `released` | `queued` | **none** |
| `released` | may be dispatched | `queued`, then onward | `RUNSTATUS#queued`, then onward |

A `waiting` or `held` row is not in GSI1 at all. Every reader that scans by status (the Reaper,
the dashboard's active count, cost) therefore never sees it, and the shipped vocabulary needs no
new value. The console reads the row by primary key and shows "waiting on `<need>`" or "awaiting
approval".

**The release obligation is durable, and it is its own item.** GSI1 has one key pair per item
(`gsi1pk`/`gsi1sk`, `lib/data-stack.ts`), and the `RunPlan`'s pair is already spent on plan
discovery (`PLANS#planning`, then `PLANS#<repoKey>`). A second logical index entry on the same
item would silently overwrite the first, so the release obligation lives on a separate item,
`PLAN#<repoKey>#<runId>` / `RELEASE`, created in the plan commit
([Trigger sources](#trigger-sources--idempotency-q3)) with `releaseSeq = 0` and no GSI1 key. It is
**armed** by `releaseSeq + 1` plus the sparse GSI1 key `RELEASE#pending` / `dueAt`, in the same
transaction as every event that can make a job releasable:

- an attempt's transition to a terminal status (the conditional status update on the attempt row,
  the `RELEASE` arm, and the attempt's report obligation, [07 § Effect obligations](07-review-integration.md#effect-obligations-and-claims)),
  whoever applies it: the `job-status` handler, the Reaper closing a silent VM, a skip below, or a
  rejected or expired gate ([07](07-review-integration.md#the-approval-gate-q5));
- `planning → planned`, and an approved fork plan's `held → running`;
- re-run step 3 above.

No other item type puts a second obligation into a slot that is already in use: every item that
carries a GSI1 key carries exactly one logical index entry, listed in the
[Data model](#data-model-q6)'s GSI budget.

**The release pass** (run by whoever armed the obligation, immediately after the transaction, and
by the Reaper for any `RELEASE#pending` past its `dueAt`) reads the `RELEASE` item's
`releaseSeq`, queries the plan's `JOB#` items
(`begins_with`, paginated, so the large `INPUT#` chunks are never read) and batch-reads each job's
latest attempt row by primary key, then for each `PlannedJob` whose latest attempt is `waiting`:

1. if the plan is `held`, or a `need`'s latest attempt is not terminal, leave it `waiting`;
2. if the activation gates no longer hold, move it to terminal `completed` with conclusion
   `cancelled` and the gate named, so a disabled repo never leaves rows waiting forever;
3. if the job's `if:` (default `success()`), re-evaluated now against its needs' effective
   results ([continue-on-error](#continue-on-error-raw-and-effective-results)) and
   `needs.*.outputs`, is false, move it to terminal with conclusion `skipped`. As on GitHub, a
   need that failed or was cancelled therefore skips the job unless its `if:` uses `always()`,
   `failure()` or `cancelled()`;
4. if it belongs to a matrix group whose `trippedSeqs` contains the current re-run sequence
   ([Matrix groups](#matrix-groups-max-parallel-and-fail-fast)), move it to terminal with
   conclusion `cancelled`;
5. if it declares `environment:` and its gate is not yet approved, move it `waiting → held` and,
   in the same transaction, create its `GATE` item
   ([07 § The approval gate](07-review-integration.md#the-approval-gate-q5)). An approval moves
   it back to `waiting` with `gateApproved` set and arms this obligation, so it returns here and
   takes the next step like any other job;
6. otherwise move it `waiting → released`, stamp GSI1 `RUNSTATUS#queued`, create its execution
   report obligation, take the job's check name
   ([07 § Check-run names](07-review-integration.md#check-run-names-one-authority-per-name)) and,
   for a matrix job, take a slot in its group, all in the same transaction,
   then enqueue it to Provision. If the group's slot condition fails, the job stays `waiting`: a
   sibling's terminal transition frees the slot and re-arms this obligation.

Every transition is conditional on `release = waiting`, so two passes racing do each job once.
Steps 2, 3 and 4 are terminal transitions, so they re-arm the `RELEASE` item for their own
dependents in the same transaction. A job ended by step 2, 3 or 4 never ran, so it never enters GSI1 (no VM,
duration or cost) and appears in run history through GSI2 only. When every `PlannedJob`'s latest
attempt is terminal, the pass moves the plan to its terminal state, which is what lets a re-run be
reserved and the review evaluator judge the sha; for a plan started by a pull request, that same
transaction marks the PR's head projection as owing a reporter pass
([07 rule 2](07-review-integration.md#when-we-submit-a-review)), so the verdict cannot be lost
either. The pass ends by removing the `RELEASE` item's GSI1 key on condition
`releaseSeq = :seen`: a terminal transition that landed during the pass, including one of its
own skips, raised `releaseSeq`, so the obligation survives and another pass runs. No crash point
can lose an owed release, because the obligation is cleared only by a pass that saw every
transition that armed it.

**A lost enqueue is recovered only for `released` rows.** The enqueue in step 5 comes after the
row is durable, so a crash between them leaves a `released`, `queued` attempt with no message. The
Reaper re-enqueues an engine attempt found in GSI1 `RUNSTATUS#queued` past a threshold with no
`microvmId`, on the extra condition `release = released`. A `waiting` or `held` row is never in
that partition and fails that condition anyway, so the Reaper cannot dispatch a job whose `needs`
have not finished or whose approval has not been given. Re-enqueue is safe to repeat: the SQS
dedupe id is the engine pk, Provision's `queued → provisioning` transition is conditional
([ADR-013](../DECISIONS.md#adr-013)), and Provision rebuilds the JobSpec from the stored plan
input ([Trigger sources](#trigger-sources--idempotency-q3)), so a second message for the same
attempt does nothing. For GitHub rows the Reaper keeps today's behaviour, treating long-`queued`
as a quota-wall signal.

### `continue-on-error`: raw and effective results

GitHub gives one failure two readings. A step with `continue-on-error` that fails has
`steps.<id>.outcome` `failure` and `steps.<id>.conclusion` `success`
([contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#steps-context)),
so the job does not fail. A job with `continue-on-error` that fails "Prevents a workflow run from
failing when a job fails" and does not trip fail-fast
([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontinue-on-error)),
while the job's own check run still shows the failure
([community discussion 15452](https://github.com/orgs/community/discussions/15452)). The engine
keeps both readings, on the attempt row, and states which surface reads which, so no two surfaces
can disagree by accident.

- **Fields.** The terminal transition writes `conclusion` (the raw job conclusion: `success`,
  `failure`, `timed_out`, `cancelled` or `skipped`), `tolerated` and `effectiveResult`
  (`success | failure | cancelled | skipped`, the `needs.<id>.result` vocabulary). The **status
  writer** computes the last two from the plan's compiled `continueOnError` for that job (decided
  at plan time, per matrix leg, and stored in the job manifest), never from the VM's report, so a
  VM cannot declare its own failure tolerated.
- **Step level.** The agent applies step-level `continue-on-error` as GitHub does, so a tolerated
  step failure leaves the job's raw conclusion `success`. Nothing above the job sees it except
  the step table, which shows the step's outcome as `failure`.
- **Job level.** `tolerated = continueOnError AND conclusion = failure`; then
  `effectiveResult = success`. Otherwise `effectiveResult` is `conclusion`, with `timed_out`
  mapped to `failure`. A `timed_out` or `cancelled` job is never tolerated in v1. That is the
  stricter reading of an undocumented case: it can turn a green verdict red, never a red one
  green, and OQ-10's conformance fixture pins it before phase 3 ships.
- **Who reads which:**

  | Surface | Reads | So a tolerated job failure |
  |---|---|---|
  | the job's execution check run and commit status | raw `conclusion` | shows `failure`, as on GitHub; the summary says "failure tolerated by `continue-on-error`" |
  | matrix fail-fast ([Matrix groups](#matrix-groups-max-parallel-and-fail-fast)) | `effectiveResult` | trips nothing |
  | release step 3 (a dependent's `if:` and status functions) | `effectiveResult` of each need | cannot occur in v1: job-level `continue-on-error` on a job that has dependents is Refused, because GitHub does not document what the dependent sees (OQ-10) |
  | the plan's terminal state ([Run-state model](#run-state-model)) | `effectiveResult` | leaves the plan `completed` |
  | the PR verdict ([07 § When we submit a review](07-review-integration.md#when-we-submit-a-review)) | `effectiveResult` and `tolerated`, from the verdict basis | does not make the verdict a failure, and does not count as a pass either |

  A required check on the tolerated job's name therefore stays red while the workflow and our
  verdict are green. That is GitHub's own behaviour for the same workflow, and the console says
  so on the job.

### Matrix groups: `max-parallel` and `fail-fast`

Both controls act across the jobs of one matrix, so neither can live on a single attempt row.
GitHub's contract, which we copy: with `fail-fast` (default `true`) "GitHub will cancel all
in-progress and queued jobs in the matrix if any job in the matrix fails", except that a failing
job with `continue-on-error: true` does not trip it; and `max-parallel` caps how many of the
matrix's jobs run at once ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).

- **Item.** `PLAN#<repoKey>#<runId>` / `GROUP#<hash(jobKey)>`, one per matrix job definition, written
  with `attribute_not_exists` in plan step 2, before the plan becomes `planned` (so before
  anything can be released). It holds `maxParallel` (absent means unbounded), `failFast`,
  `slots` (a string set of the `jobId`s that currently hold a slot) and `trippedSeqs` (a number
  set of the re-run sequences in which fail-fast has tripped; absent if none). It carries no GSI
  key: it is read by primary key from the release pass, which already knows the plan.
- **Taking a slot is part of the release transaction** (release step 6): `ADD slots :jobId` on
  condition `attribute_not_exists(slots) OR size(slots) < :maxParallel`. A full group fails the
  condition, the job stays `waiting`, and no message is sent. Two racing passes cannot both take
  the last slot, because DynamoDB evaluates the condition and the add atomically. This is the
  one conditional write on the group, and it can only stop the job being released, which is its
  purpose.
- **Freeing a slot and tripping fail-fast are part of the terminal transition, and neither can
  stop it.** Every writer of a matrix attempt's terminal status (the status writer, the Reaper, a
  cancellation below) includes, in the same transaction, `DELETE slots :jobId` and the `RELEASE`
  arm. When the attempt's effective result is `failure`
  ([continue-on-error](#continue-on-error-raw-and-effective-results); a tolerated failure is
  `success` and trips nothing) and the group has `failFast`, the transaction also does
  `ADD trippedSeqs :seq` on the group and arms the group's cancellation obligation
  ([Cancellation](#cancellation)). `:seq` is the attempt's `rerunSeq` (0 for the first run; every
  attempt row records the allocation that created it), so a re-run starts with an untripped
  group and an older attempt's late failure cannot trip a newer re-run.
- **The terminal transaction conditions only the attempt's own items.** `DELETE` and
  `ADD` on a set are idempotent and need no condition, the `RELEASE` and `CANCEL#` arms are
  unconditional upserts (below), and nothing in the transaction asks whether another job got
  there first. So when two legs of one matrix fail in the same re-run sequence, concurrently or
  after a stale read, both terminal transactions commit: the second adds a `:seq` already in the
  set and raises the cancellation obligation's `seq` again, which costs one extra, harmless
  canceller pass. The first draft conditioned the trip on `trippedSeq < :seq`, which made the
  second failure's own terminal write, slot release and report abort.
- **Effect on siblings.** `waiting` siblings are cancelled by release step 4 (`:seq` in
  `trippedSeqs`); released ones by the cancellation obligation. Neither waits on the other.

**Terminal transitions are independently committable, everywhere.** The rule above is general,
because one participant's required write must never depend on a side effect another participant
may already have applied. Every terminal transaction (status writer, Reaper, canceller, gate
reject or expiry, release steps 2–4) is built from: conditional updates of the attempt's own
items only (its row's status, for a held attempt its own `GATE` state, and its job's
`OUTRES#<jobId>` row, which only that job's attempts write), and unconditional,
idempotent updates of shared items: `DELETE`/`ADD` on
the group's sets, `ADD releaseSeq :1` plus `SET dueAt` on `RELEASE`, `ADD seq :1` plus `SET dueAt`
on the attempt's own `REPORT`, `ADD seq :1` plus `SET dueAt` on `CANCEL#`, and, for a plan
started by a pull request, `ADD seq :1` plus `SET dueAt` on `REVIEWHEAD` (which Ingest created
with the batch, so the upsert never creates it). The one shared quantity that needs a limit, the
run's output total, is updated **inside** the terminal transaction: when its cap condition
fails, the writer rebuilds the same transaction with no outputs and a failure result, whose
counter update carries no condition. So the limit decides the job's result instead of aborting
its transition, and the reservation can never move without the attempt becoming terminal in the
same write ([Deadlines and outputs](#deadlines-and-outputs)). Concurrent transactions on one shared item
can still fail with DynamoDB's `TransactionConflict`; the writer retries the identical
transaction with backoff, and the attempt-status condition makes a retry after an unseen commit a
no-op (the row is already terminal with the same conclusion, which the writer treats as
success). A writer that dies between retries leaves a non-terminal attempt that the Reaper closes
by the same transaction shape.

### Cancellation

Fail-fast, and later any other control that stops a job early, uses one protocol. The trigger
cannot touch every sibling in its own transaction (a matrix has up to 256 jobs and a transaction
100 actions), so it records an obligation instead.

1. **Obligation.** `PLAN#<repoKey>#<runId>` / `CANCEL#<hash(jobKey)>#<seq>`, armed by the tripping
   transaction with an unconditional upsert (`ADD seq :1`, `SET gsi1pk = CANCELS#pending,
   dueAt = :due`), so the first failure creates it, a second failure in the same sequence
   re-arms it, and neither can fail on it. It carries `seq`/`doneSeq` like every obligation
   ([obligation index rule](#data-model-q6)). The canceller runs immediately after the trip, and
   the Reaper re-drives any obligation past its `dueAt`.
2. **Pass.** The canceller reads the group and the plan's `PlannedJob`s for that `jobKey`, and for
   each latest attempt created in re-run sequence `seq` that is not terminal:
   - `queued` with no `microvmId` (release state `waiting`, `held` or `released`): the terminal
     transition to `cancelled` (with the slot free, the `RELEASE` arm and the report `seq` bump),
     on condition `status = queued`; for a `held` attempt the same transaction settles its `GATE`
     as `rejected` with reason `cancelled-by-fail-fast`, on condition `state = pending`. If an
     approval won the race, that condition fails and the attempt is back in `waiting`, where
     release step 4 cancels it; the canceller re-reads and moves on. Provision's own
     `queued → provisioning` transition is conditional ([ADR-013](../DECISIONS.md#adr-013)), so it
     then boots nothing;
   - `provisioning` or `running`: set `cancelRequested = :now` on condition the attempt is not
     terminal. Nothing else; the VM finishes the cancellation itself (step 3).
   The pass ends by `SET doneSeq = :s REMOVE gsi1pk, gsi1sk` on condition `seq = :s`, where `:s`
   is the `seq` it read, once every such
   attempt is terminal or carries `cancelRequested`; a trip that re-armed the obligation during
   the pass raised `seq`, so the condition fails and another pass runs. The condition names
   `seq`, which the arming upsert always sets, and never `doneSeq`, which the item created by
   that upsert does not have yet.
3. **The VM learns of it on its next broker call.** The broker already `GetItem`s the attempt row
   to authenticate every call ([Agent protocol](#agent-protocol)), and returns `cancelRequested`
   in each response; the agent reports at least every 10 s while a step runs, so it hears within
   10 s. A `jobspec` call on a cancel-requested attempt returns no JobSpec, so a VM booted during
   the race exits before step 1. Otherwise the agent applies GitHub's documented step handling:
   `SIGINT`, then `SIGTERM` after 7500 ms, then a kill after 2500 ms more, and only steps whose
   `if:` holds under `cancelled()` run afterwards
   ([workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)).
   It then reports terminal `completed` / `cancelled`.
4. **Backstop.** GitHub forcibly ends a cancelled job after 5 minutes. The Reaper, which already
   reads the whole `RUNSTATUS#running` and `RUNSTATUS#provisioning` partitions every tick, closes
   any engine attempt whose `cancelRequested` is older than 5 minutes: it terminates the VM by
   the stored `microvmId` (the Reaper already holds `TerminateMicrovm`, [ADR-019](../DECISIONS.md#adr-019))
   and applies the terminal transition. A VM that stays silent therefore cannot hold a slot or
   keep a matrix running.

`concurrency` is the other cross-job control GitHub defines, and it is Refused in v1
([matrix](#grammar-support-matrix), OQ-9): it spans plans, so it needs a per-group owner item and a
pending queue that this design does not yet have.

### Deadlines and outputs

Two more Supported constructs need durable state, so their mechanism is stated here rather than
left to the agent.

- **`timeout-minutes`.** The status writer stamps `deadlineAt = runningAt + timeout` on the
  attempt row in the `provisioning → running` transition (the job's own value, or the platform
  ceiling). The agent enforces job and step timeouts itself, and reports `timed_out`. If it does
  not, the Reaper (in the same full read of `RUNSTATUS#running`) closes any engine attempt past
  `deadlineAt` plus 60 s: VM terminated by stored id, terminal `timed_out`, slot freed, release
  armed, report owed, and fail-fast tripped, all in the one terminal transaction.
- **`outputs`: storage.** GitHub's accounting is copied: a job's outputs are measured as the sum,
  over each output that is set (an empty value is not set, as on GitHub), of its name and value
  in UTF-16 code units × 2 bytes; a job's total must be ≤ 1 MiB (1,048,576 bytes) and a run's ≤
  50 MiB. GitHub says only that "Size is approximated based on UTF-16 encoding", so counting the
  name too is the stricter reading, and the phase-2 conformance fixture measures GitHub's actual
  cut-off before the limit is advertised as exact. The agent first drops every output that may
  contain a secret (next bullet), then measures what is left. It reports outputs to the status
  writer in pages of at most 256 KB (each page an idempotent `job-outputs` broker call keyed by
  `(ref, page)`), then `job-status` with the page count and total; a job whose own total exceeds
  1 MiB fails `engine-outputs-too-large` in the agent, before any page is sent, exactly where
  GitHub would reject it. The status writer stores each page on arrival as an `OUTPUT#<n>` item
  (≤ 300 KB, so ≤ 4 for one job) under the attempt's pk; the item limit is 400 KB. The status
  writer, not the agent, enforces that physical bound, because a VM's code can send whatever it
  likes: a page index outside `0..3` or a page over 256 KB is rejected before any write, and
  the terminal transaction's `:b` is the sum of the stored pages' sizes, measured by the status
  writer with the same UTF-16 accounting, never the total the VM reports. So an attempt holds at
  most four pages and 1 MiB however its VM behaves, and what the run counter charges is what is
  stored. A page is
  **unreferenced until the attempt's terminal row names it**: the terminal transition records
  `outputPages` (the count, or 0), and every reader (release pass, Provision, `needs-outputs`)
  reads only the pages a terminal row names. A page of an attempt whose terminal row records 0
  is never read, and expires with the run's retention TTL.
- **`outputs`: a page is write-once, and the terminal transaction seals the pages it names.**
  The terminal row describes the pages' bytes, so the pages must not change after the status
  writer measured them. A state read before the page write ("is the attempt terminal yet?")
  cannot guarantee that: a page write admitted just before the terminal transaction can commit
  just after the status writer read the pages, and the terminal row would then count bytes the
  item no longer holds. The previous revision overwrote a repeated `(ref, page)` and had exactly
  that race. Now one authority, the DynamoDB transaction, orders both operations:
  - **Page write.** `job-outputs` is one `TransactWriteItems` of two actions: a
    `ConditionCheck` on the attempt row that it is `running` and has no `conclusion`, and a
    `Put` of `OUTPUT#<n>` = `{content, h, bytes}` on `attribute_not_exists(pk)`, where `h` is
    the SHA-256 of the page content and `bytes` its UTF-16 measure, both computed by the status
    writer. A page is therefore created once and never replaced. If the cancellation reason is
    on the `OUTPUT#` item, the writer reads it with a consistent read: an equal `h` is the
    agent's retry of its own earlier write and succeeds; a different `h` is refused
    `engine-output-page-conflict`, and the stored page is unchanged. If the reason is on the
    attempt row, the attempt is already terminal and the page is refused "attempt already
    closed", writing nothing.
  - **Terminal transaction.** The status writer reads the pages `0..k−1` that `job-status`
    names with consistent reads (a missing one rejects `job-status`, which the agent retries
    after resending the page), sums their stored `bytes` into `:b`, and adds to the terminal
    transaction one `ConditionCheck` per named page: `attribute_exists(pk) AND h = :h_n AND
    bytes = :bytes_n`. At most four pages, so at most four more actions, each on a distinct item.
    Because pages are write-once the check normally holds; its job is to make the terminal
    row's description and the stored content one fact, committed together or not at all.
  - **Crossings.** A page write that commits before the terminal transaction is either one the
    status writer read (immutable, so still equal) or one it did not name (a page index past
    `k`). An unnamed page is never read and never charged, and the four-index bound still
    holds. A page write that reaches DynamoDB after the terminal transaction fails its
    `ConditionCheck` on the attempt row and writes nothing. DynamoDB isolates transactions
    serializably against each other
    ([transaction isolation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html#transaction-isolation)),
    so no interleaving leaves `outputPages` or `OUTBYTES` describing bytes a reader cannot
    fetch. A forged `job-outputs` from a root step inside its own attempt has the same and no
    more power: it can choose its attempt's pages before `job-status`, which is the authority
    over its own outputs the job already has, and it cannot change one afterwards.
  - **Barrier tests (phase 2).** With the status writer paused between its page read and its
    terminal commit: an overwrite of page 0 with different content (same size, and a size change
    from 10 KB to 250 KB) is refused `engine-output-page-conflict`, the terminal commits, and a
    `needs-outputs` read returns the measured bytes; a create of an unnamed page 2 commits, the
    terminal commits with `outputPages = 2`, and no reader fetches page 2 or charges it; a page
    write released after the terminal commit is refused on the attempt row. Paused between the
    page write's admission and its commit instead: the status writer's consistent read either
    sees the committed page (and names it, with its hash) or finds it missing and rejects
    `job-status`, and a `TransactionConflict` between the two transactions (both touch the
    attempt row) is retried. In every case `OUTRES#.bytes` equals the sum of the named pages'
    stored `bytes`, and every named page's stored `h` equals the hash the terminal row
    committed with.
- **`outputs` that may contain a secret are never sent.** GitHub: "Outputs containing secrets are
  redacted on the runner and not sent to GitHub Actions", with the warning
  `Skip output 'OUTPUT-NAME' since it may contain secret`; and a value registered with
  `::add-mask::` "is treated as a secret and will be redacted on the runner … after you mask a
  value, you won't be able to set that value as an output"
  ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idoutputs),
  [workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log)).
  The agent applies the same rule at the end of the job, after evaluating each declared output
  and before any `job-outputs` call: an output whose value contains any entry of the agent's
  mask set (every resolved secret value, the checkout token, and every value registered by
  `::add-mask::` or `core.setSecret` during the job) is dropped whole, never partially masked,
  and the job log carries GitHub's warning with the name only. A dropped output is **not set**:
  it adds no bytes, it is absent from the pages, and a dependent's `needs.<id>.outputs.<name>`
  evaluates to `''`, as on GitHub, so `if:` and `${{ }}` see what they would see there. Step
  outputs (`steps.<id>.outputs`) never leave the VM, so they need no filter. The status writer
  cannot repeat this check, because it never holds a secret value, and that is deliberate; the
  limit is stated under [Secret custody](#secret-custody).
- **`outputs`: the run total counts every output the run keeps, not the ones in flight.**
  GitHub's 50 MiB is "The total of all outputs in a workflow run", so the counter must cover
  every job's outputs for as long as the run holds them. Each job has one reservation **row**,
  `PLAN#<repoKey>#<runId>` / `OUTRES#<jobId>` = `{attempt, bytes}`, and the run has one counter
  item, `PLAN#<repoKey>#<runId>` / `OUTBYTES` = `{bytes}`, always the sum of the rows. The
  counter is **created at 0 in the plan commit** (step 1 of
  [Trigger sources](#trigger-sources--idempotency-q3)), before any job can be released, because
  the cap condition below compares `bytes`, and a DynamoDB comparison against an absent
  attribute evaluates to false: an absent counter would fail the first job that kept any output
  and be misread as the cap. `ADD` alone would treat absence as zero, but the condition is
  evaluated before it. Neither
  lives on the `RunPlan`: a per-job map there would grow with the job count and user-chosen
  ids toward DynamoDB's 400 KB item limit, which "includes both attribute name binary length
  (UTF-8 length) and attribute value lengths"
  ([item size](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html#limits-items)),
  and a write that crossed it would fail with `ValidationException` inside every terminal
  transition. Each row is a few dozen bytes whatever the job's id, and the counter is one
  number. A row is the outputs of that job's latest terminal attempt, which is what a
  dependent reads, including after a re-run that left the job out (it keeps its previous
  attempt's outputs, as on GitHub). Rows are **replaced, never removed**: there is no
  release after the job finishes, so 51 jobs of 1 MiB each, run one after another, hold 51 MiB
  of reservations and the 51st fails the cap.
  - **The reservation moves only inside the terminal transaction.** There is no separate
    settle write. Every writer of a terminal transition (the status writer, the Reaper, the
    canceller, release steps 2–4, a rejected or expired gate) puts the job's `OUTRES#<jobId>`
    update and the `OUTBYTES` update into **the same `TransactWriteItems` as the attempt's
    terminal status**, whose own condition is that the attempt row is not yet terminal. DynamoDB
    applies a transaction's actions "in an all-or-nothing operation"
    ([TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)),
    so the reservation, the counter and the terminal row (with its `outputPages`) commit
    together or not at all, and only the one writer whose transaction makes the attempt
    terminal can change the row. The three items are distinct, as a transaction requires.
    The previous revision settled in one transaction and closed in a second, and a losing
    writer could re-settle between the winner's two writes, leaving `OUTBYTES` holding bytes
    that no terminal row named. A single transaction leaves no such gap.
  - **What each writer puts in the transaction.** `:b` is this attempt's bytes. Only the status
    writer, acting on the agent's `job-status`, uses a non-zero `:b`; every other closer uses 0,
    because the attempt it closes stores no outputs. `:old` is the bytes of the row the writer
    read, and `:delta = :b − :old`.
    - `OUTRES#<jobId>`: `SET attempt = :a, bytes = :b`, on condition
      `attribute_not_exists(pk)` (no row, `:old` = 0) or `attempt < :a AND bytes = :old` (a
      re-run replacing its predecessor by the difference). A row naming this same attempt cannot
      exist before its terminal transaction, because nothing else writes it. With no row and
      `:b` = 0 the action is omitted.
    - `OUTBYTES`: `ADD bytes :delta`; when `:delta > 0` only, with the condition
      `bytes <= :limit`, where the writer computes `:limit = :cap − :delta` itself, because a
      condition expression compares operands and has no arithmetic. The item always exists (the
      plan commit created it), so the comparison is never against an absent attribute. When
      `:delta ≤ 0` it has no condition.
    - The terminal row records `outputPages` = the page count when `:b > 0`, else 0.
  - **Cap exceeded.** If the transaction is cancelled with `ConditionalCheckFailed` on the
    `OUTBYTES` item alone (`TransactionCanceledException` returns a reason per action,
    [TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)),
    the status writer reads the counter to confirm it. A counter above `:limit` is the cap; one
    at or below it means another job's concurrent delta moved the total between the read and
    the commit, so the writer recomputes `:delta` and `:limit` and retries; and an absent
    counter breaks the plan-commit invariant, so the writer alarms and retries rather than
    failing the job. On a confirmed cap it rebuilds the same transaction with `:b` = 0,
    `outputPages` = 0,
    `effectiveResult = failure` and code `engine-outputs-too-large`. Its `:delta` is now
    `−:old`, which carries no condition, so the rebuilt transaction cannot fail on the cap.
    Only the crossing job fails; its terminal transition, slot release and report still commit.
    This is the one conditioned shared item in a terminal transaction
    ([Terminal transitions](#matrix-groups-max-parallel-and-fail-fast)), and it is allowed
    because its failure has a fixed fallback that removes the condition, so it decides the
    result and never blocks the transition.
  - **A losing writer changes nothing.** If the cancellation reason is on the attempt row, the
    attempt is already terminal: another writer won, and its transaction also carried its
    `OUTRES` and `OUTBYTES` changes. The loser re-reads; a terminal row with the conclusion it
    meant to write is a retry of its own unseen commit and counts as success, and any other
    conclusion means it lost, so it stops. Example: the status writer (`:b` = B) and the Reaper
    (`:b` = 0, closing an attempt it found silent) race. If the status writer commits first, the
    row holds B, the attempt is terminal with B's pages, and the Reaper's transaction fails on
    the attempt row. If the Reaper commits first, the row holds 0, the attempt is terminal with
    `outputPages` = 0, and the status writer's transaction fails on the attempt row, so it
    cannot restore B. The agent's `job-status` is then answered "attempt already closed", and
    its pages are never read. If the cancellation reason is on `OUTRES` (a stale read of a
    predecessor's row), the writer re-reads and rebuilds.
  - **A crash leaves nothing half-done.** A writer that dies before its transaction commits has
    changed nothing; one that dies after has changed everything. The re-driver (the agent's
    retried `job-status`, or the Reaper closing a silent attempt) therefore always starts from
    a consistent state, and a reservation by an attempt that never reached a terminal row
    cannot exist.
  - **An older attempt can never overwrite a newer one** (`attempt < :a`, or absent, in every
    form).
  - Concurrent jobs of one run share `OUTBYTES`, so their terminal transactions can fail with
    `TransactionConflict`; the writer retries the identical transaction with backoff. `ADD` is
    atomic, so two jobs cannot both pass the cap on a stale total.
  - **The invariants**, checked by the phase-2 interleaving tests after every step and crash
    point, are stated per job, because a row describes only one attempt:
    1. `OUTBYTES` exists from the plan commit on, and `OUTBYTES.bytes = Σ OUTRES#*.bytes` for
       the run.
    2. If the job has an `OUTRES#` row, it names the job's highest-numbered terminal attempt,
       and that attempt's `outputPages > 0` exactly when the row's `bytes > 0`.
    3. If the job has no row, every terminal attempt of the job has `outputPages = 0`.

    Nothing is claimed about the other terminal attempts. After a re-run replaces attempt 1
    (bytes B₁) with attempt 2, the row names attempt 2, and attempt 1's terminal row still
    records its own `outputPages > 0`: its pages stay stored as history, but they are no longer
    counted and no reader resolves them, because Provision, the release pass and `needs-outputs`
    read only the pages of each need's highest-numbered terminal attempt. Attempts of one job
    become terminal in attempt order (a re-run is reserved only once the plan is terminal,
    [Re-run allocation](#re-run-allocation)), so the row always names that attempt.
    The tests include the two cases the previous revision got wrong: the **first** job of a
    fresh plan to keep outputs (counter at 0, B > 0) succeeds and leaves `OUTBYTES = B`; and an
    output-producing re-run (attempt 1 keeps B₁, attempt 2 keeps B₂) leaves the row at
    `{attempt: 2, bytes: B₂}`, `OUTBYTES` changed by `B₂ − B₁`, and attempt 1's `outputPages`
    unchanged and unread.
- **`outputs`: retrieval is paged, so no response approaches a payload limit.** A dependent
  reads its needs' outputs only through a new broker action, `needs-outputs`, which takes a page
  number and returns one `OUTPUT#` item's content (≤ 300 KB, far under Lambda's 6 MB synchronous
  response limit, [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)).
  The page list is fixed by Provision, which writes into the dependent's JobSpec the exact
  `OUTPUT#<n>` keys its needs' latest terminal attempts name in `outputPages` (never the values); the broker resolves page `i`
  from the JobSpec its own token resolved, never from the VM, and reads it with `GetItem`, so it
  stays [ADR-021](../DECISIONS.md#adr-021)'s `GetItem`-only shape. The `jobspec` response carries
  the page count, not the pages. The agent fetches every page before step 1 and assembles
  `needs.*.outputs` locally, so a dependent of jobs totalling 50 MB makes about 170 calls of
  300 KB each. There is no aggregate limit below GitHub's 50 MB. Those calls count against the
  broker's reserved concurrency (OQ-5), which is a throughput cost, not a compatibility limit.
- **Matrix outputs are combined as on GitHub.** "When using a matrix, job outputs will be
  combined from all jobs inside the matrix", with the warning that "the last matrix job that
  runs and sets the output will override the output value"
  ([syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idoutputs)).
  The engine combines the legs' pages in the order of their terminal transitions (by each
  attempt's recorded `completedAt`, ties broken by `matrixIndex`), which is a "last job that
  ran" order. A leg whose output is empty does not override, as on GitHub.
- **The release pass needs outputs too** (for `if:`), and reads the `OUTPUT#` items the needs'
  terminal rows name by
  primary key; it is a control-plane λ with no response-size limit in the way.

### Re-run rules

- **Re-runs reuse the plan.** Same sha, same resolved action SHAs, same trust class. A re-run is
  never a fresh plan, so it cannot pick up a moved tag or a changed workflow file.
- **Cap.** At most 50 attempts per run, mirroring GitHub's documented limit ("A workflow run can be
  re-run a maximum of 50 times").
- **Reporting.** Each attempt gets its **own** check run, with `external_id`
  `e1:<repoKey>:<runId>:<jobId>:<attempt>` ([07](07-review-integration.md#check-run-payload)), so an
  inbound `requested_action` names exactly the attempt the user was looking at.

### Console URLs

Engine ids are strings, and the shipped SPA parses run route segments with `Number(...)`
(`web/src/main.tsx`), so engine runs get their own route prefix rather than overloading the
numeric one:

| Target | URL |
|---|---|
| One attempt of one job | `#/eruns/{repoKey}/{runId}/{jobId}/{attempt}` |
| Latest attempt of one job | `#/eruns/{repoKey}/{runId}/{jobId}`; resolves `latestAttempt` with one point-read on the plan |
| Whole run | `#/eruns/{repoKey}/{runId}` (phase 3 work, [07 OQ-5](07-review-integration.md#open-questions)) |

The shipped `#/runs/{repoId}/{runId}/{jobId}` route keeps serving GitHub-scheduled runs unchanged.
The API mirrors it with `/api/eruns/...` templates. Every lookup is by primary key, so it stays
inside the broker's `GetItem`-only shape ([ADR-021](../DECISIONS.md#adr-021)), and the resolver
needs no fallback probe between prefixes.

## Dispatch without `generate-jitconfig`

Today Provision mints a JIT config ([ADR-003](../DECISIONS.md#adr-003),
[ADR-016](../DECISIONS.md#adr-016)) and the runner registers with GitHub. Our engine has nothing
to register with. What replaces it, and what is deliberately kept:

| Today | Engine path |
|---|---|
| `POST …/actions/runners/generate-jitconfig` | *nothing* — no registration exists |
| JIT config stashed in DynamoDB, fetched by ref via the broker | **kept**: a **JobSpec** is stashed the same way, fetched the same way |
| `RunHookPayload{ref, region, broker, token}` ≤4 KB | **kept verbatim** |
| Runner polls GitHub's Actions service | our agent receives the JobSpec and reports to the broker |

**The by-reference payload and the capability token are kept exactly as they are.** This is not
convenience: [ADR-021](../DECISIONS.md#adr-021) removed all ambient AWS authority from the VM and
made its authority a per-run capability, and [ADR-016](../DECISIONS.md#adr-016)'s 4 KB payload cap
is a hard platform limit a JobSpec will exceed just as the JIT config did. Reusing the broker path
means the engine inherits those properties instead of re-litigating them — see
[Q7](#blast-radius-q7).

## Agent protocol

A small in-VM agent (`lca-agent`, ours) replaces `actions/runner`. It speaks to the **hook broker**
only — the one AWS surface a microVM can reach ([ADR-021](../DECISIONS.md#adr-021)) — authenticated
by the per-run capability token, with the run key derived from the token-bound ref and never from
caller input.

Broker actions, extending today's `jitconfig` | `terminate`:

| Action | Direction | Purpose |
|---|---|---|
| `jobspec` | VM → broker | fetch this run's JobSpec (replaces `jitconfig`), with resolved secrets and the count of `needs-outputs` and `event` pages |
| `event` | VM → broker | page `i` of the delivered event payload: one `EVENT#` item, ≤ 300 KB, by a key the JobSpec fixes ([The `github` context](#the-github-context-and-the-event-projection)) |
| `needs-outputs` | VM → broker | page `i` of its needs' outputs: one `OUTPUT#` item, ≤ 300 KB ([Deadlines and outputs](#deadlines-and-outputs)) |
| `step-status` | VM → broker | step started / finished + conclusion |
| `job-outputs` | VM → broker | one page (≤ 256 KB) of this job's outputs, write-once by `(ref, page)`: a retry with the same content succeeds, different content is refused ([Deadlines and outputs](#deadlines-and-outputs)) |
| `job-status` | VM → broker | job conclusion, plus the output page count and UTF-16 byte total |
| `log-append` | VM → broker | log chunks of ≤ 256 KB (or direct-to-CloudWatch under the VM's own log-group grant) |
| `terminate` | VM → broker | unchanged |

**Every broker message is bounded far under Lambda's 6 MB synchronous request and response
limit** ([Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)),
by construction rather than by a cap a workflow can reach: a JobSpec item is ≤ 400 KB; the
`jobspec` response adds at most 100 secrets of ≤ 4096 bytes ([Storage](#storage)); every
`needs-outputs`, `event`, `job-outputs` and `log-append` message is one page. No GitHub-defined quantity
is carried in a single message, so no Lambda limit becomes a workflow limit.

**Every byte the agent sends upward passes the mask set first.** The mask set is every resolved
secret value, the checkout token, and every value registered by `::add-mask::` during the job.
Log chunks, step names and conclusions (`step-status`), annotation messages, `$GITHUB_STEP_SUMMARY`
content (GitHub: "Summaries automatically mask any secrets that might have been added
accidentally", [workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands))
and the `job-status` message are masked by replacement with `***`; job outputs are not masked
but dropped whole when they contain a mask entry ([Deadlines and outputs](#deadlines-and-outputs)),
because a partially masked output would hand a dependent a corrupted value where GitHub hands it
none. No broker action carries a field that bypasses the mask set, and a phase-2 test sends a
secret, an `::add-mask::` value and the checkout token through every action and finds none of
them in any broker request, table item or log event.

Deliberate contract choices:

- **The agent and the job's steps are different principals inside the VM, and only the agent
  holds the capability token.** The token, broker name and ref arrive in the launch payload, and
  the agent must keep the token for the whole job. Today's image runs its supervisor and the job
  as the same `runner` user, so any step could read the token from the supervisor's
  `/proc/<pid>/environ` or memory and call the broker as the agent. The engine images change that
  ([In-VM trust boundary](#in-vm-trust-boundary)).
- **The agent's only git-host credential is one short-lived, single-repo, read-only checkout
  token**, delivered in the `jobspec` response, not stored in the JobSpec item. It is minted by the
  control plane with the installation-token API's repository and permission narrowing, so it
  cannot reach any other repo the installation grants. The agent never holds the App key or an
  installation-wide token.
- **Secrets are not in the JobSpec item.** The stored JobSpec names the secrets a job needs; their
  values are resolved at the `jobspec` call by the secret resolver
  ([Secret custody](#secret-custody)) and returned in that one response. No table row is ever
  written with a resolved value: the response is not persisted, and every upward channel passes
  the agent's mask set (above).
- **Outputs are declared, not scraped.** The agent reports `outputs` explicitly rather than the
  engine parsing logs, so a job cannot forge another job's outputs by printing them.
- **Reporting is idempotent and monotonic.** Every message carries `(ref, stepIndex)`, and the
  ref already names the attempt ([Run identity](#run-identity-keys--attempts));
  a backwards transition is rejected, exactly as the run store already refuses
  `completed → running` ([ADR-042](../DECISIONS.md#adr-042)).
- **The broker stays read-only on the table.** It authenticates the VM's capability token and
  forwards `step-status`, `job-outputs`, `job-status` and `log-append` with only the token-bound ref to a
  control-plane λ, `lca-<env>-enginestatus`, which owns every engine row write, including the
  terminal transition and the release obligation armed with it ([Release](#release)). The broker gains
  `lambda:InvokeFunction` on that exact ARN, as it does on the secret resolver, and keeps
  [ADR-021](../DECISIONS.md#adr-021)'s `GetItem`-only table grant.
- **An unreported job is not a green job.** The engine's Reaper reconciles silence into
  `timed_out`/`failed`, as today ([ADR-019](../DECISIONS.md#adr-019)) — a VM that dies mid-job must
  never leave a run that merely looks unfinished.
- **Cancellation rides the responses.** Every broker response carries the attempt row's
  `cancelRequested`, read in the same `GetItem` that authenticates the call, and the agent calls at
  least every 10 s while a step runs, so a cancel reaches it without a new channel
  ([Cancellation](#cancellation)).

### In-VM trust boundary

The capability token proves to the broker that a call comes from *this attempt's VM*. It cannot
prove the call comes from the agent rather than from the job's own code, and every report the
broker accepts (`step-status`, `job-outputs`, `job-status`, `log-append`) attests to what that
code did. So the design separates the two inside the VM, and states what remains.

**The boundary.**

1. **Two uids.** Engine images run `lca-agent` as a dedicated system user, `lca-agent`, which is
   not in `sudoers`, owns `/opt/lca-agent` (mode `0700`) and is the only user that ever holds the
   token. Steps run as `runner`, which the agent starts with `setpriv --reuid=runner
   --regid=runner --init-groups --reset-env` per step, as
   [ADR-020](../DECISIONS.md#adr-020) already does for the docker flavor's downward privilege
   change. A different uid cannot read another uid's `/proc/<pid>/environ` or `/proc/<pid>/mem`,
   or attach with `ptrace`, unless it is root.
2. **The token never leaves the agent's memory.** The run-hook hands the launch payload to the
   agent on its stdin and keeps no copy; the agent never writes the token, ref or broker name to a
   file, an environment variable, a command line or a file descriptor a step inherits. A step's
   environment is built from scratch from the JobSpec (`GITHUB_*`, `RUNNER_*`, the job and step
   `env`), never inherited from the agent. Step processes get only stdin, stdout and stderr; the
   agent opens every other descriptor `O_CLOEXEC`.
3. **`/proc` is mounted `hidepid=invisible`** before the first step, so `runner` cannot even
   list the agent's processes, and `kernel.yama.ptrace_scope` is set to 2 where the guest kernel
   exposes it. Both are defence in depth behind item 1; the phase-2 card records which the
   microVM kernel allows.
4. **The broker accepts reports only in the order the agent produces them.** `step-status` must
   name the next step index in sequence, and an index at or past the compiled job's step count
   (fixed in the stored JobSpec) is rejected, so a VM cannot create `STEP#` items beyond the
   steps its plan has; `job-outputs` must precede `job-status`, and after
   `job-status` the broker accepts only `log-append` and `terminate`. A stolen token used after
   the job finished can add log lines and nothing else. "After `job-status`" is enforced by the
   write, not by a read before it: every `STEP#` and `OUTPUT#` write is a transaction that
   includes a `ConditionCheck` that the attempt row is still non-terminal, so a report admitted
   just before the terminal transaction and committed just after it fails, rather than changing
   a row the terminal transition already described. A `STEP#` update is also monotonic on its
   own item (`started` only from absent, `finished` only from `started`, its conclusion set
   once), so a replayed report cannot rewrite a step's recorded result.
5. **Nothing a VM reports decides a platform fact.** Trust class, secret names, the check name,
   the approval gate, `timeout-minutes` deadlines, `continue-on-error`, which jobs run next and
   what a PR verdict is are all computed in the control plane from the stored plan. A VM's report
   decides only its own attempt's conclusion, outputs and logs, which is the authority the job's
   steps already have over their own result on any CI system.
6. **Each attempt's broker traffic is rate-limited** in the status writer (per ref, a token
   bucket of 20 calls per second), so a VM spamming the broker exhausts only its own allowance
   and not the 20 reserved broker concurrency all VMs share (OQ-5).

**What remains, stated.** Every v1 image grants `runner` passwordless `sudo`
(`microvm/Dockerfile.base`: `runner ALL=(ALL) NOPASSWD:ALL`) because GitHub-hosted jobs have it
and workflows depend on it (`sudo apt-get install`, the setup actions). In the unprivileged
flavors the guest's `no_new_privs` flag stops `sudo` from escalating
([ADR-020](../DECISIONS.md#adr-020)), so items 1 to 3 hold. In the `docker` flavor, which has a
root entrypoint and `additionalOsCapabilities=ALL`, a step that reaches root through the docker
socket or `sudo` can read the agent's memory and use its token. The design does not claim to
stop that, for two reasons:

- **It gives no authority beyond the attempt.** The token is bound to one attempt's ref, the
   broker derives everything from that ref, and item 5 means the forged reports can only claim a
   result for this attempt, which root in this VM could produce anyway by editing the workspace or
   the test binary before it runs. Cross-run, cross-repo and cross-tenant boundaries are the
   ref binding and the broker ([ADR-021](../DECISIONS.md#adr-021)), and none of them depends on
   the in-VM boundary.
- **GitHub draws the trust boundary at the same place.** "The individual jobs in a workflow can
   interact with (and compromise) other jobs", for example "by interacting with the Docker socket
   and inspecting other running containers and executing commands in them"
   ([secure use](https://docs.github.com/en/actions/reference/security/secure-use)). A job's own
   code is trusted to report its own result; what must not be trusted is any result that
   authorises something the job's author could not authorise anyway.

That last rule is enforced where results could authorise something: spec 07 never posts
`APPROVE`, for any trust class or diff, because every CI result on a pull request is produced by
code the PR's author controls, including ordinary test and build files that no workflow-path
filter can separate from the change ([07 § Why we never post `APPROVE`](07-review-integration.md#why-we-never-post-approve)).
A mode without `sudo` for repos that want the in-VM boundary to hold in every flavor is OQ-14.

Phase-2 adversarial tests, run on real microVMs of each flavor: a step reads
`/proc/<agent pid>/environ`, `/proc/<agent pid>/mem` and `cmdline`, lists `/proc`, `ptrace`s the
agent, searches its own environment, every readable file and every inherited descriptor for the
token, and calls the broker directly with any value it found; in unprivileged flavors every
attempt fails and the attempt's real result is what the agent reported. A `job-status` sent
before step 3 of 5, and a `step-status` after `job-status`, are both rejected. In the docker
flavor the same step, as root, does obtain the token, and the test asserts that the only effect
of using it is on its own attempt's row, logs and outputs.

## `uses:` resolution & supply chain (Q4)

Running third-party action code we fetched is the largest new attack surface in this design.

**Decision** ([ADR-058](../DECISIONS.md#adr-058)):

1. **Commit-SHA pins only.** A `uses:` naming a tag or branch (`actions/checkout@v4`) is
   **resolved to a SHA at plan time and the SHA is recorded on the run**. A tag is mutable — the
   same `@v4` can be a different tree tomorrow — so a tag-pinned run is not reproducible and not
   auditable. We do not *refuse* tags (that would refuse essentially every real workflow); we
   pin-on-first-use and report the resolution.
2. **Allowlist by owner, default-deny for the rest**, per installation. v1 seeds `actions/*`.
   The first draft also seeded `docker/*`; it is dropped, because several actions under that owner
   are Docker container actions, which are Refused anyway, and seeding an owner whose main use is
   refused only invites confusing refusals. An allowlisted owner never overrides the matrix:
   `actions/upload-artifact` is under `actions/*` and is still Refused.
3. **Cached in our own account**, keyed by SHA, immutable, so a run does not depend on the
   upstream still existing and a deleted upstream cannot break a rebuild.
4. **arm64 verified before dispatch, not discovered at runtime.** A JS action declares
   `runs.using: node20|node24` ([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)) and is arch-neutral; a **Docker** action is not, and a
   composite action is only as neutral as its steps. That maps onto the existing compat vocabulary
   rather than inventing a second one: unresolvable → `risk`, known-x86-only → `block`
   ([03](03-workflow-ingestion.md)).
5. **Refused in v1** (whole run, at plan time): Docker container actions, composite actions, any
   `uses:` pointing at a private repo we hold no grant for, and the specific actions the
   [matrix](#grammar-support-matrix) lists as Refused.

## Server APIs we would have to host

The official clients for cache and artifacts speak protocols GitHub does **not** publish. This is
where a partial engine most easily becomes a *silent* degradation, so the status of each is stated
rather than assumed.

| API | Client | Status |
|---|---|---|
| **Cache** (`actions/cache`) | undocumented service protocol | **Reimplementable, proven.** Gitea's MIT runner ships one: "Enable the built-in cache server (used by `actions/cache` and similar actions)" ([config](https://gitea.com/gitea/runner/raw/branch/main/internal/pkg/config/config.example.yaml)). Phase 6. **Until then: Degraded** (always-miss) at evidence-listed SHAs only, Refused at any other SHA. |
| **Artifacts** (`actions/upload-artifact`) | undocumented, versioned | **Partial at best.** The same file records the real cost of drift: "the stock artifact actions refusing and the cache client keeping to v1". So a stock artifact action **may refuse** against our server. Phase 6. **Until then: Refused**, because a missing artifact fails a later job after earlier ones ran. |
| **Tool cache** (`setup-*`) | filesystem, not a service | **Already solved** — our flavors prebake `/opt/hostedtoolcache` ([ADR-039](../DECISIONS.md#adr-039), [ADR-053](../DECISIONS.md#adr-053)). |
| **Job summaries / annotations** | `$GITHUB_STEP_SUMMARY` + `::error` | Ours; feeds check-run annotations ([07](07-review-integration.md)). |
| **OIDC id-token** | `ACTIONS_ID_TOKEN_REQUEST_URL` | **Cannot be reimplemented as GitHub's.** See below. |

Until phase 6 the two are classed differently, for a reason the matrix states: a cache miss changes
only speed and is an outcome GitHub can produce too, so it is admitted as a declared degradation; a
missing artifact changes the result and would fail a downstream job after upstream jobs ran, so it
is refused before anything runs.

**Both servers must scope what a PR can write.** A cache or artifact written by a pull request's
run is produced by code its author controls, so phase 6 must not let it be read by a run of
another ref, above all a `push` to the default branch that holds secrets. GitHub's rule is the
requirement: a run can restore caches from its current branch, the default branch and, for a
pull request, its base branch, but "When a cache is created by a workflow run triggered on a pull
request, the cache is created for the merge ref (`refs/pull/.../merge`) … It cannot be restored by
the base branch or other pull requests targeting that base branch"
([caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)).
The cache server keys every entry by the writing run's ref and applies that same read set, and
phase 6's 🎯 includes a PR run that writes a key a default-branch run then misses.

## Secret custody

**Today we hold no customer CI secrets at all.** GitHub injects them into a job we never see the
inside of; our SSM parameters are *platform* credentials (App key, webhook secret, OAuth client
secret: [ADR-008](../DECISIONS.md#adr-008)). Owning the engine means `secrets.*` has to come from
somewhere, and that changes what kind of system this is: from a compute supplier into a **secrets
holder**. That is a new class of obligation and it gets its own ADR
([ADR-057](../DECISIONS.md#adr-057)) rather than a paragraph.

The first draft let the console λ call `PutParameter` and gave "the dispatcher" `kms:Decrypt`
"only for the tenant it is currently dispatching". Both were wrong. The console λ is the
internet-facing plane and [ADR-025](../DECISIONS.md#adr-025) gives it no `ssm:PutParameter` at
all; and a Lambda's IAM role is static, so "only the tenant it is currently dispatching" is not
something IAM can express. A role allowed to decrypt for one tenant at a time is a role allowed
to decrypt for every tenant. The design below replaces both with mechanisms IAM and KMS actually
enforce.

### Storage

- **Path:** SSM SecureString at `/lca/<env>/tenant/<installationId>/secrets/<NAME>/<opId>`, one
  parameter per write ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)). Standard
  tier, so each value is encrypted directly by KMS with the encryption context
  `PARAMETER_ARN = <the parameter's full ARN>`, and KMS refuses to decrypt it under any other
  context ([KMS developer guide, Parameter Store](https://docs.aws.amazon.com/kms/latest/developerguide/services-parameter-store.html)).
- **Size: 4 KB per value, not GitHub's 48 KB.** The Standard tier's maximum value size is 4 KB, and
  the Advanced tier's is 8 KB
  ([Parameter Store tiers](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-advanced-parameters.html)),
  while "Secrets are limited to 48 KB in size" on GitHub
  ([secrets reference](https://docs.github.com/en/actions/reference/security/secrets)). No
  Parameter Store tier reaches 48 KB, so v1 accepts **at most 4096 bytes** (UTF-8) per value and
  says so: the console's secret form, the write broker and the docs all state the limit, and a
  larger value is refused at intake with `secret-too-large`, naming both limits and GitHub's own
  documented workaround for large secrets (commit the encrypted file, store the decryption
  passphrase as the secret,
  [storing large secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#storing-large-secrets)).
  The refusal happens when the operator saves the secret, never when a job runs. Alternatives
  considered and not chosen for v1:
  - **Advanced tier** doubles the limit to 8 KB, still short of 48 KB, and "Charges apply" where
    Standard has "No additional charge", so it buys a second incompatible number for a recurring
    cost.
  - **Segmenting a value across several parameters** breaks the one-parameter-one-write
    atomicity the audit row relies on: a crash between segment writes would leave a secret that
    decrypts to a mix of old and new bytes.
  - **Secrets Manager** holds 65,536 bytes per secret
    ([quotas](https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_limits.html))
    and would match GitHub. It is the planned route if tenants need larger secrets (OQ-8), but it
    changes the isolation mechanism (its KMS context and IAM resource shape differ from the
    `PARAMETER_ARN` condition designed below), so it gets its own design pass rather than a swap.
  Most CI secrets (tokens, API keys, passwords) are far below 4 KB; the ones that are not (PEM
  bundles, kubeconfigs, service-account JSON) are named in the console help as the expected
  casualties.
- **Count: names and parameters are capped separately.** The same AWS page caps parameters per
  account and Region (10,000 Standard, 100,000 Advanced), shared by every installation in the
  deployment, by the platform's own parameters, and by any other environment deployed to the
  same account ([05 § Environments](05-infrastructure.md#environments)). GitHub allows "up to
  1,000 organization secrets, 100 repository secrets, and 100 environment secrets". Because
  every write creates a new parameter and the old one is deleted only after a grace period
  ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)), the number of **names** an
  installation holds does not bound the number of **parameters** it occupies: rotating one name
  every second would occupy about 900 parameters before the first old value is collected. So v1
  has two kinds of cap, each enforced at intake inside the operation's begin transaction:
  - **Names:** at most 100 per installation (`secret-quota`), the `SECRETNAMES` set.
  - **Parameter slots:** one slot for every parameter that exists or may exist under the
    installation's path: each `current`, each live write's `op.path`, and each `SECRETGC#` item
    (a superseded value awaiting deletion, or a write whose outcome was never confirmed). Slots
    are counted per installation (`INSTALL#<installationId>` / `SECRETSLOTS`, at most **200**:
    100 values plus 100 in flight or awaiting collection) and per environment
    (`CONFIG#SECRETSLOTS` / `COUNT`, at most the environment's `tenantSecretSlotBudget`). A write
    that would cross either is refused (`secret-capacity`), naming which cap and, for the
    installation cap, when its earliest `SECRETGC#` item is due (or, when quarantined slots are
    what fill it, how many), so the operator knows when a
    rotation will be admitted again. A slot is released **only** in the transaction that records
    its parameter's confirmed deletion, or a write's confirmed rejection; a quarantined slot is
    not released at all in v1 (OQ-15).
  - **What the caps cost.** An installation holding 100 values can have at most 100 more
    parameters in flight or awaiting collection, less any quarantined slots, so it can rotate
    at most that many values per 15-minute grace period `G` before `secret-capacity` refuses
    it; with fewer names stored it has more headroom, and every write that timed out
    permanently takes one slot away. The environment budget is shared: once it is reached, every
    installation's **new** writes are refused until deletions release slots, while every stored
    secret keeps resolving and no other `PutParameter` in the account fails, because the
    budgets of every environment in the account together sit below the quota (next bullet). A
    second alarm fires at 80 % of the budget, and the console shows the refusal as a platform
    limit, not the tenant's fault.
  - **The account quota is allocated, code-enforced, across every environment in the
    account.** The quota is per account and Region, but each environment's counter lives in
    its own table, and [spec 05](05-infrastructure.md#environments) lets any number of
    environment names (`prod`, `dev`, personal sandboxes, each with the dev shape) pin the same
    account. Local counters cannot compose over that: two `prod`-named deployments, or `prod`
    plus two sandboxes, would each pass their own checks while their sum passed 10,000. The
    previous revision only alarmed on a daily measured count, which observes the overrun after
    admission. So the environment budget is now a **durable allocation** from one account-scoped
    registry, granted at deploy time, and the broker's runtime check reads the granted value
    rather than its own configuration:
    - **The registry.** A new account-level stack, `LCA-Account`, deployed by hand once per
      account and Region before any environment's Data stack (whose allocation resource fails
      the deployment when the registry table is absent), never by CD
      ([ADR-047](../DECISIONS.md#adr-047)'s allowlist does not gain it) and never torn down with
      an environment (`RETAIN`, and CloudFormation termination protection on), owns
      one table, `lca-account-quota` (no `<env>` in the name, because it is shared by every
      environment). Its fixed name has the same re-adoption hazard as the environment table
      ([below](#retained-table-ownership)): if its stack is deleted anyway, the retained table is
      re-adopted by the same resource-import procedure, never re-created. It holds
      `QUOTA#ssm-standard` / `TOTAL` = `{total, cap}`, seeded with `total = 0` by the stack itself
      (a conditional put on `attribute_not_exists(pk)`, so an import, a re-run or a replaced seed
      resource can never reset a live total) so later conditions never compare an absent attribute, and
      one `QUOTA#ssm-standard` / `ALLOC#<env>` per environment =
      `{tenantBudget, platformReserve, gen, state}`, plus one `QUOTA#ssm-standard` /
      `QUARANT#<env>#<gen>` = `{q, tracked}` for every released allocation that still had
      quarantined slots (below). A quarantined slot is charged to `TOTAL` **exactly once** at
      every committed state: inside an `ALLOC#<env>` while an allocation covers it, or in a
      `QUARANT#` row while none does, and it moves between the two only in a transaction that
      removes it from one and adds it to the other. `cap` is 9,500: the 10,000 Standard-parameter quota less a 500-parameter
      margin for parameters created outside this design (the account is meant to be dedicated
      to LCA, spec 05); the 500 is never allocated to anyone. The margin is **not** what bounds
      late SSM effects. A write whose `PutParameter` got no answer may land at any later time,
      so its slot is **quarantined**: charged for as long as it could land, which in v1 is for
      ever ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)), one slot per such
      write however many there are. An allocation has two parts,
      kept in separate attributes so neither can be spent as the other: `tenantBudget`, the
      environment's `tenantSecretSlotBudget`, which is the **only** value the broker can admit
      tenant parameters against; and `platformReserve`, a fixed 50 for the environment's own
      platform parameters (`/lca/<env>/` outside `tenant/`, a handful today, created by CDK or
      out of band, never by the broker). `TOTAL` is charged their sum. `gen` is a random
      128-bit id minted when the row is created, so a released and re-created allocation is a
      different allocation (below); `state` is `active` or `releasing`.
      The platform reserve is not admission-controlled, because no LCA code path creates
      platform parameters at runtime; the daily measured count (below) publishes each
      environment's non-tenant `/lca/<env>/` count and alarms at 40, 80 % of the reserve.
    - **Allocation is one cross-table transaction.** DynamoDB transactions can span tables in one
      account and Region
      ([TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)).
      A custom resource in the environment's Data stack runs on every create, and on every update
      whose budget or `allocationEpoch` changed ([below](#retained-table-ownership)), reads `TOTAL`, its own `ALLOC#<env>` (absent, or `tenantBudget = :old`
      with `gen = :gen`) and, by consistent read, its `CONFIG#SECRETSLOTS` / `COUNT`, and commits
      in one `TransactWriteItems`. When `ALLOC#<env>` is absent and `COUNT` is `released` under
      some `:oldgen` with `q = :carried` greater than 0, those `:carried` slots are still charged
      by the `QUARANT#<env>#<oldgen>` row the last release wrote, and this transaction takes them
      back (the **absorb**) rather than charge them a second time; otherwise `:carried` is 0.
      The writer computes `:new` = the new tenant budget, `:delta = (:new + 50) − (:old + 50)`
      (or `:new + 50 − :carried` when the row is absent, with a freshly minted `:gen`), and
      `:limit = cap − :delta`. `:delta` is at least 50 on every create, because `:carried` is
      `COUNT.q`, which never exceeds `COUNT.n`, and the `COUNT` condition below requires
      `n ≤ :new`:
      - `ALLOC#<env>`: `SET tenantBudget = :new, platformReserve = :fifty, gen = :gen, state =
        :active` on `attribute_not_exists(pk) OR (gen = :gen AND state = :active AND
        tenantBudget = :old)`. An allocation being released (`state = releasing`) refuses every
        deploy, which fails `allocation-releasing`.
      - `TOTAL`: `ADD total :delta`, with, when `:delta > 0` only, the condition `total <=
        :limit`.
      - in the environment's own table, `CONFIG#SECRETSLOTS` / `COUNT`: `SET budget = :new, gen
        = :gen, state = :active` on `(attribute_not_exists(n) OR n <= :new) AND
        (attribute_not_exists(gen) OR gen = :gen OR state = :released)`, and, on an absorb,
        additionally `gen = :oldgen AND state = :released AND q = :carried`. Only `tenantBudget`
        is written here; `platformReserve` never reaches the item the broker reads.
      - on an absorb only, `QUARANT#<env>#<oldgen>`: `DELETE` on `q = :carried AND tracked =
        :true`. The carried slots leave the `QUARANT#` row and enter the new allocation's
        `tenantBudget` in the same commit, so `TOTAL` charges each of them once before and once
        after. A released `COUNT` with `q > 0` whose `QUARANT#<env>#<oldgen>` row is absent or
        holds a different `q` is an invariant violation: the deployment fails
        `quarantine-ledger-mismatch` and alarms, and charges nothing.

      A cancellation on `TOTAL`
      fails the deployment with `account-quota-exhausted`, naming every environment's allocation
      and the remaining headroom, so the operator lowers a budget (`-c
      tenantSecretSlotBudget=…`) instead of finding out from a tenant's failed write. A
      cancellation on `COUNT` means the environment already holds more slots than the new budget,
      and the lowering is refused until deletions bring it down; on `ALLOC#<env>`, a concurrent
      deploy of the same environment, and the resource re-reads and retries. A retry after a
      lost response cannot charge twice: if the first attempt committed, the re-read finds
      `ALLOC#<env>` present with `tenantBudget = :new` and `COUNT` `active` under the new `gen`,
      so the retry computes `:delta = 0` and no absorb (the `QUARANT#` row is already gone);
      if it did not commit, nothing changed and the retry is the first attempt again.
    - **The broker enforces the granted value, not configuration.** The begin transaction's
      environment condition is `state = :active AND attribute_exists(budget) AND
      (attribute_not_exists(n) OR n < budget)`: it compares the counter with the budget
      attribute on the same item, which a condition expression may do. An environment whose
      allocation never committed has no `budget`, and one being released is `draining` with no
      `budget`; both refuse every write `secret-capacity`. A configured budget that was never
      granted, or a stale constant in a Lambda's environment, cannot admit a write, and the
      broker never sees `platformReserve`, so it cannot admit tenant parameters into it.
    - **Why the sum stays under the quota.** At every committed state, `TOTAL.total` is the sum
      over the `ALLOC#` rows of `tenantBudget + platformReserve`, plus the sum over the
      `QUARANT#` rows of `q`, and is at most `cap`, and each quarantined slot is in exactly one
      of those terms: an environment's carried slots sit in a `QUARANT#` row only while it has
      no allocation, and the deploy that gives it one deletes that row in the same commit
      (the absorb, above); each active environment's `COUNT.budget`
      equals its `ALLOC#<env>.tenantBudget`, so its tenant slots `COUNT.n`, which include its
      quarantined slots `COUNT.q`, stay at most `tenantBudget` except by the sweep's uncapped
      count of a parameter created outside this design, and its platform parameters have their
      own 50; a budget is lowered only in the same transaction that returns the difference to
      `TOTAL`, on condition `n` already fits; and an allocation leaves `TOTAL` only after its
      environment has been fenced and drained to its quarantined slots, which stay charged as a
      `QUARANT#` row until a redeploy takes them back (next bullet). Every tenant parameter that exists or may still come to
      exist holds a charged slot: a live one by admission, a late-risk one by quarantine, and a
      parameter can land late only at a quarantined path, where at most one parameter can exist
      at a time because parameter names are unique. So tenant parameters plus platform reserves
      across every environment never exceed 9,500 at any moment, however many late effects land
      and whenever they land, and the 500 margin is left for what this design does not create.
      An earlier revision instead released a late-risk slot after a 24-hour hold and relied on
      the 500 to absorb whatever landed later; that was fixed headroom presented as a bound on a
      population nothing bounds (501 late effects would defeat it), and it is withdrawn.
    - **Enumerating what an environment owns.** Every transaction that takes a tenant slot
      also writes the installation's owner item, `SECRETOWNERS` / `<installationId>`, in the
      environment's own table (base table, not an index:
      [Writes](#writes-a-control-plane-secrets-broker-not-the-console)). So the set of
      installations that hold or ever held a tenant slot is one partition, read completely by a
      paginated `Query` with `ConsistentRead` true; no GSI's eventual consistency, no legacy
      unindexed row (no secret row predates phase 2), and no derivation from SSM names, which
      cannot show a begun write whose parameter has not landed. The environment counter checks
      the census: after a drain pass, the sum of `SECRETSLOTS.n` over the owner items must equal
      `COUNT.n` by consistent read, and a mismatch is an invariant violation that stops the
      procedure and alarms instead of releasing anything.
    - **Releasing an allocation is an authority transition shared with admission.** Deleting an
      environment's stacks does not release its allocation: tenant parameters are created by the
      broker, not by CloudFormation, so they outlive the stack, and a released allocation over
      live parameters would let another environment over-admit. Observing the path empty and
      then releasing is not enough either: a still-deployed broker could commit a begin after the
      empty listing and create a parameter while another environment holds the returned budget.
      So the release procedure (phase 2, hand-run beside the registry, never by CD) first takes
      admission away, then waits for what was admitted to drain, then returns the budget, each
      step conditioned on the allocation's `gen` read at the start (`:gen`):
      1. **Fence (one cross-table transaction).** `ALLOC#<env>` `SET state = :releasing` on
         `gen = :gen AND state = :active`; and `CONFIG#SECRETSLOTS` / `COUNT` `SET state =
         :draining REMOVE budget` on `gen = :gen`. From this commit on, every broker begin fails
         its environment condition (`state = :active`), and every deploy of the environment
         fails its `ALLOC` condition. A begin either committed before the fence, so its slot is
         in `n`, or is refused; there is no window between them, because both are conditions on
         the same item. Delete begins take no environment slot and do not touch `COUNT`, so the
         drain's deletions still run.
      2. **Drain.** The procedure invokes the settler in `drain` mode. The settler pages through
         the `SECRETOWNERS` partition (consistent `Query`) and, for every installation it
         lists, runs a delete for every index row and makes every non-quarantine `SECRETGC#`
         item due, as an uninstall does ([Lifecycle](#lifecycle-audit-and-failure)). A write
         whose begin committed before the fence but whose parameter has not landed is an index
         row with a live `op`, found by the same `Query` of its installation's partition and
         settled by observation after `H`: present becomes `done` and is then deleted; absent
         becomes quarantined. The procedure waits until, by consistent read, `COUNT.n =
         COUNT.q` (absent counts as 0), and the owner census sums to `COUNT.n` (above): every
         slot left is then a quarantined one, and every other `current`, live `op` and
         `SECRETGC#` item has been settled by a confirmed deletion.
      3. **Census.** No earlier than `H` after the fence committed, `DescribeParameters` over
         `/lca/<env>/` (recursive) must return nothing except parameters at quarantined paths;
         the operator deletes any platform parameter first. By `H` every request the broker
         signed before the fence has been received or can no longer be
         ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)). A parameter at a
         quarantined path is deleted and keeps its slot; any other parameter the census finds
         is counted and deleted by one more sweep, and the procedure returns to step 2.
      4. **Release (one cross-table transaction).** `DELETE ALLOC#<env>` on `gen = :gen AND
         state = :releasing AND tenantBudget = :tb AND platformReserve = :pr`, the values read
         from that row; when `:q` (the `COUNT.q` read in step 2) is non-zero, `PUT
         QUARANT#<env>#<gen>` = `{q: :q, tracked: true}` on `attribute_not_exists(pk)`; `TOTAL`
         `ADD total :minus` where `:minus = −(:tb + :pr − :q)`; and `COUNT` `SET state =
         :released` on `gen = :gen AND state = :draining AND n = :q AND q = :q` (each absent
         attribute read as 0 by an `attribute_not_exists` disjunct). So the quarantined slots
         move from the allocation to a `QUARANT#` row in the same commit and stay charged to
         `TOTAL` once; only the rest returns. An orphan the sweep counted after the census
         raises `n` and cancels the release, which retries from step 2. A retry after a lost
         response cannot move the slots twice: the procedure re-reads first, and `ALLOC#<env>`
         absent with `COUNT` `released` under `:gen` means the release committed, so it stops;
         a blind resend fails the `ALLOC#<env>` condition (and, within ten minutes, is collapsed
         by the transaction's `ClientRequestToken`), and the one `QUARANT#<env>#<gen>` key per
         generation refuses a second row.

      <a id="retained-table-ownership"></a>**The Data stack keeps owning its table, and a
      retained table is re-adopted by resource import, never by an ordinary deploy.** Release
      and redeploy only work if the redeploy's allocation transaction can read the table's
      `COUNT`. The table has a fixed physical name, `lca-<env>` (`lib/data-stack.ts`), and
      `RETAIN` keeps the table but not CloudFormation's ownership of it: once its stack is
      deleted, or a first create rolls back past it, CloudFormation no longer manages the table,
      and an ordinary deploy of a re-created stack issues a CREATE for the same name. That fails
      `ResourceAlreadyExistsException` before the allocation custom resource runs, so `COUNT`
      never reaches the absorb. [ADR-033](../DECISIONS.md#adr-033) hit the same hazard with the
      run log group. Phase 2 therefore fixes the table's lifecycle in three parts:
      1. **Release does not delete the Data stack.** Tearing an environment down deletes its
         other `LCA-*-<env>` stacks and runs the release procedure above. `LCA-Data-<env>`
         stays, and keeps owning the table, the allocation custom resource and `COUNT`. Phase 2
         deploys it, in every environment that holds a non-zero allocation (the same set whose
         table is `RETAIN`, below), with CloudFormation termination protection (CDK `terminationProtection:
         true`, a plain constant, so credential-less synth is unaffected), so `cdk destroy` and
         `DeleteStack` refuse it. CD never deploys or deletes it
         ([ADR-047](../DECISIONS.md#adr-047)'s allowlist excludes `LCA-Data-*`). An operator who
         wants a released environment gone for good may lift protection and delete the stack
         and then the table by hand: with `q = 0` nothing remains to absorb and a later deploy
         starts fresh; with `q > 0` the tracked `QUARANT#` row then stays charged for ever, the
         fail-closed case below.
      2. **A redeploy after a release updates that same stack.** The allocation custom resource
         takes an `allocationEpoch` property (`-c secretAllocationEpoch=<k>`, default 0) beside
         the budget, so it also runs on an update that changes only the epoch. The release
         procedure's last output names the next epoch. The operator's `cdk deploy
         LCA-Data-<env> -c secretAllocationEpoch=<k+1>` runs the allocation transaction above,
         which finds `ALLOC#<env>` absent and `COUNT` released, and absorbs. Its physical
         resource id is the fixed `secret-allocation-<env>`, so no update replaces it and
         CloudFormation sends it a Delete only on stack deletion or a create rollback; its
         Delete handler releases nothing. A deploy that leaves the epoch unchanged after a
         release does not reallocate, so the broker keeps refusing writes `secret-capacity`,
         which fails closed.
      3. **A table orphaned anyway is imported.** If the stack was deleted regardless
         (protection lifted by hand), or a first create rolled back and left the table, an
         ordinary `cdk deploy` fails `ResourceAlreadyExistsException` and changes nothing in the
         registry. The recovery (phase 2 adds it to the runbook) is CloudFormation resource
         import, in two deploys, because an import change set may contain only the resources
         being imported and a custom resource cannot be imported. First, synthesize the Data
         stack with `-c dataImportOnly=true`, which emits only the table, with its `Retain`
         policy and its current key schema and indexes, and run `cdk import` mapping it to
         `TableName = lca-<env>`. Second, run an ordinary `cdk deploy` with the next epoch, which
         adds the rest of the stack. The allocation custom resource's Create then reads the
         retained `COUNT` and absorbs exactly as on an update. Import adopts the table with its
         items, so `COUNT`, `SECRETOWNERS`, the `SECRETGC#` quarantine items and every index row
         reach the absorb unchanged. If the orphaned table held an active allocation rather than a
         released one (the stack deleted without a release), the Create finds `ALLOC#<env>`
         present with `COUNT.gen = ALLOC.gen` and takes the update branch with `:old =
         ALLOC.tenantBudget`, so it charges only the difference. `lca-account-quota` is
         recovered the same way, with `LCA-Account`'s own import-only synth; its seed's
         condition leaves the imported `TOTAL` untouched.

      **When the environment's table no longer exists** there is no counter to fence, and no
      broker can commit a begin, because the begin transaction names that table; but there is
      also no record of which writes are quarantined. Phase 2 therefore makes the Data table
      `RETAIN` in every environment that holds a non-zero allocation (today only `prod` is,
      `lib/data-stack.ts`), so the table outlives even a forced stack deletion and can be
      imported ([above](#retained-table-ownership)). If it is gone anyway (the table itself
      deleted by hand), step 1 is the registry action alone, taken after `DescribeTable` returns
      `ResourceNotFoundException`, and followed by a second `DescribeTable`. A deploy that
      re-created the table and committed its allocation before the registry fence wrote
      `gen = :gen` onto its `COUNT`; any later deploy fails `allocation-releasing`, so if the
      second call finds the table, the procedure applies the `COUNT` half of step 1 alone
      (`SET state = :draining REMOVE budget` on `attribute_not_exists(gen) OR gen = :gen`) and
      continues on the ordinary path. If the table is still absent, the procedure fails closed
      on the unknown: it deletes the platform parameters and every tenant parameter it lists
      under `/lca/<env>/tenant/`, and step 4 runs with `:q = :tb` and without the `COUNT` action,
      so the whole tenant budget stays charged as `QUARANT#<env>#<gen>` with `tracked = false`
      and only the platform reserve returns. An untracked row is never absorbed: no table
      records which of its slots are quarantined, so a later deploy of a re-created Data stack,
      which creates a fresh table with no `COUNT` (the name is free, because the table is gone), carries nothing and charges its own allocation for its own new
      writes, while the untracked row keeps covering whatever the lost table had begun. The
      same holds for a tracked row whose table is deleted by hand while released: with no
      `COUNT` to absorb it, it stays charged, which fails closed.

      **Generations stop ABA.** After a release, a redeploy of the same environment name (an
      epoch-bumped update of its retained Data stack, or the import path, [above](#retained-table-ownership))
      creates a new `ALLOC#<env>` with a fresh `gen` and sets `COUNT` back to `active` under it
      (its condition admits `state = released`; `n` and `q` carry over, so the new budget must
      cover the quarantined slots the table still records, which the existing `n <= :new`
      condition already enforces, and the same transaction absorbs `QUARANT#<env>#<oldgen>` so
      those slots are charged inside the new `tenantBudget` and nowhere else). A later release
      writes `QUARANT#<env>#<newgen>` for the then-current `q`, which includes the carried
      slots, so a release, redeploy, release cycle leaves `TOTAL` charging each distinct
      quarantined slot once: with `q = 100`, `tenantBudget = 1,000` and the 50 reserve, `TOTAL`
      reads 100 after the first release, 1,050 after the redeploy (charged `1,050 − 100 = 950`),
      and 100 again after the second release. A release procedure still holding the old `:gen`, retried late
      at any step, fails its condition and changes nothing, so it can never fence, drain or
      return the budget of the newer allocation.

      **A late effect after release** can only land at a quarantined path, because every other
      path's operation was settled by a confirmed answer. Its slot is charged once, to the
      `QUARANT#` row while the environment is released and to the new allocation after a
      redeploy absorbs that row, so it never pushes the account past `cap`. The sweep finds the
      parameter named by its quarantine `SECRETGC#` item, deletes it and releases nothing, so
      the slot stays in `q`. A `QUARANT#` row is removed only by the absorb, which moves its
      charge rather than returning it; no slot leaves `TOTAL` in v1 (OQ-15). Until a release
      completes the allocation stays charged, so a stale allocation fails closed: it refuses a
      later deployment, never admits one.
    - **Defaults.** `tenantSecretSlotBudget` is a new per-environment knob (phase 2 adds it to
      `lib/env-config.ts`, [ADR-033](../DECISIONS.md#adr-033)), 8,000 for `prod` and 1,000 for
      every dev-shaped name; `platformReserve` is 50 for every environment and is not a knob.
      `prod` allocates 8,000 + 50 = 8,050, and one `dev` 1,000 + 50 = 1,050, so `prod` plus one
      `dev` charge `TOTAL` 9,100 of 9,500, of which 9,000 are admissible tenant slots and 100
      platform reserve. The 400 left cannot hold a third dev-shaped environment (1,050), so its
      deployment fails `account-quota-exhausted` until a budget is lowered, which is the point.
      Spec 05 recommends separate accounts, and with them each environment's allocation stands
      alone.
    - **Tests (phase 2).** Against two independent environment tables and one registry: two
      environments deploying concurrently, whose budgets together cross `cap`, end with exactly
      one allocation committed and the other deployment failed; two environments each one slot
      below their granted budget, whose granted budgets together reach `cap`, receive concurrent
      writes, and the two counters never exceed their budgets, so the account total never
      exceeds `cap`; an environment allocated 8,050 admits exactly 8,000 tenant slots and refuses
      the 8,001st `secret-capacity`, and at every step of every test `COUNT.n ≤ tenantBudget`
      on admission and `tenantBudget + platformReserve = ` the row's charge to `TOTAL`; lowering
      a budget below an environment's live count is refused; an environment whose allocation
      failed refuses every write; and a deleted environment's allocation is still held until the
      release procedure completes. The release tests inject a barrier at each transition: a
      broker begin held between the release procedure's empty census and its release, then
      allowed to run, is refused because the fence committed first; a begin held until just
      after the fence commits is refused, and one that committed just before it is counted and
      makes the procedure wait in drain; a sweep orphan counted after the census cancels the
      release; the table-absent path releases only after `ResourceNotFoundException` and keeps
      the whole tenant budget charged; and an ABA run (release, redeploy under a new `gen`, then
      the old procedure's steps retried) leaves the new allocation and `TOTAL` unchanged. The
      lifecycle-cycle tests assert that `TOTAL` tracks distinct quarantined slots, not
      generations: with `q = 100`, `tenantBudget = 1,000` and the 50 reserve, release,
      redeploy, release, redeploy, release reads `TOTAL` 100, 1,050, 100, 1,050, 100, with
      exactly one `QUARANT#<env>#*` row while released and none while active; the same cycle
      with the release transaction's response dropped and the procedure re-run, and with the
      redeploy's allocation response dropped and the custom resource retried, reads the same
      values; a cycle in which 5 more writes quarantine while active ends at `q = 105` and
      `TOTAL` 105; a released `COUNT` whose `QUARANT#` row was deleted or altered by hand fails
      the redeploy `quarantine-ledger-mismatch` and charges nothing; and an untracked row from
      the table-absent path is never absorbed by a redeploy into a fresh table. The
      late-effect test: 1,000 writes in one environment are each given a `PutParameter` that the
      broker sees time out and that SSM holds unfinished, so all 1,000 settle quarantined; the
      environment is released while a second environment, allocated concurrently, takes all the
      capacity the release returned and fills it with tenant parameters; then all 1,000 held
      requests land. At every step the number of parameters in the account (measured by
      `DescribeParameters` in the test account) is at most `TOTAL.total` + the out-of-design
      parameters the test planted, and `TOTAL.total ≤ cap`; no `PutParameter` by either
      environment fails `ParameterLimitExceeded`. The enumeration tests: a write whose begin
      committed just before the fence and whose `PutParameter` has not been sent yet (no
      parameter exists, `COUNT.n` holds its slot) is found by the drain through
      `SECRETOWNERS` and settled; an installation whose `INSTALL#` row has no `gsi1pk`
      (the legacy shape `src/shared/install-store.ts` repairs) and that no console session
      names is drained all the same, because enumeration never reads the installation index;
      and a `SECRETOWNERS` item deleted by hand makes the census mismatch, so the procedure
      stops and alarms instead of releasing. The table-ownership tests run against real
      CloudFormation in the test account, with `q = 100` quarantined, `tenantBudget = 1,000`
      and an installation in `SECRETOWNERS`: `DeleteStack` on `LCA-Data-<env>` is refused by
      termination protection; after a release, a redeploy with the epoch unchanged leaves
      `TOTAL` at 100 and writes refused, and with the epoch bumped absorbs (`TOTAL` 1,050, no
      `QUARANT#` row); the destroy/recreate test lifts protection, deletes the stack after a
      release, and shows an ordinary deploy of the re-created stack failing
      `ResourceAlreadyExistsException` with `TOTAL` still 100 and the `QUARANT#` row intact, then
      runs the two-deploy import and asserts that the allocation custom resource's Create read
      the retained `COUNT` (released, `n = q = 100`) and committed the absorb (`TOTAL` 1,050,
      `COUNT` active under a new `gen` with `q = 100`, the owner item and the 100 quarantine
      items unchanged); the same test without a release first (stack deleted while active)
      ends with `TOTAL` unchanged; a first create forced to fail after the table is created is
      recovered by the same import; and a deleted and imported `lca-account-quota` keeps its
      `TOTAL` through `LCA-Account`'s seed.
  - **The real count is measured too.** The settler's daily sweep also pages through
    the whole account's parameter list with `DescribeParameters` (names and metadata only; the
    same grant the sweep already needs) and publishes the total as a metric. An alarm fires at
    80 % of the 10,000 quota on that measured number. It is a check on the allocation, not the
    mechanism: it shows a parameter created outside this design (the account is meant to be
    dedicated to LCA, spec 05) as a count before it could become a `ParameterLimitExceeded`
    failure. A second metric publishes each environment's `COUNT.q` and alarms on any
    increase, because every quarantined slot is capacity lost until OQ-15 closes.
  - **Request rates are account-wide too, and are not allocated.** Parameter Store and KMS
    throttle by request rate per account and Region, so co-tenanted environments can slow each
    other's secret resolution. v1 bounds each environment's resolution rate by its broker's
    reserved concurrency ([ADR-021](../DECISIONS.md#adr-021)) and states the residual: a
    throttled resolution is retried and then fails the attempt closed with
    `engine-secret-unavailable` ([Lifecycle](#lifecycle-audit-and-failure)); it never runs a job
    with a secret missing. Separate accounts, as spec 05 recommends, remove the interaction.
  OQ-8 owns raising either cap.
- **Key:** one customer-managed KMS key per environment for tenant secrets, separate from the
  platform-credential key. A key per installation was considered and **not** chosen: isolation
  here comes from the encryption-context conditions below, which bind a decrypt to one parameter
  path whichever key is used. Per-installation keys would add key creation to onboarding, a
  per-key monthly cost, and a key-policy fan-out, without stopping any attack the context
  condition does not already stop. The blast radius is therefore stated as what the IAM grants
  allow, not as "one key, one tenant".
- **Index row:** `INSTALL#<installationId>` / `SECRET#<NAME>` holds name, `current` (the path,
  `opId`, `updatedAt` and `updatedBy` of the parameter that is the secret's value), and while an
  operation is unsettled its `op` ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)).
  **Never the value.**

### Writes: a control-plane secrets broker, not the console

The console λ keeps exactly [ADR-025](../DECISIONS.md#adr-025)'s grants. Secret intake follows
[ADR-034](../DECISIONS.md#adr-034)'s appcfg pattern:

1. The console authenticates the operator (GitHub OAuth session) and checks they administer the
   installation ([ADR-022](../DECISIONS.md#adr-022)).
2. It invokes a new single-purpose λ, `lca-<env>-tenantsecrets`, reachable only through
   `lambda:InvokeFunction` on its exact ARN from the console λ's role. The request carries
   `{installationId, name, value}` plus the session's verified `login` and the installation list
   the session holds.
3. The broker re-checks that `installationId` is in that list, validates `name`
   (`^[A-Z_][A-Z0-9_]{0,99}$`, not `GITHUB_*`), refuses a value over 4096 bytes
   (`secret-too-large`, see [Storage](#storage)), a 101st name for the installation
   (`secret-quota`) and a write with no parameter slot left (`secret-capacity`), and runs the
   operation protocol below.
4. It returns presence only, or `pending` when the SSM outcome is unknown; the settings screen
   then shows "write by `<login>` at `<time>`, settling" until the settler finishes it.

**The operation protocol.** SSM and DynamoDB cannot share a transaction, and `PutParameter` and
`DeleteParameter` take no client token, so a call that times out has an unknown outcome and can
still take effect later. An expiring lease cannot fence that: the previous revision gave each
name a 30-second claim, and an SSM call that settled after the claim expired could land after a
successor had already acted on the same parameter and recorded its result. The protocol below
instead makes every operation's effect land on a parameter **no other operation ever touches**,
keeps the name locked by a **durable** operation record until that effect is settled by
observation, and commits the lock, the quotas and the audit together. Because each write creates
a parameter, every write also takes a **parameter slot** ([Storage](#storage)) in the same
transaction, and the slot follows the parameter until a transaction records that the parameter
is confirmed gone.

- **One parameter per write.** A write of `NAME` stores the value at a fresh path
  `/lca/<env>/tenant/<installationId>/secrets/<NAME>/<opId>`, where `opId` is a random 128-bit id
  minted for this operation, with `Overwrite` false, so no other request can create, replace or
  be confused with that parameter. The index row's `current` names the parameter that is the
  secret's value (`{path, opId, updatedAt, updatedBy}`); the resolver reads `current`, never a
  path it derives ([Reads](#reads-a-capability-bound-resolver)). Rotation is a new parameter
  plus a pointer move, never an in-place overwrite.
- **Begin: one transaction, all `Update`; six actions for a write, two for a delete.** On the
  index row `INSTALL#<installationId>` / `SECRET#<NAME>`: set
  `op = {opId, kind, path, login, startedAt}` and the sparse GSI1 key `SECRETOPS#pending` /
  `dueAt = now + H`, on condition `attribute_not_exists(op)` (and, for a delete,
  `attribute_exists(current)`); for a delete, the same action also moves `current.path` into
  `op.path` and removes `current`, so a job resolving the name from then on sees it unset (`''`,
  as GitHub resolves a deleted secret). For a write only, four more:
  - `INSTALL#<installationId>` / `SECRETNAMES`: `ADD names :name` on condition
    `attribute_not_exists(names) OR size(names) < :namecap OR contains(names, :name)`. A set add
    is atomic and idempotent per name, so the 101st distinct name fails however intakes
    interleave. A rotation passes this condition, which is why it alone cannot bound storage.
  - `INSTALL#<installationId>` / `SECRETSLOTS`: `ADD n :one` on condition
    `attribute_not_exists(closing) AND (attribute_not_exists(n) OR n < :installcap)` (200).
    `closing` is set by the uninstall fence ([Lifecycle](#lifecycle-audit-and-failure)).
  - `CONFIG#SECRETSLOTS` / `COUNT`: `ADD n :one` on condition
    `state = :active AND attribute_exists(budget) AND (attribute_not_exists(n) OR n < budget)`,
    where `budget` is the environment's tenant budget from the account registry, written onto
    this item at deploy and removed by the release fence ([Storage](#storage)).
  - `SECRETOWNERS` / `<installationId>`: `SET since = if_not_exists(since, :now)`, no
    condition. This is the environment's **owner index**: one base-table item per installation
    that has ever taken a tenant slot, in one partition, so every installation the release
    drain and the daily sweep must visit is found by one consistent, paginated `Query`. It is
    written in the same transaction as the slot, so no slot can exist for an installation the
    index does not name, including a begun write whose parameter has not landed yet. It is
    never deleted while its installation's `SECRETSLOTS.n` is non-zero, and in v1 never
    deleted at all (it is a few bytes per installation).

  Both slot conditions admit an absent counter explicitly, because a comparison against an
  absent attribute is false and `ADD` treats absence as zero, so the first write of an
  installation or an environment needs no initialising step; the environment's `budget`, by
  contrast, must exist, so an environment with no granted allocation refuses. The delta is
  always one, so `n < :cap` (or `n < budget`) is the exact check and needs no arithmetic. A
  delete takes no slot: the parameter it removes already
  holds one, which moves with `current.path` into `op.path`. On
  `SECRETAUDIT#<installationId>` / `<iso time>#<name>#<opId>`: create the audit row in state
  `pending` on `attribute_not_exists(pk)`. There is no separate claim, reservation or audit
  write: the transaction is all-or-nothing, so a crash before it leaves nothing and a crash after
  it leaves the lock, the name and parameter slots, the audit row and the settlement obligation
  together. If the cancellation reason is on `SECRETNAMES` the write is refused `secret-quota`;
  on either slot counter, `secret-capacity` (naming the cap, and for the installation cap the
  `dueAt` of its earliest `SECRETGC#` item); on the index row, `secret-busy`. A second
  operation on the name fails the `op` condition and is refused `secret-busy` until this one
  settles. The name stays busy for at most `H` (below) when an outcome is unknown, which is the
  price of never guessing. `CONFIG#SECRETSLOTS` is one item that every installation's writes
  update, so concurrent intakes can fail with `TransactionConflict`; the broker retries the
  identical transaction with backoff, which is cheap at the rate humans save secrets.
- **Effect.** A write calls `PutParameter` on `op.path`; a delete calls `DeleteParameter` on it
  (`ParameterNotFound` counts as done). A success settles `done` at once.
  `ParameterAlreadyExists` can only be this operation's own earlier attempt (no other operation
  knows the path) and settles `done`. Any other 4xx response settles a write `abandoned` at
  once, and its slot is released at once **only if every request the operation sent received an
  error response**; if any earlier request (an SDK retry's predecessor) got no response, that
  request may still land, so the write settles `abandoned` as **unconfirmed** (below). A 5xx
  response or no response (a timeout, a dropped connection, a crash) leaves the operation for
  the settler.
- **Settle: one transaction on condition `op.opId = :opId`.** `done` for a write: `current` ←
  `op.path`, remove `op` and the GSI1 key, audit row → `done`, and, if there was a previous
  `current`, a cleanup item `INSTALL#<installationId>` / `SECRETGC#<old opId>` naming the old
  path with GSI1 `SECRETGC#pending` / `dueAt = now + G`. `done` for a delete: remove `op`, the
  GSI1 key and the index row's metadata, `DELETE names :name` on `SECRETNAMES`, audit row →
  `done`. `abandoned` (a write only; a delete is never abandoned, it is retried until it
  succeeds): remove `op` and the GSI1 key, audit row → `failed`, and, if the row has no
  `current`, `DELETE names :name`, which returns the slot the begin step reserved. The condition
  names the operation, so a settlement can be applied twice, by the broker and the settler, and
  the second is a no-op.

  How each settlement moves the parameter slot (both counters, `SECRETSLOTS` and
  `CONFIG#SECRETSLOTS`, by the same amount in the same transaction):
  - **Write `done`**: the slot moves with `op.path` into `current`; if there was a previous
    `current`, its slot moves with it into the new `SECRETGC#` item. No counter changes.
  - **Write `abandoned`, confirmed** (every request answered with an error, so no parameter
    exists): `ADD n :minusone` on both counters. This is the only release that happens without a
    deletion, because nothing was created.
  - **Write `abandoned`, unconfirmed** (some request got no answer, or the settler observed
    the path absent): the slot is **quarantined**. The same transaction creates
    `INSTALL#<installationId>` / `SECRETGC#<opId>` with `kind = quarantine`, naming `op.path`,
    and applies `ADD q :one` to both counters (`n` is unchanged: the slot is still held, now
    marked as one that may never be released). A request SSM received may land at any later
    time, and no published AWS bound says when (below), so a quarantined slot stays charged for
    as long as such a landing is possible: in v1, for ever (OQ-15). Its item has no GSI1 key and
    is never released by a timer; the sweep deletes any parameter that lands at its path, and
    that deletion's answer releases nothing.
  - **Delete `done`**: `ADD n :minusone` on both counters, because `DeleteParameter` returned
    success or `ParameterNotFound`, which are SSM's own answers about that path.
  - **`SECRETGC#` done** (below), for `kind` `superseded` or `orphan`: the settler's
    `DeleteParameter` on the item's path returned success or `ParameterNotFound`; one
    transaction removes the item on condition `attribute_exists(pk) AND kind <> :quarantine`
    and applies `ADD n :minusone` on both counters, so a second application of the same
    deletion fails its condition and releases nothing twice, and a quarantine item is never
    released by it.
- **The settler decides only from what SSM shows, and never takes over.** `lca-<env>-secretsettler`
  is a single-purpose λ that the Reaper invokes with an index row key when the row is past its
  `dueAt` in `SECRETOPS#pending` (the [obligation index rule](#data-model-q6)). It looks the
  operation's own path up with `DescribeParameters` filtered to that exact name, which returns
  metadata (name, type, version, last-modified time) and never a value: for a write, **present**
  settles `done` and **absent** settles `abandoned`, unconfirmed (its slot is quarantined, above).
  For a delete it does not rely on a listing: it calls `DeleteParameter` again, and success or
  `ParameterNotFound` settles `done`, so no slot is released on an observation that metadata
  lag could make wrong. Because the path is unique to the operation, no
  other request can make it present or absent, so the observation is about this operation alone,
  and because the lock is durable, no other operation on the name can begin while the effect is
  unsettled. `H` is 15 minutes. The broker's Lambda timeout is 60 s, so its SDK signs its last
  request (retries included) by `startedAt + 60 s`, and AWS rejects a SigV4-signed request that
  reaches it more than five minutes after its signature time
  ([Signature Version 4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-elements.html)),
  so by `startedAt + H` the broker's request has either been received long ago or can no longer
  be. If `DescribeParameters` fails, the settler leaves the row due and alarms; it never guesses.
  If metadata lags a write that did land, the settler settles `abandoned`, the operator sees the
  write as failed and repeats it, and the landed parameter is named by its quarantine
  `SECRETGC#` item and deleted by the next sweep: the error is a lost write the operator was
  told about, and one quarantined slot, never a value served or counted wrongly.
- **What a late landing can still do, and what catches it.** No published AWS bound says when a
  received `PutParameter` finishes, so the design does not assume one. Every write that might
  still land holds a quarantined slot, charged to its installation, its environment and,
  through the environment's allocation (or, after a release, its `QUARANT#` row), to the
  account registry's `TOTAL` ([Storage](#storage)). A late landing therefore creates a
  parameter at a path whose slot is already charged, and since parameter names are unique it
  creates at most one. The resolver never reads it (it follows `current` only), so it is never
  served, and the next sweep deletes it while the slot stays quarantined. The number of late
  effects can be anything; each one was charged when it became possible, so no count of them
  can push the account past `cap`. The cost is capacity: quarantined slots accumulate, they
  count against the installation's 200 and the environment's budget, and only OQ-15 can return
  them. A metric publishes `COUNT.q` and alarms on every increase. The settler's **orphan
  sweep**, run by the Reaper daily and on every uninstall, finds its installations without
  trusting any one record: it takes the union of the `SECRETOWNERS` partition (consistent,
  paginated `Query`) and the installation ids that appear as path segments in a recursive
  `DescribeParameters` listing of `/lca/<env>/tenant/`, and an id the listing shows but the
  owner index lacks (possible only for a parameter written before its table was re-created)
  is first added to the index. For each installation it lists
  `/lca/<env>/tenant/<installationId>/secrets/` with `DescribeParameters` (recursive path
  filter), then reads the installation's `SECRET#` and `SECRETGC#` rows with consistent reads.
  A listed parameter named by a quarantine item is deleted, and the item stays. Every other
  listed parameter whose last-modified time is older than `H` and that is neither a
  `current`, nor the path of a live `op`, nor named by a `SECRETGC#` item is an orphan: the
  sweep **counts it first**, in one transaction that creates `SECRETGC#<opId>` with
  `kind = orphan` on `attribute_not_exists(pk)` and applies `ADD n :one` to both slot counters
  with **no** cap condition (the parameter already exists, so refusing to count it would only
  hide it), then deletes it through the ordinary `SECRETGC#` path, which releases the slot on
  confirmed deletion. A counter pushed past its cap this way refuses further writes until the
  orphan is gone, which is the point. In this design an orphan arises only from a crash the
  protocol did not foresee or from a parameter written outside it, so each one increments a
  metric that alarms on any non-zero value. Listing before reading is what makes it safe against a concurrent write: a
  parameter that exists at listing time was created by an operation whose begin had already
  committed, so the later read sees its path as an `op` or, if settled meanwhile, as `current`
  or a `SECRETGC#` item (settle moves the path in one transaction). A parameter deleted between
  the listing and the read (a delete or a `SECRETGC#` item settling meanwhile) looks orphaned,
  is counted, and its deletion then answers `ParameterNotFound` and releases the slot again: a
  transient overcount, which refuses writes early and never admits one late. The sweep is also what finds
  the parameters of any crash the protocol above did not foresee, so recovery does not depend on
  knowing every failure point in advance. The same daily run lists the whole account's
  parameters (no path filter, names and metadata only) and publishes the total, which drives the
  80 % account-quota alarm ([Storage](#storage)).
- **Old values are deleted after a grace period.** `SECRETGC#` items are driven by the Reaper
  through the settler when due: a superseded value after `G` = 15 minutes, so a resolver that
  read the previous `current` just before the move can still fetch it; an orphan at once. A
  quarantine item is never due; the sweep deletes a parameter found at its path and keeps the
  item and its slot. The settler calls `DeleteParameter` (`ParameterNotFound` counts
  as done) and then removes the item and releases its slot in one transaction. A failed delete
  leaves the item due, retried and alarmed, and keeps the slot held. A resolver whose
  `GetParameter` returns `ParameterNotFound` re-reads the index row once before failing closed.

The invariants, checked by a phase-2 test that runs a write, a rotation and a delete of one name
with every interleaving of their steps and a crash or timeout injected at every boundary
(before begin, after begin, after the SSM call is sent, after it returns, before and after
settle), including an SSM call held past settlement and then allowed to land, are:

1. A name is in `SECRETNAMES` exactly when its index row has a `current` or a live `op`.
2. An installation's `SECRETSLOTS.n` equals its number of `current` pointers, plus live `op`s
   (a delete's `op` holds the slot its former `current` held), plus `SECRETGC#` items, and its
   `SECRETSLOTS.q` equals its number of quarantine items; `CONFIG#SECRETSLOTS.n` and `.q` equal
   the sums over installations; every installation with a non-zero `SECRETSLOTS.n` has a
   `SECRETOWNERS` item; and admission never raises `CONFIG#SECRETSLOTS.n` past that item's
   `budget` (only the sweep's uncapped orphan count can, which then refuses writes until the
   orphan's deletion is answered).
3. Every parameter under the installation's path is a `current`, a live `op`'s path, or a
   `SECRETGC#` item's (including a quarantine item's), so it holds a slot. There is no
   exception: a late landing lands at a quarantined path.
4. Every parameter the resolver can be pointed at is some row's `current`.
5. Every operation that began has an audit row, which ends `done` or `failed`.
6. Across every environment in the account and Region, the registry's `TOTAL.total` equals the
   sum over its `ALLOC#` rows of `tenantBudget + platformReserve` plus the sum over its
   `QUARANT#` rows of `q`, and is at most `cap`; each
   environment whose `COUNT.state` is `active` has `COUNT.budget = ALLOC#<env>.tenantBudget` and
   `COUNT.gen = ALLOC#<env>.gen`, and one whose `COUNT` is `draining` or `released` has no
   `budget` and admits nothing; and an `ALLOC#<env>` row leaves `TOTAL` only in the release
   transaction, after its `COUNT` was fenced and drained to `n = q`, and that same transaction
   moves `q` to a `QUARANT#` row; a tracked `QUARANT#<env>#<gen>` row leaves `TOTAL` only in
   the allocation transaction that re-creates `ALLOC#<env>`, which deletes it on condition
   that the released `COUNT` (under that `gen`) still holds the same `q` and charges those slots
   inside the new `tenantBudget`, and an untracked one never leaves. At most one tracked
   `QUARANT#<env>#*` row exists per environment, and only while that environment has no
   `ALLOC#<env>` row, so no quarantined slot is charged twice and none is charged zero times.
   So every tenant parameter
   that exists or may yet land, plus every platform reserve, is charged to `TOTAL` exactly once, which stays
   at most 9,500 of the 10,000-parameter quota, and no environment can admit a tenant
   parameter into its 50 platform reserve.

The quota-boundary tests, run against the real counter items: an installation at 199 slots
receives 50 concurrent rotations of one existing name and of distinct names, and exactly one is
admitted, the rest refused `secret-capacity`; two installations write concurrently into an
environment one slot below its budget, and exactly one succeeds; a loop that rotates one name as
fast as `secret-busy` allows, with `SECRETGC#` deletion delayed and then failing, keeps the
installation at most 200 slots and the environment at most its budget at every step, and admits
writes again only after a deletion's answer releases a slot; an unconfirmed write is
quarantined, and when its `PutParameter` is held for any length of time and then allowed to
land, the parameter is deleted by the next sweep while the slot stays held (`q` unchanged, no
further write admitted on that slot); 200 quarantined writes at one installation leave it
admitting none, refused `secret-capacity` naming quarantine as the cause, even after every
held request has landed and been deleted; and a sweep run twice over one orphan counts it once.

The broker's IAM: `ssm:PutParameter` and `ssm:DeleteParameter` on
`parameter/lca/<env>/tenant/*/secrets/*`, `kms:Encrypt` on the tenant-secret key **conditioned**
on `kms:EncryptionContext:PARAMETER_ARN` matching that same path pattern, and on the table, with
`dynamodb:LeadingKeys` limited to `INSTALL#*` (index, `SECRETNAMES`, `SECRETSLOTS` and
`SECRETGC#` rows), `CONFIG#SECRETSLOTS` (the environment's slot counter), `SECRETOWNERS`
(the owner index) and
`SECRETAUDIT#*` (audit rows): `UpdateItem`, the one action its begin and settle transactions
are made of (every create is an `Update` on `attribute_not_exists`). Neither the broker nor
the settler holds any grant on the account registry table: only the deploy-time allocation
custom resource does (`GetItem` and `UpdateItem` on `QUOTA#ssm-standard`, plus `UpdateItem` on
its own environment's `CONFIG#SECRETSLOTS`), and the hand-run release procedure, under the
operator's own credentials (`GetItem`, `UpdateItem`, `PutItem` and `DeleteItem` on
`QUOTA#ssm-standard`; `GetItem` and `UpdateItem` on the environment's `CONFIG#SECRETSLOTS`;
`Query` with `dynamodb:LeadingKeys` = `SECRETOWNERS` and `GetItem` on `INSTALL#*`, both
read-only, for its own independent owner census; `dynamodb:DescribeTable`;
`ssm:DescribeParameters`, and `ssm:DeleteParameter` on `parameter/lca/<env>/*`;
`lambda:InvokeFunction` on the settler). A broker bug
therefore cannot raise its environment's budget. The settler's IAM:
`ssm:DescribeParameters`, `ssm:DeleteParameter` on the same path pattern, and on the table, with
the same `LeadingKeys`, `GetItem`, `Query` (an installation's `SECRET#` and `SECRETGC#` rows,
and the `SECRETOWNERS` partition, for the sweep and the drain) and
`UpdateItem`; the Reaper gains `lambda:InvokeFunction` on the settler's exact ARN and nothing
else. `DescribeParameters` cannot be scoped to a path: the Parameter Store access examples grant
it on `"Resource": "*"`
([Parameter Store access](https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-paramstore-access.html)),
so the settler can list the name and metadata of every parameter in the account. That is the
stated residual; it reveals no value. Every operation each principal performs is in its list, and
nothing else is; the phase-2 test drives intake, rotation, deletion, settlement, sweep and the
quota refusal against both policies, including 100 concurrent intakes of distinct new names at
99 stored, of which exactly one succeeds.
**Neither principal holds `ssm:GetParameter`, `ssm:GetParameters`, `ssm:GetParametersByPath`,
`ssm:GetParameterHistory` or `kms:Decrypt`**: the write path cannot read a secret back, including
the one it just wrote, and its reconciliation reads metadata only. (`GetParameterHistory` is on
the list because it returns values too, and `GetParameter*` would return the ciphertext, which
is not needed.)

The residual: the broker trusts the console's statement of which installations the session holds.
A full compromise of the console λ could therefore write (overwrite) any tenant's secrets, but
**not read any**, which is the property that matters most for exfiltration. This is the same trust
the appcfg broker places in the console today. Overwrite is detectable: every write is audited and
surfaced on the installation's settings screen as `updated by <login> at <time>`.

### Reads: a capability-bound resolver

Secret values are read by a second single-purpose λ, `lca-<env>-secretresolver`. Nothing else in
the platform holds `kms:Decrypt` on the tenant-secret key.

1. **At dispatch**, Provision writes the JobSpec under the attempt's partition. It contains the
   **names** of the secrets the job references, the installation id and the trust class. It
   contains no value. For `fork` and `restricted-bot` runs the name list is empty, regardless of
   what the YAML says ([Trigger trust](#trigger-trust-forks-bots-and-re-runs)).
2. **At the VM's `jobspec` call**, the hook broker authenticates the VM's capability token
   against the attempt row (as it does for `jitconfig` today) and invokes the resolver with only
   the **ref**. The broker does not pass names or an installation id; it cannot choose them.
3. **The resolver** reads the JobSpec by that ref (`GetItem`), checks the attempt row is
   `provisioning` or `running` and the JobSpec has not expired, then assumes a reader role with an
   **STS session tag** `installationId=<the JobSpec's installationId>`.
4. **The reader role's policy is attribute-based**, keyed on the session tag:
   `ssm:GetParameter` on `parameter/lca/<env>/tenant/${aws:PrincipalTag/installationId}/secrets/*`
   and `kms:Decrypt` on the tenant-secret key with
   `kms:EncryptionContext:PARAMETER_ARN` like
   `arn:aws:ssm:<region>:<account>:parameter/lca/<env>/tenant/${aws:PrincipalTag/installationId}/secrets/*`.
   With those credentials, a request for another installation's parameter is refused by IAM and,
   independently, by KMS's context check. The reader role's trust policy allows only the
   resolver's own role to assume it, and requires `sts:TagSession` with an `installationId`
   request tag, so an untagged session cannot exist.
5. The resolver reads each named secret's index row `INSTALL#<installationId>` / `SECRET#<NAME>`
   (`GetItem`, consistent read, under the JobSpec's installation id), takes `current.path`,
   checks that it starts with `/lca/<env>/tenant/<installationId>/secrets/<NAME>/` (a row patched
   to point at another name's parameter is refused, not followed; IAM already refuses another
   installation's), and fetches exactly those parameters. A row without `current`, including
   one whose delete has begun, is a name never set and resolves to `''`. A `ParameterNotFound`
   (the pointer moved and the old parameter was collected) re-reads the row once, then fails
   closed. The resolver returns `{name: value}` to the broker, and the broker returns it to the
   VM in the `jobspec` response. Nothing is persisted. The resolver's own table grant is
   `GetItem` with `dynamodb:LeadingKeys` limited to `ERUN#*` (the JobSpec and attempt row) and
   `INSTALL#*` (index rows).

What enforces what:

| Threat | Stopped by |
|---|---|
| A VM asks for another job's secrets | its capability token authorises only its own ref ([ADR-021](../DECISIONS.md#adr-021)); the resolver derives everything else from the stored JobSpec |
| A VM asks for secrets its YAML did not name | the name list was fixed at dispatch from the plan, not from the VM's request |
| A compromised broker asks for another tenant | the broker can only pass a ref; the installation comes from the stored JobSpec |
| A bug in the resolver passes the wrong installation to `GetParameter` | the assumed session is tagged with the JobSpec's installation; IAM and the KMS context condition both reject any other path |
| A forged JobSpec row names another tenant | only Provision can `PutItem` engine rows; the console's `UpdateItem` is narrowed off engine prefixes ([Data model](#data-model-q6)) |
| A full compromise of the resolver's own code | **not stopped**: it can assume the reader role with any tag. This is the residual, and it is why the resolver is a separate λ with one caller, no network path from the internet, and nothing else in it |

### Lifecycle, audit and failure

- **Rotation** is a new write: a new parameter at a new `opId` path, the pointer moved, and the
  old parameter deleted after the grace period. **Deletion** runs the operation protocol with
  kind `delete` and ends with the parameter, the index metadata, the name and the parameter slot
  gone. Rotation is bounded by the parameter-slot caps ([Storage](#storage)): each rotation holds
  one extra slot until the superseded value is confirmed deleted.
  **Uninstall** of the App first fences the installation: one `UpdateItem` sets `closing` on
  `INSTALL#<installationId>` / `SECRETSLOTS` (creating it if absent), so every later write begin
  fails its slot condition and is refused `secret-capacity`, however stale the console session
  that requested it; a write that committed its begin before the fence holds a slot and is
  settled like any other. Only then does the settler run a delete for every index row of the
  installation, then the orphan sweep, and every `SECRETGC#` item of the installation is made
  due at once; the installation's `SECRETSLOTS.n` falls to its quarantined `q`, and the
  environment counter falls by the same amount, only as those deletions are answered. The
  quarantined slots stay charged to the environment after uninstall (OQ-15), and the
  installation's `SECRETOWNERS` item stays, so the sweep keeps deleting any parameter that
  lands at a quarantined path. GitHub assigns a new installation id
  on reinstall, so `closing` is never cleared. Failure is retried and alarmed.
- **Audit:** every operation is a `SECRETAUDIT#<installationId>` row created in the operation's
  begin transaction (name, login, action, `opId`, time, state `pending → done | failed`, no
  value), so no operation can reach SSM without one. Every read is visible in CloudTrail as a KMS `Decrypt` whose encryption
  context names the parameter ARN, so who read which secret for which run is reconstructable.
- **Failure is fail-closed.** If any named secret cannot be resolved (missing, access denied,
  throttled after retries), the resolver returns an error, the broker returns no JobSpec, and the
  agent exits before step 1. The attempt fails with code `engine-secret-unavailable`, naming the
  secret, never its value. A job never starts with some of its secrets missing, because on GitHub
  a missing secret becomes `''`, and silently running a deploy with an empty credential is worse
  than not running it. (A name that was never set at all is treated the GitHub way, as `''`, and
  the check run says so; only a set-but-unreadable secret fails closed.)
- **Masked in logs by construction:** every resolved value is registered with the agent's masker
  before the first step runs, not on a best-effort `::add-mask::` from the workflow author. The
  same mask set governs every channel out of the VM, and an output containing a masked value is
  dropped, never stored ([Agent protocol](#agent-protocol),
  [Deadlines and outputs](#deadlines-and-outputs)).
- **What the no-plaintext promise covers, exactly.** The platform never *writes* a resolved secret
  value to a table row, a queue message or a log: the resolver returns values only in the
  `jobspec` response, and every upward channel is masked or filtered by the agent. Detection is by
  literal value, the same as GitHub's, so a value the job transforms (base64, reversed, split
  across outputs) is not recognised, on GitHub or here. That is the residual, and it is the same
  one the next paragraph names: a `trusted` run that wants to leak its own secret can.
- **No `secrets: inherit`** and no bulk injection in v1, which is also why reusable workflows are
  Refused.

**The residual risk, stated because it does not go away:** a `trusted` run executes workflow code
and receives the secrets it names. A malicious workflow committed to the repo can exfiltrate those
secrets; that is true on GitHub too, and it is the repo owner's trust decision about their own
default branch. What must hold is the **boundary**: no untrusted trigger receives a secret, and no
run receives another tenant's secrets.

## Per-job token & OIDC

Two tokens, and the second one is a genuine break we must not paper over.

**1. `GITHUB_TOKEN` equivalent.** Real GitHub mints a job-scoped token honouring the workflow's
`permissions:`. We can mint an installation token, but installation tokens are scoped to *the
installation's* repos and permissions, not to one job. v1 therefore mints a **narrow, short-lived,
single-repo** token whose permissions are exactly the job's effective `permissions:` set, which
the plan admits only when it is `{}` (metadata only, GitHub's meaning of an empty map) or
`contents: read`, for every trust class, and **refuses the whole run** if any job's effective set
asks for more, or if `permissions:` is omitted so that the effective set would be a repo or org
default we cannot see at plan time and could not mint if we did, rather than over-granting
silently. Adoption is already a file move, so adding `permissions: { contents: read }` at the same
time is one line. Untrusted runs
([Trigger trust](#trigger-trust-forks-bots-and-re-runs)) get the same read-only token and nothing
else.

**2. OIDC (`id-token: write`) — and ADR-047's dependency on it.** Our **own CD** consumes GitHub
OIDC: `LCA-Deploy-<env>`'s trust policy is `StringEquals` on
`repo:jsamuel1/LambdaCIActions:ref:refs/heads/main` with `aud=sts.amazonaws.com`
([ADR-047](../DECISIONS.md#adr-047)). That works today because **GitHub** issues the token:

> "Every time your job runs, GitHub's OIDC provider auto-generates an OIDC token."
> — [OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect)

ADR-047 verified the endpoint rides the **job message**, not the runner registration — which is
precisely why it survives our JIT-by-ref runners. **A job dispatched by our engine has no job
message from GitHub, therefore no `ACTIONS_ID_TOKEN_REQUEST_URL`, therefore no token.** Issuer
`https://token.actions.githubusercontent.com` is GitHub's; we cannot mint for it, and we should not
want to.

**Decision** ([ADR-059](../DECISIONS.md#adr-059)): **our own CD stays on the `workflow_job` path
(`adopt`/`label` mode) and is explicitly excluded from `engine` mode.** The platform must not
migrate the workflow that deploys the platform onto the platform's newest, least-proven subsystem —
and the fallback if it broke would be the workstation escape hatch
([ADR-047](../DECISIONS.md#adr-047)(f)), i.e. exactly the manual path CD exists to replace.

For *tenant* jobs that need cloud identity under `engine` mode, and only for `trusted` runs, the
design is our **own OIDC issuer** (an LCA-hosted JWKS, `iss=https://oidc.<console-domain>`, subject
`repo:<host>/<owner>/<repo>:ref:<ref>`), which a customer registers as a *separate* IAM identity
provider. That is additive, phase 6, and honest: **it is not a drop-in for
`token.actions.githubusercontent.com`** — every trust policy naming GitHub's issuer must be
extended by the customer, deliberately. Claiming otherwise would be the most dangerous kind of
compatibility promise.

## Run-state model

The existing `RunStatus` (`queued → provisioning → running → completed|failed|timed_out`) is
**unchanged as a vocabulary** and applies to each attempt row. The engine adds a plan level above
it and a step level below:

```
RunPlan   planning → planned → [held] → running → completed | failed | cancelled | refused
          (a re-run moves a terminal plan back to running; see Re-run allocation)
   └─ Job  one row per attempt, each with the existing RunStatus, unchanged, plus a release
        │    state waiting ⇄ [held], then released (only `released` rows are in GSI1; see Release)
        └─ Step  pending → running → completed | failed | skipped
```

- **`refused` is a plan-level state, not a job state.** A refusal has no microVM, duration or cost,
  so it must not enter the active count, error rate, cost eligibility or reporting's status
  vocabulary — the same reasoning that kept `RefusalRecord` out of `RunStatus`
  ([ADR-050](../DECISIONS.md#adr-050)).
- **Steps are new.** Nothing today models them; the engine drives them, so it must.
- **`held`** is a plan waiting for an installation admin: a fork run under `forkPolicy: approve`.
  No VM exists while a plan is held. An `environment:` approval (phase 4) holds one **job**, not
  the plan, through the job's release state, so its siblings keep running.
- **A terminal plan's state is a reduction over effective results**
  ([continue-on-error](#continue-on-error-raw-and-effective-results)): `failed` if any job's
  latest attempt has effective result `failure`, else `cancelled` if any has `cancelled`, else
  `completed`. A tolerated job failure therefore leaves the plan `completed`, as GitHub's
  "Prevents a workflow run from failing when a job fails" requires, while the job's own row and
  check run keep the raw `failure`.
- **Job-level states are reused verbatim**, so the status vocabulary, GSI1/GSI2, Runs, Reports and
  cost estimation read engine rows unchanged. The *writers* that move those states do change: they
  take a source-aware key ([Run identity](#run-identity-keys--attempts)). The Reaper's change is the
  smallest: it writes by the `pk` of the row it already read.

## Data model (Q6)

Extends the [ADR-009](../DECISIONS.md#adr-009) single table. Split between *extend* and *new*, so
the implementation card knows which migrations it does and does not need.

**Extend existing records** (all fields optional ⇒ no migration; absent means "pre-engine", which
every consumer must be able to see rather than infer):

| Record | New field | Why |
|---|---|---|
| `RepoRecord` | `mode: 'engine'` (new enum value) | Q2 coexistence |
| `RepoRecord` | `engineEnabled?: boolean` | independent kill switch, cf. `rewriteEnabled`; absent ⇒ off ([activation gates](#activation-gates-engineenabled-semantics)) |
| `RepoRecord` | `forkPolicy?: 'skip' \| 'approve' \| 'run'` | untrusted-trigger policy; absent ⇒ `skip` ([Trigger trust](#trigger-trust-forks-bots-and-re-runs)) |
| `RunRecord` | `source?: 'github' \| 'engine'` | lets index readers group rows by scheduler. Not identity: identity is the `RunKey` and the `pk` derived from it ([Run identity](#run-identity-keys--attempts)) |
| `RunRecord` | `repoKey?`, `attempt?`, `planPk?` | engine rows only; absent on GitHub rows |
| `RunRecord` | `release?: 'waiting' \| 'held' \| 'released'` | engine rows only; a row is dispatchable only when `released`, and only then carries a GSI1 key ([Release](#release)) |
| `RunRecord` | `stepCount?`, `stepsCompleted?` | UI progress without reading logs |
| `WorkflowAnalysisRecord` | `executable?: boolean` + `unsupported?: string[]` (first 50 paths) + `unsupportedCount?` | can the engine actually run this file, and what stopped it; capped so a file of refused constructs cannot grow the item ([Item bounds](#item-bounds)) |

**New item types**:

| Entity | PK | SK | GSI |
|---|---|---|---|
| RunPlan | `PLAN#<repoKey>#<runId>` | `PLAN` | GSI1 `PLANS#planning` / `dueAt` while `planning`, then `PLANS#<repoKey>` / `createdAt` (its only index entry). Holds trust class, sha, `triggerId`, `inputChunks`, `inputHash`, `rerunSeq`, `activeRerun?`; nothing whose size grows with the job count ([Item bounds](#item-bounds)) |
| Output reservation, per job ([Deadlines and outputs](#deadlines-and-outputs)) | `PLAN#<repoKey>#<runId>` | `OUTRES#<jobId>` | — (`attempt`, `bytes`: the latest terminal attempt and the output bytes it keeps; replaced by difference, never removed) |
| Output total ([Deadlines and outputs](#deadlines-and-outputs)) | `PLAN#<repoKey>#<runId>` | `OUTBYTES` | — (`bytes`, created at 0 in the plan commit and always the sum of the plan's `OUTRES#` rows; conditioned on the 50 MiB cap) |
| Plan input ([Trigger sources](#trigger-sources--idempotency-q3)) | `PLAN#<repoKey>#<runId>` | `INPUT#<n>` | — (immutable, ≤300 KB each, ≤4 per plan, written in the **same transaction** as the `RunPlan`; canonical event projection incl. dispatch `inputs` and `eventHash`, resolved action SHAs, job manifest and compiled job definitions, each with its resolved flavor and `jobDefHash`) |
| Release obligation ([Release](#release)) | `PLAN#<repoKey>#<runId>` | `RELEASE` | sparse GSI1 `RELEASE#pending` / `dueAt` while a release pass is owed. Holds `releaseSeq`. Created in the plan commit; a separate item because the `RunPlan`'s one key pair is taken |
| Matrix group ([Matrix groups](#matrix-groups-max-parallel-and-fail-fast)) | `PLAN#<repoKey>#<runId>` | `GROUP#<hash(jobKey)>` | — (read by primary key; `maxParallel`, `failFast`, `slots` (≤ `maxParallel` attempt ids), `trippedSeqs` (≤ 50, one per re-run sequence)) |
| Cancellation obligation ([Cancellation](#cancellation)) | `PLAN#<repoKey>#<runId>` | `CANCEL#<hash(jobKey)>#<seq>` | sparse GSI1 `CANCELS#pending` / `dueAt` while `doneSeq < seq`; armed by an unconditional upsert in every tripping terminal transaction |
| Trigger batch ([Trigger batch](#trigger-batch)) | `TRIGGER#<repoKey>#<triggerId>` | `TRIGGER` | sparse GSI1 `TRIGGERS#open` / `dueAt` until sealed. Event projection, `eventHash`, `eventChunks`, `remaining`, `diff` summary ([Path filters](#path-filters-the-changed-file-set)), state `matching \| planning \| sealed` |
| Trigger member ([Trigger batch](#trigger-batch)) | `TRIGGER#<repoKey>#<triggerId>` | `MEMBER#<n>` | — (n < 64; workflow path ≤ 512 bytes, blob sha, `runId`, path-filter decision, state `pending \| planned \| refused`) |
| Delivered event ([The `github` context](#the-github-context-and-the-event-projection)) | `TRIGGER#<repoKey>#<triggerId>` | `EVENT#<n>` | — (immutable, ≤300 KB each, ≤3; the provider's payload verbatim, written in the same transaction as the batch; read by the planner and, one item per `event` call, by the agent) |
| Console dispatch ([Console dispatch identity](#console-dispatch-identity)) | `DISPATCH#<repoKey>#<hash(login, clientRequestId)>` | `DISPATCH` | — (TTL 7 days; login, workflow path, ref, typed `inputs`, `requestHash`, `dispatchId`, `triggerId`) |
| PlannedJob | `PLAN#<repoKey>#<runId>` | `JOB#<jobId>` | carries `jobKey`, `matrixIndex`, `needs` (job ids, copied from the plan input) and `latestAttempt` (never ahead of an existing attempt row) |
| Re-run allocation ([Re-run allocation](#re-run-allocation)) | `PLAN#<repoKey>#<runId>` | `RERUN#<seq>` | sparse GSI1 `RERUNS#allocating` / `dueAt` while allocating, removed when done |
| **Engine run (one attempt of one job)** | **`ERUN#<repoKey>#<runId>#<jobId>#<attempt>`** | `RUN` | GSI1 `RUNSTATUS#…` **only once `released`** (none while `waiting`/`held`); GSI2 `REPORUNS#<repoKey>`. Also `rerunSeq`, `deadlineAt?`, `cancelRequested?`, `gateApproved?`, and on terminal `conclusion` (raw), `tolerated`, `effectiveResult` ([continue-on-error](#continue-on-error-raw-and-effective-results)), `outputPages` and `completedAt` |
| Job outputs ([Deadlines and outputs](#deadlines-and-outputs)) | same pk as its attempt row | `OUTPUT#<n>` | — (≤300 KB each, ≤4, ≤1 MiB per job by GitHub's UTF-16 accounting, after the agent dropped every output containing a masked value; **write-once** (`attribute_not_exists`, with the attempt row checked non-terminal in the same transaction), carrying the writer-computed hash `h` and `bytes`; read only when the attempt's terminal row names it in `outputPages`, and the terminal transaction condition-checks each named page's `h` and `bytes`; served to dependents one item per `needs-outputs` call) |
| Step | same pk as its attempt row | `STEP#<index>` | — |
| JobSpec (dispatch payload, **no secret values**) | same pk as its attempt row | `SPEC` | — (TTL'd, like the JIT config item; ≤ 300 KB, because it carries one compiled job definition, which the plan caps at that size) |
| Execution report obligation ([07](07-review-integration.md#effect-obligations-and-claims)) | same pk as its attempt row | `REPORT` | sparse GSI1 `REPORTS#pending` / `dueAt` while `doneSeq < seq`. Check-run id, `seq`, `doneSeq`, claim fields, the check name and any previous owner to `retire` ([07 § Check-run names](07-review-integration.md#check-run-names-one-authority-per-name)). Created at release; a separate item because the attempt row's key pair is its status entry |
| Refusal record, per workflow ([Refusal](#refusal-is-a-first-class-outcome)) | `REFUSAL#ERUN#<repoKey>#<runId>` | `REFUSAL` | GSI1 `REFUSALS` / `lastSeenAt`, as every refusal record (`src/shared/refusal-store.ts`). Closes the batch member in the same transaction |
| Refusal report obligation, per workflow ([07](07-review-integration.md#effect-obligations-and-claims)) | `REFUSAL#ERUN#<repoKey>#<runId>` | `REPORT` | sparse GSI1 `REPORTS#pending` / `dueAt` while `doneSeq < seq`. Created in the same transaction as the refusal record, which keeps its own `REFUSALS` index entry ([Refusal](#refusal-is-a-first-class-outcome)). Host identity `e1r:<repoKey>:<runId>` |
| Refusal record, whole delivery ([Refusal](#refusal-is-a-first-class-outcome)) | `REFUSAL#TRIGGER#<repoKey>#<triggerId>` | `REFUSAL` | GSI1 `REFUSALS` / `lastSeenAt` (the Unclaimed screen), like every refusal record. Code `engine-too-many-workflows` or `engine-event-too-large`, the event projection's sha/ref/event, and the matching workflow count or payload size. Written in the same transaction that seals the trigger batch `refused` |
| Refusal report obligation, whole delivery ([07](07-review-integration.md#effect-obligations-and-claims)) | `REFUSAL#TRIGGER#<repoKey>#<triggerId>` | `REPORT` | sparse GSI1 `REPORTS#pending` / `dueAt` while `doneSeq < seq`. Created in that same sealing transaction. Host identity `e1t:<repoKey>:<triggerId>`, check name `LCA: refused · delivery · <context>` |
| Check-name owner ([07](07-review-integration.md#check-run-names-one-authority-per-name)) | `CHECKNAME#<repoKey>#<sha>#<hash(name)>` | `OWNER` | — (the attempt that owns the name on that sha, its check-run id, its claim key (incl. `eventHash` and `jobDefHash`), and state `owned \| contested`; TTL 30 days after the sha's last run) |
| Review intent, one per verdict ([07](07-review-integration.md#review-lifecycle)) | `PR#<repoKey>#<prNumber>` | `REVIEW#<headSha>#<intentId>` | — (identity immutable; never overwritten) |
| Review head projection ([07](07-review-integration.md#review-lifecycle)) | `PR#<repoKey>#<prNumber>` | `REVIEWHEAD` | sparse GSI1 `REVIEWS#pending` / `dueAt` while `doneSeq < seq` (PR head sha, `triggerCount` + `triggersSeq`, latest intent id + generation, `submittedIntentId`, claim fields) |
| PR head batch ([07](07-review-integration.md#when-we-submit-a-review)) | `PR#<repoKey>#<prNumber>` | `HEADTRIG#<headSha>#<triggerId>` | — (one per `pull_request` batch for that head; the verdict reads them with `begins_with(sk, 'HEADTRIG#<headSha>#')`, paginated) |
| Delivery reconciler cursor ([The `github` context](#the-github-context-and-the-event-projection)) | `CONFIG#DELIVERYRECON` | `CURSOR` | — (the last delivery id fully processed, and when) |
| Review cleanup obligation ([07](07-review-integration.md#superseding-and-dismissing)) | `PR#<repoKey>#<prNumber>` | `CLEANUP#<intentId>` | sparse GSI1 `REVIEWCLEANUP#pending` / `dueAt` until done (what superseded it: a review id, or a quiet verdict's basis) |
| Approval gate ([07](07-review-integration.md#gate-state-delivery-and-expiry)) | same pk as its attempt row | `GATE` | sparse GSI1 `GATES#open` / `dueAt` (the earlier of the owed report's due time and, while pending, `expiresAt`) while undecided or a report is owed. Created in the `waiting → held` transaction; state, `expiresAt`, check-run id, approver, time, claim fields |
| Fork-approval gate ([07](07-review-integration.md#gate-state-delivery-and-expiry)) | `PLAN#<repoKey>#<runId>` | `FORKGATE` | sparse GSI1 `GATES#open` / `dueAt`, same rules as `GATE` |
| TenantSecret **index only** | `INSTALL#<installationId>` | `SECRET#<NAME>` | sparse GSI1 `SECRETOPS#pending` / `dueAt` while an operation is unsettled (**name + metadata only; the value lives in SSM**; `current`, the parameter path that is the value, and `op?`, the durable operation record of the write broker) |
| Secret garbage ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)) | `INSTALL#<installationId>` | `SECRETGC#<opId>` | sparse GSI1 `SECRETGC#pending` / `dueAt` until the parameter it names is confirmed deleted; `kind` = `superseded` (due after `G`), `quarantine` (an abandoned write that may still land: no GSI1 key, never due, never released in v1, OQ-15; the sweep deletes a parameter found at its path) or `orphan` (counted by the sweep, due at once). Holds one parameter slot |
| Secret name reservation ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)) | `INSTALL#<installationId>` | `SECRETNAMES` | — (`names`, a string set of at most 100; the `secret-quota` cap, enforced by a conditional `ADD`) |
| Secret parameter slots, per installation ([Storage](#storage)) | `INSTALL#<installationId>` | `SECRETSLOTS` | — (`n`, the parameters the installation holds or may hold: `current`s, live `op`s and `SECRETGC#` items; `q`, how many of those are quarantined; at most 200 on admission, the `secret-capacity` cap; released only on a confirmed deletion or rejection, never for a quarantined slot; `closing`, set by the uninstall fence, refuses every later write) |
| Secret owner index ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)) | `SECRETOWNERS` | `<installationId>` | — (`since`; written in every write's begin transaction, so the partition names every installation that holds or ever held a tenant slot; read by consistent paginated `Query` by the settler's sweep and drain and by the release procedure's census; never deleted in v1) |
| Secret parameter slots, per environment ([Storage](#storage)) | `CONFIG#SECRETSLOTS` | `COUNT` | — (`n`, the sum of every installation's `SECRETSLOTS`; `q`, the sum of their quarantined slots; `budget`, the `tenantBudget` granted to this environment by the account registry at deploy, never its platform reserve; `gen`, the allocation's generation; `state` = `active \| draining \| released`; the begin transaction admits only `state = active AND n < budget`, and refuses when `budget` is absent) |
| Account quota registry, **in the account-level `lca-account-quota` table, not this one** ([Storage](#storage)) | `QUOTA#ssm-standard` | `TOTAL` / `ALLOC#<env>` | — (`TOTAL` = `{total, cap = 9,500}`, seeded at 0 by `LCA-Account`; one `ALLOC#<env>` = `{tenantBudget, platformReserve = 50, gen, state = active \| releasing}` per environment in the account and Region, charged `tenantBudget + platformReserve` against `TOTAL`; one `QUARANT#<env>#<gen>` = `{q, tracked}` per released allocation that still had quarantined slots, charged `q` against `TOTAL`; a tracked row is deleted only by the allocation transaction that re-creates `ALLOC#<env>`, which moves its `q` into the new `tenantBudget` (so each slot is charged once), and an untracked row is never removed in v1 (OQ-15); changed only by the deploy-time allocation transaction, which spans both tables, and by the release procedure's fence and release transactions) |
| Secret audit | `SECRETAUDIT#<installationId>` | `<iso time>#<name>#<opId>` | — (no value; created in the operation's begin transaction) |

Deliberate key choices: engine rows take the `ERUN#` prefix and carry the attempt, so they can
never collide with a GitHub-scheduled row or with an earlier attempt
([Run identity](#run-identity-keys--attempts)); steps and the JobSpec hang off **their own
attempt's** key, so the broker reaches them by primary key; `PlannedJob` hangs off the plan, so
releasing jobs is one query; and no row stores a secret value, so a table read, including the
broker's `GetItem`, can never yield plaintext.

### Item bounds

DynamoDB rejects any write that would take an item past 400 KB, and a sort key past 1,024 bytes
([limits](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)).
A hot item that crosses either fails every later write to it, which would wedge whatever
transition depends on that write. So the rule is: **no item holds a collection whose size
grows with user input, run count or time; such collections are rows, and every remaining field
has a stated bound.**

| Item | What could grow | Bound |
|---|---|---|
| `RunPlan` | per-job output reservations | moved to `OUTRES#<jobId>` rows and an `OUTBYTES` counter |
| `TRIGGER` | the member list | moved to `MEMBER#<n>` rows (n < 64, path ≤ 512 bytes); the `diff` summary is fixed-size |
| `REVIEWHEAD` | batch ids for one head, appended on every close/reopen and redelivery | moved to `HEADTRIG#` rows; the projection keeps a count |
| `GROUP#` | `slots`, `trippedSeqs` | ≤ `maxParallel` (≤ 256) fixed-length ids; ≤ 50 numbers (the attempt cap) |
| `INPUT#<n>`, `EVENT#<n>`, `OUTPUT#<n>` | chunked payloads | ≤ 300 KB each, with a stated chunk count and a refusal above it |
| `SPEC` | one compiled job definition | a compiled job definition over 300 KB is refused at plan time (`engine-plan-too-large`) |
| `WorkflowAnalysisRecord.unsupported` | refused constructs in a file | the first 50 paths, plus `unsupportedCount` |
| `SECRETNAMES` | secret names | ≤ 100 names of ≤ 255 bytes |
| any sort key embedding a user string (`GROUP#`, `CANCEL#`) | job ids have no documented length cap | the user string is hashed into the key; the readable value is an attribute |

The phase-1 card adds a test that builds the largest admissible shape of each row above (256
jobs with 255-byte ids, 50 re-run sequences, 64 members with 512-byte paths, 100 secrets) and
marshals it with the AWS SDK's own `marshall`, asserting each item is under 350 KB and each key
under 1,024 bytes.

**`REPORUNS#<repoKey>` for engine rows** is a new GSI2 partition *value*. The console's per-repo
history therefore reads two partitions for a GitHub repo that also uses `engine` mode
(`REPORUNS#<repoId>` and `REPORUNS#gh-<repoId>`) and merges them by `createdAt`. That is two
bounded queries instead of one, chosen over reusing the numeric partition because non-GitHub repo
ids would otherwise collide in it.

**Who may write which rows.** The management λ's `UpdateItem` grant is table-wide today
([ADR-025](../DECISIONS.md#adr-025)). Engine rows (`PLAN#`, `ERUN#`, `PR#`, `TRIGGER#`,
`DISPATCH#`, `CHECKNAME#`, `REFUSAL#ERUN#`, `REFUSAL#TRIGGER#`) carry trust class, approvals and
attempt state, so the phase-2 card narrows that grant with a `dynamodb:LeadingKeys` condition.
The narrowed set must keep **every** write the management λ makes today, which is three and only
three families (from its imports in `src/mgmt/handler.ts`):

| Write | Store function | Partition |
|---|---|---|
| repo config patch, ADR-037 index repair | `patchRepoConfig`, `repairInstallationIndex` (`src/shared/install-store.ts`) | `INSTALL#<installationId>` |
| custom-flavor validation state, image repoint | `src/shared/flavor-store.ts` | `INSTALL#<installationId>` |
| operator audit trail | `appendAudit` (`src/shared/config-store.ts`), called from four flavor routes | `CONFIG#AUDIT`, exactly |

So the statement's condition is
`ForAllValues:StringLike: dynamodb:LeadingKeys = ["INSTALL#*", "CONFIG#AUDIT"]`. `CONFIG#AUDIT`
has no wildcard, so it matches that one partition and not `CONFIG#LOCK`, `CONFIG#STATUS` or
`CONFIG#WEBHOOK`, which the appcfg broker and Ingest own. The earlier draft named `INSTALL#*`
alone; applied as written, every audit write would have been denied, and because the four call
sites `.catch` the error, the audit trail would have gone silently empty. The phase-2 card's test
change is both halves: `test/mgmt-stack.test.mjs` asserts the exact `LeadingKeys` list, a
handler-level test drives each of the writes above against a stub that enforces it (each must
succeed), and the negative assertions are extended so a write to `PLAN#`, `ERUN#`, `PR#`,
`TRIGGER#`, `DISPATCH#`, `CHECKNAME#`, `REFUSAL#`, `RUN#` and the other `CONFIG#` rows is
denied. What the condition cannot express, stated: DynamoDB IAM has no sort-key condition, so the
management λ can still patch any row inside an `INSTALL#` partition, including a tenant secret's
index row. Two things bound that. The resolver follows `current` only inside the same name's
path prefix, so a patched pointer can select at most another stored parameter of the same
secret, never another secret's or another installation's. And a patched or removed `op` can
only make the name busy or let a second operation begin; every parameter either one creates is
still found by the orphan sweep, which reads SSM, not the index. The secret's trustworthy history is therefore the `SECRETAUDIT#` rows, which the
management λ cannot write, and the console's "updated by" reads those, never the index row.

Fork approvals, gate decisions, dispatches and re-run requests from the console are handed to the
control plane (enqueued, or for a dispatch invoked on an exact ARN), as the rewrite PR already is
([ADR-031](../DECISIONS.md#adr-031)); the console never writes engine rows itself.

**GSI budget, one entry per item.** GSI1 has a single key pair per item (`gsi1pk`/`gsi1sk`,
`lib/data-stack.ts`), so an item can hold exactly one logical index entry at a time. Every item
above that needs one has one, and an obligation that would otherwise share an item with another
index entry is its own item (`RELEASE` beside the `RunPlan`, `REPORT` and `GATE` beside the
attempt row, `REPORT` beside a refusal record, whether that record is keyed on a plan or on a
trigger). The GSI1 partitions are: `RUNSTATUS#<status>`
(attempt rows, once released), `PLANS#planning` and `PLANS#<repoKey>` (plans, one at a time),
`REFUSALS` (refusal records, unchanged), and the obligation partitions `RELEASE#pending`,
`RERUNS#allocating`, `TRIGGERS#open`, `REPORTS#pending`, `GATES#open`, `CANCELS#pending`,
`REVIEWS#pending`, `REVIEWCLEANUP#pending`, `SECRETOPS#pending` and `SECRETGC#pending`; in GSI2, `REPORUNS#<repoKey>`. **Every obligation
partition sorts by `dueAt`**, the time the Reaper must act if the obligation is still owed
([07 § Effect obligations](07-review-integration.md#effect-obligations-and-claims)), so one key
condition `gsi1sk <= :now` returns exactly the due set and a backlog of not-yet-due items can
never sort ahead of a lost one. These are new partition values in the
existing indexes, not new indexes — the same technique `REFUSALS` used
([ADR-050](../DECISIONS.md#adr-050)). No new GSI is required. `lib/data-stack.ts` is unchanged.
The phase-2 card adds a test that, for every item type, asserts at most one writer path sets
`gsi1pk` and that no two obligations are assigned to one item, and a corpus test per obligation
partition: thousands of owed items whose `dueAt` is in the future, plus one that was due an hour
ago, inserted last; the Reaper's first page must contain it.

## Blast radius (Q7)

The engine hands a microVM a JobSpec and, now, real secrets. The rule is that it must not
reintroduce the amplifier [ADR-021](../DECISIONS.md#adr-021) removed.

| Invariant from ADR-019/021 | Still true under the engine? |
|---|---|
| VM holds no DynamoDB permission | ✅ JobSpec arrives through the broker, by ref |
| VM holds no SSM or KMS permission | ✅ secret values arrive in the broker's `jobspec` response, resolved by a separate λ ([Secret custody](#secret-custody)) |
| VM holds no `TerminateMicrovm` | ✅ unchanged |
| VM never learns any `microvmId`, including its own | ✅ the JobSpec must not carry one |
| Authority is a per-run capability token, not ambient IAM | ✅ extended to the new actions |
| Broker holds `GetItem` only — never `Query`/`Scan` | ✅ **constrains the design**: every new broker read must be by primary key. This is why steps and the JobSpec are keyed under the attempt row. The broker gains `lambda:InvokeFunction` on two exact ARNs, the secret resolver and the engine status writer, and nothing else; it never holds `ssm:GetParameter`, `kms:Decrypt` or any table write |
| Exec role = own log group + invoke broker | ✅ unchanged |
| A VM's authority covers only its own attempt | ✅ and, within the VM, only the agent holds it, except as stated for root in the `docker` flavor ([In-VM trust boundary](#in-vm-trust-boundary)) |

New surface, and the mitigation:

- **Secrets in the VM** — new and unavoidable for `trusted` runs. Bounded by: no secrets at all for
  fork and restricted-bot runs ([Trigger trust](#trigger-trust-forks-bots-and-re-runs));
  named-secrets-only resolution; and a resolver whose assumed credentials can decrypt only the one
  installation path its stored JobSpec names ([Secret custody](#secret-custody)).
- **Untrusted code with a token** — every class gets a read-only, single-repo checkout token, so a
  fork PR cannot use our token to write.
- **Third-party action code fetched by us** — bounded by SHA pinning, owner allowlist and our own
  cache ([Q4](#uses-resolution--supply-chain-q4)).
- **Broker concurrency is a shared resource** — its 20-reserved cap is already noted as
  boot-path contention risk ([ADR-021](../DECISIONS.md#adr-021), [ADR-028](../DECISIONS.md#adr-028)).
  The engine makes it worse by adding **per-step** traffic, so log/step reporting must batch, and
  the cap must be re-sized against measured traffic before phase 2 ships. **Unresolved — OQ-5.**

## Refusal is a first-class outcome

The card's sharpest risk: *"a partial engine that claims a job it can't faithfully run is worse
than not claiming it."* The design's answer is that refusal is a **product surface**, not an error
path — and the mechanism already exists.

- Refusals are classified, persisted and listed on the console's Unclaimed screen with a stable
  `code`, a reason and a `fix` ([ADR-050](../DECISIONS.md#adr-050)); engine refusals reuse it
  rather than inventing a parallel channel.
- **A refusal is reported to the git host too, and the report is a durable obligation.** A
  refusal record already spends its one GSI1 entry on `REFUSALS` (the Unclaimed screen,
  `src/shared/refusal-store.ts`), so its report is a separate item beside it, `REPORT`, created in
  the **same transaction** that writes the refusal (the transaction that also closes the trigger
  batch's member, [Trigger batch](#trigger-batch)), with sparse GSI1 `REPORTS#pending` / `dueAt`.
  A crash after the refusal is persisted and before the POST therefore leaves an owed report the
  Reaper re-drives; a crash after the POST and before its record is settled by the claim
  protocol's observe step, which finds our check run by its `external_id`
  ([07](07-review-integration.md#effect-obligations-and-claims)). The surface:
  - **check run** `LCA: refused · <workflowKey> · <context>`, `external_id`
    `e1r:<repoKey>:<runId>`, created completed + `neutral`, whose summary names the unsupported
    construct and deep-links to the console. Its name is in the system namespace, never a job's
    ([07 § Check-run names](07-review-integration.md#check-run-names-one-authority-per-name)), so
    it cannot satisfy a required check meant for a job;
  - **fallback**, when `checks:write` is not granted: a commit status under the same `context`.
    Commit statuses have no neutral state (`error`, `failure`, `pending`, `success`,
    [statuses](https://docs.github.com/en/rest/commits/statuses)), so it is posted `error` with
    the refusal code as its description: we could not run the workflow, and nothing about it
    passed;
  - **a refusal of a whole delivery** (`engine-too-many-workflows`, or `engine-event-too-large`;
    both decided before any workflow is a member, so there is no `runId`) is keyed on the trigger.
    The transaction that seals the batch `refused: true` (for an oversized event, the batch's
    first `Put`, which writes it already sealed, conditioned `attribute_not_exists`) also `Put`s the refusal record
    `REFUSAL#TRIGGER#<repoKey>#<triggerId>` / `REFUSAL` (with the Unclaimed screen's `REFUSALS`
    index entry) and its `REPORT` beside it, both `attribute_not_exists`, so a redelivery or a
    Planner retry that reaches the seal again fails on the batch's `state = matching` condition
    (for an oversized event, on the batch's own `attribute_not_exists`) and writes nothing twice. The surface is check run `LCA: refused · delivery · <context>` (the
    trigger context of [07 § Check-run names](07-review-integration.md#check-run-names-one-authority-per-name)),
    `external_id` `e1t:<repoKey>:<triggerId>`, created completed + `neutral`, or the `error`
    commit-status fallback under that context. Crash before the POST: the Reaper re-drives the
    `REPORT` from `REPORTS#pending`. Crash after it: the observe step lists the sha's check runs
    and adopts ours by that `external_id`. The PR verdict reads the sealed `refused` batch as a
    failure ([07](07-review-integration.md#when-we-submit-a-review)).
  The fork-policy `skip` notice (`LCA: fork approval · …`) is a refusal record too, and is delivered
  the same way. A silent refusal on a repo whose owner expects us to run CI is indistinguishable
  from an outage.
- Refusal is decided **at plan time**, before any VM boots, and refuses the **whole run**, so it
  costs nothing and cannot half-execute a workflow. The only checks after plan time are the
  activation gates re-checked at job release (a kill switch flipped mid-run), which stop jobs that
  have not started and never interrupt one that has.
- **One rule decides refusal: membership in the [matrix](#grammar-support-matrix)'s Refused or
  Out-of-scope classes, default-deny.** There is no separate "warn" path. The matrix, this section
  and the M6 exit criterion in the roadmap state the same rule.
- New refusal codes: `engine-unsupported-construct`, `engine-expression-unsupported`,
  `engine-action-not-allowlisted`, `engine-action-refused`, `engine-permissions-unsatisfiable`,
  `engine-mode-conflict`, `engine-twin-workflow`, `engine-untrusted-trigger`,
  `engine-plan-too-large`, `engine-too-many-workflows`, `engine-empty-plan`,
  `engine-duplicate-check-name`, `engine-runner-unsupported`, `engine-event-too-large`,
  `engine-workflow-path-too-long`, `engine-push-delete-unsupported`,
  `engine-path-filter-unsupported`. Runtime
  attempt failure codes (not refusals):
  `engine-secret-unavailable`, `engine-outputs-too-large`. Broker rejections of a VM report,
  which change no state: `engine-output-page-conflict` (a page index already stored with
  different content). Console intake refusal (no run exists):
  `dispatch-key-reused`, `dispatch-inputs-invalid` (more than 25 inputs, more than 65,535
  characters, or a value outside its declared `type`/`options`, as GitHub validates). Secret
  intake refusals (no run exists): `secret-too-large`, `secret-quota`, `secret-capacity` (no
  parameter slot left for the installation or the environment; [Storage](#storage)), and
  `secret-busy` (an
  earlier operation on the same name is not settled yet; [Writes](#writes-a-control-plane-secrets-broker-not-the-console)).

## Provider abstraction

**Decision** ([ADR-060](../DECISIONS.md#adr-060)): one port, GitHub as the first implementation,
**Gitea/Forgejo as the second** — because it is the host whose runner protocol we already modelled,
so it validates the port at the lowest cost.

```ts
interface GitHostProvider {
  readonly id: 'github' | 'gitlab' | 'bitbucket' | 'codecommit' | 'gitea';
  repoKey(repo: RepoRef): string;                         // '<provider>-<id>', see Run identity
  classifyTrust(ev: TriggerEvent): 'trusted' | 'fork' | 'restricted-bot';
  verifyWebhook(raw: string, headers: Record<string, string>): boolean;
  parseEvent(raw: string): TriggerEvent | null;          // → push | pull_request | dispatch
  listWorkflows(repo: RepoRef, ref: string): Promise<WorkflowFile[]>; // .lca/workflows/** only
  fetchBlob(repo: RepoRef, ref: string, path: string): Promise<string>;
  // path filters, see Path filters: the changed-file set (supportsPathFilters)
  changedFiles(repo: RepoRef, spec: DiffSpec, budget: DiffBudget): Promise<ChangedFiles>;
  // optional: recover deliveries the front door rejected (supportsDeliveryLog)
  listFailedDeliveries?(since: DeliveryCursor): Promise<FailedDelivery[]>;
  fetchDelivery?(id: string): Promise<TriggerEvent | null>;
  mintCheckoutToken(repo: RepoRef): Promise<ScopedToken>; // short-lived, single-repo, read-only
  // reporting surface — see spec 07
  reportRunStatus(run: RunRef, status: EngineStatus): Promise<void>;
  postReview(pr: PrRef, review: ReviewIntent): Promise<void>;
  deepLink(run: RunRef): string;
}
```

The port is **capability-declaring, not lowest-common-denominator**: each provider states what it
supports (`supportsCheckRuns`, `supportsReviewApproval`, `supportsInlineComments`,
`supportsPathFilters`, `supportsDeliveryLog`) and the engine and reporter degrade explicitly — GitLab has no check runs but has commit statuses and MR notes; Bitbucket has
its own build-status API. Collapsing to the intersection would throw away GitHub's richest surface,
which is the one we actually have a customer for; pretending every host has check runs would make
the reporter lie.

v1 implements **GitHub** only. GitLab/Bitbucket/CodeCommit are named to keep the port honest, not
promised.

## Open questions

- **OQ-1**: Cron ownership. `on: schedule` needs a distributed timer plus a catch-up-vs-skip policy
  after an outage. **Closes when** a repo asks for scheduled runs under `engine` mode; until then
  the `schedule` trigger never matches and the workflow analysis lists it as unmatched. (Q3,
  deferred deliberately.)
- **OQ-2**: Artifact protocol fidelity. Gitea's config states stock artifact actions may refuse
  against a third-party server. Artifact actions are Refused until this closes. **Closes when** phase 6
  tests `actions/upload-artifact` against our implementation and records which versions work (those
  then move to Supported), or documents that we ship an LCA-specific action instead.
- **OQ-3**: Reusable workflows + `secrets: inherit`. Deferred with composite actions. **Closes when**
  the custody model has a per-callee scoping story.
- **OQ-4**: Our own OIDC issuer. Additive and customer-visible. **Closes when** a tenant needs cloud
  identity under `engine` mode; ADR-059 keeps our own CD off this path regardless.
- **OQ-5**: Broker concurrency under per-step reporting. **Closes when** phase 2 measures real
  step/log traffic against the 20-reserved cap; batching may be enough, or the cap must move.
- **OQ-6**: Merge queue + repo-level rulesets on Free. Both **NOT STATED** in the docs
  ([above](#why-what-github-free-actually-withholds)). **Closes when** observed on a real Free
  private repo, or GitHub publishes a plan matrix. Nothing in this design depends on the answer;
  it only sharpens the value claim in [07](07-review-integration.md).
- **OQ-7**: `pull_request_target`. Out of v1 ([Trigger trust](#trigger-trust-forks-bots-and-re-runs)).
  **Closes when** a tenant needs base-privileged automation on fork PRs (labelling, comment bots)
  and a design exists that runs the base sha's workflow and never checks out fork code with
  secrets present.
- **OQ-8**: Secrets larger than 4 KB, more than 100 names or 200 parameter slots per
  installation, or more tenant parameters than the environment's granted allocation
  (`tenantSecretSlotBudget`, 8,000 in `prod`, drawn from the account registry's 9,500 of the
  account's 10,000 Standard parameters). v1 refuses each at intake
  (`secret-too-large`, `secret-quota`, `secret-capacity`; [Storage](#storage)), and refuses a
  deployment whose allocation would cross the registry's cap (`account-quota-exhausted`). **Closes when** a
  tenant needs a larger secret, or the budget alarm fires; the candidate is Secrets Manager
  (65,536 bytes per secret, and its own per-account secret quota), which needs
  its own isolation design because its KMS encryption context and IAM resource shape differ from
  Parameter Store's `PARAMETER_ARN` condition.
- **OQ-9**: `concurrency` (workflow and job level). Refused in v1 ([matrix](#grammar-support-matrix)).
  It is cross-run: GitHub allows "at most one running job or workflow in a concurrency group",
  replaces an older pending member with a newer one, and with `cancel-in-progress` cancels the
  running one. The design it needs: a `CONCURRENCY#<repoKey>#<hash(group)>` owner item holding the
  running attempt (or plan) and a one-slot pending reference, taken and released in the same
  transactions as release and terminal status, exactly like a matrix slot; displacement of a
  pending member as its terminal `cancelled`; `cancel-in-progress` as a
  [cancellation](#cancellation) obligation on the owner; and evaluation of `group` and
  `cancel-in-progress` expressions at release, not plan time, because they may read
  `needs.*.outputs`. **Closes when** that design is written with crash and race tests (owner
  crash, two plans racing for the group, displacement during a release pass) and a tenant needs
  the construct; until then the whole run is refused with `engine-unsupported-construct`, naming
  `concurrency`, so no two deploys can run at once because we ignored it.
- **OQ-10**: What a dependent sees when a needed job fails under job-level `continue-on-error`.
  GitHub documents that the setting "Prevents a workflow run from failing when a job fails", and
  that `needs.<id>.result` is one of `success`, `failure`, `cancelled` or `skipped`
  ([contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context)),
  but not which value a tolerated job yields, nor whether a default `if:` dependent runs. v1
  therefore refuses job-level `continue-on-error` on any job another job `needs`, and treats a
  tolerated `timed_out` or `cancelled` as not tolerated. **Closes when** a phase-1 conformance
  fixture, run on GitHub-hosted Actions, records `needs.a.result`, whether `b` (default `if:`)
  runs, `a`'s check-run conclusion and the workflow run's conclusion, for `a` ending `exit 1`,
  timed out, and cancelled; the effective-result mapping is then set to that record and the
  refusal lifted.
- **OQ-11**: Configuration variables (`vars`). Refused in v1 ([matrix](#grammar-support-matrix)):
  GitHub serves them through the Variables API under a `variables` permission our App does not
  request, under limits of its own ("Individual variables are limited to 48 KB in size", and "The
  total combined size limit for organization and repository variables is 256 KB per workflow
  run", [variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)),
  and other hosts have no such store. Evaluating `vars.X` to `''` would change `if:` results
  silently. **Closes when** a design picks the source (the host's API, read at plan time and
  stored in the plan input like the event, or a console-managed store), adds its bytes to
  `jobDefHash` so the check-name claim covers them, and keeps them out of untrusted runs, as the trust table already requires.
- **OQ-12**: Path-filter edge cases GitHub does not document
  ([Path filters](#path-filters-the-changed-file-set)): which commit GitHub diffs against for a new
  branch pushed with an empty `commits` array (v1: outcome `undetermined`, the workflow runs, as
  GitHub does when a diff times out); the order in which GitHub picks its first 3,000 files (v1:
  byte-wise path order); whether a rename's old path matches `paths` (v1: yes, both paths are in
  the set); and the run context for a push that deletes a branch (v1: refused,
  `engine-push-delete-unsupported`). **Closes when** the phase-1 conformance fixtures, run on
  GitHub-hosted Actions, record GitHub's answer for each; v1's choice is then changed to match, or
  the delete case is designed and lifted.
- **OQ-13**: Deliveries over GitHub's 25 MB cap. GitHub does not send them, so no path, the
  reconciler included, can see them, and such a push gets no run and no report
  ([size tiers](#the-github-context-and-the-event-projection)). **Closes when** GitHub exposes
  undelivered events (nothing does today), or a tenant reports a push of that size, at which
  point a periodic per-branch head comparison is the candidate.
- **OQ-14**: A mode without `sudo`. In the `docker` flavor a step can become root, and root can
  read the agent's token ([In-VM trust boundary](#in-vm-trust-boundary)). **Closes when** a
  tenant wants the in-VM boundary to hold in every flavor; the candidate is a per-repo
  `stepSudo: false` that builds a `runner` without `sudoers` and refuses the `docker` flavor
  (rootless Docker is ruled out by [ADR-020](../DECISIONS.md#adr-020)'s measurements), at the
  cost of every workflow that runs `sudo`.
- **OQ-15**: Returning quarantined secret slots. A write whose `PutParameter` got no answer
  keeps its slot charged for ever, because AWS publishes no bound on when a received request
  finishes ([Writes](#writes-a-control-plane-secrets-broker-not-the-console)); quarantined
  slots therefore accumulate against the installation's 200, the environment's budget and,
  after a release, the account registry. v1 accepts the capacity loss rather than present a
  fixed margin as a bound on an unbounded population. **Closes when** either a service-backed
  fence exists (an AWS-documented completion bound for `PutParameter`, or an idempotency token
  on it), so a quarantined slot can be released once the bound has passed, or the `q` alarm
  shows quarantine consuming more than 1 % of any environment's budget, at which point the
  candidate is to move tenant writes to a store with client tokens (Secrets Manager's
  `ClientRequestToken`, the same route as OQ-8).
