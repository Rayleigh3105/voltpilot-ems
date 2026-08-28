import { BAR, ghostBar, ghostItem, ghostLine, storageBar, STROKE } from '../../chartStyle';
import { LADESTAND, vergleichName } from '../../chartCopy';
import { chartTheme } from '../../chartTheme';
import { chargeKind, slotBarMark } from '../../schedule';
import { useEChart } from '../../useEChart';
import { ChartLegend, type LegendItem } from '../../components/ChartExplain';
import type { WhatIfResult } from '../../optimizerApi';

/**
 * Wie die GEISTER-Ebene dieser Fläche heißt (M9). Das Gegenstück ist hier kein
 * Zeitraum, sondern der Stand, wie er konfiguriert IST — deshalb wird er
 * benannt statt datiert, aber über dasselbe `chartCopy`-Wort wie jede andere
 * Überlagerung: „blass gestrichelt" soll auf jeder Fläche dasselbe bedeuten.
 */
const BASELINE_NAME = vergleichName('aktuelle Einstellungen');

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
 *
 * Seit Stufe 6 ist diese Baseline die GEISTER-EBENE des Hauses
 * (`chartStyle.GHOST`): dieselbe Kontext-Stärke, dieselbe Strichelung und
 * dasselbe Alpha wie die Vergleichsperiode der Messwerte- und der Erlöse-Welt.
 * Sie war vorher heller (0,55 / 0,6) und las sich damit fast als zweiter,
 * gleichrangiger Plan — genau das ist eine Geister-Ebene nicht.
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

      /** Die Lade-Art EINES Balkens - `chargeKind` ist die eine Ableitung. */

      const kindOf = (p: { dataIndex: number; value: number | null }) => {

        const slot = slots[p.dataIndex];

        if (slot) return chargeKind(slot.batteryKw, slot.gridKw, slot.pvKw, slot.curtailKw);

        return Number(p.value) >= 0 ? ('solarladen' as const) : ('entladen' as const);

      };


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
            axisTick: { show: false },
            axisLine: { show: false },
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
              name: BASELINE_NAME,
              type: 'bar',
              yAxisIndex: 0,
              data: baselineBattery,
              barCategoryGap: BAR.categoryGap,
              barMaxWidth: BAR.maxWidth,
              barGap: '-100%',
              z: 1,
              silent: true,
              // M9: dieselbe Geister-Grammatik wie die Vergleichs-Overlays der
              // Kundenflächen - eine Baseline ist ein Vergleich, kein zweiter
              // gleichrangiger Plan. Vorher 0,55 (Balken) / 0,6 (Linie).
              itemStyle: ghostBar(t.axis),
            },
            {
              name: 'Ihre Regler',
              type: 'bar',
              yAxisIndex: 0,
              // Dieselbe Speicher-Sprache wie im Kunden-Fahrplan: Grün lädt,
              // Beere entlädt. Bis Stufe 1 malte dieser Chart das Entladen
              // im Kosten-ROT und widersprach damit jeder anderen Flaeche. Der
              // Stil haengt am DATENELEMENT (siehe `storageItemStyle`).
              data: variantBattery.map((v, i) =>
                storageBar(v, slotBarMark(kindOf({ dataIndex: i, value: v }), t), t.surface),
              ),
              barCategoryGap: BAR.categoryGap,
              barMaxWidth: BAR.maxWidth,
              z: 3,

            },
            {
              name: `${LADESTAND} · Ihre Regler`,
              type: 'line',
              yAxisIndex: 1,
              data: variantSoc,
              showSymbol: false,
              connectNulls: false,
              z: 5,
              lineStyle: { color: t.soc, width: STROKE.context },
              itemStyle: { color: t.soc },
            },
            {
              name: `${LADESTAND} · ${BASELINE_NAME}`,
              type: 'line',
              yAxisIndex: 1,
              data: baselineSoc,
              showSymbol: false,
              connectNulls: false,
              z: 4,
              lineStyle: ghostLine(t.soc),
              itemStyle: ghostItem(t.soc),
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
    { label: 'Ihre Regler · Entladen', color: t.battDischarge, shape: 'bar', toggleable: false },
    { label: BASELINE_NAME, color: t.axis, shape: 'outline', toggleable: false },
    { label: `${LADESTAND} · Ihre Regler`, color: t.soc, unit: '%', shape: 'line', toggleable: false },
    { label: `${LADESTAND} · ${BASELINE_NAME}`, color: t.soc, unit: '%', shape: 'dashed', toggleable: false },
  ];

  return (
    <>
      {/* Legende einheitlich UEBER dem Canvas - dies war die einzige Flaeche
          im Portal, die sie darunter setzte (direkt neben dem Nachbar-Chart
          derselben Seite, der sie oben trug). */}
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart" />
    </>
  );
}
