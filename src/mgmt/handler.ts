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
  toWorkflowView,
  type AppInstallationView,
  type LabelImpactView,
  type SettingsView,
  type WebhookDeliveryView,
} from './views.js';
import {
  HOSTED_LABELS,
  parseLimit,
  parseEpochMs,
  parseRunnerLabels,
  serializeRunnerLabels,
  validateFlavorMap,
  validateRelinkBody,
  validateRepoPatch,
  validateRollbackBody,
  validateRunnerLabels,
  validateWebhookTestBody,
} from './validate.js';
import { collectVisible } from './paging.js';
import { fetchRunLogs } from './logs.js';
import {
  countRunsByStatus,
  getRun,
  listRunsByRepo,
  listRunsByStatusPaged,
} from '../shared/run-store.js';
import {
  getRepo,
  listInstallations,
  listRepos,
  patchRepoConfig,
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
import type { RepoRecord, RunRecord, RunStatus, WorkflowAnalysisRecord } from '../shared/types.js';
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
/** The webhook receiver this deployment exposes, for configured-vs-deployed comparison. */
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? '';
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
      const all = await listInstallations();
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
      const parsed = validateRepoPatch(raw);
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
      return json(200, { repo: toRepoView(updated) });
    }

    case 'listWorkflows': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      const analyses = await listWorkflowAnalyses(repo.record.repoId);
      return json(200, {
        repo: toRepoView(repo.record),
        compat: rollupCompat(analyses),
        workflows: analyses.map(toWorkflowView),
      });
    }

    case 'rescanRepo': {
      const repo = await authorizeRepo(session, match, q);
      if ('reply' in repo) return repo.reply;
      if (!DISCOVERY_QUEUE_URL) return problem(503, 'discovery queue not configured');
      const [owner, name] = repo.record.repoFullName.split('/');
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: DISCOVERY_QUEUE_URL,
          MessageBody: JSON.stringify({
            installationId: repo.record.installationId,
            repoId: repo.record.repoId,
            repoFullName: repo.record.repoFullName,
            owner,
            repo: name,
            reason: 'manual',
          }),
        }),
      );
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
      const parsed = validateFlavorMap(body.flavorMap ?? raw);
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

    case 'listRuns':
      return listRunsRoute(session, q);

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
        pending: page.pending,
        events: page.events,
        nextToken: page.nextToken ?? null,
      });
    }

    case 'listFlavors':
      return json(200, { flavors: buildFlavorViews(await imageAvailability()) });

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
  const visible = (runs: RunRecord[]): RunRecord[] =>
    runs.filter((r) => canAdminInstallation(session, r.installationId));

  if (q.repo !== undefined) {
    const repoId = asPositiveInt(q.repo);
    if (!repoId) return problem(400, 'repo must be a numeric repo id');
    const page = await collectVisible(
      (cursor) => listRunsByRepo(repoId, { limit, cursor }),
      visible,
      limit,
      q.cursor,
    );
    return json(200, { runs: page.runs.map(toRunView), nextCursor: page.nextCursor ?? null });
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
    return json(200, { runs: page.runs.map(toRunView), nextCursor: page.nextCursor ?? null });
  }
  const pages = await Promise.all(
    ALL_STATUSES.map((s) => listRunsByStatusPaged(s, { limit })),
  );
  const merged = sortRunsNewestFirst(visible(pages.flatMap((p) => p.runs))).slice(0, limit);
  // A merged multi-index view has no single coherent cursor — the client narrows by
  // status or repo to paginate deeper.
  return json(200, { runs: merged.map(toRunView), nextCursor: null });
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
  return json(200, { ...buildHealth(counts, active), countsExact: exact });
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
      listInstallations().catch(() => []),
      getWebhookHeartbeat().catch(() => undefined),
      listAudit(10).catch(() => []),
      appLinkage(),
      imageAvailability(),
    ]);

  const labels = parseRunnerLabels(labelsRaw);
  const knownIds = new Set(storedInstalls.map((i) => i.installationId));

  // Installations come from GitHub when the linkage verified (ground truth even if an
  // `installation` webhook was missed); fall back to our store when it didn't.
  const installations: AppInstallationView[] = linkage?.installations?.length
    ? linkage.installations.map((i) => ({
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        suspended: i.suspended,
        known: knownIds.has(i.installationId),
      }))
    : storedInstalls
        .filter((i) => !i.deleted)
        .map((i) => ({
          installationId: i.installationId,
          accountLogin: i.accountLogin,
          suspended: i.suspended,
          known: true,
        }));

  const deliveries: WebhookDeliveryView[] = linkage?.webhook?.recentDeliveries ?? [];
  const view: SettingsView = {
    envName: ENV_NAME,
    region: process.env.AWS_REGION ?? '',
    app: linkage?.app ?? null,
    ...(linkage?.verifyError ? { appVerifyError: linkage.verifyError } : {}),
    ...(linkage?.configuredAppId ? { configuredAppId: linkage.configuredAppId } : {}),
    installations,
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
  });
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
  const impact = await labelImpact(current, parsed.value.labels);

  if (parsed.value.dryRun) {
    return json(200, { dryRun: true, applied: false, labels: current, impact });
  }

  // The Mgmt λ has no PutParameter grant at all (ADR-025/028) — the broker owns config writes.
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
        (impact.truncated ? ' (impact scan truncated)' : ''),
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

async function labelImpact(current: string[], proposed: string[]): Promise<LabelImpactView> {
  const installs = await listInstallations().catch(() => []);
  const repos = await collectImpactRepos(installs, (id) => listRepos(id));
  const truncated = repos.length > MAX_IMPACT_REPOS;
  const scanned = repos.slice(0, MAX_IMPACT_REPOS);
  const withAnalyses = await Promise.all(
    scanned.map(async (r) => ({
      ...r,
      analyses: (await listWorkflowAnalyses(r.repoId).catch(() => [])) as WorkflowAnalysisRecord[],
    })),
  );
  return buildLabelImpact(current, proposed, withAnalyses, truncated);
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
