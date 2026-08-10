import type { PeakShaving } from '../api';
import { NARROW_PX } from '../chartStyle';
import { chartTheme } from '../chartTheme';
import { eur, fmtNum } from '../format';
import { useEChart } from '../useEChart';
import { ChartInsight, ChartLegend, ChartSubtitle, type LegendItem } from './ChartExplain';

/**
 * U4 - the per-period Lastspitzen history (PS-4 `earnings.peakShaving.history`,
 * already in the response, noted as not-yet-rendered in AGENTS.md). One grouped
 * bar pair per billing period: the peak WITHOUT the battery (baseline) vs. the
 * peak the battery actually HELD - the visible gap is the vermiedene Spitze.
 * The tooltip adds the saved Leistungskosten per period. Read-only.
 */

/** German period label from an ISO date: "Jul 2026" (Monat) or "2026" (Jahr). */
export function periodTick(periodStart: string, abrechnung: PeakShaving['abrechnung']): string {
  const d = new Date(`${periodStart}T12:00:00`);
  if (Number.isNaN(d.getTime())) return periodStart;
  return abrechnung === 'monat'
    ? d.toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })
    : String(d.getFullYear());
}

export function PeakHistoryChart({ peak }: { peak: PeakShaving }) {
  const t = chartTheme();
  const history = peak.history;

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < NARROW_PX;
      const labels = history.map((h) => periodTick(h.periodStart, peak.abrechnung));
      const baseline = history.map((h) => h.baselinePeakKw);
      const held = history.map((h) => h.peakKw);

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 16, right: narrow ? 12 : 20, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: any[]) => {
              const idx = params[0]?.dataIndex ?? 0;
              const h = history[idx];
              const lines = [`<b>${labels[idx]}</b>`];
              for (const p of params) {
                if (p.value == null) continue;
                lines.push(`${p.marker} ${p.seriesName}: ${fmtNum(Number(p.value), 'kW')}`);
              }
              if (h) {
                lines.push(
                  `<span style="color:${t.charge}">Vermiedene Spitze: ${fmtNum(h.avoidedKw, 'kW')}</span>`,
                );
                lines.push(
                  `<span style="color:${t.charge}">Ersparte Leistungskosten: ${eur(h.avoidedEur)} €</span>`,
                );
              }
              return lines.join('<br/>');
            },
          },
          xAxis: {
            type: 'category',
            data: labels,
            axisLabel: { color: t.axis, hideOverlap: true },
            axisLine: { lineStyle: { color: t.axisLine } },
          },
          yAxis: {
            type: 'value',
            name: narrow ? 'kW' : 'Bezugsspitze (kW)',
            nameTextStyle: { color: t.axis, align: 'left' },
            nameGap: 12,
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          series: [
            {
              name: 'Ohne Speicher',
              type: 'bar',
              data: baseline,
              barGap: '10%',
              itemStyle: { color: t.discharge, borderRadius: 2 },
              z: 1,
            },
            {
              name: 'Gehaltene Spitze',
              type: 'bar',
              data: held,
              itemStyle: { color: t.charge, borderRadius: 2 },
              z: 2,
            },
          ],
        },
        true,
      );
    },
    [peak, t],
  );

  const legend: LegendItem[] = [
    { color: t.discharge, label: 'Bezugsspitze ohne Speicher', unit: 'kW', shape: 'bar' },
    { color: t.charge, label: 'Gehaltene Spitze mit Speicher', unit: 'kW', shape: 'bar' },
  ];

  const totalAvoidedEur = history.reduce((s, h) => s + h.avoidedEur, 0);

  return (
    <div>
      <ChartSubtitle>
        Ihre höchste Viertelstunden-Bezugsspitze je Abrechnungsperiode - mit und ohne
        Speichereinsatz. Die Lücke ist die vermiedene Spitze.
      </ChartSubtitle>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart" />
      {history.length > 0 && totalAvoidedEur > 0.005 && (
        <ChartInsight>
          Über die gezeigten Perioden hat der Speicher rund <strong>{eur(totalAvoidedEur)} €</strong>{' '}
          an Leistungskosten vermieden.
        </ChartInsight>
      )}
    </div>
  );
}
