/**
 * Auto-rewrite planner (spec 03 § Auto-rewrite, ADR-031, M5).
 *
 * Produces the patch that adds LCA labels to a repo's workflows:
 *
 *   jobs:
 *     build:
 *   -    runs-on: ubuntu-latest
 *   +    runs-on: [self-hosted, lambda-ci]
 *
 * PURE — no GitHub calls, no AWS. The management API renders the plan as a dry-run diff, and
 * (only when both the deployment flag and the per-repo opt-in are on) turns it into a branch
 * + PR. Never a direct push, never a force-push.
 *
 * ## Why a line-level text edit, not a YAML round-trip
 *
 * Re-serializing with js-yaml would produce a diff touching the whole file: comments dropped,
 * quoting and key order normalized, anchors expanded. That is unreviewable, and this patch is
 * meant to be read by the repo's owners. So the rewriter edits ONLY the `runs-on:` lines it
 * is confident about and leaves every other byte untouched.
 *
 * The tradeoff is coverage: shapes it cannot rewrite safely (block sequences, matrix
 * expressions, runner-group objects) are reported as `skipped` with a reason so the console
 * can tell the operator what to hand-edit, instead of guessing and corrupting a workflow.
 */
import { isAdoptLabel, nonLinuxHostedLabel } from '../ingest/adopt.js';
import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };

interface FlavorLabel {
  name: string;
  label: string;
}
const FLAVORS: FlavorLabel[] = (flavorsCatalog as { flavors: FlavorLabel[] }).flavors;

/** LCA routing labels, lowercased — a job already carrying one needs no rewrite. */
const LCA_LABELS = new Set(FLAVORS.map((f) => f.label.toLowerCase()));

/** The routing label for a flavor name (`base` → `lambda-ci`). */
export function labelForFlavor(flavor: string): string | undefined {
  return FLAVORS.find((f) => f.name === flavor)?.label;
}

export interface RewriteEdit {
  /** Job id whose `runs-on` was rewritten. */
  jobId: string;
  /** 1-based line number in the original file. */
  line: number;
  before: string;
  after: string;
}

export interface RewriteSkip {
  jobId: string;
  reason: string;
}

export interface FileRewrite {
  path: string;
  /** Full rewritten file content. Absent when nothing changed. */
  content?: string;
  edits: RewriteEdit[];
  skipped: RewriteSkip[];
  /** Unified diff of this file (empty when there are no edits). */
  diff: string;
}

/** A job the caller wants rewritten, plus the flavor routing decided for it. */
export interface RewriteTarget {
  jobId: string;
  /** Flavor name (`base` / `node` / `docker`) — its label is what gets inserted. */
  flavor: string;
}

/** `runs-on: <value>` on a single line, capturing indent + inline comment. */
const RUNS_ON_RE = /^(\s*)runs-on:[ \t]*(.*?)[ \t\r]*$/;

/** A `key:` line that starts a mapping (used to find job blocks). */
const KEY_RE = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/;

/**
 * Split a workflow into lines WITHOUT losing CRLF.
 *
 * Workflow files committed from Windows checkouts are CRLF, and a naive `split('\n')` leaves a
 * trailing `\r` on every line — which made `RUNS_ON_RE` miss the selector entirely and every
 * such job report as "no single-line runs-on found". We split on the terminator, remember it
 * per line, and re-attach it when joining, so a CRLF file stays CRLF byte-for-byte.
 */
function splitLines(text: string): { lines: string[]; endings: string[] } {
  const lines: string[] = [];
  const endings: string[] = [];
  const re = /\r\n|\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push(text.slice(last, m.index));
    endings.push(m[0]);
    last = m.index + m[0].length;
  }
  lines.push(text.slice(last));
  endings.push('');
  return { lines, endings };
}

function joinLines(lines: string[], endings: string[]): string {
  return lines.map((l, i) => l + (endings[i] ?? '')).join('');
}

/**
 * Locate the `runs-on:` line for each job id.
 *
 * Scanner rather than a YAML walk because we need LINE NUMBERS in the original text, which a
 * parsed tree does not carry (js-yaml 5.x exposes no position info for scalars).
 *
 * Strategy: find the top-level `jobs:` key, then treat every key at the next indent level as
 * a job id. Within a job block, the job's OWN keys all sit at one fixed indent (YAML siblings
 * share a column), so we learn that column from the block's first key and accept `runs-on:`
 * ONLY there.
 *
 * The indent equality is load-bearing, not tidiness. Taking the first `runs-on:` at ANY deeper
 * indent matches things that are not the job's selector and are catastrophic to edit:
 *
 *   jobs:
 *     test:
 *       strategy:
 *         matrix:
 *           runs-on: [ubuntu-latest]   ← a matrix DIMENSION, deeper than the job body
 *       runs-on: ${{ matrix.runs-on }}
 *
 * A first-match scanner rewrites the matrix dimension and leaves the real selector alone —
 * i.e. it opens a PR that corrupts the customer's matrix and does not even route the job. The
 * same applies to a `runs-on:`-looking line inside a `run: |` block scalar.
 */
export function findRunsOnLines(yamlText: string): Map<string, number> {
  const { lines } = splitLines(yamlText);
  const out = new Map<string, number>();

  let jobsIndent: number | undefined;
  let jobIdIndent: number | undefined;
  let currentJob: string | undefined;
  /** Indent of the current job's own keys (`runs-on`, `steps`, `strategy`, …). */
  let jobBodyIndent: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = KEY_RE.exec(line);

    if (jobsIndent === undefined) {
      if (m && m[2] === 'jobs' && m[1].length === 0) jobsIndent = 0;
      continue;
    }

    if (!m) continue; // list items, block-scalar text, continuations: never a job key

    const indent = m[1].length;
    // Dedent back to (or past) `jobs:` ⇒ we left the jobs block.
    if (indent <= jobsIndent && m[2] !== 'jobs') break;
    if (jobIdIndent === undefined && indent > jobsIndent) jobIdIndent = indent;
    if (indent === jobIdIndent) {
      currentJob = m[2];
      jobBodyIndent = undefined; // learned from this job's first body key
      continue;
    }
    if (!currentJob) continue;

    // First key inside the job block defines the job-body column.
    if (jobBodyIndent === undefined) jobBodyIndent = indent;
    if (indent !== jobBodyIndent) continue; // nested (matrix dim, step key, …) — not the job's

    const ro = RUNS_ON_RE.exec(line);
    if (ro && !out.has(currentJob)) out.set(currentJob, i + 1);
  }

  return out;
}

/**
 * Split an inline comment off a `runs-on` value so it can be preserved verbatim.
 *
 * QUOTE-AWARE: a `#` inside a quoted label (`[ubuntu-latest, "label #1"]`) is part of the
 * label, not a comment. Cutting there truncated the value mid-token, so the selector no longer
 * looked like it carried a hosted label and the job was skipped as "no longer targets a
 * standard GitHub-hosted label" — a wrong reason for a perfectly rewritable job.
 */
function splitComment(value: string): { value: string; comment: string } {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(value[i - 1])) {
      // Walk back over ALL the whitespace before `#` so the comment (and the column it sits
      // in) is reproduced byte-for-byte; cutting at a single space silently reflowed a
      // deliberately aligned trailing comment.
      let cut = i;
      while (cut > 0 && /\s/.test(value[cut - 1])) cut--;
      return { value: value.slice(0, cut).trim(), comment: value.slice(cut) };
    }
  }
  return { value: value.trim(), comment: '' };
}

/** One entry of an inline `runs-on` sequence: the source token plus its logical label. */
interface LabelToken {
  /** The token exactly as written, quotes included — what we re-emit for kept labels. */
  raw: string;
  /** The label value with surrounding quotes removed — what we compare against. */
  value: string;
}

/**
 * Split an inline sequence's interior into label tokens, RESPECTING QUOTES.
 *
 * A naive `inner.split(',')` breaks a quoted label containing a comma
 * (`[ubuntu-latest, "a,b"]` became two labels `a` and `b`), and stripping the quotes with
 * `replace(/^['"]|['"]$/g, '')` then discarded the only thing making a label like
 * `"team: infra"` a scalar — re-emitting it bare turned the sequence entry into a `{team:
 * infra}` MAPPING, `"123"` into a number, and `"*special"` into an undefined YAML alias that
 * fails to parse at all. Every one of those lands in a customer's pull request.
 *
 * Returns undefined when the sequence cannot be tokenized confidently (an unterminated
 * quote), so the caller refuses instead of guessing.
 */
function splitInlineLabels(inner: string): LabelToken[] | undefined {
  const tokens: LabelToken[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  const push = (): void => {
    const raw = current.trim();
    current = '';
    if (!raw) return;
    tokens.push({ raw, value: unquoteLabel(raw) });
  };
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      push();
      continue;
    }
    current += ch;
  }
  if (quote) return undefined; // unterminated quote — do not guess at the boundaries
  push();
  return tokens;
}

/** Strip one layer of matching surrounding quotes from a label token. */
function unquoteLabel(raw: string): string {
  if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw[raw.length - 1] === raw[0]) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Labels whose plain (unquoted) form is NOT the string it looks like, under the YAML 1.1
 * resolver `js-yaml` 5.x uses (the same parser Discovery and the compat analysis run).
 *
 * The generic character-class check is not sufficient on its own: `null` / `NULL` resolve to
 * a NULL scalar (the parser then DROPS the entry, so the runner silently advertises one label
 * fewer than the operator was shown), `TRUE` resolves to the boolean `true` (renders as
 * `"true"`, a different label), and `0x1A` / `0o17` / `1e3` resolve to NUMBERS (`26`, `15`,
 * `1000`). A `runs-on` label like `0x1A` or `null` is unusual but perfectly legal on GitHub,
 * and every one of these silently changes the label set the preview claims.
 *
 * Matched case-insensitively where YAML 1.1 does: null/bool words are, numeric forms are not
 * (`0X1F` is, however, still a hex int, hence the `i` flag on the numeric patterns too).
 */
const YAML_NON_STRING_PLAIN = [
  /^(?:null|~|true|false|yes|no|on|off|y|n)$/i,
  /^[-+]?\d+$/, // decimal int
  /^[-+]?0x[0-9a-f]+$/i, // hex int
  /^[-+]?0o?[0-7]+$/i, // octal int (YAML 1.1 allows a bare leading 0)
  /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:e[-+]?\d+)?$/i, // float / exponent
  /^[-+]?(?:\.inf|\.nan)$/i,
  /^\d+(?::[0-5]?\d)+$/, // sexagesimal (YAML 1.1 `1:30` → 90)
];

/**
 * Render a label as a token safe to place inside an inline YAML sequence.
 *
 * Plain (unquoted) is preferred so the common case stays readable, but a label that is not a
 * plain STRING scalar MUST be quoted: `team: infra` would otherwise become a mapping,
 * `*special` an undefined alias (a parse error), `123` a number, `null` a dropped entry, and
 * `TRUE` the boolean `true`. Used when re-rendering a label that reached us ALREADY UNQUOTED —
 * i.e. the console's dry run, which is built from the parsed analysis rather than the file text.
 *
 * Round-tripping is verified against the production parser in `test/rewrite.test.mjs`: a
 * preview token that does not parse back to the exact same label shows the operator a selector
 * the write path would never emit.
 */
export function yamlLabelToken(label: string): string {
  if (
    /^[A-Za-z0-9][A-Za-z0-9._\/+-]*$/.test(label) &&
    !YAML_NON_STRING_PLAIN.some((re) => re.test(label))
  ) {
    return label;
  }
  return `"${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Rewrite one `runs-on:` value to include the LCA label, or explain why it can't be.
 *
 * Accepted shapes:
 *   `ubuntu-latest`                    → `[self-hosted, lambda-ci]`
 *   `[ubuntu-latest]`                  → `[self-hosted, lambda-ci]`
 *   `[ubuntu-latest, big-disk]`        → `[self-hosted, big-disk, lambda-ci]`  (extras kept)
 *
 * Refused: empty (block sequence on following lines), expressions, the runner-group object
 * form (all of which need a multi-line edit we won't attempt blind), a job that already
 * carries an LCA label, and — critically — any value with no standard GitHub-hosted label to
 * replace. The last case is what protects us from a STALE analysis: the stored `runs_on` said
 * `ubuntu-latest` when Discovery scanned, but the file may now say `windows-latest` or
 * `[self-hosted, gpu]`. Rewriting those would either strand the job on an arm64 Linux runner
 * or hijack somebody else's fleet, so the job is skipped with a reason instead.
 */
export function rewriteRunsOnValue(
  rawValue: string,
  lcaLabel: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const { value, comment } = splitComment(rawValue);

  if (!value) {
    return {
      ok: false,
      reason:
        'runs-on uses a block sequence (labels on following lines); rewrite it by hand to keep the diff reviewable',
    };
  }
  if (value.includes('${{')) {
    return {
      ok: false,
      reason: `runs-on is an expression (${value}); add the LCA label to the matrix values by hand`,
    };
  }
  if (value.startsWith('{')) {
    return { ok: false, reason: 'runs-on uses the runner-group object form; add the label under its `labels:` key by hand' };
  }

  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const tokens = splitInlineLabels(inner);
  if (!tokens || !tokens.length) {
    return {
      ok: false,
      reason: `runs-on could not be parsed as a label list (${value}); rewrite it by hand`,
    };
  }
  const labels = tokens.map((t) => t.value);

  if (labels.some((l) => LCA_LABELS.has(l.toLowerCase()))) {
    return { ok: false, reason: 'job already carries an LCA label' };
  }

  // The value must still contain a hosted label we are entitled to replace. Re-checked HERE
  // (not only in `rewriteTargets`) because the write path plans against the CURRENT file while
  // the target list came from a possibly stale stored analysis.
  if (!labels.some((l) => isAdoptLabel(l))) {
    return {
      ok: false,
      reason: `runs-on no longer targets a standard GitHub-hosted label (found '${labels.join(', ')}'); it may have changed since the last scan — rewrite it by hand if you want it here`,
    };
  }

  // A MIXED selector (`[ubuntu-latest, windows-latest]`) must be refused too, even though it
  // does carry an adoptable label. Rewriting it would keep the non-Linux label — and
  // `decideClaim` refuses any job carrying one — while the added `self-hosted` stops
  // GitHub-hosted runners taking it. The job would queue forever.
  const nonLinux = labels.find((l) => nonLinuxHostedLabel(l));
  if (nonLinux) {
    return {
      ok: false,
      reason: `runs-on also targets '${nonLinux}', which LambdaCIActions never claims (arm64 Linux only); split the job or drop that label by hand`,
    };
  }

  // Drop the GitHub-hosted labels: they name x86 hosted images, and LEAVING them in would
  // keep the job unroutable (labels are cumulative — a runner would have to advertise
  // `ubuntu-latest` too, which is exactly the dependency adopt mode exists to avoid).
  //
  // Kept labels are re-emitted from their SOURCE token (`t.raw`), so quoting survives: a
  // `"team: infra"` label stays a quoted scalar instead of becoming a mapping, and `"123"` /
  // `"*special"` keep their string-ness. `self-hosted` and the LCA label are literals we
  // control and need no quoting.
  const kept = tokens.filter(
    (t) => !isAdoptLabel(t.value) && t.value.toLowerCase() !== 'self-hosted',
  );
  const next = ['self-hosted', ...kept.map((t) => t.raw), lcaLabel];

  return { ok: true, value: `[${next.join(', ')}]${comment}` };
}

/** Minimal unified diff for the lines we changed (context of 3, standard `@@` hunks). */
export function unifiedDiff(
  path: string,
  before: string[],
  after: string[],
  changedLines: number[],
): string {
  if (!changedLines.length) return '';
  const CONTEXT = 3;
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];

  // Group changed line numbers into hunks whose context windows touch.
  const groups: number[][] = [];
  for (const line of [...changedLines].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && line - last[last.length - 1] <= CONTEXT * 2) last.push(line);
    else groups.push([line]);
  }

  for (const group of groups) {
    const start = Math.max(1, group[0] - CONTEXT);
    const end = Math.min(before.length, group[group.length - 1] + CONTEXT);
    const count = end - start + 1;
    out.push(`@@ -${start},${count} +${start},${count} @@`);
    for (let ln = start; ln <= end; ln++) {
      if (group.includes(ln)) {
        out.push(`-${before[ln - 1]}`);
        out.push(`+${after[ln - 1]}`);
      } else {
        out.push(` ${before[ln - 1]}`);
      }
    }
  }
  return out.join('\n');
}

/**
 * Plan the rewrite of one workflow file. Returns the new content + a reviewable diff, or an
 * edit-free result when nothing is safely rewritable.
 */
export function planFileRewrite(
  path: string,
  yamlText: string,
  targets: RewriteTarget[],
): FileRewrite {
  const { lines: before, endings } = splitLines(yamlText);
  const after = [...before];
  const runsOnLines = findRunsOnLines(yamlText);
  const edits: RewriteEdit[] = [];
  const skipped: RewriteSkip[] = [];

  for (const target of targets) {
    const line = runsOnLines.get(target.jobId);
    if (!line) {
      skipped.push({ jobId: target.jobId, reason: 'no single-line runs-on found for this job' });
      continue;
    }
    const original = before[line - 1];
    const m = RUNS_ON_RE.exec(original);
    if (!m) {
      skipped.push({ jobId: target.jobId, reason: 'runs-on line did not match the expected shape' });
      continue;
    }
    const lcaLabel = labelForFlavor(target.flavor);
    if (!lcaLabel) {
      skipped.push({ jobId: target.jobId, reason: `unknown flavor '${target.flavor}'` });
      continue;
    }
    const rewritten = rewriteRunsOnValue(m[2], lcaLabel);
    if (!rewritten.ok) {
      skipped.push({ jobId: target.jobId, reason: rewritten.reason });
      continue;
    }
    const nextLine = `${m[1]}runs-on: ${rewritten.value}`;
    if (nextLine === original) {
      skipped.push({ jobId: target.jobId, reason: 'already routed to this flavor' });
      continue;
    }
    after[line - 1] = nextLine;
    edits.push({ jobId: target.jobId, line, before: original, after: nextLine });
  }

  const diff = unifiedDiff(path, before, after, edits.map((e) => e.line));
  return {
    path,
    ...(edits.length ? { content: joinLines(after, endings) } : {}),
    edits,
    skipped,
    diff,
  };
}

/**
 * Which jobs in a parsed analysis are rewrite candidates: they target a standard hosted
 * label and carry no LCA label. `routes` (the stored routing preview) supplies the flavor,
 * defaulting to `base` — the same answer the resolver's adopt map gives.
 */
export function rewriteTargets(
  jobs: { id: string; runs_on: string[] }[],
  routes: Record<string, { flavor: string }> = {},
): RewriteTarget[] {
  const out: RewriteTarget[] = [];
  for (const job of jobs) {
    const lower = job.runs_on.map((l) => l.trim().toLowerCase());
    if (lower.some((l) => LCA_LABELS.has(l))) continue;
    // `isAdoptLabel` (a Set lookup), NOT `l in ADOPT_LABEL_FLAVORS`: `in` walks the prototype
    // chain, so a job whose selector is literally `constructor` / `toString` counted as an
    // adopt candidate here while `decideClaim` and `views.ts` (both Set-based) refused it. The
    // three predicates have to agree — the console states this count as fact.
    if (!lower.some((l) => isAdoptLabel(l))) continue;
    // A job that also targets windows/macos is not a candidate: we never claim those, so
    // rewriting it would strand it (see rewriteRunsOnValue).
    if (lower.some((l) => nonLinuxHostedLabel(l))) continue;
    out.push({ jobId: job.id, flavor: routes[job.id]?.flavor ?? 'base' });
  }
  return out;
}

/**
 * A per-job preview of the rewrite, derived from the STORED analysis alone.
 *
 * The management API cannot read repo files — it holds no GitHub App credential by design
 * (ADR-025) — so the console's dry-run is built from the `runs_on` values the Discovery λ
 * already parsed, not from the file text. It therefore shows the exact label change per job
 * (which is what the operator is deciding about) without claiming to be a byte-level file
 * diff. The rewrite λ re-plans against the real file before committing.
 */
export interface RewritePreviewJob {
  path: string;
  jobId: string;
  before: string;
  after?: string;
  /** Set when this job can't be rewritten automatically. */
  skipped?: string;
}

export interface RewritePreview {
  jobs: RewritePreviewJob[];
  /** Jobs that would change. */
  changes: number;
  /** Jobs needing a hand edit. */
  skipped: number;
}

/** Build the console's dry-run preview from parsed analyses. Pure. */
export function planPreviewFromAnalyses(
  analyses: {
    path: string;
    parsed?: { jobs: { id: string; runs_on: string[] }[] };
    routes?: Record<string, { flavor: string }>;
  }[],
): RewritePreview {
  const jobs: RewritePreviewJob[] = [];
  for (const analysis of analyses) {
    if (!analysis.parsed) continue;
    const byId = new Map(analysis.parsed.jobs.map((j) => [j.id, j]));
    for (const target of rewriteTargets(analysis.parsed.jobs, analysis.routes ?? {})) {
      const job = byId.get(target.jobId);
      if (!job) continue;
      // Render the parsed labels back into the inline form the rewriter operates on. The real
      // file may use a different (equivalent) shape; the λ handles that when it re-plans.
      //
      // Labels arrive here ALREADY UNQUOTED (js-yaml parsed them in Discovery), so re-quote the
      // ones that need it — otherwise the dry run feeds `team: infra` back through the rewriter
      // as a bare token and shows the operator a mapping-shaped selector the λ would never
      // actually write (it reads the real file, quotes intact).
      const tokens = job.runs_on.map((l) => yamlLabelToken(l));
      const before = tokens.length === 1 ? tokens[0] : `[${tokens.join(', ')}]`;
      const lcaLabel = labelForFlavor(target.flavor);
      if (!lcaLabel) {
        jobs.push({
          path: analysis.path,
          jobId: job.id,
          before,
          skipped: `unknown flavor '${target.flavor}'`,
        });
        continue;
      }
      const rewritten = rewriteRunsOnValue(before, lcaLabel);
      jobs.push(
        rewritten.ok
          ? { path: analysis.path, jobId: job.id, before, after: rewritten.value }
          : { path: analysis.path, jobId: job.id, before, skipped: rewritten.reason },
      );
    }
  }
  return {
    jobs,
    changes: jobs.filter((j) => j.after !== undefined).length,
    skipped: jobs.filter((j) => j.skipped !== undefined).length,
  };
}

/** Branch name for the rewrite PR. Stable per repo so re-running updates the same branch. */
export function rewriteBranchName(envName: string): string {
  return `lambda-ci-actions/adopt-labels-${envName}`;
}

/** PR title + body. Body states the arm64 tradeoff — the reviewer must see it. */
export function rewritePrBody(files: FileRewrite[]): { title: string; body: string } {
  const totalEdits = files.reduce((n, f) => n + f.edits.length, 0);
  const skipped = files.flatMap((f) => f.skipped.map((s) => ({ path: f.path, ...s })));
  const lines = [
    'This PR routes GitHub Actions jobs to **LambdaCIActions** runners — ephemeral,',
    'single-use AWS Lambda microVMs in your own account.',
    '',
    `It rewrites \`runs-on\` for ${totalEdits} job(s) across ${files.filter((f) => f.edits.length).length} workflow file(s).`,
    '',
    '**Before you merge:** these runners are **arm64 (Graviton) Linux only**. A job that',
    'depends on x86_64 binaries or images will fail after this change. The console\'s',
    'compatibility report lists the jobs we could flag statically, but it is a heuristic.',
    '',
    'No other lines are touched: comments, formatting and key order are preserved.',
  ];
  if (skipped.length) {
    lines.push('', 'Not rewritten (needs a hand edit):', '');
    for (const s of skipped) lines.push(`- \`${s.path}\` job \`${s.jobId}\`: ${s.reason}`);
  }
  return {
    title: 'Run CI on LambdaCIActions microVM runners',
    body: lines.join('\n'),
  };
}
