import * as logs from 'aws-cdk-lib/aws-logs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

/**
 * Per-environment deployment configuration (spec 05 § Environments, ADR-033, M5).
 *
 * M1–M4 hardcoded one shape for every environment: 2-week log retention, `DESTROY` removal,
 * a fixed Provision concurrency, and no alarm subscription. That is right for `dev` and wrong
 * for `prod` — a prod incident needs logs older than two weeks, and a prod stack must not
 * delete its log groups (or its table) when a stack is torn down.
 *
 * `dev` and `prod` are separate **AWS accounts** (spec 05), pinned by `.env.local`
 * (ADR-018), so this module does not try to make one account host both. It only varies the
 * knobs that should differ, and every value is a plain constant — no lookups, so
 * credential-less `cdk synth` still works.
 */

export type EnvName = 'dev' | 'prod' | (string & {});

export interface EnvConfig {
  /** The environment's own name (`dev`, `prod`, or a personal sandbox name). */
  name: EnvName;
  /** True for the production environment — the only place we harden defaults. */
  isProd: boolean;
  /** Retention for control/management-plane Lambda log groups. */
  lambdaLogRetention: logs.RetentionDays;
  /** Retention for the per-run microVM log group (job logs the console renders). */
  runLogRetention: logs.RetentionDays;
  /**
   * Removal policy for log groups. `prod` RETAINs: a stack rollback must not destroy the
   * evidence of the incident that caused it.
   */
  logRemovalPolicy: RemovalPolicy;
  /**
   * Reserved concurrency on Provision λ — the launch-rate ceiling that protects the microVM
   * quota (spec 05 § Quotas). Deliberately still modest in prod: raise it only alongside a
   * granted quota increase, or launches will simply throttle (and now alarm).
   */
  provisionConcurrency: number;
  /** Reserved concurrency on the hook broker (untrusted callers — bounded, ADR-021). */
  hookBrokerConcurrency: number;
  /** How long terminal run rows are kept (DynamoDB TTL), in days. */
  runRetentionDays: number;
  /** Enable AWS X-Ray active tracing on the hot path (spec 05 § Observability). */
  tracing: boolean;
  /**
   * Error-rate alarm threshold: provision failures per 5-minute period that constitute a
   * problem. Tighter in prod.
   */
  provisionFailureThreshold: number;
  /** Stuck-run age (minutes) that trips the stuck-provisioning alarm. */
  stuckRunMinutes: number;
  /**
   * Email subscribed to the alarm topic, if any. Set with `-c alarmEmail=…` — we do NOT
   * hardcode a team address (it would be wrong for every other deployment, and a committed
   * address is a small information leak).
   */
  alarmEmail?: string;
  /**
   * Auto-rewrite PR capability (ADR-031). **OFF unless explicitly enabled**, in every
   * environment including dev, because it is the one feature that writes to customer repos
   * and it requires the elevated `contents:write` App permission (AGENTS.md hard rule).
   */
  rewriteEnabled: boolean;
  /**
   * Reports natural-language assistant (ADR-044). **ON by default** — unlike
   * `rewriteEnabled` it writes nothing and cannot touch a customer repo; its cost is one
   * bounded Bedrock call per operator question, and every failure path degrades to the manual
   * picker. Switch it off with `-c reportsNl=false` where Bedrock is unavailable in the
   * deploy region, the account has no model access, or the marginal spend is unwanted: that
   * also drops `bedrock:InvokeModel` from the template entirely (see MgmtStack).
   */
  reportsNlEnabled: boolean;
  /**
   * Bedrock model id backing that assistant. Flows to the λ as `REPORTS_MODEL_ID` **and**
   * into the IAM resource ARN from the same value, so the policy and the runtime cannot
   * disagree (a drift there is a runtime 403). Override with `-c reportsModel=…`.
   */
  reportsModelId: string;
}

export interface EnvConfigOverrides {
  alarmEmail?: string;
  rewriteEnabled?: boolean;
  reportsNlEnabled?: boolean;
  reportsModelId?: string;
}

/**
 * Default Reports assistant model (ADR-044). Lives here, with the other per-env knobs, so the
 * CDK side and `src/mgmt/nl-report.ts` have exactly one place each to state it and
 * `test/mgmt-stack.test.mjs` can assert they agree — the λ cannot import this module (CDK
 * types would follow it into the bundle), so the constant is mirrored, not shared.
 */
export const DEFAULT_REPORTS_MODEL_ID = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

/**
 * Resolve the config for an environment name. Unknown names (personal sandboxes like
 * `jsam-dev`) get the dev shape — safe defaults, cheap retention, nothing retained.
 */
export function envConfig(name: EnvName, overrides: EnvConfigOverrides = {}): EnvConfig {
  const isProd = name === 'prod';
  const base: EnvConfig = isProd
    ? {
        name,
        isProd: true,
        lambdaLogRetention: logs.RetentionDays.THREE_MONTHS,
        runLogRetention: logs.RetentionDays.ONE_MONTH,
        logRemovalPolicy: RemovalPolicy.RETAIN,
        provisionConcurrency: 25,
        hookBrokerConcurrency: 50,
        runRetentionDays: 90,
        tracing: true,
        provisionFailureThreshold: 1,
        stuckRunMinutes: 15,
        rewriteEnabled: false,
        reportsNlEnabled: true,
        reportsModelId: DEFAULT_REPORTS_MODEL_ID,
      }
    : {
        name,
        isProd: false,
        lambdaLogRetention: logs.RetentionDays.TWO_WEEKS,
        runLogRetention: logs.RetentionDays.TWO_WEEKS,
        logRemovalPolicy: RemovalPolicy.DESTROY,
        provisionConcurrency: 10,
        hookBrokerConcurrency: 20,
        runRetentionDays: 30,
        tracing: true,
        provisionFailureThreshold: 5,
        stuckRunMinutes: 15,
        rewriteEnabled: false,
        reportsNlEnabled: true,
        reportsModelId: DEFAULT_REPORTS_MODEL_ID,
      };

  return {
    ...base,
    ...(overrides.alarmEmail ? { alarmEmail: overrides.alarmEmail } : {}),
    ...(overrides.rewriteEnabled !== undefined ? { rewriteEnabled: overrides.rewriteEnabled } : {}),
    ...(overrides.reportsNlEnabled !== undefined
      ? { reportsNlEnabled: overrides.reportsNlEnabled }
      : {}),
    ...(overrides.reportsModelId ? { reportsModelId: overrides.reportsModelId } : {}),
  };
}

/** Alarm evaluation period, shared so every alarm reads the same window. */
export const ALARM_PERIOD = Duration.minutes(5);
