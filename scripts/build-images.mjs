#!/usr/bin/env node
// @ts-nocheck
/**
 * build-images.mjs — phase 2 of the deploy (spec 05 / ADR-011).
 *
 * For each flavor in microvm/flavors.json:
 *   1. Stage the flavor's Dockerfile.<flavor> as `Dockerfile` in a temp build context.
 *   2. Zip the microvm/ context.
 *   3. Upload the zip to the image code bucket (from ImageStack; discovered via SSM).
 *   4. Trigger `create-microvm-image` from the uploaded context.
 *   5. Poll until CREATED; prune old image versions (keep last N).
 *   6. Publish the resulting image ARN to SSM: <ssmPrefix>/config/image-arn-<flavor>.
 *
 * Zero npm deps — Node built-ins + AWS CLI (matches create-github-app.mjs conventions).
 *
 * Usage:
 *   node scripts/build-images.mjs --env dev --region us-west-2
 *   node scripts/build-images.mjs --env dev --flavor base       # single flavor
 *   node scripts/build-images.mjs --dry-run                     # print plan, no side effects
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MICROVM_DIR = path.join(REPO_ROOT, 'microvm');
const KEEP_VERSIONS = 3;

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
const REGION = args.region || null;
const ONLY_FLAVOR = args.flavor || null;
const DRY_RUN = Boolean(args['dry-run']);
const SSM_PREFIX = `/lca/${ENV}`;

function aws(cliArgs, { capture = true } = {}) {
  const full = REGION ? [...cliArgs, '--region', REGION] : cliArgs;
  if (DRY_RUN) {
    console.log(`  [dry-run] aws ${full.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync('aws', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`aws ${full.slice(0, 2).join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function ssmGet(name) {
  const r = aws(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text']);
  return DRY_RUN ? `<${name}>` : r.stdout.trim();
}

function ssmPut(name, value) {
  aws(['ssm', 'put-parameter', '--name', name, '--value', value, '--type', 'String', '--overwrite']);
  console.log(`  ✓ published ${name}`);
}

function loadFlavors() {
  const catalog = JSON.parse(fs.readFileSync(path.join(MICROVM_DIR, 'flavors.json'), 'utf8'));
  let flavors = catalog.flavors;
  if (ONLY_FLAVOR) flavors = flavors.filter((f) => f.name === ONLY_FLAVOR);
  if (flavors.length === 0) throw new Error(`no flavor matched --flavor ${ONLY_FLAVOR}`);
  return flavors;
}

// Stage <dockerfile> as `Dockerfile` in a temp copy of microvm/, then zip it.
function stageAndZip(flavor) {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `lca-img-${flavor.name}-`));
  // shallow copy of microvm/ (Dockerfiles + bootstrap + flavors.json)
  cpDir(MICROVM_DIR, stageDir);
  const src = path.join(stageDir, flavor.dockerfile);
  if (!fs.existsSync(src)) throw new Error(`missing ${flavor.dockerfile} for flavor ${flavor.name}`);
  fs.copyFileSync(src, path.join(stageDir, 'Dockerfile'));

  const zipPath = path.join(os.tmpdir(), `lca-${flavor.name}-${Date.now()}.zip`);
  const r = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: stageDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`zip failed for ${flavor.name}: ${r.stderr}`);
  return { zipPath, stageDir };
}

function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function buildFlavor(flavor, bucket) {
  console.log(`\n=== flavor: ${flavor.name} (${flavor.arch}, ${flavor.vcpu}vCPU/${flavor.memoryMb}MB) ===`);
  if (flavor.arch !== 'arm64') {
    // AGENTS.md hard rule — microVMs are Graviton only.
    throw new Error(`flavor ${flavor.name} arch=${flavor.arch}; microVMs are arm64 only`);
  }

  const { zipPath } = stageAndZip(flavor);
  const key = `image-contexts/${flavor.name}/${path.basename(zipPath)}`;
  console.log(`  staged + zipped → ${zipPath}`);

  aws(['s3', 'cp', zipPath, `s3://${bucket}/${key}`]);
  console.log(`  uploaded → s3://${bucket}/${key}`);

  // Trigger the snapshot build from the uploaded context. The exact param shape depends on
  // the create-microvm-image API; we pass the context location + a name tagged by flavor.
  const imageName = `lca-${ENV}-${flavor.name}`;
  const r = aws([
    'lambda',
    'create-microvm-image',
    '--image-name',
    imageName,
    '--architecture',
    flavor.arch,
    '--code',
    `S3Bucket=${bucket},S3Key=${key}`,
  ]);
  const imageArn = DRY_RUN ? `arn:aws:lambda:${REGION || 'REGION'}:ACCOUNT:microvm-image/${imageName}` : JSON.parse(r.stdout).ImageArn;
  console.log(`  build triggered → ${imageArn}`);

  pollUntilCreated(imageArn);
  pruneOldVersions(imageName);

  ssmPut(`${SSM_PREFIX}/config/image-arn-${flavor.name}`, imageArn);
  return imageArn;
}

function pollUntilCreated(imageArn) {
  if (DRY_RUN) {
    console.log('  [dry-run] would poll get-microvm-image until state=CREATED');
    return;
  }
  const deadline = Date.now() + 20 * 60 * 1000; // 20 min ceiling
  for (;;) {
    const r = aws(['lambda', 'get-microvm-image', '--image-identifier', imageArn]);
    const state = JSON.parse(r.stdout).State;
    console.log(`  state=${state}`);
    if (state === 'CREATED') return;
    if (state === 'FAILED') throw new Error(`image build FAILED for ${imageArn}`);
    if (Date.now() > deadline) throw new Error(`image build timed out for ${imageArn}`);
    spawnSync('sleep', ['15']);
  }
}

function pruneOldVersions(imageName) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would keep last ${KEEP_VERSIONS} versions of ${imageName}`);
    return;
  }
  try {
    const r = aws(['lambda', 'list-microvm-images', '--output', 'json']);
    const images = (JSON.parse(r.stdout).Images || [])
      .filter((im) => im.ImageName === imageName)
      .sort((a, b) => new Date(b.CreatedAt) - new Date(a.CreatedAt));
    for (const stale of images.slice(KEEP_VERSIONS)) {
      aws(['lambda', 'delete-microvm-image', '--image-identifier', stale.ImageArn]);
      console.log(`  pruned old image ${stale.ImageArn}`);
    }
  } catch (e) {
    console.log(`  (prune skipped: ${e.message})`);
  }
}

function main() {
  const flavors = loadFlavors();
  console.log(`Building ${flavors.length} flavor(s) for env=${ENV}${DRY_RUN ? ' (dry-run)' : ''}`);

  const bucket = DRY_RUN ? '<image-code-bucket>' : ssmGet(`${SSM_PREFIX}/config/image-code-bucket`);
  console.log(`code bucket: ${bucket}`);

  const results = {};
  for (const flavor of flavors) results[flavor.name] = buildFlavor(flavor, bucket);

  console.log('\nDone. Image ARNs published to SSM:');
  for (const [name, arn] of Object.entries(results)) console.log(`  ${name}: ${arn}`);
  console.log('\nNext: deploy the orchestrator (cdk deploy LCA-Control-<env>).');
}

main();
