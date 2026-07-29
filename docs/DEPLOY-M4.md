# M4 deploy runbook — console + management API

Brings up the **management plane** (ROADMAP M4): `LCA-Mgmt-<env>` (management API) and
`LCA-Web-<env>` (console on S3 + CloudFront). Assumes M1–M3 are already deployed per
[DEPLOY-M1](DEPLOY-M1.md) — the console reads the same DynamoDB table and the run log
group the compute plane already writes.

Design: [spec 04](specs/04-web-ui.md) · [ADR-022](DECISIONS.md#adr-020) (auth) ·
[ADR-024](DECISIONS.md#adr-022) (single CloudFront origin) ·
[ADR-025](DECISIONS.md#adr-023) (IAM boundary) ·
[ADR-028](DECISIONS.md#adr-028) (vanity domain).

## Phase -1 — deploy-target pin (ADR-018)

Same rule as every other deploy: `.env.local` must pin `LCA_DEPLOY_ACCOUNT` +
`LCA_DEPLOY_REGION` and your credentials must resolve to that account, or the command
refuses. `cdk synth` without credentials stays exempt.

## Phase -0.5 — console origin: vanity domain or raw CloudFront (ADR-028)

The console's origin is load-bearing in three places — `PUBLIC_ORIGIN` on the Mgmt λ, the
GitHub App's OAuth callback URL, and the session cookie — and GitHub has **no API for App
settings**, so changing it later is a browser-only edit that breaks login until someone does
it. Decide now which path you are on.

**Recommended — vanity domain.** Add to `.env.local` (see `.env.local.example`):

```sh
LCA_CONSOLE_HOSTED_ZONE_ID=Z01234567ABCDEFGHIJK   # bare id, not /hostedzone/...
LCA_CONSOLE_ZONE_NAME=example.com                 # zone apex
```

The hostname is derived: `lambdaciactions.<zone>` for **prod**, `<env>.lambdaciactions.<zone>`
for every other env. Prod thus gets its permanent name on its first deploy and never has a
raw-CloudFront callback registered.

With this set, `PUBLIC_ORIGIN` is config — **Phase 3 below is skipped entirely**. All
`LCA_CONSOLE_*` keys must be set together; a partial config is rejected (a distribution with
no alias while the API advertises the vanity origin would break login with a misleading
`invalid OAuth state`).

**Fallback — no domain.** Leave every `LCA_CONSOLE_*` key unset (required if the account owns
no public hosted zone). The console serves on `https://<id>.cloudfront.net`, and the two-pass
bootstrap in Phase 3 applies.

## Phase 0 — console session secret (out-of-band, ADR-008)

The session cookie signing key is a SecureString CloudFormation must not create. Generate
32 random bytes and write it once per environment:

```sh
aws ssm put-parameter \
  --name "/lca/<env>/mgmt/session-secret" \
  --type SecureString \
  --value "$(openssl rand -base64 32)" \
  --region "$LCA_DEPLOY_REGION"
```

Rotating this parameter invalidates every active console session — that is the revocation
lever (ADR-022).

The OAuth client id/secret are already in SSM if you bootstrapped with
`npm run app:create` (`/lca/<env>/github/client-id`, `client-secret`). Verify:

```sh
aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/lca/<env>/" \
  --query 'Parameters[].Name' --region "$LCA_DEPLOY_REGION"
```

## Phase 1 — build the console bundle

```sh
npm ci
npm run build          # tsc → dist/ (infra + λ sources)
npm run build:web      # esbuild → web/dist (index.html, main.js, main.css)
```

`web/dist` is what WebStack uploads. If it is missing, the asset deployment is skipped
(so credential-less `cdk synth` still works) — but then the distribution serves nothing,
so do not skip this step before deploying.

## Phase 2 — deploy

### One-time: bootstrap us-east-1 (vanity-domain path only)

`LCA-Cert-<env>` is the repo's only stack outside `LCA_DEPLOY_REGION`, so it needs the CDK
bootstrap stack in **us-east-1** as well. Without it the deploy aborts immediately —
`SSM parameter /cdk-bootstrap/hnb659fds/version not found` / "has not been bootstrapped" —
before ACM is touched. Do it once per account:

```sh
npx cdk bootstrap aws://<LCA_DEPLOY_ACCOUNT>/us-east-1
```

(The deploy region was bootstrapped back in M1. Skip this entirely on the no-domain path —
no stack leaves the deploy region there.)

With a **vanity domain** configured, deploy the certificate first (or let `--all` order it —
WebStack declares the dependency):

```sh
npx cdk deploy LCA-Cert-<env> LCA-Mgmt-<env> LCA-Web-<env> -c env=<env>
```

`LCA-Cert-<env>` is deployed to **us-east-1** on purpose — CloudFront accepts viewer
certificates from no other region — while everything else lands in `LCA_DEPLOY_REGION`. This
is the phase that takes wall-clock time on a **new** hostname: ACM writes a `_<hash>` CNAME
into your zone and polls until the domain validates, and CloudFormation blocks the cert until
`ISSUED`, so the distribution can never come up with an alias whose cert is pending. Expect a
few minutes. Re-deploys reuse the issued cert.

Login works as soon as this completes — `PUBLIC_ORIGIN` came from config — except that the
GitHub App callback is not registered yet (Phase 4).

With **no domain**:

```sh
npx cdk deploy LCA-Mgmt-<env> LCA-Web-<env> -c env=<env>
```

Note the `ConsoleUrl` output from `LCA-Web-<env>`, e.g.
`https://d111111abcdef8.cloudfront.net`. Login deliberately fails with a 500 at this point:
the management API has no `PUBLIC_ORIGIN`, and guessing one would create an open-redirect
target (ADR-024). Continue to Phase 3.

Either way, `LCA-Web-<env>` outputs the exact string to register on GitHub as
`ConsoleOAuthCallbackUrl`.

## Phase 3 — point the API at the console origin (no-domain path ONLY)

**Skip this phase entirely if you configured a vanity domain** — `PUBLIC_ORIGIN` is already
set from `.env.local`.

```sh
npx cdk deploy LCA-Mgmt-<env> -c env=<env> -c publicOrigin=https://<console-domain>
```

This sets `PUBLIC_ORIGIN`, which the API uses to build the OAuth redirect URI and the
post-login redirect. Only the Lambda's environment changes — no data migration.

`-c publicOrigin=` always wins over the domain config, which is also how you pin a
transitional origin during a migration (see below).

## Phase 4 — register the OAuth callback on the GitHub App

In the App's settings (Developer settings → GitHub Apps → your app):

- **Callback URL**: the `ConsoleOAuthCallbackUrl` output, i.e. `https://<console-domain>/auth/callback`
- Leave "Request user authorization (OAuth) during installation" as-is; the console drives
  the OAuth flow itself.

The callback URL must match exactly — GitHub rejects mismatches. This edit is **browser-only**:
GitHub exposes no REST endpoint for App settings (`PATCH /app` does not exist), which is the
whole reason the origin is worth pinning to a domain you control (ADR-028).

## Phase 5 — verify (M4 exit criterion)

1. Open `https://<console-domain>` → "Sign in with GitHub" → authorize.
2. **Setup** lists your installation(s) and shows all required parameters present.
3. **Repos** lists the repos granted to the installation. Enable one.
4. **Repo detail** shows parsed workflows with per-job `runs-on → flavor` and compat
   findings. If empty, hit **Re-scan** (enqueues a Discovery scan) and reload after ~30 s.
5. Push a commit to that repo. **Dashboard** shows the run appear as `queued`; **Run
   detail** advances `provisioning → running → completed` on its own (3 s polling).
6. On **Run detail**, the log pane tails the runner output from
   `/aws/lambda/microvms/runs/lca-<env>`. "No log stream yet" is expected until the
   microVM boots.
7. **Settings** shows every secret as `set` — and no values (by construction: the API
   reads presence via `DescribeParameters`).

## Migrating an existing console onto a vanity domain (ADR-028)

For an env already live on `https://<id>.cloudfront.net`.

Two facts drive the ordering:
- The OAuth `state` cookie is **host-only** (`Path=/; HttpOnly; Secure; SameSite=Lax`, no
  `Domain` attribute — `src/mgmt/session.ts`), and `redirect_uri` is built from a single
  `PUBLIC_ORIGIN`. So a login must **start and finish on the same host**: starting one at
  `https://<vanity>/auth/login` while `PUBLIC_ORIGIN` still names the CloudFront host sends
  GitHub back to the old host, which never received the state cookie → `invalid OAuth state`.
  During the transition, keep operators on whichever host `PUBLIC_ORIGIN` names.
- Changing the GitHub App callback is **browser-only** (no API), so the new callback must be
  registered *before* the origin flip, and the old one removed only *after* it.

1. Add `LCA_CONSOLE_HOSTED_ZONE_ID` + `LCA_CONSOLE_ZONE_NAME` to `.env.local`, and bootstrap
   us-east-1 if you have not already (Phase 2) — the cert stack lands there.
2. Deploy the cert + alias while **keeping the old origin authoritative** — pin it explicitly
   so `PUBLIC_ORIGIN` does not move yet:
   ```sh
   npx cdk deploy LCA-Cert-<env> LCA-Web-<env> LCA-Mgmt-<env> -c env=<env> \
     -c publicOrigin=https://<old-cloudfront-domain>
   ```
   Wait for ACM validation. `https://<vanity>` now serves the SPA, but **do not log in
   through it yet** — keep using the old origin (see above). Verify the vanity host with an
   unauthenticated check instead:
   ```sh
   curl -sSI https://<vanity>/ | head -1          # expect 200 + a valid cert
   ```
3. In the GitHub App settings, **add** `https://<vanity>/auth/callback` alongside the existing
   CloudFront callback (GitHub Apps accept multiple callback URLs). Do not remove anything.
4. Flip the origin by dropping the override — config takes over:
   ```sh
   npx cdk deploy LCA-Mgmt-<env> -c env=<env>
   ```
   From here on, log in **only** via `https://<vanity>`; the old host now redirects to the
   vanity callback and will fail its own state check.
5. Verify login end-to-end on `https://<vanity>`. Existing sessions do **not** carry over:
   the session cookie is scoped to the old host, so operators sign in once more.
6. Only now remove the old CloudFront callback entry from the App.

Rollback at any point before step 6: re-deploy `LCA-Mgmt-<env>` with
`-c publicOrigin=https://<old-cloudfront-domain>` and log in via the old host again.

## Rollback / teardown

```sh
npx cdk destroy LCA-Web-<env> LCA-Mgmt-<env> -c env=<env>
# with a vanity domain, also:
npx cdk destroy LCA-Cert-<env> -c env=<env>
```

Non-prod buckets auto-delete their objects; the DynamoDB table belongs to
`LCA-Data-<env>` and is untouched. Destroying these two stacks removes the console and API
only — the hot path (webhook → ingest → provision) keeps running.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login → 500 | `PUBLIC_ORIGIN` unset (no-domain path) | Phase 3 (re-deploy with `-c publicOrigin=...`), or configure a vanity domain (ADR-028) |
| `LCA-Cert-<env>` fails instantly: bootstrap version SSM parameter not found | account not bootstrapped in **us-east-1** (the cert stack's region) | `npx cdk bootstrap aws://<account>/us-east-1` — see Phase 2 |
| Deploy hangs on `LCA-Cert-<env>` | ACM validation CNAME not resolving publicly | Check the `_<hash>` CNAME exists in the zone and that the zone is authoritative for the apex; a private zone can never validate |
| `cdk deploy` fails on the distribution with a certificate error | cert not in us-east-1 | Cannot happen via `LCA-Cert-<env>` (it asserts the region) — a manually-supplied ARN must be us-east-1 |
| `Console domain is partially configured` | only some `LCA_CONSOLE_*` keys set | Set the zone id AND zone name together, or clear all of them |
| `not a Route53 zone id` | pasted `/hostedzone/Z...` from the AWS API | Use the bare `Z...` id |
| Vanity host → CloudFront 403 with `ERR_SSL`/wrong-cert warning | DNS points at the distribution but the alias is not attached | Confirm `Aliases` on the distribution; a stale alias record from a previous distribution resolves to the wrong one |
| Login redirects to the OLD origin after a migration | `-c publicOrigin=` still pinned | Re-deploy `LCA-Mgmt-<env>` without the override |
| `invalid OAuth state` right after attaching a vanity alias | login started on a host other than the one `PUBLIC_ORIGIN` names — the state cookie is host-only | Log in via the host `PUBLIC_ORIGIN` names; both hosts serve the SPA but only one completes OAuth |
| `redirect_uri` mismatch from GitHub | App callback list lacks the current origin | Add `https://<origin>/auth/callback` in the App settings (browser-only — no API exists) |
| `invalid OAuth state` | state cookie lost (different host, or >10 min on the GitHub page) | Retry from the console origin |
| Redirected to Setup with `reason=no-installations` | GitHub returned no installations for this user | Install the App on an org/account you can admin |
| Repos list empty | App granted no repositories | Add repos to the installation, then reload |
| Workflows empty | Discovery hasn't scanned yet | **Re-scan**, or push to `.github/workflows/**` |
| Logs always "pending" | run has no `microvmId` (never launched) | Check the Provision λ logs + DLQ |
| 403 on every API call | session's installation grants are stale | Sign out and back in (grants are frozen at login, ADR-022) |

### Pre-M4 rows are invisible until re-written

Two index keys are new in M4 and are only written going forward:

- **Run rows** get `gsi2pk`/`gsi2sk` (ADR-023) at creation, so runs that existed before this
  deploy do not appear in the per-repo history view (`?repo=<id>`). They are still visible
  via the status filter and by direct URL.
- **Installation rows** get `gsi1pk=INSTALLS` on upsert, so `GET /api/installations`
  (and the Setup screen) lists an installation only after its next lifecycle webhook.

Both are cosmetic and self-heal with activity. To force it: re-run the App installation's
"suspend/unsuspend" (or add/remove a repository) to fire an installation webhook. There is
deliberately no migration script — backfilling would mean a full table scan for a view that
fills in on its own.
