import type { ScheduleSlot, WeatherPoint } from './api';
import { AXIS, FILL, nowLabel, nowLineStyle, SMOOTH_SERIES, STROKE, withAlpha } from './chartStyle';
import { AXIS as AXIS_NAME } from './chartCopy';
import { chartTheme } from './chartTheme';
import { useState } from 'react';
import { useEChart } from './useEChart';
import { ChartLegend, type LegendItem } from './components/ChartExplain';
import { toggleSerie } from './energieBilanz';
import { axisHourLabel, nowMarkerIndex, tooltipHeader } from './weather';
import {
  besteStunde,
  erwarteteLeistung,
  himmelBloecke,
  type HimmelBlock,
} from './wetterLeistung';
import './WeatherChart.css';

/**
 * Die Wettervorhersage — seit dem Chart-Redesign Stufe 4 (M16) antwortet sie in
 * der Größe, nach der der Kunde fragt: der **erwarteten Leistung seiner Anlage
 * in kW**. „412 W/m²" sagt einem Anlagenbetreiber nichts.
 *
 * Der Aufbau, von oben nach unten (V6 seit Paket P5 — die REIHENFOLGE ist die
 * Aussage: Himmel → **Bild** → Legende, nie eine Legende 175 px VOR der Kurve):
 *
 *  - die **Himmel-Reihe** mit BENANNTEN Chips („sonnig" · „wechselnd" ·
 *    „bedeckt") statt des früheren Wolken-Wischs, den die Legende erklären
 *    musste („dunkler = dichter"). Eine Kodierung mit Bedienungsanleitung ist
 *    keine (K10) — jeder Block trägt sein Wort;
 *  - die **kW-Kurve** als Leitserie (F1-Hierarchie, `STROKE.lead`) mit einer
 *    benannten Marke für die stärkste kommende Stunde (K6);
 *  - die **Chip-Legende** darunter, deren Einträge die Reihen SCHALTEN
 *    (E7 a, `<button aria-pressed>`);
 *  - dahinter, eine Stufe tiefer (K3), **Sonnenstärke** als Kontextkurve und
 *    **Temperatur** als ZEILE — beide im Aufklapper der Sektion.
 *
 * ⚠ **E7 (a) · KEIN Zoom durch Ziehen** (Captain 03.09.2026): dieses Bild trägt
 * gar keine `dataZoom`-Option, weder am Telefon noch am Rechner. Eine
 * waagerechte Geste darin ist Scroll, wie überall sonst auf der Seite; der
 * Tooltip erscheint per Tipp (`trigger: 'axis'`, `confine: true`).
 *
 * ⚠ **F8, verschärft: höchstens ZWEI Achsen.** Vorher waren es drei (°C, %,
 * W/m²) mit drei Strichstärken in einem Bild. Die Bewölkung ist jetzt der
 * Streifen, und die Temperatur wird ein Satz statt einer Kurve — als
 * Drei-Tage-Wackellinie beantwortet sie einem PV-Betreiber ohnehin nichts, was
 * „jetzt 18 °C, heute bis 24 °C" nicht besser sagt. Sie ist damit nicht
 * verschwunden (K3: eine Stufe tiefer), erzwingt aber keine dritte Achse.
 *
 * ⚠ **Woher die kW kommen:** aus der PV-Prognose des FAHRPLANS
 * (`schedule.pv_kw`) — die eine Stelle, an der die Prognose des aktiven
 * PV-Modells das Portal erreicht. Es wird NICHTS aus W/m² umgerechnet (das
 * wäre eine zweite Prognose), und wo der Plan-Horizont endet, endet die Linie.
 * Ohne jeden Plan-Wert führt die Fläche wieder die Sonnenstärke und sagt im
 * Kopf den GRUND (`wetterLeistung.wetterKern`).
 *
 * Alle Zeiten rendern als deutsche LOKALZEIT — die rohen UTC-Stempel der API
 * erreichen den Kunden nie (`weather.ts`).
 */
export function WeatherChart({
  points,
  planSlots = [],
  detail = false,
}: {
  points: WeatherPoint[];
  /** Der Fahrplan der Anlage — seine `pvKw` sind die PV-Prognose. */
  planSlots?: ScheduleSlot[];
  /**
   * V8 (P5) · Ist der Aufklapper „Temperatur & Sonnenstärke im Verlauf" offen?
   *
   * ⚠ Der Zustand lebt seit P5 in der SEKTION, nicht hier: der Aufklapper steht
   *   nach §4.6 UNTER den vier Kennzahlen-Zeilen, also ausserhalb des Bildes.
   *   Ein zweiter Zustand hier wäre eine zweite Wahrheit über dieselbe Frage.
   */
  detail?: boolean;
}) {
  const t = chartTheme();
  /**
   * **E7 (a) · der Legenden-Schalter** (Captain 03.09.2026, wörtlich: „Tooltip
   * + Legenden-Schalter, KEIN Zoom durch Ziehen am Telefon"). Die letzte
   * sichtbare Reihe lässt sich nicht ausblenden (`toggleSerie`) — ein leeres
   * Bild beantwortet keine Frage.
   */
  const [verborgen, setVerborgen] = useState<Set<string>>(() => new Set());

  const kw = erwarteteLeistung(points, planSlots);
  const hatLeistung = kw.some((v) => v != null);
  const bloecke = himmelBloecke(points);
  const jetzt = new Date();
  const marke = hatLeistung ? besteStunde(points, kw, jetzt) : null;

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 520;
      const time = points.map((p) => p.ts);
      const num = (key: keyof WeatherPoint) =>
        points.map((p) => (p[key] == null ? null : Number(p[key])));

      const unitBySeries: Record<string, string> = {
        'Erwartete Leistung': 'kW',
        Sonnenstärke: 'W/m²',
      };

      // "Jetzt": the last hour at/before now (the elapsed part is shaded).
      const nowIdx = nowMarkerIndex(points, Date.now());

      // Die Leitserie: erwartete Leistung, sonst (kein Plan) die Sonnenstärke.
      const leitReihe = hatLeistung
        ? {
            name: 'Erwartete Leistung',
            data: kw,
            achse: AXIS_NAME.leistung(narrow),
            farbe: t.pvLine,
          }
        : {
            name: 'Sonnenstärke',
            data: num('ghiWM2'),
            achse: AXIS_NAME.sonnenstaerke(narrow),
            farbe: t.pvLine,
          };

      // F8: NIE mehr als zwei Achsen. Die zweite entsteht nur, wenn die
      // Kontext-Reihe wirklich gezeichnet wird — und der Legenden-Schalter
      // (E7 a) sie nicht ausgeblendet hat.
      const zeigtSonne = hatLeistung && detail && !verborgen.has('Sonnenstärke');
      const zeigtLeit = !verborgen.has(leitReihe.name);

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          // Die K6-Marke sitzt ÜBER der stärksten Stunde - und die liegt am
          // Achsen-Maximum. Ohne Kopfraum schneidet ECharts sie ab (im
          // Screenshot aufgefallen).
          grid: {
            top: 46,
            right: zeigtSonne && !narrow ? 60 : 12,
            bottom: 8,
            left: 8,
            containLabel: true,
          },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: any[]) => {
              const lines = [`<b>${tooltipHeader(params[0]?.axisValue)}</b>`];
              for (const p of params) {
                if (p.value == null) continue;
                const v = Number(p.value).toLocaleString('de-DE', { maximumFractionDigits: 1 });
                lines.push(`${p.marker} ${p.seriesName}: ${v} ${unitBySeries[p.seriesName] ?? ''}`);
              }
              return lines.join('<br/>');
            },
          },
          // Die eingebaute echarts-Legende ist WEG: sie war das einzige
          // Vorkommen im Portal (fuenf Legenden-Regime), zeichnete in Canvas
          // statt in HTML und sprach keine Einheiten. `ChartLegend` unter dem
          // Titel ist die eine Grammatik.
          xAxis: {
            type: 'category',
            data: time,
            boundaryGap: false,
            axisLabel: {
              formatter: (v: string) => axisHourLabel(v),
              color: t.axis,
              fontSize: AXIS.fontSize,
              hideOverlap: true,
            },
            // F4: kein Rahmen um die Daten - weder Achslinie noch Ticks.
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: [
            {
              type: 'value',
              name: leitReihe.achse,
              // ECharts setzt einen Achsen-NAMEN mittig über die Achse - die
              // linke Hälfte hängt damit aus dem Canvas, und `containLabel`
              // rechnet ihn NICHT ein. Linksbündig wächst er nach innen.
              nameLocation: 'end',
              nameGap: 12,
              nameTextStyle: { align: 'left' },
              position: 'left',
              min: 0,
              splitLine: { lineStyle: { color: t.grid } },
              axisTick: { show: false },
              axisLine: { show: false },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
            },
            ...(zeigtSonne
              ? [
                  {
                    type: 'value',
                    // K4: die Einheit sagt einem Anlagenbetreiber nichts - das
                    // WORT trägt sie.
                    name: narrow ? '' : AXIS_NAME.sonnenstaerke(false),
                    position: 'right',
                    min: 0,
                    splitLine: { show: false },
                    axisTick: { show: false },
                    axisLine: { show: false },
                    axisLabel: { show: !narrow, color: t.temp, fontSize: AXIS.fontSize },
                  },
                ]
              : []),
          ],
          series: [
            ...(zeigtLeit ? [{
              name: leitReihe.name,
              type: 'line',
              ...SMOOTH_SERIES,
              showSymbol: false,
              connectNulls: false,
              yAxisIndex: 0,
              lineStyle: { width: STROKE.lead, color: leitReihe.farbe },
              itemStyle: { color: leitReihe.farbe },
              areaStyle: { opacity: FILL.wash, color: leitReihe.farbe },
              data: leitReihe.data,
              // K6: EINE benannte Marke - die stärkste kommende Stunde, mit
              // Wort UND Zahl.
              markPoint:
                marke != null
                  ? {
                      silent: true,
                      symbol: 'circle',
                      symbolSize: 8,
                      data: [
                        {
                          name: marke.text,
                          coord: [marke.index, marke.kw],
                          itemStyle: {
                            color: t.surface,
                            borderColor: leitReihe.farbe,
                            borderWidth: 2,
                          },
                          label: {
                            show: true,
                            position: 'top',
                            distance: 8,
                            formatter: marke.text,
                            color: t.ink,
                            fontSize: AXIS.fontSize,
                            fontWeight: 600,
                            backgroundColor: t.surface,
                            padding: [2, 5],
                            borderRadius: 4,
                          },
                        },
                      ],
                    }
                  : undefined,
              // Shade the already-elapsed hours and mark "Jetzt" (idiom shared
              // with ScheduleChart/HistoryChart).
              markArea:
                nowIdx > 0
                  ? {
                      silent: true,
                      itemStyle: { color: withAlpha(t.axis, FILL.past) },
                      data: [[{ xAxis: 0 }, { xAxis: nowIdx }]],
                    }
                  : undefined,
              markLine:
                nowIdx >= 0 && nowIdx < points.length - 1
                  ? {
                      silent: true,
                      symbol: 'none',
                      data: [
                        {
                          xAxis: nowIdx,
                          lineStyle: nowLineStyle(t),
                          // rotate: 0 pins the label horizontal (an hourly axis
                          // otherwise renders it rotated along the line).
                          label: nowLabel(t, 'insideStartTop'),
                        },
                      ],
                    }
                  : undefined,
            }] : []),
            ...(zeigtSonne
              ? [
                  {
                    name: 'Sonnenstärke',
                    type: 'line',
                    ...SMOOTH_SERIES,
                    showSymbol: false,
                    connectNulls: false,
                    yAxisIndex: 1,
                    // Kontext-Stufe: dünner, neutral, ohne Fläche - sie erklärt
                    // die Leitkurve, sie konkurriert nicht mit ihr.
                    lineStyle: { width: STROKE.contextSoft, color: t.temp },
                    itemStyle: { color: t.temp },
                    data: num('ghiWM2'),
                  },
                ]
              : []),
          ],
        },
        true,
      );
    },
    [points, planSlots, detail, hatLeistung, marke?.index, verborgen],
  );

  // EINE Legenden-Grammatik im ganzen Portal: HTML statt Canvas, mit Einheit.
  // Seit P5 steht sie NACH dem Bild (V6: Label → Kernsatz → Bild → Legende) und
  // schaltet ihre Reihen (E7 a). Die Farben sind die aufgeloesten Token, damit
  // Punkt und Kurve garantiert denselben Ton tragen. Die Legende bewirbt NUR,
  // was gezeichnet wird - eine Reihe hinter dem zugeklappten Aufklapper nicht.
  const legend: LegendItem[] = [
    hatLeistung
      ? { color: t.pvLine, label: 'Erwartete Leistung', unit: 'kW', shape: 'area' }
      : { color: t.pvLine, label: 'Sonnenstärke', unit: 'W/m²', shape: 'area' },
    ...(hatLeistung && detail
      ? [{ color: t.temp, label: 'Sonnenstärke', unit: 'W/m²', shape: 'line' as const }]
      : []),
  ];

  return (
    <>
      <HimmelStreifen bloecke={bloecke} />
      <div ref={ref} className="vp-chart" />
      <ChartLegend
        items={legend}
        hidden={verborgen}
        onToggle={(label) => setVerborgen((prev) => toggleSerie(prev, label, legend.length))}
      />
    </>
  );
}

/**
 * K10 · Der Himmelsstreifen: benannte Blöcke statt eines Grau-Wischs, den eine
 * Legende erklären müsste. Er liegt bewusst als HTML über dem Canvas - so
 * bricht das Wort nie am Rand ab und der Streifen bleibt bei jeder Breite
 * lesbar. Ohne Bewölkungsdaten erscheint er GAR NICHT.
 */
function HimmelStreifen({ bloecke }: { bloecke: HimmelBlock[] }) {
  if (bloecke.length === 0) return null;
  return (
    <div className="vp-himmel" aria-label="Bewölkung im Vorhersagezeitraum">
      <span className="vp-himmel-titel">Himmel</span>
      <div className="vp-himmel-bahn">
        {bloecke.map((b) => (
          <span
            key={`${b.art}-${b.von}`}
            className={`vp-himmel-block art-${b.art}`}
            style={{ flexGrow: b.anteil }}
          >
            {b.wort}
          </span>
        ))}
      </div>
    </div>
  );
}
