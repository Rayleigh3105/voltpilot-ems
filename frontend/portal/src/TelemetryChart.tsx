import type { TelemetryPoint } from './api';
import { chartTheme } from './chartTheme';
import { ChartInsight, ChartLegend, type LegendItem } from './components/ChartExplain';
import { fmtNum } from './format';
import { sanitizeSoc } from './plausible';
import { useEChart } from './useEChart';

/**
 * Line chart of a site's telemetry (PV, load, net power on the left axis,
 * battery SoC on the right). Palette + type from the shared design-system chart
 * tokens (chartTheme): solar orange, home blue, action ink, battery purple.
 *
 * The x-axis is a TRUE time axis: mixed sampling rates (15-min dev seed next to
 * 10-s live ingest, store-and-forward replays) must not distort time the way a
 * category axis does (every sample equal width). Chrome follows the portal's
 * self-explaining chart convention: plain-German HTML legend + one-line
 * takeaway (ChartExplain) instead of the raw ECharts legend, plus the
 * "Jetzt"-marker + shaded-past convention shared with Fahrplan/Historie.
 *
 * An implausible SoC row maps to null via the shared sanitizeSoc (plausible.ts)
 * so the line shows a GAP (connectNulls stays false) instead of clipping to the
 * axis ceiling/floor. kW series carry any real value.
 */

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function TelemetryChart({
  points,
  windowLabel = 'in den letzten 24 Stunden',
}: {
  points: TelemetryPoint[];
  /** Range phrase for the takeaway line, e.g. "in der letzten Stunde". */
  windowLabel?: string;
}) {
  const t = chartTheme();

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 480;
      const nowMs = Date.now();
      const firstMs = points.length ? new Date(points[0].ts).getTime() : nowMs;
      const series = (name: string, key: keyof TelemetryPoint, color: string, axis = 0) => ({
        name,
        type: 'line' as const,
        smooth: true,
        showSymbol: false,
        connectNulls: false,
        yAxisIndex: axis,
        lineStyle: { width: 2.5, color },
        itemStyle: { color },
        areaStyle: axis === 0 ? { opacity: 0.06, color } : undefined,
        data: points.map((p) => {
          const raw = p[key] as number | null;
          return [new Date(p.ts).getTime(), key === 'socPct' ? sanitizeSoc(raw) : raw];
        }),
      });

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 30, right: narrow ? 20 : 44, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: any[]) => {
              const lines = [`<b>${timeLabel(Number(params[0]?.axisValue))} Uhr</b>`];
              for (const p of params) {
                const v = Array.isArray(p.value) ? p.value[1] : p.value;
                if (v == null) continue;
                const n = Number(v);
                if (p.seriesName === 'Netz') {
                  const dir = n > 0.05 ? ' (Bezug)' : n < -0.05 ? ' (Einspeisung)' : '';
                  lines.push(`${p.marker} Netz: ${fmtNum(Math.abs(n), 'kW')}${dir}`);
                } else {
                  const unit = p.seriesName === 'Batterie-Ladestand' ? '%' : 'kW';
                  lines.push(`${p.marker} ${p.seriesName}: ${fmtNum(n, unit, unit === '%' ? 0 : 1)}`);
                }
              }
              return lines.join('<br/>');
            },
          },
          xAxis: {
            type: 'time',
            max: nowMs,
            axisLabel: {
              formatter: (v: number) => timeLabel(v),
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
              name: narrow ? '%' : 'Ladestand %',
              min: 0,
              max: 100,
              position: 'right',
              splitLine: { show: false },
              axisLabel: { color: t.soc },
            },
          ],
          series: [
            {
              ...series('PV-Erzeugung', 'pvPowerKw', t.pv),
              // Shared time-chart convention: shade what already happened and
              // mark "Jetzt" (here the right edge - telemetry ends at now).
              markArea: {
                silent: true,
                itemStyle: { color: t.axis, opacity: 0.06 },
                data: [[{ xAxis: firstMs }, { xAxis: nowMs }]],
              },
              markLine: {
                silent: true,
                symbol: 'none',
                data: [
                  {
                    xAxis: nowMs,
                    lineStyle: { color: t.price, type: 'solid', width: 2 },
                    // The live chart's "now" is always the right edge; an
                    // inside-positioned label would render rotated along the
                    // line there, so pin it horizontally left of the line.
                    label: {
                      formatter: 'Jetzt',
                      color: t.price,
                      position: 'insideEndTop',
                      rotate: 0,
                      align: 'right',
                      padding: [0, 6, 0, 0],
                    },
                  },
                ],
              },
            },
            series('Hausverbrauch', 'loadKw', t.load),
            series('Netz', 'powerKw', t.price),
            series('Batterie-Ladestand', 'socPct', t.soc, 1),
          ],
        },
        true,
      );
    },
    [points],
  );

  const legend: LegendItem[] = [
    { color: t.pv, label: 'PV-Erzeugung', unit: 'kW', shape: 'line' },
    { color: t.load, label: 'Hausverbrauch', unit: 'kW', shape: 'line' },
    { color: t.price, label: 'Netz (+ Bezug / − Einspeisung)', unit: 'kW', shape: 'line' },
    { color: t.soc, label: 'Batterie-Ladestand', unit: '%', shape: 'line' },
  ];

  // The takeaway: PV peak if the sun delivered, otherwise the average draw.
  let insight: string | null = null;
  const pvPeak = points.reduce<{ kw: number; ts: string } | null>((best, p) => {
    const v = p.pvPowerKw;
    return v != null && v > (best?.kw ?? 0) ? { kw: v, ts: p.ts } : best;
  }, null);
  const loads = points.map((p) => p.loadKw).filter((v): v is number => v != null);
  const cap = windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1);
  if (pvPeak && pvPeak.kw > 0.05) {
    insight = `${cap} erzeugte Ihre Anlage in der Spitze ${fmtNum(pvPeak.kw, 'kW')} (${timeLabel(new Date(pvPeak.ts).getTime())} Uhr).`;
  } else if (loads.length > 0) {
    const avg = loads.reduce((a, b) => a + b, 0) / loads.length;
    insight = `${cap} lag Ihr Verbrauch im Schnitt bei ${fmtNum(avg, 'kW')}.`;
  }

  return (
    <div>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart tall" />
      {insight && <ChartInsight>{insight}</ChartInsight>}
    </div>
  );
}
