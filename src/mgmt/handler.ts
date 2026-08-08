import crypto from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  matchRoute,
  asPositiveInt,
  type Method,
  type RouteMatch,
} from './router.js';
import {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_TTL_SECONDS,
  canAdminInstallation,
  canAdminPlatform,
  grantedInstallationIds,
  decodeSession,
  encodeSession,
  parseCookies,
  parsePlatformAdmins,
  serializeCookie,
  signState,
  verifyState,
  type SessionPayload,
} from './session.js';
import {
  ALL_STATUSES,
  ACTIVE_STATUSES,
  buildFlavorViews,
  buildHealth,
  buildLabelImpact,
  buildWebhookHealth,
  hostedLabelsIn,
  rollupCompat,
  scopeSettingsView,
  sortRunsNewestFirst,
  toRepoView,
  toRunView,
  toSecretStatus,
  type AppInstallationView,
  type LabelImpactView,
  type SettingsView,
  type WebhookDeliveryView,
} from './views.js';
import {
  countUnrunnableJobs,
  sortRefusalsNewestFirst,
  toRefusalView,
  toWorkflowViewWithReadiness,
} from './refusal-views.js';
import {
  reconcileFlavors,
  unmatchedAllowlistLabels,
  type ControlPlaneSnapshot,
  type FlavorReadiness,
  type ReadinessFlavor,
} from '../shared/flavor-readiness.js';
import {
  HOSTED_LABELS,
  parseLimit,
  parseEpochMs,
  parseRunnerLabels,
  serializeRunnerLabels,
  validateCustomFlavor,
  validateFlavorMap,
  validateRelinkBody,
  validateRepoPatch,
  validateRevalidateBody,
  validateRollbackBody,
  validateRunnerLabels,
  validateWebhookTestBody,
} from './validate.js';
import {
  FlavorExistsError,
  InvalidFlavorError,
  TooManyFlavorsError,
  buildFlavorRecord,
  deleteCustomFlavor,
  getCustomFlavor,
  listCustomFlavors,
  registerCustomFlavor,
  repointFlavorImage,
  routableCustomFlavors,
  transitionFlavorValidation,
  type CustomFlavorRecord,
} from '../shared/flavor-store.js';
import { staticGate, smokeWorkflowYaml } from '../flavorval/validate-core.js';
import { shapeRatePerMinute } from './views.js';
import { planPreviewFromAnalyses } from './rewrite.js';
import { collectVisible } from './paging.js';
import { mergedResponseComplete, repoResponseComplete } from './run-rollup.js';
import {
  METRIC_CATALOG,
  CHART_TYPES,
  DIMENSIONS,
  MAX_EXPORT_ROWS,
  applyFilters,
  availablePresets,
  boundExportRows,
  computeReport,
  maxRangeDays,
  specFromQuery,
  specToQuery,
  toCsv,
  toExportRows,
  type ReportSpec,
} from './reports.js';
import { fetchReportRuns, resolveVisibleRepos } from './report-store.js';
import {
  checkQuestion,
  modelId,
  nlEnabled,
  proposeSpec,
  rateLimit,
} from './nl-report.js';
import { fetchRunLogs } from './logs.js';
import {
  countRunsByStatus,
  getRun,
  listRunsByRepo,
  listRunsByStatusPaged,
} from '../shared/run-store.js';
import {
  countRefusals,
  listRefusals,
  listRefusalsByRepo,
} from '../shared/refusal-store.js';
import {
  getInstallation,
  getRepo,
  listInstallations,
  listRepos,
  patchRepoConfig,
  reconcileInstallations,
  repairInstallationIndex,
} from '../shared/install-store.js';
import { appendAudit, getWebhookHeartbeat, listAudit } from '../shared/config-store.js';
// Ingest's own opt-out predicate, reused so the label-impact preview cannot drift from the
// control plane's claim decision (spec 04 § Settings).
import { isRepoOptedOut } from '../ingest/filter.js';
import { listWorkflowAnalyses } from '../shared/workflow-store.js';
import { getParam, paramExists } from '../shared/ssm.js';
import { assertNoSecrets, scrubForOperator } from '../shared/redact.js';
import type { AppcfgResult } from '../appcfg/broker-core.js';
import {
  OAUTH_AUTHORIZE_URL,
  exchangeOauthCode,
  getOauthUser,
  listUserInstallations,
} from '../shared/github-app.js';
import type {
  RefusalRecord,
  RepoRecord,
  RewriteRequest,
  RunRecord,
  RunStatus,
  WorkflowAnalysisRecord,
} from '../shared/types.js';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

/**
 * Management API λ (spec 04). One Lambda behind an HTTP API, routing every
 * `/api/*` + `/auth/*` request through the pure router.
 *
 * Plane boundary (docs/ARCHITECTURE.md): this handler is **read-mostly management**. It
 * reads run/install/workflow rows and CloudWatch logs, and writes ONLY repo config
 * (mode / enabled / flavor map). It cannot mint GitHub app tokens for repo content, launch
 * or terminate microVMs, or transition runs — the control plane owns those (enforced in
 * IAM by MgmtStack, not just here).
 *
 * Secret handling: the ONLY secrets it reads are its own OAuth client secret and session
 * signing key. Every other SSM path is probed for **presence only** via
 * `paramExists` (DescribeParameters), so no code path can return a SecureString value.
 */

const ENV_NAME = process.env.LCA_ENV ?? 'dev';
const SSM_PREFIX = process.env.SSM_PREFIX ?? `/lca/${ENV_NAME}`;
const SESSION_SECRET_PARAM = process.env.SESSION_SECRET_PARAM ?? `${SSM_PREFIX}/mgmt/session-secret`;
const OAUTH_CLIENT_ID_PARAM = process.env.OAUTH_CLIENT_ID_PARAM ?? `${SSM_PREFIX}/github/client-id`;
const OAUTH_CLIENT_SECRET_PARAM =
  process.env.OAUTH_CLIENT_SECRET_PARAM ?? `${SSM_PREFIX}/github/client-secret`;
const RUN_LOG_GROUP = process.env.RUN_LOG_GROUP ?? `/aws/lambda/microvms/runs/lca-${ENV_NAME}`;
const DISCOVERY_QUEUE_URL = process.env.DISCOVERY_QUEUE_URL ?? '';
const RUNNER_LABELS_PARAM = process.env.RUNNER_LABELS_PARAM ?? `${SSM_PREFIX}/config/runner-labels`;
const PLATFORM_ADMINS_PARAM =
  process.env.PLATFORM_ADMINS_PARAM ?? `${SSM_PREFIX}/config/platform-admins`;
/**
 * The App-config broker (ADR-034). The Mgmt λ holds `lambda:InvokeFunction` on this ARN and
 * nothing else — no App PEM read, no `ssm:PutParameter` on any secret path.
 */
const APPCFG_BROKER_NAME = process.env.APPCFG_BROKER_NAME ?? '';
/**
 * Name of the flavor-validation λ (ADR-041). Empty when the function is not deployed, in which
 * case registration still succeeds but the flavor stays `pending` (and therefore not routable) and
 * the response says validation could not be started — never a silent `valid`.
 */
const FLAVORVAL_FUNCTION_NAME = process.env.FLAVORVAL_FUNCTION_NAME ?? '';
/** The webhook receiver this deployment exposes, for configured-vs-deployed comparison. */
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? '';
/**
 * Rows per terminal status folded into the Dashboard's rolling cost estimate. The Dashboard
 * polls `/api/health` every 5 s, so this is a deliberate ceiling on read amplification, not
 * an attempt at a complete billing window.
 */
const COST_SAMPLE_PER_STATUS = 50;

/**
 * How far back the Dashboard's unclaimed badge looks (ADR-050).
 *
 * Refusal rows are retained for the full ADR-033 window (`RUN_RETENTION_DAYS`, 90 days by default),
 * which is right for the Unclaimed screen's history and wrong for a headline badge: an unwindowed
 * count stays non-zero — and its banner keeps claiming jobs "are not running" — for months after
 * the operator fixed the allowlist. Seven days is long enough to cover a weekend plus a working
 * week, so a Monday-morning operator still sees Friday's breakage.
 */
const UNCLAIMED_WINDOW_DAYS = 7;
const REWRITE_QUEUE_URL = process.env.REWRITE_QUEUE_URL ?? '';
/**
 * Deployment-wide auto-rewrite flag (ADR-031). Off unless the string is exactly `true`, so a
 * missing/typo'd env var can never accidentally enable a capability that writes to customer
 * repos.
 */
const REWRITE_ENABLED = process.env.REWRITE_ENABLED === 'true';
/** Public origin of the console (CloudFront). Used to build the OAuth redirect URI. */
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '');

const sqs = new SQSClient({});
const lambdaClient = new LambdaClient({});

// ---- HTTP plumbing ---------------------------------------------------------

interface Reply {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
  cookies?: string[];
  /** Raw (non-JSON) body — used for redirects with no payload. */
  raw?: string;
}

function json(statusCode: number, body: unknown, extra: Partial<Reply> = {}): Reply {
  return { statusCode, body, ...extra };
}

function problem(statusCode: number, message: string, details?: unknown): Reply {
  return json(statusCode, { error: message, ...(details ? { details } : {}) });
}

function toResult(reply: Reply): APIGatewayProxyResultV2 {
  const headers: Record<string, string> = {
    // The console is served same-origin via CloudFront (ADR-024) so no CORS is needed;
    // these are defense-in-depth for the API responses themselves.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(reply.headers ?? {}),
  };
  if (reply.raw === undefined) headers['Content-Type'] = 'application/json';
  return {
    statusCode: reply.statusCode,
    headers,
    ...(reply.cookies?.length ? { cookies: reply.cookies } : {}),
    body: reply.raw ?? JSON.stringify(reply.body ?? {}),
  };
}

function pathOf(event: APIGatewayProxyEventV2): string {
  return event.requestContext?.http?.path ?? event.rawPath ?? '/';
}
function methodOf(event: APIGatewayProxyEventV2): string {
  return event.requestContext?.http?.method ?? 'GET';
}
function bodyOf(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // signals a 400 to the caller
  }
}

// ---- entrypoint ------------------------------------------------------------

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = methodOf(event);
  const path = pathOf(event);
  const result = matchRoute(method, path);

  if (result.kind === 'not-found') return toResult(problem(404, 'not found'));
  if (result.kind === 'method-not-allowed') {
    return toResult(
      problem(405, 'method not allowed', { allow: result.allow as Method[] }),
    );
  }

  const { route } = result.match;
  const cookies = parseCookies(cookieHeader(event));

  try {
    // Auth routes run before session verification (they establish it).
    if (route.id === 'authLogin') return toResult(await handleLogin());
    if (route.id === 'authCallback') return toResult(await handleCallback(event, cookies));
    if (route.id === 'authLogout') {
      // Logout clears the cookie only; it is intentionally session-agnostic (works on an
      // already-expired session). `SameSite=Lax` blocks cross-site POSTs, so a forced
      // logout cannot be triggered from another origin.
      return toResult(
        json(200, { ok: true }, { cookies: [serializeCookie(SESSION_COOKIE, '', { clear: true })] }),
      );
    }

    const secret = await getParam(SESSION_SECRET_PARAM);
    const session = decodeSession(cookies[SESSION_COOKIE], secret);
    if (!session) return toResult(problem(401, 'not authenticated'));

    return toResult(await route_(result.match, event, session));
  } catch (err) {
    // Never echo internals to the browser; the detail goes to CloudWatch. Sanitized even
    // there: the relink route carries an App PEM + webhook/client secrets in its request body,
    // and an SDK or middleware error can quote a request payload back (AGENTS.md hard rule —
    // a secret value must not reach a log either).
    console.error(
      JSON.stringify({
        msg: 'mgmt request failed',
        route: route.id,
        path,
        error: scrubForOperator(errMsg(err)),
      }),
    );
    return toResult(problem(500, 'internal error'));
  }
}

/** API Gateway v2 delivers cookies as an array; some proxies still send a Cookie header. */
function cookieHeader(event: APIGatewayProxyEventV2): string | undefined {
  if (Array.isArray(event.cookies) && event.cookies.length) return event.cookies.join('; ');
  const h = event.headers ?? {};
  return h.cookie ?? h.Cookie;
}

// ---- auth ------------------------------------------------------------------

function redirectUri(): string {
  if (!PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN not configured for the mgmt API');
  return `${PUBLIC_ORIGIN}/auth/callback`;
}

/**
 * Start the GitHub OAuth web flow. The `state` nonce is signed with the session secret and
 * also set as a short-lived cookie, so the callback proves BOTH that we issued the redirect
 * and that it came back to the same browser (CSRF defense).
 */
async function handleLogin(): Promise<Reply> {
  const secret = await getParam(SESSION_SECRET_PARAM);
  const clientId = await getParam(OAUTH_CLIENT_ID_PARAM);
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = signState(nonce, secret);
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  return {
    statusCode: 302,
    raw: '',
    headers: { Location: url.toString() },
    cookies: [serializeCookie(OAUTH_STATE_COOKIE, nonce, { maxAgeSeconds: 600 })],
  };
}

/**
 * OAuth callback: verify state, exchange the code, resolve the operator's installations
 * from GitHub, and mint the signed session cookie. The user token is discarded here
 * (ADR-022) — authorization is frozen into the session for its TTL.
 */
async function handleCallback(
  event: APIGatewayProxyEventV2,
  cookies: Record<string, string>,
): Promise<Reply> {
  const q = event.queryStringParameters ?? {};
  const secret = await getParam(SESSION_SECRET_PARAM);
  const nonce = verifyState(q.state, secret);
  if (!nonce || nonce !== cookies[OAUTH_STATE_COOKIE]) {
    return problem(400, 'invalid OAuth state');
  }
  if (!q.code) return problem(400, 'missing OAuth code');

  const [clientId, clientSecret] = await Promise.all([
    getParam(OAUTH_CLIENT_ID_PARAM),
    getParam(OAUTH_CLIENT_SECRET_PARAM),
  ]);
  const userToken = await exchangeOauthCode({
    clientId,
    clientSecret,
    code: q.code,
    redirectUri: redirectUri(),
  });
  const [user, installs] = await Promise.all([
    getOauthUser(userToken),
    listUserInstallations(userToken),
  ]);
  if (installs.length === 0) {
    // Authenticated but authorized for nothing — send them to the install flow. A session
    // IS minted (with an empty installation list) or the Setup screen would be unreachable:
    // without a cookie `/api/me` answers 401 and the SPA renders the login prompt again,
    // trapping a first-run operator (who has not installed the App yet — the M4 exit
    // criterion starts there) in a login loop. An empty grant list authorizes nothing:
    // `canAdminInstallation` is false for every id, so all repo/run routes answer 403 and
    // every list is empty. Re-login after installing picks up the new grant.
    const empty = encodeSession({ login: user.login, installations: [] }, secret);
    return {
      statusCode: 302,
      raw: '',
      headers: { Location: `${PUBLIC_ORIGIN}/#/setup?reason=no-installations` },
      cookies: [
        serializeCookie(SESSION_COOKIE, empty, { maxAgeSeconds: SESSION_TTL_SECONDS }),
        serializeCookie(OAUTH_STATE_COOKIE, '', { clear: true }),
      ],
    };
  }
  const token = encodeSession({ login: user.login, installations: installs }, secret);
  return {
    statusCode: 302,
    raw: '',
    headers: { Location: `${PUBLIC_ORIGIN}/#/` },
    cookies: [
      serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_SECONDS }),
      serializeCookie(OAUTH_STATE_COOKIE, '', { clear: true }),
    ],
  };
}

// ---- authenticated routes --------------------------------------------------

async function route_(
  match: RouteMatch,
  event: APIGatewayProxyEventV2,
  session: SessionPayload,
): Promise<Reply> {
  const q = event.queryStringParameters ?? {};
  switch (match.route.id) {
    case 'me':
      return json(200, {
        login: session.login,
        installations: session.installations,
        expiresAt: new Date(session.exp * 1000).toISOString(),
      });

    case 'listInstallations': {
      // Pass the session's grants so a legacy row missing the GSI1 stamp is still found
      // (by primary key) and repaired — ADR-037. The filter below is unchanged: reconcile
      // can only surface installations this session was already authorized for.
      const all = await listInstallations(grantedInstallationIds(session));
      const visible = all.filter((i) => canAdminInstallation(session, i.installationId));
      return json(200, {
        installations: visible.map((i) => ({
          installationId: i.installationId,
          accountLogin: i.accountLogin,
          suspended: i.suspended,
          deleted: i.deleted,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        })),
      });
    }

    case 'listRepos': {
      const installationId = asPositiveInt(q.installation);
      if (!installationId) return problem(400, 'installation query param required');
      if (!canAdminInstallation(session, installationId)) return problem(403, 'forbidden');
      const repos = await listRepos(installationId);
      const withRollup = await Promise.all(
        repos.map(async (r) => ({
          ...toRepoView(r),
          compat: rollupCompat(await listWorkflowAnalyses(r.repoId)),
        })),
      );
      return json(200, { repos: withRollup });
    }

    case 'patchRepo': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      const raw = bodyOf(event);
      if (raw === undefined) return problem(400, 'body is not valid JSON');
      // Routable custom flavors are accepted as `defaultFlavor` / FlavorMap targets (ADR-040);
      // unvalidated ones are not, or the console would save a choice the resolver ignores.
      const parsed = validateRepoPatch(raw, await routableCustomFlavorsFor(repo.record.installationId));
      if (!parsed.ok) return problem(400, 'invalid body', parsed.errors);
      const updated = await patchRepoConfig(
        repo.record.installationId,
        repo.record.repoId,
        parsed.value,
        session.login,
      );
      if (!updated) return problem(404, 'repo not found');
      console.log(
        JSON.stringify({
          msg: 'repo config changed',
          actor: session.login,
          repoId: updated.repoId,
          patch: parsed.value,
        }),
      );
      // A `mode` change invalidates every stored routing preview for this repo: Discovery
      // resolves flavors WITH the repo's mode (M5, ADR-030), so switching label↔adopt changes
      // both the flavor and its `reason` for every hosted-label job — and those stored routes
      // are what the console renders and what the rewrite planner reads. Without a re-scan the
      // operator flips to adopt and still sees `fallback to base (no matching label)` until
      // someone happens to push a workflow change. Best-effort: the config write already
      // succeeded, so a failed enqueue must not turn it into a 5xx.
      if (parsed.value.mode !== undefined && parsed.value.mode !== repo.record.mode) {
        await enqueueRescan(updated).catch((err) =>
          console.error(
            JSON.stringify({
              msg: 'mode-change rescan enqueue failed (routes stay stale until the next push)',
              repoId: updated.repoId,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        );
      }
      return json(200, { repo: toRepoView(updated) });
    }

    case 'listWorkflows': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      const analyses = await listWorkflowAnalyses(repo.record.repoId);
      // Reconciled against the LIVE control plane, not just the catalog (ADR-051). A route to a
      // flavor whose label is absent from the live allowlist, or whose image is unpublished, is
      // not runnable however green its stored compat is — which is exactly what this repo's
      // workflows looked like while eight PRs sat queued.
      const readiness = await flavorReadinessOrUndefined();
      const workflows = analyses.map((a) => toWorkflowViewWithReadiness(a, readiness));
      return json(200, {
        repo: toRepoView(repo.record),
        compat: rollupCompat(analyses),
        workflows,
        /** Jobs routing somewhere the live control plane cannot run. */
        unrunnableJobs: countUnrunnableJobs(workflows),
        /** False when the live read failed — the platform verdicts are `unknown`, not green. */
        controlPlaneLive: readiness !== undefined,
      });
    }

    case 'rescanRepo': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      if (!DISCOVERY_QUEUE_URL) return problem(503, 'discovery queue not configured');
      await enqueueRescan(repo.record);
      console.log(
        JSON.stringify({ msg: 'rescan requested', actor: session.login, repoId: repo.record.repoId }),
      );
      return json(202, { queued: true });
    }

    case 'getFlavorMap': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      return json(200, { flavorMap: repo.record.flavorMap ?? {} });
    }

    case 'putFlavorMap': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      const raw = bodyOf(event);
      if (raw === undefined) return problem(400, 'body is not valid JSON');
      const body = (raw ?? {}) as { flavorMap?: unknown };
      const parsed = validateFlavorMap(
        body.flavorMap ?? raw,
        await routableCustomFlavorsFor(repo.record.installationId),
      );
      if (!parsed.ok) return problem(400, 'invalid flavor map', parsed.errors);
      const updated = await patchRepoConfig(
        repo.record.installationId,
        repo.record.repoId,
        { flavorMap: parsed.value },
        session.login,
      );
      if (!updated) return problem(404, 'repo not found');
      console.log(
        JSON.stringify({
          msg: 'flavor map replaced',
          actor: session.login,
          repoId: updated.repoId,
          entries: Object.keys(parsed.value).length,
        }),
      );
      return json(200, { flavorMap: updated.flavorMap ?? {} });
    }

    case 'rewritePreview': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      return rewritePreviewRoute(repo.record);
    }

    case 'rewritePr': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      // Both gates are re-checked HERE so the API refuses with a specific 409 instead of
      // enqueuing work the rewrite λ will silently drop. The λ re-checks them anyway (it is
      // the enforcement point; this is the good error message).
      if (!REWRITE_ENABLED) {
        return problem(409, 'auto-rewrite is disabled for this deployment', {
          fix: 'Redeploy with `-c rewrite=true` after granting the GitHub App `contents:write` (off by default).',
        });
      }
      // Strict `=== true`, matching `repoOptedIn` below and the λ's own gate. The row is
      // writable out of band (RUNBOOK's break-glass `update-item`), so a stray `"false"` must
      // not enqueue a request the λ will refuse anyway — the operator would get a 202 and no PR.
      if (repo.record.rewriteEnabled !== true) {
        return problem(409, 'repo has not opted into the auto-rewrite PR', {
          fix: 'PATCH /api/repos/{repoId} with {"rewriteEnabled": true} (Repos screen toggle) first.',
        });
      }
      if (!REWRITE_QUEUE_URL) return problem(503, 'rewrite queue not configured');
      const [owner, name] = repo.record.repoFullName.split('/');
      const msg: RewriteRequest = {
        installationId: repo.record.installationId,
        repoId: repo.record.repoId,
        repoFullName: repo.record.repoFullName,
        owner,
        repo: name,
        actor: session.login,
      };
      await sqs.send(
        new SendMessageCommand({ QueueUrl: REWRITE_QUEUE_URL, MessageBody: JSON.stringify(msg) }),
      );
      console.log(
        JSON.stringify({
          msg: 'rewrite PR requested',
          actor: session.login,
          repoId: repo.record.repoId,
        }),
      );
      return json(202, { queued: true });
    }

    case 'listRuns':
      return listRunsRoute(session, q);

    case 'listRefusals':
      return listRefusalsRoute(session, q);

    case 'getRun': {
      const run = await authorizeRun(session, match);
      if ('reply' in run) return run.reply;
      return json(200, { run: toRunView(run.record) });
    }

    case 'getRunLogs': {
      const run = await authorizeRun(session, match);
      if ('reply' in run) return run.reply;
      const since = asEpochMs(q.since);
      const page = await fetchRunLogs({
        logGroupName: RUN_LOG_GROUP,
        microvmId: run.record.microvmId,
        // Bounds the stream-name resolution scan to the run's own date (src/mgmt/logs.ts).
        runCreatedAt: run.record.createdAt,
        limit: parseLimit(q.limit, 200, 1000),
        nextToken: q.nextToken,
        // `since` is the client's tail watermark: the newest event timestamp it already
        // holds, +1 ms. Used when CloudWatch stopped issuing tokens (caught up) so the tail
        // resumes instead of replaying the page (see src/mgmt/logs.ts).
        startTime: q.nextToken ? undefined : since,
      });
      return json(200, {
        logGroup: RUN_LOG_GROUP,
        microvmId: run.record.microvmId ?? null,
        // The resolved stream name: what an operator needs to go read the same events in the
        // CloudWatch console / CLI, and the fastest way to see a resolution has failed.
        logStream: page.logStream ?? null,
        pending: page.pending,
        events: page.events,
        nextToken: page.nextToken ?? null,
      });
    }

    case 'listFlavors': {
      // `installation` is OPTIONAL. Without it this is the environment-wide built-in catalog,
      // byte-identical to the pre-ADR-040 response — which is what the Repos screen's flavor
      // picker and any unscoped caller still get. With it, the installation's own custom flavors
      // are appended in EVERY state, because the console's job is to show `pending`/`invalid` and
      // why; per-row `routable` carries the ADR-041 rule instead of omission.
      //
      // ABSENT and MALFORMED are not the same request, and this is the one route where the
      // difference is invisible in the reply. `asPositiveInt` maps both to `undefined`, so a
      // `?installation=abc` typo would otherwise fall through to the unscoped branch and return a
      // 200 with no custom rows AND no `customFlavorsRead` field — a client cannot tell its scope
      // was dropped from an installation that genuinely has none. That is the same conflation the
      // degraded-read handling below exists to prevent, one layer up: the console would report
      // "no custom flavors" for an installation that has several. Every other installation-scoped
      // route already 400s on a malformed value; only the ABSENCE of the param is a valid unscoped
      // request.
      if (q.installation !== undefined && asPositiveInt(q.installation) === undefined) {
        return problem(400, 'installation must be a positive integer');
      }
      const scoped = asPositiveInt(q.installation);
      if (scoped !== undefined) {
        if (!canAdminInstallation(session, scoped)) return problem(403, 'forbidden');
        // A failed read is NOT an empty catalog, and the response must not let a client conflate
        // them. Collapsing both to `[]` would show an operator who just registered a flavor an
        // empty list during a DynamoDB blip — inviting them to register it again (a 409 at best,
        // and a second image to reason about at worst) and making the console's whole purpose here,
        // reporting validation progress, silently report "nothing to report".
        let custom: CustomFlavorRecord[] | undefined;
        try {
          custom = await listCustomFlavors(scoped);
        } catch (err) {
          console.error(
            JSON.stringify({ msg: 'custom flavor list read failed', installationId: scoped, error: errMsg(err) }),
          );
        }
        return json(200, {
          flavors: buildFlavorViews(await imageAvailability(), custom ?? []),
          // `ok` = the installation's custom rows were read (possibly genuinely none);
          // `degraded` = they could not be read, so the rows above are built-ins ONLY and the
          // absence of a custom flavor here is not evidence that it does not exist.
          customFlavorsRead: custom ? 'ok' : 'degraded',
          smokeWorkflow: smokeWorkflowYaml(),
        });
      }
      const snapshot = await controlPlaneSnapshot();
      return json(200, {
        // Passed through with its own liveness: `undefined` renders the Image column as unchecked
        // instead of asserting every flavor is unbuilt when only the SSM read failed.
        flavors: buildFlavorViews(snapshot.imagePublished),
        // The live control-plane reconciliation (ADR-051). Kept a SEPARATE array rather than
        // merged into each FlavorView so the catalog projection stays a pure function of the
        // catalog, and a per-flavor axis added elsewhere cannot collide with this one.
        //
        // EMPTY when EITHER live read failed, never reconciled against a failure sentinel.
        // `reconcileFlavors` takes no view on `live` — so reconciling an unread allowlist or an
        // unread image map would derive every catalog flavor as `unroutable`/`imageMissing` and
        // make the screen announce "N flavors cannot run in this environment" on a transient SSM
        // error. That is the same false certainty as the misleading green this ADR removes, only
        // inverted, and an alarm that fires when nothing is wrong is one operators stop reading.
        // Same rule as `flavorReadinessOrUndefined` and the Settings route: unknown ≠ broken.
        readiness: snapshot.live ? reconcileFlavors(catalogForReadiness(), snapshot) : [],
        allowlist: snapshot.allowlist,
        unmatchedAllowlistLabels: unmatchedAllowlistLabels(catalogForReadiness(), snapshot.allowlist),
        controlPlaneLive: snapshot.live,
      });
    }

    case 'registerFlavor':
      return registerFlavorRoute(session, event, q);

    case 'previewFlavor':
      return previewFlavorRoute(session, event, q);

    case 'deleteFlavor':
      return deleteFlavorRoute(session, match, q);

    case 'revalidateFlavor':
      return revalidateFlavorRoute(session, event, match, q);

    case 'health':
      return healthRoute(session);

    case 'settings':
      return settingsRoute(session);

    case 'putRunnerLabels':
      return putRunnerLabelsRoute(session, event);

    case 'relinkGithubApp':
      return relinkGithubAppRoute(session, event);

    case 'rollbackGithubApp':
      return rollbackGithubAppRoute(session, event);

    case 'testWebhook':
      return testWebhookRoute(session, event);

    case 'reportCatalog':
      return json(200, {
        metrics: METRIC_CATALOG,
        dimensions: DIMENSIONS,
        charts: CHART_TYPES,
        // Only the presets this environment's run retention can actually fill. Offering `90d`
        // where terminal rows age out at 30 days hands the operator a window the store cannot
        // serve, and the report would read a partly aged-out span while reporting itself
        // complete (ADR-043).
        presets: availablePresets(),
        maxRangeDays: maxRangeDays(),
        // The UI needs the operator's repo list to offer a repo filter; it is the SAME
        // authorization-resolved set the executor reads from, so the picker cannot offer a
        // repo the report would refuse.
        repos: (await resolveReportRepos(session)).map((r) => ({
          repoId: r.repoId,
          repoFullName: r.repoFullName,
        })),
        nl: { enabled: nlEnabled(), modelId: nlEnabled() ? modelId() : null },
      });

    case 'runReport':
      return runReportRoute(session, q);

    case 'exportReport':
      return exportReportRoute(session, q);

    case 'askReport':
      return askReportRoute(session, event);

    default:
      return problem(404, 'not found');
  }
}

/**
 * Runs list. With `repo=<repoId>` it uses the repo/time index (ADR-023); with
 * `status=<status>` the status index; unfiltered it merges the active statuses (the
 * dashboard's "what's happening now" view) — never a table scan.
 *
 * Authorization is a post-query filter (the indexes are not keyed by installation), so a
 * page can come back shorter than `limit`. We keep paging until the page is full or the
 * index is exhausted — otherwise an operator with one of several installations would see a
 * near-empty list plus a cursor, which reads as "no runs".
 */
async function listRunsRoute(
  session: SessionPayload,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  const limit = parseLimit(q.limit);
  // One `now` for the whole response so every row's live-cost estimate is measured against the
  // same instant (and so `.map(toRunView)` can't accidentally pass the array INDEX as `now`).
  const now = new Date();
  const visible = (runs: RunRecord[]): RunRecord[] =>
    runs.filter((r) => canAdminInstallation(session, r.installationId));

  if (q.repo !== undefined) {
    const repoId = asPositiveInt(q.repo);
    if (!repoId) return problem(400, 'repo must be a numeric repo id');
    if (q.status !== undefined && !ALL_STATUSES.includes(q.status as RunStatus)) {
      return problem(400, `status must be one of ${ALL_STATUSES.join(', ')}`);
    }
    // `repo` wins the index choice (GSI2 repo/time), but a `status` sent alongside it is
    // honoured as a post-query predicate rather than ignored: the console can set both, and
    // silently dropping one would show every status under a "failed" filter.
    const status = q.status as RunStatus | undefined;
    const page = await collectVisible(
      (cursor) => listRunsByRepo(repoId, { limit, cursor }),
      (runs) => visible(runs).filter((r) => status === undefined || r.status === status),
      limit,
      q.cursor,
    );
    // `complete` reports whether rows were DROPPED from this response, not whether the index
    // is exhausted — cursor exhaustion is the client's half of the verdict (ADR-029).
    // `collectVisible` never slices, so an unfiltered repo page loses nothing: every visible
    // row the query returned is here, and a run's remaining jobs are reachable through
    // `nextCursor`. Reporting `nextCursor === undefined` here instead would make a
    // repo-filtered window PERMANENTLY partial: the head page always has an open cursor while
    // history remains, and the client ANDs every page's flag, so walking to the end could
    // never clear the badge. A status predicate does drop sibling jobs, so it forces `false`.
    return json(200, {
      runs: page.runs.map((r) => toRunView(r, now)),
      nextCursor: page.nextCursor ?? null,
      complete: repoResponseComplete(status !== undefined),
    });
  }
  if (q.status !== undefined) {
    if (!ALL_STATUSES.includes(q.status as RunStatus)) {
      return problem(400, `status must be one of ${ALL_STATUSES.join(', ')}`);
    }
    const status = q.status as RunStatus;
    const page = await collectVisible(
      (cursor) => listRunsByStatusPaged(status, { limit, cursor }),
      visible,
      limit,
      q.cursor,
    );
    // A status-filtered page holds only the jobs IN that status, so a run folded from it is
    // partial by construction however far the cursor got.
    return json(200, {
      runs: page.runs.map((r) => toRunView(r, now)),
      nextCursor: page.nextCursor ?? null,
      complete: false,
    });
  }
  const pages = await Promise.all(
    ALL_STATUSES.map((s) => listRunsByStatusPaged(s, { limit })),
  );
  const visibleRuns = sortRunsNewestFirst(visible(pages.flatMap((p) => p.runs)));
  const merged = visibleRuns.slice(0, limit);
  // A merged multi-index view has no single coherent cursor — the client narrows by
  // status or repo to paginate deeper.
  //
  // `complete` tells the client whether any job row was dropped on the way out. This view
  // hands back no cursor, so the client cannot recover a dropped row by paging — the flag
  // carries the whole verdict here. It is decided HERE because only this code sees the raw
  // per-status pages: truncation must be judged before the visibility filter, since a page
  // filled with another tenant's rows looks short while this operator's sibling jobs sit
  // unread past the boundary (ADR-029).
  return json(200, {
    runs: merged.map((r) => toRunView(r, now)),
    nextCursor: null,
    complete: mergedResponseComplete({
      anyIndexTruncated: pages.some((p) => p.nextCursor !== undefined),
      visibleRows: visibleRuns.length,
      returnedRows: merged.length,
    }),
  });
}

/**
 * Enqueue a Discovery re-scan for one repo. Shared by the explicit "Re-scan" action and the
 * automatic re-scan a `mode` change requires (stored routes are mode-dependent since M5).
 */
async function enqueueRescan(repo: RepoRecord): Promise<void> {
  if (!DISCOVERY_QUEUE_URL) throw new Error('discovery queue not configured');
  const [owner, name] = repo.repoFullName.split('/');
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: DISCOVERY_QUEUE_URL,
      MessageBody: JSON.stringify({
        installationId: repo.installationId,
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        owner,
        repo: name,
        reason: 'manual',
      }),
    }),
  );
}

/**
 * Auto-rewrite dry run (ADR-031). Read-only and always available — an operator must be able
 * to see what the PR WOULD change before deciding whether to enable the capability, so this
 * is deliberately not gated on `REWRITE_ENABLED` / `rewriteEnabled`. It reports both gates so
 * the UI can explain why the Apply button is disabled.
 */
async function rewritePreviewRoute(repo: RepoRecord): Promise<Reply> {
  const analyses = await listWorkflowAnalyses(repo.repoId);
  const preview = planPreviewFromAnalyses(analyses);
  return json(200, {
    repo: toRepoView(repo),
    deploymentEnabled: REWRITE_ENABLED,
    repoOptedIn: repo.rewriteEnabled === true,
    canApply: REWRITE_ENABLED && repo.rewriteEnabled === true,
    ...preview,
  });
}

/**
 * Dashboard health. Counts are per-status index counts; `active` sampling is bounded.
 *
 * The counts are platform-wide (the status index is not keyed by installation) while every
 * run LIST is installation-filtered. `stuck` is filtered to the session's grants so no run
 * identity leaks across tenants — the aggregate numbers are deliberately platform-level and
 * documented as such in spec 04.
 */
async function healthRoute(session: SessionPayload): Promise<Reply> {
  // The counts below are deliberately platform-wide (unfilterable by design), so this is
  // the one route a ZERO-grant session (minted at callback time so Setup is reachable)
  // must not see — any GitHub user can complete the OAuth dance; only operators with at
  // least one installation grant get aggregate platform data.
  if (session.installations.length === 0) return problem(403, 'no installations');
  const counts = {} as Record<RunStatus, number>;
  let exact = true;
  await Promise.all(
    ALL_STATUSES.map(async (s) => {
      const res = await countRunsByStatus(s);
      counts[s] = res.count;
      if (!res.exact) exact = false;
    }),
  );
  const activePages = await Promise.all(
    ACTIVE_STATUSES.map((s) => listRunsByStatusPaged(s, { limit: 100 })),
  );
  const active: RunRecord[] = activePages
    .flatMap((p) => p.runs)
    .filter((r) => canAdminInstallation(session, r.installationId));
  // Cost sample (M5). This costs three ADDITIONAL bounded index queries beyond the ones
  // above, and the Dashboard polls this route every 5 s, so keep the window small: 50 rows
  // per terminal status is enough for a rolling estimate and keeps a polling console from
  // reading 300 rows every 5 seconds. Installation-filtered like every other run list, so
  // the per-flavor figures only ever include the caller's own runs (unlike `counts`, which
  // is deliberately platform-wide).
  const terminalPages = await Promise.all(
    (['completed', 'failed', 'timed_out'] as RunStatus[]).map((s) =>
      listRunsByStatusPaged(s, { limit: COST_SAMPLE_PER_STATUS }),
    ),
  );
  const costRuns: RunRecord[] = terminalPages
    .flatMap((p) => p.runs)
    .filter((r) => canAdminInstallation(session, r.installationId));
  // Unclaimed jobs (ADR-050). A THIRD axis, deliberately outside `counts`: a refused job is not
  // a run, so it must not move the active count, the error rate, or any cost figure. Bounded and
  // reported as a floor (`unclaimedExact`) like the status counts, so the badge never claims an
  // exact number it did not finish counting. Platform-wide like `counts` — the route already
  // refuses a zero-grant session for exactly that reason.
  //
  // Windowed to the last `UNCLAIMED_WINDOW_DAYS`, unlike `counts`. A refusal row survives for the
  // full ADR-033 retention (90 days by default), so an unwindowed count keeps the badge red — and
  // its banner asserting in the present tense that jobs "are not running" — for months after the
  // operator fixed the allowlist. Recency is what the badge is for; the Unclaimed screen still
  // lists the full retained history.
  const since = new Date(Date.now() - UNCLAIMED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const refusals = await countRefusals({ sinceIso: since }).catch((err) => {
    // A refusal-count failure must not blank the whole dashboard; the badge degrades instead.
    //
    // UNKNOWN, not zero. `{ count: 0 }` would render a reassuring `0` on the one stat whose whole
    // purpose is to stop the console reporting that nothing is wrong while jobs are stranded —
    // the same false green as the stored `compat: ok`, moved to the headline. `undefined` omits
    // the field, so the badge shows `—` and the banner (which triggers on a positive count) stays
    // silent rather than claiming a count it does not have.
    console.error(JSON.stringify({ msg: 'countRefusals failed', error: errMsg(err) }));
    return undefined;
  });
  return json(200, {
    ...buildHealth(counts, active, new Date(), costRuns),
    countsExact: exact,
    ...(refusals ? { unclaimed: refusals.count, unclaimedExact: refusals.exact } : {}),
    unclaimedWindowDays: UNCLAIMED_WINDOW_DAYS,
  });
}

// ---- reports (spec 04 § Reports) -------------------------------------------

/**
 * Repos this session may report on. Delegates to the report store so the catalog route and
 * the executor cannot disagree about the authorization scope.
 */
async function resolveReportRepos(
  session: SessionPayload,
): Promise<{ repoId: number; repoFullName: string }[]> {
  return resolveVisibleRepos(session);
}

/**
 * Resolve a spec from query params and execute it.
 *
 * A ZERO-grant session is refused outright: it administers nothing, so every aggregate it
 * could ask for is either empty or (if a filter were ever forgotten) platform-wide. Same
 * reasoning as `/api/health`.
 */
async function runReportRoute(
  session: SessionPayload,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  if (session.installations.length === 0) return problem(403, 'no installations');
  const parsed = specFromQuery(q);
  if (!parsed.ok) return problem(400, 'invalid report spec', parsed.errors);
  return json(200, await executeReport(session, parsed.value));
}

/**
 * Execute a validated spec. The ONLY place a report is computed — the manual picker, a
 * shared URL and the model-proposed path all land here, so the authorization scope and the
 * completeness reporting are identical for all three.
 */
async function executeReport(
  session: SessionPayload,
  spec: ReportSpec,
): Promise<Record<string, unknown>> {
  const fetched = await fetchReportRuns(session, spec);
  const rows = applyFilters(fetched.runs, spec);
  const result = computeReport(rows, spec, { complete: fetched.complete });
  return {
    ...result,
    // Transparency block (ADR-045): what was actually resolved and read, so a generated view
    // can show its provenance and be pinned as a plain URL without re-invoking the model.
    resolved: {
      query: specToQuery(spec),
      /** Repos in the operator's authorization scope for this spec. */
      repoCount: fetched.repoIds.length,
      /**
       * Repos actually queried. Lower than `repoCount` only when the row budget cut the
       * fan-out short, which is also when `complete` is false. Reported separately because
       * presenting the scope as the read set overstates what the numbers cover.
       */
      repoCountRead: fetched.repoIdsRead.length,
      /** Restates that scope came from the session, never from the request or a model. */
      scope: 'operator installations',
    },
  };
}

/** CSV/JSON export of the underlying job rows for a spec (not the aggregate). */
async function exportReportRoute(
  session: SessionPayload,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  if (session.installations.length === 0) return problem(403, 'no installations');
  const parsed = specFromQuery(q);
  if (!parsed.ok) return problem(400, 'invalid report spec', parsed.errors);
  const spec = parsed.value;
  const fetched = await fetchReportRuns(session, spec);
  // One instant for the whole response, so an in-flight row's billable window is consistent
  // across every exported row and with the filename stamp.
  const now = new Date();
  const all = toExportRows(applyFilters(fetched.runs, spec), now);
  const stamp = now.toISOString().slice(0, 10);
  const filename = `lca-${spec.metric}-${stamp}`;
  if ((q.format ?? 'csv') === 'json') {
    // Bounded before serialization: the fan-out budget allows 20 000 rows, which is 7-10 MiB of
    // JSON and therefore OVER Lambda's 6 MB synchronous response cap. Exceeding it is not a
    // short file, it is an invocation error the operator sees as a 502.
    const bounded = boundExportRows(all, (rows) => Buffer.byteLength(JSON.stringify(rows)));
    return json(
      200,
      // `complete` is the conjunction: the read may have been truncated by the fan-out budget,
      // the response by the export cap, and either one means these rows are not the whole story.
      { rows: bounded.rows, complete: fetched.complete && bounded.complete, rowLimit: MAX_EXPORT_ROWS },
      { headers: { 'Content-Disposition': `attachment; filename="${filename}.json"` } },
    );
  }
  const bounded = boundExportRows(all, (rows) => Buffer.byteLength(toCsv(rows)));
  return {
    statusCode: 200,
    raw: toCsv(bounded.rows),
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
      // A CSV body has nowhere to put the `complete` flag the JSON export carries, so a
      // truncated fan-out would hand the operator a silently short file. State it in a header
      // (and in the UI beside the download link) rather than letting the row count imply a
      // total it is not. Covers BOTH truncation sources: the read budget and the export cap.
      'X-Report-Complete': String(fetched.complete && bounded.complete),
      // Tenant-controlled strings ride in this body; never let a browser sniff it as HTML.
      'X-Content-Type-Options': 'nosniff',
    },
  };
}

/**
 * Natural-language report (Part C). The pipeline is deliberately one-directional:
 *
 *   operator question → model → JSON spec → validateReportSpec → executeReport
 *
 * The model's output is data. It is parsed, validated against the closed catalog, and either
 * handed back as a spec the SAME deterministic route then executes, or refused. Nothing it
 * returns is evaluated or rendered, and it cannot influence which repos are read.
 *
 * This route deliberately does NOT execute the report. The console adopts the returned spec as
 * picker state, which makes it fetch `GET /api/reports/run` for that spec — so executing here
 * too would run the authorization fan-out TWICE per question (up to 2 x MAX_TOTAL_ROWS row
 * reads) and throw the first result away. `/api/reports/run` stays the single executor, which
 * also means a shared URL and an assistant answer are byte-identical by construction.
 */
async function askReportRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
): Promise<Reply> {
  if (session.installations.length === 0) return problem(403, 'no installations');
  if (!nlEnabled()) return problem(503, 'natural-language reports are not enabled');
  const raw = bodyOf(event);
  if (raw === undefined) return problem(400, 'body is not valid JSON');
  const body = (raw ?? {}) as { question?: unknown };
  const question = checkQuestion(body.question);
  if (!question.ok) return problem(400, question.message);

  const decision = rateLimit(session.login);
  if (!decision.allowed) {
    return json(
      429,
      {
        error:
          decision.reason === 'container-budget'
            ? 'report assistant budget exhausted — use the manual report picker'
            : 'too many report questions — slow down',
        reason: decision.reason,
      },
      decision.retryAfterSeconds
        ? { headers: { 'Retry-After': String(decision.retryAfterSeconds) } }
        : {},
    );
  }

  const proposal = await proposeSpec(question.question);
  // Audit every invocation with the actor (ADR-044). The question is operator-authored text,
  // so only its length is logged — not its content.
  console.log(
    JSON.stringify({
      msg: 'report question',
      actor: session.login,
      modelId: modelId(),
      questionChars: question.question.length,
      outcome: proposal.ok ? 'spec' : proposal.reason,
      ...(proposal.ok ? { metric: proposal.spec.metric, dimension: proposal.spec.dimension } : {}),
    }),
  );
  if (!proposal.ok) {
    // 422, not 500: the request was fine, the assistant could not serve it. The UI shows the
    // manual picker rather than an error page.
    return json(proposal.reason === 'unavailable' ? 503 : 422, {
      error: proposal.message,
      reason: proposal.reason,
      ...(proposal.errors ? { details: proposal.errors } : {}),
      fallback: 'manual',
    });
  }
  // Spec + provenance only. The client renders from the deterministic route.
  return json(200, {
    spec: proposal.spec,
    source: { kind: 'model', modelId: proposal.modelId },
    resolved: {
      query: specToQuery(proposal.spec),
      /** Restates that scope came from the session, never from the request or the model. */
      scope: 'operator installations',
    },
  });
}

/**
 * Settings (spec 04 § Settings, ADR-034). Answers the operator's real questions — *is this
 * environment linked to a GitHub App, which one, what does it claim, and is GitHub actually
 * reaching us* — rather than listing SSM paths.
 *
 * The App identity + webhook evidence come from GitHub itself, fetched through the App-config
 * broker (the Mgmt λ cannot read the App PEM by design — ADR-025). SSM parameter presence is
 * still computed here (`DescribeParameters`, metadata only) but demoted to `diagnostics`.
 *
 * Every sub-fetch degrades independently: a broker fault must leave the rest of the screen
 * usable and say what failed, because "we can't verify the App" is itself the answer.
 */
async function settingsRoute(session: SessionPayload): Promise<Reply> {
  const checks: { param: string; label: string }[] = [
    { param: `${SSM_PREFIX}/github/app-id`, label: 'GitHub App ID' },
    { param: `${SSM_PREFIX}/github/app-pem`, label: 'GitHub App private key' },
    { param: `${SSM_PREFIX}/github/webhook-secret`, label: 'Webhook secret' },
    { param: `${SSM_PREFIX}/github/client-id`, label: 'OAuth client ID' },
    { param: `${SSM_PREFIX}/github/client-secret`, label: 'OAuth client secret' },
    { param: `${SSM_PREFIX}/mgmt/session-secret`, label: 'Console session key' },
    { param: RUNNER_LABELS_PARAM, label: 'Runner labels' },
    { param: PLATFORM_ADMINS_PARAM, label: 'Platform admins' },
    { param: `${SSM_PREFIX}/config/table-name`, label: 'Run table name' },
  ];

  const [secrets, labelsRaw, adminsRaw, storedInstalls, heartbeat, audit, linkage, flavors] =
    await Promise.all([
      Promise.all(
        checks.map(async (c) => toSecretStatus(c.param, c.label, await paramExists(c.param))),
      ),
      getParam(RUNNER_LABELS_PARAM, 0).catch(() => undefined),
      getParam(PLATFORM_ADMINS_PARAM, 0).catch(() => undefined),
      listInstallations(grantedInstallationIds(session)).catch(() => []),
      getWebhookHeartbeat().catch(() => undefined),
      listAudit(10).catch(() => []),
      appLinkage(),
      imageAvailability(),
    ]);

  const labels = parseRunnerLabels(labelsRaw);
  // Whether GitHub's own installation list is trustworthy — NOT whether it is non-empty (see
  // `installationsEnumerated`). A verified App installed nowhere yet is an authoritative empty
  // list, so the store fallback below must not resurrect stale rows for it.
  const enumerated = installationsEnumerated(linkage);
  // The store read above reconciles the SESSION's grants (ADR-037), which is the right scope
  // for the fallback list below — it only ever shows this operator's installations. The
  // `known` flag, though, is a platform-wide claim about every installation GitHub reports.
  // An installation whose row never got its GSI1 stamp is absent from the index result, so
  // without a second pass over the GitHub-reported ids this screen would render `known:
  // false` for an installation the platform is actively serving — the same index blindness
  // ADR-037 fixed, resurfacing as a false warning. Reconcile against those ids (GetItem only
  // for ones the index really missed, repairing as it goes) before deciding `known`.
  const reconciled = enumerated && linkage?.installations?.length
    ? await reconcileInstallations(
        storedInstalls,
        linkage.installations.map((i) => i.installationId),
        { get: getInstallation, repair: repairInstallationIndex },
      ).catch(() => storedInstalls)
    : storedInstalls;
  const knownIds = new Set(reconciled.map((i) => i.installationId));

  // Installations and the `installationsEnumerated` flag are resolved TOGETHER: they are two
  // halves of one fact (whose list this is), and a caller that could set one without the other
  // would be able to publish a store fallback labelled as GitHub's authoritative answer.
  const resolved = resolveInstallationList(linkage, storedInstalls, knownIds);

  const deliveries: WebhookDeliveryView[] = linkage?.webhook?.recentDeliveries ?? [];
  /**
   * Live control-plane reconciliation (ADR-051), derived from the two facts this route ALREADY
   * read: the runner-label allowlist and which flavors have a published `image-arn-*`.
   *
   * Deliberately not a second `controlPlaneSnapshot()` call. That would re-read the same
   * parameter and re-run one `DescribeParameters` per catalog flavor for values already in hand,
   * and — worse — could disagree with `runnerLabels.labels` rendered beside it if the parameter
   * changed between the two reads. `live` is the allowlist read succeeding: `labelsRaw ===
   * undefined` is the `.catch(() => undefined)` above, and an unread allowlist is not evidence
   * that anything is broken.
   */
  const snapshot: ControlPlaneSnapshot = {
    allowlist: labels,
    imagePublished: flavors,
    live: labelsRaw !== undefined,
  };
  const view: SettingsView = {
    envName: ENV_NAME,
    region: process.env.AWS_REGION ?? '',
    app: linkage?.app ?? null,
    ...(linkage?.verifyError ? { appVerifyError: linkage.verifyError } : {}),
    ...(linkage?.configuredAppId ? { configuredAppId: linkage.configuredAppId } : {}),
    installations: resolved.installations,
    // Pre-scoping value; `scopeSettingsView` recomputes it from what it actually withheld.
    installationsHidden: 0,
    // Whether the list above is GitHub's complete answer. A false makes the empty case mean
    // "we could not ask", not "installed nowhere" — the client cannot infer this from the rest
    // of the payload, because an identity that verified while `/app/installations` failed still
    // renders a verified App.
    installationsEnumerated: resolved.enumerated,
    runnerLabels: {
      labels,
      unset: labels.length === 0,
      hostedLabels: hostedLabelsIn(labels, HOSTED_LABELS),
    },
    webhook: buildWebhookHealth({
      configuredUrl: linkage?.webhook?.configuredUrl,
      deployedUrl: WEBHOOK_URL || undefined,
      secretConfigured: linkage?.webhook?.secretConfigured,
      insecureSsl: linkage?.webhook?.insecureSsl,
      heartbeat,
      recentDeliveries: deliveries,
      error: linkage?.webhookError ?? linkage?.brokerError,
    }),
    flavors: buildFlavorViews(flavors),
    recentChanges: audit,
    diagnostics: { secrets },
  };

  // Redaction guard (AGENTS.md hard rule). The shape cannot hold a secret, but the strings in
  // it are partly forwarded from GitHub/AWS; fail loudly rather than serve tainted content.
  assertNoSecrets(view, 'GET /api/settings');
  const isPlatformAdmin = canAdminPlatform(session, parsePlatformAdmins(adminsRaw));
  // Cross-tenant scoping (ADR-035): installation identities and the operator audit trail are
  // not environment-level facts. Settings itself stays readable for everyone so a fresh
  // environment can show its state.
  const scoped = scopeSettingsView(view, {
    isPlatformAdmin,
    canSeeInstallation: (id) => canAdminInstallation(session, id),
  });
  return json(200, {
    ...scoped,
    /** Whether THIS session may use the mutating actions (drives the UI's disabled state). */
    canAdminPlatform: isPlatformAdmin,
    /**
     * Per-flavor live readiness (ADR-051) — empty when the allowlist read failed, so the client
     * renders `unchecked` rather than marking every flavor broken on a transient SSM error.
     *
     * `runnerLabels.labels` above already carries the allowlist itself, so it is NOT repeated
     * here: one field, one meaning.
     */
    readiness: snapshot.live ? reconcileFlavors(catalogForReadiness(), snapshot) : [],
    /** Allowlist entries that are not a catalog flavor's label (adopt labels, FlavorMap, typos). */
    unmatchedAllowlistLabels: unmatchedAllowlistLabels(catalogForReadiness(), snapshot.allowlist),
    /** False when the live allowlist read failed — readiness is unknown, not green. */
    controlPlaneLive: snapshot.live,
  });
}

/**
 * Whether GitHub's installation enumeration for this environment can be trusted as COMPLETE.
 *
 * The discriminator is the App linkage verifying, **not** the list being non-empty. Those are
 * different facts, and conflating them makes the screen state something false in both
 * directions: a verified App that is simply not installed anywhere yet returns an authoritative
 * empty list, which must not be reported as "we could not enumerate installations" (and must not
 * make the settings view fall back to stale store rows GitHub says are gone). Conversely, an
 * identity that verified while `/app/installations` FAILED sets `verifyError` with an empty
 * list — that one genuinely is a blind spot.
 *
 * `verifyError` is the broker's single channel for both failures (`statusAction` sets it for an
 * identity failure and for an installations failure alike), so "app present AND no verifyError"
 * is exactly "the list is complete".
 *
 * Exported for tests: it is the discriminator two operator-facing claims depend on.
 */
export function installationsEnumerated(
  linkage: (AppcfgResult['linkage'] & { brokerError?: string }) | undefined,
): boolean {
  return Boolean(linkage?.app) && !linkage?.verifyError;
}

/**
 * Resolve the installation list AND whether it is GitHub's complete answer, as one value.
 *
 * These are deliberately not two independent expressions. They are two halves of one fact —
 * *whose list is this* — and separating them lets a caller publish a store fallback while
 * labelling it as GitHub's authoritative enumeration. That mislabelling is exactly what the
 * client acts on: it decides between "the App is not installed anywhere yet" (an instruction to
 * go install it) and "GitHub's list could not be read" (an instruction to retry / check
 * permissions). Returning both from one place makes the pair unbreakable and unit-testable
 * without AWS.
 *
 * When the linkage verified, GitHub's list wins even against our store — it is ground truth even
 * if an `installation` webhook was missed, and `known` then flags the rows our store lacks.
 * When it did not, the store is all we have, and `enumerated: false` says so.
 */
export function resolveInstallationList(
  linkage: (AppcfgResult['linkage'] & { brokerError?: string }) | undefined,
  stored: { installationId: number; accountLogin: string; suspended: boolean; deleted?: boolean }[],
  knownIds: ReadonlySet<number>,
): { installations: AppInstallationView[]; enumerated: boolean } {
  if (installationsEnumerated(linkage)) {
    return {
      enumerated: true,
      installations: (linkage?.installations ?? []).map((i) => ({
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        suspended: i.suspended,
        known: knownIds.has(i.installationId),
      })),
    };
  }
  return {
    enumerated: false,
    installations: stored
      .filter((i) => !i.deleted)
      .map((i) => ({
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        suspended: i.suspended,
        known: true,
      })),
  };
}

/** Broker `status` call, folded into a shape the settings view can consume. */
async function appLinkage(): Promise<
  (AppcfgResult['linkage'] & { brokerError?: string }) | undefined
> {
  if (!APPCFG_BROKER_NAME) {
    return {
      app: null,
      installations: [],
      webhook: null,
      verifyError: 'App-config broker not configured for this environment',
    };
  }
  try {
    const res = await invokeAppcfg({ action: 'status', actor: 'system' });
    if (!res.ok) return { app: null, installations: [], webhook: null, verifyError: res.error };
    return res.linkage;
  } catch (err) {
    const detail = scrubForOperator(errMsg(err));
    console.error(JSON.stringify({ msg: 'appcfg status failed', error: detail }));
    return { app: null, installations: [], webhook: null, verifyError: detail, brokerError: detail };
  }
}

/**
 * Invoke the App-config broker. RequestResponse (the operator is waiting on the verification
 * result), and the broker's own response contract guarantees no secret values come back —
 * re-asserted here so a broker regression can't leak through the API.
 */
async function invokeAppcfg(payload: Record<string, unknown>): Promise<AppcfgResult> {
  if (!APPCFG_BROKER_NAME) throw new Error('App-config broker not configured');
  let res;
  try {
    res = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: APPCFG_BROKER_NAME,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload), 'utf8'),
      }),
    );
  } catch (err) {
    // A throttle is a retryable "busy", not a fault. The broker is not concurrency-capped
    // (write serialization is its own DynamoDB lock, ADR-034), but an account-level Lambda
    // throttle can still surface here. The raw SDK error must never be surfaced either: on
    // the relink path the request payload it may quote contains the submitted credentials.
    if ((err as { name?: string }).name === 'TooManyRequestsException') {
      throw new BrokerBusyError('the platform config broker is busy — retry in a moment');
    }
    throw new Error(`App-config broker invoke failed: ${(err as { name?: string }).name ?? 'error'}`);
  }
  if (res.FunctionError) {
    throw new Error(`App-config broker returned ${res.FunctionError}`);
  }
  const text = res.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
  let parsed: AppcfgResult;
  try {
    parsed = JSON.parse(text || '{}') as AppcfgResult;
  } catch {
    throw new Error('App-config broker returned a non-JSON payload');
  }
  assertNoSecrets(parsed, 'App-config broker response');
  return parsed;
}

/** Broker at capacity — surfaced as a retryable 503, never as an internal error. */
class BrokerBusyError extends Error {}

/** Map a broker fault to a Reply: busy ⇒ 503 (retry), anything else ⇒ rethrow. */
function brokerBusyReply(err: unknown): Reply | undefined {
  return err instanceof BrokerBusyError ? problem(503, err.message) : undefined;
}

/**
 * Map a `!ok` broker result to a Reply. Lock contention (`busy`) is **503 with `Retry-After`**,
 * not the caller's `failStatus`: the request was valid and will succeed once the in-flight
 * config change finishes, so the client (and the operator) must be told to retry rather than
 * shown a validation/upstream failure.
 */
function brokerFailureReply(res: AppcfgResult, failStatus: number, fallback: string): Reply {
  if (res.busy) {
    return json(
      503,
      { error: res.error ?? 'another platform configuration change is in progress' },
      { headers: { 'Retry-After': '5' } },
    );
  }
  return problem(failStatus, res.error ?? fallback);
}

/**
 * Platform-mutation gate. Distinct from installation admin rights on purpose: these actions
 * affect the whole environment (see `canAdminPlatform`). Fails CLOSED when the allow-list is
 * unset, and says so, so a fresh environment is inert rather than open.
 */
async function requirePlatformAdmin(session: SessionPayload): Promise<Reply | undefined> {
  const admins = parsePlatformAdmins(await getParam(PLATFORM_ADMINS_PARAM, 0).catch(() => undefined));
  if (!admins.length) {
    return problem(
      403,
      `no platform administrators are configured — set ${PLATFORM_ADMINS_PARAM} ` +
        '(comma-separated GitHub logins) to enable platform settings changes',
    );
  }
  if (!canAdminPlatform(session, admins)) return problem(403, 'not a platform administrator');
  return undefined;
}

/**
 * Replace the environment's runner labels.
 *
 * Two safeguards beyond validation, because this takes effect on the very next
 * `workflow_job` webhook (Ingest reads the parameter per delivery):
 *   - `dryRun: true` returns the impact analysis and writes nothing;
 *   - a non-dry-run STILL returns the impact of what it just did, so the audit trail and the
 *     operator see the same set of affected jobs.
 */
/**
 * The installation's ROUTABLE custom flavors, for config validation (ADR-040/041).
 *
 * Fails OPEN to `[]` on a store fault, matching the resolver: a DynamoDB blip then rejects a
 * custom-flavor name rather than accepting an unverifiable one. Refusing a write the operator can
 * retry is the safe direction — the unsafe one is persisting a flavor name we could not confirm.
 */
async function routableCustomFlavorsFor(installationId: number): Promise<{ name: string }[]> {
  try {
    return routableCustomFlavors(await listCustomFlavors(installationId));
  } catch (err) {
    console.warn(
      JSON.stringify({ msg: 'custom flavor read failed during validation', error: errMsg(err) }),
    );
    return [];
  }
}

/**
 * Ask the flavor-validation λ to run the ADR-041 gates for one flavor.
 *
 * Fire-and-forget (`InvocationType: 'Event'`): a smoke run launches a microVM, dispatches a
 * workflow and waits for a conclusion — minutes of wall clock, far beyond an API request. The
 * flavor row is already `pending`, so the console has something truthful to render either way, and
 * a lost invoke leaves the row `pending` rather than falsely `valid`.
 *
 * Returns false when the trigger could not be delivered, so the caller can say so instead of
 * implying validation has begun.
 */
async function triggerFlavorValidation(input: {
  installationId: number;
  name: string;
  actor: string;
}): Promise<boolean> {
  if (!FLAVORVAL_FUNCTION_NAME) return false;
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: FLAVORVAL_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(input), 'utf8'),
      }),
    );
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({ msg: 'flavor validation trigger failed', name: input.name, error: errMsg(err) }),
    );
    return false;
  }
}

/** Resolve + authorize the `?installation=<id>` scope every custom-flavor route requires. */
function scopeInstallation(
  session: SessionPayload,
  q: Record<string, string | undefined>,
): { installationId: number } | { reply: Reply } {
  const installationId = asPositiveInt(q.installation);
  if (!installationId) return { reply: problem(400, 'installation query param required') };
  if (!canAdminInstallation(session, installationId)) return { reply: problem(403, 'forbidden') };
  return { installationId };
}

/** Shape a stored custom-flavor row for an API response. */
function toCustomFlavorResponse(rec: CustomFlavorRecord): Record<string, unknown> {
  return {
    name: rec.name,
    label: rec.label,
    arch: rec.arch,
    vcpu: rec.vcpu,
    memoryMb: rec.memoryMb,
    capabilities: rec.capabilities,
    description: rec.description,
    imageArn: rec.imageArn,
    smokeRepoFullName: rec.smokeRepoFullName ?? null,
    smokeWorkflowPath: rec.smokeWorkflowPath ?? null,
    state: rec.state,
    reason: rec.reason ?? null,
    evidence: rec.evidence ?? null,
    routable: rec.state === 'valid',
    usdPerMinute: shapeRatePerMinute(rec.vcpu, rec.memoryMb),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * `POST /api/flavors/preview` — run the cheap half of the ADR-041 static gate on a PROPOSED
 * flavor and return the rate estimate. Writes nothing and probes nothing, so the console can show
 * an operator the verdict + cost BEFORE they commit to a registration.
 *
 * The image is deliberately not probed here: `staticGate` runs every check it can without the
 * probe, and a preview that made AWS calls would let an unauthenticated-ish form keystroke drive
 * describe traffic. A `pass` here is NOT validation and the response says so.
 */
async function previewFlavorRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  const scope = scopeInstallation(session, q);
  if ('reply' in scope) return scope.reply;

  const raw = bodyOf(event);
  if (raw === undefined) return problem(400, 'body is not valid JSON');
  const parsed = validateCustomFlavor(raw);
  if (!parsed.ok) return problem(400, 'invalid custom flavor', parsed.errors);

  // Build the record to reuse the ONE writer's namespacing + built-in collision rules, so the
  // preview cannot disagree with what registration will accept.
  let candidate: CustomFlavorRecord;
  try {
    candidate = buildFlavorRecord({ ...parsed.value, installationId: scope.installationId });
  } catch (err) {
    return problem(400, 'invalid custom flavor', [errMsg(err)]);
  }

  const gate = staticGate({ flavor: candidate, requireSmokeRepo: false });
  return json(200, {
    name: candidate.name,
    label: candidate.label,
    // ADR-038: derived from the requested shape, and an ESTIMATE — only memory is requestable and
    // `vcpu` is descriptive, so this is the rate for the shape, not a quoted price.
    usdPerMinute: shapeRatePerMinute(candidate.vcpu, candidate.memoryMb),
    rateIsEstimate: true,
    staticGate: gate.ok ? { ok: true } : { ok: false, failures: gate.failures },
    // Said explicitly so no client can present a static pass as validation (ADR-041).
    note:
      'static checks only — a flavor is not routable until a smoke run launches a microVM from ' +
      'this image and proves a runner registers, runs a job and self-terminates',
  });
}

/** `POST /api/flavors` — register a custom flavor (ADR-040) and start validation (ADR-041). */
async function registerFlavorRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  const scope = scopeInstallation(session, q);
  if ('reply' in scope) return scope.reply;

  const raw = bodyOf(event);
  if (raw === undefined) return problem(400, 'body is not valid JSON');
  const parsed = validateCustomFlavor(raw);
  if (!parsed.ok) return problem(400, 'invalid custom flavor', parsed.errors);

  let rec: CustomFlavorRecord;
  try {
    rec = await registerCustomFlavor({
      ...parsed.value,
      installationId: scope.installationId,
      actor: session.login,
    });
  } catch (err) {
    if (err instanceof FlavorExistsError) return problem(409, err.message);
    // The per-installation cap (`MAX_CUSTOM_FLAVORS_PER_INSTALLATION`) is what keeps the
    // single-page flavor read whole, so exceeding it is a refusal the operator must SEE — 409, not
    // a 500 that reads as our fault. Deleting an unused flavor is the remedy.
    if (err instanceof TooManyFlavorsError) return problem(409, err.message);
    // `buildFlavorRecord` throws on a malformed name or a built-in collision — both are the
    // client's input, so 400 rather than 500 (ADR-040 refuses collisions at registration). Matched
    // by TYPE: message text cannot distinguish these from a DynamoDB fault that happens to mention
    // a "name", which would misreport a real outage as bad operator input.
    if (err instanceof InvalidFlavorError) {
      return problem(400, 'invalid custom flavor', [err.message]);
    }
    throw err;
  }

  const triggered = await triggerFlavorValidation({
    installationId: scope.installationId,
    name: rec.name,
    actor: session.login,
  });

  console.log(
    JSON.stringify({
      msg: 'custom flavor registered',
      actor: session.login,
      installationId: scope.installationId,
      flavor: rec.name,
      validationTriggered: triggered,
    }),
  );
  await appendAudit({
    at: new Date().toISOString(),
    actor: session.login,
    action: 'custom-flavor-registered',
    detail: scrubForOperator(
      `${rec.name} (${rec.memoryMb} MiB, caps [${rec.capabilities.join(', ')}]) → pending validation`,
    ),
  }).catch((err) =>
    console.error(JSON.stringify({ msg: 'flavor audit write failed', error: errMsg(err) })),
  );

  return json(201, {
    flavor: toCustomFlavorResponse(rec),
    validationTriggered: triggered,
    // A registered flavor is NOT usable yet, and the response must not imply it is.
    note: triggered
      ? 'validation started — this flavor is not routable until it reaches state `valid`'
      : 'validation could not be started; the flavor stays `pending` and is not routable. Use re-validate to retry.',
    ...(rec.smokeRepoFullName ? {} : { smokeWorkflow: smokeWorkflowYaml() }),
  });
}

/** `DELETE /api/flavors/{name}` — remove a custom flavor. */
async function deleteFlavorRoute(
  session: SessionPayload,
  match: RouteMatch,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  const scope = scopeInstallation(session, q);
  if ('reply' in scope) return scope.reply;
  const name = match.params.name;
  if (!name) return problem(400, 'flavor name required');

  const existing = await getCustomFlavor(scope.installationId, name);
  if (!existing) return problem(404, 'custom flavor not found');
  await deleteCustomFlavor(scope.installationId, name);

  console.log(
    JSON.stringify({
      msg: 'custom flavor deleted',
      actor: session.login,
      installationId: scope.installationId,
      flavor: name,
    }),
  );
  await appendAudit({
    at: new Date().toISOString(),
    actor: session.login,
    action: 'custom-flavor-deleted',
    detail: scrubForOperator(`${name} (was ${existing.state})`),
  }).catch((err) =>
    console.error(JSON.stringify({ msg: 'flavor audit write failed', error: errMsg(err) })),
  );
  return json(200, { deleted: name });
}

/**
 * `POST /api/flavors/{name}/revalidate` — the manual re-validate trigger ADR-041 requires,
 * optionally repointing the image ARN in the same call.
 *
 * Both paths return the flavor to `pending` FIRST, so it stops being routable the moment its
 * evidence is withdrawn rather than staying `valid` while a run that may condemn it is in flight.
 * This is also the only way out of terminal `invalid`.
 */
async function revalidateFlavorRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
  match: RouteMatch,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  const scope = scopeInstallation(session, q);
  if ('reply' in scope) return scope.reply;
  const name = match.params.name;
  if (!name) return problem(400, 'flavor name required');

  const raw = bodyOf(event);
  const parsed = validateRevalidateBody(raw === undefined ? {} : raw);
  if (!parsed.ok) return problem(400, 'invalid re-validate body', parsed.errors);

  const existing = await getCustomFlavor(scope.installationId, name);
  if (!existing) return problem(404, 'custom flavor not found');

  if (parsed.value.imageArn && parsed.value.imageArn !== existing.imageArn) {
    // A new ARN is a new artifact: `repointFlavorImage` swaps the ARN and resets to `pending`
    // atomically, so there is no instant where a `valid` row points at an unproven image.
    const res = await repointFlavorImage({
      installationId: scope.installationId,
      name,
      imageArn: parsed.value.imageArn,
      actor: session.login,
    });
    if (!res.changed) return problem(404, 'custom flavor not found');
  } else if (existing.state !== 'pending') {
    const moved = await transitionFlavorValidation({
      installationId: scope.installationId,
      name,
      to: 'pending',
      actor: session.login,
    });
    if (!moved) return problem(409, 'flavor state changed concurrently — retry');
  }

  const triggered = await triggerFlavorValidation({
    installationId: scope.installationId,
    name,
    actor: session.login,
  });
  const after = await getCustomFlavor(scope.installationId, name);

  console.log(
    JSON.stringify({
      msg: 'custom flavor re-validation requested',
      actor: session.login,
      installationId: scope.installationId,
      flavor: name,
      repointed: Boolean(parsed.value.imageArn && parsed.value.imageArn !== existing.imageArn),
      validationTriggered: triggered,
    }),
  );
  await appendAudit({
    at: new Date().toISOString(),
    actor: session.login,
    action: 'custom-flavor-revalidate',
    detail: scrubForOperator(
      `${name}: ${existing.state} → pending` +
        (parsed.value.imageArn && parsed.value.imageArn !== existing.imageArn
          ? ' (image repointed)'
          : ''),
    ),
  }).catch((err) =>
    console.error(JSON.stringify({ msg: 'flavor audit write failed', error: errMsg(err) })),
  );

  return json(202, {
    flavor: after ? toCustomFlavorResponse(after) : null,
    validationTriggered: triggered,
    note: triggered
      ? 'validation restarted — not routable until it reaches state `valid`'
      : 'validation could not be started; the flavor is `pending` and not routable',
  });
}

async function putRunnerLabelsRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
): Promise<Reply> {
  const denied = await requirePlatformAdmin(session);
  if (denied) return denied;

  const raw = bodyOf(event);
  if (raw === undefined) return problem(400, 'body is not valid JSON');
  const parsed = validateRunnerLabels(raw);
  if (!parsed.ok) return problem(400, 'invalid runner labels', parsed.errors);

  const current = parseRunnerLabels(await getParam(RUNNER_LABELS_PARAM, 0).catch(() => undefined));
  const impact = await labelImpact(current, parsed.value.labels, session);

  if (parsed.value.dryRun) {
    return json(200, { dryRun: true, applied: false, labels: current, impact });
  }

  // The Mgmt λ has no PutParameter grant at all (ADR-025/034) — the broker owns config writes.
  let res: AppcfgResult;
  try {
    res = await invokeAppcfg({
      action: 'setRunnerLabels',
      actor: session.login,
      labels: serializeRunnerLabels(parsed.value.labels),
    });
  } catch (err) {
    const busy = brokerBusyReply(err);
    if (busy) return busy;
    throw err;
  }
  if (!res.ok) return brokerFailureReply(res, 502, 'runner label write failed');

  console.log(
    JSON.stringify({
      msg: 'runner labels changed',
      actor: session.login,
      from: current,
      to: parsed.value.labels,
      losing: impact.losing.length,
      gaining: impact.gaining.length,
    }),
  );
  // The broker audits the parameter write itself; this row adds the IMPACT the broker cannot
  // see (which jobs changed claim status), so the trail records what the operator was shown.
  await appendAudit({
    at: new Date().toISOString(),
    actor: session.login,
    action: 'runner-labels-impact',
    detail: scrubForOperator(
      `from [${current.join(', ')}] to [${parsed.value.labels.join(', ')}]; ` +
        `${impact.losing.length} job(s) no longer claimed, ${impact.gaining.length} newly claimed` +
        (impact.partial.repoCap ? ' (impact scan hit the repo cap)' : '') +
        (impact.partial.unverifiedInstallations
          ? ' (App linkage unverified — installations may be missing from the scan)'
          : ''),
    ),
  }).catch((err) =>
    console.error(JSON.stringify({ msg: 'label audit write failed', error: errMsg(err) })),
  );
  return json(200, { dryRun: false, applied: true, labels: parsed.value.labels, impact });
}

/**
 * Which stored workflow jobs change claim status under a proposed label set. Bounded at both
 * levels — the repo enumeration (`collectImpactRepos`) and the analysis fetch — so it reports
 * `truncated` rather than fanning out unboundedly inside a 29 s API timeout.
 */
const MAX_IMPACT_REPOS = 50;

/**
 * Enumerate the repos a label-impact scan will consider, bounded.
 *
 * Pure of AWS (the two listers are injected) so the BOUND is testable: this route shares the
 * console's 29 s API Gateway cap, and an environment with many installations would otherwise
 * issue one `listRepos` query per installation before `MAX_IMPACT_REPOS` ever applied. It stops
 * as soon as it holds more repos than will be scanned — one surplus repo is all `truncated`
 * needs, and that flag is the only thing the surplus affects.
 */
export async function collectImpactRepos(
  installs: { installationId: number; deleted?: boolean }[],
  listReposFor: (installationId: number) => Promise<RepoRecord[]>,
  cap = MAX_IMPACT_REPOS,
): Promise<{ repoId: number; repoFullName: string }[]> {
  const repos: { repoId: number; repoFullName: string }[] = [];
  for (const inst of installs) {
    if (inst.deleted) continue;
    if (repos.length > cap) break;
    const list = await listReposFor(inst.installationId).catch(() => []);
    // `isRepoOptedOut` (not just `enabled !== false`): Ingest refuses a repo whose `mode` is
    // `off` as well, so counting its jobs here would claim a label change moves work that the
    // control plane will keep refusing either way. Reusing Ingest's own predicate keeps the two
    // in step, exactly as `buildLabelImpact` mirrors `shouldClaim`.
    for (const r of list) {
      if (isRepoOptedOut(r)) continue;
      repos.push({ repoId: r.repoId, repoFullName: r.repoFullName });
    }
  }
  return repos;
}

/**
 * Label-change impact.
 *
 * The candidate set is deliberately PLATFORM-wide, not the session's grants. This preview is
 * the operator's only warning about jobs a label change will stop claiming, and a label change
 * takes effect for EVERY tenant on the next webhook — so an installation missing from the
 * GSI1 index (ADR-037) must not silently shrink the impact set and make the change look safer
 * than it is. GitHub's own installation list is the ground truth, so it supplies the reconcile
 * candidates; when the broker cannot verify it, the scan falls back to the index plus this
 * session's grants and is reported as `truncated`, because it may then be missing rows.
 */
async function labelImpact(
  current: string[],
  proposed: string[],
  session: SessionPayload,
): Promise<LabelImpactView> {
  const linkage = await appLinkage();
  // Trust GitHub's list when the linkage VERIFIED, not merely when the list is non-empty: an
  // App verified and installed nowhere yet enumerates authoritatively to zero, and reporting
  // that as `unverifiedInstallations` would print "the linkage could not be verified" on the
  // operator's only pre-change warning — sending them after a credential fault that does not
  // exist, for a scan that has no blind spot at all.
  const verified = installationsEnumerated(linkage);
  const candidates = verified
    ? (linkage?.installations ?? []).map((i) => i.installationId)
    : grantedInstallationIds(session);
  const installs = await listInstallations(candidates).catch(() => []);
  const repos = await collectImpactRepos(installs, (id) => listRepos(id));
  // Two independent reasons the scan can be partial: the repo-count bound, and an unverifiable
  // App linkage that left the installation enumeration incomplete. Both mean "there may be
  // affected jobs not listed here", but they are NOT the same size of blind spot, so they are
  // reported separately (`impact.partial`) rather than folded into one flag the UI must guess at.
  const truncatedByCap = repos.length > MAX_IMPACT_REPOS;
  const scanned = repos.slice(0, MAX_IMPACT_REPOS);
  const withAnalyses = await Promise.all(
    scanned.map(async (r) => ({
      ...r,
      analyses: (await listWorkflowAnalyses(r.repoId).catch(() => [])) as WorkflowAnalysisRecord[],
    })),
  );
  return buildLabelImpact(current, proposed, withAnalyses, {
    repoCap: truncatedByCap,
    unverifiedInstallations: !verified,
  });
}

/**
 * Re-link the environment to a new/rotated GitHub App. **Write-only intake**: the credentials
 * go straight to the broker, which verifies them against GitHub before writing and answers
 * with presence + verification outcome only. Nothing in this function's response, logs, or
 * audit row can carry a submitted value (AGENTS.md hard rule).
 */
async function relinkGithubAppRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
): Promise<Reply> {
  const denied = await requirePlatformAdmin(session);
  if (denied) return denied;

  const raw = bodyOf(event);
  if (raw === undefined) return problem(400, 'body is not valid JSON');
  const parsed = validateRelinkBody(raw);
  if (!parsed.ok) return problem(400, 'invalid credentials payload', parsed.errors);

  let res: AppcfgResult;
  try {
    res = await invokeAppcfg({
      action: 'relink',
      actor: session.login,
      credentials: {
        appId: parsed.value.appId,
        pem: parsed.value.pem,
        webhookSecret: parsed.value.webhookSecret,
        clientId: parsed.value.clientId,
        clientSecret: parsed.value.clientSecret,
      },
      ...(parsed.value.allowHookDesync ? { allowHookDesync: true } : {}),
    });
  } catch (err) {
    const busy = brokerBusyReply(err);
    if (busy) return busy;
    throw err;
  }
  if (!res.ok) {
    // Contention is retryable and must not read as "your credentials were rejected".
    if (res.busy) return brokerFailureReply(res, 503, 'busy');
    // Deliberately NOT echoing the body. `rolledBack` tells the operator whether the
    // environment is back on its previous credentials.
    return json(422, {
      applied: false,
      error: res.error ?? 'relink failed',
      rolledBack: res.rolledBack ?? false,
      ...(res.replacedVersions ? { replacedVersions: res.replacedVersions } : {}),
      ...(res.createdParams ? { createdParams: res.createdParams } : {}),
      /**
       * Present and false when the refusal was a webhook-secret desync: the credentials were
       * valid but GitHub's hook config could not be updated, so proceeding would have silently
       * stopped every delivery. The UI offers `allowHookDesync` from here.
       */
      ...(res.hookSynced === false ? { hookSynced: false } : {}),
      ...(res.hookError ? { hookError: res.hookError } : {}),
    });
  }
  return json(200, {
    applied: true,
    verified: res.verified === true,
    appId: res.appId,
    appSlug: res.appSlug,
    /**
     * Whether GitHub's own hook config was updated to match the stored secret/URL. False means
     * the operator must set the webhook secret at GitHub by hand — otherwise GitHub keeps
     * signing with the old value and every delivery fails its HMAC check. A relink that ROTATED
     * the secret only reaches this branch when the operator explicitly accepted that risk.
     */
    hookSynced: res.hookSynced === true,
    ...(res.hookError ? { hookError: res.hookError } : {}),
    /** Rollback handle: SSM version numbers, not values. */
    replacedVersions: res.replacedVersions ?? {},
    /** Rollback handle: parameters this relink CREATED, which a rollback must delete. */
    createdParams: res.createdParams ?? [],
  });
}

/** Restore the credential parameter versions a prior relink replaced. */
async function rollbackGithubAppRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
): Promise<Reply> {
  const denied = await requirePlatformAdmin(session);
  if (denied) return denied;

  const raw = bodyOf(event);
  if (raw === undefined) return problem(400, 'body is not valid JSON');
  const parsed = validateRollbackBody(raw);
  if (!parsed.ok) return problem(400, 'invalid rollback payload', parsed.errors);

  let res: AppcfgResult;
  try {
    res = await invokeAppcfg({
      action: 'rollback',
      actor: session.login,
      restore: parsed.value.restore,
      ...(parsed.value.remove.length ? { remove: parsed.value.remove } : {}),
    });
  } catch (err) {
    const busy = brokerBusyReply(err);
    if (busy) return busy;
    throw err;
  }
  if (!res.ok) return brokerFailureReply(res, 502, 'rollback failed');
  return json(200, {
    rolledBack: true,
    verified: res.verified === true,
    appId: res.appId,
    /**
     * Whether GitHub's hook config was re-pointed at the RESTORED webhook secret. False means
     * GitHub still signs with the relinked App's secret while Ingest verifies against the
     * restored one, so every delivery fails its HMAC check until the operator fixes it at
     * GitHub by hand.
     */
    hookSynced: res.hookSynced === true,
    ...(res.hookError ? { hookError: res.hookError } : {}),
  });
}

/**
 * Test webhook delivery: ask GitHub to re-deliver a real, signed delivery to the configured
 * URL. A success proves URL + TLS + secret agreement end to end — which a parameter-presence
 * checkmark cannot. The heartbeat row updates when the redelivered payload lands, so the UI's
 * next poll shows the round-trip completing.
 */
async function testWebhookRoute(
  session: SessionPayload,
  event: APIGatewayProxyEventV2,
): Promise<Reply> {
  const denied = await requirePlatformAdmin(session);
  if (denied) return denied;

  const raw = bodyOf(event);
  if (raw === undefined) return problem(400, 'body is not valid JSON');
  const parsed = validateWebhookTestBody(raw);
  if (!parsed.ok) return problem(400, 'invalid body', parsed.errors);

  const before = await getWebhookHeartbeat().catch(() => undefined);
  let res: AppcfgResult;
  try {
    res = await invokeAppcfg({
      action: 'redeliver',
      actor: session.login,
      ...(parsed.value.deliveryId ? { deliveryId: parsed.value.deliveryId } : {}),
    });
  } catch (err) {
    const busy = brokerBusyReply(err);
    if (busy) return busy;
    throw err;
  }
  if (!res.ok) return brokerFailureReply(res, 502, 'redelivery failed');
  return json(202, {
    requested: true,
    deliveryId: res.deliveryId,
    /** The watermark to compare against: a later `lastReceivedAt` means the round-trip landed. */
    lastReceivedAtBefore: before?.lastAt ?? null,
  });
}

/** Which flavors have a published image ARN in SSM (presence only). */
async function imageAvailability(): Promise<Record<string, boolean>> {
  const names = buildFlavorViews({}).map((f) => f.name);
  const entries = await Promise.all(
    names.map(async (n) => [n, await paramExists(`${SSM_PREFIX}/config/image-arn-${n}`)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * The catalog fields readiness reconciliation needs (ADR-051): flavor name + routing label.
 *
 * Sourced from the same catalog projection the Flavors view uses, so a flavor cannot appear in
 * one and be missing from the other.
 */
function catalogForReadiness(): ReadinessFlavor[] {
  return buildFlavorViews({}).map((f) => ({ name: f.name, label: f.label }));
}

/**
 * Just the live claim allowlist — no image probing.
 *
 * Separate from `controlPlaneSnapshot` because the two callers need different things: readiness
 * reconciliation needs both facts, while the Unclaimed screen only compares a refusal's stored
 * allowlist against the current one. Using the full snapshot there would fire one
 * `DescribeParameters` per catalog flavor on every page load to compute image presence nothing
 * renders.
 *
 * Fails soft for the same reason as the full snapshot: `live: false` degrades the comparison to
 * "unknown" instead of claiming the allowlist is empty, which would badge every refusal as
 * changed.
 *
 * UNCACHED (`ttlMs = 0`), like every other allowlist read in this handler (`settingsRoute`,
 * `putRunnerLabelsRoute`). `getParam`'s default is a 5-minute per-container cache, and the label
 * write goes through the appcfg broker, which cannot invalidate this Lambda's cache. Cached, the
 * sequence this surface exists to serve breaks: an operator reads `label-not-allowlisted` on
 * Unclaimed, adds the label in Settings, comes back — and the same warm container serves the OLD
 * list for up to five minutes, so `config changed` stays dark and the screen asserts "still
 * broken" about a fix that already landed. The word rendered beside it is `Live`.
 */
async function allowlistSnapshot(): Promise<{ allowlist: string[]; live: boolean }> {
  try {
    const raw = await getParam(`${SSM_PREFIX}/config/runner-labels`, 0);
    return { allowlist: raw.split(',').map((l) => l.trim()).filter(Boolean), live: true };
  } catch (err) {
    console.error(JSON.stringify({ msg: 'allowlist read failed', error: errMsg(err) }));
    return { allowlist: [], live: false };
  }
}

/**
 * Which flavors have a published `image-arn-<name>` parameter — or `undefined` when the check
 * could not be performed.
 *
 * `undefined` rather than `{}` on failure (ADR-051): `{}` is a positive claim that no flavor has
 * an image, which would render the whole catalog "not built" on a transient SSM error. Presence
 * only — `DescribeParameters` returns no values, so no SecureString can leak here.
 */
async function imageAvailabilityOrUndefined(): Promise<Record<string, boolean> | undefined> {
  try {
    return await imageAvailability();
  } catch (err) {
    console.error(JSON.stringify({ msg: 'image availability read failed', error: errMsg(err) }));
    return undefined;
  }
}

/**
 * Read the LIVE control plane: the claim allowlist and which flavor images are published
 * (ADR-051).
 *
 * The allowlist is read with `GetParameter`, not `DescribeParameters`: its VALUE is the thing
 * being reconciled, and it is a plain `String` parameter (an operator-managed list of runner
 * labels), never a SecureString. The Mgmt λ's grant names this one path explicitly — spec 04's
 * hard rule is that no SECRET value is readable here, not that no parameter is.
 *
 * Fails SOFT, and the two facts fail INDEPENDENTLY. `live` is the AND of both, because readiness
 * reconciliation needs both to derive a state. But the image map keeps its own liveness
 * (`undefined` = unread), so an allowlist failure cannot make the Flavors table claim every image
 * is missing — the catalog projection would otherwise report a confident "not built" for an
 * evidence-free reason. A false alarm on this surface is worse than a missing one: it is the
 * surface whose whole purpose is to be trusted when it warns.
 */
async function controlPlaneSnapshot(): Promise<ControlPlaneSnapshot> {
  const [labels, imagePublished] = await Promise.all([
    allowlistSnapshot(),
    imageAvailabilityOrUndefined(),
  ]);
  if (!labels.live || imagePublished === undefined) {
    console.error(
      JSON.stringify({
        msg: 'control-plane snapshot incomplete',
        allowlistLive: labels.live,
        imagesLive: imagePublished !== undefined,
      }),
    );
  }
  return {
    allowlist: labels.allowlist,
    imagePublished,
    live: labels.live && imagePublished !== undefined,
  };
}

/**
 * Per-flavor readiness, or `undefined` when the live read failed.
 *
 * `undefined` rather than an all-`unroutable` array on purpose: the caller must be able to tell
 * "the control plane cannot run this" from "we could not ask", and only the first is a warning.
 */
async function flavorReadinessOrUndefined(): Promise<FlavorReadiness[] | undefined> {
  const snapshot = await controlPlaneSnapshot();
  if (!snapshot.live) return undefined;
  return reconcileFlavors(catalogForReadiness(), snapshot);
}

/**
 * Unclaimed (refused) jobs — the console surface for a claim the platform declined (ADR-050).
 *
 * Authorization is the same post-query installation filter every run list uses (`collectVisible`),
 * because the refusal indexes are keyed by repo/time, not by installation.
 */
async function listRefusalsRoute(
  session: SessionPayload,
  q: Record<string, string | undefined>,
): Promise<Reply> {
  const limit = parseLimit(q.limit);
  const visible = (rows: RefusalRecord[]): RefusalRecord[] =>
    rows.filter((r) => canAdminInstallation(session, r.installationId));

  let page: { runs: RefusalRecord[]; nextCursor?: string };
  if (q.repo !== undefined) {
    const repoId = asPositiveInt(q.repo);
    if (!repoId) return problem(400, 'repo must be a numeric repo id');
    page = await collectVisible(
      async (cursor) => {
        const res = await listRefusalsByRepo(repoId, { limit, cursor });
        return { runs: res.refusals, nextCursor: res.nextCursor };
      },
      visible,
      limit,
      q.cursor,
    );
  } else {
    page = await collectVisible(
      async (cursor) => {
        const res = await listRefusals({ limit, cursor });
        return { runs: res.refusals, nextCursor: res.nextCursor };
      },
      visible,
      limit,
      q.cursor,
    );
  }

  // The live allowlist is echoed so the UI can show what it is NOW alongside what it was when
  // each job was refused: "you already fixed this, re-run the job" and "this is still broken"
  // look identical without both. Only the allowlist — image presence is not rendered here.
  const snapshot = await allowlistSnapshot();
  return json(200, {
    unclaimed: sortRefusalsNewestFirst(page.runs).map(toRefusalView),
    nextCursor: page.nextCursor ?? null,
    allowlist: snapshot.allowlist,
    controlPlaneLive: snapshot.live,
  });
}

// ---- authorization helpers -------------------------------------------------

/**
 * Resolve `{repoId}` to a repo row the session may administer. The repo row lives under an
 * installation partition, so the caller must supply `?installation=` — we then check the
 * session's installation grant. This is the single choke point for repo authorization.
 */
async function authorizeRepo(
  session: SessionPayload,
  match: RouteMatch,
  q: Record<string, string | undefined>,
): Promise<{ record: RepoRecord } | { reply: Reply }> {
  const repoId = asPositiveInt(match.params.repoId);
  if (!repoId) return { reply: problem(400, 'repoId must be numeric') };
  const installationId = asPositiveInt(q.installation);
  if (!installationId) return { reply: problem(400, 'installation query param required') };
  if (!canAdminInstallation(session, installationId)) return { reply: problem(403, 'forbidden') };
  const record = await getRepo(installationId, repoId);
  if (!record) return { reply: problem(404, 'repo not found') };
  return { record };
}

/**
 * Resolve a run row and check the session administers its installation.
 *
 * Unlike `authorizeRepo` (which checks the grant BEFORE any lookup), the grant here is
 * only checkable after reading the row — so a denial answers **404, not 403**: a 403 on a
 * guessed `{repoId}/{runId}/{jobId}` triple would confirm to a foreign (but authenticated)
 * operator that another tenant's run exists. Deny + not-found must be indistinguishable.
 */
async function authorizeRun(
  session: SessionPayload,
  match: RouteMatch,
): Promise<{ record: RunRecord } | { reply: Reply }> {
  const repoId = asPositiveInt(match.params.repoId);
  const runId = asPositiveInt(match.params.runId);
  const jobId = asPositiveInt(match.params.jobId);
  if (!repoId || !runId || !jobId) return { reply: problem(400, 'repoId/runId/jobId must be numeric') };
  return gateRunRecord(session, await getRun(repoId, runId, jobId));
}

/**
 * The pure deny/allow decision for a fetched run row (exported for tests): absent and
 * foreign rows are indistinguishable — both 404 — so run identifiers cannot be probed.
 */
export function gateRunRecord(
  session: SessionPayload,
  record: RunRecord | undefined,
): { record: RunRecord } | { reply: Reply } {
  if (!record) return { reply: problem(404, 'run not found') };
  if (!canAdminInstallation(session, record.installationId)) {
    return { reply: problem(404, 'run not found') };
  }
  return { record };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Epoch-ms query param (log tail watermark); undefined when absent or malformed. */
function asEpochMs(raw: string | undefined): number | undefined {
  return parseEpochMs(raw);
}
