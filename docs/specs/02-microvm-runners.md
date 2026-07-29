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

> **Sizing (ADR-038)**: only **memory** is requestable, and only at *image build* time —
> `create-microvm-image --resources minimumMemoryInMiB=<memoryMb>` plus
> `--cpu-configurations architecture=ARM_64` (whose sole permitted value is `ARM_64`).
> `run-microvm` has **no** sizing parameter at all, so a VM's shape is fixed by its image, and
> the API exposes **no vCPU knob**. The catalog's `vcpu` is therefore **descriptive** — the
> shape a flavor is intended for, and the tie-break when picking the smallest flavor with a
> capability — not a request. Every vCPU-derived cost figure is an estimate.

## Runner flavors

A **flavor** = a named runner image + resource shape + label. Selected per job from
`runs-on` labels (see [03](03-workflow-ingestion.md)).

| Flavor | Label | Base | vCPU†/Mem | Contents |
|---|---|---|---|---|
| `base` | `lambda-ci` | Ubuntu arm64 + runner agent | 2 / 4 GB | git, curl, common toolchain |
| `docker` | `lambda-ci-docker` | base + dockerd (DinD) | 4 / 8 GB | Docker daemon, buildx. **Privileged** — built with `additionalOsCapabilities=ALL` + root entrypoint (ADR-020) |
| `node` | `lambda-ci-node` | base + Node LTS + pnpm | 2 / 4 GB | Node, package managers; tool-cache prebaked |
| `python` | `lambda-ci-python` | base + CPython 3.12 | 2 / 4 GB | Python + pip; tool-cache prebaked |
| `java` | `lambda-ci-java` | base + Temurin JDK 21 LTS | 2 / 8 GB | JDK, `JAVA_HOME` set; tool-cache prebaked |
| `go` | `lambda-ci-go` | base + pinned Go | 2 / 4 GB | Go + cgo C toolchain; tool-cache prebaked |
| `rust` | `lambda-ci-rust` | base + pinned Rust stable | 4 / 8 GB | rustc/cargo/clippy/rustfmt via rustup |
| `custom-*` | per-installation | operator-supplied image | configurable | operator-specified; **planned, not implemented** — must pass validation before it is routable (ADR-040/041) |

† descriptive only — see the sizing note above.

The standard language set is deliberately **one toolchain per flavor** (ADR-039): a combined
"kitchen sink" image would make every job pay every toolchain's snapshot cost. `dotnet` is
intentionally **not** shipped — it is the largest candidate with no verified consumer; it
belongs on the custom-flavor path until a real workload justifies it.

Flavors are defined once globally; a repo may **override** the mapping (e.g. `ubuntu-latest`
→ `node`) or an operator may register a `custom-*` image for their installation. The
built-in catalog is `microvm/flavors.json`, compiled into the Lambdas at build time; custom
flavors live in the shared table and are **merged over** the built-in set, which always wins
a name collision (ADR-040). Per-repo label mapping is stored in DynamoDB `FlavorMap`.

### Prebaked runner tool cache

The wall-clock win for a language flavor is not the runtime binary — it is skipping the
`setup-*` download. Each tool-cache flavor installs its toolchain into the layout
`@actions/tool-cache` `find()` expects, so `actions/setup-node@v4`, `actions/setup-python@v5`,
`actions/setup-java@v4` and `actions/setup-go@v5` resolve from cache:

```
${RUNNER_TOOL_CACHE}/<toolName>/<version>/<arch>/      # the toolchain
${RUNNER_TOOL_CACHE}/<toolName>/<version>/<arch>.complete   # SIBLING marker file
```

Three details are load-bearing, and each is pinned by `test/image-content.test.mjs`:

1. **`RUNNER_TOOL_CACHE` must be set explicitly** in the image. A self-hosted runner does
   *not* default to `/opt/hostedtoolcache`: `actions/runner` resolves `RUNNER_TOOL_CACHE ??
   RUNNER_TOOLSDIRECTORY ?? AGENT_TOOLSDIRECTORY ?? agent.ToolsDirectory` and otherwise falls
   back to `_work/_tool`. Unset, the prebaked cache sits in a directory the agent never reads.
2. **The `.complete` marker is a sibling of the arch directory**, not a file inside it.
   Without it `find()` returns empty and every job re-downloads — silently, at full speed,
   with no error.
3. **`toolName` is a case-sensitive path**: `Python` (capitalized), `node`, `go`, and
   `Java_<distribution>_<packageType>` (e.g. `Java_temurin_jdk`). The Java version directory
   stores `21.0.12+8` as `21.0.12-8`, because a `+` in `JAVA_HOME` breaks some toolchains.

The `python` flavor installs via the **upstream `setup.sh`** shipped inside the
`actions/python-versions` tarball — the same artifact `setup-python` downloads — rather than
reimplementing the layout, symlinks and marker by hand.

`rust` has **no** tool-cache entry on purpose: there is no first-party `setup-rust` that reads
the runner tool cache; the ecosystem standard (`dtolnay/rust-toolchain`) drives **rustup**,
which manages its own store. That flavor bakes rustup + the pinned toolchain onto `PATH`
instead. Both `RUSTUP_HOME` (`/opt/rust/rustup`) and `CARGO_HOME` must be **writable by the
runner user**: `dtolnay/rust-toolchain` runs `rustup toolchain install` + `rustup default`,
which write `toolchains/` and `settings.toml` under `RUSTUP_HOME`, and cargo writes the
registry index and crate cache under `CARGO_HOME` (root-owned, every dependency fetch fails
with `Permission denied (os error 13)`). `RUSTUP_HOME` is therefore chowned to the runner and
`CARGO_HOME` is repointed at `/home/runner/.cargo` at runtime. The microVM is single-use and
runs exactly one job, so there is no later job for a compromised one to poison.

The `go` flavor deliberately does **not** export a global `GOROOT`. `actions/setup-go` sets
`GOROOT` only for Go < 1.9; otherwise it just adds the cache entry's `bin` to `PATH`. A baked
`GOROOT` would survive the action and win, driving a job's chosen `go` binary against the
baked version's stdlib — so only the toolchain's `bin` goes on `PATH`, and each `go` derives
its own `GOROOT`. `JAVA_HOME` is safe to bake by contrast: `setup-java` `exportVariable`s it.

Toolchain versions are **pinned** in each Dockerfile so rebuilds are reproducible — which
makes them a patch-day obligation: a stale pin ages silently.

## Image build & snapshot pipeline

Mirrors the reference's staged approach, generalized to a flavor catalog.

```
microvm/
  Dockerfile.base        # base flavor
  Dockerfile.docker      # DinD flavor
  Dockerfile.node        # node flavor
  Dockerfile.python      # python flavor
  Dockerfile.java        # java flavor
  Dockerfile.go          # go flavor
  Dockerfile.rust        # rust flavor
  bootstrap/             # runner bootstrap scripts (shared)
  flavors.json           # flavor catalog: name, dockerfile, size, arch, label
scripts/build-images.ts  # build + snapshot + publish ARNs
```

Each `Dockerfile.<flavor>` is **self-contained** — `create-microvm-image` builds a snapshot
from a single staged `Dockerfile` in an uploaded context, not from a registry base image, so a
flavor cannot `FROM` the base flavor. The base layers are duplicated in each file and
`test/image-content.test.mjs` guards that they stay consistent (identical runner agent
version, run-hook wiring, arm64-only artifacts).

Build steps (per flavor):

1. Stage the flavor's `Dockerfile.<flavor>` as the build `Dockerfile`; zip `microvm/`.
2. Upload to the microVM **code bucket**.
3. Trigger microVM image build → snapshot, requesting the catalog's memory floor
   (`--resources minimumMemoryInMiB`) and `--cpu-configurations architecture=ARM_64`, plus
   `--additional-os-capabilities` for flavors that declare `osCapabilities` (ADR-020/028).
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

- The image declares `microvmHooks.run` with **`runTimeoutInSeconds: 60`** — the API maximum
  for that field (`MicrovmHooksRunTimeoutInSecondsInteger`: min 1, max 60; the image hooks'
  `readyTimeoutInSeconds` is a different shape and allows up to 3600 s). The hook's boot broker
  call is therefore bounded at **15 s per invoke × 2 attempts** (2 s backoff, 32 s worst case),
  so the retry budget fits the deadline with room for another full-length attempt. Both numbers
  are sized for a **cold `aws` CLI** in a snapshot-resumed guest, which is the dominant cost —
  not the broker ([ADR-028](../DECISIONS.md); the original 6 s/30 s pair left zero retry margin
  in live measurement, and the 60 s cap means the deadline cannot be raised to buy margin
  instead). The `ready` **image** hook pre-warms the CLI before the snapshot is captured, so a
  healthy boot resolves on attempt 1 and the raised bound is unused headroom. The warmup passes
  an explicit region (without one the CLI exits at `NoRegion` before the expensive
  endpoint/HTTP work) and logs `warmed` — whether it actually reached the connect attempt —
  alongside its duration. It cannot warm the credential/SigV4 path (no role in the build
  guest), which is part of why the boot bound stays generous. Every broker attempt logs its
  measured `ms`.

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
  `docs/VERIFY-M3.md`. Cold `dockerd` init measures ~40 s on Graviton (the vCPU count is not
  established — the API exposes no vCPU request, see ADR-038).

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
- Populate the **runner tool cache** so `setup-*` actions short-circuit rather than downloading a toolchain the image already has (see § Prebaked runner tool cache).
- Optional job-level cache: mount an EFS/S3-backed cache dir for package managers (Phase 3).
- Warm pool intentionally out of scope for v1 (single-use only); revisit if boot latency proves painful.

## Custom flavors (bring-your-own image)

> **Status: designed, NOT implemented.** This section is the agreed shape from ADR-040/041, not
> a description of shipped behavior. Nothing in `src/` reads a custom flavor today: the three
> catalog consumers (`src/provision/flavor.ts`, `src/mgmt/views.ts`, `src/ingest/compat.ts`)
> still import `microvm/flavors.json` statically, there is no `FLAVOR#` row writer or reader,
> and no validation state machine exists. Implementation is tracked as its own card. Read what
> follows as the contract that work must satisfy — do not cite it as an existing capability.

An operator may register a `custom-*` flavor for their own installation (ADR-040). Storage is
a per-installation row in the shared table (`pk=INSTALL#<id>`, `sk=FLAVOR#<name>`) — the
static JSON is compiled into the Lambdas and stays read-only. Resolution composes
`builtin ++ custom`; built-in names always win, and a custom flavor that collides with one is
rejected at registration rather than silently shadowing (or being shadowed by) it. Custom
flavors are visible only to their own installation, and their requested memory is bounds-checked
against the region's microVM quota with the derived per-minute rate surfaced before save.

A custom flavor is **not routable until it has demonstrably run a job** (ADR-041):
`pending → validating → valid | invalid(reason)`, and only `valid` flavors are selectable in a
`FlavorMap`/`defaultFlavor` or resolvable from a label. Validation is (1) static checks — arm64,
image ARN resolves and is readable by the provisioner, capabilities drawn from the closed
vocabulary (`docker`, `node`, `python`, `java`, `go`, `rust`), memory within quota — and (2) a
**smoke run**: one microVM launched from the image with a synthetic JIT-registered runner that
must register, execute a trivial job, and self-terminate through the hook broker. Static checks
alone are not sufficient evidence: the `docker` flavor built fine, published its ARN and routed
correctly while failing *every* job because nothing could start `dockerd` (ADR-019/020).
Re-validation is automatic when the image ARN changes and manually triggerable from the console.

## Constraints

- **arm64 only** — native x86 deps need arm64 builds or (slow) emulation. Flag at ingestion.
- **No runner reuse** — clean isolation, but every job pays boot; mitigated by snapshots.
- **Quota-bound concurrency** — request microVM quota increases early.
- **Snapshot storage** — small fixed monthly cost per flavor image; prune old versions.
