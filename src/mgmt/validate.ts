import { flavorNames } from './views.js';
import { customFlavorBaseNameError } from '../shared/flavor-catalog.js';
import { KNOWN_CAPABILITIES, areCapabilitiesKnown } from '../provision/flavor.js';
import { MIN_MEMORY_MB, DEFAULT_MAX_MEMORY_MB } from '../flavorval/validate-core.js';
import type { RegisterFlavorInput } from '../shared/flavor-store.js';
import type { RepoMode } from '../shared/types.js';
import type { RepoConfigPatch } from '../shared/install-store.js';

/**
 * Request-body validation for the Management API's config writes (spec 04).
 *
 * Pure + total: every function returns either a normalized value or a list of
 * operator-facing errors. The handler turns errors into a 400 — it never passes
 * unvalidated client input to DynamoDB, and it never accepts fields outside the
 * config surface (no status, no microVM ids, no secrets).
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const MODES: readonly RepoMode[] = ['label', 'adopt', 'off'];

/** Max label→flavor overrides per repo. Bounds the item size + the UI editor. */
export const MAX_FLAVOR_MAP_ENTRIES = 50;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a `label → flavor` map: keys are non-empty runner labels, values must name a
 * flavor that exists in the catalog (a typo'd flavor would silently fall back to `base`
 * at provision time, which is exactly the surprise the UI should prevent).
 *
 * `customFlavors` (ADR-040/041) is the installation's ROUTABLE custom flavors. It is optional and
 * trailing so every existing caller behaves identically; the caller must pass only `valid` ones,
 * because accepting a `pending`/`invalid` name here would save config the resolver then ignores —
 * the job would silently land on `base` while the console showed the operator's choice.
 */
export function validateFlavorMap(
  input: unknown,
  customFlavors?: readonly { name: string }[],
): ValidationResult<Record<string, string>> {
  if (!isPlainObject(input)) return { ok: false, errors: ['flavorMap must be an object'] };
  const errors: string[] = [];
  const known = new Set(flavorNames(customFlavors));
  const entries = Object.entries(input);
  if (entries.length > MAX_FLAVOR_MAP_ENTRIES) {
    errors.push(`flavorMap has ${entries.length} entries (max ${MAX_FLAVOR_MAP_ENTRIES})`);
  }
  const out: Record<string, string> = {};
  for (const [label, flavor] of entries) {
    const key = label.trim();
    if (!key) {
      errors.push('flavorMap keys must be non-empty labels');
      continue;
    }
    if (typeof flavor !== 'string' || !known.has(flavor)) {
      errors.push(`flavorMap["${key}"]: unknown flavor "${String(flavor)}" (known: ${[...known].join(', ')})`);
      continue;
    }
    out[key] = flavor;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/**
 * Validate a `PATCH /api/repos/{repoId}` body. Rejects unknown fields outright.
 *
 * `customFlavors` — see {@link validateFlavorMap}: routable custom flavors only.
 */
export function validateRepoPatch(
  input: unknown,
  customFlavors?: readonly { name: string }[],
): ValidationResult<RepoConfigPatch> {
  if (!isPlainObject(input)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  const patch: RepoConfigPatch = {};
  const allowed = new Set(['enabled', 'mode', 'defaultFlavor', 'flavorMap', 'rewriteEnabled']);

  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') errors.push('enabled must be a boolean');
    else patch.enabled = input.enabled;
  }
  if (input.mode !== undefined) {
    if (typeof input.mode !== 'string' || !MODES.includes(input.mode as RepoMode)) {
      errors.push(`mode must be one of ${MODES.join(', ')}`);
    } else {
      patch.mode = input.mode as RepoMode;
    }
  }
  if (input.defaultFlavor !== undefined) {
    // `null` clears the override — the repo reverts to the catalog default (`base`).
    // Without an explicit clear a defaultFlavor, once set, would be permanent: the
    // validator rejects everything but known flavor names.
    if (input.defaultFlavor === null) {
      patch.defaultFlavor = null;
    } else if (
      typeof input.defaultFlavor !== 'string' ||
      !flavorNames(customFlavors).includes(input.defaultFlavor)
    ) {
      errors.push(
        `defaultFlavor must be a known flavor (${flavorNames(customFlavors).join(', ')}) or null to clear`,
      );
    } else {
      patch.defaultFlavor = input.defaultFlavor;
    }
  }
  if (input.flavorMap !== undefined) {
    const fm = validateFlavorMap(input.flavorMap, customFlavors);
    if (!fm.ok) errors.push(...fm.errors);
    else patch.flavorMap = fm.value;
  }
  if (input.rewriteEnabled !== undefined) {
    // Per-repo opt-in to the auto-rewrite PR (ADR-031). Accepting it here does NOT grant
    // anything on its own: the rewrite λ also requires the deployment-wide flag, and GitHub
    // still enforces whether the App holds `contents:write`.
    if (typeof input.rewriteEnabled !== 'boolean') errors.push('rewriteEnabled must be a boolean');
    else patch.rewriteEnabled = input.rewriteEnabled;
  }

  if (!errors.length && Object.keys(patch).length === 0) {
    errors.push(
      'body must set at least one of: enabled, mode, defaultFlavor, flavorMap, rewriteEnabled',
    );
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: patch };
}

// ---- runner labels (spec 04 § Settings) ------------------------------------

/**
 * Labels GitHub RESERVES for its own runner taxonomy. GitHub refuses to register a
 * self-hosted runner carrying one, so a JIT registration with any of these fails at
 * provision time — reject them outright, with no opt-in escape hatch.
 */
export const RESERVED_LABELS: readonly string[] = [
  'self-hosted',
  'linux',
  'windows',
  'macos',
  'x64',
  'x86',
  'arm',
  'arm64',
];

/**
 * Labels that name a GitHub-HOSTED runner image. Claiming one is legitimate (that is exactly
 * what `adopt` mode does — silently move `ubuntu-latest` jobs onto microVMs), but it is a
 * decision with blast radius: every job in every enabled repo using that label stops going to
 * GitHub-hosted. So it requires an explicit opt-in rather than a typo.
 */
export const HOSTED_LABELS: readonly string[] = [
  'ubuntu-latest',
  'ubuntu-24.04',
  'ubuntu-24.04-arm',
  'ubuntu-22.04',
  'ubuntu-22.04-arm',
  'ubuntu-20.04',
  'windows-latest',
  'windows-2025',
  'windows-2022',
  'windows-2019',
  'macos-latest',
  'macos-15',
  'macos-14',
  'macos-13',
];

/** Max labels an environment may claim. Bounds the SSM value + the claim-time comparison. */
export const MAX_RUNNER_LABELS = 20;

export interface RunnerLabelsPatch {
  labels: string[];
  /** Operator explicitly accepted claiming GitHub-hosted label names. */
  allowHostedLabels: boolean;
  /** Preview only: compute the impact, write nothing. */
  dryRun: boolean;
}

/**
 * Validate a runner-labels write (`PUT /api/settings/runner-labels`).
 *
 * Labels are compared case-insensitively at claim time (`shouldClaim`), so they are
 * normalized to lower case here — otherwise the UI could show `Ubuntu-Latest` while the
 * stored value and the claim comparison disagree on case, and a duplicate-by-case pair would
 * silently collapse.
 */
export function validateRunnerLabels(input: unknown): ValidationResult<RunnerLabelsPatch> {
  if (!isPlainObject(input)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  const allowed = new Set(['labels', 'allowHostedLabels', 'dryRun']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  }

  if (input.allowHostedLabels !== undefined && typeof input.allowHostedLabels !== 'boolean') {
    errors.push('allowHostedLabels must be a boolean');
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    errors.push('dryRun must be a boolean');
  }
  const allowHosted = input.allowHostedLabels === true;

  if (!Array.isArray(input.labels)) {
    errors.push('labels must be a non-empty array of strings');
    return { ok: false, errors };
  }
  if (input.labels.length === 0) {
    // An empty list would claim nothing — the environment goes dark with a green checkmark.
    // Disabling the platform is `mode: 'off'` per repo, not an empty global label set.
    errors.push('labels must not be empty (use repo mode "off" to stop claiming jobs)');
  }
  if (input.labels.length > MAX_RUNNER_LABELS) {
    errors.push(`labels has ${input.labels.length} entries (max ${MAX_RUNNER_LABELS})`);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.labels) {
    if (typeof raw !== 'string') {
      errors.push('labels must contain strings only');
      continue;
    }
    const label = raw.trim().toLowerCase();
    if (!label) {
      errors.push('labels must not contain empty strings');
      continue;
    }
    // A comma would split one label into two when the SSM value is parsed by Ingest.
    if (/[,\s]/.test(label)) {
      errors.push(`label "${label}" must not contain commas or whitespace`);
      continue;
    }
    if (label.length > 64) {
      errors.push(`label "${label.slice(0, 20)}…" exceeds 64 characters`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(label)) {
      errors.push(`label "${label}" must be alphanumeric with . _ - separators`);
      continue;
    }
    if (RESERVED_LABELS.includes(label)) {
      errors.push(
        `label "${label}" is reserved by GitHub — a self-hosted runner cannot register with it`,
      );
      continue;
    }
    if (HOSTED_LABELS.includes(label) && !allowHosted) {
      errors.push(
        `label "${label}" names a GitHub-hosted runner image; claiming it takes over every ` +
          'job using it. Re-submit with allowHostedLabels=true to confirm.',
      );
      continue;
    }
    if (seen.has(label)) continue; // case-insensitive dedupe, not an error
    seen.add(label);
    out.push(label);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { labels: out, allowHostedLabels: allowHosted, dryRun: input.dryRun === true },
  };
}

/** Parse the stored comma-separated SSM value into the effective claim list. */
export function parseRunnerLabels(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Serialize labels back to the SSM representation Ingest reads. */
export function serializeRunnerLabels(labels: string[]): string {
  return labels.join(',');
}

// ---- GitHub App relink intake (spec 04 § Settings) --------------------------

/**
 * Validate a relink body's SHAPE only — the fields exist and are strings of plausible size.
 * The real validation is the broker's live GitHub verification, and the broker re-validates
 * everything itself (`validateAppCredentials`); this exists so the management API rejects
 * obvious garbage without forwarding it, and so a 400 never quotes a submitted value.
 */
export function validateRelinkBody(
  input: unknown,
): ValidationResult<{
  appId: string;
  pem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  allowHookDesync: boolean;
}> {
  if (!isPlainObject(input)) return { ok: false, errors: ['body must be a JSON object'] };
  const required = ['appId', 'pem', 'webhookSecret', 'clientId', 'clientSecret'] as const;
  const optional = ['allowHookDesync'] as const;
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (
      !(required as readonly string[]).includes(key) &&
      !(optional as readonly string[]).includes(key)
    ) {
      errors.push(`unknown field "${key}"`);
    }
  }
  for (const key of required) {
    const v = input[key];
    if (typeof v !== 'string' || v.trim().length === 0) errors.push(`${key} is required`);
    else if (v.length > 16384) errors.push(`${key} is implausibly large`);
  }
  if (input.allowHookDesync !== undefined && typeof input.allowHookDesync !== 'boolean') {
    errors.push('allowHookDesync must be a boolean');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      appId: String(input.appId).trim(),
      pem: String(input.pem),
      webhookSecret: String(input.webhookSecret),
      clientId: String(input.clientId).trim(),
      clientSecret: String(input.clientSecret),
      // Explicit opt-in: proceed even though GitHub will keep signing with the previous webhook
      // secret. Off by default because the default outcome of a desync is a total delivery
      // outage (see `relinkAction` step 5).
      allowHookDesync: input.allowHookDesync === true,
    },
  };
}

/**
 * Validate a rollback body: `{ restore: { "<param>": <version> }, remove?: ["<param>"] }` —
 * versions and names, never values.
 *
 * `remove` names parameters the relink CREATED (they have no prior version, so undoing them is a
 * deletion). Without it an operator cannot roll back a FIRST link at all: `restore` would be
 * empty and the request a no-op.
 */
export function validateRollbackBody(
  input: unknown,
): ValidationResult<{ restore: Record<string, number>; remove: string[] }> {
  if (!isPlainObject(input)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (key !== 'restore' && key !== 'remove') errors.push(`unknown field "${key}"`);
  }
  const restore: Record<string, number> = {};
  if (input.restore !== undefined) {
    if (!isPlainObject(input.restore)) {
      errors.push('restore must be an object');
    } else {
      for (const [name, version] of Object.entries(input.restore)) {
        if (!/^github\/[a-z-]+$/.test(name)) {
          errors.push('restore keys must be GitHub App credential parameter names');
          continue;
        }
        if (!Number.isSafeInteger(version) || (version as number) < 1) {
          errors.push(`restore["${name}"] must be a positive SSM version`);
          continue;
        }
        restore[name] = version as number;
      }
    }
  }
  const remove: string[] = [];
  if (input.remove !== undefined) {
    if (!Array.isArray(input.remove)) {
      errors.push('remove must be an array of parameter names');
    } else {
      for (const name of input.remove) {
        if (typeof name !== 'string' || !/^github\/[a-z-]+$/.test(name)) {
          errors.push('remove entries must be GitHub App credential parameter names');
          continue;
        }
        if (!remove.includes(name)) remove.push(name);
      }
    }
  }
  if (!errors.length && !Object.keys(restore).length && !remove.length) {
    errors.push('rollback must name at least one parameter version to restore or to remove');
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { restore, remove } };
}

/** Validate a webhook-test body: an optional positive delivery id. */
export function validateWebhookTestBody(input: unknown): ValidationResult<{ deliveryId?: number }> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isPlainObject(input)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors = Object.keys(input)
    .filter((k) => k !== 'deliveryId')
    .map((k) => `unknown field "${k}"`);
  if (input.deliveryId !== undefined) {
    if (!Number.isSafeInteger(input.deliveryId) || (input.deliveryId as number) < 1) {
      errors.push('deliveryId must be a positive integer');
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: input.deliveryId === undefined ? {} : { deliveryId: input.deliveryId as number },
  };
}

/** Parse + clamp a `limit` query param. */
export function parseLimit(raw: string | undefined, def = 50, max = 200): number {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return def;
  return Math.min(n, max);
}

/**
 * Parse an epoch-milliseconds query param (the log viewer's tail watermark). Returns
 * undefined for anything non-numeric or out of range so a bogus value falls back to "whole
 * stream" rather than reaching CloudWatch as garbage.
 */
export function parseEpochMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

// ---- custom flavors (ADR-040/041) ------------------------------------------

/** Max length of a custom flavor's operator-facing description. Bounds the item + the UI. */
export const MAX_CUSTOM_FLAVOR_DESCRIPTION = 200;

/**
 * Length caps on the operator-supplied variable-length fields.
 *
 * These are a CORRECTNESS property of the store, not cosmetics. `listCustomFlavors` reads ONE
 * DynamoDB query page and `MAX_CUSTOM_FLAVORS_PER_INSTALLATION` (64) is what makes that page
 * provably the whole set — an argument that only holds if a row has a bounded size. DynamoDB's
 * item limit is 400 KiB, so without these caps three rows carrying a few hundred KiB of ARN
 * suffix would exceed a 1 MiB page: later `valid` flavors would silently vanish from the read,
 * dropping their labels out of ingest's claim allowlist (jobs never claimed, no error anywhere)
 * and letting the registration cap itself be bypassed, since it counts only the returned page.
 *
 * Every value is well above what the underlying service actually permits — a microVM image name
 * is far shorter than 256, and GitHub bounds an owner at 39 characters and a repo at 100 — so
 * these refuse abuse without constraining any legitimate registration.
 */
export const MAX_IMAGE_ARN_LENGTH = 512;
export const MAX_SMOKE_REPO_LENGTH = 140;
export const MAX_SMOKE_WORKFLOW_PATH_LENGTH = 200;

/**
 * Validate a `POST /api/flavors` body (custom-flavor registration, ADR-040).
 *
 * Collects every error rather than short-circuiting, so an operator fixing a form sees the whole
 * list. Deliberately does NOT check the built-in name collision or probe the image: the collision
 * is enforced by `buildFlavorRecord` (the single writer, so it holds for every path) and the image
 * is probed by the ADR-041 static gate. This validator's job is shape + bounds.
 *
 * `vcpu` IS accepted but is DESCRIPTIVE ONLY (ADR-038): the microVM API takes a memory floor and
 * exposes no vCPU knob, so this figure drives the rate ESTIMATE and the smallest-flavor sort, and
 * must never be presented as provisioned capacity.
 */
export function validateCustomFlavor(
  input: unknown,
  opts: { maxMemoryMb?: number } = {},
): ValidationResult<Omit<RegisterFlavorInput, 'installationId' | 'actor'>> {
  if (!isPlainObject(input)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  const allowed = new Set([
    'name',
    'vcpu',
    'memoryMb',
    'capabilities',
    'description',
    'imageArn',
    'smokeRepoFullName',
    'smokeWorkflowPath',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  }

  // The operator supplies the BASE name; `custom-` is added by the store, never by the client.
  const base = typeof input.name === 'string' ? input.name.trim() : input.name;
  const nameError = customFlavorBaseNameError(base);
  if (nameError) errors.push(`name: ${nameError}`);

  const vcpu = input.vcpu;
  if (typeof vcpu !== 'number' || !Number.isFinite(vcpu) || vcpu < 1 || vcpu > 16) {
    errors.push('vcpu must be a number between 1 and 16 (descriptive only — ADR-038)');
  }

  const max = opts.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB;
  const memoryMb = input.memoryMb;
  if (
    typeof memoryMb !== 'number' ||
    !Number.isInteger(memoryMb) ||
    memoryMb < MIN_MEMORY_MB ||
    memoryMb > max
  ) {
    errors.push(`memoryMb must be an integer between ${MIN_MEMORY_MB} and ${max}`);
  }

  let capabilities: string[] = [];
  if (input.capabilities === undefined) {
    capabilities = [];
  } else if (
    !Array.isArray(input.capabilities) ||
    input.capabilities.some((c) => typeof c !== 'string')
  ) {
    errors.push('capabilities must be an array of strings');
  } else {
    capabilities = (input.capabilities as string[]).map((c) => c.trim()).filter(Boolean);
    if (!areCapabilitiesKnown(capabilities)) {
      const unknown = capabilities.filter((c) => !KNOWN_CAPABILITIES.includes(c));
      errors.push(
        `capabilities must be drawn from the closed vocabulary (${KNOWN_CAPABILITIES.join(', ')}); unknown: ${unknown.join(', ')}`,
      );
    }
  }

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description) errors.push('description is required');
  else if (description.length > MAX_CUSTOM_FLAVOR_DESCRIPTION) {
    errors.push(`description is longer than ${MAX_CUSTOM_FLAVOR_DESCRIPTION} characters`);
  } else if (advertisesVcpuShape(description)) {
    // ADR-038: only memory is requestable, so a description promising "2 vCPU" advertises a shape
    // the API cannot be asked for. The source-level guard forbids this for built-in descriptions;
    // a custom description reaches the same console table and must not be able to say it either.
    errors.push(
      'description must not advertise a vCPU shape — only memory is requestable (ADR-038); ' +
        'describe the toolchain instead',
    );
  }

  const imageArn = typeof input.imageArn === 'string' ? input.imageArn.trim() : '';
  if (!imageArn) errors.push('imageArn is required');
  else if (!isMicrovmImageArn(imageArn)) {
    errors.push('imageArn must be a microVM image ARN (arn:<partition>:lambda:<region>:<account>:microvm-image/<name>)');
  }

  let smokeRepoFullName: string | undefined;
  if (input.smokeRepoFullName !== undefined) {
    const r = typeof input.smokeRepoFullName === 'string' ? input.smokeRepoFullName.trim() : '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(r) || r.length > MAX_SMOKE_REPO_LENGTH) {
      errors.push(
        `smokeRepoFullName must be "owner/repo" and at most ${MAX_SMOKE_REPO_LENGTH} characters`,
      );
    } else {
      smokeRepoFullName = r;
    }
  }

  let smokeWorkflowPath: string | undefined;
  if (input.smokeWorkflowPath !== undefined) {
    const p = typeof input.smokeWorkflowPath === 'string' ? input.smokeWorkflowPath.trim() : '';
    // Confined to the workflows directory: this path is handed to GitHub's
    // `workflow_dispatch` API, and a traversal-ish value is a request we should never send.
    if (
      !p ||
      !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(p) ||
      p.length > MAX_SMOKE_WORKFLOW_PATH_LENGTH
    ) {
      errors.push(
        `smokeWorkflowPath must be a .github/workflows/*.yml path of at most ${MAX_SMOKE_WORKFLOW_PATH_LENGTH} characters`,
      );
    } else {
      smokeWorkflowPath = p;
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      base: base as string,
      vcpu: vcpu as number,
      memoryMb: memoryMb as number,
      capabilities,
      description,
      imageArn,
      ...(smokeRepoFullName ? { smokeRepoFullName } : {}),
      ...(smokeWorkflowPath ? { smokeWorkflowPath } : {}),
    },
  };
}

/**
 * Whether a description advertises a vCPU shape (ADR-038 honesty rule).
 *
 * Matches the spirit of the repo's source-level guard over `microvm/flavors.json` descriptions:
 * a count next to a vCPU/core word. `test/image-content.test.mjs` enforces it for built-ins;
 * this enforces it for operator-supplied text, which lands in the same table.
 */
export function advertisesVcpuShape(description: string): boolean {
  return /\b\d+(\.\d+)?\s*(v?cpus?|vcpu|cores?|threads?)\b/i.test(description);
}

/**
 * Whether a string looks like a microVM image ARN.
 *
 * Length-capped as well as shape-checked: the ARN is persisted on the flavor row, and an unbounded
 * one would break the single-page `listCustomFlavors` invariant — see {@link MAX_IMAGE_ARN_LENGTH}.
 */
export function isMicrovmImageArn(arn: string): boolean {
  return (
    arn.length <= MAX_IMAGE_ARN_LENGTH &&
    /^arn:[a-z0-9-]+:lambda:[a-z0-9-]+:\d{12}:microvm-image\/[\w.-]+$/.test(arn)
  );
}

/** Validate a `POST /api/flavors/{name}/revalidate` body (optionally repointing the image). */
export function validateRevalidateBody(
  input: unknown,
): ValidationResult<{ imageArn?: string }> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isPlainObject(input)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (key !== 'imageArn') errors.push(`unknown field "${key}"`);
  }
  let imageArn: string | undefined;
  if (input.imageArn !== undefined) {
    const arn = typeof input.imageArn === 'string' ? input.imageArn.trim() : '';
    if (!arn || !isMicrovmImageArn(arn)) errors.push('imageArn must be a microVM image ARN');
    else imageArn = arn;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: imageArn ? { imageArn } : {} };
}
