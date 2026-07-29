// console-domain.ts — vanity console hostname resolution (ADR-036).
//
// The console origin is load-bearing in three places that all break on change:
//   1. `PUBLIC_ORIGIN` on the mgmt λ (OAuth redirect URI + post-login redirect),
//   2. the GitHub App's OAuth **callback URL** — browser-only to edit (GitHub exposes no
//      REST endpoint for App settings; `PATCH /app` does not exist),
//   3. the first-party session cookie's origin (ADR-024).
//
// Pinning those to CloudFront's generated `*.cloudfront.net` name means a distribution
// replacement silently breaks login until a human edits the App in a browser. So the origin
// becomes a **config input** derived before any resource exists, which also removes the
// two-pass `-c publicOrigin=...` bootstrap (docs/DEPLOY-M4.md).
//
// Config is machine-local (`.env.local`, same file as the ADR-018 deploy pin) rather than
// checked in: the hosted zone is an account-specific resource, and a fresh account that
// owns no domain must still be able to deploy. When no domain is configured the raw
// CloudFront path stays fully functional — every custom-domain resource is skipped.
//
// Zero npm deps; pure functions so the scheme is unit-testable without CDK or AWS.

import type { EnvLocal } from './deploy-env.js';

/** Project label inside the zone — the console is named after the project. */
export const CONSOLE_LABEL = 'lambdaciactions';

export interface ConsoleDomainConfig {
  /** Fully-qualified vanity hostname, e.g. `dev.lambdaciactions.example.com`. */
  hostname: string;
  /** `https://<hostname>` — the value for PUBLIC_ORIGIN and the OAuth callback base. */
  origin: string;
  /** Route53 public hosted zone that will hold the alias + ACM validation records. */
  hostedZoneId: string;
  /** Apex of that zone (no trailing dot), e.g. `example.com`. */
  zoneName: string;
}

/**
 * Hostname scheme: **prod owns the project label; every other env is prefixed.**
 *
 *   prod → lambdaciactions.<zone>
 *   dev  → dev.lambdaciactions.<zone>
 *
 * Prod therefore gets the short, permanent name from its very first deploy, so a raw
 * CloudFront callback URL is never registered on the App for prod at all (the reason the
 * scheme is fixed in code rather than configured per env: a typo in a prod hostname costs
 * a browser-only GitHub App edit to fix).
 */
export function consoleHostname(envName: string, zoneName: string): string {
  const zone = normalizeZoneName(zoneName);
  const env = String(envName ?? '').trim();
  // Same grammar as `isDnsName`'s per-label rule: alphanumeric ends, inner hyphens only, and
  // RFC 1035's 63-octet label cap. A trailing hyphen (`dev-`) is the realistic slip — it
  // would otherwise reach ACM + CloudFront + Route53 verbatim and fail mid-deploy, which is
  // the exact failure the LCA_CONSOLE_DOMAIN override path is validated against.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(env) || env.length > 63) {
    throw new Error(
      `Console domain: env name "${envName}" is not a valid DNS label; cannot derive a hostname.`,
    );
  }
  return env === 'prod' ? `${CONSOLE_LABEL}.${zone}` : `${env}.${CONSOLE_LABEL}.${zone}`;
}

/** Strip a trailing dot and lowercase — Route53 reports zone names as `example.com.`. */
export function normalizeZoneName(zoneName: string): string {
  const z = String(zoneName ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!isDnsName(z)) {
    throw new Error(`Console domain: LCA_CONSOLE_ZONE_NAME "${zoneName}" is not a valid DNS name.`);
  }
  return z;
}

/** Every label is alphanumeric-with-inner-hyphens, and there are at least two of them. */
function isDnsName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name);
}

export interface ResolveConsoleDomainInput {
  envName: string;
  /** Parsed `.env.local` (ADR-018 pin file), or null when absent (CI synth). */
  envLocal: EnvLocal | null;
  /** `-c consoleDomain=` — full hostname override, bypasses the scheme. */
  contextDomain?: string;
  /** `-c consoleHostedZoneId=` */
  contextHostedZoneId?: string;
  /** `-c consoleZoneName=` */
  contextZoneName?: string;
}

/**
 * Resolve the console's custom domain, or `null` when none is configured (→ raw CloudFront).
 *
 * Precedence per field: CDK context → `.env.local` → unset. Required pair when enabled:
 * a hosted zone id AND a zone name (the zone name is needed to build the hostname and to
 * construct the zone reference without an AWS lookup, so credential-less synth still works).
 *
 * Configuring a domain is opt-in and **all-or-nothing**: a half-configured domain throws
 * rather than silently falling back, because a silent fallback would deploy a distribution
 * with no alias while `PUBLIC_ORIGIN` pointed at the vanity name — login would break with
 * an `invalid OAuth state` that looks like a cookie bug.
 */
export function resolveConsoleDomain(input: ResolveConsoleDomainInput): ConsoleDomainConfig | null {
  const { envName, envLocal } = input;
  const pick = (ctx: string | undefined, key: string): string | undefined => {
    const v = ctx ?? envLocal?.[key];
    const trimmed = typeof v === 'string' ? v.trim() : '';
    return trimmed === '' ? undefined : trimmed;
  };

  const hostedZoneId = pick(input.contextHostedZoneId, 'LCA_CONSOLE_HOSTED_ZONE_ID');
  const zoneNameRaw = pick(input.contextZoneName, 'LCA_CONSOLE_ZONE_NAME');
  const domainOverride = pick(input.contextDomain, 'LCA_CONSOLE_DOMAIN');

  // Nothing configured at all → raw CloudFront (a fresh account owning no domain).
  if (!hostedZoneId && !zoneNameRaw && !domainOverride) return null;

  if (!hostedZoneId) {
    throw new Error(
      'Console domain is partially configured: a hosted zone id is required.\n' +
        'Fix: set LCA_CONSOLE_HOSTED_ZONE_ID in .env.local (or -c consoleHostedZoneId=...), ' +
        'or clear every LCA_CONSOLE_* key to deploy on the raw CloudFront domain.',
    );
  }
  if (!/^Z[A-Z0-9]{4,}$/.test(hostedZoneId)) {
    throw new Error(
      `Console domain: hosted zone id "${hostedZoneId}" is not a Route53 zone id (e.g. Z01234567ABCDEFGHIJK).\n` +
        "Pass the bare id, not the `/hostedzone/...` path Route53's API returns.",
    );
  }
  if (!zoneNameRaw) {
    throw new Error(
      'Console domain is partially configured: a zone name is required.\n' +
        'Fix: set LCA_CONSOLE_ZONE_NAME in .env.local (or -c consoleZoneName=...) to the zone apex, ' +
        'e.g. example.com.',
    );
  }

  const zoneName = normalizeZoneName(zoneNameRaw);
  let hostname: string;
  if (domainOverride) {
    hostname = domainOverride.trim().toLowerCase().replace(/\.$/, '');
    // The override skips the scheme, so it also skips the label validation the scheme's
    // inputs get. Without this check a typo (space, underscore, empty label) reaches ACM +
    // CloudFront + Route53 verbatim and fails mid-deploy instead of at synth.
    if (!isDnsName(hostname)) {
      throw new Error(
        `Console domain: LCA_CONSOLE_DOMAIN "${domainOverride}" is not a valid DNS hostname.`,
      );
    }
  } else {
    hostname = consoleHostname(envName, zoneName);
    // Belt-and-braces: the label check above cannot see the assembled name, and a zone name
    // long enough to push the FQDN past 253 octets is rejected here rather than at ACM.
    if (!isDnsName(hostname) || hostname.length > 253) {
      throw new Error(
        `Console domain: derived hostname "${hostname}" is not a valid DNS hostname.`,
      );
    }
  }

  // A hostname outside the zone can never be resolved by the alias record we create, and
  // ACM DNS validation would hang forever waiting for a record in the wrong zone.
  if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) {
    throw new Error(
      `Console domain: "${hostname}" is not inside hosted zone "${zoneName}".\n` +
        'The alias + ACM validation records are created in that zone, so the hostname must be a ' +
        'subdomain of it (or the apex itself).',
    );
  }

  return { hostname, origin: `https://${hostname}`, hostedZoneId, zoneName };
}
