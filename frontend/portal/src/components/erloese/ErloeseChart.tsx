import { useRef } from 'react';
import { AXIS, BAR, FILL, STROKE, ghostItem, ghostLine, withAlpha, NARROW_PX } from '../../chartStyle';
import { chartTheme } from '../../chartTheme';
import { kopf, notizZeile, tooltip, TOOLTIP_CSS, wertZeile } from '../../chartTooltip';
import { zeigerSchwebt } from '../../chartFokus';
import { betrag, mitPreisFeld, type GeldDiagramm, type LeerBand } from '../../erloeseSeite';
import { useEChart } from '../../useEChart';

/**
 * **Das Erlöse-Diagramm** (Konzept „Verlauf-Rework", Paket P2, Entscheid
 * E3 = A) — reine Render-Schicht über `erloeseSeite.geldDiagramm`.
 *
 * - **Säulen mit Vorzeichen:** Eigenverbrauch und Einspeisung nach oben,
 *   Netzbezug nach unten, das Ergebnis als Punkt. Die Farben sind die ROLLEN
 *   der Energie-Seite (Erzeugung Orange, Netz Petrol), die Kosten das Weinrot
 *   des Hauses — wer eine Seite kennt, liest die andere ohne Legende.
 * - **Kumuliert:** die Summe seit Beginn des Zeitraums, daneben derselbe
 *   Verlauf der Vergleichsperiode (Geister-Grammatik `ghostLine`).
 * - **Am Tag:** darunter ein zweites Feld mit dem Börsenpreis derselben
 *   Stunde — eigene Achse, gemeinsame Zeitachse, nie eine zweite Skala im
 *   selben Feld.
 * - **Lücken bleiben leer:** Zellen ohne Werte sind beschriftete Bänder
 *   („keine Messwerte", „noch offen"), nie eine Null.
 */

export type ErloeseModus = 'saeulen' | 'kumuliert';

const BAND_TEXT: Record<LeerBand['art'], (n: number) => string> = {
  luecke: (n) => (n > 1 ? 'keine Messwerte' : ''),
  zukunft: (n) => (n > 2 ? 'noch offen' : ''),
  vorher: (n) => (n > 2 ? 'vor Messbeginn' : ''),
};

/** Achsenbeschriftung in Euro, mit echtem Minus und so vielen Stellen, wie die Skala braucht. */
function euroAchse(maxAbs: number) {
  const stellen = maxAbs < 1 ? 2 : maxAbs < 10 ? 1 : 0;
  return (v: number) =>
    `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('de-DE', {
      minimumFractionDigits: stellen,
      maximumFractionDigits: stellen,
    })} €`;
}

/** Jede wievielte Kategorie eine Beschriftung trägt, damit sich nichts überlappt. */
function intervall(range: GeldDiagramm['range'], n: number, plotPx: number): number {
  const minPx = range === 'week' ? 48 : range === 'year' ? 34 : 26;
  const slot = plotPx / Math.max(1, n);
  return Math.max(0, Math.ceil(minPx / slot) - 1);
}

export function ErloeseChart({
  d,
  modus,
  preise,
  vergleichName,
  onZelle,
  label,
}: {
  /** Aus `geldDiagramm` — memoisiert, sonst zeichnet jede Eltern-Darstellung neu. */
  d: GeldDiagramm;
  modus: ErloeseModus;
  /** Börsenpreis je Stunde (nur Tag); `null` ohne Preisfeld. */
  preise: (number | null)[] | null;
  /** „Juli" / „Vortag" — der Name der Vergleichsperiode; `null` ohne Vergleich. */
  vergleichName: string | null;
  /** Ein Klick auf eine Säule öffnet die Zelle (Tag bzw. Monat). */
  onZelle?: (index: number) => void;
  label: string;
}) {
  const klick = useRef({ d, onZelle });
  klick.current = { d, onZelle };
  const gebunden = useRef(false);
  const mitPreis = mitPreisFeld(d, modus, preise);

  const ref = useEChart(
    (chart, width) => {
      if (!gebunden.current) {
        gebunden.current = true;
        chart.getZr().on('click', (e: { offsetX: number; offsetY: number }) => {
          const { d: dd, onZelle: oeffne } = klick.current;
          // Auf Touch-Geräten öffnet das Antippen den Tooltip; der Weg in die
          // Zelle ist dort die Tabelle (ein Antippen, das zugleich wegführt,
          // ließe den Tooltip nie lesen).
          if (!oeffne || !dd.drill || !zeigerSchwebt()) return;
          if (!chart.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])) return;
          const idx = Math.round(Number(chart.convertFromPixel({ xAxisIndex: 0 }, e.offsetX)));
          const z = dd.zellen[idx];
          if (!z || z.zustand === 'zukunft' || z.zustand === 'vorher') return;
          oeffne(idx);
        });
      }

      const t = chartTheme();
      const narrow = width < NARROW_PX;
      const left = narrow ? 52 : 64;
      const right = modus === 'kumuliert' ? (narrow ? 64 : 120) : 12;
      const plotPx = Math.max(100, width - left - right);
      const n = d.achse.length;
      const euro = euroAchse(modus === 'kumuliert' ? Math.max(...d.kumuliert.map((v) => Math.abs(v ?? 0)), 0) : d.maxAbs);
      const achsenText = { color: t.axis, fontSize: AXIS.fontSize, fontFamily: t.font };

      const baender = {
        silent: true,
        data: d.baender.map((b) => {
          const span = b.bis - b.von + 1;
          const text = BAND_TEXT[b.art](span);
          return [
            {
              xAxis: b.von,
              itemStyle: { color: b.art === 'luecke' ? withAlpha(t.axis, 0.12) : withAlpha(t.axis, 0.05) },
              label: {
                show: !!text,
                position: 'insideTop',
                color: t.axis,
                fontSize: AXIS.fontSize,
                fontFamily: t.font,
                formatter: text,
              },
            },
            { xAxis: b.bis },
          ];
        }),
      };

      const tip = (i: number) => {
        const z = d.zellen[i];
        if (!z) return '';
        const titel = kopf(d.titel[i]);
        if (z.zustand === 'zukunft') return tooltip(titel, notizZeile(t.axis, 'liegt in der Zukunft'));
        if (z.zustand === 'vorher') return tooltip(titel, notizZeile(t.axis, 'vor Messbeginn'));
        if (z.zustand === 'luecke') return tooltip(titel, notizZeile(t.axis, 'keine Messwerte'));
        if (modus === 'kumuliert') {
          return tooltip(
            titel,
            wertZeile(t.ink, `<b>${betrag(d.kumuliert[i])}</b> bis hier`),
            d.vergleichKumuliert && d.vergleichKumuliert[i] != null && vergleichName
              ? wertZeile(t.cPrice2, `${betrag(d.vergleichKumuliert[i])} ${vergleichName}`)
              : null,
          );
        }
        const preis = mitPreis && preise ? preise[i] : null;
        return tooltip(
          titel,
          wertZeile(t.ink, `<b>${betrag(d.netto[i])}</b> Ergebnis`),
          wertZeile(t.cPv, `${betrag(d.eigen[i])} Eigenverbrauch`),
          wertZeile(t.cGrid, `${betrag(d.einsp[i])} Einspeisung`),
          wertZeile(t.cGeldKosten, `${betrag(d.kosten[i])} Netzbezug`),
          preis != null
            ? wertZeile(t.cPrice, `${preis.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh Börsenpreis (Ø)`)
            : null,
          d.vergleichNetto?.[i] != null && vergleichName
            ? wertZeile(t.cPrice2, `${betrag(d.vergleichNetto[i])} ${vergleichName}`)
            : null,
          z.zustand === 'laeuft' ? notizZeile(t.axis, 'läuft noch') : null,
          d.drill && onZelle && zeigerSchwebt()
            ? notizZeile(t.axis, d.drill === 'tag' ? 'Klick öffnet den Tag' : 'Klick öffnet den Monat')
            : null,
        );
      };

      const xBasis = {
        type: 'category' as const,
        data: d.achse,
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { ...achsenText, interval: intervall(d.range, n, plotPx) },
      };
      const yBasis = {
        type: 'value' as const,
        splitNumber: narrow ? 3 : 4,
        axisLabel: { ...achsenText, formatter: euro },
        splitLine: { lineStyle: { color: t.grid } },
      };
      const nullLinie = {
        silent: true,
        symbol: 'none',
        lineStyle: { color: t.axisLine, width: STROKE.ref, type: 'solid' as const },
        label: { show: false },
        data: [{ yAxis: 0 }],
      };

      if (modus === 'kumuliert') {
        chart.setOption(
          {
            textStyle: { fontFamily: t.font },
            grid: { left, right, top: 16, bottom: 28, containLabel: false },
            tooltip: {
              trigger: 'axis',
              confine: true,
              extraCssText: TOOLTIP_CSS,
              axisPointer: { type: 'line', lineStyle: { color: t.axisLine } },
              formatter: (ps: { dataIndex: number }[]) => tip(ps[0]?.dataIndex ?? 0),
            },
            xAxis: { ...xBasis, boundaryGap: false },
            yAxis: yBasis,
            series: [
              ...(d.vergleichKumuliert && vergleichName
                ? [
                    {
                      name: `Vergleich ${vergleichName}`,
                      type: 'line' as const,
                      symbol: 'none',
                      silent: true,
                      z: 1,
                      data: d.vergleichKumuliert,
                      lineStyle: ghostLine(t.cPrice2),
                      itemStyle: ghostItem(t.cPrice2),
                      endLabel: {
                        show: !narrow,
                        color: t.axis,
                        fontSize: AXIS.fontSize,
                        formatter: (p: { value: number | null }) =>
                          p.value == null ? '' : `${vergleichName} ${betrag(p.value)}`,
                      },
                    },
                  ]
                : []),
              {
                name: 'Ergebnis kumuliert',
                type: 'line' as const,
                symbol: 'none',
                z: 3,
                data: d.kumuliert,
                lineStyle: { color: t.ink, width: STROKE.lead },
                itemStyle: { color: t.ink },
                areaStyle: { color: withAlpha(t.ink, FILL.wash) },
                endLabel: {
                  show: true,
                  color: t.ink,
                  fontSize: AXIS.fontSize,
                  fontWeight: 700,
                  formatter: (p: { value: number | null }) => (p.value == null ? '' : betrag(p.value)),
                },
                markLine: nullLinie,
                markArea: baender,
              },
            ],
          },
          true,
        );
        return;
      }

      const saeulen = [
        {
          name: 'Einspeisung',
          type: 'bar' as const,
          stack: 'geld',
          barMaxWidth: BAR.maxWidth,
          barCategoryGap: BAR.categoryGap,
          data: d.einsp,
          itemStyle: { color: t.cGrid, borderColor: t.surface, borderWidth: 1 },
          markArea: baender,
          markLine: nullLinie,
        },
        {
          name: 'Eigenverbrauch',
          type: 'bar' as const,
          stack: 'geld',
          barMaxWidth: BAR.maxWidth,
          data: d.eigen,
          itemStyle: { color: t.cPv, borderColor: t.surface, borderWidth: 1, borderRadius: [BAR.radius, BAR.radius, 0, 0] },
        },
        {
          name: 'Netzbezug',
          type: 'bar' as const,
          stack: 'geld',
          barMaxWidth: BAR.maxWidth,
          data: d.kosten,
          itemStyle: { color: t.cGeldKosten, borderColor: t.surface, borderWidth: 1, borderRadius: [0, 0, BAR.radius, BAR.radius] },
        },
        {
          name: 'Ergebnis',
          type: 'scatter' as const,
          z: 5,
          symbolSize: narrow ? 7 : 8,
          data: d.netto,
          itemStyle: { color: t.ink, borderColor: t.surface, borderWidth: 2 },
        },
        // Der gewählte Vergleich: das Ergebnis derselben Position der
        // Vergleichsperiode als feine Marke neben dem Punkt.
        ...(d.vergleichNetto && vergleichName
          ? [
              {
                name: `Ergebnis ${vergleichName}`,
                type: 'scatter' as const,
                z: 4,
                symbol: 'rect',
                symbolSize: [narrow ? 12 : 18, 2],
                silent: true,
                data: d.vergleichNetto,
                itemStyle: { color: t.cPrice2 },
              },
            ]
          : []),
      ];

      if (!mitPreis || !preise) {
        chart.setOption(
          {
            textStyle: { fontFamily: t.font },
            grid: { left, right, top: 12, bottom: 28, containLabel: false },
            tooltip: {
              trigger: 'axis',
              confine: true,
              extraCssText: TOOLTIP_CSS,
              axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(t.axis, 0.08) } },
              formatter: (ps: { dataIndex: number }[]) => tip(ps[0]?.dataIndex ?? 0),
            },
            xAxis: xBasis,
            yAxis: yBasis,
            series: saeulen,
          },
          true,
        );
        return;
      }

      // Am Tag: zwei Felder, eine Zeitachse. Das obere trägt das Geld, das
      // untere den Börsenpreis derselben Stunde.
      const hoehe = chart.getHeight();
      const unten = narrow ? 64 : 76;
      const oben = Math.max(120, hoehe - unten - 12 - 36 - 28);
      const preisTop = 12 + oben + 36;
      chart.setOption(
        {
          textStyle: { fontFamily: t.font },
          title: [
            {
              text: 'Börsenpreis · ct/kWh',
              left,
              top: 12 + oben + 12,
              textStyle: { color: t.axis, fontSize: AXIS.fontSize, fontWeight: 500, fontFamily: t.font },
            },
          ],
          grid: [
            { left, right, top: 12, height: oben, containLabel: false },
            { left, right, top: preisTop, height: unten, containLabel: false },
          ],
          axisPointer: { link: [{ xAxisIndex: 'all' }] },
          tooltip: {
            trigger: 'axis',
            confine: true,
            extraCssText: TOOLTIP_CSS,
            axisPointer: { type: 'shadow', shadowStyle: { color: withAlpha(t.axis, 0.08) } },
            formatter: (ps: { dataIndex: number }[]) => tip(ps[0]?.dataIndex ?? 0),
          },
          xAxis: [
            { ...xBasis, gridIndex: 0, axisLabel: { ...xBasis.axisLabel, show: false } },
            { ...xBasis, gridIndex: 1 },
          ],
          yAxis: [
            { ...yBasis, gridIndex: 0 },
            {
              type: 'value' as const,
              gridIndex: 1,
              splitNumber: 2,
              axisLabel: {
                ...achsenText,
                formatter: (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 0 })}`,
              },
              splitLine: { lineStyle: { color: t.grid } },
            },
          ],
          series: [
            ...saeulen,
            {
              name: 'Börsenpreis',
              type: 'line' as const,
              xAxisIndex: 1,
              yAxisIndex: 1,
              step: 'middle',
              symbol: 'none',
              data: preise,
              lineStyle: { color: t.cPrice, width: STROKE.context },
              itemStyle: { color: t.cPrice },
            },
          ],
        },
        true,
      );
    },
    [d, modus, preise, vergleichName, mitPreis],
  );

  return (
    <div
      ref={ref}
      className={`vp-vr-chart${mitPreis ? ' hoch' : ''}${d.drill && onZelle ? ' klickbar' : ''}`}
      role="img"
      aria-label={label}
    />
  );
}
