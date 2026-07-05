import type { TelemetryPoint } from './api';
import { chartTheme } from './chartTheme';
import { useEChart } from './useEChart';

/**
 * Line chart of a site's telemetry (PV, load, net power on the left axis,
 * battery SoC on the right). Palette + type from the shared design-system chart
 * tokens (chartTheme): solar orange, home blue, action ink, battery purple.
 * Width-aware: on narrow containers the legend tightens and axis chrome slims
 * down so nothing collides on a phone.
 */
export function TelemetryChart({ points }: { points: TelemetryPoint[] }) {
  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < 480;
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

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 44, right: narrow ? 20 : 44, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            valueFormatter: (v: unknown) =>
              v == null ? '-' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: 2 }),
          },
          legend: {
            top: 8,
            icon: 'roundRect',
            itemGap: narrow ? 8 : 10,
            itemWidth: narrow ? 18 : 25,
            textStyle: { color: t.ink, fontWeight: 600 },
          },
          xAxis: {
            type: 'category',
            data: time,
            boundaryGap: false,
            axisLabel: {
              formatter: (v: string) =>
                new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
              hideOverlap: true,
            },
            axisLine: { lineStyle: { color: t.axisLine } },
          },
          yAxis: [
            {
              type: 'value',
              name: 'kW',
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis },
            },
            {
              type: 'value',
              name: 'SoC %',
              min: 0,
              max: 100,
              position: 'right',
              splitLine: { show: false },
              axisLabel: { color: t.soc },
            },
          ],
          series: [
            series('PV', 'pvPowerKw', t.pv),
            series('Last', 'loadKw', t.load),
            series('Netz', 'powerKw', t.price),
            series('SoC', 'socPct', t.soc, 1),
          ],
        },
        true,
      );
    },
    [points],
  );

  return <div ref={ref} className="vp-chart tall" />;
}
