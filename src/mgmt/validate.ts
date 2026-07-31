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
