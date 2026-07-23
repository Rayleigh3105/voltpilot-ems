import type { EarningsRange, History } from '../api';
import { chartTheme } from '../chartTheme';
import { useEChart } from '../useEChart';
import {
  metricHasData,
  noVerlaufNote,
  widgetSeries,
  type SeriesColor,
  type WidgetMetric,
} from '../widgetHistory';
import { ChartInsight, ChartLegend, type LegendItem, type SwatchShape } from './ChartExplain';

/**
 * Portal v3.2 · **M2** — der **Verlauf** einer Cockpit-Kachel, im Detail-Modal
 * direkt unter ihren Werten. Wiederverwendet die geteilte Diagramm-Maschine
 * (`useEChart` + `chartTheme`, der `HistoryChart`/`PeakHistoryChart`-Pfad) — es
 * gibt KEINEN neuen Chart-Stack. Die Reihe folgt dem **gewählten Zeitraum**
 * (`widgetSeries`): Tag → Leistungs-Kurve (kW), Woche/Monat/Jahr → Energie-
 * Balken (kWh), Ladestand → Prozent-Kurve.
 *
 * Ehrlichkeit: liegt für den Zeitraum kein Verlauf vor (Gesamt, frische
 * Anlage), rendert es einen deutschen Satz statt eines erfundenen Diagramms
 * (die „—"-Disziplin, `metricHasData`).
 */
export function WidgetHistoryChart({
  history,
  metric,
  range,
  periodLabel,
}: {
  history: History | null;
  metric: WidgetMetric;
  range: EarningsRange;
  /** Das Periodenetikett des gewählten Zeitraums (z. B. „Juli", „Heute"). */
  periodLabel: string;
}) {
  const t = chartTheme();
  const has = metricHasData(history, metric);
  const hue = (c: SeriesColor): string => t[c];

  const ref = useEChart(
    (chart, width) => {
      if (!has || !history) return;
      const view = widgetSeries(history, metric);
      const narrow = width < 480;
      const isLine = view.axis === 'percent' || view.day;

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 18, right: narrow ? 12 : 16, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: any[]) => {
              const lines = [`<b>${bucketLabel(params[0]?.axisValue, view.day)}</b>`];
              for (const p of params) {
                if (p.value == null) continue;
                lines.push(
                  `${p.marker} ${p.seriesName}: ${Number(p.value).toLocaleString('de-DE', {
                    maximumFractionDigits: view.unit === '%' ? 0 : 2,
                  })} ${view.unit}`,
                );
              }
              return lines.join('<br/>');
            },
          },
          xAxis: {
            type: 'category',
            data: view.labels,
            boundaryGap: !isLine,
            axisLabel: {
              formatter: (v: string) => bucketLabel(v, view.day),
              color: t.axis,
              hideOverlap: true,
            },
            axisLine: { lineStyle: { color: t.axisLine } },
          },
          yAxis: {
            type: 'value',
            name: view.unit,
            nameTextStyle: { color: t.axis, align: 'left' },
            nameGap: 12,
            min: view.axis === 'percent' ? 0 : undefined,
            max: view.axis === 'percent' ? 100 : undefined,
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          series: view.series.map((s) =>
            isLine
              ? {
                  name: s.label,
                  type: 'line' as const,
                  smooth: true,
                  showSymbol: false,
                  lineStyle: { width: 2.5, color: hue(s.color) },
                  itemStyle: { color: hue(s.color) },
                  areaStyle:
                    view.axis === 'percent' ? undefined : { opacity: 0.06, color: hue(s.color) },
                  data: s.data,
                }
              : {
                  name: s.label,
                  type: 'bar' as const,
                  barMaxWidth: 18,
                  itemStyle: { color: hue(s.color), borderRadius: 2 },
                  data: s.data,
                },
          ),
        },
        true,
      );
    },
    [history, metric, has, t],
  );

  const shape: SwatchShape = metric.axis === 'percent' ? 'line' : range === 'day' ? 'area' : 'bar';
  const unit = metric.axis === 'percent' ? '%' : range === 'day' ? 'kW' : 'kWh';
  const legend: LegendItem[] = metric.series.map((s) => ({
    color: hue(s.color),
    label: s.label,
    unit,
    shape,
  }));

  return (
    <section className="vp-wmodal-verlauf">
      <span className="vp-wmodal-verlauf-title">Verlauf · {periodLabel}</span>
      {has ? (
        <>
          <ChartLegend items={legend} />
          <div ref={ref} className="vp-chart vp-chart-modal" />
          <ChartInsight>{metric.insight}</ChartInsight>
        </>
      ) : (
        <p className="vp-wmodal-noverlauf">{noVerlaufNote(range)}</p>
      )}
    </section>
  );
}

/** Bucket-Etikett: Tag → „12:15 Uhr", sonst „15.06.". */
function bucketLabel(iso: string, day: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return day
    ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}
