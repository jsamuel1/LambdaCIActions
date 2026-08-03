#!/usr/bin/env node
// CDK app entrypoint for LambdaCIActions.
//
// M1 scope (see docs/ROADMAP.md): ImageStack (compute-plane image build infra) +
// ControlStack (webhook → ingest → SQS → provision → microVM). DataStack lands with M2,
// MgmtStack + WebStack with M4 (management plane + console).
//
// Environment selection: `-c env=dev|prod` (default dev). Account/region are PINNED — in
// `.env.local` on a workstation (ADR-018, see .env.local.example) or in the process
// environment on a CI runner, which has no gitignored file to read (ADR-047). Deploys refuse
// to run against ambient credentials that don't match the pin, whichever source it came from.
// Credential-less `cdk synth` (CI build gate) is exempt.
// Secrets are NEVER defined here — they are created out-of-band (ADR-008) and referenced
// by ARN/path inside the stacks.
//
// The console's vanity domain (ADR-036) is also configured in `.env.local`
// (LCA_CONSOLE_HOSTED_ZONE_ID + LCA_CONSOLE_ZONE_NAME): the hosted zone is an
// account-specific resource, and an account owning no domain must still be able to deploy —
// so with those unset every custom-domain resource is skipped and the console serves on the
// raw CloudFront name.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { ImageStack } from '../lib/image-stack.js';
import { ControlStack } from '../lib/control-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { MgmtStack } from '../lib/mgmt-stack.js';
import { WebStack } from '../lib/web-stack.js';
import { CertStack } from '../lib/cert-stack.js';
import { DeployStack } from '../lib/deploy-stack.js';
import { loadEnvLocal, validateTarget } from '../lib/deploy-env.js';
import { envConfig } from '../lib/env-config.js';
import { resolveConsoleDomain } from '../lib/console-domain.js';

const app = new App();

const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
const requestedRegion = (app.node.tryGetContext('region') as string | undefined) ?? null;

// Deploy-target pin (ADR-018, extended by ADR-047). CDK_DEFAULT_ACCOUNT is only set when
// the CDK CLI resolved real credentials — i.e. any invocation that COULD reach an account
// (deploy, diff, credentialed synth). In that case a pin is mandatory (`.env.local`, else
// LCA_DEPLOY_* from the environment) and must match the ambient account. Credential-less
// synth (CI build gate, fresh worktrees) proceeds unpinned.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envLocal = loadEnvLocal(repoRoot);
const ambientAccount = process.env.CDK_DEFAULT_ACCOUNT;

let account: string | undefined;
let region: string;
if (ambientAccount || envLocal) {
  const target = validateTarget(envLocal, { region: requestedRegion, env: envName });
  if (ambientAccount && ambientAccount !== target.account) {
    throw new Error(
      `Deploy-target mismatch: credentials resolve to account ${ambientAccount}, but the deploy ` +
        `pin sets LCA_DEPLOY_ACCOUNT=${target.account}.\n` +
        'Switch AWS_PROFILE/credentials to the pinned account, or update the pin deliberately.',
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

// Per-environment config (ADR-033): retention, concurrency, alarm thresholds, tracing.
// `dev` and `prod` are separate ACCOUNTS (spec 05) — this only varies the knobs.
//   -c alarmEmail=oncall@example.com   subscribe the alarm topic (unsubscribed by default)
//   -c rewrite=true                    enable the auto-rewrite PR capability (OFF by default;
//                                      requires the App to hold contents:write — ADR-031)
const alarmEmail = app.node.tryGetContext('alarmEmail') as string | undefined;
const rewriteCtx = app.node.tryGetContext('rewrite') as string | boolean | undefined;
const config = envConfig(envName, {
  alarmEmail,
  // Only the exact string `true` (or boolean true) enables it: `-c rewrite=1` or a typo must
  // NOT switch on a capability that writes to customer repositories.
  ...(rewriteCtx === undefined ? {} : { rewriteEnabled: rewriteCtx === true || rewriteCtx === 'true' }),
});

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
  config,
});
controlStack.addDependency(imageStack);
controlStack.addDependency(dataStack);

// Phase 4 (M4): management plane. The console API reads the shared table + run logs and
// enqueues manual re-scans onto the control plane's discovery queue.
//
// `publicOrigin` (PUBLIC_ORIGIN on the mgmt λ) is the console's browser origin. It is used
// to build the OAuth redirect URI and post-login redirects, so it must match the GitHub
// App's registered callback URL exactly.
//
// With a vanity domain configured (ADR-036) the origin is KNOWN AT SYNTH TIME from config —
// no discovery, no second pass. Without one, the origin is CloudFront's generated domain,
// which does not exist until WebStack's first deploy, so the legacy two-pass bootstrap in
// docs/DEPLOY-M4.md still applies: deploy, then re-deploy MgmtStack with
// `-c publicOrigin=https://<domain>`. We never guess an origin — a wrong value is an
// open-redirect target, so login fails loudly instead.
const consoleDomain = resolveConsoleDomain({
  envName,
  envLocal,
  // CI has no gitignored `.env.local` (ADR-047), so an env whose console runs on a vanity
  // domain must be able to declare it in the workflow environment. Lowest precedence: the
  // file still wins on a workstation. Without this, a CD deploy of such an env would synth
  // with no domain — dropping the CloudFront alias + cert and rewriting PUBLIC_ORIGIN to the
  // raw CloudFront name, which breaks login against the App's registered callback.
  processEnv: process.env as Record<string, string>,
  contextDomain: app.node.tryGetContext('consoleDomain') as string | undefined,
  contextHostedZoneId: app.node.tryGetContext('consoleHostedZoneId') as string | undefined,
  contextZoneName: app.node.tryGetContext('consoleZoneName') as string | undefined,
});

// An explicit `-c publicOrigin=` still wins, so an operator can point the API at a
// transitional origin mid-migration (both callbacks registered) without editing config.
const publicOriginOverride = (app.node.tryGetContext('publicOrigin') as string | undefined) ?? undefined;
const publicOrigin = publicOriginOverride ?? consoleDomain?.origin;
const mgmtStack = new MgmtStack(app, `LCA-Mgmt-${envName}`, {
  env,
  envName,
  ssmPrefix,
  table: dataStack.table,
  discoveryQueueUrl: controlStack.discoveryQueueUrl,
  discoveryQueueArn: controlStack.discoveryQueueArn,
  rewriteQueueUrl: controlStack.rewriteQueueUrl,
  rewriteQueueArn: controlStack.rewriteQueueArn,
  publicOrigin,
  config,
});
mgmtStack.addDependency(dataStack);
mgmtStack.addDependency(controlStack);

// Phase 4 (M4): the console's ACM certificate. CloudFront only accepts viewer certs from
// us-east-1, so this stack is region-pinned regardless of LCA_DEPLOY_REGION (ADR-036).
// Only created when a vanity domain is configured.
//
// Cross-region references (WebStack consuming this cert ARN) require a CONCRETE account:
// CDK cannot wire the SSM-reader custom resource for an environment-agnostic stack. That
// only bites if someone forces a domain via `-c` with no pin and no credentials, so fail
// with the actual reason instead of CDK's generic message.
if (consoleDomain && !account) {
  throw new Error(
    `A console domain (${consoleDomain.hostname}) is configured, but no deploy account is ` +
      'resolved. The us-east-1 certificate is a cross-region reference and needs a concrete ' +
      'account.\nFix: pin LCA_DEPLOY_ACCOUNT (ADR-018/ADR-047), or drop the console-domain ' +
      'context flags for a credential-less synth.',
  );
}
const certStack = consoleDomain
  ? new CertStack(app, `LCA-Cert-${envName}`, {
      env: { account, region: 'us-east-1' },
      envName,
      domain: consoleDomain,
    })
  : undefined;

// Phase 4 (M4): console hosting. Fronts BOTH the SPA bundle and the management API on one
// CloudFront distribution so the session cookie stays first-party (ADR-024).
const webStack = new WebStack(app, `LCA-Web-${envName}`, {
  env,
  envName,
  apiHost: mgmtStack.apiEndpointHost,
  domain: consoleDomain ?? undefined,
  certificate: certStack?.certificate,
});
webStack.addDependency(mgmtStack);
if (certStack) webStack.addDependency(certStack);

// CI deploy identity (ADR-047). Its own stack ON PURPOSE: it holds the credential CD uses to
// deploy the management plane, so it must be deployable from a workstation independently and
// must never appear in CD's own stack allowlist — a CD run must not be able to widen its own
// trust policy, and a broken deploy must not take out the identity needed to deploy the fix.
// No stack dependencies for the same reason.
//
//   -c createGithubOidcProvider=true
//        CREATE the account's GitHub OIDC provider. Off by default, and the default is the
//        safe one: the provider is an account-level singleton keyed by issuer URL, so this
//        stack references its canonical ARN unless told otherwise. Creating a second one fails
//        the stack (EntityAlreadyExists), and the creating path also synthesizes a
//        custom-resource role holding `iam:CreateOpenIDConnectProvider` on `Resource: "*"`.
//        Set it only for a genuinely fresh account — check first:
//          aws iam list-open-id-connect-providers
//   -c githubOidcProviderArn=...     override the referenced ARN (rarely needed)
//   -c deployRepo=owner/repo         (default jsamuel1/LambdaCIActions)
//   -c deployRefs=refs/heads/main    comma-separated; exact refs only, wildcards rejected
const deployRepo = (app.node.tryGetContext('deployRepo') as string | undefined) ?? 'jsamuel1/LambdaCIActions';
const deployRefs = ((app.node.tryGetContext('deployRefs') as string | undefined) ?? 'refs/heads/main')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
const createOidcCtx = app.node.tryGetContext('createGithubOidcProvider') as string | boolean | undefined;
new DeployStack(app, `LCA-Deploy-${envName}`, {
  env,
  envName,
  githubRepo: deployRepo,
  githubRefs: deployRefs,
  existingProviderArn: app.node.tryGetContext('githubOidcProviderArn') as string | undefined,
  // Only the exact string `true` (or boolean true) opts in — `-c createGithubOidcProvider=1`
  // or a typo must not switch on a path that adds a wildcard IAM write.
  createProvider: createOidcCtx === true || createOidcCtx === 'true',
  bootstrapQualifier: (app.node.tryGetContext('bootstrapQualifier') as string | undefined) ?? undefined,
  // Deliberately NO extra bootstrap regions, even when a console domain resolves. With a
  // vanity domain the cert lives in us-east-1 (ADR-036) — but `LCA-Cert-<env>` is on CD's
  // forbidden list and `--exclusively` skips it as a WebStack dependency, so CD never deploys
  // into us-east-1 at all: that stack is hand-deployed from a workstation under the operator's
  // own credentials (docs/DEPLOY-M4.md § CD and the vanity console domain). Nothing else in a
  // CD run reaches that region either — WebStack's cross-region cert reference is resolved at
  // deploy time by a custom resource running with the deployed stack's own role, not by the
  // CLI's bootstrap roles, and no stack uses `fromLookup`. Granting them anyway would add four
  // more admin-by-proxy assume-role targets that CD cannot use, inside the one stack whose
  // stated property is that it holds nothing else (ADR-047 (d)). The construct keeps
  // `additionalBootstrapRegions` for a future CD job that genuinely deploys across regions; it
  // is not inferred from console config.
});

app.synth();
