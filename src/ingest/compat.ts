import flavorsCatalog from '../../microvm/flavors.json' with { type: 'json' };
import type {
  CompatLevel,
  CompatMessage,
  CompatResult,
  ParsedJob,
  ParsedWorkflow,
} from '../shared/types.js';
import type { FlavorResolution } from '../provision/flavor.js';

/**
 * Compatibility analysis (spec 03 § Compatibility analysis).
 *
 * Because LambdaCIActions runners are **arm64 Linux only** and single-use, ingestion computes a
 * `compat.level` per job so the UI can surface actionable guidance and Ingest can decide whether
 * to claim the job at all (`block` ⇒ not eligible ⇒ GitHub-hosted still runs it).
 *
 * Levels are ordered worst-wins: `ok` < `warn` < `risk` < `block`.
 *
 * Kept PURE — no network, no AWS, no fs. `resolveFlavor` is injected via `analyzeWorkflowCompat`'s
 * `resolveFn` so this module stays decoupled from the resolver's internals (dependency inversion).
 */

const LEVEL_RANK: Record<CompatLevel, number> = { ok: 0, warn: 1, risk: 2, block: 3 };

/** Flavor names that advertise the `docker` capability (derived from the catalog). */
const DOCKER_CAPABLE_FLAVORS = new Set<string>(
  (flavorsCatalog as { flavors: { name: string; capabilities: string[] }[] }).flavors
    .filter((f) => f.capabilities.includes('docker'))
    .map((f) => f.name),
);

/** Return the worst (highest-rank) of two levels. */
function worse(a: CompatLevel, b: CompatLevel): CompatLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

const X86_TOKENS = ['amd64', 'x86_64', 'x86', 'i386', 'i686'];
const ARM_TOKENS = ['arm64', 'aarch64'];

/** Non-Linux OS labels GitHub uses for `runs-on` (we only run arm64 Linux). */
function nonLinuxOsLabel(label: string): boolean {
  const l = label.toLowerCase();
  return l === 'windows' || l === 'macos' || l.startsWith('windows-') || l.startsWith('macos-');
}

function hasToken(haystack: string, tokens: string[]): boolean {
  const l = haystack.toLowerCase();
  return tokens.some((t) => l.includes(t));
}

/**
 * Analyze one parsed job against its resolved flavor. Pure. Returns the worst level that fired,
 * `eligible = level !== 'block'`, and every triggered message.
 */
export function analyzeCompat(job: ParsedJob, resolution: FlavorResolution): CompatResult {
  const messages: CompatMessage[] = [];
  const add = (m: CompatMessage) => {
    messages.push(m);
  };

  // block: runs-on carries a non-Linux OS label.
  for (const label of job.runs_on) {
    if (nonLinuxOsLabel(label)) {
      add({
        level: 'block',
        code: 'unsupported-os',
        text: `runs-on '${label}' is an unsupported OS; LambdaCIActions runners are arm64 Linux only.`,
        fix: `Keep this job on GitHub-hosted runners (LambdaCIActions will not claim it), or port it to Linux and change runs-on to '${resolution.flavor === 'base' ? 'lambda-ci' : `lambda-ci-${resolution.flavor}`}'.`,
      });
      break;
    }
  }

  // risk: explicit x86 arch hint present with NO arm64/aarch64 hint also present.
  // (Mixed arm64 + x86 → warn, not risk.)
  const archLower = job.step_signals.arch_hints.map((h) => h.toLowerCase());
  const x86Hint = archLower.find((h) => X86_TOKENS.includes(h));
  const hasArmHint = archLower.some((h) => ARM_TOKENS.includes(h));
  if (x86Hint) {
    if (hasArmHint) {
      add({
        level: 'warn',
        code: 'mixed-arch-hint',
        text: `job declares both arm64 and x86 (${x86Hint}) arch hints; verify the arm64 path is exercised.`,
        fix: 'Confirm the arm64 branch is the one taken on this runner (`uname -m` prints `aarch64`), or gate the x86 path behind a matrix exclusion.',
      });
    } else {
      add({
        level: 'risk',
        code: 'x86-arch-hint',
        text: `job declares an x86 arch hint ('${x86Hint}') and no arm64 hint; publish an arm64 variant or exclude this job.`,
        fix: `Replace the hardcoded '${x86Hint}' download/target with an arch-detected one (e.g. \`$(uname -m)\`), or publish an arm64 build of the artifact.`,
      });
    }
  }

  // risk: container image tag looks x86-only.
  if (job.container && hasToken(job.container, ['amd64', 'x86_64', '-x86'])) {
    add({
      level: 'risk',
      code: 'x86-container',
      text: `container image '${job.container}' looks x86-only; publish an arm64 variant.`,
      fix: `Push a multi-arch manifest for '${job.container}' (\`docker buildx build --platform linux/amd64,linux/arm64\`) so the arm64 runner can pull it, or drop the arch suffix from the tag if a multi-arch tag already exists.`,
    });
  }

  // warn: external reusable-workflow call (not a local ./… path).
  if (job.uses && !job.uses.startsWith('./')) {
    add({
      level: 'warn',
      code: 'external-reusable',
      text: `reusable workflow '${job.uses}' is external; its runner requirements can't be seen — routing by this job's own labels.`,
      fix: `Open '${job.uses}' and check the runs-on of the jobs it defines: the callee's own labels decide where those jobs land, not this caller's.`,
    });
  }

  // warn: unresolved matrix expression in runs_on.
  if (job.runs_on.some((r) => r.includes('${{'))) {
    add({
      level: 'warn',
      code: 'dynamic-matrix',
      text: `matrix dimension is dynamic/unresolved; routed by base labels — verify per-variant.`,
      fix: 'Replace the expression with literal labels, or add an explicit LCA label alongside it so every matrix variant routes deterministically.',
    });
  }

  // warn: job needs Docker but the resolved flavor lacks it (safety net for a FlavorMap override
  // that pinned a non-docker flavor; the resolver's signal upgrade normally prevents this).
  if (job.step_signals.needs_docker && !DOCKER_CAPABLE_FLAVORS.has(resolution.flavor)) {
    add({
      level: 'warn',
      code: 'docker-missing',
      text: `job needs Docker but resolved flavor '${resolution.flavor}' lacks it.`,
      fix: `Remove the FlavorMap entry pinning this job to '${resolution.flavor}', or point it at a docker-capable flavor (${[...DOCKER_CAPABLE_FLAVORS].join(', ')}).`,
    });
  }

  // NOTE: adopt-mode candidacy (a job targeting `ubuntu-latest` with no LCA label) is
  // deliberately NOT a compat message. It is not a defect — it is the normal state of every
  // repo that hasn't onboarded yet — and emitting it as a `warn` would fold into the
  // workflow's compat level, turning every un-adopted repo yellow and destroying the signal
  // spec 03 depends on ("the UI nudges toward adopt once compat is green"). It is surfaced
  // instead as `adoptCandidate` on the workflow view (src/mgmt/views.ts).

  const level = messages.reduce<CompatLevel>((acc, m) => worse(acc, m.level), 'ok');
  return { level, eligible: level !== 'block', messages };
}

/**
 * Analyze every job in a workflow, folding to the WORST job level. `resolveFn` is injected so this
 * module never imports the resolver's I/O-bearing wiring.
 */
export function analyzeWorkflowCompat(
  wf: ParsedWorkflow,
  resolveFn: (job: ParsedJob) => FlavorResolution,
): { path: string; jobs: Record<string, CompatResult>; level: CompatLevel } {
  const jobs: Record<string, CompatResult> = {};
  let level: CompatLevel = 'ok';
  for (const job of wf.jobs) {
    const result = analyzeCompat(job, resolveFn(job));
    jobs[job.id] = result;
    level = worse(level, result.level);
  }
  return { path: wf.path, jobs, level };
}
