import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { PriceHistory } from './api';

/** Shared echarts lifecycle (init/resize/dispose), re-render on resize. */
function useChart(render: (chart: echarts.ECharts) => void, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const onResize = () => {
      if (!chart.current) return;
      chart.current.resize();
      renderRef.current(chart.current);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (chart.current) render(chart.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

const AXIS_TEXT = '#6C757D';
const GRID_LINE = '#F1F3F5';
const BAND = '#5A8DE8';
const AVG_LINE = '#3B6FD4';

/** de-DE EUR/MWh + ct/kWh for a tooltip value. */
function fmtPrice(v: number | null): string {
  if (v == null) return '-';
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} EUR/MWh (${(v / 10).toLocaleString(
    'de-DE',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  )} ct/kWh)`;
}

/** Axis label per aggregation bucket. */
function axisLabel(iso: string, bucket: string): string {
  const d = new Date(iso);
  if (bucket === 'PT15M') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (bucket === 'PT1H') {
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
  const ref = useChart(
    (chart) => {
      const { buckets, bucket } = history;
      const isDay = bucket === 'PT15M';
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
            textStyle: { fontFamily: 'Inter, sans-serif', color: AXIS_TEXT },
            grid: { top: 28, right: 12, bottom: 28, left: 8, containLabel: true },
            tooltip: {
              trigger: 'axis',
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
              inRange: { color: ['#2E9E5B', '#FF9800', '#E53935'] },
            },
            xAxis: {
              type: 'category',
              data: times,
              axisLabel: { formatter: (v: string) => axisLabel(v, bucket), color: AXIS_TEXT },
              axisLine: { lineStyle: { color: '#E9ECEF' } },
            },
            yAxis: {
              type: 'value',
              name: 'EUR/MWh',
              splitLine: { lineStyle: { color: GRID_LINE } },
              axisLabel: { color: AXIS_TEXT },
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
                        lineStyle: { color: BAND, type: 'dashed', width: 1.5 },
                        label: { formatter: 'Morgen', color: BAND, position: 'insideEndTop' },
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
          textStyle: { fontFamily: 'Inter, sans-serif', color: AXIS_TEXT },
          grid: { top: 28, right: 12, bottom: 28, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
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
            axisLabel: { formatter: (v: string) => axisLabel(v, bucket), color: AXIS_TEXT },
            axisLine: { lineStyle: { color: '#E9ECEF' } },
          },
          yAxis: {
            type: 'value',
            name: 'EUR/MWh',
            splitLine: { lineStyle: { color: GRID_LINE } },
            axisLabel: { color: AXIS_TEXT },
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
              areaStyle: { color: BAND, opacity: 0.14 },
              z: 1,
            },
            {
              name: 'Ø Preis',
              type: 'line',
              data: avg,
              symbol: 'none',
              smooth: false,
              lineStyle: { color: AVG_LINE, width: 2.5 },
              itemStyle: { color: AVG_LINE },
              z: 2,
            },
          ],
        },
        true,
      );
    },
    [history],
  );

  return <div ref={ref} style={{ width: '100%', height: 320 }} />;
}
