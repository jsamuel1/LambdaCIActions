# Spec 02 — microVM Runners

Status: **Draft** · Plane: Compute

How LambdaCIActions builds runner images, provisions ephemeral microVMs, boots the GitHub
Actions runner agent, and reaps them. This is the compute engine.

## Contents
- [What is a Lambda microVM here](#what-is-a-lambda-microvm-here)
- [Runner flavors](#runner-flavors)
- [Image build & snapshot pipeline](#image-build--snapshot-pipeline)
- [Runner bootstrap](#runner-bootstrap)
- [Provisioning lifecycle](#provisioning-lifecycle)
- [Reaping & timeouts](#reaping--timeouts)
- [Caching & pre-warming](#caching--pre-warming)
- [Constraints](#constraints)

---

## What is a Lambda microVM here

An ephemeral, snapshot-booted VM (Graviton/arm64) that hosts a **single** GitHub Actions
job then self-terminates. Compared to CodeBuild: faster start (snapshot boot), a real full
OS, VPC-attachable, and per-second billed. Compared to shared Lambda: full VM isolation.

> **API surface** (confirmed; see [ADR-012](../DECISIONS.md)): images are built with
> `create-microvm-image` (Dockerfile → `CREATED` image ARN); a microVM is launched with
> `run-microvm --image-identifier <ARN>` and an optional `--run-hook-payload` (≤16 KB).
> The image implements HTTP **lifecycle hooks** (default `:8080`): `/run` (post-boot,
> gates traffic until 200), `/terminate` (pre-teardown), `/suspend` `/resume` (idle;
> unused for single-use). Teardown is `terminate-microvm`. Per-VM endpoints need a JWE
> from `create-microvm-auth-token`. Quota = total memory of `RUNNING`/`SUSPENDED` VMs
> per region.

Key numbers (from reference + AWS docs, to validate in [ROADMAP](../ROADMAP.md) M1):

- Boot from snapshot: seconds.
- Max lifetime: up to 8h (we cap lower by default).
- Size: e.g. 2 vCPU / 4 GB ≈ \$0.0044/min, per-second billing.
- Arch: **arm64 only**.

## Runner flavors

A **flavor** = a named runner image + resource shape + label. Selected per job from
`runs-on` labels (see [03](03-workflow-ingestion.md)).

| Flavor | Label | Base | vCPU/Mem | Contents |
|---|---|---|---|---|
| `base` | `lambda-ci` | Ubuntu arm64 + runner agent | 2 / 4 GB | git, curl, common toolchain |
| `docker` | `lambda-ci-docker` | base + dockerd (DinD) | 4 / 8 GB | Docker daemon, buildx. **Privileged** — built with `additionalOsCapabilities=ALL` + root entrypoint (ADR-020) |
| `node` | `lambda-ci-node` | base + Node LTS + pnpm | 2 / 4 GB | Node, package managers |
| `custom-*` | per-repo | per-repo Dockerfile | configurable | repo-specified |

Flavors are defined once globally; a repo may **override** the mapping (e.g. `ubuntu-latest`
→ `node`) or register a `custom-*` image. Mapping stored in DynamoDB `FlavorMap`.

## Image build & snapshot pipeline

Mirrors the reference's staged approach, generalized to a flavor catalog.

```
microvm/
  Dockerfile.base        # base flavor
  Dockerfile.docker      # DinD flavor
  Dockerfile.node        # node flavor
  bootstrap/             # runner bootstrap scripts (shared)
  flavors.json           # flavor catalog: name, dockerfile, size, arch, label
scripts/build-images.ts  # build + snapshot + publish ARNs
```

Build steps (per flavor):

1. Stage the flavor's `Dockerfile.<flavor>` as the build `Dockerfile`; zip `microvm/`.
2. Upload to the microVM **code bucket**.
3. Trigger microVM image build → snapshot.
4. Poll to completion; prune old image versions (keep last N).
5. Write the resulting **image ARN** to config (SSM/DynamoDB): `MICROVM_IMAGE_ARN_<FLAVOR>`.

Because image ARNs must exist before the orchestrator can launch runners, deploy is
**phased** (see [05-infrastructure](05-infrastructure.md)): infra → build images → deploy orchestrator.

## Runner bootstrap

Baked into the image as a **run-hook HTTP server** (default `:8080`), not a plain boot
script — this matches the real `run-microvm` contract (see [ADR-012](../DECISIONS.md)).
Provision λ passes the JIT config + job metadata as the `--run-hook-payload` JSON; Lambda
delivers it to `POST /run` after the snapshot boots.

```
POST /run   { ref, region, broker, token }  (≤ 4 KB payload — JIT config by reference, ADR-016)
  ├─ resolve ref → { jitConfig, runId, jobId, … } by invoking the hook broker λ with the
  │  run's capability token (ADR-021 — the VM holds no DynamoDB permission)
  ├─ (flavor pre-run hook, if present: ${RUNNER_DIR}/pre-run.sh — docker flavor starts dockerd)
  ├─ cd /opt/actions-runner
  ├─ ./run.sh --jitconfig <jitConfig>     # runs exactly ONE job, then exits
  │    (when the entrypoint is root: setpriv --reuid/--regid/--init-groups runner)
  ├─ return 200 quickly so Lambda un-gates traffic; run the job in the background
  └─ on agent exit → ask the broker to terminate this VM; the broker reads `microvmId`
     off the run row (Provision stamped it post-launch, ADR-019) and calls
     `terminate-microvm`; Reaper backstops

POST /terminate   # fires pre-teardown; best-effort final status report
```

- The image declares `microvmHooks.run` with **`runTimeoutInSeconds: 120`** and the hook's
  boot broker call is bounded at **20 s per invoke × 3 attempts** (2 s/4 s backoff, 66 s worst
  case), so the retry budget still fits the deadline with room for another full-length
  attempt. Both numbers are sized for a **cold `aws` CLI** in a snapshot-resumed guest, which
  is the dominant cost — not the broker ([ADR-028](../DECISIONS.md); the original 6 s/30 s
  pair left zero retry margin in live measurement). The `ready` **image** hook pre-warms the
  CLI before the snapshot is captured, so a healthy boot resolves on attempt 1 and the raised
  bound is unused headroom. The warmup passes an explicit region (without one the CLI exits at
  `NoRegion` before the expensive endpoint/HTTP work) and logs `warmed` — whether it actually
  reached the connect attempt — alongside its duration. Every broker attempt logs its measured
  `ms`.

- There is **no in-guest id source** for the VM's own `microvmId` (no metadata file, no
  env var — verified from live runs, ADR-019). Self-terminate therefore goes through the
  hook broker, which reads the id off the run row keyed by the same `ref` the VM's
  capability token is bound to (ADR-021). The VM never sees any `microvmId`.

- JIT config is **single-use** (see [01](01-github-app.md)); it arrives in the payload,
  never in surviving env/user-data, and nothing long-lived lands on disk.
- The hook emits lifecycle signals (`booted`, `running`, `job_done`) so the UI shows live
  status without polling GitHub.
- The `docker` flavor runs its **pre-run hook** (`${RUNNER_DIR}/pre-run.sh`) before the
  agent: it mounts cgroup2 and starts `dockerd`, then the run-hook drops root → `runner`
  with `setpriv`. That flavor is the only one built with `additionalOsCapabilities=ALL`
  and the only one whose entrypoint stays root — a default microVM has an empty capability
  set, a read-only `/sys` and no writable cgroup hierarchy, so a rootful daemon cannot
  start, and in-guest `sudo` can never escalate (`NoNewPrivs: 1`). See **ADR-020** and
  `docs/VERIFY-M3.md`. Cold `dockerd` init measures ~40 s on 4 vCPU Graviton.

## Provisioning lifecycle

Owned by **Provision λ** (SQS consumer):

```
receive msg {installation_id, repo_id, run_id, job_id, labels}
  ├─ dedupe on (repo_id, run_id, job_id)            # idempotency
  ├─ resolve flavor  → image ARN                     # FlavorMap + flavors.json
  ├─ mint installation token → JIT config            # GitHub App (01)
  ├─ run-microvm(--image-identifier <ARN>,           # no VM tags on GA API (ADR-015)
  │              --run-hook-payload <JSON ref>)        # ≤ 4 KB — by reference (ADR-016)
  ├─ stamp Run.microvmId (unconditional, ADR-019)     # hook readback + Reaper correlation
  ├─ write Run: status=provisioning → running
  └─ on launch error → throw → SQS retry → DLQ; Run=failed(reason)
```

State machine: `queued → provisioning → running → completed | failed | timed_out`.
Transitions written to DynamoDB `Run` rows for the UI.

## Reaping & timeouts

- **Per-runner cap**: `MAX_RUNNER_LIFETIME` (default well under 8h) enforced by the runner itself and by the Reaper.
- **Reaper λ** (EventBridge schedule): lists live microVMs (no tags on the GA API — correlates by the run store's persisted `microvmId`, ADR-015); terminates any past cap; closes `Run` rows with no live microVM (`timed_out`/`orphaned`). Backstop only — the primary teardown is the hook's self-terminate (ADR-019).
- **Stuck-queue signal**: `Run` in `provisioning` beyond threshold ⇒ UI health warning (likely a quota wall — see [05](05-infrastructure.md)).

## Caching & pre-warming

The biggest reference win was baking dependencies into the snapshot:

- Pre-install language toolchains, common CLIs, and **Docker layers** into the flavor image → saves minutes/build.
- Optional job-level cache: mount an EFS/S3-backed cache dir for package managers (Phase 3).
- Warm pool intentionally out of scope for v1 (single-use only); revisit if boot latency proves painful.

## Constraints

- **arm64 only** — native x86 deps need arm64 builds or (slow) emulation. Flag at ingestion.
- **No runner reuse** — clean isolation, but every job pays boot; mitigated by snapshots.
- **Quota-bound concurrency** — request microVM quota increases early.
- **Snapshot storage** — small fixed monthly cost per flavor image; prune old versions.
