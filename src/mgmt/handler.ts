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
  grantedInstallationIds,
  decodeSession,
  encodeSession,
  parseCookies,
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
  rollupCompat,
  sortRunsNewestFirst,
  toRepoView,
  toRunView,
  toSecretStatus,
  toWorkflowView,
  type SettingsView,
} from './views.js';
import { parseLimit, parseEpochMs, validateFlavorMap, validateRepoPatch } from './validate.js';
import { planPreviewFromAnalyses } from './rewrite.js';
import { collectVisible } from './paging.js';
import { mergedResponseComplete, repoResponseComplete } from './run-rollup.js';
import {
  METRIC_CATALOG,
  CHART_TYPES,
  DIMENSIONS,
  RANGE_PRESETS,
  MAX_RANGE_DAYS,
  applyFilters,
  computeReport,
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
  getRepo,
  listInstallations,
  listRepos,
  patchRepoConfig,
} from '../shared/install-store.js';
import { listWorkflowAnalyses } from '../shared/workflow-store.js';
import { getParam, paramExists } from '../shared/ssm.js';
import {
  OAUTH_AUTHORIZE_URL,
  exchangeOauthCode,
  getOauthUser,
  listUserInstallations,
} from '../shared/github-app.js';
import type { RepoRecord, RewriteRequest, RunRecord, RunStatus } from '../shared/types.js';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

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
/**
 * Rows per terminal status folded into the Dashboard's rolling cost estimate. The Dashboard
 * polls `/api/health` every 5 s, so this is a deliberate ceiling on read amplification, not
 * an attempt at a complete billing window.
 */
const COST_SAMPLE_PER_STATUS = 50;
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
    // Never echo internals to the browser; the detail goes to CloudWatch.
    console.error(
      JSON.stringify({ msg: 'mgmt request failed', route: route.id, path, error: errMsg(err) }),
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
      return settingsRoute();

    case 'reportCatalog':
      return json(200, {
        metrics: METRIC_CATALOG,
        dimensions: DIMENSIONS,
        charts: CHART_TYPES,
        presets: RANGE_PRESETS,
        maxRangeDays: MAX_RANGE_DAYS,
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
  return json(200, { ...buildHealth(counts, active, new Date(), costRuns), countsExact: exact });
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
  const rows = toExportRows(applyFilters(fetched.runs, spec), now);
  const stamp = now.toISOString().slice(0, 10);
  const filename = `lca-${spec.metric}-${stamp}`;
  if ((q.format ?? 'csv') === 'json') {
    return json(200, { rows, complete: fetched.complete }, {
      headers: { 'Content-Disposition': `attachment; filename="${filename}.json"` },
    });
  }
  return {
    statusCode: 200,
    raw: toCsv(rows),
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
      // A CSV body has nowhere to put the `complete` flag the JSON export carries, so a
      // truncated fan-out would hand the operator a silently short file. State it in a header
      // (and in the UI beside the download link) rather than letting the row count imply a
      // total it is not.
      'X-Report-Complete': String(fetched.complete),
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
 * executed by the SAME deterministic code path as the manual picker or refused. Nothing it
 * returns is evaluated or rendered, and it cannot influence which repos are read.
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
  const report = await executeReport(session, proposal.spec);
  return json(200, { ...report, source: { kind: 'model', modelId: proposal.modelId } });
}

/**
 * Settings: presence/health of the SSM parameters the platform depends on. Values are
 * NEVER read here — `paramExists` uses DescribeParameters (spec 04 hard rule).
 */
async function settingsRoute(): Promise<Reply> {
  const checks: { param: string; label: string }[] = [
    { param: `${SSM_PREFIX}/github/app-id`, label: 'GitHub App ID' },
    { param: `${SSM_PREFIX}/github/app-pem`, label: 'GitHub App private key' },
    { param: `${SSM_PREFIX}/github/webhook-secret`, label: 'Webhook secret' },
    { param: `${SSM_PREFIX}/github/client-id`, label: 'OAuth client ID' },
    { param: `${SSM_PREFIX}/github/client-secret`, label: 'OAuth client secret' },
    { param: `${SSM_PREFIX}/mgmt/session-secret`, label: 'Console session key' },
    { param: `${SSM_PREFIX}/config/runner-labels`, label: 'Runner labels' },
    { param: `${SSM_PREFIX}/config/table-name`, label: 'Run table name' },
  ];
  const secrets = await Promise.all(
    checks.map(async (c) => toSecretStatus(c.param, c.label, await paramExists(c.param))),
  );
  const view: SettingsView = {
    envName: ENV_NAME,
    region: process.env.AWS_REGION ?? '',
    secrets,
    flavors: buildFlavorViews(await imageAvailability()),
  };
  return json(200, view);
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
