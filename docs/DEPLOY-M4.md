# M4 deploy runbook — console + management API

Brings up the **management plane** (ROADMAP M4): `LCA-Mgmt-<env>` (management API) and
`LCA-Web-<env>` (console on S3 + CloudFront). Assumes M1–M3 are already deployed per
[DEPLOY-M1](DEPLOY-M1.md) — the console reads the same DynamoDB table and the run log
group the compute plane already writes.

Design: [spec 04](specs/04-web-ui.md) · [ADR-022](DECISIONS.md#adr-020) (auth) ·
[ADR-024](DECISIONS.md#adr-022) (single CloudFront origin) ·
[ADR-025](DECISIONS.md#adr-023) (IAM boundary).

## Phase -1 — deploy-target pin (ADR-018)

Same rule as every other deploy: `.env.local` must pin `LCA_DEPLOY_ACCOUNT` +
`LCA_DEPLOY_REGION` and your credentials must resolve to that account, or the command
refuses. `cdk synth` without credentials stays exempt.

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

Also create the **platform-admin allow-list** (ADR-030). Platform settings changes (re-link
the GitHub App, change runner labels, test webhook delivery) require membership in it, and it
**fails closed**: until it exists, Settings is read-only and the API answers 403 naming the
parameter. It is a plain `String` — a list of GitHub logins is not a secret:

```sh
aws ssm put-parameter \
  --name "/lca/<env>/config/platform-admins" \
  --type String \
  --value "your-github-login,another-operator" \
  --region "$LCA_DEPLOY_REGION"
```

Revocation is a parameter edit — the management λ reads it uncached, so it takes effect on the
next request.

The claimed runner labels (`/lca/<env>/config/runner-labels`) are created by the M1–M3 deploy.
Once the allow-list above is in place they can be changed from the Settings screen instead of
by hand.

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

## Phase 2 — first deploy (login not yet functional)

```sh
npx cdk deploy LCA-Mgmt-<env> LCA-Web-<env> -c env=<env>
```

Note the `ConsoleUrl` output from `LCA-Web-<env>`, e.g.
`https://d111111abcdef8.cloudfront.net`.

Login deliberately fails with a 500 at this point: the management API has no
`PUBLIC_ORIGIN`, and guessing one would create an open-redirect target (ADR-024).

## Phase 3 — point the API at the console origin (second pass)

```sh
npx cdk deploy LCA-Mgmt-<env> -c env=<env> -c publicOrigin=https://<console-domain>
```

This sets `PUBLIC_ORIGIN`, which the API uses to build the OAuth redirect URI and the
post-login redirect. Only the Lambda's environment changes — no data migration.

## Phase 4 — register the OAuth callback on the GitHub App

In the App's settings (Developer settings → GitHub Apps → your app):

- **Callback URL**: `https://<console-domain>/auth/callback`
- Leave "Request user authorization (OAuth) during installation" as-is; the console drives
  the OAuth flow itself.

The callback URL must match exactly — GitHub rejects mismatches.

## Phase 5 — verify (M4 exit criterion)

1. Open `https://<console-domain>` → "Sign in with GitHub" → authorize.
2. **Setup** lists your installation(s) and shows platform readiness as *App verified /
   labels claimed / webhook state* rather than a parameter checklist.
3. **Repos** lists the repos granted to the installation. Enable one.
4. **Repo detail** shows parsed workflows with per-job `runs-on → flavor` and compat
   findings. If empty, hit **Re-scan** (enqueues a Discovery scan) and reload after ~30 s.
5. Push a commit to that repo. **Dashboard** shows the run appear as `queued`; **Run
   detail** advances `provisioning → running → completed` on its own (3 s polling).
6. On **Run detail**, the log pane tails the runner output from
   `/aws/lambda/microvms/runs/lca-<env>`. "No log stream yet" is expected until the
   microVM boots.
7. **Settings** shows the environment's linkage with evidence, not a list of SSM paths
   (spec 04 § Settings): the GitHub App verified live via `GET /app` (name + app id), its
   installations, the effective runner labels, and webhook health backed by a real
   last-received delivery. No values are returned by construction — credential presence is
   probed with `DescribeParameters` and demoted to the collapsed **Diagnostics** section.
8. If you are in the `platform-admins` list (Phase 0), the mutating actions are enabled:
   **Re-link App…** (write-only credential intake, verified against GitHub before anything is
   written, with a rollback button), label editing behind a mandatory **Preview impact**, and
   **Test delivery** (asks GitHub to re-deliver its most recent delivery — the "last received"
   timestamp advancing is the proof the round-trip landed). Without the allow-list every
   action is hidden and the API answers 403.

## Rollback / teardown

```sh
npx cdk destroy LCA-Web-<env> LCA-Mgmt-<env> -c env=<env>
```

Non-prod buckets auto-delete their objects; the DynamoDB table belongs to
`LCA-Data-<env>` and is untouched. Destroying these two stacks removes the console and API
only — the hot path (webhook → ingest → provision) keeps running.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login → 500 | `PUBLIC_ORIGIN` unset | Phase 3 (re-deploy with `-c publicOrigin=...`) |
| `invalid OAuth state` | state cookie lost (different host, or >10 min on the GitHub page) | Retry from the console origin |
| Redirected to Setup with `reason=no-installations` | GitHub returned no installations for this user | Install the App on an org/account you can admin |
| Repos list empty | App granted no repositories | Add repos to the installation, then reload |
| Workflows empty | Discovery hasn't scanned yet | **Re-scan**, or push to `.github/workflows/**` |
| Logs always "pending" | run has no `microvmId` (never launched) | Check the Provision λ logs + DLQ |
| 403 on every API call | session's installation grants are stale | Sign out and back in (grants are frozen at login, ADR-022) |
| Settings actions hidden / 403 "no platform administrators are configured" | `/lca/<env>/config/platform-admins` unset (fails closed, ADR-030) | Create it (Phase 0), then reload |
| Every delivery 401s after a relink | GitHub still signs with the old webhook secret (`hookSynced: false`) | Set the webhook secret on the App at GitHub by hand, or roll back from Settings |

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
