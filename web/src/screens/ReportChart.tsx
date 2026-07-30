import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { ChartType, Report, SeriesPoint } from '../api.js';

/**
 * Report charts (spec 04 § Reports, ADR-034).
 *
 * ECharts (Apache-2.0) via **per-chart-type imports** rather than the `echarts` barrel: the
 * console is a static S3/CloudFront bundle, and the full package is several times the size of
 * the bar/line pair every report here needs. Adding a chart type means adding it to this
 * `use` list — that friction is deliberate.
 *
 * Renderer is **SVG, not canvas**. Two reasons: the console's CSP is `default-src 'none'` with
 * `style-src 'self'` (ADR-022) and the SVG path touches far less inline styling, and SVG text
 * stays selectable/legible when an operator screenshots a report into a ticket.
 *
 * Sizing lives in `styles.css`. React's inline-style prop compiles to a `style` attribute,
 * which the console's CSP drops (spec 04 § CSP and inline styles), so a chart sized that way
 * would collapse to zero height in production while working in dev. ECharts' own runtime
 * styling is CSSOM property assignment (`el.style.width = …`) and SVG presentation attributes,
 * neither of which `style-src` restricts — only markup-level `style="…"` and inline `<style>`.
 */
echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

/** Palette pulled from the console's CSS variables so charts match the shell. */
const PRIMARY = '#4ea1ff';
const SECONDARY = '#8b93a7';
const AXIS = '#8b93a7';
const LINE = '#2a3040';

function formatValue(value: number, unit: string): string {
  if (unit === 'USD') return `$${value.toFixed(value < 1 ? 4 : 2)}`;
  if (unit === 'ratio 0-1') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'seconds') return value >= 60 ? `${Math.round(value / 60)}m` : `${Math.round(value)}s`;
  return String(value);
}

/**
 * Truncate a category label for an axis. Repo / workflow / job names are tenant-controlled and
 * unbounded; ECharts renders them as SVG text (never HTML), so this is a legibility measure,
 * not an escaping one.
 */
function axisLabel(label: string): string {
  return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}

/**
 * How each chart type in the vocabulary is drawn. Declared as an exhaustive `Record` keyed by
 * `ChartType` so **TypeScript** fails the build if a type is added to the vocabulary
 * (`src/mgmt/reports.ts`) without being handled here. That matters more than it looks: the
 * vocabulary is the model's menu and the picker's option list, so an unhandled type would fall
 * through to some default chart and silently answer a different question than the one asked.
 */
export const CHART_RENDERING: Record<ChartType, 'echarts-bar' | 'echarts-line' | 'table'> = {
  bar: 'echarts-bar',
  stackedBar: 'echarts-bar',
  line: 'echarts-line',
  table: 'table',
};

function buildOption(report: Report): echarts.EChartsCoreOption {
  const { points, metric, spec } = report;
  const isLine = CHART_RENDERING[spec.chart] === 'echarts-line';
  const hasSecondary = points.some((p) => p.secondary !== undefined);
  const seriesName = metric.unit === 'seconds' ? 'p50' : metric.label;

  return {
    animation: false,
    grid: { left: 56, right: 16, top: 28, bottom: 64, containLabel: true },
    tooltip: {
      trigger: 'axis',
      // `formatter` receives ECharts-internal params, not raw HTML from the API; the value
      // strings are numbers we format ourselves and the category name is SVG-rendered text.
      valueFormatter: (v: unknown) => formatValue(Number(v), metric.unit),
    },
    ...(hasSecondary ? { legend: { textStyle: { color: AXIS }, top: 0 } } : {}),
    xAxis: {
      type: 'category',
      data: points.map((p) => axisLabel(p.label)),
      axisLabel: { color: AXIS, rotate: points.length > 6 ? 30 : 0, hideOverlap: true },
      axisLine: { lineStyle: { color: LINE } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: AXIS, formatter: (v: number) => formatValue(v, metric.unit) },
      splitLine: { lineStyle: { color: LINE } },
    },
    series: [
      {
        name: seriesName,
        type: isLine ? 'line' : 'bar',
        data: points.map((p) => p.value),
        itemStyle: { color: PRIMARY },
        ...(isLine ? { smooth: false, symbolSize: 6 } : {}),
        ...(spec.chart === 'stackedBar' ? { stack: 'total' } : {}),
      },
      ...(hasSecondary
        ? [
            {
              name: 'p90',
              type: isLine ? 'line' : 'bar',
              data: points.map((p) => p.secondary ?? 0),
              itemStyle: { color: SECONDARY },
            },
          ]
        : []),
    ],
  };
}

export function ReportChart({ report }: { report: Report }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const chart = useRef<echarts.ECharts | undefined>(undefined);

  useEffect(() => {
    if (!host.current) return;
    chart.current = echarts.init(host.current, undefined, { renderer: 'svg' });
    const onResize = (): void => chart.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.current?.dispose();
      chart.current = undefined;
    };
  }, []);

  useEffect(() => {
    // `notMerge` so switching metric/dimension replaces the option outright — a merge would
    // leave the previous series' data points behind on the new axis.
    chart.current?.setOption(buildOption(report), { notMerge: true });
  }, [report]);

  if (!report.points.length) {
    return <p className="muted">No jobs in this window.</p>;
  }
  return <div className="chart" ref={host} />;
}

/** Tabular view of the same series — the `table` chart type, and the export's preview. */
export function ReportTable({ report }: { report: Report }): JSX.Element {
  const secondary = report.points.some((p) => p.secondary !== undefined);
  return (
    <table>
      <thead>
        <tr>
          <th>{dimensionLabel(report)}</th>
          <th>{secondary ? 'p50' : report.metric.label}</th>
          {secondary && <th>p90</th>}
          <th>Jobs</th>
        </tr>
      </thead>
      <tbody>
        {report.points.map((p: SeriesPoint) => (
          <tr key={p.key}>
            <td>{p.label}</td>
            <td>{formatValue(p.value, report.metric.unit)}</td>
            {secondary && <td>{p.secondary === undefined ? '—' : formatValue(p.secondary, report.metric.unit)}</td>}
            <td>{p.sampleSize}</td>
          </tr>
        ))}
        {!report.points.length && (
          <tr>
            <td colSpan={secondary ? 4 : 3} className="muted">
              No jobs in this window.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function dimensionLabel(report: Report): string {
  switch (report.spec.dimension) {
    case 'repo':
      return 'Repo';
    case 'flavor':
      return 'Flavor';
    case 'workflow':
      return 'Workflow';
    case 'status':
      return 'Status';
    case 'time':
      return 'Bucket';
    case 'none':
      return 'All';
  }
}

export { formatValue };
