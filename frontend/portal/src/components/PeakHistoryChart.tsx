import { useState } from 'react';
import type { PeakShaving } from '../api';
import { NARROW_PX } from '../chartStyle';
import { chartTheme } from '../chartTheme';
import { eur, fmtNum } from '../format';
import { useEChart } from '../useEChart';
import { Aufklapper } from './Aufklapper';
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

/** Die zwei Reihen — ihre Namen tragen Legende UND Serie, damit ein Schalter
 *  nie eine Reihe meint, die das Bild anders nennt. */
const REIHE_OHNE = 'Bezugsspitze ohne Speicher';
const REIHE_MIT = 'Gehaltene Spitze mit Speicher';

export function PeakHistoryChart({
  peak,
  verlauf = false,
}: {
  peak: PeakShaving;
  /**
   * P6 · der Rahmen des Bereichs „Verlauf" (Konzept `vp-verlauf-sprache-konzept-v5`
   * §3.2 V6): **Bild zuerst**, die Legende als `.vp-chip`-SCHALTER darunter
   * (E7 = a), die Erklärung im Aufklapper, und die Kernaussage übernimmt der
   * Wirt (er trägt sie als Kernsatz ÜBER dem Bild).
   *
   * ⚠ Ohne die Prop ist das Bauteil **byte-identisch** zu vorher — jeder andere
   *   Aufrufer bleibt unberührt.
   */
  verlauf?: boolean;
}) {
  const t = chartTheme();
  const history = peak.history;

  // E7 = a · Legenden-SCHALTER statt Zoom-Geste. Nur im Verlauf-Rahmen: der
  // alte Rahmen kennt keine schaltbare Legende, und ein stiller Zustand, den
  // niemand umlegen kann, wäre eine Reihe weniger ohne Grund.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());

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
          // ⚠ Die Reihen werden GEFILTERT, nicht auf `[]` gesetzt: eine leere
          //   Reihe bliebe in der Tooltip-Liste stehen und behauptete einen
          //   Wert, den das Bild nicht zeichnet.
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
          ].filter((_, i) => !hidden.has(i === 0 ? REIHE_OHNE : REIHE_MIT)),
        },
        true,
      );
    },
    [peak, t, hidden],
  );

  const legend: LegendItem[] = [
    { color: t.discharge, label: REIHE_OHNE, unit: 'kW', shape: 'bar' },
    { color: t.charge, label: REIHE_MIT, unit: 'kW', shape: 'bar' },
  ];

  const totalAvoidedEur = history.reduce((s, h) => s + h.avoidedEur, 0);

  const erklaerung =
    'Ihre höchste Viertelstunden-Bezugsspitze je Abrechnungsperiode – mit und ohne ' +
    'Speichereinsatz. Die Lücke ist die vermiedene Spitze. Tippen Sie eine Kachel der ' +
    'Legende an, um eine Reihe aus- oder einzublenden.';

  if (verlauf) {
    // V6 · die Reihenfolge IST die Aussage: BILD → Legende → Erklärung. Der
    // Kernsatz steht beim Wirt (er kennt die Periode, über die er spricht).
    return (
      <div>
        <div ref={ref} className="vp-c-bild vp-chart" />
        <div className="vp-c-bild-legende">
          <ChartLegend
            items={legend}
            hidden={hidden}
            onToggle={(label) =>
              setHidden((prev) => {
                const next = new Set(prev);
                // ⚠ Die LETZTE sichtbare Reihe lässt sich nicht ausblenden — ein
                //   leeres Bild ist keine Antwort (das `toggleSerie`-Muster).
                if (next.has(label)) next.delete(label);
                else if (next.size < legend.length - 1) next.add(label);
                return next;
              })
            }
          />
        </div>
        <Aufklapper titel="Wie lese ich das Bild?">
          <p className="vp-c-bild-erklaerung">{erklaerung}</p>
        </Aufklapper>
      </div>
    );
  }

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

/**
 * P6 · die Kernaussage des Bildes — ABGELEITET, nie behauptet: ohne vermiedene
 * Kosten über dem Rauschboden steht dort nichts (der Wirt zeigt dann die
 * Erklärung allein). Sie ist wörtlich der Satz, den der alte Rahmen als
 * `ChartInsight` UNTER dem Bild trug.
 */
export function peakVerlaufKernsatz(peak: PeakShaving): string | null {
  const total = peak.history.reduce((s, h) => s + h.avoidedEur, 0);
  if (peak.history.length === 0 || total <= 0.005) return null;
  return `Über die gezeigten Perioden hat der Speicher rund ${eur(total)} € an Leistungskosten vermieden.`;
}
