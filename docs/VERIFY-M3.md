# M3 verification — flavor routing, end-to-end on the deployed stack

**Verdict: M3 exit criterion PASSED.**

> 🎯 *A repo with docker + node jobs routes each to the right flavor with no YAML edits
> beyond adding LCA labels.* — `docs/ROADMAP.md` § M3

Verified against the live `dev` deployment on **2026-07-27**. Getting there required fixing
one real platform defect in the `docker` flavor (see [Defect found](#defect-found-docker-flavor-could-never-start-dockerd)
and **ADR-019**) — the routing logic itself was correct on first run.

---

## Environment under test

| | |
|---|---|
| Account / region | `863638663908` / `us-west-2` (pinned via `.env.local`, ADR-018) |
| Stacks | `LCA-Image-dev`, `LCA-Data-dev`, `LCA-Control-dev` |
| Source | `main` @ `945aa0e` + the ADR-019 fix on this branch |
| Toolchain | AWS CLI **2.36.8** (`aws lambda-microvms` present — the floor is ≥ 2.35.17) |
| Control plane | `lca-dev-ingest`, `lca-dev-discovery`, `lca-dev-provision`, `lca-dev-reaper` |
| Images | `lca-dev-base`, `lca-dev-node`, `lca-dev-docker` (all rebuilt from this tree) |
| GitHub App | `lambdaciactions-dev` (app id `4292494`, installation `146431062`) |
| Webhook | `https://w061napnkg.execute-api.us-west-2.amazonaws.com/webhook` |

The deployed `LCA-Control-dev` predated M3-S4 (no Discovery λ), so the phased deploy was
re-run in order: infra (no diff) → **build images** (all three flavors) → orchestrator.
The control-plane deploy added `DiscoveryFn` + `DiscoveryQueue`/`DiscoveryDLQ` and updated
`IngestFn` / `ProvisionFn`.

## Test fixture

Repo **`jsamuel1/lca-m3-verify`** (repo id `1313438232`), created for this verification.
One workflow, `.github/workflows/flavors.yml`, three jobs. The **only** LCA-specific
content is the `runs-on` label — no `container:`, no platform conditionals, no setup steps
added for the platform:

| Job | `runs-on` | Asserts |
|---|---|---|
| `node-job` | `[self-hosted, lambda-ci-node]` | `node`/`npm` preinstalled; `npm run build` |
| `docker-job` | `[self-hosted, lambda-ci-docker]` | `docker version` (server!) + `docker run arm64v8/alpine` |
| `base-job` | `[self-hosted, lambda-ci]` | `git`/`jq` present, nothing else |

The repo was picked up automatically: the App installation covers all repos, so
`installation_repositories` → Discovery λ scanned it before any push
(`{"msg":"discovery scan","repo":"jsamuel1/lca-m3-verify","reason":"installation"}`), then
the workflow push re-scanned it (`"reason":"push","files":1`).

## Evidence

### 1. Discovery + parse + compat gate (DynamoDB `lca-dev`, `REPO#1313438232 / WF#…`)

The Discovery λ parsed the workflow and stored a per-job routing preview and compat result:

```json
routes: {
  "node-job":   { "flavor": "node",   "reason": "explicit LCA label 'lambda-ci-node'" },
  "docker-job": { "flavor": "docker", "reason": "explicit LCA label 'lambda-ci-docker'" },
  "base-job":   { "flavor": "base",   "reason": "explicit LCA label 'lambda-ci'" }
}
compat: { "level": "ok", "jobs": { "node-job": {"level":"ok","eligible":true},
                                   "docker-job": {"level":"ok","eligible":true},
                                   "base-job": {"level":"ok","eligible":true} } }
```

All three jobs `eligible: true` → the Ingest claim gate let them through (no `blocked`
lines in `/aws/lambda/lca-dev-ingest`).

### 2. Flavor routing at provision time (`/aws/lambda/lca-dev-provision`, run `30244719785`)

```
{"msg":"flavor resolved","jobId":89909148434,"flavor":"base","reason":"explicit LCA label 'lambda-ci'"}
{"msg":"microVM launched","microvmId":"microvm-300cb2c8-…","flavor":"base"}
{"msg":"flavor resolved","jobId":89909148384,"flavor":"node","reason":"explicit LCA label 'lambda-ci-node'"}
{"msg":"microVM launched","microvmId":"microvm-a74bf736-…","flavor":"node"}
{"msg":"flavor resolved","jobId":89909148425,"flavor":"docker","reason":"explicit LCA label 'lambda-ci-docker'"}
{"msg":"microVM launched","microvmId":"microvm-85c95f7e-…","flavor":"docker"}
```

Three jobs → three distinct flavors → three distinct microVMs, one per job.

### 3. Run records (DynamoDB `lca-dev`, run `30244719785`)

| Job id | Labels | Flavor | microVM | Status |
|---|---|---|---|---|
| `89909148434` | `self-hosted, lambda-ci` | `base` | `microvm-300cb2c8-…` | `completed` |
| `89909148384` | `self-hosted, lambda-ci-node` | `node` | `microvm-a74bf736-…` | `completed` |
| `89909148425` | `self-hosted, lambda-ci-docker` | `docker` | `microvm-85c95f7e-…` | `completed` |

### 4. GitHub check results (run [`30244719785`](https://github.com/jsamuel1/lca-m3-verify/actions/runs/30244719785))

`conclusion: success` for the workflow and for **all three** jobs. In-guest proof from the
job logs:

- every job: `uname -m` → `aarch64` (arm64 throughout, per AGENTS.md)
- `node-job`: node + npm present without any `setup-node` toolchain download
- `docker-job`: `Server: Docker Engine - Community` (a *server* section, i.e. the daemon
  answered) and `docker run --rm arm64v8/alpine:3.20 uname -m` → `aarch64`

### 5. Boot latency + per-job cost

Measured from the same run (`/aws/lambda/lca-dev-provision` + the guest log group
`/aws/lambda/microvms/runs/lca-dev`):

| Phase | base | node | docker |
|---|---|---|---|
| `RunMicrovm` call → `/run` hook delivered (**boot**) | ~1.4 s | ~1.2 s | ~1.4 s |
| `/run` → runner agent picks up the job | ~6 s | ~6 s | ~55 s¹ |
| Job wall-clock (agent start → conclusion) | ~19 s | ~24 s | ~100 s |
| microVM total billed lifetime (launch → self-terminate) | ~19 s | ~24 s | ~96 s |

¹ the `docker` flavor's pre-run hook starts `dockerd` before handing over to the agent;
cold daemon init measured **32–39 s** across runs on 4 vCPU Graviton (see the caveat below).

Per-job cost at the reference Graviton rate (2 vCPU / 4 GB ≈ **$0.0044/min**, 4 vCPU / 8 GB
≈ **$0.0088/min**), billed per second:

| Flavor | Lifetime | Rate | Cost |
|---|---|---|---|
| `base` (2/4) | 19 s | $0.0044/min | ≈ **$0.0014** |
| `node` (2/4) | 24 s | $0.0044/min | ≈ **$0.0018** |
| `docker` (4/8) | 96 s | $0.0088/min | ≈ **$0.0141** |

Boot latency is consistent with the M1 measurement — snapshot boot is ~1–1.5 s and is not
the dominant term; agent handshake and (for `docker`) daemon init are.

## Defect found: docker flavor could never start dockerd

Routing was right on the first run, but **every** `docker-job` failed at `docker version`
with `dial unix /var/run/docker.sock: connect: no such file or directory`. Three stacked
in-guest constraints, each established by probe jobs on real microVMs:

1. **Nothing started the daemon.** Spec 02 assumed the run-hook would start `dockerd`, and
   `run-hook.mjs` did call an optional `${RUNNER_DIR}/pre-run.sh` — but no such hook was
   ever written or baked into the image.
2. **`sudo` cannot escalate in-guest.** The guest boots with `NoNewPrivs: 1`; sudo fails
   with *"The \"no new privileges\" flag is set"*. A `USER runner` entrypoint can never
   reach root, so the hook could not start a rootful daemon.
3. **A default microVM cannot host a rootful daemon at all.** `CapEff`/`CapPrm`/`CapInh`
   are empty, `/sys` is read-only, and `/sys/fs/cgroup` is an empty read-only directory.
   `mount -t cgroup2` returns EPERM even inside `unshare -Urmn`, so `dockerd` exits with
   `failed to start daemon: Devices cgroup isn't mounted`. Rootless Docker is not an
   escape hatch: the same mount denial applies and `dockerd-rootless.sh` isn't shipped by
   the Docker apt packages.

**Fix (ADR-019)** — scoped to the one flavor that asks for Docker:

- build the `docker` image with the GA API's `--additional-os-capabilities ALL` (declared
  per flavor as `osCapabilities` in `microvm/flavors.json`, forwarded by
  `scripts/build-images.mjs`);
- keep a **root entrypoint** for that flavor only, and have `run-hook.mjs` drop to the
  `runner` user with `setpriv --reuid/--regid/--init-groups` (downward privilege changes
  are allowed under `no_new_privs`; the agent refuses to run as root);
- ship `microvm/bootstrap/pre-run.docker.sh` as `${RUNNER_DIR}/pre-run.sh` — mounts cgroup2
  if absent, starts `dockerd`, polls the API with a bounded wait.

After the fix the same unchanged fixture went green: `cgroup=0::/ controllers=cpuset cpu io
memory hugetlb pids` → `dockerd ready in 39s: 29.6.2` → `docker run arm64v8/alpine` →
`aarch64`. `base` and `node` remain unprivileged (`USER runner`, no extra capabilities);
`test/image-content.test.mjs` pins that asymmetry.

A confirming re-run on the exact image built from this branch
([`30245239270`](https://github.com/jsamuel1/lca-m3-verify/actions/runs/30245239270)) was
green on all three jobs (`dockerd ready in 32s`).

## Known gaps (not M3 blockers)

- **`docker` cold-start is slow.** `dockerd` init measured 32–39 s, which dominates a short
  docker job's cost. The readiness wait was raised from 45 s → 120 s so a slow-but-healthy
  daemon isn't killed. Pre-warming containerd into the snapshot is a Phase-3 item
  (alongside the warm pool, ADR-006).
- **`microvmId` self-discovery still fails in-guest.** `{"msg":"microvm id discovery
  failed", … envKeys:[AWS_LAMBDA_MICROVM_IMAGE_*]}` → the run-hook falls back to
  `{"msg":"no microvm id available; relying on Reaper"}`, so VMs are swept within ~5 min
  instead of self-terminating instantly. The run-row readback fix for this exists on the
  unmerged `kermes/task-fiery-butterfly` branch; the cost figures above use launch→job-end
  and therefore *understate* today's actual billed lifetime.
- **`transitions` is empty on the run records** (`transitions: 0`) even though status
  advances `queued → provisioning → running → completed`. Terminal status and flavor are
  correct; the per-transition audit list isn't being appended. Worth a look in M4 when the
  UI starts reading run history.

## Reproducing

```sh
# 0. pin the target + toolchain floor
cp .env.local.example .env.local     # LCA_DEPLOY_ACCOUNT=…  LCA_DEPLOY_REGION=us-west-2
aws --version                         # ≥ 2.35.17
aws lambda-microvms help >/dev/null && echo OK

# 1. phased deploy
npx cdk deploy LCA-Image-dev -c env=dev
npm run build:images -- --env dev --region us-west-2      # all three flavors
npx cdk deploy LCA-Data-dev LCA-Control-dev -c env=dev

# 2. trigger the fixture (App installation must cover the repo)
gh workflow run flavors.yml --repo <owner>/lca-m3-verify

# 3. read the evidence
aws logs tail /aws/lambda/lca-dev-provision --since 10m | grep -E 'flavor resolved|microVM launched'
aws logs tail /aws/lambda/microvms/runs/lca-dev --since 10m
aws dynamodb scan --table-name lca-dev \
  --filter-expression 'begins_with(pk, :p)' \
  --expression-attribute-values '{":p":{"S":"RUN#<repoId>#<runId>"}}'
```
