#!/usr/bin/env node
// CDK app entrypoint for LambdaCIActions.
//
// M1 scope (see docs/ROADMAP.md): ImageStack (compute-plane image build infra) +
// ControlStack (webhook → ingest → SQS → provision → microVM). DataStack / MgmtStack /
// WebStack / AuthStack land in later milestones.
//
// Environment selection: `-c env=dev|prod` (default dev). Account/region come from the
// standard CDK env vars (CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION) or `-c region=…`.
// Secrets are NEVER defined here — they are created out-of-band (ADR-008) and referenced
// by ARN/path inside the stacks.
import { App } from 'aws-cdk-lib';
import { ImageStack } from '../lib/image-stack.js';
import { ControlStack } from '../lib/control-stack.js';
import { DataStack } from '../lib/data-stack.js';

const app = new App();

const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
const region =
  (app.node.tryGetContext('region') as string | undefined) ??
  process.env.CDK_DEFAULT_REGION ??
  'us-west-2';
const account = process.env.CDK_DEFAULT_ACCOUNT;

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

app.synth();
