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
 * expressions, runner-group objects, inline flow-mapping job bodies) are reported as `skipped`
 * with a reason so the console can tell the operator what to hand-edit, instead of guessing
 * and corrupting a workflow.
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

/**
 * A `key:` line that starts a mapping (used to find job blocks).
 *
 * The key may be a plain scalar OR a QUOTED one: `"build":` / `'build':` are legal YAML and
 * legal GitHub job ids. A plain-only pattern silently failed to recognize such a line as a
 * key, which does not merely lose that job — it makes the scanner attribute the job's own
 * `runs-on:` line to the PREVIOUS job (see `findRunsOnLines`), i.e. it plans an edit for job
 * A against job B's selector and commits that to the customer's repo.
 *
 * Group 3 is the quoted form's inner text, group 4 the plain form; `keyName` picks whichever
 * matched. Escapes inside a double-quoted id are not decoded — job ids are matched against
 * `parseWorkflow`'s ids, which come from the same YAML source, and an id needing escapes is
 * refused below rather than guessed at.
 */
const KEY_RE = /^(\s*)(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_.-]+)):\s*(.*)$/;

/** The key name a `KEY_RE` match names, whichever of the three spellings matched. */
function keyName(m: RegExpExecArray): string {
  return m[2] ?? m[3] ?? m[4];
}

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
 *
 * ## Unrecognized structure must FORGET the current job, not skip the line
 *
 * The mirror-image hazard is a line at the job-id column the scanner cannot parse as a key.
 * Merely `continue`-ing there does not lose one job — it leaves `currentJob` pointing at the
 * PREVIOUS job while the scan walks into the new job's body, so the next `runs-on:` is
 * recorded under the wrong job id. `planFileRewrite` then rewrites job B's selector using job
 * A's target (or rewrites a selector no target asked about at all) and commits that to the
 * customer's repo:
 *
 *   jobs:
 *     lint:
 *       runs-on:                     ← block sequence: the planner refuses `lint`
 *         - ubuntu-latest
 *     "release":                      ← quoted id (legal YAML, legal job id)
 *       runs-on: ubuntu-latest        ← was attributed to `lint`, and rewritten
 *
 * Quoted ids are now recognized (`KEY_RE`), but the class does not end there — an id needing
 * escapes, a complex `?` key, or a multi-line flow mapping are all unparseable here. So any
 * non-blank line at or shallower than the job-id column that is NOT a recognized key clears
 * `currentJob`: an unrecognized shape yields "no single-line runs-on found" (a safe `skipped`
 * reason) instead of an edit against the wrong job.
 *
 * A job whose body is INLINE on the job-id line (`build: {runs-on: ubuntu-latest}`, or an
 * anchor) is refused for the same reason: there is no line we can edit without re-flowing the
 * mapping, and a multi-line flow mapping would otherwise expose an interior `runs-on:` line
 * whose trailing comma we would silently drop.
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
      if (m && keyName(m) === 'jobs' && m[1].length === 0) jobsIndent = 0;
      continue;
    }

    if (!m) {
      // Not a key we can parse. If it sits at (or shallower than) the job-id column it is
      // structure we do not understand — most likely a job id in a spelling this scanner
      // cannot read. Forget the current job so its target can never be planned against the
      // next job's selector; deeper lines (list items, block-scalar text) are ordinary body
      // content and change nothing.
      const indent = line.length - line.replace(/^\s*/, '').length;
      if (jobIdIndent !== undefined && indent <= jobIdIndent) {
        currentJob = undefined;
        jobBodyIndent = undefined;
      }
      continue;
    }

    const indent = m[1].length;
    const name = keyName(m);
    // Dedent back to (or past) `jobs:` ⇒ we left the jobs block.
    if (indent <= jobsIndent && name !== 'jobs') break;
    if (jobIdIndent === undefined && indent > jobsIndent) jobIdIndent = indent;
    if (indent === jobIdIndent) {
      jobBodyIndent = undefined; // learned from this job's first body key
      // Anything on the job-id line itself means the body is inline (a flow mapping) or
      // anchored: there is no `runs-on:` line of its own to edit, and treating the flow
      // mapping's interior lines as body keys would drop their separators. Refuse the job.
      const inlineBody = m[5].trim();
      currentJob = !inlineBody || inlineBody.startsWith('#') ? name : undefined;
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
 *
 * ESCAPE-AWARE too: inside a DOUBLE-quoted YAML scalar `\"` is an escaped quote, not the
 * closing one (YAML 1.1 § double-quoted style). Treating it as a terminator ends the quote
 * state early, so a later ` #` inside the same label reads as a comment and the value is cut
 * mid-token. Single-quoted scalars have no backslash escapes (`''` is the only escape, and it
 * naturally reads as close-then-reopen), so the backslash rule applies to `"` only.
 *
 * A `#` at position 0 starts a comment too — `RUNS_ON_RE` has already eaten the whitespace
 * after `runs-on:`, so `runs-on: # labels below` arrives here as a value whose FIRST character
 * is `#`. Requiring a preceding whitespace character therefore misread a comment-ONLY value as
 * a label list: `runs-on: # options: self-hosted, ubuntu-latest` tokenized into
 * `# options: self-hosted` + `ubuntu-latest`, passed the hosted-label gate on the second, and
 * emitted `runs-on: [self-hosted, # options: self-hosted, lambda-ci]` — which does not parse
 * at all (`missed comma between flow collection entries`) and, because the real labels sat in
 * the block sequence on the FOLLOWING lines, would have been committed to a customer's
 * repository as a broken workflow. In YAML such a line carries no value (the scalar is the
 * following block sequence, or nothing), so the caller must refuse it.
 */
function splitComment(value: string): { value: string; comment: string } {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++; // skip the escaped character — `\"` does not close the scalar
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
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
 *
 * ESCAPE-AWARE inside a DOUBLE-quoted scalar: `\"` is an escaped quote, not the closing one,
 * so the quote state must skip the escaped character. Reading `\"` as a terminator put the
 * scanner back in "outside a quote" state mid-label, where a following `,` split ONE label
 * into two — `["a\"x,y"]` became `a\"x` + `y`, which re-emits as `"a\"x, y"`: a DIFFERENT
 * label, silently, in the customer's pull request. (A `,` count that happens to be even also
 * re-balances the state, so this is not detectable by refusing unbalanced input.)
 * Single-quoted scalars have no backslash escapes — `''` is the only escape and reads
 * correctly as close-then-reopen — so the rule applies to `"` only.
 */
function splitInlineLabels(inner: string): LabelToken[] | undefined {
  const tokens: LabelToken[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let undecodable = false;
  const push = (): void => {
    const raw = current.trim();
    current = '';
    if (!raw) return;
    const value = unquoteLabel(raw);
    // An escape we cannot decode to the parser's exact result means we do not know what this
    // label IS — and every refusal predicate (non-Linux, LCA-already-present) depends on
    // knowing. Fail the whole tokenization so the caller refuses the file.
    if (value === undefined) {
      undecodable = true;
      return;
    }
    tokens.push({ raw, value });
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\') {
        const next = inner[i + 1];
        if (next === undefined) return undefined; // dangling escape — do not guess
        current += next;
        i++;
        continue;
      }
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
  if (undecodable) return undefined;
  return tokens;
}

/**
 * Single-character YAML 1.1 double-quoted escapes (the table `js-yaml` implements).
 *
 * The whole table is decoded, not just `\\` and `\"`, because a PARTIAL decode is not the
 * conservative direction it looks like. Every predicate downstream matches on `value`, so an
 * undecoded escape makes a label compare as a string no parser ever yields — and the one that
 * matters is the arm64 refusal: `[ubuntu-latest, "\x77indows-latest"]` parses as
 * `windows-latest` (verified against js-yaml 5.2.1), so leaving `\x77` verbatim let the
 * mixed-selector guard MISS, the rewrite emit `[self-hosted, "\x77indows-latest", lambda-ci]`,
 * and the job queue forever: `decideClaim` refuses the non-Linux label while the added
 * `self-hosted` stops GitHub-hosted runners taking it. A miss is only "safe" for predicates
 * that DROP a label; it is unsafe for every predicate that REFUSES on one.
 */
const YAML_DQ_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: '\u2028',
  P: '\u2029',
});

/** Hex-escape forms: `\xNN`, `\uNNNN`, `\UNNNNNNNN`. */
const YAML_DQ_HEX: Readonly<Record<string, number>> = Object.freeze({ x: 2, u: 4, U: 8 });

/**
 * Strip one layer of matching surrounding quotes from a label token AND decode the escapes
 * that quoting introduced, so `value` is the label the YAML parser would produce.
 *
 * Comparison correctness depends on this: the claim/adopt/LCA predicates all match on `value`,
 * while `raw` is what gets re-emitted. Returns undefined when the token carries an escape we
 * cannot decode to the parser's exact result — the caller then REFUSES the rewrite rather
 * than planning against a label whose real value it does not know. (Such a sequence is also
 * invalid YAML, so the file would not have parsed for Discovery either; refusing costs
 * nothing and keeps this decoder from having to be a superset of the parser.)
 */
function unquoteLabel(raw: string): string | undefined {
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    // Single-quoted scalars have exactly one escape: `''` → `'`. No backslash processing.
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    const body = raw.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const esc = body[i + 1];
      if (esc === undefined) return undefined; // dangling escape — invalid YAML
      const width = YAML_DQ_HEX[esc];
      if (width !== undefined) {
        const digits = body.slice(i + 2, i + 2 + width);
        if (digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) return undefined;
        const code = Number.parseInt(digits, 16);
        // Surrogates / out-of-range code points are not valid YAML escapes either.
        if (!Number.isFinite(code) || code > 0x10ffff) return undefined;
        out += String.fromCodePoint(code);
        i += 1 + width;
        continue;
      }
      const simple = Object.prototype.hasOwnProperty.call(YAML_DQ_ESCAPES, esc)
        ? YAML_DQ_ESCAPES[esc]
        : undefined;
      if (simple === undefined) return undefined; // unknown escape — do not guess
      out += simple;
      i += 1;
    }
    return out;
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
      reason: comment
        ? // The whole value was a comment, so the labels (if any) live in a block sequence on the
          // following lines — the same unrewritable shape, reached by a different spelling.
          `runs-on carries no inline value (the line is only a comment: ${comment.trim()}); its labels are on the following lines — rewrite it by hand to keep the diff reviewable`
        : 'runs-on uses a block sequence (labels on following lines); rewrite it by hand to keep the diff reviewable',
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
    totalEdits
      ? `It rewrites \`runs-on\` for ${totalEdits} job(s) across ${files.filter((f) => f.edits.length).length} workflow file(s).`
      : // The recovery case (rewrite/handler.ts): the branch already carried the rewrite from an
        // earlier request whose PR call failed, so THIS request committed nothing. Claiming
        // "0 job(s)" would read like an empty PR; the change is real, it just landed earlier.
        'The `runs-on` changes were committed to this branch by an earlier request whose pull',
    ...(totalEdits ? [] : ['request could not be opened at the time. Review the branch diff below.']),
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
