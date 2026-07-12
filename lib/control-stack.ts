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
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
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
  table: ddb.ITable; // shared DynamoDB table (DataStack)
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

    const { envName, ssmPrefix, table } = props;
    // NOTE: props.tagPrefix is retained for future taggable resources (e.g. image tags via
    // lambda-microvms TagResource) but is NOT used for microVM launch/terminate isolation —
    // the GA API can't tag VMs (ADR-015). void it to satisfy noUnusedLocals.
    void props.tagPrefix;
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
        TABLE_NAME: table.tableName,
      },
    });
    queue.grantSendMessages(ingest);
    // Ingest writes run rows (queued + status transitions) and installation/repo config.
    table.grantWriteData(ingest);
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
        TABLE_NAME: table.tableName,
      },
    });
    provision.addEventSource(
      new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true }),
    );
    // Provision transitions run rows (provisioning → running / failed).
    table.grantWriteData(provision);

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
    // Launch/terminate microVMs (spec 05, corrected in ADR-015). The GA lambda-microvms
    // API does NOT support tagging a VM at launch, so the pre-GA aws:RequestTag /
    // aws:ResourceTag least-privilege gate is impossible. Isolation instead comes from:
    //   (a) the dedicated per-env execution role stamped on each VM (executionRoleArn),
    //   (b) the run store being the authoritative run↔VM mapping, and
    //   (c) scoping actions to this account/region.
    // Actions use the `lambda:` prefix (lambda-microvms signs as `lambda`) with GA operation
    // casing (`Microvm`, not `MicroVM`).
    provision.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'LaunchMicroVMs',
        actions: ['lambda:RunMicrovm'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': this.region },
        },
      }),
    );
    provision.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TerminateMicroVMs',
        actions: ['lambda:TerminateMicrovm', 'lambda:GetMicrovm'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': this.region },
        },
      }),
    );

    // ---- Reaper λ + EventBridge schedule (spec 02 reaping, M2) ----
    const reaperLogGroup = new logs.LogGroup(this, 'ReaperLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-reaper`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const reaper = new NodejsFunction(this, 'ReaperFn', {
      functionName: `lca-${envName}-reaper`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(SRC, 'reaper', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(120),
      memorySize: 256,
      reservedConcurrentExecutions: 1, // one sweep at a time
      logGroup: reaperLogGroup,
      bundling,
      environment: {
        TABLE_NAME: table.tableName,
      },
    });
    // Reaper reads/updates run rows (incl. the status GSI) and lists/terminates VMs.
    // Correlation is by the run store's persisted microvmId, not tags (ADR-015).
    table.grantReadWriteData(reaper);
    reaper.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ListMicroVMs',
        actions: ['lambda:ListMicrovms'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': this.region },
        },
      }),
    );
    reaper.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TerminateMicroVMs',
        actions: ['lambda:TerminateMicrovm', 'lambda:GetMicrovm'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': this.region },
        },
      }),
    );
    new events.Rule(this, 'ReaperSchedule', {
      ruleName: `lca-${envName}-reaper-schedule`,
      description: 'Periodic microVM lifetime-cap + orphan reconciliation sweep',
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(reaper)],
    });

    // ---- DLQ alarming (spec 05 observability) ----
    // Any message landing in the DLQ means a job repeatedly failed to provision — page.
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `lca-${envName}-alarms`,
      displayName: `LambdaCIActions ${envName} alarms`,
    });
    const dlqDepthAlarm = new cloudwatch.Alarm(this, 'DLQDepthAlarm', {
      alarmName: `lca-${envName}-provision-dlq-depth`,
      alarmDescription: 'Provisioning DLQ has messages — jobs failed to provision after retries',
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqDepthAlarm.addAlarmAction(new cwactions.SnsAction(alarmTopic));

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
    new CfnOutput(this, 'ReaperFunctionName', { value: reaper.functionName });
    new CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
