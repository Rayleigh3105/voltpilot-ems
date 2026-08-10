import type { ForecastAccuracyPoint, ForecastModelId } from './api';
import {
  AXIS,
  DIRECT_LABEL_GUTTER_PX,
  FILL,
  NARROW_PX,
  STROKE,
  directLabel,
  withAlpha,
} from './chartStyle';
import { AXIS as AXIS_NAME } from './chartCopy';
import { chartTheme } from './chartTheme';
import { POLARITAET, direktEtikett, verbesserung } from './prognose';
import { useEChart } from './useEChart';
import { ChartLegend, type LegendItem } from './components/ChartExplain';

/**
 * Wie weit lagen die Modelle daneben? — die tägliche mittlere Abweichung je
 * Modell, UNTEN ist besser.
 *
 * Drei Dinge, die diese Fläche seit dem Chart-Redesign Stufe 4 sagt und vorher
 * verschwieg (Scout `vp-charts-verstaendlich-r2` §6 F):
 *
 *  1. **Die POLARITÄT steht im Bild.** Die aktive Linie liegt oben, oben ist
 *     hier aber SCHLECHTER — ein Laie liest das genau verkehrt herum. „↑
 *     schlechter" und „↓ besser" stehen deshalb INNEN am Rand; außen lief der
 *     Text in der Revision 1 aus der Fläche heraus.
 *  2. **Die Fläche zwischen den Kurven trägt ihr WORT** („so viel besser war
 *     der Kandidat"). Sie ist die eigentliche Aussage; unbenannt war sie eine
 *     Kodierung mit Bedienungsanleitung (K10).
 *  3. **Die Einheit ist Klartext** („Kilowatt Abweichung"): „Ø kW" liest sich
 *     als Durchschnittsleistung.
 *
 * F1-Hierarchie: das AKTIVE Modell trägt die Aussage (2,2 px, Preis-Blau), der
 * Kandidat ist KONTEXT (1,4 px, gestrichelt, neutrales Schiefer). Der frühere
 * Orange-Ton des Kandidaten ist damit weg — gegen die grüne Verbesserungs-
 * Fläche maß er ΔE 3,6 (harter CVD-FAIL), das Neutral misst 12,2.
 *
 * Die Legende ist die HTML-`ChartLegend` (Swatch + Label + Einheit) — die
 * Modellnamen sind lang und die Canvas-Legende kollidierte am Telefon mit dem
 * Bild.
 */
export function ForecastQualityChart({
  points,
  modelLabels,
  activeModel,
}: {
  points: ForecastAccuracyPoint[];
  modelLabels: Record<string, string>;
  activeModel: ForecastModelId;
}) {
  const t = chartTheme();
  const models = [...new Set(points.map((p) => p.model))].sort(
    // Active model first, so the legend reads "live model, then candidates".
    (a, b) => Number(b === activeModel) - Number(a === activeModel),
  );
  /** Der EINE Kandidat der Prognoseart (mehr als einen gibt es nicht). */
  const kandidat = models.find((m) => m !== activeModel) ?? null;

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < NARROW_PX;
      const days = [...new Set(points.map((p) => p.day))].sort();
      const byKey = new Map(points.map((p) => [`${p.model}|${p.day}`, p.maeKw]));
      const reihe = (model: ForecastModelId | null) =>
        model == null ? days.map(() => null) : days.map((d) => byKey.get(`${model}|${d}`) ?? null);

      const aktivWerte = reihe(activeModel);
      // Der obere Polaritäts-Anker haengt am hoechsten GEZEICHNETEN Wert. Ein
      // `type: 'max'`-markLine mit unsichtbarer Linie rendert sein Label nicht
      // zuverlaessig (im Screenshot fehlte „↑ schlechter" ganz) - der Wert wird
      // deshalb selbst gerechnet und als `yAxis`-Marke gesetzt.
      const hoechster = Math.max(
        0,
        ...points.map((p) => p.maeKw).filter((v): v is number => typeof v === 'number'),
      );
      const kandidatWerte = reihe(kandidat);
      const flaeche = verbesserung(aktivWerte, kandidatWerte);
      // Die Marke für das Flächen-Wort: der Tag mit dem größten Vorsprung -
      // dort ist am meisten Platz, und dort ist die Aussage am stärksten.
      let besterTag = -1;
      flaeche.delta.forEach((d, i) => {
        if (d == null) return;
        if (besterTag < 0 || d > (flaeche.delta[besterTag] as number)) besterTag = i;
      });

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          // Kopfraum für die Polaritäts-Marke oben; rechts der Rand für die
          // Direktbeschriftung (ohne ihn schneidet ECharts das Etikett ab).
          grid: {
            top: 30,
            // Die Etiketten dieser Flaeche sind zweiwortig („Kandidat Ø ±0,54
            // kW") und damit laenger als der geteilte Vorgabe-Rand - der hat
            // sie im Screenshot am rechten Canvas-Rand abgeschnitten.
            right: narrow ? 12 : DIRECT_LABEL_GUTTER_PX + 32,
            bottom: 8,
            left: 8,
            containLabel: true,
          },
          tooltip: {
            trigger: 'axis',
            confine: true,
            valueFormatter: (v: number | null) =>
              v == null
                ? '-'
                : `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW Abweichung`,
          },
          xAxis: {
            type: 'category',
            data: days,
            boundaryGap: false,
            axisLabel: {
              formatter: (v: string) =>
                new Date(v).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
              color: t.axis,
              fontSize: AXIS.fontSize,
              hideOverlap: true,
            },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: {
            type: 'value',
            // K4: „Ø kW" liest sich als Durchschnittsleistung - hier steht die
            // Einheit als WORT.
            name: AXIS_NAME.abweichung(narrow),
            // Linksbuendig verankert, sonst haengt die halbe Beschriftung aus
            // dem Canvas („Kilowatt Abweichung" rendert als „vatt Abweichung").
            nameLocation: 'end',
            nameGap: 12,
            nameTextStyle: { align: 'left' },
            min: 0,
            splitLine: { lineStyle: { color: t.grid } },
            axisTick: { show: false },
            axisLine: { show: false },
            axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
          },
          series: [
            // Die Verbesserungs-Fläche liegt HINTER den Kurven: zwei gestapelte
            // Hilfsreihen (untere Kante unsichtbar + die Differenz als Fläche).
            {
              name: 'vorsprung-unten',
              type: 'line',
              data: flaeche.unten,
              stack: 'verbesserung',
              symbol: 'none',
              silent: true,
              lineStyle: { opacity: 0 },
              areaStyle: { opacity: 0 },
              z: 1,
            },
            {
              name: 'vorsprung',
              type: 'line',
              data: flaeche.delta,
              stack: 'verbesserung',
              symbol: 'none',
              silent: true,
              lineStyle: { opacity: 0 },
              areaStyle: { color: t.guenstig, opacity: FILL.speaking },
              z: 1,
              // K10: die Fläche trägt ihr WORT - unbenannt war sie ein Rätsel.
              markPoint:
                flaeche.wort != null && besterTag >= 0
                  ? {
                      silent: true,
                      symbol: 'circle',
                      symbolSize: 0,
                      data: [
                        {
                          coord: [besterTag, flaeche.unten[besterTag]],
                          label: {
                            show: true,
                            position: 'top',
                            distance: 2,
                            formatter: flaeche.wort,
                            color: t.guenstig,
                            fontSize: AXIS.fontSize,
                            fontWeight: 600,
                            backgroundColor: withAlpha(t.guenstig, 0.1),
                            padding: [2, 6],
                            borderRadius: 4,
                          },
                        },
                      ],
                    }
                  : undefined,
            },
            ...models.map((model) => {
              const isActive = model === activeModel;
              // K2: Name + Ø-Wert AM Kurvenende. Er steht dort statt im Kopf,
              // weil er dort nicht von der Kurve abweichen kann - und weil
              // dieselben zwei Zahlen im Kopf eine Doppelung der Verdikt-Karte
              // wären. Am Telefon ist rechts kein Platz dafür.
              const etikett = narrow ? null : direktEtikett(points, model, isActive);
              return {
                name: modelLabels[model] ?? model,
                type: 'line',
                connectNulls: false,
                showSymbol: false,
                data: reihe(model),
                z: 2,
                ...(etikett
                  ? directLabel(isActive ? t.price : t.temp, () => etikett)
                  : {}),
                lineStyle: {
                  // F1-Hierarchie: das AKTIVE Modell traegt die Aussage, der
                  // Kandidat ist Kontext. F6: gestrichelt heisst Kandidat.
                  width: isActive ? STROKE.lead : STROKE.contextSoft,
                  type: isActive ? 'solid' : 'dashed',
                  color: isActive ? t.price : t.temp,
                },
                itemStyle: { color: isActive ? t.price : t.temp },
                // Die Polaritaets-Anker haengen an der aktiven Reihe - sie
                // stehen INNEN am Rand, damit sie die Flaeche nie verlassen.
                markLine: isActive
                  ? {
                      silent: true,
                      symbol: 'none',
                      data: [
                        {
                          // ⚠ Die Linie ist eine HAARLINIE in Rasterfarbe, NICHT
                          // `opacity: 0`: eine unsichtbare markLine nimmt in
                          // ECharts ihr LABEL mit - genau daran fehlte
                          // „↑ schlechter" im ersten Bau (im Screenshot
                          // aufgefallen, während „↓ besser" mit sichtbarer
                          // Linie erschien).
                          yAxis: hoechster,
                          lineStyle: { color: t.grid, width: STROKE.ref },
                          label: {
                            formatter: POLARITAET.oben,
                            position: 'insideStartTop',
                            color: t.axis,
                            fontSize: AXIS.fontSize,
                            rotate: 0,
                          },
                        },
                        {
                          yAxis: 0,
                          lineStyle: { color: t.axisLine, width: STROKE.ref },
                          label: {
                            formatter: POLARITAET.unten,
                            position: 'insideStartTop',
                            color: t.guenstig,
                            fontSize: AXIS.fontSize,
                            fontWeight: 600,
                            rotate: 0,
                          },
                        },
                      ],
                    }
                  : undefined,
              };
            }),
          ],
        },
        true,
      );
    },
    [points, modelLabels, activeModel, kandidat],
  );

  const legend: LegendItem[] = models.map((model) => ({
    color: model === activeModel ? t.price : t.temp,
    label: modelLabels[model] ?? model,
    unit: 'kW',
    shape: model === activeModel ? 'line' : 'dashed',
  }));

  return (
    <div>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart compact" />
    </div>
  );
}
