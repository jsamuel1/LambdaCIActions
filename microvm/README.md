# microVM runner images

Flavor images for LambdaCIActions runners. Built into Lambda microVM snapshots and booted
one-per-job. See [docs/specs/02-microvm-runners.md](../docs/specs/02-microvm-runners.md)
and [ADR-012](../docs/DECISIONS.md).

## Layout

```
microvm/
  flavors.json            Flavor catalog (name, label, dockerfile, arch, size)
  Dockerfile.base         `base` flavor — Ubuntu arm64 + runner agent + run-hook
  Dockerfile.node         `node` flavor — base + Node.js LTS toolchain (npm/pnpm/yarn)
  Dockerfile.python       `python` flavor — base + CPython 3.12 (arm64)
  Dockerfile.java         `java` flavor — base + Eclipse Temurin JDK 21 LTS (aarch64)
  Dockerfile.go           `go` flavor — base + pinned Go + cgo C toolchain
  Dockerfile.rust         `rust` flavor — base + pinned Rust stable via rustup
  Dockerfile.docker       `docker` flavor — base + Docker engine (arm64, 4 vCPU / 8 GB)
  bootstrap/
    run-hook.mjs          Lifecycle-hook HTTP server (:8080): /run, /terminate, /healthz
```

Each `Dockerfile.<flavor>` is **self-contained** and duplicates the base layers — a snapshot
is built from one staged `Dockerfile` in an uploaded context, so a flavor cannot `FROM` the
base flavor. Keep the shared layers in sync; `test/image-content.test.mjs` enforces the
invariants that matter (same runner agent version, run-hook wiring, arm64-only artifacts).

## Prebaked runner tool cache

The `node`, `python`, `java` and `go` flavors install their toolchain into the runner tool
cache so `actions/setup-*` resolves from cache instead of downloading:

```
${RUNNER_TOOL_CACHE}/<toolName>/<version>/<arch>/          # toolchain
${RUNNER_TOOL_CACHE}/<toolName>/<version>/<arch>.complete  # SIBLING marker — required
```

Gotchas (all three are silent failures — the job just re-downloads at full speed):

- **Set `RUNNER_TOOL_CACHE` in the image.** A self-hosted runner does not default to
  `/opt/hostedtoolcache`; without the env var the agent uses `_work/_tool` and never sees the
  prebaked cache.
- **The `.complete` marker is a sibling of the arch dir**, not a file inside it.
- **`toolName` is a case-sensitive path**: `Python`, `node`, `go`, `Java_temurin_jdk`. Java's
  version dir uses `-` where the version uses `+` (`21.0.12-8`).

`python` installs via the upstream `setup.sh` inside the `actions/python-versions` tarball —
the same artifact `setup-python` downloads — rather than hand-rolling the layout.

`rust` has no tool-cache entry: the Rust actions drive **rustup**, not the runner tool cache,
so that flavor bakes rustup + the pinned toolchain onto `PATH` instead.

Toolchain versions are pinned via `ARG` in each Dockerfile (reproducible rebuilds) — bump them
deliberately on patch day.

## Boot model (ADR-012)

Lambda microVMs do **not** use user-data + `run.sh`. Instead:

1. `create-microvm-image` builds a snapshot from `Dockerfile.<flavor>` → an image ARN.
2. `run-microvm --image-identifier <ARN> --run-hook-payload <JSON>` launches a VM.
3. After the snapshot boots, Lambda delivers the payload to `POST /run` on the image's
   HTTP hook server (`:8080`). Traffic is gated until `/run` returns 200.
4. `run-hook.mjs` parses the `{ ref, region, broker, token }` pointer, fetches the JIT
   config by invoking the **hook broker λ** with its per-run capability token (ADR-021 — the
   VM has no DynamoDB permission), ACKs 200, and runs `./run.sh --jitconfig <jitConfig>`
   in the background — **exactly one job**.
5. On agent exit, the hook asks the broker to terminate this VM. The broker reads the run
   row's `microvmId` (Provision stamps it post-launch — there is no in-guest id source,
   ADR-019) and calls `terminate-microvm`; the VM itself never holds that permission and
   never learns any VM id (ADR-021). The Reaper λ backstops orphans (spec 02).

The `--run-hook-payload` is capped at **4 KB** (ADR-016); the JIT config is passed by
reference, never inline.

## arm64 only

Graviton-only (AGENTS.md hard rule). The base image, runner tarball
(`actions-runner-linux-arm64`), and Node build are all arm64. Do not introduce x86_64
bases or binaries — the snapshot build would produce an unbootable image.

## Building

Images are built out-of-band (phase 2 of the deploy, spec 05) by
[`scripts/build-images.mjs`](../scripts/build-images.mjs), which stages the Dockerfile,
zips this directory, uploads it to the code bucket (from `ImageStack`),
runs `create-microvm-image`, polls to `CREATED`, and publishes the image ARN to SSM at
`/lca/<env>/config/image-arn-<flavor>`.

Sizing (ADR-030): the build requests `--resources minimumMemoryInMiB=<memoryMb>` from the
catalog plus `--cpu-configurations architecture=ARM_64`. **Memory is the only requestable
dimension** — the GA API has no vCPU knob and `run-microvm` takes no sizing parameter at all,
so the catalog's `vcpu` is descriptive.

```sh
npm run build:images -- --env dev --region us-west-2
```

Add `--dry-run` to print the plan without calling AWS. Build one flavor with
`--flavor <name>`.
