import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CompatLevel, CompatRollup, RunStatus } from './api.js';

export function Badge({ kind, children }: { kind: string; children: ReactNode }): JSX.Element {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: RunStatus }): JSX.Element {
  return <Badge kind={status}>{status}</Badge>;
}

export function CompatBadge({ level }: { level: CompatLevel }): JSX.Element {
  return <Badge kind={level}>{level}</Badge>;
}

/** Compat rollup as coloured counts (Repos + Repo detail headline). */
export function CompatRollupView({ roll }: { roll?: CompatRollup }): JSX.Element {
  if (!roll) return <span className="muted">—</span>;
  const parts: [CompatLevel, number][] = [
    ['ok', roll.ok],
    ['warn', roll.warn],
    ['risk', roll.risk],
    ['block', roll.block],
  ];
  const shown = parts.filter(([, n]) => n > 0);
  if (!shown.length) return <span className="muted">no workflows</span>;
  return (
    <span className="row">
      {shown.map(([level, n]) => (
        <Badge key={level} kind={level}>
          {n} {level}
        </Badge>
      ))}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="card stat">
      <div className="n">{value}</div>
      <div className="k">{label}</div>
    </div>
  );
}

export function Loading({ what }: { what: string }): JSX.Element {
  return <p className="muted">Loading {what}…</p>;
}

export function ErrorBox({ message }: { message: string }): JSX.Element {
  return (
    <div className="card">
      <p className="error">{message}</p>
    </div>
  );
}

/**
 * A de-emphasized identifier with a copy button (spec 04 § Runs). Ids are for correlating
 * with GitHub/CloudWatch, not for scanning, so they render small + dim at the end of the
 * column they belong to rather than as a column of their own.
 *
 * The button lives inside a clickable table row, so it must stop propagation — otherwise
 * copying an id also navigates away from the list. Accessibility: the button carries an
 * explicit `aria-label` (its glyph is decorative) and the outcome is announced through a
 * polite live region rather than colour alone.
 *
 * The button is only rendered when the Clipboard API is actually available. `navigator.
 * clipboard` needs a secure context — the console is HTTPS-only behind CloudFront
 * (ADR-024), but a plain-HTTP dev origin leaves it undefined — and a button that silently
 * does nothing when pressed is worse than no button: the id itself is on screen and
 * selectable either way. A *rejected* write (denied permission) is different: the press was
 * real, so it is reported in the same live region instead of being swallowed.
 */
export function CopyId({ label, value }: { label: string; value: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const supported = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;

  async function copy(): Promise<void> {
    let next: 'copied' | 'failed';
    try {
      await navigator.clipboard.writeText(value);
      next = 'copied';
    } catch {
      // Not worth an error banner — the id is on screen and can be selected by hand.
      next = 'failed';
    }
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1500);
  }

  return (
    <span className="idcell">
      <span className="muted mono">{value}</span>
      {supported && (
        <button
          type="button"
          className="copy"
          aria-label={`Copy ${label} ${value}`}
          onClick={(e) => {
            e.stopPropagation();
            void copy();
          }}
        >
          <span aria-hidden="true">{state === 'copied' ? '✓' : '⧉'}</span>
        </button>
      )}
      <span className="sronly" role="status" aria-live="polite">
        {state === 'copied' ? `${label} ${value} copied` : ''}
        {state === 'failed' ? `Could not copy ${label} ${value}` : ''}
      </span>
    </span>
  );
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatCost(usd?: number): string {
  if (usd === undefined) return '—';
  return `$${usd.toFixed(4)}`;
}

export function formatTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}
