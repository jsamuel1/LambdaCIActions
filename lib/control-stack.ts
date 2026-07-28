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
  /** Discovery queue coordinates, consumed by MgmtStack's manual re-scan endpoint (M4). */
  public readonly discoveryQueueUrl: string;
  public readonly discoveryQueueArn: string;

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

    // ---- SQS: workflow-discovery scans (M3-S4) ----
    // Standard queue: scans are idempotent upserts, so duplicate delivery is harmless and
    // FIFO ordering buys nothing.
    const discoveryDlq = new sqs.Queue(this, 'DiscoveryDLQ', {
      queueName: `lca-${envName}-discovery-dlq`,
      retentionPeriod: Duration.days(14),
    });
    const discoveryQueue = new sqs.Queue(this, 'DiscoveryQueue', {
      queueName: `lca-${envName}-discovery`,
      visibilityTimeout: Duration.seconds(360), // headroom over the Discovery λ timeout
      deadLetterQueue: { queue: discoveryDlq, maxReceiveCount: 3 },
    });
    this.discoveryQueueUrl = discoveryQueue.queueUrl;
    this.discoveryQueueArn = discoveryQueue.queueArn;

    // ---- Ingest λ ----
    const bundling = {
      minify: true,
      sourceMap: false,
      target: 'node22',
      // NodejsFunction externalizes `@aws-sdk/*` by default (present in the Lambda runtime).
      // But `@aws-sdk/client-lambda-microvms` is a NEW package NOT in the runtime — it must be
      // BUNDLED or the Provision/Reaper dynamic import fails at runtime ("Cannot find package").
      // Setting externalModules to only the base SDK bundles everything else (incl. microvms).
      externalModules: ['@aws-sdk/client-lambda'],
    };
    const ingestLogGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-ingest`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const ingest = new NodejsFunction(this, 'IngestFn', {
      functionName: `lca-${envName}-ingest`,
      runtime: lambda.Runtime.NODEJS_22_X,
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
        DISCOVERY_QUEUE_URL: discoveryQueue.queueUrl,
        TABLE_NAME: table.tableName,
      },
    });
    queue.grantSendMessages(ingest);
    discoveryQueue.grantSendMessages(ingest);
    // Ingest writes run rows (queued + status transitions) and installation/repo config,
    // and reads stored workflow analyses for the claim-time compat gate (M3-S4).
    table.grantReadWriteData(ingest);
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
    // microVM execution role (ADR-015): stamped on each VM via run-microvm --execution-role-arn.
    // microVMs run UNTRUSTED workflow code, so this role is deliberately the thinnest thing
    // that still works (ADR-021): runtime logs + `lambda:InvokeFunction` on the hook broker.
    // It holds NO DynamoDB access and NO `lambda:TerminateMicrovm` — both of those used to be
    // unscopable here (a shared role can't express a per-VM `dynamodb:LeadingKeys`, and the GA
    // microVM API has no VM-level ARNs/tags — ADR-015), which made a VM able to read other
    // runs' rows, harvest their `microvmId`, and terminate them (the ADR-019 amplifier).
    // Also still the per-env isolation boundary. Trusts the Lambda service principal
    // (microVMs are part of the Lambda service).
    const microvmExecRole = new iam.Role(this, 'MicrovmExecRole', {
      roleName: `lca-${envName}-microvm-exec`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role stamped on LambdaCIActions microVMs (invokes the hook broker only)',
    });
    // Runtime logs: the VM writes run-hook + runner output to the per-run log group
    // Provision passes at launch (ADR-016).
    microvmExecRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'MicrovmRuntimeLogs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/microvms/*`],
      }),
    );

    // ---- Hook broker λ (ADR-021) ----
    // The control-plane mediator for everything a microVM needs from AWS: fetch its own JIT
    // config (ADR-016 by-reference payload) and terminate itself at job end (ADR-019). The VM
    // authenticates with a per-run capability token minted by Provision; the broker derives
    // the DynamoDB key from the token-bound ref, so a VM can only ever touch its own run
    // partition and never learns any microvmId (not even its own).
    const hookBrokerLogGroup = new logs.LogGroup(this, 'HookBrokerLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-hook-broker`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const hookBroker = new NodejsFunction(this, 'HookBrokerFn', {
      functionName: `lca-${envName}-hook-broker`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(SRC, 'hook', 'handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      // Its only callers are microVMs running untrusted code, one call each at boot and at
      // job end. Cap the concurrency so a pathological/malicious VM fleet can't drain the
      // account's unreserved pool out from under the control plane.
      reservedConcurrentExecutions: 20,
      logGroup: hookBrokerLogGroup,
      bundling,
      environment: {
        TABLE_NAME: table.tableName,
      },
    });
    // Reads exactly two items by primary key — the JIT config item (token hash + config) and
    // the run row (token hash + microvmId). NOT `grantReadData`: that hands out Query/Scan/
    // BatchGetItem/stream reads plus `/index/*`, i.e. table-wide enumeration on the one role
    // an untrusted VM can reach (indirectly) — the exact shape ADR-021 exists to remove. The
    // broker never queries and never touches an index, so grant GetItem on the table only.
    hookBroker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadOwnRunItems',
        actions: ['dynamodb:GetItem'],
        resources: [table.tableArn],
      }),
    );
    // Terminates the caller's own VM on its behalf. Still region-scoped only — the GA API
    // has no VM-level ARNs (ADR-015) — but this authority now lives in the control plane,
    // where the target id is chosen by us, not by untrusted in-VM code.
    hookBroker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BrokeredTerminate',
        actions: ['lambda:TerminateMicrovm'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': this.region },
        },
      }),
    );
    // The VM's ONLY AWS privilege besides logs: invoke this one function.
    microvmExecRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeHookBroker',
        actions: ['lambda:InvokeFunction'],
        resources: [hookBroker.functionArn],
      }),
    );

    const provisionLogGroup = new logs.LogGroup(this, 'ProvisionLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-provision`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const provision = new NodejsFunction(this, 'ProvisionFn', {
      functionName: `lca-${envName}-provision`,
      runtime: lambda.Runtime.NODEJS_22_X,
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
        RUNNER_ROLE_ARN: microvmExecRole.roleArn,
        HOOK_BROKER_NAME: hookBroker.functionName,
      },
    });
    // Provision must write the JIT config item (side-store) + stamp run rows.
    table.grantReadWriteData(provision);
    // Provision passes the exec role to run-microvm — needs iam:PassRole for it.
    provision.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PassMicrovmExecRole',
        actions: ['iam:PassRole'],
        resources: [microvmExecRole.roleArn],
      }),
    );
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
    // RunMicrovm attaches network connectors (INTERNET_EGRESS so the runner reaches GitHub,
    // HTTP_INGRESS for the per-VM endpoint that receives the /run hook); launching requires
    // lambda:PassNetworkConnector on each. Scope to the aws-managed connectors.
    provision.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PassNetworkConnectors',
        actions: ['lambda:PassNetworkConnector'],
        resources: ['arn:aws:lambda:*:aws:network-connector:aws-network-connector:*'],
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

    // ---- Discovery λ (M3-S4, spec 03 § Discovery) ----
    // Fetches .github/workflows/** via the GitHub App installation token, parses +
    // analyzes compat, persists WorkflowAnalysisRecords for Ingest/Provision/UI.
    const discoveryLogGroup = new logs.LogGroup(this, 'DiscoveryLogGroup', {
      logGroupName: `/aws/lambda/lca-${envName}-discovery`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const discovery = new NodejsFunction(this, 'DiscoveryFn', {
      functionName: `lca-${envName}-discovery`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(SRC, 'discover', 'handler.ts'),
      handler: 'handler',
      // A full-repo scan is N sequential GitHub fetches; give it room.
      timeout: Duration.seconds(300),
      memorySize: 256,
      // GitHub API rate-limit friendliness: one scan at a time is plenty.
      reservedConcurrentExecutions: 2,
      logGroup: discoveryLogGroup,
      bundling,
      environment: {
        APP_ID_PARAM: `${ssmPrefix}/github/app-id`,
        APP_PEM_PARAM: `${ssmPrefix}/github/app-pem`,
        TABLE_NAME: table.tableName,
      },
    });
    discovery.addEventSource(
      new SqsEventSource(discoveryQueue, { batchSize: 1, reportBatchItemFailures: true }),
    );
    // Writes workflow-analysis rows; reads the repo row (FlavorMap).
    table.grantReadWriteData(discovery);
    // Reads the App credentials to mint installation tokens (contents:read fetches).
    discovery.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadDiscoveryConfig',
        actions: ['ssm:GetParameter'],
        resources: [
          paramArn(`${ssmPrefix}/github/app-id`),
          paramArn(`${ssmPrefix}/github/app-pem`),
        ],
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
      runtime: lambda.Runtime.NODEJS_22_X,
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
    new CfnOutput(this, 'DiscoveryQueueUrl', { value: discoveryQueue.queueUrl });
    new CfnOutput(this, 'ReaperFunctionName', { value: reaper.functionName });
    new CfnOutput(this, 'HookBrokerFunctionName', { value: hookBroker.functionName });
    new CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
