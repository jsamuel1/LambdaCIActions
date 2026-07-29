import type { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { getParam } from '../shared/ssm.js';
import { getFileContent, listWorkflowFiles } from '../shared/github-app.js';
import { parseWorkflow } from '../ingest/workflow-parser.js';
import { analyzeWorkflowCompat } from '../ingest/compat.js';
import { resolveFlavor } from '../provision/flavor.js';
import { putWorkflowAnalysis } from '../shared/workflow-store.js';
import { getRepo } from '../shared/install-store.js';
import {
  WorkflowParseError,
  type DiscoveryRequest,
  type ParsedJob,
  type WorkflowAnalysisRecord,
} from '../shared/types.js';

/**
 * Discovery λ — SQS consumer (spec 03 § Discovery, M3-S4).
 *
 * Per message (one repo to scan):
 *   1. List `.github/workflows/*.yml|yaml` via the installation token (contents:read).
 *   2. Fetch + parse each file (parseWorkflow — pure).
 *   3. Analyze compat per job (analyzeWorkflowCompat + resolveFlavor — pure), honoring
 *      the repo's FlavorMap override so the stored routing preview matches what
 *      Provision will actually resolve.
 *   4. Upsert one WorkflowAnalysisRecord per file (parse failures stored as parseError
 *      rows so the UI can surface them; they never break the scan).
 *
 * Failures throw per-record → SQS retry → DLQ (partial batch responses).
 *
 * Env: APP_ID_PARAM, APP_PEM_PARAM, TABLE_NAME.
 */

const APP_ID_PARAM = process.env.APP_ID_PARAM!;
const APP_PEM_PARAM = process.env.APP_PEM_PARAM!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await discoverOne(record);
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: 'discovery failed',
          messageId: record.messageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

async function discoverOne(record: SQSRecord): Promise<void> {
  const req = JSON.parse(record.body) as DiscoveryRequest;
  const appId = await getParam(APP_ID_PARAM);
  const pem = await getParam(APP_PEM_PARAM);
  const auth = {
    appId,
    pem,
    installationId: req.installationId,
    owner: req.owner,
    repo: req.repo,
  };

  // Per-repo FlavorMap override + onboarding mode (may not exist yet — e.g.
  // installation.created races the repo row write; fall back to no overrides / label mode).
  const repoRecord = await getRepo(req.installationId, req.repoId).catch(() => undefined);
  const flavorMap = repoRecord?.flavorMap;
  // `mode` is load-bearing for the stored routing preview (M5, ADR-030): without it an
  // adopt-mode repo's `ubuntu-latest` jobs resolve through the FALLBACK, so every stored
  // route reads `fallback to base (no matching label)` — a reason the console renders
  // verbatim, contradicting the adopt-mode routing Provision will actually apply. The stored
  // `routes[jobId].flavor` is also what the auto-rewrite planner reads to choose the label it
  // inserts (ADR-031), so a fallback-derived flavor would leak into the customer's PR.
  const mode = repoRecord?.mode;

  const files = await listWorkflowFiles(auth);
  console.log(
    JSON.stringify({ msg: 'discovery scan', repo: req.repoFullName, reason: req.reason, files: files.length }),
  );

  for (const file of files) {
    const { content, sha } = await getFileContent({ ...auth, path: file.path });
    const iso = new Date().toISOString();
    const base: Pick<
      WorkflowAnalysisRecord,
      'repoId' | 'installationId' | 'repoFullName' | 'path' | 'lastParsedSha' | 'createdAt' | 'updatedAt'
    > = {
      repoId: req.repoId,
      installationId: req.installationId,
      repoFullName: req.repoFullName,
      path: file.path,
      lastParsedSha: sha,
      createdAt: iso,
      updatedAt: iso,
    };

    let analysis: WorkflowAnalysisRecord;
    try {
      const parsed = parseWorkflow(file.path, content);
      const resolveFn = (job: ParsedJob) =>
        resolveFlavor(job.runs_on, { flavorMap, signals: job.step_signals, mode });
      const compat = analyzeWorkflowCompat(parsed, resolveFn);
      const routes: WorkflowAnalysisRecord['routes'] = {};
      for (const job of parsed.jobs) routes[job.id] = resolveFn(job);
      analysis = {
        ...base,
        name: parsed.name,
        parsed,
        compat: { level: compat.level, jobs: compat.jobs },
        routes,
      };
    } catch (err) {
      if (!(err instanceof WorkflowParseError)) throw err;
      // Malformed YAML is a repo-content problem, not an infra failure — persist the
      // error for the UI and move on (no retry).
      analysis = { ...base, name: file.path.split('/').pop() ?? file.path, parseError: err.message };
    }
    await putWorkflowAnalysis(analysis);
  }
}
