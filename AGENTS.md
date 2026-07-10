# AGENTS.md — LambdaCIActions

Guidance for AI coding agents working in this repo.

## What this is
A CI/CD platform running GitHub Actions jobs on **AWS Lambda microVMs** — a drop-in
replacement for GitHub-hosted/self-hosted runners. GitHub App for onboarding, workflow
ingestion for routing, web UI for management. **Currently spec/design phase — no code yet.**

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

## Hard rules
- arm64 only — don't assume x86 binaries/base images.
- Least privilege IAM per Lambda (see 05); microVM launch/terminate scoped by resource tag.
- Don't put secret **values** in the UI/API — presence/health only.
- GitHub `contents:write` (auto-rewrite PRs) is **off by default** — don't enable without explicit decision.

## When adding code
- Match the milestone in `docs/ROADMAP.md`; update the relevant spec + add an ADR for any design-affecting choice.
- Keep control / compute / management plane boundaries clean (see ARCHITECTURE).
