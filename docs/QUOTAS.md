# Quotas & limits

Every ceiling that can stop a job from running, where it lives, and how to raise it. Companion
docs: [RUNBOOK.md](RUNBOOK.md) (alarm response), [specs/05-infrastructure](specs/05-infrastructure.md)
§ Quotas & limits.

**The short version**: the microVM concurrency quota is the one that will bite you, its default
is low and inconsistently granted, and a request takes days — so ask **before** you need it.

## Contents
- [AWS quotas](#aws-quotas)
- [Requesting an increase](#requesting-an-increase)
- [Our own self-imposed limits](#our-own-self-imposed-limits)
- [GitHub-side limits](#github-side-limits)
- [How exhaustion shows up](#how-exhaustion-shows-up)

---

## AWS quotas

Values are **per account per region**. Check the current value before assuming the default —
grants vary between accounts.

| Quota | Service | Why it matters | Default |
|---|---|---|---|
| Concurrent microVMs | `lambda` (microVMs) | **The primary concurrency ceiling.** One microVM per job ⇒ this is your max parallel CI. | Low; varies by account — verify, don't assume |
| microVM images | `lambda` (microVMs) | One image per flavor per build. Old images accumulate unless pruned. | Verify |
| Lambda concurrent executions | Lambda | Shared across the whole account. Our reserved concurrency carves out of it. | 1,000 |
| SQS in-flight messages | SQS | Bounds how many jobs can be mid-provision. Far above our Provision concurrency. | 120,000 |
| DynamoDB on-demand throughput | DynamoDB | Table is PAY_PER_REQUEST; CI spikes are small relative to defaults. | 40,000 RCU/WCU |
| API Gateway request rate | API Gateway | Webhook ingress. One request per job event. | 10,000 rps |
| SSM Parameter Store throughput | SSM | Read per provision (App creds, image ARN). | 40–3,000 tps by tier |
| CloudWatch Logs ingestion | Logs | Job output volume. | Region-dependent |

Check current values:

```bash
# microVM quotas (service code: lambda)
aws service-quotas list-service-quotas --service-code lambda \
  --query "Quotas[?contains(QuotaName, 'icrovm')].[QuotaName,Value,QuotaCode]" --output table

# a specific quota, including whether it was ever raised
aws service-quotas get-service-quota --service-code lambda --quota-code <QuotaCode>
```

If `list-service-quotas` shows no microVM entries, your CLI predates the API. The compute plane
requires **AWS CLI ≥ 2.35.17** / **boto3 ≥ 1.43.44** — see
[specs/05](specs/05-infrastructure.md) § Toolchain prerequisites. Verify with
`aws lambda-microvms help`.

## Requesting an increase

Do this **per account and region**, on day one of a new environment — not when CI is already
throttling.

```bash
aws service-quotas request-service-quota-increase \
  --service-code lambda --quota-code <QuotaCode> --desired-value <N>

# track it
aws service-quotas list-requested-service-quota-change-history --service-code lambda \
  --query 'RequestedQuotas[].[QuotaName,DesiredValue,Status,Created]' --output table
```

Sizing `N`: your peak concurrent *jobs*, not workflows. A single push to a monorepo with a
12-way matrix is 12 microVMs. Take your busiest hour's peak, add headroom for retries, and
round up. Ask for more than you need now — a second request costs another round trip.

Support will ask what you are building; "ephemeral single-use CI runners, one VM per CI job,
self-terminating" is the answer that gets the quota. Include expected peak and average VM
lifetime.

**After a grant**: raise the Provision λ reserved concurrency to match, or the launch rate stays
capped by *our* limit instead. It is per-env in `lib/env-config.ts`
(`provisionConcurrency`, ADR-033) — change it there and redeploy, rather than editing the
function by hand, so the next deploy doesn't revert it.

## Our own self-imposed limits

Deliberate ceilings in our code. They protect the AWS quotas and downstream services, and each
is a knob, not a bug.

| Limit | Value | Where | Why |
|---|---|---|---|
| Provision reserved concurrency | dev 10 / prod 25 | `lib/env-config.ts` | Bounds microVM launch rate → protects the microVM quota. Excess work queues in SQS. |
| Hook broker reserved concurrency | dev 20 / prod 50 | `lib/env-config.ts` | Its callers are untrusted microVMs; caps their ability to drain the account's Lambda pool (ADR-021). |
| Discovery reserved concurrency | 2 | `lib/control-stack.ts` | GitHub API politeness — one repo scan at a time is plenty. |
| Reaper concurrency | 1 | `lib/control-stack.ts` | One reconciliation sweep at a time. |
| Rewrite concurrency | 1 | `lib/control-stack.ts` | Operator-initiated, rare, GitHub-rate-limited. |
| SQS `maxReceiveCount` | 3 | `lib/control-stack.ts` | Then DLQ + alarm. Note: a *permanent* mint failure short-circuits before this (ADR-030) rather than burning retries. |
| Run-hook payload | 4,096 bytes | GA `lambda-microvms` API | Hard service cap — why the JIT config goes by reference (ADR-016). |
| Flavor-map entries per repo | 50 | `src/mgmt/validate.ts` | Bounds item size + the UI editor. |
| JIT labels per runner | 20 | `src/provision/labels.ts` | Bounds registration payload from a pathological `runs-on`. |
| Run-row retention (TTL) | dev 30 / prod 90 days | `lib/env-config.ts` | History for the console + incident review, then aged out. |

## GitHub-side limits

| Limit | Value | Impact |
|---|---|---|
| Installation token | ~60 min | Cached until 5 min before expiry (`src/shared/github-app.ts`). |
| App JWT | 10 min max | We mint 9 min. |
| REST rate limit | 5,000 req/hr per installation | Discovery is the heaviest consumer (one fetch per workflow file). |
| REST **secondary** rate limits | 900 points/min per endpoint (a POST costs 5, so ≈180 mints/min) **and** 80 content-creating req/min / 500 per hour | `generate-jitconfig` is a POST, so both apply — the hourly content-creation cap binds at 500 jobs/hour whatever the rate, which a busy org reaches. Adopt mode makes it reachable sooner: a whole workflow's jobs mint at once. GitHub refuses with **403**, which Provision classifies transient so the job waits instead of failing (ADR-030). GitHub says these limits change without notice and some endpoints have undisclosed costs — treat the numbers as indicative and the 403 as authoritative. |
| JIT config | single use | By design (ADR-003) — one config per job, consumed at boot. |
| Reserved runner labels | see ADR-030 | GitHub may reject hosted-label names (`ubuntu-latest`) at registration. This is the open verification item for adopt mode. |
| Webhook delivery timeout | 10 s | Why Ingest acks fast and does real work async. |

## How exhaustion shows up

| Symptom | Likely limit | Where to look |
|---|---|---|
| `lca-<env>-quota-throttles` alarm | microVM concurrency | Request an increase (above) |
| Jobs queue, provisioning backlog age climbs | Our Provision concurrency, or the microVM quota | `lca-<env>-provision-backlog-age` alarm; [RUNBOOK](RUNBOOK.md) |
| Discovery DLQ filling | GitHub REST rate limit | `/aws/lambda/lca-<env>-discovery` |
| `kind=mint` provision failures | GitHub-side (labels, permissions, install state) | Run row `reason` — it names the fix. A rate-limit 403 is retried, not failed. |
| Launch fails with a validation error | Not a quota — bad image ARN or missing config | `/aws/lambda/lca-<env>-provision` |

A quota refusal is **not** a correctness failure: the job is retried and, once capacity frees
up, runs. Provision proves that by rethrowing a throttled launch **without** writing a terminal
status — a `failed` row is final, so the redelivered SQS message would never re-attempt the
launch. Each redelivery re-mints a JIT config (single-use; the abandoned one TTLs out in 30 min
and `maxReceiveCount` 3 bounds it to ≤3 mints per job), so a sustained throttle storm also
spends GitHub API budget. The failure mode to avoid is not noticing — which is why
`QuotaThrottles` is alarmed rather than only logged (ADR-032).
