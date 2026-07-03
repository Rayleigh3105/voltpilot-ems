import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type { SchedulePlan } from './api';
import { chartTheme } from './chartTheme';

/**
 * The optimizer plan over the day-ahead price curve, on one shared time axis:
 * planned battery power as signed bars (green = charge, red = discharge; left
 * axis, kW), the price as a stepped line (right axis, EUR/MWh) so WHY the plan
 * charges/discharges is visible at a glance, and the planned SoC trajectory as
 * a subtle dashed line (hidden 0-100% axis, shown in the tooltip). A dashed
 * marker separates today from tomorrow at the local-midnight slot.
 */
export function ScheduleChart({ plan }: { plan: SchedulePlan }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const onResize = () => {
      chart.current?.resize();
      setRev((r) => r + 1); // re-render: legend rows depend on width
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const t = chartTheme();
    const slots = plan.slots;
    const times = slots.map((s) => s.start);
    const battery = slots.map((s) => (s.batteryKw == null ? null : Number(s.batteryKw)));
    const prices = slots.map((s) => (s.priceEurMwh == null ? null : Number(s.priceEurMwh)));
    const soc = slots.map((s) => (s.socPct == null ? null : Number(s.socPct)));

    // Index of the first slot on the actual local "tomorrow": the
    // today/tomorrow divider (same approach as the price chart).
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const boundaryIdx = slots.findIndex(
      (s) => new Date(s.start).toDateString() === tomorrow.toDateString(),
    );

    const kwAbs = battery.filter((v): v is number => v != null).map((v) => Math.abs(v));
    const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;

    chart.current.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: chart.current.getWidth() < 520 ? 72 : 44, right: 48, bottom: 28, left: 8, containLabel: true },
        legend: {
          top: 0,
          data: ['Laden/Entladen', 'Börsenpreis', 'Geplanter SoC'],
          textStyle: { color: t.axis },
        },
        tooltip: {
          trigger: 'axis',
          formatter: (params: any[]) => {
            const time = new Date(params[0]?.axisValue).toLocaleString('de-DE', {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            });
            const lines = [`<b>${time}</b>`];
            for (const p of params) {
              if (p.value == null) continue;
              const v = Number(p.value);
              if (p.seriesName === 'Laden/Entladen') {
                const label = v >= 0 ? 'Laden' : 'Entladen';
                lines.push(`${p.marker} ${label}: ${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`);
              } else if (p.seriesName === 'Börsenpreis') {
                lines.push(`${p.marker} Preis: ${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} EUR/MWh (${(v / 10).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ct/kWh)`);
              } else if (p.seriesName === 'Geplanter SoC') {
                lines.push(`${p.marker} SoC: ${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`);
              }
            }
            return lines.join('<br/>');
          },
        },
        xAxis: {
          type: 'category',
          data: times,
          axisLabel: {
            formatter: (v: string) =>
              new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            color: t.axis,
          },
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
            name: 'Laden/Entladen',
            type: 'bar',
            yAxisIndex: 0,
            data: battery,
            barCategoryGap: '10%',
            itemStyle: {
              borderRadius: 2,
              color: (p: any) => (Number(p.value) >= 0 ? t.charge : t.discharge),
            },
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
            name: 'Geplanter SoC',
            type: 'line',
            yAxisIndex: 2,
            data: soc,
            smooth: true,
            symbol: 'none',
            lineStyle: { color: t.axis, width: 1.5, type: 'dashed' },
            itemStyle: { color: t.axis },
          },
        ],
      },
      true,
    );
  }, [plan, rev]);

  return <div ref={ref} className="vp-chart" />;
}
