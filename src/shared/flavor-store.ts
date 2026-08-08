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
const doc = client ? DynamoDBDocumentClient.from(client) : undefined;
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
        Item: rec,
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
): Promise<CustomFlavorRecord | undefined> {
  const res = await requireDoc().send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: installPk(installationId), sk: flavorSk(name) },
    }),
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
 * Returns false when the transition was refused (illegal, or the row moved underneath us).
 */
export async function transitionFlavorValidation(input: {
  installationId: number;
  name: string;
  to: FlavorValidationState;
  reason?: string;
  evidence?: FlavorValidationEvidence;
  actor?: string;
  now?: Date;
}): Promise<boolean> {
  const from = FLAVOR_VALIDATION_STATES.filter((s) => canTransitionValidation(s, input.to));
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

  // `state` may be absent on a row written before this field existed; treat that as `pending`.
  const stateGuard = from
    .map((s, i) => {
      values[`:from${i}`] = s;
      return `#state = :from${i}`;
    })
    .join(' OR ');
  const allowsPending = from.includes('pending');

  try {
    await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression:
          `SET ${sets.join(', ')}` + (removes.length ? ` REMOVE ${removes.join(', ')}` : ''),
        ConditionExpression:
          `attribute_exists(pk) AND (${stateGuard}` +
          (allowsPending ? ' OR attribute_not_exists(#state)' : '') +
          ')',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
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
}): Promise<{ changed: boolean; previousImageArn?: string }> {
  const iso = (input.now ?? new Date()).toISOString();
  try {
    const res = await requireDoc().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: installPk(input.installationId), sk: flavorSk(input.name) },
        UpdateExpression:
          'SET imageArn = :arn, #state = :pending, updatedAt = :now' +
          (input.actor ? ', updatedBy = :actor' : '') +
          ' REMOVE #reason, evidence',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#state': 'state', '#reason': 'reason' },
        ExpressionAttributeValues: {
          ':arn': input.imageArn,
          ':pending': 'pending' satisfies FlavorValidationState,
          ':now': iso,
          ...(input.actor ? { ':actor': input.actor } : {}),
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
