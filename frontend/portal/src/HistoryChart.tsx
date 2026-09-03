import { useRef, useState, type ReactNode } from 'react';
import type { History } from './api';
import { endsCollide, useDirectLabels } from './chartKopf';
import { useChartDetail } from './useChartDetail';
import {
  BAR,
  BASE_SERIES_LIMIT,
  DIRECT_LABEL_GUTTER_PX,
  directLabel,
  FILL,
  ghostItem,
  ghostLine,
  NARROW_PX,
  nowLabel,
  nowLineStyle,
  SMOOTH_SERIES,
  STROKE,
  withAlpha,
} from './chartStyle';
import { vergleichName, vergleichReihe } from './chartCopy';
import { chartTheme, type ChartTheme } from './chartTheme';
import { energieTeil, flussSatz, flussTeil, kopf, tooltip, TOOLTIP_CSS, type FlussRolle } from './chartTooltip';
import { fmtNum } from './format';
import {
  anzeigeWert,
  energieDiagramm,
  toggleSerie,
  vorzeichenLabel,
  type EnergieFarbe,
  type EnergieSerie,
} from './energieBilanz';
import {
  drilldownHinweis,
  ereignisSpur,
  tagesSprung,
  type EreignisSpurView,
} from './historieEreignisse';
import { angleichen, type UeberlagerungLegende } from './historieVergleich';
import { useEChart } from './useEChart';
import {
  ChartDetailToggle,
  ChartLegend,
  type LegendItem,
} from './components/ChartExplain';
import { Aufklapper } from './components/Aufklapper';
import { useIsPhone } from './useIsPhone';
import { EreignisSpur, ereignisFarbe } from './components/EreignisSpur';
import { UeberlagerungLegendeZeile } from './components/HistorieWelt';

import './components/Historie.css';

/**
 * Wie kräftig ein Ereignis-Band unter den Reihen liegt (Ortsangabe, kein
 * Inhalt). Im Browser bei 1440 UND 375 px eingestellt: darunter verschwindet es
 * am Telefon hinter den dichten Balken, darüber konkurriert es am Schreibtisch
 * mit den Reihen, die es erklären soll.
 */
const BAND_OPACITY = 0.2;

/**
 * Welche Reihe der Energie-Bilanz welche Fluss-Rolle des Ablese-Satzes ist
 * (K7). Der Ladestand hat KEINE — er ist keine Leistung und trägt keine
 * Richtung, also behält er seine eigene Wert-Zeile.
 */
const SATZ_ROLLE: Partial<Record<EnergieSerie['key'], FlussRolle>> = {
  pv: 'pv',
  haus: 'haus',
  netz: 'netz',
  batterie: 'speicher',
};

/**
 * Die Ereignis-Bänder als ECharts-`markArea` (F6): je Ereignis eine
 * durchscheinende Fläche über GENAU der Balkenspanne, die
 * `historieEreignisse.bandSpanne` entschieden hat - in derselben Farbe wie sein
 * Chip darunter, damit Marker und Erklärung sichtbar zusammengehören.
 */
function ereignisBaender(spur: EreignisSpurView | null, t: ChartTheme) {
  if (!spur || spur.chips.length === 0) return {};
  const data = spur.chips
    .filter((c) => c.vonIndex >= 0)
    .map((c) => [
      {
        xAxis: c.vonIndex,
        itemStyle: { color: ereignisFarbe(t, c.info.farbe), opacity: BAND_OPACITY },
      },
      { xAxis: c.bisIndex },
    ]);
  return data.length ? { markArea: { silent: true, data } } : {};
}

/** Bucket label: day -> "12:15", week -> "Mi 06:00", month/year -> "15.06.". */
function timeLabel(iso: string, range: History['range'], narrow = false): string {
  const d = new Date(iso);
  if (range === 'day') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === 'week') {
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

/**
 * A pure `EnergieFarbe` key -> the resolved chart hex.
 *
 * **Die FORM entscheidet mit (F2, „dünn heisst dunkler"):** als LINIE
 * (Tages-Ansicht) braucht dieselbe Rolle eine dunklere Stufe als als Balken.
 * Beim NETZ ist das zusätzlich eine Trennungsfrage - der helle Netz-Ton war
 * vom Laden-Grün nicht zu trennen (ΔE 9,8, harter FAIL), die dunklere
 * `flowGridLine`-Stufe trennt mit ΔE 19,3. PV und Haus bekommen aus demselben
 * Grund ihre `-line`-Stufen; als BALKEN (Woche+) behalten alle drei den hellen
 * Grundton, den auch der Energiefluss trägt.
 *
 * Entlade-Summen tragen den eigenen Beerenton (K5); die kombinierte signierte
 * Batterie-Zeitreihe bleibt eine logische Reihe mit Vorzeichen/Position.
 */
function farbe(t: ChartTheme, key: EnergieFarbe, linie = false): string {
  switch (key) {
    case 'pv':
      return linie ? t.pvLine : t.pv;
    case 'load':
      return linie ? t.loadLine : t.load;
    case 'grid':
      return linie ? t.flowGridLine : t.flowGrid;
    case 'gridImport':
      return t.discharge;
    case 'gridExport':
      return t.charge;
    case 'charge':
      return t.charge;
    case 'battDischarge':
      return t.battDischarge;
    case 'soc':
    default:
      return t.soc;
  }
}

function num(v: number, digits = 2): string {
  return v.toLocaleString('de-DE', { maximumFractionDigits: digits });
}

/**
 * **Die Standardansicht „Energie"** — EIN Diagramm mit der ganzen
 * Energiegeschichte des Zeitraums: PV-Erzeugung, Hausverbrauch, Netz
 * (+Bezug/−Einspeisung), Batterie (+laden/−entladen) und der Ladestand auf einer
 * zweiten Achse. Das ist der gemeinsame Nenner der sechs recherchierten
 * Referenzprodukte (Fronius Solar.web, SolarEdge, Home Assistant Energy, Victron
 * VRM, OpenEMS, evcc) — und der Ersatz für die frühere Vier-Reihen-Fassung, die
 * weder Batterie noch Ladestand zeigte und unter dem GELD-Tab lag.
 *
 * Fünf Regeln aus dem Entwurf, alle hier umgesetzt:
 *
 *  1. Tag = kW-Linien, Woche/Monat/Jahr = kWh-Balken (der SolarEdge/Fronius-Wechsel).
 *  2. **Die Legende ist die Bedienung** — Klick blendet eine Reihe aus.
 *  3. Der Tooltip nennt **alle** Reihen zu einem Zeitpunkt, in Klartext
 *     („Einspeisung 55,0 kW", nicht „Netz −55").
 *  4. Eine **betonte Nulllinie** trägt „↑ Bezug · Laden / ↓ Einspeisung · Entladen".
 *  5. Zoom per Streifen (unter 480 px entfällt er, wie im Entwurf vermerkt).
 *
 * Ehrlichkeit: eine Reihe ohne einen einzigen Wert wird NICHT als 0-Linie
 * gezeichnet — sie fehlt, und die Legende nennt den Grund.
 *
 * Seit PR E trägt es zwei Anschlussfragen mit (Konzept
 * `data/vp-historie-konzept-t4`): die **Ereignis-Spur** (F6) erklärt die
 * Ausreißer, und ein **Tipp auf einen Balken öffnet diesen Tag** (F5) - beides
 * abgeleitet im reinen `historieEreignisse.ts`, die Adresse baut der Aufrufer.
 */
export function HistoryEnergieChart({
  history,
  onTagOeffnen,
  vergleich,
  legende,
  erklaerung,
}: {
  history: History;
  /**
   * Der Tagesdrilldown (F5): bekommt das Datum (`YYYY-MM-DD`) des angetippten
   * Balkens. Fehlt er, ist das Diagramm wie bisher nur Anzeige — im
   * Tages-Zeitraum gibt es ohnehin nichts Feineres zu öffnen.
   */
  onTagOeffnen?: (at: string) => void;
  /**
   * **F8 · die Überlagerung**: die Antwort der Vergleichsperiode. Sie wird als
   * blasse, gestrichelte Reihe HINTER der aktuellen gezeichnet — gleiche Farbe
   * je Größe, damit man sie wiedererkennt, ohne sie zu verwechseln. Ohne Werte
   * (`null`) ist das Diagramm zeichengleich zu vorher.
   */
  vergleich?: History | null;
  /** Wer oben/unten liegt, in Worten — kommt aus `historieVergleich`. */
  legende?: UeberlagerungLegende | null;
  /**
   * **P3 · der Untertitel des Bildes.** Er steht seit dem Verlauf-Umbau IM
   * Aufklapper „Wie lese ich das Bild?" (Konzept §3.2 V6: Label → Kernsatz →
   * BILD → Legende → Erklärung), nicht mehr davor. Ohne ihn bleibt der
   * Aufklapper bei den zwei Richtungszeilen — er verschwindet nie.
   */
  erklaerung?: ReactNode;
}) {
  // K3: der Grundzustand zeigt HÖCHSTENS drei Reihen. Was darüber hinausgeht
  // (Batterie, Ladestand) liegt hinter „Mehr anzeigen ▾" - weniger
  // gleichzeitig ist verständlicher, UND es ist die vom dataviz-Validator
  // vorgeschriebene Antwort auf nicht trennbare Farbpaare („cut series or
  // facet instead"). Der Zustand wird pro Tab-Sitzung gemerkt.
  const [tiefe, tiefeUmschalten] = useChartDetail('messwerte.reihen');
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const t = chartTheme();
  /**
   * **E7 · am Telefon zieht niemand mehr einen Ausschnitt** (Captain-Entscheid
   * 03.09.2026, wörtlich: „Tooltip + Legenden-Schalter, KEIN Zoom durch Ziehen
   * am Telefon"). Jede waagerechte Geste im Bild war bis P3 ein Zoom und nie
   * ein Scroll — auf einer langen Seite kollidiert das mit dem Lesen.
   *
   * ⚠ **Die Grenze ist die VIEWPORT-Breite (`useIsPhone`, ≤ 720 px), nicht die
   *   gemessene Chart-Breite (`NARROW_PX` = 480).** Zwischen 481 und 720 sagt
   *   der Entscheid „Telefon", der Chart aber „breit genug für den Streifen" —
   *   dort hätte ein Tablet die Geste behalten, die der Entscheid abschafft.
   */
  const isPhone = useIsPhone();
  const diagramm = energieDiagramm(history);
  // Nur Reihen mit Werten sind überhaupt schaltbar/zeichenbar.
  const vorhanden = diagramm.serien.filter((s) => !s.leer);
  const fehlend = diagramm.serien.filter((s) => s.leer);
  // Die Reihen jenseits des Grundzustands - benannt, damit der Umschalter
  // sagt, WAS dahinter liegt (ein „mehr" ohne Inhaltsangabe ist eine
  // Wundertüte). Ausgeblendet wird nur, was der Kunde nicht selbst ein- oder
  // ausgeschaltet hat.
  const tiefereReihen = vorhanden.slice(BASE_SERIES_LIMIT);
  const sichtbar = vorhanden.filter(
    (s) =>
      !hidden.has(s.label) && (tiefe || !tiefereReihen.some((x) => x.label === s.label)),
  );
  // Die Vergleichsreihen entstehen aus DEMSELBEN `energieDiagramm` - eine
  // zweite Ableitung könnte auseinanderlaufen. Zugeordnet wird über den
  // Reihen-SCHLÜSSEL (nie über die Reihenfolge), am Index ausgerichtet.
  const vglDiagramm = vergleich ? energieDiagramm(vergleich) : null;
  const vglSerien = new Map(
    (vglDiagramm?.serien ?? []).filter((s) => !s.leer).map((s) => [s.key, s]),
  );
  const spur = ereignisSpur(history);
  const sprungHinweis = onTagOeffnen ? drilldownHinweis(history.range) : null;

  // Der Klick-Kontext liegt in einer Ref, damit der zrender-Handler GENAU EINMAL
  // je Diagramm registriert wird: `useEChart` ruft `render` bei jeder
  // Container-Größenänderung erneut auf, und ein `zr.off('click')` würde auch
  // ECharts' eigene Handler (Tooltip!) abräumen.
  // Der Zeitraum reist MIT: derselbe Diagramm-Baustein zeigt nacheinander Tag,
  // Woche und Monat - ein im Handler eingeschlossener Zeitraum wäre nach dem
  // ersten Wechsel falsch.
  const klick = useRef<{
    zeiten: string[];
    range: History['range'];
    oeffne?: (at: string) => void;
  }>({ zeiten: [], range: history.range });
  klick.current = { zeiten: diagramm.zeiten, range: history.range, oeffne: onTagOeffnen };
  const klickGebunden = useRef(false);

  const ref = useEChart(
    (chart, width) => {
      if (!klickGebunden.current) {
        klickGebunden.current = true;
        chart.getZr().on('click', (e: { offsetX: number; offsetY: number }) => {
          const { zeiten, range, oeffne } = klick.current;
          if (!oeffne) return;
          // Der ganze Balken-STREIFEN ist das Ziel, nicht nur der gezeichnete
          // Balken: in einem Monat ist ein schwacher Tag genau der, den man
          // antippen will, und der ist nur wenige Pixel hoch.
          if (!chart.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])) return;
          const roh = chart.convertFromPixel({ xAxisIndex: 0 }, e.offsetX);
          const idx = Math.round(Number(roh));
          const iso = zeiten[idx];
          if (!iso) return;
          const at = tagesSprung(iso, range);
          if (at) oeffne(at);
        });
      }
      const narrow = width < NARROW_PX;
      const weekNarrow = narrow && history.range === 'week';
      const { zeiten, einheit, jetztIndex } = diagramm;
      const brauchtSoc = sichtbar.some((s) => s.zweiteAchse);
      const vglName = legende?.vergleich ?? null;
      // Nur zu SICHTBAREN Reihen gibt es eine Vergleichsreihe: die Legende ist
      // die Bedienung, und was ausgeblendet ist, bleibt es in beiden Zeiträumen.
      const vglReihen = sichtbar
        .map((s) => ({ s, v: vglSerien.get(s.key) }))
        .filter((x): x is { s: EnergieSerie; v: EnergieSerie } => x.v != null);
      // M9: eine Geister-Ebene heißt überall gleich - `chartCopy` besitzt das
      // Wort, damit „blass gestrichelt" auf jeder Fläche dasselbe bedeutet.
      const nameOf = (s: EnergieSerie) => vergleichReihe(s.label, vglName);
      // K2: Name + Wert AM Kurvenende. Nur auf der TAGES-Ansicht (Linien mit
      // sichtbarem Ende); die kWh-Balken von Woche+ haben kein Kurvenende, und
      // eine Vergleichs-Überlagerung verdoppelt jede Reihe - dann bleibt die
      // Legende der bessere Weg (K2-Rückfall).
      const linienEnden = sichtbar
        .filter((x) => x.linie && !x.zweiteAchse)
        .map((x) => {
          for (let i = x.werte.length - 1; i >= 0; i -= 1) {
            const v = x.werte[i];
            if (v != null) return v;
          }
          return null;
        });
      const alleWerte = sichtbar
        .filter((x) => x.linie && !x.zweiteAchse)
        .flatMap((x) => x.werte.filter((v): v is number => v != null));
      const spanne = alleWerte.length ? Math.max(...alleWerte) - Math.min(...alleWerte) : 0;
      const direkt =
        vglReihen.length === 0 &&
        sichtbar.every((x) => x.linie) &&
        useDirectLabels(
          sichtbar.filter((x) => !x.zweiteAchse).length,
          width,
          endsCollide(linienEnden, spanne),
        );
      const vglLookup = new Map(vglReihen.map((x) => [nameOf(x.s), x.s]));

      const serieOption = (s: EnergieSerie, isFirst: boolean) => {
        const color = farbe(t, s.farbe, s.linie);
        const base = {
          name: s.label,
          yAxisIndex: s.zweiteAchse ? 1 : 0,
          data: s.werte,
          itemStyle: { color },
        };
        // Die betonte Nulllinie hängt an der ersten gezeichneten kW/kWh-Reihe.
        // Die RICHTUNGSWORTE stehen bewusst NICHT auf der Linie: im echten
        // Diagramm liegen dort die Kurven, die Beschriftung wurde unlesbar
        // durchkreuzt (und ECharts zeichnete von zwei Labels auf derselben Linie
        // nur eines). Sie stehen darum als lesbare Zeile unter der Legende -
        // gleicher Inhalt, umbruchfähig, auch am Telefon.
        const zeroLine =
          isFirst && !s.zweiteAchse
            ? {
                ...ereignisBaender(spur, t),
                markLine: {
                  silent: true,
                  symbol: 'none',
                  data: [
                    {
                      yAxis: 0,
                      // F4: die Nulllinie signierter Flächen ist eine eigene,
                      // etwas dunklere HAARLINIE - nie ein 1,6-px-Balken.
                      lineStyle: { color: t.axisLine, width: STROKE.ref, type: 'solid' as const },
                      label: { show: false },
                    },
                    ...(jetztIndex > 0 && jetztIndex < zeiten.length - 1
                      ? [
                          {
                            xAxis: jetztIndex,
                            lineStyle: nowLineStyle(t),
                            label: nowLabel(t, 'insideEndTop'),
                          },
                        ]
                      : []),
                  ],
                },
              }
            : {};
        if (s.linie) {
          return {
            ...base,
            ...zeroLine,
            type: 'line' as const,
            ...SMOOTH_SERIES,
            showSymbol: false,
            connectNulls: false,
            // F1-Hierarchie: die gemessenen Reihen TRAGEN die Aussage, der
            // Ladestand auf der zweiten Achse ist Kontext.
            lineStyle: s.zweiteAchse
              ? { width: STROKE.contextSoft, color, type: 'dotted' as const }
              : { width: STROKE.lead, color },
            ...(s.zweiteAchse ? {} : { areaStyle: { opacity: FILL.wash, color } }),
            ...(direkt && !s.zweiteAchse
              ? directLabel(color, (p) => {
                  const v = p.value;
                  if (v == null) return '';
                  return `${s.label}  ${fmtNum(Math.abs(Number(v)), einheit)}`;
                })
              : {}),
            z: s.zweiteAchse ? 1 : 2,
          };
        }
        return {
          ...base,
          ...zeroLine,
          type: 'bar' as const,
          barMaxWidth: BAR.maxWidth,
          barCategoryGap: BAR.categoryGap,
          itemStyle: { color, borderRadius: BAR.radius },
        };
      };

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: {
            top: 26,
            // K2 braucht rechts Platz fuer das Etikett.
            right: direkt ? DIRECT_LABEL_GUTTER_PX : brauchtSoc ? (narrow ? 26 : 46) : 12,
            bottom: narrow ? 8 : 34,
            left: 8,
            containLabel: true,
          },
          tooltip: {
            trigger: 'axis',
            confine: true,
            // K7: ein SATZ muss umbrechen duerfen - siehe TOOLTIP_CSS.
            extraCssText: TOOLTIP_CSS,
            /**
             * K7 · ein Mini-SATZ statt einer Zahlenkolonne. Die vier
             * Fluss-Größen (Sonne · Haus · Netz · Speicher) ziehen sich zu
             * EINER Aussage zusammen; der Ladestand und die Reihen der
             * Vergleichsperiode behalten ihre Wert-Zeile — der Ladestand, weil
             * er keine Richtung hat, die Vergleichsreihen, weil sie einen
             * ANDEREN Zeitraum meinen und ihn nennen müssen.
             *
             * Der Wortschatz folgt der Auflösung: am Tag misst die Fläche
             * Leistung („Haus braucht 3,4 kW"), ab der Woche Energie über einen
             * Eimer („Haus 31 kWh verbraucht") — zwei Sätze, die sich nicht
             * gegenseitig umformulieren dürfen.
             */
            formatter: (params: { axisValue: string; value: number | null; marker: string; seriesName: string }[]) => {
              const istTag = einheit === 'kW';
              const wertVon = (label: string): number | null => {
                const p = params.find((x) => x.seriesName === label);
                return p == null || p.value == null ? null : Number(p.value);
              };
              // Nur eine SICHTBARE Reihe darf in den Satz - was hinter „Mehr
              // anzeigen" liegt, ist nicht im Bild und gehört nicht in seine
              // Beschreibung.
              const flussWert = (key: EnergieSerie['key']): number | null => {
                const s = sichtbar.find((x) => x.key === key);
                return s == null ? null : wertVon(s.label);
              };
              const satz = flussSatz(
                {
                  pv: flussWert('pv'),
                  haus: flussWert('haus'),
                  netz: flussWert('netz'),
                  speicher: flussWert('batterie'),
                },
                (b) => `${num(b)} ${einheit}`,
                istTag ? flussTeil : energieTeil,
              );
              const zeilen: string[] = [];
              for (const p of params) {
                if (p.value == null) continue;
                const vgl = vglLookup.get(p.seriesName);
                const s = vgl ?? sichtbar.find((x) => x.label === p.seriesName);
                if (!s) continue;
                // Was der Satz schon ausgesprochen hat, steht darunter NICHT
                // noch einmal (M10-Geist: keine Doppel-Kolonne). Die
                // Vergleichsreihen sind davon ausgenommen - sie tragen
                // dieselbe Größe für einen anderen Zeitraum.
                if (!vgl && s.key !== 'soc' && satz.genannt.has(SATZ_ROLLE[s.key]!)) continue;
                const v = Number(p.value);
                const label = s.signed ? vorzeichenLabel(s.key, v) : s.label;
                // Beide Werte stehen im selben Tooltip - die Vergleichszeile
                // trägt ihren Zeitraum, damit nie geraten werden muss, welche
                // Zahl zu welcher Periode gehört.
                const suffix = vgl
                  ? ` <span style="opacity:.7">(${vergleichName(vglName)})</span>`
                  : '';
                zeilen.push(
                  `${p.marker} ${label}${suffix}: ${num(anzeigeWert(s, v))} ${s.unit}`,
                );
              }
              return tooltip(
                kopf(`${timeLabel(params[0]?.axisValue, history.range)}${history.range === 'day' ? ' Uhr' : ''}`),
                satz.text,
                ...zeilen,
                // Die Geste sichtbar machen, wo es sie gibt (F5) - dieselbe
                // Klick-Zeile wie im Optimizer-Diagramm.
                sprungHinweis ? '<span style="opacity:.7">Klick: diesen Tag öffnen</span>' : null,
              );
            },
          },
          xAxis: {
            type: 'category',
            data: zeiten,
            boundaryGap: diagramm.balken,
            axisLabel: {
              // Narrow week view: one weekday label per day (at its first
              // bucket) - the auto interval over hourly buckets would repeat
              // weekdays ("Mo Mo Di ...").
              formatter: weekNarrow
                ? (v: string) => (new Date(v).getHours() === 0 ? timeLabel(v, 'week', true) : '')
                : (v: string) => timeLabel(v, history.range, narrow),
              interval: weekNarrow ? 0 : 'auto',
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
              name: narrow ? einheit : einheit === 'kW' ? 'Leistung (kW)' : 'Energie (kWh)',
              nameTextStyle: { color: t.axis, align: 'left' },
              nameGap: 12,
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis },
            },
            {
              type: 'value',
              name: narrow ? '' : 'Ladestand (%)',
              nameTextStyle: { color: t.soc, align: 'right' },
              nameGap: 12,
              position: 'right',
              min: 0,
              max: 100,
              // Shown WHENEVER the Ladestand is drawn, phone included: its 0..100
              // scale does not share the kW zero, so without the labelled axis a
              // 30 % night reading sits visually BELOW the emphasised zero line
              // and reads as a negative power (measured in the browser at 375 px).
              show: brauchtSoc,
              splitLine: { show: false },
              axisLabel: {
                color: t.soc,
                formatter: narrow ? '{value}' : '{value} %',
                showMinLabel: false,
              },
            },
          ],
          // **E7 · am Telefon GAR KEIN Zoom** (Captain 03.09.2026): kein
          // Streifen und kein `inside` — eine waagerechte Geste im Bild ist
          // dort wieder Scroll, so wie überall sonst auf der Seite. Am Rechner
          // bleibt beides.
          // `zoomOnMouseWheel: false` is load-bearing: the chart sits on a long
          // scrollable page, so a wheel over it must scroll the page (the same
          // reason LocationMap disables scrollWheelZoom). Zooming is the slider
          // brush on desktop.
          dataZoom: isPhone
            ? []
            : narrow
            ? [{ type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: false, moveOnMouseWheel: false }]
            : [
                { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: false, moveOnMouseWheel: false },
                {
                  type: 'slider',
                  xAxisIndex: 0,
                  height: 22,
                  bottom: 2,
                  borderColor: t.axisLine,
                  // Token + Alpha statt eines rgba-Literals (die Hausregel des
                  // Admin-PlanCharts) - der letzte rgba-Wert der Chart-Schicht.
                  fillerColor: withAlpha(t.price, FILL.band),
                  handleStyle: { color: t.price },
                  textStyle: { color: t.axis },
                },
              ],
          series: [
            // Die Vergleichsreihen ZUERST: sie liegen damit hinter den
            // aktuellen, so wie ihre Deckkraft es verspricht.
            ...vglReihen.map(({ s, v }) => ({
              name: nameOf(s),
              type: 'line' as const,
              yAxisIndex: s.zweiteAchse ? 1 : 0,
              data: angleichen(v.werte, zeiten.length),
              ...SMOOTH_SERIES,
              showSymbol: false,
              connectNulls: false,
              z: 0,
              silent: true,
              // M9: die EINE Geister-Grammatik - Kontext-Stärke, gestrichelt,
              // EIN Alpha. Die Farbe bleibt die der Größe (Wiedererkennung).
              lineStyle: ghostLine(farbe(t, s.farbe, s.linie)),
              itemStyle: ghostItem(farbe(t, s.farbe, s.linie)),
            })),
            ...sichtbar.map((s, i) => serieOption(s, i === 0)),
          ],
        },
        true,
      );
    },
    [history, diagramm, sichtbar, vergleich, legende, t, isPhone],
  );

  // Die Legende bewirbt nur, was gezeichnet WERDEN KANN: eine Reihe hinter dem
  // zugeklappten „Mehr anzeigen" ist keine ausgeblendete Reihe, sie ist gar
  // nicht im Bild - sie in der Legende zu führen wäre ein leeres Versprechen.
  const legendReihen = tiefe ? vorhanden : vorhanden.slice(0, BASE_SERIES_LIMIT);
  const legend: LegendItem[] = legendReihen.map((s) => ({
    color: farbe(t, s.farbe, s.linie),
    label: s.label,
    unit: s.vorzeichen ?? s.unit,
    shape: s.zweiteAchse ? 'dotted' : s.linie ? 'area' : 'bar',
  }));

  return (
    <div>
      {fehlend.length > 0 && (
        <p className="vp-note vp-energie-fehlt">
          {fehlend.map((s) => s.fehlt).join(' ')}
        </p>
      )}
      {/* V6 · das BILD steht sofort nach dem Kernsatz. Legende und Erklärung
          wohnen darunter — bis P3 standen sie davor und schoben die Kurve aus
          dem ersten Bildschirm. */}
      <div
        ref={ref}
        className={
          sprungHinweis ? 'vp-c-bild vp-chart tall vp-chart-clickable' : 'vp-c-bild vp-chart tall'
        }
      />
      {spur && <EreignisSpur spur={spur} onTagOeffnen={onTagOeffnen} />}
      {/* V6 · der Detail-Umschalter gehört zur LEGENDE, nicht über das Bild:
          er entscheidet, WELCHE Reihen gezeichnet werden — genau die Frage der
          Legende. Über dem Bild schob er es aus dem ersten Bildschirm. */}
      <div className="vp-c-bild-legende">
        {tiefereReihen.length > 0 && (
          <ChartDetailToggle
            open={tiefe}
            onToggle={tiefeUmschalten}
            was={tiefereReihen.map((s) => s.label).join(', ')}
          />
        )}
        <ChartLegend
          items={legend}
          hidden={hidden}
          onToggle={(label) => setHidden((prev) => toggleSerie(prev, label, vorhanden.length))}
        />
        {vglSerien.size > 0 && <UeberlagerungLegendeZeile legende={legende ?? null} />}
      </div>
      {/* V8 · die Erklärung des Bildes in EINEM Aufklapper. Sie verschwindet
          nicht — sie wartet, bis jemand sie braucht. */}
      <Aufklapper titel="Wie lese ich das Bild?">
        {erklaerung && <p className="vp-c-bild-erklaerung">{erklaerung}</p>}
        {sichtbar.some((s) => s.signed) && (
          <p className="vp-c-bild-richtung">
            <span>↑ über der Nulllinie: Bezug · Laden</span>
            <span>↓ darunter: Einspeisung · Entladen</span>
          </p>
        )}
        <p className="vp-c-bild-erklaerung">
          <strong>PV-Erzeugung</strong> und <strong>Hausverbrauch</strong> stehen über der
          Nulllinie. Was darunter liegt, verlässt Ihr Haus: <strong>Einspeisung</strong> ins
          Netz und <strong>Entladen</strong> des Speichers. Der <strong>Ladestand</strong> läuft
          auf der rechten Achse mit. Tippen Sie eine Kachel der Legende an, um eine Reihe aus-
          oder einzublenden.
          {/* ⚠ Der Satz „im Diagramm können Sie einen Ausschnitt ziehen" steht
              nur am Rechner: am Telefon gibt es die Geste seit E7 nicht mehr,
              und ein Versprechen ohne Handlung ist schlimmer als keines. */}
          {isPhone ? '' : ' Am Rechner können Sie im Diagramm einen Ausschnitt ziehen.'}
          {sprungHinweis ? ` ${sprungHinweis}` : ''}
        </p>
      </Aufklapper>
    </div>
  );
}
