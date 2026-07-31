import { flavorNames } from './views.js';
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
 */
export function validateFlavorMap(input: unknown): ValidationResult<Record<string, string>> {
  if (!isPlainObject(input)) return { ok: false, errors: ['flavorMap must be an object'] };
  const errors: string[] = [];
  const known = new Set(flavorNames());
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

/** Validate a `PATCH /api/repos/{repoId}` body. Rejects unknown fields outright. */
export function validateRepoPatch(input: unknown): ValidationResult<RepoConfigPatch> {
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
    } else if (typeof input.defaultFlavor !== 'string' || !flavorNames().includes(input.defaultFlavor)) {
      errors.push(`defaultFlavor must be a known flavor (${flavorNames().join(', ')}) or null to clear`);
    } else {
      patch.defaultFlavor = input.defaultFlavor;
    }
  }
  if (input.flavorMap !== undefined) {
    const fm = validateFlavorMap(input.flavorMap);
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
