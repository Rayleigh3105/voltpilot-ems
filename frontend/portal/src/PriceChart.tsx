import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { PriceSeries } from './api';

/**
 * Day-ahead spot prices as 15-min bars for today + tomorrow. Bars are colour-
 * graded low -> high (design-system green -> solar orange -> red) via a visualMap,
 * and a dashed marker separates today from tomorrow at local midnight. Prices are
 * EUR/MWh (API native); the tooltip also shows ct/kWh (= EUR/MWh / 10).
 */
export function PriceChart({ series }: { series: PriceSeries }) {
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
    // Forward-looking widget: show today + tomorrow (the API may also return
    // yesterday for the history views).
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const pts = series.points.filter((p) => new Date(p.ts) >= startOfToday);
    const times = pts.map((p) => p.ts);
    const values = pts.map((p) => (p.priceEurMwh == null ? null : Number(p.priceEurMwh)));
    const nums = values.filter((v): v is number => v != null);
    const min = nums.length ? Math.min(...nums) : 0;
    const max = nums.length ? Math.max(...nums) : 100;

    // Index of the first slot on the actual local "tomorrow" - drives the
    // today/tomorrow divider (robust even when the series includes yesterday).
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const boundaryIdx = pts.findIndex(
      (p) => new Date(p.ts).toDateString() === tomorrow.toDateString(),
    );

    chart.current.setOption(
      {
        textStyle: { fontFamily: 'Inter, sans-serif', color: '#6C757D' },
        grid: { top: 28, right: 12, bottom: 28, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: number | null) =>
            v == null
              ? '-'
              : `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} EUR/MWh (${(v / 10).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ct/kWh)`,
        },
        visualMap: {
          show: false,
          min,
          max,
          dimension: 1,
          inRange: { color: ['#2E9E5B', '#FF9800', '#E53935'] },
        },
        xAxis: {
          type: 'category',
          data: times,
          axisLabel: {
            formatter: (v: string) =>
              new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            color: '#6C757D',
          },
          axisLine: { lineStyle: { color: '#E9ECEF' } },
        },
        yAxis: {
          type: 'value',
          name: 'EUR/MWh',
          splitLine: { lineStyle: { color: '#F1F3F5' } },
          axisLabel: { color: '#6C757D' },
        },
        series: [
          {
            name: 'Börsenpreis',
            type: 'bar',
            data: values,
            barCategoryGap: '10%',
            itemStyle: { borderRadius: [2, 2, 0, 0] },
            markLine:
              boundaryIdx > 0
                ? {
                    silent: true,
                    symbol: 'none',
                    lineStyle: { color: '#5A8DE8', type: 'dashed', width: 1.5 },
                    label: { formatter: 'Morgen', color: '#5A8DE8', position: 'insideEndTop' },
                    data: [{ xAxis: boundaryIdx }],
                  }
                : undefined,
          },
        ],
      },
      true,
    );
  }, [series]);

  return <div ref={ref} style={{ width: '100%', height: 300 }} />;
}
