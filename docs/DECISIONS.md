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
  the run-hook payload. **Amended by [ADR-020](#adr-020)**: the pointer is now
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
ADR-020).
**Consequences**: The microVM image and the control plane now share a contract (the ref
format, and — per ADR-020 — the broker name + capability token) delivered via the payload.
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
  `.env.local` exists, the pin is mandatory and must match the ambient account; stacks
  get `env = { account: pin, region: pin }`. Credential-less synth (the CI gate, fresh
  worktrees) proceeds unpinned — it cannot deploy anything.
- **`scripts/build-images.mjs` / `scripts/create-github-app.mjs`**: refuse to start
  without a valid pin AND an STS caller-identity match; `--dry-run` is exempt (no AWS
  calls). Any explicit `--region`/`-c region` must equal the pinned region.
**Why**: comparing the pin against the *actual* resolved identity (not just exporting a
profile) catches every mis-targeting mode: wrong profile, stale credentials, env-var
overrides. Keeping the guard dependency-free preserves the scripts' zero-npm-dep
convention, and one TS module shared via `dist/` avoids two divergent implementations.
**Consequences**: first deploy on a fresh clone requires `cp .env.local.example
.env.local` + editing two values (deliberate one-time friction). Dev/prod account
separation (M5) becomes trivial: each checkout/env pins its own account.

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
**Consequences**: **Accepted cross-tenant risk — SUPERSEDED by [ADR-020](#adr-020), which
removed both grants from the VM.** As originally shipped the grant was region-scoped, not
VM-scoped, so *anything* executing inside a microVM could terminate *any* microVM in the
account/region. The role lives inside VMs that run **untrusted workflow code** — a
malicious or compromised PR in any onboarded repo could enumerate nothing (no `List*`
granted) but could kill another tenant's in-flight job given its id, i.e. a cross-tenant
denial-of-service primitive. Accepted at the time because (a) the GA `lambda-microvms` API
exposes no VM-level resource ARNs or tags to scope against (ADR-015), (b) the blast
radius is bounded to job availability — no data access, since each VM is its own VM with
its own single-use JIT credentials — and (c) the alternative (Reaper-only) costs ~5 min
of idle billing on every job. **Amplifier (also closed by ADR-020)**: the exec role's
run-table grant was `grantReadData` (table-wide `GetItem`/`Query`/`Scan`, pre-dating this
ADR), so a VM could read other runs' rows and harvest their `microvmId` — target ids were
discoverable from inside a VM.

**Amendment (ADR-020, M3)**: step 2 and step 3 above no longer describe the shipped system.
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
target, so login fails loudly (500) until it is set. Custom domains + ACM are M5.

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

## ADR-027 — Console repo config is enforced in Ingest, not the management plane (M4)
**Status**: Accepted (v1) · follows [ADR-023](#adr-023)
**Context**: M4 gave the console `PATCH /api/repos/{repoId}` over `enabled`, `mode` and
`defaultFlavor`. ADR-023 deliberately restricts the Mgmt λ to config writes — it cannot
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
  microVM runtime, not a cost basis (v1 stores no per-phase timestamps — spec 04 OQ-5). It
  exceeds wall clock whenever jobs run in parallel, which is the question it answers.
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
  + cost"). The windowed, groupable report remains open on the Reports screen (spec 04 OQ-6);
  when it lands, this sample is a candidate for removal rather than a second source of truth.
- **The cost sample's unit is a JOB, not a workflow run** (review fix). The run store is keyed
  `(repoId, runId, jobId)` (ADR-009/ADR-029), so a 3-variant matrix workflow is three rows.
  `CostSummary` originally called its counter `runs`, and the Dashboard rendered it as
  "3 finished run(s)" for ONE workflow and divided the total by 3 for a "mean per run" — a
  denominator off by the matrix width. The summed spend was always right; only the count and the
  mean lied. The field is `jobs` (and `byFlavor[f].jobs`), and the Dashboard says so, because
  grouping by `(repoId, runId)` here would misrepresent the sample in the other direction: the
  sample is a bounded page of job rows, so a run whose jobs straddle the page boundary would be
  priced as a complete run when it is not — the same partial-window problem ADR-029 solved on
  Runs with an explicit flag. Per-workflow-run cost belongs to the Reports screen (OQ-6), which
  gets a read pattern that can see a whole run.
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
