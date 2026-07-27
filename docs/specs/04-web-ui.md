# Spec 04 — Web UI & Management API

Status: **Implemented (M4)** · Plane: Management

> Implemented by `src/mgmt/**` (API), `web/**` (console), `lib/mgmt-stack.ts` +
> `lib/web-stack.ts` (infra). Design decisions: [ADR-022](../DECISIONS.md#adr-020) (auth),
> [ADR-023](../DECISIONS.md#adr-021) (run-history index), [ADR-024](../DECISIONS.md#adr-022)
> (single CloudFront origin), [ADR-025](../DECISIONS.md#adr-023) (mgmt IAM boundary),
> [ADR-026](../DECISIONS.md#adr-024) (polling). Deploy: [DEPLOY-M4](../DEPLOY-M4.md).

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

| Screen | Purpose | Key data | Route |
|---|---|---|---|
| **Setup / Install** | Installation list + platform readiness | install state, missing SSM params | `#/setup` |
| **Dashboard** | Health at a glance | active/queued/running counts, error rate, stuck runs, recent runs | `#/` |
| **Repos** | List installed repos; enable/disable; set mode + default flavor | full_name, mode, default flavor, compat rollup, last change + actor | `#/repos` |
| **Repo detail** | Per-repo workflows + flavor map | workflows[], per-job routing, compat findings, override editor, re-scan | `#/repos/{repoId}` |
| **Workflow detail** | Parsed view of a workflow | jobs, `runs_on`, resolved flavor + reason, compat warnings | inline on Repo detail |
| **Runs** | Filterable run history | status, repo, run/job, flavor, duration, est. cost, started | `#/runs` (`?repo=<id>`) |
| **Run detail** | Single run/job deep-dive | state, microVM id, timings, cost estimate, CloudWatch log tail | `#/runs/{repoId}/{runId}/{jobId}` |
| **Flavors** | Global flavor catalog + image availability | name, label, arch, size, capabilities, $/min, image built? | `#/flavors` |
| **Settings** | Secret/config presence, env identity | SSM param presence (**not values**), env, region | `#/settings` |

Workflow detail is rendered inline on Repo detail rather than as its own screen: a repo has
a handful of workflow files, and the operator's question ("which job goes where, and what's
incompatible?") is answered by one table per file without a navigation hop.

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

One Lambda (`src/mgmt/handler.ts`) behind two catch-all HTTP API routes (`/api/{proxy+}`,
`/auth/{proxy+}`). Routing itself lives in a **pure route table** (`src/mgmt/router.ts`) so
adding an endpoint is not a CloudFormation change and the whole table is unit-tested.

| Method + path | Purpose | Status |
|---|---|---|
| `GET /auth/login` | Start GitHub OAuth (signed `state` + nonce cookie) | ✅ |
| `GET /auth/callback` | Exchange code, mint session cookie | ✅ |
| `POST /auth/logout` | Clear the session cookie | ✅ |
| `GET /api/me` | Session introspection (login, installations, expiry) | ✅ |
| `GET /api/installations` | List installations the caller can admin | ✅ |
| `GET /api/repos?installation=<id>` | List repos + compat rollup | ✅ |
| `PATCH /api/repos/{repoId}` | Set `enabled`, `mode`, `defaultFlavor`, `flavorMap` | ✅ |
| `GET /api/repos/{repoId}/workflows` | Parsed workflows + routing + compat | ✅ |
| `POST /api/repos/{repoId}/rescan` | Enqueue a Discovery scan | ✅ |
| `GET/PUT /api/repos/{repoId}/flavor-map` | Read/replace label→flavor overrides | ✅ |
| `GET /api/runs` | Filter runs (`repo`, `status`, `limit`, `cursor`) | ✅ |
| `GET /api/runs/{repoId}/{runId}/{jobId}` | Run detail + derived duration/cost | ✅ |
| `GET /api/runs/{repoId}/{runId}/{jobId}/logs` | Tail CloudWatch logs (paginated) | ✅ |
| `GET /api/flavors` | Catalog + per-flavor image availability | ✅ |
| `GET /api/health` | Dashboard aggregates + stuck-run detection | ✅ |
| `GET /api/settings` | Env identity + SSM parameter **presence** | ✅ |
| `POST /api/repos/{repoId}/rewrite-pr` | Opt-in auto-rewrite PR ([03](03-workflow-ingestion.md)) | M5 |

Run paths carry `repoId` because the run row's key is the `(repoId, runId, jobId)`
idempotency triple (ADR-009) — the API mirrors the storage key rather than adding a lookup.
Every `/api/*` route requires a session; repo-scoped routes additionally require
`?installation=<id>` and check the session's grant for it.

Responses are JSON; log endpoints paginate via CloudWatch tokens (no log bodies in Dynamo).
Run-list pagination uses an opaque cursor (base64url of the DynamoDB `LastEvaluatedKey`);
the unfiltered multi-status view returns `nextCursor: null` — narrow by repo or status to
page deeper (ADR-023).

## Auth

GitHub-OAuth-only with a stateless signed session — **ADR-022**. Summary:

- `/auth/login` → GitHub authorize with an HMAC-signed `state` nonce that is also set as a
  short-lived `HttpOnly` cookie; the callback requires both to agree.
- The callback exchanges the code for a **user** token, resolves identity (`/user`) and
  authorization (`/user/installations`), then **discards the token** — it never enters the
  cookie or any store.
- Session = `base64url(json).base64url(HMAC-SHA256)` in an `HttpOnly; Secure;
  SameSite=Lax` cookie, TTL 8 h, signed with `/lca/<env>/mgmt/session-secret` (SSM
  SecureString, created out-of-band per ADR-008).
- Authorization is a single predicate, `canAdminInstallation`, applied at two choke points
  (repo resolution, run resolution) plus list filtering. GitHub's own access decision is
  the source of truth; the platform never interprets org roles.
- Cognito is **not** used in v1 (ADR-022 rationale).
- Secrets are shown as **presence/health only** ("webhook secret: set ✓") — never values.
  The API reads presence via `ssm:DescribeParameters`, which cannot return a value, and the
  Mgmt λ has no IAM permission to read the App PEM or webhook secret at all (ADR-025).

## Live run updates

- Runner bootstrap emits lifecycle heartbeats → `Run` rows update ([02](02-microvm-runners.md)).
- v1 is **polling** (ADR-026): 3 s on Run detail, 5 s on Dashboard/Runs, **paused while the
  tab is hidden**. No WebSocket/SSE — Phase 3.
- Log viewer tails the per-env run log group (`/aws/lambda/microvms/runs/lca-<env>`,
  ADR-016) filtered to the run's `microvmId` (ADR-019), following CloudWatch's `nextToken`.

## Tech choices

- **Frontend**: React 18 + TypeScript SPA, hash-routed, bundled by **esbuild**
  (`npm run build:web` → `web/dist`). esbuild is already a devDependency (NodejsFunction
  uses it), so the console added no new build tooling. **No component library** — the
  console is ~10 screens of tables and forms; a hand-rolled stylesheet keeps the bundle at
  ~165 KB and avoids a framework dependency. Cloudscape remains an option if the surface grows.
- **Hosting**: private S3 bucket (OAC) + CloudFront, with the API attached to the **same
  distribution** as `/api/*` and `/auth/*` behaviors (ADR-024) — first-party cookie, no CORS.
- **API**: API Gateway (HTTP API) + one Lambda (TypeScript, arm64, Node 22), same toolchain
  as the orchestrator.
- **State**: DynamoDB (shared single table) + GSI2 for per-repo run history (ADR-023).
- **Auth**: GitHub OAuth + signed session cookie (ADR-022).

## Non-functional

- **Read latency**: every read is a keyed `GetItem` or an index `Query` — no table scans.
  Dashboard counts use `Select: COUNT` on GSI1; run history uses GSI2 (ADR-023).
- **No secret exposure**: presence via `DescribeParameters`; the λ holds no IAM grant for
  secret paths beyond its own OAuth/session credentials (ADR-025).
- **Least privilege**: read-mostly. `dynamodb:UpdateItem` is the only write (no
  Put/Delete), `sqs:SendMessage` only on the discovery queue, log read-only on one group,
  and **no** microVM launch/terminate or `iam:PassRole`. Asserted against the synthesized
  template in `test/mgmt-stack.test.mjs`.
- **Input allow-listing**: config bodies are validated field-by-field; unknown fields are a
  400, so a run's status/microVM id can't be patched through the config endpoint.
- **Auditability**: config writes stamp `updatedBy` (GitHub login) + `updatedAt` on the repo
  row and emit a structured log line with the actor and the patch.

## Resolved questions

- **OQ-1** (live updates) → **polling**, ADR-026. WebSocket stays in the Phase 3 backlog.
- **OQ-2** (Cognito) → **GitHub-OAuth-only** + server-signed stateless session, ADR-022.
- **OQ-3** (cost rate card) → derived from the **flavor catalog footprint**
  (`vcpu × $/vCPU-min + GB × $/GB-min`, calibrated to the README's 2 vCPU/4 GB ≈
  $0.0044/min reference) rather than a hand-maintained rate table, so a new flavor cannot
  ship without a price. Surfaced as an explicit *estimate*: it uses wall-clock duration,
  which is an upper bound on billed microVM runtime (v1 stores no per-phase timestamps).

## Open questions

- **OQ-4**: custom domain + ACM cert for the console (currently the CloudFront domain) — M5.
- **OQ-5**: per-phase run timestamps (`provisioningAt`/`runningAt`) would make the cost
  estimate exact and enable boot-latency charts. Worth a run-row schema addition in M5?
