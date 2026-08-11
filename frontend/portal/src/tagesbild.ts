/**
 * Das TAGESBILD — die reinen Regeln hinter dem Drei-Panel-Tagesbild der
 * Erlöse-Welt (Chart-Redesign Stufe 3; Scout `vp-charts-verstaendlich-r2` §6 A,
 * Mockup `vn-tagesbild`, Ranking M1 + M5).
 *
 * Was es ersetzt: „Speicher & Preis" (`HistoryDayChart`) war ein EINZELBILD mit
 * DREI Y-Achsen, von denen eine unsichtbar war (Inventar `vp-charts-filigran-c7`
 * §3a Nr. 3) — also genau die Konstruktion, die F8 (verschärft in r2 §4)
 * verbietet. An ihre Stelle treten drei Panels über EINER Zeitachse mit EINEM
 * Fadenkreuz: **was Strom kostet · was die Anlage macht · was dabei
 * herauskommt.**
 *
 * Diese Datei rechnet; gezeichnet wird in `components/Tagesbild.tsx`.
 *
 * ---------------------------------------------------------------------------
 * ⚠ DIE EINE ENTSCHEIDUNG, DIE MAN KENNEN MUSS: es gibt KEINE „ohne
 * Speicher"-GEISTERKURVE, und das ist kein Versehen.
 *
 * Das Mockup zeichnet in Panel 3 neben der Ertragskurve eine zweite, blasse
 * Kurve „ohne Speicher". Für sie bräuchte es je Zeit-Eimer einen
 * Gegenwelt-Wert — und den gibt es im Portal nicht: `/sites/{id}/earnings`
 * liefert `baselineEur`/`actualEur` (das EXAKTE Paar) nur als
 * ZEITRAUM-Summe, seine Reihe (`SiteEarningsBucket`) trägt Einspeise-Erlös,
 * Wert des Eigenverbrauchs und Stromkosten — keine Baseline.
 *
 * Die naheliegende Ersatzrechnung `Ergebnis − savedEur` ist genau die Zeile,
 * die das Haus schon einmal BEWUSST NICHT gebaut hat (`erloesKomposition.ts`,
 * dokumentiert in `frontend/portal/AGENTS.md`): sie stimmt nur ohne Wert des
 * Eigenverbrauchs, weil eine ungeregelte Anlage WENIGER selbst verbraucht und
 * diesen Gegenwert der Endpunkt nicht kennt. Eine fast richtige Kurve über den
 * ganzen Tag wäre die schlechteste aller Auskünfte.
 *
 * Also steht der Vergleichsanker (K8) dort, wo er EXAKT ist: als
 * `Kernaussage.anker` im Kopf — mit demselben `proofLine`-Paar, mit dem der
 * Geld-Held der Anlage seit jeher rechnet. Das Mockup setzt den Satz „Ohne
 * Speicher wären es 3,10 € gewesen." ebenfalls in den KOPF; geliefert wird also
 * die Aussage, nur nicht ihre zweite, ungemessene Zeichnung.
 * ------------------------------------------------------------------------- */

import type { HistoryBucket, PlantKind, SiteEarningsBucket } from './api';
import { eurAmount, fmtNum } from './format';
import { proofAnchor } from './fleet';
import { PANELS3 } from './chartStyle';
import type { Kernaussage } from './chartKopf';

/* ---------------------------------------------------------------------------
 * K1 · Die drei Panel-Überschriften — in AUSSAGEFORM, nicht als Einheit
 *
 * Befund ③ der Revision 1 (r2 §2): jede Panel-Überschrift nannte eine Größe
 * („Preis (ct/kWh)"), also blieb das Bild die AUFGABE statt der Antwort. Die
 * Einheit steht weiter da — als Beisatz hinter der Aussage, nie an ihrer
 * Stelle (K4: eine Einheit steht nie allein).
 * ------------------------------------------------------------------------- */

export interface PanelTitel {
  /** Die Aussage — was dieses Panel beantwortet. */
  text: string;
  /** Der Beisatz mit der Einheit („– Cent je Kilowattstunde"). */
  einheit: string;
}

export const PANEL_TITEL = {
  preis: { text: 'Was Strom heute kostet', einheit: '– Cent je Kilowattstunde' },
  leistung: {
    text: 'Was Ihre Anlage macht',
    einheit: '– Kilowatt · gefüllt = lädt ↑  Umriss = gibt ab ↓',
  },
  ertrag: { text: 'Was dabei herauskommt', einheit: '– Euro, über den Tag aufsummiert' },
} as const satisfies Record<'preis' | 'leistung' | 'ertrag', PanelTitel>;

/**
 * Der TEXT einer Panel-Überschrift. Am Telefon fällt der Einheiten-Beisatz weg:
 * bei 375 px lief er über den Bildrand und kollidierte mit der Preis-Marke
 * darunter (im Browser gemessen). Die Einheit bleibt sichtbar — sie steht in
 * JEDER Legendenzeile (K4: die Einheit steht nie allein, aber sie muss auch
 * nicht zweimal dastehen).
 */
export function panelTitelText(titel: PanelTitel, narrow: boolean): string {
  return narrow ? titel.text : `${titel.text}  ${titel.einheit}`;
}

/** Die Reihen-Namen — sie sind zugleich die Legendenzeilen und die Etiketten. */
export const REIHE = {
  preis: 'Börsenpreis',
  laden: 'Speicher lädt',
  abgeben: 'Speicher gibt ab',
  plan: 'Geplant (Soll)',
  ladestand: 'Ladestand',
  netz: 'Netz',
  /**
   * ⚠ Sie heißt „Ergebnis“, nicht „mit VoltPilot“: der Vergleichsanker im
   * Kopf nennt mit genau diesem Wort das NETZ-Ergebnis (`proofLine`), und das
   * ist eine ANDERE Zahl als die kumulierte Netto-Kurve (sie trägt zusätzlich
   * den Wert des Eigenverbrauchs). Zwei Zahlen unter EINEM Wort - im Browser
   * sofort sichtbar: „7,00 €“ in der Legende neben „3,64 €“ im Kopf.
   */
  ertrag: 'Ergebnis',
} as const;

/** Was hinter „Mehr anzeigen ▾" liegt (K3: der Umschalter nennt seinen Inhalt). */
export const DETAIL_INHALT = 'Ladestand, Netz';

/** Unter diesem Betrag ist eine Speicherbewegung Messrauschen, keine Aussage. */
export const KW_TOTBAND = 0.05;

/** Unter diesem Betrag ist eine Ersparnis Rundung, keine Aussage. */
export const EUR_TOTBAND = 0.005;

/* ---------------------------------------------------------------------------
 * Die Aufteilung der drei Flächen
 *
 * ⚠ Die ANZAHL der Grids ist IMMER drei, auch wenn eine Fläche nichts zu
 * zeigen hat — sie schrumpft dann auf Höhe 0 (`sichtbar: false`). Damit
 * bleiben Achsen- und Serien-INDIZES stabil, und der Ein-Panel-Fall braucht
 * keinen zweiten Codepfad (die bewährte Lösung der Zwei-Panel-Stufe).
 * ------------------------------------------------------------------------- */

export interface PanelBox {
  /** Oberkante als Anteil der Bildhöhe. */
  topPct: number;
  /** Höhe als Anteil der Bildhöhe — genau eines von `heightPct`/`bottomPx`. */
  heightPct?: number;
  /** Unterkante in Pixeln (Fußraum für Achse + „Jetzt"-Fahne). */
  bottomPx?: number;
  sichtbar: boolean;
}

export interface PanelLayout {
  preis: PanelBox;
  leistung: PanelBox;
  ertrag: PanelBox;
  /**
   * Auf WELCHER Zeitachse die Beschriftung steht: die geteilte Zeitachse wird
   * genau EINMAL beschriftet, unten am letzten sichtbaren Panel (K9).
   */
  achseIndex: 0 | 1 | 2;
}

const UNSICHTBAR: PanelBox = { topPct: 100, heightPct: 0, sichtbar: false };

/**
 * Welche Fläche wo liegt. Das Leistungs-Panel ist die einzige, die es IMMER
 * gibt (ohne sie gäbe es kein Tagesbild) — Preis und Ertrag entfallen, wenn
 * ihre Daten fehlen, statt eine leere Fläche zu behaupten.
 */
export function panelLayout(hatPreis: boolean, hatErtrag: boolean): PanelLayout {
  const preis: PanelBox = hatPreis
    ? { topPct: PANELS3.preis.topPct, heightPct: PANELS3.preis.heightPct, sichtbar: true }
    : UNSICHTBAR;
  // Ohne Preis-Panel rückt die Leistung nach oben und übernimmt dessen Platz.
  const leistungTop = hatPreis ? PANELS3.leistung.topPct : PANELS3.preis.topPct;
  const leistung: PanelBox = hatErtrag
    ? {
        topPct: leistungTop,
        heightPct: PANELS3.ertrag.topPct - leistungTop - PANELS3.titelGapPct,
        sichtbar: true,
      }
    : { topPct: leistungTop, bottomPx: PANELS3.ohneErtragBottomPx, sichtbar: true };
  const ertrag: PanelBox = hatErtrag
    ? { topPct: PANELS3.ertrag.topPct, bottomPx: PANELS3.ohneErtragBottomPx, sichtbar: true }
    : UNSICHTBAR;
  return { preis, leistung, ertrag, achseIndex: hatErtrag ? 2 : 1 };
}

/** Wo die Überschrift eines Panels sitzt — sie hängt an ihrer Fläche. */
export function titelTopPct(box: PanelBox): number {
  return Math.max(0, box.topPct - PANELS3.titelGapPct);
}

/* ---------------------------------------------------------------------------
 * Panel 1 + 2 · Die gemessenen Reihen auf der GETEILTEN Zeitachse
 * ------------------------------------------------------------------------- */

/** kWh eines Eimers → mittlere Leistung in kW; `null` bleibt eine Lücke. */
function kw(kwh: number | null | undefined, bucketMinutes: number): number | null {
  if (kwh == null || !Number.isFinite(kwh) || !(bucketMinutes > 0)) return null;
  return (kwh * 60) / bucketMinutes;
}

/**
 * Die gemessene Speicherleistung je Eimer (+ lädt / − gibt ab).
 *
 * **Fehlt einer der beiden Kanäle, bleibt der Eimer LEER** — nie eine erfundene
 * 0: ein Speicher, dessen Bewegung nicht gemessen wurde, hat nicht „nichts
 * getan".
 */
export function speicherReihe(
  buckets: readonly HistoryBucket[],
  bucketMinutes: number,
): (number | null)[] {
  return buckets.map((b) => {
    if (b.batteryChargeKwh == null || b.batteryDischargeKwh == null) return null;
    return kw(b.batteryChargeKwh - b.batteryDischargeKwh, bucketMinutes);
  });
}

/**
 * Die gemessene Netzleistung je Eimer (+ Bezug / − Einspeisung) — die
 * Kontext-Reihe hinter „Mehr anzeigen". Ohne beide Richtungen keine Zeile.
 */
export function netzReihe(
  buckets: readonly HistoryBucket[],
  bucketMinutes: number,
): (number | null)[] {
  return buckets.map((b) => {
    if (b.gridImportKwh == null || b.gridExportKwh == null) return null;
    return kw(b.gridImportKwh - b.gridExportKwh, bucketMinutes);
  });
}

/** Der Börsenpreis je Eimer in ct/kWh (der Endpunkt liefert EUR/MWh). */
export function preisReihe(buckets: readonly HistoryBucket[]): (number | null)[] {
  return buckets.map((b) => (b.priceEurMwh == null ? null : b.priceEurMwh / 10));
}

/** Ob eine Reihe überhaupt einen Wert trägt — sonst wird sie nicht gezeichnet. */
export function hatWerte(reihe: readonly (number | null)[]): boolean {
  return reihe.some((v) => v != null);
}

/**
 * K9 · Der Index des Eimers, in dem „jetzt" liegt — `-1`, wenn der gezeigte Tag
 * ganz in der Vergangenheit (oder ganz in der Zukunft) liegt. Nur dann gibt es
 * eine Jetzt-Linie und eine Vergangenheits-Schattierung; auf einem
 * abgeschlossenen Tag wäre beides eine Behauptung über nichts.
 */
export function jetztIndex(times: readonly string[], now: Date): number {
  const ms = now.getTime();
  let idx = -1;
  for (let i = 0; i < times.length; i += 1) {
    const t = new Date(times[i]).getTime();
    if (!Number.isFinite(t)) return idx;
    if (t <= ms) idx = i;
    else break;
  }
  return idx === times.length - 1 ? -1 : idx;
}

/* ---------------------------------------------------------------------------
 * Panel 3 · Der Ertrag, über den Tag aufsummiert (M5)
 * ------------------------------------------------------------------------- */

export interface ErtragReihe {
  /**
   * Der kumulierte Stand je Zeitpunkt der GETEILTEN Zeitachse. `null` VOR dem
   * ersten bewerteten Eimer — dort ist nichts gemessen, und eine 0 behauptete
   * „bis hier null verdient".
   */
  werte: (number | null)[];
  /** Der Endstand als Zahl; `null`, wenn nichts kumulierbar war. */
  endEur: number | null;
  /** „mit VoltPilot 9,84 €" — das Etikett am Kurvenende (K2). */
  endText: string | null;
  vorhanden: boolean;
}

const LEERE_ERTRAG: ErtragReihe = {
  werte: [],
  endEur: null,
  endText: null,
  vorhanden: false,
};

/** Eine Zahl oder 0 — für die SUMME, in der ein fehlender Teil nichts beiträgt. */
function zahl(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Die kumulierte Ertragskurve auf der geteilten Zeitachse.
 *
 * **Die zwei Raster sind verschieden, und das ist der ganze Trick:** die
 * Historie liefert Viertelstunden, die Geld-Reihe des Tages STUNDEN (P6,
 * `verlaufSchritt`). Der Stand zu einem Zeitpunkt ist deshalb die Summe aller
 * Geld-Eimer, die bei diesem Zeitpunkt schon BEGONNEN haben — die Kurve steigt
 * damit an jeder vollen Stunde und ist zwischendurch konstant. Sie behauptet
 * also keine Viertelstunden-Auflösung, die das Geld nicht hat.
 *
 * Sie rechnet dieselbe laufende Summe wie `erloesKomposition.geldVerlauf`
 * (dieselbe Größe, dieselbe Preiswahrheit) — es entsteht kein zweiter
 * Geld-Rechner, nur eine zweite Zeitachse.
 */
export function ertragKumuliert(
  times: readonly string[],
  series: readonly SiteEarningsBucket[] | null | undefined,
): ErtragReihe {
  const eimer = (series ?? [])
    .map((b) => ({ ms: new Date(b.start).getTime(), netto: zahl(b.nettoEur) }))
    .filter((b) => Number.isFinite(b.ms))
    .sort((a, b) => a.ms - b.ms);
  if (times.length === 0 || eimer.length === 0) return LEERE_ERTRAG;

  let i = 0;
  let lauf = 0;
  let gesehen = false;
  const werte = times.map((iso) => {
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) return null;
    while (i < eimer.length && eimer[i].ms <= ms) {
      lauf += eimer[i].netto;
      i += 1;
      gesehen = true;
    }
    return gesehen ? lauf : null;
  });

  // Der Endstand ist die VOLLE Summe, auch wenn die Zeitachse vor dem letzten
  // Geld-Eimer endet - sonst stünde am Kurvenende eine kleinere Zahl als in der
  // Ergebnis-Karte derselben Seite.
  const summe = eimer.reduce((s, b) => s + b.netto, 0);
  return {
    werte,
    endEur: summe,
    endText: `${REIHE.ertrag} ${eurAmount(summe)}`,
    vorhanden: werte.some((v) => v != null),
  };
}

/* ---------------------------------------------------------------------------
 * K1 + K8 · Der Kernaussage-Kopf
 *
 * ABGELEITET, nie geschrieben (`chartKopf`-Regel). Die Zahl ist das GEMESSENE
 * `savedEur` dieses Tages — was die Steuerung gebracht hat, also genau das,
 * was diese Fläche belegen soll (und ausdrücklich NICHT das Netto-Ergebnis:
 * das steht als große Zahl schon in der Ergebnis-Karte darüber, zweimal
 * dieselbe Zahl auf einer Seite wäre die dokumentierte Doppelung).
 *
 * Der Anker ist das EXAKTE Paar aus `fleet.proofLine` (`baselineEur` gegen
 * `actualEur`) — dieselbe Ableitung, mit der der Geld-Held rechnet.
 * ------------------------------------------------------------------------- */

/** Was der Kopf aus dem gemessenen Geld dieses Tages braucht. */
export interface TagesbildGeld {
  savedEur: number | null;
  baselineEur: number | null;
  actualEur: number | null;
}

export const KEIN_GELD_GRUND =
  'Für diesen Tag ist noch nicht berechenbar, was die Steuerung gebracht hat.';

/**
 * Der Tages-Satz aus den GEMESSENEN Energien: was der Speicher an diesem Tag
 * bewegt hat. Bewusst ohne Fenster-Erzählung („mittags geladen, abends
 * geliefert") — dafür müsste die Fläche eine zweite Ableitung erfinden; die
 * Mengen stehen dagegen so in den Eimern.
 */
export function speicherTagSatz(buckets: readonly HistoryBucket[]): string | null {
  let laden = 0;
  let abgeben = 0;
  let gemessen = false;
  for (const b of buckets) {
    if (b.batteryChargeKwh != null) {
      laden += b.batteryChargeKwh;
      gemessen = true;
    }
    if (b.batteryDischargeKwh != null) {
      abgeben += b.batteryDischargeKwh;
      gemessen = true;
    }
  }
  if (!gemessen) return null;
  const l = laden >= 0.05;
  const a = abgeben >= 0.05;
  if (l && a) {
    return `der Speicher hat ${fmtNum(laden, 'kWh')} geladen und ${fmtNum(abgeben, 'kWh')} abgegeben.`;
  }
  if (l) return `der Speicher hat ${fmtNum(laden, 'kWh')} geladen.`;
  if (a) return `der Speicher hat ${fmtNum(abgeben, 'kWh')} abgegeben.`;
  return 'der Speicher stand an diesem Tag still.';
}

/** Der K8-Vergleichsanker: das exakte Paar „mit VoltPilot" gegen „ohne". */
export function ohneSpeicherAnker(
  geld: TagesbildGeld | null | undefined,
  plantKind: PlantKind,
): string | null {
  if (!geld) return null;
  const { baselineEur, actualEur } = geld;
  if (baselineEur == null || actualEur == null) return null;
  if (!Number.isFinite(baselineEur) || !Number.isFinite(actualEur)) return null;
  return proofAnchor(plantKind, baselineEur, actualEur);
}

/**
 * Die Kernaussage des Tagesbilds.
 *
 * `null` = es gibt noch nichts zu sagen (das Geld ist nicht geladen) — der Kopf
 * rendert dann GAR NICHTS. Ein bekanntes, aber nicht berechenbares Geld ergibt
 * den ehrlichen GRUND, nie eine erfundene Zahl.
 */
export function tagesbildKern(input: {
  geld: TagesbildGeld | null | undefined;
  buckets: readonly HistoryBucket[];
  plantKind: PlantKind;
}): Kernaussage | null {
  const { geld, buckets, plantKind } = input;
  if (!geld) return null;
  const satzTeil = speicherTagSatz(buckets);
  const saved = geld.savedEur;
  if (saved == null || !Number.isFinite(saved)) {
    return { wert: null, satz: null, grund: KEIN_GELD_GRUND, ton: 'calm' };
  }
  const zaehlt = Math.abs(saved) >= EUR_TOTBAND;
  return {
    wert: zaehlt ? eurAmount(saved) : null,
    satz: satzTeil
      ? `hat die Steuerung an diesem Tag gebracht — ${satzTeil}`
      : 'hat die Steuerung an diesem Tag gebracht.',
    grund: null,
    ton: zaehlt && saved > 0 ? 'ok' : 'calm',
    anker: zaehlt ? ohneSpeicherAnker(geld, plantKind) : null,
  };
}

/* ---------------------------------------------------------------------------
 * Die Aussage unter dem Bild (`ChartInsight`)
 * ------------------------------------------------------------------------- */

/**
 * Der Satz, der die geteilte Zeitachse ERKLÄRT (K9) — und, wo Panel 3
 * gezeichnet wird, die eine Ehrlichkeit dazu: die Gegenwelt „ohne Speicher"
 * ist für den TAGESVERLAUF nicht gemessen, nur ihr Tagesergebnis ist bekannt
 * (und steht im Kopf).
 */
export function tagesbildAussage(hatErtrag: boolean): string {
  const geteilt =
    'Alle Flächen teilen eine Zeitachse: was senkrecht übereinander liegt, gehört zusammen.';
  if (!hatErtrag) return geteilt;
  return `${geteilt} Die untere Kurve summiert das Geld des Tages auf; wie eine Anlage ohne Speicher im Tagesverlauf dagestanden hätte, ist nicht gemessen — ihr Tagesergebnis steht oben.`;
}
