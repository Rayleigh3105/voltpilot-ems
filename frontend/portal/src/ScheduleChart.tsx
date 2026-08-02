import { useMemo, useState } from 'react';
import type { SchedulePlan } from './api';
import { chartTheme } from './chartTheme';
import {
  chargeKind,
  CURTAIL_LEGEND_LABEL,
  defaultHiddenGroups,
  dutyTooltip,
  forecastLines,
  hasCurtailment,
  hasGridCharge,
  hiddenLabels,
  LOAD_FORECAST_LABEL,
  MEASURED_LOAD_LABEL,
  MEASURED_PV_LABEL,
  measuredLoadLine,
  measuredNote,
  measuredPvLine,
  needsPointMarkers,
  planInsightParts,
  powerAxisMax,
  PV_FORECAST_LABEL,
  SERIES_GROUPS,
  slotBarColor,
  slotDuty,
  SOC_LABEL,
  socRangeLine,
  toggleGroup,
  type SeriesGroup,
} from './schedule';
import { useEChart } from './useEChart';
import { ChartLegend, ChartInsight, type LegendItem } from './components/ChartExplain';
import './components/Fahrplan.css';

/**
 * The optimizer plan for the day, made obvious at a glance: planned battery
 * power as signed bars (grün = Laden aus Solarstrom, türkis = Laden aus dem
 * Netz, blau = Entladen; left axis, kW) directly over the day-ahead price
 * (stepped line, right axis, ct/kWh) so WHY the plan charges/discharges is
 * visible, plus the planned Ladestand (SoC) as a dashed line on its OWN
 * labelled right axis (0-100 %), so it can be read without hovering and never
 * looks like a negative power value. Grid-charge
 * slots are DERIVED per slot (charging while net-importing, see schedule.ts);
 * on an EEG site ("Nur Solarladen") the türkis color can never appear - the
 * chart itself is the proof that only solar is stored. Over the bars run the
 * two dotted FORECAST lines the plan was computed from (PV-Prognose orange,
 * Verbrauchsprognose blau, same kW axis as the bars) - they explain the plan
 * ("warum hält er abends? da liegt die Nachtlast"). Next to EACH of them runs its MEASURED twin
 * (solid, same colour - gepunktet = Prognose, durchgezogen = gemessen) for the
 * slots that already happened: "Verbrauch (gemessen)" makes the load forecast
 * error visible - the one that made a plant draw from the grid at night - and
 * "PV (gemessen)" does the same for the PV forecast while making the
 * Solarladen-Regel checkable (a charge bar may never exceed the measured PV
 * line). A slot the optimizer marked with an IN-SLOT DUTY says so in its
 * tooltip ("Vorhersage, kein fester Befehl - folgt dem gemessenen Verbrauch"):
 * the bar is what the plan expects, while the device tracks the measured house
 * resp. the measured surplus inside the quarter hour. Without a duty (or on an
 * older run) the tooltip stays silent - never a guessed marking.
 * A "Jetzt"-marker and a shaded past region separate what already
 * happened from what is still planned; a dashed line splits today from morgen.
 * The colour swatches + one-line takeaway below the canvas explain the diagram
 * in plain German (captain: the diagrams should be understandable instantly).
 *
 * SINCE THE FAHRPLAN REBUILD (Konzept vp-fahrplan-kunde-konzept §6.4, D4) the
 * DEFAULT is deliberately quiet: bars + price + Jetzt carry the core statement
 * („günstig laden, teuer entladen"), and the forecast/measured/SoC lines are
 * THREE layer switches instead of nine legend pills - seven series at once
 * (three of them blue) were only legible to their author, and the pills alone
 * cost 339 px on a phone. A layer the run cannot fill gets no switch at all.
 */

function ct(v: number | null): string {
  return v == null
    ? '-'
    : `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}

export function ScheduleChart({
  plan,
  peakTargetKw,
  onSlotClick,
  selectedIndex,
}: {
  plan: SchedulePlan;
  /**
   * U4 Lastspitzen overlay: when set (schedule.peakTargetKw), a red dashed
   * horizontal line marks the planned grid-import Ziel on the power axis, and
   * the axis grows to keep it in view. Absent = the plain Fahrplan (default).
   */
  peakTargetKw?: number | null;
  /**
   * "Warum"-layer tap target (the OptimizerPlanChart bar-click pattern,
   * widened to the whole plot column so idle slots are tappable too): called
   * with the tapped slot's index. Absent = the chart behaves exactly as
   * before (no click handling).
   */
  onSlotClick?: (index: number) => void;
  /** The selected slot to highlight (a solid marker line); null/absent = none. */
  selectedIndex?: number | null;
}) {
  const t = chartTheme();
  // D4: DREI Gruppen-Schalter statt neun Einzel-Pills, und der Default ist
  // ruhig - Balken + Preis + Jetzt tragen die Kernaussage „günstig laden,
  // teuer entladen"; Prognosen/Gemessen/Ladestand sind bewusste Schichten.
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<SeriesGroup>>(defaultHiddenGroups);
  // Memoised: `useEChart` depends on it, and a fresh Set per render would
  // re-draw the canvas on every render.
  const hidden = useMemo(() => hiddenLabels(hiddenGroups), [hiddenGroups]);
  const forecast = forecastLines(plan.slots);
  // The measured twins of the two forecasts, for the slots that already
  // happened - the gap to their dotted counterpart is the forecast error.
  const ist = measuredLoadLine(plan.slots);
  const istPv = measuredPvLine(plan.slots);

  // Which series are actually drawn = present in the run AND their layer is on.
  // Computed once so canvas, legend and axis can never disagree.
  const showPv = forecast.pv.present && !hidden.has(PV_FORECAST_LABEL);
  const showLoad = forecast.load.present && !hidden.has(LOAD_FORECAST_LABEL);
  const showIst = ist.present && !hidden.has(MEASURED_LOAD_LABEL);
  const showIstPv = istPv.present && !hidden.has(MEASURED_PV_LABEL);
  const showSoc = plan.slots.some((s) => s.socPct != null) && !hidden.has(SOC_LABEL);

  const ref = useEChart((chart, width) => {
    const narrow = width < 480;
    const slots = plan.slots;
    const target = peakTargetKw != null && peakTargetKw > 0 ? peakTargetKw : null;
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
    // The marker is only truthful while the plan actually covers "now": a
    // stale plan that ended hours ago must not draw a "Jetzt" line onto its
    // last bar (audit F2) - the page's staleness banner says so instead.
    const lastEndMs =
      slots.length > 0
        ? new Date(slots[slots.length - 1].start).getTime() + (plan.slotMinutes || 15) * 60_000
        : 0;
    const nowInPlan = nowIdx >= 0 && nowMs < lastEndMs;

    const kwAbs = battery.filter((v): v is number => v != null).map((v) => Math.abs(v));
    const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;
    // The forecast lines share the kW axis, so a 60-kW PV forecast must lift
    // the axis top - otherwise it would be clipped by a 15-kW battery scale.
    // Only VISIBLE lines count, so hiding one re-tightens the scale.
    const showPvLine = showPv;
    const showLoadLine = showLoad;
    const showIstLine = showIst;
    const showIstPvLine = showIstPv;
    const axisMax = powerAxisMax(
      kwMax, [forecast.pv, forecast.load, ist, istPv], hidden, target);

    // The plan's DATE belongs on the axis (audit F2): a plan from yesterday
    // rendered a pure 10:15 … 23:45 time axis and read as today. The first
    // label of every calendar day carries its date on a second line.
    const dayStarts = new Set<number>();
    let seenDay = '';
    slots.forEach((s, i) => {
      const day = new Date(s.start).toDateString();
      if (day !== seenDay) {
        dayStarts.add(i);
        seenDay = day;
      }
    });

    // The SoC line only gets an axis when the plan actually carries SoC AND
    // the customer switched the "Ladestand" layer on (D4).
    const hasSoc = showSoc;

    const markLineData: any[] = [];
    if (boundaryIdx > 0)
      markLineData.push({
        xAxis: boundaryIdx,
        lineStyle: { color: t.axis, type: 'dashed', width: 1.5 },
        label: { formatter: 'Morgen', color: t.axis, position: 'insideEndTop' },
      });
    if (nowInPlan)
      markLineData.push({
        xAxis: nowIdx,
        lineStyle: { color: t.price, type: 'solid', width: 2 },
        // rotate 0: an inside label on a vertical markLine otherwise renders
        // rotated along the line (the documented edge-label gotcha).
        label: { formatter: 'Jetzt', color: t.price, position: 'insideStartTop', rotate: 0 },
      });
    // U4: the peak-shaving Ziel as a horizontal red dashed line on the power axis.
    if (target != null)
      markLineData.push({
        yAxis: target,
        lineStyle: { color: t.discharge, type: 'dashed', width: 1.5 },
        label: {
          formatter: `Ziel Netzbezug ${Math.round(target)} kW`,
          color: t.discharge,
          position: 'insideEndTop',
        },
      });
    // "Warum"-layer selection highlight (the OptimizerPlanChart pattern).
    if (selectedIndex != null && selectedIndex >= 0 && selectedIndex < slots.length)
      markLineData.push({
        xAxis: selectedIndex,
        lineStyle: { color: t.plan, type: 'solid', width: 2 },
        // rotate 0: an inside label on a vertical markLine otherwise renders
        // rotated along the line (the documented edge-label gotcha).
        label: { formatter: 'Ausgewählt', color: t.plan, position: 'insideEndTop', rotate: 0 },
      });

    // Tap-to-explain: the whole plot column is a tap target (idle slots too),
    // via the zrender click + pixel→category conversion. Only wired when the
    // caller opts in - without onSlotClick the chart is byte-identical.
    const zr = chart.getZr();
    zr.off('click');
    if (onSlotClick) {
      zr.on('click', (e: { offsetX: number; offsetY: number }) => {
        const pt: [number, number] = [e.offsetX, e.offsetY];
        if (!chart.containPixel('grid', pt)) return;
        const idx = Math.round(Number(chart.convertFromPixel({ xAxisIndex: 0 }, pt[0])));
        if (Number.isFinite(idx) && idx >= 0 && idx < slots.length) onSlotClick(idx);
      });
    }

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
                const kind = chargeKind(
                  slots[p.dataIndex]?.batteryKw ?? null,
                  slots[p.dataIndex]?.gridKw ?? null,
                  slots[p.dataIndex]?.pvKw,
                  slots[p.dataIndex]?.curtailKw,
                );
                const label =
                  kind === 'netzladen'
                    ? 'lädt aus dem Netz'
                    : kind === 'solarladen'
                      ? 'lädt Solarstrom'
                      : kind === 'entladen'
                        ? 'entlädt'
                        : 'hält';
                const amt =
                  Math.abs(v) < 0.05
                    ? ''
                    : ` ${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
                lines.push(`${p.marker} Batterie ${label}${amt}`);
              } else if (p.seriesName === 'Börsenpreis') {
                lines.push(`${p.marker} Strompreis: ${ct(v)}`);
              } else if (
                p.seriesName === PV_FORECAST_LABEL ||
                p.seriesName === LOAD_FORECAST_LABEL ||
                p.seriesName === MEASURED_LOAD_LABEL ||
                p.seriesName === MEASURED_PV_LABEL
              ) {
                lines.push(
                  `${p.marker} ${p.seriesName}: ${v.toLocaleString('de-DE', {
                    maximumFractionDigits: 2,
                  })} kW`,
                );
              } else if (p.seriesName === 'Ladestand') {
                lines.push(`${p.marker} Ladestand: ${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`);
              }
            }
            if (batV != null && Math.abs(batV) > 0.05) {
              const kind = chargeKind(
                slots[params[0]?.dataIndex]?.batteryKw ?? null,
                slots[params[0]?.dataIndex]?.gridKw ?? null,
                slots[params[0]?.dataIndex]?.pvKw,
                slots[params[0]?.dataIndex]?.curtailKw,
              );
              lines.push(
                `<span style="color:${t.axis}">${
                  batV > 0
                    ? kind === 'netzladen'
                      ? 'Speichert günstigen Strom aus dem Netz'
                      : 'Speichert eigenen Solarstrom'
                    : 'Deckt den Verbrauch aus dem Speicher'
                }</span>`,
              );
            }
            // Duty-Vorschau (PR 4): in einem markierten Slot ist der Balken
            // eine Vorhersage - das Gerät folgt dort dem gemessenen Verbrauch
            // bzw. lädt nur den gemessenen Überschuss. Ohne Pflicht (oder auf
            // einem älteren Lauf) steht hier nichts - nie eine geratene
            // Markierung. Der Text ist eine Konstante aus schedule.ts: in
            // diesen HTML-Formatter darf nie ein dynamischer String.
            const duty = slotDuty(slots[params[0]?.dataIndex] ?? {});
            if (duty) {
              lines.push(`<span style="color:${t.axis}">${dutyTooltip(duty)}</span>`);
            }
            return lines.join('<br/>');
          },
        },
        xAxis: {
          type: 'category',
          data: times,
          axisLabel: {
            formatter: (v: string, index: number) => {
              const d = new Date(v);
              const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
              if (!dayStarts.has(index)) return time;
              return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}\n${time}`;
            },
            lineHeight: 15,
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
            // Discharge stays at battery scale; the top grows to keep the peak
            // Ziel visible when the Lastspitzen overlay is on.
            min: -Math.ceil(kwMax),
            max: Math.ceil(axisMax),
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
          // SoC axis (0-100 %) - VISIBLE on the right, offset behind the price
          // axis (audit F4: as a hidden axis over a signed kW scale the SoC
          // line sat below the 0-kW gridline and read as a negative value, and
          // touch users had no hover to decode it). Too narrow for a second
          // right axis => hidden again, and the SoC band is named in text
          // under the chart instead.
          {
            type: 'value',
            min: 0,
            max: 100,
            show: hasSoc && !narrow,
            position: 'right',
            offset: 44,
            splitLine: { show: false },
            axisLine: { show: true, lineStyle: { color: t.soc } },
            axisTick: { lineStyle: { color: t.soc } },
            axisLabel: { color: t.soc, formatter: '{value} %' },
          },
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
              color: (p: any) => {
                const slot = slots[p.dataIndex];
                const kind = slot
                  ? chargeKind(slot.batteryKw, slot.gridKw, slot.pvKw, slot.curtailKw)
                  : Number(p.value) >= 0
                    ? 'solarladen'
                    : 'entladen';
                return slotBarColor(kind, t);
              },
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
          // The two forecast INPUTS of the plan, on the SAME kW axis as the
          // bars: dotted + thin so they read as context, never as measured
          // values, and so they stay distinguishable from the solid price line
          // (which shares the blue family). An absent value is a GAP, never 0.
          ...(showPvLine
            ? [
                {
                  name: PV_FORECAST_LABEL,
                  type: 'line',
                  yAxisIndex: 0,
                  data: forecast.pv.values,
                  smooth: true,
                  symbol: 'none',
                  connectNulls: false,
                  z: 4,
                  lineStyle: { color: t.pv, width: 1.5, type: 'dotted' },
                  itemStyle: { color: t.pv },
                },
              ]
            : []),
          ...(showLoadLine
            ? [
                {
                  name: LOAD_FORECAST_LABEL,
                  type: 'line',
                  yAxisIndex: 0,
                  data: forecast.load.values,
                  smooth: true,
                  symbol: 'none',
                  connectNulls: false,
                  z: 4,
                  lineStyle: { color: t.load, width: 1.5, type: 'dotted' },
                  itemStyle: { color: t.load },
                },
              ]
            : []),
          // The MEASURED PV - same colour as its forecast (same quantity) but
          // SOLID, so the pair reads as "geplant vs. wirklich". Drawn UNDER the
          // measured consumption (lower z) but over the bars, so a charge bar
          // exceeding the measured PV stays visible - that is the
          // Solarladen-Regel made checkable.
          ...(showIstPvLine
            ? [
                {
                  name: MEASURED_PV_LABEL,
                  type: 'line',
                  yAxisIndex: 0,
                  data: istPv.values,
                  smooth: false,
                  symbol: 'circle',
                  symbolSize: 5,
                  showSymbol: needsPointMarkers(istPv),
                  connectNulls: false,
                  z: 5,
                  lineStyle: { color: t.pv, width: 2 },
                  itemStyle: { color: t.pv },
                },
              ]
            : []),
          // P3: the MEASURED consumption - same colour as its forecast (same
          // quantity) but SOLID and a touch thicker, so the pair reads as
          // "geplant vs. wirklich" and the gap between them is the message.
          // An MPC plan usually has only one or two past slots, so a stroke
          // alone would be invisible - point markers then carry the value.
          ...(showIstLine
            ? [
                {
                  name: MEASURED_LOAD_LABEL,
                  type: 'line',
                  yAxisIndex: 0,
                  data: ist.values,
                  smooth: false,
                  symbol: 'circle',
                  symbolSize: 5,
                  showSymbol: needsPointMarkers(ist),
                  connectNulls: false,
                  z: 5,
                  lineStyle: { color: t.load, width: 2 },
                  itemStyle: { color: t.load },
                },
              ]
            : []),
          ...(hasSoc
            ? [
                {
                  name: SOC_LABEL,
                  type: 'line',
                  yAxisIndex: 2,
                  data: soc,
                  smooth: true,
                  symbol: 'none',
                  z: 1,
                  lineStyle: { color: t.soc, width: 1.5, type: 'dashed' },
                  itemStyle: { color: t.soc },
                },
              ]
            : []),
        ],
      },
      true,
    );
    // `forecast`/`ist` are derived from `plan`, so `plan` covers them.
  }, [plan, t, peakTargetKw, onSlotClick, selectedIndex, hidden]);

  // Insight: charge cheap, discharge expensive, and today's saving - composed
  // by the pure builder so the "flat curve" clause can never contradict a
  // visibly cycling plan (audit F3).
  const insight = planInsightParts(plan.slots, new Date());
  // The planned SoC band in words - the readable fallback wherever the SoC
  // axis has no room (phones) and the touch-friendly answer to "how full?".
  const socLine = socRangeLine(plan.slots);

  // The türkis entry appears only when the plan actually charges from the
  // grid: on an EEG site ("Nur Solarladen") the color never occurs, and the
  // legend must not advertise it - no türkis = provably no Netzstrom stored.
  const gridCharging = hasGridCharge(plan.slots);
  // Same discipline for the orange curtailment colour of the phase band above
  // the chart: it gets a legend row only when the plan really holds PV back.
  const curtailing = hasCurtailment(plan.slots);
  // The DEFAULT legend is one calm line: the bar colours + the price. Nothing
  // here is a toggle - the bar entries are per-slot STATES of ONE series, and
  // the layers are switched by the three group buttons above (D4).
  const legend: LegendItem[] = [
    { color: t.charge, label: 'Laden aus Solarstrom', unit: 'kW', shape: 'bar', toggleable: false },
    ...(gridCharging
      ? [{ color: t.gridCharge, label: 'Laden aus dem Netz (günstig)', unit: 'kW', shape: 'bar', toggleable: false } as LegendItem]
      : []),
    { color: t.battDischarge, label: 'Entladen (teurer Strom)', unit: 'kW', shape: 'bar', toggleable: false },
    ...(curtailing
      ? [{ color: t.pv, label: CURTAIL_LEGEND_LABEL, unit: 'kW', shape: 'bar', toggleable: false } as LegendItem]
      : []),
    { color: t.price, label: 'Börsen-Strompreis', unit: 'ct/kWh', shape: 'line', toggleable: false },
    ...(peakTargetKw != null && peakTargetKw > 0
      ? [{ color: t.discharge, label: 'Ziel Netzbezug (Lastspitze)', unit: 'kW', shape: 'dashed', toggleable: false } as LegendItem]
      : []),
    // ...plus exactly the rows of the layers that are switched ON, so the
    // legend never advertises a line the chart does not draw.
    ...(showPv
      ? [{ color: t.pv, label: PV_FORECAST_LABEL, unit: 'kW', shape: 'dotted', toggleable: false } as LegendItem]
      : []),
    ...(showLoad
      ? [{ color: t.load, label: LOAD_FORECAST_LABEL, unit: 'kW', shape: 'dotted', toggleable: false } as LegendItem]
      : []),
    // The measured twins sit next to their forecast (gepunktet = Prognose,
    // durchgezogen = gemessen), so the pairing is obvious.
    ...(showIstPv
      ? [{ color: t.pv, label: MEASURED_PV_LABEL, unit: 'kW', shape: 'line', toggleable: false } as LegendItem]
      : []),
    ...(showIst
      ? [{ color: t.load, label: MEASURED_LOAD_LABEL, unit: 'kW', shape: 'line', toggleable: false } as LegendItem]
      : []),
    ...(showSoc
      ? [{ color: t.soc, label: 'Ladestand des Speichers', unit: '%', shape: 'dashed', toggleable: false } as LegendItem]
      : []),
  ];

  // The three layer switches. A group whose series the plan does not carry is
  // NOT offered - a switch that can only ever show nothing is worse than none.
  const gemessenAvailable = ist.present || istPv.present;
  const groupAvailable: Record<SeriesGroup, boolean> = {
    prognosen: forecast.pv.present || forecast.load.present,
    gemessen: gemessenAvailable,
    ladestand: plan.slots.some((s) => s.socPct != null),
  };
  // ...and when a measured twin is absent although the plan already has past
  // slots AND draws that forecast, say WHY instead of leaving a silent gap
  // (never a 0-line, and never a claim about a channel the plan has no
  // forecast for).
  // ...but only where the absence is really news: while the layer is ON (a
  // twin is missing next to a drawn one), or when there is NOTHING measured at
  // all - then the missing SWITCH is what needs explaining. Silent in between:
  // a line nobody asked to see is not a gap worth a sentence.
  const istNote =
    hiddenGroups.has('gemessen') && gemessenAvailable
      ? null
      : measuredNote(plan.slots, new Date(), plan.slotMinutes || 15);

  return (
    <div>
      <div className="vp-sched-layers" role="group" aria-label="Zusätzliche Schichten">
        {SERIES_GROUPS.filter((g) => groupAvailable[g.id]).map((g) => {
          const on = !hiddenGroups.has(g.id);
          return (
            <button
              key={g.id}
              type="button"
              className={`vp-sched-layer${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => setHiddenGroups((cur) => toggleGroup(cur, g.id))}
            >
              {on ? g.label : `+ ${g.label}`}
            </button>
          );
        })}
      </div>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart tall" />
      {istNote && (
        <p className="vp-note vp-plan-ist" style={{ margin: 'var(--vp-space-2) 0 0' }}>
          {istNote}
        </p>
      )}
      {socLine && (
        <p className="vp-note vp-plan-soc" style={{ margin: 'var(--vp-space-2) 0 0' }}>
          {socLine}
        </p>
      )}
      {insight && (
        <ChartInsight>
          {insight.map((part, i) =>
            part.strong ? <strong key={i}>{part.text}</strong> : <span key={i}>{part.text}</span>,
          )}
        </ChartInsight>
      )}
    </div>
  );
}
