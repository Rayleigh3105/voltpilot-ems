import type { EarningsRange, SiteEarningsBucket, SiteEarningsRange } from '../api';
import { bucketAxisLabel, bucketTooltipLabel } from '../anlage';
import type { Kernaussage } from '../chartKopf';
import { AXIS, BAR, ghostItem, ghostLine, SMOOTH_SERIES, STROKE } from '../chartStyle';
import { vergleichName, vergleichReihe } from '../chartCopy';
import { chartTheme } from '../chartTheme';
import { eurAmount } from '../format';
import { geldVerlauf, verlaufKern, type GeldReihe } from '../erloesKomposition';
import { angleichen, type UeberlagerungLegende } from '../historieVergleich';
import { useEChart } from '../useEChart';
import { ChartHeadline, ChartInsight, ChartLegend, ChartSubtitle } from './ChartExplain';
import { UeberlagerungLegendeZeile } from './HistorieWelt';

/**
 * **Karte 2 der Erlöse-Welt · „Geld im Verlauf"** — die drei Teile des
 * Ergebnisses über die Zeit: Einspeise-Erlös und Wert des Eigenverbrauchs
 * gestapelt nach OBEN, Stromkosten nach UNTEN, dazu die kumulierte Linie, die
 * am Ende genau auf dem Netto-Ergebnis des Zeitraums landet.
 *
 * Reine Render-Schicht: alle Zahlen kommen aus `erloesKomposition.geldVerlauf`
 * (unit-getestet), die Farben aus der geteilten `chartTheme()`-Palette — rot
 * ist hier korrekt, denn es sind echte Kosten (die Konvention der
 * `HistoryChart`-Netzbezugs-Reihe), und die kumulierte Linie trägt die
 * Aktions-Tinte.
 *
 * Der Maßstab folgt dem Zeitraum (P6): Stunden am Tag, Tage in Woche und Monat,
 * Monate im Jahr — die Balkenbreite ist die Aussage, nicht ein Zoom.
 */
/**
 * Die EINE Farbzuordnung je Geld-Reihe — Balken und Legende lesen sie, damit
 * eine Reihe im Bild nie eine andere Farbe trägt als in ihrer Beschriftung.
 */
const LEGENDEN_FARBE = (t: ReturnType<typeof chartTheme>): Record<GeldReihe['id'], string> => ({
  einspeisung: t.price,
  eigenverbrauchswert: t.charge,
  stromkosten: t.discharge,
});

export function ErloeseVerlaufChart({
  series,
  range,
  vergleich,
  legende,
  kern,
}: {
  series: SiteEarningsBucket[];
  range: SiteEarningsRange;
  /**
   * **F8 · die Überlagerung**: die Balken der Vergleichsperiode werden NICHT
   * gestapelt (zwei Stapel übereinander sind unlesbar), sondern als blasse,
   * gestrichelte Linien in DERSELBEN Farbe je Größe gezeichnet — plus die
   * kumulierte Linie, die die Aussage der Karte trägt. Ohne Werte ist das
   * Diagramm zeichengleich zu vorher.
   */
  vergleich?: SiteEarningsBucket[] | null;
  legende?: UeberlagerungLegende | null;
  /**
   * K1/M11 · der Kernaussage-Slot. **Seit P6 hat der Verlauf seine EIGENE
   * Aussage** (`verlaufKern`, Konzept §3.1 Position 3): sie beantwortet „WANN
   * kam das Geld?", nennt also den stärksten Eimer — nicht die Summe des
   * Zeitraums, die eine Karte darüber steht. Wer hier eine Zahl übergibt, die
   * das Ergebnis wiederholt, baut die vierfache Geld-Aussage wieder ein, die
   * der Mobil-Umbau abgeschafft hat.
   *
   * Wird nichts übergeben, leitet die Karte ihn selbst ab.
   */
  kern?: Kernaussage | null;
}) {
  const view = geldVerlauf(series, range);
  const vglView = vergleich && vergleich.length > 0 ? geldVerlauf(vergleich, range) : null;
  // Die Beschriftungs-Helfer der Geld-Ansicht kennen Tag/Monat/„sonst"; eine
  // Woche wird wie ein Monat beschriftet (Tage), „Gesamt" wie ein Jahr (Monate).
  const labelRange: EarningsRange =
    range === 'day' ? 'day' : range === 'week' || range === 'month' ? 'month' : 'year';

  const ref = useEChart(
    (chart) => {
      const t = chartTheme();
      const hue = LEGENDEN_FARBE(t);
      const vglName = legende?.vergleich ?? null;

      chart.setOption(
        {
          textStyle: { fontFamily: t.font },
          grid: { left: 6, right: 6, top: 12, bottom: 4, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            axisPointer: { type: 'shadow' },
            formatter: (params: { dataIndex: number }[]) => {
              const i = params[0].dataIndex;
              const lines = view.reihen
                .filter((r) => Math.abs(r.data[i]) >= 0.005)
                .map((r) => `${r.label}: <b>${eurAmount(r.data[i])}</b>`);
              lines.push(`kumuliert: <b>${eurAmount(view.kumuliert[i])}</b>`);
              // F8: beide Zeiträume in EINEM Tooltip - der Vergleich ist erst
              // eine Aussage, wenn beide Zahlen nebeneinander stehen.
              if (vglView && !vglView.leer) {
                const k = vglView.kumuliert[i];
                lines.push(
                  k == null
                    ? `<span style="opacity:.7">${vergleichName(vglName)}: keine Daten</span>`
                    : `<span style="opacity:.7">${vergleichName(vglName)} kumuliert: ${eurAmount(k)}</span>`,
                );
              }
              return `${bucketTooltipLabel(view.starts[i], labelRange)}<br/>${lines.join('<br/>')}`;
            },
          },
          xAxis: {
            type: 'category',
            data: view.starts.map((s) => bucketAxisLabel(s, labelRange)),
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { color: t.axis, hideOverlap: true, fontSize: AXIS.fontSize },
          },
          yAxis: {
            type: 'value',
            axisLabel: {
              color: t.axis,
              fontSize: AXIS.fontSize,
              formatter: (v: number) => `${v.toLocaleString('de-DE')} €`,
            },
            splitLine: { lineStyle: { color: t.grid } },
          },
          series: [
            // Zuerst die Vergleichsperiode: blass, gestrichelt, hinter allem.
            ...(vglView && !vglView.leer
              ? [
                  ...vglView.reihen.map((r) => ({
                    name: vergleichReihe(r.label, vglName),
                    type: 'line' as const,
                    ...SMOOTH_SERIES,
                    symbol: 'none',
                    silent: true,
                    z: 0,
                    data: angleichen(r.data, view.starts.length),
                    // M9: die EINE Geister-Grammatik (`chartStyle.GHOST`).
                    lineStyle: ghostLine(hue[r.id]),
                    itemStyle: ghostItem(hue[r.id]),
                  })),
                  {
                    name: vergleichReihe('kumuliert', vglName),
                    type: 'line' as const,
                    ...SMOOTH_SERIES,
                    symbol: 'none',
                    silent: true,
                    z: 0,
                    data: angleichen(vglView.kumuliert, view.starts.length),
                    lineStyle: ghostLine(t.plan),
                    itemStyle: ghostItem(t.plan),
                  },
                ]
              : []),
            ...view.reihen.map((r) => ({
              name: r.label,
              type: 'bar',
              stack: 'geld',
              // F9: EIN Breiten-Deckel im ganzen Portal (vorher 16 und 26).
              barMaxWidth: BAR.maxWidth,
              barCategoryGap: BAR.categoryGap,
              itemStyle: { color: hue[r.id] },
              data: r.data,
            })),
            {
              name: 'kumuliert',
              type: 'line',
              // ⚠ `smooth: true` ist der ECharts-Faktor 0,5 und schwingt
              // zwischen zwei Stuetzstellen ueber - auf einer KUMULIERTEN
              // Geldkurve heisst das, sie faellt sichtbar unter einen Stand,
              // den sie nie hatte. `SMOOTH_SERIES` (0,2 + smoothMonotone) ist
              // die Hausregel; diese Flaeche war die letzte mit dem Footgun.
              ...SMOOTH_SERIES,
              symbol: 'none',
              // F1-Hierarchie: die kumulierte Linie IST die Aussage der Flaeche.
              lineStyle: { color: t.plan, width: STROKE.lead },
              itemStyle: { color: t.plan },
              data: view.kumuliert,
              // Die betonte Nulllinie: darüber Erlöse, darunter Kosten.
              markLine: {
                silent: true,
                symbol: 'none',
                // F4: die Nulllinie ist eine eigene, etwas dunklere Haarlinie.
                lineStyle: { color: t.axisLine, width: STROKE.ref, type: 'solid' },
                label: { show: false },
                data: [{ yAxis: 0 }],
              },
            },
          ],
        },
        true,
      );
    },
    [series, range, vergleich, legende],
  );

  if (view.leer) {
    return (
      <>
        <ChartSubtitle>{view.untertitel}</ChartSubtitle>
        <p className="vp-muted">
          Für diesen Zeitraum gibt es noch keine bewerteten Viertelstunden - sobald Messwerte
          und Börsenpreise vorliegen, entsteht hier der Verlauf.
        </p>
      </>
    );
  }

  const t = chartTheme();
  return (
    <>
      <ChartHeadline kern={kern ?? verlaufKern(view, range)} />
      <ChartSubtitle>{view.untertitel}</ChartSubtitle>
      {/* K3 · die Legende bewirbt NUR, was gezeichnet wird (Befund B8): sie
          liest dieselbe `view.reihen`, aus der auch die Balken entstehen —
          eine über den ganzen Zeitraum leere Reihe (z. B. der Wert des
          Eigenverbrauchs ohne hinterlegten Tarif) steht deshalb weder im Bild
          noch in der Legende. */}
      <ChartLegend
        items={[
          ...view.reihen.map((r) => ({
            label: r.label,
            color: LEGENDEN_FARBE(t)[r.id],
            unit: '€',
          })),
          { label: 'kumuliert', color: t.plan, unit: '€', shape: 'line' as const },
        ]}
      />
      {vglView && !vglView.leer && <UeberlagerungLegendeZeile legende={legende ?? null} />}
      <div
        className="vp-chart compact"
        ref={ref}
        role="img"
        aria-label="Erlöse und Stromkosten im Verlauf"
      />
      {view.kumuliertText && <ChartInsight icon="euro">{view.kumuliertText}</ChartInsight>}
    </>
  );
}
