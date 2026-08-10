import type { PriceHistory } from './api';
import { AXIS, dayBoundaryStyle, FILL, NARROW_PX, STROKE, withAlpha } from './chartStyle';
import { AXIS as AXIS_NAME } from './chartCopy';
import { chartTheme } from './chartTheme';
import { fokusFenster, tagesGrenze, type TagFokus } from './marktpreise';
import {
  ctReihe,
  fensterFuerSlot,
  fensterZeilen,
  preisFenster,
  preisMarken,
  type FensterArt,
  type FensterZeile,
} from './preisFenster';
import { useEChart } from './useEChart';
import { kopf, tooltip } from './chartTooltip';

import './preisFenster.css';

/** ct/kWh (die Kunden-Einheit) + EUR/MWh (das Profi-Detail) für einen Tooltip. */
function fmtPrice(ct: number | null): string {
  if (ct == null) return '-';
  return `${ct.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ct/kWh (${(ct * 10).toLocaleString('de-DE', { maximumFractionDigits: 1 })} EUR/MWh)`;
}

/** Axis label per aggregation bucket. */
function axisLabel(iso: string, bucket: string, narrow = false): string {
  const d = new Date(iso);
  if (bucket === 'PT15M') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (bucket === 'PT1H') {
    // A phone-width canvas has no room for "Mi 06:00" pairs - the weekday
    // alone keeps several ticks readable instead of one lonely label.
    if (narrow) return d.toLocaleDateString('de-DE', { weekday: 'short' });
    return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${d.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/** Tooltip header per bucket. */
function tooltipHead(iso: string, bucket: string): string {
  const d = new Date(iso);
  if (bucket === 'PT15M') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  if (bucket === 'PT1H') {
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) +
      ' · ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * F6 (KORRIGIERT) · Die Tagesgrenze trägt ein DATUM, keine „Morgen"-Plakette.
 * Der Börsenpreis für morgen STEHT FEST — „Morgen" klang wie eine Prognose,
 * das Datum sagt schlicht, wo der nächste Handelstag beginnt.
 */
function grenzLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

/**
 * ECharts setzt einen Achsen-NAMEN standardmäßig mittig über die Achse - die
 * linke Hälfte hängt damit aus dem Canvas, und `containLabel` rechnet ihn NICHT
 * ein („Preis (ct/kWh)" rendert als „reis (ct/kWh)", im Screenshot aufgefallen).
 * Linksbündig verankert wächst er nach innen.
 */
const ACHSEN_NAME = {
  nameLocation: 'end' as const,
  nameGap: 12,
  nameTextStyle: { align: 'left' as const },
};

/** Der Ton eines benannten Preisfensters (Token-Paar, siehe `chartTheme`). */
function fensterFarbe(art: FensterArt, t: ReturnType<typeof chartTheme>): string {
  return art === 'teuer' ? t.discharge : t.guenstig;
}

/**
 * Der Börsenpreis über einen gewählten Zeitraum.
 *
 * **Tag (PT15M):** eine ruhige STUFENLINIE (F1-Hierarchie: sie trägt die
 * Kernaussage) plus höchstens zwei benannte Preisfenster als zarte
 * Hinterlegung — jedes MIT SEINEM WORT im Bild (K10) — und höchstens zwei
 * benannte Marken für Tief und Hoch (K6). Der frühere Ampel-`visualMap`
 * (grün → orange → rot über 96 satte Balken) ist damit weg: eine Farbskala
 * ohne Skala ist eine Kodierung mit Bedienungsanleitung. Die Regeln dafür
 * stehen einmal in `preisFenster.ts` und werden vom Cockpit-Streifen
 * mitbenutzt, damit die zwei Flächen über denselben Tag nichts Verschiedenes
 * behaupten.
 *
 * **F6 ist korrigiert:** Day-Ahead-Preise stehen FEST, also bleibt die Linie
 * durchgezogen (gepunktet hieße Prognose) und die Tagesgrenze ist eine
 * Referenz-Haarlinie mit DATUM statt der alten „Morgen"-Plakette.
 *
 * **Woche/Monat/Jahr:** Ø-Linie + Min/Max-Band auf den `chartStyle`-Werten.
 *
 * Die Achse spricht überall **ct/kWh** — die Einheit auf der Rechnung; EUR/MWh
 * bleibt Profi-Detail im Tooltip (und in der Kennzahlenzeile der Seite).
 *
 * **`fokus` ist die Telefon-Fassung der Tagesgrenze** (Mobil-Umbau Stufe 4):
 * bei 375 px liegen 192 Viertelstunden in ~343 px. Mit `fokus` zeigt die Kurve
 * EINEN Tag; die Grenze bleibt trotzdem sichtbar (getönte Folgetags-Fläche +
 * beschrifteter Strich), damit der Sprung nicht aus dem Nichts kommt.
 */
export function PriceHistoryChart({
  history,
  fokus = null,
}: {
  history: PriceHistory;
  fokus?: TagFokus | null;
}) {
  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < NARROW_PX;
      const { buckets, bucket } = history;
      const isDay = bucket === 'PT15M';
      const weekNarrow = narrow && bucket === 'PT1H';
      const times = buckets.map((b) => b.ts);
      // Die WERTE sind ct/kWh - eine Botschaft, eine Einheit. EUR/MWh bleibt
      // Profi-Detail im Tooltip.
      const avg = ctReihe(buckets.map((b) => b.avgEurMwh));

      if (isDay) {
        // Divider at the first slot on the next calendar day (today/tomorrow).
        const boundaryIdx = tagesGrenze(buckets);
        // Das Fenster ist REIN PROGRAMMATISCH: jede Geste ist abgeschaltet
        // (`zoomLock` + alle move/zoom-Auslöser aus), sonst finge das Diagramm
        // am Telefon Wischgesten ab, die der Seite gehören.
        const zoomFenster = fokus ? fokusFenster(buckets, fokus) : null;

        // Die benannten Fenster + Marken werden auf dem GEZEIGTEN Ausschnitt
        // gerechnet: am Telefon zeigt die Kurve einen Tag, also darf sie nicht
        // das Tief des anderen benennen.
        const von = zoomFenster ? zoomFenster.start : 0;
        const bis = zoomFenster ? zoomFenster.end : avg.length - 1;
        const sicht = avg.slice(von, bis + 1);
        const fenster = preisFenster(sicht, 15).map((f) => ({
          ...f,
          von: f.von + von,
          bis: f.bis + von,
        }));
        const marken = preisMarken(sicht).map((m) => ({ ...m, index: m.index + von }));
        const hatNegativ = sicht.some((v) => v != null && v < 0);

        chart.setOption(
          {
            textStyle: { fontFamily: t.font, color: t.axis },
            // Die Marken sitzen OBEN im Bild - ohne Kopfraum schneidet ECharts
            // sie am Canvas-Rand ab.
            grid: { top: 34, right: 12, bottom: 8, left: 8, containLabel: true },
            tooltip: {
              trigger: 'axis',
              confine: true,
              /**
               * K7: der Preis mit seiner BEDEUTUNG statt einer nackten Zahl.
               * Die Einordnung kommt aus DEMSELBEN `preisFenster`-Ergebnis,
               * das die Bänder im Bild zeichnet - Tooltip und Schattierung
               * können sich damit nicht widersprechen. Ohne Fenster (flacher
               * Tag) bleibt es beim Preis, nie eine erfundene Einordnung.
               */
              formatter: (params: any[]) => {
                const p = params[0];
                if (!p) return '';
                const f = fensterFuerSlot(fenster, Number(p.dataIndex));
                const preis = fmtPrice(p.value == null ? null : Number(p.value));
                return tooltip(
                  kopf(tooltipHead(p.axisValue, bucket)),
                  f == null ? preis : `${preis} — ${f.wort}`,
                );
              },
            },
            dataZoom: zoomFenster
              ? [
                  {
                    type: 'inside',
                    startValue: zoomFenster.start,
                    endValue: zoomFenster.end,
                    zoomLock: true,
                    moveOnMouseMove: false,
                    moveOnMouseWheel: false,
                    zoomOnMouseWheel: false,
                    zoomOnTouch: false,
                  },
                ]
              : undefined,
            xAxis: {
              type: 'category',
              data: times,
              boundaryGap: false,
              axisLabel: {
                formatter: (v: string) => axisLabel(v, bucket, narrow),
                color: t.axis,
                fontSize: AXIS.fontSize,
                hideOverlap: true,
              },
              // F4: kein Rahmen um die Daten - weder Achslinie noch Ticks.
              axisTick: { show: false },
              axisLine: { show: false },
            },
            yAxis: {
              // K4: die Einheit steht nie allein; nur in der schmalen Fassung
              // trägt sie sich selbst.
              name: AXIS_NAME.preis(narrow),
              type: 'value',
              ...ACHSEN_NAME,
              splitLine: { lineStyle: { color: t.grid } },
              axisTick: { show: false },
              axisLine: { show: false },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
            },
            series: [
              {
                name: 'Börsenpreis',
                type: 'line',
                data: avg,
                // Ein Viertelstundenpreis GILT bis zum nächsten Slot - die
                // Stufe ist die ehrliche Form, nicht die Interpolation.
                step: 'end',
                showSymbol: false,
                connectNulls: false,
                lineStyle: { color: t.price, width: STROKE.lead },
                itemStyle: { color: t.price },
                // K6: höchstens drei benannte Marken - hier Tief und Hoch, je
                // mit WORT und Zahl.
                markPoint:
                  marken.length > 0
                    ? {
                        silent: true,
                        symbol: 'circle',
                        symbolSize: 8,
                        data: marken.map((m) => ({
                          name: m.text,
                          coord: [m.index, m.ct],
                          itemStyle: {
                            color: t.surface,
                            borderColor: m.art === 'hoch' ? t.discharge : t.guenstig,
                            borderWidth: 2,
                          },
                          label: {
                            show: true,
                            position: m.art === 'hoch' ? 'top' : 'bottom',
                            distance: 8,
                            formatter: m.text,
                            color: t.ink,
                            fontSize: AXIS.fontSize,
                            fontWeight: 600,
                            backgroundColor: t.surface,
                            padding: [2, 5],
                            borderRadius: 4,
                          },
                        })),
                      }
                    : undefined,
                markLine: {
                  silent: true,
                  symbol: 'none',
                  data: [
                    // Die Nulllinie wird nur betont, wo es wirklich unter Null
                    // geht - sonst wäre sie eine Behauptung über Negativpreise.
                    ...(hatNegativ
                      ? [
                          {
                            yAxis: 0,
                            lineStyle: { color: t.axisLine, type: 'solid', width: STROKE.ref },
                            label: { show: false },
                          },
                        ]
                      : []),
                    ...(boundaryIdx > 0
                      ? [
                          {
                            xAxis: boundaryIdx,
                            // F6 (korrigiert): der Börsenpreis für morgen STEHT
                            // FEST - die Tagesgrenze ist eine Referenz-
                            // Haarlinie mit DATUM, keine Prognose-Marke.
                            lineStyle: dayBoundaryStyle(t),
                            label: {
                              formatter: grenzLabel(times[boundaryIdx]),
                              color: t.axis,
                              fontSize: AXIS.fontSize,
                              position: 'insideEndBottom',
                              // Auf einer Kategorie-Achse rendert ECharts eine
                              // Beschriftung sonst GEDREHT an der Linie
                              // entlang - die dokumentierte Kanten-Falle.
                              rotate: 0,
                              backgroundColor: t.surface,
                              padding: [2, 4],
                              borderRadius: 3,
                            },
                          },
                        ]
                      : []),
                  ],
                },
                markArea: {
                  silent: true,
                  data: [
                    // ⚠ Die Bänder tragen ihr Wort in der ZEILE unter dem Bild
                    // (`FensterZeile`), nicht als `markArea`-Label: ein
                    // 2½-Stunden-Band ist auf einer 48-Stunden-Achse ~40 px
                    // breit, sein Wort ~150 px - im ersten Bau überlappten sich
                    // die zwei Etiketten prompt gegenseitig UND die
                    // Datums-Beschriftung der Tagesgrenze.
                    ...fenster.map((f) => [
                      {
                        xAxis: f.von,
                        itemStyle: { color: withAlpha(fensterFarbe(f.art, t), FILL.speaking) },
                      },
                      { xAxis: f.bis },
                    ]),
                    // Die Tagesgrenze ist bei 375 px die eigentliche Botschaft
                    // der Kurve („bis wohin ist der Preis schon bekannt"): der
                    // Strich allein geht zwischen 96 Slots unter, die getönte
                    // Fläche nicht.
                    ...(boundaryIdx > 0
                      ? [
                          [
                            {
                              xAxis: boundaryIdx,
                              itemStyle: { color: withAlpha(t.price, FILL.past) },
                            },
                            { xAxis: buckets.length - 1 },
                          ],
                        ]
                      : []),
                  ],
                },
              },
            ],
          },
          true,
        );
        return;
      }

      // Week/month/year: average line + min/max band (two stacked helper series
      // draw the band; the tooltip reads avg/min/max off the bucket by index).
      const lows = ctReihe(buckets.map((b) => b.minEurMwh));
      const spans = buckets.map((b) =>
        b.minEurMwh == null || b.maxEurMwh == null
          ? null
          : (Number(b.maxEurMwh) - Number(b.minEurMwh)) / 10,
      );

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 28, right: 12, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: any[]) => {
              const idx = params[0]?.dataIndex;
              const b = buckets[idx];
              if (!b) return '';
              const lines = [`<b>${tooltipHead(b.ts, bucket)}</b>`];
              lines.push(`Ø ${fmtPrice(b.avgEurMwh == null ? null : Number(b.avgEurMwh) / 10)}`);
              if (b.minEurMwh != null && b.maxEurMwh != null) {
                lines.push(
                  `Min ${(Number(b.minEurMwh) / 10).toLocaleString('de-DE', {
                    maximumFractionDigits: 1,
                  })} · Max ${(Number(b.maxEurMwh) / 10).toLocaleString('de-DE', {
                    maximumFractionDigits: 1,
                  })} ct/kWh`,
                );
              }
              return lines.join('<br/>');
            },
          },
          xAxis: {
            type: 'category',
            data: times,
            boundaryGap: false,
            axisLabel: {
              // Narrow week view: one weekday label per day (at its first
              // bucket) - the auto interval over hourly buckets would repeat
              // weekdays ("Mo Mo Di ...").
              formatter:
                weekNarrow
                  ? (v: string) =>
                      new Date(v).getHours() === 0 ? axisLabel(v, bucket, true) : ''
                  : (v: string) => axisLabel(v, bucket, narrow),
              interval: weekNarrow ? 0 : 'auto',
              color: t.axis,
              hideOverlap: true,
            },
            // F4: kein Rahmen um die Daten - weder Achslinie noch Ticks.
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: {
            type: 'value',
            // K4: die Einheit steht nie allein - ct/kWh ist die Leiteinheit,
            // EUR/MWh bleibt Profi-Detail im Tooltip.
            name: AXIS_NAME.preis(narrow),
            ...ACHSEN_NAME,
            splitLine: { lineStyle: { color: t.grid } },
            axisTick: { show: false },
            axisLine: { show: false },
            axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
          },
          series: [
            {
              name: 'min',
              type: 'line',
              data: lows,
              stack: 'band',
              symbol: 'none',
              silent: true,
              lineStyle: { opacity: 0 },
              areaStyle: { opacity: 0 },
              z: 1,
            },
            {
              name: 'span',
              type: 'line',
              data: spans,
              stack: 'band',
              symbol: 'none',
              silent: true,
              lineStyle: { opacity: 0 },
              areaStyle: { color: t.price, opacity: FILL.band },
              z: 1,
            },
            {
              name: 'Ø Preis',
              type: 'line',
              data: avg,
              symbol: 'none',
              smooth: false,
              lineStyle: { color: t.price, width: STROKE.lead },
              itemStyle: { color: t.price },
              z: 2,
            },
          ],
        },
        true,
      );
    },
    // `fokus` MUSS in den Abhaengigkeiten stehen: `useEChart` fuehrt die
    // Render-Closure nur bei einer Aenderung hier erneut aus, sonst behielte
    // das Diagramm sein altes Fenster und der „Morgen ›"-Sprung waere eine
    // Beschriftung ohne Wirkung (im Browser per Canvas-Vergleich aufgefallen -
    // Etikett und Chip wechselten, die Pixel nicht).
    [history, fokus],
  );

  // K10: die Bänder tragen ihr Wort - unmittelbar unter dem Bild, im selben
  // Block, samt Zeitraum. Ohne Fenster (flacher Tag, Rückblick) erscheint die
  // Zeile gar nicht.
  const zeilen: FensterZeile[] =
    history.bucket === 'PT15M'
      ? fensterZeilen(
          preisFenster(
            ctReihe(history.buckets.map((b) => b.avgEurMwh)),
            15,
          ),
          history.buckets.map((b) => b.ts),
        )
      : [];

  return (
    <>
      <div ref={ref} className="vp-chart" />
      {zeilen.length > 0 && (
        <div className="vp-preisfenster">
          {zeilen.map((f) => (
            <span key={f.art} className={`vp-preisfenster-item art-${f.art}`}>
              <i aria-hidden="true" />
              {f.wort} · {f.zeit}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
