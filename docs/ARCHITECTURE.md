# Architecture

LambdaCIActions runs GitHub Actions jobs on ephemeral AWS Lambda microVMs. This doc
covers the system decomposition, request/lifecycle flows, the data model, and the
security + failure-handling posture.

## Contents

- [Design goals & non-goals](#design-goals--non-goals)
- [The three planes](#the-three-planes)
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
Read-mostly; writes are config (flavor overrides, repo enable/disable).

```
┌── Control plane ─────────┐   ┌── Compute plane ──────────┐   ┌── Management plane ──────┐
│ GitHub App               │   │ microVM image builder     │   │ Web UI (SPA)             │
│ API GW  /webhook         │   │ Provision λ               │   │ API GW  /api/*           │
│ Ingest λ                 │   │ Lambda microVM (runner)   │   │ Mgmt API λ               │
│ SQS runner-requests + DLQ│   │ Reaper λ (timeouts)       │   │ DynamoDB (config + runs) │
│ JIT token minting        │   │ ECR/code bucket snapshots │   │ Cognito / GitHub OAuth   │
└──────────────────────────┘   └───────────────────────────┘   └──────────────────────────┘
```

## Component inventory

| Component | Service | Responsibility |
|---|---|---|
| Webhook endpoint | API Gateway (HTTP API) | `POST /webhook`; fast 2xx to GitHub |
| Ingest λ | Lambda | Verify HMAC, filter `workflow_job`=`queued` for our labels, enqueue |
| Runner-request queue | SQS (+ DLQ) | Decouple ingest from provisioning; retries |
| Provision λ | Lambda | Consume queue, mint JIT token, launch microVM w/ config |
| Runner | Lambda microVM | Boot from snapshot, register JIT, run 1 job, terminate |
| Reaper λ | Lambda (EventBridge schedule) | Kill microVMs exceeding max lifetime; reconcile orphans |
| Image builder | Lambda + code bucket | Build/snapshot flavor images; publish image ARNs |
| Mgmt API λ | Lambda | CRUD over repos/workflows/flavors; run history/logs |
| Config + run store | DynamoDB | Installations, repos, workflows, flavor maps, run records |
| Web UI | S3 + CloudFront (SPA) | Operator console |
| Auth | GitHub OAuth (+ optional Cognito) | UI login scoped to installations the user can admin |
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
- **Least privilege**: Provision λ can launch/terminate only tagged microVMs; Mgmt API λ scoped to config tables; no Lambda has the App key except those that must mint tokens.
- **UI auth**: GitHub OAuth; a user sees only installations they can admin on GitHub. Optional Cognito layer for session mgmt.
- **Runner isolation**: single-use microVM per job; no runner reuse ⇒ no cross-job leakage. Optional VPC attachment with egress filtering for jobs touching private resources.
- **Secrets never in code/CFN**: SecureStrings are created out-of-band and only *referenced* by CDK (CloudFormation cannot create SecureStrings).

## Scaling, quotas & failure handling

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
