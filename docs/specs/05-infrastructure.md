# Spec 05 — Infrastructure & Deployment

Status: **Draft** · Plane: Cross-cutting

CDK stacks, secret handling, the phased deploy (image ARNs must exist before the
orchestrator), IAM posture, and operational concerns (quotas, cost, observability).

## Contents
- [Toolchain prerequisites](#toolchain-prerequisites)
- [Stack decomposition](#stack-decomposition)
- [Secrets (SSM SecureString)](#secrets-ssm-securestring)
- [Phased deployment](#phased-deployment)
- [IAM posture](#iam-posture)
- [Networking](#networking)
- [Observability](#observability)
- [Quotas & limits](#quotas--limits)
- [Cost model](#cost-model)
- [Environments](#environments)
- [Open questions](#open-questions)

---

## Toolchain prerequisites

The compute plane is built on **AWS Lambda MicroVMs** (GA 22 Jun 2026), exposed as a
distinct service namespace: `lambda-microvms` (API version **2025-09-09**) — NOT under
`aws lambda`. Tooling that predates the GA model cannot see the API and the phased deploy
will fail at the image-build step. Minimum versions:

| Tool | Minimum | Notes |
|---|---|---|
| **AWS CLI v2** | **≥ 2.35.17** | First versions shipping the `lambda-microvms` service model. `2.33.15` (and the Amazon Linux 2023 `awscli-2` dnf package as of 2026-07) do **not** have it. Verify with `aws lambda-microvms help`. |
| **botocore** | **≥ 1.43.44** | Ships `botocore/data/lambda-microvms/2025-09-09/`. Verify: `python3 -c "import boto3; boto3.client('lambda-microvms', region_name='us-west-2').create_microvm_image"`. |
| **boto3** | **≥ 1.43.44** | Pairs with the botocore floor above (any `@aws-sdk/client-lambda-microvms` for TS Lambdas must likewise post-date the GA model). |
| Node.js | ≥ 18 | Bootstrap scripts use built-ins only. |
| CDK v2 | ≥ 2.113 | App is CDK v2 TypeScript. |

These floors apply to the **deployer** — the host running `cdk deploy` / `npm run
build:images`, which calls the `lambda-microvms` API. They do **not** apply inside the runner
images: the guest only ever calls `lambda invoke` (the hook broker, ADR-021), so all three
flavors ship Ubuntu 22.04's apt `awscli` — aws-cli **v1** (1.22.34 / botocore 1.23.34) — and
that is sufficient. It is, however, the CLI whose **cold start** sizes the boot broker budget
and whose botocore error wording the pre-warm's `warmed` check matches ([ADR-028](../DECISIONS.md)),
so re-measure both before changing the guest CLI or base image.

**Check before deploying:**
```bash
aws --version                       # want ≥ 2.35.17
aws lambda-microvms help >/dev/null && echo "lambda-microvms OK"
aws lambda-microvms list-managed-microvm-images --region us-west-2
```
If the system CLI is too old, install the standalone AWS CLI v2 to a user prefix (no root)
and prepend it to `PATH` — do not rely on the distro package:
```bash
curl -sL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp/awscli-install
/tmp/awscli-install/aws/install --install-dir "$HOME/.local/aws-cli" --bin-dir "$HOME/.local/bin" --update
export PATH="$HOME/.local/bin:$PATH"
```

Region note: the managed base image (`arn:aws:lambda:<region>:aws:microvm-image:al2023-1`)
must exist in the target region. Confirmed present in `us-west-2`; `list-managed-microvm-images`
is the source of truth per region.

---

## Stack decomposition

CDK v2 (TypeScript). Split so the compute plane can be built before the control plane.

| Stack | Contains | Notes |
|---|---|---|
| `ImageStack` | microVM code bucket, image build role, (image ARNs via build script) | Deploy first; images built out-of-band |
| `ControlStack` | API GW `/webhook`, Ingest λ, SQS + DLQ, Provision λ, Discovery λ, Hook broker λ, Reaper λ + schedule | Depends on image ARNs in config |
| `DataStack` | DynamoDB table + GSI1 (status/time) + GSI2 (repo/time, ADR-023) | Shared by all planes |
| `MgmtStack` | HTTP API `/api/*` + `/auth/*`, Mgmt API λ | Management plane (M4). IAM boundary per ADR-025 |
| `WebStack` | S3 (OAC, private) + CloudFront; API attached as `/api/*` + `/auth/*` behaviors; vanity alias + A/AAAA records when a console domain is configured | Hosts the SPA; single origin per ADR-024, vanity domain per ADR-036 |
| `CertStack` | ACM certificate for the console's vanity hostname, DNS-validated | **us-east-1 only** — CloudFront accepts viewer certs from no other region. Created ONLY when `LCA_CONSOLE_*` is configured (ADR-036); needs a us-east-1 CDK bootstrap |
| ~~`AuthStack`~~ | — | **Dropped**: auth is GitHub OAuth + a signed session cookie, no Cognito user pool (ADR-022). The only resource it would own is the session secret — an out-of-band SecureString. |

Cross-stack refs kept minimal; config values (image ARNs, table names) flow via SSM
parameters rather than hard CFN exports where possible, to decouple deploy ordering. The one
unavoidable hard ref is `CertStack` → `WebStack`: a CloudFront viewer certificate must be
passed as an ARN, so both stacks set `crossRegionReferences: true` (CDK wires an SSM-backed
custom-resource pair across the region boundary). That ref only exists on the vanity-domain
path — with no console domain configured, every stack stays in `LCA_DEPLOY_REGION`.

## Secrets (SSM SecureString)

CloudFormation **cannot create** SecureStrings — so they're created **out-of-band** and
only *referenced* by CDK.

| Param | Type | Contents |
|---|---|---|
| `/lca/<env>/github/app-pem` | SecureString | GitHub App private key |
| `/lca/<env>/github/webhook-secret` | SecureString | HMAC secret |
| `/lca/<env>/github/client-id` | String | OAuth client id (console login) |
| `/lca/<env>/github/client-secret` | SecureString | OAuth client secret (console login) |
| `/lca/<env>/mgmt/session-secret` | SecureString | Console session cookie signing key (ADR-022) |
| `/lca/<env>/github/app-id` | String | App ID |
| `/lca/<env>/config/image-arn-<flavor>` | String | Published by build script |
| `/lca/<env>/config/runner-labels` | String | Claimed labels — the claim **allowlist** checked before flavor resolution. Must list every flavor label in `microvm/flavors.json` (plus any mapped label); a missing one means those jobs are never claimed. See [DEPLOY-M1](../DEPLOY-M1.md#phase-0--secrets-out-of-band-adr-008) |
| `/lca/<env>/config/table-name` | String | Published by `DataStack` |

`scripts/create-github-app.mjs` writes the GitHub App credentials (app id, PEM, webhook
secret, OAuth client id/secret) after the App Manifest flow; the console session secret is
created manually (see [DEPLOY-M4](../DEPLOY-M4.md) phase 0). CDK grants specific Lambdas
`ssm:GetParameter` on specific paths only — and the Mgmt λ gets **no** grant on the App PEM
or webhook secret; it checks their presence with `ssm:DescribeParameters`, which returns
metadata only (ADR-025).

## Phased deployment

Same three-step shape as the reference, generalized:

```
1. deploy infra        →  cdk deploy ImageStack DataStack
                          (bucket + build role + tables; no orchestrator yet —
                           image ARNs don't exist)

2. build microVM images →  npm run build:images
                          (per flavor: stage Dockerfile.<flavor>, zip microvm/,
                           upload, build, snapshot, poll, prune, write image ARN → SSM)

3. deploy orchestrator  →  cdk deploy ControlStack MgmtStack WebStack
                          (+ CertStack in us-east-1 when a vanity domain is configured;
                           now image ARNs exist in SSM — Ingest/Provision/Discovery/Reaper λ,
                           API GWs, and the console all come up)

4. console origin pass  →  npm run build:web
                          cdk deploy MgmtStack -c publicOrigin=https://<cloudfront-domain>
                          (ONLY when no vanity domain is configured: the management API
                           can't know CloudFront's generated origin until the distribution
                           exists — two-pass by design, ADR-024. With LCA_CONSOLE_* set the
                           origin comes from config and this step disappears, ADR-036)
```

Re-running step 2 rebuilds images (e.g. patch day); steps 3–4 are idempotent. Full console
runbook: [DEPLOY-M4](../DEPLOY-M4.md).

## IAM posture

Least privilege per Lambda:

| Lambda | Allowed |
|---|---|
| Ingest | read webhook secret; `sqs:SendMessage`; `dynamodb:PutItem/UpdateItem` (installations, runs) |
| Provision | read app-pem + image ARNs; mint GitHub tokens (network egress); launch/terminate microVMs (region-scoped — the GA API can't tag VMs, ADR-015); write runs |
| Reaper | list live microVMs + terminate orphans (by run-store `microvmId`); update run rows |
| Hook broker | `dynamodb:GetItem` on the run table (no Query/Scan, no index); `lambda:TerminateMicrovm` (region-scoped). Called ONLY by microVMs, token-gated to the caller's own run; 20 reserved concurrent executions (ADR-021) |
| microVM exec role | its own log group; `lambda:InvokeFunction` on the hook broker ARN. **Nothing else** — no DynamoDB, no microVM control (ADR-021) |
| Mgmt API | read the shared table + run log group; `dynamodb:UpdateItem` (config only — no Put/Delete); `sqs:SendMessage` on the discovery queue; read ONLY its own OAuth/session secrets; `ssm:DescribeParameters` for presence checks. **No** token minting, **no** microVM launch/terminate, **no** `iam:PassRole`, **no** access to the App PEM (ADR-025, asserted in `test/mgmt-stack.test.mjs`) |
| Image build | `s3:*` on code bucket; microVM image build APIs |

microVM launch/terminate IAM is scoped to account/region (`aws:RequestedRegion`), NOT by
VM tag — the GA `lambda-microvms` API doesn't support tagging a VM (see ADR-015). Runtime
isolation comes from the dedicated per-env execution role + the run store as the
authoritative run↔VM mapping.

The microVM execution role is the sharpest edge here — it is stamped on VMs running
**untrusted workflow code**. Per **ADR-021** it holds no ambient authority: its DynamoDB
read and its `lambda:TerminateMicrovm` were removed and replaced by a single
`lambda:InvokeFunction` on the hook broker λ, which performs both operations against the
caller's OWN run only (authorized by a per-run capability token; the DDB key is derived from
the token-bound ref). `test/exec-role-iam.test.mjs` asserts this against the synthesized
template, so re-widening the role fails the build.

## Networking

- Default: microVMs run without VPC (simplest, internet egress via AWS).
- Opt-in **VPC attachment** per flavor/repo for jobs needing private resources; enables
  egress filtering. Adds ENI setup latency — document the tradeoff.
- API Gateways are public (webhook must be reachable by GitHub; `/api` behind auth).

## Observability

- **Logs**: each runner → its own CloudWatch log stream inside the per-env run log group
  (`/aws/lambda/microvms/runs/lca-<env>`, ADR-016); Lambdas → standard log groups. The
  console's log viewer reads that group filtered by the run's `microvmId` (ADR-019) — log
  bodies never land in DynamoDB.
- **Metrics**: emit `RunsQueued`, `RunsRunning`, `ProvisionLatency`, `BootLatency`, `JobDuration`, `ProvisionFailures`, `QuotaThrottles` (custom CW metrics).
- **Alarms**: DLQ depth > 0; `QuotaThrottles > 0`; stuck-`provisioning` age; provision error rate.
- **Tracing**: X-Ray across API GW → Lambda → SQS for the hot path.

## Quotas & limits

- **microVM service quota** is the primary concurrency ceiling; defaults are **low and inconsistently granted** (per reference). Request increases per account **early** in M1.
- Lambda reserved concurrency on Provision λ bounds launch rate (protects downstream + quota).
- SQS provides backpressure; DLQ isolates poison messages.
- Document per-account quota status in the UI Settings screen (manual entry or Service Quotas API read).

## Cost model

Rough, per reference (validate in M1):

| Item | Rate |
|---|---|
| microVM ≈ 2 vCPU / 4 GB | ≈ \$0.0044 / min (per-second billed) |
| Snapshot storage/IO | ≈ \$1.50 / month / flavor image |
| Lambda + API GW + SQS + Dynamo | negligible at low volume |
| CloudFront + S3 (UI) | negligible |

> **Sizing caveat (ADR-038)**: the vCPU half of that reference shape is **not requestable** —
> `create-microvm-image` accepts `--resources minimumMemoryInMiB` and
> `--cpu-configurations architecture=ARM_64` only, and `run-microvm` takes no sizing parameter
> at all. Memory is the one dimension the build script requests (and the one the microVM quota
> is denominated in); the vCPU figure is a reference point for the rate, not a provisioned
> shape. Treat every derived cost as an estimate.

Compared to GitHub `linux_2_core_arm` ≈ \$0.005/min → roughly a wash, favoring many short
jobs (per-second vs per-minute). Real win is **latency** + **VPC access**, not raw price.

## Environments

- `dev` and `prod` as separate AWS accounts (or at least separate regions), each with its
  own GitHub App + secrets. One App per account+region in v1 (see [01](01-github-app.md) OQ-3).
- CDK context / `.env` selects the environment; secrets namespaced under `/lca/<env>/...`.

## Open questions

- **OQ-1**: Single DynamoDB table (single-table design) vs a few tables? (Leaning single-table + GSIs.)
- **OQ-2**: SSM Parameter Store vs Secrets Manager for the App PEM? (SSM SecureString per reference + cheaper; Secrets Manager gives rotation. Leaning SSM v1.)
- **OQ-3**: Multi-region active/active for the webhook endpoint, or single region + DR? (Leaning single region v1.)
