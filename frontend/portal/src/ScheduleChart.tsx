import { useMemo, useState } from 'react';
import type { SchedulePlan } from './api';
import {
  AXIS,
  BAR,
  dayBoundaryStyle,
  FILL,
  FORECAST,
  NARROW_PX,
  nowLabel,
  nowLineStyle,
  PANELS,
  SMOOTH_SERIES,
  storageBar,
  STROKE,
} from './chartStyle';
import { AXIS as AXIS_NAME, BEZUGSPREIS, BOERSENPREIS, EINSPEISEWERT, SPANNE } from './chartCopy';
import { chartTheme } from './chartTheme';
import { escHtml, kopf, notizZeile, tooltip, wertZeile } from './chartTooltip';
import {
  chargeKind,
  curtailArea,
  CURTAIL_AREA_LABEL,
  curtailBandLabel,
  CURTAIL_LEGEND_LABEL,
  curtailSpans,
  curtailTickData,
  curtailTooltip,
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
  planKernaussage,
  powerAxisMax,
  priceSpread,
  PV_FORECAST_LABEL,
  SERIES_GROUPS,
  slotAktionSatz,
  slotBarMark,
  type PlanWordingKind,
  slotDuty,
  SOC_LABEL,
  socRangeLine,
  toggleGroup,
  type SeriesGroup,
} from './schedule';
import { useEChart } from './useEChart';
import {
  ChartHeadline,
  ChartLegend,
  ChartInsight,
  type LegendItem,
} from './components/ChartExplain';
import { chartDetailKey } from './useChartDetail';
import { consumerShade, type ConsumerLayer } from './consumerSchedule';
import './components/Fahrplan.css';

/**
 * Der Fahrplan ist seit dem Chart-Redesign Stufe 2 ein ZWEI-PANEL-BILD: EIN
 * ECharts-Objekt, zwei Plotflächen über EINER Zeitachse, EIN Fadenkreuz
 * (`axisPointer.link`) und die „Jetzt"-Fahne genau EINMAL an der Achse (K9).
 *
 * OBEN das flache PREIS-Panel: Bezugspreis und Einspeisewert je Viertelstunde
 * als Stufenlinien-Paar, dazwischen das zarte SPANNENBAND (M4) mit seinem
 * Namensschild im Bild (K10) - die Spanne IST der Grund fürs Laden und
 * Entladen. Fehlen die zwei Größen (älterer Lauf), steht dort ehrlich der
 * nackte Börsenpreis; fehlt auch der, entfällt das Panel ganz statt eine leere
 * Fläche zu behaupten.
 *
 * UNTEN das LEISTUNGS-Panel: der Speicher als Säulenstäbe in EINER Farbe (K5 -
 * gefüllt = lädt, Umriss = gibt ab, Wort in der Legende; türkis nur, wenn der
 * Plan wirklich aus dem Netz lädt, sodass „kein Türkis" der sichtbare
 * EEG-Beweis bleibt), die Sonne als Kontextkurve, der Verbraucher-Stapel, der
 * Ladestand als beschriftete Miniskala rechts (die eine geduldete
 * F8-Ausnahme) und das orange Abregel-Band MIT seinem Wort (K5: Farbe nie
 * allein).
 *
 * WARUM zwei Panels (F8 verschärft, r2 §4/§6 B): die frühere Preis-Rechtsachse
 * im selben Bild war die Ursache des Dual-Axis-Fehllesens UND zweier
 * gemessener Farb-Kollisionen - Grün×Grün (Ladebalken in kW gegen
 * Einspeisewert in ct) und Blau×Blau (Verbrauchslinie gegen Preislinie, ΔE 1,3
 * auf der Linien-Stufe). Der Panel-Schnitt löst beide STRUKTURELL auf, statt
 * sie umzufärben - und weil der Preis das Leistungs-Panel verlassen hat, darf
 * der Verbrauch jetzt seine dunklere Linien-Stufe `loadLine` tragen (F2), die
 * ihn zugleich vom Netzladen-Türkis trennt (ΔE 10,9 → 18,3).
 *
 * Über den Balken laufen die zwei gepunkteten PROGNOSE-Linien, mit denen der
 * Plan gerechnet hat, und daneben je ihr GEMESSENER Zwilling (durchgezogen,
 * gleiche Farbe je Größe): „Verbrauch (gemessen)" macht den Prognosefehler
 * sichtbar, der eine Anlage nachts ans Netz brachte, „PV (gemessen)" dasselbe
 * für die Sonne - und damit die Solarladen-Regel prüfbar (ein Ladebalken darf
 * diese Linie nie überragen). Ein Slot mit einer IN-SLOT-PFLICHT sagt das im
 * Tooltip; ohne Pflicht (oder auf einem älteren Lauf) steht dort nichts - nie
 * eine geratene Markierung.
 *
 * Der Grundzustand bleibt bewusst ruhig (D4): Balken + Preis-Panel + Jetzt
 * tragen die Kernaussage, Prognosen/Gemessen/Ladestand sind DREI benannte
 * Schichten statt neun Legenden-Pills. Eine Schicht, die der Lauf nicht füllen
 * kann, bekommt gar keinen Schalter.
 */

/** Preis mit Einheit für den Tooltip. */
function ct(v: number | null): string {
  return v == null ? '-' : `${ctPlain(v)} ct/kWh`;
}

/** Nackte Preiszahl (eine Nachkommastelle) - für Namensschilder im Bild. */
function ctPlain(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function kw(v: number, digits = 2): string {
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: digits })} kW`;
}

/** A small padlock as an ECharts path symbol - the §14.11 Schloss marking. */
const LOCK_SYMBOL =
  'path://M6 8V6a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h1zm2 0h4V6a2 2 0 1 0-4 0v2z';

/** Der Speicherschlüssel der Fahrplan-Schichten (K3, pro Tab-Sitzung). */
const SCHED_GROUPS_KEY = chartDetailKey('fahrplan.schichten');

export function ScheduleChart({
  plan,
  peakTargetKw,
  onSlotClick,
  selectedIndex,
  consumers,
  plantKind,
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
   * before (no click handling). Beide Panels sind Tap-Ziel - sie teilen ihre
   * Zeitachse, also beantwortet ein Tipp im Preis-Panel dieselbe Frage.
   */
  onSlotClick?: (index: number) => void;
  /** The selected slot to highlight (a solid marker line); null/absent = none. */
  selectedIndex?: number | null;
  /**
   * Verbrauchssteuerung §14.11: the consumer layers of the newest
   * co-optimizer run, aligned to THIS plan's slot grid (consumerLayers()).
   * Positive stacked step-areas in shades of the ONE consumer hue; a
   * Pflichtfenster slot additionally carries a lock marker + the word in the
   * tooltip (never colour alone). Absent/empty = the chart is byte-identical
   * to the pre-consumer view.
   */
  consumers?: ConsumerLayer[];
  /**
   * K1: die Veräußerungsform der Anlage - sie entscheidet, ob der
   * Kernaussage-Satz „verkaufen" oder „nutzen" sagt. **Ohne sie wird KEIN Satz
   * gezeigt**: eine Direktvermarktungs-Anlage mit „nutzen" zu beschreiben wäre
   * ein falsch abgeleiteter Satz, und der ist schlimmer als keiner (r2 §10).
   */
  plantKind?: PlanWordingKind;
}) {
  const t = chartTheme();
  // D4: DREI Gruppen-Schalter statt neun Einzel-Pills, und der Default ist
  // ruhig - Balken + Preis + Jetzt tragen die Kernaussage „günstig laden,
  // teuer entladen"; Prognosen/Gemessen/Ladestand sind bewusste Schichten.
  // K3: der Grundzustand ist ruhig, die Tiefe liegt hinter den drei benannten
  // Schaltern. Ihr Zustand wird PRO TAB-SITZUNG gemerkt - wer die Prognosen
  // einmal aufgeklappt hat, findet sie beim Zurückspringen offen, und ein
  // neuer Tab beginnt wieder ruhig.
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<SeriesGroup>>(() => {
    try {
      const raw = sessionStorage.getItem(SCHED_GROUPS_KEY);
      if (raw == null) return defaultHiddenGroups();
      return new Set(raw ? (raw.split(',') as SeriesGroup[]) : []);
    } catch {
      return defaultHiddenGroups();
    }
  });
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

  // ---- Das PREIS-Panel (F8 verschärft + M4) --------------------------------
  // Das Spannenband braucht BEIDE Größen; ein älterer Lauf ohne sie fällt auf
  // den nackten Börsenpreis zurück, und ein Lauf ohne jeden Preis bekommt gar
  // kein Panel - eine leere Fläche wäre eine Behauptung.
  const spread = priceSpread(plan.slots);
  const hasSpot = plan.slots.some((s) => s.priceEurMwh != null);
  const showSpread = spread.present;
  const showSpot = !showSpread && hasSpot;
  const twoPanel = showSpread || showSpot;

  // The türkis entry appears only when the plan actually charges from the
  // grid: on an EEG site ("Nur Solarladen") the color never occurs, and the
  // legend must not advertise it - no türkis = provably no Netzstrom stored.
  const gridCharging = hasGridCharge(plan.slots);
  // DASSELBE Gate trägt ALLES Orange: Band, Sockel-Ticks, die gedrosselte
  // Fläche und die Legenden-Zeile (Scout `vp-pilsting-abregeln` Frage 4).
  // Es wird EINMAL hier berechnet und in die Canvas-Closure hineingereicht -
  // Legende und Canvas können damit nicht wieder auseinanderlaufen.
  const curtailing = hasCurtailment(plan.slots);
  // Die gedrosselte Menge gehört in die zuschaltbare Prognosen-Ebene: sie
  // erklärt, warum die PV-Prognose über dem Einspeise-Cap liegt.
  const curtail = curtailArea(plan.slots);
  const showCurtailArea = curtailing && curtail.present && !hidden.has(PV_FORECAST_LABEL);

  // §14.11 consumer layers (Verbrauchssteuerung Inkrement 2): only layers
  // that carry a value in THIS plan's grid draw anything - without them the
  // chart (series, legend, axis) is byte-identical to the pre-consumer view.
  const activeConsumers = (consumers ?? []).filter((l) => l.values.some((v) => v != null));
  const showConsumers = activeConsumers.length > 0;
  const anyPflicht = activeConsumers.some((l) =>
    l.pflicht.some((p, i) => p && (l.values[i] ?? 0) > 0.049),
  );

  const ref = useEChart((chart, width) => {
    const narrow = width < NARROW_PX;
    const slots = plan.slots;
    const target = peakTargetKw != null && peakTargetKw > 0 ? peakTargetKw : null;
    const times = slots.map((s) => s.start);
    const battery = slots.map((s) => (s.batteryKw == null ? null : Number(s.batteryKw)));
    // Price shown in ct/kWh (the unit on the customer's bill), not EUR/MWh.
    const pricesCt = slots.map((s) => (s.priceEurMwh == null ? null : Number(s.priceEurMwh) / 10));
    const soc = slots.map((s) => (s.socPct == null ? null : Number(s.socPct)));
    // Die Abregel-Geometrie kommt aus DEMSELBEN Gate wie die Legenden-Zeile
    // (`curtailing`, oben einmal berechnet) - ohne Abregelung entsteht hier
    // nichts, mit Abregelung entsteht Band UND Tick UND (in der
    // Prognosen-Ebene) Fläche.
    const curtailBands = curtailing ? curtailSpans(slots) : [];
    const curtailTicks = curtailing ? curtailTickData(slots) : [];
    // K5/K10: das Band trägt sein WORT im Bild, und zwar genau einmal - am
    // LÄNGSTEN Block. Ein Wort je Block wäre Rauschen (K6: höchstens drei
    // benannte Marken).
    const bandWord = curtailBandLabel(slots);
    let longestBand = -1;
    curtailBands.forEach((s, i) => {
      if (longestBand < 0 || s.to - s.from > curtailBands[longestBand].to - curtailBands[longestBand].from)
        longestBand = i;
    });

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
    // The consumer stack shares it too - its peak must lift the top.
    const consumerStackMax = showConsumers
      ? Math.max(
          0,
          ...slots.map((_s, i) => activeConsumers.reduce((sum, l) => sum + (l.values[i] ?? 0), 0)),
        )
      : 0;
    const axisMax = Math.max(
      powerAxisMax(kwMax, [forecast.pv, forecast.load, ist, istPv], hidden, target),
      consumerStackMax > 0 ? consumerStackMax * 1.1 : 0,
    );

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

    // The SoC line only gets its mini scale when the plan actually carries SoC
    // AND the customer switched the "Ladestand" layer on (D4).
    const hasSoc = showSoc;
    const socScale = hasSoc && !narrow;

    /* ---- Die zwei Plotflächen ------------------------------------------
     * ⚠ BEIDE Grids tragen denselben linken und rechten Rand - sonst lägen
     * ihre Zeitachsen nicht übereinander, und eine geteilte Zeitachse ist der
     * ganze Zweck des Umbaus. Deshalb feste Pixel statt `containLabel`.
     * Ohne Preisdaten schrumpft das Kopf-Panel auf null: die Indizes der
     * Achsen und Serien bleiben damit stabil, und es wird nichts Leeres
     * gezeichnet. */
    const left = narrow ? PANELS.leftNarrowPx : PANELS.leftPx;
    const right = socScale ? PANELS.rightWithSocPx : PANELS.rightPx;
    const grid = twoPanel
      ? [
          { left, right, top: PANELS.topPx, height: `${PANELS.headPct}%` },
          { left, right, top: `${PANELS.bodyTopPct}%`, bottom: PANELS.bottomPx },
        ]
      : [
          { left, right, top: 0, height: 0, show: false },
          { left, right, top: PANELS.topPx, bottom: PANELS.bottomPx },
        ];

    /* ---- Die Marken: Linie in BEIDEN Panels, das WORT genau EINMAL -------
     * Rev 1 hatte je Panel eine eigene Jetzt-Fahne, und die kollidierten mit
     * den Panel-Überschriften (r2 §6 A). K9: ein Zeit-Anker, ein Ort - die
     * Fahne steht unten an der Zeitachse, die Linie zieht durch beide
     * Flächen, damit das Fadenkreuz einen sichtbaren Anker hat. */
    const priceMarks: any[] = [];
    const powerMarks: any[] = [];
    if (boundaryIdx > 0) {
      // F6 (korrigiert): die Tagesgrenze ist eine REFERENZ, keine Prognose -
      // der Börsenpreis für morgen steht fest und bleibt durchgezogen.
      const dayLine = {
        xAxis: boundaryIdx,
        lineStyle: dayBoundaryStyle(t),
      };
      priceMarks.push({
        ...dayLine,
        label: {
          formatter: 'Morgen',
          color: t.axis,
          fontSize: AXIS.fontSize,
          position: 'insideEndTop',
          rotate: 0,
        },
      });
      powerMarks.push({ ...dayLine, label: { show: false } });
    }
    if (nowInPlan) {
      // F5: EINE Jetzt-Linie im ganzen Portal - dünn, gestrichelt, in Ink.
      const nowLine = { xAxis: nowIdx, lineStyle: nowLineStyle(t) };
      priceMarks.push({ ...nowLine, label: { show: false } });
      powerMarks.push({
        ...nowLine,
        // K9: der Zeit-Anker ist ein WORT mit seiner Uhrzeit, unten an der
        // Achse (`start` = das untere Ende einer senkrechten markLine). Der
        // deckende Grund hält die Fahne über den Balken lesbar; `rotate: 0`
        // ist Pflicht - sonst rendert ECharts sie GEDREHT entlang der Linie.
        label: {
          ...nowLabel(t, 'start'),
          formatter: `Jetzt ${new Date(slots[nowIdx].start).toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit',
          })}`,
          backgroundColor: t.surface,
          padding: [2, 4],
          borderRadius: 3,
          distance: PANELS.nowFlagDistancePx,
        },
      });
    }
    // U4: the peak-shaving Ziel as a horizontal red dashed line on the power axis.
    if (target != null)
      powerMarks.push({
        yAxis: target,
        lineStyle: { color: t.discharge, type: 'dashed', width: STROKE.ref },
        label: {
          formatter: `Ziel Netzbezug ${Math.round(target)} kW`,
          color: t.discharge,
          fontSize: AXIS.fontSize,
          position: 'insideEndTop',
          rotate: 0,
        },
      });
    // "Warum"-layer selection highlight (the OptimizerPlanChart pattern).
    if (selectedIndex != null && selectedIndex >= 0 && selectedIndex < slots.length) {
      const selLine = {
        xAxis: selectedIndex,
        lineStyle: { color: t.plan, type: 'solid', width: STROKE.context },
      };
      priceMarks.push({ ...selLine, label: { show: false } });
      powerMarks.push({
        ...selLine,
        label: {
          formatter: 'Ausgewählt',
          color: t.plan,
          fontSize: AXIS.fontSize,
          position: 'insideEndTop',
          rotate: 0,
        },
      });
    }

    /** Die Vergangenheits-Schattierung - je Panel einmal (F5, Hauch). */
    const pastArea =
      nowIdx > 0
        ? {
            silent: true,
            itemStyle: { color: t.axis, opacity: FILL.past },
            data: [[{ xAxis: 0 }, { xAxis: nowIdx }]],
          }
        : undefined;

    // Tap-to-explain: the whole plot column is a tap target (idle slots too),
    // via the zrender click + pixel→category conversion. Beide Panels teilen
    // die Zeitachse, also beantwortet ein Tipp oben dieselbe Frage wie unten.
    // Only wired when the caller opts in - without onSlotClick the chart is
    // byte-identical.
    const zr = chart.getZr();
    zr.off('click');
    if (onSlotClick) {
      zr.on('click', (e: { offsetX: number; offsetY: number }) => {
        const pt: [number, number] = [e.offsetX, e.offsetY];
        if (!chart.containPixel('grid', pt)) return;
        // Beide x-Achsen haben denselben linken/rechten Rand, also liefert
        // jede dieselbe Kategorie - die des Leistungs-Panels ist die, die es
        // immer gibt.
        const idx = Math.round(Number(chart.convertFromPixel({ xAxisIndex: 1 }, pt[0])));
        if (Number.isFinite(idx) && idx >= 0 && idx < slots.length) onSlotClick(idx);
      });
    }

    /* ---- Die Serien des PREIS-Panels ------------------------------------ */
    const priceSeries: any[] = [];
    if (showSpread) {
      // Das Band als gestapeltes Paar (die bewährte echarts-Technik, dieselbe
      // wie bei der gedrosselten Menge unten): die untere Kante trägt das
      // Minimum unsichtbar, die obere die Höhe mit der Füllung - so liegt die
      // Fläche exakt zwischen den zwei Linien, auch bei Lücken.
      priceSeries.push(
        {
          name: 'Spannen-Basis',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: spread.base,
          stack: 'vp-spanne',
          step: 'end',
          symbol: 'none',
          connectNulls: false,
          silent: true,
          z: 1,
          lineStyle: { opacity: 0 },
          itemStyle: { color: t.price },
          tooltip: { show: false },
        },
        {
          name: SPANNE,
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: spread.delta,
          stack: 'vp-spanne',
          step: 'end',
          symbol: 'none',
          connectNulls: false,
          silent: true,
          z: 1,
          lineStyle: { opacity: 0 },
          itemStyle: { color: t.price },
          // F3-AUSNAHME: die Fläche TRÄGT hier die Aussage (die Spanne ist der
          // Grund fürs Laden), deshalb 0,14 statt 0,08 - und sie bekommt ihr
          // Namensschild im Bild (K10), nicht nur eine Legendenzeile.
          areaStyle: { color: t.price, opacity: FILL.band },
          tooltip: { show: false },
          markPoint:
            spread.widestIndex != null && spread.widestCt != null
              ? {
                  silent: true,
                  symbol: 'circle',
                  symbolSize: 0,
                  data: [
                    {
                      coord: [spread.widestIndex, spread.widestMidCt],
                      label: {
                        show: true,
                        formatter: `${SPANNE} ${ctPlain(spread.widestCt)} ct`,
                        color: t.price,
                        fontSize: AXIS.fontSize,
                        fontWeight: 600,
                        backgroundColor: t.surface,
                        padding: [2, 5],
                        borderRadius: 3,
                      },
                    },
                  ],
                }
              : undefined,
        },
        {
          // Der ruhigere Rand des Bands. Eigener Ton statt einer zweiten
          // Blau-Stufe: `flowGridLine` hält gegen das Preis-Blau ΔE 16,4
          // (normal) / 15,8 (Deutan) - zwei Stufen derselben Farbe lägen weit
          // darunter. Grün bleibt auf dieser Leinwand AUSSCHLIESSLICH der
          // Speicher (genau die Kollision, für die es diese Stufe gibt).
          name: EINSPEISEWERT,
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: spread.exportCt,
          step: 'end',
          symbol: 'none',
          connectNulls: false,
          z: 2,
          lineStyle: { color: t.flowGridLine, width: STROKE.context },
          itemStyle: { color: t.flowGridLine },
        },
        {
          // Die LEITSERIE des Panels (F1-Hierarchie): der Preis, mit dem der
          // Optimierer wirklich entscheidet.
          name: BEZUGSPREIS,
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: spread.importCt,
          step: 'end',
          symbol: 'none',
          connectNulls: false,
          z: 3,
          lineStyle: { color: t.price, width: STROKE.lead },
          itemStyle: { color: t.price },
        },
      );
    } else if (showSpot) {
      priceSeries.push({
        name: BOERSENPREIS,
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: pricesCt,
        step: 'end',
        symbol: 'none',
        z: 2,
        lineStyle: { color: t.price, width: STROKE.lead },
        itemStyle: { color: t.price },
      });
    }
    if (priceSeries.length) {
      priceSeries[0].markArea = pastArea;
      priceSeries[0].markLine = priceMarks.length
        ? { silent: true, symbol: 'none', data: priceMarks }
        : undefined;
    }

    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        // EIN Fadenkreuz über BEIDE Panels: das macht die geteilte Zeitachse
        // sichtbar (K9) - ohne die Verknüpfung wäre es zweimal dasselbe Bild
        // mit zwei unabhängigen Zeigern.
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        grid,
        tooltip: {
          trigger: 'axis',
          confine: true,
          /**
           * Der Tooltip wird aus dem SLOT-INDEX komponiert, nicht aus den
           * `params` des gerade überfahrenen Panels: bei zwei Grids liefert
           * ECharts nur die Serien DIESES Grids, und ein Ablesen, das oben
           * andere Zeilen zeigt als unten, wäre kein geteiltes Fadenkreuz.
           * So liest sich jede Viertelstunde überall gleich.
           */
          formatter: (params: any[]) => {
            const i = params?.[0]?.dataIndex;
            const s = slots[i];
            if (s == null) return '';
            const time = new Date(s.start).toLocaleString('de-DE', {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            });
            // K7: die HANDLUNG zuerst - der Satz beantwortet „was macht der
            // Speicher hier", die Zeilen darunter belegen ihn. Bis Stufe 5
            // stand dieselbe Aussage als LETZTE von neun Zeilen.
            const lines = [kopf(`${time} Uhr`), slotAktionSatz(s)].filter(
              (z): z is string => z != null,
            );
            const row = (color: string, text: string) => lines.push(wertZeile(color, text));

            // --- Preis-Panel
            if (showSpread) {
              const imp = spread.importCt[i];
              const exp = spread.exportCt[i];
              if (imp != null) row(t.price, `${BEZUGSPREIS}: ${ct(imp)}`);
              if (exp != null) row(t.flowGridLine, `${EINSPEISEWERT}: ${ct(exp)}`);
              if (imp != null && exp != null)
                lines.push(
                  notizZeile(t.axis, `${SPANNE}: ${ctPlain(Math.abs(imp - exp))} ct/kWh`),
                );
            } else if (showSpot) {
              const p = pricesCt[i];
              if (p != null) row(t.price, `${BOERSENPREIS}: ${ct(p)}`);
            }

            // --- Leistungs-Panel
            // Die Batterie hat KEINE eigene Wert-Zeile mehr: ihre Menge UND
            // ihre Quelle stehen schon im Satz oben (M10-Geist, keine
            // Doppel-Kolonne). Ihre FARBE trägt weiterhin das Balkenbild.
            if (showPv && forecast.pv.values[i] != null)
              row(t.pvLine, `${PV_FORECAST_LABEL}: ${kw(forecast.pv.values[i]!)}`);
            if (showIstPv && istPv.values[i] != null)
              row(t.pvLine, `${MEASURED_PV_LABEL}: ${kw(istPv.values[i]!)}`);
            if (showLoad && forecast.load.values[i] != null)
              row(t.loadLine, `${LOAD_FORECAST_LABEL}: ${kw(forecast.load.values[i]!)}`);
            if (showIst && ist.values[i] != null)
              row(t.loadLine, `${MEASURED_LOAD_LABEL}: ${kw(ist.values[i]!)}`);
            if (hasSoc && soc[i] != null)
              row(
                t.soc,
                `${SOC_LABEL}: ${soc[i]!.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`,
              );
            // Consumer names are customer-controlled -> escaped (XSS rule); an
            // off slot (0 kW) stays silent. The Pflicht word travels WITH the
            // value (never colour alone, §14.11).
            activeConsumers.forEach((layer, li) => {
              const v = layer.values[i];
              if (v == null || v <= 0.049) return;
              const pflicht = layer.pflicht[i] ? ' · Pflichtfenster (fest)' : '';
              row(
                consumerShade(t.consumer, li),
                `${escHtml(layer.name)}: ${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW${pflicht}`,
              );
            });

            // Duty-Vorschau (PR 4): in einem markierten Slot ist der Balken
            // eine Vorhersage - das Gerät folgt dort dem gemessenen Verbrauch
            // bzw. lädt nur den gemessenen Überschuss. Ohne Pflicht (oder auf
            // einem älteren Lauf) steht hier nichts - nie eine geratene
            // Markierung. Der Text ist eine Konstante aus schedule.ts: in
            // diesen HTML-Formatter darf nie ein dynamischer String.
            const duty = slotDuty(s);
            if (duty) lines.push(notizZeile(t.axis, dutyTooltip(duty)));
            // Abregeln nennt seine MENGE und den Cap - sonst bliebe der orange
            // Slot eine Farbe ohne Zahl. `curtailTooltip` setzt den Satz aus
            // Konstanten + formatierten Zahlen zusammen (XSS-Regel der
            // Chart-Formatter); null = dieser Slot regelt nicht ab.
            const curtailLine = curtailTooltip(s);
            if (curtailLine) lines.push(notizZeile(t.pv, curtailLine));
            return tooltip(...lines);
          },
        },
        xAxis: [
          {
            // Das Kopf-Panel teilt die Achse des Leistungs-Panels und
            // beschriftet sie deshalb NICHT - eine Zeitachse, einmal
            // beschriftet, unten wo der Blick ohnehin endet.
            type: 'category',
            gridIndex: 0,
            data: times,
            show: twoPanel,
            axisLabel: { show: false },
            axisTick: { show: false },
            axisLine: { show: false },
            axisPointer: { label: { show: false } },
          },
          {
            type: 'category',
            gridIndex: 1,
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
              fontSize: AXIS.fontSize,
              hideOverlap: true,
            },
            // F4: kein Rahmen um die Daten - weder Achslinie noch Ticks.
            axisTick: { show: false },
            axisLine: { show: false },
          },
        ],
        yAxis: [
          {
            // Panel 1: der Preis, allein auf seiner Skala.
            type: 'value',
            gridIndex: 0,
            show: twoPanel,
            name: AXIS_NAME.preis(narrow),
            nameTextStyle: { color: t.axis, align: 'left', fontSize: AXIS.nameFontSize },
            nameGap: 10,
            // Negativpreise sind Produkt-Substanz - die Null bleibt im Bild
            // (Hausregel 5d), sonst läse sich ein negativer Preis wie ein
            // niedriger.
            min: (v: { min: number }) => Math.min(0, v.min),
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          {
            // Panel 2: die Leistung. Discharge stays at battery scale; the top
            // grows to keep the peak Ziel visible when the overlay is on.
            type: 'value',
            gridIndex: 1,
            name: AXIS_NAME.leistung(narrow),
            nameTextStyle: { color: t.axis, align: 'left', fontSize: AXIS.nameFontSize },
            nameGap: 10,
            min: -Math.ceil(kwMax),
            max: Math.ceil(axisMax),
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          {
            // Die EINE geduldete F8-Ausnahme: der Ladestand als beschriftete
            // Kontext-Miniskala (0-100 %, dimensionslos, Domänen-Konvention).
            // Zu schmal für eine zweite Rechts-Achse ⇒ sie entfällt, und das
            // Band wird unter dem Bild in Worten genannt.
            type: 'value',
            gridIndex: 1,
            min: 0,
            max: 100,
            show: socScale,
            position: 'right',
            offset: 44,
            splitLine: { show: false },
            // Diese EINE Achse behält ihre Linie: sie steht 44 px neben dem
            // Panelrand, und ohne den Strich wäre nicht ablesbar, welche
            // Zahlenreihe zu welcher Achse gehört (F4 regelt den RAHMEN um die
            // Daten, nicht die Zuordnung zweier Rechts-Achsen).
            axisLine: { show: true, lineStyle: { color: t.soc, width: STROKE.ref } },
            axisTick: { show: false },
            axisLabel: { color: t.soc, formatter: '{value} %', fontSize: AXIS.fontSize },
          },
        ],
        series: [
          ...priceSeries,
          {
            name: 'Batterie',
            type: 'bar',
            xAxisIndex: 1,
            yAxisIndex: 1,
            // K5: der Speicher ist EINE Farbe - Laden gefüllt, Abgeben als
            // UMRISS (dazu unter der Nulllinie und mit Wort in der Legende).
            // Der Stil hängt am DATENELEMENT, nicht als Callback an der Serie
            // (siehe `storageItemStyle` - eine Funktion auf `borderWidth` lässt
            // ECharts den ganzen Balken-Satz weglassen).
            data: battery.map((v, i) => {
              const sl = slots[i];
              const kind = sl
                ? chargeKind(sl.batteryKw, sl.gridKw, sl.pvKw, sl.curtailKw)
                : (v ?? 0) >= 0
                  ? ('solarladen' as const)
                  : ('entladen' as const);
              return storageBar(v, slotBarMark(kind, t), t.surface);
            }),
            // F9: aus dem 96-Slot-Farbblock werden ablesbare Viertelstunden-Stäbe.
            barCategoryGap: BAR.categoryGap,
            barMaxWidth: BAR.maxWidth,
            z: 3,
            markArea: pastArea,
            markLine: powerMarks.length
              ? { silent: true, symbol: 'none', data: powerMarks }
              : undefined,
          },
          // Der schmale orange Sockel-Tick am Nullpunkt je abregelndem Slot -
          // die EXAKTE Slot-Wahrheit neben dem weichen Band (das Muster des
          // `:8484`-Plan-Charts). Als Scatter mit Rechteck-Symbol bekommt er
          // seine Höhe in PIXELN und hängt damit nicht an der kW-Skala. Er
          // trägt zugleich das Band: die Batterie-Reihe hat ihre markArea schon
          // an die Vergangenheit vergeben (eine Reihe, eine markArea), und das
          // Abregeln gehört ins Leistungs-Panel - dort ist die Sonne.
          ...(curtailing
            ? [
                {
                  name: 'Abregeln',
                  type: 'scatter',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: curtailTicks,
                  symbol: 'rect',
                  symbolSize: [7, 6],
                  symbolOffset: [0, -3],
                  silent: true,
                  z: 6,
                  itemStyle: { color: t.pv },
                  tooltip: { show: false },
                  markArea: curtailBands.length
                    ? {
                        silent: true,
                        itemStyle: { color: t.pv, opacity: FILL.speaking },
                        data: curtailBands.map((s) => [{ xAxis: s.from }, { xAxis: s.to }]),
                      }
                    : undefined,
                  // K5/K10: das Wort steht IM BILD, genau einmal, über dem
                  // LÄNGSTEN Block (K6: höchstens drei benannte Marken).
                  // ⚠ Es hängt bewusst an einem markPoint und NICHT am Label
                  // der markArea: ECharts klemmt ein Flächen-Label auf die
                  // Breite seines Rechtecks, und ein drei Viertelstunden
                  // schmaler Block quetschte den Satz Buchstabe auf Buchstabe
                  // (im Browser aufgefallen, nicht im Test).
                  markPoint: curtailBands.length
                    ? {
                        silent: true,
                        symbol: 'circle',
                        symbolSize: 0,
                        data: [
                          {
                            coord: [
                              Math.round(
                                (curtailBands[longestBand].from + curtailBands[longestBand].to) / 2,
                              ),
                              Math.ceil(axisMax) * 0.92,
                            ],
                            label: {
                              show: true,
                              formatter: bandWord,
                              color: t.pvLine,
                              fontSize: AXIS.fontSize,
                              fontWeight: 600,
                              backgroundColor: t.surface,
                              padding: [2, 5],
                              borderRadius: 3,
                            },
                          },
                        ],
                      }
                    : undefined,
                },
              ]
            : []),
          // The two forecast INPUTS of the plan, on the SAME kW axis as the
          // bars: dotted + thin so they read as context, never as measured
          // values. An absent value is a GAP, never 0.
          ...(showPv
            ? [
                {
                  name: PV_FORECAST_LABEL,
                  type: 'line',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: forecast.pv.values,
                  ...SMOOTH_SERIES,
                  symbol: 'none',
                  connectNulls: false,
                  z: 4,
                  lineStyle: { color: t.pvLine, width: FORECAST.width, type: 'dotted' },
                  itemStyle: { color: t.pvLine },
                },
              ]
            : []),
          // Die gedrosselte Menge als halbtransparente orange Fläche zwischen
          // Einspeise-Cap (`pvKw - curtailKw`) und PV-Prognose - die
          // Prognosen-Ebene erklärt damit, WARUM der Forecast über dem Cap
          // liegt. Zwei gestapelte Reihen: die untere trägt den Cap unsichtbar,
          // die obere die Differenz mit der Füllung.
          ...(showCurtailArea
            ? [
                {
                  name: 'Einspeise-Cap',
                  type: 'line',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: curtail.cap,
                  stack: 'vp-curtail',
                  symbol: 'none',
                  connectNulls: false,
                  silent: true,
                  z: 3,
                  lineStyle: { opacity: 0 },
                  itemStyle: { color: t.pv },
                  tooltip: { show: false },
                },
                {
                  name: CURTAIL_AREA_LABEL,
                  type: 'line',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: curtail.delta,
                  stack: 'vp-curtail',
                  symbol: 'none',
                  connectNulls: false,
                  silent: true,
                  z: 3,
                  lineStyle: { color: t.pv, width: STROKE.ref, type: 'dashed' },
                  itemStyle: { color: t.pv },
                  // F3-Ausnahme: die Fläche TRÄGT hier die Aussage (wie viel
                  // gedrosselt wird) und hat ihr Namensschild in der Legende.
                  areaStyle: { color: t.pv, opacity: FILL.speaking },
                  tooltip: { show: false },
                },
              ]
            : []),
          ...(showLoad
            ? [
                {
                  name: LOAD_FORECAST_LABEL,
                  type: 'line',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: forecast.load.values,
                  ...SMOOTH_SERIES,
                  symbol: 'none',
                  connectNulls: false,
                  z: 4,
                  // Seit Stufe 2 trägt der Verbrauch seine dunklere
                  // LINIEN-Stufe (F2): der Preis hat das Panel verlassen, also
                  // gibt es die Blau×Blau-Kollision (ΔE 1,3) hier nicht mehr -
                  // und gegen das Netzladen-Türkis gewinnt `loadLine` deutlich
                  // (ΔE 10,9 → 18,3, gemessen mit --pairs all).
                  lineStyle: { color: t.loadLine, width: FORECAST.width, type: 'dotted' },
                  itemStyle: { color: t.loadLine },
                },
              ]
            : []),
          // The MEASURED PV - same colour as its forecast (same quantity) but
          // SOLID, so the pair reads as "geplant vs. wirklich". Drawn UNDER the
          // measured consumption (lower z) but over the bars, so a charge bar
          // exceeding the measured PV stays visible - that is the
          // Solarladen-Regel made checkable.
          ...(showIstPv
            ? [
                {
                  name: MEASURED_PV_LABEL,
                  type: 'line',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: istPv.values,
                  smooth: false,
                  symbol: 'circle',
                  symbolSize: 5,
                  showSymbol: needsPointMarkers(istPv),
                  connectNulls: false,
                  z: 5,
                  lineStyle: { color: t.pvLine, width: STROKE.context },
                  itemStyle: { color: t.pvLine },
                },
              ]
            : []),
          // P3: the MEASURED consumption - same colour as its forecast (same
          // quantity) but SOLID and a touch thicker, so the pair reads as
          // "geplant vs. wirklich" and the gap between them is the message.
          // An MPC plan usually has only one or two past slots, so a stroke
          // alone would be invisible - point markers then carry the value.
          ...(showIst
            ? [
                {
                  name: MEASURED_LOAD_LABEL,
                  type: 'line',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  data: ist.values,
                  smooth: false,
                  symbol: 'circle',
                  symbolSize: 5,
                  showSymbol: needsPointMarkers(ist),
                  connectNulls: false,
                  z: 5,
                  lineStyle: { color: t.loadLine, width: STROKE.context },
                  itemStyle: { color: t.loadLine },
                },
              ]
            : []),
          ...(hasSoc
            ? [
                {
                  name: SOC_LABEL,
                  type: 'line',
                  xAxisIndex: 1,
                  yAxisIndex: 2,
                  data: soc,
                  ...SMOOTH_SERIES,
                  symbol: 'none',
                  z: 1,
                  lineStyle: { color: t.soc, width: STROKE.contextSoft, type: 'dashed' },
                  itemStyle: { color: t.soc },
                },
              ]
            : []),
          // §14.11: consumers as POSITIVE stacked step-areas in shades of the
          // ONE consumer hue (the battery keeps its own sign logic). A null =
          // the consumer run does not cover the slot (gap, never a 0).
          ...(showConsumers
            ? activeConsumers.map((layer, li) => ({
                name: `Verbraucher · ${layer.name}`,
                type: 'line',
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: layer.values,
                stack: 'vp-verbraucher',
                step: 'end',
                symbol: 'none',
                connectNulls: false,
                z: 2,
                lineStyle: { color: consumerShade(t.consumer, li), width: STROKE.contextSoft },
                itemStyle: { color: consumerShade(t.consumer, li) },
                areaStyle: { color: consumerShade(t.consumer, li), opacity: FILL.band },
              }))
            : []),
          // The lock markers on Pflicht slots (word travels in the tooltip -
          // never colour alone). One series at the TOP of the consumer stack.
          ...(showConsumers && anyPflicht
            ? [
                {
                  name: 'Pflichtfenster',
                  type: 'scatter',
                  xAxisIndex: 1,
                  yAxisIndex: 1,
                  symbol: LOCK_SYMBOL,
                  symbolSize: 11,
                  symbolOffset: [0, -8],
                  silent: true,
                  z: 6,
                  itemStyle: { color: t.consumer },
                  tooltip: { show: false },
                  data: slots
                    .map((_s, i) => {
                      const pflicht = activeConsumers.some(
                        (l) => l.pflicht[i] && (l.values[i] ?? 0) > 0.049,
                      );
                      if (!pflicht) return null;
                      const top = activeConsumers.reduce((sum, l) => sum + (l.values[i] ?? 0), 0);
                      return [i, top];
                    })
                    .filter((d): d is [number, number] => d != null),
                },
              ]
            : []),
        ],
      },
      true,
    );
    // `forecast`/`ist`/`curtail`/`curtailing`/`spread` are derived from
    // `plan`, so `plan` covers them.
  }, [plan, t, peakTargetKw, onSlotClick, selectedIndex, hidden, consumers]);

  // Insight: charge cheap, discharge expensive, and today's saving - composed
  // by the pure builder so the "flat curve" clause can never contradict a
  // visibly cycling plan (audit F3).
  const insight = planInsightParts(plan.slots, new Date());
  // The planned SoC band in words - the readable fallback wherever the SoC
  // axis has no room (phones) and the touch-friendly answer to "how full?".
  const socLine = socRangeLine(plan.slots);

  // Die Legende gilt für BEIDE Panels und ist der von K2 vorgesehene RÜCKFALL:
  // eine Direktbeschriftung am Kurvenende trägt bis vier Reihen, der Fahrplan
  // zeichnet bis zu zwölf (`useDirectLabels`). Nichts hier ist ein Umschalter -
  // die Balkenfarben sind per-Slot-ZUSTÄNDE einer Serie, und die Schichten
  // schalten die drei Gruppen-Knöpfe darüber (D4).
  const legend: LegendItem[] = [
    // Zuerst das Preis-Panel, in der Lesereihenfolge des Bildes.
    ...(showSpread
      ? ([
          { color: t.price, label: BEZUGSPREIS, unit: 'ct/kWh', shape: 'line', toggleable: false },
          {
            color: t.flowGridLine,
            label: EINSPEISEWERT,
            unit: 'ct/kWh',
            shape: 'line',
            toggleable: false,
          },
          {
            color: t.price,
            label: `${SPANNE} = Grund fürs Laden`,
            unit: 'ct/kWh',
            shape: 'area',
            toggleable: false,
          },
        ] as LegendItem[])
      : []),
    ...(showSpot
      ? [
          {
            color: t.price,
            label: BOERSENPREIS,
            unit: 'ct/kWh',
            shape: 'line',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    { color: t.charge, label: 'Laden aus Solarstrom', unit: 'kW', shape: 'bar', toggleable: false },
    ...(gridCharging
      ? [
          {
            color: t.gridCharge,
            label: 'Laden aus dem Netz (günstig)',
            unit: 'kW',
            shape: 'bar',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    // K5: dieselbe Farbe wie Laden, andere FORM - „gefüllt = lädt, Umriss =
    // gibt ab"; das Wort steht daneben und die Position unter der Nulllinie.
    {
      color: t.charge,
      label: 'Entladen (teurer Strom)',
      unit: 'kW',
      shape: 'outline',
      toggleable: false,
    },
    // Orange steht am Canvas als BAND + Sockel-Tick (und in der
    // Prognosen-Ebene als Fläche), also trägt die Legende die Flächen-Form.
    // Gate = dasselbe `curtailing` wie das Canvas.
    ...(curtailing
      ? [
          {
            color: t.pv,
            label: CURTAIL_LEGEND_LABEL,
            unit: 'kW',
            shape: 'area',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    ...(peakTargetKw != null && peakTargetKw > 0
      ? [
          {
            color: t.discharge,
            label: 'Ziel Netzbezug (Lastspitze)',
            unit: 'kW',
            shape: 'dashed',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    // ...plus exactly the rows of the layers that are switched ON, so the
    // legend never advertises a line the chart does not draw.
    ...(showPv
      ? [
          {
            color: t.pvLine,
            label: PV_FORECAST_LABEL,
            unit: 'kW',
            shape: 'dotted',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    ...(showLoad
      ? [
          {
            color: t.loadLine,
            label: LOAD_FORECAST_LABEL,
            unit: 'kW',
            shape: 'dotted',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    // The measured twins sit next to their forecast (gepunktet = Prognose,
    // durchgezogen = gemessen), so the pairing is obvious.
    ...(showIstPv
      ? [
          {
            color: t.pvLine,
            label: MEASURED_PV_LABEL,
            unit: 'kW',
            shape: 'line',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    ...(showIst
      ? [
          {
            color: t.loadLine,
            label: MEASURED_LOAD_LABEL,
            unit: 'kW',
            shape: 'line',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    ...(showSoc
      ? [
          {
            color: t.soc,
            label: 'Ladestand des Speichers',
            unit: '%',
            shape: 'dashed',
            toggleable: false,
          } as LegendItem,
        ]
      : []),
    // §14.11: one row per consumer (only with consumers - the legend never
    // advertises a layer the chart does not draw), plus the lock explainer
    // when a Pflichtfenster exists.
    ...activeConsumers.map(
      (layer, li) =>
        ({
          color: consumerShade(t.consumer, li),
          label: layer.name,
          unit: 'kW',
          shape: 'area',
          toggleable: false,
        }) as LegendItem,
    ),
    ...(anyPflicht
      ? [
          {
            color: t.consumer,
            label: 'Schloss = Pflichtfenster (feste Zeit)',
            unit: 'kW',
            shape: 'area',
            toggleable: false,
          } as LegendItem,
        ]
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

  // K1/M11: die Kernaussage als SATZ über dem Bild. Sie ist ABGELEITET
  // (planSentence + savingsTodayEur + die persistierte Baseline als
  // Vergleichsanker) - ohne belegbare Aussage steht dort der ehrliche Grund.
  const kern = plantKind
    ? planKernaussage(plan.slots, plantKind, new Date(), plan.slotMinutes || 15)
    : null;

  return (
    <div>
      <ChartHeadline kern={kern} />
      <div className="vp-sched-layers" role="group" aria-label="Zusätzliche Schichten">
        {SERIES_GROUPS.filter((g) => groupAvailable[g.id]).map((g) => {
          const on = !hiddenGroups.has(g.id);
          return (
            <button
              key={g.id}
              type="button"
              className={`vp-sched-layer${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() =>
                setHiddenGroups((cur) => {
                  const next = toggleGroup(cur, g.id);
                  try {
                    sessionStorage.setItem(SCHED_GROUPS_KEY, [...next].join(','));
                  } catch {
                    /* Speicher nicht verfügbar - der Zustand lebt nur im Bild. */
                  }
                  return next;
                })
              }
            >
              {on ? g.label : `+ ${g.label}`}
            </button>
          );
        })}
      </div>
      <ChartLegend items={legend} />
      {/* Zwei Panels brauchen mehr Höhe als eine Fläche - `panels` ist die
          Zwei-Panel-Stufe der `.vp-chart`-Höhenklassen. Am Telefon bleiben sie
          UNTEREINANDER in derselben Instanz (sie teilen ja die Zeitachse). */}
      <div ref={ref} className={`vp-chart ${twoPanel ? 'panels' : 'tall'}`} />
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
