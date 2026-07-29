# Spec 04 — Web UI & Management API

Status: **Implemented (M4)** · Plane: Management

> Implemented by `src/mgmt/**` (API), `web/**` (console), `lib/mgmt-stack.ts` +
> `lib/web-stack.ts` (infra). Design decisions: [ADR-022](../DECISIONS.md#adr-020) (auth),
> [ADR-023](../DECISIONS.md#adr-021) (run-history index), [ADR-024](../DECISIONS.md#adr-022)
> (single CloudFront origin), [ADR-025](../DECISIONS.md#adr-023) (mgmt IAM boundary),
> [ADR-026](../DECISIONS.md#adr-024) (polling), [ADR-027](../DECISIONS.md#adr-025) (where
> console config is enforced). Deploy: [DEPLOY-M4](../DEPLOY-M4.md).

The operator console: install/manage the GitHub App, see which repos + workflows are
onboarded, inspect live and historical runs with logs, and tune flavor mappings. Backed by
a management API over the same DynamoDB the control/compute planes write to.

## Contents
- [Personas & jobs-to-be-done](#personas--jobs-to-be-done)
- [Screens](#screens)
- [Management API](#management-api)
- [Settings](#settings)
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
| **Settings** | GitHub App linkage, runner labels, webhook health + platform actions | verified App id/name/slug, installation ids + accounts, effective runner labels, webhook endpoint + delivery evidence, flavors, env/region | `#/settings` |

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
| `PATCH /api/repos/{repoId}` | Set `enabled`, `mode`, `defaultFlavor` (a flavor name, or `null` to clear the override), `flavorMap` | ✅ || `GET /api/repos/{repoId}/workflows` | Parsed workflows + routing + compat | ✅ |
| `POST /api/repos/{repoId}/rescan` | Enqueue a Discovery scan | ✅ |
| `GET/PUT /api/repos/{repoId}/flavor-map` | Read/replace label→flavor overrides | ✅ |
| `GET /api/runs` | Filter runs (`repo`, `status`, `limit`, `cursor`) | ✅ |
| `GET /api/runs/{repoId}/{runId}/{jobId}` | Run detail + derived duration/cost | ✅ |
| `GET /api/runs/{repoId}/{runId}/{jobId}/logs` | Tail CloudWatch logs (`nextToken` or `since`) | ✅ |
| `GET /api/flavors` | Catalog + per-flavor image availability | ✅ |
| `GET /api/health` | Dashboard aggregates + stuck-run detection | ✅ |
| `GET /api/settings` | Env identity, verified App linkage, runner labels, webhook health | ✅ |
| `PUT /api/settings/runner-labels` | Replace the claimed runner labels (`dryRun` returns impact only) | ✅ |
| `POST /api/settings/github-app/relink` | Write-only credential intake: verify against GitHub, then store | ✅ |
| `POST /api/settings/github-app/rollback` | Undo a relink: restore replaced parameter versions and/or `remove` ones it created | ✅ |
| `POST /api/settings/webhook/test` | Ask GitHub to re-deliver a delivery (real signed round-trip) | ✅ |
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

## Settings

The Settings screen answers four operator questions with **evidence**, not with SSM parameter
paths (ADR-029). SSM is an implementation detail: knowing that `/lca/dev/github/app-pem`
exists tells an operator nothing about whether their platform works.

### 1. GitHub App linkage

App id, name, slug, owner, subscribed events and permissions, **verified live** by minting an
App JWT and calling `GET /app`. A green badge therefore proves the *stored* PEM + app id pair
actually authenticates — the previous "parameter present ✓" could be green with a corrupt key.
Installation ids + account logins come from `GET /app/installations` (GitHub's ground truth),
cross-referenced against our install store so a **missed `installation` webhook** shows up as
`not in run store` rather than silently diverging. A stored `app-id` that disagrees with the
App the key authenticates as is called out explicitly — that is the signature of a
half-finished rotation.

### 2. Runner labels

The **effective** claim list (the value Ingest reads per delivery), not the parameter path.
Labels that name GitHub-hosted images are flagged, because claiming them is an adopt-mode
takeover.

`PUT /api/settings/runner-labels` validates field-by-field (`src/mgmt/validate.ts`):

- normalized to lower case — claim-time matching is case-insensitive, so storing mixed case
  would let the UI and the claim comparison disagree;
- **GitHub-reserved** labels (`self-hosted`, `linux`, `arm64`, …) are rejected outright with no
  opt-in: GitHub refuses to register a self-hosted runner carrying one, so the job would fail
  at provision time;
- **GitHub-hosted** label names (`ubuntu-latest`, `macos-14`, …) require an explicit
  `allowHostedLabels: true` — adopt mode depends on that distinction, and a typo here takes
  over every job in every enabled repo;
- an **empty** list is rejected: it would claim nothing while every status badge stayed green.
  Turning the platform off is per-repo `mode: 'off'`, not a global empty label set;
- commas/whitespace are rejected (they would split one label into two in the SSM value).

Because a label change takes effect on the **very next** `workflow_job` delivery, the flow is
two-phase: `dryRun: true` returns a **label-impact analysis** — which repos/workflows/jobs
stop or start being claimed — and the UI requires a preview before Apply. The impact matcher
mirrors `shouldClaim` exactly (asserted in `test/mgmt-settings.test.mjs`), or the preview would
lie about whose jobs move. It mirrors Ingest's *other* two gates as well, for the same reason:
the scan drops opted-out repos with Ingest's own `isRepoOptedOut` (`enabled === false` **or**
`mode === 'off'`), and `buildLabelImpact` skips jobs whose stored compat result is
`eligible: false` — those never move whatever the labels say. A job with no stored analysis IS
counted, because Ingest fails open there. The scan is bounded to 50 repos and reports
`truncated`; the *enumeration* stops as soon as it holds more repos than it will scan, so a
many-installation environment does not pay one `listRepos` query per installation inside the
console's 29 s API Gateway integration cap.

"Very next delivery" is enforced, not assumed: Ingest reads the label parameter with a 30 s cache
TTL (`RUNNER_LABELS_TTL_MS`) rather than `getParam`'s 5-minute default, which would otherwise
leave a warm container claiming against the previous set for minutes with no signal — an
unclaimed job just runs on GitHub-hosted.

### 3. Webhook health

Evidence from **both directions**, because neither alone is conclusive:

- **Inbound** — Ingest writes a `CONFIG#WEBHOOK / LAST` heartbeat row on every
  signature-verified delivery (event name, timestamp, `X-GitHub-Delivery` guid, count) and a
  separate `lastRejectedAt` / `rejections` counter on every HMAC failure. A rejection **newer
  than** the newest accepted delivery is the exact symptom of a half-finished secret rotation,
  and must not read as silence. One fixed-key `UpdateItem` per delivery, best-effort — a failed
  heartbeat degrades the screen, never a webhook.
- **Outbound** — GitHub's own `GET /app/hook/deliveries` log (status codes, durations,
  redelivery flag) shows deliveries that never arrived: wrong URL after a redeploy, 5xx, TLS.
- **Configuration** — the URL GitHub is configured to POST to (`GET /app/hook/config`) next to
  the URL this deployment actually exposes. A mismatch is the classic post-redeploy failure and
  is flagged as `degraded` even while old deliveries still land.

The folded badge (`healthy` / `degraded` / `unknown`) requires **positive** evidence for green:
an accepted delivery or a 2xx in GitHub's log, with no URL mismatch, no `insecure_ssl`, and no
newer signature rejection. Anything ambiguous is `unknown` — a checkmark has to mean something.

`POST /api/settings/webhook/test` asks GitHub to re-deliver the most recent delivery. That is a
real round trip: GitHub re-signs the payload with the configured secret and posts it to the
configured URL, so success exercises URL + TLS + secret agreement in one shot. The heartbeat
updating on the next poll is the confirmation.

The App-JWT calls behind `status` (`GET /app`, `/app/installations`, `/app/hook/config`,
`/app/hook/deliveries`) are cached for 30 s at **two** levels: in-memory per broker container,
and in a shared `CONFIG#STATUS / LINKAGE` row. The shared row is what actually bounds the cost —
`GET /api/settings` is readable by any authenticated session, and concurrent reads scale the
broker out to containers whose in-memory caches are all cold. That budget — 5,000
JWT-authenticated requests/hour — belongs to the whole App and is the same one Provision spends
minting an installation token per job, so a polling console (or an unprivileged poller) must not
be able to starve run provisioning. Any mutation clears both levels, so a relink or label change
is never read back stale; a DynamoDB fault on the cache path degrades to a live GitHub read.

Rotating the webhook secret has one further consequence on the **inbound** side: `getParam`
caches for 5 minutes, so a warm Ingest container would keep verifying against the previous secret
while GitHub already signs with the new one — and GitHub does not retry a delivery that failed
verification, so those `workflow_job` events would be lost silently. Ingest therefore re-reads
the secret **uncached once** before rejecting a signed-but-unverified delivery, rate-bounded per
container and skipped for an absent/malformed signature (`verifyWithRotation`).

### 4. Diagnostics (collapsed)

SSM parameter **presence** (`DescribeParameters`, metadata only) survives in a collapsed
section for deploy debugging. It is no longer how platform health is expressed.

### Re-linking the GitHub App

`POST /api/settings/github-app/relink` is a **write-only intake**: the operator submits
`appId` + `pem` + `webhookSecret` + `clientId` + `clientSecret`, and the response carries only
*presence + verification outcome*. No endpoint can return a credential value, nothing is
persisted in the browser, and error strings never quote a submitted value.

**Relink is verify → snapshot → write → re-verify → sync-hook → auto-undo.** Credentials are
validated against GitHub *before* any write, so a typo cannot take the environment offline. The
rollback handle is a set of SSM parameter **version numbers** plus the list of parameters the
relink **created**: the previous values stay in SSM's own parameter history and are never copied
into a Lambda, a log, or a DynamoDB row. Three edge cases are handled explicitly because each
would otherwise leave a broken environment that looks fine:
- **A parameter this attempt CREATED has no version to restore**, so undo *deletes* it. Without
  that, a first-link that fails halfway strands a partial credential set and reports rollback
  failure.
- **A first link is rollback-able too.** Its `replacedVersions` is empty (nothing existed to
  replace), so the response also returns `createdParams` and `POST .../rollback` accepts a
  `remove` list. Restoring versions alone would make the operator's rollback a silent no-op.
- **The webhook secret must be pushed to GitHub too** (`PATCH /app/hook/config`). Storing a
  rotated secret in SSM alone means GitHub keeps signing with the old one and Ingest rejects
  every delivery with 401 — the environment goes silent while every credential badge reads
  green. GitHub does not retry a delivery that failed verification, so that work is *lost*, not
  deferred. So a hook-sync failure **fails closed when the secret actually changed**: the relink
  is refused and rolled back, and the response carries `hookSynced: false` so the console can
  offer an explicit `allowHookDesync: true` retry for operators whose App does not own its hook
  config (they set the secret at GitHub by hand first). When the submitted secret is *unchanged*,
  GitHub and Ingest still agree, so the failure is advisory (`hookSynced: false` + a UI warning)
  and the relink stands.

An explicit rollback reads **every** historical value before it writes any of them. A
read-then-write loop that faulted midway would leave a mixed credential set — some parameters
restored, the rest on the replacement values — with nothing left to compensate from.
Intake is **write-only** — the response carries presence + verification outcome, never a value,
and validation errors never quote a submitted credential.

Critically, **the management λ performs none of this itself.** It holds no App PEM read and no
`ssm:PutParameter` grant at all; it invokes a control-plane **App-config broker** λ
(`src/appcfg/`) and can reach nothing else (ADR-029). Secret-read and secret-write authority
stay in the control plane, behind one function whose only caller is the console λ.

### Who may change platform settings

Installation admin rights are **not** sufficient. GitHub answers "may this person administer
this installation", which is right for repo config but wrong here: one environment can host
several installations, and any one admin could otherwise re-point the whole platform's
credentials or stop every other tenant's jobs from being claimed. GitHub has no notion of
"admin of this deployment", so the platform keeps an explicit allow-list —
`/lca/<env>/config/platform-admins`, comma-separated GitHub logins — checked by
`canAdminPlatform`. It **fails closed**: an unset or empty list authorizes nobody, and the API
says so instead of granting authority to the first person who logs in. Settings stays readable
regardless, so a fresh environment can still show its state.

Every mutation stamps an audit row (`CONFIG#AUDIT`, actor + action + operator-facing detail,
surfaced as "Recent platform changes") and emits a structured log line. Audit details never
contain a secret value.

### What a non-admin sees

Settings stays **readable** for any authenticated session — environment identity, App linkage,
effective labels, webhook evidence, flavors and diagnostics are all environment-level facts, and
a fresh environment has to be able to show its own state. Two blocks are not environment-level
and are scoped per session (`scopeSettingsView`):

- **Installations** name other tenants (account login + installation id). Any GitHub user can
  complete the OAuth dance — a zero-grant session is minted deliberately so Setup is reachable —
  so the list is filtered to the session's own grants, exactly like `GET /api/installations`.
- **Recent platform changes** is the operator audit trail (who changed what) and is
  platform-admin only.

Platform admins see both in full: they already hold platform-wide authority, and reviewing a
relink needs the whole picture.

### Concurrency and retries

Platform config **mutations** are serialized by a conditional DynamoDB lock row
(`CONFIG#LOCK`), not by a Lambda concurrency cap — a cap would also serialize the polled read
path. Losing that race is not a rejection: the broker answers `busy`, and the management API maps
it to **503 with `Retry-After`** so the operator is told to retry rather than shown a validation
or upstream failure. Reads (`status`) run unlocked, but a status computation captures the cache's
invalidation **generation** before it starts and publishes conditionally on it: four GitHub
round-trips take long enough for a mutation to land midway, and an unconditional publish would
overwrite that mutation's invalidation with a pre-change snapshot and serve it platform-wide for
the full TTL.

Rollback re-pushes the **restored** webhook secret to GitHub for the same reason a relink pushes
the new one: restoring SSM alone would leave GitHub signing with the relinked App's secret while
Ingest verifies against the restored one, and every delivery would 401. A rollback whose hook
re-sync fails reports `hookSynced: false` with a UI warning.

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
- Secrets are **never** exposed as values. Presence is read via `ssm:DescribeParameters`
  (which cannot return a value) and demoted to a collapsed diagnostics section; the Mgmt λ has
  no IAM permission to read the App PEM or webhook secret at all, and no `ssm:PutParameter`
  grant of any kind (ADR-025, ADR-029). The relink intake accepts credentials write-only and
  answers with presence + verification outcome. A `assertNoSecrets` guard
  (`src/shared/redact.ts`) scans every settings/broker payload for secret-shaped content
  (PEM blocks, `ghp_*`/`v1.<40 hex>` tokens) and throws rather than serving it, so a future
  field addition cannot quietly become a leak.

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
- **API**: API Gateway (HTTP API) + one Lambda (TypeScript, arm64, Node 22), same toolchain
  as the orchestrator.
- **State**: DynamoDB (shared single table) + GSI2 for per-repo run history (ADR-023).
- **Auth**: GitHub OAuth + signed session cookie (ADR-022).

## Non-functional

- **Read latency**: every read is a keyed `GetItem` or an index `Query` — no table scans.
  Dashboard counts use `Select: COUNT` on GSI1 (paged, bounded); run history uses GSI2
  (ADR-023).
- **No secret exposure**: presence via `DescribeParameters`; the λ holds no IAM grant for
  secret paths beyond its own OAuth/session credentials (ADR-025), no `ssm:PutParameter`, and
  every settings payload passes the `assertNoSecrets` shape guard (ADR-029).
- **Least privilege**: read-mostly. `dynamodb:UpdateItem` is the only write (no
  Put/Delete), `sqs:SendMessage` only on the discovery queue, `lambda:InvokeFunction` only on
  the App-config broker's exact ARN, log read-only on one group, and **no** microVM
  launch/terminate or `iam:PassRole`. Asserted against the synthesized template in
  `test/mgmt-stack.test.mjs`, which also pins the broker's `ssm:PutParameter` blast radius to
  the exact credential + label paths (specifically *not* the console session key or the image
  ARNs).
- **Input allow-listing**: config bodies are validated field-by-field; unknown fields are a
  400, so a run's status/microVM id can't be patched through the config endpoint.
- **Auditability**: config writes stamp `updatedBy` (GitHub login) + `updatedAt` on the repo
  row and emit a structured log line with the actor and the patch.
- **Config takes effect in the control plane** (ADR-027): the management λ only writes repo
  config. `enabled=false` / `mode='off'` are enforced by Ingest's claim gate, and
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
  ship without a price. Surfaced as an explicit *estimate*: it uses wall-clock duration,
  which is an upper bound on billed microVM runtime (v1 stores no per-phase timestamps).

## Open questions

- **OQ-4**: custom domain + ACM cert for the console (currently the CloudFront domain) — M5.
- **OQ-5**: per-phase run timestamps (`provisioningAt`/`runningAt`) would make the cost
  estimate exact and enable boot-latency charts. Worth a run-row schema addition in M5?
