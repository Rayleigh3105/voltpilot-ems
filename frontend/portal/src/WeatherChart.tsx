import type { WeatherPoint } from './api';
import { FILL, nowLabel, nowLineStyle, SMOOTH_SERIES, STROKE } from './chartStyle';
import { AXIS as AXIS_NAME } from './chartCopy';
import { chartTheme } from './chartTheme';
import { useEChart } from './useEChart';
import { ChartLegend, type LegendItem } from './components/ChartExplain';
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
          grid: { top: 16, right: narrow ? 12 : 68, bottom: 8, left: 8, containLabel: true },
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
          // Die eingebaute echarts-Legende ist WEG: sie war das einzige
          // Vorkommen im Portal (fuenf Legenden-Regime), zeichnete in Canvas
          // statt in HTML und sprach keine Einheiten. `ChartLegend` unter dem
          // Titel ist die eine Grammatik - deshalb faellt hier auch der
          // Kopfraum im Grid weg, den sie belegte.
          xAxis: {
            type: 'category',
            data: time,
            boundaryGap: false,
            axisLabel: {
              formatter: (v: string) => axisHourLabel(v),
              color: t.axis,
              hideOverlap: true,
            },
            // F4: kein Rahmen um die Daten - weder Achslinie noch Ticks.
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: [
            {
              type: 'value',
              name: AXIS_NAME.temperatur(narrow),
              position: 'left',
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis },
            },
            {
              type: 'value',
              name: narrow ? '' : AXIS_NAME.bewoelkung(false),
              min: 0,
              max: 100,
              position: 'right',
              splitLine: { show: false },
              axisLabel: { show: !narrow, color: t.cloud },
            },
            {
              type: 'value',
              // K4: die Einheit sagt einem Anlagenbetreiber nichts - das WORT
              // trägt sie. (Die Leitgröße wird in Stufe 4 die erwartete
              // Leistung der Anlage in kW; hier steht erst die Beschriftung um.)
              name: narrow ? '' : AXIS_NAME.sonnenstaerke(false),
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
              ...SMOOTH_SERIES,
              showSymbol: false,
              yAxisIndex: 0,
              lineStyle: { width: STROKE.context, color: t.temp },
              itemStyle: { color: t.temp },
              data: num('temperatureC'),
              // Shade the already-elapsed hours and mark "Jetzt" (idiom shared
              // with ScheduleChart/HistoryChart).
              markArea:
                nowIdx > 0
                  ? {
                      silent: true,
                      itemStyle: { color: t.axis, opacity: FILL.past },
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
                          lineStyle: nowLineStyle(t),
                          // rotate: 0 pins the label horizontal (an hourly axis
                          // otherwise renders it rotated along the line).
                          label: nowLabel(t, 'insideStartTop'),
                        },
                      ],
                    }
                  : undefined,
            },
            {
              name: 'Wolken',
              type: 'line',
              ...SMOOTH_SERIES,
              showSymbol: false,
              yAxisIndex: 1,
              lineStyle: { width: STROKE.contextSoft, color: t.cloud },
              itemStyle: { color: t.cloud },
              areaStyle: { opacity: FILL.wash, color: t.cloud },
              data: num('cloudCoverPct'),
            },
            {
              name: 'Einstrahlung',
              type: 'line',
              ...SMOOTH_SERIES,
              showSymbol: false,
              yAxisIndex: 2,
              lineStyle: { width: STROKE.lead, color: t.pvLine },
              itemStyle: { color: t.pvLine },
              areaStyle: { opacity: FILL.band, color: t.pvLine },
              data: num('ghiWM2'),
            },
          ],
        },
        true,
      );
    },
    [points],
  );

  // EINE Legenden-Grammatik im ganzen Portal: HTML statt Canvas, mit Einheit,
  // ueber dem Bild. Die Farben sind die aufgeloesten Token, damit Punkt und
  // Kurve garantiert denselben Ton tragen.
  const t = chartTheme();
  const legend: LegendItem[] = [
    { color: t.pvLine, label: 'Sonnenstärke', unit: 'W/m²', shape: 'area' },
    { color: t.temp, label: 'Temperatur', unit: '°C', shape: 'line' },
    { color: t.cloud, label: 'Bewölkung', unit: '%', shape: 'area' },
  ];

  return (
    <>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart" />
    </>
  );
}
