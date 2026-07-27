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
  Dockerfile.docker       `docker` flavor — base + Docker engine (arm64, 4 vCPU / 8 GB)
  bootstrap/
    run-hook.mjs          Lifecycle-hook HTTP server (:8080): /run, /terminate, /healthz
```

## Boot model (ADR-012)

Lambda microVMs do **not** use user-data + `run.sh`. Instead:

1. `create-microvm-image` builds a snapshot from `Dockerfile.<flavor>` → an image ARN.
2. `run-microvm --image-identifier <ARN> --run-hook-payload <JSON>` launches a VM.
3. After the snapshot boots, Lambda delivers the payload to `POST /run` on the image's
   HTTP hook server (`:8080`). Traffic is gated until `/run` returns 200.
4. `run-hook.mjs` parses the `{ ref, region, table }` pointer, fetches the JIT config
   from DynamoDB by ref (ADR-016), ACKs 200, and runs `./run.sh --jitconfig <jitConfig>`
   in the background — **exactly one job**.
5. On agent exit, the hook reads its own `microvmId` back off the run row (Provision
   stamps it post-launch — there is no in-guest id source, ADR-019) and calls
   `terminate-microvm` to self-destruct. The Reaper λ backstops orphans (spec 02).

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

```sh
npm run build:images -- --env dev --region us-west-2
```

Add `--dry-run` to print the plan without calling AWS.
