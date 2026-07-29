import { Stack, StackProps, Duration, CfnOutput, Fn } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', '..', 'src');

export interface MgmtStackProps extends StackProps {
  envName: string;
  ssmPrefix: string; // /lca/<env>
  table: ddb.ITable;
  /**
   * Discovery queue URL (ControlStack) so the console can trigger a manual re-scan.
   * Passed as a URL + ARN pair rather than an IQueue to keep MgmtStack deployable
   * without a hard CFN dependency on the control plane.
   */
  discoveryQueueUrl?: string;
  discoveryQueueArn?: string;
  /**
   * Public origin of the console (the CloudFront domain), used to build the OAuth
   * redirect URI and post-login redirects. Set after WebStack's first deploy — see
   * docs/DEPLOY-M4.md; until then login returns 500 by design rather than guessing an
   * origin (an attacker-controlled redirect target would be worse).
   */
  publicOrigin?: string;
}

/**
 * MgmtStack — the management plane (spec 04, M4).
 *
 *   CloudFront → HTTP API (`/api/*`, `/auth/*`) → Mgmt API λ → DynamoDB / CloudWatch Logs
 *
 * Plane boundary (docs/ARCHITECTURE.md, ADR-025): this stack deliberately grants the Mgmt λ
 * a **narrow, mostly-read** posture:
 *   - DynamoDB: table-wide read; writes limited to `UpdateItem` (config patches, plus the
 *     ADR-029 installation index repair — both `SET`s of specific attributes on an existing
 *     row). No `PutItem`/`DeleteItem`, so it cannot forge run rows or delete history.
 *   - SSM: reads ONLY its own OAuth client id/secret + session key. Every other parameter
 *     is checked for presence via `DescribeParameters` (a metadata action that returns no
 *     values) — so no code path can leak a SecureString (spec 04 hard rule).
 *   - CloudWatch Logs: read-only on the per-env run log group.
 *   - NO `lambda:RunMicrovm` / `TerminateMicrovm`, NO GitHub App PEM. It cannot launch
 *     compute or mint installation tokens; the only GitHub calls it makes are OAuth
 *     (its own client creds) and `/user/*` with the operator's token.
 */
export class MgmtStack extends Stack {
  public readonly httpApi: apigw.HttpApi;
  public readonly apiEndpointHost: string;

  constructor(scope: Construct, id: string, props: MgmtStackProps) {
    super(scope, id, props);

    const { envName, ssmPrefix, table } = props;
    const paramArn = (name: string) =>
      `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;

    const logGroup = new logs.LogGroup(this, 'MgmtLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-mgmt`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const runLogGroupName = `/aws/lambda/microvms/runs/lca-${envName}`;

    const fn = new NodejsFunction(this, 'MgmtFn', {
      functionName: `lca-${envName}-mgmt`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, // arm64 everywhere (ADR-010)
      entry: path.join(SRC, 'mgmt', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(29), // HTTP API integration cap
      memorySize: 512,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        externalModules: ['@aws-sdk/client-lambda'],
      },
      environment: {
        LCA_ENV: envName,
        SSM_PREFIX: ssmPrefix,
        SESSION_SECRET_PARAM: `${ssmPrefix}/mgmt/session-secret`,
        OAUTH_CLIENT_ID_PARAM: `${ssmPrefix}/github/client-id`,
        OAUTH_CLIENT_SECRET_PARAM: `${ssmPrefix}/github/client-secret`,
        RUN_LOG_GROUP: runLogGroupName,
        TABLE_NAME: table.tableName,
        DISCOVERY_QUEUE_URL: props.discoveryQueueUrl ?? '',
        PUBLIC_ORIGIN: props.publicOrigin ?? '',
      },
    });

    // Reads across all entities (runs, installs, repos, workflow analyses).
    table.grantReadData(fn);
    // Config writes ONLY: UpdateItem on the table. No Put/Delete → cannot forge or destroy
    // run history, only patch existing rows. The handler restricts what it patches: repo
    // config (enabled/mode/defaultFlavor/flavorMap) and the ADR-029 installation GSI1 index
    // repair (gsi1pk/gsi1sk on an installation the session is already authorized for).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PatchRepoConfig',
        actions: ['dynamodb:UpdateItem'],
        resources: [table.tableArn],
      }),
    );

    // Its OWN secrets only (OAuth client creds + session signing key).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadOwnAuthSecrets',
        actions: ['ssm:GetParameter'],
        resources: [
          paramArn(`${ssmPrefix}/github/client-id`),
          paramArn(`${ssmPrefix}/github/client-secret`),
          paramArn(`${ssmPrefix}/mgmt/session-secret`),
        ],
      }),
    );
    // Presence checks for the Settings screen. DescribeParameters returns metadata only —
    // never a value — so this cannot leak a SecureString even for paths above.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DescribeParamPresence',
        actions: ['ssm:DescribeParameters'],
        resources: ['*'], // DescribeParameters does not support resource-level scoping
      }),
    );

    // Log viewer: read-only, and only the per-env run log group.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadRunLogs',
        actions: ['logs:FilterLogEvents', 'logs:DescribeLogStreams', 'logs:GetLogEvents'],
        resources: [
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:${runLogGroupName}`,
          `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:${runLogGroupName}:*`,
        ],
      }),
    );

    // Manual re-scan: enqueue a discovery request (send only, no receive/delete).
    if (props.discoveryQueueArn) {
      const queue = sqs.Queue.fromQueueArn(this, 'DiscoveryQueueRef', props.discoveryQueueArn);
      queue.grantSendMessages(fn);
    }

    this.httpApi = new apigw.HttpApi(this, 'MgmtApi', {
      apiName: `lca-${envName}-mgmt`,
      description: 'LambdaCIActions management API (spec 04)',
    });
    const integration = new HttpLambdaIntegration('MgmtIntegration', fn);
    // One catch-all per prefix: routing lives in the pure router (src/mgmt/router.ts) so
    // the route table is unit-testable and adding an endpoint isn't a CFN change.
    this.httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [
        apigw.HttpMethod.GET,
        apigw.HttpMethod.POST,
        apigw.HttpMethod.PATCH,
        apigw.HttpMethod.PUT,
      ],
      integration,
    });
    this.httpApi.addRoutes({
      path: '/auth/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration,
    });

    // `apiEndpoint` is https://<id>.execute-api.<region>.amazonaws.com and is a CFN token
    // at synth time — CloudFront needs the bare host, so split with an intrinsic rather
    // than JS string ops (which would operate on the token placeholder).
    this.apiEndpointHost = Fn.select(2, Fn.split('/', this.httpApi.apiEndpoint));

    new CfnOutput(this, 'MgmtApiEndpoint', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'MgmtFunctionName', { value: fn.functionName });
    new CfnOutput(this, 'RunLogGroup', { value: runLogGroupName });
  }
}
