import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Stack runs from dist/lib/ at synth time; NodejsFunction needs the real .ts SOURCE tree
// (esbuild bundles from source), which lives at <repoRoot>/src.
const SRC = path.join(__dirname, '..', '..', 'src');

export interface ControlStackProps extends StackProps {
  envName: string;
  ssmPrefix: string; // /lca/<env>
  tagPrefix: string; // lca
}

/**
 * ControlStack — the M1 hot path (spec 01 + 02 + 05, phase 3).
 *
 *   API GW (HTTP) POST /webhook → Ingest λ → SQS (FIFO + DLQ) → Provision λ → run-microvm
 *
 * Least-privilege IAM (spec 05):
 *   - Ingest reads ONLY the webhook secret + runner-labels params; may SendMessage to the
 *     queue. No GitHub App key, no microVM launch.
 *   - Provision reads the App PEM + image-arn params; mints tokens (egress); launches +
 *     terminates ONLY microVMs tagged `lca:managed=true`.
 *
 * Secrets are referenced by SSM path (ADR-008); this stack never creates them.
 */
export class ControlStack extends Stack {
  constructor(scope: Construct, id: string, props: ControlStackProps) {
    super(scope, id, props);

    const { envName, ssmPrefix, tagPrefix } = props;
    const paramArn = (name: string) =>
      `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;

    // ---- SQS: provisioning requests + DLQ (FIFO for (repo,run,job) dedupe) ----
    const dlq = new sqs.Queue(this, 'ProvisionDLQ', {
      queueName: `lca-${envName}-provision-dlq.fifo`,
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: Duration.days(14),
    });
    const queue = new sqs.Queue(this, 'ProvisionQueue', {
      queueName: `lca-${envName}-provision.fifo`,
      fifo: true,
      contentBasedDeduplication: false, // Ingest sets an explicit dedup id
      // Give Provision headroom over the Lambda timeout to avoid premature redelivery.
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ---- Ingest λ ----
    const bundling = {
      minify: true,
      sourceMap: false,
      target: 'node20',
    };
    const ingestLogGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-ingest`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const ingest = new NodejsFunction(this, 'IngestFn', {
      functionName: `lca-${envName}-ingest`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64, // arm64 everywhere (ADR-010)
      entry: path.join(SRC, 'ingest', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(10),
      memorySize: 256,
      logGroup: ingestLogGroup,
      bundling,
      environment: {
        WEBHOOK_SECRET_PARAM: `${ssmPrefix}/github/webhook-secret`,
        RUNNER_LABELS_PARAM: `${ssmPrefix}/config/runner-labels`,
        QUEUE_URL: queue.queueUrl,
      },
    });
    queue.grantSendMessages(ingest);
    ingest.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadWebhookConfig',
        actions: ['ssm:GetParameter'],
        resources: [
          paramArn(`${ssmPrefix}/github/webhook-secret`),
          paramArn(`${ssmPrefix}/config/runner-labels`),
        ],
      }),
    );

    // ---- Provision λ ----
    const provisionLogGroup = new logs.LogGroup(this, 'ProvisionLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-provision`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const provision = new NodejsFunction(this, 'ProvisionFn', {
      functionName: `lca-${envName}-provision`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(SRC, 'provision', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(60),
      memorySize: 512,
      // Bound launch rate → protects the microVM quota (spec 05).
      reservedConcurrentExecutions: 10,
      logGroup: provisionLogGroup,
      bundling,
      environment: {
        APP_ID_PARAM: `${ssmPrefix}/github/app-id`,
        APP_PEM_PARAM: `${ssmPrefix}/github/app-pem`,
        IMAGE_ARN_PARAM_PREFIX: `${ssmPrefix}/config/image-arn-`,
        TAG_PREFIX: tagPrefix,
      },
    });
    provision.addEventSource(
      new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true }),
    );

    // Provision reads App PEM + image ARNs (path-scoped).
    provision.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadProvisionConfig',
        actions: ['ssm:GetParameter'],
        resources: [
          paramArn(`${ssmPrefix}/github/app-id`),
          paramArn(`${ssmPrefix}/github/app-pem`),
          paramArn(`${ssmPrefix}/config/image-arn-*`),
        ],
      }),
    );
    // Launch/terminate ONLY tagged microVMs (spec 05). RunMicroVM is a create op that
    // stamps the tag; we gate it with a RequestTag condition and terminate by resource tag.
    provision.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'LaunchTaggedMicroVMs',
        actions: ['lambda:RunMicroVM'],
        resources: ['*'],
        conditions: {
          StringEquals: { [`aws:RequestTag/${tagPrefix}:managed`]: 'true' },
        },
      }),
    );
    provision.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TerminateTaggedMicroVMs',
        actions: ['lambda:TerminateMicroVM', 'lambda:GetMicroVM'],
        resources: ['*'],
        conditions: {
          StringEquals: { [`aws:ResourceTag/${tagPrefix}:managed`]: 'true' },
        },
      }),
    );

    // ---- API Gateway: POST /webhook ----
    const httpApi = new apigw.HttpApi(this, 'WebhookApi', {
      apiName: `lca-${envName}-webhook`,
      description: 'LambdaCIActions GitHub webhook receiver',
    });
    httpApi.addRoutes({
      path: '/webhook',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('IngestIntegration', ingest),
    });

    new CfnOutput(this, 'WebhookUrl', {
      value: `${httpApi.apiEndpoint}/webhook`,
      description: 'Set this as the GitHub App hook_attributes.url (scripts/create-github-app.mjs --webhook-url)',
    });
    new CfnOutput(this, 'ProvisionQueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'ProvisionDLQUrl', { value: dlq.queueUrl });
  }
}
