import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type { WeatherPoint } from './api';
import { chartTheme } from './chartTheme';

/**
 * Hourly weather forecast: temperature (line, left °C), cloud cover (grey area,
 * right %) and shortwave/GHI irradiance (solar-orange area, offset right W/m² -
 * the PV-relevant channel). Palette from the shared design-system chart tokens.
 */
export function WeatherChart({ points }: { points: WeatherPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const onResize = () => {
      chart.current?.resize();
      setRev((r) => r + 1); // re-render: axis layout depends on width
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    const t = chartTheme();
    // Three y-axes do not fit a phone: below 520px the cloud/irradiance axes
    // hide (their values stay in the tooltip), the temperature axis remains.
    const narrow = chart.current.getWidth() < 520;
    const time = points.map((p) => p.ts);
    const num = (key: keyof WeatherPoint) =>
      points.map((p) => (p[key] == null ? null : Number(p[key])));

    chart.current.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: narrow ? 72 : 44, right: narrow ? 12 : 68, bottom: 28, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) =>
            v == null ? '-' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 }),
        },
        legend: { top: 8, icon: 'roundRect', textStyle: { color: t.ink, fontWeight: 600 } },
        xAxis: {
          type: 'category',
          data: time,
          boundaryGap: false,
          axisLabel: {
            formatter: (v: string) =>
              new Date(v).toLocaleString('de-DE', {
                weekday: 'short',
                hour: '2-digit',
              }),
            color: t.axis,
          },
          axisLine: { lineStyle: { color: t.axisLine } },
        },
        yAxis: [
          {
            type: 'value',
            name: '°C',
            position: 'left',
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          {
            type: 'value',
            name: narrow ? '' : 'Wolken %',
            min: 0,
            max: 100,
            position: 'right',
            splitLine: { show: false },
            axisLabel: { show: !narrow, color: t.cloud },
          },
          {
            type: 'value',
            name: narrow ? '' : 'W/m²',
            position: 'right',
            offset: narrow ? 0 : 56,
            splitLine: { show: false },
            axisLabel: { show: !narrow, color: t.pv },
          },
        ],
        series: [
          {
            name: 'Temperatur',
            type: 'line',
            smooth: true,
            showSymbol: false,
            yAxisIndex: 0,
            lineStyle: { width: 2.5, color: t.temp },
            itemStyle: { color: t.temp },
            data: num('temperatureC'),
          },
          {
            name: 'Wolken',
            type: 'line',
            smooth: true,
            showSymbol: false,
            yAxisIndex: 1,
            lineStyle: { width: 1.5, color: t.cloud },
            itemStyle: { color: t.cloud },
            areaStyle: { opacity: 0.12, color: t.cloud },
            data: num('cloudCoverPct'),
          },
          {
            name: 'Einstrahlung',
            type: 'line',
            smooth: true,
            showSymbol: false,
            yAxisIndex: 2,
            lineStyle: { width: 2, color: t.pv },
            itemStyle: { color: t.pv },
            areaStyle: { opacity: 0.14, color: t.pv },
            data: num('ghiWM2'),
          },
        ],
      },
      true,
    );
  }, [points, rev]);

  return <div ref={ref} className="vp-chart" />;
}
