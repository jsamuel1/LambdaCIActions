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
  (item `pk=RUN#…, sk=JITCONFIG`, TTL 30 min) and passes only `{ref, region, table}`
  (~100 B) as the run-hook payload. The `/run` hook resolves the ref via the baked-in AWS
  CLI (`dynamodb get-item`) using the **microVM execution role** (`lca-<env>-microvm-exec`,
  read-only on the table), which Provision stamps on every launch via `--execution-role-arn`
  (and holds `iam:PassRole` for).
- Images declare `hooks = { port: 8080, microvmImageHooks: { ready: ENABLED },
  microvmHooks: { run: ENABLED } }` and ship a hook server that answers both the prefixed
  runtime paths and bare paths, logging every request. Build logging (`--logging
  cloudWatch`) is always on: `/aws/lambda/microvms/<image-name>`.
**Why**: The 4 KB cap makes by-reference the only option; the run store already holds the
run↔VM mapping (ADR-015), so it is the natural side-store, and the TTL bounds JIT-config
exposure. The exec role finally gives the VM a scoped identity (read-only JIT fetch).
**Consequences**: The microVM image and the control plane now share a contract (table
name + ref format) delivered via the payload. Rotating the hook-path prefix is AWS's
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

## ADR-018 — Self-terminate via run-row readback (no in-guest microVM id source) (M3)
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
**Consequences**: A VM can terminate any VM in the region if the exec role is misused —
acceptable because the role only exists inside our own single-use VMs; revisit when the
API grows VM-scoped ARNs. If the readback misses (row gone, DDB outage), behavior
degrades exactly to the old Reaper-only path. `test/run-hook.test.mjs` pins the
ref→run-row key derivation against the run store so the two sides can't drift.
