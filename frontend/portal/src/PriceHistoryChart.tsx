import type { PriceHistory } from './api';
import { chartTheme } from './chartTheme';
import { useEChart } from './useEChart';

/** de-DE EUR/MWh + ct/kWh for a tooltip value. */
function fmtPrice(v: number | null): string {
  if (v == null) return '-';
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} EUR/MWh (${(v / 10).toLocaleString(
    'de-DE',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  )} ct/kWh)`;
}

/** Axis label per aggregation bucket. */
function axisLabel(iso: string, bucket: string, narrow = false): string {
  const d = new Date(iso);
  if (bucket === 'PT15M') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (bucket === 'PT1H') {
    // A phone-width canvas has no room for "Mi 06:00" pairs - the weekday
    // alone keeps several ticks readable instead of one lonely label.
    if (narrow) return d.toLocaleDateString('de-DE', { weekday: 'short' });
    return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${d.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/** Tooltip header per bucket. */
function tooltipHead(iso: string, bucket: string): string {
  const d = new Date(iso);
  if (bucket === 'PT15M') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  if (bucket === 'PT1H') {
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) +
      ' · ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Day-ahead prices over a chosen range. The day view (PT15M) is the
 * forward-looking bar chart - colour-graded low -> high (green -> orange -> red)
 * with a dashed "Morgen" divider at local midnight. Week/month/year show the
 * average price as a line with a light min/max band, so a whole year stays
 * readable while the daily spread is still visible. Prices are EUR/MWh (API
 * native); tooltips also show ct/kWh.
 */
export function PriceHistoryChart({ history }: { history: PriceHistory }) {
  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < 480;
      const { buckets, bucket } = history;
      const isDay = bucket === 'PT15M';
      const weekNarrow = narrow && bucket === 'PT1H';
      const times = buckets.map((b) => b.ts);
      const avg = buckets.map((b) => (b.avgEurMwh == null ? null : Number(b.avgEurMwh)));

      if (isDay) {
        const nums = avg.filter((v): v is number => v != null);
        const min = nums.length ? Math.min(...nums) : 0;
        const max = nums.length ? Math.max(...nums) : 100;

        // Divider at the first slot on the next calendar day (today/tomorrow).
        let boundaryIdx = -1;
        for (let i = 1; i < buckets.length; i++) {
          if (new Date(buckets[i].ts).toDateString() !== new Date(buckets[i - 1].ts).toDateString()) {
            boundaryIdx = i;
            break;
          }
        }

        chart.setOption(
          {
            textStyle: { fontFamily: t.font, color: t.axis },
            grid: { top: 28, right: 12, bottom: 8, left: 8, containLabel: true },
            tooltip: {
              trigger: 'axis',
              confine: true,
              formatter: (params: any[]) => {
                const p = params[0];
                if (!p) return '';
                return `<b>${tooltipHead(p.axisValue, bucket)}</b><br/>${fmtPrice(
                  p.value == null ? null : Number(p.value),
                )}`;
              },
            },
            visualMap: {
              show: false,
              min,
              max,
              dimension: 1,
              inRange: { color: [t.charge, t.pv, t.discharge] },
            },
            xAxis: {
              type: 'category',
              data: times,
              axisLabel: {
              formatter: (v: string) => axisLabel(v, bucket, narrow),
              color: t.axis,
              hideOverlap: true,
            },
              axisLine: { lineStyle: { color: t.axisLine } },
            },
            yAxis: {
              type: 'value',
              name: 'EUR/MWh',
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis },
            },
            series: [
              {
                name: 'Börsenpreis',
                type: 'bar',
                data: avg,
                barCategoryGap: '10%',
                itemStyle: { borderRadius: [2, 2, 0, 0] },
                markLine:
                  boundaryIdx > 0
                    ? {
                        silent: true,
                        symbol: 'none',
                        lineStyle: { color: t.price, type: 'dashed', width: 1.5 },
                        label: { formatter: 'Morgen', color: t.price, position: 'insideEndTop' },
                        data: [{ xAxis: boundaryIdx }],
                      }
                    : undefined,
              },
            ],
          },
          true,
        );
        return;
      }

      // Week/month/year: average line + min/max band (two stacked helper series
      // draw the band; the tooltip reads avg/min/max off the bucket by index).
      const lows = buckets.map((b) => (b.minEurMwh == null ? null : Number(b.minEurMwh)));
      const spans = buckets.map((b) =>
        b.minEurMwh == null || b.maxEurMwh == null ? null : Number(b.maxEurMwh) - Number(b.minEurMwh),
      );

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 28, right: 12, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: any[]) => {
              const idx = params[0]?.dataIndex;
              const b = buckets[idx];
              if (!b) return '';
              const lines = [`<b>${tooltipHead(b.ts, bucket)}</b>`];
              lines.push(`Ø ${fmtPrice(b.avgEurMwh == null ? null : Number(b.avgEurMwh))}`);
              if (b.minEurMwh != null && b.maxEurMwh != null) {
                lines.push(
                  `Min ${Number(b.minEurMwh).toLocaleString('de-DE', { maximumFractionDigits: 1 })} · Max ${Number(
                    b.maxEurMwh,
                  ).toLocaleString('de-DE', { maximumFractionDigits: 1 })} EUR/MWh`,
                );
              }
              return lines.join('<br/>');
            },
          },
          xAxis: {
            type: 'category',
            data: times,
            boundaryGap: false,
            axisLabel: {
              // Narrow week view: one weekday label per day (at its first
              // bucket) - the auto interval over hourly buckets would repeat
              // weekdays ("Mo Mo Di ...").
              formatter:
                weekNarrow
                  ? (v: string) =>
                      new Date(v).getHours() === 0 ? axisLabel(v, bucket, true) : ''
                  : (v: string) => axisLabel(v, bucket, narrow),
              interval: weekNarrow ? 0 : 'auto',
              color: t.axis,
              hideOverlap: true,
            },
            axisTick: { show: !weekNarrow },
            axisLine: { lineStyle: { color: t.axisLine } },
          },
          yAxis: {
            type: 'value',
            name: 'EUR/MWh',
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          series: [
            {
              name: 'min',
              type: 'line',
              data: lows,
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
              data: spans,
              stack: 'band',
              symbol: 'none',
              silent: true,
              lineStyle: { opacity: 0 },
              areaStyle: { color: t.price, opacity: 0.14 },
              z: 1,
            },
            {
              name: 'Ø Preis',
              type: 'line',
              data: avg,
              symbol: 'none',
              smooth: false,
              lineStyle: { color: t.price, width: 2.5 },
              itemStyle: { color: t.price },
              z: 2,
            },
          ],
        },
        true,
      );
    },
    [history],
  );

  return <div ref={ref} className="vp-chart" />;
}
