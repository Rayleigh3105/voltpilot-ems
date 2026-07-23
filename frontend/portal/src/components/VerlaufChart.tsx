import type { ComponentRole } from '../komponenten';
import { chartTheme } from '../chartTheme';
import { useEChart } from '../useEChart';
import type { VerlaufRange, VerlaufSeries } from '../verlauf';

/**
 * The Verlauf-Explorer chart (Historie · „Messwerte"). ONE measurement over the
 * selected range, drawn through the shared `useEChart` + `chartTheme` machine
 * (no new chart lib): the DAY range is a raw line; Woche/Monat/Jahr of a v2
 * entity are an average line with a min–max band (the `PriceHistoryChart`
 * pattern), while v1 site-level energy over week+ is drawn as bars. Never a
 * dual y-axis — one measurement, one axis. Colored by the measurement's role.
 */

/** The teal grid hue (a flow token, not part of chartTheme). */
function gridColor(): string {
  if (typeof window !== 'undefined' && typeof getComputedStyle === 'function') {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--vp-flow-grid').trim();
    if (v) return v;
  }
  return '#0ea5a3';
}

/** Series color: per the channel's nature when we know it (so a hybrid's
 * PV-Leistung reads orange, not the component's storage hue), else the role. */
function seriesColor(channel: string, role: ComponentRole): string {
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
      return role === 'grid' ? gridColor() : t.load;
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
      return gridColor();
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

function fmt(v: number | null, unit: string): string {
  if (v == null) return '-';
  const n = v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  return unit ? `${n} ${unit}` : n;
}

export function VerlaufChart({
  series,
  range,
  role,
  channel,
  label,
}: {
  series: VerlaufSeries;
  range: VerlaufRange;
  role: ComponentRole;
  channel: string;
  label: string;
}) {
  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const color = seriesColor(channel, role);
      const narrow = width < 480;
      const weekNarrow = narrow && range === 'week';
      const { points, unit } = series;
      const times = points.map((p) => p.t);
      const avg = points.map((p) => p.avg);

      const xAxis = {
        type: 'category' as const,
        data: times,
        boundaryGap: series.bars,
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
      const yAxis = {
        type: 'value' as const,
        name: unit || undefined,
        splitLine: { lineStyle: { color: t.grid } },
        axisLabel: { color: t.axis },
      };
      const base = {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: 28, right: 12, bottom: 8, left: 8, containLabel: true },
      };

      // Now-marker (day range only): a subtle line at the current slot.
      let nowIdx = -1;
      if (range === 'day') {
        const now = Date.now();
        for (let i = 0; i < points.length; i++) {
          if (new Date(points[i].t).getTime() <= now) nowIdx = i;
          else break;
        }
      }
      const markLine =
        nowIdx > 0 && nowIdx < points.length - 1
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: t.price, type: 'dashed' as const, width: 1.5 },
              label: { formatter: 'Jetzt', color: t.price, position: 'insideEndTop' as const, rotate: 0 },
              data: [{ xAxis: nowIdx }],
            }
          : undefined;

      if (series.bars) {
        chart.setOption(
          {
            ...base,
            tooltip: {
              trigger: 'axis',
              confine: true,
              formatter: (params: { axisValue: string; value: number | null }[]) => {
                const p = params[0];
                if (!p) return '';
                return `<b>${tooltipHead(p.axisValue, range)}</b><br/>${label}: ${fmt(
                  p.value == null ? null : Number(p.value),
                  unit,
                )}`;
              },
            },
            xAxis,
            yAxis,
            series: [
              {
                name: label,
                type: 'bar',
                data: avg,
                barCategoryGap: '30%',
                itemStyle: { color, borderRadius: [2, 2, 0, 0] },
              },
            ],
          },
          true,
        );
        return;
      }

      if (series.hasBand) {
        // Average line + min/max band (two stacked helper series draw the band).
        const lows = points.map((p) => p.min ?? p.avg);
        const spans = points.map((p) =>
          p.min != null && p.max != null ? p.max - p.min : null,
        );
        chart.setOption(
          {
            ...base,
            tooltip: {
              trigger: 'axis',
              confine: true,
              formatter: (params: { dataIndex: number }[]) => {
                const idx = params[0]?.dataIndex;
                const p = points[idx];
                if (!p) return '';
                const lines = [`<b>${tooltipHead(p.t, range)}</b>`, `Ø ${fmt(p.avg, unit)}`];
                if (p.min != null && p.max != null) {
                  lines.push(`Min ${fmt(p.min, '')} · Max ${fmt(p.max, unit)}`);
                }
                return lines.join('<br/>');
              },
            },
            xAxis,
            yAxis,
            series: [
              { name: 'min', type: 'line', data: lows, stack: 'band', symbol: 'none', silent: true, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, z: 1 },
              { name: 'span', type: 'line', data: spans, stack: 'band', symbol: 'none', silent: true, lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.14 }, z: 1 },
              { name: label, type: 'line', data: avg, symbol: 'none', smooth: false, lineStyle: { color, width: 2.5 }, itemStyle: { color }, z: 2 },
            ],
          },
          true,
        );
        return;
      }

      // Plain line (day range: raw values).
      chart.setOption(
        {
          ...base,
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: { axisValue: string; value: number | null }[]) => {
              const p = params[0];
              if (!p) return '';
              return `<b>${tooltipHead(p.axisValue, range)}</b><br/>${label}: ${fmt(
                p.value == null ? null : Number(p.value),
                unit,
              )}`;
            },
          },
          xAxis,
          yAxis,
          series: [
            {
              name: label,
              type: 'line',
              data: avg,
              symbol: 'none',
              smooth: false,
              connectNulls: false,
              lineStyle: { color, width: 2.5 },
              itemStyle: { color },
              areaStyle: { color, opacity: 0.06 },
              markLine,
            },
          ],
        },
        true,
      );
    },
    [series, range, role, channel, label],
  );

  return <div ref={ref} className="vp-chart" />;
}
