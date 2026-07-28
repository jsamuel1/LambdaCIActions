#!/usr/bin/env node
// CDK app entrypoint for LambdaCIActions.
//
// M1 scope (see docs/ROADMAP.md): ImageStack (compute-plane image build infra) +
// ControlStack (webhook → ingest → SQS → provision → microVM). DataStack lands with M2,
// MgmtStack + WebStack with M4 (management plane + console).
//
// Environment selection: `-c env=dev|prod` (default dev). Account/region are PINNED in
// `.env.local` (ADR-018, see .env.local.example) — deploys refuse to run against ambient
// credentials that don't match the pin. Credential-less `cdk synth` (CI gate) is exempt.
// Secrets are NEVER defined here — they are created out-of-band (ADR-008) and referenced
// by ARN/path inside the stacks.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { ImageStack } from '../lib/image-stack.js';
import { ControlStack } from '../lib/control-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { MgmtStack } from '../lib/mgmt-stack.js';
import { WebStack } from '../lib/web-stack.js';
import { loadEnvLocal, validateTarget } from '../lib/deploy-env.js';

const app = new App();

const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
const requestedRegion = (app.node.tryGetContext('region') as string | undefined) ?? null;

// Deploy-target pin (ADR-018). CDK_DEFAULT_ACCOUNT is only set when the CDK CLI resolved
// real credentials — i.e. any invocation that COULD reach an account (deploy, diff,
// credentialed synth). In that case .env.local is mandatory and must match the ambient
// account. Credential-less synth (CI build gate, fresh worktrees) proceeds unpinned.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envLocal = loadEnvLocal(repoRoot);
const ambientAccount = process.env.CDK_DEFAULT_ACCOUNT;

let account: string | undefined;
let region: string;
if (ambientAccount || envLocal) {
  const target = validateTarget(envLocal, { region: requestedRegion });
  if (ambientAccount && ambientAccount !== target.account) {
    throw new Error(
      `Deploy-target mismatch: credentials resolve to account ${ambientAccount}, but .env.local ` +
        `pins LCA_DEPLOY_ACCOUNT=${target.account}.\n` +
        'Switch AWS_PROFILE/credentials to the pinned account, or update .env.local deliberately.',
    );
  }
  account = target.account;
  region = target.region;
} else {
  // No credentials AND no pin: synth-only path (CI). Nothing can be deployed from here.
  account = undefined;
  region = requestedRegion ?? process.env.CDK_DEFAULT_REGION ?? 'us-west-2';
}

const env = { account, region };
const ssmPrefix = `/lca/${envName}`;
const tagPrefix = 'lca';

// Phase 1: compute-plane image infra (deploy first; images built out-of-band by
// scripts/build-images.mjs, which publishes image ARNs to SSM).
const imageStack = new ImageStack(app, `LCA-Image-${envName}`, {
  env,
  envName,
  ssmPrefix,
});

// Phase 1: shared data plane (DynamoDB single-table, ADR-009). Deployed alongside infra —
// the control plane reads its table name from SSM, so there's no hard CFN dependency, but
// the table must exist before Ingest/Provision/Reaper run.
const dataStack = new DataStack(app, `LCA-Data-${envName}`, {
  env,
  envName,
  ssmPrefix,
});

// Phase 3: control plane. Depends on image ARNs living in SSM (published by the build
// script in phase 2) and the shared table (DataStack). We add explicit stack dependencies
// so `cdk deploy --all` orders them, though the real gate is the phased deploy (spec 05).
const controlStack = new ControlStack(app, `LCA-Control-${envName}`, {
  env,
  envName,
  ssmPrefix,
  tagPrefix,
  table: dataStack.table,
});
controlStack.addDependency(imageStack);
controlStack.addDependency(dataStack);

// Phase 4 (M4): management plane. The console API reads the shared table + run logs and
// enqueues manual re-scans onto the control plane's discovery queue.
//
// `publicOrigin` is the console's CloudFront domain, which does not exist until WebStack's
// first deploy — hence the two-pass bootstrap documented in docs/DEPLOY-M4.md:
//   1. deploy MgmtStack + WebStack (login disabled: no origin),
//   2. re-deploy MgmtStack with `-c publicOrigin=https://<domain>`.
// We refuse to guess an origin because a wrong value is an open-redirect target.
const publicOrigin = (app.node.tryGetContext('publicOrigin') as string | undefined) ?? undefined;
const mgmtStack = new MgmtStack(app, `LCA-Mgmt-${envName}`, {
  env,
  envName,
  ssmPrefix,
  table: dataStack.table,
  discoveryQueueUrl: controlStack.discoveryQueueUrl,
  discoveryQueueArn: controlStack.discoveryQueueArn,
  publicOrigin,
});
mgmtStack.addDependency(dataStack);
mgmtStack.addDependency(controlStack);

// Phase 4 (M4): console hosting. Fronts BOTH the SPA bundle and the management API on one
// CloudFront distribution so the session cookie stays first-party (ADR-024).
const webStack = new WebStack(app, `LCA-Web-${envName}`, {
  env,
  envName,
  apiHost: mgmtStack.apiEndpointHost,
});
webStack.addDependency(mgmtStack);

app.synth();
