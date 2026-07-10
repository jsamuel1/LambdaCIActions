# GitHub App bootstrap

`scripts/create-github-app.mjs` registers the **LambdaCIActions** GitHub App via the
[App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
and writes the generated credentials to SSM. See [docs/specs/01-github-app.md](../docs/specs/01-github-app.md)
for the permission/event rationale.

## Why not `gh app create`?

There is no such command, and it can't exist as a pure PAT-driven call: the REST `/app`
endpoints authenticate with a **JWT signed by the App's own private key** — which you don't
have until the App exists (chicken-and-egg). GitHub App creation is only possible via:

1. The web UI (`github.com/settings/apps/new`), or
2. The **App Manifest flow** — POST a manifest, the user clicks **Create GitHub App** once
   in the browser, GitHub redirects back with a temporary `code`, and you exchange it for
   the credentials.

This script automates everything except that one required click.

## Requirements

- Node ≥ 18 (built-ins only — zero npm deps).
- AWS CLI configured with permission to `ssm:PutParameter` under `/lca/<env>/github/*`
  (skip with `--dry-run`).
- A browser on the machine running the script (or copy the printed `localhost` URL).

## Usage

Preview the manifest + planned SSM writes without touching GitHub or AWS:

```sh
node scripts/create-github-app.mjs --dry-run --env dev
```

Create for real (personal account):

```sh
node scripts/create-github-app.mjs \
  --console-url https://console.example.com \
  --webhook-url https://<api-id>.execute-api.us-west-2.amazonaws.com/webhook \
  --env dev --region us-west-2
```

Create under an org, custom callback port:

```sh
node scripts/create-github-app.mjs \
  --console-url https://console.example.com \
  --webhook-url https://api.example.com/webhook \
  --org my-org --env prod --region us-east-1 --port 8976
```

### Flags

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--console-url` | yes (unless `--dry-run`) | — | App homepage URL |
| `--webhook-url` | yes (unless `--dry-run`) | — | Webhook receiver (API GW `/webhook`) |
| `--org` | no | personal account | Create under this org |
| `--env` | no | `dev` | SSM namespace `/lca/<env>/github/*` |
| `--region` | no | AWS CLI default | Region for SSM |
| `--port` | no | `8976` | Local callback port |
| `--dry-run` | no | off | Print manifest + planned writes, no side effects |

## What it writes to SSM

Under `/lca/<env>/github/`:

| Param | Type |
|---|---|
| `app-id` | String |
| `client-id` | String |
| `app-slug` | String |
| `client-secret` | SecureString |
| `webhook-secret` | SecureString |
| `app-pem` | SecureString |

Per [ADR-008](../docs/DECISIONS.md), these are **created out-of-band by this script** and
only *referenced* by CDK (CloudFormation cannot create SecureStrings).

## Ordering caveat

The `--webhook-url` must be the deployed API Gateway `/webhook` endpoint, which doesn't
exist until `ControlStack` deploys. So the real run belongs **inside ROADMAP M1**, after
infra is up. Use `--dry-run` any time to validate the manifest shape.

## After creation

Install the app on your repos at `https://github.com/apps/<slug>/installations/new`
(the script prints the exact URL). The `installation` webhook then drives repo discovery
and workflow ingestion (spec 01 + 03).
