# Roadmap

Phased delivery. Each milestone is independently demoable and de-risks the next. Dates TBD;
ordering + exit criteria are the contract.

Legend: 🎯 exit criterion · ⚠️ key risk

---

## M0 — Specs & review (this round)
Design docs + ADRs committed for review. No code.
- 🎯 Specs 01–05 + ARCHITECTURE + DECISIONS reviewed and merged.
- 🎯 Open questions triaged into M1 scope.

## M1 — Spike: one microVM runs one job
Prove the core mechanic end-to-end for a **single hardcoded repo**, minimal glue.
- Register a dev GitHub App; store secrets in SSM.
- `ImageStack` + build script → one `base` flavor snapshot.
- `ControlStack` minimal: API GW `/webhook` → Ingest λ (HMAC + filter) → SQS → Provision λ → mint JIT → launch microVM → runner runs one real job → self-terminates.
- 🎯 A push to the test repo triggers a job that runs on a microVM and reports success in GitHub.
- 🎯 Measured boot latency, job duration, and per-job cost captured (validate reference numbers).
- ⚠️ **microVM quota** — request increases day one. ⚠️ arm64 image gotchas.

## M2 — Robust control plane
Make the hot path production-shaped.
- DLQ + retries + idempotency (`repo,run_id,job_id`).
- Reaper λ + EventBridge schedule; lifetime cap; orphan reconciliation.
- `DataStack` — DynamoDB run records + state machine transitions.
- Installation lifecycle webhooks (install/uninstall/suspend/repos-changed).
- 🎯 Kill/timeout/failure paths verified; no ghost "running" runs; DLQ alarming.

## M3 — Flavors & ingestion ✅ verified 2026-07-27
Multiple runner types + workflow awareness.
- Flavor catalog (`base`, `docker`, `node`) + per-repo `FlavorMap`.
- Discovery + parser: `.github/workflows/**` → normalized model; `push` re-parse.
- `runs-on` → flavor routing; `label` mode.
- Compatibility analysis (`ok`/`warn`/`risk`/`block`).
- 🎯 **verified** — A repo with docker + node jobs routes each to the right flavor with no YAML edits beyond adding LCA labels. Evidence: [`docs/VERIFY-M3.md`](VERIFY-M3.md) (`jsamuel1/lca-m3-verify` run `30244719785`, all three jobs green on `base`/`node`/`docker` microVMs). Verification found + fixed one platform defect: the `docker` flavor could never start `dockerd` (ADR-020).

## M4 — Web UI & Management API
Operator visibility + control. **Shipped** — see [spec 04](specs/04-web-ui.md), ADR-022..024, [DEPLOY-M4](DEPLOY-M4.md).
- `MgmtStack` API + `WebStack` SPA + GitHub OAuth.
- Screens: Setup, Dashboard, Repos, Repo/Workflow detail, Runs, Run detail (logs), Flavors, Settings.
- Run history (GSI2, ADR-023) + CloudWatch log viewer; live status via polling (ADR-026).
- 🎯 An operator installs the App, enables a repo, watches a run to completion, and reads its logs — all from the UI.

## M5 — Drop-in & polish
True zero-edit adoption + hardening.
- `adopt` mode (standard-label mapping); opt-in auto-rewrite PR.
- **Flavor catalog expansion** — standard language flavors (`python`, `java`, `go`, `rust`) with a prebaked runner tool cache so `setup-*` actions short-circuit (ADR-031); flavor images request their catalog memory (ADR-030).
- **Custom flavors** — per-installation bring-your-own image, merged over the built-in catalog (ADR-032), not routable until a smoke run proves it works (ADR-033).
- Compat guidance surfaced with actionable fixes.
- Metrics/alarms/X-Ray; cost estimates in Run detail.
- **Reports screen** — cost/utilisation over a time window, grouped by repo/flavor/workflow
  (cost left Runs per ADR-029; see spec 04 OQ-6).
- `dev`/`prod` account separation; runbook + quotas doc.
- 🎯 A brand-new repo runs unchanged in `adopt` mode; dashboard shows health + cost.

## Phase 3 backlog (post-v1)
- Warm pool / boot-latency optimization (revisit ADR-006).
- Org-level runner groups (vs repo-level).
- VPC-attached flavors + egress filtering per repo.
- Shared caching layer (EFS/S3) for package managers + Docker layers.
- WebSocket live updates (vs polling).
- Secrets Manager + rotation (vs SSM).
- Language-runtime signal inference (route a `pytest` job to `python` with no label — needs parser support for `setup-*` steps + a multi-runtime policy, ADR-031).
- A `dotnet` flavor (deliberately excluded from the M5 standard set — largest snapshot, no verified consumer yet).
- Multi-region / DR for the webhook endpoint.

## Cross-cutting risks
| Risk | Mitigation |
|---|---|
| microVM quotas low/inconsistent | Request early per account; UI surfaces headroom; SQS backpressure |
| arm64-only breaks some workflows | Compat analysis flags; document arm64 image path |
| Boot latency per job (no pool) | Pre-warmed snapshots; warm pool in Phase 3 if needed |
| GitHub App permission creep (`contents:write` for rewrite) | Off by default; PR-only, reviewable |
| Secret handling | SSM SecureString out-of-band; path-scoped IAM; never in code/CFN/UI |
