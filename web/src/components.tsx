import { type ReactNode } from 'react';
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
