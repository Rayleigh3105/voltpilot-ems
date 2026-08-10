import {
  AXIS,
  BAR,
  dayBoundaryStyle,
  FILL,
  NARROW_PX,
  PANELS,
  SMOOTH_SERIES,
  storageBar,
  STROKE,
} from '../../chartStyle';
import { chartTheme } from '../../chartTheme';
import { chargeKind, slotBarMark } from '../../schedule';
import { useEChart } from '../../useEChart';
import { ChartLegend, type LegendItem } from '../../components/ChartExplain';
import type { OptimizerDiagnostics } from '../../optimizerApi';

/**
 * „Der Plan" — die Admin-Diagnose des Fahrplans, seit dem Chart-Redesign
 * Stufe 3 ein **ZWEI-PANEL-BILD** in derselben Sprache wie der Kunden-Fahrplan
 * (F8 verschärft, r2 §4): oben die Preise, unten die Leistung, über EINER
 * Zeitachse mit EINEM Fadenkreuz (`axisPointer.link`).
 *
 * Aufgelöst sind damit die zwei Befunde des Inventars (`vp-charts-filigran-c7`
 * §3a Nr. 10):
 *
 *  1. **DREI Y-Achsen, eine davon unsichtbar** — der Ladestand ritt auf einer
 *     versteckten Skala mit, seine Kurve war also nicht ablesbar. Er bekommt
 *     jetzt die beschriftete Miniskala rechts (die EINE geduldete
 *     F8-Ausnahme), und die Preise haben ihre eigene Fläche.
 *  2. **`charge`/`discharge` doppelt belegt** — dieselben zwei Töne trugen die
 *     BALKEN (kW) *und* die Preislinien (ct/kWh). Der Panel-Schnitt löst das
 *     strukturell: die Preise sprechen jetzt die Preis-Töne der Stufe 2
 *     (Bezugspreis `price`, Einspeisewert `flowGridLine`, der Börsenpreis des
 *     Solvers als gestrichelte Kontext-Stufe DERSELBEN Preisfarbe), und Grün
 *     bleibt im unteren Panel ausschließlich der Speicher.
 *
 * Der Speicher folgt derselben K5-Regel wie überall: EINE Farbe, gefüllt =
 * lädt, Umriss = gibt ab, Türkis nur beim Netzladen (`slotBarMark`) — das
 * frühere Rot fürs Entladen ist damit weg, denn eine Batterie, die in eine
 * teure Stunde entlädt, verdient Geld und darf nie wie ein Fehler aussehen.
 *
 * Ein Klick wählt weiterhin einen Slot für die €-Aufschlüsselung darunter —
 * jetzt über die ganze Spalte, nicht nur den Balken.
 */

/** Der Börsenpreis, mit dem der Solver rechnet (die Solver-Referenz). */
const SPOT = 'Börsenpreis (Solver)';
const BEZUG = 'Bezugspreis (real)';
const EINSPEISE = 'Einspeisewert (real)';
const BATTERIE = 'Batterie';
const NETZ = 'Netz';
const LADESTAND = 'Ladestand';

export function OptimizerPlanChart({
  diag,
  selectedIdx,
  onSelectSlot,
}: {
  diag: OptimizerDiagnostics;
  selectedIdx: number;
  onSelectSlot: (idx: number) => void;
}) {
  const t = chartTheme();

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < NARROW_PX;
      const slots = diag.slots;
      const times = slots.map((s) => s.time);
      const num = (v: unknown) => (v == null ? null : Number(v));
      const battery = slots.map((s) => num(s.batteryKw));
      const grid = slots.map((s) => num(s.gridKw));
      const soc = slots.map((s) => num(s.socPct));
      const spot = slots.map((s) => num(s.solverPriceCtKwh));
      const importCt = slots.map((s) => num(s.importPriceCtKwh));
      const exportCt = slots.map((s) => num(s.exportValueCtKwh));

      const hatPreis = [...spot, ...importCt, ...exportCt].some((v) => v != null);
      const socScale = !narrow && soc.some((v) => v != null);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const boundaryIdx = slots.findIndex(
        (s) => new Date(s.time).toDateString() === tomorrow.toDateString(),
      );

      /* ---- Die zwei Plotflächen --------------------------------------------
       * ⚠ BEIDE Grids tragen denselben linken und rechten Rand, und
       * `containLabel` bleibt aus - sonst lägen die zwei Zeitachsen nicht
       * übereinander, und die geteilte Achse IST der Zweck. Ohne Preisdaten
       * schrumpft das Kopf-Panel auf Höhe 0; die Indizes bleiben stabil. */
      const left = narrow ? PANELS.leftNarrowPx : PANELS.leftPx;
      const right = socScale ? PANELS.rightWithSocPx : PANELS.rightPx;
      const grids = hatPreis
        ? [
            { left, right, top: PANELS.topPx, height: `${PANELS.headPct}%` },
            { left, right, top: `${PANELS.bodyTopPct}%`, bottom: PANELS.bottomPx },
          ]
        : [
            { left, right, top: 0, height: 0, show: false },
            { left, right, top: PANELS.topPx, bottom: PANELS.bottomPx },
          ];

      /* ---- Marken: Linie durch BEIDE Panels, das WORT genau einmal --------- */
      const preisMarken: Record<string, unknown>[] = [];
      const leistungsMarken: Record<string, unknown>[] = [];
      const mitWort = (
        basis: Record<string, unknown>,
        formatter: string,
        color: string,
      ) => {
        preisMarken.push({ ...basis, label: { show: false } });
        leistungsMarken.push({
          ...basis,
          label: {
            formatter,
            color,
            fontSize: AXIS.fontSize,
            position: 'insideEndTop',
            rotate: 0,
          },
        });
      };
      if (boundaryIdx > 0)
        mitWort(
          {
            xAxis: boundaryIdx,
            lineStyle: dayBoundaryStyle(t),
          },
          'Morgen',
          t.axis,
        );
      if (selectedIdx >= 0 && selectedIdx < slots.length)
        mitWort(
          {
            xAxis: selectedIdx,
            lineStyle: { color: t.plan, type: 'solid', width: STROKE.context },
          },
          'Slot',
          t.plan,
        );

      const kwAbs = [...battery, ...grid]
        .filter((v): v is number => v != null)
        .map((v) => Math.abs(v));
      const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;

      // Die ganze Spalte ist das Klickziel (auch ein Slot ohne Balken) - beide
      // Panels teilen die Zeitachse, also beantwortet ein Klick oben dieselbe
      // Frage wie unten.
      const zr = chart.getZr();
      zr.off('click');
      zr.on('click', (e: { offsetX: number; offsetY: number }) => {
        const pt: [number, number] = [e.offsetX, e.offsetY];
        if (!chart.containPixel('grid', pt)) return;
        const idx = Math.round(Number(chart.convertFromPixel({ xAxisIndex: 1 }, pt[0])));
        if (Number.isFinite(idx) && idx >= 0 && idx < slots.length) onSelectSlot(idx);
      });

      const preisSerien: Record<string, unknown>[] = hatPreis
        ? [
            {
              name: BEZUG,
              type: 'line',
              xAxisIndex: 0,
              yAxisIndex: 0,
              data: importCt,
              step: 'end',
              symbol: 'none',
              connectNulls: false,
              z: 3,
              lineStyle: { color: t.price, width: STROKE.lead },
              itemStyle: { color: t.price },
              markLine: preisMarken.length
                ? { silent: true, symbol: 'none', data: preisMarken }
                : undefined,
            },
            {
              name: EINSPEISE,
              type: 'line',
              xAxisIndex: 0,
              yAxisIndex: 0,
              data: exportCt,
              step: 'end',
              symbol: 'none',
              connectNulls: false,
              z: 2,
              lineStyle: { color: t.flowGridLine, width: STROKE.context },
              itemStyle: { color: t.flowGridLine },
            },
            {
              // Der Solver-Preis ist die REFERENZ, gegen die man die zwei
              // echten Linien liest - dieselbe Preisfarbe, Kontext-Stärke und
              // gestrichelt. Wo er von ihnen abweicht, lebt „warum hat er das
              // getan"; ein eigener Farbplatz dafür wäre eine dritte Aussage.
              name: SPOT,
              type: 'line',
              xAxisIndex: 0,
              yAxisIndex: 0,
              data: spot,
              step: 'end',
              symbol: 'none',
              z: 1,
              lineStyle: { color: t.price, width: STROKE.contextSoft, type: 'dashed' },
              itemStyle: { color: t.price },
            },
          ]
        : [];

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          axisPointer: { link: [{ xAxisIndex: 'all' }] },
          grid: grids,
          tooltip: {
            trigger: 'axis',
            confine: true,
            /**
             * ⚠ Aus dem SLOT-INDEX komponiert, nicht aus den `params`: bei zwei
             * Grids liefert ECharts nur die Serien des überfahrenen Panels, und
             * ein Ablesen, das oben andere Zeilen zeigt als unten, wäre kein
             * geteiltes Fadenkreuz.
             */
            formatter: (params: { dataIndex?: number }[]) => {
              const idx = params?.[0]?.dataIndex ?? -1;
              const s = slots[idx];
              if (!s) return '';
              const time = new Date(s.time).toLocaleString('de-DE', {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
              });
              const kind = chargeKind(s.batteryKw, s.gridKw, s.pvKw, s.curtailKw);
              const label =
                kind === 'netzladen'
                  ? 'lädt aus dem Netz'
                  : kind === 'solarladen'
                    ? 'lädt Solarstrom'
                    : kind === 'entladen'
                      ? 'entlädt'
                      : 'hält';
              const lines = [`<b>${time} Uhr</b>`, `Batterie ${label}`];
              if (s.batteryKw != null) lines.push(`Leistung: ${fmtKw(Number(s.batteryKw))}`);
              if (s.gridKw != null) lines.push(`${NETZ}: ${fmtKw(Number(s.gridKw))}`);
              if (s.importPriceCtKwh != null)
                lines.push(`${BEZUG}: ${fmtCt(Number(s.importPriceCtKwh))}`);
              if (s.exportValueCtKwh != null)
                lines.push(`${EINSPEISE}: ${fmtCt(Number(s.exportValueCtKwh))}`);
              if (s.solverPriceCtKwh != null)
                lines.push(`${SPOT}: ${fmtCt(Number(s.solverPriceCtKwh))}`);
              if (s.socPct != null)
                lines.push(
                  `${LADESTAND}: ${Number(s.socPct).toLocaleString('de-DE', {
                    maximumFractionDigits: 0,
                  })} %`,
                );
              lines.push('<span style="opacity:.7">Klick: €-Aufschlüsselung ↓</span>');
              return lines.join('<br/>');
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
              show: hatPreis,
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
                formatter: (v: string) =>
                  new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                color: t.axis,
                fontSize: AXIS.fontSize,
                hideOverlap: true,
              },
              axisTick: { show: false },
              axisLine: { show: false },
            },
          ],
          yAxis: [
            {
              // Panel 1: die Preise, allein auf ihrer Skala. Negativpreise sind
              // Produkt-Substanz - die Null bleibt im Bild (Hausregel 5d).
              type: 'value',
              gridIndex: 0,
              show: hatPreis,
              name: narrow ? '' : 'Preis (ct/kWh)',
              nameTextStyle: { color: t.axis, align: 'left', fontSize: AXIS.nameFontSize },
              nameGap: 10,
              min: (v: { min: number }) => Math.min(0, v.min),
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
              axisTick: { show: false },
              axisLine: { show: false },
            },
            {
              // Panel 2: die Leistung, symmetrisch um die Nulllinie.
              type: 'value',
              gridIndex: 1,
              name: narrow ? '' : 'Leistung (kW)',
              nameTextStyle: { color: t.axis, align: 'left', fontSize: AXIS.nameFontSize },
              nameGap: 10,
              min: -Math.ceil(kwMax),
              max: Math.ceil(kwMax),
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
              axisTick: { show: false },
              axisLine: { show: false },
            },
            {
              // Die EINE geduldete F8-Ausnahme: der Ladestand als BESCHRIFTETE
              // Kontext-Miniskala - vorher lief er auf einer unsichtbaren
              // Achse mit und war damit nicht ablesbar.
              type: 'value',
              gridIndex: 1,
              min: 0,
              max: 100,
              show: socScale,
              position: 'right',
              offset: 44,
              splitLine: { show: false },
              axisLine: { show: true, lineStyle: { color: t.soc, width: STROKE.ref } },
              axisTick: { show: false },
              axisLabel: { color: t.soc, formatter: '{value} %', fontSize: AXIS.fontSize },
            },
          ],
          series: [
            ...preisSerien,
            {
              name: NETZ,
              type: 'bar',
              xAxisIndex: 1,
              yAxisIndex: 1,
              data: grid,
              barCategoryGap: BAR.categoryGap,
              barMaxWidth: BAR.maxWidth,
              barGap: '-100%',
              z: 1,
              silent: true,
              // EIN neutraler Kontext-Sockel in BEIDE Richtungen: das frühere
              // Türkis für die Einspeisung war derselbe Ton, mit dem die Balken
              // darüber „Netzladen" sagen - die Richtung trägt hier die
              // Position, nicht eine zweite Bedeutung derselben Farbe.
              itemStyle: { borderRadius: 1, opacity: FILL.band * 2, color: t.neutral },
            },
            {
              name: BATTERIE,
              type: 'bar',
              xAxisIndex: 1,
              yAxisIndex: 1,
              // K5: der Speicher ist EINE Farbe - gefüllt = lädt, Umriss = gibt
              // ab, Türkis nur beim Netzladen. Dieselbe `slotBarMark`, durch die
              // auch der Kunden-Fahrplan geht.
              data: battery.map((v, i) => {
                const s = slots[i];
                const kind = chargeKind(s.batteryKw, s.gridKw, s.pvKw, s.curtailKw);
                return storageBar(v, slotBarMark(kind, t), t.surface);
              }),
              barCategoryGap: BAR.categoryGap,
              barMaxWidth: BAR.maxWidth,
              z: 3,
              markLine: leistungsMarken.length
                ? { silent: true, symbol: 'none', data: leistungsMarken }
                : undefined,
            },
            {
              name: LADESTAND,
              type: 'line',
              xAxisIndex: 1,
              yAxisIndex: 2,
              data: soc,
              ...SMOOTH_SERIES,
              symbol: 'none',
              z: 2,
              lineStyle: { color: t.soc, width: STROKE.contextSoft, type: 'dotted' },
              itemStyle: { color: t.soc },
            },
          ],
        },
        true,
      );
    },
    [diag, selectedIdx, t],
  );

  const legend: LegendItem[] = [
    { color: t.price, label: BEZUG, unit: 'ct/kWh', shape: 'line' },
    { color: t.flowGridLine, label: EINSPEISE, unit: 'ct/kWh', shape: 'line' },
    { color: t.price, label: SPOT, unit: 'ct/kWh', shape: 'dashed' },
    { color: t.charge, label: 'Speicher lädt Solarstrom', unit: 'kW', shape: 'bar' },
    { color: t.gridCharge, label: 'Speicher lädt aus dem Netz', unit: 'kW', shape: 'bar' },
    { color: t.charge, label: 'Speicher gibt ab', unit: 'kW', shape: 'outline' },
    { color: t.neutral, label: NETZ, unit: 'kW', shape: 'area' },
    { color: t.soc, label: LADESTAND, unit: '%', shape: 'dotted' },
  ];

  return (
    <div>
      <ChartLegend items={legend} />
      {/* Zwei Panels brauchen mehr Höhe als eine Fläche - `panels` ist die
          Zwei-Panel-Stufe der `.vp-chart`-Höhenklassen. */}
      <div ref={ref} className="vp-chart panels" />
    </div>
  );
}

function fmtKw(v: number): string {
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
}

function fmtCt(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}
