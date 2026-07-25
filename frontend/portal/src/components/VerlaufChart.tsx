import type { ComponentRole } from '../komponenten';
import { chartTheme } from '../chartTheme';
import { useEChart } from '../useEChart';
import { secondAxisUnit, type VerlaufRange, type VerlaufSeries } from '../verlauf';

/**
 * The Verlauf-Explorer chart (Historie · Energie → „Messwerte"). **Up to three
 * measurements on ONE chart** (the owner's explicit ask: pick any recorded
 * measurement, see all its data — and compare a few), drawn through the shared
 * `useEChart` + `chartTheme` machine (no new chart lib):
 *
 *  - DAY range = raw lines;
 *  - Woche/Monat/Jahr of a v2 entity = average line with a min–max band (the
 *    `PriceHistoryChart` pattern) — the band is drawn for a SINGLE selection
 *    only, because three overlapping bands are mud;
 *  - v1 site-level energy over week+ = bars.
 *
 * A SECOND y-axis appears automatically when the units differ (kW next to %) —
 * one axis would squash the kW curve into the floor of a 0..100 scale. Colored
 * by the measurement's nature, else by its component role.
 */

/** One selected measurement, ready to draw. */
export interface VerlaufSelection {
  /** Stable key (`entityId:channel`). */
  key: string;
  /** Plain-German measurement name (prefixed by its component when ambiguous). */
  label: string;
  channel: string;
  role: ComponentRole;
  series: VerlaufSeries;
}

/** Series color: per the channel's nature when we know it (so a hybrid's
 * PV-Leistung reads orange, not the component's storage hue), else the role. */
export function seriesColor(channel: string, role: ComponentRole): string {
  const t = chartTheme();
  switch (channel) {
    case 'soc_pct':
    case 'soc':
      return t.soc;
    case 'pv_power_kw':
    case 'pv':
      return t.pv;
    case 'battery_power_kw':
      return t.charge;
    case 'load_kw':
    case 'haus':
      return t.load;
    case 'temperature_c':
      return t.temp;
    case 'power_kw':
    case 'netz':
      return role === 'grid' ? t.flowGrid : t.load;
  }
  switch (role) {
    case 'pv':
      return t.pv;
    case 'storage':
      return t.soc;
    case 'house':
    case 'consumer':
      return t.load;
    case 'grid':
    default:
      return t.flowGrid;
  }
}

/** Axis label per range: time on the day, weekday/date on aggregated ranges. */
function axisLabel(iso: string, range: VerlaufRange, narrow: boolean): string {
  const d = new Date(iso);
  if (range === 'day') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === 'week') {
    if (narrow) return d.toLocaleDateString('de-DE', { weekday: 'short' });
    return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${d.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/** Tooltip header per range. */
function tooltipHead(iso: string, range: VerlaufRange): string {
  const d = new Date(iso);
  if (range === 'day') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  if (range === 'week') {
    return (
      d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) +
      ' · ' +
      d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) +
      ' Uhr'
    );
  }
  return d.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * ECharts inserts a formatter's return value via innerHTML, so anything
 * customer-controlled must be escaped. That is not theoretical here: a
 * measurement label can be an operator-declared Modbus channel name and a
 * component label is customer text, both of which reach the tooltip.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(v: number | null, unit: string): string {
  if (v == null) return '-';
  const n = v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  return unit ? `${n} ${esc(unit)}` : n;
}

export function VerlaufChart({
  selections,
  range,
}: {
  /** One to three measurements; the first owns the primary axis. */
  selections: VerlaufSelection[];
  range: VerlaufRange;
}) {
  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < 480;
      const weekNarrow = narrow && range === 'week';
      const first = selections[0];
      if (!first) return;

      // The longest series owns the time axis; every selection shares the range
      // and anchor, so the bucket starts line up.
      const axisFrom = selections.reduce(
        (best, s) => (s.series.points.length > best.series.points.length ? s : best),
        first,
      );
      const times = axisFrom.series.points.map((p) => p.t);
      const byTime = (s: VerlaufSelection) => {
        const map = new Map(s.series.points.map((p) => [p.t, p] as const));
        return times.map((tt) => map.get(tt) ?? null);
      };

      const units = selections.map((s) => s.series.unit);
      const zweiteEinheit = secondAxisUnit(units);
      const axisIndexOf = (s: VerlaufSelection) =>
        zweiteEinheit != null && s.series.unit === zweiteEinheit ? 1 : 0;
      // The min–max band only makes sense for a single selection (three
      // overlapping bands are mud), and only where the data carries one.
      const withBand = selections.length === 1 && first.series.hasBand;

      // Now-marker (day range only): a subtle line at the current slot.
      let nowIdx = -1;
      if (range === 'day') {
        const now = Date.now();
        for (let i = 0; i < times.length; i++) {
          if (new Date(times[i]).getTime() <= now) nowIdx = i;
          else break;
        }
      }
      const markLine =
        nowIdx > 0 && nowIdx < times.length - 1
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: t.price, type: 'dashed' as const, width: 1.5 },
              label: {
                formatter: 'Jetzt',
                color: t.price,
                position: 'insideEndTop' as const,
                rotate: 0,
              },
              data: [{ xAxis: nowIdx }],
            }
          : undefined;

      const xAxis = {
        type: 'category' as const,
        data: times,
        boundaryGap: first.series.bars,
        axisLabel: {
          formatter: weekNarrow
            ? (v: string) => (new Date(v).getHours() === 0 ? axisLabel(v, range, true) : '')
            : (v: string) => axisLabel(v, range, narrow),
          interval: weekNarrow ? 0 : ('auto' as const),
          color: t.axis,
          hideOverlap: true,
        },
        axisTick: { show: !weekNarrow },
        axisLine: { lineStyle: { color: t.axisLine } },
      };
      const yAxis = [
        {
          type: 'value' as const,
          name: units[0] || undefined,
          splitLine: { lineStyle: { color: t.grid } },
          axisLabel: { color: t.axis },
        },
        {
          type: 'value' as const,
          name: zweiteEinheit ?? undefined,
          position: 'right' as const,
          show: zweiteEinheit != null,
          // A percentage axis always shows the full scale, so it reads as a level.
          ...(zweiteEinheit === '%' ? { min: 0, max: 100 } : {}),
          splitLine: { show: false },
          axisLabel: { color: t.axis },
        },
      ];

      const series: Record<string, unknown>[] = [];
      if (withBand) {
        const pts = first.series.points;
        const color = seriesColor(first.channel, first.role);
        series.push(
          {
            name: 'min',
            type: 'line',
            data: pts.map((p) => p.min ?? p.avg),
            stack: 'band',
            symbol: 'none',
            silent: true,
            lineStyle: { opacity: 0 },
            areaStyle: { opacity: 0 },
            z: 1,
          },
          {
            name: 'span',
            type: 'line',
            data: pts.map((p) => (p.min != null && p.max != null ? p.max - p.min : null)),
            stack: 'band',
            symbol: 'none',
            silent: true,
            lineStyle: { opacity: 0 },
            areaStyle: { color, opacity: 0.14 },
            z: 1,
          },
        );
      }
      selections.forEach((s, i) => {
        const color = seriesColor(s.channel, s.role);
        const values = byTime(s).map((p) => p?.avg ?? null);
        if (s.series.bars) {
          series.push({
            name: s.label,
            type: 'bar',
            yAxisIndex: axisIndexOf(s),
            data: values,
            barCategoryGap: '30%',
            itemStyle: { color, borderRadius: [2, 2, 0, 0] },
            z: 2,
          });
          return;
        }
        series.push({
          name: s.label,
          type: 'line',
          yAxisIndex: axisIndexOf(s),
          data: values,
          symbol: 'none',
          smooth: false,
          connectNulls: false,
          lineStyle: { color, width: 2.4 },
          itemStyle: { color },
          // One selection keeps its calm filled area; several would overlap into
          // mud, so a comparison draws plain lines.
          ...(selections.length === 1 ? { areaStyle: { color, opacity: 0.06 } } : {}),
          ...(i === 0 && markLine ? { markLine } : {}),
          z: 2,
        });
      });

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 28, right: zweiteEinheit ? 20 : 12, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: { dataIndex: number }[]) => {
              const idx = params[0]?.dataIndex;
              if (idx == null) return '';
              const lines = [`<b>${tooltipHead(times[idx], range)}</b>`];
              for (const s of selections) {
                const p = byTime(s)[idx];
                const color = seriesColor(s.channel, s.role);
                const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>`;
                lines.push(`${dot} ${esc(s.label)}: ${fmt(p?.avg ?? null, s.series.unit)}`);
                if (withBand && p?.min != null && p.max != null) {
                  lines.push(
                    `&nbsp;&nbsp;Min ${fmt(p.min, '')} · Max ${fmt(p.max, s.series.unit)}`,
                  );
                }
              }
              return lines.join('<br/>');
            },
          },
          xAxis,
          yAxis,
          series,
        },
        true,
      );
    },
    [selections, range],
  );

  return <div ref={ref} className="vp-chart" />;
}
