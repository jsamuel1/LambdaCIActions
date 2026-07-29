# AGENTS.md — LambdaCIActions

Guidance for AI coding agents working in this repo.

## What this is
A CI/CD platform running GitHub Actions jobs on **AWS Lambda microVMs** — a drop-in
replacement for GitHub-hosted/self-hosted runners. GitHub App for onboarding, workflow
ingestion for routing, web UI for management. Built milestone-by-milestone (M1..M5, see
`docs/ROADMAP.md`) via the Kermes full_auto kanban pipeline.

## Full-auto task lifecycle (READ THIS if you are a kanban worker)
This repo runs under Kermes **full_auto**. When you are spawned on an `in_progress`
milestone card, you own the card through to review handoff. The spawn primer gives you
ONLY the task title + description — the handoff contract lives here:

1. Implement the milestone scope in your worktree. Match the spec + add/adjust ADRs.
2. Run the gate before handoff: `npm ci && npm run build` && `npm test` && `npx cdk synth`.
   Do not hand off red.
3. **Commit** your work on the task branch (`kermes/task-<slug>`). Never leave verified
   work uncommitted — an empty branch strands the milestone.
4. Leave a `task_comment` summarizing what shipped + what was tested + the commit hash.
5. **When done and green, call `task_request_review` on your own card.** This is the ONLY
   thing that advances the card into the review→merge pipeline — if you just stop, the
   card freezes in `in_progress` and the milestone chain stalls. Do NOT `task_close`
   (that terminates the lifecycle and skips review+merge).
6. If you genuinely cannot finish (blocked, ambiguous spec, unrecoverable failure),
   `task_comment` the reason and `task_fail` the card — do not exit silently.

Do NOT push to `main` directly. Landing happens in the merge stage via a PR (`gh pr
merge`); base branch is always `main`.

## Read first
- `README.md` — vision + repo map.
- `docs/ARCHITECTURE.md` — planes, request flows, data model, security.
- `docs/DECISIONS.md` — ADRs (why things are the way they are). **Check before proposing design changes.**
- `docs/specs/01..05` — component specs.
- `docs/ROADMAP.md` — milestones + exit criteria.

## Conventions (planned)
- Language: **TypeScript** everywhere (CDK v2 infra, Lambdas, React SPA).
- Runtime: **arm64** (microVMs are Graviton-only — no x86_64).
- Secrets: **SSM SecureString**, created out-of-band, only referenced by CDK. **Never** commit secrets or write them to code/CFN.
- Deploy is **phased**: infra → build images → orchestrator (image ARNs must exist first). See `docs/specs/05-infrastructure.md`.
- **Deploy-target pin (ADR-018):** deploy-touching commands (cdk deploy/diff, `build:images`, `app:create`, `backfill:installs`) REQUIRE a gitignored `.env.local` (copy `.env.local.example`) pinning `LCA_DEPLOY_ACCOUNT` + `LCA_DEPLOY_REGION`; they verify the ambient credentials actually resolve to that account and refuse on mismatch. Credential-less `cdk synth` and `--dry-run` are exempt — except `backfill:installs`, whose dry run reads the live table and so is pinned too (ADR-028).
- **Toolchain floor:** the compute plane uses the `lambda-microvms` service (API `2025-09-09`, GA 2026-06-22) — a separate namespace from `aws lambda`. Requires **AWS CLI ≥ 2.35.17** and **boto3/botocore ≥ 1.43.44**; older tooling (incl. the AL2023 `awscli-2` dnf package) can't see the API and the deploy fails at image-build. Verify with `aws lambda-microvms help`. Full matrix + install steps in `docs/specs/05-infrastructure.md` § Toolchain prerequisites.

## Hard rules
- arm64 only — don't assume x86 binaries/base images.
- Least privilege IAM per Lambda (see 05); microVM launch/terminate scoped to account/region — NOT by VM tag (the GA `lambda-microvms` API can't tag VMs; run↔VM mapping lives in the run store, see ADR-015).
- Don't put secret **values** in the UI/API — presence/health only.
- GitHub `contents:write` (auto-rewrite PRs) is **off by default** — don't enable without explicit decision.

## When adding code
- Match the milestone in `docs/ROADMAP.md`; update the relevant spec + add an ADR for any design-affecting choice.
- Keep control / compute / management plane boundaries clean (see ARCHITECTURE).
