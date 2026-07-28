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
| `ControlStack` | API GW `/webhook`, Ingest λ, SQS + DLQ, Provision λ, Hook broker λ, Reaper λ + schedule | Depends on image ARNs in config |
| `DataStack` | DynamoDB table(s) + GSIs | Shared by all planes |
| `MgmtStack` | API GW `/api/*`, Mgmt API λ, (optional WS API) | Management plane |
| `WebStack` | S3 bucket, CloudFront dist, OAI/OAC | Hosts the SPA |
| `AuthStack` | GitHub OAuth config, optional Cognito user pool | Referenced by Mgmt + Web |

Cross-stack refs kept minimal; config values (image ARNs, table names) flow via SSM
parameters rather than hard CFN exports where possible, to decouple deploy ordering.

## Secrets (SSM SecureString)

CloudFormation **cannot create** SecureStrings — so they're created **out-of-band** and
only *referenced* by CDK.

| Param | Type | Contents |
|---|---|---|
| `/lca/github/app-pem` | SecureString | GitHub App private key |
| `/lca/github/webhook-secret` | SecureString | HMAC secret |
| `/lca/github/oauth-client-secret` | SecureString | UI OAuth client secret |
| `/lca/github/app-id` | String | App ID |
| `/lca/config/image-arn-<flavor>` | String | Published by build script |
| `/lca/config/runner-labels` | String | Claimed labels |

Setup script (`scripts/bootstrap-secrets.ts`) creates the SecureStrings interactively;
CDK grants specific Lambdas `ssm:GetParameter` on specific paths only.

## Phased deployment

Same three-step shape as the reference, generalized:

```
1. deploy infra        →  cdk deploy ImageStack DataStack
                          (bucket + build role + tables; no orchestrator yet —
                           image ARNs don't exist)

2. build microVM images →  npm run build:images
                          (per flavor: stage Dockerfile.<flavor>, zip microvm/,
                           upload, build, snapshot, poll, prune, write image ARN → SSM)

3. deploy orchestrator  →  cdk deploy ControlStack MgmtStack WebStack AuthStack
                          (now image ARNs exist in SSM; Ingest/Provision/Reaper λ,
                           API GWs, SPA, auth all come up)
```

Re-running step 2 rebuilds images (e.g. patch day); step 3 is idempotent.

## IAM posture

Least privilege per Lambda:

| Lambda | Allowed |
|---|---|
| Ingest | read webhook secret; `sqs:SendMessage`; `dynamodb:PutItem/UpdateItem` (installations, runs) |
| Provision | read app-pem + image ARNs; mint GitHub tokens (network egress); launch/terminate microVMs (region-scoped — the GA API can't tag VMs, ADR-015); write runs |
| Reaper | list live microVMs + terminate orphans (by run-store `microvmId`); update run rows |
| Hook broker | `dynamodb:GetItem` on the run table (no Query/Scan, no index); `lambda:TerminateMicrovm` (region-scoped). Called ONLY by microVMs, token-gated to the caller's own run; 20 reserved concurrent executions (ADR-021) |
| microVM exec role | its own log group; `lambda:InvokeFunction` on the hook broker ARN. **Nothing else** — no DynamoDB, no microVM control (ADR-021) |
| Mgmt API | read all plane tables; write **config** entities only; **no** token minting, **no** microVM launch |
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

- **Logs**: each runner → its own CloudWatch log stream; Lambdas → standard log groups. UI reads runner logs via `log_ref`.
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
| microVM 2 vCPU / 4 GB | ≈ \$0.0044 / min (per-second billed) |
| Snapshot storage/IO | ≈ \$1.50 / month / flavor image |
| Lambda + API GW + SQS + Dynamo | negligible at low volume |
| CloudFront + S3 (UI) | negligible |

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
