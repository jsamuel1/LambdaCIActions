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
- **Flavor publication + reconciliation** (ADR-049) — `npm run build:images -- --flavor <name>`
  builds/rebuilds one flavor and publishes it **image-first, label-second** (refusing a label
  whose image is absent); `npm run flavors:reconcile` reports catalog vs live allowlist vs
  `image-arn-*` vs real image state and exits non-zero on drift. Closes the hole that left four
  of seven catalog flavors advertised-but-unrunnable in dev, whose only symptom was jobs queued
  for hours with no error anywhere. Builds stay workstation-only; CD reports, never remediates.
  **No flavor image is built by this change** — `python`/`java`/`go`/`rust` all still report
  `blocked`; `npm run build:images -- --flavor python` is the intended first use and unblocks the
  `lambda-ci-python` workflows that motivated it.
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

## M6 — Our own workflow engine + review integration
**Design only so far.** Specs and ADRs are written; **no implementation exists**. See
[spec 06](specs/06-workflow-engine.md), [spec 07](specs/07-review-integration.md), and
[ADR-054](DECISIONS.md#adr-054)..[ADR-060](DECISIONS.md#adr-060). This milestone reverses the
founding "don't host them" posture ([ADR-004](DECISIONS.md#adr-004), amended) for repos that opt in.

**Why, corrected.** The filing assumed GitHub Free meters our runners. **It does not** — "GitHub
Actions usage is free for self-hosted runners"
([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). What Free
actually withholds on **private** repos is *governance*: required reviewers, protected branches and
code owners are Pro/Team features, and environments are public-repo-only. So the two real drivers
are **PR governance** and **portability to non-GitHub hosts** — a host with no GitHub Actions emits
no `workflow_job` webhook, so there is nothing to route and owning the scheduler is the only way in.
Cost is not a driver; spec 06 has the citation table.

Phases are separately shippable and deliberately ordered so the riskiest unknown is proved early.
Each becomes its own card — **proposed here, not filed from the design card.**

1. **Engine core, offline.** parse → classify every construct into spec 06's four matrix classes →
   plan (DAG + matrix + `if:`, trust class) → deterministic job list. No AWS, no GitHub,
   unit-tested against fixture workflows.
   🎯 A fixture suite of real workflows produces byte-identical plans across runs; every construct
   in the Refused and Out-of-scope classes, and every unknown key, **refuses the whole run** with a
   code + reason; the `actions/cache` fail-open evidence for each admitted SHA is a recorded
   fixture; fork and Dependabot fixtures plan with an empty secret set; any `concurrency` key, an
   undecidable `fail-fast`/`max-parallel` expression, an empty matrix and two jobs rendering one
   check name each refuse with their code; the set of keys spec 06's tables classify equals the
   key list of GitHub's workflow-syntax reference, and the recursive census's heading and value
   sets equal the reference's at its pinned date (a scheduled drift job fails otherwise); an
   unknown key inserted at every schema-object position of every fixture (root, triggers, job,
   `strategy`, `container`, each service, each step, `defaults.run`, `permissions`, each input)
   and an out-of-set value at every enum position each refuse with
   `engine-unsupported-construct` naming the path, while an extra key under a user-named map
   (`env`, a matrix dimension) still plans; omitted `permissions`, `read-all`, `packages: read`
   and `container.options` refuse; the largest admissible shape of every item type (256 jobs with
   255-byte ids, 50 re-run sequences, 64 trigger members with 512-byte paths) marshals under
   350 KB per item and 1,024 bytes per key, and a 257-job plan refuses `engine-plan-too-large`;
   path-filter conformance fixtures, each also run on GitHub-hosted Actions to record GitHub's
   answer (spec 06 OQ-12), cover a push to an existing branch, a forced push, a new branch with
   and without commits, a tag push with `paths`, 1,001 commits (always runs), an injected diff
   timeout and a 404 on `before` (both run), 3,001 changed files with the only match sorting
   last (does not run), a PR whose base advanced after branching (three-dot excludes the base's
   change), a rename across a `paths` boundary, and a branch deletion (refused); `runs-on` fixtures resolve `ubuntu-latest`,
   `[self-hosted, lambda-ci-java]`, `labels: [lambda-ci]` and a static-matrix `${{ matrix.os }}`
   to their flavors and refuse `windows-latest` on any leg, `x64`, a foreign label, a `group:`,
   an expression over `needs`, an empty result, a non-valid custom flavor and a toolchain-dropping
   `services:` upgrade, each with `engine-runner-unsupported`; `if: github.event.action ==
   'reopened'` evaluates over the stored payload, and `github.run_number`, `github.ref_protected`
   and any `vars.*` refuse.
2. **Dispatch + agent protocol.** First task: the run-store key refactor (`RunKey` / `runRowKey()`,
   every writer and reader, Reaper by stored `pk`, broker ref grammar, queue message) and the
   management λ's `UpdateItem` narrowed to `INSTALL#*` plus exactly `CONFIG#AUDIT` (its audit
   trail). Then one job runs on a microVM driven by
   **us** — no `generate-jitconfig` — logs land, the attempt row transitions.
   🎯 A single-job workflow completes end to end under `engine` mode, with the VM holding no ambient
   AWS authority ([ADR-021](DECISIONS.md#adr-021) invariants re-asserted by test); a test proves no
   caller builds a run key outside `runRowKey()`; the Reaper closes a ghost engine attempt on its own
   row; every existing management write (repo patch, index repair, flavor validation, audit
   append) succeeds against the narrowed policy and writes to `PLAN#`, `ERUN#`, `PR#`, `TRIGGER#`,
   `DISPATCH#`, `CHECKNAME#`, `REFUSAL#`, `RUN#` and the other `CONFIG#` rows are denied; a job past
   `timeout-minutes` whose agent stays silent is closed `timed_out` by the Reaper with its VM
   terminated; a job emitting outputs of 1 MiB + 2 bytes by GitHub's UTF-16 accounting fails
   `engine-outputs-too-large` and one of exactly 1 MiB succeeds; a dependent of jobs whose
   outputs total 49 MiB reads all of them byte-identical through `needs-outputs` pages, with no
   broker request or response over 400 KB; a run whose outputs would cross 50 MiB fails only the
   crossing job, whose terminal transition, slot release and report still commit, both when the
   jobs run concurrently and when 51 jobs of 1 MiB each run one after another (the 51st fails);
   barrier-controlled interleavings of the status writer (outputs B) against the Reaper, and
   against the canceller, each closing the same attempt, run with each writer's read, build and
   commit paused at every combination of points, and every crash point injected, always end
   with exactly one terminal transaction committed, `OUTBYTES` equal to the sum of the run's
   `OUTRES#` rows, and the job's row naming its latest terminal attempt, whose `outputPages`
   is non-zero exactly when the row holds B; the first job of a fresh plan to keep outputs
   succeeds against the counter the plan commit created at 0 (the case an uncreated counter
   would misread as the cap), and an output-producing re-run moves the row from attempt 1's
   B₁ to attempt 2's B₂ and the counter by `B₂ − B₁`, with attempt 1's pages left stored and
   never read; the losing writer's transaction is cancelled on the attempt row and changes neither
   item; a status writer that crosses the cap while the Reaper also closes the attempt ends
   with one terminal row and the counter unchanged by the loser; with the status writer paused
   between its page read and its terminal commit, an overwrite of a named page (same size, and
   10 KB → 250 KB) is refused `engine-output-page-conflict`, a create of an unnamed page is
   never named, read or charged, and a page write released after the terminal commit is refused,
   so every named page's stored hash and size equal what the terminal row committed (spec 06
   § Deadlines and outputs); 256 jobs with 255-byte ids each settling
   outputs, concurrently and across 50 re-run sequences, never fail with `ValidationException`
   and keep `OUTBYTES` equal to the sum of the rows; in each unprivileged flavor a step that reads
   `/proc/<agent>/environ`, `mem` and `cmdline`, lists `/proc`, `ptrace`s the agent and searches
   its environment, readable files and inherited descriptors finds no token, and a broker call
   with any value it found is rejected; a `job-status` sent before the last step and a
   `step-status` after `job-status` are both rejected; in the `docker` flavor a root step that
   does obtain the token can affect only its own attempt's row, logs and outputs (spec 06 § In-VM
   trust boundary); deliveries just under and just over the measured Lambda ceiling, and one of
   9 MB, against the deployed webhook route, each end in exactly one `engine-event-too-large`
   report (the latter two through the delivery reconciler), a reconciler run racing a GitHub
   redelivery of the same guid writes one batch, and a failed sub-900 KB delivery is planned
   normally by the reconciler; a re-run of a 1 MiB job that now emits 512 KiB frees
   512 KiB, while a re-run growing from 1 MiB to 1.5 MiB at 49.6 MiB of run total fails, and its
   one terminal transaction sets the row to attempt 2 with 0 bytes and lowers the counter by the
   1 MiB attempt 1 held; an output set from
   `${{ secrets.TOKEN }}`, one set from a value registered with `::add-mask::`, and one
   containing the checkout token are each skipped with GitHub's warning, appear in no broker
   request, `OUTPUT#` item or log event, and read as `''` in a dependent; a secret, an
   `::add-mask::` value and the checkout token sent through every broker action appear in no
   table item or log event; a 950 KB event payload refuses the delivery with one report; a matrix's
   legs' outputs combine in completion order, and an empty leg output overrides nothing;
   step/log reporting is measured against the broker's reserved-concurrency cap (spec 06 OQ-5).
3. **Report back to GitHub.** Check runs + commit statuses + deep links; our engine visible in the PR.
   Includes the **run-level console view** the review body needs — a two-segment `#/runs/{repoId}/{runId}`
   currently falls through to the Runs list, so the whole-run deep link does not resolve today
   (spec 07 OQ-5).
   🎯 A PR shows our check run with annotations from a failing step and a working "Re-run job" button
   that creates attempt 2 with its own check run while attempt 1's row, logs and link are unchanged;
   a double click creates one attempt; a crash injected after the re-run reservation, and another
   between two jobs of a multi-job dependent fan-out, each leave no `latestAttempt` naming a missing
   row and are completed by redelivery or the Reaper; a dependent attempt that is `waiting` on an
   unfinished need is **never** dispatched by the Reaper, even past its threshold; a crash injected
   between re-run completion and the release pass, and another between a job's terminal transition
   and its dependents' release, are each finished by the Reaper from the durable release obligation; a
   plan write interrupted mid-`PlannedJob` releases nothing until resumed, and the Reaper finishes
   it **from the stored plan input alone**, with the original webhook (and,
   for a console `workflow_dispatch`, its inputs) unavailable; a planner crash injected just
   before the plan commit, followed by a move of an `@v4` action tag, leaves no chunk behind and
   the retried plan commits with one consistent resolution, while a retry **after** the commit
   adopts the stored resolution even though the tag has moved; a plan's `RELEASE` obligation and
   its `PLANS#<repoKey>` discovery entry are both queryable at once, and a test asserts no item
   type is written with two GSI1 entries; a console dispatch whose response is dropped and then
   retried with the same key, and two concurrent submissions of one key, each create exactly one
   batch and one plan per workflow, while the same key with different inputs is refused
   `dispatch-key-reused`; a delivery matching two workflows with a crash injected between the
   two plan commits yields no PR verdict until the Reaper plans the second and seals the batch; a
   PR event with no `.lca/workflows` files, and one whose workflows' path filters all miss, each
   create no intent and no review, and an all-skipped plan is quiet; a matrix
   with `max-parallel: 2` never has more than two attempts released at once, including with two
   release passes racing and with a crash between a terminal transition and the next pass; with
   `fail-fast` a failing job cancels its queued siblings and brings its running ones to
   `cancelled` within 10 s of their next broker call, a silent one is terminated by the Reaper
   after 5 minutes, a crash right after the trip is finished from `CANCELS#pending`, two legs
   failing concurrently in one re-run sequence (and one after a stale read of the group) both
   commit their terminal transitions, free their slots and owe their reports while the group is
   cancelled once, an injected `TransactionConflict` on the group is retried to the same result, a
   tolerated (`continue-on-error`) failure trips nothing, and a re-run starts untripped; a
   workflow whose only failure is a tolerated job leaves its plan `completed`, its check run
   `failure` and its PR verdict not `failure`, and one with only tolerated failures is quiet; job-level `continue-on-error` on a needed job refuses the run; a plan refused at plan
   time with a crash injected after the refusal is recorded and before its check-run POST is
   reported by the Reaper, a crash after the POST and before its record is adopted by
   `external_id` with no second check run, and without `checks:write` it posts an `error` commit
   status; a delivery matching 65 workflows writes one trigger refusal record and its `REPORT`,
   and a crash before its POST is re-driven by the Reaper while a crash after it is adopted by
   `external_id` `e1t:` with no second check run; for every obligation partition, one obligation that was due an hour ago, inserted
   behind thousands not yet due, is on the Reaper's first page; a re-run renames attempt 1's check
   run out of the job's name before attempt 2's is created, and on a protected branch requiring
   that name, attempt 1 green then attempt 2 failing blocks the merge, attempt 1 failing then
   attempt 2 green allows it, a refused rename leaves attempt 1 `cancelled`, and an injected
   duplicate is never `neutral` under the job's name; one commit pushed to two branches, green on
   one and failing on the other, produces two check names and neither retires the other; two PRs
   into one base whose head is the same commit, with opposite outcomes, leave the name contested
   and red under a required check, never green; an `opened` and a `reopened` delivery for one PR
   at one head, with `if: github.event.action == 'reopened'` giving opposite outcomes, leave the
   name contested and red, never letting the newer one retire the older; a re-run and a
   redelivery of one delivery each take the name over cleanly; a console dispatch's check can satisfy no
   required check; the commit-status fallback obeys the same ownership; a
   missing `checks:write` grant degrades to a commit
   status without failing the job; every posted deep link resolves to the attempt it names.
4. **Review integration.** PR comments, append-only reviews (submit, supersede, dismiss our own
   stale `REQUEST_CHANGES`), fork-run approval, and our own approval gate.
   🎯 A crash between review submit and record never yields a duplicate review; a failure review
   followed by a green re-run on the **same** head sha creates a second intent row (the first row
   and its `reviewId` unchanged), posts a "now passing" review and supersedes or dismisses the
   failure review, and a duplicate delivery of either verdict creates nothing; a new head sha
   supersedes our old review and dismisses an old `REQUEST_CHANGES`, including when the new sha is
   green and posts no review; when verdict B overtakes a still-unposted verdict A, A is never
   posted, and when B lands after A's claim, A is noted or dismissed within one reporter loop; a
   reporter A stalled past its claim, then B taking over, then A resuming, yields one review (A's
   record and any new effect are refused by the holder/fence condition, and B observes before it
   posts); the same stall-takeover-resume sequence on an execution check-run create yields one
   check run; a quiet green re-run superseding our failure `COMMENT` notes it with a link to the
   green attempt, never to a review; a
   crash injected right after `submittedIntentId` moves still dismisses the displaced
   `REQUEST_CHANGES`; `reviewRequestChanges` cannot be enabled where our App cannot dismiss, and
   degrades to `COMMENT` if that changes later; no code path, setting or provider produces an
   `APPROVE` (a type-level test: the review event type admits only `COMMENT` and
   `REQUEST_CHANGES`); adversarial same-repository PR fixtures, each `trusted`, each green, and
   each with every workflow file unchanged, produce no `APPROVE` and a console label of "the PR's
   own code reported success": one that weakens a test the workflow runs, one that edits a
   `package.json` script the workflow calls, and one in the `docker` flavor whose root step takes
   the agent's token and reports its attempt green before the real tests run (spec 07 § Why we
   never post `APPROVE`); a fork PR under `forkPolicy: approve` runs only after
   approval and still with no secrets; a
   PR closed and reopened 100 times at one head keeps one bounded `REVIEWHEAD` item and a
   verdict that reads every `HEADTRIG#` row; `check_run.rerequested` re-runs exactly like the
   button, and `check_suite` deliveries are acknowledged and change nothing; a step summary
   over 65,535 characters is posted truncated with a console link, never rejected; an `environment:`-gated job is held **before dispatch** (no
   VM booted) with its own `LCA: approve · …` check run in `action_required` and **no**
   execution check run; a crash injected between the hold and the approval check-run POST is
   delivered by the Reaper from `GATES#open` even behind many later-expiring pending gates; a gate
   left undecided past 30 days is expired by
   the Reaper, its job `cancelled` and dependents released; an approval racing the expiry, and a
   double approval, each decide the gate once; an approved matrix job still waits for a
   `max-parallel` slot, and a held one whose matrix trips fail-fast is cancelled with its gate
   settled; on approval it dispatches and its execution check run goes
   `queued → in_progress →` its real conclusion; on rejection it never runs, the execution check
   run is `cancelled` and a required check on that job name stays unsatisfied — with
   the console stating plainly that on a Free private repo the approval is advisory
   ([ADR-057](DECISIONS.md#adr-057)).
5. **Second provider (Gitea/Forgejo).** Proves the port is a port.
   🎯 A Gitea repo runs a workflow on our microVMs and gets its result back, with **no** GitHub-only
   assumption in the shared path.
6. **Action ecosystem hardening.** Cache + artifact servers, composite/docker actions, our own OIDC
   issuer (`trusted` runs only). Secret custody itself lands with phase 2, because the first
   `trusted` job with a secret needs it: write broker, tag-scoped resolver, audit, and the 4096-byte
   value limit, tested at 4096 bytes (accepted and resolved byte-identical) and 4097 bytes (refused
   at intake with `secret-too-large`, nothing written to SSM), and the write protocol's
   interleaving test (spec 06 § Writes): a write, a rotation and a delete of one name with a crash
   or timeout injected at every boundary, and an SSM call held past settlement then allowed to
   land, always end with the name in `SECRETNAMES` exactly when its row has a `current` or a live
   operation, an audit row for every operation begun, and every unnamed parameter removed and
   counted by the next orphan sweep; and the quota-boundary tests (spec 06 § Writes): concurrent
   rotations at 199 installation slots admit exactly one, two installations racing for the last
   environment slot admit exactly one, a rotation loop with delayed and failing garbage
   collection never exceeds 200 installation slots or the environment budget, and a
   `PutParameter` that got no answer is quarantined for good: when it lands, however late, the
   sweep deletes the parameter and the slot stays charged; and the account-allocation tests (spec 06
   § Storage): two environment tables sharing one account registry, deployed concurrently with
   budgets that together cross its 9,500 cap, commit exactly one allocation and fail the other
   deployment `account-quota-exhausted`; concurrent writes into two environments at the last
   slots of their granted budgets never take the account total past the cap; an environment
   with no granted allocation refuses every write; an allocation of 8,000 + 50 admits exactly
   8,000 tenant slots; lowering a budget below the live count is refused; and a deleted
   environment's allocation stays held until the generation-fenced release procedure has
   fenced admission, drained every installation named by its `SECRETOWNERS` owner index down
   to its quarantined slots and found the path empty, then moved those slots to a `QUARANT#`
   row that stays charged until a redeploy absorbs it into its new allocation, so repeated
   release/redeploy cycles (including lost release and allocation responses, retried) leave
   `TOTAL` charging each distinct quarantined slot once, with a broker begin held
   across each of those boundaries refused, and a stale procedure retried after a redeploy
   changing nothing; the release keeps `LCA-Data-<env>` (termination-protected) so the redeploy
   is an epoch-bumped update of the stack that still owns the table, and a destroy/recreate test
   on real CloudFormation shows an ordinary deploy over the orphaned fixed-name `lca-<env>`
   table failing `ResourceAlreadyExistsException` with the registry untouched, then the
   two-deploy resource import bringing the retained `COUNT` and quarantine items to the
   allocation custom resource, which absorbs them; 1,000 writes quarantined in one environment and then landing after its
   release, while a second environment fills the returned capacity, never take the account's
   measured parameter count past `TOTAL` or `cap`; and a begun write with no parameter yet, and
   an installation with no `INSTALLS` index entry, are both found and drained through
   `SECRETOWNERS`.
   🎯 `actions/cache` hits against our server on a real job, and a cache written by a pull request
   run is missed by a later default-branch `push` run (spec 06 § Server APIs); artifact-action compatibility is
   **measured and documented** rather than assumed (spec 06 OQ-2); a per-repo `stepSudo: false`
   mode is designed or explicitly declined (spec 06 OQ-14), with `container.credentials` and
   `services.<id>.credentials` designed alongside private action images.

**Exit criteria for the milestone as a whole**
- 🎯 A repo in `engine` mode runs a multi-job workflow with `needs:` + a matrix, entirely scheduled by
  us, and reports every job into the PR with working deep links.
- 🎯 No workflow file runs on both schedulers, proven by test: the planner reads only
  `.lca/workflows/**`, refuses a run whose basename also exists under `.github/workflows/`, and plans
  nothing when `engineEnabled` is absent or false; the claim-gate and planner refusals hold as
  defence in depth.
- 🎯 Every construct in spec 06's Refused and Out-of-scope classes, and every unknown key, refuses the
  **whole run** at plan time with an actionable reason; the only admitted degradation is the
  evidence-listed `actions/cache` miss, stated on the check run. **A dispatched run containing a
  construct we cannot faithfully run is the failure this milestone is judged on.**
- 🎯 No fork or restricted-bot run receives a secret, `vars` or an OIDC token, proven by test; the
  resolver's assumed session cannot read another installation's parameter, proven against IAM.
- 🎯 `LambdaCIActions` itself is still deployed by CD on the `workflow_job` path — M6 must not break
  [ADR-047](DECISIONS.md#adr-047)'s OIDC trust ([ADR-059](DECISIONS.md#adr-059)).

**Risks**
- ⚠️ **Scope.** The largest single change proposed in this project. Mitigation is the
  supported/unsupported/out-of-scope table in spec 06 — if it is not explicit, implementation never
  converges.
- ⚠️ **Compatibility cliff.** A partial engine that claims a job it cannot run faithfully is worse
  than not claiming it. Refusal is a first-class outcome, decided at plan time before any VM boots.
- ⚠️ **Undocumented protocol** — the top feasibility risk, and the reason we do **not** emulate
  GitHub's Actions service: it is unpublished and `actions/runner` states it is "not taking
  contributions". Gitea's five-RPC published proto is what makes the milestone viable at all
  ([ADR-055](DECISIONS.md#adr-055)). Had no option been viable, this design would have ended in a
  documented "no".
- ⚠️ **Secret custody** turns us into a secrets holder — a new class of security obligation
  ([ADR-057](DECISIONS.md#adr-057)). The resolver is the one principal that can decrypt; a full
  compromise of its code is the residual.
- ⚠️ **Adoption is a file move.** `engine` mode reads `.lca/workflows/`, so a repo moves its files to
  adopt it. That is the price of never running a workflow twice.
- ⚠️ **OIDC discontinuity.** Our own issuer is not a drop-in for GitHub's; customers must extend trust
  policies deliberately ([ADR-059](DECISIONS.md#adr-059)).
- ⚠️ **Permission growth.** Three new write grants (`checks`, `pull_requests`, `statuses`). Opt-in,
  gated like [ADR-031](DECISIONS.md#adr-031), and `contents:write` stays off — but an existing
  installation must re-approve, so the degradation path is mandatory, not theoretical.
- ⚠️ **The job can lie about itself.** Inside the VM the agent's token is held by a separate uid,
  but in the `docker` flavor a root step can still take it and forge its own attempt's result
  (spec 06 § In-VM trust boundary). That is GitHub's trust model too; the mitigation is that no
  CI result authorises anything: we never post `APPROVE` (spec 07 § Why we never post
  `APPROVE`), and a required check from our App enforces only what the PR's own code reported.
- ⚠️ **Front-door size limits.** A webhook between the Lambda ceiling and GitHub's 25 MB is seen
  only through GitHub's delivery log, so the delivery reconciler's 3-day window is a hard
  dependency; its staleness alarm is part of phase 2's operational readiness.

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
| M6 would make us hold **tenant** CI secrets | Write broker (console keeps no `PutParameter`); tag-scoped resolver is the only decryptor; no secrets for fork/bot triggers ([ADR-057](DECISIONS.md#adr-057)) — design only |
