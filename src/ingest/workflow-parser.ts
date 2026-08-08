/**
 * Pure GitHub Actions workflow parser (spec 03 § Parsing model).
 *
 * Turns raw workflow YAML into the normalized {@link ParsedWorkflow} model used by
 * routing + compatibility analysis. This module is intentionally PURE — no network, no
 * AWS, no filesystem — so it is trivially unit-testable. Discovery over the GitHub API
 * and wiring into ingest/provision live in later M3 slices.
 *
 * It deliberately does NOT attempt full GitHub Actions semantics; it extracts only what
 * routing and compat need: `runs-on` labels, `container:`/`services:` presence, reusable
 * workflow refs, statically-resolvable matrix dims, and heuristic capability signals.
 */
import { load, YAMLException } from 'js-yaml';
import { basename } from 'node:path';
import {
  WorkflowParseError,
  type ParsedJob,
  type ParsedWorkflow,
  type StepSignals,
} from '../shared/types.js';

/** Arch tokens we recognise in runs-on / container tags / run text (best-effort substring scan). */
const ARCH_TOKENS = ['arm64', 'aarch64', 'amd64', 'x86_64'] as const;

/** `uses:` prefixes that imply a Docker-capable flavor. */
const DOCKER_ACTION_PREFIX = 'docker/';

/** `run:` substrings that imply Docker usage. */
const DOCKER_RUN_PATTERNS = [/\bdocker-compose\b/, /\bdocker\s/];

type Unknown = Record<string, unknown>;

function isRecord(v: unknown): v is Unknown {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce a YAML scalar to its string form (numbers/booleans → string), else null. */
function scalarToString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Flatten a scalar or array of scalars to a string[] (nulls dropped). */
function scalarsToArray(v: unknown): string[] {
  const s = scalarToString(v);
  if (s !== null) return [s];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const is = scalarToString(item);
      if (is !== null) out.push(is);
    }
    return out;
  }
  return [];
}

/**
 * Normalize a `runs-on` value to a string[].
 *
 * Handles all valid GitHub Actions shapes:
 *  - string (`ubuntu-latest`) and matrix expressions (`${{ matrix.os }}`) — preserved verbatim.
 *  - array (`[self-hosted, lambda-ci-docker]`).
 *  - runner-group object form `{ group: X, labels: [...] }` — the LCA routing labels live under
 *    `labels`, so they MUST be extracted (dropping them silently breaks label-based routing).
 *    `labels` accepts a scalar or an array; `group` is not a routing label and is ignored here.
 */
function normalizeRunsOn(v: unknown): string[] {
  if (v == null) return [];
  const s = scalarToString(v);
  if (s !== null) return [s];
  if (Array.isArray(v)) return scalarsToArray(v);
  if (isRecord(v)) return scalarsToArray(v.labels);
  return [];
}

/**
 * The runner group named by the object form `runs-on: { group: X, labels: [...] }`, else null.
 *
 * Kept SEPARATE from the label list on purpose: a group is not a label, and GitHub requires a
 * runner to be in the requested group AND carry every requested label. We mint into the
 * repo-level default group only, so the claim gate needs this value to refuse a job that asks
 * for another group (ADR-030) instead of stranding it.
 */
function normalizeRunnerGroup(v: unknown): string | null {
  if (!isRecord(v) || Array.isArray(v)) return null;
  return scalarToString(v.group);
}

/**
 * Normalize `on:` (string | array | map) to a trigger-name string[].
 * Map form `{ push: {...}, pull_request: {...} }` → its keys.
 */
function normalizeOn(v: unknown): string[] {
  if (v == null) return [];
  const s = scalarToString(v);
  if (s !== null) return [s];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const is = scalarToString(item);
      if (is !== null) out.push(is);
    }
    return out;
  }
  if (isRecord(v)) return Object.keys(v);
  return [];
}

/** Extract `container` image from string form or `{ image }` object form; null otherwise. */
function normalizeContainer(v: unknown): string | null {
  const s = scalarToString(v);
  if (s !== null) return s;
  if (isRecord(v)) {
    const img = scalarToString(v.image);
    if (img !== null) return img;
  }
  return null;
}

/** Keys of `job.services`; empty if absent/not a map. */
function normalizeServices(v: unknown): string[] {
  return isRecord(v) ? Object.keys(v) : [];
}

/**
 * Statically-resolvable `strategy.matrix` dims, string-coerced, excluding include/exclude.
 * Only array-valued dims are kept (dynamic `fromJSON(...)` and expression values are dropped).
 */
function normalizeMatrixDims(strategy: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isRecord(strategy)) return out;
  const matrix = strategy.matrix;
  if (!isRecord(matrix)) return out;
  for (const [key, val] of Object.entries(matrix)) {
    if (key === 'include' || key === 'exclude') continue;
    if (!Array.isArray(val)) continue;
    const dims: string[] = [];
    for (const item of val) {
      const s = scalarToString(item);
      if (s !== null) dims.push(s);
    }
    out[key] = dims;
  }
  return out;
}

function collectArchHints(...texts: string[]): string[] {
  const hints = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const token of ARCH_TOKENS) {
      if (lower.includes(token)) hints.add(token);
    }
  }
  return [...hints];
}

/**
 * Compute {@link StepSignals} for a job from its steps + container/services context.
 */
function computeStepSignals(
  steps: unknown,
  container: string | null,
  services: string[],
  runsOn: string[],
): StepSignals {
  const knownActions: string[] = [];
  const seenActions = new Set<string>();
  const archTexts: string[] = [...runsOn];
  if (container) archTexts.push(container);

  let needsDocker = container !== null || services.length > 0;

  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const uses = scalarToString(step.uses);
      if (uses !== null) {
        if (!seenActions.has(uses)) {
          seenActions.add(uses);
          knownActions.push(uses);
        }
        if (uses.startsWith(DOCKER_ACTION_PREFIX)) needsDocker = true;
      }
      const run = scalarToString(step.run);
      if (run !== null) {
        archTexts.push(run);
        if (DOCKER_RUN_PATTERNS.some((re) => re.test(run))) needsDocker = true;
      }
    }
  }

  return {
    needs_docker: needsDocker,
    arch_hints: collectArchHints(...archTexts),
    known_actions: knownActions,
  };
}

function parseJob(id: string, raw: unknown): ParsedJob {
  const job = isRecord(raw) ? raw : {};
  const name = scalarToString(job.name);
  const runsOn = normalizeRunsOn(job['runs-on']);
  const runnerGroup = normalizeRunnerGroup(job['runs-on']);
  const container = normalizeContainer(job.container);
  const services = normalizeServices(job.services);
  const uses = scalarToString(job.uses);
  const matrixDims = normalizeMatrixDims(job.strategy);
  const stepSignals = computeStepSignals(job.steps, container, services, runsOn);

  return {
    id,
    name,
    runs_on: runsOn,
    runner_group: runnerGroup,
    container,
    services,
    uses,
    matrix_dims: matrixDims,
    step_signals: stepSignals,
  };
}

/**
 * Parse raw workflow YAML into the normalized {@link ParsedWorkflow} model.
 *
 * @param path     Workflow path (e.g. `.github/workflows/ci.yml`) — used for `name`
 *                 fallback (basename) and error context.
 * @param yamlText Raw file contents.
 * @throws {WorkflowParseError} on malformed YAML or a non-mapping document.
 *
 * A well-formed workflow with no `jobs:` yields `jobs: []` (not a throw).
 */
export function parseWorkflow(path: string, yamlText: string): ParsedWorkflow {
  // js-yaml 5.x throws on empty input; treat an empty/whitespace-only file as an empty
  // workflow (degenerate but not malformed) rather than a parse error.
  if (yamlText.trim() === '') {
    return { path, name: basename(path), on: [], jobs: [] };
  }

  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch (err) {
    const msg = err instanceof YAMLException || err instanceof Error ? err.message : String(err);
    throw new WorkflowParseError(path, `malformed YAML: ${msg}`, { cause: err });
  }

  // Empty document (null/undefined) is treated as an empty workflow, not an error.
  if (doc == null) {
    return { path, name: basename(path), on: [], jobs: [] };
  }
  if (!isRecord(doc)) {
    throw new WorkflowParseError(path, 'workflow root is not a mapping');
  }

  const name = scalarToString(doc.name) ?? basename(path);
  const on = normalizeOn(doc.on);

  const jobs: ParsedJob[] = [];
  const rawJobs = doc.jobs;
  if (isRecord(rawJobs)) {
    for (const [jobId, rawJob] of Object.entries(rawJobs)) {
      jobs.push(parseJob(jobId, rawJob));
    }
  }

  return { path, name, on, jobs };
}
