# Architecture

LambdaCIActions runs GitHub Actions jobs on ephemeral AWS Lambda microVMs. This doc
covers the system decomposition, request/lifecycle flows, the data model, and the
security + failure-handling posture.

## Contents

- [Design goals & non-goals](#design-goals--non-goals)
- [The three planes](#the-three-planes)
- [The execution plane (proposed, M6)](#the-execution-plane-proposed-m6)
- [Component inventory](#component-inventory)
- [Request flows](#request-flows)
- [Data model](#data-model)
- [Security model](#security-model)
- [Scaling, quotas & failure handling](#scaling-quotas--failure-handling)
- [Known constraints](#known-constraints)

---

## Design goals & non-goals

**Goals**

1. **Drop-in**: an existing repo's workflows run unchanged after switching `runs-on` (or via auto-rewrite — see [03-workflow-ingestion](specs/03-workflow-ingestion.md)).
2. **Self-serve onboarding**: install a GitHub App, pick repos, done — no per-repo webhook wiring.
3. **Ephemeral & isolated**: one microVM per job, JIT-registered, self-terminating.
4. **Observable**: a web UI showing repos, workflows, queued/running/finished jobs, and logs.
5. **Cheap at idle**: zero standing compute; pay per job-second.

**Non-goals (v1)**

- x86_64 runners (microVMs are arm64/Graviton only).
- Replacing GitHub as the source of truth for workflow definitions (we read, we don't host).
  **Qualified for M6** ([ADR-054](DECISIONS.md#adr-054)): still true for `label`/`adopt` mode — i.e.
  every repo onboarded to date — but an opt-in fourth mode (`engine`) proposes that we own the
  definition *and* the scheduler for repos that ask for it. See
  [the execution plane](#the-execution-plane-proposed-m6).
- Cross-cloud runners (AWS only).
- Warm pools / runner reuse (single-use only in v1; revisit if cold-start hurts).

## The three planes

### 1. Control plane
Owns the GitHub relationship. Receives `workflow_job` webhooks, authenticates them
(HMAC), decides whether a job is ours (label/repo match), and mints **JIT runner
registration tokens** from the GitHub App installation. Enqueues provisioning requests.

### 2. Compute plane
Owns runner images and runner lifecycle. Builds/snapshots microVM images per **flavor**,
provisions a microVM from the right snapshot on demand, injects the JIT config, and
tracks the runner until it self-terminates. Enforces max lifetime + reaping.

### 3. Management plane
Owns operator-facing state and UX. A web UI + management API backed by DynamoDB:
installed orgs/repos, discovered workflows, flavor mappings, and a run history/log view.
Read-mostly; writes are config (flavor overrides, repo enable/disable). Implemented in M4 —
see [spec 04](specs/04-web-ui.md); the plane's IAM boundary (no compute, no secret values,
no Put/Delete on the table) is pinned by [ADR-025](DECISIONS.md#adr-025), and the console +
API share one CloudFront origin ([ADR-024](DECISIONS.md#adr-024)) — on a config-derived
vanity hostname when one is configured ([ADR-036](DECISIONS.md#adr-036)).

```
┌── Control plane ─────────┐   ┌── Compute plane ──────────┐   ┌── Management plane ──────┐
│ GitHub App               │   │ microVM image builder     │   │ Web UI (SPA)             │
│ API GW  /webhook         │   │ Provision λ               │   │ API GW  /api/*           │
│ Ingest λ                 │   │ Lambda microVM (runner)   │   │ Mgmt API λ               │
│ SQS runner-requests + DLQ│   │ Reaper λ (timeouts)       │   │ DynamoDB (config + runs) │
│ JIT token minting        │   │ ECR/code bucket snapshots │   │ Cognito / GitHub OAuth   │
└──────────────────────────┘   └───────────────────────────┘   └──────────────────────────┘
```

## The execution plane (proposed, M6)

**Status: designed, not built** — [spec 06](specs/06-workflow-engine.md),
[spec 07](specs/07-review-integration.md), [ADR-054](DECISIONS.md#adr-054)..[ADR-060](DECISIONS.md#adr-060).
Everything above this section describes the shipped system; everything in it describes a proposal.

The three planes above all assume **GitHub schedules and we execute**. A fourth plane appears when
that assumption is inverted for a repo in the new `engine` mode: the plane that decides *what should
run*, which today is GitHub's Actions service.

```
┌── Execution plane (M6, proposed) ────────────────────────────┐
│ Trigger λ    match `on:` → which workflows fire            │
│ Planner λ    parse → matrix → `needs` DAG → `if:` → RunPlan │
│ Release λ    dispatch jobs whose deps are terminal          │
│ Reporter λ   check runs / statuses / reviews → the git host │
│ lca-agent    in-VM: runs steps, reports via the broker      │
└───────────────────────────────────────────────────┘
```

**Coexistence, not replacement.** `RepoMode` gains a fourth value. In `engine` mode the engine
schedules files under `.lca/workflows/` and nothing else; GitHub keeps scheduling any file still
under `.github/workflows/`. Each file has exactly one scheduler:

| Mode | Scheduler | Executor | Plane doing the deciding |
|---|---|---|---|
| `off` | GitHub | GitHub-hosted | — |
| `label` | GitHub | us (LCA-labelled jobs) | control |
| `adopt` | GitHub | us (standard labels too) | control |
| **`engine`** | **us**, for `.lca/workflows/**` | **us** | **execution** |

**No workflow runs on both schedulers**, because a deploying workflow run twice would deploy twice.
The mechanism is the directory: GitHub only searches `.github/workflows`, and the engine only reads
`.lca/workflows`. Activation is fail-closed (`mode`, `engineEnabled`, deployment flag, deny list, and
a refusal when a same-named twin is still under `.github/workflows`). Two guards stay as defence in
depth: the claim gate refuses `workflow_job` in `engine` mode (visibly, as a refusal record —
[ADR-050](DECISIONS.md#adr-050)), and the planner refuses repos not in `engine` mode
([ADR-054](DECISIONS.md#adr-054)).

**Untrusted triggers get no secrets.** Every engine run has a trust class fixed at plan time from
the event (`trusted`, `fork`, `restricted-bot`); only `trusted` runs receive secrets or OIDC
(`vars` is refused for every class in v1),
and every class gets a read-only checkout token ([ADR-056](DECISIONS.md#adr-056)).

### D. Engine run (proposed): trigger → plan → dispatch → report

```
git host        Ingest λ     Planner λ    SQS      Provision λ    microVM        Reporter λ
  │ push / PR       │            │          │           │            │              │
  ├───────────────▶ verify HMAC  │          │           │            │              │
  │                 │ mode==engine? write trigger batch (+ PR head projection), then enqueue
  │                 ├──────────▶ fetch .lca/workflows @sha            │              │
  │                 │            │ match `on:` (+ changed-file set for path filters) → fix batch members; classify trust
  │                 │            │ expand matrix, order  │            │              │
  │                 │            │ `needs`, eval `if:`   │            │              │
  │                 │            │  ── unsupported? ──▶ REFUSE run (no VM booted) ──▶ neutral check
  │                 │            │ plan input (event, inputs, SHAs, job manifest) + RunPlan: one transaction
  │                 │            │ attempt rows created `waiting`; release pass → `released`
  │                 │            ├─enqueue─▶│           │            │              │
  │                 │            │          ├──poll────▶│            │              │
  │                 │            │          │  stash JobSpec (names, no values) by ref
  │                 │            │          │  mint capability token │              │
  │                 │            │          │           ├──launch───▶│              │
  │                 │            │          │           │   lca-agent (own uid, sole token holder) → broker: jobspec (+ resolver: secrets)
  │                 │            │          │           │   runs steps as `runner` → step-status (broker → status writer) │
  │                 │            │          │           │   needs-outputs / job-outputs: ≤300 KB pages, never one big payload │
  │                 │            │          │           │   job-status: terminal + release obligation, one write │
  │                 │            │          │           │            │ self-terminate
  │                 │  release pass: next ready jobs (Reaper re-drives an armed obligation) │
  ◀── check run / status / review, deep-linked to the console ───────────────────┤

  every 5 min: delivery reconciler λ ──App JWT──▶ GET /app/hook/deliveries?status=failure
               │ failed push/PR for an engine repo, no TRIGGER# yet → fetch payload
               └─▶ same Ingest logic: plan it (≤ 900 KB) or write the sealed `engine-event-too-large` refusal
```

The **delivery reconciler** exists because the webhook route's front door (HTTP API 10 MB, Lambda
synchronous invoke 6 MB) is smaller than GitHub's 25 MB delivery cap; a delivery it rejects never
reaches Ingest, and GitHub's delivery log (3-day retention) is the only place it is visible. It
reads the App PEM Provision already reads, writes only through Ingest's idempotent transactions,
and alarms when its cursor goes stale (spec 06 § The `github` context).

Properties that carry over from the shipped hot path on purpose, rather than being redesigned:

- **JobSpec by reference through the hook broker.** The 4 KB run-hook payload cap
  ([ADR-016](DECISIONS.md#adr-016)) and the no-ambient-authority rule
  ([ADR-021](DECISIONS.md#adr-021)) both still apply, so a JobSpec is stashed and fetched exactly
  as a JIT config is — the VM still learns no `microvmId` and holds no DynamoDB or terminate rights.
  Inside the VM the capability token is held only by `lca-agent` under its own uid; steps run as
  `runner` and cannot read it in unprivileged flavors ([ADR-057](DECISIONS.md#adr-057) (d)).
- **Job-level run states are unchanged** (`queued → provisioning → running → completed|failed|timed_out`)
  as a vocabulary, and each re-run is a new attempt row. Engine rows use a source-aware key
  (`ERUN#<repoKey>#<runId>#<jobId>#<attempt>`), and every run-store writer takes that key instead of
  re-deriving one; the Reaper writes by the stored `pk` of the row it read
  ([ADR-056](DECISIONS.md#adr-056)). The engine adds a plan level *above* (with `held` and
  `refused`), a step level *below*, and a release state (`waiting ⇄ [held]`, then `released`)
  beside each attempt's status: rows exist before they may run, only `released` rows are in the
  status index, and the Reaper re-enqueues only those, so recovery cannot bypass `needs:`, a
  matrix's `max-parallel` slot, fail-fast or an approval.
- **Every crash point leaves a durable obligation, not a lost one.** A delivery's trigger batch is
  written before anything is enqueued, and is sealed only when every matching workflow is planned
  or refused; a plan's input and the plan commit in one transaction; a terminal transition arms the
  plan's release obligation in the same write; a release, a hold, a refusal, a fail-fast trip and
  a review pointer move each create the report, gate, cancel or cleanup obligation they make owed
  in the same write. Each obligation is its own item with one sparse index entry sorted by when it
  is due, so the Reaper's `dueAt <= now` query finds every due one. External
  effects run under holder-fenced, deadline-bound claims (spec 07 § Effect obligations and claims),
  and each job check name has one owning attempt per sha, so a required check never chooses
  between two runs.
- **Refusal costs nothing and happens before boot.** Any construct outside spec 06's Supported and
  Degraded classes (default-deny) refuses the **whole run** at plan time, so a partial engine cannot
  half-execute a workflow — the failure mode the design most needs to avoid.
- **Reporting is a projection, never the record.** The run row is written before any report is
  attempted; a failed report degrades the *display*, never the run.

**What does not carry over: GitHub OIDC.** `id-token: write` works today because GitHub mints the
token off the job message ([ADR-047](DECISIONS.md#adr-047)); an engine-dispatched job has no such
message and therefore no id-token endpoint. Our own CD is consequently **excluded** from `engine`
mode ([ADR-059](DECISIONS.md#adr-059)) — the workflow that deploys the platform must not depend on
the platform's newest subsystem.

## Component inventory

| Component | Service | Responsibility |
|---|---|---|
| Webhook endpoint | API Gateway (HTTP API) | `POST /webhook`; fast 2xx to GitHub |
| Ingest λ | Lambda | Verify HMAC, filter `workflow_job`=`queued` for our labels, enqueue |
| Runner-request queue | SQS (+ DLQ) | Decouple ingest from provisioning; retries |
| Provision λ | Lambda | Consume queue, mint JIT token, launch microVM w/ config |
| Runner | Lambda microVM | Boot from snapshot, register JIT, run 1 job, terminate |
| Hook broker λ | Lambda | Only AWS surface a runner microVM can call: hands back that run's JIT config and terminates that run's VM, capability-token gated (ADR-021) |
| Reaper λ | Lambda (EventBridge schedule) | Kill microVMs exceeding max lifetime; reconcile orphans |
| Image builder | Lambda + code bucket | Build/snapshot flavor images; publish image ARNs |
| Mgmt API λ | Lambda | Read repos/workflows/runs/logs; write repo config + installation index repair only (ADR-025, ADR-037) |
| Config + run store | DynamoDB | Installations, repos, workflows, flavor maps, run records |
| Web UI | S3 (OAC) + CloudFront (SPA) | Operator console; same distribution fronts the API (ADR-024). Vanity alias + A/AAAA Route53 records when a console domain is configured (ADR-036) |
| Console cert | ACM (**us-east-1**) | Viewer certificate for the vanity hostname — CloudFront accepts no other region. Only exists on the vanity-domain path (ADR-036) |
| Auth | GitHub OAuth + signed session cookie | UI login scoped to installations the user can admin (ADR-022) |
| Secrets | SSM Parameter Store (SecureString) | App private key, webhook secret, OAuth client secret |

## Request flows

### A. Job execution (hot path)

```
GitHub                API GW      Ingest λ     SQS        Provision λ      microVM         GitHub
  │  workflow_job=queued │           │          │             │              │               │
  ├──────────────────────▶           │          │             │              │               │
  │                      │─invoke────▶          │             │              │               │
  │                      │      verify HMAC      │             │              │               │
  │                      │      match repo+label │             │              │               │
  │                      │           │─enqueue──▶             │              │               │
  │◀── 202 (fast) ───────┤           │          │             │              │               │
  │                      │           │          │─poll───────▶│              │               │
  │                      │           │          │    mint JIT token (App)     │               │
  │                      │           │          │    select flavor image      │               │
  │                      │           │          │             │─launch──────▶│               │
  │                      │           │          │             │              │─register JIT──▶│
  │                      │           │          │             │              │◀── run job ───▶│
  │                      │           │          │             │              │  self-terminate│
  │                      │           │          │             │  emit run events → DynamoDB   │
```

- **Fast-2xx**: ingest responds before provisioning so GitHub's delivery isn't blocked.
- **Idempotency**: SQS message keyed by `(repo, run_id, job_id)`; provisioner dedupes.
- **Flavor selection**: from workflow labels / `runs-on`, resolved against the repo's flavor map ([03](specs/03-workflow-ingestion.md)).
- Run state transitions (`queued → provisioning → running → completed|failed|timed_out`) are written to DynamoDB for the UI.

### B. Onboarding (GitHub App install)

```
Operator ─▶ Web UI ─▶ "Install App" ─▶ GitHub App install screen ─▶ pick repos
   │                                                          │
   │◀──────────── installation webhook (installation, repos) ─┘
   │
Ingest λ records installation + repos → DynamoDB
Discovery job pulls .github/workflows/*.yml per repo → parses → stores workflow rows
Web UI shows repos + discovered workflows + suggested flavor mapping
```

### C. Reaping (safety net)

EventBridge fires the Reaper λ on a schedule; it lists active microVMs, terminates any
past `MAX_RUNNER_LIFETIME`, and closes stale run records so the UI never shows
perpetually-"running" ghosts.

## Data model

DynamoDB single-table (or few-table) design. Illustrative entities:

| Entity | PK | SK | Notable attrs |
|---|---|---|---|
| Installation | `INST#<installation_id>` | `META` | org, account_login, permissions, suspended |
| Repo | `INST#<installation_id>` | `REPO#<repo_id>` | full_name, enabled, default_flavor |
| Workflow | `REPO#<repo_id>` | `WF#<path>` | name, `runs_on[]`, jobs[], last_parsed_sha |
| FlavorMap | `REPO#<repo_id>` | `FLAVOR#<label>` | image_arn key, vcpu, mem, overrides |
| Run | `REPO#<repo_id>` | `RUN#<run_id>#<job_id>` | status, flavor, microvm_id, timings, log_ref |
| Flavor (global) | `FLAVOR#<name>` | `META` | image_arn, dockerfile, arch, size |

Logs stream to CloudWatch; the UI reads via a `log_ref` (log group + stream) rather than
copying log bodies into DynamoDB.

## Security model

- **Webhook auth**: HMAC-SHA256 with a secret stored in SSM SecureString; constant-time compare.
- **GitHub App**: private key in SSM SecureString; short-lived installation tokens minted per provisioning; JIT runner tokens are single-use.
- **Least privilege**: Provision λ launches/terminates microVMs scoped to the account/region (the GA API cannot scope by VM — ADR-015); Mgmt API λ scoped to config tables; no Lambda has the App key except those that must mint tokens.
- **No ambient authority in the runner** (ADR-021): the execution role stamped on a microVM holds only its own log group plus `lambda:InvokeFunction` on the hook broker λ — no DynamoDB, no `TerminateMicrovm`. A VM authenticates to the broker with a per-run capability token, the broker derives the run key from the token-bound ref, and no `microvmId` ever reaches the guest. Untrusted workflow code therefore cannot read another run's row or kill another tenant's job. `test/exec-role-iam.test.mjs` asserts this against the synthesized template.
- **UI auth**: GitHub OAuth; a user sees only installations they can admin on GitHub. Optional Cognito layer for session mgmt.
- **Runner isolation**: single-use microVM per job; no runner reuse ⇒ no cross-job leakage. Optional VPC attachment with egress filtering for jobs touching private resources.
- **Secrets never in code/CFN**: SecureStrings are created out-of-band and only *referenced* by CDK (CloudFormation cannot create SecureStrings).
- **We hold no customer CI secrets today.** GitHub injects them into a job we never see inside; every
  SSM parameter we own is a *platform* credential. **M6 would change that** — an engine must resolve
  `secrets.*` itself, which turns us from a compute supplier into a secrets holder. The proposed
  containment: writes through a single-purpose control-plane broker (the console λ keeps ADR-025's
  no-`PutParameter` boundary); reads only through a resolver that assumes a reader role tagged with
  the JobSpec's installation id, whose ABAC policy and KMS encryption-context condition admit only
  that installation's path; no secrets at all for fork or bot triggers; at most 4096 bytes per
  value, the Standard-tier limit, refused at intake above that
  ([ADR-057](DECISIONS.md#adr-057)). Not implemented.

## Scaling, quotas & failure handling

- **Broker concurrency** is capped (20 reserved) because its callers are untrusted VMs; that cap is itself a shared resource — see ADR-021's residual risk on boot-path contention.
- **Concurrency** bounded by (a) SQS + Provision λ reserved concurrency and (b) **microVM service quotas** — default quotas are low; request increases early (see [05-infrastructure](specs/05-infrastructure.md)).
- **Backpressure**: if quota is hit, messages stay on SQS and retry; DLQ captures poison messages. UI surfaces "queued > N min" as a health signal.
- **Partial failures**: provisioning failure → message returns to queue (visibility timeout) → retry → DLQ after N attempts; run marked `failed` with reason.
- **Orphans**: Reaper reconciles microVMs with no matching active run.
- **GitHub outages**: jobs simply don't arrive; no state to corrupt. (Reference author notes microVMs can also serve as fallback capacity.)

## Known constraints

- **arm64 only** — Graviton 3/4. Workflows assuming x86_64 native deps must use arm64 images or emulation (slow). Ingestion flags likely-incompatible workflows ([03](specs/03-workflow-ingestion.md)).
- **8-hour max microVM lifetime** — long jobs beyond this are unsupported; Reaper enforces a configurable ceiling well under 8h by default.
- **No warm pool (v1)** — every job pays microVM boot; mitigated by snapshotting pre-warmed images.
- **Snapshot storage cost** — small monthly fixed cost per flavor image.
