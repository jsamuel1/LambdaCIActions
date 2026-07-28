# LambdaCIActions

CI/CD execution platform built on **AWS Lambda microVMs** — a drop-in replacement for
GitHub Actions self-hosted runners. LambdaCIActions runs your existing GitHub Actions
workflows on ephemeral, single-use Graviton microVMs in your own AWS account, with a
GitHub App for onboarding and a web UI for managing repos, workflows, and runs.

> Inspired by Luc van Donkersgoed's [_"I replaced my GitHub runners with Lambda microVMs"_](https://lucvandonkersgoed.com/2026/07/01/i-replaced-my-github-runners-with-lambda-microvms-and-maybe-you-should-too/)
> and the reference [`donkersgoed/github-runner-ochestrator`](https://github.com/donkersgoed/github-runner-ochestrator).
> LambdaCIActions extends that idea from a single-repo orchestrator into a
> **multi-tenant, self-serve platform** with a GitHub App and a management console.

---

## Why

GitHub-hosted runners are convenient but: run in GitHub's regions (latency to your
private AWS resources), give you no VPC access, and offer limited customization.
Self-hosted runners on EC2/ECS mean idle cost, patching, and warm-pool management.

**Lambda microVMs** give you:

- **Ephemeral, single-use runners** — a fresh isolated microVM per job, self-terminating. No shared state, no idle compute.
- **Fast boot** from a pre-built snapshot image (seconds, not minutes).
- **Your account, your region, your VPC** — cut E2E latency to private APIs; reach private resources; apply egress filtering.
- **Per-second billing** on Graviton (2 vCPU / 4 GB ≈ \$0.0044/min) — competitive with, and often cheaper than, GitHub-hosted for many short jobs.
- **Strong tenant isolation** — unlike shared Lambda, each microVM is its own VM.

Tradeoffs (see [ARCHITECTURE](docs/ARCHITECTURE.md)): **arm64 only** (Graviton 3/4, no x86_64),
you own patching + security baseline, and microVM service quotas can be low by default.

## What makes this different from the reference orchestrator

| | Reference orchestrator | **LambdaCIActions** |
|---|---|---|
| Scope | One repo, `.env`-driven | Multi-repo, multi-org, self-serve |
| Onboarding | Manual webhook + SSM setup | **GitHub App** install flow |
| Workflow awareness | Label-only routing | **Parses existing workflows**, maps `runs-on` → flavor |
| Visibility | CloudWatch logs | **Web UI** — repos, workflows, live runs, logs |
| Runner images | 2 fixed flavors | Flavor catalog + per-repo overrides |

## High-level architecture

```
                        ┌───────────────────────────────────────────┐
   GitHub App           │                 AWS Account                 │
   (webhooks) ──HMAC──▶ │  API GW ─▶ Ingest λ ─▶ SQS ─▶ Provision λ   │
                        │                                │            │
   Web UI (console) ──▶ │  API GW ─▶ Mgmt API ─▶ DynamoDB │            │
                        │                                ▼            │
                        │                        Lambda microVM       │
                        │                        (JIT runner, 1 job)  │
                        └───────────────────────────────────────────┘
```

Three planes:

- **Control plane** — GitHub App, webhook ingestion, JIT runner registration.
- **Compute plane** — microVM image build + ephemeral runner lifecycle.
- **Management plane** — web UI + management API over repo/workflow/run state.

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository map

```
docs/
  ARCHITECTURE.md          System design: planes, request flow, data model
  DECISIONS.md             Architecture Decision Records (ADRs)
  ROADMAP.md               Phased delivery milestones
  DEPLOY-M1.md             Runbook: control + compute plane bootstrap
  DEPLOY-M4.md             Runbook: console + management API
  specs/
    01-github-app.md       GitHub App registration, auth, webhooks, JIT runners
    02-microvm-runners.md  Image build, flavors, lifecycle, snapshots
    03-workflow-ingestion.md  Parsing existing workflows → runner routing
    04-web-ui.md           Management console + management API
    05-infrastructure.md   CDK stacks, secrets, deploy phases
bin/        CDK app entrypoint (lca.ts)
lib/        CDK stacks (image-, data-, control-, mgmt-, web-stack.ts)
src/        Lambda source (ingest/, discover/, provision/, reaper/, mgmt/, shared/)
web/        Console SPA (React + TypeScript, esbuild → web/dist)
microvm/    microVM image Dockerfiles + run-hook lifecycle server
scripts/    build/deploy helpers (create-github-app, build-images, build-web)
test/       unit tests (node --test)
```

## Status

**M1–M4 implemented.** The hot path (webhook → Ingest → SQS → Provision → microVM →
self-terminate), the Reaper + run store, flavors + workflow ingestion, and now the
**operator console**: `MgmtStack` (management API) + `WebStack` (React SPA on S3 +
CloudFront) with GitHub OAuth login, repo/workflow management, run history, and a
CloudWatch log viewer. Deploy the console with
[docs/DEPLOY-M4.md](docs/DEPLOY-M4.md); the platform bootstrap is
[docs/DEPLOY-M1.md](docs/DEPLOY-M1.md). M5 (drop-in `adopt` mode + polish) is next — see
[docs/ROADMAP.md](docs/ROADMAP.md). Specs 01–05 + ADRs remain the design source of truth.

## License

Private. All rights reserved (for now).
