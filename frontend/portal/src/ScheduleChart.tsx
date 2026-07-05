import type { SchedulePlan } from './api';
import { chartTheme } from './chartTheme';
import { useEChart } from './useEChart';
import { ChartLegend, ChartInsight, type LegendItem } from './components/ChartExplain';

/**
 * The optimizer plan for the day, made obvious at a glance: planned battery
 * power as signed bars (grün = laden, rot = entladen; left axis, kW) directly
 * over the day-ahead price (stepped line, right axis, ct/kWh) so WHY the plan
 * charges/discharges is visible, plus the planned Ladestand (SoC) as a dashed
 * line. A "Jetzt"-marker and a shaded past region separate what already
 * happened from what is still planned; a dashed line splits today from morgen.
 * The colour swatches + one-line takeaway below the canvas explain the diagram
 * in plain German (captain: the diagrams should be understandable instantly).
 */

/** Weighted-average ct/kWh over the slots where `weight(slot)` is positive. */
function weightedCt(
  slots: SchedulePlan['slots'],
  weight: (batteryKw: number) => number,
): number | null {
  let num = 0;
  let den = 0;
  for (const s of slots) {
    if (s.batteryKw == null || s.priceEurMwh == null) continue;
    const w = weight(Number(s.batteryKw));
    if (w <= 0) continue;
    num += w * (Number(s.priceEurMwh) / 10);
    den += w;
  }
  return den > 0 ? num / den : null;
}

function ct(v: number | null): string {
  return v == null
    ? '-'
    : `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}

function eur(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function ScheduleChart({ plan }: { plan: SchedulePlan }) {
  const t = chartTheme();

  const ref = useEChart((chart, width) => {
    const narrow = width < 480;
    const slots = plan.slots;
    const times = slots.map((s) => s.start);
    const battery = slots.map((s) => (s.batteryKw == null ? null : Number(s.batteryKw)));
    // Price shown in ct/kWh (the unit on the customer's bill), not EUR/MWh.
    const pricesCt = slots.map((s) => (s.priceEurMwh == null ? null : Number(s.priceEurMwh) / 10));
    const soc = slots.map((s) => (s.socPct == null ? null : Number(s.socPct)));

    // today/tomorrow divider: first slot on the local "tomorrow".
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const boundaryIdx = slots.findIndex(
      (s) => new Date(s.start).toDateString() === tomorrow.toDateString(),
    );

    // "Jetzt": the last slot whose start is at/before now (past is shaded).
    const nowMs = Date.now();
    let nowIdx = -1;
    for (let i = 0; i < slots.length; i++) {
      if (new Date(slots[i].start).getTime() <= nowMs) nowIdx = i;
      else break;
    }

    const kwAbs = battery.filter((v): v is number => v != null).map((v) => Math.abs(v));
    const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;

    const markLineData: any[] = [];
    if (boundaryIdx > 0)
      markLineData.push({
        xAxis: boundaryIdx,
        lineStyle: { color: t.axis, type: 'dashed', width: 1.5 },
        label: { formatter: 'Morgen', color: t.axis, position: 'insideEndTop' },
      });
    if (nowIdx >= 0 && nowIdx < slots.length - 1)
      markLineData.push({
        xAxis: nowIdx,
        lineStyle: { color: t.price, type: 'solid', width: 2 },
        label: { formatter: 'Jetzt', color: t.price, position: 'insideStartTop' },
      });

    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: 30, right: narrow ? 16 : 52, bottom: 8, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          confine: true,
          formatter: (params: any[]) => {
            const time = new Date(params[0]?.axisValue).toLocaleString('de-DE', {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            });
            const lines = [`<b>${time} Uhr</b>`];
            let batV: number | null = null;
            for (const p of params) {
              if (p.value == null) continue;
              const v = Number(p.value);
              if (p.seriesName === 'Batterie') {
                batV = v;
                const label = v > 0.05 ? 'lädt' : v < -0.05 ? 'entlädt' : 'hält';
                const amt =
                  Math.abs(v) < 0.05
                    ? ''
                    : ` ${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
                lines.push(`${p.marker} Batterie ${label}${amt}`);
              } else if (p.seriesName === 'Börsenpreis') {
                lines.push(`${p.marker} Strompreis: ${ct(v)}`);
              } else if (p.seriesName === 'Ladestand') {
                lines.push(`${p.marker} Ladestand: ${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`);
              }
            }
            if (batV != null && Math.abs(batV) > 0.05) {
              lines.push(
                `<span style="color:${t.axis}">${batV > 0 ? 'Speichert günstigen Strom' : 'Deckt den Verbrauch aus dem Speicher'}</span>`,
              );
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
            hideOverlap: true,
          },
          axisLine: { lineStyle: { color: t.axisLine } },
        },
        yAxis: [
          {
            type: 'value',
            name: narrow ? 'kW' : 'Leistung (kW)',
            nameTextStyle: { color: t.axis, align: 'left' },
            nameGap: 12,
            min: -Math.ceil(kwMax),
            max: Math.ceil(kwMax),
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          {
            type: 'value',
            name: narrow ? 'ct/kWh' : 'Preis (ct/kWh)',
            nameTextStyle: { color: t.price, align: 'right' },
            nameGap: 12,
            position: 'right',
            splitLine: { show: false },
            axisLabel: { color: t.price, formatter: '{value}' },
          },
          // Hidden SoC axis (0-100%): the trajectory rides along, values in the tooltip.
          { type: 'value', min: 0, max: 100, show: false },
        ],
        series: [
          {
            name: 'Batterie',
            type: 'bar',
            yAxisIndex: 0,
            data: battery,
            barCategoryGap: '8%',
            z: 3,
            itemStyle: {
              borderRadius: 2,
              color: (p: any) => (Number(p.value) >= 0 ? t.charge : t.discharge),
            },
            // Shade the already-elapsed part of the day, and mark today|morgen + jetzt.
            markArea:
              nowIdx > 0
                ? {
                    silent: true,
                    itemStyle: { color: t.axis, opacity: 0.08 },
                    data: [[{ xAxis: 0 }, { xAxis: nowIdx }]],
                  }
                : undefined,
            markLine: markLineData.length
              ? { silent: true, symbol: 'none', data: markLineData }
              : undefined,
          },
          {
            name: 'Börsenpreis',
            type: 'line',
            yAxisIndex: 1,
            data: pricesCt,
            step: 'end',
            symbol: 'none',
            z: 2,
            lineStyle: { color: t.price, width: 2 },
            itemStyle: { color: t.price },
          },
          {
            name: 'Ladestand',
            type: 'line',
            yAxisIndex: 2,
            data: soc,
            smooth: true,
            symbol: 'none',
            z: 1,
            lineStyle: { color: t.soc, width: 1.5, type: 'dashed' },
            itemStyle: { color: t.soc },
          },
        ],
      },
      true,
    );
  }, [plan, t]);

  // Insight: charge cheap, discharge expensive, and today's saving.
  const chargeCt = weightedCt(plan.slots, (kw) => Math.max(kw, 0));
  const dischargeCt = weightedCt(plan.slots, (kw) => Math.max(-kw, 0));
  const today = new Date().toDateString();
  const savingsToday = plan.slots
    .filter((s) => new Date(s.start).toDateString() === today)
    .reduce((sum, s) => sum + ((s.baselineCostEur ?? 0) - (s.costEur ?? 0)), 0);

  const legend: LegendItem[] = [
    { color: t.charge, label: 'Laden (günstiger Strom)', unit: 'kW', shape: 'bar' },
    { color: t.discharge, label: 'Entladen (teurer Strom)', unit: 'kW', shape: 'bar' },
    { color: t.price, label: 'Börsen-Strompreis', unit: 'ct/kWh', shape: 'line' },
    { color: t.soc, label: 'Ladestand des Speichers', unit: '%', shape: 'dashed' },
  ];

  return (
    <div>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart tall" />
      {chargeCt != null && dischargeCt != null && (
        <ChartInsight>
          Der Speicher <strong>lädt günstig</strong> (Ø {ct(chargeCt)}) und{' '}
          <strong>entlädt teuer</strong> (Ø {ct(dischargeCt)}), um den Abendverbrauch zu decken -{' '}
          {savingsToday > 0.005 ? (
            <>
              das spart heute rund <strong>{eur(savingsToday)}</strong> gegenüber einem Betrieb
              ohne Speicher.
            </>
          ) : (
            <>bei flachem Preisverlauf bleibt der Speicher überwiegend in Ruhe.</>
          )}
        </ChartInsight>
      )}
    </div>
  );
}
