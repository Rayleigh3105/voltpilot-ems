import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { TelemetryPoint } from './api';

/**
 * Line chart of a site's telemetry (PV, load, net power on the left axis,
 * battery SoC on the right). Brand palette from the design-system category
 * colors: solar orange, home blue, primary blue, battery purple.
 */
export function TelemetryChart({ points }: { points: TelemetryPoint[] }) {
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
    const time = points.map((p) => p.ts);
    const series = (name: string, key: keyof TelemetryPoint, color: string, axis = 0) => ({
      name,
      type: 'line' as const,
      smooth: true,
      showSymbol: false,
      yAxisIndex: axis,
      lineStyle: { width: 2.5, color },
      itemStyle: { color },
      areaStyle: axis === 0 ? { opacity: 0.06, color } : undefined,
      data: points.map((p) => p[key] as number | null),
    });

    chart.current.setOption({
      textStyle: { fontFamily: 'Inter, sans-serif', color: '#6C757D' },
      grid: { top: 48, right: 56, bottom: 40, left: 56 },
      tooltip: { trigger: 'axis' },
      legend: {
        top: 8,
        icon: 'roundRect',
        textStyle: { color: '#1A1A1A', fontWeight: 600 },
      },
      xAxis: {
        type: 'category',
        data: time,
        boundaryGap: false,
        axisLabel: {
          formatter: (v: string) =>
            new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
        axisLine: { lineStyle: { color: '#E9ECEF' } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'kW',
          splitLine: { lineStyle: { color: '#F1F3F5' } },
          axisLabel: { color: '#6C757D' },
        },
        {
          type: 'value',
          name: 'SoC %',
          min: 0,
          max: 100,
          position: 'right',
          splitLine: { show: false },
          axisLabel: { color: '#9C27B0' },
        },
      ],
      series: [
        series('PV', 'pvPowerKw', '#FF9800'),
        series('Load', 'loadKw', '#2196F3'),
        series('Net power', 'powerKw', '#5A8DE8'),
        series('Battery SoC', 'socPct', '#9C27B0', 1),
      ],
    });
  }, [points]);

  return <div ref={ref} style={{ width: '100%', height: 360 }} />;
}
