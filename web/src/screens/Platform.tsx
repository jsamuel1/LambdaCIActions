import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, formatCost } from '../components.js';

/** Flavors — global catalog + whether an image ARN is published for each (spec 04). */
export function Flavors(): JSX.Element {
  const flavors = useApi(() => api.flavors(), []);
  if (flavors.error) return <ErrorBox message={flavors.error} />;
  if (!flavors.data) return <Loading what="flavors" />;
  return (
    <div className="card">
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
          </tr>
        </thead>
        <tbody>
          {flavors.data.flavors.map((f) => (
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
                {f.imageAvailable ? (
                  <span className="badge ok">built</span>
                ) : (
                  <span className="badge warn">not built</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        arm64 only (Graviton). Images are built out-of-band by `npm run build:images`, which
        publishes each ARN to SSM.
      </p>
      <p className="muted">
        &dagger; vCPU is indicative only — the microVM API accepts a memory request
        (`minimumMemoryInMiB`) but exposes no vCPU knob, so per-minute rates are estimates.
      </p>
    </div>
  );
}
