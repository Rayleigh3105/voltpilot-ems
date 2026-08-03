import { chartTheme } from '../../chartTheme';
import { chargeKind } from '../../schedule';
import { useEChart } from '../../useEChart';
import { ChartLegend, type LegendItem } from '../../components/ChartExplain';
import type { WhatIfResult } from '../../optimizerApi';

/**
 * The what-if comparison: the SAME horizon planned twice, drawn once.
 *
 * Deliberately its OWN chart rather than a second `OptimizerPlanChart`: that
 * one answers "what did the run in force do and why" over a single plan, this
 * one answers "what does the knob change". Everything below it is nonetheless
 * the page's existing chart machinery - `useEChart` (container ResizeObserver
 * + width-aware layout), `chartTheme()` for the `--vp-chart-*` tokens,
 * `chargeKind` for the solarladen/netzladen/entladen colouring, `ChartLegend`
 * for the HTML legend - so the two charts read as one surface.
 *
 * Reading it: the SOLID bars are the variant (the knobs you moved), the pale
 * outline behind them the baseline (the site as configured). Where only pale
 * shows, the change removed a movement; where only solid shows, it added one.
 * The two SoC lines carry the same solid/dashed distinction.
 */
export function WhatIfCompareChart({ result }: { result: WhatIfResult }) {
  const t = chartTheme();

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 520;
      const slots = result.variant.slots;
      const base = result.baseline.slots;
      const times = slots.map((s) => s.time);
      const num = (v: number | null | undefined) => (v == null ? null : Number(v));

      const variantBattery = slots.map((s) => num(s.batteryKw));
      const baselineBattery = base.map((s) => num(s.batteryKw));
      const variantSoc = slots.map((s) => num(s.socPct));
      const baselineSoc = base.map((s) => num(s.socPct));

      const kwAbs = [...variantBattery, ...baselineBattery]
        .filter((v): v is number => v != null)
        .map((v) => Math.abs(v));
      const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 28, right: narrow ? 12 : 44, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: { dataIndex?: number }[]) => {
              const idx = params[0]?.dataIndex ?? 0;
              const v = slots[idx];
              const b = base[idx];
              if (!v) return '';
              const time = new Date(v.time).toLocaleString('de-DE', {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
              });
              const kw = (x: number | null) =>
                x == null ? '—' : `${x.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
              const pct = (x: number | null) =>
                x == null ? '—' : `${x.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`;
              return [
                `<b>${time} Uhr</b>`,
                `Ihre Regler: ${kw(num(v.batteryKw))} · SoC ${pct(num(v.socPct))}`,
                `Gespeichert: ${kw(num(b?.batteryKw))} · SoC ${pct(num(b?.socPct))}`,
              ].join('<br/>');
            },
          },
          xAxis: {
            type: 'category',
            data: times,
            axisLabel: {
              formatter: (v: string) =>
                new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
              color: t.axis,
              hideOverlap: true,
            },
            axisLine: { lineStyle: { color: t.axisLine } },
          },
          yAxis: [
            {
              type: 'value',
              name: narrow ? 'kW' : 'Batterie (kW)',
              nameTextStyle: { color: t.axis, align: 'left' },
              nameGap: 12,
              min: -Math.ceil(kwMax),
              max: Math.ceil(kwMax),
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis },
            },
            { type: 'value', min: 0, max: 100, show: false },
          ],
          series: [
            {
              // The baseline sits BEHIND as a pale outline: it is context for
              // the variant, never a second thing to read at equal weight.
              name: 'Aktuelle Einstellungen',
              type: 'bar',
              yAxisIndex: 0,
              data: baselineBattery,
              barCategoryGap: '8%',
              barGap: '-100%',
              z: 1,
              silent: true,
              itemStyle: {
                borderRadius: 1,
                color: 'transparent',
                borderColor: t.axis,
                borderWidth: 1,
                opacity: 0.55,
              },
            },
            {
              name: 'Ihre Regler',
              type: 'bar',
              yAxisIndex: 0,
              data: variantBattery,
              barCategoryGap: '8%',
              z: 3,
              itemStyle: {
                borderRadius: 2,
                color: (p: { dataIndex: number; value: number | null }) => {
                  const slot = slots[p.dataIndex];
                  const kind =
                    slot && chargeKind(slot.batteryKw, slot.gridKw, slot.pvKw, slot.curtailKw);
                  if (kind === 'netzladen') return t.gridCharge;
                  return Number(p.value) >= 0 ? t.charge : t.discharge;
                },
              },
            },
            {
              name: 'Ladestand (Regler)',
              type: 'line',
              yAxisIndex: 1,
              data: variantSoc,
              showSymbol: false,
              connectNulls: false,
              z: 5,
              lineStyle: { color: t.soc, width: 1.6 },
              itemStyle: { color: t.soc },
            },
            {
              name: 'Ladestand (aktuell)',
              type: 'line',
              yAxisIndex: 1,
              data: baselineSoc,
              showSymbol: false,
              connectNulls: false,
              z: 4,
              lineStyle: { color: t.soc, width: 1.2, type: 'dashed', opacity: 0.6 },
              itemStyle: { color: t.soc },
            },
          ],
          legend: { show: false },
          animation: false,
        },
        true,
      );
    },
    [result],
  );

  const legend: LegendItem[] = [
    { label: 'Ihre Regler · Solarladen', color: t.charge, shape: 'bar', toggleable: false },
    { label: 'Ihre Regler · Netzladen', color: t.gridCharge, shape: 'bar', toggleable: false },
    { label: 'Ihre Regler · Entladen', color: t.discharge, shape: 'bar', toggleable: false },
    { label: 'Aktuelle Einstellungen (Umriss)', color: t.axis, shape: 'bar', toggleable: false },
    { label: 'Ladestand', color: t.soc, unit: '%', shape: 'line', toggleable: false },
  ];

  return (
    <>
      <div ref={ref} className="vp-chart" />
      <ChartLegend items={legend} />
    </>
  );
}
