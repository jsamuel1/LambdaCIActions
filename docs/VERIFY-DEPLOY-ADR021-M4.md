# Deploy verification — ADR-021 brokered run-hook + M4 management plane

**Verdict: ADR-021 posture PASSED live. M4 stacks UP, OAuth login BLOCKED on one
human-only GitHub setting (see [Outstanding](#outstanding--one-human-step).)**

Deployed and verified against the live `dev` environment on **2026-07-28**. Both PR #14
(ADR-021 brokered run-hook, `409aba9`) and PR #15 (M4 console + management API, `63069ff`)
were merged and CI-green but had never been deployed — the running control plane was
`main` @ `945aa0e` + the M3 docker fix, and no `LCA-Mgmt-dev` / `LCA-Web-dev` existed.

---

## Environment under test

| | |
|---|---|
| Account / region | `863638663908` / `us-west-2` (pinned via `.env.local`, ADR-018) |
| Source | `main` @ `63069ff` |
| Toolchain | AWS CLI **2.36.8** (`aws lambda-microvms` present — floor is ≥ 2.35.17) |
| Preflight gate | `npm ci && npm run build && npm test` → **281/281 pass**; `npx cdk synth -c env=dev` clean |
| GitHub App | `lambdaciactions-dev` (app id `4292494`, 1 installation, events `push` + `workflow_job`) |
| Webhook | `https://w061napnkg.execute-api.us-west-2.amazonaws.com/webhook` (unchanged by this deploy) |

### Stacks after the deploy

| Stack | Status | Last updated (UTC) |
|---|---|---|
| `LCA-Data-dev` | UPDATE_COMPLETE | 2026-07-28T23:20:19Z (GSI2 added — see [below](#gsi2-is-sparse-and-was-not-backfilled)) |
| `LCA-Image-dev` | UPDATE_COMPLETE | 2026-07-14T14:26:13Z (no diff) |
| `LCA-Control-dev` | UPDATE_COMPLETE | 2026-07-28T23:21:12Z |
| `LCA-Mgmt-dev` | UPDATE_COMPLETE | 2026-07-28T23:37:25Z |
| `LCA-Web-dev` | CREATE_COMPLETE | 2026-07-28T23:31:49Z |

### Images rebuilt from this tree

| Flavor | Before | After | `additionalOsCapabilities` |
|---|---|---|---|
| `lca-dev-base` | v9.0 | **v10.0** (SUCCESSFUL, 23:08:22Z) | — |
| `lca-dev-node` | v8.0 | **v9.0** (SUCCESSFUL, 23:11:46Z) | — |
| `lca-dev-docker` | v9.0 | **v10.0** (SUCCESSFUL, 23:15:08Z) | `["ALL"]` (ADR-020) |

## Ordering constraint: the version-skew window

The run-hook payload contract is baked into the image. ADR-021 replaced `{ref, region,
table}` with `{ref, region, broker, token}`, so images and control plane must move in the
same window with no in-flight jobs (docs/DEPLOY-M1.md § Phase 2 — that note cites the
decision as ADR-020; it is ADR-021, one of the stale cross-references the ADR-021 renumber
left behind, tracked on its own card and deliberately not touched here). Sequence used:

1. Confirmed the window was quiet: zero open PRs, zero non-`TERMINATED` microVMs
   (`list-microvms` → 12/12 `TERMINATED`).
2. `npm run build:images -- --env dev --region us-west-2` (all three flavors).
3. `npx cdk deploy LCA-Control-dev -c env=dev` — **74.8 s**, closing the window. This also
   updated `LCA-Data-dev` (declared dependency, `bin/lca.ts`), which is where GSI2
   (ADR-023) was actually created — the M4 stacks were not yet involved.

### The window was still hit — and failed closed, as designed

A concurrent kanban card opened PR #16 (`kermes/task-nimble-anemone`) at **23:20:46Z**,
mid-window. Its two jobs launched with the OLD 97-byte payload against the NEW broker
images, and the new run-hook rejected them:

```json
{"msg":"run payload missing ref/broker/token",
 "raw":"{\"microvmId\":\"microvm-6cd670d9-…\",\"runHookPayload\":\"{\\\"ref\\\":\\\"RUN#1296388576#30407682591#90436690282#JITCONFIG\\\",\\\"region\\\":\\\"us-west-2\\\",\\\"table\\\":\\\"lca-dev\\\"}\"}"}
```

`/run` returned 400 and the jobs stayed `queued` — no partial or degraded execution, which
is the documented intent. Recovery was `gh run cancel` + `gh run rerun` once both planes
were consistent; run `30407682591` then went **green on both jobs**. Payload size moved
97 → 164 bytes (cap 4096), visible in the Provision log.

Operational note: "quiesce CI" cannot be established by observation alone in this repo —
another agent can open a PR seconds later. A real freeze needs the other cards paused.

## ADR-021 evidence

### 1. Broker λ is live

`lca-dev-hook-broker` — `nodejs22.x`, **arm64**, 30 s timeout, 256 MB,
`ReservedConcurrentExecutions: 20` (confirmed via `get-function-concurrency`; note
`get-function-configuration` reports `null` for this field). `TABLE_NAME=lca-dev` only.

`lca-dev-provision` now carries `HOOK_BROKER_NAME=lca-dev-hook-broker` alongside
`TABLE_NAME` / `IMAGE_ARN_PARAM_PREFIX` / `APP_ID_PARAM` / `APP_PEM_PARAM` /
`RUNNER_ROLE_ARN`.

### 2. microVM exec role — verified against the DEPLOYED role, not the template

`aws iam get-role-policy --role-name lca-dev-microvm-exec` (one inline policy, zero
attached managed policies):

```json
[
 {"Sid":"MicrovmRuntimeLogs",
  "Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
  "Resource":"arn:aws:logs:us-west-2:863638663908:log-group:/aws/lambda/microvms/*"},
 {"Sid":"InvokeHookBroker",
  "Action":"lambda:InvokeFunction",
  "Resource":"arn:aws:lambda:us-west-2:863638663908:function:lca-dev-hook-broker"}
]
```

- **zero** `dynamodb:*` — the table-wide `grantReadData` is gone.
- **zero** microVM control actions — `lambda:TerminateMicrovm` is gone.
- exactly one invokable ARN: the single broker function.

That closes the ADR-019 amplifier: a VM can no longer read another run's row, harvest its
`microvmId`, or terminate anyone.

Broker's own role is correspondingly narrow: `dynamodb:GetItem` on the table ARN only (no
`/index/*`, no Query/Scan) and `lambda:TerminateMicrovm` gated by
`aws:RequestedRegion == us-west-2`.

### 3. Brokered boot + terminate, one green job per flavor

Fixture: **`jsamuel1/lca-m3-verify`** (repo id `1313438232`), the M3 flavor-routing repo —
three jobs whose only LCA-specific content is the `runs-on` label.
`workflow_dispatch` → run **`30407823249`**, conclusion **success**, all three jobs green.

| Job | Flavor | microVM | Job wall time | Run row |
|---|---|---|---|---|
| `node-job` | node | `microvm-fe0063f2-…` | 23:24:15→23:24:37 (22 s) | `completed` |
| `base-job` | base | `microvm-ade0c34b-…` | 23:24:21→23:24:48 (27 s) | `completed` |
| `docker-job` | docker | `microvm-85bde901-…` | 23:24:51→23:25:18 (27 s) | `completed` |

Provision resolved each flavor from its explicit label and launched a distinct VM:

```
{"msg":"flavor resolved","runId":30407823249,"jobId":90437140849,"flavor":"node","reason":"explicit LCA label 'lambda-ci-node'"}
{"msg":"run-hook payload size","totalBytes":164,"cap":4096,"runId":30407823249}
{"msg":"microVM launched","microvmId":"microvm-fe0063f2-…","flavor":"node",…}
```

**Boot fetch via broker** — 6 broker invocations for 3 jobs: 3 × `jitconfig` (the handler
logs nothing on the success path) + 3 × `terminate`. VM-side proof of the brokered boot is
`job starting` following a successful `jitconfig` (the VM cannot start a job without the
config the broker returned), with `asRoot:true` only on the docker flavor as ADR-020
requires:

```json
{"msg":"job starting","runId":30407823249,"jobId":90437140849,"repoFullName":"jsamuel1/lca-m3-verify","asRoot":false}
{"msg":"job starting","runId":30407823249,"jobId":90437140920,"repoFullName":"jsamuel1/lca-m3-verify","asRoot":true}
```

**Self-terminate via broker** — the broker resolved each VM id off the run row and
terminated it; the VM never learns any microvmId:

```json
{"msg":"self-terminate brokered","pk":"RUN#1313438232#30407823249#90437140849","microvmId":"microvm-fe0063f2-…"}
{"msg":"self-terminate brokered","pk":"RUN#1313438232#30407823249#90437140853","microvmId":"microvm-ade0c34b-…"}
{"msg":"self-terminate brokered","pk":"RUN#1313438232#30407823249#90437140920","microvmId":"microvm-85bde901-…"}
```

`list-microvms` afterwards: zero non-`TERMINATED` VMs.

### 4. No capability token leaked

- **Run rows** carry `hookTokenHash` (sha256 hex) and no plaintext; no token in any
  `reason`/status field.
- **Log groups** scanned with `filter-log-events --filter-pattern '"token"'` over the
  window: `lca-dev-hook-broker` 0, `lca-dev-provision` 0, `microvms/lca-dev-{base,node,docker}` 0.
  `microvms/runs/lca-dev` had 2 hits — both the *literal error string* `"run payload
  missing ref/broker/token"` from the skew failure above, whose payloads were the old
  contract and contained no token at all.

### Defect found — boot broker call burns retries on cold-CLI timeout

On all three fresh boots, attempts 1 and 2 of the `jitconfig` call failed:

```json
{"msg":"broker invoke failed","action":"jitconfig","attempt":1,"status":null,"error":"spawnSync aws ETIMEDOUT","stderr":""}
{"msg":"broker invoke failed","action":"jitconfig","attempt":2,"status":null,"error":"spawnSync aws ETIMEDOUT","stderr":""}
```

Attempt 3 succeeded, so every job ran — but the boot path is running with **no retry
margin**. `BOOT_CALL_TIMEOUT_MS = 6000` is too tight for a cold `aws` CLI invocation inside
a freshly-snapshot-resumed guest (measured: >6 s on the first two tries, consistently).
The comment in `run-hook.mjs` budgets `3 × 6 s + 2 s + 4 s = 24 s` against the 30 s
`runTimeoutInSeconds`; observed usage was ~22 s of that 30 s to get one success. A single
additional slow attempt would exhaust the platform hook deadline and strand the VM.

This is a latent reliability bug, not a security finding, and it did not fail this
verification. It is **not** fixed here — it needs its own card (raise the boot budget
and/or pre-warm the CLI in the image so the first call is not cold).

## M4 evidence

| Output | Value |
|---|---|
| `LCA-Web-dev.ConsoleUrl` | `https://d2x4qcl1ibd2ax.cloudfront.net` |
| `LCA-Web-dev.DistributionId` | `EI6WSGHFSQUCX` |
| `LCA-Mgmt-dev.MgmtApiEndpoint` | `https://q2s2zkcji8.execute-api.us-west-2.amazonaws.com` |
| `LCA-Mgmt-dev.RunLogGroup` | `/aws/lambda/microvms/runs/lca-dev` |

### GSI2 is sparse and was not backfilled

GSI2 (`REPORUNS#<repoId>` / `createdAt`, ADR-023) did not exist before this deploy — it
landed with the `LCA-Data-dev` update at **23:20:47Z**. `gsi2pk`/`gsi2sk` are written once
in `buildQueuedItem` (`src/shared/run-store.ts`), so DynamoDB only projects rows **queued
after** that point. Measured immediately after the deploy:

| RUN rows | count |
|---|---|
| total | 104 |
| in GSI2 (`gsi2pk` present) | 7 — every run queued from 23:23:28Z onward |
| not in GSI2 | 97 — `2026-07-14T13:29:04Z` … `2026-07-28T23:20:48Z` |

Consequence for the console: `GET /api/runs?repo=<id>` and the Repo-detail history it
backs (`listRunsByRepo` → `IndexName: 'gsi2'`) show **only post-deploy runs** for every
repo. The unfiltered Dashboard view and `?status=` filter are unaffected — they read GSI1,
which predates this deploy.

This is expected sparse-index behaviour, not a defect: `createdAt` is immutable so a
backfill is a pure one-off `UpdateItem` per row, and the pre-existing rows are dev-only
traffic that ages out on the table's `ttl`. Recorded here so the M4 exit walkthrough is not
read as broken when a repo's history looks short. Prod cutover has no such gap (GSI2 exists
before the first run).

Phases run per docs/DEPLOY-M4.md:

- **Phase 0** — `/lca/dev/mgmt/session-secret` created out-of-band as a **SecureString**
  (`openssl rand -base64 32`), version 1. Not created by CloudFormation (ADR-008).
- **Phase 1** — `npm run build:web` → `web/dist` (index.html, main.css, main.js 167 kB).
- **Phase 2** — `npx cdk deploy LCA-Mgmt-dev LCA-Web-dev -c env=dev` (292 s; CloudFront
  distribution creation dominates).
- **Phase 3** — `npx cdk deploy LCA-Mgmt-dev -c env=dev -c publicOrigin=https://d2x4qcl1ibd2ax.cloudfront.net`
  → `PUBLIC_ORIGIN` now set on `lca-dev-mgmt` (19 s, Lambda env only).

Verified live:

- Console serves the SPA: `GET /` → **200**, `<title>LambdaCIActions Console</title>`.
- `GET /auth/login` → **302** to
  `https://github.com/login/oauth/authorize?client_id=Iv23liqxo1L0yFSPaYws&redirect_uri=https%3A%2F%2Fd2x4qcl1ibd2ax.cloudfront.net%2Fauth%2Fcallback&state=…`
  — correct client id, correct callback, CSRF state present. So Phase 3 took effect and the
  documented "login 500s until Phase 3" state is passed.
- Management API rejects unauthenticated reads: `/api/repos`, `/api/runs`, `/api/settings`
  all **401** `{"error":"not authenticated"}`.
- A path like `/runs/123` returns **403** — expected, not a defect: the console is
  hash-routed (`#/runs/…`) precisely because a distribution-wide CloudFront error rewrite
  would corrupt the API's own 401/403/404 responses (ADR-024 / web-stack.ts class doc).

## Outstanding — one human step

**The OAuth callback URL is not registered on the GitHub App, and cannot be set by this
agent.** GitHub exposes no REST endpoint to modify a GitHub App's callback URLs (`PATCH
/app` does not exist; `GET /app` is read-only), so this is browser-only.

Root cause: `scripts/create-github-app.mjs` registers the app with
`redirect_url: http://localhost:8976/callback` — the local one-shot listener it uses to
capture credentials at bootstrap. The console origin did not exist then and was never
added afterwards.

Fix (Developer settings → GitHub Apps → `lambdaciactions-dev` → General):

- **Callback URL**: add `https://d2x4qcl1ibd2ax.cloudfront.net/auth/callback`

Until then, clicking "Sign in with GitHub" reaches GitHub's authorize page and GitHub
refuses the redirect back, so console login (and therefore M4 phase-5 verification steps
1–7) cannot complete. Everything on the LCA side of that flow is confirmed correct.

## Reproduction

```sh
# preflight (worktree needs its own copy of the gitignored pin)
cp ../../.env.local .env.local
ada credentials update --account=863638663908 --provider=isengard --role=Admin \
  --profile=sauhsoj+playground1-Admin --once
npm ci && npm run build && npm test && npx cdk synth -c env=dev

# skew window — verify quiet, then move both planes together
aws lambda-microvms list-microvms --region us-west-2      # expect 0 non-TERMINATED
npm run build:images -- --env dev --region us-west-2
npx cdk deploy LCA-Control-dev -c env=dev

# posture check against the DEPLOYED role
aws iam get-role-policy --role-name lca-dev-microvm-exec \
  --policy-name "$(aws iam list-role-policies --role-name lca-dev-microvm-exec \
                    --query 'PolicyNames[0]' --output text)"

# E2E
gh workflow run flavors.yml --repo jsamuel1/lca-m3-verify --ref main

# M4
aws ssm put-parameter --name /lca/dev/mgmt/session-secret --type SecureString \
  --value "$(openssl rand -base64 32)" --region us-west-2
npm run build:web
npx cdk deploy LCA-Mgmt-dev LCA-Web-dev -c env=dev
npx cdk deploy LCA-Mgmt-dev -c env=dev -c publicOrigin=https://d2x4qcl1ibd2ax.cloudfront.net
```

### Gotcha: stale static credentials shadow `credential_process`

`aws sts get-caller-identity` failed with `ExpiredToken` even though the profile's
`credential_process` (isengardcli) returned a valid, unexpired credential. Cause: stale
`aws_access_key_id`/`aws_session_token` entries for the same profile name in
`~/.aws/credentials`, which take precedence over the `credential_process` in
`~/.aws/config`. `ada credentials update … --once` rewrites those entries and fixes it.

### Gotcha: `list-microvm-image-versions` wants an ARN, and its payload is `items`

The image-inspection verbs are worth pinning, because the obvious guesses fail:
`--image-identifier` rejects a bare image name (`Invalid ARN format: lca-dev-base`) and
wants the full `arn:aws:lambda:<region>:<acct>:microvm-image:<name>`. The response key is
`items` (not `MicrovmImageVersions`) and each entry's version field is `imageVersion`, so
JMESPath written against the CLI's usual PascalCase shape silently returns `null`. For
"what is live right now", `get-microvm-image` → `latestActiveImageVersion` is direct:

```sh
aws lambda-microvms get-microvm-image \
  --image-identifier arn:aws:lambda:us-west-2:863638663908:microvm-image:lca-dev-docker \
  --query '[name,latestActiveImageVersion,updatedAt]' --output text

aws lambda-microvms list-microvm-image-versions \
  --image-identifier arn:aws:lambda:us-west-2:863638663908:microvm-image:lca-dev-docker \
  --query 'items[].[imageVersion,state,additionalOsCapabilities]' --output text
```

## Independent re-verification (review pass)

Every live claim above was re-checked against AWS/GitHub afterwards from the same pinned
account — as a review of this note, not a re-run of the deploy. All matched: stack
statuses/timestamps, the six `lca-dev-*` functions, the deployed exec-role policy
(statement-for-statement), Provision's `HOOK_BROKER_NAME`, the broker's own two-statement
role, `ReservedConcurrentExecutions: 20`, per-flavor `latestActiveImageVersion`
(10.0 / 9.0 / 10.0) with `additionalOsCapabilities: ["ALL"]` on docker **only**, run
`30407823249`'s three green jobs and their labels, all three run rows (`completed`,
`microvmId`, `hookTokenHash`, no plaintext), the three brokered `self-terminate` log lines,
the six `ETIMEDOUT` jitconfig attempts, the 97 → 164 byte payload transition, the
token-pattern log scan (2 hits, both the literal error string), M4's `PUBLIC_ORIGIN` / 302 /
401s / 403, and `npm test` → 281/281 with a credential-less `cdk synth` clean.

Two refinements from that pass:

- **The 6-invocation count is right, and the evidence is stronger than stated.** The broker
  log shows exactly 6 `START` lines in the E2E window (8 only if `INIT_START` is miscounted).
  The six timed-out jitconfig attempts produced **no broker `START` at all** — independent
  proof the timeout is spent in the guest's cold `aws` CLI rather than in broker latency,
  which is precisely what the defect above asserts.
- **GSI2's backfill gap** was unrecorded; now [documented above](#gsi2-is-sparse-and-was-not-backfilled).
