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
// ...or, when no `.env.local` exists, in the PROCESS ENVIRONMENT under the same names
// (ADR-047). A checkout on a CI runner is a fresh clone: it cannot carry a gitignored
// file, and committing one would publish the target account and defeat the point. The
// workflow therefore declares the pin inline (`env:` block / repo variables) and the
// guard reads it from there. `.env.local` WINS when both are present, so a workstation
// with a pinned file cannot be silently retargeted by a stray exported variable.
//
// Rationale: bin/lca.ts previously resolved the account from ambient credentials
// (CDK_DEFAULT_ACCOUNT), so a deploy landed wherever the shell's credentials happened
// to point. The guard compares the pin against the ACTUAL caller identity and refuses
// on mismatch — that STS comparison is the actual safety property and is IDENTICAL for
// both pin sources: a pin is a declaration of intent, never a grant. There is no
// "trusted CI" branch and no variable that switches the check off. Credential-less synth
// (CI build gate) and --dry-run remain exempt — they have no side effects and no ambient
// account to mis-target.
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

/** The pin keys readable from the process environment (ADR-047). */
const ENV_PIN_KEYS = ['LCA_DEPLOY_ACCOUNT', 'LCA_DEPLOY_REGION', 'LCA_DEPLOY_ENV'] as const;

/**
 * Collect a pin from the process environment. Returns null when NONE of the keys are set,
 * so an unpinned credential-less synth stays on its exempt path (bin/lca.ts branches on a
 * null pin). A partial pin is deliberately returned as-is: validateTarget then produces the
 * same actionable error it produces for a malformed file, rather than silently ignoring a
 * half-written CI config.
 *
 * AWS_PROFILE is NOT read here: on a runner, credentials come from the OIDC role, and
 * inheriting an operator's profile name would be meaningless at best.
 */
export function pinFromEnv(env: NodeJS.ProcessEnv = process.env): EnvLocal | null {
  const out: EnvLocal = {};
  for (const key of ENV_PIN_KEYS) {
    const val = env[key]?.trim();
    if (val) out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Resolve the deploy-target pin: `<repoRoot>/.env.local` if it exists, else the process
 * environment (ADR-047), else null.
 *
 * File-over-env precedence is deliberate. A workstation's `.env.local` is the operator's
 * standing declaration of which account this checkout may touch; an environment variable is
 * ambient and easy to inherit from a parent shell, a direnv, or a copied command line. If
 * the two disagree the file must win, otherwise an exported variable could quietly redirect
 * a local deploy. (Either way the STS identity check still has to pass, so the worst case is
 * a refusal, not a mis-targeted deploy.)
 */
export function loadEnvLocal(repoRoot: string): EnvLocal | null {
  const p = path.join(repoRoot, '.env.local');
  if (fs.existsSync(p)) return parseEnvFile(fs.readFileSync(p, 'utf8'));
  return pinFromEnv();
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
      'No deploy-target pin found. Deploys require an explicit target pin (ADR-018/ADR-047).\n' +
        '  • workstation: .env.local is missing — cp .env.local.example .env.local, then set\n' +
        '    LCA_DEPLOY_ACCOUNT + LCA_DEPLOY_REGION\n' +
        '  • CI: export LCA_DEPLOY_ACCOUNT + LCA_DEPLOY_REGION in the job environment',
    );
  }
  const account = envLocal.LCA_DEPLOY_ACCOUNT;
  const pinnedRegion = envLocal.LCA_DEPLOY_REGION;
  const pinnedEnv = envLocal.LCA_DEPLOY_ENV?.trim() || undefined;
  if (!/^\d{12}$/.test(account ?? '')) {
    throw new Error(
      `Deploy pin: LCA_DEPLOY_ACCOUNT must be a 12-digit AWS account id (got "${account ?? ''}").`,
    );
  }
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(pinnedRegion ?? '')) {
    throw new Error(
      `Deploy pin: LCA_DEPLOY_REGION must be a region like us-west-2 (got "${pinnedRegion ?? ''}").`,
    );
  }
  if (pinnedEnv && !/^(dev|prod)$/.test(pinnedEnv)) {
    throw new Error(
      `Deploy pin: LCA_DEPLOY_ENV must be 'dev' or 'prod' (got "${pinnedEnv}").`,
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
      `Deploy-env mismatch: command selected env "${opts.env}" but the deploy pin sets ` +
        `LCA_DEPLOY_ENV=${pinnedEnv} (account ${account}).\n` +
        `dev and prod are separate accounts (spec 05): deploying "${opts.env}" resources into ` +
        `the ${pinnedEnv} account would cross the boundary.\n` +
        `Fix: use a checkout whose pin sets ${opts.env}, or drop the env selector.`,
    );
  }
  if (opts.region && opts.region !== pinnedRegion) {
    throw new Error(
      `Region mismatch: command requested "${opts.region}" but the deploy pin sets LCA_DEPLOY_REGION=${pinnedRegion}.\n` +
        'Drop the --region/-c region flag (the pin wins) or update the pin deliberately.',
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
 *   - dryRun: skipped entirely (no pin read, no STS) — dry runs have no side effects.
 *   - Loads the pin (.env.local, else the process environment — ADR-047), validates it,
 *     exports AWS_PROFILE from the pin when the shell didn't set one, then compares the pin
 *     against the real STS caller account.
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
      `Deploy-target mismatch: credentials resolve to account ${caller}, but the deploy pin sets ` +
        `LCA_DEPLOY_ACCOUNT=${target.account}.\n` +
        'Switch AWS_PROFILE/credentials to the pinned account, or update the pin deliberately.',
    );
  }
  console.log(`✓ deploy target verified: account ${target.account}, region ${target.region}${target.env ? `, env ${target.env}` : ''}`);
  return target;
}
