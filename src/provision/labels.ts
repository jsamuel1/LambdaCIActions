/**
 * Runner-label preparation for JIT registration (M5, ADR-030).
 *
 * GitHub assigns a job to a runner only when the runner carries **every** label in the job's
 * `runs-on` (labels are cumulative — GitHub docs, "Using self-hosted runners in a workflow").
 * So the JIT config we mint must advertise the job's own label set, whatever it says:
 *
 *   - `label` mode  → `[self-hosted, lambda-ci-node]` (verified working since M1).
 *   - `adopt` mode  → `[ubuntu-latest]` — the whole point of zero-edit adoption is that the
 *     workflow still says `ubuntu-latest`, so the runner has to answer to that label.
 *
 * Pure — no I/O.
 *
 * ## Known risk (adopt mode)
 *
 * GitHub reserves its hosted-runner label names on some registration paths, and a
 * `generate-jitconfig` call carrying `ubuntu-latest` may be rejected with an HTTP 422. That
 * is a **deterministic** failure, not a transient one, so `classifyMintFailure` below exists
 * to stop it from burning SQS retries and to surface an actionable reason on the run instead
 * of a generic "launch failed". Whether the current GitHub API accepts the label is recorded
 * as an open verification item in ADR-030 — it must be confirmed against a real repo before
 * adopt mode is advertised as GA.
 */

/**
 * Labels GitHub assigns to a self-hosted runner automatically from the machine itself
 * (docs: "Using default labels to route jobs") — `self-hosted`, `linux`, `arm64` and friends.
 *
 * We do NOT enumerate them in a constant: `jitRunnerLabels` passes the job's `runs-on` set
 * through verbatim, and GitHub adds its own defaults at registration. A hardcoded list here
 * would only invite a future caller to inject labels the job never asked for.
 */

/**
 * Hard cap on labels we send, so a pathological `runs-on` can't build a giant request.
 *
 * The cap is a REFUSAL boundary, not a truncation point — see `TooManyRunnerLabelsError`.
 */
export const MAX_JIT_LABELS = 20;

/**
 * Thrown when a job's `runs-on` normalizes to NOTHING we can advertise.
 *
 * `jitRunnerLabels` drops unresolved `${{ … }}` expressions (they are not labels), so a job
 * whose selector is ENTIRELY expression-driven — `runs-on: ${{ matrix.os }}`, or
 * `runs-on: ["${{ matrix.os }}"]` — yields an empty set. Minting with an empty `labels` array
 * is the worst possible outcome: GitHub accepts it, the runner comes up carrying only its
 * automatic defaults (`self-hosted`, `linux`, `ARM64`), and those cannot satisfy the job's
 * real selector. The microVM boots, burns the single-use JIT config, matches nothing, and
 * idles until the Reaper kills it — paying for a VM that could never take the job.
 *
 * So this is a PERMANENT, pre-mint refusal: the run is failed with an actionable reason
 * before anything irreversible happens.
 */
export class NoRunnerLabelsError extends Error {
  constructor(labels: string[]) {
    super(
      "this job's runs-on resolves to no usable runner label " +
        `(got ${JSON.stringify(labels)}): every entry is an unresolved expression. ` +
        'Fix: add a literal LCA label alongside the matrix expression ' +
        '(e.g. `runs-on: [self-hosted, lambda-ci, "${{ matrix.os }}"]`), or set the matrix ' +
        'values to literal labels.',
    );
    this.name = 'NoRunnerLabelsError';
  }
}

/**
 * Thrown when a job's normalized label set exceeds `MAX_JIT_LABELS`.
 *
 * This used to TRUNCATE at the cap, which is the same class of bug as minting with an empty
 * set — and quieter. `decideClaim` claims on the FULL webhook label set, so a job whose LCA
 * label sits past position 20 (`[l1 … l20, lambda-ci]`) is claimed, and the truncated mint
 * then registers a runner that does not advertise `lambda-ci`. GitHub matches cumulatively,
 * so the job it was claimed for can never be assigned to it: the VM boots, burns the
 * single-use JIT config, matches nothing, and idles until the Reaper — while Provision has
 * already stamped the run `running`, so the console shows a healthy run that will never move.
 *
 * Refusing pre-mint keeps the failure loud, free (no VM launched) and actionable.
 */
export class TooManyRunnerLabelsError extends Error {
  constructor(labels: string[]) {
    super(
      `this job's runs-on carries more runner labels than we can register ` +
        `(${labels.length} after normalization, max ${MAX_JIT_LABELS}). ` +
        'A runner must advertise EVERY label in runs-on, so we cannot drop any of them: ' +
        `dropping one silently would launch a microVM the job can never be assigned to. ` +
        `Fix: reduce this job's runs-on to at most ${MAX_JIT_LABELS} labels.`,
    );
    this.name = 'TooManyRunnerLabelsError';
  }
}

/**
 * Normalize a job's `runs-on` into the label set the JIT runner should advertise: trimmed,
 * de-duplicated case-insensitively (GitHub labels are case-insensitive), and unresolved matrix
 * expressions dropped (`${{ matrix.os }}` is not a label — sending it verbatim would create
 * a junk label that matches nothing).
 *
 * Order is preserved (first occurrence wins) so logs read like the workflow.
 *
 * NOT capped here: the whole set is returned so the caller can REFUSE an over-cap job
 * (`TooManyRunnerLabelsError`) rather than mint a runner missing a required label.
 */
export function jitRunnerLabels(jobLabels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of jobLabels ?? []) {
    const label = String(raw).trim();
    if (!label) continue;
    if (label.includes('${{')) continue; // unresolved expression, not a real label
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/** Whether a mint failure is permanent (retrying cannot help) or worth a redelivery. */
export type MintFailureKind = 'permanent' | 'transient';

export interface MintFailureClassification {
  kind: MintFailureKind;
  /** Operator-facing reason persisted on the run row + shown in the console. */
  reason: string;
}

/**
 * Classify a `generate-jitconfig` failure.
 *
 * A 4xx other than 429 is the repo/App/labels being wrong — the same request will fail
 * forever, so we record an actionable failure instead of retrying into the DLQ. 429 (rate
 * limit) and 5xx are transient.
 *
 * `labels` is used only to make the message actionable when GitHub rejects a hosted label
 * in adopt mode, which is the one failure an operator can actually fix (switch the repo to
 * `label` mode, or use the auto-rewrite PR).
 */
export function classifyMintFailure(
  message: string,
  labels: string[] = [],
): MintFailureClassification {
  // Our own pre-mint refusals (no usable labels / too many labels) never reach GitHub, so they
  // carry no HTTP status and would otherwise be misread as transient network errors and
  // retried forever.
  if (
    message.includes('runs-on resolves to no usable runner label') ||
    message.includes('runs-on carries more runner labels than we can register')
  ) {
    return { kind: 'permanent', reason: message };
  }
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  const code = status ? Number(status) : undefined;
  const transient = code === undefined || code === 429 || code >= 500;

  if (transient) {
    return { kind: 'transient', reason: `JIT registration failed (retrying): ${message}` };
  }

  const hostedLabel = labels.find((l) => /^(ubuntu|windows|macos)[-.]/i.test(l.trim()) || /^ubuntu-latest$/i.test(l.trim()));
  if (code === 422 && hostedLabel) {
    return {
      kind: 'permanent',
      reason:
        `GitHub rejected the runner labels for this job (HTTP 422). The label '${hostedLabel}' ` +
        'is a GitHub-hosted runner label and cannot be registered on a self-hosted runner, so ' +
        "adopt mode cannot claim this repo's jobs as-is. Fix: switch the repo to `label` mode " +
        'and add an LCA label (or open the auto-rewrite PR from the console).',
    };
  }

  return { kind: 'permanent', reason: `JIT registration rejected by GitHub: ${message}` };
}
