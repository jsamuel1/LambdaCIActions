import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };
import type { RepoMode } from '../shared/types.js';

/**
 * Claim-refusal classification (ADR-049).
 *
 * Every path in Ingest that answers a `workflow_job.queued` webhook with `claimed: false`
 * comes through here, so a refusal has exactly one machine-readable shape regardless of which
 * gate produced it. The reason string alone was not enough: it was computed, returned in the
 * 202 body — which GitHub discards — and then dropped, so the ONE refusal an operator actually
 * hits (an `lambda-ci-*` label that is not in the live `/lca/<env>/config/runner-labels`
 * allowlist) left no trace in CloudWatch, no run row, and nothing in the console. Eight PRs sat
 * `QUEUED` for ~7 h with no error anywhere.
 *
 * Two decisions live in this module, and both exist to stop the fix from becoming noise:
 *
 * 1. **Is this refusal ACTIONABLE?** An adopt-mode-off repo answering `ubuntu-latest` jobs with
 *    "no LCA label" is the normal, high-volume steady state of an un-onboarded repo — logging
 *    each one at info level and writing a row per job would bury the real misconfiguration. A
 *    refusal is actionable when the job carries evidence that someone MEANT it to run here: an
 *    LCA-shaped label (see `lcaShapedLabel`), which in the allowlist-miss case is precisely the
 *    label the operator forgot to allowlist.
 * 2. **What is the stable code?** `reason` is operator-facing prose and may be reworded;
 *    `RefusalCode` is the machine tag the console filters on and the log line carries.
 *
 * Pure — no I/O — so the classification, the noise split and the persisted row's shape are all
 * unit-testable without AWS.
 */

/** Catalog labels, lower-cased. A job carrying one of these asked for LambdaCIActions by name. */
const CATALOG_LABELS: ReadonlySet<string> = new Set(
  (flavorsCatalog as { flavors: { label: string }[] }).flavors.map((f) => f.label.toLowerCase()),
);

/**
 * Prefix every built-in routing label shares (`lambda-ci`, `lambda-ci-node`, …).
 *
 * Pinned by `test/refusal.test.mjs` against the catalog rather than derived from it at runtime:
 * the "did the operator mean us?" heuristic below rests on this prefix, and a catalog entry that
 * stopped sharing it would silently widen or narrow the heuristic. A test failure is the right
 * place to notice that, not a module-load throw inside a webhook Lambda.
 */
const LCA_LABEL_PREFIX = 'lambda-ci';

/**
 * Whether a `runs-on` label LOOKS like it was meant for LambdaCIActions.
 *
 * Deliberately wider than the live allowlist, because that is the entire point: the label that
 * strands a job is by definition NOT in the allowlist, so an allowlist-derived predicate would
 * classify the bug as ordinary noise. Two signals:
 *   - the label is in the built-in flavor catalog (`lambda-ci-python` when only `lambda-ci`,
 *     `lambda-ci-node`, `lambda-ci-docker` are allowlisted — the live SauhsojVideo case), or
 *   - the label starts with `lambda-ci` (a typo, or a flavor label from a newer catalog than
 *     the deployment).
 *
 * Residual gap, deliberate: an operator's own custom allowlist label (`my-runner`) that is
 * later REMOVED from the allowlist is not LCA-shaped by either signal, so its refusals stay in
 * the sampled/no-row lane. It is indistinguishable from a job targeting a foreign self-hosted
 * fleet — `runs-on: [self-hosted, gpu]` must NOT become an error in every repo — and the fix is
 * to name custom labels with the `lambda-ci` prefix. Recorded in ADR-049.
 */
export function lcaShapedLabel(label: string): boolean {
  const l = label.trim().toLowerCase();
  if (!l) return false;
  return CATALOG_LABELS.has(l) || l === LCA_LABEL_PREFIX || l.startsWith(`${LCA_LABEL_PREFIX}-`);
}

/** Every LCA-shaped label on a job, lower-cased, first-seen order, de-duplicated. */
export function lcaShapedLabels(jobLabels: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of jobLabels) {
    const l = raw.trim().toLowerCase();
    if (!l || !lcaShapedLabel(l)) continue;
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

/**
 * Stable machine tag for a refusal. Ordered roughly by how much operator attention it deserves.
 *
 * - `label-not-allowlisted` — the bug this ADR exists for. The job names an LCA-shaped label
 *   that the LIVE allowlist parameter does not contain, so `decideClaim` refuses before routing
 *   ever runs and the job queues forever with no error.
 * - `incompatible-label` — a Windows/macOS/x86 label we refuse in every mode (`decideClaim`).
 * - `repo-disabled` — `enabled: false` or `mode: 'off'` on the repo row.
 * - `runner-group` — `runs-on: { group: … }` naming a non-default runner group (ADR-030).
 * - `compat-block` — the stored analysis says the job cannot run here (spec 03).
 * - `no-lca-label` — label mode, no LCA label. The normal state of an un-onboarded repo.
 * - `no-standard-label` — adopt mode, no standard hosted label (e.g. `[self-hosted, gpu]`,
 *   which targets someone else's fleet and must not be hijacked).
 */
export type RefusalCode =
  | 'label-not-allowlisted'
  | 'incompatible-label'
  | 'repo-disabled'
  | 'runner-group'
  | 'compat-block'
  | 'no-lca-label'
  | 'no-standard-label';

/** Log severity for a refusal. `info` is operator-visible; `debug` is the sampled noise lane. */
export type RefusalLevel = 'info' | 'debug';

export interface RefusalClassification {
  code: RefusalCode;
  level: RefusalLevel;
  /**
   * Whether this refusal is worth an operator's attention: it is logged in full AND persisted
   * so the console can show it. False ⇒ the expected steady state of a repo that has not
   * onboarded these jobs; logged at debug and never written to the table.
   */
  actionable: boolean;
  /** LCA-shaped labels found on the job (the ones an allowlist is probably missing). */
  lcaLabels: string[];
  /** Operator-facing remedy, present on every actionable code. */
  fix?: string;
}

/** Inputs the classification needs. `gate` is which refusal branch fired. */
export interface RefusalInput {
  /** Which Ingest gate refused. `claim` = `decideClaim`, the rest are the sibling gates. */
  gate: 'claim' | 'repo-disabled' | 'runner-group' | 'compat-block';
  jobLabels: readonly string[];
  /** The LIVE allowlist snapshot (`/lca/<env>/config/runner-labels`). */
  claimedLabels: readonly string[];
  mode?: RepoMode;
  /** `decideClaim`'s reason, used only to distinguish its sub-cases. */
  reason?: string;
  /** Non-default runner group, for the `runner-group` gate. */
  group?: string | null;
}

function lower(labels: readonly string[]): string[] {
  return labels.map((l) => l.trim().toLowerCase()).filter(Boolean);
}

/**
 * Classify a refusal into a stable code + whether it deserves operator attention.
 *
 * The `claim` gate needs sub-classification because `decideClaim` returns one boolean for three
 * very different situations, and only one of them is a misconfiguration:
 *   - an incompatible (Windows/macOS/x86) label — refused in every mode;
 *   - an LCA-shaped label that is not in the live allowlist — THE bug;
 *   - no LCA label at all — the normal un-onboarded state.
 *
 * The sub-case is derived from the LABELS, not by parsing `decideClaim`'s prose: the reason
 * string is operator-facing and reworded freely, so matching on it would make this
 * classification silently wrong the next time it is edited.
 */
export function classifyRefusal(input: RefusalInput): RefusalClassification {
  const jobLabels = lower(input.jobLabels);
  const allowlist = new Set(lower(input.claimedLabels));
  const lcaLabels = lcaShapedLabels(jobLabels);
  /**
   * LCA-shaped labels the live allowlist does not carry. Non-empty means the operator asked
   * for LambdaCIActions by name and the control plane cannot honour it — actionable in EVERY
   * gate, because the same evidence of intent applies whichever gate refused.
   */
  const unlisted = lcaLabels.filter((l) => !allowlist.has(l));
  const intent = lcaLabels.length > 0;

  switch (input.gate) {
    case 'repo-disabled':
      return {
        code: 'repo-disabled',
        // A labelled job in a repo someone switched off is a contradiction worth surfacing;
        // an unlabelled job in a disabled repo is exactly what "off" is supposed to look like.
        level: intent ? 'info' : 'debug',
        actionable: intent,
        lcaLabels,
        ...(intent
          ? {
              fix:
                'The job carries an LCA label but the repo is disabled (or mode=off). Re-enable ' +
                'the repo in the console, or remove the label from the workflow.',
            }
          : {}),
      };
    case 'runner-group':
      return {
        code: 'runner-group',
        level: 'info',
        actionable: true,
        lcaLabels,
        fix:
          `runs-on names runner group '${input.group ?? ''}'. LambdaCIActions registers runners ` +
          'in the repository default group only — move the job to the default group.',
      };
    case 'compat-block':
      return {
        code: 'compat-block',
        level: 'info',
        actionable: true,
        lcaLabels,
        fix: 'Compatibility analysis blocked this job. See the workflow in the console for the findings.',
      };
    case 'claim':
    default:
      break;
  }

  // `decideClaim` sub-cases, in the same precedence order the gate itself applies.
  const incompatible = jobLabels.some((l) => INCOMPATIBLE_HINT.test(l));
  if (incompatible) {
    return {
      code: 'incompatible-label',
      // `[ubuntu-latest, windows-latest]` in an adopt repo is a normal cross-platform matrix;
      // `[lambda-ci, windows-latest]` is a mistake, because it asked for us BY NAME and we
      // cannot serve it. Only the second is surfaced.
      level: intent ? 'info' : 'debug',
      actionable: intent,
      lcaLabels,
      ...(intent
        ? {
            fix:
              'The job requests a Windows/macOS/x86 runner and an LCA label. LambdaCIActions is ' +
              'arm64 Linux only — split the job, or drop the LCA label from the x86/non-Linux leg.',
          }
        : {}),
    };
  }

  if (unlisted.length > 0) {
    return {
      code: 'label-not-allowlisted',
      level: 'info',
      actionable: true,
      lcaLabels,
      fix:
        `Add ${unlisted.join(', ')} to /lca/<env>/config/runner-labels (and confirm the flavor's ` +
        'image is published) — the label is not in the live allowlist, so the job can never be claimed.',
    };
  }

  if (input.mode === 'adopt') {
    return { code: 'no-standard-label', level: 'debug', actionable: false, lcaLabels };
  }
  return { code: 'no-lca-label', level: 'debug', actionable: false, lcaLabels };
}

/**
 * Labels that make a job unrunnable here, as a shape test for CLASSIFICATION only.
 *
 * `decideClaim`/`incompatibleRunnerLabel` remain the authority on whether to refuse — this only
 * decides which bucket an already-refused job goes in, so a prefix/word test is adequate and
 * cannot change a claim outcome.
 */
const INCOMPATIBLE_HINT = /^(windows|macos)|^(x64|x86|x86_64|x86-64|amd64|i386|i686)$/;
