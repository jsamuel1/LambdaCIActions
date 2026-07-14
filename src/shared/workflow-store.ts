import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { WorkflowAnalysisRecord } from './types.js';

/**
 * Workflow-analysis store (spec 03 § Discovery, ADR-009 single table).
 *
 * One row per workflow file per repo, upserted by the Discovery λ and read by:
 *   - Ingest — claim-time compat gate (`block` ⇒ don't claim the job), and
 *   - Provision — parsed step signals threaded into flavor resolution.
 *
 * Keys: PK = `REPO#<repoId>`, SK = `WF#<path>`. The repo partition is keyed by repoId
 * alone (not installation) because the hot-path consumers (Ingest/Provision) know the
 * repoId from the webhook but would need an extra lookup for the installation.
 */

const client = DynamoDBClient ? new DynamoDBClient({}) : undefined;
const doc = client ? DynamoDBDocumentClient.from(client) : undefined;
const TABLE = process.env.TABLE_NAME;

// ---- pure key helpers ------------------------------------------------------

export function workflowPk(repoId: number): string {
  return `REPO#${repoId}`;
}
export function workflowSk(path: string): string {
  return `WF#${path}`;
}

function requireDoc(): DynamoDBDocumentClient {
  if (!doc || !TABLE) {
    throw new Error('workflow-store not configured: TABLE_NAME env + DynamoDB SDK required');
  }
  return doc;
}

// ---- operations ------------------------------------------------------------

/** Upsert one workflow-analysis row (Discovery λ). Last write wins per path. */
export async function putWorkflowAnalysis(record: WorkflowAnalysisRecord): Promise<void> {
  await requireDoc().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: workflowPk(record.repoId),
        sk: workflowSk(record.path),
        entity: 'WORKFLOW',
        ...record,
      },
    }),
  );
}

/**
 * List every stored workflow analysis for a repo (Ingest compat gate, Provision signals,
 * M4 UI). A repo has at most a few dozen workflow files — a single Query page suffices.
 */
export async function listWorkflowAnalyses(repoId: number): Promise<WorkflowAnalysisRecord[]> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :wf)',
      ExpressionAttributeValues: { ':pk': workflowPk(repoId), ':wf': 'WF#' },
    }),
  );
  return (res.Items ?? []) as unknown as WorkflowAnalysisRecord[];
}
