import type { WeatherPoint } from './api';
import { chartTheme } from './chartTheme';
import { useEChart } from './useEChart';
import { axisHourLabel, nowMarkerIndex, tooltipHeader } from './weather';

/**
 * Hourly weather forecast: temperature (line, left °C), cloud cover (grey area,
 * right %) and shortwave/GHI irradiance (solar-orange area, offset right W/m² -
 * the PV-relevant channel). Palette from the shared design-system chart tokens.
 * A "Jetzt"-marker + shaded past make now unmistakable (same idiom as the
 * Fahrplan/Historie charts); all times render as German LOCAL time - the raw
 * UTC ISO timestamps from the API never reach the user (weather.ts).
 * Width-aware: three y-axes do not fit a phone, so below 520px the cloud and
 * irradiance axes hide (their values stay in the tooltip) and the legend gets
 * room to wrap.
 */
export function WeatherChart({ points }: { points: WeatherPoint[] }) {
  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < 520;
      const time = points.map((p) => p.ts);
      const num = (key: keyof WeatherPoint) =>
        points.map((p) => (p[key] == null ? null : Number(p[key])));

      const unitBySeries: Record<string, string> = {
        Temperatur: '°C',
        Wolken: '%',
        Einstrahlung: 'W/m²',
      };

      // "Jetzt": the last hour at/before now (the elapsed part is shaded).
      const nowIdx = nowMarkerIndex(points, Date.now());

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: narrow ? 72 : 44, right: narrow ? 12 : 68, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: any[]) => {
              const lines = [`<b>${tooltipHeader(params[0]?.axisValue)}</b>`];
              for (const p of params) {
                if (p.value == null) continue;
                const v = Number(p.value).toLocaleString('de-DE', { maximumFractionDigits: 1 });
                lines.push(`${p.marker} ${p.seriesName}: ${v} ${unitBySeries[p.seriesName] ?? ''}`);
              }
              return lines.join('<br/>');
            },
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
              formatter: (v: string) => axisHourLabel(v),
              color: t.axis,
              hideOverlap: true,
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
              // Shade the already-elapsed hours and mark "Jetzt" (idiom shared
              // with ScheduleChart/HistoryChart).
              markArea:
                nowIdx > 0
                  ? {
                      silent: true,
                      itemStyle: { color: t.axis, opacity: 0.08 },
                      data: [[{ xAxis: 0 }, { xAxis: nowIdx }]],
                    }
                  : undefined,
              markLine:
                nowIdx >= 0 && nowIdx < points.length - 1
                  ? {
                      silent: true,
                      symbol: 'none',
                      data: [
                        {
                          xAxis: nowIdx,
                          lineStyle: { color: t.price, type: 'solid', width: 2 },
                          // rotate: 0 pins the label horizontal (an hourly axis
                          // otherwise renders it rotated along the line).
                          label: {
                            formatter: 'Jetzt',
                            color: t.price,
                            position: 'insideStartTop',
                            rotate: 0,
                          },
                        },
                      ],
                    }
                  : undefined,
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
    },
    [points],
  );

  return <div ref={ref} className="vp-chart" />;
}
