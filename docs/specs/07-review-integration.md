# Spec 07 — Review Integration (the PR surface)

Status: **Proposed (design only — no implementation)** · Plane: Control (reporting) + Management (detail)

Our only write into a customer repo today is the opt-in `runs-on` auto-rewrite PR
([ADR-031](../DECISIONS.md#adr-031)). We post **no** check runs, **no** commit statuses, **no** PR
comments and **no** reviews — spec 01 **OQ-2** declined `checks:write` on the grounds that "GitHub
already renders job status", which was correct while GitHub was the scheduler. Under
[06](06-workflow-engine.md) it stops being correct: **a run GitHub did not schedule is a run GitHub
cannot render.** This spec designs that surface, and the approval gate that answers the governance
gap Free actually has.

> **Nothing here is implemented, and no App permission change is deployed by this card.**

## Contents
- [What this buys, precisely](#what-this-buys-precisely)
- [Surfaces we post](#surfaces-we-post)
- [Check run payload](#check-run-payload)
- [Re-run via `requested_actions`](#re-run-via-requested_actions)
- [Review payload](#review-payload)
- [Effect obligations and claims](#effect-obligations-and-claims)
- [Review lifecycle](#review-lifecycle)
- [The approval gate (Q5)](#the-approval-gate-q5)
- [Deep-link contract](#deep-link-contract)
- [Permissions & events](#permissions--events)
- [Opt-in gates](#opt-in-gates)
- [Provider-agnostic reporting port](#provider-agnostic-reporting-port)
- [Failure handling](#failure-handling)
- [Open questions](#open-questions)

---

## What this buys, precisely

[06 § Why](06-workflow-engine.md#why-what-github-free-actually-withholds) establishes with citations
that Free withholds **governance on private repos**, not minutes. This spec is the half that closes
that gap, so it is worth being exact about which part we can genuinely fix:

| Gap on Free + private | Can we substitute it? |
|---|---|
| **Required status checks** before merge | ⚠️ **Reportable, not enforceable by us.** We can post the check; only branch protection can *require* it — and that is the withheld feature. GitHub does contemplate an App as the required source: "in some cases you may only want to accept a status check from a specific GitHub App" ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)) — but the customer needs a paid plan to configure it. |
| **Required approving reviews** | ❌ **Not in v1.** We post `COMMENT` and, opted in, `REQUEST_CHANGES`, never `APPROVE`: every CI result on a PR is produced by code the PR's author controls, so it cannot stand in for a reviewer ([Why we never post `APPROVE`](#why-we-never-post-approve)). Whether an App review would even satisfy a required-review rule is **NOT STATED** in the docs (OQ-1). |
| **Visibility of CI result in the PR** | ✅ **Yes, fully.** Check runs with annotations are available to any GitHub App on any plan; nothing in the Checks docs gates them by plan. |
| **An enforced merge gate with no paid plan** | ⚠️ Only if we hold `contents:write` and merge ourselves — which we decline by default (see [Q5](#the-approval-gate-q5)). |

**The honest headline, stated up front rather than buried:** we can make our CI result *first-class
and legible* in the PR on any plan, and we can *advise* on merge. We cannot *enforce* a merge gate
on a Free private repo without becoming the merger, and we choose not to be by default.

## Surfaces we post

| Surface | API | Purpose | Why |
|---|---|---|---|
| **Check run** (primary) | `POST/PATCH /repos/{o}/{r}/check-runs` | one **execution** check run per engine job attempt (live status, annotations, re-run button, deep link), plus a separate **approval** check run for a job held at our gate | The only surface with **inline annotations**, a `details_url` and actionable buttons |
| **Commit status** (fallback) | `POST /repos/{o}/{r}/statuses/{sha}` | one status per job, `context` = the job's check name ([names](#check-run-names-one-authority-per-name)) | For providers with no checks equivalent, and installations that have not granted `checks:write` |
| **Review comment** | `POST /repos/{o}/{r}/pulls/{n}/comments` | line-level findings that outlive a check run | Check-run annotations are scoped to the check; a review comment is a conversation |
| **Review** | `POST /repos/{o}/{r}/pulls/{n}/reviews` | `COMMENT`, or `REQUEST_CHANGES` when opted in; append-only ([lifecycle](#review-lifecycle)). Never `APPROVE` in v1 ([why](#why-we-never-post-approve)) | A failure verdict that outlives the check run, as a conversation on the PR |

**Check runs are Apps-only, which is a fact in our favour** — nobody can spoof our check with a
PAT: "Write permission for the REST API to interact with checks is only available to GitHub Apps.
OAuth apps and authenticated users can view check runs and check suites, but they are not able to
create them." ([checks](https://docs.github.com/en/rest/checks/runs))

## Check run payload

One **execution** check run **per engine job attempt**, not per run: annotations are file+line
scoped and an attempt is the unit that owns a log and a conclusion. A re-run creates a new check
run ([below](#re-run-via-requested_actions)). An execution check run is owed from the moment its
attempt is **released** ([06 § Release](06-workflow-engine.md#release)): the release transaction
creates the attempt's report obligation ([Effect obligations](#effect-obligations-and-claims)), so
the check run never shows work that has not been allowed to run, and is never lost when a reporter
crashes. A job that release ends without running (skipped by `if:` or a failed `need`, cancelled
by a gate) gets its execution check run created already `completed` with that conclusion. A job
held at the approval gate gets a separate, differently named approval check run
([The approval gate](#the-approval-gate-q5)).

```jsonc
// POST /repos/{owner}/{repo}/check-runs
{
  "name": "LCA / ci / build (node 20) [pull_request → main]",
                                            // "LCA / <workflowKey> / <jobName> [<context>]" — see
                                            // Check-run names: unique per sha by construction,
                                            // and the one name a required check can target
  "head_sha": "ce58745…",
  "status": "in_progress",                  // queued → in_progress → completed
  "started_at": "2026-08-21T09:14:52Z",
  "external_id": "e1:gh-42:k3v9q2m7x4p8t6w2r5n1:b7c2d9f4h6j8l3m5n0p2:1",
                                            // "e1:<repoKey>:<runId>:<jobId>:<attempt>" — the
                                            // engine's attempt key, so an inbound check_run
                                            // webhook maps to one attempt row with no lookup
  "details_url": "https://<console>/#/eruns/gh-42/k3v9q2m7x4p8t6w2r5n1/b7c2d9f4h6j8l3m5n0p2/1",
  "output": {
    "title": "Running on lca-dev-node (arm64 microVM)",
    "summary": "Step 3/7 — `npm ci`",
    "text": "…markdown; step table + timings…"
  }
}
```

On completion, `PATCH` the same check run:

```jsonc
{
  "status": "completed",
  "conclusion": "failure",                  // success | failure | neutral | cancelled
                                            // | skipped | timed_out | action_required
                                            // (degraded jobs keep their real conclusion; the
                                            // degradation is stated in output.summary)
  "completed_at": "2026-08-21T09:21:03Z",
  "output": {
    "title": "1 failing step",
    "summary": "`npm test` exited 1 after 4m12s",
    "annotations": [
      { "path": "src/auth.ts", "start_line": 88, "end_line": 88,
        "annotation_level": "failure",
        "message": "TypeError: cannot read property 'exp' of undefined",
        "title": "npm test" }
    ]
  },
  "actions": [
    { "label": "Re-run job", "identifier": "lca_rerun_job",
      "description": "Re-run this job on a fresh microVM" }
  ]
}
```

Documented limits the implementation must respect, all from
[checks](https://docs.github.com/en/rest/checks/runs):

- **≤50 annotations per API request** ("The Checks API limits the number of annotations to a
  maximum of 50 per API request. To create more than 50 annotations, you have to make multiple
  requests"), appended across requests.
- **≤3 `actions`**, with `label` ≤20 chars, `description` ≤40, `identifier` ≤20.
- `output.summary` and `output.text` accept Markdown, "Maximum length: 65535 characters" each;
  annotation `message` ≤64 KB. A job's `$GITHUB_STEP_SUMMARY` has no such bound on our side, so
  the reporter writes the first 60,000 characters of the summary, cut on a line boundary, plus a
  line linking the full summary on the console; it never sends a field over the limit and lets
  the request fail. Annotations past the first 50 per request are appended in further requests,
  and past 1,000 per attempt are counted, not posted, with the count in the summary. Review
  bodies follow the same rule against `body`.
- **`status: waiting|pending|requested` is refused to us** — "Only GitHub Actions can set a status
  of waiting, pending, or requested." Providing a conclusion "will automatically set the status
  parameter to completed", and the docs describe no way back from `completed`. So the design never
  needs one: an engine job blocked on our approval gate has **no execution check run yet**, and
  the human-must-act signal is a separate approval check run, created `completed` +
  `conclusion: action_required` and never reopened ([The approval gate](#the-approval-gate-q5)).
- **Which conclusions let a PR merge.** "Required status checks must have a `successful`,
  `skipped`, or `neutral` status"
  ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
  So `neutral` and `skipped` are only ever posted under a name no required check can mean as "this
  job ran and passed": refusals and approval notices use the system namespace (`LCA: …`, below),
  never a job's `LCA / …` name, and a job that was prevented from running by a person (gate
  rejected or expired) or by fail-fast is `cancelled`, not `skipped`. A job skipped by its own
  `if:` or by a failed `need` is `skipped`, as on GitHub.

### Check-run names: one authority per name

A required check is configured by **name**, and GitHub does not define which check run it reads
when several on one sha share that name. Its own docs warn: "make sure that job names are unique
across all workflows. Using the same job name in multiple workflows can cause ambiguous status
check results and block pull requests from being merged"
([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
The previous draft relied on "GitHub shows the newest" for re-runs and concluded a duplicate
`neutral` under the job's name; `neutral` satisfies a required check, so a duplicate could have
masked a real failure. The design now makes the selection question never arise: **on any sha, at
most one check run carrying a given job name can hold a satisfying conclusion, and it is the
current attempt's.**

1. **A name says which trigger context it judges.** A job's check name is
   `LCA / <workflowKey> / <jobName> [<context>]`: `workflowKey` is the file's path under
   `.lca/workflows/` without its extension, `jobName` is the job's rendered name with matrix
   values as on GitHub, and `context` is what GitHub itself can tell apart on one sha:

   | Event | `context` | Can a required check target it? |
   |---|---|---|
   | `push` to branch `b` | `push b` (`push tag t` for a tag) | yes: stable per branch |
   | `pull_request` into base branch `b` | `pull_request → b` | yes: stable per base branch, which is what branch protection on `b` evaluates |
   | console `workflow_dispatch` | `dispatch <first 8 of dispatchId>` | **no, by design**: the name is new for every dispatch, so an operator-started run, whose inputs nobody reviewed, can never satisfy a required check |

   The first draft's name carried only the event, so a push of one commit to branch A and to
   branch B shared a name, and the newer run, whose `github.ref` and filters differ, could
   retire the older one's result. Now those are two names. Two jobs of one plan that render to
   the same name are Refused at plan time (`engine-duplicate-check-name`).
2. **System checks have their own namespace.** Every check that is not a job's result is named
   `LCA: <kind> · …` (`LCA: refused · <workflowKey> · <context>`,
   `LCA: refused · delivery · <context>`, `LCA: fork approval · <workflowKey> · <context>`,
   `LCA: approve · <workflowKey> / <jobName> · <context>`). No job name can produce a string
   starting `LCA: `, because every job name starts `LCA / `, so a job named `refused` cannot
   collide with a refusal notice.
3. **One owner per name per sha, and only an equivalent run may replace it.**
   `CHECKNAME#<repoKey>#<sha>#<hash(name)>` / `OWNER` records the attempt that owns the name, its
   check-run id once created, a state `owned | contested`, and the owner's **claim key**:
   `(workflowPath, jobKey, matrixIndex, event, ref, base ref, PR number, dispatchId, trust class,
   eventHash, jobDefHash)`. `eventHash` is the SHA-256 of the delivered payload the plan stored,
   and `jobDefHash` of the leg's compiled job definition (steps, env, resolved action SHAs,
   flavor) ([06 § The `github` context](06-workflow-engine.md#the-github-context-and-the-event-projection)).
   Together they cover every fact a job can read from its trigger, because the engine persists
   the whole payload and refuses every `github` property it cannot derive from it, so two keys
   are equal only when the runs could not have observed different inputs. The previous key
   listed only the coarse fields, so an `opened` and a `reopened` delivery at the same head had
   equal keys while `if: github.event.action == 'reopened'` ran different jobs. A
   claim is taken in the release transaction that creates the attempt's `REPORT` obligation:
   - **no owner:** `Put` with `attribute_not_exists`, state `owned`;
   - **same claim key** (a re-run, or a redelivery of the same delivery; both reuse the stored
     payload and plan): the pointer moves to the new attempt, on condition the stored claim key is equal
     and the state is `owned`, recording the previous owner as `retire` on the new `REPORT`.
     Newest claimant wins only among runs that judged the same thing;
   - **different claim key** (two open PRs whose head is the same commit and whose base is the
     same branch; two deliveries for one PR and head that differ in action or payload, such as
     `opened` then `reopened`; one commit pushed twice to a branch, whose `push` payloads differ
     in `before`; two workflow files whose names render the same string): the name becomes
     **`contested`**, permanently for that sha. The `Update` sets `state = contested` on condition
     the stored claim key differs, records both attempts as `retire`, and the new attempt's
     `REPORT` carries `contested = true`.
   A contested name fails closed: the reporter renames every contestant's run out of the name
   (step 4) and then creates, under the name itself, one check run of ours, `completed` +
   `failure`, titled "Two different LCA runs claim this check on `<sha>`" and naming both, with
   `external_id` `e1c:<repoKey>:<sha>:<hash(name)>` so a takeover adopts it. Every later
   contestant is renamed out on arrival, and no reporter ever concludes a run under a contested
   name. A required check on that name therefore stays red until the head moves to a new commit,
   which is the remedy the console states. The cost is stated rather than hidden: reopening a
   pull request at an unchanged head (an `opened` and a `reopened` delivery whose payloads
   differ), or pushing one commit to a branch twice, contests that sha's names, so a required
   check on them stays red until a new commit. The alternative, letting the newer delivery take
   the name, is the substitution this rule exists to forbid. Branch protection never sees two of our runs under
   one name with different meanings, and never sees one run's green stand in for another's.
4. **Retire before create.** The new owner's reporter, under its claim, first **renames** the
   retired check run to `LCA: retired · <old name> · attempt <n>` (`name` is an updatable body
   parameter of `PATCH …/check-runs/{id}`, [checks](https://docs.github.com/en/rest/checks/runs)),
   records that, and only then creates its own run under the name. In between, the name has no
   check run, so a required check on it is pending and **blocks**: the window fails closed. The
   retired run keeps its conclusion and links, so the history stays readable. Only the retire step
   ever sends `name`; every other update of a check run omits it, so a retired run that is still
   in progress cannot rename itself back when it finishes.
5. **If a rename is refused**, the reporter instead sets the retired run's conclusion to
   `cancelled` with the title "Superseded by attempt `<n+1>`" (a conclusion change on a completed
   run, the same documented operation the approval gate relies on). Two runs then share the name,
   but only the current one can satisfy it: whichever GitHub selects, a stale success can no
   longer authorise a merge. A retired attempt that is still running keeps reporting its steps in
   `output`, but its reporter checks `CHECKNAME#` ownership under its claim before every conclusion
   and never sets one other than `cancelled` on a run it no longer owns. The fallback is counted
   and alarmed.
6. **A surplus duplicate is retired the same way.** If an anomaly produces two check runs with one
   `external_id`, the adopted one keeps the name and the other is retired by step 4 (or 5). It is
   never concluded `neutral` under the job's name.
7. **Commit statuses obey the same owner record.** A commit status is per `context`, and the
   combined status uses "the latest status for all contexts"
   ([statuses](https://docs.github.com/en/rest/commits/statuses)), so latest-wins would let any
   newer run replace any older one, which is exactly the substitution step 3 forbids. So the
   fallback writes a status only while it owns the name under step 3: a same-claim-key successor
   replaces its predecessor's status by that documented rule; a contested name gets one status
   of ours, `failure`, with the contested description, and no contestant writes that context
   again. If a check run and a commit status share a name, "both must pass when that name is
   required"
   ([troubleshooting required checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)),
   so a stale fallback status left over after `checks:write` is granted can block a merge but
   never authorise one.
8. **Names are unique per deployment, because the owner record is per deployment.** Steps 3
   to 7 hold one `CHECKNAME#` owner per name, but that record lives in one environment's
   table, while a repo's check names and status contexts are one namespace shared by every
   App installed on it. Two LCA deployments (a `prod` and a `dev`, or two operators' `prod`s,
   each with its own App, [01](01-github-app.md)) installed on one repo would each enforce
   "one owner per name" locally and together put two runs under one name, the substitution
   this section forbids. So the name prefix is the deployment's, not a constant: `LCA` when
   the App's slug is `lambdaciactions`, and `LCA (<app slug>)` for every other App (`LCA
   (lambdaciactions-dev) / ci / build [pull_request → main]`). GitHub App names are unique
   across GitHub, so slugs are, and no two deployments can render one name. The system-check
   prefix is derived the same way (`LCA: ` or `LCA (<slug>): `), and the rule "no job name
   starts with the system prefix" holds per deployment. Every observe and adopt step lists
   check runs with the `app_id` filter set to our App
   ([checks](https://docs.github.com/en/rest/checks/runs)) and reviews by our App's bot user,
   because `repoKey` in an `external_id` or review marker is the repo's id and is the same for
   every deployment, so an unfiltered listing could adopt another deployment's effect. The
   console recommends configuring a required check with our App as its expected source, which
   GitHub supports for check runs, so even a name collision with a non-LCA writer cannot
   satisfy it.

**What a required check on our name can mean.** A required check named
`LCA / ci / build [pull_request → main]` is satisfied only by the latest attempt of that job,
run for a pull request into `main`, at that sha, whose claim key (event payload and job
definition included) nobody else contests. A
`push` run of the same commit carries a different name and cannot satisfy it, and neither can
a console dispatch.

Annotations are produced from our own `::error file=…,line=…::` / `::warning` workflow-command
parsing ([06](06-workflow-engine.md#grammar-support-matrix)) — the same commands GitHub consumes,
so a workflow needs no LCA-specific output to get annotations.

## Re-run via `requested_actions`

The re-run button arrives back as a webhook, which is why the `check_run` event is requested:

```
user clicks "Re-run job"
   └─▶ check_run.requested_action  { requested_action: { identifier: "lca_rerun_job" },
                                      check_run: { id: 98765, external_id: "e1:gh-42:…:…:1" } }
        └─▶ Ingest → parse external_id → attempt key → reserve re-run (one transaction)
             └─▶ per job: attempt row (waiting) + latestAttempt together → arm release
                  └─▶ release pass: ready jobs → new microVM(s) + new check run(s);
                       dependents stay waiting until their needs finish
```

`external_id` is `e1:<repoKey>:<runId>:<jobId>:<attempt>`: a version tag, then the engine's full
attempt key ([06 § Run identity](06-workflow-engine.md#run-identity-keys--attempts)). It fits the
field's limits, needs no lookup table, and names the exact attempt the user clicked on, not just
the job.

Rules that make the re-run non-destructive and idempotent:

- **The old attempt is never mutated.** A re-run writes a new `ERUN#…#<attempt+1>` row. The
  previous attempt's row, steps, logs and check run stay as they were, because they are the record
  of a flake.
- **Only the latest attempt can be re-run from its button.** Ingest re-runs only if the clicked
  attempt equals `PlannedJob.latestAttempt`, checked inside the reservation transaction
  ([06 § Re-run allocation](06-workflow-engine.md#re-run-allocation)). A second click on the same
  button, a redelivered webhook, or a click on an older attempt's button is a no-op that logs
  `rerun-stale`. So one click yields one new attempt per job in the re-run set.
- **A re-run never strands its own projection.** `latestAttempt` moves only in the same
  transaction that creates the attempt row it names, and the allocation record fixes every attempt
  number up front, so a crash after the reservation or partway through a multi-job fan-out is
  finished by the next pass (a redelivery or the Reaper) instead of leaving a latest-attempt URL
  that points at no row.
- **The webhook proves who clicked; trust comes from the plan.** The re-run inherits the plan's
  trust class ([06 § Trigger trust](06-workflow-engine.md#trigger-trust-forks-bots-and-re-runs)). A
  maintainer clicking re-run on a fork PR's check does not give the new attempt secrets.
- **Each attempt gets its own check run.** We create a new check run for attempt 2 rather than
  patching attempt 1's, and attempt 2 takes over the job's check name: attempt 1's run is renamed
  out first ([Check-run names](#check-run-names-one-authority-per-name)), so a required check
  never has two candidates under one name. The old check run's `details_url` keeps pointing at
  the old attempt.
- **Cap:** 50 attempts per run, as on GitHub.

GitHub's own `rerequest` endpoint (`POST …/check-runs/{id}/rerequest`) re-runs *GitHub's* notion of
the check suite; for engine-owned runs the `requested_action` path is the correct one because we
own the run. A user who clicks GitHub's native "Re-run" on our check run instead sends
`check_run.rerequested` to our App alone; Ingest handles it exactly like `requested_action`
(same `external_id`, same latest-attempt check), so both buttons do the same thing.

## Review payload

```jsonc
// POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
{
  "commit_id": "ce58745…",                 // pinned: a review must name the sha it judged
  "event": "COMMENT",                      // default; REQUEST_CHANGES only when the repo
                                           // opts in AND our App can dismiss it; never APPROVE
  "body": "**LCA CI: 1 of 4 jobs failed** at `ce58745`.\n\n| job | result |\n|---|---|\n| build (node 20) | ❌ |\n\n[Failing job logs and timings →](https://<console>/#/eruns/gh-42/<runId>/<jobId>/1)\n\n<!-- lca-review:v1 repoKey=gh-42 pr=17 sha=ce58745… intent=<intentId> fence=<n> -->",
  "comments": [
    { "path": "src/auth.ts", "line": 88, "side": "RIGHT",
      "body": "`npm test` failed here — [step log →](https://<console>/#/eruns/gh-42/<runId>/<jobId>/1)" }
  ]
}
```

The body links to the **failing job's attempt**, not to the whole run, because the whole-run view
does not exist yet (see [Deep-link contract](#deep-link-contract) and OQ-5).

The vocabulary is verified: "The review actions include: APPROVE, REQUEST_CHANGES, or COMMENT."
([reviews](https://docs.github.com/en/rest/pulls/reviews)) The reporter's own type for `event` is
`'COMMENT' | 'REQUEST_CHANGES'`, so `APPROVE` cannot be built, not merely not chosen. Inline `comments` are passed only on
create; nothing in the lifecycle below edits them afterwards.

## Effect obligations and claims

Every write we make to the git host (create a check run, change its conclusion, post a review,
dismiss one) is an external effect: no DynamoDB condition can fence it, and a worker can stall in
the middle of one. The first lease design fenced only *which intent* a worker held, so after a
lease expired a second worker could take the same logical claim, and both could POST. Every effect
below follows one protocol instead, so the defence is stated once.

**1. The obligation is durable before the effect.** Each effect has an obligation item, created
in the same transaction as the state change that makes it owed, and carrying the sparse GSI1 key of
its kind while it is owed:

| Obligation | Item | Created with | GSI1 while owed | Host identity (adopted by) |
|---|---|---|---|---|
| execution check run for an attempt | `<attempt pk>` / `REPORT` | the attempt's `waiting → released`, or its terminal transition at release | `REPORTS#pending` | `external_id` `e1:<repoKey>:<runId>:<jobId>:<attempt>` |
| contested-name check run | the `REPORT` of the attempt that made the name contested | the claim that sets `CHECKNAME#… state = contested` | `REPORTS#pending` | `external_id` `e1c:<repoKey>:<sha>:<hash(name)>` |
| refusal check run for a refused workflow | `REFUSAL#ERUN#<repoKey>#<runId>` / `REPORT` | the refusal record's write (same transaction) | `REPORTS#pending` | `external_id` `e1r:<repoKey>:<runId>` |
| refusal check run for a refused whole delivery | `REFUSAL#TRIGGER#<repoKey>#<triggerId>` / `REPORT` | the transaction that writes the trigger refusal record and seals the batch `refused` | `REPORTS#pending` | `external_id` `e1t:<repoKey>:<triggerId>` |
| approval check run for a held job | `<attempt pk>` / `GATE` | `waiting → held` ([gate](#the-approval-gate-q5)) | `GATES#open` | `external_id` `e1g:<attempt key>` |
| fork-approval check run for a held plan | `PLAN#…` / `FORKGATE` | the plan's `planned → held` | `GATES#open` | `external_id` `e1f:<repoKey>:<runId>` |
| cancel a matrix's running siblings | `PLAN#…` / `CANCEL#<hash(jobKey)>#<seq>` | every fail-fast trip, by unconditional upsert ([06 § Cancellation](06-workflow-engine.md#cancellation)) | `CANCELS#pending` | none: no host effect |
| converge the PR's reviews onto the latest verdict | `PR#…` / `REVIEWHEAD` | a verdict, a head change, a plan going terminal, a batch sealing | `REVIEWS#pending` | review body marker `lca-review:v1 … intent=<intentId> fence=<n>` |
| withdraw one of our reviews | `PR#…` / `CLEANUP#<intentId>` | the pointer moving off it | `REVIEWCLEANUP#pending` | the review's own id and state |

Every host identity is unique per obligation and derivable from the obligation item alone, so a
takeover never needs anything but the item to find what a crashed holder may have posted. The
commit-status fallback has no `external_id`; there the observed fact is the status for the
obligation's context on the sha, which is ours only while `CHECKNAME#` says so.

Each item carries `seq`, raised whenever the obligation changes (a terminal status, a new verdict),
and `doneSeq`, the `seq` its last effect satisfied. The GSI1 key is removed only by a record
that sets `doneSeq = :s` and removes the key on condition `seq = :s`, `:s` being the `seq` the
worker read before its effect; `doneSeq = seq` below is shorthand for that write. The condition
names `seq` rather than `doneSeq`, because an item created by an upsert has no `doneSeq` yet
and a comparison against an absent attribute is false. A queue message is only the fast path;
the index is the guarantee.

**The sort key is the time the obligation is due, and nothing else.** Every obligation partition
in GSI1, here and in [06](06-workflow-engine.md#data-model-q6), sorts by `dueAt`: the instant at
which, if the obligation is still owed, the Reaper must re-drive it. Every write that raises `seq`
sets `dueAt = now + T` (T is the per-kind fast-path allowance, 2 minutes by default); a Reaper
re-drive that fails sets `dueAt = now + backoff`. An item that also has a deadline of its own (a
gate's 30-day expiry) stores `dueAt = min(report due, deadline)`, recomputed in every write to it.
So "what must the Reaper do now" is exactly the key condition `gsi1pk = :p AND gsi1sk <= :now`,
whose results come back oldest-due first; the Reaper pages until that condition is exhausted,
carrying the cursor to its next tick when its per-tick budget runs out. No obligation that is due
can sort behind one that is not, so a backlog of not-yet-due items cannot hide a lost one. The
first draft keyed gates by `expiresAt` alone and claimed one query also found overdue reports;
it could not, because a key condition on expiry says nothing about report age.

**2. A claim names its holder and has a hard deadline.** A worker claims an obligation with one
conditional `Update` that sets
`claim = {holder: <random 128-bit id, new per attempt>, fence: <fence + 1>, until: now + 60 s}`
(written `SET fence = if_not_exists(fence, :zero) + :one`, so the first claim on an item that
has never been claimed starts the fence at 1)
on condition that no live claim exists (`attribute_not_exists(claim) OR claim.until < :now`).
`fence` is a counter on the item that never goes down. Every later write the worker makes to the
item is conditioned on `claim.holder = :me AND claim.fence = :f`, so a worker whose claim was taken
over can no longer record anything. A worker renews by the same conditional write, extending
`until` by 60 s, and never past its own invocation's remaining time; a renewal that fails means
the claim is gone and the worker stops at once, without starting another effect.

**3. A worker never starts an effect it cannot finish inside its claim.** Before each effect it
checks that at least 15 s remain on `until`, renewing first if not, and sends the request with a
12 s client timeout.
GitHub ends any request it takes longer than 10 seconds to process: "If GitHub takes more than 10
seconds to process an API request, GitHub will terminate the request"
([troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#timeouts)).
Every reporter Lambda's timeout is 60 s and it renews only within that, so a claim cannot
outlive its holder by more than one lease. The residual is a worker frozen *after* it sent the
request bytes and before GitHub replied: that request is bounded by GitHub's own 10 s, so it has
settled, one way or the other, before the 15 s margin runs out. GitHub "reserves the right to
change the timeout window"; the margin is a config value, and the alarm on rule 5's duplicate
counter is what would show the window had moved.

**4. A takeover settles the unknown outcome before acting.** A worker that claims an item whose
previous claim expired (the previous `fence` is recorded as `lastFence`) does not know whether the
previous holder's effect happened. It does not repeat it blind. It first **observes** the git host
for the effect, by its idempotency marker: a check run is found by `external_id` among the sha's
check runs; a review is found by the `lca-review:v1 … intent=<intentId> fence=<n>` marker among our
App's reviews on the PR; a dismissal or conclusion change is visible on the object itself. If the
effect is visible, it records it and does not repeat it; if not, the 15 s margin and GitHub's
10 s limit mean no in-flight request from the previous holder can still land, so it may perform
the effect once.

**5. A surplus effect is adopted, never hidden.** If, despite the above, two of our reviews for one
intent ever exist (for example GitHub accepted a request after reporting a timeout), the next
observing worker records the one with the highest `fence` marker as the intent's review and gives
the other a cleanup obligation. A surplus check run is **renamed out** of the name it shares with
the adopted one ([Check-run names](#check-run-names-one-authority-per-name)): its conclusion is
left as it was, and it can no longer be selected by a required check. Each adoption increments a
duplicate-effect metric, which alarms on any non-zero value.

Two rules keep this honest. **We cannot make an external POST exactly-once**, and the design does
not claim to; it makes a duplicate require a GitHub-side anomaly, bounds its lifetime to one Reaper
interval, and never leaves one untracked. And **no reporter failure affects a run's outcome**
([Failure handling](#failure-handling)).

## Review lifecycle

The first draft promised one review per `(PR, head sha)` that we would "update". GitHub does not
allow that. The update endpoint "Updates the contents of a specified review summary comment" and
takes only a `body`; a submitted review cannot be deleted ("Submitted reviews cannot be
deleted"); and its state (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`) cannot be changed
([reviews](https://docs.github.com/en/rest/pulls/reviews)). So reviews are modelled as
**append-only**, and only check runs are mutable.

| Surface | Mutable? | How we use it |
|---|---|---|
| Check run | yes (`PATCH`) | live status, annotations, conclusion; one per job attempt |
| Submitted review **body** | yes (`PUT …/reviews/{id}`, body only) | a superseded note only; never the state |
| Submitted review **state** | **no** | changed only by submitting a new review, or by dismissing |
| Inline review comments | not by us | posted once with the review that owns them |

### When we submit a review

A **review intent** is one verdict we reached for one PR at one head sha, once that sha's verdict
is **closed** (below): `COMMENT`, or `REQUEST_CHANGES` (only if the repo opted in, see
[Opt-in gates](#opt-in-gates)), or `none` for a `green` or `tolerated-only`
verdict, which posts nothing unless rule 4's "no longer failing" exception applies when the
reporter decides (rule 2, step 3).
A sha can have several intents over time, one per verdict, because a re-run can change the verdict.
Each intent is **its own immutable row**, never an overwrite of an earlier one.

- **Closed verdict.** A verdict judges a fixed set of runs, never "whatever plans exist so far".
  The set is the trigger batches recorded under the PR as `HEADTRIG#<headSha>#<triggerId>` rows
  ([06 § Trigger batch](06-workflow-engine.md#trigger-batch)), read with
  `begins_with(sk, 'HEADTRIG#<headSha>#')` and paginated to the end, each of which lists every
  workflow its delivery matched. Their count must equal `REVIEWHEAD.triggerCount`; a shorter read
  means "not yet". The evaluator may create an intent only when **every** listed batch is
  `sealed` (its member set is final and every member is planned or refused) **and** every planned
  member's `RunPlan` is terminal. A batch not yet sealed, or a member plan still running, means
  "not yet": the evaluator writes nothing. A refused member makes the verdict a failure (the
  review names the refusal), because a workflow that did not run has not passed. Because Ingest
  records a batch on `REVIEWHEAD` before the Planner writes any plan for it, a slow or crashed
  planner can only delay a verdict, never let one be reached without its plans.
- **The verdict is a reduction over what actually ran, never over an empty set.** It reads each
  job's latest attempt through the **effective result** and the `tolerated` flag
  ([06 § continue-on-error](06-workflow-engine.md#continue-on-error-raw-and-effective-results)),
  the same pair fail-fast and the plan's terminal state read, so the verdict cannot disagree
  with the run about the same workflow. Once the barrier holds, the evaluator reduces the closed
  set, in this order:

  | Closed set contains | Verdict | Intent |
  |---|---|---|
  | no member at all (every batch sealed empty: no `.lca/workflows` file, or none matched the event's filters) | `no-runs` | **none is created** |
  | a refused member, a batch sealed `refused`, or any job whose effective result is `failure` or `cancelled` (raw `failure` without `continue-on-error`, `timed_out`, `cancelled`) | `failure` | `COMMENT` (or `REQUEST_CHANGES` if opted in) |
  | at least one job whose raw conclusion is `success`, and nothing above | `green` | `none` (quiet); the check runs carry the result |
  | jobs, but every one ended `skipped`, or was a tolerated failure | `tolerated-only` | `none` (quiet) |

  Every condition is existential ("a job that ran and passed"), not universal, so an empty,
  all-skipped or all-tolerated set can never satisfy the green row vacuously. No row produces
  `APPROVE`, for any trust class, opt-in or diff ([below](#why-we-never-post-approve)). A tolerated
  failure neither fails the verdict (the author declared it allowed, and GitHub's workflow
  result agrees) nor counts as the passing job that green needs. `no-runs` writes nothing on
  the PR, which is the honest statement: we did not judge this head. The console's PR view says
  "no engine workflow matched this head". A `cancelled` job counts as failure because it did not
  pass, whoever stopped it.
- **Verdict basis.** The batch ids, plus, for each planned member, the latest attempt of each of
  its jobs with its raw conclusion, `tolerated` and effective result. These are written once by
  the attempt's terminal transition and never change, so two evaluations that saw the same
  attempts have the same basis and reach the same verdict. The basis can span many batches of up
  to 64 workflows of 256 jobs each, so the intent row stores only `basisHash` (SHA-256 of the
  canonical basis), the counts per result, and the first 50 failing or tolerated jobs for the
  review body ([06 § Item bounds](06-workflow-engine.md#item-bounds)); the full basis is
  re-derivable from the immutable attempt rows it names.
- **`intentId`** is a fixed-length hash of `(headSha, basisHash, event)`. The same verdict computed
  twice (a duplicate webhook, two runs finishing together) yields the same id; a re-run that
  produced new attempts yields a new basis, so a new id.
- **Intent row:** `PR#<repoKey>#<prNumber>` / `REVIEW#<headSha>#<intentId>`. `intentId`,
  `headSha`, `basisHash`, the bounded basis summary, `event` and `generation` are written once at creation. Only `state`
  (`new | skipped | quiet | submitted | superseded | dismissed | dismiss-failed`) and `reviewId`
  change afterwards, and `reviewId` is set at most once (`attribute_not_exists(reviewId)`).
- **Head projection:** `PR#<repoKey>#<prNumber>` / `REVIEWHEAD` holds the PR's current `headSha`,
  `triggerCount` (the number of `HEADTRIG#` rows for that sha) with `triggersSeq` (raised on every
  new row), the
  `generation` and `intentId` of the newest intent for it (`latestIntentId`), `submittedIntentId`,
  and the claim fields of [Effect obligations](#effect-obligations-and-claims).
  **`submittedIntentId` means "the review of ours that is
  actually visible on the PR"**, never "the review we would like to be visible": it moves only
  after a POST we made or adopted, and away from an intent only in the same write that records that
  intent's cleanup obligation. History lives in the intent rows.
- **`generation`** orders verdicts for one sha: `triggerCount` plus the sum of
  their member plans' `rerunSeq` ([06 § Re-run allocation](06-workflow-engine.md#re-run-allocation)).
  Batches are only added and `rerunSeq` only grows, so every new batch or re-run raises it, and
  a later basis always has a higher generation. Unlike the first design, it is computed only over
  a closed set, so it cannot be raised by a plan the evaluator had simply not seen yet.

Rules:

1. **One intent per verdict, created once.** A `no-runs` verdict creates no intent and stops
   here. Otherwise the intent row and the head projection are written in
   one transaction: `Put` the intent (state `new`) with `attribute_not_exists`, and `Update`
   `REVIEWHEAD` to `latestIntentId = :id, generation = :g` on condition
   `headSha = :sha AND triggersSeq = :ts AND (attribute_not_exists(generation) OR generation < :g)`,
   where `:ts` is the `triggersSeq` the evaluator read before checking the barrier. A duplicate
   delivery fails the `Put` (same id), an evaluation that read an older basis fails the generation
   check, and an evaluation that missed a batch appended after its read fails the `triggersSeq`
   check, so all three are no-ops. `REVIEWHEAD.headSha`, `triggerCount` and the `HEADTRIG#` rows are written only by
   Ingest (or the delivery reconciler, which runs the same logic), from the PR's own `pull_request` events (`opened`, `synchronize`, `reopened`), in the
   same transaction as the batch they name ([06 § Trigger batch](06-workflow-engine.md#trigger-batch)),
   and on condition that the stored event time is older; never by the evaluator.
2. **Only the latest intent can reach GitHub, and only under a fenced claim.** All review effects
   for a PR are made by one reporter loop at a time, which converges what is visible onto
   `latestIntentId`. The loop is driven by the `REVIEWHEAD` obligation
   ([Effect obligations](#effect-obligations-and-claims)), whose `seq` is raised by a new intent,
   a head change, a member plan going terminal ([06 § Release](06-workflow-engine.md#release)) and
   a batch sealing, so the loop also runs the evaluator above.
   1. **Claim.** One conditional `Update` on `REVIEWHEAD` that takes the claim (new `holder`,
      `fence + 1`, `until`) on the protocol's condition **and** `latestIntentId = :L AND
      generation = :g`. A reporter holding an older intent A cannot claim it, because A is no
      longer `latestIntentId`; A's row is set `new → skipped` and nothing is posted for it.
      Submission is decided against the current projection, not against the intent's own state,
      and only one holder can have it.
   2. **Observe and adopt.** List the PR's reviews by our App. Any review whose
      `lca-review:v1 … intent=<id>` marker names an intent not yet recorded `submitted` (a crash
      after a POST, before its record, or the previous holder's POST after a takeover) is recorded
      now: `reviewId` set, and, if it is not the claimed intent, a cleanup obligation for it
      (rule 6). Two reviews for one intent are resolved by protocol rule 5. An orphan therefore
      cannot stay visible untracked.
   3. **Decide.** The claimed intent L is **quiet** if its event is `none` and the visible review
      (`submittedIntentId`) is not a failure verdict on L's own sha; otherwise it needs a review.
      Quietness is decided here, under the claim, not at creation, so it is always judged against
      what is visible now.
   4. **Effect.** If L needs a review and step 2 found none for L, POST it with L's marker and the
      claim's `fence`, within the protocol's deadline rule.
   5. **Record (one transaction).** L → `submitted` with `reviewId` (or → `quiet`);
      `submittedIntentId` → L (or cleared, if quiet and the visible review is for an older sha);
      **in the same write**, `Put` `CLEANUP#<P>` for the previously visible intent P, if any, with
      what superseded it (L's review, or L's basis when L is quiet); release the claim and set
      `doneSeq = seq` as read; all on condition `claim.holder = :me AND claim.fence = :f AND
      headSha = :sha` (L's sha). If the head moved, the record fails, the worker releases its
      claim (condition: still its holder) and loops; its review is then an orphan for step 2.
   6. **Loop.** If `seq` moved since the claim, a newer intent or plan arrived while L was being
      posted; go to the evaluator and step 1 again.

   Step 5's `doneSeq` condition is what keeps the obligation alive: a new intent that landed
   mid-loop raised `seq`, so the GSI1 key `REVIEWS#pending` survives and the Reaper restarts the
   loop if the fast path is lost.

   One race cannot be closed, because the POST is an external effect: intent B can be created
   between the claim on A and A's POST. A is then posted when it is already stale. The design makes
   that **brief and never stranded**: A's record makes A the visible review, the loop immediately
   claims B, and B's record writes A's cleanup obligation; a crash anywhere in that sequence leaves
   an expired claim, an adoptable orphan (step 2), a raised `seq`, or a durable cleanup
   obligation, each of which the Reaper drives forward. A stale `COMMENT` or `REQUEST_CHANGES` is
   visible for at most one reporter loop plus a lease, or a Reaper interval after a crash, never
   indefinitely. No intent is ever `APPROVE` ([below](#why-we-never-post-approve)), so a stale
   review never carries authority to merge; a stale `REQUEST_CHANGES` can only block one.
3. **At most one submitted review per intent.** The fenced claim admits one poster, a takeover
   observes before it posts, and adoption by **this** intent's marker means a retry never posts
   twice; because each verdict has its own id, a retry of the green intent can never adopt the
   earlier failure review, or the reverse. A duplicate that a GitHub-side anomaly could still
   produce is adopted and withdrawn by protocol rule 5.
4. **A new head sha gets new intents.** That is unavoidable, because a review is pinned to the sha
   it judged; we keep it rare by rule 2's quiet default and by superseding (below). Quiet by
   default means: a failure verdict gets a `COMMENT`, a green verdict gets no review, so a green PR
   has a check run and no review. A bot that reviews every push is noise, and noise gets muted,
   which costs us the surface. **One exception**, from step 3: a `green` or `tolerated-only` verdict
   (both have intent `none`) on a sha whose visible review is our failure review is not quiet, and
   posts a short "no longer failing at `<sha>`" `COMMENT` (listing any tolerated failures), because
   leaving the failure review as the newest word on that sha would be false.
5. **The verdict for a sha changes only by a re-run** (a flaky job going green). Then the re-run's
   attempts form a new basis, a new intent is created by rule 1, and the reporter converges onto
   it. The old intent row and its review stay as they were, except for the cleanup step below. We
   never edit the old review's state.
6. **Superseding is a durable obligation, not a follow-up.** `CLEANUP#<intentId>` (sparse GSI1
   `REVIEWCLEANUP#pending` / `dueAt`) is created in the same transaction that moves
   `submittedIntentId` away from that intent (step 5), or that adopts an orphan (step 2), or that
   records a new head sha over a visible `REQUEST_CHANGES` ([below](#superseding-and-dismissing)).
   It records what superseded the review: a newer
   review's id, or, for a quiet green verdict, that verdict's basis.
   The cleanup worker applies it under the claim protocol
   ([Effect obligations](#effect-obligations-and-claims)) and
   ([Superseding and dismissing](#superseding-and-dismissing)), then
   sets the intent `superseded`, `dismissed` or `dismiss-failed` and removes the GSI1 key, each on
   condition `state = submitted` and its claim, so a retry acts at most once and the old review's
   `reviewId` is never overwritten. The Reaper sweeps `REVIEWCLEANUP#pending` past its `dueAt`. A crash after the pointer moved therefore cannot strand an old `REQUEST_CHANGES`: the
   pointer and the obligation moved together.
7. **No head projection yet means wait.** If `REVIEWHEAD` is absent or names another sha when a
   verdict is reached, the transaction in rule 1 fails, and the evaluation is retried with backoff
   on the reporter queue. A verdict for a sha the PR has moved past is dropped: its check runs
   already carry the result.

### Superseding and dismissing

When a newer review replaces one of ours (a new head sha, or a re-run that changed the verdict):

- **A superseded `COMMENT` review:** we update its **body** to a one-line note naming what
  replaced it, read from its cleanup obligation. Superseded by a newer review: "Superseded by LCA
  review for `<sha>` →", linking to that review. Superseded by a quiet green verdict, which posts
  no review: "Now passing at `<sha>`, see the runs →", linking to the first job attempt in that
  verdict's basis (an immutable attempt URL, [Deep-link contract](#deep-link-contract)), never to
  a review that does not exist. Its state stays as it was; a `COMMENT` carries no merge authority,
  so leaving it is safe.
- **A superseded `REQUEST_CHANGES` review:** we **dismiss** it
  (`PUT …/reviews/{id}/dismissals`, message "Superseded by LCA review for `<sha>`"), because
  where branch protection counts it, a stale request-changes keeps blocking merge. Ingest's
  head-sha write clears `submittedIntentId` and writes this `CLEANUP#` obligation in the same
  transaction. Our dismissal is the only path, and it is safe to be eventual: a stale
  `REQUEST_CHANGES` fails closed, it blocks a merge and never authorises one.
  Dismissal needs `pull_requests: write` (the same grant as creating a review, per the
  [permissions table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)),
  but "To dismiss a pull request review on a protected branch, you must be a repository
  administrator or be included in the list of people or teams who can dismiss pull request
  reviews" ([reviews](https://docs.github.com/en/rest/pulls/reviews)). So:
  - **Before enabling `reviewRequestChanges`, the console checks the dismissal
    path.** If the target branch is protected and our App is not allowed to dismiss, the console
    refuses to turn the toggle on and says which setting to change. That prevents a
    `REQUEST_CHANGES` we can neither change nor remove.
    The check reads the branch's protection (`GET …/branches/{branch}/protection`, Administration
    read, which the App already holds as write for runner registration,
    [01](01-github-app.md)) and its active rulesets (`GET …/rules/branches/{branch}`, Metadata
    read), and is repeated whenever the reporter is about to post a `REQUEST_CHANGES`, so a
    setting changed later degrades the next review to `COMMENT` instead of posting a block we
    could not withdraw.
  - If a dismissal still fails at runtime, the intent is marked `dismiss-failed`, the new
    review's body names the stuck review, and the console raises it on the repo page. We never
    retry in a loop.
- **We only ever touch reviews our own App authored**, identified by the review's `user` and the
  marker. A human's review is never edited or dismissed by us.

### Why we never post `APPROVE`

v1 posts `COMMENT`, and `REQUEST_CHANGES` where the repo opts in. It never posts `APPROVE`, for
any trust class, opt-in, branch or diff.

The previous revision posted `APPROVE` for a green verdict when every run in the closed set was
`trusted` and the PR changed no file under `.lca/workflows/**`. That rule was too narrow, because
the code that decides a CI result is much larger than the workflow file. A same-repository PR is
`trusted` ([06 § Trigger trust](06-workflow-engine.md#trigger-trust-forks-bots-and-re-runs)), and
its workflow runs against the PR's own head. Its author can leave every workflow file unchanged
and still choose the result, by editing:

- the tests the workflow runs, or the code they test, so a check that should fail passes;
- a build or package script the workflow calls (`package.json` scripts, a `Makefile`, a shell
  script in the repo), so the step that should check something does not;
- or, in the `docker` flavor, nothing at all: a root step can take the agent's token and report
  its own attempt green ([06 § In-VM trust boundary](06-workflow-engine.md#in-vm-trust-boundary)).

All of those are ordinary source files, and no path filter can separate them from the change
under review. So **every CI result on a PR is a result its author controls**, and an `APPROVE`
built from one is the author approving their own change through our App. GitHub's own
"Require approval of the most recent reviewable push" exists to stop exactly that: it counts an
approval only from "someone other than the person who made the most recent changes"
([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).

The alternatives, and why none is v1:

| Option | Why not in v1 |
|---|---|
| Approve only from a check whose definition is read from the base sha | The base sha's workflow still checks out and runs the head's tests and scripts, so the author still controls its result. Only a check that does not execute head code (a policy evaluated by the control plane over the diff, for example) would be independent, and none is designed. Running base-defined workflows over head code is also `pull_request_target`'s shape, which is out of scope ([06 § Trigger trust](06-workflow-engine.md#trigger-trust-forks-bots-and-re-runs)) |
| An admin-set policy that lets chosen repos or authors self-approve | It turns an admin's trust in a person into an automatic approval of every later push by that person, which is the case GitHub's most-recent-push rule refuses. Making it safe needs approval of each head by someone other than the pusher, which is a human review that the human can post directly |
| **Never post `APPROVE` (chosen)** | Costs the "green, so approved" shortcut. A green result is still visible as our check runs, and on a plan with branch protection a required status check from our App is the enforceable gate ([Q5](#the-approval-gate-q5)) |

How this is encoded, so it cannot regress by configuration:

- **There is no `reviewApprove` toggle.** The intent type is `COMMENT | REQUEST_CHANGES | none`,
  and the reporter's review payload type has no `APPROVE` member, so the event cannot be built.
- **The port has no approve operation** ([Provider-agnostic reporting port](#provider-agnostic-reporting-port)).
  A second provider (GitLab MR approve, Bitbucket PR approve) inherits the same rule.
- **The `branch_protection_rule` and `repository_ruleset` events are not requested.** Their only
  consumer was revoking our `APPROVE` when a branch stopped dismissing stale approvals, so with
  no `APPROVE` they would be grants with no consumer ([Permissions & events](#permissions--events)).
- **The console says what a green result is.** The PR view labels a green verdict "the PR's own
  code reported success", never "approved by LCA".

A design that does post `APPROVE` needs an approval signal that the PR's author does not control;
that is OQ-8.

### PRs opened by a bot, including ours

- **PRs our own App opened** (the ADR-031 `runs-on` rewrite PR) get a check run and **never a
  review** from us. "Approved by the bot that wrote it" is not evidence of anything, and must never
  appear in a PR's history.
- **PRs from other bots** (Dependabot, Renovate) get the normal lifecycle. Their runs are
  `restricted-bot` or `fork` trust and have no secrets
  ([06 § Trigger trust](06-workflow-engine.md#trigger-trust-forks-bots-and-re-runs)), and the review
  is still advisory.
- Fork PRs held under `forkPolicy: approve` get a neutral `LCA: fork approval · …` check run asking
  for approval and no review until they have run. Its name is never a job's, so a required check
  on a job stays unsatisfied until the job runs.

### Other constraints

- **`commit_id` is always pinned.** An unpinned review floats onto later pushes and would claim to
  have judged code it never saw.
- **`REQUEST_CHANGES` is opt-in per repo** and off by default: on a repo *with* branch protection it
  **blocks merge until dismissed** ("If a person with admin permissions chooses the **Request
  changes** option in a review, then that person must approve the pull request before the pull
  request can be merged", [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
  A failing flaky test must not be able to wedge a customer's PR by default. Default is `COMMENT`.

## The approval gate (Q5)

**Decision** ([ADR-057](../DECISIONS.md#adr-057)): **we report and advise; we do not merge.**
`contents:write` stays **off by default**, consistent with
[ADR-031](../DECISIONS.md#adr-031)'s posture and AGENTS.md's hard rule.

The reasoning, with the limit stated out loud as the card requires:

1. **Merging is `contents:write`, not `pull_requests:write`** — verified:
   `PUT /repos/{o}/{r}/pulls/{n}/merge` requires the **Contents** permission at write level
   ([permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)).
   So "we gate merges ourselves" is not a small extra scope; it is the *same* elevated permission
   the auto-rewrite feature keeps off by default, and it converts us from a reporter into an actor
   that can write to any granted repo's default branch.
2. **On a Free private repo our approval is advisory, and we say so in the UI.** With no branch
   protection available, nothing *stops* a human merging over a `REQUEST_CHANGES`. Presenting our
   approval as a gate there would be a false security claim — the worst possible outcome for a
   governance feature.
3. **Whether an App approval even counts as a required review is NOT STATED** in GitHub's docs.
   The reviews API documents only the action vocabulary; the protected-branches page speaks of
   "reviewers **with write permissions**" without addressing Apps. We therefore do not claim it
   works. **OQ-1** closes it by observation on a repo that has required reviews configured.
4. **What we *can* enforce, and it is not nothing:** a **required status check** sourced
   specifically from our App is explicitly contemplated by GitHub — "in some cases you may only
   want to accept a status check from a specific GitHub App". On a repo whose plan allows branch
   protection, our check run is an enforceable gate. What it enforces is that the PR's checks ran
   on our runners and reported success, which is what a GitHub-hosted required check enforces
   too: the result comes from the PR's own code, so it is a gate on "the checks passed", never a
   substitute for a reviewer ([Why we never post `APPROVE`](#why-we-never-post-approve)). That is
   the recommended configuration and the console says so, in those words.

**The LCA approval gate itself** (our own, engine-side) is the honest substitute for environment
protection rules, which Free withholds for private repos:

```
engine job declares `environment: prod`        (phase 4; Refused for the whole run until then)
   └─▶ release pass, ONE transaction: attempt `waiting → held`, Put GATE (state pending,
        expiresAt = now + 30 d, report owed, dueAt = now + T), no VM booted (06 § Release)
        ├─▶ gate reporter (claim protocol): APPROVAL check run "LCA: approve · <workflowKey> / <jobName> · <context>",
        │    created completed + `conclusion: action_required`, deep-linked "Approve in console →"
        │    (no execution check run exists for this attempt yet)
        └─▶ console: approver (an installation admin, per ADR-022) approves / rejects
             ├─ approved ⇒ ONE transaction: GATE pending → approved (approver, time);
             │   attempt `held → waiting` with `gateApproved`; RELEASE armed.
             │   The release pass then treats it like any other ready job: fail-fast and
             │   `max-parallel` apply (06 § Matrix groups), and release creates its execution
             │   REPORT and enqueues it to Provision.
             │   gate reporter PATCHes the approval check run to `conclusion: success`,
             │   "approved by <login>" (a conclusion change on a completed run, not a reopen);
             │   execution check run "LCA / <workflowKey> / <jobName> [<context>]" created
             │   queued → in_progress → final
             └─ rejected / expired ⇒ ONE transaction: GATE pending → rejected | expired;
                 attempt terminal `cancelled` (never ran, no VM); RELEASE armed for dependents;
                 execution REPORT created already `completed` + `cancelled`.
                 gate reporter PATCHes the approval check run to `conclusion: failure`;
                 dependents are released as for any cancelled need (06 § Release)
```

**Gate and execution are two check runs, on purpose.** A check run that has a conclusion is
`completed` ("Providing conclusion will automatically set the status parameter to completed",
[checks](https://docs.github.com/en/rest/checks/runs)), and the docs describe no transition from
`completed` back to `queued` or `in_progress`. So the first draft's single check run, marked
`action_required` while held and then dispatched, would have had to reopen a completed run, which
is undocumented. Instead:

- The **approval check run** is born `completed` and only ever changes conclusion
  (`action_required` → `success` or `failure`) by `PATCH …/check-runs/{id}`. The update endpoint's
  only stated restriction on conclusions is "You cannot change a check run conclusion to `stale`,
  only GitHub can set this", so a conclusion change on a completed run is within the documented
  contract, and `status` never has to move backwards. If that PATCH is ever refused, the fallback
  is a new approval check run of the same name carrying the decision; the `GATE` item is
  authoritative either way, and dispatch never waits on the PATCH.
- The **execution check run** is created after the approval, starts `queued`, and follows the
  ordinary forward lifecycle to one final conclusion. Its name is the job's normal check name
  ([Check-run names](#check-run-names-one-authority-per-name)), so a required check on that name
  is satisfied only by the job actually
  running and passing. A rejected gate posts it `cancelled`, which does not satisfy a required check
  (only `success`, `skipped` and `neutral` do), so rejection blocks merge where checks are enforced.
- The approval check run never carries the job's name; it is in the `LCA: ` system namespace. A
  required check on the job's name can therefore never be satisfied by the approval alone.

### Gate state, delivery and expiry

A held attempt is deliberately invisible to the status index ([06 § Release](06-workflow-engine.md#release)),
so the gate needs its own durable record of the two things it owes: a visible approval check run,
and a decision by a deadline. Both live on one item, created atomically with the hold.

- **The `GATE` item is created in the hold transaction.** `<attempt pk>` / `GATE`, created by the
  same transaction that moves the attempt `waiting → held` (`attribute_not_exists`). It holds
  `state` (`pending → approved | rejected | expired`), `expiresAt` (hold time + 30 days, GitHub's
  own re-run window), the approval check-run id once known, the report `seq` / `doneSeq`, the
  claim fields, and the approver and decision time once decided. There is no instant at which an
  attempt is `held` without a `GATE`, or the reverse.
- **It is discoverable while it owes anything, by when it is due.** While `state = pending`, or
  while a report is owed (`doneSeq < seq`), the item carries the sparse GSI1 key
  `GATES#open` / `dueAt`, under the obligation index rule
  ([Effect obligations](#effect-obligations-and-claims)): `dueAt` is the earlier of the owed
  report's due time (`now + T`, set by every write that raises `seq`) and, while pending,
  `expiresAt`. A lost approval-check POST therefore becomes due after T and an undecided gate
  after 30 days, and the Reaper's one query, `GATES#open` with `dueAt <= now`, returns exactly the
  items that need either action, never behind the many pending gates that are not yet due. The
  re-driver reads the item and does whichever is owed: deliver the report, expire the gate, or
  both.
- **Delivery is an obligation, not a follow-up call.** The approval check run is created by the
  gate reporter under the claim protocol ([Effect obligations](#effect-obligations-and-claims)):
  a takeover first lists the sha's check runs and adopts ours by `external_id` (`e1g:<attempt key>`,
  distinct from the execution run's `e1:`) before creating one. A crash before the POST leaves
  `doneSeq < seq`, so the Reaper re-drives it; the hold is never invisible.
- **Every decision is one transaction with every state it changes.** Approve: `GATE pending →
  approved` (condition `state = pending AND expiresAt > :now`), attempt `held → waiting` with
  `gateApproved = true`, the plan's `RELEASE` armed, gate report `seq + 1` and `dueAt` reset.
  Release then dispatches it through the ordinary pass, which is what keeps an approved matrix
  job inside `max-parallel` and subject to fail-fast
  ([06 § Matrix groups](06-workflow-engine.md#matrix-groups-max-parallel-and-fail-fast)).
  Reject or expire: `GATE pending → rejected | expired`, attempt terminal `cancelled`, the plan's
  `RELEASE` armed, execution `REPORT` created completed + `cancelled`, gate report `seq + 1`. A
  double click, a redelivered console request, or an approval racing the expiry sweep each fail
  the `state = pending` condition and change nothing, so exactly one decision wins. A held job
  whose matrix group trips fail-fast while it waits is expired early by the canceller (the same
  reject transaction, recorded as `cancelled-by-fail-fast`), so a gate never outlives its matrix;
  if an approval wins that race, the job is back in `waiting` and release step 4 cancels it
  instead.
- **Expiry is enforced by the Reaper**, through the due-time query above. The console also
  refuses an approval past `expiresAt`, so a late click never races the sweep into an approval.
- **The `GATES#open` key is removed** only when `state` is decided **and** `doneSeq = seq`, by the
  gate reporter's record of the final conclusion PATCH, so a decided gate whose PR surface has not
  caught up stays discoverable.
- **Fork-approval holds use the same shape.** A fork plan held under `forkPolicy: approve`
  ([06 § Trigger trust](06-workflow-engine.md#trigger-trust-forks-bots-and-re-runs)) gets a
  `PLAN#…` / `FORKGATE` item in the `planned → held` transaction, with the same states, expiry,
  `GATES#open` key and decision rule; approve moves the plan `held → running` and arms `RELEASE`
  in that one transaction. Its check run is `LCA: fork approval · <workflowKey> · <context>`,
  `external_id` `e1f:<repoKey>:<runId>`.

The approval is enqueued by the console and applied by the control plane; the console never writes
engine rows ([06 § Data model](06-workflow-engine.md#data-model-q6)). An approval never changes a
run's trust class: approving an `environment:` job on a fork run is refused, because fork runs
cannot receive environment secrets at all.

This gate is **real**, because it governs the thing we actually control: whether *our* runner
executes. It is not a merge gate, and the console must never describe it as one. `prevent
self-review` (the approver may not be the pusher) is supported, mirroring GitHub's own option.

## Deep-link contract

**Pinned URL contract.** GitHub-scheduled runs keep the shipped numeric route. Engine runs get
their own `#/eruns/` prefix, because their ids are strings and carry an attempt, and the shipped
SPA parses `#/runs/` segments with `Number(...)` (`web/src/main.tsx`). None of the engine routes
exist today; each is listed with the phase that adds it.

| Target | URL | Exists today? | Posted in |
|---|---|---|---|
| One job, GitHub-scheduled | `https://<console>/#/runs/{repoId}/{runId}/{jobId}` | ✅ yes | unchanged; not used by the engine |
| One attempt of one engine job | `https://<console>/#/eruns/{repoKey}/{runId}/{jobId}/{attempt}` | ❌ phase 2 | check run `details_url`; inline comments; review body |
| Latest attempt of one engine job | `https://<console>/#/eruns/{repoKey}/{runId}/{jobId}` | ❌ phase 2 | console navigation only. Never posted to the git host: a posted link must keep meaning the attempt it was posted about |
| Whole engine run | `https://<console>/#/eruns/{repoKey}/{runId}` | ❌ **phase 3** | review body, once it exists |
| Approval | the attempt URL above, with the approve control on it | ❌ phase 4 | the approval check run (`LCA: approve · <workflowKey> / <jobName> · <context>`) |
| Refusal | `https://<console>/#/unclaimed` | ✅ yes | refusal check run `LCA: refused · …`, or its commit-status fallback ([ADR-050](../DECISIONS.md#adr-050)) |

> **The whole-run link is a gap, not a given.** The shipped SPA renders `RunDetail` only when all
> three numeric segments are present (`case 'runs': a && b && c ? <RunDetail/> : <Runs/>`), so a
> two-segment URL falls through to the unfiltered Runs list. The engine route must not repeat that:
> phase 3 adds a genuine run-level view (all jobs of one run, latest attempt of each, with their
> conclusions) **before** any review body uses the whole-run URL; until it exists, the review body
> links to the first failing job's attempt URL. Recorded as **OQ-5**.

Rules:

- **`<console>` is `PUBLIC_ORIGIN`**, the one config-derived origin — the vanity hostname when one
  is configured, else the CloudFront name ([ADR-024](../DECISIONS.md#adr-024),
  [ADR-036](../DECISIONS.md#adr-036)). It is never hardcoded: the two-pass bootstrap exists
  precisely because this value is deploy-time ([ADR-047](../DECISIONS.md#adr-047)).
- **A posted link names one attempt and is stable for the life of that attempt's row.** A re-run
  never changes what an already-posted link shows; the attempt page links forward to newer attempts.
  It survives log expiry: it lands on the attempt, which reports honestly if its logs have aged out.
- **A deep link is not an authorization bypass.** The console requires GitHub OAuth and shows only
  installations the user can admin ([ADR-022](../DECISIONS.md#adr-022)); an anonymous click from a
  public PR gets a login screen, not a run. This is the property that makes it safe to put the link
  in a public comment.

## Permissions & events

**This resolves spec 01 OQ-2** ([01 § Open questions](01-github-app.md#open-questions)): `checks:write`
**is** needed once we schedule, because the premise of the original "no" — that GitHub renders the
status — fails for a run GitHub never scheduled.

| Permission | Level | Gates | Verified endpoint |
|---|---|---|---|
| `checks` | **write** | check runs + `requested_action` | `POST`/`PATCH /repos/{o}/{r}/check-runs` |
| `pull_requests` | **write** | `COMMENT` / `REQUEST_CHANGES` reviews, review comments, superseded-body update, dismissal of our own stale `REQUEST_CHANGES` | `POST …/pulls/{n}/reviews`, `PUT …/reviews/{id}`, `PUT …/reviews/{id}/dismissals` |
| `statuses` | **write** | commit-status fallback | `POST /repos/{o}/{r}/statuses/{sha}` |
| `contents` | read *(unchanged)* | fetch workflows + checkout | — |
| `administration` | write *(unchanged; held for runner registration, [01](01-github-app.md))* | its read half: the dismissal-path check before `REQUEST_CHANGES` reads branch protection | `GET /repos/{o}/{r}/branches/{branch}/protection` (Administration read) |
| `metadata` | read *(unchanged)* | the dismissal-path check reads active rulesets | `GET /repos/{o}/{r}/rules/branches/{branch}` (Metadata read) |
| `contents` | **write — NOT requested** | merging, pushing | `PUT /repos/{o}/{r}/pulls/{n}/merge` ⇒ declined by [Q5](#the-approval-gate-q5) |

All from
[permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

| New event | Why |
|---|---|
| `pull_request` | engine trigger ([06](06-workflow-engine.md#trigger-sources--idempotency-q3)) + the PR context for reporting, including the head/base repo ids that decide trust ([06](06-workflow-engine.md#trigger-trust-forks-bots-and-re-runs)) |
| `check_run` | receives `requested_action` (the re-run button) and `rerequested` (GitHub's own "Re-run" link on our check run, sent "Only [to] the GitHub App that someone requests to re-run the check"); both go through the same re-run path, keyed by `external_id`, with the same latest-attempt rule ([Re-run](#re-run-via-requested_actions)) |
| `check_suite` *(not chosen: GitHub subscribes every App holding `checks:write` automatically)* | **acknowledged with 2xx and dropped by Ingest.** We create check runs on our own schedule, not on `check_suite.requested`, and a suite-level `rerequested` (`check_suite.rerequested`) names no attempt, so honouring it would need a whole-run re-run design (OQ-6) we do not have; the console says so on the PR view |
| `branch_protection_rule`, `repository_ruleset` | ⚠️ **not requested in v1.** Their only consumer was revoking our `APPROVE` when a branch stopped dismissing stale approvals; v1 never posts `APPROVE` ([why](#why-we-never-post-approve)). The `REQUEST_CHANGES` dismissal-path check is re-read before each POST and needs no event |
| `pull_request_review` | ⚠️ **not requested in v1.** Nothing in this design reads a human's review: verdicts reduce engine attempts only, and our own reviews are tracked by the ids our POSTs return. A use for it (deferring our advisory review to a human approval) needs state, ordering against new heads and dismissals, and tests that do not exist, so the grant waits for that design (OQ-7) |
| `issue_comment` | ⚠️ **not requested in v1** — a `/lca rerun` chatops verb is not worth a grant that reads every comment on every issue in every granted repo. The re-run button already exists |

**Least-privilege reasoning, matching ADR-031's posture:** each grant and each event maps to exactly
one surface we have decided to post or one consumer we have designed, and the table names it;
an event delivered automatically (`check_suite`) is named with what we do with it. `contents:write`
is refused by an explicit decision rather than omitted by accident, and four read events
(`issue_comment`, `pull_request_review`, `branch_protection_rule`, `repository_ruleset`) are
declined because no designed consumer needs them. Three write grants replace zero, so this **is** permission growth — an existing
installation must approve it, and until an admin does, GitHub simply withholds the new permissions.
That makes the degradation path mandatory, not theoretical: see [Failure handling](#failure-handling).

## Opt-in gates

Three independent gates, deliberately the same shape as
[ADR-031](../DECISIONS.md#adr-031)'s, because this is the same class of change — writing into a
customer's repo:

1. **Deployment flag** — `cdk deploy -c review=true`. Absent ⇒ the reporter λ is not even deployed.
2. **Per-repo toggle** — `RepoRecord.reviewEnabled` (absent ⇒ off).
3. **The App actually holds the permission** — checked at runtime, never assumed. A missing grant
   degrades; it does not throw.

Plus two feature-level toggles, off by default: `reviewRequestChanges` (else `COMMENT`),
refused by the console and degraded to `COMMENT` by the reporter when our App cannot dismiss
reviews on the target branch ([Superseding and dismissing](#superseding-and-dismissing)); and
`approvalGate`. There is deliberately no toggle for `APPROVE`
([Why we never post `APPROVE`](#why-we-never-post-approve)).

**The reporter is a control-plane λ, not the management API.** The management plane must stay
read-mostly with no App credentials ([ADR-025](../DECISIONS.md#adr-025)); the console *enqueues* an
approval decision and the control plane acts on it — exactly the split the auto-rewrite already uses
([ADR-031](../DECISIONS.md#adr-031)).

## Provider-agnostic reporting port

The reporting half of `GitHostProvider` ([06](06-workflow-engine.md#provider-abstraction)).
**Capability-declaring, so a host without a surface degrades visibly instead of silently:**

```ts
interface ReviewReporter {
  readonly caps: {
    checkRuns: boolean;          // GitHub ✓   GitLab ✗   Bitbucket ✗   Gitea ✓
    commitStatuses: boolean;     //         ✓          ✓            ✓        ✓
    inlineComments: boolean;     //         ✓          ✓            ✓        ✓
    requestChanges: boolean;     //         ✓          verified per provider in phase 5
    requestedActions: boolean;   //         ✓          ✗            ✗        ✗
  };
  openJobReport(attempt: AttemptRef, claim: EffectClaim): Promise<ReportHandle>; // one per attempt; adopts by external id first
  updateJobReport(h: ReportHandle, s: JobReportState, claim: EffectClaim): Promise<void>;
  closeJobReport(h: ReportHandle, c: JobConclusion, claim: EffectClaim, a?: Annotation[]): Promise<void>;
  submitReview(pr: PrRef, intent: ReviewIntent, claim: EffectClaim): Promise<ReviewHandle>;
                                // append-only; only under a live, holder-fenced REVIEWHEAD claim;
                                // ReviewIntent.event is 'COMMENT' | 'REQUEST_CHANGES', never an approval
  findOwnReviews(pr: PrRef): Promise<ReviewHandle[]>; // marker-bearing reviews by our App, for adoption
  findOwnReports(sha: string): Promise<ReportHandle[]>; // our check runs by external id, for adoption
  supersedeReview(h: ReviewHandle, by: ReviewHandle | AttemptRef, claim: EffectClaim): Promise<'noted' | 'dismissed' | 'dismiss-failed'>;
  canDismiss(pr: PrRef): Promise<boolean>;            // gates REQUEST_CHANGES before posting
  deepLink(ref: RunRef | AttemptRef): string;
}
```

`EffectClaim` is `{holder, fence, until}` from [Effect obligations](#effect-obligations-and-claims).
Every effecting method refuses to start when less than the protocol's margin remains on `until`,
so a provider implementation cannot quietly ignore the deadline rule.

Mapping, so the port is not GitHub's API wearing a hat:

| Concept | GitHub | GitLab | Bitbucket | Gitea |
|---|---|---|---|---|
| per-job report | check run | commit status + MR note | build status | check run |
| inline finding | annotation / review comment | MR discussion on position | PR comment (inline) | review comment |
| block merge | review `REQUEST_CHANGES` | verified in phase 5 | verified in phase 5 | review request changes |
| approve | ✗ — never posted ([why](#why-we-never-post-approve)) | ✗ | ✗ | ✗ |
| re-run button | `requested_actions` | ✗ — console only | ✗ — console only | ✗ — console only |

Where a capability is absent the reporter **says so in the surface it does have** (e.g. a GitLab MR
note carries the console link instead of a button) rather than dropping the affordance without
trace. v1 implements GitHub; Gitea is phase 5.

## Failure handling

Reporting is **best-effort and must never affect a run's outcome.** A CI platform that fails jobs
because it could not post a comment is worse than one that posts nothing.

| Failure | Behaviour |
|---|---|
| `checks:write` not granted | fall back to commit status; if that is also missing, console-only + one structured log line. **Never** fails the job |
| 403 / 404 (repo gone, App suspended) | drop the report, log with the repo + run; no retry storm |
| 422 (e.g. `head_sha` not found — force-push mid-run) | drop; the sha we judged no longer exists, so the report would be misleading anyway |
| Review submitted but `reviewId` not recorded (crash) | the next reporter loop lists the PR's reviews and adopts every one carrying an `lca-review:v1 … intent=<intentId>` marker not yet recorded; the claimed intent's own review is recorded, any other gets a cleanup obligation. Never adopts an earlier verdict's review as a later one |
| Reporter stalls past its claim, another takes over, the first resumes | the first can record nothing (its `holder`/`fence` no longer match) and cannot start a new effect (its deadline check fails); the taker observes the PR for the first's POST before posting. A duplicate needs GitHub to accept a request after its own 10 s timeout; if one appears it is adopted, withdrawn and alarmed ([protocol](#effect-obligations-and-claims)) |
| Stale intent reaches the reporter | its claim fails (it is not `latestIntentId`); the intent is set `skipped` and nothing is posted |
| Verdict evaluated while a workflow of the same delivery is still being planned | nothing is written: the delivery's batch is not sealed ([06 § Trigger batch](06-workflow-engine.md#trigger-batch)) |
| Every batch for the head sealed with no member (no `.lca/workflows`, or no filter matched) | `no-runs`: no intent, no review; the console says no engine workflow matched |
| Crash after a refusal is recorded, before its check run is posted | the refusal's `REPORT` is `REPORTS#pending`; the Reaper re-drives it and the observe step adopts a check run that did land |
| Surplus check run under one job name (anomaly, or a re-run) | renamed out of the name before the new one is created; if the rename is refused, concluded `cancelled`, never `neutral` ([Check-run names](#check-run-names-one-authority-per-name)) |
| Crash after `submittedIntentId` moved | impossible to strand: the pointer move and the old intent's `CLEANUP#` row are one transaction, and the Reaper sweeps `REVIEWCLEANUP#pending` |
| Crash before an approval check run is created | the `GATE` item is `GATES#open` with a report owed; the Reaper re-drives it, and the held job is never invisible |
| Dismissal of our stale `REQUEST_CHANGES` refused | intent marked `dismiss-failed`, named in the new review's body and on the console repo page; no retry loop |
| Secondary rate limit | exponential backoff on the reporter queue; run outcomes already persisted, so a late report is a late *display*, not lost data |
| Console origin unknown | omit `details_url` rather than emit a broken link |

**Ordering matters and is enforced:** the run row is written **before** the report is attempted, so
the console is authoritative and the PR surface is a projection of it. A report can therefore be
retried or replayed; it can never be the only record.

## Open questions

- **OQ-1**: Does a GitHub **App's** `APPROVE` satisfy a *required approving review*? **NOT STATED**
  in the docs (the reviews API lists only the vocabulary; protected branches speaks of "reviewers
  with write permissions"). **Closes when** observed against a repo with required reviews on a plan
  that allows them. Nothing in v1 depends on the answer: we never post `APPROVE`
  ([above](#why-we-never-post-approve)). It matters only to OQ-8.
- **OQ-2**: One check run per job attempt, or one per run with a step table? v1 is per attempt
  (annotations are file-scoped, and an attempt owns a conclusion). **Closes when** a real repo with a 30-job matrix shows
  whether 30 checks is signal or noise — GitHub caps a suite at 1000 same-named check runs, so the
  limit is UX, not API.
- **OQ-3**: Should a refusal post a `neutral` check run on repos in `label`/`adopt` mode too?
  Refusals exist there today and are console-only ([ADR-050](../DECISIONS.md#adr-050)). Additive;
  needs a noise judgement. **Closes when** the Unclaimed screen shows whether operators find
  refusals without a PR nudge.
- **OQ-4**: `issue_comment` chatops (`/lca rerun`). Declined in v1 on read-radius grounds.
  **Closes when** a customer asks and accepts the grant.
- **OQ-5**: The **whole-run console route** does not exist, and the shipped two-segment
  `#/runs/{repoId}/{runId}` falls through to the Runs list ([above](#deep-link-contract)). **Closes
  when** phase 3 adds `#/eruns/{repoKey}/{runId}`; until then review bodies link to the first
  failing job's attempt URL. This is console work,
  not reporting work, and it is the one prerequisite spec 07 has on the SPA.
- **OQ-6**: Suite-level "Re-run all checks" (`check_suite.rerequested`). Acknowledged and dropped
  in v1 ([Permissions & events](#permissions--events)). **Closes when** a whole-run re-run is designed (every job's
  latest attempt in one allocation, [06 § Re-run allocation](06-workflow-engine.md#re-run-allocation)).
- **OQ-7**: `pull_request_review`, to let our advisory review defer to a human's. Not requested in
  v1. **Closes when** a design states what "defer" means (suppress our `REQUEST_CHANGES`, or only
  annotate), the durable state it reads, its ordering against a new
  head sha and against a human's review being dismissed, and the tests for each race.
- **OQ-8**: An `APPROVE` that carries real authority. v1 never posts one, because every CI result
  on a PR is produced by code its author controls ([Why we never post `APPROVE`](#why-we-never-post-approve)).
  **Closes when** a design names an approval signal the PR's author cannot influence (for example
  a control-plane policy evaluated over the diff without executing head code, or a recorded
  approval of this head by an installation admin who is not the pusher), states whether OQ-1's
  answer makes the review count, re-adds `branch_protection_rule`/`repository_ruleset` only with
  a consumer, and passes the adversarial same-repository fixtures the roadmap lists for phase 4
  (unchanged workflow with weakened tests, a changed build script, and a docker-flavor root step
  forging its own result), each of which must still produce no `APPROVE`.
