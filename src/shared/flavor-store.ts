import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { installPk } from './install-store.js';
import {
  builtinCollision,
  customFlavorBaseNameError,
  customFlavorLabel,
  customFlavorName,
  type CatalogFlavor,
} from './flavor-catalog.js';

/**
 * Custom-flavor store (ADR-040) + the validation state machine (ADR-041).
 *
 * Storage shares the installation partition that already holds `INSTALL` + `REPO#<repoId>`
 * (ADR-009), so a custom flavor is enumerable with the same `begins_with` query and
 * per-installation scoping falls out of the KEY rather than needing an authorization filter:
 *
 *   PK=`INSTALL#<installationId>`  SK=`FLAVOR#custom-<base>`   → a custom flavor
 *
 * A custom flavor is therefore visible only to its own installation — a cross-tenant read is
 * not "denied", it is unaddressable.
 *
 * The pure parts (key helpers, the state machine, record→catalog projection) are exported
 * separately from the I/O so ADR-041's routability rule is unit-testable without DynamoDB.
 */

const client = DynamoDBClient ? new DynamoDBClient({}) : undefined;
/**
 * `removeUndefinedValues` is load-bearing here, not a convenience.
 *
 * The validation evidence map is assembled from OBSERVATIONS, and an observation that was never
 * made is `undefined` — a run whose job never concluded has no `workflowConclusion`. Without this
 * option the document client REFUSES the whole write ("Pass options.removeUndefinedValues=true"),
 * and because the refusal happens inside the verdict write it also defeats the orchestrator's
 * `pending` fallback: the row is then stranded in `validating` until the reconciliation sweep
 * releases it a lease later (before the sweep existed, only a manual re-validate could). Observed
 * live on 2026-08-20 against `custom-brokenagent`. Dropping an
 * absent observation is exactly the intended encoding — the field is optional on
 * {@link FlavorValidationEvidence} — whereas failing the write loses the verdict entirely.
 */
const doc = client
  ? DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })
  : undefined;
const TABLE = process.env.TABLE_NAME;

// ---- pure key helpers ------------------------------------------------------

/** `FLAVOR#<name>` — `name` is already namespaced `custom-<base>`. */
export function flavorSk(name: string): string {
  return `FLAVOR#${name}`;
}

/** The `begins_with` prefix that enumerates an installation's custom flavors. */
export const FLAVOR_SK_PREFIX = 'FLAVOR#';

/**
 * Max custom flavors one installation may register.
 *
 * This bound is what makes the single-page `listCustomFlavors` query below CORRECT rather than
 * merely adequate. Every consumer of that read is a safety gate — the ingest claim allowlist,
 * provision routing, config validation — and a silently truncated page would drop a `valid`
 * flavor's label, leaving its jobs unclaimed with no actionable error. Rather than paginate a
 * read that should never need it (and thereby make the truncation *invisible* instead of
 * *impossible*), registration refuses past this cap: 64 rows of a few hundred bytes each cannot
 * approach DynamoDB's 1 MiB page, so one page is provably the whole set.
 *
 * 64 is also a real product bound, not just a technical one. A custom flavor is an operator-built
 * microVM image; an installation with dozens already has an image-sprawl problem, and each one
 * carries a validation smoke run against microVM quota.
 *
 * The count-then-write is not atomic, so simultaneous registrations can land a few rows over the
 * cap. That is deliberate and harmless: the cap exists to keep the row count orders of magnitude
 * below the page limit, and a conditional counter would serialize every registration to make the
 * boundary exact at a number nobody is near.
 */
export const MAX_CUSTOM_FLAVORS_PER_INSTALLATION = 64;

/**
 * Max length of the stored `reason`.
 *
 * The last variable-length field on the row that is not already bounded by the registration
 * validator. A reason is normally ours (a static-gate failure list, a smoke verdict), but it can
 * embed an AWS error message of unbounded length — and an unbounded field breaks the same
 * single-page invariant {@link MAX_CUSTOM_FLAVORS_PER_INSTALLATION} exists to guarantee. Truncated
 * rather than refused: a verdict must always be recordable, and a clipped explanation is strictly
 * better than a write that fails and leaves the flavor stuck in `validating`.
 */
export const MAX_FLAVOR_REASON_LENGTH = 1024;

/**
 * GSI1 partition holding every flavor row with OUTSTANDING recovery work (ADR-041), keyed by the
 * time that work falls due. Two kinds of row live here:
 *
 * - a LIVE smoke-run claim (`validating`), due at its lease expiry. {@link claimFlavorValidation}
 *   writes it; every write that leaves `validating` without scheduling a restart removes it.
 * - a RETRIGGER marker (`pending` + `retriggerToken`), due when the sweep should next try to start
 *   validation again. {@link releaseExpiredFlavorClaim} writes it in the SAME conditional write
 *   that releases an expired claim, so there is no instant at which the row is neither claimed nor
 *   scheduled for a restart. It is removed only by the next claim (the restart actually began), by
 *   an operator transition or repoint, or by the sweep giving up with an operator-facing reason.
 *
 * Sparse, and its own partition-key namespace, disjoint from `RUNSTATUS#`/`INSTALLS`/`REFUSALS`, so
 * no other GSI1 reader can see these rows.
 *
 * It exists for one reader: the reconciliation sweep ({@link listDueFlavorRecoveries}). A lease
 * only makes a stranded row ELIGIBLE for takeover, and an async invoke can fail or be dropped; the
 * index is the durable record that recovery is still owed. Without it that enumeration is a scan.
 */
export const FLAVOR_CLAIMS_GSI1PK = 'FLAVORCLAIMS';

/**
 * The claim index's sort key: the lease expiry, zero-padded so lexicographic order IS numeric order
 * (GSI1's sort key is a string). 16 digits covers every epoch-ms value this side of year 2286.
 */
export function flavorClaimGsi1sk(leaseUntilMs: number): string {
  return String(Math.max(0, Math.floor(leaseUntilMs))).padStart(16, '0');
}

/**
 * How many times the sweep may automatically re-trigger validation for one flavor before it stops
 * and waits for an operator.
 *
 * A claim only expires when its run wrote neither a verdict nor a release — DynamoDB unreachable
 * for the whole budget, or the λ killed outright. The second can repeat deterministically (a
 * container that is OOM-killed at the same step every time), and each attempt launches a microVM.
 * An uncapped re-trigger would turn that into a smoke VM every sweep interval, forever. The counter
 * is reset by a terminal verdict and by an image repoint (a new artifact).
 */
export const MAX_FLAVOR_AUTO_RECOVERIES = 3;

/**
 * How many times the sweep may SEND the restart for one retrigger marker before giving up.
 *
 * Distinct from {@link MAX_FLAVOR_AUTO_RECOVERIES}: that caps runs that claimed and then died (each
 * one a microVM); this caps invokes that were accepted but never produced a claim at all (the event
 * was dropped, or the λ fails before its claim on every attempt). A send that is REFUSED is not
 * counted — the marker is re-armed for the next tick, so a Lambda API outage delays recovery rather
 * than abandoning it.
 */
export const MAX_FLAVOR_RETRIGGER_SENDS = 3;

/**
 * How long after a send its marker falls due again. Must comfortably exceed the time for an
 * accepted async invoke to reach the smoke λ and claim the row: with reserved concurrency 1 a queued
 * event can wait out a whole in-flight run (12-minute timeout). A send that fires again early is
 * harmless — the restarted run's claim is a CAS, so a duplicate finds the row claimed and exits —
 * but it is a wasted invoke.
 */
export const FLAVOR_RETRIGGER_BACKOFF_MS = 15 * 60_000;

/** Clip a reason to {@link MAX_FLAVOR_REASON_LENGTH} characters, marking that it was cut. */
export function clampReason(reason: string): string {
  return reason.length <= MAX_FLAVOR_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_FLAVOR_REASON_LENGTH - 1)}…`;
}

// ---- validation state machine (ADR-041) ------------------------------------

/**
 * `pending → validating → valid | invalid(reason)`.
 *
 * `invalid` is TERMINAL by design: a deterministically broken image (the ADR-019/020 `docker`
 * case — built fine, published its ARN, routed correctly, failed every job) must not loop on
 * microVM quota. Leaving it is an explicit operator act — a manual re-validate, or a new image
 * ARN, both of which route through `pending`.
 */
export type FlavorValidationState = 'pending' | 'validating' | 'valid' | 'invalid';

export const FLAVOR_VALIDATION_STATES: readonly FlavorValidationState[] = [
  'pending',
  'validating',
  'valid',
  'invalid',
];

/**
 * Legal state transitions. Pure so the whole machine is testable.
 *
 * - `pending → validating`      a validation run started.
 * - `validating → valid|invalid` a validation run finished.
 * - `validating → pending`      the run was abandoned (λ timeout / crash) and is retryable.
 * - `valid|invalid → pending`   re-validation: a new image ARN, or a manual re-validate.
 * - `pending → pending`         idempotent re-request (queueing twice is not an error).
 *
 * Deliberately ABSENT: `valid → validating` and `invalid → validating`. A re-validation must
 * pass through `pending` so the record stops being routable the moment its evidence is
 * withdrawn. Allowing a direct hop would leave a flavor advertised as `valid` — and therefore
 * routable — while the run that might invalidate it was still in flight.
 */
export function canTransitionValidation(
  from: FlavorValidationState,
  to: FlavorValidationState,
): boolean {
  if (from === to) return to === 'pending';
  switch (from) {
    case 'pending':
      return to === 'validating';
    case 'validating':
      return to === 'valid' || to === 'invalid' || to === 'pending';
    case 'valid':
    case 'invalid':
      return to === 'pending';
    default:
      return false;
  }
}

/** Whether a flavor in this state may be routed to / selected in config (ADR-041). */
export function isRoutableState(state: FlavorValidationState | undefined): boolean {
  return state === 'valid';
}

// ---- record ----------------------------------------------------------------

/** Evidence captured by a validation run — what was actually observed, not a claim. */
export interface FlavorValidationEvidence {
  /** The image ARN the run validated. Re-validation is triggered when this changes. */
  imageArn?: string;
  /** microVM id launched by the smoke run (control-plane observed). */
  microvmId?: string;
  /** GitHub runner id that registered with the smoke nonce label (control-plane observed). */
  runnerId?: number;
  /** The smoke workflow run GitHub executed, and its conclusion. */
  workflowRunId?: number;
  workflowConclusion?: string;
  /** True when the VM was gone from ListMicrovms within the smoke deadline (self-terminate). */
  selfTerminated?: boolean;
  /** ISO timestamps bounding the run, for the console's progress display. */
  startedAt?: string;
  finishedAt?: string;
}

export interface CustomFlavorRecord {
  pk: string;
  sk: string;
  entity: 'FLAVOR';
  installationId: number;
  /** `custom-<base>`. */
  name: string;
  /** The operator-chosen part, without the namespace prefix. */
  base: string;
  /** `lambda-ci-custom-<base>`. */
  label: string;
  /** Always `arm64` — microVMs are Graviton-only (AGENTS.md hard rule, ADR-007). */
  arch: string;
  /** DESCRIPTIVE only (ADR-038). */
  vcpu: number;
  /** Requested as `--resources minimumMemoryInMiB` (ADR-038). */
  memoryMb: number;
  capabilities: string[];
  description: string;
  /** The operator's own microVM image ARN. */
  imageArn: string;
  /** Repo the smoke run registers its throwaway runner against (ADR-041). */
  smokeRepoFullName?: string;
  /** Path of the operator-supplied smoke workflow (`workflow_dispatch`). */
  smokeWorkflowPath?: string;
  state: FlavorValidationState;
  /** Operator-facing reason for `invalid` (and progress detail while `validating`). */
  reason?: string;
  evidence?: FlavorValidationEvidence;
  /**
   * Ownership token of the smoke run holding `validating` (ADR-041). Set by
   * {@link claimFlavorValidation}, required by the run's own verdict and release, and removed on
   * every transition out of `validating` — so a write from an EARLIER run can never land on a later
   * run's claim.
   */
  validationRunId?: string;
  /** Epoch ms after which a `validating` claim may be taken over (its λ is provably gone). */
  validationLeaseUntil?: number;
  /**
   * How many times the reconciliation sweep has released an expired claim on this row with no
   * verdict in between (ADR-041). Incremented only by {@link releaseExpiredFlavorClaim}, removed by
   * every other transition; caps automatic re-triggering at {@link MAX_FLAVOR_AUTO_RECOVERIES}.
   */
  autoRecoveries?: number;
  /**
   * Present while the reconciliation sweep still owes this row an automatic restart (ADR-041): set
   * by {@link releaseExpiredFlavorClaim}, required by every later sweep write about that restart,
   * and removed by the next claim, every transition and every repoint. See
   * {@link FLAVOR_CLAIMS_GSI1PK}.
   */
  retriggerToken?: string;
  /** Accepted sends of the current restart (see {@link MAX_FLAVOR_RETRIGGER_SENDS}). */
  retriggerAttempts?: number;
  /**
   * Monotonic row revision (ADR-041). Absent on a freshly registered row (read as 0) and bumped by
   * EVERY later write — claim, verdict, release, operator re-validate, image repoint, fence. A claim
   * is conditional on the revision it READ, so it can only land on the exact row state its run
   * inspected: any intervening write, including a fence by a run whose own claim did not answer,
   * makes it fail. Because the value only ever grows, a claim that was refused once can never become
   * admissible again.
   */
  rev?: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/**
 * Project a stored record into the shape the routing/pricing/compat layers consume.
 *
 * `custom: true` is stamped here rather than inferred downstream so no consumer has to
 * string-match the name prefix to know a flavor is operator-supplied.
 */
export function toCatalogFlavor(rec: CustomFlavorRecord): CatalogFlavor {
  return {
    name: rec.name,
    label: rec.label,
    arch: rec.arch,
    vcpu: rec.vcpu,
    memoryMb: rec.memoryMb,
    capabilities: rec.capabilities ?? [],
    description: rec.description,
    custom: true,
    installationId: rec.installationId,
  };
}

/**
 * The subset of an installation's custom flavors that may be ROUTED TO (ADR-041).
 *
 * This is the enforcement point the ADR calls for: everything downstream composes from this,
 * so a `pending` / `validating` / `invalid` flavor cannot become routable by any other path.
 */
export function routableCustomFlavors(
  records: readonly CustomFlavorRecord[],
): CatalogFlavor[] {
  return records.filter((r) => isRoutableState(r.state)).map(toCatalogFlavor);
}

// ---- registration input ----------------------------------------------------

export interface RegisterFlavorInput {
  installationId: number;
  /** Operator-chosen base name; the `custom-` prefix is added here, never by the caller. */
  base: string;
  vcpu: number;
  memoryMb: number;
  capabilities: string[];
  description: string;
  imageArn: string;
  smokeRepoFullName?: string;
  smokeWorkflowPath?: string;
  actor?: string;
}

/**
 * Build the record a registration writes. Pure, so the namespacing + collision rules are
 * testable without DynamoDB.
 *
 * Throws {@link InvalidFlavorError} on a name that is malformed or collides with a built-in —
 * ADR-040 requires the collision to be refused at REGISTRATION rather than resolved by precedence
 * at routing time, so an operator cannot redefine what `lambda-ci-node` means for their jobs.
 */
export function buildFlavorRecord(
  input: RegisterFlavorInput,
  now: Date = new Date(),
): CustomFlavorRecord {
  const nameError = customFlavorBaseNameError(input.base);
  if (nameError) throw new InvalidFlavorError(nameError);
  const name = customFlavorName(input.base);
  const label = customFlavorLabel(input.base);
  const collision = builtinCollision(name, label);
  if (collision) {
    throw new InvalidFlavorError(
      `custom flavor ${collision.field} collides with built-in flavor '${collision.collidesWith}'`,
    );
  }
  const iso = now.toISOString();
  return {
    pk: installPk(input.installationId),
    sk: flavorSk(name),
    entity: 'FLAVOR',
    installationId: input.installationId,
    name,
    base: input.base,
    label,
    // Not operator-settable: microVMs are Graviton-only, and an `arch` field the operator could
    // set to `x86_64` would be a value the static gate then has to reject. Fixing it here means
    // the only way to fail the arch gate is a record written before this constraint existed.
    arch: 'arm64',
    vcpu: input.vcpu,
    memoryMb: input.memoryMb,
    capabilities: [...input.capabilities],
    description: input.description,
    imageArn: input.imageArn,
    ...(input.smokeRepoFullName ? { smokeRepoFullName: input.smokeRepoFullName } : {}),
    ...(input.smokeWorkflowPath ? { smokeWorkflowPath: input.smokeWorkflowPath } : {}),
    // Registration is never born `valid` (ADR-041): a brand-new flavor has no evidence.
    state: 'pending',
    createdAt: iso,
    updatedAt: iso,
    ...(input.actor ? { createdBy: input.actor, updatedBy: input.actor } : {}),
  };
}

// ---- operations ------------------------------------------------------------

function requireDoc(): DynamoDBDocumentClient {
  if (!doc || !TABLE) {
    throw new Error('flavor-store not configured: TABLE_NAME env + DynamoDB SDK required');
  }
  return doc;
}

/** Raised when a name is already registered for this installation. */
export class FlavorExistsError extends Error {
  constructor(name: string) {
    super(`custom flavor '${name}' already exists for this installation`);
    this.name = 'FlavorExistsError';
  }
}

/**
 * Raised when the SUBMITTED flavor is unacceptable: a malformed base name, or a derived
 * name/label that collides with a built-in (ADR-040).
 *
 * Typed rather than left for the caller to recognize by message text. The API has to map this to
 * 400 and an infrastructure fault to 500, and a regex over `err.message` cannot tell them apart:
 * a DynamoDB `ValidationException` mentioning an attribute "name" would be reported to the operator
 * as invalid input, hiding a real fault behind a wrong diagnosis.
 */
export class InvalidFlavorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFlavorError';
  }
}

/** Raised when the installation already holds {@link MAX_CUSTOM_FLAVORS_PER_INSTALLATION}. */
export class TooManyFlavorsError extends Error {
  constructor(limit: number) {
    super(`installation already has the maximum of ${limit} custom flavors`);
    this.name = 'TooManyFlavorsError';
  }
}

/**
 * Register a custom flavor. Conditional on the row NOT existing, so a double-submit is a
 * refusal rather than a silent overwrite of an already-validated flavor's evidence.
 *
 * Enforces {@link MAX_CUSTOM_FLAVORS_PER_INSTALLATION} first — see that constant for why the cap
 * is a correctness property of the single-page read and not merely a quota.
 */
export async function registerCustomFlavor(
  input: RegisterFlavorInput,
  now: Date = new Date(),
  /** Record, in the registration write itself, that a validation run is owed. */
  retrigger?: { token: string; dueAtMs: number },
): Promise<CustomFlavorRecord> {
  const rec = buildFlavorRecord(input, now);
  // Deliberately AFTER `buildFlavorRecord`: a malformed name or a built-in collision is a 400 that
  // should not cost a query, and it is the more common operator error.
  const existing = await listCustomFlavors(input.installationId);
  if (existing.length >= MAX_CUSTOM_FLAVORS_PER_INSTALLATION) {
    throw new TooManyFlavorsError(MAX_CUSTOM_FLAVORS_PER_INSTALLATION);
  }
  try {
    await requireDoc().send(
      new PutCommand({
        TableName: TABLE,
        Item: retrigger ? { ...rec, ...retriggerMarker(retrigger.token, retrigger.dueAtMs) } : rec,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new FlavorExistsError(rec.name);
    }
    throw err;
  }
  return rec;
}

/**
 * List an installation's custom flavors (all states — the console shows their progress).
 *
 * One page, deliberately, and safe because registration caps the row count at
 * {@link MAX_CUSTOM_FLAVORS_PER_INSTALLATION} — orders of magnitude below DynamoDB's 1 MiB query
 * page. Every caller is a safety gate that would fail quietly on a partial result (a dropped
 * `valid` row means its label leaves the claim allowlist and its jobs are never claimed), so the
 * invariant is enforced at the WRITE, where it can be refused loudly, instead of papered over
 * with paging here.
 */
export async function listCustomFlavors(
  installationId: number,
): Promise<CustomFlavorRecord[]> {
  const res = await requireDoc().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': installPk(installationId),
        ':prefix': FLAVOR_SK_PREFIX,
      },
    }),
  );
  return (res.Items ?? []) as unknown as CustomFlavorRecord[];
}

/**
 * The routable custom flavors for an installation, plus whether the read DEGRADED (ADR-040
 * fail-open).
 *
 * The fault behavior is safe only in combination with the provisioner's refusal, and the two must
 * be read together. Because callers gate this read on `needsCustomFlavors`, EVERY job that reaches
 * it has named a custom flavor — so returning `[]` here cannot quietly downgrade an ordinary job
 * (an ordinary job never gets this far). What it does mean is that `resolveFlavor` reports the
 * flavor as `unresolvedCustom`, which the provisioner turns into a refused launch rather than a
 * silent fallback to `base`. That is the whole point: falling through would put the job on a REAL
 * built-in image while its runner still advertised the custom label, so it would succeed on the
 * wrong image.
 *
 * `degraded` is what lets the caller pick the RIGHT refusal. A deleted / no-longer-`valid` flavor
 * is deterministic — retrying cannot fix it, so the run should be failed with a readable reason —
 * while a store fault is transient and must be retried. Collapsing the two makes a transient blip
 * indistinguishable from a permanent misconfiguration, and the run row then sticks in
 * `provisioning` with nothing explaining why.
 */
export async function loadRoutableCustomFlavorsResult(
  installationId: number,
): Promise<{ flavors: CatalogFlavor[]; degraded: boolean }> {
  try {
    return {
      flavors: routableCustomFlavors(await listCustomFlavors(installationId)),
      degraded: false,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'custom flavor read failed — degrading to built-in catalog',
        installationId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { flavors: [], degraded: true };
  }
}

/**
 * The routable custom flavors for an installation, or `[]` on ANY fault (ADR-040 fail-open).
 *
 * The fault-tolerant half of {@link loadRoutableCustomFlavorsResult}, for callers that only build a
 * PREVIEW and have no launch to refuse — discovery's stored routing analysis, for instance, where a
 * degraded read simply produces the same preview an installation with no custom flavors gets.
 * A caller that is about to act on the result (i.e. launch a VM) must use the `Result` form so it
 * can distinguish a vanished flavor from an unreadable table.
 */
export async function loadRoutableCustomFlavors(
  installationId: number,
): Promise<CatalogFlavor[]> {
  return (await loadRoutableCustomFlavorsResult(installationId)).flavors;
}

/** Read one custom flavor. */
export async function getCustomFlavor(
  installationId: number,
  name: string,
  signal?: AbortSignal,
): Promise<CustomFlavorRecord | undefined> {
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: flavorSk(name) },
    }),
    { abortSignal: signal },
  );
  return res.Item as unknown as CustomFlavorRecord | undefined;
}

/**
 * Move a custom flavor to a new validation state, enforcing {@link canTransitionValidation}
 * IN THE CONDITION EXPRESSION rather than in a read-then-write.
 *
 * The check has to be atomic: two concurrent validation runs (a manual re-validate racing an
 * image-ARN-change trigger) would otherwise both read `pending`, both launch a microVM, and
 * both write a verdict — burning double quota and letting the loser's stale verdict overwrite
 * the winner's. `attribute_exists(pk)` additionally makes a write for a deleted flavor a no-op
 * instead of resurrecting it.
 *
 * `from` narrows the accepted source states further than the state machine does (never widens
 * it). The smoke λ uses it to release a possibly-stranded row `validating → pending` without
 * overwriting a `valid`/`invalid` verdict that landed after all.
 *
 * Returns false when the transition was refused (illegal, or the row moved underneath us).
 */
export async function transitionFlavorValidation(
  input: {
    installationId: number;
    name: string;
    to: FlavorValidationState;
    from?: readonly FlavorValidationState[];
    /**
     * Require the row to be held by THIS run (`validationRunId`). The smoke λ passes it on its
     * verdict and release so a write that lands late cannot touch a later run's claim.
     */
    runId?: string;
    /**
     * Require the row to still point at this image. The smoke λ passes the ARN it actually launched
     * on its verdict, so a verdict can only ever describe the artifact the row names — independently
     * of the run token, which a repoint already removes.
     */
    imageArn?: string;
    reason?: string;
    evidence?: FlavorValidationEvidence;
    actor?: string;
    now?: Date;
    /**
     * `to: 'pending'` only: record, in this same write, that a validation run is owed (see
     * {@link retriggerMarker}). Used by the operator's re-validate.
     */
    retrigger?: { token: string; dueAtMs: number };
  },
  signal?: AbortSignal,
): Promise<boolean> {
  if (input.retrigger && input.to !== 'pending') return false;
  const from = FLAVOR_VALIDATION_STATES.filter(
    (s) => canTransitionValidation(s, input.to) && (!input.from || input.from.includes(s)),
  );
  if (from.length === 0) return false;
  const iso = (input.now ?? new Date()).toISOString();

  const names: Record<string, string> = { '#state': 'state' };
  const values: Record<string, unknown> = { ':to': input.to, ':now': iso };
  const sets = ['#state = :to', 'updatedAt = :now'];
  const removes: string[] = [];

  // A reason is state-scoped: carrying `invalid`'s reason into a later `valid` would leave the
  // console showing a failure message next to a passing flavor.
  //
  // `evidence` is deliberately NOT cleared the same way. It is a record of the last run that
  // actually observed something, so a same-ARN re-validate keeps it as the previous verdict's
  // evidence for the SAME artifact, and a caller that wants it gone passes `evidence` explicitly.
  // `repointFlavorImage` does remove it, and that asymmetry is the point: a new ARN is a new
  // artifact, so evidence gathered about the old one would be attributed to an image it was never
  // collected from (ADR-041). Consumers must therefore read `evidence` as "last run", not "this
  // state" — which is why `state` and `reason`, never `evidence`, decide routability.
  if (input.reason !== undefined) {
    sets.push('#reason = :reason');
    names['#reason'] = 'reason';
    values[':reason'] = clampReason(input.reason);
  } else {
    removes.push('#reason');
    names['#reason'] = 'reason';
  }
  if (input.evidence !== undefined) {
    sets.push('evidence = :evidence');
    values[':evidence'] = input.evidence;
  }
  if (input.actor) {
    sets.push('updatedBy = :actor');
    values[':actor'] = input.actor;
  }
  // Ownership ends with `validating`. Claims are made only by `claimFlavorValidation`, so every
  // target this function writes leaves the state and drops the token + lease with it — and the
  // row's entry in the live-claim index, which must hold exactly the rows some run holds.
  //
  // The automatic-recovery counter is reset by every transition: a verdict, a run's own release and
  // an operator's re-validate all prove the loop the counter guards (sweep → re-trigger → the run
  // dies again) is not happening. Only the sweep's own release increments it.
  //
  // A pending restart (`retriggerToken`) goes too: an operator re-validate or a verdict supersedes
  // it, so the sweep must not start another run on its own afterwards.
  removes.push(
    'validationRunId',
    'validationLeaseUntil',
    'gsi1pk',
    'gsi1sk',
    'autoRecoveries',
    'retriggerToken',
    'retriggerAttempts',
  );
  if (input.retrigger) {
    // A fresh restart replaces whatever the row's index entry was (a live claim, an older marker).
    const marker = retriggerMarker(input.retrigger.token, input.retrigger.dueAtMs);
    for (const [attr, value] of Object.entries(marker)) {
      removes.splice(removes.indexOf(attr), 1);
      sets.push(`${attr} = :m_${attr}`);
      values[`:m_${attr}`] = value;
    }
  }
  // Every write moves the revision, so a claim based on the row as it was BEFORE this write fails.
  values[':one'] = 1;

  // `state` may be absent on a row written before this field existed; treat that as `pending`.
  const stateGuard = from
    .map((s, i) => {
      values[`:from${i}`] = s;
      return `#state = :from${i}`;
    })
    .join(' OR ');
  const allowsPending = from.includes('pending');
  let ownerGuard = '';
  if (input.runId !== undefined) {
    values[':runId'] = input.runId;
    ownerGuard = ' AND validationRunId = :runId';
  }
  if (input.imageArn !== undefined) {
    values[':imageArn'] = input.imageArn;
    ownerGuard += ' AND imageArn = :imageArn';
  }

  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression:
          `SET ${sets.join(', ')}` +
          (removes.length ? ` REMOVE ${removes.join(', ')}` : '') +
          ' ADD rev :one',
        ConditionExpression:
          `attribute_exists(pk) AND (${stateGuard}` +
          (allowsPending ? ' OR attribute_not_exists(#state)' : '') +
          ')' +
          ownerGuard,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
      { abortSignal: signal },
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Claim a flavor for ONE smoke run: `pending → validating`, stamped with the run's token + lease.
 *
 * The conditional write is the concurrency guard (ADR-041). Beyond the state check it is a
 * COMPARE-AND-SWAP on the exact row the run read (`expect`):
 *
 * - `rev` — the monotonic revision every write bumps. The claim lands only if nothing has written the
 *   row since the run read it. That binds the claim to the inspected state: an operator re-validate
 *   or image repoint in between makes it fail, so a run can never launch the image it READ and then
 *   write a verdict onto a row that now names another one. It is also the fence against a claim
 *   whose response was lost: {@link fenceFlavorValidationRun} bumps `rev`, after which that claim —
 *   and every other claim based on an older read, however many generations of them are still in
 *   flight — fails its condition forever, because `rev` never goes back.
 * - `createdAt` + `imageArn` — the record's identity and artifact. `rev` restarts at 0 when a
 *   flavor is deleted and re-registered under the same name, so `rev` alone cannot tell the two rows
 *   apart; the registration timestamp can, and the ARN pins the artifact itself.
 * - an EXPIRED `validating` claim may be taken over. The lease outlives the claiming λ's own
 *   timeout, so its owner is provably dead; this is how a row stranded by a run that could not
 *   reach DynamoDB at all recovers on the next trigger, rather than only via an operator. A
 *   `validating` row with no lease predates leases and is treated as expired.
 * - `attribute_exists(pk)` — never resurrect a deleted flavor.
 *
 * Returns false when refused.
 */
export async function claimFlavorValidation(
  input: {
    installationId: number;
    name: string;
    runId: string;
    /** Epoch ms. */
    leaseUntil: number;
    /** The row as the run READ it. The claim lands only on exactly that row. */
    expect: { rev?: number; createdAt: string; imageArn: string };
    reason?: string;
    actor?: string;
    /** Set when this run was started by the reconciliation sweep: keep its recovery counter. */
    autoRecovery?: boolean;
    now?: Date;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  const now = input.now ?? new Date();
  const values: Record<string, unknown> = {
    ':validating': 'validating' satisfies FlavorValidationState,
    ':pending': 'pending' satisfies FlavorValidationState,
    ':runId': input.runId,
    ':lease': input.leaseUntil,
    ':nowMs': now.getTime(),
    ':now': now.toISOString(),
    ':one': 1,
    ':createdAt': input.expect.createdAt,
    ':imageArn': input.expect.imageArn,
  };
  const sets = [
    '#state = :validating',
    'validationRunId = :runId',
    'validationLeaseUntil = :lease',
    'updatedAt = :now',
    // Into the sparse live-claim index, so the reconciliation sweep can find this claim if its run
    // never writes a verdict or a release (see FLAVOR_CLAIMS_GSI1PK).
    'gsi1pk = :claimsPk',
    'gsi1sk = :claimsSk',
  ];
  values[':claimsPk'] = FLAVOR_CLAIMS_GSI1PK;
  values[':claimsSk'] = flavorClaimGsi1sk(input.leaseUntil);
  // `fencedRunId` is the scalar fence this revision replaced; drop it from rows that still carry it.
  // A pending automatic restart is consumed by THIS claim: the restart has begun, and the row's index
  // entry is now the live claim's (due at its lease), so the marker must not fire again.
  const removes: string[] = ['fencedRunId', 'retriggerToken', 'retriggerAttempts'];
  // A claim made for any reason other than the sweep's own re-trigger (registration, an operator's
  // re-validate) resets the automatic-recovery counter: it is a fresh decision to run, not the
  // repeat of a run that keeps dying.
  if (!input.autoRecovery) removes.push('autoRecoveries');
  if (input.reason !== undefined) {
    sets.push('#reason = :reason');
    values[':reason'] = clampReason(input.reason);
  } else {
    removes.push('#reason');
  }
  if (input.actor) {
    sets.push('updatedBy = :actor');
    values[':actor'] = input.actor;
  }
  // A fresh registration has no `rev` yet; it reads as 0 and is matched by its absence.
  const readRev = input.expect.rev ?? 0;
  let revGuard: string;
  if (readRev === 0) {
    revGuard = '(attribute_not_exists(rev) OR rev = :rev)';
  } else {
    revGuard = 'rev = :rev';
  }
  values[':rev'] = readRev;
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression:
          `SET ${sets.join(', ')} REMOVE ${removes.join(', ')} ADD rev :one`,
        ConditionExpression:
          'attribute_exists(pk)' +
          ` AND ${revGuard}` +
          ' AND createdAt = :createdAt AND imageArn = :imageArn' +
          ' AND (#state = :pending OR attribute_not_exists(#state)' +
          ' OR (#state = :validating AND (attribute_not_exists(validationLeaseUntil)' +
          ' OR validationLeaseUntil < :nowMs)))',
        ExpressionAttributeNames: { '#state': 'state', '#reason': 'reason' },
        ExpressionAttributeValues: values,
      }),
      { abortSignal: signal },
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Fence every claim based on the row as it is NOW: bump `rev` and touch nothing else. Idempotent in
 * effect (bumping twice fences the same set and more).
 *
 * Used by the smoke λ when its own claim did not answer: whether that claim landed is unknown, and
 * it may still be in flight. A claim is a compare-and-swap on the revision its run read, so once the
 * bump has TAKEN EFFECT a late-settling claim fails its condition; a claim that landed before it is
 * then undone by the token-guarded release. That release is only sound after a fence the caller
 * has CONFIRMED: a fence that timed out may itself still be in flight, and a release run before it
 * lands can be overtaken by the claim (release → claim → late fence strands `validating`). So the
 * caller retries the fence until one attempt answers, and only then releases. A late duplicate
 * fence is harmless — it only bumps `rev`. The revision is MONOTONIC, so a later run's fence can
 * never re-admit an older one's claim — the defect of a single overwritable `fencedRunId`.
 */
export async function fenceFlavorValidationRun(
  input: { installationId: number; name: string },
  signal?: AbortSignal,
): Promise<void> {
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression: 'ADD rev :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':one': 1 },
      }),
      { abortSignal: signal },
    );
  } catch (err) {
    // A deleted flavor needs no fence: there is no row for a late claim to land on, and a
    // re-registered one has a new `createdAt` the late claim cannot match.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw err;
  }
}

/** A live claim whose lease has run out, as the reconciliation sweep sees it. */
export interface ExpiredFlavorClaim {
  kind: 'claim';
  installationId: number;
  name: string;
  /** The token of the run that held it — the release is conditional on it. */
  runId: string;
  leaseUntil: number;
  /** How many times the sweep has already released this flavor without an intervening verdict. */
  autoRecoveries: number;
}

/** A released row whose automatic restart has not yet been taken up by a claim. */
export interface DueFlavorRetrigger {
  kind: 'retrigger';
  installationId: number;
  name: string;
  /** Every sweep write about this restart is conditional on it. */
  token: string;
  /** Accepted sends so far (see {@link MAX_FLAVOR_RETRIGGER_SENDS}). */
  attempts: number;
  autoRecoveries: number;
}

export type DueFlavorRecovery = ExpiredFlavorClaim | DueFlavorRetrigger;

/**
 * Every index entry due before `nowMs`: expired claims and restarts still owed.
 *
 * This is the enumeration that turns the lease from a passive permission ("a later claim MAY take
 * this row over") into an actual recovery: a run that could not reach DynamoDB for its whole budget,
 * or a λ killed outright, writes neither a verdict nor a release, and the only producers of new
 * runs are registration and an operator's re-validate. Without this read nothing ever comes back.
 * Retrigger markers are read by the same query so that a restart whose invoke failed, was dropped,
 * or was never sent because the sweep died is retried on a later tick rather than lost.
 *
 * Paginated to completion up to `maxPages`, and REPORTS truncation instead of hiding it: the index
 * is eventually consistent and every row is re-checked by a conditional write, so a partial read is
 * safe — the rest are found on the next sweep — but it must be visible in the log.
 */
export async function listDueFlavorRecoveries(
  nowMs: number,
  opts: { maxPages?: number } = {},
): Promise<{ claims: DueFlavorRecovery[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 10;
  const claims: DueFlavorRecovery[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await requireDoc().send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk < :now',
        ExpressionAttributeValues: {
          ':pk': FLAVOR_CLAIMS_GSI1PK,
          ':now': flavorClaimGsi1sk(nowMs),
        },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (res.Items ?? []) as Partial<CustomFlavorRecord>[]) {
      if (typeof item.installationId !== 'number' || typeof item.name !== 'string') continue;
      const autoRecoveries = typeof item.autoRecoveries === 'number' ? item.autoRecoveries : 0;
      if (item.state === 'validating' && typeof item.validationRunId === 'string') {
        claims.push({
          kind: 'claim',
          installationId: item.installationId,
          name: item.name,
          runId: item.validationRunId,
          leaseUntil: item.validationLeaseUntil ?? 0,
          autoRecoveries,
        });
      } else if (
        (item.state === 'pending' || item.state === undefined) &&
        typeof item.retriggerToken === 'string'
      ) {
        claims.push({
          kind: 'retrigger',
          installationId: item.installationId,
          name: item.name,
          token: item.retriggerToken,
          attempts: typeof item.retriggerAttempts === 'number' ? item.retriggerAttempts : 0,
          autoRecoveries,
        });
      }
    }
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return { claims, truncated: false };
  }
  return { claims, truncated: true };
}

/**
 * Release a claim whose lease EXPIRED: `validating → pending`, conditional on the row still being
 * held by `runId` under a lease that ended before `nowMs`. The reconciliation sweep's first write.
 *
 * The guards are the claim's own, read the other way round. The token means a row some LATER run
 * has since claimed (new token) is never touched; the lease check means a claim whose run is still
 * inside its budget is never touched either, however stale the eventually-consistent index read
 * was. `ADD rev 1` fences any claim still in flight against the pre-release row, exactly as every
 * other state write does. `autoRecoveries` is incremented here and ONLY here, so the caller can stop
 * re-triggering a flavor whose runs keep dying (see {@link MAX_FLAVOR_AUTO_RECOVERIES}); the
 * condition pins the value the caller decided on, so the stored reason always matches the decision.
 *
 * With `retrigger`, the SAME write turns the row's index entry into a retrigger marker due at
 * `retrigger.dueAtMs` instead of removing it. That is what makes the restart durable: there is no
 * moment at which the row has left `validating` but nothing records that a restart is owed, so an
 * invoke that fails, an event that is dropped, or a sweep that dies before sending is picked up by a
 * later tick. Without `retrigger` (the cap was reached) the entry is removed and the row waits for
 * an operator, as its `reason` says.
 *
 * Returns the counter's new value when released, or `undefined` when the condition refused (the
 * row moved on its own — nothing to do).
 */
export async function releaseExpiredFlavorClaim(
  input: {
    installationId: number;
    name: string;
    runId: string;
    nowMs: number;
    reason: string;
    /** The counter value the caller's decision was based on (from the index read). */
    expectAutoRecoveries: number;
    /** Schedule an automatic restart in the same write. */
    retrigger?: { token: string; dueAtMs: number };
  },
  signal?: AbortSignal,
): Promise<{ autoRecoveries: number } | undefined> {
  const values: Record<string, unknown> = {
    ':pending': 'pending' satisfies FlavorValidationState,
    ':validating': 'validating' satisfies FlavorValidationState,
    ':reason': clampReason(input.reason),
    ':now': new Date(input.nowMs).toISOString(),
    ':actor': 'reconciliation-sweep',
    ':runId': input.runId,
    ':nowMs': input.nowMs,
    ':one': 1,
    ':recoveries': input.expectAutoRecoveries,
  };
  let update =
    'SET #state = :pending, #reason = :reason, updatedAt = :now, updatedBy = :actor';
  let removes = 'validationRunId, validationLeaseUntil';
  if (input.retrigger) {
    update += ', retriggerToken = :tok, retriggerAttempts = :zero, gsi1sk = :due';
    values[':tok'] = input.retrigger.token;
    values[':zero'] = 0;
    values[':due'] = flavorClaimGsi1sk(input.retrigger.dueAtMs);
  } else {
    removes += ', gsi1pk, gsi1sk, retriggerToken, retriggerAttempts';
  }
  try {
    const res = await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression: `${update} REMOVE ${removes} ADD rev :one, autoRecoveries :one`,
        ConditionExpression:
          'attribute_exists(pk) AND #state = :validating AND validationRunId = :runId' +
          ' AND validationLeaseUntil < :nowMs' +
          (input.expectAutoRecoveries === 0
            ? ' AND (attribute_not_exists(autoRecoveries) OR autoRecoveries = :recoveries)'
            : ' AND autoRecoveries = :recoveries'),
        ExpressionAttributeNames: { '#state': 'state', '#reason': 'reason' },
        ExpressionAttributeValues: values,
        ReturnValues: 'UPDATED_NEW',
      }),
      { abortSignal: signal },
    );
    const n = (res.Attributes as { autoRecoveries?: number } | undefined)?.autoRecoveries;
    return { autoRecoveries: typeof n === 'number' ? n : input.expectAutoRecoveries + 1 };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return undefined;
    throw err;
  }
}

/**
 * The condition every write about an outstanding restart shares: the row is still `pending` and
 * still owes THIS restart. A claim (the restart began), a verdict, an operator re-validate or a
 * repoint removes the token, after which none of these writes can land.
 *
 * Retrigger bookkeeping deliberately does NOT bump `rev`. The revision fences claims against
 * changes to what a run inspects (state, artifact, identity); the marker is none of those, and
 * bumping it would refuse the very claim the restart is trying to produce whenever a sweep write
 * landed between the restarted run's read and its claim.
 */
const RETRIGGER_GUARD =
  'attribute_exists(pk) AND (#state = :pending OR attribute_not_exists(#state))' +
  ' AND retriggerToken = :tok';

/**
 * Record that the sweep is about to SEND restart `token`, before it sends it: bump the attempt
 * count (CAS on the count it read) and move the marker's due time to `nextDueAtMs`. If the sweep
 * then dies, or the invoke is accepted but the event never produces a claim, the marker falls due
 * again at `nextDueAtMs` and is sent again. Returns false when the row no longer owes this restart
 * or another sweep already recorded this attempt.
 */
export async function markFlavorRetriggerSent(
  input: {
    installationId: number;
    name: string;
    token: string;
    /** The attempt count as read. */
    attempts: number;
    nextDueAtMs: number;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  return conditionalRetriggerWrite(
    input,
    'SET retriggerAttempts = :next, gsi1sk = :due',
    ' AND retriggerAttempts = :attempts',
    {
      ':attempts': input.attempts,
      ':next': input.attempts + 1,
      ':due': flavorClaimGsi1sk(input.nextDueAtMs),
    },
    signal,
  );
}

/**
 * The send recorded by {@link markFlavorRetriggerSent} was REFUSED (the invoke threw or the function
 * is not configured): restore the attempt count and make the marker due at `dueAtMs`, so the next
 * tick tries again. A refused send proves nothing ran, so it must not use up the restart's budget.
 * If this write itself fails the marker is still due at the marked time — later, never lost.
 */
export async function rearmFlavorRetrigger(
  input: {
    installationId: number;
    name: string;
    token: string;
    /** The attempt count {@link markFlavorRetriggerSent} wrote. */
    attempts: number;
    dueAtMs: number;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  return conditionalRetriggerWrite(
    input,
    'SET retriggerAttempts = :prev, gsi1sk = :due',
    ' AND retriggerAttempts = :attempts',
    {
      ':attempts': input.attempts,
      ':prev': Math.max(0, input.attempts - 1),
      ':due': flavorClaimGsi1sk(input.dueAtMs),
    },
    signal,
  );
}

/**
 * Give up on restart `token`: drop it from the index and say why on the row, so the operator sees
 * that re-validating is now theirs to do. Used once {@link MAX_FLAVOR_RETRIGGER_SENDS} accepted sends
 * have produced no claim.
 */
export async function abandonFlavorRetrigger(
  input: { installationId: number; name: string; token: string; reason: string; nowMs: number },
  signal?: AbortSignal,
): Promise<boolean> {
  return conditionalRetriggerWrite(
    input,
    'SET #reason = :reason, updatedAt = :now, updatedBy = :actor' +
      ' REMOVE retriggerToken, retriggerAttempts, gsi1pk, gsi1sk',
    '',
    {
      ':reason': clampReason(input.reason),
      ':now': new Date(input.nowMs).toISOString(),
      ':actor': 'reconciliation-sweep',
    },
    signal,
  );
}

async function conditionalRetriggerWrite(
  input: { installationId: number; name: string; token: string },
  update: string,
  extraCondition: string,
  values: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression: update,
        ConditionExpression: RETRIGGER_GUARD + extraCondition,
        ExpressionAttributeNames: {
          '#state': 'state',
          ...(update.includes('#reason') ? { '#reason': 'reason' } : {}),
        },
        ExpressionAttributeValues: {
          ':pending': 'pending' satisfies FlavorValidationState,
          ':tok': input.token,
          ...values,
        },
      }),
      { abortSignal: signal },
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Record that a validation run is owed on a row that is ALREADY `pending` (an operator re-validate
 * of a pending flavor, which needs no state transition). Conditional on `pending`, so it never
 * touches a row a run has claimed. Does not bump `rev`, for the reason given at RETRIGGER_GUARD.
 */
export async function scheduleFlavorRetrigger(
  input: { installationId: number; name: string; token: string; dueAtMs: number },
  signal?: AbortSignal,
): Promise<boolean> {
  const marker = retriggerMarker(input.token, input.dueAtMs);
  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression:
          'SET retriggerToken = :rtTok, retriggerAttempts = :rtZero, gsi1pk = :rtPk, gsi1sk = :rtDue',
        ConditionExpression:
          'attribute_exists(pk) AND (#state = :pending OR attribute_not_exists(#state))',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':pending': 'pending' satisfies FlavorValidationState,
          ':rtTok': marker.retriggerToken,
          ':rtZero': 0,
          ':rtPk': marker.gsi1pk,
          ':rtDue': marker.gsi1sk,
        },
      }),
      { abortSignal: signal },
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * The four attributes of a fresh retrigger marker. Written IN THE SAME WRITE as the operator action
 * that makes a run owed (registration, re-validate, repoint), so the row is never `pending` with a
 * run promised and nothing recording that promise: the Mgmt λ's async invoke has the same failure
 * modes as the sweep's (refused, or accepted and dropped after Lambda's retries). The marker is due
 * after a backoff, so the Mgmt λ's own send gets the first chance; the sweep resends only if no
 * claim has consumed the marker by then.
 */
export function retriggerMarker(
  token: string,
  dueAtMs: number,
): Pick<CustomFlavorRecord, 'retriggerToken' | 'retriggerAttempts'> & {
  gsi1pk: string;
  gsi1sk: string;
} {
  return {
    retriggerToken: token,
    retriggerAttempts: 0,
    gsi1pk: FLAVOR_CLAIMS_GSI1PK,
    gsi1sk: flavorClaimGsi1sk(dueAtMs),
  };
}

/**
 * Repoint a custom flavor at a new image ARN, resetting it to `pending`.
 *
 * A new ARN is a NEW ARTIFACT and inherits no evidence (ADR-041), so this is deliberately not
 * a plain field update: the two writes are one atomic operation, because an ARN swap that left
 * the flavor `valid` would route production jobs at an image nothing has ever executed.
 * Returns the previous ARN when the row existed.
 */
export async function repointFlavorImage(input: {
  installationId: number;
  name: string;
  imageArn: string;
  actor?: string;
  now?: Date;
  /** Record, in this same write, that a validation run of the new image is owed. */
  retrigger?: { token: string; dueAtMs: number };
}): Promise<{ changed: boolean; previousImageArn?: string }> {
  const iso = (input.now ?? new Date()).toISOString();
  const marker = input.retrigger
    ? retriggerMarker(input.retrigger.token, input.retrigger.dueAtMs)
    : undefined;
  try {
    const res = await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression:
          'SET imageArn = :arn, #state = :pending, updatedAt = :now' +
          (input.actor ? ', updatedBy = :actor' : '') +
          (marker
            ? ', retriggerToken = :rtTok, retriggerAttempts = :rtZero, gsi1pk = :rtPk, gsi1sk = :rtDue' +
              ' REMOVE #reason, evidence, validationRunId, validationLeaseUntil, autoRecoveries'
            : ' REMOVE #reason, evidence, validationRunId, validationLeaseUntil, gsi1pk, gsi1sk, autoRecoveries, retriggerToken, retriggerAttempts') +
          // A claim based on the row before the swap must fail: it read the OLD artifact.
          ' ADD rev :one',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#state': 'state', '#reason': 'reason' },
        ExpressionAttributeValues: {
          ':arn': input.imageArn,
          ':pending': 'pending' satisfies FlavorValidationState,
          ':now': iso,
          ':one': 1,
          ...(input.actor ? { ':actor': input.actor } : {}),
          ...(marker
            ? {
                ':rtTok': marker.retriggerToken,
                ':rtZero': 0,
                ':rtPk': marker.gsi1pk,
                ':rtDue': marker.gsi1sk,
              }
            : {}),
        },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return {
      changed: true,
      previousImageArn: (res.Attributes as { imageArn?: string } | undefined)?.imageArn,
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return { changed: false };
    }
    throw err;
  }
}

/** Delete a custom flavor row. */
export async function deleteCustomFlavor(
  installationId: number,
  name: string,
): Promise<void> {
  await requireDoc().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: flavorSk(name) },
    }),
  );
}
