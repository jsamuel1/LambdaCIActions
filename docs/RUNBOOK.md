# Runbook — LambdaCIActions operations

Operational procedures for a deployed environment. Companion docs:
[QUOTAS.md](QUOTAS.md) (limits + increase requests), [DEPLOY-M4](DEPLOY-M4.md) (bootstrap),
[specs/05-infrastructure](specs/05-infrastructure.md) (topology, IAM, observability).

Every command assumes `.env.local` pins the intended account+region (ADR-018) and that
`AWS_PROFILE` resolves there. `<env>` is `dev` or `prod`. Set **`LCA_DEPLOY_ENV`** in each
checkout's pin as well: with it, a command whose `-c env=`/`--env` disagrees with the pinned
environment is refused before any AWS call, so a prod-selected deploy cannot land in the dev
account (and vice versa). One checkout per environment is the intended shape.

## Contents
- [Know your environment](#know-your-environment)
- [Alarm response](#alarm-response)
- [Common diagnoses](#common-diagnoses)
- [Adopt mode: enable, verify, roll back](#adopt-mode-enable-verify-roll-back)
- [Auto-rewrite PRs](#auto-rewrite-prs)
- [Deploys](#deploys)
- [Break-glass](#break-glass)

---

## Know your environment

| Thing | Where |
|---|---|
| Console | CloudFront domain from `LCA-Web-<env>` output `ConsoleUrl` |
| Webhook | `LCA-Control-<env>` output `WebhookUrl` |
| Alarms | SNS topic `lca-<env>-alarms` |
| Run (job) logs | `/aws/lambda/microvms/runs/lca-<env>`, stream per microVM id |
| Control-plane logs | `/aws/lambda/lca-<env>-{ingest,provision,discovery,reaper,hook-broker,rewrite}` |
| Metrics | CloudWatch namespace `LambdaCIActions`, dimension `env=<env>` |
| Run + config data | DynamoDB table `lca-<env>` |
| Queues | `lca-<env>-provision.fifo`, `lca-<env>-discovery`, `lca-<env>-rewrite` (DLQs: `lca-<env>-provision-dlq.fifo`, `lca-<env>-discovery-dlq`, `lca-<env>-rewrite-dlq`) |

```bash
aws cloudformation describe-stacks --stack-name LCA-Control-<env> \
  --query 'Stacks[0].Outputs' --output table
```

## Alarm response

Each alarm below states what fired, what it means, and the first command to run.

### `lca-<env>-provision-dlq-depth`
**Means**: a job failed to provision 3× and was parked. Developers are waiting on a job that
will never start.
```bash
# 1. What failed, and why?
aws sqs receive-message --queue-url <ProvisionDLQUrl> --max-number-of-messages 10 \
  --visibility-timeout 30 --query 'Messages[].Body'
# 2. The run row carries the operator-facing reason:
aws dynamodb get-item --table-name lca-<env> \
  --key '{"pk":{"S":"RUN#<repoId>#<runId>#<jobId>"},"sk":{"S":"RUN"}}' \
  --query 'Item.reason.S'
```
Then read `/aws/lambda/lca-<env>-provision` around that timestamp. Common causes in
[Common diagnoses](#common-diagnoses). Once fixed, GitHub will not re-queue the job — ask the
developer to re-run it (or re-drive the DLQ message only if the run is still `queued`).

### `lca-<env>-discovery-dlq-depth`
**Means**: workflow scans are failing, so routing and compat decisions are running on **stale**
parses. Jobs still run (Ingest fails open) but may land on the wrong flavor.
```bash
aws logs tail /aws/lambda/lca-<env>-discovery --since 1h --filter-pattern '?error ?failed'
```
Usual causes: App installation token failure (check `/lca/<env>/github/app-pem` is intact),
GitHub rate limiting, or a repo whose `.github/workflows` grew past the fetch budget. After
fixing, trigger a re-scan per repo from the console (Repo detail → Re-scan).

### `lca-<env>-rewrite-dlq-depth`
**Means**: an operator clicked "Open rewrite PR" and it never opened. Nothing else surfaces
this — the rewrite λ writes to GitHub, not to a run row or a queue we otherwise watch.
```bash
aws logs tail /aws/lambda/lca-<env>-rewrite --since 1h --filter-pattern '{ $.msg = "rewrite failed" }'
```
Usual causes: the App lacks `contents:write` / `pull_requests:write` (GitHub answers 403 — grant
the permission or tell the operator the capability is not available), a branch-protection rule
refusing the branch creation, or a concurrent edit making the sha-guarded write 409 (redrive the
message; the λ re-plans from live contents). Nothing was partially merged: the λ only ever
writes to its own branch.

### `lca-<env>-quota-throttles`
**Means**: microVM launches were **refused by a quota**, not by a bug. This is capacity, not
correctness — see [QUOTAS.md](QUOTAS.md) to request an increase. Short-term relief: lower
concurrent load, or accept the queueing (jobs wait rather than fail once the throttled message
is redelivered).

A throttled launch deliberately leaves the run row in `provisioning` and rethrows, so SQS
redelivers it — writing `failed` would be terminal and the redelivered message could never
re-attempt the launch. If every redelivery throttles, the message lands in the provisioning DLQ
(`lca-<env>-provision-dlq-depth`) and the Reaper fails the stuck row at its age threshold.

### `lca-<env>-provision-failures`
**Means**: launches are failing above the env threshold. Group the reasons first — the failure
kind is a metric dimension:
```bash
aws logs filter-log-events --log-group-name /aws/lambda/lca-<env>-provision \
  --filter-pattern '{ $.msg = "*failed*" }' --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --query 'events[].message' --output text | head -50
```
`kind=mint` ⇒ GitHub rejected JIT registration (see below). `kind=launch` ⇒ the microVM API
refused. `kind=quota` ⇒ see the quota alarm.

### `lca-<env>-provision-backlog-age`
**Means**: messages are sitting in the provisioning queue unconsumed — Provision has stopped
making progress. **This is the alarm that catches a silent stall**, since a λ that is not
invoked emits no errors.
```bash
aws lambda get-function-concurrency --function-name lca-<env>-provision
aws sqs get-queue-attributes --queue-url <ProvisionQueueUrl> \
  --attribute-names ApproximateNumberOfMessages ApproximateAgeOfOldestMessage
aws logs tail /aws/lambda/lca-<env>-provision --since 30m
```
Check for exhausted reserved concurrency, an event-source mapping that got disabled, or every
invocation timing out.

### `lca-<env>-{ingest,provision,hook-broker,reaper}-errors`
A control-plane λ is throwing. Read its log group; the handlers log structured JSON with a
`msg` field, so filter on that rather than grepping free text.

## Common diagnoses

**"Jobs queue in GitHub but nothing ever starts."** Work the chain in order — the first
missing link explains it:
1. Is the webhook arriving? GitHub App → Advanced → Recent Deliveries (expect 202).
2. Did we claim it? `aws logs filter-log-events --log-group-name /aws/lambda/lca-<env>-ingest
   --filter-pattern '{ $.msg = "job claimed" }'`. A `claimed: false` response carries a
   `reason` naming the gate that declined (no LCA label, repo opted out, compat block).
3. Did a runner register? The run row's `status` tells you how far it got:
   `queued` (never provisioned) → `provisioning` (launch attempted) → `running`.
4. Did the VM boot? Run logs, stream = the run's `microvmId`.

**A run is stuck non-terminal.** The Reaper sweeps every 5 minutes and marks lifetime-capped
or orphaned runs `timed_out`/`failed`. If a run sits `running` longer than a job plausibly
takes, check `/aws/lambda/lca-<env>-reaper` — if the Reaper itself is failing, nothing reaps.

**`kind=mint` failures / HTTP 422 on registration.** GitHub refused the runner labels. In
adopt mode this is the known risk in ADR-030: the hosted label (`ubuntu-latest`) may be
reserved. The run's `reason` names the fix. Immediate remedy: switch the repo back to `label`
mode (below) and add LCA labels, or open a rewrite PR.

**`kind=mint` failures naming a rate limit.** `generate-jitconfig` is a POST, so GitHub's
**secondary** rate limits meter it: a POST costs 5 points against a 900 points/minute
per-endpoint budget (≈180 mints/min), and content-creating requests are capped separately at
80/minute and **500/hour** — the hourly one binds at 500 jobs in an hour whatever the launch
rate. GitHub refuses with **403**, not 429. These are classified transient: the run stays
`provisioning`, SQS redelivers, and the job runs once the budget refills — the reason reads
`GitHub rate-limited JIT registration (retrying)`. A sustained storm DLQs after
`maxReceiveCount` 3 and the Reaper fails the row. If the *per-minute* ceiling is what you are
hitting, lower `provisionConcurrency` for the env (`lib/env-config.ts`) rather than raising it:
that ceiling is GitHub's, not ours. Lowering concurrency does **not** help against the hourly
content-creation cap — that is a volume limit, so the remedy there is fewer minting jobs per
hour (or a second App installation). A 403 that names a *permission* instead (`Resource not
accessible by integration`) is permanent — grant the App permission.

**A run fails immediately with "runs-on resolves to no usable runner label".** The job's
`runs-on` is entirely an unresolved expression (`runs-on: ${{ matrix.os }}`), which leaves
nothing we can advertise — so we refuse before minting rather than launch a VM that can never
be assigned the job. Nothing was consumed; no cleanup needed. Fix in the workflow: add a
literal label beside the expression (`runs-on: [self-hosted, lambda-ci, "${{ matrix.os }}"]`)
or make the matrix values literal labels.

**A job fails on arm64 that passed on GitHub-hosted.** Expected class of failure after
enabling adopt mode — our runners are Graviton (ADR-007). Check the repo's compat findings in
the console; each carries a `fix`. If the job genuinely needs x86, exclude it (keep it on
GitHub-hosted) by leaving the repo in `label` mode and labelling only the jobs that can move.

## Adopt mode: enable, verify, roll back

Adopt mode makes a repo's `ubuntu-*` jobs run here with no YAML changes. It is
**all-or-nothing per repo** and moves work to arm64 — treat it as a change, not a setting.

**Before enabling**: Repo detail → confirm compat shows no `risk`/`block` findings on the jobs
listed as adopt candidates. Re-scan first if the parse is stale.

**Enable**: Repo detail → Onboarding mode → `adopt`. Takes effect on the **next** queued job;
in-flight jobs are unaffected.

**Verify**: push a trivial commit and watch Dashboard → the run should appear with the flavor
resolved from adopt-mode routing (Run detail shows the reason), and finish green.

**Roll back** — instant, no deploy:
```bash
# via the console: Repo detail → mode → label   (preferred: it records the actor)
# or directly, if the console is unavailable:
aws dynamodb update-item --table-name lca-<env> \
  --key '{"pk":{"S":"INSTALL#<installationId>"},"sk":{"S":"REPO#<repoId>"}}' \
  --update-expression 'SET #m = :label, updatedAt = :now' \
  --expression-attribute-names '{"#m":"mode"}' \
  --expression-attribute-values '{":label":{"S":"label"},":now":{"S":"'"$(date -u +%FT%TZ)"'"}}'
```
Jobs already claimed keep running; new `ubuntu-latest` jobs go back to GitHub-hosted runners.
To stop claiming a repo entirely, set `mode` to `off` (or `enabled=false`).

## Auto-rewrite PRs

Disabled by default in every environment (ADR-031). Enabling it is deliberate and has three
gates:
1. Grant the GitHub App `contents:write` **and** `pull_requests:write` (elevated — a decision,
   not a checkbox).
2. Redeploy with the flag: `npx cdk deploy LCA-Control-<env> LCA-Mgmt-<env> -c env=<env> -c rewrite=true`.
3. Per repo: Repo detail → "Allow LambdaCIActions to open a rewrite PR".

The dry-run preview works with all three off — use it to show a team what the PR would do.

Auditing what it did: `aws logs filter-log-events --log-group-name /aws/lambda/lca-<env>-rewrite
--filter-pattern '{ $.msg = "rewrite PR ready" }'` — each entry records the repo, the actor who
requested it, and the PR URL. The λ never merges, never force-pushes, and reuses an existing
open PR rather than opening duplicates.

**No PR appeared but the branch exists**: click "Open rewrite PR" again. If the commits landed
and only the PR call failed (commonly an App holding `contents:write` but not
`pull_requests:write`), the re-run finds no new edits and opens the PR for the existing branch —
look for `"msg": "rewrite no-op"` with `"status": "opened"`. If the reason instead tells you to
delete the branch, that branch's rewrite is already merged (GitHub refuses a PR with no commits
between base and head); delete it and re-request to re-plan from the default branch.

To revoke: untick the repo toggle (immediate), or redeploy without `-c rewrite=true`
(deployment-wide), or remove the App permission (belt and braces).

## Deploys

Phased, because image ARNs must exist before the orchestrator reads them (ADR-011):

```bash
npm ci && npm run build && npm test          # gate
npx cdk deploy LCA-Image-<env> LCA-Data-<env> -c env=<env>
npm run build:images -- --env <env>          # publishes image ARNs to /lca/<env>/config/image-arn-*
npm run build:web
npx cdk deploy LCA-Control-<env> LCA-Mgmt-<env> LCA-Web-<env> -c env=<env> \
  -c alarmEmail=oncall@example.com
```

`build:images` takes its own `--env` (it is a plain node script, not the CDK app, so it does
not see `-c env=…`) and **defaults to `dev`**. Omitting it on a prod deploy publishes the image
ARNs under `/lca/dev/...`, leaving `/lca/prod/config/image-arn-*` absent — the `LCA-Control-prod`
deploy then fails resolving them. Pass `--region <region>` too when the pinned region isn't
your shell default.

Prod adds nothing but flags — the account separation is the boundary (ADR-033):
`-c env=prod`. Verify after deploy: console Settings shows every secret present, Flavors shows
every image available, and a test push completes green.

## Flavors: adding, rebuilding, and checking one against reality

A catalog entry in `microvm/flavors.json` is a **claim**, not capacity. What a job can actually
run on is the live claim allowlist plus a real image (ADR-049). Check the two against the
catalog at any time — read-only, safe to run whenever:

```bash
npm run flavors:reconcile -- --env <env>            # exits 1 on drift
npm run flavors:reconcile -- --env <env> --json      # machine-readable
npm run flavors:reconcile -- --env <env> --no-image-check   # SSM params only
```

Exit 2 means the report is **incomplete**, not that the plane is broken: either SSM could not be
read, or `get-microvm-image` failed for a reason other than `ResourceNotFoundException`
(AccessDenied, expired credentials, wrong region, or an `aws` older than 2.35.17 with no
`lambda-microvms` service) — or it succeeded but returned no `state`, which is a response we
could not interpret rather than a missing image. Those flavors are reported `image_unverified`
rather than as missing
images, and `--fix` refuses — an unreadable image is *unknown*, and rebuilding a healthy catalog
on the strength of a permissions error is the harm that avoids.

Statuses and what they mean:

| status | severity | meaning |
|---|---|---|
| `ok` | ok | label claimed, image `CREATED`/`UPDATED` — runnable |
| `image_unverified` | ok | parameters look right, image state not checked (`--no-image-check`) |
| `label_unverified` | ok | image verified but the allowlist was not read, so selectability is unknown. Not reachable from this CLI (it always reads the allowlist) — it exists for a consumer that reads only `image-arn-*`, e.g. the console health item |
| `image_building` | warn | a build is in flight; wait |
| `label_missing` | warn | image exists but no label — capacity that can never be selected |
| `image_missing` | **blocked** | label claimed with no image — jobs get claimed then fail in provisioning, with no GitHub-hosted fallback |
| `not_built` | **blocked** | advertised by the catalog, neither built nor claimed — jobs queue forever with no error |
| `image_failed` | **blocked** | the image build failed; rebuild |

**Add a flavor to a live environment** (build the image, then advertise it — never the reverse):

```bash
npm run build:images -- --env <env> --flavor <name>
npm run flavors:reconcile -- --env <env>       # expect it to go green
```

**Rebuild after a Dockerfile / patch change.** The label stays in place throughout, and the ARN
is repointed only after the new version verifies:

```bash
npm run build:images -- --env <env> --flavor <name> --rebuild
npm run build:images -- --env <env> --rebuild                 # whole set
```

Quiesce first for either — the image-hook contract is a serialized skew window, so no job may
be in flight. **`build:images` enforces this itself**: it enumerates all pages of
`lambda-microvms list-microvms` and refuses while any microVM is non-terminated (`--publish-label-only`
and `--dry-run` are exempt — neither touches an image). Only `TERMINATED` counts as terminal
(`MicrovmState` has no `FAILED`; `TERMINATING` still exists and may still be resuming), and an
unrecognized state counts as live. Observation is not a freeze, though:
pause the other writers too (this repo dogfoods its own runners, so a merge mid-window strands
its jobs). `--force-unquiesced` overrides the refusal for a VM wedged non-terminal that the
Reaper has not yet collected — only after you have frozen the writers by hand.

**Fix drift in the safe direction only:**

```bash
npm run flavors:reconcile -- --env <env> --fix
```

`--fix` builds a missing image or adds a label for an image that verifies. It **never removes a
label** — that would take routing away from jobs that may depend on it right now — and it
refuses outright if any microVM is non-terminated. Removing a flavor is a deliberate act: drop
it from `flavors.json` *and* edit the allowlist parameter by hand.

Exit codes for `--fix` follow the same 1-vs-2 rule as a plain report, and `--fix` **re-reads the
live plane after remediating** rather than trusting that each build exited 0: **1** means drift
remains, **2** means something went wrong and this report should not be trusted — an unreadable
fleet, an incomplete post-fix probe, or a remediation that failed part-way, which stops the run
rather than continuing down the list.

The re-read matters for one case in particular. If `/lca/<env>/config/runner-labels` does not
exist at all, `build:images` publishes the image ARN, warns, and refuses to *create* the
parameter (creating it from one flavor would drop every other label) — and exits 0. So a `--fix`
run can build every missing image, add no label whatsoever, and be told by each child process
that it succeeded. Scored against the plane instead, that run exits 1 and names the cause. Seed
the parameter (`docs/DEPLOY-M1.md` phase 0) and re-run.

With `--json`, `--fix` prints exactly one document: the post-fix report, matching the exit code.
A run that finds nothing safely fixable prints that same shape with an empty `fixed`, so the
output is always parseable — never prose on stdout.

CD runs `flavors:reconcile --no-image-check` as a **report-only** step, so drift shows up in the
deploy summary. It never builds: an image build is deploy-touching, and the CD job is itself a
microVM, so it cannot honour the quiesce precondition (ADR-049).

### A job that stays queued forever

Symptom: GitHub shows the job `QUEUED` indefinitely, nothing in Provision's logs, no run row.
`shouldClaim` refuses before flavor resolution and GitHub discards ingest's 202, so there is no
error anywhere by design. Diagnose in this order:

1. `npm run flavors:reconcile -- --env <env>` — this is usually the whole answer.
2. Confirm you are querying the **platform's** region, not the workload's. A
   `ParameterNotFound` from the wrong region is indistinguishable from a missing flavor.
3. If the flavor is `ok`, the problem is elsewhere: check the repo is enabled, its mode, the
   runner group (non-default groups are refused), and the workflow's labels.

## Break-glass

**Stop all claiming immediately** (platform-wide, no deploy): point the runner-labels config
at a label nothing uses. Ingest re-reads it from SSM on a **30-second** per-container cache
(`RUNNER_LABELS_TTL_MS` in `src/ingest/handler.ts` — deliberately far below `getParam`'s
5-minute default, because the Settings screen presents a label change as taking effect on the
next delivery), so it takes effect within **~30 s** — warm containers keep using the old value
until their cache entry expires. If you need it to be instant, also zero Provision's
concurrency (below) so nothing launches while the change propagates.
```bash
aws ssm put-parameter --name /lca/<env>/config/runner-labels \
  --value 'lambda-ci-DISABLED' --type String --overwrite
```
If the console is reachable and you are in `config/platform-admins`, the same change is a
**Settings → Runner labels** edit (mandatory impact preview, audited actor + timestamp,
ADR-034). The SSM write above is the break-glass path for when the console is not available.
Adopt-mode repos are **not** covered by that (they claim by hosted label, not by our label) —
set those repos to `mode=off`. If you need to stop the platform launching anything at all
without touching per-repo config, zero Provision's concurrency. Note this does **not** stop
Ingest claiming: claimed jobs keep accumulating in SQS and start launching as soon as the
concurrency is restored (they may exceed GitHub's own job timeout while waiting).
```bash
aws lambda put-function-concurrency --function-name lca-<env>-provision \
  --reserved-concurrent-executions 0     # stop launching; jobs queue in SQS
```
Both are reversible and neither loses run history. Restore by re-setting the parameter /
concurrency to its previous value (see `lib/env-config.ts` for the env's default).

**Terminate a runaway microVM**: the Reaper handles lifetime caps automatically. For a manual
kill, get `microvmId` from the run row and use the `lambda-microvms` CLI (requires the
toolchain floor in [specs/05](specs/05-infrastructure.md) § Toolchain prerequisites).
