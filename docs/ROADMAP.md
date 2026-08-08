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
Operator visibility + control. **Shipped** — see [spec 04](specs/04-web-ui.md), ADR-022..027, [DEPLOY-M4](DEPLOY-M4.md).
- `MgmtStack` API + `WebStack` SPA + GitHub OAuth.
- Screens: Setup, Dashboard, Repos, Repo/Workflow detail, Runs, Run detail (logs), Flavors, Settings.
- Run history (GSI2, ADR-023) + CloudWatch log viewer; live status via polling (ADR-026).
- 🎯 **Exit criterion NOT met — verification attempted 2026-08-03.** An operator installs the
  App, enables a repo, watches a run to completion, and reads its logs — all from the UI.
  Evidence: [`docs/VERIFY-M4.md`](VERIFY-M4.md) — 6 of 9 walkthrough steps pass as observed
  against the deployed `dev` console (repo enable, routing preview, live `provisioning →
  running → completed` with no reload, presence-only Settings, ADR-027 opt-out
  gate). Step 7 — **"and reads its logs"** — failed at that walkthrough: the run-detail log
  pane rendered `0 events` for every run, because `src/mgmt/logs.ts` passed the microVM id as
  `logStreamNamePrefix` while it is a stream-name *suffix*. That locator defect
  (`task-1785738322-0bb6`) is **fixed** — the stream is now resolved to its exact name before
  it is read ([ADR-048](DECISIONS.md#adr-048)) — but the 🎯 stays unmarked: it needs the pane
  **re-walked against the deployed console**, **and** the interactive GitHub half of steps 1–2
  (registered Callback URL is owner-only, authorize screen is interactive) walked by a human —
  the 🎯's "installs the App" clause.
  The M4 planes were first deployed to `dev` on 2026-07-28/29; that cutover's deploy-time
  evidence (broker posture, GSI2 index gap, `publicOrigin` deploy hazard) is
  [`docs/VERIFY-DEPLOY-ADR021-M4.md`](VERIFY-DEPLOY-ADR021-M4.md).

## M5 — Drop-in & polish
True zero-edit adoption + hardening. **Mostly implemented** — see ADR-030..033,
[RUNBOOK](RUNBOOK.md), [QUOTAS](QUOTAS.md).
- `adopt` mode (standard-label mapping, ADR-030): mode-aware claim gate, standard-label →
  flavor routing with signal upgrade, runner registers with the job's own labels.
- Opt-in auto-rewrite PR (ADR-031): line-level `runs-on` edit, dry-run label preview in the
  console, three independent gates, branch+PR only. `contents:write` stays **off by default**.
- **Flavor catalog expansion** — standard language flavors (`python`, `java`, `go`, `rust`) with a prebaked runner tool cache so `setup-*` actions short-circuit (ADR-039); flavor images request their catalog memory (ADR-038).
- **Custom flavors** — per-installation bring-your-own image, merged over the built-in catalog (ADR-040), not routable until a smoke run proves it works (ADR-041).
- Compat findings carry an actionable `fix`; adopt candidacy surfaced separately from compat
  level so it doesn't mask real problems.
- Metrics as EMF + per-env alarms + X-Ray (ADR-032); cost estimate in Run detail **and** a
  rolling per-flavor estimate on the Dashboard.
- **Reports screen** (spec 04 § Reports): spend / **billable compute minutes** / job counts /
  duration p50-p90 / failure rate /
  queue-to-start latency over a window, charted + CSV/JSON export, plus a natural-language
  report assistant. Cost left Runs per ADR-029 and lands here. Aggregates are
  authorization-first (ADR-043); phase watermarks make the cost basis honest (ADR-042); the
  assistant emits a **validated spec**, never code (ADR-045). `billableMinutes` is the
  utilisation half: the same billable window as `spend` with the rate divided out, reported as an
  **absolute** figure — a utilisation *ratio* needs the microVM concurrency quota as a
  denominator, which is Settings/quotas work and is deliberately not invented here. This is the
  windowed, groupable
  report ADR-029 deferred; the Dashboard's rolling estimate remains a deliberately separate
  fixed bounded sample of recent finished runs, not a substitute for it.
- Vanity console domain + us-east-1 ACM cert (ADR-036) — **shipped**; resolves spec 04 OQ-4.
- `dev`/`prod` config separation (ADR-033); runbook + quotas docs.
- 🎯 **Exit criterion not yet verified**: a brand-new repo running unchanged in `adopt` mode
  needs a live-repo run. It is also what closes spec 03 OQ-4 (does `generate-jitconfig`
  accept `ubuntu-latest` as a runner label? — see ADR-030's open verification item). The
  dashboard health + cost half is shipped and unit-tested.

## Phase 3 backlog (post-v1)
- Warm pool / boot-latency optimization (revisit ADR-006).
- Org-level runner groups (vs repo-level).
- VPC-attached flavors + egress filtering per repo.
- Shared caching layer (EFS/S3) for package managers + Docker layers.
- WebSocket live updates (vs polling).
- Secrets Manager + rotation (vs SSM).
- Language-runtime signal inference (route a `pytest` job to `python` with no label — needs parser support for `setup-*` steps + a multi-runtime policy, ADR-039).
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
