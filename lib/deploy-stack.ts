import { Stack, StackProps, CfnOutput, Aws } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface DeployStackProps extends StackProps {
  envName: string;
  /** `owner/repo` allowed to assume the deploy role. */
  githubRepo: string;
  /**
   * Git refs allowed to assume the role, as full ref paths (`refs/heads/main`).
   * Wildcards are REJECTED — see the constructor.
   */
  githubRefs: string[];
  /**
   * ARN of an EXISTING `token.actions.githubusercontent.com` provider. Defaults to the
   * canonical ARN for this account, which is the only shape it can have — the resource is an
   * account-level singleton keyed by issuer URL. Override only for a provider in another
   * account (not a supported topology here) or in tests.
   */
  existingProviderArn?: string;
  /**
   * Create the OIDC provider instead of referencing it. OFF by default, and that default is
   * the safe one: `CreateOpenIDConnectProvider` fails with EntityAlreadyExists if the account
   * already has one (most do — any prior GitHub-OIDC workload created it), and the CDK
   * construct drags in a custom-resource Lambda whose role holds
   * `iam:CreateOpenIDConnectProvider` on `Resource: "*"`. Only set this for a genuinely fresh
   * account, after checking:
   *
   *   aws iam list-open-id-connect-providers
   */
  createProvider?: boolean;
  /** CDK bootstrap qualifier whose roles this role may assume. Default `hnb659fds`. */
  bootstrapQualifier?: string;
  /**
   * Extra regions whose bootstrap roles the role may assume, beyond the stack's own region.
   * Needed only when a deploy spans regions (e.g. the us-east-1 cert stack, ADR-036).
   */
  additionalBootstrapRegions?: string[];
}

/** GitHub's OIDC issuer. Fixed by GitHub; not configurable. */
const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/**
 * DeployStack — the CI deploy identity (ADR-047).
 *
 * ## Why this is a separate stack
 * It holds the credential that CD uses to deploy the other stacks. If it were part of that
 * set, a CD run could rewrite its own trust policy or permissions — and a broken deploy
 * would take out the identity needed to deploy the fix. It is deployed from a workstation,
 * deliberately, and is never in CD's stack allowlist.
 *
 * ## Why GitHub OIDC and not the microVM exec role
 * The obvious shortcut is to let the runner's own AWS identity deploy. It is closed: the
 * runner's `lca-<env>-microvm-exec` is ONE role shared by every microVM in the environment,
 * and those VMs run untrusted workflow code from every onboarded repo. ADR-021 cut it to a
 * log group plus one `lambda:InvokeFunction` on the hook broker for exactly that reason.
 * Attaching deploy authority there would hand platform deploy — and destroy — power to every
 * job in every tenant repo. GitHub OIDC keeps the authority bound to a repo+ref claim that
 * workflow code inside a VM cannot forge.
 *
 * ## Trust
 * `sub` is pinned to `repo:<owner>/<repo>:ref:refs/heads/<branch>` for explicit refs only.
 * A wildcard repo or ref would let any fork's pull-request workflow — i.e. any GitHub user —
 * assume this role, so the constructor rejects `*` outright instead of documenting the
 * hazard. `aud` is `sts.amazonaws.com`, matching what configure-aws-credentials requests.
 *
 * The OIDC provider is an account-level singleton keyed by issuer URL, so this stack
 * REFERENCES it by its canonical ARN by default and only creates one when explicitly asked
 * (`createProvider`) — see the constructor for why that default matters.
 *
 * ## Permissions and their ceiling
 * The role gets `sts:AssumeRole` on the four CDK bootstrap roles — that is the whole of what
 * `cdk deploy` needs, and it keeps this stack from silently drifting behind the resource
 * surface of the stacks CD deploys. Two read-only grants are added for the workflow's own
 * steps: `cloudformation:DescribeStacks` on the two CD-deployed stacks (to read `ConsoleUrl`
 * between passes) and `lambda:GetFunctionConfiguration` on the mgmt function (to assert
 * `PUBLIC_ORIGIN` actually landed). No IAM action, no `Resource: "*"`, no managed policy.
 *
 * **It is nonetheless admin-by-proxy, and honesty about that matters more than the shape of
 * the policy:** the bootstrap `cfn-exec-role` in this account carries `AdministratorAccess`
 * (the CDKToolkit default — `CloudFormationExecutionPolicies` is empty). Anything the deploy
 * role can push through CloudFormation therefore executes with admin. Narrowing it requires
 * re-bootstrapping with `--cloudformation-execution-policies`, which is out of scope here and
 * tracked as a follow-up. Writing direct CFN/S3/`iam:PassRole` statements instead would NOT
 * fix that — `iam:PassRole` on the same admin `cfn-exec-role` reaches the identical ceiling
 * while being longer, more brittle, and easy to over-grant. The real containment is the trust
 * policy (one repo, one ref) plus the workflow's stack allowlist.
 */
export class DeployStack extends Stack {
  public readonly role: iam.Role;
  public readonly roleArn: string;

  constructor(scope: Construct, id: string, props: DeployStackProps) {
    super(scope, id, props);

    const {
      envName,
      githubRepo,
      githubRefs,
      existingProviderArn,
      createProvider = false,
      bootstrapQualifier = 'hnb659fds',
      additionalBootstrapRegions = [],
    } = props;

    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRepo)) {
      throw new Error(
        `githubRepo must be "owner/repo" with no wildcards (got "${githubRepo}"). A wildcard ` +
          'repository claim would let any repository on GitHub assume the deploy role.',
      );
    }
    if (githubRefs.length === 0) {
      throw new Error('githubRefs must name at least one ref (e.g. refs/heads/main).');
    }
    for (const ref of githubRefs) {
      if (ref.includes('*') || ref.includes('?')) {
        throw new Error(
          `githubRefs must be exact refs, not patterns (got "${ref}"). A wildcard ref would ` +
            'let any branch — including one pushed by a fork PR — assume the deploy role.',
        );
      }
      if (!ref.startsWith('refs/')) {
        throw new Error(`githubRefs entries must be full ref paths like refs/heads/main (got "${ref}").`);
      }
    }

    // Reference by default; create only on request. The provider is keyed by issuer URL and
    // is an account-level singleton: a second one cannot exist, so "reference" is the correct
    // verb for every account that already has one — which, for GitHub OIDC, is most of them
    // (ours already had one from an unrelated project). Getting this backwards fails the whole
    // stack at deploy time with EntityAlreadyExists, and the creating path additionally
    // synthesizes a custom-resource Lambda whose role holds `iam:CreateOpenIDConnectProvider`
    // on `Resource: "*"` — a wildcard IAM write in the stack whose entire purpose is least
    // privilege. Referencing also keeps a teardown of this stack from deleting a provider that
    // unrelated workloads depend on.
    //
    // The referenced ARN is derived, not configured: an OIDC provider ARN has exactly one
    // possible shape per account+issuer.
    const canonicalProviderArn = `arn:${Aws.PARTITION}:iam::${this.account}:oidc-provider/${GITHUB_OIDC_HOST}`;
    if (createProvider && existingProviderArn) {
      throw new Error(
        'createProvider and existingProviderArn are mutually exclusive: pick referencing an ' +
          'existing provider (the default) or creating one, not both.',
      );
    }
    const provider: iam.IOpenIdConnectProvider = createProvider
      ? new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
          url: GITHUB_OIDC_URL,
          clientIds: ['sts.amazonaws.com'],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GitHubOidc',
          existingProviderArn ?? canonicalProviderArn,
        );

    const subs = githubRefs.map((ref) => `repo:${githubRepo}:ref:${ref}`);

    this.role = new iam.Role(this, 'GitHubDeployRole', {
      roleName: `lca-${envName}-github-deploy`,
      // ASCII only: IAM validates `description` against
      // [\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF], so the em dash used elsewhere in this
      // file fails the CreateRole call at deploy time (not at synth).
      description:
        `GitHub Actions CD identity for ${githubRepo} (${githubRefs.join(', ')}) - assumes the ` +
        'CDK bootstrap roles to deploy the management plane. ADR-047.',
      // `StringEquals` on the full sub, never StringLike: a `StringLike` with a trailing
      // wildcard is how these roles usually get over-trusted.
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: subs.length === 1 ? subs[0] : subs,
        },
      }),
    });

    const regions = [this.region, ...additionalBootstrapRegions];
    const bootstrapRoleArns = regions.flatMap((region) =>
      ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
        (kind) => `arn:${Aws.PARTITION}:iam::${this.account}:role/cdk-${bootstrapQualifier}-${kind}-role-${this.account}-${region}`,
      ),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: bootstrapRoleArns,
      }),
    );

    // Read-only, and needed by the workflow itself: after the first pass it reads the
    // console URL out of LCA-Web-<env>'s outputs to feed the second (`-c publicOrigin=`)
    // pass, and the mgmt function's name out of LCA-Mgmt-<env>'s outputs for the assertion
    // below. Scoped to this env's stack ARNs so it cannot enumerate unrelated stacks.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOwnStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          `arn:${Aws.PARTITION}:cloudformation:${this.region}:${this.account}:stack/LCA-Mgmt-${envName}/*`,
          `arn:${Aws.PARTITION}:cloudformation:${this.region}:${this.account}:stack/LCA-Web-${envName}/*`,
        ],
      }),
    );

    // The last CD step asserts PUBLIC_ORIGIN actually landed on the mgmt λ — a green
    // `cdk deploy` does not prove the second pass took effect, and a wrong origin breaks
    // login (ADR-024/ADR-036) rather than failing the deploy. Reading it needs an explicit
    // grant: `cdk deploy` runs under the ASSUMED bootstrap roles, but the workflow's own
    // `aws lambda` call runs as this role. Read-only, and scoped to the one function whose
    // physical name is fixed by MgmtStack (`lca-<env>-mgmt`).
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadMgmtFunctionConfig',
        actions: ['lambda:GetFunctionConfiguration'],
        resources: [
          `arn:${Aws.PARTITION}:lambda:${this.region}:${this.account}:function:lca-${envName}-mgmt`,
        ],
      }),
    );

    this.roleArn = this.role.roleArn;

    new CfnOutput(this, 'GitHubDeployRoleArn', {
      value: this.role.roleArn,
      description:
        'Set as the CD workflow\'s role-to-assume (repo variable LCA_DEPLOY_ROLE_ARN or inline).',
    });
    new CfnOutput(this, 'GitHubOidcProviderArn', {
      value: provider.openIdConnectProviderArn,
      description: createProvider
        ? 'Provider CREATED by this stack (-c createGithubOidcProvider=true).'
        : 'Pre-existing account-level provider, referenced (not managed by this stack).',
    });
    new CfnOutput(this, 'TrustedSubjects', { value: subs.join(', ') });
  }
}
