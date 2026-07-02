import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { ForecastAccuracyPoint, ForecastModelId } from './api';

/**
 * Daily forecast accuracy per model as lines over the last weeks: y = mittlere
 * Abweichung (MAE, kW), one line per model - lower is better. The active
 * model renders solid in the brand blue, the learning challenger dashed in
 * solar orange, so "war der Kandidat genauer?" is answerable at a glance
 * without any data-science vocabulary.
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
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const onResize = () => chart.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const days = [...new Set(points.map((p) => p.day))].sort();
    const models = [...new Set(points.map((p) => p.model))].sort(
      // Active model first, so the legend reads "live model, then candidates".
      (a, b) => Number(b === activeModel) - Number(a === activeModel),
    );
    const byKey = new Map(points.map((p) => [`${p.model}|${p.day}`, p.maeKw]));

    chart.current.setOption(
      {
        textStyle: { fontFamily: 'Inter, sans-serif', color: '#6C757D' },
        grid: { top: 40, right: 12, bottom: 28, left: 8, containLabel: true },
        legend: {
          top: 0,
          left: 0,
          icon: 'roundRect',
          itemWidth: 14,
          itemHeight: 3,
          textStyle: { color: '#6C757D' },
        },
        tooltip: {
          trigger: 'axis',
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
            color: '#6C757D',
          },
          axisLine: { lineStyle: { color: '#E9ECEF' } },
        },
        yAxis: {
          type: 'value',
          name: 'kW',
          splitLine: { lineStyle: { color: '#F1F3F5' } },
          axisLabel: { color: '#6C757D' },
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
              color: isActive ? '#5A8DE8' : '#FF9800',
            },
            itemStyle: { color: isActive ? '#5A8DE8' : '#FF9800' },
          };
        }),
      },
      true,
    );
  }, [points, modelLabels, activeModel]);

  return <div ref={ref} style={{ width: '100%', height: 280 }} />;
}
