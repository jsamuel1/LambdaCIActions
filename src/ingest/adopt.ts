import type { RepoMode } from '../shared/types.js';

/**
 * Adopt mode — standard-label mapping (spec 03 § Onboarding modes, ADR-030, M5).
 *
 * `label` mode requires a one-line YAML edit per job (`runs-on: [self-hosted, lambda-ci]`).
 * `adopt` mode is the **zero-edit** path: a repo whose workflows still say
 * `runs-on: ubuntu-latest` is claimed as-is, and routing maps the standard GitHub-hosted
 * label onto a flavor.
 *
 * Pure — no I/O — so both the claim decision and the label map are unit-testable. The
 * per-repo `mode` comes from the repo row (written by the console, spec 04) and is read by
 * Ingest before the claim decision.
 *
 * ## Why this is opt-in per repo, not the default
 *
 * Claiming `ubuntu-latest` means intercepting jobs the repo never asked us to run. Two
 * consequences the operator must accept deliberately:
 *   - **arm64.** GitHub's `ubuntu-*` runners are x86_64; ours are Graviton (ADR-007). A job
 *     that silently depended on x86 breaks. Compat analysis flags what it can see, but
 *     `arch_hints` are heuristics.
 *   - **All-or-nothing per repo.** GitHub's runner matching is by label set, so we cannot
 *     take *some* `ubuntu-latest` jobs and leave the rest on GitHub-hosted.
 *
 * Default on install stays `label` (spec 03; the UI nudges toward `adopt` once compat is
 * green).
 */

/**
 * GitHub-hosted runner labels we recognize in adopt mode, mapped to the flavor a job gets
 * when nothing more specific matches.
 *
 * Per spec 03 OQ-3 the mapping is deliberately **signal-driven**: every standard label maps
 * to `base`, and the resolver's existing signal-upgrade step (spec 03 routing step 4) moves
 * to `docker` when the parsed steps need it. Encoding `node` here instead
 * would guess from the label, which carries no such information — GitHub's `ubuntu-latest`
 * image happens to ship Node, but a job that needs it says so in its steps.
 *
 * `ubuntu-20.04` is included because a repo can still carry it in an old workflow; the job
 * gets the same arm64 `base` flavor (we do not emulate old distro images — ADR-007).
 */
export const ADOPT_LABEL_FLAVORS: Readonly<Record<string, string>> = Object.freeze({
  'ubuntu-latest': 'base',
  'ubuntu-24.04': 'base',
  'ubuntu-22.04': 'base',
  'ubuntu-20.04': 'base',
});

/** Every standard label adopt mode claims, lowercased. */
const ADOPT_LABELS = new Set(Object.keys(ADOPT_LABEL_FLAVORS));

/**
 * Non-Linux hosted labels. We must NEVER claim these in ANY mode: we only run arm64 Linux, so
 * claiming a `windows-latest` job would strand it (compat analysis marks it `block`, but the
 * claim decision must not depend on an analysis being present — it fails open by design).
 *
 * Exported because the auto-rewrite planner (ADR-031) needs the same predicate: rewriting a
 * mixed selector like `[ubuntu-latest, windows-latest]` would produce a job that `decideClaim`
 * refuses AND that GitHub-hosted can no longer take (we added `self-hosted`), i.e. one that
 * queues forever.
 */
export function nonLinuxHostedLabel(label: string): boolean {
  const l = label.toLowerCase();
  return l.startsWith('windows') || l.startsWith('macos');
}

/**
 * Architecture labels that assert x86. Refused in EVERY mode for the same reason as the
 * non-Linux labels: microVMs are Graviton-only (ADR-007), so `runs-on: [self-hosted, linux,
 * x64, lambda-ci]` is a job that cannot run here.
 *
 * GitHub's runner matching is purely declarative — a runner is assigned a job when it
 * advertises every requested label. Passing `x64` through to `generate-jitconfig` therefore
 * mints an arm64 runner that CLAIMS to be x86, and the job executes on the wrong architecture
 * instead of staying queued for a runner that could actually serve it. Refusing the claim
 * leaves the job with GitHub-hosted / the repo's own x86 fleet, which is the correct outcome.
 *
 * Only exact arch tokens are listed. A substring test would catch unrelated custom labels
 * (`x64-cache-warmer`), and `arm64`/`aarch64` are deliberately absent — those are true of us.
 */
const X86_ARCH_LABELS = new Set(['x64', 'x86', 'x86_64', 'x86-64', 'amd64', 'i386', 'i686']);

/**
 * Whether a `runs-on` label asserts an x86 architecture (case-insensitive, exact token).
 *
 * Exported for the same reason as `nonLinuxHostedLabel`: the auto-rewrite planner (ADR-031)
 * must not add an LCA label to a job whose selector demands x86, because that produces a
 * selector `decideClaim` refuses and GitHub-hosted can no longer serve — a job that queues
 * forever.
 */
export function x86ArchLabel(label: string): boolean {
  return X86_ARCH_LABELS.has(label.trim().toLowerCase());
}

/**
 * Any label that makes a job unrunnable on an arm64 Linux microVM, in every mode.
 * Returns the offending label (for the operator-facing reason) or undefined.
 */
export function incompatibleRunnerLabel(
  labels: string[],
): { label: string; why: string } | undefined {
  for (const raw of labels) {
    const l = raw.trim().toLowerCase();
    if (!l) continue;
    if (nonLinuxHostedLabel(l)) {
      return { label: l, why: 'is not a Linux runner label' };
    }
    if (x86ArchLabel(l)) {
      return { label: l, why: 'requires an x86 runner' };
    }
  }
  return undefined;
}

/** Whether a single `runs-on` label is one adopt mode maps (case-insensitive). */
export function isAdoptLabel(label: string): boolean {
  return ADOPT_LABELS.has(label.trim().toLowerCase());
}

/**
 * The flavor an adopt-mode label maps to, or undefined when the label isn't a standard
 * hosted label we recognize.
 */
export function adoptFlavorForLabel(label: string): string | undefined {
  const key = label.trim().toLowerCase();
  // Own-property check: a bare `ADOPT_LABEL_FLAVORS[key]` lookup resolves inherited keys, so a
  // job labelled `constructor` / `toString` returned a FUNCTION from a signature that promises
  // `string | undefined`. Downstream `byName()` rejected it, so nothing routed wrong — but the
  // same shape as `in` did make `rewriteTargets` disagree with the claim gate.
  return Object.prototype.hasOwnProperty.call(ADOPT_LABEL_FLAVORS, key)
    ? ADOPT_LABEL_FLAVORS[key]
    : undefined;
}

/**
 * Whether a parsed job's runner GROUP puts it out of reach.
 *
 * `runs-on: { group: X, labels: […] }` requires a runner that is in group X *and* carries the
 * labels; we register JIT runners into the repo-level default group only
 * (`runner_group_id: 1`, spec 01 OQ-1). Ingest refuses to claim such a job (ADR-030), so every
 * predicate that PREDICTS a claim — the console's `adoptCandidate` count and the auto-rewrite
 * planner's target list — has to agree, or the console advertises jobs adopt mode will always
 * refuse and the rewrite PR edits a job that still cannot run.
 *
 * `null`/absent (any non-object `runs-on`) and an explicit `default` are fine.
 */
export function unreachableRunnerGroup(group: string | null | undefined): boolean {
  const g = (group ?? '').trim().toLowerCase();
  return g !== '' && g !== 'default';
}

/** How a job came to be claimed — recorded on the run + logged for support. */
export type ClaimVia = 'label' | 'adopt';

export interface ClaimDecision {
  claim: boolean;
  /** Which rule decided (only meaningful when `claim` is true). */
  via?: ClaimVia;
  /** Operator-facing reason, always set (explains a refusal too). */
  reason: string;
}

/**
 * Decide whether to claim a `workflow_job`, given the repo's onboarding mode.
 *
 * Precedence:
 *   1. **Labels we cannot honor are refused first, in every mode.** A `windows-latest` job
 *      cannot run on an arm64 Linux microVM, and neither can an `x64`/`amd64` one — claiming
 *      either strands the job (GitHub assigns it to us and then nothing can execute it) or,
 *      worse for the arch case, runs it on the wrong architecture, because GitHub matches
 *      runners on advertised labels alone. This must sit ABOVE the explicit-label rule: a job
 *      labelled `[windows-latest, lambda-ci]` or `[x64, lambda-ci]` is a mistake in the
 *      workflow, not consent, and the compat gate that would otherwise catch it fails open by
 *      design (ADR-030).
 *   2. An explicit LCA label wins over adopt mode (a repo in adopt mode that ALSO labels a job
 *      explicitly is honored as a `label` claim — the operator asked for it by name).
 *   3. Only then does adopt mode widen the net to standard hosted labels.
 *
 * `mode` is the repo row's value; `undefined` means "no row / not configured" and is
 * treated as `label`, matching spec 03's fail-open default. Callers still enforce
 * `off`/`enabled=false` separately (`isRepoOptedOut`) — this function does not re-check
 * them so the two gates stay independently testable.
 */
export function decideClaim(params: {
  jobLabels: string[];
  claimedLabels: string[];
  mode?: RepoMode;
}): ClaimDecision {
  const jobLabels = (params.jobLabels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const claims = new Set(params.claimedLabels.map((l) => l.trim().toLowerCase()).filter(Boolean));

  // Refuse anything that isn't arm64-Linux-shaped, in EVERY mode and before any claim rule.
  const bad = incompatibleRunnerLabel(jobLabels);
  if (bad) {
    return {
      claim: false,
      reason: `'${bad.label}' ${bad.why} (LambdaCIActions runs arm64 Linux only)`,
    };
  }

  const explicit = jobLabels.find((l) => claims.has(l));
  if (explicit) {
    return { claim: true, via: 'label', reason: `explicit LCA label '${explicit}'` };
  }

  if (params.mode !== 'adopt') {
    return { claim: false, reason: 'no LCA label (repo is in label mode)' };
  }

  const standard = jobLabels.find((l) => ADOPT_LABELS.has(l));
  if (standard) {
    return { claim: true, via: 'adopt', reason: `adopt mode: standard label '${standard}'` };
  }

  // A self-hosted-only job in an adopt-mode repo is left alone: `runs-on: [self-hosted, gpu]`
  // targets someone else's runner fleet, and claiming it would hijack their jobs.
  return { claim: false, reason: 'adopt mode: no standard GitHub-hosted label on the job' };
}
