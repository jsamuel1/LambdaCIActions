import { useRef, useState } from 'react';
import {
  api,
  type CustomFlavor,
  type CustomFlavorInput,
  type Flavor,
  type FlavorPreview,
  type FlavorReadiness,
  type FlavorValidationState,
  type Installation,
} from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, formatCost } from '../components.js';

/**
 * Per-flavor live readiness (ADR-051).
 *
 * `imageAvailable` alone was misleading: an image can be published while the flavor's routing
 * label is absent from the live claim allowlist, in which case the capacity exists and no job can
 * ever select it. Both halves are shown, and the state names which one is missing.
 */
function ReadinessBadge({ r }: { r?: FlavorReadiness }): JSX.Element {
  if (!r) {
    return (
      <span className="badge queued" title="Could not read the live control plane.">
        unchecked
      </span>
    );
  }
  if (r.runnable) return <span className="badge ok">runnable</span>;
  const kind = r.state === 'imageMissing' ? 'risk' : 'block';
  return (
    <span className={`badge ${kind}`} title={r.problem}>
      {r.state}
    </span>
  );
}

/**
 * Validation state of a custom flavor (ADR-041).
 *
 * `pending` and `validating` are deliberately NOT rendered as warnings: neither is a defect, and
 * neither is routable. Only `invalid` is a verdict against the image, and only `valid` is proof.
 */
function ValidationBadge({ state }: { state: FlavorValidationState }): JSX.Element {
  switch (state) {
    case 'valid':
      return (
        <span className="badge ok" title="A smoke run proved this image: a runner registered, a job ran and the VM self-terminated.">
          valid
        </span>
      );
    case 'invalid':
      return (
        <span className="badge block" title="A validation run found this image unusable. See the reason.">
          invalid
        </span>
      );
    case 'validating':
      return (
        <span className="badge warn" title="A smoke run is in flight — one microVM is launching a throwaway runner.">
          validating
        </span>
      );
    default:
      return (
        <span className="badge queued" title="Registered but not yet proven. Not routable.">
          pending
        </span>
      );
  }
}

/** ADR-038: only memory is requestable, so every rate is an estimate and vCPU is indicative. */
function shapeCell(f: { vcpu: number; memoryMb: number }): JSX.Element {
  return (
    <>
      {f.vcpu} vCPU&dagger; / {Math.round(f.memoryMb / 1024)} GB
    </>
  );
}

const EMPTY_FORM: CustomFlavorInput = {
  base: '',
  vcpu: 2,
  memoryMb: 4096,
  capabilities: [],
  description: '',
  imageArn: '',
  smokeRepoFullName: '',
  smokeWorkflowPath: '',
};

/** The closed capability vocabulary (ADR-041 static gate). An unknown string is refused. */
const CAPABILITIES = ['docker', 'node', 'python', 'java', 'go', 'rust'];

/**
 * How often the selected installation's flavors are re-read while a custom flavor is still in
 * flight (`pending`/`validating`) or the custom read was `degraded`. Validation is an async λ that
 * takes minutes; without this the badge would freeze at whatever the post-register reload saw.
 */
export const FLAVOR_POLL_MS = 5000;

/** Drop the optional empty strings so the API sees "absent", not "empty". */
function toPayload(form: CustomFlavorInput): CustomFlavorInput {
  return {
    ...form,
    base: form.base.trim(),
    imageArn: form.imageArn.trim(),
    description: form.description.trim(),
    smokeRepoFullName: form.smokeRepoFullName?.trim() || undefined,
    smokeWorkflowPath: form.smokeWorkflowPath?.trim() || undefined,
  };
}

/**
 * Identity of exactly what a preview was computed for: the installation AND the payload. A preview
 * is only ever shown — and registration only ever enabled — when this matches the form as it is
 * NOW, so a verdict can never be displayed for, or authorize, a different draft or installation.
 */
function previewKey(installationId: number, payload: CustomFlavorInput): string {
  return JSON.stringify([installationId, payload]);
}

/**
 * Registration form for a bring-your-own image (ADR-040/041).
 *
 * Two-step, and ENFORCED as two-step: `Check` runs the server's static gate + rate estimate with no
 * write, and `Register` is only enabled while a passing preview exists for exactly the current
 * installation + payload. Any edit drops the preview, and a preview response that resolves after an
 * edit (or after a newer Check) is discarded rather than repopulating a verdict for values it was
 * not computed from. The form is keyed by installation in `Flavors`, so switching installation
 * remounts it with an empty draft and nothing in flight can write into it.
 *
 * It is the SERVER's gate, not a re-implementation — a client-side copy would eventually disagree
 * with what registration accepts. In particular the description rule (ADR-038: a description must
 * not advertise a vCPU shape) is enforced server-side and its error is surfaced verbatim, rather
 * than pre-empted here where a looser client regex would let a rejected registration look like a
 * bug.
 */
function RegisterFlavorForm({
  installationId,
  onRegistered,
}: {
  installationId: number;
  onRegistered: (installationId: number, smokeWorkflow?: string) => void;
}): JSX.Element {
  const [form, setForm] = useState<CustomFlavorInput>(EMPTY_FORM);
  const [preview, setPreview] = useState<{ key: string; result: FlavorPreview } | undefined>(
    undefined,
  );
  const [pending, setPending] = useState<'check' | 'register' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [details, setDetails] = useState<string[]>([]);
  const [note, setNote] = useState<string | undefined>(undefined);
  /** Bumped by every edit and every Check; only the newest Check may write its result. */
  const generation = useRef(0);

  const currentKey = previewKey(installationId, toPayload(form));
  const current = preview && preview.key === currentKey ? preview.result : undefined;
  const canRegister = !pending && current?.staticGate.ok === true;

  const set = <K extends keyof CustomFlavorInput>(key: K, value: CustomFlavorInput[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates the previous verdict — it was about a different flavor — and orphans
    // an in-flight Check, whose answer is for the values before this edit.
    generation.current += 1;
    setPreview(undefined);
    setPending((p) => (p === 'check' ? undefined : p));
    setNote(undefined);
  };

  /** Surface the API's own message + `details`; a 400 here is nearly always actionable. */
  const fail = (err: unknown): void => {
    const e = err as { message?: string; details?: unknown };
    setError(e.message ?? String(err));
    setDetails(Array.isArray(e.details) ? e.details.map((d) => String(d)) : []);
  };

  const check = async (): Promise<void> => {
    const body = toPayload(form);
    const key = previewKey(installationId, body);
    const gen = (generation.current += 1);
    setPending('check');
    setPreview(undefined);
    setError(undefined);
    setDetails([]);
    try {
      const result = await api.previewFlavor(installationId, body);
      if (generation.current !== gen) return; // superseded by an edit or a newer Check
      setPreview({ key, result });
    } catch (err) {
      if (generation.current !== gen) return;
      fail(err);
    } finally {
      if (generation.current === gen) setPending(undefined);
    }
  };

  const register = async (): Promise<void> => {
    const body = toPayload(form);
    // Re-checked here, not only in `disabled`: the button state is a render behind the form.
    if (!preview || preview.key !== previewKey(installationId, body) || !preview.result.staticGate.ok) {
      setError('Run Check on the current values first — registration needs a passing static check.');
      setDetails([]);
      return;
    }
    setPending('register');
    setError(undefined);
    setDetails([]);
    try {
      const res = await api.registerFlavor(installationId, body);
      generation.current += 1;
      setNote(res.note);
      setForm(EMPTY_FORM);
      setPreview(undefined);
      onRegistered(installationId, res.smokeWorkflow);
    } catch (err) {
      fail(err);
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="card">
      <h3>Register a custom flavor</h3>
      <p className="muted">
        Bring your own microVM image. It is registered <code>pending</code> and is{' '}
        <strong>not routable</strong> until a smoke run launches one microVM from it and proves a
        runner registers, a job runs and the VM self-terminates (ADR-041).
      </p>
      <div className="stack">
        <label className="field">
          <span>Name</span>
          <input
            value={form.base}
            onChange={(e) => set('base', e.target.value)}
            placeholder="gpu"
            autoComplete="off"
          />
          <span className="muted tight">
            Registered as <code>custom-{form.base.trim() || '…'}</code>, routed by{' '}
            <code>lambda-ci-custom-{form.base.trim() || '…'}</code>.
          </span>
        </label>
        <label className="field">
          <span>Image ARN</span>
          <input
            value={form.imageArn}
            onChange={(e) => set('imageArn', e.target.value)}
            placeholder="arn:aws:lambda:us-west-2:123456789012:microvm-image:my-image"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Memory (MiB)</span>
          <input
            type="number"
            value={form.memoryMb}
            onChange={(e) => set('memoryMb', Number(e.target.value))}
          />
          <span className="muted tight">
            The only shape value that is actually requested (<code>minimumMemoryInMiB</code>).
          </span>
        </label>
        <label className="field">
          <span>vCPU (indicative&dagger;)</span>
          <input
            type="number"
            value={form.vcpu}
            onChange={(e) => set('vcpu', Number(e.target.value))}
          />
          <span className="muted tight">
            Descriptive only — the microVM API exposes no vCPU knob (ADR-038).
          </span>
        </label>
        <label className="field">
          <span>Smoke repository</span>
          <input
            value={form.smokeRepoFullName ?? ''}
            onChange={(e) => set('smokeRepoFullName', e.target.value)}
            placeholder="owner/repo"
            autoComplete="off"
          />
          <span className="muted tight">
            Where validation registers its throwaway runner and dispatches the trivial job.
            Required before validation can run.
          </span>
        </label>
        <label className="field">
          <span>Smoke workflow path</span>
          <input
            value={form.smokeWorkflowPath ?? ''}
            onChange={(e) => set('smokeWorkflowPath', e.target.value)}
            placeholder=".github/workflows/lca-flavor-validate.yml"
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Description</span>
          <input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="CUDA toolchain image for model smoke tests"
            autoComplete="off"
          />
          <span className="muted tight">
            Do not state a vCPU shape here — the platform cannot provision one, so advertising it
            is refused (ADR-038).
          </span>
        </label>
        <div className="field">
          <span>Capabilities</span>
          <div className="row">
            {CAPABILITIES.map((c) => (
              <label key={c} className="row">
                <input
                  type="checkbox"
                  checked={form.capabilities.includes(c)}
                  onChange={(e) =>
                    set(
                      'capabilities',
                      e.target.checked
                        ? [...form.capabilities, c]
                        : form.capabilities.filter((x) => x !== c),
                    )
                  }
                />
                {c}
              </label>
            ))}
          </div>
          <span className="muted tight">
            A closed vocabulary: these feed capability upgrades and the compatibility gate, so an
            unrecognized value would be silently inert and is refused.
          </span>
        </div>
      </div>

      <div className="row gap-top">
        <button
          type="button"
          onClick={check}
          disabled={pending !== undefined || !form.base.trim() || !form.imageArn.trim()}
        >
          {pending === 'check' ? 'Checking…' : 'Check'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={register}
          disabled={!canRegister}
          title={
            canRegister
              ? undefined
              : 'Run Check on the current values first — registration needs a passing static check.'
          }
        >
          Register
        </button>
      </div>
      {!current && pending === undefined && (
        <p className="muted tight">
          Register is enabled once <strong>Check</strong> passes for the values as they are now.
        </p>
      )}

      {error && <ErrorBox message={error} />}
      {details.length > 0 && (
        <ul className="error">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {note && <p className="muted">{note}</p>}

      {current && (
        <div className="subcard gap-top">
          <p className="tight">
            <code>{current.name}</code> · label <code>{current.label}</code> · ~
            {formatCost(current.usdPerMinute)}/min{' '}
            {current.rateIsEstimate && <span className="muted">(estimate&dagger;)</span>}
          </p>
          {current.staticGate.ok ? (
            <p className="gap-top">
              <span className="badge ok">static checks pass</span>
            </p>
          ) : (
            <>
              <p className="gap-top">
                <span className="badge block">static checks fail</span>
              </p>
              <ul className="error">
                {current.staticGate.failures.map((f) => (
                  <li key={f.code}>{f.message}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted tight">{current.note}</p>
        </div>
      )}
    </div>
  );
}

/** The workflow the operator must commit before validation can dispatch anything. */
function SmokeWorkflow({ yaml }: { yaml: string }): JSX.Element {
  return (
    <details className="card">
      <summary>Smoke workflow to commit to your smoke repository</summary>
      <p className="muted">
        Validation dispatches this workflow with a one-shot nonce. Its <code>runs-on</code> carries
        only that nonce, so it is inert until a validation run triggers it and can never be taken by
        a real CI runner. We do not commit it for you — writing to your default branch is a side
        effect nobody asked for.
      </p>
      <pre className="mono">{yaml}</pre>
    </details>
  );
}

/**
 * One custom flavor row's actions: re-validate (optionally repointing the image) and delete.
 *
 * Delete is irreversible and immediately makes every job naming the flavor unclaimable, so it is a
 * two-step action: the first click only arms an inline confirmation that names the flavor AND the
 * installation it belongs to, and the request is sent only from that confirmation's own button.
 * Cancel disarms it without a request. Re-validate needs no such guard: it is recoverable (it only
 * returns the flavor to `pending` and starts a new run).
 */
function CustomFlavorActions({
  installationId,
  installationLabel,
  flavor,
  onChanged,
}: {
  installationId: number;
  /** How the operator knows the installation, for the delete confirmation. */
  installationLabel: string;
  flavor: Flavor;
  onChanged: () => void;
}): JSX.Element {
  const [imageArn, setImageArn] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);

  const run = async (fn: () => Promise<string | undefined>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      setNote(await fn());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row">
      <input
        value={imageArn}
        onChange={(e) => setImageArn(e.target.value)}
        placeholder="new image ARN (optional)"
        aria-label={`New image ARN for ${flavor.name}`}
        autoComplete="off"
      />
      <button
        type="button"
        disabled={busy || confirmingDelete}
        onClick={() =>
          run(async () => {
            const res = await api.revalidateFlavor(
              installationId,
              flavor.name,
              imageArn.trim() ? { imageArn: imageArn.trim() } : {},
            );
            setImageArn('');
            return res.validationTriggered
              ? 'validation started — the flavor is pending until it passes'
              : 'validation could not be started; the flavor stays pending and is not routable';
          })
        }
      >
        Re-validate
      </button>
      {!confirmingDelete ? (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setNote(undefined);
            setConfirmingDelete(true);
          }}
        >
          Delete
        </button>
      ) : (
        <span role="alertdialog" aria-label={`Confirm deleting ${flavor.name}`} className="row">
          <span className="error">
            Delete <code>{flavor.name}</code> from installation <strong>{installationLabel}</strong>?
            This cannot be undone. Jobs that name <code>{flavor.label}</code> will no longer be
            claimed.
          </span>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.deleteFlavor(installationId, flavor.name);
                setConfirmingDelete(false);
                return `${flavor.name} deleted`;
              })
            }
          >
            Delete permanently
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </span>
      )}
      {error && <span className="error">{error}</span>}
      {note && <span className="muted">{note}</span>}
    </div>
  );
}

/**
 * Flavors — the built-in catalog plus, when an installation is selected, its own custom flavors in
 * every validation state (spec 04, ADR-040/041).
 *
 * The installation selector is not cosmetic: a custom flavor lives in its installation's partition
 * and is only addressable there, so an unscoped request genuinely cannot show one.
 *
 * Scope binding: every read is tagged with the installation it was issued for, and rows are only
 * rendered when that tag matches the CURRENT selection. `useApi` keeps the previous `data` while a
 * new read is in flight, so without the tag an A→B switch would keep A's rows on screen with
 * B-scoped Delete/Re-validate buttons — and with a same-named flavor in both, a click on A's row
 * would mutate B. Mutations take their installation from the tag, never from the selector, and
 * per-row and form state are keyed by it so no draft survives into another installation.
 *
 * Validation is an async λ that takes minutes, so while any custom row is `pending`/`validating`
 * (or the custom read was `degraded`) the read polls on the visibility-aware `useApi` interval and
 * the badge + reason advance to the terminal verdict without a reload.
 */
export function Flavors(): JSX.Element {
  const installs = useApi(() => api.installations(), []);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [reloadTick, setReloadTick] = useState(0);
  const [smokeWorkflowFromRegister, setSmokeWorkflowFromRegister] = useState<
    { installationId: number; yaml: string } | undefined
  >(undefined);
  const flavors = useApi(
    () => {
      const scope = selected;
      return (scope ? api.flavorsFor(scope) : api.flavors()).then((body) => ({ scope, body }));
    },
    [selected, reloadTick],
    (d) => (d && d.scope === selected && needsPoll(d.body) ? FLAVOR_POLL_MS : undefined),
  );
  const reload = (): void => setReloadTick((t) => t + 1);

  const selector = (
    <div className="card">
      <label className="field">
        <span>Installation</span>
        <select
          value={selected ?? ''}
          onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">Built-in catalog only (no installation selected)</option>
          {(installs.data?.installations ?? []).map((i: Installation) => (
            <option key={i.installationId} value={i.installationId}>
              {i.accountLogin} ({i.installationId})
            </option>
          ))}
        </select>
      </label>
      {installs.error && <ErrorBox message={`Could not list installations: ${installs.error}`} />}
      {!selected && (
        <p className="muted">
          Custom flavors belong to an installation. Select one to see, register or re-validate
          them.
        </p>
      )}
    </div>
  );

  // Only data read for the CURRENT selection may render: anything else is another installation's
  // rows, and every action on them would be mis-scoped.
  const fresh = flavors.data && flavors.data.scope === selected ? flavors.data : undefined;
  if (!fresh) {
    return (
      <>
        {selector}
        {!flavors.loading && flavors.error ? (
          <ErrorBox message={flavors.error} />
        ) : (
          <Loading what="flavors" />
        )}
      </>
    );
  }

  const scope = fresh.scope;
  const data = fresh.body;
  const readiness = data.readiness ?? [];
  const byFlavor = new Map(readiness.map((r) => [r.flavor, r]));
  const notRunnable = readiness.filter((r) => !r.runnable);
  const rows = data.flavors;
  const custom = rows.filter((f) => f.custom);
  const scoped = data as { customFlavorsRead?: 'ok' | 'degraded'; smokeWorkflow?: string };
  const degraded = scoped.customFlavorsRead === 'degraded';
  const smokeWorkflow =
    (smokeWorkflowFromRegister && smokeWorkflowFromRegister.installationId === scope
      ? smokeWorkflowFromRegister.yaml
      : undefined) ?? scoped.smokeWorkflow;

  return (
    <>
      {selector}
      {flavors.error && (
        <ErrorBox message={`Refresh failed — showing the last successful read: ${flavors.error}`} />
      )}
      {degraded && (
        <div className="card">
          <p className="error">
            This installation&apos;s custom flavors could not be read. The rows below are built-ins
            only — the absence of a custom flavor here is <strong>not</strong> evidence that it does
            not exist. Retry before registering anything, or you may register a duplicate.
          </p>
        </div>
      )}

      <div className="card">
        {data.controlPlaneLive === false && (
          <p className="muted">
            Could not read the live control plane — the Runnable column reads <em>unchecked</em>, and
            any <em>unchecked</em> Image cell means the check did not run, not that the image is
            missing.
          </p>
        )}
        {notRunnable.length > 0 && (
          <p className="error">
            {notRunnable.length} catalog flavor{notRunnable.length === 1 ? '' : 's'} cannot run in
            this environment. A job naming an <code>unroutable</code>/<code>unclaimable</code>{' '}
            flavor&apos;s label is left <code>queued</code> by GitHub with no error.
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Flavor</th>
              <th>Label</th>
              <th>Arch</th>
              <th>Size</th>
              <th>Capabilities</th>
              <th>$/min&dagger;</th>
              <th>Image</th>
              <th>Label allowlisted</th>
              <th>Runnable</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const r = byFlavor.get(f.name);
              return (
                <tr key={f.name}>
                  <td>
                    {f.name}
                    {f.custom && <span className="badge">custom</span>}
                    <div className="muted">{f.description}</div>                  </td>
                  <td>{f.label}</td>
                  <td>{f.arch}</td>
                  <td>{shapeCell(f)}</td>
                  <td>{f.capabilities.join(', ') || '—'}</td>
                  <td>~{formatCost(f.usdPerMinute)}</td>
                  <td>
                    {f.imageAvailable === null ? (
                      <span className="muted" title="The image-arn parameter check could not be performed — this is not evidence the image is missing.">
                        unchecked
                      </span>
                    ) : f.imageAvailable ? (
                      <span className="badge ok">built</span>
                    ) : (
                      <span className="badge warn">not built</span>
                    )}
                  </td>
                  <td>
                    {!r ? (
                      <span className="muted">?</span>
                    ) : r.labelAllowlisted ? (
                      <span className="badge ok">yes</span>
                    ) : (
                      <span className="badge block">no</span>
                    )}
                  </td>
                  <td>
                    {f.custom ? (
                      // A custom flavor's routability is its VALIDATION state, not the built-in
                      // image/allowlist reconciliation: its image lives on its own row rather than
                      // in this environment's `image-arn-*` namespace, so reconciling it there
                      // would report `imageMissing` for an image that is fine.
                      <ValidationBadge state={f.validationState ?? 'pending'} />
                    ) : (
                      <>
                        <ReadinessBadge r={r} />
                        {r && !r.runnable && r.fix && <div className="fix">{r.fix}</div>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">
          arm64 only (Graviton). Built-in images are built out-of-band by{' '}
          <code>npm run build:images</code>, which publishes each ARN to SSM.{' '}
          <strong>Runnable</strong> reconciles the built-in catalog against the LIVE control plane: a
          flavor needs BOTH a published image and its routing label in{' '}
          <code>/lca/&lt;env&gt;/config/runner-labels</code>, which the claim gate consults before
          routing ever runs. A <strong>custom</strong> flavor instead shows its ADR-041 validation
          state — only <code>valid</code> is routable.
        </p>
        <p className="muted">
          &dagger; vCPU is indicative only — the microVM API accepts a memory request
          (<code>minimumMemoryInMiB</code>) but exposes no vCPU knob, so every per-minute rate here
          is an <strong>estimate</strong> for the requested shape.
        </p>
      </div>

      {scope !== undefined && custom.length > 0 && (
        <div className="card">
          <h3>Custom flavor validation</h3>
          <table>
            <thead>
              <tr>
                <th>Flavor</th>
                <th>State</th>
                <th>Reason</th>
                <th>Image ARN</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {custom.map((f) => (
                <tr key={`${scope}:${f.name}`}>
                  <td>
                    {f.name}
                    <div className="muted">{f.label}</div>
                  </td>
                  <td>
                    <ValidationBadge state={f.validationState ?? 'pending'} />
                  </td>
                  <td>{f.validationReason ?? <span className="muted">—</span>}</td>
                  <td>
                    <code>{f.imageArn ?? '—'}</code>
                  </td>
                  <td>
                    <CustomFlavorActions
                      installationId={scope}
                      installationLabel={installationLabel(installs.data?.installations, scope)}
                      flavor={f}
                      onChanged={reload}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Re-validating returns a flavor to <code>pending</code> first, so it stops being routable
            the moment its evidence is withdrawn. Supplying a new image ARN is a new artifact and
            inherits no evidence. This is also the only way out of terminal <code>invalid</code>.
          </p>
        </div>
      )}

      {scope !== undefined && (
        <RegisterFlavorForm
          key={scope}
          installationId={scope}
          onRegistered={(installationId, yaml) => {
            setSmokeWorkflowFromRegister(yaml ? { installationId, yaml } : undefined);
            reload();
          }}
        />
      )}
      {scope !== undefined && smokeWorkflow && <SmokeWorkflow yaml={smokeWorkflow} />}
    </>
  );
}

/**
 * The installation as the operator sees it in the selector (`account (id)`), for confirmations that
 * must say WHICH installation an irreversible action targets. Falls back to the id alone.
 */
function installationLabel(installations: Installation[] | undefined, id: number): string {
  const i = installations?.find((x) => x.installationId === id);
  return i ? `${i.accountLogin} (${i.installationId})` : String(id);
}

/**
 * Whether the selected installation's read is still moving: a custom flavor not yet at a terminal
 * verdict, or a custom read that failed and should be retried rather than left looking empty.
 */
function needsPoll(body: {
  flavors: Flavor[];
  customFlavorsRead?: 'ok' | 'degraded';
}): boolean {
  if (body.customFlavorsRead === 'degraded') return true;
  return body.flavors.some(
    (f) => f.custom && (f.validationState === undefined || f.validationState === 'pending' || f.validationState === 'validating'),
  );
}

/** Re-exported so the type is used even when the console only renders `FlavorView` rows. */
export type { CustomFlavor };
