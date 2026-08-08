import { api, type FlavorReadiness } from '../api.js';
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

/** Flavors — global catalog + whether an image ARN is published for each (spec 04). */
export function Flavors(): JSX.Element {
  const flavors = useApi(() => api.flavors(), []);
  if (flavors.error) return <ErrorBox message={flavors.error} />;
  if (!flavors.data) return <Loading what="flavors" />;
  const readiness = flavors.data.readiness ?? [];
  const byFlavor = new Map(readiness.map((r) => [r.flavor, r]));
  const notRunnable = readiness.filter((r) => !r.runnable);
  return (
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
          {notRunnable.length} catalog flavor{notRunnable.length === 1 ? '' : 's'} cannot run in this
          environment. A job naming an <code>unroutable</code>/<code>unclaimable</code> flavor's
          label is left <code>queued</code> by GitHub with no error.
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
            <th>$/min</th>
            <th>Image</th>
            <th>Label allowlisted</th>
            <th>Runnable</th>
          </tr>
        </thead>
        <tbody>
          {flavors.data.flavors.map((f) => {
            const r = byFlavor.get(f.name);
            return (
              <tr key={f.name}>
                <td>
                  {f.name}
                  <div className="muted">{f.description}</div>
                </td>
                <td>{f.label}</td>
                <td>{f.arch}</td>
                <td>
                  {f.vcpu} vCPU&dagger; / {Math.round(f.memoryMb / 1024)} GB
                </td>
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
                  <ReadinessBadge r={r} />
                  {r && !r.runnable && r.fix && <div className="fix">{r.fix}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">
        arm64 only (Graviton). Images are built out-of-band by `npm run build:images`, which
        publishes each ARN to SSM. <strong>Runnable</strong> reconciles the catalog against the LIVE
        control plane: a flavor needs BOTH a published image and its routing label in{' '}
        <code>/lca/&lt;env&gt;/config/runner-labels</code>, which the claim gate consults before
        routing ever runs.
      </p>
      <p className="muted">
        &dagger; vCPU is indicative only — the microVM API accepts a memory request
        (`minimumMemoryInMiB`) but exposes no vCPU knob, so per-minute rates are estimates.
      </p>
    </div>
  );
}
