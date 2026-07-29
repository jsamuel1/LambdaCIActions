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

### Pre-M4 rows are invisible until re-written

Two index keys are new in M4 and are only written going forward:

- **Run rows** get `gsi2pk`/`gsi2sk` (ADR-023) at creation, so runs that existed before this
  deploy do not appear in the per-repo history view (`?repo=<id>`). They are still visible
  via the status filter and by direct URL. This one is cosmetic and fills in with new runs.
- **Installation rows** get `gsi1pk=INSTALLS` on upsert (`listInstallations` enumerates that
  partition to avoid a table scan). An INSTALL row written by M2-era code has no `gsi1pk`,
  so `GET /api/installations` omits it and the Setup screen shows the "no installations"
  empty state — **even while the platform is claiming and running that installation's jobs**
  (ingest reads repos by primary key, so the hot path is unaffected).

**The installation case does NOT self-heal.** GitHub never re-sends `installation.created`
for an existing installation, and job activity never touches the installation row. Run the
backfill on any environment first deployed before M4:

```bash
npm run build                             # the ADR-018 pin guard is loaded from dist/
npm run backfill:installs                 # dry run — lists the rows it would stamp
npm run backfill:installs -- --apply      # write
```

The script (`scripts/backfill-installs.mjs`, ADR-037) scans for installation rows (keyed
`INSTALL#<id>` / `INSTALL`) missing `gsi1pk` and stamps `gsi1pk=INSTALLS`,
`gsi1sk=<accountLogin>`. It is idempotent (conditional
on `attribute_not_exists(gsi1pk)`) — a second run reports nothing to do. It requires the
same `.env.local` deploy-target pin as every other account-touching command (ADR-018), for
the **dry run too**, since the dry run reads the live table and an unpinned run would report
the wrong account's rows. Defaults: `--env dev`; pass `--table <name>` to skip the SSM
table-name lookup.

Verify:

```bash
aws dynamodb query --table-name lca-dev --index-name gsi1 \
  --key-condition-expression 'gsi1pk = :p' \
  --expression-attribute-values '{":p":{"S":"INSTALLS"}}' \
  --query 'Items[].{id:installationId.N,login:accountLogin.S}'
```

Every installation should be listed. Then reload the console — Setup lists the account as
`active`.

If you cannot run the backfill immediately, the console still self-heals **per operator**:
`GET /api/installations` reconciles any installation the session holds a grant for but the
index did not return, fetching it by primary key and repairing the row (ADR-037). The
backfill is still the right move — it repairs rows nobody has logged in for yet.
