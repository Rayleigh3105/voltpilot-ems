import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { History, HistoryBucket } from './api';
import { chartTheme } from './chartTheme';

/** Shared echarts lifecycle (init/resize/dispose) for the history charts. */
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

/** Bucket label: day -> "12:15", week -> "Mi 06:00", month/year -> "15.06.". */
function timeLabel(iso: string, range: History['range']): string {
  const d = new Date(iso);
  if (range === 'day') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === 'week') {
    return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${d.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/** kWh -> avg kW over one bucket. */
function kw(kwh: number | null, bucketMinutes: number): number | null {
  return kwh == null ? null : (kwh * 60) / bucketMinutes;
}

/**
 * The energy series of a period: PV / Verbrauch / Netzbezug / Einspeisung.
 * Day view shows average power (kW lines, like the live telemetry chart);
 * week/month/year show energy per bucket (kWh bars).
 */
export function HistoryEnergyChart({ history }: { history: History }) {
  const ref = useChart((chart) => {
    const t = chartTheme();
    const { buckets, bucketMinutes } = history;
    const day = history.range === 'day';
    const times = buckets.map((b) => b.start);

    const val = (b: HistoryBucket, field: keyof HistoryBucket) =>
      day ? kw(b[field] as number | null, bucketMinutes) : (b[field] as number | null);
    const series = (name: string, field: keyof HistoryBucket, color: string) =>
      day
        ? {
            name,
            type: 'line' as const,
            smooth: true,
            showSymbol: false,
            lineStyle: { width: 2.5, color },
            itemStyle: { color },
            areaStyle: { opacity: 0.06, color },
            data: buckets.map((b) => val(b, field)),
          }
        : {
            name,
            type: 'bar' as const,
            barMaxWidth: 18,
            itemStyle: { color, borderRadius: 2 },
            data: buckets.map((b) => val(b, field)),
          };

    // The 4-item legend wraps to two rows on narrow phones - give the plot
    // area room so the axis name never collides with the second legend row.
    const narrow = chart.getWidth() < 520;
    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: narrow ? 76 : 44, right: 12, bottom: 28, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          formatter: (params: any[]) => {
            const lines = [`<b>${timeLabel(params[0]?.axisValue, history.range)}</b>`];
            for (const p of params) {
              if (p.value == null) continue;
              lines.push(
                `${p.marker} ${p.seriesName}: ${Number(p.value).toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${day ? 'kW' : 'kWh'}`,
              );
            }
            return lines.join('<br/>');
          },
        },
        legend: { top: 8, icon: 'roundRect', textStyle: { color: t.ink, fontWeight: 600 } },
        xAxis: {
          type: 'category',
          data: times,
          boundaryGap: !day,
          axisLabel: { formatter: (v: string) => timeLabel(v, history.range), color: t.axis },
          axisLine: { lineStyle: { color: t.axisLine } },
        },
        yAxis: {
          type: 'value',
          name: day ? 'kW' : 'kWh',
          splitLine: { lineStyle: { color: t.grid } },
          axisLabel: { color: t.axis },
        },
        series: [
          series('PV-Erzeugung', 'pvKwh', t.pv),
          series('Verbrauch', 'loadKwh', t.load),
          series('Netzbezug', 'gridImportKwh', t.discharge),
          series('Einspeisung', 'gridExportKwh', t.charge),
        ],
      },
      true,
    );
  }, [history]);

  return <div ref={ref} className="vp-chart" />;
}

/**
 * The traceability centerpiece of the day view: ACTUAL battery behavior as
 * signed bars (green = laden, red = entladen) directly over the day-ahead
 * price curve (stepped line, right axis) - charging-when-cheap is visible at
 * a glance. Where the optimizer persisted a plan, its trajectory is overlaid
 * dashed (plan vs actual); the measured SoC rides along on a hidden 0-100%
 * axis. Same visual language as the Fahrplan chart, deliberately.
 */
export function HistoryDayChart({ history }: { history: History }) {
  const ref = useChart((chart) => {
    const t = chartTheme();
    const { buckets, plan, bucketMinutes } = history;
    const times = buckets.map((b) => b.start);
    const battery = buckets.map((b) =>
      b.batteryChargeKwh == null || b.batteryDischargeKwh == null
        ? null
        : kw(b.batteryChargeKwh - b.batteryDischargeKwh, bucketMinutes),
    );
    const prices = buckets.map((b) => b.priceEurMwh);
    const soc = buckets.map((b) => b.socLastPct);
    const planByTime = new Map(plan.map((p) => [new Date(p.time).getTime(), p.batteryKw]));
    const planned = buckets.map((b) => planByTime.get(new Date(b.start).getTime()) ?? null);
    const hasPlan = plan.length > 0;

    const kwAbs = [...battery, ...planned]
      .filter((v): v is number => v != null)
      .map((v) => Math.abs(v));
    const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;

    const narrow = chart.getWidth() < 520;
    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: narrow ? 76 : 44, right: 48, bottom: 28, left: 8, containLabel: true },
        legend: {
          top: 0,
          data: [
            'Batterie (ist)',
            ...(hasPlan ? ['Batterie (geplant)'] : []),
            'Börsenpreis',
            'SoC',
          ],
          textStyle: { color: t.axis },
        },
        tooltip: {
          trigger: 'axis',
          formatter: (params: any[]) => {
            const time = new Date(params[0]?.axisValue).toLocaleTimeString('de-DE', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const lines = [`<b>${time}</b>`];
            for (const p of params) {
              if (p.value == null) continue;
              const v = Number(p.value);
              if (p.seriesName === 'Batterie (ist)' || p.seriesName === 'Batterie (geplant)') {
                const label = v >= 0 ? 'Laden' : 'Entladen';
                const suffix = p.seriesName === 'Batterie (geplant)' ? ' (geplant)' : '';
                lines.push(`${p.marker} ${label}${suffix}: ${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`);
              } else if (p.seriesName === 'Börsenpreis') {
                lines.push(
                  `${p.marker} Preis: ${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} EUR/MWh (${(v / 10).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ct/kWh)`,
                );
              } else if (p.seriesName === 'SoC') {
                lines.push(`${p.marker} SoC: ${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`);
              }
            }
            return lines.join('<br/>');
          },
        },
        xAxis: {
          type: 'category',
          data: times,
          axisLabel: { formatter: (v: string) => timeLabel(v, 'day'), color: t.axis },
          axisLine: { lineStyle: { color: t.axisLine } },
        },
        yAxis: [
          {
            type: 'value',
            name: 'kW',
            min: -Math.ceil(kwMax),
            max: Math.ceil(kwMax),
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          {
            type: 'value',
            name: 'EUR/MWh',
            position: 'right',
            splitLine: { show: false },
            axisLabel: { color: t.axis },
          },
          // Hidden SoC axis (0-100%): the trajectory rides along, values in the tooltip.
          { type: 'value', min: 0, max: 100, show: false },
        ],
        series: [
          {
            name: 'Batterie (ist)',
            type: 'bar',
            yAxisIndex: 0,
            data: battery,
            barCategoryGap: '10%',
            itemStyle: {
              borderRadius: 2,
              color: (p: any) => (Number(p.value) >= 0 ? t.charge : t.discharge),
            },
          },
          ...(hasPlan
            ? [
                {
                  name: 'Batterie (geplant)',
                  type: 'line' as const,
                  yAxisIndex: 0,
                  data: planned,
                  step: 'middle' as const,
                  symbol: 'none',
                  lineStyle: { color: t.plan, width: 1.5, type: 'dashed' as const },
                  itemStyle: { color: t.plan },
                },
              ]
            : []),
          {
            name: 'Börsenpreis',
            type: 'line',
            yAxisIndex: 1,
            data: prices,
            step: 'end',
            symbol: 'none',
            lineStyle: { color: t.price, width: 2 },
            itemStyle: { color: t.price },
          },
          {
            name: 'SoC',
            type: 'line',
            yAxisIndex: 2,
            data: soc,
            smooth: true,
            symbol: 'none',
            lineStyle: { color: t.soc, width: 1.5, type: 'dotted' },
            itemStyle: { color: t.soc },
          },
        ],
      },
      true,
    );
  }, [history]);

  return <div ref={ref} className="vp-chart" />;
}
