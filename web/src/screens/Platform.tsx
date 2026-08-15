import { useState } from 'react';
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
 * Registration form for a bring-your-own image (ADR-040/041).
 *
 * Two-step by design: `Check` runs the server's static gate + rate estimate with no write, so the
 * operator sees the verdict and the cost before committing. It is the SERVER's gate, not a
 * re-implementation — a client-side copy would eventually disagree with what registration accepts.
 * In particular the description rule (ADR-038: a description must not advertise a vCPU shape) is
 * enforced server-side and its error is surfaced verbatim, rather than pre-empted here where a
 * looser client regex would let a rejected registration look like a bug.
 */
function RegisterFlavorForm({
  installationId,
  onRegistered,
}: {
  installationId: number;
  onRegistered: (smokeWorkflow?: string) => void;
}): JSX.Element {
  const [form, setForm] = useState<CustomFlavorInput>(EMPTY_FORM);
  const [preview, setPreview] = useState<FlavorPreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [details, setDetails] = useState<string[]>([]);
  const [note, setNote] = useState<string | undefined>(undefined);

  const set = <K extends keyof CustomFlavorInput>(key: K, value: CustomFlavorInput[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates the previous verdict — it was about a different flavor.
    setPreview(undefined);
    setNote(undefined);
  };

  /** Drop the optional empty strings so the API sees "absent", not "empty". */
  const payload = (): CustomFlavorInput => ({
    ...form,
    base: form.base.trim(),
    imageArn: form.imageArn.trim(),
    description: form.description.trim(),
    ...(form.smokeRepoFullName?.trim()
      ? { smokeRepoFullName: form.smokeRepoFullName.trim() }
      : { smokeRepoFullName: undefined }),
    ...(form.smokeWorkflowPath?.trim()
      ? { smokeWorkflowPath: form.smokeWorkflowPath.trim() }
      : { smokeWorkflowPath: undefined }),
  });

  /** Surface the API's own message + `details`; a 400 here is nearly always actionable. */
  const fail = (err: unknown): void => {
    const e = err as { message?: string; details?: unknown };
    setError(e.message ?? String(err));
    setDetails(Array.isArray(e.details) ? e.details.map((d) => String(d)) : []);
  };

  const check = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setDetails([]);
    try {
      setPreview(await api.previewFlavor(installationId, payload()));
    } catch (err) {
      setPreview(undefined);
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const register = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setDetails([]);
    try {
      const res = await api.registerFlavor(installationId, payload());
      setNote(res.note);
      setForm(EMPTY_FORM);
      setPreview(undefined);
      onRegistered(res.smokeWorkflow);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
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
        <button type="button" onClick={check} disabled={busy || !form.base || !form.imageArn}>
          Check
        </button>
        <button
          type="button"
          className="primary"
          onClick={register}
          disabled={busy || !form.base || !form.imageArn}
        >
          Register
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {details.length > 0 && (
        <ul className="error">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {note && <p className="muted">{note}</p>}

      {preview && (
        <div className="subcard gap-top">
          <p className="tight">
            <code>{preview.name}</code> · label <code>{preview.label}</code> · ~
            {formatCost(preview.usdPerMinute)}/min{' '}
            {preview.rateIsEstimate && <span className="muted">(estimate&dagger;)</span>}
          </p>
          {preview.staticGate.ok ? (
            <p className="gap-top">
              <span className="badge ok">static checks pass</span>
            </p>
          ) : (
            <>
              <p className="gap-top">
                <span className="badge block">static checks fail</span>
              </p>
              <ul className="error">
                {preview.staticGate.failures.map((f) => (
                  <li key={f.code}>{f.message}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted tight">{preview.note}</p>
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

/** One custom flavor row's actions: re-validate (optionally repointing the image) and delete. */
function CustomFlavorActions({
  installationId,
  flavor,
  onChanged,
}: {
  installationId: number;
  flavor: Flavor;
  onChanged: () => void;
}): JSX.Element {
  const [imageArn, setImageArn] = useState('');
  const [busy, setBusy] = useState(false);
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
        disabled={busy}
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
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await api.deleteFlavor(installationId, flavor.name);
            return `${flavor.name} deleted`;
          })
        }
      >
        Delete
      </button>
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
 */
export function Flavors(): JSX.Element {
  const installs = useApi(() => api.installations(), []);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [reloadTick, setReloadTick] = useState(0);
  const [smokeWorkflowFromRegister, setSmokeWorkflowFromRegister] = useState<string | undefined>(
    undefined,
  );
  const flavors = useApi(
    () => (selected ? api.flavorsFor(selected) : api.flavors()),
    [selected, reloadTick],
  );

  if (flavors.error) return <ErrorBox message={flavors.error} />;
  if (!flavors.data) return <Loading what="flavors" />;

  const readiness = flavors.data.readiness ?? [];
  const byFlavor = new Map(readiness.map((r) => [r.flavor, r]));
  const notRunnable = readiness.filter((r) => !r.runnable);
  const rows = flavors.data.flavors;
  const custom = rows.filter((f) => f.custom);
  const scoped = flavors.data as { customFlavorsRead?: 'ok' | 'degraded'; smokeWorkflow?: string };
  const degraded = scoped.customFlavorsRead === 'degraded';
  const smokeWorkflow = smokeWorkflowFromRegister ?? scoped.smokeWorkflow;
  const reload = (): void => setReloadTick((t) => t + 1);

  return (
    <>
      <div className="card">
        <label className="field">
          <span>Installation</span>
          <select
            value={selected ?? ''}
            onChange={(e) => {
              setSelected(e.target.value ? Number(e.target.value) : undefined);
              setSmokeWorkflowFromRegister(undefined);
            }}
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
        {degraded && (
          <p className="error">
            This installation&apos;s custom flavors could not be read. The rows below are built-ins
            only — the absence of a custom flavor here is <strong>not</strong> evidence that it does
            not exist. Retry before registering anything, or you may register a duplicate.
          </p>
        )}
      </div>

      <div className="card">
        {flavors.data.controlPlaneLive === false && (
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

      {selected !== undefined && custom.length > 0 && (
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
                <tr key={f.name}>
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
                      installationId={selected}
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

      {selected !== undefined && (
        <RegisterFlavorForm
          installationId={selected}
          onRegistered={(yaml) => {
            setSmokeWorkflowFromRegister(yaml);
            reload();
          }}
        />
      )}
      {selected !== undefined && smokeWorkflow && <SmokeWorkflow yaml={smokeWorkflow} />}
    </>
  );
}

/** Re-exported so the type is used even when the console only renders `FlavorView` rows. */
export type { CustomFlavor };
