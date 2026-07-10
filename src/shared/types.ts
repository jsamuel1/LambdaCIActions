/**
 * Shared types for the LambdaCIActions control + compute plane.
 */

/** A GitHub `workflow_job` webhook payload (subset we consume). */
export interface WorkflowJobEvent {
  action: 'queued' | 'in_progress' | 'completed' | 'waiting';
  workflow_job: {
    id: number;
    run_id: number;
    labels: string[];
    name: string;
    status: string;
  };
  repository: {
    id: number;
    name: string;
    full_name: string; // owner/repo
    owner: { login: string };
  };
  installation: { id: number };
}

/** The message Ingest λ enqueues onto SQS for Provision λ. */
export interface ProvisionRequest {
  installationId: number;
  repoId: number;
  repoFullName: string; // owner/repo
  owner: string;
  repo: string;
  runId: number;
  jobId: number;
  labels: string[];
}

/** The JSON we hand to `run-microvm --run-hook-payload` (delivered to /run). Keep <16 KB. */
export interface RunHookPayload {
  jitConfig: string;
  runId: number;
  jobId: number;
  repoFullName: string;
  labels: string[];
}

/** GitHub App credentials read from SSM. */
export interface GithubAppCredentials {
  appId: string;
  pem: string;
  webhookSecret: string;
}
