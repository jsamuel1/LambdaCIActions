# Spec 04 — Web UI & Management API

Status: **Draft** · Plane: Management

The operator console: install/manage the GitHub App, see which repos + workflows are
onboarded, inspect live and historical runs with logs, and tune flavor mappings. Backed by
a management API over the same DynamoDB the control/compute planes write to.

## Contents
- [Personas & jobs-to-be-done](#personas--jobs-to-be-done)
- [Screens](#screens)
- [Management API](#management-api)
- [Auth](#auth)
- [Live run updates](#live-run-updates)
- [Tech choices](#tech-choices)
- [Non-functional](#non-functional)
- [Open questions](#open-questions)

---

## Personas & jobs-to-be-done

- **Platform owner** — install the App, set global flavors, request quotas, watch health.
- **Repo maintainer** — enable a repo, pick onboarding mode, fix compat warnings, watch their runs.
- **Debugging engineer** — find a failed run, read logs, see which flavor/microVM ran it and timings.

## Screens

| Screen | Purpose | Key data |
|---|---|---|
| **Setup / Install** | App manifest create + install flow; connect AWS env | app creds status, install link |
| **Dashboard** | Health at a glance | queued/running counts, error rate, quota headroom, stuck-queue alerts |
| **Repos** | List installed repos; enable/disable; set mode | full_name, mode, default flavor, compat rollup |
| **Repo detail** | Per-repo workflows + flavor map | workflows[], routing, override editor |
| **Workflow detail** | Parsed view of a workflow | jobs, `runs_on`, resolved flavor, compat warnings |
| **Runs** | Filterable run history | status, repo, workflow, flavor, duration, timings |
| **Run detail** | Single run/job deep-dive | state timeline, microVM id, log viewer (CloudWatch), cost estimate |
| **Flavors** | Global flavor catalog + image build status | name, size, image ARN, last build, arch |
| **Settings** | Secrets status, labels, retention, quota links | SSM param presence (not values), defaults |

Wireframe (Repo detail):

```
┌ Repos › acme/service ─────────────────────────────── mode: [adopt ▾] ─┐
│ Compat: ● 6 ok  ● 1 warn  ● 0 risk                    [Re-scan]        │
│─────────────────────────────────────────────────────────────────────│
│ Workflow            Jobs   runs-on        → Flavor      Compat        │
│ ci.yml              build  ubuntu-latest  → node        ● ok          │
│                     test   ubuntu-latest  → node        ● ok          │
│ release.yml         build  ubuntu-latest  → docker      ● warn (DinD) │
│─────────────────────────────────────────────────────────────────────│
│ Flavor overrides:  ubuntu-latest → [node ▾]   [+ add override]        │
└───────────────────────────────────────────────────────────────────────┘
```

## Management API

REST over API Gateway → **Mgmt API λ**. Read-mostly; writes are config.

| Method + path | Purpose |
|---|---|
| `GET /api/installations` | List installations the caller can admin |
| `GET /api/repos?installation=<id>` | List repos for an installation |
| `PATCH /api/repos/{repo_id}` | Set `mode`, `default_flavor`, enable/disable |
| `GET /api/repos/{repo_id}/workflows` | Parsed workflows + routing + compat |
| `POST /api/repos/{repo_id}/rescan` | Force re-parse |
| `GET/PUT /api/repos/{repo_id}/flavor-map` | Read/replace label→flavor overrides |
| `POST /api/repos/{repo_id}/rewrite-pr` | Open opt-in auto-rewrite PR ([03](03-workflow-ingestion.md)) |
| `GET /api/runs` | Filter runs (repo, status, time) |
| `GET /api/runs/{run_id}/{job_id}` | Run detail + `log_ref` |
| `GET /api/runs/{run_id}/{job_id}/logs` | Stream/tail CloudWatch logs (paginated) |
| `GET /api/flavors` | Global catalog + image build status |
| `GET /api/health` | Dashboard aggregates |

Responses are JSON; log endpoints paginate via CloudWatch tokens (no log bodies in Dynamo).

## Auth

- **GitHub OAuth** (the App's OAuth creds) — user logs in with GitHub.
- Authorization: a user may view/manage an installation **only if** they have admin on the
  corresponding GitHub org/repo. Verified by calling GitHub with the user's token at
  session start; cached in the session.
- Optional **Cognito** in front for session/token management and to keep GitHub tokens
  server-side. Mgmt API validates a session JWT; never trusts client-supplied scopes.
- Secrets are shown as **presence/health only** (e.g. "webhook secret: set ✓") — never values.

## Live run updates

- Runner bootstrap emits lifecycle heartbeats → `Run` rows update ([02](02-microvm-runners.md)).
- UI gets near-real-time updates via **WebSocket API (API Gateway)** or SSE; fallback to polling `GET /api/runs`.
- Log viewer tails CloudWatch via `GetLogEvents` with a next-token loop.

## Tech choices

- **Frontend**: SPA (React + TypeScript), hosted on **S3 + CloudFront**. Component lib TBD (Cloudscape is a natural fit for an AWS-flavored ops console).
- **API**: API Gateway (HTTP API) + Lambda (TypeScript), same runtime/toolchain as the orchestrator to keep one build.
- **State**: DynamoDB (shared with control/compute planes).
- **Auth**: GitHub OAuth (+ optional Cognito).

## Non-functional

- **Read latency**: dashboard/list < 300 ms p95 (Dynamo GSIs on status + time).
- **No secret exposure**: UI/API never return SecureString values.
- **Least privilege**: Mgmt API λ can read all planes' tables but write only config entities; cannot mint GitHub tokens or launch microVMs.
- **Auditability**: config writes (mode/flavor changes, rewrite PRs) recorded with actor + timestamp.

## Open questions

- **OQ-1**: WebSocket vs SSE vs polling for live updates in v1? (Polling is simplest; WS is nicest. Leaning polling for v1, WS in Phase 3.)
- **OQ-2**: Cognito now or GitHub-OAuth-only for v1? (Leaning OAuth-only + server-side session for v1.)
- **OQ-3**: Cost estimate on run detail — compute from job-seconds × flavor rate; where do we source the rate card? (Config table.)
