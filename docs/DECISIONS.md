# Architecture Decision Records

Lightweight ADRs. Each: context → decision → status → consequences. Reversible unless noted.

---

## ADR-001 — Runners on Lambda microVMs (not CodeBuild / EC2 / ECS)
**Status**: Accepted (v1)
**Context**: Need ephemeral, isolated, fast-booting CI runners in our own AWS account.
**Decision**: Use Lambda microVMs booted from pre-built snapshots.
**Why**: Faster start than CodeBuild, real full VM (unlike shared Lambda), per-second
billing, VPC-attachable, strong isolation. Matches the proven reference design.
**Consequences**: arm64-only; we own patching + security baseline; quota-bound concurrency.

## ADR-002 — GitHub App (not PAT / OAuth App)
**Status**: Accepted
**Context**: Multi-tenant, self-serve onboarding across many repos/orgs.
**Decision**: Register as a GitHub App; per-install short-lived tokens; native webhooks.
**Why**: Install-scoped, fine-grained permissions, org-managed, one webhook endpoint.
**Consequences**: App manifest + credential mgmt; installation-token caching; SecureString for PEM.

## ADR-003 — JIT runner registration (not classic register-token)
**Status**: Accepted
**Context**: Single-use ephemeral runners.
**Decision**: Mint `generate-jitconfig` per job; runner auto-removes after one job.
**Why**: No long-lived token on the box; runner can't self-relabel; single-use = leak-safe.
**Consequences**: Provision λ mints per job; labels/group fixed at mint time.

## ADR-004 — Read existing workflows; don't host them
**Status**: Accepted
**Context**: Want drop-in replacement without becoming the workflow source of truth.
**Decision**: Parse `.github/workflows/**`, map `runs-on` → flavor, route eligible jobs.
GitHub remains the definition + scheduler; we only supply compute.
**Why**: Zero-migration path; users keep GitHub Actions semantics.
**Consequences**: Ingestion + compat analysis complexity; some jobs unclaimable (`block`).

## ADR-005 — Two onboarding modes: `label` (default) and `adopt`
**Status**: Accepted
**Context**: Trade safety vs zero-edit convenience.
**Decision**: `label` mode (opt-in per workflow via LCA label) default; `adopt` mode maps
standard labels for true no-edit drop-in once compat is green.
**Why**: Safe by default, powerful when trusted.
**Consequences**: Routing must handle both; UI nudges label→adopt.

## ADR-006 — Single-use runners, no warm pool (v1)
**Status**: Accepted (revisit)
**Context**: Boot latency vs isolation + idle cost.
**Decision**: One microVM per job, self-terminating; no pool.
**Why**: Cleanest isolation, zero idle cost; snapshots keep boot fast.
**Consequences**: Every job pays boot. **Revisit** if cold-start proves painful (Phase 3 warm pool).

## ADR-007 — arm64-only, surface compat instead of emulating
**Status**: Accepted
**Context**: microVMs are Graviton-only.
**Decision**: Support arm64 natively; **flag** x86 assumptions at ingestion (`risk`/`block`)
rather than auto-emulating.
**Why**: Emulation is slow + surprising; explicit compat is honest.
**Consequences**: Some workflows need arm64 image variants; clear UI guidance required.

## ADR-008 — Secrets in SSM SecureString, created out-of-band
**Status**: Accepted
**Context**: CloudFormation can't create SecureStrings.
**Decision**: Bootstrap script creates SecureStrings; CDK only references them; Lambdas get
path-scoped `ssm:GetParameter`.
**Why**: Matches reference; cheap; keeps secrets out of code/CFN.
**Consequences**: Extra setup step; no built-in rotation (see 05 OQ-2 re Secrets Manager).

## ADR-009 — Shared DynamoDB across planes; UI is read-mostly
**Status**: Accepted
**Context**: Control/compute write run+config state; management reads it.
**Decision**: One shared table (single-table design + GSIs); Mgmt API writes config only.
**Why**: One source of truth; simplest consistency; least-privilege writes.
**Consequences**: Careful key design; GSIs for status/time queries.

## ADR-010 — TypeScript + CDK v2 everywhere
**Status**: Accepted
**Context**: Reference is TS/CDK; team familiarity.
**Decision**: CDK v2 (TS) infra; TS Lambdas; React+TS SPA. One toolchain.
**Why**: Single language, shared tooling/tests, matches reference to ease porting.
**Consequences**: arm64 Lambda runtime; Node build pipeline.

## ADR-011 — Phased deploy (infra → images → orchestrator)
**Status**: Accepted
**Context**: Orchestrator needs image ARNs that don't exist until images are built.
**Decision**: Three-step deploy; image ARNs published to SSM by the build script.
**Why**: Breaks the chicken-and-egg; matches reference.
**Consequences**: Deploy is not a single `cdk deploy`; documented in [05](specs/05-infrastructure.md).

## ADR-012 — microVM boot via `run-microvm` + `/run` lifecycle hook (not user-data + `run.sh`)
**Status**: Accepted (v1) · supersedes the bootstrap sketch in early [spec 02](specs/02-microvm-runners.md)
**Context**: Specs 01/02 were drafted before the AWS Lambda microVM API surface was
confirmed. They assumed a self-hosted-runner-style boot: JIT config injected as
`env`/user-data, image runs `./run.sh --jitconfig …` then `shutdown -h now`. The real
Lambda microVM API works differently:
- **Launch**: `run-microvm --image-identifier <ARN>` (only the image ARN is required).
  Optional `--run-hook-payload` carries **≤16 KB** of per-launch data.
- **Snapshot build**: `create-microvm-image` from a Dockerfile → a `CREATED` image ARN.
- **Lifecycle hooks**: the image implements an HTTP server (default **:8080**) exposing
  `/run` (fires after snapshot boot; traffic gated until it returns 200), `/terminate`
  (pre-teardown), and `/suspend` `/resume` (idle — unused for single-use runners).
- **Teardown**: `terminate-microvm` (we call it after the job; Reaper backstops orphans).
- **Endpoint auth**: each microVM has a dedicated HTTPS endpoint; requests need a JWE from
  `create-microvm-auth-token`, port-scoped + expiring.
- **Capacity**: account-level quota = total memory across `RUNNING`/`SUSPENDED` microVMs
  per region (vertically bumpable ~4x via Service Quotas).
**Decision**: Provision λ passes the JIT config + job metadata as the **`run-hook-payload`
JSON** (well under 16 KB). The baked-in image runs a small **run-hook HTTP server**: on
`POST /run` it parses the payload, writes the JIT config, launches the runner agent
(`./run.sh --jitconfig …`) for exactly one job, then returns 200; on job exit it calls
`terminate-microvm` (self-terminate), with the Reaper as a backstop. No JIT token is ever
placed in user-data/env that survives, and nothing long-lived lands on disk.
**Why**: Matches the actual API contract; keeps the single-use + leak-safe properties of
ADR-003/006; 16 KB is ample for a JIT config + labels + repo ref.
**Consequences**: The image must ship a run-hook server (not just a bootstrap shell
script). Provision λ needs `create-microvm-auth-token` only if it health-checks the
endpoint (v1 skips this — fire-and-forget launch, rely on `workflow_job` status +
Reaper). Payload cap (16 KB) bounds what we can inject at launch — larger config must be
fetched by the runner post-boot.

## ADR-013 — Forward-only run state machine, guarded by conditional writes (M2)
**Status**: Accepted (v1)
**Context**: Multiple independent producers write a run's status: Ingest (`queued`, plus
`running`/terminal from `workflow_job` status webhooks), Provision (`provisioning` →
`running`/`failed`), and the Reaper (`timed_out`/`failed`). GitHub redelivers webhooks and
SQS is at-least-once, so events arrive duplicated and out of order (a late `running`
webhook can land after `completed`).
**Decision**: Model status as a strictly ordered rank
(`queued`<`provisioning`<`running`<terminal) and make every transition a DynamoDB
conditional update that applies only from a status from which the target is reachable.
Same-status rewrites are idempotent no-ops; backward moves and terminal→anything are
rejected at the database, not in application logic. The transition helper returns a
boolean (applied vs guarded-out) so callers (esp. Provision) can skip duplicate work.
**Why**: The database is the single serialization point across all producers — pushing the
invariant into the conditional write means no producer can create a ghost or regress a run
regardless of delivery order or concurrency, without distributed locking.
**Consequences**: Provision's idempotency guard is the `queued→provisioning` transition
(a duplicate SQS delivery whose run already advanced is skipped, so no double-launch). A
genuinely lost transition (DB fault) is backstopped by the Reaper, not retried inline.

## ADR-014 — GSI1 status/time index for run reconciliation (M2)
**Status**: Accepted (v1)
**Context**: The Reaper (and later the UI) must enumerate runs in a non-terminal status
(`queued`/`provisioning`/`running`) every few minutes to reconcile ghosts. A table scan
grows with retained history.
**Decision**: A single GSI (`gsi1`), sparse over run rows: `gsi1pk=RUNSTATUS#<status>`,
`gsi1sk=<updatedAt ISO>`. Terminal rows carry a DynamoDB TTL (90d) so history ages out.
The GSI keys are re-stamped on every transition so a row always sits in exactly one status
partition.
**Why**: Reaping cost scales with *active* runs, not total history; the time sort key lets
the UI page recent runs per status. Single sparse GSI keeps write amplification low and
fits the ADR-009 single-table model.
**Consequences**: Every transition writes both `status` and the two GSI keys. `queued`
runs also appear in the index; the Reaper treats long-`queued` rows as a quota-wall signal
(spec 05 stuck-queue).

## ADR-015 — Correct to the GA `lambda-microvms` API; drop tag-based VM isolation (M3)
**Status**: Accepted (v1) · corrects [ADR-012](#adr-012); supersedes the tag-scoped-IAM
assumption in ADR-006 / early spec 05
**Context**: ADR-012 and the M1/M2 implementation were written against a *guessed* microVM
API surface — `aws lambda create-microvm-image --architecture --code S3Bucket=…`,
`RunMicroVMCommand` with a `Tags` map, tag-filtered `ListMicroVMs`, and IAM gated by
`aws:RequestTag`/`aws:ResourceTag`. Verified against the **GA API** (AWS Lambda MicroVMs,
announced 2026-06-22; service model `lambda-microvms` API version **2025-09-09**, in AWS
CLI ≥ 2.35.17 / boto3 ≥ 1.43.44), the real surface differs:
- It is a **distinct service** — `aws lambda-microvms …` / `@aws-sdk/client-lambda-microvms`
  — not `aws lambda`. IAM actions still use the `lambda:` prefix (the service signs as
  `lambda`) but with GA operation casing: `RunMicrovm`, `CreateMicrovmImage`,
  `ListMicrovms`, `TerminateMicrovm`, `GetMicrovm` (note `Microvm`, not `MicroVM`).
- **`CreateMicrovmImage`** requires `--base-image-arn` (a managed base, e.g.
  `arn:aws:lambda:<region>:aws:microvm-image:al2023-1`), `--build-role-arn`, and
  `--code-artifact uri=s3://…`. It is versioned: returns `{imageArn, imageVersion,
  state:CREATING}`; poll `GetMicrovmImage` until `state=CREATED`.
- **`RunMicrovm`** takes `imageIdentifier` (+ optional `executionRoleArn`, `idlePolicy`,
  `runHookPayload`, `maximumDurationInSeconds`). It has **no `tags`** — you cannot tag a VM
  at launch. `ListMicrovms` items carry only `microvmId/state/imageArn/imageVersion/
  startedAt` (no tags, no runId), and microVMs are not a taggable resource.
**Decision**:
1. Call the `lambda-microvms` namespace with the real parameter shapes (build script +
   `src/shared/microvm.ts` wrapper via `@aws-sdk/client-lambda-microvms`).
2. **The run↔VM mapping is the run store, not a VM tag.** Provision stamps
   `RunRecord.microvmId` when the VM reaches `running`; the Reaper lists live VMs (id +
   `startedAt` only) and reconciles against that persisted id — a `running` run whose
   `microvmId` is no longer live (or was never recorded) past the orphan grace → `timed_out`.
3. **IAM isolation cannot use `aws:RequestTag`/`aws:ResourceTag` on the VM** (no tags).
   Provision/Reaper microVM actions are scoped to the account/region (`aws:RequestedRegion`);
   runtime isolation comes from the dedicated per-env **execution role** stamped on each VM
   and the run store as the authoritative mapping.
**Why**: The tag-based design is physically impossible on the GA API. The run store already
had to hold `microvmId` for status/UX, so it is the natural source of truth; region-scoped
IAM + per-env execution role is the available least-privilege posture until/unless the API
adds VM tagging or resource-level ARNs.
**Consequences**: `TAG_PREFIX` is no longer consumed by Provision/Reaper (the
`ControlStack` `tagPrefix` prop is retained only for future taggable resources, e.g. image
tags via `TagResource`). Reaper terminates over-cap VMs by `startedAt`. IAM is coarser than
the original tag-gated intent — revisit if the API gains VM-level resource ARNs or tagging.
Toolchain floor (CLI ≥ 2.35.17, boto3/botocore ≥ 1.43.44) is documented in spec 05
§ Toolchain prerequisites and AGENTS.md.

## ADR-016 — JIT config by reference; empirically-verified microVM hook contract (M3)
**Status**: Accepted (v1) · amends [ADR-012](#adr-012) (payload + hook details)
**Context**: First live runs against the GA `lambda-microvms` API surfaced three contract
details that no documentation states (all verified from real launches + build logs):
1. **`runHookPayload` hard cap is 4096 bytes** (service model constraint) — NOT the 16 KB
   ADR-012 assumed. A GitHub `encoded_jit_config` alone is ~4.1 KB, so it can NEVER be
   passed inline.
2. **Enabling any lifecycle hook requires the `ready` image hook** — `create/update-microvm-image`
   rejects `microvmHooks.run=ENABLED` unless `microvmImageHooks.ready=ENABLED`. The build
   boots the image and POSTs the ready hook; the snapshot is taken only after it returns 200
   (a 4xx/timeout fails the build with "Ready hook check failed").
3. **Hooks are delivered under a runtime path prefix**: the platform requests
   `POST /aws/lambda-microvms/runtime/v1/<hook>` (`/ready`, `/run`, `/terminate`) on the
   declared hooks port — NOT the bare `/<hook>` paths. Observed from live build logs; the
   in-image server must strip the prefix (ours logs every request for diagnosability).
Also: `RunMicrovm` requires `lambda:PassNetworkConnector` on the aws-managed connectors
(`INTERNET_EGRESS`, `HTTP_INGRESS`) and `iam:PassRole` for the execution role.
**Decision**:
- Provision stashes `{jitConfig, runId, jobId, repoFullName, labels}` in the shared table
  (item `pk=RUN#…, sk=JITCONFIG`, TTL 30 min) and passes only a small pointer (~200 B) as
  the run-hook payload. **Amended by [ADR-021](#adr-021)**: the pointer is now
  `{ref, region, broker, token}` and the `/run` hook resolves the ref by invoking the hook
  broker λ, not by calling DynamoDB itself — the **microVM execution role**
  (`lca-<env>-microvm-exec`, stamped on every launch via `--execution-role-arn`, which
  Provision holds `iam:PassRole` for) no longer has any table access.
- Images declare `hooks = { port: 8080, microvmImageHooks: { ready: ENABLED },
  microvmHooks: { run: ENABLED } }` and ship a hook server that answers both the prefixed
  runtime paths and bare paths, logging every request. Build logging (`--logging
  cloudWatch`) is always on: `/aws/lambda/microvms/<image-name>`.
**Why**: The 4 KB cap makes by-reference the only option; the run store already holds the
run↔VM mapping (ADR-015), so it is the natural side-store, and the TTL bounds JIT-config
exposure. The exec role gives the VM a scoped identity (narrowed to broker-invoke-only by
ADR-021).
**Consequences**: The microVM image and the control plane now share a contract (the ref
format, and — per ADR-021 — the broker name + capability token) delivered via the payload.
Rotating the hook-path prefix is AWS's
call — the server tolerates both shapes. Terminal-state JIT items age out via TTL; a
failed launch leaves an orphaned JITCONFIG item that TTLs away harmlessly.

## ADR-017 — Workflow discovery wiring: async scans, rendered-name matching, fail-open gates (M3-S4)

**Status**: accepted
**Context**: M3-S1..S3 shipped `parseWorkflow` + `analyzeCompat` as pure, unconsumed
modules. Wiring them in needs three decisions: (a) where discovery (GitHub fetch → parse →
persist) runs, (b) how a `workflow_job` webhook is correlated back to a stored analysis —
the webhook carries only the *rendered* job name + workflow name, never the file path or
job id — and (c) what happens when that correlation fails.
**Decision**:
- **Discovery is its own λ behind a standard SQS queue** (`lca-<env>-discovery`), fed by
  Ingest on `push` events touching `.github/workflows/**` and on
  `installation.created` / `installation_repositories.added`. Scans are idempotent
  upserts (one `WorkflowAnalysisRecord` per file: `pk=REPO#<repoId>, sk=WF#<path>`), so a
  standard queue + redelivery is safe; FIFO buys nothing. Parse failures are persisted as
  `parseError` rows (UI-surfaceable), never retried as infra failures.
- **Analyses store parse output + compat + routing preview** computed with the repo's
  FlavorMap override, so what the UI shows matches what Provision resolves.
- **Webhook → analysis correlation is by rendered name** (`workflow_job.workflow_name` →
  parsed `name`, `workflow_job.name` → job `name:` or id, matrix renders matched by
  `"name ("` prefix). The parser now extracts each job's `name:` for this.
- **Both consumers fail OPEN**: Ingest's claim-time compat gate only skips a claim on an
  unambiguous `block` match; Provision's signal threading degrades to label-only routing
  when no analysis matches. An ambiguous match (same rendered name in two workflows, no
  `workflow_name`) is treated as no match.
**Why**: Fetching N files inline in the webhook handler would blow its 10 s budget and
GitHub's delivery timeout; async scans keep Ingest hot-path fast. Rendered-name matching
is the only correlation GitHub gives us without an extra API call per job. Failing open
preserves the M1..M2 invariant that a labeled job always gets a runner — a stale or
missing analysis must never strand a job (the label IS the operator's explicit intent);
compat `block` is advisory routing, not a security boundary.
**Consequences**: A renamed job/workflow can miss its analysis until the next push re-scan
(acceptable: fail-open). Jobs with expression-bearing custom names (`name: ${{ … }}`)
never match — they route label-only. The claim gate adds one DDB Query per claimed
webhook (single-digit ms, small partitions). Manual "re-scan" (spec 03) needs only an SQS
send to the discovery queue — the M4 UI can reuse the same message shape.

## ADR-018 — Deploy-target pin: `.env.local` required for all deploy-touching commands

**Status**: accepted
**Context**: `bin/lca.ts` resolved the deploy account from ambient credentials
(`CDK_DEFAULT_ACCOUNT`) and the deploy scripts from whatever `AWS_PROFILE`/default chain
the shell happened to carry. Nothing pinned the intended target, so a shell pointed at
the wrong account would silently deploy stacks, build images, or write GitHub App
SecureStrings into it. With multiple Isengard accounts on the same workstation this is a
live footgun, and it also left "which account is dev?" undiscoverable from the repo.
**Decision**: A gitignored **`.env.local`** at the repo root (template:
`.env.local.example`) pins `LCA_DEPLOY_ACCOUNT` (12-digit) + `LCA_DEPLOY_REGION`, with
optional `AWS_PROFILE`. A shared guard (`lib/deploy-env.ts`, zero npm deps) is enforced
by every deploy-touching entry point:
- **CDK app** (`bin/lca.ts`): if credentials are present (`CDK_DEFAULT_ACCOUNT` set) or
  a pin exists, the pin is mandatory and must match the ambient account; stacks
  get `env = { account: pin, region: pin }`. Credential-less synth (the CI gate, fresh
  worktrees) proceeds unpinned — it cannot deploy anything.
- **`scripts/build-images.mjs` / `scripts/create-github-app.mjs`**: refuse to start
  without a valid pin AND an STS caller-identity match; `--dry-run` is exempt (no AWS
  calls). Any explicit `--region`/`-c region` must equal the pinned region.
- **`scripts/backfill-installs.mjs`** (ADR-037): same pin + STS match, but with **no dry-run
  exemption** — its dry run still reads the live table, so an unpinned one would report
  another account's rows as the target's. The exemption above is for commands whose dry run
  makes no AWS call at all; it is not a blanket rule.
**Why**: comparing the pin against the *actual* resolved identity (not just exporting a
profile) catches every mis-targeting mode: wrong profile, stale credentials, env-var
overrides. Keeping the guard dependency-free preserves the scripts' zero-npm-dep
convention, and one TS module shared via `dist/` avoids two divergent implementations.
**Consequences**: first deploy on a fresh clone requires `cp .env.local.example
.env.local` + editing two values (deliberate one-time friction). Dev/prod account
separation (M5) becomes trivial: each checkout/env pins its own account.

**Amended by [ADR-047](#adr-047--cd-runs-on-our-own-microvm-runners-under-a-github-oidc-deploy-role-m4)
(M4 CD)**: the pin may also come from the **process environment** — `LCA_DEPLOY_ACCOUNT` /
`LCA_DEPLOY_REGION` / `LCA_DEPLOY_ENV` — when no `.env.local` exists. A CI checkout is a fresh
clone, so it cannot carry a gitignored file, and committing one would publish the deploy target
and defeat the point. `.env.local` **wins** when both are present, so an ambient exported
variable cannot silently retarget a workstation deploy.

The identity check is **unchanged and applies identically to both sources**: the pin is still
compared against the real STS caller account and still refuses on mismatch. There is no
"trusted CI" branch and no variable that switches the guard off — a pin was never the safety
property, the identity match is. A pin declares intent; a partial or malformed one (from either
source) fails loudly rather than degrading to "unpinned".

**M5 review fix — the pin also binds the ENVIRONMENT, not just the account.** The paragraph
above was optimistic: `-c env=prod` / `--env prod` selected resource names, retention,
concurrency and alarm thresholds, while the account came from an independent pin, and *nothing
tied the two together*. A pin for the dev account plus `env=prod` therefore deployed
`lca-prod-*` resources into the **dev** account, published prod-namespaced image ARNs to
`/lca/prod/image-arn/*` there, and let `app:create --env prod` write GitHub App SecureStrings to
`/lca/prod/github/*` in the wrong account — the reciprocal was equally possible. Since dev and
prod are separate **accounts** by design (spec 05), the pin is the only authority on which
environment a checkout may build. `.env.local` now also carries **`LCA_DEPLOY_ENV`** (`dev` |
`prod`), and `validateTarget` refuses a command whose selected env contradicts it — before any
STS call, in the CDK app and in both scripts. The key is **optional** so existing
single-account checkouts keep working: with no `LCA_DEPLOY_ENV` there is no env claim to
contradict, and only the account+region pin applies. Pinned by `test/deploy-env.test.mjs`,
which also asserts each entrypoint actually passes its selector through.

## ADR-019 — Self-terminate via run-row readback (no in-guest microVM id source) (M3)
**Status**: Accepted (v1) · amends [ADR-016](#adr-016) (teardown path)
**Context**: The `/run` hook is supposed to call `terminate-microvm` on ITSELF at job end
so the VM dies instantly. That requires the VM's own `microvmId` — and live runs show the
guest has **no way to discover it**: `/run/microvm/id`, `/etc/microvm-id`, and
`/proc/device-tree/microvm-id` don't exist, and the environment carries only
`AWS_LAMBDA_MICROVM_IMAGE_{ARN,VERSION,NAME}` (image identity, not VM identity). Result:
every job fell through to "no microvm id available; relying on Reaper" and idled until
the 5-minute Reaper sweep — ~5 min of dead billing per job (≈ \$0.022 at 2 vCPU/4 GB) and
slower quota release. Passing the id INTO the launch payload is a chicken/egg: the id
doesn't exist until `RunMicrovm` returns, after the payload is fixed.
**Decision**: **Run-row readback.** Provision already persists the run↔VM mapping
(ADR-015); make that write the id channel:
1. Provision stamps `RunRecord.microvmId` via a dedicated `stampMicrovmId` write that is
   **unconditional** (only `attribute_exists(pk)`) and happens BEFORE the
   `running` transition — the forward-only status guard must never drop the mapping when
   an ultra-fast job's `completed` webhook wins the race.
2. At job end the hook derives the run-row key from the JIT config ref it already holds
   (`RUN#…#JITCONFIG` → pk `RUN#…`, sk `RUN`), reads `microvmId` back with the baked-in
   AWS CLI (short retry for the write race), and calls `terminate-microvm` on itself.
3. The microVM exec role gains `lambda:TerminateMicrovm` scoped to the region (the GA API
   has no VM-level resource ARNs/tags to scope tighter — ADR-015); the Reaper stays as
   the backstop for crashed hooks / lost writes.
**Why**: The readback needs no new infrastructure (table + exec-role read grant already
exist), no API the platform doesn't offer, and no payload change. Alternatives rejected:
writing the id to the JITCONFIG item (second write path for the same fact — the run row
IS the mapping per ADR-015); shortening the Reaper sweep (still pays idle minutes, just
fewer); per-VM endpoint hostname parsing (endpoint shape is undocumented/unstable and the
hook never sees its own endpoint).
**Consequences**: **Accepted cross-tenant risk — SUPERSEDED by [ADR-021](#adr-021), which
removed both grants from the VM.** As originally shipped the grant was region-scoped, not
VM-scoped, so *anything* executing inside a microVM could terminate *any* microVM in the
account/region. The role lives inside VMs that run **untrusted workflow code** — a
malicious or compromised PR in any onboarded repo could enumerate nothing (no `List*`
granted) but could kill another tenant's in-flight job given its id, i.e. a cross-tenant
denial-of-service primitive. Accepted at the time because (a) the GA `lambda-microvms` API
exposes no VM-level resource ARNs or tags to scope against (ADR-015), (b) the blast
radius is bounded to job availability — no data access, since each VM is its own VM with
its own single-use JIT credentials — and (c) the alternative (Reaper-only) costs ~5 min
of idle billing on every job. **Amplifier (also closed by ADR-021)**: the exec role's
run-table grant was `grantReadData` (table-wide `GetItem`/`Query`/`Scan`, pre-dating this
ADR), so a VM could read other runs' rows and harvest their `microvmId` — target ids were
discoverable from inside a VM.

**Amendment (ADR-021, M3)**: step 2 and step 3 above no longer describe the shipped system.
The VM does **not** read the run row and does **not** hold `lambda:TerminateMicrovm`; it
invokes the hook broker λ with a per-run capability token and the broker performs the
readback + terminate inside the control plane. The readback *mechanism* of this ADR is
unchanged and still authoritative (Provision's unconditional `stampMicrovmId` remains the
id channel, and that same write now also carries the run's capability-token hash, so the
brokered terminate is authorized off the row with no TTL rather than the 30-min JIT item) —
only the principal that executes it moved. Both revisit triggers are
therefore discharged for the exec role: DynamoDB read is gone entirely, and
`TerminateMicrovm` is region-scoped on a control-plane role whose target id is chosen by
our code, not by workflow code. **Still open**: re-scope the broker's `TerminateMicrovm` to
VM-level ARNs the moment the GA API exposes them. If the readback misses (row gone, DDB
outage), behavior degrades exactly to the old Reaper-only path. `test/run-hook.test.mjs`
pins the ref→run-row key derivation against the run store so the two sides can't drift.

## ADR-020 — Docker flavor needs `additionalOsCapabilities=ALL` + a root entrypoint (M3)

**Status**: accepted
**Context**: M3 verification against the deployed dev stack routed `lambda-ci-docker` jobs
to the `docker` flavor correctly, but every one of them failed at `docker version` with
`dial unix /var/run/docker.sock: connect: no such file or directory`. Three separate
in-guest constraints were established by probe jobs on real microVMs:
1. **Nothing starts dockerd.** The snapshot has no init; spec 02 assumed the run-hook would
   start the daemon, but no pre-run hook was ever shipped.
2. **`sudo` can never escalate.** The guest boots with `NoNewPrivs: 1`, so sudo fails with
   *"The \"no new privileges\" flag is set"* — a non-root entrypoint can never reach root.
3. **A default microVM cannot host a rootful daemon.** `CapEff/CapPrm/CapInh` are all
   empty, `/sys` is mounted read-only and `/sys/fs/cgroup` is an empty read-only dir.
   `mount -t cgroup2` fails with EPERM even inside `unshare -Urmn` (a user namespace grants
   `CapEff=…ffffffffff` but mounting sysfs/cgroup2 is still denied), so dockerd dies with
   `failed to start daemon: Devices cgroup isn't mounted`. Rootless docker is not an escape
   hatch either — the same cgroup/mount denial applies, and `dockerd-rootless.sh` isn't
   shipped by the Docker apt packages we install.
**Decision**: the `docker` flavor is built with the GA API's
**`--additional-os-capabilities ALL`** (the only supported value) and keeps a **root
entrypoint**; `run-hook.mjs` uses `setpriv --reuid/--regid/--init-groups` to drop to the
`runner` user for the agent (the agent refuses to run as root, and a *downward* privilege
change is permitted under `no_new_privs`). `microvm/bootstrap/pre-run.docker.sh` — baked in
as `${RUNNER_DIR}/pre-run.sh` and executed by the run-hook before the agent — mounts
cgroup2 if absent, starts `dockerd`, and polls the API with a bounded 120s wait so a broken
daemon surfaces its own log in the job output rather than stalling the whole microVM
lifetime (the run-hook logs the nonzero hook exit and still starts the agent, so the job
fails at its first `docker` step with GitHub reporting it — dropping the agent instead would
leave the GitHub job hanging until its own timeout). Cold daemon init measured 32–39 s, so
the bound has to leave real headroom. The capability grant is declared per flavor in
`microvm/flavors.json` (`osCapabilities`), so `base`/`node` remain unprivileged and keep
their `USER runner` entrypoints.
**Why**: the alternatives were worse. Rootless docker is blocked by the same kernel
constraints; running the agent itself as root is rejected by the agent; and granting the
capability fleet-wide would hand every job (including plain `lambda-ci` ones) a privileged
guest for no benefit. Scoping the grant to the one flavor whose *stated purpose* is
`docker build/run` keeps the blast radius equal to the capability the user opted into by
choosing that label.
**Consequences**: `lambda-ci-docker` runs in a more privileged microVM than the other
flavors — acceptable because each microVM is single-use, single-tenant and self-terminating
(ADR-003/006), but it must be documented in the flavor catalog UI (M4) so operators can see
what a label grants. Adding a future flavor that needs host-level privileges is now a
one-line catalog change. `test/image-content.test.mjs` pins the whole contract (hook wiring,
root entrypoint scoped to docker-capable flavors, no `sudo`, bounded readiness wait, arm64).

## ADR-021 — microVMs hold no ambient AWS authority: brokered run-hook operations (M3)
**Status**: Accepted (v1) · supersedes the IAM half of [ADR-019](#adr-019) · amends
[ADR-016](#adr-016) (payload-by-reference access path) · boot budget amended by
[ADR-028](#adr-028)
**Context**: The microVM execution role (`lca-<env>-microvm-exec`) is stamped on VMs that
execute **untrusted workflow code**, and carried two grants that couldn't be scoped where
they were:
1. `dynamodb:GetItem`/`Query`/`Scan` table-wide, via `table.grantReadData(microvmExecRole)`
   — needed so the hook could resolve its JIT config by reference (ADR-016) and read its
   own `microvmId` (ADR-019). A VM could read **any** run's row.
2. `lambda:TerminateMicrovm` on `Resource: "*"`, region-conditioned only (ADR-019). Any VM
   could terminate any VM in the account/region.
Together they compose into a cross-tenant DoS with **discoverable targets**: read other
rows → harvest `microvmId` → terminate that job.
Neither is fixable in IAM alone. DynamoDB's `dynamodb:LeadingKeys` matches literal
partition-key values, and one role is shared by every VM in the env, so there is no
condition that says "only *your* `RUN#…` partition". The GA `lambda-microvms` API exposes
no VM-level ARNs or tags (ADR-015), so `TerminateMicrovm` cannot be resource-scoped at all.
**Decision**: **Remove the authority from the VM instead of trying to scope it.** A new
control-plane **hook broker λ** (`lca-<env>-hook-broker`, `src/hook/`) performs both
operations on the VM's behalf:
1. Provision mints a 32-byte per-run **capability token** at launch, stores only its
   SHA-256 on the JIT config item (`hookTokenHash`) **and mirrors the same hash onto the
   durable run row** when it stamps `microvmId`, then passes the plaintext to the VM in
   the run-hook payload — which already had to carry the ref and stays well under the 4 KB
   cap (ADR-016). The payload's `table` field is replaced by `broker` + `token`.
2. The in-VM hook invokes the broker with `{action, ref, token}`. `action=jitconfig`
   returns that run's stashed config; `action=terminate` reads that run's `microvmId` and
   terminates it. The item key is derived **from the token-bound ref**, never from
   free-form caller input, and a bad token / unknown ref get the identical `unauthorized`
   response so a VM can't probe which refs exist. The two actions authorize against
   **different items on purpose**: `jitconfig` off the JIT config item (claimed seconds
   after boot, 30-min TTL), `terminate` off the run row (no TTL until the run is terminal),
   because self-terminate fires at job **end** — up to the Reaper's 2 h lifetime cap. Pinning
   terminate to the TTL'd item would silently lose self-terminate for every job over 30 min
   and regress ADR-019 back to Reaper-only reaping. The opposite race — a job finishing
   *before* Provision's post-launch stamp writes `microvmId` + the hash — falls back to the
   still-live JIT item to authorize, and answers `{ok:true, terminated:false}` so the hook's
   bounded retry can reach the stamped row; an invalid capability still gets the identical
   terminal `unauthorized`.
3. The exec role is cut to exactly two things: its own log group (ADR-016) and
   `lambda:InvokeFunction` on the single broker function ARN. No DynamoDB. No
   `TerminateMicrovm`. The broker's own table access is `dynamodb:GetItem` on the table ARN
   only — deliberately **not** `grantReadData`, which would add Query/Scan/BatchGetItem plus
   `/index/*`: the broker is the one role untrusted code can reach (indirectly), so it must
   not itself hold the table-wide enumeration this ADR exists to remove. It reads two items
   by primary key and never queries an index.
**Why**: This converts an unscopable ambient permission into a **capability**: the authority
a VM holds is now a function of a secret it was individually issued, which is exactly the
per-VM scoping IAM couldn't express. It also removes `microvmId` from the compute plane
altogether — a VM never learns any VM id, including its own, so there is no target to
harvest even if a workflow escapes the runner user. Alternatives rejected:
`dynamodb:LeadingKeys` (can't express a per-VM value from a shared role); a per-run IAM
role (a role create/delete per job — quota-bound, slow on the hot path, and
`iam:CreateRole` in the control plane is worse than the problem); pre-signed API Gateway
URL (equivalent trust model, but adds a public-internet edge for an operation that has no
reason to be reachable off-account); leaving read table-wide and only fixing terminate
(leaves the harvesting primitive intact for the next privileged operation added).
**Consequences**: One extra Lambda invoke on the boot path (~50 ms) — and it is *on* the
critical path, because `/run` cannot ACK until the JIT config is resolved and Lambda gates
traffic to the VM until that ACK. That makes the guest-side call bounded on purpose, and the
boot call bounded *twice*: the image declares `microvmHooks.run` with a
`runTimeoutInSeconds`, so the whole boot retry budget (invokes + backoff) has to fit
inside that deadline — a bigger budget cannot help, because the platform abandons `/run`
while the hook is still sleeping between attempts and the VM strands for the Reaper with the
job unstarted. Boot therefore uses a per-invoke bound × a small attempt count with exponential
backoff (originally 6 s × 3 + 2 s/4 s = 24 s — **resized in [ADR-028](#adr-028)** to 15 s × 2 +
2 s after live measurement showed the cost is the cold `aws` CLI, not the broker, and that the
hook deadline is itself capped at 60 s by the API); terminate keeps a 15 s per-invoke bound and
a larger attempt budget (no
platform deadline behind it). The bound exists at all because the AWS CLI otherwise blocks
`spawnSync` forever if the guest's network is broken, which would strand the VM with no ACK
and no retry; the backoff is exponential across attempts, since the reserved-concurrency cap
below can legitimately throttle a launch burst and flat retries would all land in the same
throttle window. And it is one more function to deploy. The
broker is capped at 20 reserved concurrent executions: its only callers are untrusted VMs
(one call at boot, one at job end), so a pathological VM fleet must not be able to drain the
account's unreserved concurrency pool out from under the control plane. The broker is now
the single audited chokepoint for microVM→control-plane calls, so future
run-hook needs (status reporting, artifact hand-off) extend it rather than re-widening the
exec role. The token hash now lives on two items (JIT config + run row) — one write each,
both already happening — because their lifetimes differ; the run row is authoritative for
terminate. The token is a bearer secret inside the VM: it authorizes only that run's own
config + self-terminate, and the hook redacts it from logs — but workflow code CAN read it
from the payload, so it must never be reused for anything broader than "my own run". The
broker is reached with `aws lambda invoke`, which can only write its response to a file, so
the hook writes it into a fresh owner-only `mkdtemp` dir and deletes the dir in the same
call — the `jitconfig` response carries the run's single-use registration credential and
must not sit in world-readable `/tmp` once workflow code is running. The request goes to the
CLI the same way (`--payload fileb://…` in that dir, mode 0600) rather than as an argv value:
`/proc/<pid>/cmdline` is world-readable in the guest and the terminate invoke fires *after*
workflow code has run, so an argv-borne token would be readable by a leftover process. The
**control plane** holds the same plaintext (it builds the launch payload), so its error paths
are the symmetrical egress route: an SDK validation/serialization failure echoes the offending
request value back ("Value '…' at 'runHookPayload' failed to satisfy constraint"), and
Provision writes launch failures into the run row's `reason` — durable for 90 days and
surfaced by the management API/UI, which must never carry secret values (AGENTS.md). The launch
error is therefore scrubbed (`src/shared/redact.ts`) before it is persisted *and* before it is
rethrown for the batch handler's log line. Two
failure-path properties follow from where the guest hook calls the broker from and what the
broker returns: (a) `selfTerminate` runs in the runner agent's `exit`/`error` handler, i.e.
outside any request scope, so the broker call and its scratch-dir setup are wrapped — a throw
there would be an uncaught exception that kills the hook process, losing the `/terminate`
final log flush on top of the missed terminate, and every failure must degrade to
Reaper-backstop instead; (b) a malformed broker response is parsed through a wrapper that
raises a content-free error, because the `jitconfig` body carries the run's single-use
registration credential and `JSON.parse`'s own message quotes a slice of its input — logging
that raw would put credential bytes in the run's CloudWatch stream, which outlives the VM.
Note the token has no expiry of its own: for `terminate` it outlives the JIT config item's
30-min TTL by design (bounded instead by the run row's terminal-state TTL and by the VM's
own lifetime — the run it can terminate is the run that holds it, so replay after job end is
a no-op). Residual risk: the broker's
own `lambda:TerminateMicrovm` is still region-scoped (`Resource: "*"`) — unchanged from
ADR-019 and unavoidable until the API ships VM-level ARNs — but it is no longer reachable by
untrusted code, and the id it acts on comes from our own run store. Second residual risk: the
reserved-concurrency cap is protection *and* a shared resource. Its callers are untrusted, so a
VM that hammers the broker in a loop can occupy the 20 slots and throttle other tenants' boot
fetches; the guest's bounded exponential backoff absorbs a normal launch burst, but a sustained
abuser turns "can't kill your job" into "can delay your job's start" — a weaker but still
cross-tenant availability effect. It is accepted for the same reason ADR-019's was (availability
only, no data access) and is bounded by the boot budget: a starved `/run` fails that job, not
the control plane. Revisit before mutually-distrusting tenants or public-fork PR runs: the fix
is per-run/per-installation rate limiting in the broker (the token already identifies the run),
not a bigger cap.
**Rollout**: this is a **breaking change to the run-hook payload contract** — `table` is
replaced by `broker` + `token`, and the in-VM hook is *baked into the image*. An old image
rejects the new payload (`missing ref/broker/token`) and a new image rejects the old one, so
the two sides must move together: rebuild the flavor images (`npm run build:images`) in the
same change window as the `LCA-Control` deploy, with no in-flight jobs. Mid-window jobs fail
to start (the hook 400s `/run`) rather than running with weakened IAM; the Reaper reaps the
stranded VM and GitHub re-queues on the next push. Provision fails the message *before*
minting a JIT config if `HOOK_BROKER_NAME` is unset (the guard is the first thing
`provisionOne` does after parsing the message — ahead of even the queued→provisioning
idempotency transition, so a misconfigured deploy DLQs without ever burning a single-use
credential or moving run state). `test/run-hook.test.mjs` pins the VM-side
payload/ref contract, but only image rebuild ships it.
**Verification**: `test/exec-role-iam.test.mjs` asserts against the synthesized
`LCA-Control` template that the exec role holds **zero** `dynamodb:*`, **zero** microVM
control actions, and an `InvokeFunction` pinned to the broker ARN — so a future
`grantReadData(microvmExecRole)` fails the build — and that the broker's own DynamoDB access
is `GetItem` on the table with no index reach. `test/hook-broker.test.mjs` pins the
token hashing/compare and the ref→key derivation (rejecting other entities, `RUN#…#RUN`,
wildcards, and non-numeric ids). `test/hook-broker-handler.test.mjs` pins the λ's
authorization decisions: which item authorizes which action (including terminate succeeding
with the JIT item already aged out, and the pre-stamp race deferring to a retry rather than
a terminal denial), that a wrong token never reaches `TerminateMicrovm`,
that unknown-ref and bad-token responses are byte-identical, and that malformed requests are
rejected before any store access.

The VM-side retry classification is part of the contract: `aws lambda invoke` exits **0**
for a Lambda *function* error too (broker timeout, DDB throttle, cold-start crash), writing
`{errorMessage, errorType}` rather than the broker's own `{ok:false, error}`. The hook only
stops retrying on the latter — a deliberate refusal can't fix itself, whereas treating a
transient control-plane blip as terminal would fail the job at boot or silently drop
self-terminate back to Reaper-only reaping. `test/run-hook.test.mjs` pins both classes, the
token-off-argv payload handling, and that the boot budget stays under the image's declared
`runTimeoutInSeconds`; `test/provision-config-guard.test.mjs` pins the guard-before-mint
ordering above, and `test/provision-redaction.test.mjs` pins the control-plane side: a
payload-echoing SDK error loses the token, and the redaction happens before both sinks (the
persisted `reason` and the rethrow). The token hash mirrored onto the run row is a control-plane verifier for a
bearer secret, so it is declared on `RunRecord` as such and must never be serialized into a
management-API response or the UI (AGENTS.md).

## ADR-022 — Operator auth: GitHub-OAuth-only with a stateless signed session (M4)
**Status**: Accepted (v1) · resolves [spec 04](specs/04-web-ui.md) OQ-2
**Context**: The console needs operator login and per-installation authorization. Spec 04
left two options open: GitHub OAuth alone, or Cognito in front of it for session/token
management. We also need an authorization source of truth — "may this user administer
installation X?" — without re-implementing GitHub's org-role semantics.
**Decision**: **GitHub OAuth web flow only, with a server-signed stateless session.**
1. `GET /auth/login` redirects to GitHub with a `state` nonce that is BOTH HMAC-signed with
   the session secret and set as a short-lived `HttpOnly` cookie; `/auth/callback` requires
   both to agree (CSRF defense on the redirect).
2. The callback exchanges the code for a **user** token, calls `/user` and
   `/user/installations`, then **discards the token**.
3. The session is `base64url(json).base64url(HMAC-SHA256)` — login + the installation list
   + `iat`/`exp` — in an `HttpOnly; Secure; SameSite=Lax` cookie, TTL 8 h. The signing key
   is an SSM SecureString (`/lca/<env>/mgmt/session-secret`), created out-of-band (ADR-008).
4. Authorization is one predicate — `canAdminInstallation(session, id)` — applied at two
   choke points (`authorizeRepo`, `authorizeRun`); every repo/run read and every config
   write goes through one of them. List endpoints additionally filter rows by it.
**Why**: `/user/installations` already encodes GitHub's own access decision, so the
platform never interprets org roles. Not persisting the user token means a stolen cookie
cannot be replayed against the GitHub API — the worst case is bounded to this platform's
own read/config surface. No session table means no extra DynamoDB entity, no eviction
logic, and a stateless λ. Cognito was rejected for v1: it adds a user pool, a hosted UI,
and token plumbing to solve a problem (session storage) that 40 lines of HMAC solve, and it
would still delegate identity to GitHub.
**Consequences**: revocation is TTL-bounded — losing GitHub access leaves a valid session
for up to 8 h (accepted: management surface only; no compute or secret access). Rotating
the session secret invalidates all sessions (that IS the revocation lever). Installation
grants are frozen at login, so a newly-granted installation needs a re-login to appear.
Revisit if we need instant revocation or non-GitHub identities.

## ADR-023 — GSI2 repo/time index for run history (M4)
**Status**: Accepted (v1) · complements [ADR-014](#adr-014)
**Context**: GSI1 (`RUNSTATUS#<status>` / `updatedAt`) exists for the Reaper's per-status
sweep. The M4 Runs screen and Repo detail need a different access pattern: "the last N runs
of THIS repo, newest first, regardless of status." GSI1 can't serve it (status is the
partition), and a table Scan violates the < 300 ms p95 read target in spec 04.
**Decision**: add **GSI2** — `gsi2pk = REPORUNS#<repoId>`, `gsi2sk = <createdAt ISO>` —
written **once** in `buildQueuedItem` and never touched by transitions. The unfiltered
"recent runs" view is a bounded fan-out: one small query per status merged and sorted in
the λ. Deep pagination requires narrowing by repo or status, whose cursors are opaque
base64url of the DynamoDB `LastEvaluatedKey`.
**Why**: keying the sort on the **immutable** `createdAt` (not `updatedAt`) means a status
transition rewrites GSI1 only — no double index churn on the hot path, and a run's position
in history never moves while it executes. Alternatives rejected: a composite
`REPOSTATUS#<repoId>#<status>` partition (would move rows between partitions on every
transition); a scan with a filter expression (cost + latency scale with total history);
storing a per-repo run counter (write contention on the hot path).
**Consequences**: one more index to pay for on every run insert (single write, PAY_PER_REQUEST).
The merged unfiltered view has no coherent cursor, so its `nextCursor` is always null — the
UI narrows to paginate, which matches how operators actually drill in. Because neither index
is keyed by installation, authorization is a post-query filter: a filtered list walks up to
5 index pages per request to fill a page of visible rows (`src/mgmt/paging.ts`) so an
operator whose installation is a minority of platform traffic doesn't see "no runs" next to a
cursor. Dashboard `Select: COUNT` queries page `LastEvaluatedKey` up to 10 times and report
`countsExact: false` when that budget is spent — a single COUNT query only counts one 1 MB
pass, which would silently under-report a long history.
`test/run-store-gsi2.test.mjs` pins the "gsi2sk is createdAt" invariant so a future
transition change can't silently break history ordering; `test/mgmt-authz-paging.test.mjs`
pins the visibility-paging contract.

## ADR-024 — One CloudFront distribution fronts both the SPA and the management API (M4)
**Status**: Accepted (v1)
**Context**: The console is an S3-hosted SPA; the management API is an API Gateway HTTP API.
If the browser talks to two origins, the session cookie becomes cross-site: it needs
`SameSite=None` (thus third-party-cookie-blocking risk in modern browsers), the API needs
CORS with credentials, and the OAuth redirect URI points at a different host than the app.
**Decision**: **one distribution, two behaviors.** Default behavior → private S3 bucket via
Origin Access Control (bucket is never public); `/api/*` and `/auth/*` → the HTTP API
origin with `CACHING_DISABLED` + `ALL_VIEWER_EXCEPT_HOST_HEADER` (cookies and query
strings forwarded, nothing cached). SPA deep links do **not** need a CloudFront error
rewrite: the app is hash-routed (`#/runs/1/2/3`), so every real request path is `/`. We
deliberately configure **no** `errorResponses` — custom error responses are
distribution-wide, so a 403/404 → `/index.html` rewrite would also rewrite the management
API's `403 forbidden` / `404 not found` into `200` + HTML, breaking the API contract and
masking authorization denials. The shell also carries a `self`-only CSP + HSTS +
`frame-ancestors 'none'` via a response-headers policy on the S3 behavior.
**Why**: same-origin makes the session a first-party cookie, removes CORS entirely, and
gives OAuth a single stable callback URL (`https://<domain>/auth/callback`). It also puts
the API behind CloudFront's TLS + edge termination for free.
**Consequences**: the console domain must exist before the management API knows its own
public origin, so the first deploy is **two-pass**: deploy `LCA-Web-<env>`, then re-deploy
`LCA-Mgmt-<env>` with `-c publicOrigin=https://<domain>` (docs/DEPLOY-M4.md). We
deliberately do NOT default `publicOrigin` to a guess — a wrong value is an open-redirect
target, so login fails loudly (500) until it is set. Custom domains + ACM shipped in M5 —
[ADR-036](#adr-036) makes the origin config-derived and removes the two-pass deploy for any
env with a vanity domain configured; the two-pass path above still applies with none.

## ADR-025 — Management-plane IAM: read-mostly, config-write-only, no compute (M4)
**Status**: Accepted (v1)
**Context**: The management λ reads across all three planes' data (runs, installations,
workflow analyses, run logs). The tempting shortcut — `grantReadWriteData` on the table plus
broad SSM read — would let a console bug (or an authz gap) forge run rows, delete history,
or return the GitHub App private key. Spec 04 states the boundary; nothing enforced it.
**Decision**: pin the boundary in IAM **and** assert it in tests:
- DynamoDB: `grantReadData` + a separate statement granting exactly `dynamodb:UpdateItem`.
  No `PutItem`/`DeleteItem`/`BatchWriteItem` → cannot forge or destroy run rows.
- SSM: `GetParameter` on exactly three paths (OAuth client id/secret, session secret).
  Secret **presence** for the Settings screen comes from `ssm:DescribeParameters`, a
  metadata API that cannot return a value — so no code path can leak a SecureString.
- Logs: `FilterLogEvents`/`GetLogEvents`/`DescribeLogStreams` on the per-env run log group
  only; no `PutLogEvents` to it.
- SQS: `SendMessage` only, on the discovery queue (manual re-scan) — no receive/delete.
- **No** `lambda:RunMicrovm`/`TerminateMicrovm`, no `iam:PassRole`, no App PEM access.
Request bodies are additionally allow-listed field-by-field (`validateRepoPatch` rejects
unknown fields), so an operator cannot patch a run's status through the config endpoint.
**Why**: the console is the internet-facing surface of the platform; its blast radius should
be "change repo config" and nothing more. `test/mgmt-stack.test.mjs` asserts the negative
grants against the synthesized template, so a future `grantReadWriteData` convenience call
fails the build rather than silently widening the plane.
**Consequences**: adding a genuinely new management write (e.g. the M5 rewrite-PR endpoint,
which needs a GitHub token) requires a deliberate ADR + IAM change, not a one-line grant.
The `DescribeParameters` statement is `Resource: '*'` because the API has no resource-level
scoping — acceptable since it returns metadata only.

**Amended by [ADR-037](#adr-037)**: the `UpdateItem` grant now backs a second code path —
the installation GSI1 index repair. It needed **no IAM change** (same action, same table) and
writes only index attributes (`gsi1pk`/`gsi1sk`) on an installation row the session already
holds a grant for — no attribute the console or the control plane reads for behaviour.
"UpdateItem is the only write" still holds; "its only purpose is repo config" no longer does.

## ADR-026 — Polling for live run updates in v1 (no WebSocket/SSE) (M4)
**Status**: Accepted (v1) · resolves [spec 04](specs/04-web-ui.md) OQ-1
**Context**: Run detail and the dashboard should update while a job executes. Spec 04 listed
WebSocket (API Gateway), SSE, and polling.
**Decision**: **polling**. `useApi(fetcher, deps, pollMs)` re-fetches on an interval —
3 s for run detail, 5 s for dashboard/runs — and **pauses while `document.visibilityState`
is not `visible`. The log viewer tails CloudWatch by following its `nextToken`.
**Why**: zero new infrastructure (no WS API, no connection table, no fan-out publisher on
the control-plane write path), no reconnect/backoff state machine in the SPA, and a CI
console is a foreground tool watched for seconds-to-minutes — a 3 s lag is invisible. A WS
API would require the control plane to know about connected UI clients, coupling the hot
path to the management plane for a cosmetic gain.
**Consequences**: idle open tabs cost DynamoDB reads; the visibility pause bounds that to
tabs a human is actually looking at, and the aggregate queries are `Select: COUNT` or
`Limit`-bounded index queries (never scans). The log tail follows CloudWatch's `nextToken`
only while one is issued — the filter stops returning a token once caught up, so the client
then advances a `since` watermark (newest event held, +1 ms). Re-sending a spent token, as
the first implementation did, replays the same page indefinitely; `test/mgmt-logs.test.mjs`
pins the token/watermark precedence and the `pending` semantics. Phase 3 already lists
WebSocket live updates — this ADR is the explicit "not yet", not a rejection.

**Fixed by [ADR-048](#adr-048)**: the tail was correct about *paging* and wrong about *which
stream* — it located the run's stream with `logStreamNamePrefix: microvmId`, but the id is a
stream-name suffix, so the pane read nothing for any run. The stream is now resolved to its
exact name before it is read.

## ADR-027 — Console repo config is enforced in Ingest, not the management plane (M4)
**Status**: Accepted (v1) · follows [ADR-025](#adr-025)
**Context**: M4 gave the console `PATCH /api/repos/{repoId}` over `enabled`, `mode` and
`defaultFlavor`. ADR-025 deliberately restricts the Mgmt λ to config writes — it cannot
touch the hot path. That leaves an obvious gap: writing config is not the same as *honoring*
it. As first implemented, `enabled=false` / `mode='off'` and `defaultFlavor` were persisted
and rendered, but no control-plane code read them, so the console's Disable button and
default-flavor selector were cosmetic — the platform kept claiming the repo's jobs and kept
falling back to `base`.
**Decision**: the **control plane** enforces console config at the points that already own
those decisions:
- **Claim gate** — `src/ingest/handler.ts` reads the repo row before enqueueing a claimed
  job and drops it when `isRepoOptedOut(repo)` (`enabled === false` or `mode === 'off'`),
  logging `claimed: false, disabled: true`. This sits AFTER the label filter (so an
  unlabeled job costs no read) and beside the existing compat gate.
- **Flavor fallback** — `resolveFlavor` takes `opts.defaultFlavor` from the repo row and
  uses it instead of catalog `base` when no FlavorMap entry and no explicit LCA label
  matched. FlavorMap and explicit labels still win; an unknown flavor name is ignored;
  signal-based upgrade still applies on top.
**Why**: keeping enforcement in Ingest/Provision preserves the plane boundary — the
management λ never gains hot-path permissions — and puts each rule where its data already
lives. Alternatives rejected: having the Mgmt λ mutate the runner-label config (would widen
its IAM and couple planes); a separate "disabled repos" table (a second source of truth for
a field the repo row already has).
**Consequences**: one extra `GetItem` per claimed job. Both gates **fail OPEN** — a missing
repo row (repos onboarded before M4) or a DynamoDB fault must never stop a labeled job, per
spec 03 § routing. Consequently a *disabled* repo whose row read fails will still run that
job; that is the deliberate trade (availability over strictness) and matches the compat
gate. `mode='adopt'` is not an opt-out — it is treated as `label` until the M5
standard-label map ships. `test/filter.test.mjs` and `test/flavor.test.mjs` pin both.

## ADR-028 — The boot broker budget is sized for a cold AWS CLI, and the CLI is warmed pre-snapshot (M4)
**Status**: Accepted (v1) · amends the boot-budget half of [ADR-021](#adr-021)
**Context**: ADR-021 put a bounded, retried `aws lambda invoke` on the boot critical path:
`/run` cannot ACK until the JIT config is resolved, and the platform abandons the hook after
the image's declared `microvmHooks.runTimeoutInSeconds`. That budget was sized off the
**broker's** latency (~50 ms of DynamoDB work) — 6 s per invoke × 3 attempts + 2 s/4 s
backoff = 24 s against a 30 s hook timeout.

The cost model was wrong. The dominant term is the **cold `aws` CLI** in a freshly
snapshot-resumed guest — Python interpreter start, botocore service-model load, endpoint
resolution — not the broker. The 2026-07-28 dev verification (run `30407823249`) shows attempts 1 **and** 2 failing
identically on **all three** flavors (recorded in `docs/VERIFY-DEPLOY-ADR021-M4.md`, which
lands on its own branch — not an ancestor of this one, so the evidence is reproduced here
rather than only cited):

```json
{"msg":"broker invoke failed","action":"jitconfig","attempt":1,"status":null,"error":"spawnSync aws ETIMEDOUT","stderr":""}
```

Every job still ran — attempt 3 succeeded each time — so this was latent, not breaking. But
it means the boot path had **zero retry margin**: ~22 s of the 30 s deadline consumed to
obtain one success. One further slow attempt exhausts the hook deadline, `/run` never ACKs,
Lambda keeps traffic gated, and the VM is stranded until the Reaper: a failed job plus paid
idle time. A cold-start blip or a throttled broker turns that into intermittent boot failures.

**Decision**: fix the cost and the budget, and pin the margin.
1. **Warm the CLI pre-snapshot.** `run-hook.mjs` exports `prewarmAwsCli()`, called from the
   `ready` **image** hook — which runs during `create/update-microvm-image`, *before* the
   snapshot is captured, so the snapshot carries the warm state and a booted VM's first
   broker call is not the guest's first CLI invocation. The warmup is credential-free and
   egress-free: `--no-sign-request` against a **closed loopback port**
   (`http://127.0.0.1:1`) with IMDS disabled, which forces the whole import/model-load/
   endpoint path and then fails to connect. A non-zero exit is the expected outcome; only the
   elapsed time is interesting, and it is logged. It is best-effort and wrapped — a non-200
   from `/ready` fails the entire image build ("Ready hook check failed").

   **Which CLI this is about.** The guest is not running the deploy host's CLI. All three
   Dockerfiles install Ubuntu 22.04's apt `awscli`, which is **aws-cli v1 (1.22.34 /
   botocore 1.23.34)** — the `≥ 2.35.17` floor in `docs/specs/05-infrastructure.md` applies to
   the *deployer*, which needs the `lambda-microvms` service model; the guest only calls
   `lambda invoke` from the long-standing base service, which v1 has. This matters because v1
   is the slower cold path of the two, so it is the binary any future tuning must measure.
   Reproduced in an `ubuntu:22.04` container (x86 host, so treat the absolute numbers as
   corroborating rather than authoritative — the guest is arm64 and snapshot-resumed):
   **6.36 s cold** for the prewarm invocation vs **2.50 s** for an immediately repeated one.
   The cold figure lands directly on top of the old 6 s bound, which is what made attempts 1
   and 2 time out; the ~3.9 s the repeat saves is what the pre-warm moves to build time.

   It must reach the **connect attempt** to be worth anything. A region is therefore passed
   explicitly (`PREWARM_REGION`, defaulted — the guest images set no `AWS_REGION`): without
   one the CLI aborts at parameter validation with `NoRegion`, *before* endpoint resolution
   and HTTP-stack construction, i.e. before the expensive half of the cold path. Confirmed on
   the guest's own v1 CLI: with a region it reaches `Could not connect to the endpoint URL`
   (exit 255, the expected outcome); without one it exits at `You must specify a region`
   having done none of the endpoint/HTTP work. The log line reports `warmed`
   (the connect attempt was reached) separately from `ran` (the process started), so an early
   exit reads as a failed warmup instead of a successful one — a `ran`-only signal would have
   reported success for a warmup that did nothing. `warmed` accepts **either** botocore
   connect-phase error — `EndpointConnectionError` (port refused, the normal case) or
   `ConnectTimeoutError` (SYN dropped, e.g. a loopback firewall rule) — since both are raised
   only after the expensive work is done (both format strings verified present in the guest's
   botocore 1.23.34, not just in a current release); matching one wording would report a
   failed warmup on
   a fully warm CLI.

   What it does **not** warm: `--no-sign-request` plus disabled IMDS means the
   credential-provider chain and the SigV4 signing path stay cold, because the build guest has
   no role to resolve. A real boot call signs, so attempt 1 still pays that fraction — a second
   reason the per-invoke bound below is sized for a cold-ish call rather than a warm one.
2. **Resize the budget for a cold call anyway**, because a pre-warm can regress silently (a
   base-image change, a CLI upgrade, a rebuilt snapshot) and the guest must not depend on it.
   The deadline is not a free variable: the API caps `microvmHooks.runTimeoutInSeconds` at
   **60 s** (`MicrovmHooksRunTimeoutInSecondsInteger`: min 1, max 60, lambda-microvms
   `2025-09-09` — the image hooks' `readyTimeoutInSeconds` is a separate shape allowing
   3600 s, which is easy to confuse with it). So the image takes the whole ceiling, **30 s →
   60 s**, and the budget is derived down from it: per-invoke bound **6 s → 15 s** and attempts
   **3 → 2**, giving `2 × 15 s + 2 s = 32 s` worst case with a further full-length attempt
   (`+ 4 s backoff + 15 s`) still fitting inside 60 s.

   Dropping an attempt is deliberate. The observed failure is one **slow** call, not three
   flaky ones — every logged failure was the 6 s bound expiring, never a broker refusal — so
   per-invoke headroom buys more than a third try. Against a 60 s ceiling the two cannot both
   be had: `3 × 15 s + 2 s + 4 s = 51 s` would re-create exactly the zero margin this ADR
   exists to remove. Terminate is unaffected and keeps its larger attempt count (no platform
   deadline behind it).
3. **Measure, don't assume.** Every broker attempt logs its own `ms` — on success (`broker
   invoke ok`, action/attempt/duration only, never the response body) as well as on failure, so
   a healthy boot proves attempt 1 clears the bound and a regressed pre-warm shows up as a slow
   success rather than silence. The next
   verification reads the real cold-call duration out of the run's log stream instead of
   re-deriving it from a timeout.
4. **Pin it in tests.** `test/run-hook.test.mjs` keeps the original "budget < hook timeout"
   invariant (which the 6 s budget satisfied while still having no margin) and adds: the API's
   real **1–60 s** range for the declared hook timeout (a value above it fails the image build
   with a `ValidationException`, so this is a build-breaking invariant, not a style one),
   budget + one more full-length attempt ≤ hook timeout, a floor on the per-invoke bound above
   the measured cold cost, a floor of one retry, the presence of per-attempt duration logging,
   the pre-warm's credential-free/loopback/bounded properties, that its bound fits the `ready`
   hook deadline, that it passes a region, and that `warmed` is false on an early exit but true
   on a connect timeout. Both budget invariants read the backoff from the **jitconfig call
   site**, not from `callBroker`'s parameter default — boot passes its own literal, so sizing
   off the default would let a call-site change blow the deadline with the tests still green.

**Why**: the two halves cover each other. The pre-warm removes the latency, so the raised
bound is dead headroom on a healthy boot rather than added boot time; the raised bound means a
*failed or regressed* pre-warm degrades to a slower boot instead of a stranded VM. Pinning the
*margin* rather than just the budget is the part that would have caught this: the shipped 6 s
budget passed the pre-existing invariant.

Alternatives rejected: **raising only the timeout** — not available past 60 s anyway (API cap),
and even at the cap it leaves ~20 s of cold-CLI latency on every boot with every boot one blip
from the wall; **only pre-warming** (a silent regression puts us straight back to a no-margin
budget); **keeping 3 attempts** (see decision 2 — it spends the 60 s ceiling on retries instead
of on per-attempt headroom, for a failure mode that is slowness rather than flakiness);
**replacing the CLI with a hand-rolled signed HTTPS call from Node** — it removes the startup
cost entirely, but it means implementing SigV4 plus credential-provider-chain resolution in an
image that deliberately carries **no npm deps**, and re-deriving the two security properties the
current file-based handling already gives us (the capability token stays off `argv`, and the
credential-bearing response stays out of shared `/tmp`). That is a large, security-sensitive
surface for a latency win the pre-warm already delivers; revisit only if the CLI's cold cost
becomes structural — the 60 s cap means there is no headroom left to buy a second time.

**Consequences**: a wedged boot now occupies its VM for up to 60 s instead of 30 s before the
platform gives up — bounded, and small against the Reaper's 2 h lifetime cap that actually
bounds paid idle time. A boot that needs more than two broker attempts now fails where it
previously had a third try; that is the accepted trade for per-attempt headroom, and the
pre-warm plus the 15 s bound make a single attempt succeed in the measured case. Deploy-touching:
the new hook timeout and the pre-warm both live in the **image**, so they need an image rebuild
(`npm run build:images`) and the ADR-021 skew-window discipline in `docs/DEPLOY-M1.md`. The
pre-warm adds one CLI invocation to each image build. Boot logs gain an `aws cli prewarm` line
and an `ms` field per broker attempt; neither carries payload content (the capability token and
the JIT config stay redacted per ADR-021).

## ADR-029 — Runs is run-primary with client-side grouping and an explicit partial flag (M4)
**Status**: Accepted (v1) · refines [ADR-023](#adr-023) · [spec 04](specs/04-web-ui.md) § Runs
**Context**: the Runs screen listed one row per **job**, because that is what the store holds:
a run row is keyed by the `(repoId, runId, jobId)` triple (ADR-009) and both indexes (GSI1
status/time, GSI2 repo/time) page over job rows. An operator thinks in **workflow runs**, so a
matrix of 8 jobs read as 8 unrelated lines. Making the run the primary row needs a fold — and
the fold can lie: `GET /api/runs` returns an index **page**, so a run's jobs can straddle the
page boundary and a rollup computed from a partial job set reports a wrong duration and a
wrong status. A `status=` filter makes it worse: it returns only the jobs *in that status*, so
every run row built from it is partial by construction.
**Decision**: group **client-side**, and carry completeness explicitly rather than assuming it.
- The fold lives in one pure module, `src/mgmt/run-rollup.ts`, re-exported to the SPA via
  `web/src/rollup.ts` and unit-tested against `dist/` (`test/run-rollup.test.mjs`) — not
  inline in the React component, where it could not be tested.
- **Status fold**: failure dominates (any `failed` → `failed`, then `timed_out`); otherwise the
  most advanced active status wins (`running` > `provisioning` > `queued`); `completed` only
  when every job completed. An empty job set folds to `queued`, never `completed`.
- **Flavor rollup**: the single name when all jobs agree, else `<most common> +<n>` with the
  full breakdown on expand. Jobs with no flavor yet are ignored, not folded in. On a partial
  window the label is weakened (`node +?` / `node +2?`) because an unread job may use an
  unseen flavor — "all jobs agree" is exactly the claim a partial window cannot make.
- **Duration**: **wall clock** (earliest job queued → latest transition) is the primary figure
  because it answers "how long did this run take". The **sum of job durations** is shown on
  expand as **job time** — deliberately not "compute": each job's `durationSeconds` is itself
  queue → last transition, so queued time is included and the sum is an upper bound on billed
  microVM runtime, not a cost basis (v1 stored no per-phase timestamps — spec 04 OQ-5). It
  exceeds wall clock whenever jobs run in parallel, which is the question it answers.
  **Amended by [ADR-042](#adr-042)**: the watermarks resolve OQ-5, so billable time is now
  `runningAt → updatedAt` where a watermark exists. This figure is unchanged — it is still
  queue-inclusive job time, deliberately not a cost basis; the cost basis lives in
  `views.billableSeconds`.
- **Completeness** is split into two halves, so neither side can lie on its own. The **server**
  returns `complete` on `GET /api/runs`, answering only *were any job rows dropped from this
  response?* — not *is the index exhausted?*. The **client** supplies exhaustion from the
  cursor, plus the integrity of the join between its live head page and its appended older
  pages. Whole runs are folded only when every loaded page said `complete`, the cursor is
  spent, **and** that join is intact; otherwise **every** group in the window is stamped
  `partial`, badged in the UI, and its status/job count/flavor/durations render as lower bounds,
  while its **start time** renders as an *upper* bound (`≤`) — the earliest LOADED job's queue
  time, which an unread earlier sibling would push back. Bounding the durations but not the
  start time would leave one value on the row still asserted as fact.
  The head/older join is the third signal because the head page is re-polled every 5 s while
  the older pages sit in client state, and GSI2 is sorted by the immutable `createdAt`: a newly
  queued job pushes a row off the bottom of the fixed-size head page into a gap the older pages
  begin below, so the window develops a hole in the middle while the cursor and server verdict
  both still say exact. The client therefore remembers the key of the head row directly above
  the first older row and treats the window as partial once that row is no longer on the head
  page (`headSeamIntact`) — identity, not a row count, because the count is unchanged by the
  shift. The seam is armed by the paging **hop**, not by the arrival of appended rows: a repo
  page can come back empty with a live cursor when `collectVisible` spent its page budget on
  another tenant's rows, and that hop moved the cursor off the head page just the same. It is
  also captured from the head snapshot the cursor was read from, before the request, so the
  recorded row and the resume point belong to one snapshot. Re-fetching the whole appended
  history on every poll was rejected: it would multiply
  the 5 s read cost by the number of pages walked to fix a case the operator resolves by
  reloading.
  Paging is also asynchronous while the filter controls reset the window, so each older-page
  request carries its filter identity (`pageQueryKey`) and is discarded if the repo/status
  changed before it landed — applying it would append the previous repo's jobs under the newly
  selected one and continue paging the old index.
  Keeping the two halves apart matters: a repo-filtered head page always carries an open cursor
  while history remains, so folding exhaustion into the server's flag would leave such a window
  permanently partial no matter how far the operator paged. The dropped-rows half in turn cannot
  be computed client-side: the merged multi-status view queries each status index for `limit`
  rows and applies the installation-visibility filter *afterwards*, so a response shortened by
  filtering out another tenant's rows would look like proof of exhaustion while this operator's
  sibling jobs sit unread past the boundary. Only the route sees the raw per-status cursors
  (`mergedResponseComplete`); the repo path never slices, so it reports
  `repoResponseComplete`.
  A `status=` filter drops sibling jobs by construction and therefore always reports
  `complete: false`, including when combined with `repo=` — in which case `repo` picks the index
  and `status` rides along as a post-query predicate rather than being ignored.
**Why**: no new API surface — `complete` is one added response field on an existing read, so
the change needs no infrastructure and no schema change. Server-side **grouping** was rejected
for v1: it would mean a run-keyed index (GSI3) or a fan-out read per run, i.e. a hot-path
schema change to fix a presentation problem. Per-run job fetch on expand was rejected as
insufficient on its own: it fixes the *expanded* view but the collapsed row still shows a
rollup, so completeness would still have to be labelled. Flagging only the run that owns the
page-boundary row would be unsound — a straddling run's oldest *loaded* job need not be the
boundary row — so the flag is per window, deliberately conservative.
**Consequences**: a truncated window marks runs partial even when most are in fact whole; that
is the accepted direction of error (a labelled lower bound over a confident wrong number).
Clearing the status filter or exhausting the cursor with a repo filter yields exact rollups.
Run/job ids move to small dim text with a copy button (`CopyId`), which must
`stopPropagation` because it sits inside a click-through row. **Est. cost leaves this screen**:
a cost figure belongs on a Reports screen with a window and grouping, so `formatCost` and
`flavorRatePerMinute` stay in place unused-by-Runs, and Reports is tracked separately (M5).
If per-run cost/latency reporting arrives, a run-keyed index becomes worth revisiting and this
ADR is the place to record the reversal.

## ADR-030 — Adopt mode: standard-label claiming, with the runner advertising the job's own labels (M5)
**Status**: Accepted (v1) · supersedes the deferral note in [ADR-005](#adr-005) · one
**open verification item** (below)
**Context**: `label` mode (ADR-005) needs a one-line YAML edit per job. The M5 exit criterion
is stronger: *a brand-new repo runs unchanged in adopt mode*. Two facts constrain the design:
- GitHub matches a job to a runner by **label set containment** — the runner must advertise
  *every* label in the job's `runs-on` ("Using self-hosted runners in a workflow": labels
  "operate cumulatively"). So a job that says `runs-on: ubuntu-latest` can only ever be served
  by a runner carrying `ubuntu-latest`.
- Registration accepts caller-supplied labels as given, including GitHub's own default label
  names (`config.sh --labels gpu,x64,linux` — "GitHub Actions accepts them as given and does
  not validate that the runner is actually using that operating system or architecture").
**Decision**:
- **Claim gate** (`src/ingest/adopt.ts` `decideClaim`) becomes mode-aware. `windows-*` /
  `macos-*` are refused **first, in every mode** — above the explicit-label rule, because
  `runs-on: [windows-latest, lambda-ci]` is a workflow mistake rather than consent, and
  claiming it strands the job on a runner that can never execute it. The compat gate cannot be
  the only guard: it fails open by design. Then an explicit LCA label wins and is recorded as
  `via: 'label'`. Only in `adopt` mode do standard hosted
  labels (`ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`, `ubuntu-20.04`) claim a job, as
  `via: 'adopt'`.
- **Routing**: every standard label maps to `base`, and the existing signal-based upgrade
  (spec 03 step 4) moves the job to `docker` when its parsed steps need it. This
  settles spec 03 OQ-3 in favour of *signal-driven*: the label `ubuntu-latest` carries no
  information about what the job needs, so guessing `node` from it would be superstition.
- **JIT labels** (`src/provision/labels.ts`): the minted runner advertises the **job's own**
  label set (de-duplicated, matrix expressions dropped, capped), because of containment
  above. In adopt mode that includes `ubuntu-latest`.
- **Mode is per repo and defaults to `label`.** Adopt is all-or-nothing per repo (GitHub gives
  us no way to take *some* `ubuntu-latest` jobs), and it silently moves work to arm64 — so it
  is the operator's explicit choice, made from the console where compat findings are visible.
- The repo row is now read **before** the claim decision (previously after the label filter),
  since `mode` is an input to it. A row-read failure degrades to `label` mode: a DynamoDB
  fault must never *start* intercepting a repo's hosted-label jobs.
**Why not rewrite-only**: rewriting YAML (ADR-031) is the honest alternative, but it needs
`contents:write` and a merged PR, i.e. it is not "unchanged". Adopt mode is the zero-edit path;
the rewrite PR is the make-it-explicit path. We ship both and let the operator pick.
**Consequences**: one repo-row read per queued job in every mode (was: only for label-matched
jobs). Adopt-mode jobs land on Graviton, so a job with an undeclared x86 dependency will fail
where it used to pass — compat analysis flags what is statically visible and the console states
the tradeoff at the toggle, but `arch_hints` are heuristics, not proof.
**⚠️ Open verification item**: GitHub reserves its hosted-runner label names on some
registration paths, and `generate-jitconfig` may reject `ubuntu-latest` with **HTTP 422**. The
current docs for label assignment do not state such a prohibition, and we have not yet observed
the call against a live repo. Mitigation shipped now: `classifyMintFailure` treats a 4xx mint
failure as **permanent** (no SQS retry storm, no burnt DLQ budget) and, for a 422 carrying a
hosted label, writes an actionable reason onto the run row naming the fix (switch to `label`
mode, or use the rewrite PR). A **transient** mint failure (429/5xx/network, and a rate-limit
403 — see the sixth-review fix below) deliberately does
NOT write a terminal status: `failed` is terminal, so the redelivered message's
`queued→provisioning` idempotency guard would refuse to advance the row and skip the launch —
the retry would never reach the mint again. The row stays `provisioning` and the Reaper
backstops a run that never recovers. **Adopt mode must not be advertised as GA until a real
adopt-mode job has been observed green end to end**; the M5 exit criterion is what closes this.
`test/adopt.test.mjs` and `test/jit-labels.test.mjs` pin the behaviour either way.
**Seventh-review fixes (two ways a claimed job could never run, or ran on the wrong machine)**:
- **An x86 architecture label is refused, in every mode.** `decideClaim` refused only
  `windows*`/`macos*`, so `runs-on: [self-hosted, linux, x64, lambda-ci]` was claimed and `x64`
  was passed straight through to `generate-jitconfig`. GitHub matches a runner to a job on
  **advertised labels alone**, so this registers a Graviton runner that CLAIMS to be x86 — and
  the job is then assigned and **executes on the wrong architecture**, rather than staying
  queued for a runner that could serve it. That is strictly worse than the stranded-job outcome
  the non-Linux refusal prevents, and compat analysis does not contain it (x86 hints are `risk`,
  and the analysis lookup fails open by design). The refusal is now a shared predicate,
  `incompatibleRunnerLabel`, applied by `decideClaim`, by `rewriteTargets` /
  `rewriteRunsOnValue` (rewriting such a job would produce a selector we refuse AND that
  GitHub-hosted can no longer serve), by the console's `adoptCandidate` flag, and **again**
  pre-mint in Provision (`IncompatibleRunnerLabelError`, classified permanent) so a message
  queued before the gate existed cannot mint the false label. Exact tokens only
  (`x64`, `x86`, `x86_64`, `x86-64`, `amd64`, `i386`, `i686`) — a substring test would catch
  custom labels like `x64-cache-warmer`, and `arm64`/`aarch64` are true of us.
- **A job naming a non-default runner group is not claimed.** `runs-on: { group: X, labels:
  [...] }` requires a runner that is in group X **and** carries the labels. We register into the
  repo-level default group only (`runner_group_id: 1`, spec 01 OQ-1), and the `workflow_job`
  webhook carries only the labels — so adopt mode claimed a
  `{ group: special, labels: [ubuntu-latest] }` job on the strength of `ubuntu-latest`, minted a
  runner in the default group, and the job waited forever. This is newly reachable in M5
  precisely because adopt mode claims the hosted label with no LCA label present anywhere. The
  parser now records `runner_group` on the parsed job (kept separate from `runs_on`: a group is
  not a label), and Ingest refuses the claim when the matched analysis names a group other than
  `default`. Consistent with the compat gate, the refusal is **evidence-based**: with no stored
  analysis the group is invisible and the pre-existing fail-open posture stands — the residual
  gap, closed only by resolving group ids at mint time, which v1 does not do. The refusal is a
  shared predicate (`unreachableRunnerGroup`) applied by the Ingest gate, by the console's
  `adoptCandidate` flag and by `rewriteTargets`: a predicate that *predicts* a claim must agree
  with the gate, or RepoDetail advertises jobs adopt mode always refuses and the rewrite PR edits
  a customer workflow for a job that still cannot run.
  `test/adopt.test.mjs`, `test/adopt-routing-consistency.test.mjs` and
  `test/jit-labels.test.mjs` pin all of it.

**Sixth-review fix**: a **rate-limit 403 is transient**, not permanent. `generate-jitconfig`
is a POST, so GitHub's **secondary** rate limits meter it and GitHub refuses with **403**, not
429 — for both the primary limit and the secondary/abuse limit. The blanket "non-429 4xx is permanent" rule therefore
stamped a merely throttled job terminal `failed` with "rejected by GitHub", and because
`failed` is terminal the redelivered message's `queued→provisioning` guard refuses to advance
the row — so the SQS retry that would have succeeded never reached the mint, and a developer's
job needed a manual re-run. Adopt mode is exactly what makes the burst reachable: claiming by
standard label mints a whole workflow's jobs at once, and Provision's reserved concurrency
(10 dev / 25 prod) can outrun GitHub's per-minute ceiling. Two published secondary limits apply
(GitHub docs, "Rate limits for the REST API"): **900 points/minute** per endpoint with a POST
costing **5 points** (≈180 mints/min), and a separate **content-creation** cap of **80/minute
and 500/hour**. The hourly one is the one concurrency cannot buy its way out of — it binds at
500 minting jobs in an hour whatever the rate, which RUNBOOK now says explicitly so the
"lower `provisionConcurrency`" remedy is not applied to a volume limit it cannot fix. GitHub
states the secondary limits change without notice and that some endpoints carry undisclosed
costs, so the numbers are indicative and the classification matches the refusal, not a budget
calculation. The classification now matches on the response
**body**, not the bare status, because 403 is also how GitHub reports a revoked installation or
a missing permission — which is genuinely permanent and must keep naming the fix rather than
retrying into the DLQ. `test/jit-labels.test.mjs` pins both halves.

**Fifth-review fix**: the label cap is a **refusal**, not a truncation. `jitRunnerLabels`
used to stop at `MAX_JIT_LABELS` (20), which is the same silent-failure class as the empty-set
case above and quieter. `decideClaim` claims on the FULL webhook label set, so a job like
`[l1 … l20, lambda-ci]` is claimed and the truncated mint then registers a runner that never
advertises `lambda-ci`. GitHub matches cumulatively, so the runner can never be assigned the
job it was launched for: the VM boots, burns the single-use JIT config, matches nothing and
idles until the Reaper — while the run row already reads `running`, so the console shows a
healthy run that will never move. Normalization now returns the whole set and Provision refuses
an over-cap job pre-mint with `TooManyRunnerLabelsError` (classified **permanent**, stating the
observed count, the cap and the fix). Pinned by `test/jit-labels.test.mjs` and
`test/provision-config-guard.test.mjs`.

**Fourth-review fix**: `adoptCandidate` (the console's per-job flag and its `adoptCandidates`
count) now applies the SAME non-Linux refusal as `decideClaim`. It previously asked only "has a
standard hosted label AND no LCA label", so a mixed selector like `[ubuntu-latest,
windows-latest]` — which the claim gate refuses in every mode, and which `rewriteTargets`
already excluded — was counted and advertised. RepoDetail states that count as fact ("N job(s)
… run on arm64 microVMs"), so the divergence made the console overstate what adopt mode would
claim on exactly the repos where the mistake matters. `test/mgmt-views.test.mjs` now cross-checks
the flag against `decideClaim` and `rewriteTargets` rather than restating the rule.

**Third-review fixes (both were silent-failure paths, not cosmetics)**:
- **An all-expression `runs-on` is refused BEFORE the mint.** `jitRunnerLabels` drops unresolved
  `${{ … }}` entries because they are not labels, so `runs-on: ${{ matrix.os }}` normalizes to an
  EMPTY set. GitHub accepts `labels: []` and returns a JIT config for a runner carrying only its
  automatic defaults (`self-hosted`, `linux`, `ARM64`) — which cannot satisfy the job's real
  selector. The VM would boot, consume the single-use JIT config, match nothing, and idle until
  the Reaper: paid compute that could never take the job, reported as a timeout rather than a
  configuration error. `NoRunnerLabelsError` now fails the run pre-mint with the fix in the
  reason (add a literal LCA label alongside the expression), and `classifyMintFailure` special-
  cases it as **permanent** — it carries no `HTTP <status>`, so the status-based rule would
  otherwise read it as transient and retry forever.
- **Discovery resolves flavors WITH the repo's mode.** The stored `routes[jobId]` is not just a
  console decoration: it is what the auto-rewrite planner reads to choose the label it writes
  into a customer's PR (ADR-031). Resolving without `mode` sent every hosted-label job through
  the FALLBACK, so an adopt-mode repo's routes read `fallback to base (no matching label)` —
  wrong explanation always, and the wrong *flavor* whenever the repo also set `defaultFlavor`
  (the fallback honours it; the adopt map does not). A `mode` change now also enqueues a
  re-scan, because otherwise the operator flips to adopt and the console keeps showing the
  stale fallback routes until someone happens to push a workflow change.

## ADR-031 — Auto-rewrite PR: line-level edit, three gates, never a push (M5)

**Status**: Accepted (v1) · implements spec 03 § Auto-rewrite · keeps the AGENTS.md
`contents:write` hard rule intact
**Context**: some teams want the routing decision visible **in the repo** rather than implied
by console config. Spec 03 promises an opt-in PR that adds LCA labels. `contents:write` is an
elevated GitHub App permission and is **off by default** by project rule, so the capability
cannot simply exist.
**Decision**:
- **Line-level text edit, not a YAML round-trip.** `src/mgmt/rewrite.ts` rewrites only the
  `runs-on:` lines it is confident about and leaves every other byte alone. Re-serializing
  with js-yaml would drop comments and normalize quoting/key order across the whole file,
  producing a diff no reviewer can sanely approve. Shapes we cannot edit safely (block
  sequences, `${{ matrix.os }}`, the runner-group object form) are reported as `skipped` with
  a reason for the operator to hand-edit — we never guess and corrupt a workflow.
- **The hosted label is removed**, not kept beside ours: by ADR-030's containment rule,
  leaving `ubuntu-latest` in would demand a runner advertising it and defeat the rewrite.
- **Three independent gates**, all required: (1) deployment flag `-c rewrite=true` →
  `REWRITE_ENABLED`; (2) per-repo `rewriteEnabled`, set from the console; (3) GitHub's own
  answer if the App lacks `contents:write` (403, surfaced as the failure reason). Any one off
  ⇒ no write. The dry-run diff stays available regardless, so an operator can see exactly what
  the PR *would* do before enabling anything.
- **A separate control-plane λ does the writing** (`src/rewrite/handler.ts`), fed by an SQS
  queue. The management API only enqueues. This preserves ADR-025: the read-mostly management
  plane holds no App PEM and cannot mint installation tokens, so the one capability that
  writes to a customer repo does not live behind the console's IAM role.
- **Branch + PR only.** An existing branch is never reset (that would be a force-push — spec
  03 forbids it); an existing open PR is reused rather than duplicated; nothing is auto-merged.
  Commits carry the blob `sha` we planned against, so a concurrent edit makes GitHub reject
  the write instead of us clobbering it.
- The λ **re-plans against live file contents** rather than trusting the operator's dry run,
  which may be stale. Critically it plans against **the ref it is about to write**: the default
  branch when creating the branch, the rewrite branch when that branch already exists. Reading
  the default branch on a re-run would yield a stale blob sha, so the `sha`-guarded write would
  409 on every attempt, retry, and DLQ — and a partially applied multi-file rewrite could never
  be completed. `rewriteTargets` skips jobs that already carry an LCA label, so a re-run is
  naturally a no-op for files already rewritten. The target list still comes from the stored
  analysis, so `rewriteRunsOnValue` re-checks the **live** value for a standard hosted label and
  refuses anything else: if a job's `runs-on` changed to `windows-latest`, or to another fleet's
  `[self-hosted, gpu]`, since the scan, it is skipped with a reason rather than rewritten into
  something unroutable.
  CRLF files are handled without reformatting: line terminators are preserved per line, so a
  Windows-checked-in workflow is not silently reported as unrewritable (nor converted to LF).
- **The `runs-on:` scanner is anchored to the job-body indent column**, not "first match at any
  deeper indent" (second review fix). YAML siblings share a column, so a job's own keys all sit
  at one indent; anything deeper is something else. Two shapes made the looser scan actively
  dangerous rather than merely imprecise:
  `strategy.matrix.runs-on:` (a matrix *dimension*) and a `runs-on:`-looking line inside a
  `run: |` block scalar. Both are indented deeper than the job body and both precede the real
  selector, so a first-match scanner rewrote the WRONG line — committing a corrupted matrix into
  the customer's repo while leaving the actual selector unrouted. Anchoring makes the matrix case
  resolve to the job's real `runs-on: ${{ matrix.runs-on }}`, which `rewriteRunsOnValue` then
  refuses as an expression: the correct outcome is a `skipped` reason, never a blind edit.
- **A re-run that finds nothing to change returns the open PR's URL.** That is the normal second
  click — the first run already rewrote every job, so `rewriteTargets` skips them all. Reporting
  a bare "nothing to do" for a request whose entire outcome is a waiting pull request would send
  the operator hunting for it. The lookup is best-effort: failing to decorate a successful no-op
  must not turn it into an SQS retry. **A no-op with no open PR is reported differently when the
  branch already existed** (fourth review fix): we plan against that branch and never reset it,
  so if its PR was closed — or merged and the branch left behind — every further click is a
  permanent no-op while the default branch may still be unrouted. The reason names the branch and
  the unblocking action (delete it, so the next request re-plans from the default branch) instead
  of claiming there is nothing to do.
- **…but where a PR can still be opened, the no-edit path OPENS it** (eighth review fix). The
  "delete the branch" advice above is only correct when the branch's rewrite has already been
  merged. It is actively harmful in the state the λ actually lands in when the commits succeeded
  and only `ensurePullRequest` failed — a 5xx, or an App granted `contents:write` but not
  `pull_requests:write`. The redelivery re-plans against the rewrite branch, whose jobs now all
  carry LCA labels, so every job is skipped and the request degrades to a permanent no-op;
  telling the operator to delete that branch discards the committed rewrite AND cannot produce a
  PR, because a fresh branch cut from the default branch reaches the same state again. So when
  the branch exists, has no open PR, and there are no new edits, the λ calls `ensurePullRequest`
  and reports `opened`. The attempt is best-effort (a failure degrades to the honest no-op
  reason above, never a DLQ for a delivery that committed nothing), and GitHub's 422 "no commits
  between base and head" is exactly the already-merged case where deleting the branch IS the
  right advice. The recovery PR is opened with no plan, so `rewritePrBody` describes the earlier
  commits rather than claiming "0 job(s) across 0 workflow file(s)".
**Why the console preview is not a file diff**: the management λ cannot read repo files (no
credential, by design), so its dry run is derived from the stored parse (`runs_on` per job).
It shows the exact label change per job — the thing being decided — without pretending to be
a byte-level diff. The λ produces the real unified diff when it commits.
**Seventh-review fix**: the `runs-on:` scanner must **forget the current job** on structure it
cannot parse, not skip the line. Its job-key pattern accepted only plain scalars, so a YAML-quoted
job id (`"build":` / `'release':` — legal YAML and a legal GitHub job id) was not recognized as a
key. That did not merely lose the job: `currentJob` stayed pointing at the PREVIOUS job while the
scan walked into the new job's body, so the next `runs-on:` was recorded under the wrong job id.
The planner then rewrote job B's selector using job A's target — e.g. stamping `lambda-ci-docker`
(4 vCPU / 8 GB) onto a job that asked for neither, while the job that did need docker stayed
unrouted and was reported as having no `runs-on`. In the worst shape (`lint` with a block-sequence
selector followed by a quoted `"release"`), planning the *refused* job edited the *other* job's
line. Quoted ids are now recognized, and — because the class is open (ids needing escapes,
complex `?` keys) — any unrecognized non-blank line at or shallower than the job-id column clears
the current job, so the outcome is a `skipped` reason rather than an edit against the wrong job.
A job whose body is an **inline flow mapping** (`build: {runs-on: ubuntu-latest}`) is refused for
the same reason: there is no line to edit without re-flowing the mapping, and treating its
interior lines as body keys would drop their separators. Pinned by `test/rewrite.test.mjs`.

**Eighth-review fix**: the inline-sequence tokenizer is now **escape-aware**, because it was
silently rewriting a label into a DIFFERENT label. Inside a double-quoted YAML scalar `\"` is an
escaped quote, not the closing one, but the scanner treated any `"` as a terminator — so it
dropped out of "inside a quote" state MID-LABEL. A following `,` then split one label in two and
the halves were re-emitted joined by `, `: `[ubuntu-latest, "a\"x,y\"z"]` became
`[self-hosted, "a\"x, y\"z", lambda-ci]`, i.e. the runner is asked for a label the workflow never
named — committed to the customer's repo, and shown identically in the console dry run. The
existing unterminated-quote refusal could not catch it: an even number of escaped quotes
re-balances the state. The same early exit made a later ` #` inside the label read as a comment
and truncate the value, which surfaced as a wrong "no longer targets a standard GitHub-hosted
label" refusal. Two consequences fixed together: the scanner skips the character after a
backslash inside a double-quoted token (and refuses a dangling trailing escape rather than
guessing), and `unquoteLabel` now DECODES `\\`/`\"` and single-quoted `''` so every comparison
predicate (`already carries an LCA label`, `isAdoptLabel`, `nonLinuxHostedLabel`) sees the label
the parser would produce rather than its escaped spelling — otherwise a label written
`"lambda-ci"` dodged the already-routed check. Single-quoted scalars have no backslash escapes,
so the backslash rule is scoped to `"`. `test/rewrite.test.mjs` pins each case by semantic round
trip through the production parser, not by output string.

**Ninth-review fix**: the escape decode is now the **whole YAML double-quoted table**, not just
`\\` and `\"`, because a partial decode was not the conservative direction the eighth-review fix
assumed. That fix argued an undecoded escape can only make a comparison MISS, which keeps the
label as-is — true for the predicates that DROP a label, false for the ones that REFUSE on one.
The arm64 containment guard is a refusal: `[ubuntu-latest, "\x77indows-latest"]` parses as
`windows-latest` (verified against js-yaml 5.2.1, the parser Discovery runs), so
`nonLinuxHostedLabel` never saw it, the mixed-selector refusal was skipped, and the rewrite
emitted `[self-hosted, "\x77indows-latest", lambda-ci]` into the customer's PR — a job
`decideClaim` refuses (non-Linux label) that GitHub-hosted can no longer take either (we added
`self-hosted`), i.e. one that queues forever. The same hole let an escaped `"lambda\x2dci"` dodge
the already-routed check. `unquoteLabel` therefore decodes every single-character escape
`js-yaml` implements plus `\xNN`/`\uNNNN`/`\UNNNNNNNN`, and — the important half — **returns
undefined for any escape it cannot decode exactly**, which fails the whole tokenization so the
caller refuses the file. Guessing is not available: a predicate that refuses needs the label's
real value, and a token carrying an unknown escape is invalid YAML anyway (the file would not
have parsed for Discovery), so refusing costs nothing and keeps this decoder from having to be a
superset of the parser. Pinned by `test/rewrite.test.mjs` in both directions — escaped
`windows`/`macos`/LCA spellings are refused, and an escaped `ubuntu-latest` is still recognized
as the label we may replace.

**Tenth-review fix**: a **comment-only `runs-on` value is refused**, not tokenized as labels.
`RUNS_ON_RE` consumes the whitespace after `runs-on:`, so a line whose whole value is a comment
(`runs-on: # options: self-hosted, ubuntu-latest`, with the real labels in the block sequence on
the following lines) reaches `splitComment` as a string whose FIRST character is `#`. The comment
scanner required a preceding whitespace character, so it found no comment and handed the comment
TEXT to the label tokenizer. A comment that happens to name a hosted label therefore passed the
hosted-label gate, and the emitted line was
`runs-on: [self-hosted, # options: self-hosted, lambda-ci]` — which **does not parse at all**
(`missed comma between flow collection entries`), leaves the block sequence below it dangling,
and would have been committed to the customer's repository by a PR we opened. That is exactly the
failure the line-level design exists to prevent, and neither the unterminated-quote refusal nor
the escape-decode work above could see it: the value is well-formed, it simply is not a value.
`splitComment` now treats a `#` at position 0 as a comment (matching YAML), which leaves the
remaining value empty, and `rewriteRunsOnValue` refuses it with a reason naming the shape (the
labels are on the following lines — hand-edit) rather than the generic block-sequence message.
Pinned by `test/rewrite.test.mjs`, which asserts the original file parses, the plan produces NO
edits and NO `content`, and the skip reason names the operator action.

**Twelfth-review fixes (the recovery path was reporting failures as success)**:
- **Only GitHub's "No commits between…" 422 is benign.** The eighth-review fix taught the
  no-edit path to OPEN a PR for a branch that already carries a rewrite — the state the λ lands
  in when the commits succeeded and only the PR call failed. Its catch, however, swallowed
  *every* failure and returned `nothing-to-do`, whose reason tells the operator to **delete the
  branch holding their un-PR'd rewrite**. A 403 (App holds `contents:write` but not
  `pull_requests:write` — exactly the case the comment cites), a rate-limit 403/429, a 5xx and
  any other 422 were all reported as "nothing to do" while the SQS message was acknowledged, so
  the operator had a `202`, no PR, and destructive advice. `githubJson` now throws a typed
  `GithubApiError` carrying the **status** (the message text is unchanged — `isNotFound` and
  `classifyMintFailure` match on it), and the recovery rethrows everything except a 422 whose
  body says "no commits between", so a real failure retries and ultimately DLQs visibly. The
  open-PR **lookup** also stopped swallowing: concluding "no PR is open" from a *failed* call
  would let the recovery open a SECOND pull request for a branch that already has one.
- **Workflow paths are encoded per segment.** Both the contents read and the write used
  `encodeURI`, which deliberately leaves `#` and `?` unescaped. A legitimately named
  `.github/workflows/release#arm.yml` was therefore sent as a URL **fragment** (dropped from the
  request entirely) and `release?arm.yml` started a query string — the read 404s and the λ
  misreports the workflow as deleted, and the write targets the wrong resource. Both now encode
  each segment with `encodeURIComponent` and rejoin on `/`, matching what `encodeRefPath`
  already did for branch names. `test/rewrite-pr-lookup.test.mjs` pins the status
  discrimination, the rethrow, and the request paths for `#`, `?`, `%`, spaces and Unicode.

**Eleventh-review fix**: both opt-in gates admit only the **exact** enabling value, and the
gate ordering is pinned by a test. `validateRepoPatch` accepts only a boolean for
`rewriteEnabled`, but the repo row is also writable out of band — RUNBOOK documents a
break-glass `dynamodb update-item` on exactly that item for `mode` — so the λ's truthiness test
(`!repo?.rewriteEnabled`) would have treated a stray `"false"` or `1` as consent, while
`toRepoView` and the management API's `repoOptedIn` both report `=== true`: the console would
show the toggle OFF for a repo the writer was willing to open a PR on. Both the λ and the API
now test `!== true` / `=== true`. Separately, the gates' *position* was unpinned: the CDK test
only proved `REWRITE_ENABLED` reaches the function's environment, so nothing stopped a future
edit from moving a gate below the `getParam(APP_PEM_PARAM)` read or a repo call.
`test/rewrite-pr-lookup.test.mjs` now asserts the deployment gate precedes the per-repo gate,
and both precede the App private-key read and every GitHub call (`getRepoDefaultBranch`,
`getBranchSha`, `getFileContent`, `ensureBranch`, `putFileOnBranch`, `ensurePullRequest`,
`findOpenPullRequest`) — a refused request must reach neither the credential nor the repo.

**Consequences**: an extra queue + λ, both inert in a default deployment. The rewriter's
coverage is deliberately partial; `skipped` entries are a first-class output surfaced in the
UI and repeated in the PR body, alongside an explicit arm64 warning for the reviewer.
`test/rewrite.test.mjs` pins comment/indentation preservation and every refusal.

**Fifth-review fix**: a **deleted or renamed workflow is skipped, not fatal**. Discovery upserts
one analysis row per workflow and never prunes rows for files that no longer exist, so a stored
candidate can 404 on read. Letting that throw failed the whole request: SQS redelivered, 404ed
again, and the message DLQed (alarming) while every OTHER workflow in the repo went unrewritten
and the operator got no PR at all — from a repo simply having deleted a workflow since its last
scan. Only 404 is swallowed (a 403 from a missing `contents:write`, or a 5xx, still retries), and
when every candidate has vanished the no-op reason names the paths and tells the operator to
re-scan rather than claiming no job needs a label. Pinned by `test/rewrite-pr-lookup.test.mjs`.

**Sixth-review fixes** (both about touching the customer's repo, so both are in scope for the
`contents:write` hard rule):
- **The ref path keeps its slashes.** `GET /repos/{o}/{r}/git/ref/{ref}` matches the ref as
  literal path segments and does not decode `%2F`, so `encodeURIComponent` over the whole branch
  name made the existence probe 404 for a branch that exists. Our branch always contains a slash
  (`lambda-ci-actions/adopt-labels-<env>`), so this was the normal case: the probe reported
  "absent", the create then failed `422 Reference already exists`, the request errored, SQS
  redelivered, and the message DLQed — every second "Open rewrite PR" click was unfixable, and
  `planRef` would have read the wrong ref anyway. Encoding is now per segment.
- **No branch is created for a request with nothing to rewrite.** The λ used to call
  `ensureBranch` before planning (it needed to know whether the branch existed to pick
  `planRef`). That pushed a stray `lambda-ci-actions/adopt-labels-<env>` branch into the
  customer's repo on every no-op request — including a repo whose jobs are all already labelled,
  where the operator's action produced a branch and no PR. The existence check is now a
  non-mutating probe (`getBranchSha`), and the branch is created only once there is at least one
  edit to commit. Both pinned by `test/rewrite-pr-lookup.test.mjs`.

## ADR-032 — Custom metrics as EMF log lines, alarms bound to an env-only dimension set (M5)
**Status**: Accepted (v1) · implements spec 05 § Observability
**Context**: spec 05 names the platform metrics (`ProvisionLatency`, `ProvisionFailures`,
`QuotaThrottles`, …) and the alarms over them. Two implementation traps: a `PutMetricData`
call on the provisioning hot path adds latency and its own throttling failure mode; and a
CloudWatch alarm reads **one exact dimension set** — it does not aggregate across dimensions.
**Decision**:
- Emit metrics as **CloudWatch Embedded Metric Format** log lines (`src/shared/metrics.ts`):
  no extra API call, no `cloudwatch:PutMetricData` grant on any Lambda, and the datapoint
  shares a log line with the context that explains it. `putMetrics` (real API) exists for
  non-Lambda callers and is unused on the hot path.
- **Publish two dimension sets** per datum: the full set (`env` + `flavor`/`via`/`kind`) for
  console drill-down, and an **`env`-only rollup** that alarms bind to. Without the rollup an
  alarm on `{env}` would sit at `INSUFFICIENT_DATA` forever while the per-flavor metric
  ticked up — a silent alarm, which is worse than no alarm.
- **Cardinality rule**: repo full name, run id, job id and microVM id are attached as EMF
  **properties**, never dimensions. As dimensions they would bill one custom metric per run
  and be useless for alarming; as properties they stay queryable in Logs Insights.
- Alarms (ControlStack): both DLQ depths, `QuotaThrottles > 0`, `ProvisionFailures` over the
  env threshold, per-λ `Errors`, and provisioning-queue **age of oldest message** (the only
  signal that catches "Provision stopped consuming", which emits no error anywhere). All use
  `treatMissingData: NOT_BREACHING` so an idle platform never pages.
- The alarm topic gets a subscriber only via `-c alarmEmail=…`. An unsubscribed topic is a
  silent alarm, but a hardcoded team address would be wrong for every other deployment (and
  is a small information leak in a public repo), so this is an explicit deploy-time input.
- X-Ray active tracing on the hot path, per-env (`config.tracing`).
- **A quota throttle is retried, not failed** — Provision rethrows without writing a terminal
  status, because `failed` is final and the redelivered message's queued→provisioning guard
  would then return early, so the retry we asked SQS for could never re-attempt the launch. One
  throttle would permanently fail a job that only needed to wait. The accepted cost: the
  redelivery re-mints a JIT config and abandons the previous one. That is safe (single-use, and
  the side-store item TTLs out in 30 min unclaimed — [ADR-016](#adr-016)) and bounded
  (`maxReceiveCount` 3, so ≤3 mints per job), whereas carrying the old config across deliveries
  would risk launching on one another delivery already consumed. It does spend GitHub API budget
  during a throttle storm, which is part of why `QuotaThrottles` is alarmed rather than only
  logged.
- **The dashboard cost sample prices only runs that actually launched a microVM** (third review
  fix). Provision stamps `flavor` on its mint- and launch-failure paths for support, so a run
  that never got a VM still carries a priced flavor; `estimateCostUsd` then billed its full
  wall-clock (including the queued wait) for compute that never existed. The estimate therefore
  grew every time provisioning broke — exactly when an operator is reading the dashboard.
  `microvmId` is the only evidence a VM existed, so it gates the sample.
- **The dashboard total does not pre-empt the Reports screen** ([ADR-029](#adr-029) moved cost
  off Runs on the grounds that a cost figure needs a window and grouping). This is deliberately
  the weaker artefact ADR-029 does not defer: a fixed, bounded sample of the most recent
  terminal runs, labelled as such, reachable with no new index and no new read pattern — it
  answers "is spend roughly what I expect" for the M5 exit criterion ("dashboard shows health
  + cost"). The windowed, groupable report now ships on the Reports screen
  ([ADR-043](#adr-043), spec 04 § Reports), which serves it by authorization-first repo fan-out
  over GSI2 under a read budget; this sample stays as the health-screen figure rather than a
  second source of truth, and both now share one billable-time definition so they cannot
  disagree about what a job cost.
- **The cost sample's unit is a JOB, not a workflow run** (review fix). The run store is keyed
  `(repoId, runId, jobId)` (ADR-009/ADR-029), so a 3-variant matrix workflow is three rows.
  `CostSummary` originally called its counter `runs`, and the Dashboard rendered it as
  "3 finished run(s)" for ONE workflow and divided the total by 3 for a "mean per run" — a
  denominator off by the matrix width. The summed spend was always right; only the count and the
  mean lied. The field is `jobs` (and `byFlavor[f].jobs`), and the Dashboard says so, because
  grouping by `(repoId, runId)` here would misrepresent the sample in the other direction: the
  sample is a bounded page of job rows, so a run whose jobs straddle the page boundary would be
  priced as a complete run when it is not — the same partial-window problem ADR-029 solved on
  Runs with an explicit flag. Per-workflow-run cost is **still not delivered by either surface**:
  the Reports screen ([ADR-043](#adr-043)) ships the windowed, groupable report but its counting
  unit is also the job — its dimensions are repo/flavor/workflow/status/time, with no `run` — so a
  true per-workflow-run figure remains future work.
**Consequences**: metric emission cannot fail a provision (`emitMetrics` swallows everything —
telemetry is best-effort by construction). Alarm thresholds and λ error tolerances differ per
environment (ADR-033). Anyone adding a metric must keep the emitter's dimension set and the
alarm's `dimensionsMap` in sync; `test/metrics.test.mjs` and `test/observability.test.mjs`
assert the pairing rather than leaving it to review.

## ADR-033 — Per-environment config module; `prod` hardens retention and removal (M5)
**Status**: Accepted (v1) · refines spec 05 § Environments · builds on [ADR-018](#adr-018)
**Context**: M1–M4 hardcoded one deployment shape: 2-week log retention, `RemovalPolicy.DESTROY`
on every log group, fixed Provision concurrency, no alarm subscription. That is correct for
`dev` and wrong for `prod` — an incident review needs logs older than two weeks, and a stack
rollback must not delete the evidence of the failure that caused it.
**Decision**: a single `lib/env-config.ts` returns the knobs that legitimately differ by
environment — log retention (Lambda + run logs), log removal policy, Provision/broker reserved
concurrency, run-row retention, alarm thresholds, tracing, alarm email, and the auto-rewrite
flag. `prod` retains log groups and keeps 3-month Lambda / 1-month run-log retention; `dev`
stays cheap and disposable. **An unknown env name (a personal sandbox like `jsam-dev`) gets the
dev shape** — never prod's, so a typo cannot create retained resources.
Every value is a plain constant: no context lookups, so credential-less `cdk synth` (the CI
gate, ADR-018) keeps working.
**Why not one account with stage prefixes**: spec 05 already commits to `dev`/`prod` as separate
AWS accounts, and ADR-018 pins the deploy target per checkout. This module deliberately does
**not** try to make one account host both — it only varies the knobs, while account isolation
stays the real boundary (separate GitHub App, separate secrets, separate quota). That boundary
is an operational convention: ADR-018 checks a pin against the ambient credentials, it does not
bind an env NAME to an account, so co-tenanting `dev` and `prod` is possible (names are
`env`-suffixed so it would not collide) and simply forfeits the isolation.
**Wiring note (both directions matter)**: a config knob that nothing reads is worse than no
knob — the docs then describe behaviour the system does not have. Two were caught in review and
wired: `runRetentionDays` reaches the run store as `RUN_RETENTION_DAYS` on **every** λ that
writes run rows (Ingest, Provision, Reaper — if they disagreed, a row's retention would depend
on which one wrote it last), falling back to 90 days when unset so pre-M5 deployments keep
today's behaviour; and `runLogRetention` is applied to the per-run microVM log group in
`ControlStack` — the microVM exec role holds `logs:CreateLogGroup`, so a group with no policy
is auto-created with `NEVER_EXPIRE` and job logs accumulate forever.
**That policy is set with `logs.LogRetention`, not `logs.LogGroup`** (second review fix). Every
environment deployed before M5 already HAS `/aws/lambda/microvms/runs/lca-<env>`, created by the
launch path itself. A `logs.LogGroup` would attempt a CREATE and fail the ControlStack update
with `ResourceAlreadyExistsException`, rolling M5 back — M5 would have been undeployable to the
existing dev account without deleting live job logs by hand. `LogRetention` is a custom resource
that PUTs the retention policy, creating the group only when absent and adopting it when present.
Its removal policy is pinned `RETAIN` regardless of env: the group holds customers' job logs and
is written by the launch path, so it is not this stack's to delete.
**Consequences**: stack constructors now take a required `config` prop (call sites and tests
updated). `prod` log groups survive stack deletion and must be cleaned up deliberately —
intentional, and the same trade DataStack already made for the table. Auto-rewrite is `false`
in the base config for **every** environment including prod (ADR-031), so enabling it is always
an explicit deploy-time act.

## ADR-034 — Settings shows verified evidence, and platform config writes go through a control-plane broker (M4)
**Status**: Accepted (v1) · extends [ADR-025](#adr-025), honors [ADR-027](#adr-027)
**Context**: the M4 Settings screen listed SSM parameter paths with a present/absent flag.
That is the wrong abstraction twice over. It leaks an implementation detail an operator should
never have to reason about (`/lca/dev/github/app-pem`), and — worse — **presence is not
evidence**. `webhook-secret: set ✓` is green when the secret at GitHub was rotated and every
delivery is now failing its HMAC check; `app-pem: set ✓` is green when the stored key is
corrupt or belongs to a deleted App. The screen also had no mutating actions, so rotating an
App or changing the claimed runner labels meant hand-running `npm run app:create` or an `aws
ssm put-parameter` against production.

Making it evidence-based needs the App private key (App JWT → `GET /app`, `/app/installations`,
`/app/hook/config`, `/app/hook/deliveries`), and making it mutable needs `ssm:PutParameter` on
SecureString paths. ADR-025 deliberately denies the Mgmt λ **both**: it is the internet-facing,
cookie-authenticated surface, and it holds no grant for the PEM precisely so no console bug can
leak it. ADR-027 separately rejected "have the Mgmt λ mutate the runner-label config" as
widening its IAM and coupling planes.

**Decision**: keep the console λ read-mostly and move the authority into a new single-purpose
control-plane function, `src/appcfg/` (`lca-<env>-appcfg`), reachable ONLY via
`lambda:InvokeFunction` on its exact ARN — the same containment shape ADR-021 uses for
microVMs. The console λ gains **no** PEM read and **no** `ssm:PutParameter` of any kind.

The broker owns four actions: `status` (live linkage + webhook evidence), `relink`,
`rollback`, `setRunnerLabels`, `redeliver`. Settings then reports:
- **App linkage** verified live via `GET /app` — a green badge proves the *stored* credentials
  authenticate, and a stored `app-id` disagreeing with the key's App is flagged;
- **installations** from GitHub's own listing, cross-referenced with our install store so a
  missed `installation` webhook surfaces instead of silently diverging;
- **runner labels** as the effective list, not a parameter path;
- **webhook health** from both directions: a `CONFIG#WEBHOOK / LAST` heartbeat row Ingest
  writes per verified delivery (plus a separate signature-rejection counter) AND GitHub's
  delivery log. `healthy` requires positive evidence and no contradiction; everything ambiguous
  is `unknown`.
SSM paths survive only in a collapsed diagnostics section.

**Relink is verify → snapshot → write → re-verify → sync-hook → auto-undo.** Credentials are
validated against GitHub *before* any write, so a typo cannot take the environment offline. The
rollback handle is a set of SSM parameter **version numbers** plus the list of parameters the
relink **created**: the previous values stay in SSM's own parameter history and are never copied
into a Lambda, a log, or a DynamoDB row. Three edge cases are handled explicitly, because each
would otherwise leave a broken environment that reads as healthy:

- **A parameter this attempt created has no version to restore.** Undo therefore *deletes* such
  a parameter rather than trying to re-put a version that never existed. Without this, a
  first-link that fails part-way strands a partial credential set in SSM and reports rollback
  failure — the verify→write→undo contract has to hold on a fresh environment too.
- **A *successful* first link must be undoable too.** Its `replacedVersions` is empty, because
  nothing existed to replace, so the result also carries `createdParams` and `rollback` accepts a
  `remove` list constrained to the same credential allow-list. A rollback handle made only of
  versions would leave the operator's rollback button a silent no-op on exactly the environment
  most likely to need it.
- **The webhook secret has two homes.** Storing a rotated `webhook-secret` in SSM alone leaves
  GitHub signing with the previous value, so Ingest's HMAC check rejects every subsequent
  delivery with 401 and the environment goes silent while every credential badge reads green. The
  relink therefore also pushes the secret (and this deployment's receiver URL) to GitHub via
  `PATCH /app/hook/config`. When the secret **changed** and that push fails, the relink **fails
  closed**: it is rolled back and refused. GitHub does not retry a delivery that failed
  verification, so the jobs lost in a desync window are lost, not delayed — a `hookSynced: false`
  warning on a green-looking relink is not a proportionate answer to a total claim outage. An
  Enterprise/org-hook App that genuinely does not own its hook config is still supported, but the
  operator must set the secret at GitHub and confirm explicitly (`allowHookDesync: true`), which
  the console offers directly from the refusal. When the submitted secret is **unchanged**, GitHub
  and Ingest still agree whatever the hook call did, so the failure stays advisory.

An explicit rollback reads **every** historical value before writing any of them. A sequential
read-then-write loop that faulted midway would leave a mixed credential set — some parameters
restored, the rest still on the replacement values — and, unlike the relink path, there is no
snapshot left to compensate from.

Intake is **write-only** — the response carries presence + verification outcome, never a value,
and validation errors never quote a submitted credential.

**Why**: concentrating secret-read + secret-write in one control-plane function with a
single caller keeps the blast radius auditable in IAM rather than in prose, and preserves both
ADR-025's boundary and ADR-027's rejection of console-side config mutation. Alternatives
rejected: (a) granting the Mgmt λ the PEM + `PutParameter` — puts write authority over every
platform secret behind an internet-facing surface, exactly what ADR-025 exists to prevent;
(b) orchestrating the manifest flow only (console hands off to `npm run app:create`) — leaves
the operator hand-running a script against production and gives no verification or rollback;
(c) storing a copy of the previous credentials to enable rollback — a second at-rest copy of
every secret, strictly worse than reading SSM's own version history.

**Consequences**: `ssm:PutParameter` now exists in the platform where it did not before. Its
scope is pinned in the synthesized template (`test/mgmt-stack.test.mjs`) to exactly the five
credential parameters plus `app-slug` and `config/runner-labels` — specifically **not**
`mgmt/session-secret` (writing it would let the broker forge operator sessions) and **not** the
image ARNs. `ssm:DeleteParameter` is scoped to the same set (needed for the create-then-fail undo
above). The broker's mutating actions are serialized by a conditional-write lock row
(`CONFIG#LOCK`, `acquireConfigLock`), because concurrent relinks could interleave writes into a
credential set no rollback snapshot describes. A `reservedConcurrentExecutions: 1` cap was
considered and **rejected**: it would also serialize the read path (`status`), which the Settings
screen polls every 15 s, so two operators with the screen open would throttle each other into a
blank view. The lock carries a TTL above the broker's timeout so a crashed holder cannot wedge
config changes, and the broker's `dynamodb:UpdateItem` grant is condition-scoped to `CONFIG#*`
leading keys so it can reach only audit + lock rows. The broker's timeout (25 s) is deliberately
below the Mgmt λ's 29 s API Gateway cap: a broker that outlived the caller would complete a
relink whose `replacedVersions` rollback handle the operator never received. Its log group keeps
3 months (credential changes are audit-relevant). A `assertNoSecrets` shape guard
(`src/shared/redact.ts`) scans every broker/settings payload for PEM blocks and GitHub token
shapes and **throws** rather than serving them, so a future field addition cannot quietly
become a leak. Because the shape guard cannot recognize an *opaque* secret (a webhook secret or
OAuth client secret is just a high-entropy string), the relink path additionally redacts the
submitted plaintexts by **literal value** from every response string and log line
(`redactLiterals`), and `githubJson` no longer echoes GitHub response bodies into error text —
only the HTTP status, GitHub's request id, and GitHub's own `message` field, itself
literal-redacted. Ingest takes one extra fixed-key `UpdateItem` per delivery for the heartbeat,
best-effort and off the enqueue critical path — a failed heartbeat degrades the screen, never a
webhook. The *rejection* counter is the one heartbeat write reachable before authentication (the
webhook endpoint is public and the signature check is what rejects an anonymous caller), so it is
rate-bounded to one write per minute by a condition on the row — enough to make a secret mismatch
visible without giving an anonymous caller a write amplifier. `/app/hook/config` and
`/app/hook/deliveries` require the App to own its hook config; where it does not (some
Enterprise/org-hook setups) the screen degrades to heartbeat-only evidence and says why.

Three further consequences of that design, each pinned by a test:

- **The App's JWT rate budget is shared with job provisioning.** `status` costs four
  App-JWT calls and the Settings screen polls it, while the same 5,000 requests/hour budget is
  what Provision spends minting an installation token per job. `status` is therefore cached at
  **two** levels for 30 s (poll interval is 15 s): in-memory per broker container, and — because
  `GET /api/settings` is readable by ANY authenticated session (ADR-035) and concurrent reads
  scale the broker out to containers whose in-memory caches are all cold — in a shared
  `CONFIG#STATUS / LINKAGE` row, so the bound is platform-wide rather than per-container. The row
  holds the already-redacted linkage payload (`assertNoSecrets` runs before the write and again
  on read-back, since the row is treated as untrusted platform state). Any mutation clears both
  levels and **bumps an invalidation generation** on that row; a `status` computation captures the
  generation before it starts and publishes conditionally on it. Clearing alone is not enough: the
  four GitHub round-trips take long enough for a relink to land midway, and an unconditional
  publish would then overwrite that relink's invalidation with a pre-change snapshot and serve it
  to every container for the full TTL. A timestamp cannot express this, because the stale write is
  genuinely the newer one. A DynamoDB fault on either cache path degrades to
  a live GitHub read rather than failing the screen. This is why the broker's `CONFIG#*`-scoped
  DynamoDB grant includes `GetItem` alongside `UpdateItem`.
- **Rotating the webhook secret has an Ingest cache window.** A warm Ingest container keeps
  verifying against the PREVIOUS webhook secret until its cached copy expires — while GitHub
  already signs with the new one. GitHub does **not** retry a delivery that failed verification,
  so every `workflow_job` in that window would be lost silently, and Settings would report
  `degraded` for a rotation that actually succeeded. Two bounds, and the second is the guarantee:
  Ingest re-reads the secret **uncached once** before rejecting a signed-but-unverified delivery
  (`verifyWithRotation`), which recovers on the FIRST failing delivery; and the secret's own read
  carries a 30 s TTL (`WEBHOOK_SECRET_TTL_MS`) rather than `getParam`'s 5-minute default. The
  re-read alone is not sufficient, because it is the one SSM call reachable before authentication
  and is therefore rate-bounded per container (30 s) — an anonymous caller posting junk with a
  well-formed `sha256=` prefix once per window can keep that window spent, so GitHub's real
  delivery would find it throttled and be rejected. The TTL removes that dependency: worst-case
  staleness is 30 s whether or not the re-read gets to fire. The re-read is additionally skipped
  entirely for an absent/malformed `sha256=` signature, short-circuited when the stored value is
  unchanged, and degrades to rejection (never a 5xx) if the read faults. Both bounds are pinned by
  `test/ingest-secret-rotation.test.mjs`.
- **Losing the config lock is retryable, not a rejection.** The broker returns `busy` and the
  management API answers **503 with `Retry-After`**, rather than the 422/502 a real credential or
  upstream failure gets. The lock holder is `actor:uuid`, not `actor:timestamp`: a
  double-submitted form by one operator inside a millisecond would otherwise share a holder
  string and the first completion would release the second's lock.
- **Rollback must restore GitHub's hook config too.** Restoring the SSM credential versions
  alone leaves GitHub signing with the *relinked* App's webhook secret while Ingest verifies
  against the restored one — every delivery 401s, which is exactly the silent outage the relink
  path's hook sync exists to prevent. Rollback re-pushes the restored secret and reports
  `hookSynced`. Relatedly, the non-atomic `app-slug` write happens only AFTER post-write
  verification passes, so a rolled-back environment does not keep advertising the slug of an App
  whose credentials are no longer stored — and rollback re-points `app-slug` at the App the
  *restored* credentials authenticate as, since the slug is not a credential and therefore carries
  no version in the operator's rollback snapshot. That re-point is best-effort and skipped when
  the restored credentials do not verify (`verified: false` is already the signal that the
  rollback is incomplete; there is no authoritative slug to write).
- **The label-impact preview must mirror ALL of Ingest's claim gates, not just `shouldClaim`.**
  Ingest applies two further refusals downstream of the label match: the repo opt-out
  (`isRepoOptedOut` — `enabled === false` **or** `mode === 'off'`) and the compat gate (a job
  whose stored analysis is `eligible: false` is left to GitHub-hosted whatever its labels). A
  preview that ignores them over-reports movement — promising a takeover of jobs the control
  plane will keep refusing — which defeats the whole point of requiring a preview before Apply.
  The scan therefore reuses Ingest's own `isRepoOptedOut` predicate rather than an inlined
  `enabled !== false`, and `buildLabelImpact` skips ineligible jobs while still counting jobs with
  no stored analysis (Ingest fails open there).
- **A label change also has an Ingest cache window.** `getParam`'s 5-minute default would leave a
  warm container claiming against the PREVIOUS label set for minutes after the write, while the
  UI says the change takes effect on the next `workflow_job` delivery. Unlike the webhook secret
  there is no failure signal to trigger a re-read from — an unclaimed job simply runs on
  GitHub-hosted and nothing reports it — so the bound is the TTL itself: the claimed-label read
  uses a 30 s TTL (`RUNNER_LABELS_TTL_MS`). Labels are a non-secret `String`, so the cost is one
  extra `GetParameter` per container per 30 s on the webhook path.

## ADR-035 — Platform-wide settings need their own fail-closed allow-list, not installation admin rights (M4)
**Status**: Accepted (v1) · follows [ADR-022](#adr-022), [ADR-034](#adr-034)
**Context**: every existing authorization decision in the console derives from
`canAdminInstallation` — GitHub's own answer to "may this person administer this installation"
(ADR-022). That is the right question for repo config, and it deliberately avoids interpreting
org roles ourselves. It is the **wrong** question for the ADR-034 mutations. One environment can
host several installations from unrelated accounts; re-pointing the GitHub App credentials or
changing the claimed runner labels affects **all** of them. Under installation-derived
authorization, an admin of any one installation could rotate the whole platform's credentials
or stop every other tenant's jobs from being claimed.
**Decision**: platform mutations require membership in an explicit allow-list,
`/lca/<env>/config/platform-admins` (comma-separated GitHub logins), checked by
`canAdminPlatform` — a predicate distinct from `canAdminInstallation`. It **fails closed**: an
unset or empty list authorizes nobody, and the API answers 403 naming the parameter to set.
`GET /api/settings` stays readable by any session (it exposes no secrets), and returns
`canAdminPlatform` so the UI can render the actions as unavailable rather than failing on click.
**Why**: GitHub has no concept of "administrator of this deployment", so the platform must hold
that fact itself. Failing closed is the only safe default — the alternative (treat the first
logged-in operator, or any installation admin, as a platform admin) grants environment-wide
authority by accident on a fresh deploy. Alternatives rejected: deriving it from the account
that owns the App (unavailable for user-owned Apps, and wrong for shared orgs); a DynamoDB
admin table (a second source of truth needing its own bootstrap path, when the config parameter
is already the platform's out-of-band convention per ADR-008).
**Consequences**: one more out-of-band parameter to create at deploy time; without it Settings
is read-only. It is a plain `String`, not a SecureString — a list of GitHub logins is not a
secret, and the Mgmt λ reads it directly (alongside `config/runner-labels`) rather than through
the broker. Revocation is a parameter edit, effective on the next request (the Mgmt λ reads it
with `ttlMs=0`, so no cached grant survives). Pinned by `test/mgmt-settings.test.mjs`.

`GET /api/settings` being readable by any session is **not** the same as returning everything to
every session. Two of its blocks are not environment-level facts and are scoped per session
(`scopeSettingsView`, pure + unit-tested):

- **installations** name other tenants (account login + installation id). Any GitHub user can
  complete the OAuth dance — and a zero-grant session is minted on purpose so the Setup screen is
  reachable (ADR-022) — so an unscoped list would let an authenticated stranger enumerate every
  org/user that installed the App. It is filtered to the session's own grants, matching
  `GET /api/installations`.
- **recentChanges** is the operator audit trail (who changed what, when) and is platform-admin
  only.

Platform admins receive both in full: they already hold environment-wide authority, and
reviewing a relink needs the complete picture. Everything else — env/region, App linkage,
effective labels, webhook evidence, flavors, diagnostics — stays visible so a fresh environment
can still show its own state, which is the whole point of the screen.

## ADR-036 — Vanity console domain: config-derived origin + a us-east-1 cert stack (M5)
**Status**: Accepted (v1) · supersedes the two-pass `publicOrigin` bootstrap in
[ADR-024](#adr-024)
**Context**: The dev console shipped on CloudFront's generated name
(`https://<id>.cloudfront.net`). That name is not cosmetic — it is load-bearing in three
coupled places, all of which break if the distribution is ever replaced:
1. `PUBLIC_ORIGIN` on the Mgmt λ (OAuth redirect URI + post-login redirect),
2. the GitHub App's OAuth **callback URL**, and
3. the first-party session cookie's origin (ADR-024).
(2) is the expensive one: GitHub exposes **no REST endpoint for App settings** (verified
2026-07-28 — `PATCH /app` does not exist), so a domain change is a browser-only edit and
login stays broken until a human performs it. The generated name is also only knowable
*after* WebStack's first deploy, which is the sole reason ADR-024 required a second
`-c publicOrigin=...` deploy pass.
**Decision**: give the console a **stable vanity hostname** and make the origin a
**config input resolved at synth time**.
- **Scheme** (`lib/console-domain.ts`): prod owns the bare project label, other envs are
  prefixed — `lambdaciactions.<zone>` for prod, `<env>.lambdaciactions.<zone>` otherwise.
  Prod therefore gets its permanent name on its **first** deploy, so a raw-CloudFront
  callback URL is never registered for prod at all. `LCA_CONSOLE_DOMAIN` overrides the
  scheme when a hostname must be exact.
- **Config location**: `.env.local` (the same machine-local, gitignored file as the ADR-018
  deploy pin), keys `LCA_CONSOLE_HOSTED_ZONE_ID` + `LCA_CONSOLE_ZONE_NAME`, each overridable
  by `-c consoleHostedZoneId=` / `-c consoleZoneName=` / `-c consoleDomain=`. Not checked in:
  a hosted zone is an account-specific resource.
- **Certificate**: its own stack, `LCA-Cert-<env>`, with `env.region` **hard-pinned to
  us-east-1** and a constructor assertion that refuses any other region. CloudFront accepts
  viewer certs only from us-east-1 regardless of where the distribution's stack lives.
  WebStack consumes the ARN via `crossRegionReferences: true` on both stacks. Validation is
  DNS against the same public zone that holds the alias, so issuance is hands-off.
- **Alias**: `domainNames` + `certificate` on the distribution, plus **A *and* AAAA** alias
  records. Both zone references use `fromHostedZoneAttributes` (id + name), never
  `fromLookup`, so credential-less `cdk synth` keeps working (ADR-018's CI exemption).
- **Fallback**: with no `LCA_CONSOLE_*` config, `resolveConsoleDomain` returns `null` and
  every custom-domain resource is skipped — a fresh account owning no domain still deploys
  on the raw CloudFront name, and the ADR-024 two-pass bootstrap still applies there.
**Why**: the origin becomes knowable before any resource exists, which (a) removes the
two-pass deploy for domained envs — `PUBLIC_ORIGIN` is just config now — and (b) decouples
all three coupling points from CloudFront's generated name, so a future distribution
replacement no longer requires a browser edit to restore login. The us-east-1 pin is
enforced in code because the wrong region is the classic trap here: it synths cleanly and
fails at `cdk deploy` on the distribution update, *after* the cert has been issued.
**Consequences**:
- Config is **all-or-nothing**: a half-configured domain (zone id without zone name, or a
  hostname outside the zone) **throws** rather than falling back. A silent fallback is the
  dangerous case — the distribution would come up with no alias while `PUBLIC_ORIGIN`
  pointed at the vanity name, and login would fail with a misleading `invalid OAuth state`
  that reads like a cookie bug.
- The cert stack is the repo's **first** stack outside `LCA_DEPLOY_REGION`, so a domained env
  needs the CDK bootstrap stack in **us-east-1** too. Missing it fails the deploy instantly
  (bootstrap-version SSM parameter not found) before ACM does anything; docs/DEPLOY-M4.md
  Phase 2 carries the one-time `cdk bootstrap aws://<account>/us-east-1`. The no-domain path
  keeps every stack in one region and needs no extra bootstrap.
- First deploy of a new hostname is **slower**: ACM writes a `_<hash>` CNAME and polls, and
  CloudFormation blocks the cert until `ISSUED`, so the distribution can never come up with
  an alias whose cert is pending. A cert stuck in `PENDING_VALIDATION` means the CNAME never
  resolved publicly (wrong zone, or a zone that is not authoritative).
- Migration off an existing raw-CloudFront origin requires **both** callbacks registered on
  the App simultaneously — add the vanity one, flip `PUBLIC_ORIGIN`, verify, then remove the
  old one. This is possible because a GitHub App accepts up to **10** callback URLs (matched
  exactly; OAuth Apps allow only one, with prefix matching). `-c publicOrigin=` still wins
  over config precisely so an operator can pin a transitional origin mid-flip. Removing the
  old entry first breaks login instantly.
- During that flip the console is reachable on **two** hosts but only **one** can complete
  OAuth: the `state` cookie is host-only (no `Domain` attribute) and `redirect_uri` is built
  from the single `PUBLIC_ORIGIN`, so a login started on the other host returns to a callback
  that never received the cookie → `invalid OAuth state`. Operators must stay on whichever
  host `PUBLIC_ORIGIN` names until the flip completes; docs/DEPLOY-M4.md orders the steps
  accordingly. Widening the cookie to the parent domain would fix the window at the cost of
  scoping the session above the console — rejected.
- Existing sessions do not survive the origin flip: the session cookie is scoped to the old
  host, so operators re-authenticate once. That is the same revocation lever as rotating the
  session secret (ADR-022), not a new failure mode.
- **Apex override caveat**: `LCA_CONSOLE_DOMAIN` may name the zone apex (`example.com`), and
  the alias records are then created at the apex (`recordName: undefined`). Two consequences
  the derived scheme does not have: (a) the console's HSTS header carries
  `includeSubdomains` with a one-year max-age, so serving the console at the apex pins
  **every** host in that zone to HTTPS in any browser that has loaded it — including
  unrelated subdomains; (b) an apex zone typically already carries other records. The derived
  scheme puts the console under its own `lambdaciactions` label precisely so the HSTS scope
  and the record namespace stay inside the console's own subtree. Use an apex override only
  for a zone dedicated to this console.
- `test/console-domain.test.mjs` pins the scheme + the refuse-on-partial-config behavior;
  `test/console-domain-infra.test.mjs` pins the us-east-1 assertion, the A+AAAA pair, the
  apex-override record shape, and the no-domain fallback (no alias, no cert, no records).
## ADR-037 — Installation enumeration reconciles unindexed rows on read (M4 fix)
**Status**: Accepted (v1) · follows [ADR-009](#adr-009), [ADR-022](#adr-022)
**Context**: `listInstallations()` enumerates installations from the GSI1 `INSTALLS`
partition so the console never table-scans. The `gsi1pk=INSTALLS` / `gsi1sk=<accountLogin>`
write only arrived with M4 (commit 63069ff, 2026-07-28), so an INSTALL row written by M2-era
code carries no index keys and is **invisible** to that query. Observed on dev: installation
`146431062` (`jsamuel1`) served 30 granted repos and claimed jobs normally — the ingest hot
path reads by primary key (`getRepo`) — while `GET /api/installations` returned `[]` and the
Setup screen rendered "You have no LambdaCIActions App installations". GitHub does not
re-send `installation.created` for an existing install, so nothing re-writes the row: the
only workaround was uninstall/reinstall. DEPLOY-M4's claim that this "self-heals with
activity" was wrong — job activity never touches the installation row.
**Decision**: two parts.
1. **Reconcile-on-read, bounded by the caller's grants.** `listInstallations(reconcileIds)`
   keeps the GSI1 query as the primary path, then — for any id in `reconcileIds` the index
   did not return — does a single `GetItem` by primary key and, when the row exists without
   `gsi1pk`, repairs it in place (`SET gsi1pk, gsi1sk` conditional on
   `attribute_not_exists(gsi1pk)`). The Mgmt handler passes `session.installations`, i.e.
   exactly the installations the operator is *already* authorized to see (ADR-022 freezes
   these at login from GitHub, independent of our table).
2. **A one-shot backfill** — `npm run backfill:installs` (`scripts/backfill-installs.mjs`,
   dry-run by default) stamps every unindexed installation row, so an existing environment is
   fully repaired in one command rather than lazily per operator login. Both paths select on
   the same signal — the key shape (`INSTALL#<id>` / `INSTALL`) plus a missing `gsi1pk`, not
   the optional `entity` attribute — so neither can repair a row the other cannot.
**Why not a fallback scan**: the obvious alternative — "if the GSI query comes back empty,
scan with a filter" — is triggered by the wrong signal. Empty-index is not the failure mode;
*partially* indexed is (one M4-era install indexed, one M2-era install not), and a scan that
only fires on total emptiness still hides the legacy row. Firing the scan unconditionally
puts a table scan on a polled console endpoint (ADR-026 polls), and its cost grows with run
history, which dwarfs installation count. The grant list gives an exact, already-authorized
candidate set: worst case one `GetItem` per installation the operator administers (a handful),
paid once because the read self-heals. Reconcile also needs no new IAM — the Mgmt λ already
holds `dynamodb:UpdateItem` for repo config (ADR-025), and this write touches only index
attributes on a row keyed by an id the session is authorized for.
**Consequences**: the invariant "an installation the platform is demonstrably serving is
never absent from the console" holds for any operator with a grant for it, even on an
un-backfilled environment. A legacy installation nobody holds a grant for stays invisible
until the backfill runs — acceptable, since nobody can view it anyway. A repair failure is
logged and swallowed: the row is already in the response, so the read must not fail. The
repair is idempotent and concurrency-safe (conditional write; a losing racer is a no-op).
`upsertInstallation` now stamps the keys via the shared `installGsi1Keys()` helper, and
`test/install-store-gsi1.test.mjs` pins that every write path carries them — the regression
class here is "a new write path forgets the index stamp". The reconciled list is re-sorted by
account login so a recovered row occupies the same position it will hold once the index alone
serves it — by **UTF-8 byte order** (`byGsi1sk`), not locale collation, since
that is how DynamoDB orders a String sort key: locale puts `abc` before `Acme`, the index does
the reverse, and the mismatch would be the same row-jump wearing a disguise.

> **ADR numbering note.** This block was originally authored as 030..033 and has been renumbered
> to **038..041** to vacate a collision: the concurrent branch `kermes/task-tidal-hawk` claims
> 030..033 for entirely different subjects (adopt-mode label claiming, the auto-rewrite PR, EMF
> metrics, the per-environment config module). ADR numbers are a shared mutable namespace, and
> 038+ was the lowest free range at the time of renumbering (`kermes/task-nervous-mountain`
> holds 034/035, `kermes/task-admiring-beetle` 036, `kermes/task-bouncing-toad` 037). Renumbering
> unconditionally — rather than deferring it to whichever branch lands second — means neither
> branch has to renumber at merge time. If a branch holding 034..037 is abandoned the gap stays;
> a gap in the sequence is cheaper than a duplicate number.

## ADR-038 — Flavor `vcpu` is descriptive; only `minimumMemoryInMiB` is requestable (M5)
**Status**: Accepted (v1) · corrects the flavor-size claims in [spec 02](specs/02-microvm-runners.md) and the cost model in [spec 04](specs/04-web-ui.md)
**Context**: `microvm/flavors.json` carries `vcpu` + `memoryMb` per flavor, spec 02's flavor
table advertises "2 / 4 GB" and "4 / 8 GB", `docs/VERIFY-M3.md` prices runs off those pairs,
and `src/mgmt/views.ts` derives `flavorRatePerMinute` from `vcpu * VCPU_USD_PER_MINUTE +
GB * GB_USD_PER_MINUTE`. Checked against the GA `lambda-microvms` API surface (CLI 2.35.17+,
API 2025-09-09):
- **`run-microvm` has no sizing parameter at all** — the full option set is
  `--ingress/egress-network-connectors --image-identifier --image-version
  --execution-role-arn --idle-policy --logging --run-hook-payload
  --maximum-duration-in-seconds --client-token`. A VM's shape is fixed by its **image**.
- **`create-microvm-image` accepts `--resources minimumMemoryInMiB` (a single-element list,
  memory only) and `--cpu-configurations architecture=ARM_64`.** There is **no vCPU knob**:
  `cpu-configurations` carries `architecture` alone, whose only permitted value is `ARM_64`.
- `scripts/build-images.mjs` passes **neither**. Every flavor is therefore built at the
  service default shape, and always has been.
Consequence: `vcpu` has never influenced a real microVM, `memoryMb` was equally inert, and
the M3 `docker`-vs-`base` boot/cost deltas were attributed to a "4 vCPU / 8 GB snapshot"
that was never requested. The measured 32–39 s `dockerd` init is real; the "on 4 vCPU
Graviton" qualifier on it is not established.
**Decision**:
1. `build-images.mjs` forwards `--resources minimumMemoryInMiB=<memoryMb>` from the catalog,
   so `memoryMb` becomes the **actual** floor the service honors, and
   `--cpu-configurations architecture=ARM_64` to make the arm64-only hard rule explicit at
   the API rather than implicit in the Dockerfile's `--platform`.
2. `vcpu` is **retained but redocumented as descriptive** — an operator-facing indication of
   the shape a flavor is *intended* for and the second sort key in
   `smallestWithCapability`. It is NOT a request, and no code may present it as provisioned
   capacity. Renaming it now would churn the catalog, the `FlavorDef` type, the API view and
   the UI for no behavioral gain; the honest fix is that the one field the API accepts is
   actually sent.
3. The cost model keeps its two-term formula (memory *is* requestable, and microVM quota is
   denominated in total memory of `RUNNING`/`SUSPENDED` VMs per spec 02), but every
   surfaced figure stays labelled an **estimate** — as `estimateCostUsd` already does.
**Why**: silently keeping two size fields where the API accepts one is how the M3 cost table
came to state a shape nobody requested. Sending memory makes the more consequential half
real (it drives both quota consumption and the OOM behavior of a `docker`/`rust` job) at the
cost of one CLI flag.
**Consequences**: the next `npm run build:images` changes the requested memory floor for
every flavor, so it is a **deploy-touching** change and re-baselines boot latency —
`docs/VERIFY-M3.md`'s per-flavor figures predate it and its cost floors should be re-measured
rather than carried forward. `test/image-content.test.mjs` pins that the build script
forwards both flags, and that no flavor `description` advertises a vCPU count — the catalog's
descriptions render verbatim on the console's Flavors screen, so a "4 vCPU / 8 GB" footprint
there contradicts that screen's own footnote in the same view (the `docker` description was
exactly this sweep miss). Revisit if the API later exposes a vCPU request, at which point `vcpu`
becomes requestable and this ADR's point 2 is superseded.

## ADR-039 — Expanded standard flavor set with prebaked runner tool cache (M5)
**Status**: Accepted (v1) · extends the catalog established in [ADR-020](#adr-020)
**Context**: The catalog shipped `base`, `node`, `docker`. Any other language runtime meant a
workflow either used a `setup-*` action (a per-job download on every run) or the repo went
back to GitHub-hosted runners. Adding a runtime today requires a Dockerfile + a catalog entry
+ a Lambda redeploy, because the catalog is a static `import` in three call sites.
**Decision**: add **`python`, `java`, `go`, `rust`** as standard flavors, each a
`Dockerfile.base` clone plus one pinned toolchain layer, and **prebake the GitHub runner tool
cache** (`/opt/hostedtoolcache`, `RUNNER_TOOL_CACHE`) so `actions/setup-python@v5`,
`actions/setup-java@v4`, `actions/setup-go@v5` and `actions/setup-node@v4` resolve from cache
instead of downloading. Deliberately **excluded**:
- **`dotnet`** — the SDK is the largest of the candidates and no verified consumer asked for
  it; snapshot size is a boot-latency and storage cost paid by every job of that flavor.
  Left to the custom-flavor path (ADR-040) until a real workload justifies it.
- A combined "kitchen sink" flavor — it would pay every toolchain's snapshot cost on every
  job. One toolchain per flavor keeps the cost proportional to what the job asked for.
Each new flavor declares a capability equal to its name (`python`, `java`, `go`, `rust`),
keeps the unprivileged `USER runner` entrypoint and **no** `osCapabilities` (only `docker`
gets `ALL`, per ADR-020), and pins toolchain versions rather than tracking `latest` so a
rebuild is reproducible. Expanding the set also forced the label-precedence rule to become
explicit: "most specific wins" was unambiguous while the catalog held one label per length,
but `lambda-ci-python`/`lambda-ci-docker` are both 16 characters and `-node`/`-java`/`-rust`
all 14, so a pure length sort left those ties to `Array#sort` stability — i.e. to the order of
entries in `flavors.json`, where reordering the catalog would silently re-route live jobs.
Equal-specificity ties now break by **flavor name ascending**, which is catalog-order
independent and puts the one collision that matters on its safe side (`python`+`docker` →
`docker`: a present daemon, rather than docker steps failing on a missing socket the labels
said should work). Baked environment variables follow what each action actually does:
`JAVA_HOME` is baked (setup-java `exportVariable`s it, so the action always wins), `GOROOT` is
deliberately **not** (setup-go sets it only for Go < 1.9, so a baked value would override a
job's chosen toolchain and pair its binary with the baked stdlib), and rust's `RUSTUP_HOME` +
`CARGO_HOME` are both runner-writable because `dtolnay/rust-toolchain` and cargo write into
them — safe because a microVM is single-use and runs exactly one job.
**Why**: the wall-clock win is in the tool cache, not the runtime binary — a `setup-python`
download+extract dominates a short job. Prebaking the cache is what makes a flavor faster
than `base` + `setup-*`; without it the flavor only saves the download for jobs that skip the
setup action entirely. Layering on `base` (rather than a shared registry base image) is
forced by the build model: `create-microvm-image` builds a snapshot from one staged
`Dockerfile` in an uploaded context, so each flavor's Dockerfile must be self-contained —
hence the duplicated base layers, which `test/image-content.test.mjs` guards.
**Consequences**: four more images to build, and `npm run build:images` gets proportionally
slower (it is serial per flavor). Signal-driven upgrade still only understands
`needs_docker` — a job that needs Python does **not** auto-upgrade off `base`; label or
`FlavorMap`/`defaultFlavor` selects these. Extending signal inference to language runtimes is
a separate change (it needs parser support for `setup-*` steps and a policy for what to do
when a job needs two runtimes).
One-toolchain-per-flavor also makes the existing docker signal upgrade a **replacement rather
than an addition**, which the pre-expansion catalog hid: upgrading `base` → `docker` lost
nothing, but upgrading `python` → `docker` for a `services:` block hands the job a daemon and
**no Python**, so it dies at its first `pip` step with a command-not-found after having asked
for Python explicitly. The upgrade still happens (a missing daemon is the harder failure), but
it is no longer silent: `resolveFlavor`'s reason names the dropped capabilities and `compat`
raises `toolchain-dropped`, both derived from the catalog. A job that genuinely needs a runtime
*and* a daemon wants a custom flavor (ADR-040) or an in-job toolchain install — the standard set
deliberately does not carry a `python`+`docker` image. The pinned versions are now a **patch-day obligation**: they
age silently, and a stale pin is invisible until a workflow needs a newer runtime.
The pin rule covers **package managers too**, not just the language runtime: `corepack prepare
pnpm@latest` / `npm install -g npm@latest` resolve at build time, so a floating tag beside a
pinned runtime is a half-kept promise — `test/image-content.test.mjs` now rejects any `@latest`
/`@stable`/`@next` install in a flavor Dockerfile.
A prebaked runtime is also not a self-sufficient job environment: `node`, `python`, `go` and
`rust` carry `build-essential`, because node-gyp (npm's fallback whenever a dependency ships no
prebuilt binary), a source-only sdist (arm64 wheels are still commonly absent), cgo, and cargo's
link step all shell out to a compiler the shared apt line does not install. Verified in a
container: that line yields no `gcc`/`cc`/`g++`/`make`/`ld`. Without it the failure surfaces
mid-job as `command 'gcc' failed` / `gyp ERR! ... not found: make`, after the download cost is
already paid. `base`/`java`/`docker` skip it deliberately — `base` carries no runtime to compile
against, Temurin builds consume published JARs, and a docker job compiles inside its own
container; it is ~200 MB of snapshot each.
And a new flavor is **not reachable from its label until
`/lca/<env>/config/runner-labels` lists it**: `shouldClaim` is an allowlist consulted *before*
resolution, seeded by hand per DEPLOY-M1, so an omitted label makes those jobs sit queued on
GitHub with a 202 `claimed:false` and nothing logged as an error. That seed is now pinned
against the catalog by `test/filter.test.mjs`.

## ADR-040 — Custom flavors live in the store and are merged over the built-in catalog (M5)
**Status**: Accepted (v1) · shapes work deferred from this milestone
**Context**: An operator cannot bring their own image. The catalog is `import
flavorsCatalog from '../../microvm/flavors.json'` in `src/provision/flavor.ts`,
`src/mgmt/views.ts` and `src/ingest/compat.ts` — compiled into each Lambda bundle at build
time, so it is physically not writable at runtime. Spec 02 has always listed a `custom-*`
row, and the Phase 3 backlog has "custom per-repo images", but nothing implements it.
**Decision**:
1. **Storage** — a per-installation flavor record in the shared table (ADR-009), keyed
   `pk=INSTALL#<installationId>`, `sk=FLAVOR#<name>`, so it shares the installation
   partition that already holds `INSTALL` + `REPO#<repoId>` rows and is enumerable with the
   existing `begins_with` query. The static JSON stays **read-only and build-time**.
2. **Resolution** — the three static imports move behind a resolver that composes
   `builtin ++ custom`. Built-in flavors always win a name collision: a custom flavor whose
   name matches a built-in is **rejected at registration** (not silently shadowed, and not
   silently shadowing) so an operator cannot redefine what `lambda-ci-node` means for their
   jobs. Custom flavors are namespaced `custom-<name>` with labels
   `lambda-ci-custom-<name>`, which makes collision structurally unlikely and keeps the
   most-specific-label rule in `resolveFlavor` intact.
3. **Scope** — a custom flavor is visible only to its own installation. Resolution is
   already per-run (the provisioner knows `installationId`), and cross-tenant flavor
   visibility would leak one operator's image names to another.
4. **Bounds** — registration validates `minimumMemoryInMiB` against the region's microVM
   memory quota (spec 02: quota is total memory of `RUNNING`/`SUSPENDED` VMs) and surfaces
   the derived `flavorRatePerMinute` before save, so an operator sees the per-minute rate of
   the shape they are about to request. Per ADR-038 memory is the only requestable
   dimension, so it is the only one bounds-checked.
5. **Behavior with no custom flavors registered must be byte-identical** to today — the
   resolver returns the built-in catalog and performs no I/O when the installation has no
   flavor rows.
**Why**: making the JSON writable is impossible (it is bundled), and a second static catalog
would duplicate the source of truth. The installation partition is the natural home: the same
partition already carries the config the console writes, and per-installation scoping falls
out of the key rather than needing an authorization filter.
**Consequences**: flavor resolution gains a table read on the provision hot path — it must
degrade to built-in-only on a DynamoDB fault (fail open, matching ADR-027's gates) rather
than failing the launch. `flavorNames()` (used by `validateFlavorMap`/`validateRepoPatch`) and
`buildFlavorViews` become async/installation-scoped, which changes the Mgmt API's validation
surface. Deferred to a follow-up card; this ADR fixes the shape so the standard-set work
(ADR-039) does not have to guess it.

## ADR-041 — A custom flavor is not routable until a smoke run proves it (M5)
**Status**: Accepted (v1) · depends on [ADR-040](#adr-040); reuses the broker from [ADR-021](#adr-021)
**Context**: ADR-019/020 are the case study: the `docker` flavor **built successfully**,
published its image ARN, resolved correctly from its label, and then failed every single job
because nothing in the guest could start `dockerd`. `imageAvailability()` probes only that an
image ARN parameter *exists*. Letting an operator register an arbitrary image and route
production jobs at it with no stronger evidence reproduces that failure mode on demand, in
someone else's repo.
**Decision**: a custom flavor carries a validation state — **`pending → validating → valid |
invalid(reason)`** — and **only `valid` flavors are selectable in a `FlavorMap`, as a
`defaultFlavor`, or resolvable from a label.** An unvalidated flavor resolves as if it did not
exist (falling through to the normal fallback chain) with the reason recorded, so a
half-configured flavor degrades to a working job rather than a failed one. Validation is two
gates:
1. **Static** — `arch === 'arm64'` (AGENTS.md hard rule); the image ARN resolves and is
   readable by the provisioner's role; declared capabilities are drawn from a **closed
   vocabulary** (`docker`, `node`, `python`, `java`, `go`, `rust`) because capabilities feed
   both `smallestWithCapability` upgrades and the `compat` gate — an unknown capability
   string would be silently inert; `minimumMemoryInMiB` within quota bounds (ADR-040).
2. **Smoke run** — launch **one** microVM from the image with a synthetic JIT-registered
   runner and require that the Actions agent registers, executes a trivial job, and the VM
   self-terminates through the ADR-021 hook broker. Static checks alone would have passed the
   broken `docker` image; only executing a job distinguishes "image built" from "image
   works", and only observing self-terminate proves the ADR-021 path is wired.
Re-validation is triggered automatically **when the image ARN changes** (a new ARN is a new
artifact and inherits no evidence) and is manually triggerable from the console.
**Why**: the state machine is the enforcement point rather than advice, because the failure it
prevents is silent at registration time and only visible as other people's red builds.
Terminal `invalid(reason)` — rather than an indefinite retry — keeps a deterministically
broken image from burning microVM quota on a loop.
**Consequences**: registration is no longer synchronous — the console shows progress and a
failure reason, so validation needs its own status surface (a Flavors screen or a Settings
extension). The smoke run **launches a real microVM and registers a real (throwaway) runner**,
so it consumes quota, costs money, and needs a repo to register against; it is therefore
**deploy-touching** and cannot run in a local test. Unit tests can cover the state machine and
the static gates; the smoke run itself is verified against a live environment. Deferred to a
follow-up card together with ADR-040.

> **ADR numbering note.** This block was originally authored as 030..034 and has been renumbered
> to **042..046** to vacate a collision, following the same convention as the 038..041 block
> above. At the time of renumbering 030..033 were claimed by `kermes/task-tidal-hawk` (PR #23),
> 034/035 by `kermes/task-nervous-mountain`, and 036..041 had landed, so 042 was the lowest free
> number. The mapping is 030→042 (phase watermarks), 031→043 (authorization-first aggregation),
> 032→044 (Bedrock model + scoped grant), 033→045 (validated spec emission), 034→046 (ECharts).
> Renumbering unconditionally means neither branch has to renumber at merge time; a gap is
> cheaper than a duplicate number.


## ADR-042 — Phase watermarks on the run row (`provisioningAt` / `runningAt`) (M5)
**Status**: Accepted (v1) · resolves spec 04 OQ-5 · precondition for [ADR-043](#adr-043)
**Context**: M4 priced a run as `wall-clock(createdAt → updatedAt) × flavor rate`. The microVM
service only bills while the VM *runs*, so that figure includes queue time and provisioning
time and is an unbounded overstatement — a job that sat queued for ten minutes and ran for one
was priced at eleven. It also made queue-to-start latency, the single most useful number for
judging whether the platform is keeping up, uncomputable: nothing recorded when a job started.
**Decision**: stamp two ISO timestamps on the run row, inside the SAME guarded `UpdateItem`
that performs the status transition, using `if_not_exists` so each is **write-once**:
`provisioningAt` on first entry to `provisioning`, `runningAt` on first entry to `running`.
`createdAt` already marks `queued` and `updatedAt` the terminal transition, so no third
attribute is needed. Billable time is `runningAt → updatedAt`; queue latency is
`createdAt → runningAt`.
**Why write-once, and why in the transition write**: a `workflow_job` webhook can be delivered
more than once, and `transitionRun` treats a same-status re-write as an idempotent success. A
plain `SET` would let a duplicate `running` delivery push `runningAt` forward — *shrinking*
billable time and *inflating* queue latency, both in the flattering direction, silently.
Riding the existing forward-only condition also means a watermark can never exist for a phase
the run did not actually enter. Rejected: a separate phase-history item per run (doubles write
volume on the hot path for data only reporting reads), and deriving phases from CloudWatch
(the log group is per-env and the correlation is by microVM id, which is stamped later).
**Consequences**: rows created before M5 have no watermarks. Reports must treat that as
**absent, never zero** — `queueLatency` excludes such rows and reports coverage, and `spend`
falls back to wall-clock and labels the row `costBasis: wallClock`. So the cost estimate
improves monotonically as history turns over rather than changing retroactively.
`test/run-store.test.mjs` pins the write-once expression and that terminal/queued transitions
stamp nothing.

## ADR-043 — Reporting aggregates via authorization-first repo fan-out (M5)
**Status**: Accepted (v1) · builds on [ADR-023](#adr-023), [ADR-042](#adr-042)
**Context**: the Reports screen needs spend / counts / duration / failure rate / queue latency
over a time window. The table has no aggregate index: rows are per-job, keyed by
`(repoId, runId, jobId)` and indexed by status/time (GSI1) and repo/time (GSI2). Three designs
were considered: (a) rollup rows written on every run transition, (b) a new time-bucketed GSI,
(c) a bounded query fan-out over GSI2.
**Decision**: **(c) a bounded fan-out, ordered authorization-first.** The Reports code resolves
the operator's visible repos *before* reading anything — from the installation partitions their
session grants — and only queries those GSI2 partitions. `spec.filters.repoIds` can only
*narrow* that set (set intersection); it can never widen it.
**Why**: the deciding factor is authorization, not cost. Every other management read queries a
status/repo index and filters by installation *afterwards* (`collectVisible`, spec 04
§ Authorization). For a list, a missed filter leaks a row. For an **aggregate** it converts a
per-tenant total into a platform-wide one — and unlike a leaked row, a leaked *number* looks
entirely plausible and no one notices. Inverting the order removes the filter that could be
forgotten: a foreign row is never fetched. Rollup rows (a) were rejected because they put a
write on the control-plane hot path for a management-plane read, need a backfill for existing
history, and would themselves have to be keyed per-installation to be safe. A time-bucketed
index (b) was rejected because the bucket partition is shared across tenants, which reproduces
exactly the post-filter hazard this ADR exists to eliminate.
**Consequences**: reads scale with (visible repos × pages), bounded by `MAX_PAGES_PER_REPO`
(20), `PAGE_SIZE` (200) and `MAX_TOTAL_ROWS` (20 000), with concurrency 8. GSI2 is
newest-first, so paging stops at the first row older than the window — a 24 h report costs one
page per repo. Spending a budget sets `complete: false`, which the API returns and the UI
renders as "treat these numbers as a floor"; it never silently truncates. Report windows are
capped at the environment's **actual** terminal-row retention (`RUN_RETENTION_DAYS`, ADR-033:
dev 30, prod 90) rather than a fixed 90, and the Mgmt λ is given that same config value the
control-plane writers stamp the TTL with. A fixed 90-day cap was wrong in a way that mattered:
in a 30-day environment it accepted a window most of which had already aged out of the table,
and the report answered over that partially deleted span while reporting `complete: true` — the
exact silent floor every other budget path here discloses. A preset or explicit window wider
than retention is **rejected with a readable error naming the available presets**, not clamped
(clamping answers a different question than the shared link names), and both the picker's option
list and the assistant's prompt menu are generated from the same number so neither offers a
window the validator would refuse. Width is not the whole cap: an explicit window is **also**
rejected when its `from` predates the retention horizon (`now − RUN_RETENTION_DAYS`), however
narrow it is. A 10-day window 200 days ago is inside every width limit and behind the horizon
entirely, and a report pinned by URL carries `from`/`to` verbatim — so any bookmarked or shared
custom-window report becomes an aged-out one by the passage of time alone, and answering it
`complete: true` over rows the TTL deleted prints "No jobs in this window" about jobs that ran.
The horizon is inclusive, so a window exactly retention-wide resolves at the moment it is built;
it does not stay resolvable forever, since an absolute `from` necessarily crosses a moving
horizon — preset windows are recomputed against `now` on every read and so are immune.
An operator with hundreds of active repos and a 90-day window
is the case this
design serves worst; if that becomes real, rollups keyed *per installation* are the next step.
`test/report-isolation.test.mjs` asserts a foreign partition is never queried, that the
platform-wide total is strictly larger than the tenant total (so the test is actually
isolating), and that a repo granted via two installations is not double-counted.
One consequence of the row budget is not about reads at all: **an export cannot carry it.** A
CSV/JSON download is a single synchronous Lambda response (6 MB cap), and 20 000 job rows measures
3.8–6.5 MiB as CSV and 7.2–9.8 MiB as JSON depending on how long the tenant-controlled
repo/workflow/job names are — so the read budget exceeds the platform's response limit, and the
failure is an invocation error surfacing as a 502 rather than a short file. Exports are therefore
capped separately (`MAX_EXPORT_ROWS` 10 000, with a `MAX_EXPORT_BYTES` 4.5 MB backstop because
names are unbounded and a row has no fixed width), both truncation sources feed the same
`complete` / `X-Report-Complete` disclosure, and the cap is published in the report result so the
UI warns before the download rather than after.

## ADR-044 — Reports assistant on Bedrock: Claude Sonnet, one pinned model, one scoped grant (M5)
**Status**: Accepted (v1) · security boundary in [ADR-045](#adr-045)
**Context**: the Reports screen accepts a natural-language question ("spend by repo last 30
days") and must turn it into a report. The repo had no Bedrock dependency, no model choice, and
no IAM for one.
**Decision**: `@aws-sdk/client-bedrock-runtime` (pinned exact, per repo convention), invoked
from the existing Mgmt λ — not a new function — with `bedrock:InvokeModel` granted on **exactly
one model id** in the deploy region. Default model: `anthropic.claude-3-5-sonnet-20241022-v2:0`.
The id is an **EnvConfig knob** (ADR-033) that flows to the λ as `REPORTS_MODEL_ID` *and* into
the IAM resource ARN from the same value, so the policy and the runtime can never disagree;
`test/mgmt-stack.test.mjs` asserts the stack default equals the handler default (a drift there is
a runtime 403). The NL path is **enabled by default** and switched off per-env with
`-c reportsNl=false`, which also drops the Bedrock grant from the template entirely; the model is
overridden with `-c reportsModel=…`. Both live in EnvConfig rather than as stack props for the
reason ADR-033's wiring note gives — the first cut made them props `bin/lca.ts` never passed, so
this paragraph described a switch no operator could reach, and the only field workaround
(hand-editing the λ's env) breaks the grant and 403s.
**Why Sonnet over Haiku**: the task looks trivial and isn't. Mapping loose phrasing onto the
enumerated metric × dimension × chart catalog in `src/mgmt/reports.ts` plus a time window is a
small *structured* problem where a wrong-but-valid answer is worse than a refusal: an invalid
spec is rejected and the operator sees the picker, but a plausible-but-wrong spec renders a chart
that silently answers a different question. Sonnet's stronger instruction-following buys accuracy
on exactly that
failure mode, and the cost is bounded by `max_tokens: 400`, `temperature: 0`, a system prompt
capped at **3 600 characters (~900 tokens)** and the caps below. That prompt figure is a
test-enforced budget (`MAX_SYSTEM_PROMPT_CHARS`), not an estimate: the prompt is generated from
`METRIC_CATALOG`, so it is the fixed input cost of *every* question and adding a metric — or
widening one metric's prose — raises that bill on a route whose model choice is justified partly
by the bill being small. An earlier revision of this paragraph quoted "~400 tokens" while the
generated prompt was already past 600, which is exactly the drift the test now prevents.
`InvokeModelWithResponseStream` is deliberately NOT
granted — one small JSON object needs no stream.
**Why the existing λ**: a separate Reports λ would need its own DynamoDB read grant, its own
session-secret read, and a second copy of the authorization logic that ADR-043 exists to keep
in one place. The Mgmt λ's posture widens by exactly one action on one resource.
**Cost / abuse controls**: `POST` (never a prefetchable `GET`); question capped at 400 chars and
validated before any spend; per-actor sliding window of 10 invocations/minute keyed on the
server-derived session login; a per-container ceiling of 500 invocations as a crude spend cap.
**And the route does not execute the report.** `/api/reports/ask` returns the validated spec plus
its provenance; the console adopts that spec as picker state, which fetches
`GET /api/reports/run`. Executing in both places ran the authorization fan-out TWICE per question
(up to 2 × `MAX_TOTAL_ROWS` = 40 000 row reads) and discarded the first result, since the console
only ever rendered the deterministic fetch. One executor also means an assistant answer and the
shared URL for it cannot drift apart. Every invocation is logged with the actor, the model id, the
outcome and the question *length* — never its content, which is operator-authored text. A durable
cross-container budget belongs in the run table and is deferred rather than faked.
**Consequences**: the console now has a per-request marginal cost on one interaction it did not
have before, and a Bedrock regional dependency. Throttling, an unconfigured model, or a
malformed response degrade to the manual picker (ADR-045), never to an error page.

## ADR-045 — Generative UI = validated spec emission, never model-authored code (M5)
**Status**: Accepted (v1) · this is the security boundary of the Reports feature
**Context**: "dynamic generative UI" is commonly implemented by having a model emit JSX/HTML/JS
that the frontend evaluates, or SQL that the backend runs. Report data here is
**tenant-controlled**: repo names, workflow names, job names and branch names all originate
from GitHub. Any of it reaching a prompt is untrusted input, and anything the model emits that
gets executed or rendered is an injection sink with a straight path to another tenant's data.
**Decision**: the model **selects from a closed vocabulary and nothing else**. It emits a JSON
report spec — one metric, one dimension and one chart type drawn from the enumerated catalog in
`src/mgmt/reports.ts`, a preset window, and
optional flavor/status filters — which is parsed as data and passed through
`validateReportSpec`, the *same* validator the manual picker's query params go through. The
backend then executes the deterministic report **through the one report route**
(`GET /api/reports/run`); the frontend renders it with pre-built components.
Specifically:
- **No `eval`, no `new Function`, no `dangerouslySetInnerHTML`, no model-authored JS/JSX/HTML**,
  and no model-authored DynamoDB expression. Unknown fields are rejected, not ignored, so a
  spec carrying `html`, `component`, `query` or `KeyConditionExpression` fails closed. An
  ill-typed field is rejected too, never coerced: an explicit `dimension: null` is an error, not
  a silent default, because a repaired spec answers a question nobody asked.
- **Authorization is not a spec field.** Scope comes from the session's installations
  (ADR-043). A spec naming a foreign repo id contributes zero rows.
- **No tenant data in the prompt.** Repo/workflow/job names are never sent, so a repo named
  `ignore previous instructions…` cannot influence the model. The prompt is our catalog text
  plus the operator's own question.
- **Ambiguity fails closed.** An array of candidate specs is refused rather than silently
  taking the first — rendering one of several proposals is rendering a report nobody chose.
- **Transparency + fallback.** Every generated view states the report and filters it resolved
  to, and the resolved spec is written into the URL, so a report is a plain shareable link that
  re-runs deterministically and never re-invokes the model. Disabled, throttled, unsupported,
  and invalid-spec outcomes all fall back to the manual picker with the reason shown.
**Why**: this makes the blast radius of a fully-compromised model output equal to *picking the
wrong report from a menu the operator could already pick from*. No prompt injection — from
tenant data or from the question — can widen scope, execute code, or read another tenant's rows,
because none of those are expressible in the spec grammar.
**Consequences**: the assistant can only answer questions the deterministic catalog already
covers; anything else is an explicit `unsupported` refusal rather than a bespoke answer. That is
the intended trade. Adding a report means adding a catalog entry (which the prompt is generated
from), not prompting differently. `test/nl-report.test.mjs` pins the refusals for hostile
payloads: model-authored queries, render payloads, scope-widening fields, hallucinated metrics,
truncated JSON, and candidate arrays.

## ADR-046 — Charts: ECharts (Apache-2.0), not Highcharts (M5)
**Status**: Accepted (v1) · **settled** — Highcharts is not being licensed for this project
**Context**: the Reports screen needs bar / stacked-bar / line charts. Highcharts was the
initial request. Highcharts is **commercially licensed** for non-personal use — unlike
Chart.js, ECharts or Recharts it is not MIT/BSD. The call was put to the project owner
explicitly and the answer was **no Highcharts license**, so the licensed option is off the
table rather than merely unconfirmed. The SPA also had zero chart dependencies and a
deliberately lean runtime dep set (react + react-dom only), and is served as a static
S3/CloudFront bundle.
**Decision**: **Apache ECharts, pinned exact (`echarts@5.5.1`)**, imported per chart type
(`echarts/core` + `BarChart`/`LineChart` + only the components used) rather than via the barrel,
and rendered with the **SVG** renderer. Highcharts is rejected on licensing; the decision is
recorded here rather than quietly vendoring a licensed library. **This is not a
revisit-if-convenient item**: adopting Highcharts later would require a license decision, not
just a dependency swap, so any future charting work should extend the ECharts wrapper in
`web/src/screens/ReportChart.tsx`.
**Why SVG over canvas**: the console's CSP is `default-src 'none'` with `style-src 'self'`
(ADR-022) and the SVG path touches far less inline styling, and SVG text stays legible when an
operator screenshots a report into a ticket. Chart height lives in `styles.css`, not a React
inline style — the CSP drops `style="…"` attributes, so an inline-sized chart would work in dev
and collapse to zero height in production. (ECharts' own runtime styling is CSSOM property
assignment and SVG presentation attributes, neither of which `style-src` restricts;
`test/web-stack.test.mjs` still fails the build if a React inline style appears in `web/src`.)
**Consequences**: the SPA bundle grows to ~692 KB raw / ~228 KB gzipped (measured from
`npm run build:web`) — the first meaningful runtime dependency beyond React. Acceptable for an
authenticated internal console behind CloudFront, and bounded by the per-chart-type import list:
adding a chart type means editing that list, which is deliberate friction. If the bundle becomes
a problem the next step is lazy-loading the Reports route, not swapping libraries.

> **ADR numbering note.** This block takes **047** because 042..046 are claimed by the
> concurrent branch `kermes/task-jolly-dove` (spend/run analytics) and 034/035 by
> `kermes/task-nervous-mountain`. ADR numbers are a shared mutable namespace across branches;
> a gap is cheaper than a duplicate.

## ADR-047 — CD runs on our own microVM runners under a GitHub-OIDC deploy role (M4)
**Status**: Accepted (v1) · amends [ADR-018](#adr-018--deploy-target-pin-envlocal-required-for-all-deploy-touching-commands) · constrained by [ADR-021](#adr-021--microvms-hold-no-ambient-aws-authority-brokered-run-hook-operations-m3)

**Context**: The management plane (`LCA-Mgmt-<env>` + `LCA-Web-<env>`) was deployed by hand
from a workstation. CI (`ci.yml`) already dogfoods the platform for *tests* — 100% self-hosted
on our own microVMs — but the deploy itself did not, so the platform's claim to replace
self-hosted runners stopped short of the workload that matters most. Three things blocked a CD
job:

1. **No identity.** A workflow job had no AWS credentials.
2. **ADR-018.** `bin/lca.ts` requires a pin from `.env.local` whenever credentials resolve,
   and `.env.local` is gitignored — a CI checkout is a fresh clone and cannot have one.
3. **Unverified assumption.** Our runners register **JIT-by-ref** (ADR-016) rather than as
   long-lived registered runners, and it was not known whether the Actions service still
   injects the id-token endpoint into such a job.

**Decision**:

**(a) Identity is GitHub OIDC. The shared microVM exec role is not an option.** The tempting
shortcut — let the runner's own AWS identity deploy — is closed by ADR-021.
`lca-<env>-microvm-exec` is **one role shared by every microVM in the environment**, and those
VMs execute untrusted workflow code from every onboarded repo; ADR-021 deliberately cut it to
its own log group plus `lambda:InvokeFunction` on the hook broker. Attaching deploy authority
there would hand platform-deploy *and teardown* power to every job in every tenant repo — the
exact cross-tenant escalation ADR-021 exists to remove. A GitHub OIDC JWT instead binds the
authority to a `repo` + `ref` claim that code inside a VM cannot forge.

Verified before building anything (probe run **30789251216**, `runs-on: [self-hosted,
lambda-ci-node]`): a job declaring `id-token: write` on our own JIT runner **does** receive
`ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`, and the endpoint mints a JWT with
`sub=repo:jsamuel1/LambdaCIActions:ref:refs/heads/<branch>`, `aud=sts.amazonaws.com`. The
endpoint rides the job message, not the runner registration, so JIT-by-ref is irrelevant to it.

**(b) ADR-018 accepts a pin from the process environment, with the identity check unchanged.**
`loadEnvLocal()` falls back to `LCA_DEPLOY_ACCOUNT`/`LCA_DEPLOY_REGION`/`LCA_DEPLOY_ENV` read
from the environment when no `.env.local` exists; **`.env.local` wins when both are present**,
so an ambient exported variable cannot silently retarget a workstation deploy. What does *not*
change is the STS comparison: the pin is still checked against the real caller identity and
still refuses on mismatch. There is no "skip in CI" branch and no variable that disables the
guard, because a pin was never the safety property — the identity match is. A pin is a
declaration of intent; a partial or malformed one fails loudly rather than degrading to
"unpinned". Credential-less `cdk synth` stays exempt (the CI build gate needs no account).

The pin is declared inline in the workflow (`env:`), not as a secret: an account id and a
region are not secrets, and hiding the deploy target from review is precisely what ADR-018 was
written to stop.

**(c) The deploy identity is its own stack, `LCA-Deploy-<env>`** (`lib/deploy-stack.ts`),
deployed from a workstation and **never** in CD's own allowlist. It holds the credential CD
uses; if CD could deploy it, a CD run could widen its own trust policy, and a broken deploy
would take out the identity needed to deploy the fix.

Trust is `StringEquals` on the exact `sub`
(`repo:jsamuel1/LambdaCIActions:ref:refs/heads/main`) and `aud=sts.amazonaws.com`. Wildcards
are **rejected at synth**, not documented as a hazard: a `StringLike` with `repo:owner/*` or
`ref:refs/heads/*` would let any fork's pull-request workflow — i.e. any GitHub user — assume
the role. The account's `token.actions.githubusercontent.com` provider **already existed**
(created 2025-06-27 for an unrelated project), and an OIDC provider is an account-level
singleton keyed by issuer URL — so the stack **references** it by its canonical ARN and creates
one only on explicit opt-in (`-c createGithubOidcProvider=true`). Referencing is the safe
default twice over: `CreateOpenIDConnectProvider` fails with `EntityAlreadyExists` when one is
present, and the creating construct synthesizes a custom-resource role holding
`iam:CreateOpenIDConnectProvider` on `Resource: "*"` — a wildcard IAM write inside the stack
whose whole purpose is least privilege. It also keeps a teardown of this stack from deleting a
provider other workloads depend on.

**(d) Permissions: `sts:AssumeRole` on the four CDK bootstrap roles, plus two read-only
grants the workflow's own steps need — `DescribeStacks` on the two CD-deployed stacks and
`lambda:GetFunctionConfiguration` on `lca-<env>-mgmt`. Nothing else.** No managed policies, no
`iam:` action, no `Resource: "*"`. Assume-bootstrap-roles is the smallest grant that can run
`cdk deploy`, and it does not have to be revised every time the deployed stacks grow a resource
type. The two reads are separate because `cdk deploy` runs under the *assumed* bootstrap roles
while every `aws ...` step in the workflow runs as this role: the `ConsoleUrl` lookup between
passes and the closing `PUBLIC_ORIGIN` assertion would otherwise fail with `AccessDenied`
*after* both deploys had already landed. `test/deploy-role-iam.test.mjs` cross-checks the
workflow's `aws` verbs against the granted actions so that pairing cannot silently drift.

**This is admin-by-proxy, and the honest statement matters more than the shape of the policy.**
`cdk-hnb659fds-cfn-exec-role-863638663908-us-west-2` carries **`AdministratorAccess`** — the
CDKToolkit default, `CloudFormationExecutionPolicies` is empty in the bootstrap stack — so
anything the deploy role pushes through CloudFormation executes with admin. Writing direct
CFN/S3/Lambda/`iam:PassRole` statements *instead* would not fix that: `iam:PassRole` on the
same admin `cfn-exec-role` reaches the identical ceiling while being longer, more brittle and
easier to over-grant. Lowering the ceiling requires re-bootstrapping the account with
`--cloudformation-execution-policies` (**out of scope; follow-up**). The real containment is
therefore the trust policy (one repo, one ref) plus the workflow's stack allowlist — both
asserted by tests, because both are the kind of control that rots silently.

**(e) CD deploys `LCA-Mgmt-<env>` + `LCA-Web-<env>` only, with `--exclusively`.** Never
`--all`; never the image, control, data or deploy stacks. `--exclusively` is load-bearing, not
tidiness: `LCA-Mgmt-<env>` declares CDK dependencies on the data and control stacks, and
`cdk deploy <stack>` deploys a stack's dependencies by default — so naming only Mgmt+Web
*without* `-e` would quietly redeploy the control plane, i.e. the plane that owns the runner
executing that very job. A bad control-plane deploy leaves no runner to deploy the fix.

**(f) Workstation `cdk deploy` becomes the documented escape hatch**, not the steady state
(docs/DEPLOY-M4.md § Manual escape hatch). CD depends on the runner plane it deploys onto, so a
non-CD path has to stay first-class and correct for exactly the case where the platform is down.

**Consequences**:
- `workflow_dispatch` only for now; a `push:`-to-main trigger is a deliberate follow-up so the
  first CD runs are observed rather than automatic.
- The two-pass `-c publicOrigin=` bootstrap (docs/DEPLOY-M4.md Phase 3) is now automated: CD
  reads `ConsoleUrl` from `LCA-Web-<env>`'s outputs between passes, then asserts
  `PUBLIC_ORIGIN` actually landed on the mgmt λ — a green `cdk deploy` does not prove the
  second pass took effect.
- **A vanity domain (ADR-036) must be declared in the workflow environment for a CD deploy.**
  Console-domain config is machine-local (`.env.local`) for the same reason the pin is, and a
  runner has no such file — so `resolveConsoleDomain` also reads `LCA_CONSOLE_*` from the
  process environment, at the LOWEST precedence (context → `.env.local` → environment). Without
  that source, CD would synth an env that HAS a vanity domain as if it had none: the CloudFront
  alias and the us-east-1 cert would be removed and `PUBLIC_ORIGIN` rewritten to the raw
  CloudFront name, breaking login against the callback registered on the App — which is
  browser-only to fix. `dev` has no vanity domain today, so `deploy.yml` declares no
  `LCA_CONSOLE_*` and pass 2 does the real work.
- **A vanity-domain env also needs `LCA-Cert-<env>` deployed by hand before CD can run.** The
  us-east-1 ACM certificate is its own stack (ADR-036) and it is on CD's forbidden list, so
  `--exclusively` skips it as a `LCA-Web-<env>` dependency rather than deploying it. The
  workstation deploys it once (and again on any change to the hostname or zone); CD then
  consumes the cert ARN through the cross-region reference. A CD run against an env whose cert
  stack does not exist yet fails at `LCA-Web-<env>` when that reference cannot resolve — loudly,
  which is the correct failure, but only if the operator sequence is known. CD itself needs no
  us-east-1 authority for this: the reference is resolved by a custom resource running with the
  deployed stack's own role, not by the CLI's bootstrap roles, so the deploy role is granted
  bootstrap roles in the deploy region only.
- A pin can now come from the environment, so an operator debugging locally with exported
  `LCA_DEPLOY_*` variables gets the CI code path. The STS match still gates it, and the file
  still wins, so the failure mode is a refusal rather than a mis-target.
- `LCA-Deploy-<env>` must be deployed by hand once per environment before CD can run at all,
  and the role ARN is hardcoded in the workflow (derived from `envName`, so prod needs its own
  line or a repo variable).
- The `cfn-exec-role` admin ceiling is accepted and recorded, not fixed.

> **ADR numbering note.** This block takes **048**: 042..047 are already on `main` (the
> highest landed number is 047), and the only outstanding gap, 034/035, is claimed by the
> unmerged `kermes/task-nervous-mountain`. ADR numbers are a shared mutable namespace across
> branches, so a gap is cheaper than a duplicate — do not backfill 034/035 here.

## ADR-048 — A run's log stream is resolved by name, not matched by prefix (M4 fix)
**Status**: Accepted (v1) · amends [ADR-016](#adr-016) (log destination) · fixes the log half
of [ADR-026](#adr-026)

**Context**: Every microVM's runner + run-hook output lands in one per-env log group
(`/aws/lambda/microvms/runs/lca-<env>`, ADR-016) with one stream per VM, and the run row
carries the `microvmId` (ADR-019). The first log reader therefore located a run's stream with
`logStreamNamePrefix: microvmId` on both `FilterLogEvents` and `DescribeLogStreams`.

That locator is **backwards**. The service names the stream
`<YYYY/MM/DD>[<imageVersion>]<microvmId>` — for example
`2026/08/03[10.0]microvm-98c2f28c-2463-3526-a201-ef44bd494d15` — so the microVM id is a
**suffix**. A prefix filter never matched: the pane rendered `Logs / 0 events` for the whole
life of every run, and because the `pending` probe used the same bad prefix it first claimed
"No log stream yet — the microVM has not started writing" for a VM that had already written.
Verified in dev on run `30789972919`: prefix-filtering the id returned 0 events and 0 streams,
while `--log-stream-names '2026/08/03[10.0]microvm-98c2f28c-…'` returned the job's output.
This blocked the M4 exit criterion — an operator must be able to read a run's logs **from the
UI** — with the AWS console as the only workaround.

**Decision**: **resolve the exact stream name first, then read that stream by name.**
`DescribeLogStreams` cannot suffix-match, so the prefix argument is the wrong instrument for
the id and the right one for the *date*:

1. Scan `DescribeLogStreams` with `logStreamNamePrefix` = the run's `createdAt` date
   (`YYYY/MM/DD`) and the day after it — a VM queued near midnight UTC launches on the next
   date — and take the stream whose name **contains** the `microvmId`.
2. If that finds nothing, fall back to one `orderBy: LastEventTime, descending` scan of the
   group: a live run's stream is the most recently written. CloudWatch forbids combining that
   ordering with a name prefix, which is why it is the fallback and not the primary. It runs
   whenever the date tiers could not *rule the stream out* — no usable date, a scan the budget
   truncated, or a date prefix that listed **no streams at all**, which is what a changed name
   format looks like from here. Only an exhausted scan over a populated date namespace is an
   authoritative miss.
3. Read with `logStreamNames: [exactName]`; **never** a prefix.

Matching is containment, not `endsWith`: the id is a UUID-shaped token that cannot occur
inside an unrelated stream's name, so containment is equally exact and does not break if the
service moves the date/version decoration.

Resolved names are cached per Lambda container (`microvmId` → stream name, FIFO-bounded), so
the pane's log poll costs one `FilterLogEvents` in steady state, not a rescan. Misses are
cached too, but only for **5 s**: "no stream yet" becomes "stream" seconds later while the VM
boots, so a miss has to stay retryable — while an *uncached* miss meant every poll of a queued
run re-scanned the group. Measured on the miss path: an attempt costs 2 `DescribeLogStreams` on
a 50-stream day and 7 on a 300-stream day. The log pane polls every **4 s** (the run row
itself polls every 3 s — ADR-026), so uncached that is 0.5–1.8 TPS from a **single** viewer
against an account-wide 5 TPS quota; with the TTL a miss is re-derived every second poll, i.e.
0.25–0.9 TPS. A `ThrottlingException` surfaces as a 500, not a "waiting for logs" pane.

The two tiers share **one** describe budget (12 calls × 50 streams), rather than each getting
its own page cap that multiplies across them. Two of those calls are *reserved* for the
fallback: without a reserve a busy queue date can spend the whole budget and the fallback is
then skipped for want of calls, in precisely the case it exists for. A date prefix listed to
its end **and** holding real streams is proof the stream is not there, so the ordinary "VM has
not written yet" poll costs two describes and never re-scans the whole group.

**Residual limit**: the date tier reaches ~450 streams under the run's own date, and the
fallback the 100 most recently written streams in the group. Beyond both, a **finished** run
is unresolvable — an old stream is by definition not among the most recently written. A live
run is unaffected, because its stream *is* the most recent; that is what the reserved fallback
pages buy. Dev is orders of magnitude below the horizon, but this is the limit that makes the
row stamp below the real scaling answer rather than just a cheaper one.

Second residual, from the authoritative-miss rule itself: a stream stamped with a date
**outside** `[D, D+1]` — a clock-skewed VM, or one launched more than a day after it was
queued — is unresolvable whenever the queue date is a *populated* namespace, because those
prefixes then list themselves out over real streams and rule the stream out before the
fallback can run. This is the deliberate price of keeping the ordinary "VM has not written
yet" poll at two describes: the alternative is a whole-group recency scan on every poll of
every queued run. It is not the same case as a changed name *format*, which empties the date
namespace for every stream at once and therefore does reach the fallback. Pinned by
`test/mgmt-logs.test.mjs` so it stays a known cost rather than a surprise.

**Why not stamp the stream name on the run row at launch?** Cheaper (zero describes), but it
needs a Provision-side write plus a resolver fallback for every row written before it lands —
and the resolver is the thing that has to be correct either way. Resolution is self-healing
for existing runs, and the container cache already removes the per-poll cost. The row stamp
stays available as a later optimisation.

**Consequences**:
- `pending` is now exactly "there is no stream to read" — no VM, or no stream yet — rather
  than "the first page came back empty". A resumed tail that returns nothing is still
  *caught up*, so the UI cannot flash "no log stream yet" over rendered output.
- `GET /api/runs/…/logs` returns the resolved `logStream`, and the Run detail log pane shows
  it, so an operator can jump to the same events in the CloudWatch console and can see at a
  glance when resolution failed. The pane tracks it **per poll**, not from the pages it
  rendered: it only buffers pages that carried events, so deriving the name from them would
  hide it in precisely the empty-pane case it exists to explain.
- A cold container pays one `DescribeLogStreams` per run before its first read in the common
  case — the stream is on the first page of the run's own date — and up to the 12-call budget
  on a busy day, since each tier pages before the next one starts: the measured figures above
  are 2 on a 50-stream day and 7 on a 300-stream day. Only the FIRST read of a run pays this;
  the container cache makes every later poll one `FilterLogEvents`. IAM already allowed both
  calls (ADR-025), so there is no permission change.
- A stream that appears during a cached miss shows up to 5 s late in the pane. That is under
  two poll intervals and invisible next to microVM boot time.
- The stream layout is now a load-bearing assumption in two places (date prefix, id
  containment). A wholesale **format** change degrades to the recency scan rather than to an
  empty pane — for live runs, which is when an operator is watching — because it empties the
  date namespace for every stream at once, and a date prefix that lists nothing is treated as
  "cannot rule it out" rather than "not there". That is what makes the degradation real rather
  than aspirational. It does **not** cover a single stream stamped outside `[D, D+1]` on a
  populated date; see the second residual limit above.
- **The test stub is part of the fix.** `test/mgmt-logs.test.mjs` previously replied from a
  scripted response queue that ignored `logStreamNamePrefix` entirely, and its fixture names
  (`vm-1/x` for `vm-1`) were id-prefixed — so no test in the file could observe a wrong
  locator direction, which is precisely why this shipped green. The stub is now a small
  CloudWatch model that honours `logStreamNamePrefix` / `logStreamNames` / `startTime` /
  `limit` / `nextToken` / `orderBy` (including rejecting the prefix + `LastEventTime`
  combination the API forbids), with realistic `2026/08/03[10.0]microvm-…` fixtures. A test
  asserts the model itself cannot see an id-prefix scan, so the guard cannot rot back. The
  handler's own wiring is pinned separately (`test/mgmt-logs.test.mjs`, source-level): the
  resolver is only date-bounded because the route passes the run's `createdAt`, and dropping
  that argument would leave every logs test green while silently degrading resolution to the
  recency fallback — which cannot find a finished run's stream.

---

## ADR-049 — A flavor is published image-first, label-second; drift is a command, not a belief (M5 fix)
**Status**: Accepted (v1) · amends [ADR-039](#adr-039) (expanded standard set) and
[ADR-011](#adr-011) (phased deploy) · constrained by [ADR-047](#adr-047) (CD allowlist)

**Context**: `microvm/flavors.json` defined seven flavors. The dev environment could run three.

On 2026-08-07, eight PRs in `jsamuel1/SauhsojVideo` sat `QUEUED` for about seven hours. The
workflow named `[self-hosted, lambda-ci-python]`; the catalog defined `python`;
`docs/DEPLOY-M1.md` documented `lambda-ci-python` in its seed command; `test/filter.test.mjs`
asserted that documented seed covers every catalog label — and all of that was true while the
deployed plane had neither the label nor the image:

| flavor | live allowlist | `image-arn-*` | image |
|---|---|---|---|
| base, node, docker | yes | yes | `UPDATED` |
| python | no | no | `ResourceNotFoundException` |
| java, go, rust | no | no | never built |

Live `/lca/dev/config/runner-labels` was `lambda-ci,lambda-ci-node,lambda-ci-docker`.

Three separate gaps produced that, and each is worth naming because the fix addresses all
three rather than the symptom:

1. **No supported way to build one flavor.** `scripts/build-images.mjs` existed but no
   workflow invoked it (CD deploys `LCA-Mgmt-dev`/`LCA-Web-dev` only), and publishing the
   label was a hand-written `aws ssm put-parameter` in a doc. So a catalog entry became
   capacity only if a human remembered two commands in the right order.
2. **No way to observe the disagreement.** Nothing compared the catalog to live state. A unit
   test over `flavors.json` and a doc string cannot: both are repository facts, and the bug
   was a *deployment* fact. The only symptom was a queued job with no error in any log,
   because `shouldClaim` refuses before flavor resolution and GitHub discards ingest's 202.
3. **No ordering rule.** The two writes (image ARN parameter, allowlist label) were
   independent, and nothing said which comes first.

**Decision**:

**1. Image first, label second — enforced, not documented.** `build-images.mjs` publishes
`/lca/<env>/config/image-arn-<flavor>` only after the image reaches `CREATED`/`UPDATED`, then
adds the flavor's label to `/lca/<env>/config/runner-labels`, and **refuses** to add a label
whose image is not in a usable state (`mayClaimLabel`).

This ordering is a safety property, not a preference, because the two intermediate states are
not symmetric:

- *image, no label* → the job stays queued on GitHub. Nothing is consumed, and **a
  GitHub-hosted runner can still take it.** Recoverable, and the operator's own workflow can
  fall back.
- *label, no image* → ingest **claims** the job, provisioning then fails. The claim is the
  damage: GitHub considers the job assigned to a self-hosted runner, so the fallback is
  already gone. A worse failure, reached faster, with a less obvious cause.

`--skip-label` exists for staging capacity ahead of advertising it; it leaves `label_missing`
drift, which the reconcile command reports and can safely fix. `--publish-label-only` is the
other half — an image that already verified, label not yet added.

**2. Rebuild repoints, never unpublishes.** `create-microvm-image` is not idempotent, so an
existing image is UPDATED (a new version) — build, verify, then repoint the ARN. The label is
left alone across a rebuild (`ensureLabel` is idempotent and append-only): removing and
re-adding it would open a window in which live jobs stop being claimed, which is the exact
harm this ADR is about. `--flavor <name>` does one; the default (or `--all`) does the set.

**3. `npm run flavors:reconcile` — drift is a command.** Read-only by default: per flavor it
prints catalog ∙ live allowlist ∙ ARN parameter ∙ **real image state**, and exits non-zero on
drift. It is pinned to a deploy target (ADR-018/ADR-037) with no dry-run exemption, because an
unpinned read produces a confident report about the wrong environment — and a
`ParameterNotFound` from the wrong region is indistinguishable from a missing flavor. That is
not hypothetical: SauhsojVideo's own workload region differs from LCA's, and querying the
former is what first suggested the parameters did not exist at all.

Checking that a parameter *exists* is not evidence the image does. The published ARN for
`python` would have looked fine to a presence check; `get-microvm-image` returned
`ResourceNotFoundException`. So the CLI resolves the concrete image state, and its
`--no-image-check` mode (for a credential without the microVM API) degrades to
`image_unverified` rather than `ok` — an unchecked image is *unknown*, not present.

**4. `--fix` moves in the safe direction only.** Build a missing image, or add a label for an
image that verifies. It **never removes a label**: that takes routing away from jobs which may
depend on it right now, and "advertised but unbuildable" is a decision (build it, or delete
the catalog entry), not a cleanup. `--fix` is rejected outright with `--no-image-check`.

**4b. The quiesce gate lives in `build-images`, not only in `--fix`.** Both commands refuse on a
non-quiescent fleet, enumerating **all pages** of non-terminated microVMs — the image-hook
contract has a serialized skew window, and a VM resuming from a snapshot whose image is being
replaced fails `/run` instead of running degraded. Putting the gate only in `--fix` would have
left the *documented primary command* (`npm run build:images -- --flavor <name>`) as the one path
that could race, while its own wrapper was safe — and `--fix` remediates by shelling out to that
very script. `--publish-label-only` is exempt: a label write cannot skew a running VM, it only
changes which future jobs are claimed, and gating it would block the safe half of remediation
during ordinary traffic. `--force-unquiesced` exists for a VM wedged non-terminal that the Reaper
has not collected, and is logged loudly. The gate is a floor, not the whole procedure: pause the
other writers too.

The terminal set is `TERMINATED` and nothing else, taken from the deployed service model rather
than guessed: `MicrovmState` (lambda-microvms 2025-09-09) is
`PENDING | RUNNING | SUSPENDING | SUSPENDED | TERMINATING | TERMINATED`. There is no `FAILED`
microVM state — `FAILED` belongs to `BuildState`/`MicrovmImageVersionState`, which describe an
image *build*. Treating it as terminal would widen the terminal set beyond the model in the one
direction a safety gate must not widen, because a state the gate calls terminal is a VM whose
image it will replace. `TERMINATING` is deliberately live, and an absent or unrecognized state
counts as live: "I do not know what this VM is doing" resolves to refusing the swap. The
predicate is `isLiveMicroVmState` in the shared module, so the two gates cannot drift apart.

**4c. Exit codes distinguish "the plane disagrees" from "do not trust this report."** 1 is drift
— including drift `--fix` will not touch, so a partially-remediated run cannot exit 0 and claim
agreement. 2 is an operational failure: unreadable live state, an incomplete image probe, an
unreadable fleet, or a remediation that failed part-way (which stops rather than continuing).
Collapsing the two would let "I could not look" render as an ordinary drift table.

That verdict is taken from a **re-read of the plane after remediating**, not from the child
processes' exit codes against the pre-fix report. The two are different facts, and the gap is
reachable: `build-images` exits 0 when `runner-labels` is *absent* — it publishes the image ARN,
warns, and refuses to CREATE the parameter, because creating it from one flavor would drop every
other label an operator had seeded. On an environment that skipped the phase-0 seed every row is
`label_missing`/`not_built`, so the set of rows `--fix` will not touch is empty, and scoring the
run against that snapshot reports success after adding no label at all — the whole catalog still
unrunnable, from a command that just said it fixed it. Re-observing costs a handful of API calls
and generalises to any remediation that silently no-ops. An incomplete probe on that second read
is exit 2 (unknown), not success. With `--json`, `--fix` emits exactly one document — the
post-fix report — because two on one stdout parse as neither.

**5. One derivation, one surface today.** The verdicts live in `src/shared/flavor-reconcile.ts`,
a pure module the CLI and `build-images` consume. A CLI that says `python` is blocked while the
console shows it green is the same class of bug as the one being fixed here, so the mapping from
(label, ARN, image state) → status/severity/fix exists exactly once. The console surface is a
separate card and does **not** consume it yet; this ADR fixes the derivation it must use, and
pins (in `test/flavor-reconcile.test.mjs`) that the console's presence-only evidence projects to
`image_unverified` rather than `ok`. The symmetric case is pinned too: an observation that never
read `runner-labels` projects to `label_unverified`, not `ok` — `ok` asserts *label claimed*, and a
consumer that read only `image-arn-*` has not observed that. Neither unknown counts as drift; only
an observed disagreement does.

A probe that fails for any reason other than `ResourceNotFoundException` yields *unknown*, not
*absent*: an AccessDenied or a pre-2.35.17 AWS CLI would otherwise report a healthy catalog as
`image_missing`/`blocked` — a confident verdict about a plane never observed, and one carrying
`safeFix: 'build'`. The CLI exits 2 on an incomplete probe and `--fix` refuses. A *successful*
`get-microvm-image` whose body carries no `state` is the same fact: the call returned, but we
could not interpret it, so it is unknown rather than absent (the CLI records it as an incomplete
probe and exits 2). Only the API's own not-found signal may assert absence.

**6. Missing flavors do NOT auto-build, and CD's reconcile is report-only.** An image build
takes minutes, is deploy-touching, and mutates the plane every runner boots from. Three
reasons it stays out of CD:

- **It cannot honour its own quiesce requirement.** The build would run *on a microVM runner*,
  so the fleet is provably non-empty at the moment the check runs — the job itself is the
  counter-example. A gate that can never pass is worse than no gate.
- **ADR-047's allowlist forbids it.** Image work belongs to `LCA-Image-*`, which CI must never
  deploy, and the deploy role holds no microVM-image authority.
- **Cost and blast radius.** Rebuilding seven images per CD run to fix a rare gap inverts the
  cost/benefit.

So: **building is a human, workstation-pinned action**; CD runs `flavors:reconcile
--no-image-check` as a **report-only** step (`continue-on-error`) so a live allowlist gap is
visible in the run summary rather than discovered by a stuck PR seven hours later. Its
credential needs `ssm:GetParameter`/`GetParametersByPath` on `/lca/<env>/config/*`, added to
`DeployStack`; until that role is redeployed **from a workstation** the step degrades to a
skipped report instead of failing the deploy.

**Consequences**:
- One documented command turns a catalog entry into capacity, in the order that cannot strand
  a job: `npm run build:images -- --flavor <name>`.
- `npm run flavors:reconcile` answers "does this environment really run what it advertises?"
  and is safe to run any time; it exits 1 on drift, so it works as a scheduled check.
- The `label_missing` state is now merely a warning with a one-line safe fix, and
  `image_missing` — the state label-first creates — is reported as `blocked`.
- A repository unit test still cannot prove deployment state, and this ADR does not claim
  otherwise. `test/filter.test.mjs` keeps the docs↔catalog guard because a wrong *documented*
  seed is its own bug; the live check is a command an operator (or CD) runs.
- **No flavor is built by this change.** `python`, `java`, `go` and `rust` all remain unbuilt
  and unadvertised: the tooling landed, the live build did not (the workstation that authored
  this had no deploy pin for the LCA account, and the pin correctly refused). Reconcile reports
  all four as `not_built` (`blocked`) every run — which is the correct nag. Building `python`
  unblocks the `lambda-ci-python` workflows that motivated this card and is the intended first
  use of `npm run build:images -- --flavor python`; building or deleting `java`/`go`/`rust` is a
  separate decision. What is no longer possible is *not knowing*.
