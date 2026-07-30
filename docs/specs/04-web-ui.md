# Spec 04 — Web UI & Management API

Status: **Implemented (M4)** · Plane: Management

> Implemented by `src/mgmt/**` (API), `web/**` (console), `lib/mgmt-stack.ts` +
> `lib/web-stack.ts` (infra). Design decisions: [ADR-022](../DECISIONS.md#adr-022) (auth),
> [ADR-023](../DECISIONS.md#adr-023) (run-history index), [ADR-024](../DECISIONS.md#adr-024)
> (single CloudFront origin), [ADR-025](../DECISIONS.md#adr-025) (mgmt IAM boundary),
> [ADR-026](../DECISIONS.md#adr-026) (polling), [ADR-027](../DECISIONS.md#adr-027) (where
> console config is enforced), [ADR-029](../DECISIONS.md#adr-029) (run-primary Runs screen).
> Deploy: [DEPLOY-M4](../DEPLOY-M4.md).

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
- [Resolved questions](#resolved-questions)
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
| **Runs** | Filterable, run-primary history | run + folded status, flavor rollup, duration, job count, expandable jobs | `#/runs` (`?repo=<id>`) |
| **Run detail** | Single run/job deep-dive | state, microVM id, timings, cost estimate, CloudWatch log tail | `#/runs/{repoId}/{runId}/{jobId}` |
| **Reports** | Spend + run analytics over a window, and an NL report assistant | spend/job-count/duration p50-p90/failure rate/queue latency, by repo·flavor·workflow·status·time; CSV+JSON export | `#/reports` (`?metric=…&dimension=…&preset=…`) |
| **Flavors** | Global flavor catalog + image availability | name, label, arch, size, capabilities, $/min, image built? | `#/flavors` |
| **Settings** | Secret/config presence, env identity | SSM param presence (**not values**), env, region | `#/settings` |

Workflow detail is rendered inline on Repo detail rather than as its own screen: a repo has
a handful of workflow files, and the operator's question ("which job goes where, and what's
incompatible?") is answered by one table per file without a navigation hop.

### Runs screen — run-primary rows and rollup rules

The run store is per **job** (key = `(repoId, runId, jobId)`, ADR-009) but an operator thinks
in workflow **runs**, so the screen's primary row is a run and its jobs are nested behind an
expander. The fold is a pure module (`src/mgmt/run-rollup.ts`, re-exported to the SPA as
`web/src/rollup.ts`, tested in `test/run-rollup.test.mjs`) — **ADR-029**:

- **Status fold** — failure dominates: any `failed` → `failed`, then `timed_out`; otherwise
  the most advanced active status wins (`running` > `provisioning` > `queued`); `completed`
  only when every job completed. An empty job set folds to `queued`, never `completed`.
- **Flavor rollup** — the single name when all jobs agree, else `<most common> +<n>` (e.g.
  `node +2`) with the full breakdown shown on expand. Jobs with no flavor yet are ignored.
  On a **partial** window the label is weakened rather than stated as fact (`node +?`,
  `node +2?`): an unread job may use a flavor the loaded jobs never mention, so
  "all jobs agree" is unprovable there.
- **Duration** — the run row shows **wall clock** (earliest job queued → latest transition),
  which answers "how long did the run take". The **sum of job durations** appears on expand as
  **job time**, not "compute": a job's `durationSeconds` is queue → last transition, so queued
  time is in it and the sum is an upper bound on billed microVM runtime rather than a cost
  basis (billable time is `runningAt → last transition` — ADR-030, § Reports). It exceeds wall
  clock for parallel matrices, which is its point. On a
  partial window a duration renders as `≥ 4m 10s` (`durationLabel`); a run with no elapsed span
  yet keeps the plain em dash, since `≥ —` would read as "at least unknown".
- **Started** — the earliest job queue time. On a **partial** window it is an *upper* bound and
  renders as `≤ 01/07/2026, 09:14`: an unread job of the same run may have been queued earlier,
  so the run started at or before the figure shown. It is the one run-row value bounded the
  other way from the durations and job count.
- **Partial rollups** — grouping is client-side over an index **page**, so a run's jobs can
  straddle the page boundary. Completeness is therefore three signals. `GET /api/runs` returns
  **`complete`**, the server's answer to *were any job rows dropped from this response?* — it
  deliberately does **not** mean "the index is exhausted", which the client already knows from
  the cursor. The server half has to be server-side because truncation is judged on the raw
  index pages *before* the installation-visibility filter — a page filled with another tenant's
  rows comes back short while this operator's sibling jobs sit unread past the boundary. The
  third signal is the client's own head/older **seam**: the head page is re-polled every 5 s
  while appended older pages stay in state, and GSI2 sorts on the immutable `createdAt`, so a
  newly queued job pushes a row off the bottom of the head page into a gap the older pages
  start below. The client remembers the key of the head row directly above the first older row
  and marks the window partial once it is gone (`headSeamIntact`). The seam is armed by the
  paging **hop** rather than by appended rows — an empty page with a live cursor still moved
  the cursor off the head page — and the boundary is captured from the head snapshot the
  cursor was read from. Whole runs are folded only
  when `complete` held for every loaded page, the cursor is exhausted, and the seam is intact;
  otherwise every run in the window is badged `partial` and its status, job count, flavor,
  durations and start time render as bounds rather than facts. A repo-filtered page drops nothing, so paging it to the end
  yields exact rollups — until new jobs arrive and shift the seam, when the badge returns. A
  `status=` filter selects *jobs*, so it always reports `complete: false` (including alongside
  `repo=`, where it applies as a post-query predicate) — the screen says so inline.
- **Ids** — run/job ids are small dim text at the end of their column with a copy button
  (`CopyId`): an accessible label, a polite live region for both the copied and the
  could-not-copy outcome, and `stopPropagation` so copying does not trigger the row's
  navigation. The button is rendered only when `navigator.clipboard` exists (it needs a secure
  context — HTTPS-only in production per ADR-024, absent on a plain-HTTP dev origin), because a
  control that does nothing when pressed is worse than none: the id is on screen and selectable
  regardless.
- **Expansion survives polling** — expansion is component state keyed `repoId-runId`, so the
  5 s poll re-renders rows without collapsing an open run.
- **A filter change abandons in-flight paging.** "Load older" is asynchronous while the repo /
  status controls reset the appended pages, the cursor and the seam, so a response can land in a
  window it does not belong to. Each request is stamped with its filter identity
  (`pageQueryKey`) and dropped on arrival if the filter has moved on — otherwise the previous
  repo's jobs would be appended under the newly selected repo and further paging would walk the
  old index.
- **No cost column.** Cost belongs on a Reports screen with a time window and grouping, not on
  a history list; `formatCost` / `flavorRatePerMinute` remain for Run detail and Reports (M5).
- **Repo filter** is an in-screen picker that fans out over the session's installations
  client-side (`GET /api/repos` is installation-scoped; no aggregated repos read was added).
  The selection lives in the URL (`#/runs?repo=<id>`), keeping the
  Repo-detail deep link and shareable filtered views working.

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
| `PATCH /api/repos/{repoId}` | Set `enabled`, `mode`, `defaultFlavor` (a flavor name, or `null` to clear the override), `flavorMap` | ✅ || `GET /api/repos/{repoId}/workflows` | Parsed workflows + routing + compat | ✅ |
| `POST /api/repos/{repoId}/rescan` | Enqueue a Discovery scan | ✅ |
| `GET/PUT /api/repos/{repoId}/flavor-map` | Read/replace label→flavor overrides | ✅ |
| `GET /api/runs` | Filter runs (`repo`, `status`, `limit`, `cursor`; `repo`+`status` compose); returns `complete` (were any job rows dropped from this response?) | ✅ |
| `GET /api/runs/{repoId}/{runId}/{jobId}` | Run detail + derived duration/cost | ✅ |
| `GET /api/runs/{repoId}/{runId}/{jobId}/logs` | Tail CloudWatch logs (`nextToken` or `since`) | ✅ |
| `GET /api/flavors` | Catalog + per-flavor image availability | ✅ |
| `GET /api/health` | Dashboard aggregates + stuck-run detection | ✅ |
| `GET /api/settings` | Env identity + SSM parameter **presence** | ✅ |
| `GET /api/reports/catalog` | Metric catalog + vocabulary + the operator's reportable repos + assistant availability | ✅ |
| `GET /api/reports/run` | Execute a report spec from query params | ✅ |
| `GET /api/reports/export` | CSV/JSON download of the underlying job rows (`format=csv\|json`) | ✅ |
| `POST /api/reports/ask` | NL question → validated spec → rendered report (ADR-032/033) | ✅ |
| `POST /api/repos/{repoId}/rewrite-pr` | Opt-in auto-rewrite PR ([03](03-workflow-ingestion.md)) | M5 |

Run paths carry `repoId` because the run row's key is the `(repoId, runId, jobId)`
idempotency triple (ADR-009) — the API mirrors the storage key rather than adding a lookup.
Every `/api/*` route requires a session; repo-scoped routes additionally require
`?installation=<id>` and check the session's grant for it.

Responses are JSON; log endpoints paginate via CloudWatch tokens (no log bodies in Dynamo).
CloudWatch stops issuing `nextToken` once a filter is caught up, so the log endpoint also
accepts `since=<epoch-ms>` — the client's tail watermark (newest event it holds, +1 ms).
`nextToken` wins when both are sent; a resumed tail that returns nothing is *caught up*, not
`pending`. `pending: true` means the run has no `microvmId`, the log group does not exist, or
a cold first page found no stream (confirmed with one `DescribeLogStreams`).

Run-list pagination uses an opaque cursor (base64url of the DynamoDB `LastEvaluatedKey`);
the unfiltered multi-status view returns `nextCursor: null` — narrow by repo or status to
page deeper (ADR-023). Because the run indexes are not keyed by installation, authorization
is a **post-query filter**, so filtered endpoints walk up to 5 index pages per request to
fill a page of visible rows; `nextCursor` is null only when the index is exhausted
(`src/mgmt/paging.ts`, `test/mgmt-authz-paging.test.mjs`). `limit` is a **floor** on those
endpoints: because the cursor addresses an index page, a response may carry a few rows beyond
`limit` (whatever the last fetched page contributed) rather than dropping rows the cursor can
no longer reach.

`GET /api/health` counts are **platform-wide** (the status index is not per-installation),
while `stuck` and every run list are filtered to the session's installations. Counts follow
`LastEvaluatedKey` for up to 10 pages and set `countsExact: false` when that budget is spent,
so a large history reads as a labelled lower bound rather than a wrong total.

## Reports

The Reports screen owns cost/spend and run analytics. It is the home for the cost estimate
that the Runs table only summarises.

**Counting unit.** Every stored row is one workflow **job**, not one workflow run — the run
store is keyed by `(repoId, runId, jobId)` because a job is what occupies a microVM. A
`workflow_run` with five jobs is five rows, so "job count" is the unit and the UI says *jobs*.

**Report catalog** (the closed vocabulary; `src/mgmt/reports.ts` is the single source, and the
assistant's prompt is generated from it so the two cannot drift):

| Metric | Unit | Definition |
|---|---|---|
| `spend` | USD | Σ per-job billable minutes × flavor rate. **Estimate** — see below. |
| `runCount` | jobs | Job rows created in the window, by queued timestamp. |
| `duration` | seconds | p50 / p90 of queued→last-transition wall clock, **terminal jobs only**. |
| `failureRate` | ratio | (failed + timed_out) ÷ terminal jobs. In-flight jobs excluded from **both** sides. |
| `queueLatency` | seconds | p50 / p90 of queued→`runningAt`, over jobs carrying the watermark. |

Dimensions: `repo`, `flavor`, `workflow`, `status`, `time` (hourly under 3 days, else daily),
`none`. Charts: `bar`, `stackedBar`, `line`, `table` — the list is the renderer's capability, not
a wish list, so a spec can never resolve to a chart type that silently falls through to a
different one. Windows: `24h`/`7d`/`30d`/`90d`
presets or an explicit `from`/`to`, capped at **90 days** because terminal rows carry a 90-day
TTL. Percentiles are **nearest-rank, never interpolated** — with tens of samples an interpolated
p90 invents a value between two real jobs.

**Cost honesty.** `spend` is an estimate and is labelled as one everywhere. The rate comes from
the flavor's vCPU/GB footprint (OQ-3), and billable time comes from the `runningAt` watermark
(ADR-030) so queue and provisioning time are not charged. Rows predating the watermark fall back
to total wall clock, which **overstates** cost; each export row carries `costBasis`
(`measured` \| `wallClock`) and every report reports `coverage` — the share of contributing rows
measured rather than inferred. Reconciliation against a real microVM bill is still outstanding
(OQ-6): the direction of the error is known and stated, the magnitude is not.

**Every report reports its own completeness.** `complete: false` means the read budget was spent
before the window was exhausted, and the UI renders the numbers as a floor with advice to narrow
the window — it never silently truncates. `coverage` and the metric's `caveat` are shown
alongside every chart.

**Tenant isolation (ADR-031).** Unlike run lists, reporting does **not** post-filter. It resolves
the operator's visible repos first and queries only those GSI2 partitions, so a foreign row is
never fetched. `filters.repoIds` can only narrow that set. A zero-grant session gets 403, as on
`/api/health`. `test/report-isolation.test.mjs` asserts the platform-wide total is strictly
larger than the tenant total, so the test is provably isolating something.

**Export.** `GET /api/reports/export` returns the underlying job rows, not the aggregate. CSV
fields are RFC-4180 quoted **and** formula-defanged: repo/workflow/job names are
tenant-controlled, and a name beginning `=`/`+`/`-`/`@` executes on open in Excel/Sheets.

**Assistant (ADR-032 / ADR-033).** `POST /api/reports/ask` sends the operator's question to
Bedrock, which replies with a JSON spec — never code, never a query, never markup. The spec goes
through the *same* validator as the picker's query params; anything outside the vocabulary is
rejected, not repaired. The resolved spec is written into the URL, so a generated report is a
plain shareable link that re-runs deterministically without the model. Refusals (disabled,
unsupported, invalid spec, unavailable, rate-limited) leave the manual picker fully usable and
show why. No tenant data enters the prompt; authorization is never a spec field. Limits: 400-char
question, 10 invocations/minute per actor, 500 per container.

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
  the source of truth; the platform never interprets org roles. Run resolution can only
  check the grant AFTER reading the row, so a foreign run answers **404 (identical to
  missing)** — not 403 — to avoid an existence oracle on guessed run ids.
- A user with **zero installations** still gets a session (with an empty grant list) so the
  Setup screen is reachable for first-run onboarding — the empty list authorizes nothing:
  repo routes answer 403, run routes 404 (the deny-as-not-found rule above), every list is
  empty, and `/api/health` (whose counts are platform-wide) is explicitly denied. Installing
  the App and re-logging-in picks up the grant.
- Cognito is **not** used in v1 (ADR-022 rationale).
- Secrets are shown as **presence/health only** ("webhook secret: set ✓") — never values.
  The API reads presence via `ssm:DescribeParameters`, which cannot return a value, and the
  Mgmt λ has no IAM permission to read the App PEM or webhook secret at all (ADR-025).

## Live run updates

- Runner bootstrap emits lifecycle heartbeats → `Run` rows update ([02](02-microvm-runners.md)).
- v1 is **polling** (ADR-026): 3 s on Run detail, 5 s on Dashboard/Runs, **paused while the
  tab is hidden**. No WebSocket/SSE — Phase 3.
- Log viewer tails the per-env run log group (`/aws/lambda/microvms/runs/lca-<env>`,
  ADR-016) filtered to the run's `microvmId` (ADR-019), following CloudWatch's `nextToken`
  while one is issued and its own `since` watermark afterwards (see the API notes above —
  re-sending a spent token would replay the same page forever).

## Tech choices

- **Frontend**: React 18 + TypeScript SPA, hash-routed, bundled by **esbuild**
  (`npm run build:web` → `web/dist`). esbuild is already a devDependency (NodejsFunction
  uses it), so the console added no new build tooling. **No component library** — the
  console is ~10 screens of tables and forms; a hand-rolled stylesheet keeps the bundle at
  ~165 KB and avoids a framework dependency. Cloudscape remains an option if the surface grows.
- **Hosting**: private S3 bucket (OAC) + CloudFront, with the API attached to the **same
  distribution** as `/api/*` and `/auth/*` behaviors (ADR-024) — first-party cookie, no CORS.
  The distribution defines **no custom error responses**: they are distribution-wide, so an
  SPA fallback rewrite would also turn the API's 403/404 into `200` + HTML. Hash routing
  makes the fallback unnecessary. The app shell is served with a `self`-only CSP
  (`frame-ancestors 'none'`), HSTS, `nosniff`, and `Referrer-Policy: same-origin`
  (`test/web-stack.test.mjs`).
- **Console origin**: a **vanity domain** when configured (ADR-036) — `lambdaciactions.<zone>`
  for prod, `<env>.lambdaciactions.<zone>` otherwise — with a us-east-1 ACM cert
  (`LCA-Cert-<env>`, CloudFront's only accepted cert region) and A+AAAA Route53 aliases.
  Because the origin is then known at synth time, `PUBLIC_ORIGIN` is plain config and the
  ADR-024 two-pass deploy disappears. With no domain configured the raw `*.cloudfront.net`
  origin and the two-pass bootstrap still apply.
- **API**: API Gateway (HTTP API) + one Lambda (TypeScript, arm64, Node 22), same toolchain
  as the orchestrator.
- **State**: DynamoDB (shared single table) + GSI2 for per-repo run history (ADR-023).
- **Auth**: GitHub OAuth + signed session cookie (ADR-022).

## Non-functional

- **Read latency**: every read is a keyed `GetItem` or an index `Query` — no table scans.
  Dashboard counts use `Select: COUNT` on GSI1 (paged, bounded); run history uses GSI2
  (ADR-023).
- **No secret exposure**: presence via `DescribeParameters`; the λ holds no IAM grant for
  secret paths beyond its own OAuth/session credentials (ADR-025).
- **Least privilege**: read-mostly. `dynamodb:UpdateItem` is the only write (no
  Put/Delete), `sqs:SendMessage` only on the discovery queue, log read-only on one group,
  and **no** microVM launch/terminate or `iam:PassRole`. Asserted against the synthesized
  template in `test/mgmt-stack.test.mjs`. Two code paths use that write: repo config
  patches, and the ADR-037 installation index repair (`gsi1pk`/`gsi1sk` on an installation
  the session already holds a grant for).
- **Input allow-listing**: config bodies are validated field-by-field; unknown fields are a
  400, so a run's status/microVM id can't be patched through the config endpoint.
- **Auditability**: config writes stamp `updatedBy` (GitHub login) + `updatedAt` on the repo
  row and emit a structured log line with the actor and the patch.
- **Config takes effect in the control plane** (ADR-027): the management λ only writes repo
  config (and the ADR-037 installation index repair, which writes only index attributes —
  no field the console or control plane reads for behaviour).
  `enabled=false` / `mode='off'` are enforced by Ingest's claim gate, and
  `defaultFlavor` by `resolveFlavor`'s fallback. Both fail open, so a config read fault
  cannot stop a labeled job.
- **CSP and inline styles**: the console CSP has `style-src 'self'` with no
  `unsafe-inline`, so browsers drop `style="…"` attributes. React's `style={{…}}` compiles to
  exactly that — all layout lives in `web/src/styles.css` and `test/web-stack.test.mjs`
  fails the build if an inline style returns.

## Resolved questions

- **OQ-1** (live updates) → **polling**, ADR-026. WebSocket stays in the Phase 3 backlog.
- **OQ-2** (Cognito) → **GitHub-OAuth-only** + server-signed stateless session, ADR-022.
- **OQ-3** (cost rate card) → derived from the **flavor catalog footprint**
  (`vcpu × $/vCPU-min + GB × $/GB-min`, calibrated to the README's 2 vCPU/4 GB ≈
  $0.0044/min reference) rather than a hand-maintained rate table, so a new flavor cannot
  ship without a price. Surfaced as an explicit *estimate*.
  **Amended by ADR-038**: the catalog's `vcpu` is *descriptive* — the microVM API accepts a
  memory request (`--resources minimumMemoryInMiB`) and exposes no vCPU knob — so the vCPU
  term is a proxy for the shape a flavor is intended for, not for provisioned capacity. The
  two-term formula stays (memory is real and drives quota), but every surface must label the
  figure an estimate; the Flavors screen footnotes the `vcpu` column for this reason.
  **Amended by ADR-030**: the *duration* term is no longer wall clock. v1 had no per-phase
  timestamps, so it billed queue + provisioning time too; the watermarks below narrow it to
  `runningAt → updatedAt`. The figure stays an estimate — the rate is still derived, not billed.
- **OQ-5** (per-phase run timestamps) → **added**, ADR-030. `provisioningAt` + `runningAt` are
  stamped write-once inside the guarded status transition, which makes billable time
  `runningAt → updatedAt` instead of total wall clock and makes queue-to-start latency a real
  metric. Pre-M5 rows have no watermark and are reported as coverage, never as zero.
- **Chart library** → **ECharts (Apache-2.0), pinned exact**, ADR-034. Highcharts was requested
  but is commercially licensed and no entitlement covering this repo could be confirmed.
- **Generative UI shape** → **constrained spec emission**, ADR-033. The model selects from a
  closed catalog; no model-authored JS/JSX/HTML/query is ever evaluated or rendered.
- **Report model** → **Claude 3.5 Sonnet on Bedrock**, from the existing Mgmt λ, with
  `bedrock:InvokeModel` scoped to that one model id, ADR-032.

## Open questions

- **OQ-4**: ~~custom domain + ACM cert for the console~~ — **resolved** by
  [ADR-036](../DECISIONS.md#adr-036) (M5): config-derived vanity origin + a us-east-1 cert
  stack, with the raw-CloudFront path kept for accounts owning no domain.
- **OQ-6**: reconcile the `spend` estimate against a real microVM bill for one month so the
  error bar is a measured number rather than a stated direction. The estimate is deliberately
  labelled and its bias (overstates, for rows without a `runningAt` watermark) is known;
  the magnitude is not.
- **OQ-7**: a durable, cross-container spend budget for the Reports assistant. The current cap
  is per-λ-container (ADR-032) — adequate for a single-λ console, wrong the moment reporting
  moves to its own function or the console scales out.
