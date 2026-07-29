#!/usr/bin/env node
// @ts-nocheck
/**
 * backfill-installs.mjs — one-shot migration: stamp GSI1 keys onto pre-M4 installation rows.
 *
 * Why: `listInstallations()` enumerates installations via the GSI1 `INSTALLS` partition
 * (src/shared/install-store.ts). The `gsi1pk`/`gsi1sk` write landed in M4 (commit 63069ff),
 * so any INSTALL row written by M2-era code is invisible to that query and the console's
 * Setup screen renders the empty state for an installation the platform is actively serving.
 * GitHub never re-sends `installation.created`, so it does not self-heal. See ADR-029.
 *
 * This stamps `gsi1pk=INSTALLS`, `gsi1sk=<accountLogin>` on every `entity=INSTALL` row that
 * lacks `gsi1pk`. Idempotent: the update is conditional on `attribute_not_exists(gsi1pk)`,
 * and a second run finds nothing to do.
 *
 * A `Scan` with a filter is acceptable here: one-shot, and installations are one row per
 * GitHub account that installed the App (tens, not millions).
 *
 * DRY RUN IS THE DEFAULT — pass `--apply` to write.
 *
 * Deploy-target pin (ADR-018): required for BOTH dry-run and apply. Unlike build-images /
 * create-github-app, this script's dry run still READS the live table, so an unpinned dry
 * run would report another account's data as if it were the target's. Cheap to satisfy,
 * and it makes "dry run says 1 row" mean the pinned account's 1 row.
 *
 * Zero npm deps — Node built-ins + AWS CLI (matches scripts/ conventions).
 *
 * Usage:
 *   npm run build                                   # the pin guard lives in dist/
 *   npm run backfill:installs                       # dry run against the pinned account
 *   npm run backfill:installs -- --apply            # write
 *   npm run backfill:installs -- --env dev --apply
 *   npm run backfill:installs -- --table lca-dev --apply   # skip SSM table-name lookup
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Must match install-store.ts INSTALLS_GSI1PK.
const INSTALLS_GSI1PK = 'INSTALLS';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const ENV = args.env || 'dev';
const APPLY = Boolean(args.apply);
let REGION = args.region || null;
let TABLE = args.table || null;
const SSM_PREFIX = `/lca/${ENV}`;

// ---------------------------------------------------------------------------
// deploy-target pin (ADR-018) — enforced for reads too, see header.
// ---------------------------------------------------------------------------
async function guardDeployTarget() {
  let mod;
  try {
    mod = await import(path.join(REPO_ROOT, 'dist', 'lib', 'deploy-env.js'));
  } catch {
    console.error('ERROR: dist/lib/deploy-env.js not found — run `npm run build` first.');
    process.exit(1);
  }
  try {
    const target = mod.assertDeployTarget({ repoRoot: REPO_ROOT, region: REGION });
    REGION = target.region; // pin wins
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

function aws(cliArgs) {
  const full = REGION ? [...cliArgs, '--region', REGION] : cliArgs;
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`aws ${full.slice(0, 2).join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function resolveTableName() {
  if (TABLE) return TABLE;
  const r = aws([
    'ssm',
    'get-parameter',
    '--name',
    `${SSM_PREFIX}/config/table-name`,
    '--query',
    'Parameter.Value',
    '--output',
    'text',
  ]);
  return r.stdout.trim();
}

/** Scan (paged) for INSTALL rows with no gsi1pk. Returns raw DDB items. */
function findUnindexedInstalls(table) {
  const items = [];
  let startKey = null;
  do {
    const cmd = [
      'dynamodb',
      'scan',
      '--table-name',
      table,
      '--filter-expression',
      'entity = :e AND attribute_not_exists(gsi1pk)',
      '--expression-attribute-values',
      JSON.stringify({ ':e': { S: 'INSTALL' } }),
      '--output',
      'json',
    ];
    if (startKey) cmd.push('--exclusive-start-key', JSON.stringify(startKey));
    const res = JSON.parse(aws(cmd).stdout);
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey ?? null;
  } while (startKey);
  return items;
}

function stamp(table, item) {
  aws([
    'dynamodb',
    'update-item',
    '--table-name',
    table,
    '--key',
    JSON.stringify({ pk: item.pk, sk: item.sk }),
    '--update-expression',
    'SET gsi1pk = :gpk, gsi1sk = :gsk',
    // Idempotent + concurrency-safe: a row another writer (or a reconcile-on-read) just
    // stamped is skipped rather than overwritten.
    '--condition-expression',
    'attribute_exists(pk) AND attribute_not_exists(gsi1pk)',
    '--expression-attribute-values',
    JSON.stringify({
      ':gpk': { S: INSTALLS_GSI1PK },
      ':gsk': { S: item.accountLogin.S },
    }),
  ]);
}

async function main() {
  await guardDeployTarget();
  const table = resolveTableName();
  console.log(
    `backfill-installs: env=${ENV} region=${REGION} table=${table} mode=${APPLY ? 'APPLY' : 'dry-run'}`,
  );

  const rows = findUnindexedInstalls(table);
  if (rows.length === 0) {
    console.log('✓ nothing to do — every INSTALL row already carries gsi1pk=INSTALLS');
    return;
  }

  let stamped = 0;
  let skipped = 0;
  for (const item of rows) {
    const pk = item.pk?.S ?? '?';
    const login = item.accountLogin?.S;
    if (!login) {
      // gsi1sk is the account login; a row without one cannot be indexed meaningfully.
      // Nothing re-writes it automatically: only `installation.created` calls
      // upsertInstallation (which rewrites the whole row), and GitHub never re-sends that
      // for an existing install — suspend/unsuspend only flip flags. Uninstall/reinstall
      // the App for that account, or repair accountLogin by hand.
      console.warn(`  ! ${pk} has no accountLogin — skipped (needs a reinstall to rewrite)`);
      skipped++;
      continue;
    }
    if (!APPLY) {
      console.log(`  [dry-run] ${pk} → gsi1pk=${INSTALLS_GSI1PK}, gsi1sk=${login}`);
      continue;
    }
    try {
      stamp(table, item);
      console.log(`  ✓ ${pk} → gsi1pk=${INSTALLS_GSI1PK}, gsi1sk=${login}`);
      stamped++;
    } catch (e) {
      if (/ConditionalCheckFailed/.test(e.message)) {
        console.log(`  = ${pk} already indexed by a concurrent writer — skipped`);
        skipped++;
        continue;
      }
      throw e;
    }
  }

  if (!APPLY) {
    console.log(
      `\n${rows.length - skipped} row(s) would be stamped. Re-run with --apply to write.`,
    );
    return;
  }
  console.log(`\n✓ stamped ${stamped} row(s), skipped ${skipped}.`);
  console.log(
    'Verify: aws dynamodb query --table-name ' +
      `${table} --index-name gsi1 --region ${REGION} ` +
      `--key-condition-expression 'gsi1pk = :p' ` +
      `--expression-attribute-values '{":p":{"S":"${INSTALLS_GSI1PK}"}}'`,
  );
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
