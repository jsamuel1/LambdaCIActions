# Spec 01 — GitHub App

Status: **Draft** · Plane: Control

The GitHub App is how LambdaCIActions attaches to repos, receives job events, and mints
runner credentials. It replaces the reference orchestrator's manual per-repo webhook +
PAT setup with a single self-serve install.

## Contents
- [Why a GitHub App (not a PAT / OAuth App)](#why-a-github-app)
- [App registration](#app-registration)
- [Permissions & events](#permissions--events)
- [Authentication chain](#authentication-chain)
- [Webhook handling](#webhook-handling)
- [JIT runner registration](#jit-runner-registration)
- [Installation lifecycle](#installation-lifecycle)
- [Open questions](#open-questions)

---

## Why a GitHub App

| Option | Verdict |
|---|---|
| Personal Access Token | ✗ user-bound, coarse scopes, rotation pain, no per-repo webhook |
| OAuth App | ✗ acts as a user; not meant for server-to-server automation |
| **GitHub App** | ✓ install-scoped, fine-grained perms, short-lived tokens, org-managed, native webhook |

A GitHub App installs against an org/user, is granted specific repos, delivers webhooks
to one endpoint, and mints short-lived **installation tokens** — exactly the model we need
for multi-tenant runner provisioning.

## App registration

Registered once (per environment) either manually or via **App Manifest flow** (preferred
— lets the web UI drive creation and capture the generated credentials).

Manifest highlights:

```jsonc
{
  "name": "LambdaCIActions",
  "url": "https://<console-domain>",
  "hook_attributes": { "url": "https://<api-domain>/webhook" },
  "redirect_url": "https://<console-domain>/setup/callback",
  "public": false,
  "default_permissions": {
    "actions": "read",
    "administration": "write",   // required to register self-hosted runners
    "contents": "read",          // read .github/workflows for ingestion
    "metadata": "read"
  },
  "default_events": ["workflow_job", "installation", "installation_repositories", "push"]
}
```

Generated on creation and stored in SSM SecureString:
`app_id`, `client_id`, `client_secret`, `webhook_secret`, `pem` (private key).

## Permissions & events

| Permission | Level | Why |
|---|---|---|
| `administration` | write | Create/remove self-hosted runner JIT config |
| `actions` | read | Read workflow/run metadata |
| `contents` | read | Fetch `.github/workflows/*.yml` for ingestion |
| `metadata` | read | Baseline (mandatory) |

| Event | Why |
|---|---|
| `workflow_job` | The hot-path trigger (`queued` → provision) |
| `installation` | App installed/uninstalled/suspended |
| `installation_repositories` | Repos added/removed from an install |
| `push` | Re-parse workflows when `.github/workflows/**` changes |

> Runner registration can be **org-level** (runner group) or **repo-level**. v1 uses
> repo-level JIT for simplicity; org-level runner groups are a Phase-3 option.

## Authentication chain

```
App private key (SSM)
   │  sign JWT (app auth, ~10 min)
   ▼
GET /app/installations/{id}/access_tokens
   │  installation token (~60 min, scoped to granted repos + perms)
   ▼
POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig
   │  JIT runner config (single-use)
   ▼
microVM boots with JIT config → registers → runs one job → auto-removed
```

- **App JWT** signed with the PEM, `iss=app_id`, ≤10-min expiry.
- **Installation token** cached per-installation until near expiry (minimize API calls / rate limits).
- **JIT config** minted per job at provision time; encodes labels, runner group, work dir; single-use, so a leaked config can't re-register.

## Webhook handling

Handled by the **Ingest λ** behind API Gateway `POST /webhook`.

1. Read `X-Hub-Signature-256`; HMAC-SHA256 the raw body with `webhook_secret`; **constant-time** compare. Reject on mismatch.
2. Branch on `X-GitHub-Event`:
   - `workflow_job` + `action=queued` + our label present → enqueue provisioning (fast path). Respond `202` immediately.
   - `workflow_job` + `action=in_progress|completed` → update run record (best-effort).
   - `installation*` → upsert/remove installation + repos in DynamoDB.
   - `push` touching `.github/workflows/**` → enqueue a re-parse job.
3. Always ack fast; do real work async (SQS) so GitHub delivery never times out.

Label contract: LambdaCIActions claims jobs whose `runs-on` includes a configured label
(default `lambda-ci`, plus flavor labels like `lambda-ci-docker`). See [03](03-workflow-ingestion.md).

## JIT runner registration

Preferred over the classic register-token/config.sh dance:

- `generate-jitconfig` returns an **encoded runner config** the runner consumes with `./run.sh --jitconfig <token>`.
- No long-lived registration token on the box; the runner is **auto-removed** after the job.
- Labels/group are fixed at mint time — the runner can't self-relabel.

The Provision λ mints JIT config, passes it as microVM boot data (env/user-data), and the
runner bootstrap (see [02](02-microvm-runners.md)) launches the agent with it.

## Installation lifecycle

| Event | Action |
|---|---|
| `installation.created` | Insert installation + granted repos; kick discovery (parse workflows) |
| `installation_repositories.added` | Insert new repos; parse their workflows |
| `installation_repositories.removed` | Mark repos disabled; stop claiming their jobs |
| `installation.suspend` | Stop provisioning; keep config |
| `installation.unsuspend` | Resume |
| `installation.deleted` | Soft-delete installation + repos; retain run history per retention policy |

## Open questions

- **OQ-1**: Repo-level vs org-level runner groups for v1 default? (Leaning repo-level.)
- **OQ-2**: Do we need `checks:write` to surface richer status back into the PR UI, or is the native Actions job status enough? (Leaning: not needed — GitHub already renders job status.)
- **OQ-3**: Multi-account / multi-region deploy — one App per AWS account+region, or one App fanning out? (Affects webhook routing.)
