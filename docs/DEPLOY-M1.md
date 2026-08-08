# M1 deploy runbook — one microVM runs one job

The phased deploy for ROADMAP **M1** (ADR-011). Bootstraps the control + compute plane for
a single test repo. `<env>` is `dev` unless noted; region `us-west-2` or `us-east-1`
(default quota → ~256 concurrent @4 GB, no increase needed).

Prereqs: Node ≥ 18, a GitHub account/org you can install an App on, and an **AWS CLI
that has the `lambda-microvms` service** (GA API `2025-09-09`, a separate namespace from
`aws lambda`). That means **AWS CLI ≥ 2.35.17** — the Amazon Linux 2023 `awscli-2` dnf
package (2.33.15) is too old and the image-build phase will fail. Check + install:

```sh
aws --version                                   # want ≥ 2.35.17
aws lambda-microvms help >/dev/null && echo OK   # must succeed
# if too old, install the standalone v2 to a user prefix (no root):
curl -sL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp/awscli-install
/tmp/awscli-install/aws/install --install-dir "$HOME/.local/aws-cli" --bin-dir "$HOME/.local/bin" --update
export PATH="$HOME/.local/bin:$PATH"
```
Any boto3/botocore used alongside must be ≥ 1.43.44. Full matrix: `docs/specs/05-infrastructure.md` § Toolchain prerequisites.

```sh
npm install
npm run build          # tsc → dist/
npm test               # builds + runs unit tests
```

## Phase -1 — pin the deploy target (ADR-018)

Every deploy-touching command (cdk deploy/diff, `build:images`, `app:create`) refuses to
run without a `.env.local` pinning the target account + region — and refuses if your
credentials resolve to a different account:

```sh
cp .env.local.example .env.local
# edit: LCA_DEPLOY_ACCOUNT=<12-digit account>  LCA_DEPLOY_REGION=us-west-2
#       (optional) AWS_PROFILE=<profile to use when the shell doesn't set one>
```

`.env.local` is gitignored — never commit it. If you pass `--region`/`-c region`
anywhere, it must match the pin (or just omit it — the pin wins). Each git worktree needs
its own copy.

Two credential traps make the pin check refuse a deploy. Both fail closed — the guards
compare the *resolved* account (`CDK_DEFAULT_ACCOUNT` in `bin/lca.ts`, `sts
get-caller-identity` in `assertDeployTarget`) against the pin, so a wrong-account shell can
never deploy silently; it just blocks you:

- **Ambient `AWS_*` env vars beat `AWS_PROFILE`.** A shell carrying
  `AWS_ACCESS_KEY_ID`/`AWS_SESSION_TOKEN` for another account resolves to that account and
  the deploy refuses with `Deploy-target mismatch`. Unset them (`unset AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION`) rather than editing
  the pin.
- **Stale static credentials in `~/.aws/credentials` shadow a `credential_process`** in
  `~/.aws/config` under the same profile name, so `sts get-caller-identity` returns
  `ExpiredToken` even though the helper works. `ada credentials update … --once` rewrites
  the entries and fixes it.

Credential-less `cdk synth` and `--dry-run` are exempt from the pin check (the CI path).

## Phase 0 — secrets (out-of-band, ADR-008)

The webhook secret + App PEM are SecureStrings that CloudFormation can't create. The
GitHub App bootstrap script (phase 3) writes them. Nothing to do here yet — just know CDK
only *references* `/lca/<env>/github/*`.

Also seed the claimed-labels config the Ingest λ reads. This is the **claim allowlist**:
`shouldClaim` (`src/ingest/filter.ts`) drops any `workflow_job` whose `runs-on` contains none
of these labels, *before* flavor resolution runs. A flavor label that is missing here is a
silent dead end — the job is acked 202 `claimed:false`, no runner is ever provisioned, and the
job just sits queued on GitHub with no error anywhere. So seed **every** flavor label from
`microvm/flavors.json`, not just `lambda-ci` (pinned by `test/filter.test.mjs`):

```sh
aws ssm put-parameter --name /lca/dev/config/runner-labels \
  --type String --overwrite --region us-west-2 \
  --value 'lambda-ci,lambda-ci-node,lambda-ci-python,lambda-ci-java,lambda-ci-go,lambda-ci-rust,lambda-ci-docker'
```

Add any non-LCA label you intend to claim via a repo `FlavorMap` (e.g. `ubuntu-latest`) to
this list too — the map is consulted during *resolution*, which the claim gate runs before.
Re-run this command after adding a flavor to the catalog; nothing publishes it automatically.

## Phase 1 — infra (image build bucket + role)

```sh
npx cdk deploy LCA-Image-dev -c env=dev -c region=us-west-2
```

Publishes `/lca/dev/config/image-code-bucket` to SSM. No orchestrator yet (image ARNs
don't exist).

## Phase 2 — build the microVM image

Stages `microvm/Dockerfile.base`, zips the context, uploads it, runs `create-microvm-image`,
polls to `CREATED`, and publishes the image ARN to `/lca/dev/config/image-arn-base`.

```sh
npm run build:images -- --env dev --region us-west-2
# preview only:
npm run build:images -- --env dev --region us-west-2 --dry-run
```

**arm64 only** (AGENTS.md / ADR-007) — the base image + runner tarball are Graviton.

The run-hook payload contract is baked into the image, so on any change to it the image and
the control plane must move together (ADR-021 replaced `table` with `broker` + `token`): on
an existing env, rebuild the images in the same window as the Phase 3 deploy, with no
in-flight jobs. A version-skewed pair fails `/run` (400) instead of running degraded.

The freeze gate is "zero non-`TERMINATED` microVMs", and it has one sharp edge:
`list-microvms` paginates (page 1 caps at 10) and the CLI evaluates `--query` **per page**,
printing one result per page. A first-page-only read can call the window quiet while a live
VM sits on page 2, so filter for the non-terminated set and read every page:

```sh
aws lambda-microvms list-microvms --region us-west-2 \
  --query 'items[?state!=`TERMINATED`].microvmId' --output text   # expect empty, ALL pages
```

Observation alone is not a freeze if anything else can queue work. This repo dogfoods its
own runners (`.github/workflows/ci.yml`), so a PR merged mid-window strands its jobs —
pause the other writers (agents, merge queues) for the duration, don't just check that it
looks idle. Recovery from a skewed job is `gh run cancel` + `gh run rerun` once both planes
agree; see [`VERIFY-DEPLOY-ADR021-M4.md`](VERIFY-DEPLOY-ADR021-M4.md) for a window that was
hit and failed closed.

## Phase 3 — orchestrator + GitHub App

Deploy the control plane, then register the App against the now-live webhook URL.

```sh
npx cdk deploy LCA-Control-dev -c env=dev -c region=us-west-2
# note the WebhookUrl output, e.g. https://<id>.execute-api.us-west-2.amazonaws.com/webhook
```

Register the App (one interactive browser click — the manifest flow can't be headless;
see scripts/README.md). This writes `app-id` / `app-pem` / `webhook-secret` to SSM:

```sh
node scripts/create-github-app.mjs \
  --console-url https://example.com \
  --webhook-url https://<id>.execute-api.us-west-2.amazonaws.com/webhook \
  --env dev --region us-west-2
```

`--console-url` is only the App's homepage link, not the OAuth callback (that is registered
in [DEPLOY-M4](DEPLOY-M4.md) Phase 4). If you already know the console's vanity hostname
([ADR-036](DECISIONS.md#adr-036) — it is config, so it is knowable before any console
resource exists), pass it here so the App never advertises a placeholder.

Install the App on the test repo (the script prints the exact URL).

## Verify (M1 exit criterion)

1. In the test repo, add a workflow job with `runs-on: lambda-ci`.
2. Push / trigger it → GitHub sends `workflow_job=queued` → Ingest λ (HMAC ✓, label ✓) →
   SQS → Provision λ mints a JIT config and `run-microvm`s the base image.
3. The microVM's `/run` hook launches the runner; the job runs and reports success in
   GitHub; the VM self-terminates.

Capture boot latency, job duration, and per-job cost (2nd M1 exit criterion) from the
Provision λ logs + CloudWatch runner log stream.

## Teardown (dev)

```sh
npx cdk destroy LCA-Control-dev LCA-Image-dev -c env=dev -c region=us-west-2
# then delete built images + SSM params if fully resetting:
#   aws lambda-microvms delete-microvm-image --image-identifier <arn>
#   aws ssm delete-parameters --names /lca/dev/config/image-arn-base ...
```
