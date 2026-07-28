import { Stack, StackProps, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface DataStackProps extends StackProps {
  envName: string;
  ssmPrefix: string; // /lca/<env>
}

/**
 * DataStack — the shared DynamoDB table (ADR-009 single-table design, spec 05).
 *
 * One table holds run records + installation/repo config, distinguished by key prefix:
 *   - Run:          PK=`RUN#<repoId>#<runId>#<jobId>`  SK=`RUN`
 *   - Installation: PK=`INSTALL#<installationId>`      SK=`INSTALL`
 *   - Repo:         PK=`INSTALL#<installationId>`      SK=`REPO#<repoId>`
 *
 * GSI1 is the status/time index the Reaper + UI use to list active runs by status without
 * a table scan: GSI1PK=`RUNSTATUS#<status>`, GSI1SK=`<updatedAt ISO>`.
 *
 * The table NAME is published to SSM so Lambdas (Ingest/Provision/Reaper) resolve it by
 * path rather than a cross-stack CFN export (spec 05: decouple deploy ordering).
 */
export class DataStack extends Stack {
  public readonly table: ddb.Table;
  public readonly tableNameParam: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName, ssmPrefix } = props;

    this.table = new ddb.Table(this, 'Table', {
      tableName: `lca-${envName}`,
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST, // spiky CI load; no capacity planning
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl', // age out terminal run rows per retention policy
      // Run history is valuable; keep the table on prod stack deletes. dev can be cleaned
      // up manually. RETAIN is the safe default for a data store.
      removalPolicy: envName === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // GSI1 — status/time index. Sparse: only rows that set gsi1pk/gsi1sk appear (run rows,
    // plus installation rows which use `gsi1pk=INSTALLS` so the UI can enumerate them).
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    // GSI2 — repo/time index (ADR-023), the M4 run-history read path:
    // GSI2PK=`REPORUNS#<repoId>`, GSI2SK=`<createdAt ISO>`. Both components are immutable,
    // so run transitions never rewrite this index. Sparse: run rows only.
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'gsi2pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    this.tableNameParam = `${ssmPrefix}/config/table-name`;
    new ssm.StringParameter(this, 'TableNameParam', {
      parameterName: this.tableNameParam,
      stringValue: this.table.tableName,
      description: 'LambdaCIActions shared DynamoDB table name (ADR-009)',
    });

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'TableArn', { value: this.table.tableArn });
  }
}
