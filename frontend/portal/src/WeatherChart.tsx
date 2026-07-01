import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { WeatherPoint } from './api';

/**
 * Hourly weather forecast: temperature (line, left °C), cloud cover (grey area,
 * right %) and shortwave/GHI irradiance (solar-orange area, offset right W/m² -
 * the PV-relevant channel). Palette from the design-system category colours.
 */
export function WeatherChart({ points }: { points: WeatherPoint[] }) {
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
    const num = (key: keyof WeatherPoint) =>
      points.map((p) => (p[key] == null ? null : Number(p[key])));

    chart.current.setOption(
      {
        textStyle: { fontFamily: 'Inter, sans-serif', color: '#6C757D' },
        grid: { top: 40, right: 92, bottom: 40, left: 52 },
        tooltip: { trigger: 'axis' },
        legend: { top: 8, icon: 'roundRect', textStyle: { color: '#1A1A1A', fontWeight: 600 } },
        xAxis: {
          type: 'category',
          data: time,
          boundaryGap: false,
          axisLabel: {
            formatter: (v: string) =>
              new Date(v).toLocaleString([], {
                weekday: 'short',
                hour: '2-digit',
              }),
            color: '#6C757D',
          },
          axisLine: { lineStyle: { color: '#E9ECEF' } },
        },
        yAxis: [
          {
            type: 'value',
            name: '°C',
            position: 'left',
            splitLine: { lineStyle: { color: '#F1F3F5' } },
            axisLabel: { color: '#6C757D' },
          },
          {
            type: 'value',
            name: 'Wolken %',
            min: 0,
            max: 100,
            position: 'right',
            splitLine: { show: false },
            axisLabel: { color: '#90A4AE' },
          },
          {
            type: 'value',
            name: 'W/m²',
            position: 'right',
            offset: 56,
            splitLine: { show: false },
            axisLabel: { color: '#FF9800' },
          },
        ],
        series: [
          {
            name: 'Temperatur',
            type: 'line',
            smooth: true,
            showSymbol: false,
            yAxisIndex: 0,
            lineStyle: { width: 2.5, color: '#E8833A' },
            itemStyle: { color: '#E8833A' },
            data: num('temperatureC'),
          },
          {
            name: 'Wolken',
            type: 'line',
            smooth: true,
            showSymbol: false,
            yAxisIndex: 1,
            lineStyle: { width: 1.5, color: '#90A4AE' },
            itemStyle: { color: '#90A4AE' },
            areaStyle: { opacity: 0.12, color: '#90A4AE' },
            data: num('cloudCoverPct'),
          },
          {
            name: 'Einstrahlung (GHI)',
            type: 'line',
            smooth: true,
            showSymbol: false,
            yAxisIndex: 2,
            lineStyle: { width: 2, color: '#FF9800' },
            itemStyle: { color: '#FF9800' },
            areaStyle: { opacity: 0.14, color: '#FF9800' },
            data: num('ghiWM2'),
          },
        ],
      },
      true,
    );
  }, [points]);

  return <div ref={ref} style={{ width: '100%', height: 320 }} />;
}
