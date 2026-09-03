import type { History, PlantKind, SiteEarningsBucket } from '../api';
import {
  AXIS,
  BAR,
  FILL,
  NARROW_PX,
  nowLabel,
  nowLineStyle,
  PANELS,
  SMOOTH_SERIES,
  storageBar,
  storageMark,
  STROKE,
} from '../chartStyle';
import { chartTheme, type ChartTheme } from '../chartTheme';
import { LADESTAND } from '../chartCopy';
import { flussSatz, kopf, tooltip, TOOLTIP_CSS, wertZeile } from '../chartTooltip';
import { preisMarken } from '../preisFenster';
import { ereignisSpur } from '../historieEreignisse';
import {
  DETAIL_INHALT,
  ertragKumuliert,
  hatWerte,
  jetztIndex,
  netzReihe,
  PANEL_TITEL,
  panelLayout,
  preisReihe,
  REIHE,
  speicherReihe,
  tagesbildAussage,
  tagesbildKern,
  titelTopPct,
  type PanelBox,
  type PanelTitel,
  type TagesbildGeld,
} from '../tagesbild';
import { useChartDetail } from '../useChartDetail';
import { useEChart } from '../useEChart';
import {
  ChartDetailToggle,
  ChartHeadline,
  ChartInsight,
  ChartLegend,
  type LegendItem,
} from './ChartExplain';
import { EreignisSpur, ereignisFarbe } from './EreignisSpur';

import './Historie.css';

/**
 * **Das TAGESBILD** — der Nachweis-Baustein der Erlöse-Welt (Chart-Redesign
 * Stufe 3; Ziel-Mockup `vn-tagesbild`, r2 §6 A, Ranking M1 + M5).
 *
 * DREI Plotflächen in EINEM ECharts-Objekt über EINER Zeitachse, verbunden
 * durch EIN Fadenkreuz (`axisPointer.link`) und EINE „Jetzt"-Fahne unter der
 * Achse (K9):
 *
 *  1. **Was Strom heute kostet** — der Börsenpreis als ruhige Stufenlinie, mit
 *     höchstens zwei BENANNTEN Marken (K6: Wort UND Zahl, aus derselben
 *     `preisMarken`-Regel wie die Marktpreis-Seite).
 *  2. **Was Ihre Anlage macht** — Laden grün gefüllt und Abgeben beere gefüllt
 *     (K5, dazu Position und Wort); Ladestand und Netz
 *     liegen eine Stufe tiefer hinter „Mehr anzeigen ▾" (K3).
 *  3. **Was dabei herauskommt** — das gemessene Geld des Tages, aufsummiert.
 *
 * Es ERSETZT das frühere „Speicher & Preis" (`HistoryDayChart`): ein Einzelbild
 * mit DREI Y-Achsen, von denen eine unsichtbar war — also genau die
 * Konstruktion, die F8 (verschärft, r2 §4) verbietet, und die Ursache dafür,
 * dass Preis und Leistung im selben Bild gegeneinander gelesen wurden.
 *
 * ⚠ Es gibt KEINE „ohne Speicher"-Geisterkurve — der Vergleichsanker steht als
 * exaktes Paar im KOPF. Die ausführliche Begründung steht in `tagesbild.ts`;
 * kurz: einen Gegenwelt-Wert JE ZEIT-EIMER gibt es im Portal nicht, und die
 * naheliegende Ersatzrechnung ist genau die Zeile, die das Haus schon einmal
 * bewusst nicht gebaut hat.
 *
 * ⚠ ALLE drei Grids tragen denselben linken und rechten Rand, und
 * `containLabel` bleibt aus — sonst lägen die Zeitachsen nicht übereinander,
 * und die geteilte Achse IST der Zweck (die Auflage der Zwei-Panel-Stufe).
 */

/** Das gemessene Geld dieses Tages, so viel wie das Bild davon braucht. */
export interface TagesbildGeldReihe extends TagesbildGeld {
  /** Die Geld-Eimer des Tages (Stunden) — Quelle der Summenkurve. */
  series: SiteEarningsBucket[];
}

/** Eine Plotfläche als ECharts-Grid — die Ränder sind für alle gleich. */
function grid(box: PanelBox, left: number, right: number) {
  const base = { left, right, top: `${box.topPct}%`, show: box.sichtbar };
  return box.bottomPx != null
    ? { ...base, bottom: box.bottomPx }
    : { ...base, height: `${box.heightPct ?? 0}%` };
}

/** Die Überschrift eines Panels — Aussage fett, Einheit als ruhiger Beisatz. */
function panelTitel(
  box: PanelBox,
  titel: PanelTitel,
  left: number,
  t: ChartTheme,
  narrow: boolean,
) {
  return {
    show: box.sichtbar,
    left,
    top: `${titelTopPct(box)}%`,
    text: narrow
      ? `{a|${titel.text}}`
      : `{a|${titel.text}}  {b|${titel.einheit}}`,
    textStyle: {
      rich: {
        // §3.6: „die drei Panel-Titel 12/600 sekundär". Sie benennen ein
        // Panel — sie sind nicht die Aussage der Karte (Befund B5: fünf
        // gleich laute Köpfe je Seite).
        a: { color: t.axis, fontSize: AXIS.fontSize, fontWeight: 600 },
        b: { color: t.axis, fontSize: AXIS.fontSize, fontWeight: 400 },
      },
    },
  };
}

function eur(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function ct(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}

function kwText(v: number): string {
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
}

export function Tagesbild({
  history,
  geld,
  plantKind,
}: {
  history: History;
  /** Das gemessene Geld des Tages; `null` = Panel 3 entfällt (ehrlich, nie 0). */
  geld?: TagesbildGeldReihe | null;
  plantKind: PlantKind;
}) {
  const t = chartTheme();
  const [detail, toggleDetail] = useChartDetail('tagesbild');
  const spur = ereignisSpur(history);

  const buckets = history.buckets;
  const times = buckets.map((b) => b.start);
  const preise = preisReihe(buckets);
  const speicher = speicherReihe(buckets, history.bucketMinutes);
  const netz = netzReihe(buckets, history.bucketMinutes);
  const ladestand = buckets.map((b) => b.socLastPct);
  const ertrag = ertragKumuliert(times, geld?.series);

  const hatPreis = hatWerte(preise);
  const hatErtrag = ertrag.vorhanden;
  const hatNetz = hatWerte(netz);
  const hatLadestand = hatWerte(ladestand);
  // K3: die Detailtiefe wird nur ANGEBOTEN, wenn es wirklich etwas dahinter
  // gibt - ein Umschalter, der nur Leeres zeigen kann, ist schlimmer als keiner.
  const detailMoeglich = hatNetz || hatLadestand;
  const zeigeDetail = detail && detailMoeglich;

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < NARROW_PX;
      const layout = panelLayout(hatPreis, hatErtrag);
      const left = narrow ? PANELS.leftNarrowPx : PANELS.leftPx;
      // Die Ladestand-Miniskala ist die EINE geduldete F8-Ausnahme und braucht
      // rechts Platz; ohne sie bleibt der schmale Rand.
      const socScale = zeigeDetail && hatLadestand && !narrow;
      const right = socScale ? PANELS.rightWithSocPx : PANELS.rightPx;

      const nowIdx = jetztIndex(times, new Date());
      // Die kW-Achse bekommt UNABHAENGIGE Grenzen statt einer symmetrischen
      // Spanne: ein Tag, der mit 9 kW laedt und mit 3 kW abgibt, verschenkte
      // sonst die halbe Flaeche an leeren Raum. Die Null bleibt im Bild
      // (Hausregel 5d) - sie steht nur nicht mehr zwingend in der Mitte.
      const kwWerte = speicher
        .concat(zeigeDetail ? netz : [])
        .filter((v): v is number => v != null);
      const kwMax = Math.max(1, ...kwWerte);
      const kwMin = Math.min(-1, ...kwWerte);

      /* ---- Marken: die Linie zieht durch ALLE Panels, das WORT steht EINMAL
       * unten an der Zeitachse (K9). Zwei Fahnen übereinander waren genau der
       * Baufehler der Revision 1 (r2 §6 A). */
      const nowLine = nowIdx > 0 ? { xAxis: nowIdx, lineStyle: nowLineStyle(t) } : null;
      const stilleMarke = nowLine ? [{ ...nowLine, label: { show: false } }] : [];
      const fahnenMarke = nowLine
        ? [
            {
              ...nowLine,
              label: {
                ...nowLabel(t, 'start'),
                formatter: `Jetzt ${new Date(times[nowIdx]).toLocaleTimeString('de-DE', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`,
                backgroundColor: t.surface,
                padding: [2, 4],
                borderRadius: 3,
                distance: PANELS.nowFlagDistancePx,
              },
            },
          ]
        : [];

      /** Die Vergangenheits-Schattierung (F5, Hauch) - auf JEDEM Panel. */
      const pastArea =
        nowIdx > 0
          ? {
              data: [
                [
                  { xAxis: 0, itemStyle: { color: t.axis, opacity: FILL.past } },
                  { xAxis: nowIdx },
                ],
              ],
            }
          : undefined;

      /**
       * Die Ereignis-Bänder (F6) - dieselbe Semantik wie in der Messwerte-Welt.
       *
       * ⚠ Eine Serie trägt GENAU EINE `markArea`, also reisen Vergangenheits-
       * Schattierung und Ereignis-Bänder auf DERSELBEN Liste. Getrennt gedacht
       * verlor eine von beiden - im Browser aufgefallen: die Bänder waren
       * unsichtbar, solange es ein Preis-Panel gab.
       */
      const ereignisPaare = (spur?.chips ?? [])
        .filter((c) => c.vonIndex >= 0)
        .map((c) => [
          {
            xAxis: c.vonIndex,
            itemStyle: { color: ereignisFarbe(t, c.info.farbe), opacity: FILL.event },
          },
          { xAxis: c.bisIndex },
        ]);
      const flaechen = (mitEreignissen: boolean) => {
        const data = [...(pastArea ? pastArea.data : []), ...(mitEreignissen ? ereignisPaare : [])];
        return data.length ? { markArea: { silent: true, data } } : {};
      };

      // K6: höchstens ZWEI benannte Preis-Marken, Wort UND Zahl - dieselbe
      // Regel, mit der die Marktpreis-Seite ihre Extreme benennt.
      const marken = hatPreis ? preisMarken(preise) : [];

      const serien: Record<string, unknown>[] = [];
      if (layout.preis.sichtbar) {
        serien.push({
          name: REIHE.preis,
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: preise,
          step: 'end',
          symbol: 'none',
          z: 2,
          lineStyle: { color: t.price, width: STROKE.lead },
          itemStyle: { color: t.price },
          ...flaechen(true),
          markLine: stilleMarke.length
            ? { silent: true, symbol: 'none', data: stilleMarke }
            : undefined,
          // Ein Wort über einer Marke gehört an einen `markPoint` mit
          // `symbolSize: 0` - ein `markArea`-Label würde auf die Breite seines
          // Rechtecks geklemmt (die dokumentierte ECharts-Falle).
          markPoint: marken.length
            ? {
                silent: true,
                symbol: 'circle',
                symbolSize: 5,
                data: marken.map((m) => ({
                  xAxis: m.index,
                  yAxis: m.ct,
                  itemStyle: { color: m.art === 'hoch' ? t.discharge : t.guenstig },
                  label: {
                    formatter: m.text,
                    color: t.ink,
                    fontSize: AXIS.fontSize,
                    // BEIDE nach oben: die Tief-Marke liegt an der
                    // Panel-Unterkante, ein Label darunter landete in der
                    // Ueberschrift der naechsten Flaeche. Am Telefon ist das
                    // Preis-Panel nur ~100 px hoch, dort stiess auch das obere
                    // Label in die Ueberschrift - deshalb rueckt es hinein
                    // (beides im Browser bei 375 px gemessen).
                    position: narrow ? 'inside' : 'top',
                    backgroundColor: t.surface,
                    padding: [1, 3],
                    borderRadius: 3,
                  },
                })),
              }
            : undefined,
        });
      }

      serien.push({
        name: REIHE.laden,
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        // K5: Laden grün gefüllt, Abgeben beere gefüllt; dazu Position
        // (über/unter Null) und das Wort in der Legende.
        data: speicher.map((v) =>
          storageBar(v, storageMark(v != null && v < 0 ? 'entladen' : 'laden', t), t.surface),
        ),
        barCategoryGap: BAR.categoryGap,
        barMaxWidth: BAR.maxWidth,
        z: 3,
        ...flaechen(!layout.preis.sichtbar),
        markLine: (layout.ertrag.sichtbar ? stilleMarke : fahnenMarke).length
          ? {
              silent: true,
              symbol: 'none',
              data: layout.ertrag.sichtbar ? stilleMarke : fahnenMarke,
            }
          : undefined,
      });

      if (zeigeDetail && hatNetz) {
        serien.push({
          name: REIHE.netz,
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: netz,
          ...SMOOTH_SERIES,
          symbol: 'none',
          z: 2,
          lineStyle: { color: t.flowGridLine, width: STROKE.contextSoft },
          itemStyle: { color: t.flowGridLine },
        });
      }
      if (zeigeDetail && hatLadestand) {
        serien.push({
          name: REIHE.ladestand,
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 2,
          data: ladestand,
          ...SMOOTH_SERIES,
          symbol: 'none',
          z: 1,
          lineStyle: { color: t.soc, width: STROKE.contextSoft, type: 'dotted' },
          itemStyle: { color: t.soc },
        });
      }

      if (layout.ertrag.sichtbar) {
        serien.push({
          name: REIHE.ertrag,
          type: 'line',
          xAxisIndex: 2,
          yAxisIndex: 3,
          data: ertrag.werte,
          // Das Geld des Tages liegt in STUNDEN-Eimern, die Achse in
          // Viertelstunden: die Kurve steigt an der vollen Stunde und hält
          // dazwischen - sie behauptet damit keine Auflösung, die sie nicht hat.
          step: 'end',
          symbol: 'none',
          connectNulls: false,
          z: 2,
          lineStyle: { color: t.plan, width: STROKE.lead },
          itemStyle: { color: t.plan },
          areaStyle: { color: t.plan, opacity: FILL.wash },
          ...flaechen(false),
          markLine: fahnenMarke.length
            ? { silent: true, symbol: 'none', data: fahnenMarke }
            : undefined,
        });
      }

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          // EIN Fadenkreuz über ALLE Panels - das macht die geteilte Zeitachse
          // überhaupt erst sichtbar (K9).
          axisPointer: { link: [{ xAxisIndex: 'all' }] },
          title: [
            panelTitel(layout.preis, PANEL_TITEL.preis, left, t, narrow),
            panelTitel(layout.leistung, PANEL_TITEL.leistung, left, t, narrow),
            panelTitel(layout.ertrag, PANEL_TITEL.ertrag, left, t, narrow),
          ],
          grid: [
            grid(layout.preis, left, right),
            grid(layout.leistung, left, right),
            grid(layout.ertrag, left, right),
          ],
          tooltip: {
            trigger: 'axis',
            confine: true,
            // K7: ein SATZ muss umbrechen duerfen - siehe TOOLTIP_CSS.
            extraCssText: TOOLTIP_CSS,
            /**
             * ⚠ Aus dem EIMER-INDEX komponiert, nicht aus den `params`: bei
             * mehreren Grids liefert ECharts nur die Serien des überfahrenen
             * Panels - ein Ablesen, das oben andere Zeilen zeigt als unten,
             * wäre kein geteiltes Fadenkreuz. Der Formatter gibt rohes HTML
             * zurück und interpoliert deshalb ausschließlich Konstanten und
             * formatierte Zahlen (die XSS-Regel der Chart-Formatter).
             */
            formatter: (params: { dataIndex?: number }[]) => {
              const i = params?.[0]?.dataIndex ?? -1;
              const iso = times[i];
              if (iso == null) return '';
              const zeit = new Date(iso).toLocaleTimeString('de-DE', {
                hour: '2-digit',
                minute: '2-digit',
              });
              // K7 · der SATZ zuerst: was der Speicher tut und - wenn die
              // Detailtiefe das Netz zeigt - wohin die Energie geht. Beide
              // Größen sind GEMESSEN (Historie), also spricht der Satz nur
              // ihre eigenen Vorzeichen aus und erfindet keine Zuordnung.
              const satz = flussSatz(
                {
                  speicher: speicher[i] ?? null,
                  netz: zeigeDetail && hatNetz ? (netz[i] ?? null) : null,
                },
                (b) => kwText(b),
              );
              const zeilen = [kopf(`${zeit} Uhr`), satz.text].filter(
                (z): z is string => z != null,
              );
              const row = (color: string, text: string) => zeilen.push(wertZeile(color, text));
              if (layout.preis.sichtbar && preise[i] != null)
                row(t.price, `${REIHE.preis}: ${ct(preise[i] as number)}`);
              if (zeigeDetail && hatLadestand && ladestand[i] != null)
                row(
                  t.soc,
                  `${LADESTAND}: ${(ladestand[i] as number).toLocaleString('de-DE', {
                    maximumFractionDigits: 0,
                  })} %`,
                );
              if (layout.ertrag.sichtbar && ertrag.werte[i] != null)
                row(t.plan, `${REIHE.ertrag}: ${eur(ertrag.werte[i] as number)}`);
              return tooltip(...zeilen);
            },
          },
          xAxis: [0, 1, 2].map((gi) => {
            const beschriftet = gi === layout.achseIndex;
            const achse: Record<string, unknown> = {
              type: 'category',
              gridIndex: gi,
              data: times,
              show: gi === 0 ? layout.preis.sichtbar : gi === 1 ? true : layout.ertrag.sichtbar,
              // Die geteilte Zeitachse wird GENAU EINMAL beschriftet - unten,
              // wo der Blick ohnehin endet.
              axisLabel: beschriftet
                ? {
                    formatter: (v: string) =>
                      new Date(v).toLocaleTimeString('de-DE', {
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    color: t.axis,
                    fontSize: AXIS.fontSize,
                    hideOverlap: true,
                  }
                : { show: false },
              axisTick: { show: false },
              axisLine: { show: false },
            };
            // ⚠ Der Schlüssel wird WEGGELASSEN, nicht auf `undefined` gesetzt:
            // ECharts liest `axisPointer` als Teilmodell und schreibt in dessen
            // Option - ein vorhandener Schlüssel mit `undefined` liefert kein
            // Modell und die ganze Fläche stirbt beim Zeichnen
            // („Cannot set properties of undefined"; im Browser aufgefallen,
            // nicht im Test - der stubbt `setOption`).
            if (!beschriftet) achse.axisPointer = { label: { show: false } };
            return achse;
          }),
          yAxis: [
            {
              // Panel 1: der Preis, allein auf seiner Skala. Negativpreise sind
              // Produkt-Substanz, also bleibt die Null im Bild (Hausregel 5d).
              type: 'value',
              gridIndex: 0,
              show: layout.preis.sichtbar,
              min: (v: { min: number }) => Math.min(0, v.min),
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
              axisTick: { show: false },
              axisLine: { show: false },
            },
            {
              // Panel 2: die Leistung, symmetrisch um die Nulllinie.
              type: 'value',
              gridIndex: 1,
              min: Math.floor(kwMin),
              max: Math.ceil(kwMax),
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
              axisTick: { show: false },
              axisLine: { show: false },
            },
            {
              // Die EINE geduldete F8-Ausnahme: der Ladestand als beschriftete
              // Kontext-Miniskala (0-100 %, dimensionslos).
              type: 'value',
              gridIndex: 1,
              min: 0,
              max: 100,
              show: socScale,
              position: 'right',
              offset: 44,
              splitLine: { show: false },
              axisLine: { show: true, lineStyle: { color: t.soc, width: STROKE.ref } },
              axisTick: { show: false },
              axisLabel: { color: t.soc, formatter: '{value} %', fontSize: AXIS.fontSize },
            },
            {
              // Panel 3: das Geld. Die Null bleibt im Bild - ein Verlusttag
              // hängt unter ihr, statt als niedriger Gewinn zu lesen.
              type: 'value',
              gridIndex: 2,
              show: layout.ertrag.sichtbar,
              min: (v: { min: number }) => Math.min(0, v.min),
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis, fontSize: AXIS.fontSize },
              axisTick: { show: false },
              axisLine: { show: false },
            },
          ],
          series: serien,
        },
        true,
      );
    },
    [history, geld, zeigeDetail, t],
  );

  // K1/K8: die Kernaussage ist ABGELEITET (gemessenes `savedEur` + das exakte
  // `proofLine`-Paar als Vergleichsanker), nie geschrieben.
  const kern = tagesbildKern({ geld, buckets, plantKind });

  const legende: LegendItem[] = [
    ...(hatPreis
      ? [{ color: t.price, label: REIHE.preis, unit: 'ct/kWh', shape: 'line' as const }]
      : []),
    { color: t.charge, label: REIHE.laden, unit: 'kW', shape: 'bar' },
    { color: t.battDischarge, label: REIHE.abgeben, unit: 'kW', shape: 'bar' },
    // Die Legende bewirbt NUR, was gezeichnet werden kann: was hinter dem
    // zugeklappten Umschalter liegt, gehört nicht hinein.
    ...(zeigeDetail && hatNetz
      ? [{ color: t.flowGridLine, label: REIHE.netz, unit: 'kW', shape: 'line' as const }]
      : []),
    ...(zeigeDetail && hatLadestand
      ? [{ color: t.soc, label: REIHE.ladestand, unit: '%', shape: 'dotted' as const }]
      : []),
    ...(hatErtrag
      ? [{ color: t.plan, label: ertrag.endText ?? REIHE.ertrag, unit: '€', shape: 'line' as const }]
      : []),
  ];

  return (
    <div>
      <ChartHeadline kern={kern} />
      <ChartLegend items={legende} />
      {detailMoeglich && (
        <ChartDetailToggle open={detail} onToggle={toggleDetail} was={DETAIL_INHALT} />
      )}
      {/* Drei Flächen brauchen mehr Höhe als zwei - `panels3` ist die
          Drei-Panel-Stufe der `.vp-chart`-Höhenklassen. Am Telefon stapeln sie
          sich weiter INNERHALB einer Instanz (sie teilen ja die Zeitachse). */}
      <div ref={ref} className="vp-chart panels3" />
      {spur && (
        <EreignisSpur
          spur={spur}
          protokollHinweis={
            history.protocol.length > 0
              ? 'Den ganzen Tag in Sätzen finden Sie unten im Tagesprotokoll.'
              : null
          }
        />
      )}
      <ChartInsight icon="activity">{tagesbildAussage(hatErtrag)}</ChartInsight>
    </div>
  );
}
