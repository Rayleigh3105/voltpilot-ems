import type { EarningsRange, SiteEarningsBucket, SiteEarningsRange } from '../api';
import { bucketAxisLabel, bucketTooltipLabel } from '../anlage';
import { chartTheme } from '../chartTheme';
import { eurAmount } from '../format';
import { geldVerlauf, type GeldReihe } from '../erloesKomposition';
import { useEChart } from '../useEChart';
import { ChartInsight, ChartLegend, ChartSubtitle } from './ChartExplain';

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
export function ErloeseVerlaufChart({
  series,
  range,
}: {
  series: SiteEarningsBucket[];
  range: SiteEarningsRange;
}) {
  const view = geldVerlauf(series, range);
  // Die Beschriftungs-Helfer der Geld-Ansicht kennen Tag/Monat/„sonst"; eine
  // Woche wird wie ein Monat beschriftet (Tage), „Gesamt" wie ein Jahr (Monate).
  const labelRange: EarningsRange =
    range === 'day' ? 'day' : range === 'week' || range === 'month' ? 'month' : 'year';

  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < 480;
      const hue: Record<GeldReihe['id'], string> = {
        einspeisung: t.price,
        eigenverbrauchswert: t.charge,
        stromkosten: t.discharge,
      };

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
              return `${bucketTooltipLabel(view.starts[i], labelRange)}<br/>${lines.join('<br/>')}`;
            },
          },
          xAxis: {
            type: 'category',
            data: view.starts.map((s) => bucketAxisLabel(s, labelRange)),
            axisLine: { lineStyle: { color: t.axisLine } },
            axisTick: { show: false },
            axisLabel: { color: t.axis, hideOverlap: true, fontSize: narrow ? 10 : 11 },
          },
          yAxis: {
            type: 'value',
            axisLabel: {
              color: t.axis,
              fontSize: narrow ? 10 : 11,
              formatter: (v: number) => `${v.toLocaleString('de-DE')} €`,
            },
            splitLine: { lineStyle: { color: t.grid } },
          },
          series: [
            ...view.reihen.map((r) => ({
              name: r.label,
              type: 'bar',
              stack: 'geld',
              barMaxWidth: 26,
              itemStyle: { color: hue[r.id] },
              data: r.data,
            })),
            {
              name: 'kumuliert',
              type: 'line',
              smooth: true,
              symbol: 'none',
              lineStyle: { color: t.plan, width: 2 },
              itemStyle: { color: t.plan },
              data: view.kumuliert,
              // Die betonte Nulllinie: darüber Erlöse, darunter Kosten.
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: t.axis, width: 1, type: 'solid', opacity: 0.5 },
                label: { show: false },
                data: [{ yAxis: 0 }],
              },
            },
          ],
        },
        true,
      );
    },
    [series, range],
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
      <ChartSubtitle>{view.untertitel}</ChartSubtitle>
      <ChartLegend
        items={[
          { label: 'Einspeise-Erlös', color: t.price, unit: '€' },
          { label: 'Wert des Eigenverbrauchs', color: t.charge, unit: '€' },
          { label: 'Stromkosten', color: t.discharge, unit: '€' },
          { label: 'kumuliert', color: t.plan, unit: '€', shape: 'line' },
        ]}
      />
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
