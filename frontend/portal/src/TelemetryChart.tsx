import type { TelemetryPoint } from './api';
import { AXIS, FILL, SMOOTH_SERIES, STROKE } from './chartStyle';
import { AXIS as AXIS_NAME } from './chartCopy';
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

/**
 * The four telemetry channels, in draw order (label is the legend/toggle key).
 *
 * ⚠ Alle drei kW-Reihen tragen ihre LINIEN-Stufe (F2) - hier sind es Linien,
 * keine Balken. Und „Netz" lief bis Stufe 1 auf dem PREIS-Blau, direkt neben
 * dem Haus-Blau: der gemessene Blau-Kollaps dieses Charts (F10). Preis-Blau ist
 * ab jetzt fuer PREISE reserviert, Netz traegt ueberall den Netz-Ton.
 */
const CHANNELS: { label: string; key: keyof TelemetryPoint; tone: keyof ReturnType<typeof chartTheme>; axis: number; unit: string }[] = [
  { label: 'PV-Erzeugung', key: 'pvPowerKw', tone: 'pvLine', axis: 0, unit: 'kW' },
  { label: 'Hausverbrauch', key: 'loadKw', tone: 'loadLine', axis: 0, unit: 'kW' },
  { label: 'Netz', key: 'powerKw', tone: 'flowGridLine', axis: 0, unit: 'kW' },
  { label: 'Batterie-Ladestand', key: 'socPct', tone: 'soc', axis: 1, unit: '%' },
];

export function TelemetryChart({
  points,
  windowLabel = 'in den letzten 24 Stunden',
  hidden,
  onToggle,
  variant = 'tall',
}: {
  points: TelemetryPoint[];
  /** Range phrase for the takeaway line, e.g. "in der letzten Stunde". */
  windowLabel?: string;
  /** Labels the customer has toggled off (channel-toggle pills, V3 Q3). */
  hidden?: Set<string>;
  /** When given, the legend rows become series-toggle pills. */
  onToggle?: (label: string) => void;
  /** 'compact' = the shorter Live-Daten chart; 'tall' keeps today's height. */
  variant?: 'tall' | 'compact';
}) {
  const t = chartTheme();

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 480;
      const nowMs = Date.now();
      const series = (name: string, key: keyof TelemetryPoint, color: string, axis = 0) => ({
        name,
        type: 'line' as const,
        ...SMOOTH_SERIES,
        showSymbol: false,
        connectNulls: false,
        yAxisIndex: axis,
        // F1-Hierarchie: die drei Leistungs-Kanäle TRAGEN die Aussage, der
        // Ladestand auf der zweiten Achse ist Kontext.
        lineStyle: { width: axis === 0 ? STROKE.lead : STROKE.contextSoft, color },
        itemStyle: { color },
        areaStyle: axis === 0 ? { opacity: FILL.wash, color } : undefined,
        data: points.map((p) => {
          const raw = p[key] as number | null;
          return [new Date(p.ts).getTime(), key === 'socPct' ? sanitizeSoc(raw) : raw];
        }),
      });

      // Only the channels the customer left on (V3 channel-toggle pills). The
      // "Jetzt" marker + shaded past ride the first VISIBLE series so they stay
      // even if PV is toggled off.
      const visible = CHANNELS.filter((c) => !hidden?.has(c.label));
      const built = visible.map((c) => series(c.label, c.key, t[c.tone] as string, c.axis));
      // F5: auf einer Flaeche, die AUSSCHLIESSLICH Vergangenheit zeigt,
      // entfaellt die Jetzt-Linie SAMT Vergangenheits-Wash. Der rechte Rand IST
      // jetzt (die x-Achse endet auf `nowMs`), und ein Wash ueber das ganze
      // Bild plus ein „Jetzt"-Etikett am Rand waren doppeltes Rauschen -
      // gemessen im Ist-Screenshot des Scouts.
      const showSocAxis = visible.some((c) => c.axis === 1);

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
              color: t.axis,
              fontSize: AXIS.fontSize,
              hideOverlap: true,
            },
            // F4: kein Rahmen um die Daten - weder Achslinie noch Ticks.
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: [
            {
              type: 'value',
              // K4: die Einheit steht nie allein - sie sagt nicht, WAS gemessen
              // wird, und kW neben kWh unkommentiert ist die haeufigste
              // Verwechslung im Energie-Portal.
              name: AXIS_NAME.leistung(narrow),
              nameTextStyle: { color: t.axis, fontSize: AXIS.nameFontSize },
              splitLine: { lineStyle: { color: t.grid } },
              axisTick: { show: false },
              axisLine: { show: false },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
            },
            {
              type: 'value',
              name: AXIS_NAME.ladestand(narrow),
              nameTextStyle: { color: t.soc, fontSize: AXIS.nameFontSize },
              min: 0,
              max: 100,
              position: 'right',
              show: showSocAxis,
              splitLine: { show: false },
              axisTick: { show: false },
              axisLine: { show: false },
              axisLabel: { color: t.soc, fontSize: AXIS.fontSize },
            },
          ],
          series: built,
        },
        true,
      );
    },
    [points, hidden],
  );

  // The legend labels ARE the series names, so a toggle pill's key matches the
  // `hidden` set exactly. Netz's +Bezug/−Einspeisung detail stays in the tooltip.
  const legend: LegendItem[] = CHANNELS.map((c) => ({
    color: t[c.tone] as string,
    label: c.label,
    unit: c.unit,
    shape: 'line',
  }));

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
      <ChartLegend items={legend} hidden={hidden} onToggle={onToggle} />
      <div ref={ref} className={`vp-chart${variant === 'compact' ? ' compact' : ' tall'}`} />
      {insight && <ChartInsight>{insight}</ChartInsight>}
    </div>
  );
}
