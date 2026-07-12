#!/usr/bin/env node
// @ts-nocheck
/**
 * build-images.mjs — phase 2 of the deploy (spec 05 / ADR-011), corrected for the GA
 * `lambda-microvms` API (2025-09-09).
 *
 * For each flavor in microvm/flavors.json:
 *   1. Stage the flavor's Dockerfile.<flavor> as `Dockerfile` in a temp build context.
 *   2. Zip the microvm/ context.
 *   3. Upload the zip to the image code bucket (from ImageStack; discovered via SSM).
 *   4. `aws lambda-microvms create-microvm-image` from the uploaded context (requires a
 *      base image ARN + build role ARN + code-artifact uri).
 *   5. Poll `get-microvm-image` until state=CREATED; prune old image versions (keep last N).
 *   6. Publish the resulting image ARN to SSM: <ssmPrefix>/config/image-arn-<flavor>.
 *
 * Requires AWS CLI >= 2.35.17 (ships the `lambda-microvms` service). See
 * docs/specs/05-infrastructure.md § Toolchain prerequisites.
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

function buildFlavor(flavor, ctx) {
  console.log(`\n=== flavor: ${flavor.name} (${flavor.arch}, ${flavor.vcpu}vCPU/${flavor.memoryMb}MB) ===`);
  if (flavor.arch !== 'arm64') {
    // AGENTS.md hard rule — microVMs are Graviton only.
    throw new Error(`flavor ${flavor.name} arch=${flavor.arch}; microVMs are arm64 only`);
  }

  const { zipPath } = stageAndZip(flavor);
  const key = `image-contexts/${flavor.name}/${path.basename(zipPath)}`;
  console.log(`  staged + zipped → ${zipPath}`);

  aws(['s3', 'cp', zipPath, `s3://${ctx.bucket}/${key}`]);
  console.log(`  uploaded → s3://${ctx.bucket}/${key}`);

  // Trigger the snapshot build via the GA lambda-microvms API (ADR-015):
  //   create-microvm-image --base-image-arn <managed al2023 arm64>
  //                         --build-role-arn <ImageStack role>
  //                         --code-artifact uri=s3://... --name <image>
  // Returns { imageArn, imageVersion, state:CREATING }. Poll get-microvm-image for CREATED.
  const imageName = `lca-${ENV}-${flavor.name}`;
  const r = aws([
    'lambda-microvms',
    'create-microvm-image',
    '--base-image-arn',
    ctx.baseImageArn,
    '--build-role-arn',
    ctx.buildRoleArn,
    '--code-artifact',
    `uri=s3://${ctx.bucket}/${key}`,
    '--name',
    imageName,
    '--description',
    `LambdaCIActions ${flavor.name} flavor (${ENV})`,
  ]);
  const imageArn = DRY_RUN
    ? `arn:aws:lambda:${REGION || 'REGION'}:ACCOUNT:microvm-image:${imageName}`
    : JSON.parse(r.stdout).imageArn;
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
    const r = aws(['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn]);
    const state = JSON.parse(r.stdout).state;
    console.log(`  state=${state}`);
    if (state === 'CREATED' || state === 'UPDATED') return;
    if (state === 'CREATE_FAILED' || state === 'UPDATE_FAILED') {
      throw new Error(`image build ${state} for ${imageArn}`);
    }
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
    // Each rebuild of the same image name adds a VERSION; prune old versions, keep last N.
    const r = aws([
      'lambda-microvms',
      'list-microvm-image-versions',
      '--image-identifier',
      imageName,
      '--output',
      'json',
    ]);
    const versions = (JSON.parse(r.stdout).items || [])
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    for (const stale of versions.slice(KEEP_VERSIONS)) {
      aws([
        'lambda-microvms',
        'delete-microvm-image-version',
        '--image-identifier',
        imageName,
        '--image-version',
        stale.imageVersion,
      ]);
      console.log(`  pruned old version ${imageName}:${stale.imageVersion}`);
    }
  } catch (e) {
    console.log(`  (prune skipped: ${e.message})`);
  }
}

function discoverBaseImageArn() {
  if (DRY_RUN) return `arn:aws:lambda:${REGION || 'REGION'}:aws:microvm-image:al2023-1`;
  // The managed arm64 AL2023 base image. list-managed-microvm-images is the source of truth
  // per region; pick the al2023 base (fall back to the first managed image).
  const r = aws(['lambda-microvms', 'list-managed-microvm-images', '--output', 'json']);
  const items = JSON.parse(r.stdout).items || [];
  if (items.length === 0) throw new Error('no managed microVM base images in this region');
  const al2023 = items.find((i) => /al2023/i.test(i.imageArn));
  return (al2023 || items[0]).imageArn;
}

function main() {
  const flavors = loadFlavors();
  console.log(`Building ${flavors.length} flavor(s) for env=${ENV}${DRY_RUN ? ' (dry-run)' : ''}`);

  const bucket = DRY_RUN ? '<image-code-bucket>' : ssmGet(`${SSM_PREFIX}/config/image-code-bucket`);
  const buildRoleArn = DRY_RUN
    ? '<image-build-role-arn>'
    : ssmGet(`${SSM_PREFIX}/config/image-build-role-arn`);
  const baseImageArn = discoverBaseImageArn();
  console.log(`code bucket:    ${bucket}`);
  console.log(`build role:     ${buildRoleArn}`);
  console.log(`base image ARN: ${baseImageArn}`);

  const ctx = { bucket, buildRoleArn, baseImageArn };
  const results = {};
  for (const flavor of flavors) results[flavor.name] = buildFlavor(flavor, ctx);

  console.log('\nDone. Image ARNs published to SSM:');
  for (const [name, arn] of Object.entries(results)) console.log(`  ${name}: ${arn}`);
  console.log('\nNext: deploy the orchestrator (cdk deploy LCA-Control-<env>).');
}

main();
