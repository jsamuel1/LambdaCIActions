# Spec 05 — Infrastructure & Deployment

Status: **Draft** · Plane: Cross-cutting

CDK stacks, secret handling, the phased deploy (image ARNs must exist before the
orchestrator), IAM posture, and operational concerns (quotas, cost, observability).

## Contents
- [Toolchain prerequisites](#toolchain-prerequisites)
- [Stack decomposition](#stack-decomposition)
- [Secrets (SSM SecureString)](#secrets-ssm-securestring)
- [Phased deployment](#phased-deployment)
- [Flavor publication & reconciliation](#flavor-publication--reconciliation)
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
| `DeployStack` | CI deploy identity: the `lca-<env>-github-deploy` role (GitHub OIDC), trust pinned to one repo + `refs/heads/main`; `sts:AssumeRole` on the four CDK bootstrap roles plus two read-only grants CD's own steps need | **Workstation deploy only** — never in CD's allowlist, or a CD run could widen its own credential (ADR-047). No stack dependencies. References the account's OIDC provider (an account-level singleton) unless `-c createGithubOidcProvider=true` |
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
| `/lca/<env>/github/app-slug` | String | App slug, for install URLs. Written by `create-github-app.mjs` and re-written by the App-config broker on relink/rollback (ADR-034) |
| `/lca/<env>/config/image-arn-<flavor>` | String | Published by build script |
| `/lca/<env>/config/runner-labels` | String | Claimed labels — the claim **allowlist** checked before flavor resolution. Seeded with `lambda-ci` at phase 0; `build:images` appends each flavor's label after that flavor's image verifies (ADR-049), and never removes one. A label with no image is worse than a missing label — see [Flavor publication & reconciliation](#flavor-publication--reconciliation). Check with `npm run flavors:reconcile`. See [DEPLOY-M1](../DEPLOY-M1.md#phase-0--secrets-out-of-band-adr-008) |
| `/lca/<env>/config/table-name` | String | Published by `DataStack` |
| `/lca/<env>/config/platform-admins` | String | Comma-separated GitHub logins allowed to make **platform-wide** settings changes (relink the App, change runner labels, test webhook delivery). **Fails closed** — unset authorizes nobody (ADR-035). Created manually, see [DEPLOY-M4](../DEPLOY-M4.md) |

`scripts/create-github-app.mjs` writes the GitHub App credentials (app id, PEM, webhook
secret, OAuth client id/secret) after the App Manifest flow; the console session secret is
created manually (see [DEPLOY-M4](../DEPLOY-M4.md) phase 0). CDK grants specific Lambdas
`ssm:GetParameter` on specific paths only — and the Mgmt λ gets **no** grant on the App PEM
or webhook secret; it checks their presence with `ssm:DescribeParameters`, which returns
metadata only (ADR-025).

## Phased deployment

Same three-step shape as the reference (infra → images → orchestrator), generalized — plus a
console-origin pass, and a one-time step 0 when CD is used:

```
0. CI deploy identity   →  cdk deploy DeployStack   # once per env, FROM A WORKSTATION
   (only if CD is used)    (LCA-Deploy-<env>: the GitHub-OIDC role CD assumes. Outside this
                            sequence's dependency chain, and deliberately NOT deployable by
                            CD itself — ADR-047. Steps 1-4 need no OIDC role at all.)

1. deploy infra        →  cdk deploy ImageStack DataStack
                          (bucket + build role + tables; no orchestrator yet —
                           image ARNs don't exist)

2. build microVM images →  npm run build:images -- --env <env>
                          (per flavor: stage Dockerfile.<flavor>, zip microvm/,
                           upload, build, snapshot, poll, prune, write image ARN → SSM,
                           THEN add the flavor's label to runner-labels — in that order,
                           ADR-049)
                          NOTE: this is a node script, not the CDK app — it reads its own
                          `--env` (default `dev`), NOT `-c env=…`. On a prod deploy the flag
                          is mandatory, or the ARNs land under /lca/dev and step 3 fails.

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

Steps 3–4 for `MgmtStack` + `WebStack` are what CD automates once step 0 is done
(`.github/workflows/deploy.yml`, ADR-047) — always with `--exclusively`, because `MgmtStack`
declares CDK dependencies on `DataStack` + `ControlStack` and CD must never redeploy the
control plane that owns the runner executing the job. Steps 1–2, `ControlStack` and
`CertStack` stay workstation-only. Runbook: [DEPLOY-M4](../DEPLOY-M4.md) § Deploy via CI.

Re-running step 2 rebuilds images (e.g. patch day); steps 3–4 are idempotent. Full console
runbook: [DEPLOY-M4](../DEPLOY-M4.md).

## Flavor publication & reconciliation

Step 2 publishes **two** pieces of live state per flavor, and the order between them is a
safety property (ADR-049):

1. `/lca/<env>/config/image-arn-<flavor>` — only after the image reaches `CREATED`/`UPDATED`.
2. `/lca/<env>/config/runner-labels` — the flavor's label appended, and **only** if (1)
   verified. `build:images` refuses otherwise.

The asymmetry that forces the order: an image with no label leaves the job queued on GitHub,
where a GitHub-hosted runner can still take it. A label with no image makes Ingest *claim* the
job — which surrenders that fallback — and then fail in provisioning. So the intermediate state
of a correct publication is recoverable, and the intermediate state of the reverse is not.

Because both are **deployment** facts, no repository test can prove them. `npm run
flavors:reconcile` is the check:

| source | fact |
|---|---|
| `microvm/flavors.json` | which flavors are *advertised* |
| `/lca/<env>/config/runner-labels` | which labels Ingest will *claim* |
| `/lca/<env>/config/image-arn-<flavor>` | which flavors *point at* an image |
| `get-microvm-image` | whether that image *exists*, and in what state |

It is read-only, deploy-target pinned (ADR-018/ADR-037 — a `ParameterNotFound` from the wrong
region is indistinguishable from a missing flavor), and exits non-zero on drift: 1 for drift, 2
when live state could not be read at all (including an image probe that failed for any reason
other than `ResourceNotFoundException` — unknown is not absent). `--fix` builds a missing image
or adds a label for a verified one; it never removes a label, refuses on a non-quiescent fleet,
and refuses on an incomplete probe. A `--fix` run that clears only the safely-fixable half still
exits 1, and a failed remediation exits 2 rather than passing as drift. Verdicts come from
`src/shared/flavor-reconcile.ts`, which the console health item must consume when it lands so the
CLI and the console cannot disagree.

`build:images` carries the same quiesce refusal as `--fix` (all pages of non-terminated
microVMs), because `--fix` remediates by invoking it — gating only the wrapper would leave the
documented primary command as the one path that can race a resuming VM against the image being
replaced. `--publish-label-only` and `--dry-run` are exempt: neither touches an image.

Building is **workstation-only**. CD runs the reconcile as a report-only step
(`--no-image-check`, `continue-on-error`) under a credential scoped to `/lca/<env>/config/*`;
it holds no microVM-image authority, and an image build could not honour its own quiesce
precondition from inside a microVM job anyway (ADR-047/ADR-049).

## IAM posture

Least privilege per Lambda:

| Lambda | Allowed |
|---|---|
| Ingest | read webhook secret; `sqs:SendMessage`; `dynamodb:PutItem/UpdateItem` (installations, runs) |
| Provision | read app-pem + image ARNs; mint GitHub tokens (network egress); launch/terminate microVMs (region-scoped — the GA API can't tag VMs, ADR-015); write runs |
| Reaper | list live microVMs + terminate orphans (by run-store `microvmId`); update run rows |
| Hook broker | `dynamodb:GetItem` on the run table (no Query/Scan, no index); `lambda:TerminateMicrovm` (region-scoped). Called ONLY by microVMs, token-gated to the caller's own run; 20 reserved concurrent executions (ADR-021) |
| microVM exec role | its own log group; `lambda:InvokeFunction` on the hook broker ARN. **Nothing else** — no DynamoDB, no microVM control (ADR-021) |
| Mgmt API | read the shared table + run log group; `dynamodb:UpdateItem` (config only — no Put/Delete); `sqs:SendMessage` on the discovery queue; read ONLY its own OAuth/session secrets plus the two **non-secret** config params it reports as effective values (`config/runner-labels`, `config/platform-admins`); `ssm:DescribeParameters` for presence checks; `lambda:InvokeFunction` on the App-config broker ARN and nothing else. **No** token minting, **no** microVM launch/terminate, **no** `iam:PassRole`, **no** access to the App PEM, **no** `ssm:PutParameter` of any kind (ADR-025 + ADR-034, asserted in `test/mgmt-stack.test.mjs`) |
| App-config broker | read the App credentials incl. historical versions (`ssm:GetParameter` on the exact `github/*` + `config/runner-labels` paths); the platform's **only** `ssm:PutParameter`/`DeleteParameter` grant, scoped to that same exact path set — **not** `mgmt/session-secret`, not the image ARNs, no prefix wildcard; `dynamodb:UpdateItem`/`GetItem` restricted to `CONFIG#*` leading keys (audit, lock, status cache). Invoked ONLY by the Mgmt λ; makes App-JWT GitHub calls (`GET /app`, installations, hook config + deliveries). No compute, no run rows (ADR-034) |
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
  console's log viewer reads that group by resolving the run's stream to its **exact name**
  first — the stream is `<YYYY/MM/DD>[<imageVersion>]<microvmId>`, so the `microvmId`
  (ADR-019) is a *suffix* and cannot be prefix-matched: a date-bounded `DescribeLogStreams`
  scan (with a recency-ordered fallback) then a read by `logStreamNames` (ADR-048) — log
  bodies never land in DynamoDB.
- **Metrics** (M5, ADR-032): emitted as **CloudWatch EMF log lines**, not `PutMetricData` — no
  extra hot-path API call and no `cloudwatch:PutMetricData` grant on any Lambda. Namespace
  `LambdaCIActions`; today's metrics are `RunsProvisioned`, `ProvisionLatency`,
  `ProvisionFailures` and `QuotaThrottles`. Two dimension sets are published per datum: the full
  set (`env` + `flavor`/`via`/`kind`) for drill-down, and an **`env`-only rollup that alarms
  bind to** (CloudWatch does not aggregate across dimensions — an alarm on a set that is never
  published stays at `INSUFFICIENT_DATA`, i.e. silently dead). Repo/run/job/microVM ids ride as
  EMF **properties**, never dimensions, to keep cardinality (and billing) bounded.
- **Alarms** (per env, all publishing to `lca-<env>-alarms`): provisioning DLQ depth > 0;
  discovery DLQ depth > 0; `QuotaThrottles > 0`; `ProvisionFailures` above the env threshold;
  per-λ `Errors` (Ingest / Provision / hook broker / Reaper); provisioning-queue **age of
  oldest message** — the only signal that catches "Provision stopped consuming", which produces
  no error metric anywhere. All treat missing data as *not breaching* so an idle platform never
  pages. Subscribe a recipient with `-c alarmEmail=…` (unsubscribed by default: an alarm topic
  with no subscriber is a silent alarm, but a committed address would be wrong for every other
  deployment).
- **Tracing**: X-Ray **active tracing on the Lambdas** on the hot path (per-env, ADR-033:
  Ingest, Provision, Discovery, Reaper, hook broker, rewrite, mgmt). Each function's invocation
  gets its own segment, which is what makes a slow provision or a failing handler visible.
  API Gateway and SQS are *not* instrumented, and v1 ships **no X-Ray SDK / ADOT layer**, so
  outbound SDK calls produce no subsegments and nothing writes SQS's `AWSTraceHeader` — a
  webhook and the launch it caused are therefore **separate traces**, not one linked trace
  across the queue. Correlating them today means the run's `(repoId, runId, jobId)` in the
  structured logs, not a trace id. End-to-end trace linking needs sender-side instrumentation
  and is deliberately out of v1.
- **Cost**: the console's Dashboard shows a rolling spend estimate over recently finished runs,
  broken down per flavor, derived from the same per-run estimate as Run detail (no Cost Explorer
  call). It is an upper bound (wall-clock × flavor rate) and labelled as an estimate.

## Quotas & limits

- **microVM service quota** is the primary concurrency ceiling; defaults are **low and inconsistently granted** (per reference). Request increases per account **early** in M1.
- Lambda reserved concurrency on Provision λ bounds launch rate (protects downstream + quota).
  Per-env (ADR-033): dev 10, prod 25 — raise only alongside a granted quota increase.
- SQS provides backpressure; DLQ isolates poison messages.
- A throttled launch is invisible to the developer waiting on their PR, so it is **alarmed**
  (`QuotaThrottles`, above) rather than only logged.
- Full quota inventory, current values, and the increase-request procedure: [QUOTAS.md](../QUOTAS.md).
- Operational procedures (alarm response, stuck runs, adopt-mode rollback, rewrite PRs):
  [RUNBOOK.md](../RUNBOOK.md).

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
  ADR-018 verifies that a checkout's `.env.local` pin matches the ambient credentials, and — when
  the pin sets **`LCA_DEPLOY_ENV`** — that the selected env (`-c env=`, `build:images --env`,
  `app:create --env`) matches the environment the account is pinned for. Without that key the
  account+region pin still applies but the env is unconstrained, so **two env names can still
  pin the same account**: co-tenanting remains an operational choice rather than an error, and
  resource names are `env`-suffixed (`lca-<env>-*`, `/lca/<env>/...`) so it would not collide —
  it would merely forfeit the isolation the separation exists for. Setting `LCA_DEPLOY_ENV` in
  both checkouts is what makes the separation code-enforced.
- CDK context selects the environment (`-c env=dev|prod`); the deploy target account+region is
  **pinned** in `.env.local` and verified against the real caller identity (ADR-018), which also
  refuses a selected env that contradicts `LCA_DEPLOY_ENV`. Secrets are namespaced under
  `/lca/<env>/...`.
- Per-environment knobs live in `lib/env-config.ts` (ADR-033) — log retention, log removal
  policy, reserved concurrency, run-row retention, alarm thresholds, tracing, and the
  auto-rewrite flag:

  | Knob | `dev` | `prod` |
  |---|---|---|
  | Lambda log retention | 2 weeks | 3 months |
  | Run (job) log retention | 2 weeks | 1 month |
  | Log group removal | `DESTROY` | **`RETAIN`** |
  | Provision reserved concurrency | 10 | 25 |
  | Run-row retention (TTL) | 30 days | 90 days |
  | `ProvisionFailures` alarm threshold | 5 / 5 min | 1 / 5 min |
  | λ `Errors` alarm threshold | 2 | 0 |
  | Auto-rewrite (`contents:write`) | off | off (opt-in per deploy) |

  An **unknown** env name (a personal sandbox like `jsam-dev`) resolves to the dev shape, never
  prod's, so a typo cannot create retained resources.
- Deploy commands:

  ```bash
  # dev (default)
  npx cdk deploy --all
  # prod, with alarms delivered and auto-rewrite deliberately enabled
  npx cdk deploy --all -c env=prod -c alarmEmail=oncall@example.com -c rewrite=true
  ```

## Open questions

- **OQ-1**: Single DynamoDB table (single-table design) vs a few tables? (Leaning single-table + GSIs.)
- **OQ-2**: SSM Parameter Store vs Secrets Manager for the App PEM? (SSM SecureString per reference + cheaper; Secrets Manager gives rotation. Leaning SSM v1.)
- **OQ-3**: Multi-region active/active for the webhook endpoint, or single region + DR? (Leaning single region v1.)
