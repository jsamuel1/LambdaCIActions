import { useEffect, useState } from 'react';
import {
  ApiError,
  api,
  reportQueryString,
  type AskRefusal,
  type ChartType,
  type RangePreset,
  type Report,
  type ReportCatalog,
  type ReportDimension,
  type ReportMetric,
  type ReportQuery,
} from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, formatTime } from '../components.js';
import { CHART_RENDERING, ReportChart, ReportTable, formatValue } from './ReportChart.js';

/**
 * Reports — cost/spend + run analytics (spec 04 § Reports, M5).
 *
 * Two ways in, ONE execution path:
 *
 *  - the **manual picker** (metric × dimension × window × filters), whose state lives entirely
 *    in the URL hash so any report is a shareable link; and
 *  - the **assistant**, which sends a question to `/api/reports/ask`, gets back a *validated
 *    spec plus its result*, and then writes that spec into the same URL. So a generated report
 *    is indistinguishable from a hand-picked one once it lands — reloading the link re-runs the
 *    deterministic report and never re-invokes the model (ADR-033).
 *
 * Every refusal from the assistant (disabled, unsupported question, invalid spec, model
 * unavailable, rate limited) leaves the picker fully usable and shows why.
 */

const DIMENSION_LABELS: Record<ReportDimension, string> = {
  repo: 'by repo',
  flavor: 'by flavor',
  workflow: 'by workflow',
  status: 'by status',
  time: 'over time',
  none: 'total',
};

const DEFAULT_QUERY: ReportQuery = {
  metric: 'spend',
  dimension: 'repo',
  chart: 'bar',
  preset: '7d',
};

/** Read the picker state out of the hash query string (`#/reports?metric=…`). */
function queryFromHash(): ReportQuery {
  const raw = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const csvNums = (k: string): number[] | undefined => {
    const v = raw.get(k);
    if (!v) return undefined;
    const nums = v.split(',').filter((s) => /^\d+$/.test(s)).map(Number);
    return nums.length ? nums : undefined;
  };
  const csv = (k: string): string[] | undefined => {
    const v = raw.get(k);
    if (!v) return undefined;
    const parts = v.split(',').filter(Boolean);
    return parts.length ? parts : undefined;
  };
  return {
    metric: (raw.get('metric') as ReportMetric) ?? DEFAULT_QUERY.metric,
    dimension: (raw.get('dimension') as ReportDimension) ?? DEFAULT_QUERY.dimension,
    chart: (raw.get('chart') as ChartType) ?? DEFAULT_QUERY.chart,
    preset: (raw.get('preset') as RangePreset) ?? (raw.get('from') ? undefined : DEFAULT_QUERY.preset),
    from: raw.get('from') ?? undefined,
    to: raw.get('to') ?? undefined,
    repos: csvNums('repos'),
    flavors: csv('flavors'),
    statuses: csv('statuses') as ReportQuery['statuses'],
  };
}

export function Reports(): JSX.Element {
  const [query, setQuery] = useState<ReportQuery>(queryFromHash);
  const catalog = useApi(() => api.reportCatalog(), []);

  // Keep the hash in sync so the address bar IS the report's permalink. `replaceState` rather
  // than assigning `location.hash`: assigning fires `hashchange`, which the shell's router
  // listens to, remounting this screen and discarding in-flight state on every filter tweak.
  useEffect(() => {
    const next = `#/reports?${reportQueryString(query)}`;
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [query]);

  const report = useApi(() => api.report(query), [reportQueryString(query)]);

  if (catalog.error) return <ErrorBox message={catalog.error} />;
  if (!catalog.data) return <Loading what="report catalog" />;

  return (
    <div className="stack">
      <Assistant catalog={catalog.data} onSpec={setQuery} />
      <Picker catalog={catalog.data} query={query} onChange={setQuery} />
      {report.error ? (
        <ErrorBox message={report.error} />
      ) : !report.data ? (
        <Loading what="report" />
      ) : (
        <ReportView report={report.data} query={query} />
      )}
    </div>
  );
}

// ---- assistant -------------------------------------------------------------

function Assistant({
  catalog,
  onSpec,
}: {
  catalog: ReportCatalog;
  onSpec: (q: ReportQuery) => void;
}): JSX.Element | null {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message: string; reason?: string } | undefined>();
  const [resolved, setResolved] = useState<Report | undefined>();

  if (!catalog.nl.enabled) {
    return (
      <div className="card">
        <p className="muted tight">
          The report assistant is not enabled in this environment — use the picker below.
        </p>
      </div>
    );
  }

  async function ask(): Promise<void> {
    if (!question.trim() || busy) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const res = await api.askReport(question);
      setResolved(res);
      // Adopt the model's spec as picker state. From here on the report is a plain URL and
      // the model is out of the loop entirely.
      onSpec(specToQuery(res));
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as unknown as AskRefusal | undefined;
        setRefusal({ message: e.message, reason: body?.reason });
      } else {
        setRefusal({ message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <input
          className="grow"
          type="text"
          value={question}
          maxLength={400}
          placeholder="Ask for a report — e.g. “spend by repo last 30 days”"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
        />
        <button className="primary" onClick={() => void ask()} disabled={busy || !question.trim()}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>
      {refusal && (
        <p className="gap-top muted tight">
          <span className="error">{refusal.message}</span>{' '}
          {refusal.reason === 'unavailable'
            ? 'The picker below still works.'
            : 'Try rephrasing, or use the picker below.'}
        </p>
      )}
      {resolved && !refusal && (
        <p className="gap-top muted tight">
          Resolved to <strong>{resolved.metric.label}</strong>{' '}
          {DIMENSION_LABELS[resolved.spec.dimension]}, {windowLabel(resolved)} — rendered from the{' '}
          {resolved.source ? 'assistant' : 'picker'} but pinned as a plain URL. Model:{' '}
          {resolved.source?.modelId ?? '—'}.
        </p>
      )}
    </div>
  );
}

/** Project a server-resolved spec back onto picker query state. */
function specToQuery(report: Report): ReportQuery {
  const s = report.spec;
  return {
    metric: s.metric,
    dimension: s.dimension,
    chart: s.chart,
    preset: s.preset,
    ...(s.preset ? {} : { from: s.from, to: s.to }),
    repos: s.filters.repoIds,
    flavors: s.filters.flavors,
    statuses: s.filters.statuses,
  };
}

// ---- picker ----------------------------------------------------------------

function Picker({
  catalog,
  query,
  onChange,
}: {
  catalog: ReportCatalog;
  query: ReportQuery;
  onChange: (q: ReportQuery) => void;
}): JSX.Element {
  const patch = (p: Partial<ReportQuery>): void => onChange({ ...query, ...p });
  return (
    <div className="card">
      <div className="row">
        <label className="muted" htmlFor="metric">
          Report
        </label>
        <select
          id="metric"
          value={query.metric}
          onChange={(e) => {
            const metric = e.target.value as ReportMetric;
            // Duration/latency are distributions — `stackedBar` would imply the p50 and p90
            // bars sum to something, which they don't. Reset to a plain bar on metric change.
            patch({ metric, chart: query.chart === 'stackedBar' ? 'bar' : query.chart });
          }}
        >
          {catalog.metrics.map((m) => (
            <option key={m.metric} value={m.metric}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="muted" htmlFor="dimension">
          Group
        </label>
        <select
          id="dimension"
          value={query.dimension}
          onChange={(e) => patch({ dimension: e.target.value as ReportDimension })}
        >
          {catalog.dimensions.map((d) => (
            <option key={d} value={d}>
              {DIMENSION_LABELS[d]}
            </option>
          ))}
        </select>

        <label className="muted" htmlFor="preset">
          Window
        </label>
        <select
          id="preset"
          value={query.preset ?? 'custom'}
          onChange={(e) => patch({ preset: e.target.value as RangePreset, from: undefined, to: undefined })}
        >
          {catalog.presets.map((p) => (
            <option key={p} value={p}>
              last {p}
            </option>
          ))}
          {!query.preset && <option value="custom">custom</option>}
        </select>

        <label className="muted" htmlFor="chart">
          Chart
        </label>
        <select id="chart" value={query.chart} onChange={(e) => patch({ chart: e.target.value as ChartType })}>
          {catalog.charts.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label className="muted" htmlFor="repo">
          Repo
        </label>
        <select
          id="repo"
          value={query.repos?.length === 1 ? String(query.repos[0]) : ''}
          onChange={(e) => patch({ repos: e.target.value ? [Number(e.target.value)] : undefined })}
        >
          <option value="">all my repos</option>
          {catalog.repos.map((r) => (
            <option key={r.repoId} value={r.repoId}>
              {r.repoFullName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ---- result ----------------------------------------------------------------

function windowLabel(report: Report): string {
  return report.spec.preset
    ? `last ${report.spec.preset}`
    : `${formatTime(report.spec.from)} → ${formatTime(report.spec.to)}`;
}

function ReportView({ report, query }: { report: Report; query: ReportQuery }): JSX.Element {
  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <div>
            <div className="n">
              {report.total === undefined ? '—' : formatValue(report.total, report.metric.unit)}
            </div>
            <div className="k">
              {report.total === undefined ? report.metric.label : `total ${report.metric.label}`}
              {report.metric.estimate && ' (estimate)'}
            </div>
          </div>
          <div className="spacer" />
          <span className="muted">
            {report.rowCount} jobs · {report.resolved.repoCount} repos · {windowLabel(report)}
          </span>
          <a className="badge" href={api.reportExportUrl(query, 'csv')} download>
            CSV
          </a>
          <a className="badge" href={api.reportExportUrl(query, 'json')} download>
            JSON
          </a>
        </div>
        <p className="gap-top muted tight">
          <strong>{report.metric.label}</strong> — {report.metric.definition} Scope:{' '}
          {report.resolved.scope}.
        </p>
        {report.caveat && (
          <p className="gap-top muted tight">
            Coverage {Math.round(report.coverage * 100)}%. {report.caveat}
          </p>
        )}
        {!report.complete && (
          <p className="gap-top tight">
            <span className="error">
              Partial: the read budget was spent before this window was exhausted — treat these
              numbers as a floor, and narrow the window or the repo filter.
            </span>
          </p>
        )}
      </div>
      <div className="card">
        {CHART_RENDERING[report.spec.chart] === 'table' ? (
          <ReportTable report={report} />
        ) : !report.points.length ? (
          // The chart is mounted ONLY with a non-empty series: it owns an ECharts instance bound
          // to its host div, so an internal empty-state return would strand that instance (see
          // ReportChart). Mount/unmount instead, and let React dispose it.
          <p className="muted">No jobs in this window.</p>
        ) : (
          <>
            <ReportChart report={report} />
            <ReportTable report={report} />
          </>
        )}
        <p className="gap-top muted tight">Generated {formatTime(report.generatedAt)}.</p>
      </div>
    </div>
  );
}
