import type { ForecastAccuracyPoint, ForecastModelId } from './api';
import { chartTheme } from './chartTheme';
import { useEChart } from './useEChart';
import { ChartLegend, type LegendItem } from './components/ChartExplain';

/**
 * Daily forecast accuracy per model as lines over the last weeks: y = mittlere
 * Abweichung (MAE, kW), one line per model - lower is better. The active
 * model renders solid in the brand blue, the learning challenger dashed in
 * solar orange, so "war der Kandidat genauer?" is answerable at a glance
 * without any data-science vocabulary. The legend is the HTML ChartLegend
 * (swatch + label + unit) - the model names are long and the canvas legend
 * would collide with the plot on a phone; the HTML one wraps cleanly.
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

  const ref = useEChart(
    (chart) => {
      const days = [...new Set(points.map((p) => p.day))].sort();
      const byKey = new Map(points.map((p) => [`${p.model}|${p.day}`, p.maeKw]));

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 24, right: 12, bottom: 8, left: 8, containLabel: true },
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
            axisLabel: {
              formatter: (v: string) =>
                new Date(v).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
              color: t.axis,
              hideOverlap: true,
            },
            axisLine: { lineStyle: { color: t.axisLine } },
          },
          yAxis: {
            type: 'value',
            name: 'kW',
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          series: models.map((model) => {
            const isActive = model === activeModel;
            return {
              name: modelLabels[model] ?? model,
              type: 'line',
              connectNulls: false,
              symbolSize: 6,
              data: days.map((d) => byKey.get(`${model}|${d}`) ?? null),
              lineStyle: {
                width: 2.5,
                type: isActive ? 'solid' : 'dashed',
                color: isActive ? t.price : t.pv,
              },
              itemStyle: { color: isActive ? t.price : t.pv },
            };
          }),
        },
        true,
      );
    },
    [points, modelLabels, activeModel],
  );

  const legend: LegendItem[] = models.map((model) => ({
    color: model === activeModel ? t.price : t.pv,
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
