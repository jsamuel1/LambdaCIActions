import {
  getAppHookConfig,
  getAppIdentity,
  listAppHookDeliveries,
  listAppInstallations,
  redeliverAppHook,
  updateAppHookConfig,
} from '../shared/github-app.js';
import { deleteParam, getParam, getParamVersion, paramVersion, putParam } from '../shared/ssm.js';
import { appendAudit, acquireConfigLock, releaseConfigLock } from '../shared/config-store.js';
import {
  APP_CREDENTIAL_PARAMS,
  SECURE_CREDENTIAL_PARAMS,
  AppcfgRequestError,
  assertNoSecrets,
  parseAppcfgRequest,
  redactLiterals,
  scrubForOperator,
  type AppLinkageView,
  type AppcfgResult,
  type AppCredentialsInput,
  type ParameterVersionSnapshot,
} from './broker-core.js';

/**
 * GitHub App config broker λ (ADR-028) — control plane.
 *
 * The Settings screen needs two things the management λ deliberately cannot do:
 *
 *   1. **Prove** the environment's GitHub App linkage (mint an App JWT → `GET /app`,
 *      `/app/installations`, `/app/hook/config`, `/app/hook/deliveries`). That requires the
 *      App PEM, which ADR-025 keeps out of the console λ's IAM policy entirely.
 *   2. **Re-link** the environment to a rotated/replacement App, which requires
 *      `ssm:PutParameter` on SecureString credential paths — internet-facing write authority
 *      over every platform secret if it lived in the console λ.
 *
 * So the authority lives here, behind one function whose only caller is the Mgmt λ
 * (`lambda:InvokeFunction` on this ARN, nothing else) — the same containment shape ADR-021
 * uses for microVMs.
 *
 * Invariant enforced in code, not just prose: **no response field can carry a secret value.**
 * Relink is write-only intake (submit credentials → get back presence + verification
 * outcome), rollback works off SSM parameter VERSION numbers (the values stay in SSM's own
 * history), and every result passes `assertNoSecrets` before it is returned.
 *
 * Env: SSM_PREFIX, TABLE_NAME, WEBHOOK_URL (the deployed receiver, for mismatch detection).
 */

const SSM_PREFIX = process.env.SSM_PREFIX ?? `/lca/${process.env.LCA_ENV ?? 'dev'}`;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? '';

const APP_ID_PARAM = `${SSM_PREFIX}/github/app-id`;
const APP_PEM_PARAM = `${SSM_PREFIX}/github/app-pem`;
const RUNNER_LABELS_PARAM = `${SSM_PREFIX}/config/runner-labels`;

/**
 * The AWS + GitHub seam, injected so the broker's decisions — verify before write, roll back
 * on failure, delete rather than orphan a parameter this attempt created, keep GitHub's hook
 * config in step with the stored secret, never return a secret — are testable without AWS
 * credentials or a live GitHub App.
 */
export interface AppcfgDeps {
  getParam: typeof getParam;
  paramVersion: typeof paramVersion;
  getParamVersion: typeof getParamVersion;
  putParam: typeof putParam;
  deleteParam: typeof deleteParam;
  appendAudit: typeof appendAudit;
  getAppIdentity: typeof getAppIdentity;
  listAppInstallations: typeof listAppInstallations;
  getAppHookConfig: typeof getAppHookConfig;
  updateAppHookConfig: typeof updateAppHookConfig;
  listAppHookDeliveries: typeof listAppHookDeliveries;
  redeliverAppHook: typeof redeliverAppHook;
  acquireConfigLock: typeof acquireConfigLock;
  releaseConfigLock: typeof releaseConfigLock;
}

const defaultDeps: AppcfgDeps = {
  getParam,
  paramVersion,
  getParamVersion,
  putParam,
  deleteParam,
  appendAudit,
  getAppIdentity,
  listAppInstallations,
  getAppHookConfig,
  updateAppHookConfig,
  listAppHookDeliveries,
  redeliverAppHook,
  acquireConfigLock,
  releaseConfigLock,
};

export function createHandler(deps: AppcfgDeps = defaultDeps) {
  return async function handle(event: unknown): Promise<AppcfgResult> {
    let req;
    try {
      req = parseAppcfgRequest(event);
    } catch (err) {
      const message = err instanceof AppcfgRequestError ? err.message : 'bad request';
      console.warn(
        JSON.stringify({ msg: 'appcfg broker rejected request', error: scrubForOperator(message) }),
      );
      return { ok: false, error: scrubForOperator(message) };
    }

    // Plaintexts THIS request carries. The shape guard cannot recognize an opaque webhook or
    // client secret, so every error string on the relink path is literal-redacted against the
    // submitted values before it is logged or returned.
    const submitted = req.credentials
      ? [req.credentials.pem, req.credentials.webhookSecret, req.credentials.clientSecret]
      : [];
    const clean = (text: string): string =>
      scrubForOperator(redactLiterals(text, submitted));

    try {
      switch (req.action) {
        case 'status':
          return finish(await statusAction(deps));
        case 'relink':
          return finish(
            await withConfigLock(deps, req.actor, () =>
              relinkAction(deps, req.credentials!, req.actor),
            ),
            submitted,
          );
        case 'rollback':
          return finish(
            await withConfigLock(deps, req.actor, () =>
              rollbackAction(deps, req.restore!, req.actor),
            ),
          );
        case 'redeliver':
          return finish(await redeliverAction(deps, req.deliveryId, req.actor));
        case 'setRunnerLabels':
          return finish(
            await withConfigLock(deps, req.actor, () =>
              setRunnerLabelsAction(deps, req.labels!, req.actor),
            ),
          );
      }
    } catch (err) {
      const detail = clean(errMsg(err));
      console.error(
        JSON.stringify({ msg: 'appcfg broker failed', action: req.action, error: detail }),
      );
      return { ok: false, error: detail };
    }
  };
}

export const handler = createHandler();

/**
 * Last gate before anything leaves the broker (see the module invariant). `submitted` carries
 * the request's known plaintexts so an opaque secret — invisible to the shape guard — cannot
 * ride out inside an error string it was quoted into.
 */
function finish(result: AppcfgResult, submitted: readonly string[] = []): AppcfgResult {
  const out = submitted.length ? redactResult(result, submitted) : result;
  if (submitted.length && containsLiteral(out, submitted)) {
    throw new Error('refusing to return a submitted credential from appcfg broker');
  }
  assertNoSecrets(out, 'appcfg broker');
  return out;
}

/**
 * Literal-redact EVERY string in a result, not just `error`. Any operator-facing field can
 * carry forwarded GitHub text — `hookError` is the live example: GitHub's 422 body quotes the
 * rejected webhook secret back, and the shape guard cannot recognize an opaque secret.
 */
function redactResult(result: AppcfgResult, submitted: readonly string[]): AppcfgResult {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactLiterals(v, submitted);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return walk(result) as AppcfgResult;
}

/** Whether a serialized result still contains any submitted plaintext verbatim. */
function containsLiteral(payload: unknown, secrets: readonly string[]): boolean {
  const json = JSON.stringify(payload ?? {});
  return secrets.some((s) => s && s.length >= 8 && json.includes(s));
}

// ---- status ----------------------------------------------------------------

/**
 * Live linkage + webhook evidence. Every sub-fetch is independently fault-tolerant: a
 * missing PEM, a revoked App, or a webhook-scope failure must degrade to a specific
 * operator-facing message, not a blank screen — "we could not verify" is itself the answer
 * the Settings screen needs to show.
 */
async function statusAction(deps: AppcfgDeps): Promise<AppcfgResult> {
  const linkage: AppLinkageView = { app: null, installations: [], webhook: null };

  let appId: string;
  let pem: string;
  try {
    // ttlMs=0: an operator hitting Settings right after a relink must not see a cached
    // pre-relink credential from this container.
    [appId, pem] = await Promise.all([
      deps.getParam(APP_ID_PARAM, 0),
      deps.getParam(APP_PEM_PARAM, 0),
    ]);
    linkage.configuredAppId = appId;
  } catch (err) {
    linkage.verifyError = `GitHub App credentials are not readable: ${scrubForOperator(errMsg(err))}`;
    return { ok: true, linkage };
  }

  try {
    const identity = await deps.getAppIdentity(appId, pem);
    linkage.app = {
      appId: identity.appId,
      name: identity.name,
      slug: identity.slug,
      htmlUrl: identity.htmlUrl,
      ownerLogin: identity.ownerLogin,
      events: identity.events,
      permissions: identity.permissions,
    };
  } catch (err) {
    linkage.verifyError = scrubForOperator(errMsg(err));
  }

  if (linkage.app) {
    // Installations come from GitHub here (not our store) so the screen shows ground truth
    // even when an `installation` webhook was missed.
    try {
      linkage.installations = await deps.listAppInstallations(appId, pem);
    } catch (err) {
      linkage.verifyError = linkage.verifyError ?? scrubForOperator(errMsg(err));
    }

    try {
      const [config, deliveries] = await Promise.all([
        deps.getAppHookConfig(appId, pem),
        deps.listAppHookDeliveries(appId, pem, 20).catch(() => []),
      ]);
      linkage.webhook = {
        configuredUrl: config.url,
        contentType: config.contentType,
        insecureSsl: config.insecureSsl,
        secretConfigured: config.secretConfigured,
        recentDeliveries: deliveries,
      };
    } catch (err) {
      // `/app/hook/config` needs the App to own its hook config; a GitHub Enterprise or
      // org-hook setup can 403/404 here. That is not a platform fault — say so.
      linkage.webhookError = scrubForOperator(errMsg(err));
    }
  }

  return { ok: true, linkage };
}

// ---- relink ---------------------------------------------------------------

/**
 * Verify-then-write. The submitted credentials are validated against GitHub BEFORE any SSM
 * write (mint an App JWT with the submitted PEM + app id, `GET /app`, list installations),
 * so a typo'd PEM can never take the environment offline.
 *
 * Two failure modes get explicit handling because both would otherwise leave the environment
 * broken in a way the operator cannot see:
 *
 *  - **Partial write.** If a later write fails we undo the earlier ones. Parameters that did
 *    not exist beforehand have no version to restore, so they are DELETED — otherwise a
 *    first-link that fails halfway strands a partial credential set and rollback reports
 *    failure.
 *  - **Webhook secret desync.** Storing a new `webhook-secret` without telling GitHub means
 *    GitHub keeps signing with the old one and Ingest rejects every delivery (401). So the
 *    App's hook config is updated at GitHub as part of the same operation.
 */
async function relinkAction(
  deps: AppcfgDeps,
  creds: AppCredentialsInput,
  actor: string,
): Promise<AppcfgResult> {
  // 1. Verify with the SUBMITTED credentials — never write on trust.
  const identity = await deps.getAppIdentity(creds.appId, creds.pem);
  if (String(identity.appId) !== creds.appId) {
    return {
      ok: false,
      error: `submitted appId ${creds.appId} does not match the App the key authenticates as (${identity.appId})`,
    };
  }
  const installations = await deps.listAppInstallations(creds.appId, creds.pem).catch(() => []);

  // 2. Snapshot current versions so a failure (or the operator) can roll back. We snapshot
  //    version NUMBERS, not values: the previous secrets stay in SSM's parameter history and
  //    are never copied into a Lambda, a log, or a DynamoDB row. Parameters that do NOT exist
  //    yet are tracked separately — they have no version to restore, only a deletion to undo.
  const before: ParameterVersionSnapshot = {};
  const absent: string[] = [];
  for (const suffix of APP_CREDENTIAL_PARAMS) {
    const v = await deps.paramVersion(`${SSM_PREFIX}/${suffix}`);
    if (v !== undefined) before[suffix] = v;
    else absent.push(suffix);
  }

  const values: Record<string, string> = {
    'github/app-id': creds.appId,
    'github/app-pem': creds.pem,
    'github/webhook-secret': creds.webhookSecret,
    'github/client-id': creds.clientId,
    'github/client-secret': creds.clientSecret,
  };

  const written: string[] = [];
  try {
    for (const suffix of APP_CREDENTIAL_PARAMS) {
      await deps.putParam(`${SSM_PREFIX}/${suffix}`, values[suffix], {
        secure: SECURE_CREDENTIAL_PARAMS.includes(suffix),
        description: `LambdaCIActions GitHub App credential (relinked by ${actor})`,
      });
      written.push(suffix);
    }
    // The App slug is convenience metadata (install URLs); not part of the atomic set.
    await deps
      .putParam(`${SSM_PREFIX}/github/app-slug`, identity.slug, { secure: false })
      .catch(() => 0);
  } catch (err) {
    const rolled = await undoWrites(deps, before, absent, written, actor, 'relink-failure').catch(
      () => false,
    );
    return {
      ok: false,
      error: `relink failed after writing ${written.length}/${APP_CREDENTIAL_PARAMS.length} parameters: ${scrubForOperator(errMsg(err))}`,
      rolledBack: rolled,
      replacedVersions: before,
    };
  }

  // 3. Post-write verification: re-read from SSM and re-verify against GitHub, so the
  //    operator's "verified" badge reflects the STORED state, not just what they pasted.
  let verified = false;
  let verifyError: string | undefined;
  try {
    const [storedId, storedPem] = await Promise.all([
      deps.getParam(APP_ID_PARAM, 0),
      deps.getParam(APP_PEM_PARAM, 0),
    ]);
    const check = await deps.getAppIdentity(storedId, storedPem);
    verified = String(check.appId) === creds.appId;
    if (!verified) verifyError = 'stored credentials authenticate as a different App';
  } catch (err) {
    verifyError = scrubForOperator(errMsg(err));
  }

  if (!verified) {
    const rolled = await undoWrites(
      deps,
      before,
      absent,
      written,
      actor,
      'relink-verify-failure',
    ).catch(() => false);
    return {
      ok: false,
      error: `relink written but post-write verification failed: ${verifyError ?? 'unknown'}`,
      rolledBack: rolled,
      replacedVersions: before,
    };
  }

  // 4. Synchronize GitHub's own hook config with what we just stored. Without this, a rotated
  //    webhook secret makes GitHub sign with the old value and every delivery fails its HMAC
  //    check — the environment goes silent while every credential badge reads green.
  let hookSynced = false;
  let hookError: string | undefined;
  try {
    await deps.updateAppHookConfig(creds.appId, creds.pem, {
      secret: creds.webhookSecret,
      ...(WEBHOOK_URL ? { url: WEBHOOK_URL } : {}),
    });
    hookSynced = true;
  } catch (err) {
    // NOT fatal, and deliberately not a rollback trigger: the credentials themselves verified,
    // and some Apps (Enterprise / org-hook setups) don't own their hook config, so the operator
    // may have to set the secret at GitHub by hand. Surfacing it is the right outcome — the
    // Settings screen's signature-rejection counter is the backstop if they are out of sync.
    hookError = scrubForOperator(errMsg(err));
  }

  await audit(deps, actor, 'github-app-relink', {
    appId: identity.appId,
    slug: identity.slug,
    installations: installations.length,
    hookSynced,
    replacedVersions: before,
  });

  return {
    ok: true,
    verified: true,
    appId: identity.appId,
    appSlug: identity.slug,
    replacedVersions: before,
    hookSynced,
    ...(hookError ? { hookError } : {}),
  };
}

/** Explicit operator-driven rollback to a previously reported version snapshot. */
async function rollbackAction(
  deps: AppcfgDeps,
  restore: ParameterVersionSnapshot,
  actor: string,
): Promise<AppcfgResult> {
  const rolled = await restoreVersions(deps, restore, actor, 'operator-rollback');
  if (!rolled) return { ok: false, error: 'rollback failed — see CloudWatch for detail' };
  let appId: number | undefined;
  let verified = false;
  try {
    const [storedId, storedPem] = await Promise.all([
      deps.getParam(APP_ID_PARAM, 0),
      deps.getParam(APP_PEM_PARAM, 0),
    ]);
    const identity = await deps.getAppIdentity(storedId, storedPem);
    appId = identity.appId;
    verified = true;
  } catch {
    verified = false;
  }
  return { ok: true, rolledBack: true, verified, ...(appId ? { appId } : {}) };
}

/**
 * Undo a failed relink's writes.
 *
 * Two cases, and both matter: a parameter that EXISTED gets its prior version re-put, while a
 * parameter this attempt CREATED is deleted (there is no version to go back to). Without the
 * second case a half-completed first-link leaves an orphaned partial credential set in SSM and
 * reports rollback failure — the verify→write→rollback contract has to hold on a fresh
 * environment too.
 */
async function undoWrites(
  deps: AppcfgDeps,
  before: ParameterVersionSnapshot,
  absent: string[],
  written: string[],
  actor: string,
  reason: string,
): Promise<boolean> {
  const toRestore = pick(before, written);
  const toDelete = written.filter((s) => absent.includes(s));
  if (!Object.keys(toRestore).length && !toDelete.length) return false;

  let ok = true;
  for (const [suffix, version] of Object.entries(toRestore)) {
    const name = `${SSM_PREFIX}/${suffix}`;
    try {
      const value = await deps.getParamVersion(name, version);
      await deps.putParam(name, value, {
        secure: SECURE_CREDENTIAL_PARAMS.includes(suffix),
        description: `LambdaCIActions GitHub App credential (restored v${version} by ${actor})`,
      });
    } catch (err) {
      ok = false;
      console.error(
        JSON.stringify({
          msg: 'rollback restore failed',
          param: suffix,
          error: scrubForOperator(errMsg(err)),
        }),
      );
    }
  }
  for (const suffix of toDelete) {
    try {
      await deps.deleteParam(`${SSM_PREFIX}/${suffix}`);
    } catch (err) {
      ok = false;
      console.error(
        JSON.stringify({
          msg: 'rollback delete failed',
          param: suffix,
          error: scrubForOperator(errMsg(err)),
        }),
      );
    }
  }
  await audit(deps, actor, 'github-app-rollback', {
    reason,
    restored: toRestore,
    removed: toDelete,
    complete: ok,
  });
  return ok;
}

/**
 * Re-put the exact prior versions of each parameter. Reads `Name:version` from SSM's own
 * history — the only place the previous values exist. Used by the operator-driven rollback,
 * which by definition targets versions that existed.
 */
async function restoreVersions(
  deps: AppcfgDeps,
  snapshot: ParameterVersionSnapshot,
  actor: string,
  reason: string,
): Promise<boolean> {
  const entries = Object.entries(snapshot);
  if (!entries.length) return false;
  for (const [suffix, version] of entries) {
    const name = `${SSM_PREFIX}/${suffix}`;
    const value = await deps.getParamVersion(name, version);
    await deps.putParam(name, value, {
      secure: SECURE_CREDENTIAL_PARAMS.includes(suffix),
      description: `LambdaCIActions GitHub App credential (restored v${version} by ${actor})`,
    });
  }
  await audit(deps, actor, 'github-app-rollback', { reason, restored: snapshot });
  return true;
}

// ---- runner labels --------------------------------------------------------

/**
 * Write the environment's claim list. Lives here (not in the Mgmt λ) because the console
 * holds NO `ssm:PutParameter` grant at all — concentrating config-write authority in one
 * control-plane function keeps the internet-facing surface read-mostly (ADR-025/028), and
 * ADR-027 explicitly rejected letting the management plane mutate runner-label config.
 *
 * `runner-labels` is a plain String, not a SecureString: the labels are public by nature
 * (they appear in every workflow file). It is scoped separately from the credential paths in
 * IAM for exactly that reason.
 */
async function setRunnerLabelsAction(
  deps: AppcfgDeps,
  labels: string,
  actor: string,
): Promise<AppcfgResult> {
  const before = await deps.getParam(RUNNER_LABELS_PARAM, 0).catch(() => '');
  await deps.putParam(RUNNER_LABELS_PARAM, labels, {
    secure: false,
    description: `LambdaCIActions claimed runner labels (set by ${actor})`,
  });
  await audit(deps, actor, 'runner-labels-change', { from: before, to: labels });
  return { ok: true, labels: labels.split(',').filter(Boolean) };
}

// ---- webhook test ---------------------------------------------------------

/**
 * Ask GitHub to re-deliver a delivery. A successful redelivery is a REAL round-trip: GitHub
 * signs the payload with the configured webhook secret and posts it to the configured URL,
 * so it exercises URL, TLS and secret agreement in one shot — unlike a checkmark that only
 * means "a parameter exists".
 */
async function redeliverAction(
  deps: AppcfgDeps,
  deliveryId: number | undefined,
  actor: string,
): Promise<AppcfgResult> {
  const [appId, pem] = await Promise.all([
    deps.getParam(APP_ID_PARAM, 0),
    deps.getParam(APP_PEM_PARAM, 0),
  ]);
  let id = deliveryId;
  if (id === undefined) {
    const recent = await deps.listAppHookDeliveries(appId, pem, 1);
    if (!recent.length) {
      return {
        ok: false,
        error:
          'GitHub has no recorded deliveries for this App yet — nothing to re-deliver. ' +
          'Trigger any workflow (or re-install the App) to produce a first delivery.',
      };
    }
    id = recent[0].id;
  }
  await deps.redeliverAppHook(appId, pem, id);
  await audit(deps, actor, 'webhook-redeliver', { deliveryId: id, target: WEBHOOK_URL });
  return { ok: true, redelivered: true, deliveryId: id };
}

// ---- helpers --------------------------------------------------------------

/**
 * Run a MUTATING action under the platform config lock.
 *
 * Only the writes are serialized. `status` (which the Settings screen polls) deliberately runs
 * unlocked and concurrently — gating reads behind the same mutual exclusion would let two
 * operators with Settings open block each other, and a stale read is harmless where a mixed
 * credential set is not.
 */
async function withConfigLock(
  deps: AppcfgDeps,
  actor: string,
  fn: () => Promise<AppcfgResult>,
): Promise<AppcfgResult> {
  const holder = `${actor}:${Date.now()}`;
  let held = false;
  try {
    held = await deps.acquireConfigLock(holder);
  } catch (err) {
    // A lock-store fault must not silently drop the mutex and allow interleaved credential
    // writes; refuse instead.
    return {
      ok: false,
      error: `could not acquire the platform config lock: ${scrubForOperator(errMsg(err))}`,
    };
  }
  if (!held) {
    return {
      ok: false,
      error: 'another platform configuration change is in progress — retry in a moment',
    };
  }
  try {
    return await fn();
  } finally {
    await deps.releaseConfigLock(holder).catch((err) =>
      console.error(
        JSON.stringify({ msg: 'config lock release failed', error: scrubForOperator(errMsg(err)) }),
      ),
    );
  }
}

/** Audit rows are operator-facing text; scrub + assert before persisting. */
async function audit(
  deps: AppcfgDeps,
  actor: string,
  action: string,
  detail: unknown,
): Promise<void> {
  assertNoSecrets(detail, `audit(${action})`);
  const text = scrubForOperator(JSON.stringify(detail ?? {}));
  console.log(JSON.stringify({ msg: 'platform config changed', actor, action, detail: text }));
  await deps
    .appendAudit({ at: new Date().toISOString(), actor, action, detail: text })
    .catch((err) => {
      console.error(
        JSON.stringify({
          msg: 'audit write failed',
          action,
          error: scrubForOperator(errMsg(err)),
        }),
      );
    });
}

function pick(snapshot: ParameterVersionSnapshot, keys: string[]): ParameterVersionSnapshot {
  const out: ParameterVersionSnapshot = {};
  for (const k of keys) if (snapshot[k] !== undefined) out[k] = snapshot[k];
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
