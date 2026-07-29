// deploy-env.ts — deploy-target pin guard (ADR-018).
//
// Every deploy-touching command (cdk synth/deploy via bin/lca.ts, build-images.mjs,
// create-github-app.mjs) MUST run against an explicitly pinned account+region.
// The pin lives in `.env.local` at the repo root (gitignored; see .env.local.example):
//
//   LCA_DEPLOY_ACCOUNT=123456789012   # required — 12-digit target account
//   LCA_DEPLOY_REGION=us-west-2       # required — target region
//   AWS_PROFILE=some-profile          # optional — exported for child aws calls
//
// Rationale: bin/lca.ts previously resolved the account from ambient credentials
// (CDK_DEFAULT_ACCOUNT), so a deploy landed wherever the shell's credentials happened
// to point. The guard compares the pin against the ACTUAL caller identity and refuses
// on mismatch. Credential-less synth (CI) and --dry-run remain exempt — they have no
// side effects and no ambient account to mis-target.
//
// Zero npm deps — Node built-ins + AWS CLI only (matches scripts/ conventions).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface DeployTarget {
  account: string;
  region: string;
  /**
   * The environment this account is pinned for (`dev` / `prod`), or undefined when the pin
   * predates `LCA_DEPLOY_ENV`. See `validateTarget` for why it matters.
   */
  env?: string;
}

export interface EnvLocal {
  [key: string]: string;
}

/** Parse simple KEY=VALUE lines (comments + blanks ignored, surrounding quotes stripped). */
export function parseEnvFile(text: string): EnvLocal {
  const out: EnvLocal = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Read + parse <repoRoot>/.env.local; null if the file doesn't exist. */
export function loadEnvLocal(repoRoot: string): EnvLocal | null {
  const p = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(p)) return null;
  return parseEnvFile(fs.readFileSync(p, 'utf8'));
}

/**
 * Pure validation of the pin contents + any explicitly requested region.
 * Returns the pinned target; throws with an actionable message otherwise.
 * Exported separately so it is unit-testable without fs/STS.
 */
export function validateTarget(
  envLocal: EnvLocal | null,
  opts: { region?: string | null; env?: string | null } = {},
): DeployTarget {
  if (!envLocal) {
    throw new Error(
      '.env.local is missing. Deploys require an explicit target pin (ADR-018).\n' +
        'Fix: cp .env.local.example .env.local   # then set LCA_DEPLOY_ACCOUNT + LCA_DEPLOY_REGION',
    );
  }
  const account = envLocal.LCA_DEPLOY_ACCOUNT;
  const pinnedRegion = envLocal.LCA_DEPLOY_REGION;
  const pinnedEnv = envLocal.LCA_DEPLOY_ENV?.trim() || undefined;
  if (!/^\d{12}$/.test(account ?? '')) {
    throw new Error(
      `.env.local: LCA_DEPLOY_ACCOUNT must be a 12-digit AWS account id (got "${account ?? ''}").`,
    );
  }
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(pinnedRegion ?? '')) {
    throw new Error(
      `.env.local: LCA_DEPLOY_REGION must be a region like us-west-2 (got "${pinnedRegion ?? ''}").`,
    );
  }
  if (pinnedEnv && !/^(dev|prod)$/.test(pinnedEnv)) {
    throw new Error(
      `.env.local: LCA_DEPLOY_ENV must be 'dev' or 'prod' (got "${pinnedEnv}").`,
    );
  }
  // Bind the SELECTED environment to the pinned one (ADR-033). `-c env=prod` /
  // `build-images --env prod` chooses resource names, retention, concurrency and alarm
  // thresholds; the account comes from a separate pin. With nothing tying the two together, a
  // pin for the dev account plus `env=prod` deployed `lca-prod-*` resources — and published
  // prod-namespaced image ARNs — into the DEV account, and the reciprocal was equally
  // possible. dev and prod are separate ACCOUNTS by design (spec 05), so the pin is the only
  // authority on which one this checkout may build.
  if (pinnedEnv && opts.env && opts.env !== pinnedEnv) {
    throw new Error(
      `Deploy-env mismatch: command selected env "${opts.env}" but .env.local pins ` +
        `LCA_DEPLOY_ENV=${pinnedEnv} (account ${account}).\n` +
        `dev and prod are separate accounts (spec 05): deploying "${opts.env}" resources into ` +
        `the ${pinnedEnv} account would cross the boundary.\n` +
        `Fix: use a checkout whose .env.local pins ${opts.env}, or drop the env selector.`,
    );
  }
  if (opts.region && opts.region !== pinnedRegion) {
    throw new Error(
      `Region mismatch: command requested "${opts.region}" but .env.local pins LCA_DEPLOY_REGION=${pinnedRegion}.\n` +
        'Drop the --region/-c region flag (the pin wins) or update .env.local deliberately.',
    );
  }
  return { account, region: pinnedRegion, ...(pinnedEnv ? { env: pinnedEnv } : {}) };
}

/** Resolve the ACTUAL caller account via STS (aws CLI). Throws on failure. */
export function stsCallerAccount(): string {
  const r = spawnSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `Cannot resolve caller identity (aws sts get-caller-identity failed):\n${r.stderr || r.stdout}\n` +
        'Are credentials configured for the pinned account/profile?',
    );
  }
  return r.stdout.trim();
}

/**
 * Full guard for deploy-touching scripts (build-images, create-github-app).
 *   - dryRun: skipped entirely (no file read, no STS) — dry runs have no side effects.
 *   - Loads .env.local, validates the pin, exports AWS_PROFILE from the pin when the
 *     shell didn't set one, then compares the pin against the real STS caller account.
 * Returns the verified target; the caller should use target.region for all AWS calls.
 */
export function assertDeployTarget(opts: {
  repoRoot: string;
  region?: string | null;
  env?: string | null;
  dryRun?: boolean;
  getCaller?: () => string;
}): DeployTarget | null {
  const { repoRoot, region = null, env = null, dryRun = false, getCaller = stsCallerAccount } = opts;
  if (dryRun) return null;
  const envLocal = loadEnvLocal(repoRoot);
  const target = validateTarget(envLocal, { region, env });
  if (envLocal && envLocal.AWS_PROFILE && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = envLocal.AWS_PROFILE;
  }
  const caller = getCaller();
  if (caller !== target.account) {
    throw new Error(
      `Deploy-target mismatch: credentials resolve to account ${caller}, but .env.local pins ` +
        `LCA_DEPLOY_ACCOUNT=${target.account}.\n` +
        'Switch AWS_PROFILE/credentials to the pinned account, or update .env.local deliberately.',
    );
  }
  console.log(`✓ deploy target verified: account ${target.account}, region ${target.region}${target.env ? `, env ${target.env}` : ''}`);
  return target;
}
