/**
 * **Die Ereignis-Spur und der Tagesdrilldown** — die reine Wahrheit hinter den
 * zwei letzten Gesten der Historie (Konzept `data/vp-historie-konzept-t4`,
 * Features **F5** Tagesdrilldown und **F6** Ereignis-Marker).
 *
 * Der behobene Befund: das Diagramm ZEIGT den Ausreißer, erklärt ihn aber nie —
 * und wer wissen will, was an dem Tag los war, musste den Zeitraum umstellen und
 * dann blättern (im Tagesmodus bis zu 211 Klicks, F2/K4). Beides sind
 * Anschlussfragen an denselben Balken, deshalb leben sie in einem Modul:
 *
 * - **F6** verwandelt die Server-Ereignisse (`History.events`) in Chips plus die
 *   Balkenspanne, über der das Diagramm sein Band zeichnet.
 * - **F5** sagt, in WELCHEN Tag ein Balken (oder ein Chip) führt. Die Adresse
 *   dazu baut niemand hier: das macht `historieHash`, den Anker liefert
 *   `historieZeit.ts` `ankerAusWert` — dieses Modul entscheidet nur das Datum.
 *
 * Kein React, kein Netz (das `historieZeit.ts`/`fleet.ts`-Muster).
 *
 * **Drei Ehrlichkeitsregeln, die hier Gesetz sind:**
 * 1. **Ohne Spur wird keine Ruhe behauptet.** Fehlt `events` ganz (älteres
 *    Backend), rendert die Seite gar nichts — „keine besonderen Ereignisse"
 *    wäre eine Aussage über eine Prüfung, die nie stattgefunden hat.
 * 2. **Eine unbekannte Art wird übersprungen, nicht geraten.** Ein Marker, den
 *    niemand erklären kann, ist schlimmer als kein Marker.
 * 3. **Was der Zeitraum nicht auswertet, sagt die Spur.** Die §-14a-Netzgrenze
 *    steht nur in der rohen Telemetrie, deshalb wertet der Server sie für Monat
 *    und Jahr nicht aus ({@link spurHinweis}) — sonst läse sich das Fehlen
 *    eines Markers als „keine Netzgrenze".
 */
import type {
  ErzeugerVorgabe,
  ErzeugerVorgabeRohwert,
  History,
  HistoryEvent,
  HistoryRange,
  HistoryVorgabe,
  HistoryVorgaben,
} from './api';
import { isoDate } from './periodNav';
import { monatSchluessel, tagSchluessel } from './verlaufRaster';

/** Die Arten, die diese Oberfläche kennt (der Server darf mehr schicken). */
export type EreignisArt =
  | 'negativpreis'
  /**
   * § 51a EEG (Solarspitzengesetz, Konzept `vp-fahrplan-eigenverbrauch-konzept`
   * §4.7/§9, Scheibe S4): dieselbe negative Börsenpreis-Lage wie `negativpreis`,
   * aber bei dieser Anlage klemmt sie die sonst feste Einspeisevergütung auf
   * null - kein echter negativer Satz. Der Zwilling ist der Server
   * (`HistoryService.einspeiseEreignisSlots`/`Ereignisse.java`).
   */
  | 'keine-verguetung'
  | 'abregelung'
  | 'netzgrenze'
  | 'netzladen'
  | 'abendverkauf'
  | 'datenluecke'
  | 'geraet-still'
  | 'netzbetreiber'
  | 'direktvermarkter'
  | 'nicht-bereit';

/**
 * **Die Vorgaben einer Erzeugeranlage** (UEMS EZ-9, Konzept `vp-erzeuger-wago-konzept` §4.5, EW-12 A): wer die
 * Anlage begrenzt oder gesteuert hat und wann eine Einheit für den Direktvermarkter nicht bereit war. Der Zwilling
 * ist `Ereignisse.VORGABEN_ARTEN` (`services/api/.../history/Ereignisse.java`); beide zusammen ändern.
 */
export const VORGABEN_ARTEN = ['netzbetreiber', 'direktvermarkter', 'nicht-bereit'] as const;
export type VorgabenArt = (typeof VORGABEN_ARTEN)[number];

export function istVorgabenArt(art: EreignisArt): art is VorgabenArt {
  return (VORGABEN_ARTEN as readonly string[]).includes(art);
}

/**
 * **Der Bereich einer Art — und damit ihre Farbe** (Konzept
 * `data/vp-verlauf-ereignisse-k1`, Entscheid „Bereichsfarben" vom 20.10.2026).
 * Vier Farben aus der Rollenpalette statt einer je Art: Markt blau wie die
 * Preislinie, Netz petrol, PV orange, Daten grau schraffiert. Das SYMBOL
 * unterscheidet die Art innerhalb eines Bereichs. Aufgelöst wird der Schlüssel
 * erst beim Zeichnen (`chartTheme()` bzw. die `--vp-c-chart-*`-Tokens), damit
 * dieses Modul rein bleibt.
 */
export type EreignisBereich = 'markt' | 'pv' | 'netz' | 'daten';

export interface EreignisArtInfo {
  /** Das kurze Wort in Chronik, Chips und Kacheln. */
  label: string;
  /**
   * Der Bereich — und damit die Farbe. Das Feld heißt aus Bestandsgründen
   * `farbe`: der stillgelegte `HistoryChart.tsx` liest es und steht unter dem
   * Bytegleich-Schutz von `test/bestandsschutz/diagramme.json`.
   */
  farbe: EreignisBereich;
  /** Der Satz, der die Art erklärt (Erklärung im Kartenkopf). */
  erklaerung: string;
}

/** Kanonische Reihenfolge: erst der Markt, dann die Anlage, zuletzt die Lücken. */
export const ART_ORDER: readonly EreignisArt[] = [
  'negativpreis',
  'keine-verguetung',
  'abregelung',
  'netzgrenze',
  'netzladen',
  'abendverkauf',
  'netzbetreiber',
  'direktvermarkter',
  'nicht-bereit',
  'datenluecke',
  'geraet-still',
];

export const EREIGNIS_ARTEN: Record<EreignisArt, EreignisArtInfo> = {
  negativpreis: {
    label: 'Negative Preise',
    farbe: 'markt',
    erklaerung:
      'Der Börsenpreis lag unter null — eingespeister Strom kostet dann Geld, statt welches zu bringen.',
  },
  'keine-verguetung': {
    label: 'Keine Vergütung',
    farbe: 'markt',
    erklaerung:
      'In diesen Viertelstunden gab es für eingespeisten Strom keine Vergütung (§ 51a EEG).',
  },
  abregelung: {
    label: 'Abregelung',
    farbe: 'pv',
    erklaerung:
      'Die Einspeisung wurde bewusst begrenzt. Geplant aus dem Fahrplan, nicht gemessen.',
  },
  netzgrenze: {
    label: 'Netzgrenze',
    farbe: 'netz',
    erklaerung: 'Ihr Gerät hat eine Begrenzung des Netzbetreibers (§ 14a) gemeldet.',
  },
  netzladen: {
    label: 'Netzladen',
    farbe: 'netz',
    erklaerung:
      'Der Speicher hat mehr geladen, als die Sonne in dieser Zeit lieferte — der Rest kam aus dem Netz.',
  },
  // NEUTRAL, nie grün und nie rot: der Abendverkauf war weder ein Gewinn noch
  // ein Fehler, sondern eine ENTSCHEIDUNG am Markt, die die Fakten erklären.
  // Deshalb der Bereich Markt (das Blau der Preislinie), kein Ertrags- oder
  // Kostenton.
  abendverkauf: {
    label: 'Abendverkauf',
    farbe: 'markt',
    erklaerung:
      'Der Fahrplan hat abends Energie verkauft. Der Text nennt die Menge, den Preis und die Nacht, die darauf folgte.',
  },
  datenluecke: {
    label: 'Datenlücke',
    farbe: 'daten',
    erklaerung: 'In diesem Abschnitt fehlen Messwerte. Eine Lücke ist keine gemessene Null.',
  },
  'geraet-still': {
    label: 'Gerät still',
    farbe: 'daten',
    erklaerung: 'Ab hier kamen keine Messwerte mehr — das Gerät meldet sich nicht.',
  },
  // Die Vorgaben (EZ-9): „Vorgabe“, beim Direktvermarkter „Abruf“ - nie „Eingriff“, das Wort meint im Portal den
  // Handeingriff (§4.1).
  netzbetreiber: {
    label: 'Netzbetreiber',
    farbe: 'netz',
    erklaerung:
      'Der Netzbetreiber hat die Anlage begrenzt oder abgeschaltet. „folgt“ heißt: seine Vorgabe war die wirksame Grenze; „nicht bindend“: eine andere Grenze war strenger. Die Energie ist geschätzt.',
  },
  direktvermarkter: {
    label: 'Direktvermarkter',
    farbe: 'markt',
    erklaerung: 'Der Direktvermarkter hat Leistung abgerufen oder die Anlage gestoppt (Abruf).',
  },
  'nicht-bereit': {
    label: 'nicht bereit',
    farbe: 'daten',
    erklaerung: 'Eine Einheit war für den Direktvermarkter nicht bereit — mit dem Grund, den die Steuerung meldet.',
  },
};

/** Ein Chip der Spur — plus die Balkenspanne, über der das Band liegt. */
export interface EreignisChip {
  /** Stabiler Schlüssel für die Liste. */
  key: string;
  art: EreignisArt;
  info: EreignisArtInfo;
  /** Der Zeitpräfix („15.07." / „11:00–15:00 Uhr"), zeitraumgerecht. */
  zeit: string;
  /** Die Aussage vom Server (ohne Zeitangabe). */
  text: string;
  /** Zeit + Aussage in einem Satz — der Titel des Chips. */
  titel: string;
  /** Erster/letzter Bucket-Index für das Band im Diagramm (−1 = kein Bucket). */
  vonIndex: number;
  bisIndex: number;
  /** Der Tag, in den ein Tipp springt (`YYYY-MM-DD`) — null im Tages-Zeitraum. */
  sprungAt: string | null;
  /** Beginn und (exklusives) Ende — ab der Woche des ganzen Bündels. */
  start: Date;
  ende: Date;
  /** Die eine Zahl des Servers, ungerundet — `null` bei Lücken oder älterem Backend. */
  wert: number | null;
  einheit: 'ct/kWh' | 'kWh' | 'kW' | null;
  /** Aus dem Fahrplan, keine Messung (Abregelung, Abendverkauf). */
  geplant: boolean;
  /** Summe der Fenster in Minuten (ab der Woche nicht der Abstand von Beginn bis Ende). */
  minuten: number;
  /** Zahl der Fenster und der Tage im Bündel (im Tag je 1). */
  anzahl: number;
  tage: number;
  /** Die Fakten des Abendverkaufs; sonst leer. */
  fakten: { label: string; value: string }[];
  /** Die Vorgabe hinter Netzbetreiber, Direktvermarkter und „nicht bereit“ (EZ-9); sonst null. */
  vorgabe: HistoryVorgabe | null;
}

export interface EreignisSpurView {
  chips: EreignisChip[];
  /** Der ruhige Satz, wenn nichts Auffälliges passiert ist — sonst null. */
  leerText: string | null;
  /**
   * Die Zählung der Vorgaben „Nach Art“ (EZ-9) — nur bei einer Anlage mit Anlagensteuerung, sonst null. Ihr Dasein
   * macht aus „Nichts Auffälliges“ ein „Noch keine Vorgaben“.
   */
  vorgaben: HistoryVorgaben | null;
  /** „Noch keine Vorgaben …“, wenn die Anlage Vorgaben kennt, der Zeitraum aber keine hat und andere Ereignisse stehen. */
  vorgabenHinweis: string | null;
  /** Was dieser Zeitraum NICHT auswertet — sonst null. */
  hinweis: string | null;
  /** Die vorkommenden Arten in kanonischer Reihenfolge (die Legende). */
  arten: { art: EreignisArt; info: EreignisArtInfo }[];
}

/**
 * Was der Zeitraum nicht auswertet. **Der Zwilling der Server-Regel**
 * `Ereignisse.evaluatesGridLimit` (`services/api/.../history/Ereignisse.java`):
 * `grid_limit_kw` steht nur in der rohen Telemetrie, die Rollup-Kaskade führt
 * die Spalte nicht — ein Jahresfenster wäre ein Scan über Millionen Rohzeilen.
 * Beide Seiten zusammen ändern.
 */
export function spurHinweis(range: HistoryRange): string | null {
  if (range === 'day' || range === 'week') return null;
  return 'Die Netzgrenze (§ 14a) wird für Tag und Woche ausgewertet, nicht für diesen Zeitraum.';
}

/** Die Kurzform von {@link spurHinweis} als ruhiger Chip in der Karte. */
export const SPUR_HINWEIS_KURZ = '§\u00a014a: nur Tag/Woche';

/** Wie viele Chips ohne Aufklappen sichtbar sind. */
export const CHIPS_SICHTBAR = 4;

function zeit2(n: number): string {
  return String(n).padStart(2, '0');
}

function uhrzeit(d: Date): string {
  return `${zeit2(d.getHours())}:${zeit2(d.getMinutes())}`;
}

function tag(d: Date): string {
  return `${zeit2(d.getDate())}.${zeit2(d.getMonth() + 1)}.`;
}

/**
 * Der Zeitpräfix des Chips. Am Tag sind es Uhrzeiten (dort spielt sich alles
 * ab), ab der Woche Datumsangaben — genau die Auflösung, in der der Kunde in
 * diesem Zeitraum denkt.
 */
export function ereignisZeit(start: Date, end: Date, range: HistoryRange): string {
  if (range === 'day') {
    const von = uhrzeit(start);
    const bis = uhrzeit(end);
    return von === bis ? `${von} Uhr` : `${von}–${bis} Uhr`;
  }
  // `end` ist exklusiv: ein Ereignis, das um 00:00 des Folgetags endet, gehört
  // noch zum Vortag und darf ihn nicht mitzählen.
  const letzter = new Date(end.getTime() - 1);
  const von = tag(start);
  const bis = tag(letzter);
  return von === bis ? von : `${von}–${bis}`;
}

/**
 * Die Balkenspanne, über der das Band liegt.
 *
 * **Zwei Fälle, eine Regel:** ein Ereignis, das Buckets ÜBERDECKT (negative
 * Preise, Abregelung, …), bekommt genau diese; eine DATENLÜCKE hat per
 * Definition keinen einzigen Bucket — auf einer Kategorie-Achse existiert die
 * fehlende Zeit gar nicht — und wird deshalb an der Nahtstelle zwischen dem
 * letzten und dem ersten wieder gemessenen Bucket markiert.
 *
 * Das Band ist **mindestens eine Bucket-Breite** breit: eine Spanne von einem
 * Index auf sich selbst wäre auf der Kategorie-Achse null Pixel breit, also
 * unsichtbar. Der Chip nennt die exakte Zeit, das Band ist die Ortsangabe.
 */
export function bandSpanne(
  starts: number[],
  startMs: number,
  endMs: number,
): [number, number] | null {
  if (starts.length === 0) return null;
  let von = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= startMs) von = i;
    else break;
  }
  if (von < 0) von = 0;
  let bis = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] < endMs) bis = i;
    else break;
  }
  if (bis < von) bis = von;
  const letzter = starts.length - 1;
  if (bis === von) {
    if (bis < letzter) bis += 1;
    else if (von > 0) von -= 1;
  }
  return [von, bis];
}

/**
 * In welchen Tag ein Balken (oder ein Chip) führt — `null` im Tages-Zeitraum,
 * der ist schon die feinste Auflösung. Zurück kommt das Datum, aus dem der
 * Aufrufer mit `ankerAusWert(…, 'day')` seinen Anker und mit `historieHash`
 * seine Adresse baut; hier wird bewusst KEINE Route zusammengesetzt.
 */
export function tagesSprung(bucketStart: string, range: HistoryRange): string | null {
  if (range === 'day') return null;
  const d = new Date(bucketStart);
  if (Number.isNaN(d.getTime())) return null;
  return isoDate(d);
}

/** Der Hinweis auf die Geste — nur, wo es etwas zu öffnen gibt. */
export function drilldownHinweis(range: HistoryRange): string | null {
  if (range === 'day') return null;
  return 'Einen Balken antippen öffnet diesen Tag.';
}

/**
 * Die Spur eines Zeitraums. `null`, wenn das Backend gar keine Ereignisse
 * liefert — dann behauptet die Seite weder Ereignisse noch deren Abwesenheit.
 */
export function ereignisSpur(history: History): EreignisSpurView | null {
  if (!history.events) return null;
  const starts = history.buckets.map((b) => new Date(b.start).getTime());
  const chips: EreignisChip[] = [];
  history.events.forEach((e: HistoryEvent, i) => {
    const info = EREIGNIS_ARTEN[e.type as EreignisArt];
    // Regel 2: unbekannte Art -> überspringen, nie raten.
    if (!info) return;
    const start = new Date(e.start);
    const end = new Date(e.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    const spanne = bandSpanne(starts, start.getTime(), end.getTime());
    const zeit = ereignisZeit(start, end, history.range);
    const art = e.type as EreignisArt;
    chips.push({
      key: `${e.type}-${e.start}-${i}`,
      art,
      info,
      zeit,
      text: e.text,
      titel: `${zeit} · ${e.text}`,
      vonIndex: spanne ? spanne[0] : -1,
      bisIndex: spanne ? spanne[1] : -1,
      sprungAt: tagesSprung(e.start, history.range),
      start,
      ende: end,
      wert: typeof e.value === 'number' && Number.isFinite(e.value) ? e.value : null,
      einheit: e.unit ?? null,
      // Ein älteres Backend kennt das Feld nicht: dann gilt die Art.
      geplant: e.planned ?? (art === 'abregelung' || art === 'abendverkauf'),
      minuten: typeof e.minutes === 'number' ? e.minutes : Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000)),
      anzahl: e.count ?? 1,
      tage: e.days ?? 1,
      fakten: e.facts ?? [],
      vorgabe: e.vorgabe ?? null,
    });
  });
  const vorhanden = ART_ORDER.filter((a) => chips.some((c) => c.art === a));
  const vorgaben = history.vorgaben ?? null;
  const keineVorgaben = vorgaben ? keineVorgabenText(vorgaben) : null;
  const ohneVorgaben = !chips.some((c) => istVorgabenArt(c.art));
  return {
    chips,
    leerText: chips.length === 0 ? (keineVorgaben ?? 'Nichts Auffälliges') : null,
    vorgaben,
    vorgabenHinweis: chips.length > 0 && ohneVorgaben ? keineVorgaben : null,
    hinweis: spurHinweis(history.range),
    arten: vorhanden.map((art) => ({ art, info: EREIGNIS_ARTEN[art] })),
  };
}

/** Ohne Vorgaben im Zeitraum: „noch keine“ — oder, solange der Läufer die Anlage nie ausgewertet hat, genau das. */
function keineVorgabenText(v: HistoryVorgaben): string {
  return v.verarbeitetBis == null
    ? 'Die Vorgaben dieser Anlage werden noch ausgewertet'
    : 'Noch keine Vorgaben in diesem Zeitraum';
}

// ===========================================================================
// Chronik und „Nach Art" (Konzept `data/vp-verlauf-ereignisse-k1`)
// ===========================================================================
//
// Die Karte unter dem Diagramm sagt je Ereignis EIN Wort und EINE Zahl, statt
// Etikett und Servertext doppelt zu sagen. Zwei Ansichten aus denselben Chips:
//
// - **Chronik** — je Tag (Woche, Monat) bzw. Monat (Jahr) ein Datumsblock, je
//   Art darin eine Zeile; im Tag je Ereignis eine Zeile mit Uhrzeit.
// - **Nach Art** — je Art die Anzahl, die eine Zahl über den Zeitraum und ein
//   Streifen, an welchen Tagen/Monaten/Stunden sie vorkam.
//
// Der Server bündelt ab der Woche schon je Tag bzw. Monat; hier wird trotzdem
// noch einmal gebündelt, damit ein älteres Backend (Fenster statt Bündel) zum
// selben Bild führt.

const MINUS = '−';
const NB = ' ';
const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const MONAT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'] as const;
const MONAT_LANG = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
] as const;
const WOCHENTAG_LANG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'] as const;

/** Eine Zahl deutsch mit echtem Minus (AP-08 E11). */
function zahlDe(v: number, stellen: number): string {
  const t = Math.abs(v).toLocaleString('de-DE', {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
  return v < 0 && t.replace(/[0,.]/g, '') !== '' ? `${MINUS}${t}` : t;
}

/** „45 Min", „2 Std", „2 Std 15 Min", „1 Tag 4 Std" — nie „0 Std 45 Min". */
export function dauerText(minuten: number): string {
  const m = Math.max(0, Math.round(minuten));
  if (m >= 1440) {
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const tage = `${d}${NB}${d === 1 ? 'Tag' : 'Tage'}`;
    return h ? `${tage} ${h}${NB}Std` : tage;
  }
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest}${NB}Min`;
  return rest ? `${h}${NB}Std ${rest}${NB}Min` : `${h}${NB}Std`;
}

/**
 * Ein Börsenpreis in ct: eine Stelle, unter 0,1 ct zwei — „−0,04 ct" statt des
 * sinnlosen „-0,0". Was selbst auf zwei Stellen null wäre, heißt „unter 0 ct".
 */
export function centText(ct: number): string {
  if (Math.abs(ct) < 0.005) return `unter 0${NB}ct`;
  return `${zahlDe(ct, Math.abs(ct) < 0.1 ? 2 : 1)}${NB}ct`;
}

/** Energie: eine Stelle, ab 100 kWh ganze Zahlen. */
function kwhText(kwh: number): string {
  return `${zahlDe(kwh, Math.abs(kwh) >= 100 ? 0 : 1)}${NB}kWh`;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Wie die Werte einer Art über mehrere Chips zusammengehen. */
function sammle(art: EreignisArt, chips: readonly EreignisChip[]): number | null {
  const werte = chips.map((c) => c.wert).filter((v): v is number => v != null);
  if (!werte.length) return null;
  if (art === 'negativpreis' || art === 'netzgrenze') return Math.min(...werte);
  return werte.reduce((a, v) => a + v, 0);
}

/**
 * **Die EINE Zahl** einer Art: tiefster Preis, Energie, niedrigste Grenze —
 * und wo es keine gibt (Lücke, älteres Backend), die Dauer.
 */
export function ereignisZahl(
  art: EreignisArt,
  wert: number | null,
  minuten: number,
  start: Date,
  range: HistoryRange,
): string {
  if (art === 'geraet-still') {
    return range === 'year' ? `seit ${tag(start)}` : `seit ${hhmm(start)}`;
  }
  // Netzbetreiber und Direktvermarkter: die geschätzt nicht erzeugte Energie, ohne Grundlage „—“, nie 0.
  if (art === 'netzbetreiber' || art === 'direktvermarkter') return energieText(wert);
  if (art === 'datenluecke' || wert == null) return dauerText(minuten);
  if (art === 'negativpreis') {
    const t = centText(wert);
    return t.startsWith('unter') ? t : `bis ${t}`;
  }
  if (art === 'netzgrenze') return `≤${NB}${zahlDe(wert, 1)}${NB}kW`;
  return kwhText(wert);
}

/** Der Schlüssel, unter dem Chronik, Spur und Hervorhebung dasselbe meinen. */
export function fokusSchluessel(chip: EreignisChip, range: HistoryRange): string {
  if (range === 'day') return chip.key;
  return range === 'year' ? monatSchluessel(chip.start) : tagSchluessel(chip.start);
}

export interface ChronikZeile {
  key: string;
  art: EreignisArt;
  info: EreignisArtInfo;
  /** Das Wort der Zeile, wenn es mehr als die Art sagt: „Netzbetreiber · 60 %“ (EZ-9); sonst das Wort der Art. */
  titel?: string;
  /**
   * Der Teil des Titels nach dem Urheber („60 %“, „Abruf 80,0 kW“, „Motor 2“) — am Telefon steht er vorn in der
   * Unterzeile statt im Titel (Kontoauszug), sonst bräche „Netzbetreiber · 60 %“ mitten im Wort um.
   */
  titelWert?: string | null;
  /** Unter der Zahl: die Euro-Schätzung einer Vorgabe, nur wenn EZ-7 sie liefert. */
  zahlUnter?: string | null;
  /** Die Vorgabe hinter der Zeile (EZ-9) — mit `id` öffnet ein Tipp ihr Detail mit Rohsignalen und Zählerständen. */
  vorgabe?: HistoryVorgabe | null;
  /** Was neben dem Wort steht: Uhrzeit, „2× · 30 Min", „9 Tage" — am Tag die Dauer. */
  meta: string;
  /** Die eine Zahl, fertig formatiert. */
  zahl: string;
  geplant: boolean;
  fakten: { label: string; value: string }[];
  /** Beginn des ersten und Ende des letzten Chips — die Ortsangabe in Diagramm und Spur. */
  start: Date;
  ende: Date;
  /** Der Satz des Servers (bzw. die Sätze) — als Titel für Hover und Vorleser. */
  satz: string;
}

export interface ChronikGruppe {
  /** = {@link fokusSchluessel} aller Zeilen der Gruppe. */
  key: string;
  /** Der Datumsblock: „02"/„Fr", „Mai"/„", am Tag „10:15"/„bis 15:45". */
  gross: string;
  klein: string;
  /** Ausgeschrieben für Vorleser und Tooltip: „Freitag, 02.10.", „Mai 2026", „10:15–15:45 Uhr". */
  label: string;
  /** Wohin ein Tipp führt — im Tag nirgends hin. */
  sprung: { range: 'day' | 'month'; at: string } | null;
  zeilen: ChronikZeile[];
}

/**
 * **Die Chronik:** im Tag je Ereignis eine Gruppe (Uhrzeit links), sonst je
 * Tag bzw. Monat EINE Gruppe mit je Art EINER Zeile — zwei Netzlade-Fenster am
 * 02.10. sind „Netzladen 2× · 30 Min", nicht zwei gleiche Zeilen untereinander.
 */
export function ereignisChronik(spur: EreignisSpurView, range: HistoryRange): ChronikGruppe[] {
  const sortiert = [...spur.chips].sort((a, b) => a.start.getTime() - b.start.getTime());
  if (range === 'day') {
    return sortiert.map((c) => ({
      key: fokusSchluessel(c, range),
      gross: hhmm(c.start),
      klein: c.vorgabe?.laeuft ? 'läuft' : `bis ${hhmm(c.ende)}`,
      label: c.vorgabe?.laeuft ? `ab ${hhmm(c.start)} Uhr, läuft` : `${hhmm(c.start)}–${hhmm(c.ende)} Uhr`,
      sprung: null,
      zeilen: [
        istVorgabenArt(c.art) ? vorgabenZeileTag(c) : {
          key: c.key,
          art: c.art,
          info: c.info,
          meta: dauerText(c.minuten),
          zahl: ereignisZahl(c.art, c.wert, c.minuten, c.start, range),
          geplant: c.geplant,
          fakten: c.fakten,
          start: c.start,
          ende: c.ende,
          satz: c.text,
        },
      ],
    }));
  }
  const gruppen = new Map<string, EreignisChip[]>();
  for (const c of sortiert) {
    const k = fokusSchluessel(c, range);
    const g = gruppen.get(k);
    if (g) g.push(c);
    else gruppen.set(k, [c]);
  }
  return [...gruppen.entries()].map(([key, chips]) => {
    const d = chips[0].start;
    const jahr = range === 'year';
    const zeilen = ART_ORDER.filter((a) => chips.some((c) => c.art === a)).map((art) => {
      const xs = chips.filter((c) => c.art === art);
      if (istVorgabenArt(art)) return vorgabenZeileBuendel(`${key}-${art}`, art, xs, range);
      const anzahl = xs.reduce((n, c) => n + c.anzahl, 0);
      const minuten = xs.reduce((n, c) => n + c.minuten, 0);
      const tage = xs.length === 1 ? xs[0].tage : new Set(xs.map((c) => tagSchluessel(c.start))).size;
      const start = new Date(Math.min(...xs.map((c) => c.start.getTime())));
      const ende = new Date(Math.max(...xs.map((c) => c.ende.getTime())));
      const zahlIstDauer = art === 'datenluecke' || sammle(art, xs) == null;
      let meta: string;
      if (art === 'geraet-still') meta = 'meldet sich nicht';
      else if (jahr && art !== 'datenluecke') meta = `${tage}${NB}${tage === 1 ? 'Tag' : 'Tage'}`;
      else if (anzahl > 1) meta = zahlIstDauer ? `${anzahl}×` : `${anzahl}× · ${dauerText(minuten)}`;
      else meta = `${hhmm(start)}–${hhmm(ende)}`;
      return {
        key: `${key}-${art}`,
        art,
        info: EREIGNIS_ARTEN[art],
        meta,
        zahl: ereignisZahl(art, sammle(art, xs), minuten, start, range),
        geplant: xs.some((c) => c.geplant),
        fakten: xs.length === 1 ? xs[0].fakten : [],
        start,
        ende,
        satz: xs.map((c) => c.text).join(' · '),
      };
    });
    return {
      key,
      gross: jahr ? MONAT[d.getMonth()] : String(d.getDate()).padStart(2, '0'),
      klein: jahr ? '' : WOCHENTAG[d.getDay()],
      label: jahr
        ? `${MONAT_LANG[d.getMonth()]} ${d.getFullYear()}`
        : `${WOCHENTAG_LANG[d.getDay()]}, ${tag(d)}`,
      sprung: jahr
        ? { range: 'month' as const, at: isoDate(new Date(d.getFullYear(), d.getMonth(), 1)) }
        : { range: 'day' as const, at: isoDate(d) },
      zeilen,
    };
  });
}

/** Eine Zelle eines Streifens bzw. der Spur: Tag, Monat, Stunde oder Viertelstunde. */
export interface EreignisZelle {
  start: Date;
  ende: Date;
  /** Liegt in der Zukunft (wird hohl gezeichnet). */
  zukunft?: boolean;
}

/** Die erste und letzte Zelle, die ein Zeitraum [start, ende) berührt — null, wenn keine. */
export function zellenSpanne(
  zellen: readonly EreignisZelle[],
  start: Date,
  ende: Date,
): [number, number] | null {
  const a = start.getTime();
  // Ein Zeitpunkt ohne Dauer berührt die Zelle, in der er liegt.
  const b = Math.max(ende.getTime(), a + 1);
  let von = -1;
  let bis = -1;
  zellen.forEach((z, i) => {
    if (z.start.getTime() < b && z.ende.getTime() > a) {
      if (von < 0) von = i;
      bis = i;
    }
  });
  return von < 0 ? null : [von, bis];
}

/** Die 24 Stunden eines Tages als Zellen — der Streifen von „Nach Art" am Tag. */
export function stundenZellen(anchor: Date, now: Date): EreignisZelle[] {
  return Array.from({ length: 24 }, (_, h) => {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), h);
    const ende = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), h + 1);
    return { start, ende, zukunft: start.getTime() >= now.getTime() };
  });
}

export interface ArtUebersicht {
  art: EreignisArt;
  info: EreignisArtInfo;
  /** Wie oft: Tage (Woche, Monat, Jahr) bzw. Ereignisse (Tag) — die Zahl am Filter-Chip. */
  n: number;
  /** Die große Zahl der Kachel: „6 Tage", am Tag „2×". */
  anzahl: string;
  /** Die eine Zahl über den ganzen Zeitraum. */
  zahl: string;
  /** Was die Vorgaben einer Art darüber hinaus sagen: „4 Stopps“, „1 unvollständig“ (EZ-9); sonst null. */
  zusatz: string | null;
  geplant: boolean;
  /** Je Zelle des Zeitraums: kam die Art dort vor? */
  streifen: { an: boolean; zukunft: boolean }[];
}

/**
 * **„Nach Art"** — je vorkommender Art (kanonische Reihenfolge) die Anzahl,
 * die eine Zahl und der Streifen über die Zellen des Zeitraums (Tage der
 * Woche/des Monats, Monate des Jahres, Stunden des Tages).
 */
export function ereignisArten(
  spur: EreignisSpurView,
  range: HistoryRange,
  zellen: readonly EreignisZelle[],
): ArtUebersicht[] {
  return ART_ORDER.filter((a) => spur.chips.some((c) => c.art === a)).map((art) => {
    const xs = spur.chips.filter((c) => c.art === art);
    const an = new Set<number>();
    for (const c of xs) {
      const sp = zellenSpanne(zellen, c.start, c.ende);
      if (sp) for (let i = sp[0]; i <= sp[1]; i++) an.add(i);
    }
    const streifen = zellen.map((z, i) => ({ an: an.has(i), zukunft: !!z.zukunft && !an.has(i) }));
    const gesamt = istVorgabenArt(art) ? vorgabenGesamt(spur.vorgaben, art) : null;
    if (gesamt) {
      // Die Zählung des Servers (EZ-7) - eine Vorgabe über Mitternacht zählt einmal, die Dauer je Urheber vereinigt.
      const energie = gesamt.energyKwh != null && gesamt.energyKwh > 0 ? ` · ${energieText(gesamt.energyKwh)} nicht erzeugt` : '';
      return {
        art,
        info: EREIGNIS_ARTEN[art],
        n: gesamt.anzahl,
        anzahl: `${gesamt.anzahl}×`,
        zahl: `${dauerText(gesamt.minutes)}${art === 'nicht-bereit' ? '' : energie}`,
        zusatz: vorgabenZusatz(gesamt),
        geplant: false,
        streifen,
      };
    }
    let n: number;
    let einheit: string;
    if (range === 'day') {
      n = xs.reduce((k, c) => k + c.anzahl, 0);
      einheit = '×';
    } else if (range === 'year') {
      n = xs.reduce((k, c) => k + c.tage, 0);
      einheit = n === 1 ? 'Tag' : 'Tage';
    } else {
      n = new Set(xs.map((c) => tagSchluessel(c.start))).size;
      einheit = n === 1 ? 'Tag' : 'Tage';
    }
    const minuten = xs.reduce((k, c) => k + c.minuten, 0);
    const erster = xs.reduce((a, c) => (c.start < a ? c.start : a), xs[0].start);
    return {
      art,
      info: EREIGNIS_ARTEN[art],
      n,
      anzahl: einheit === '×' ? `${n}×` : `${n}${NB}${einheit}`,
      // Ohne Datumsblock daneben nennt „Gerät still“ den Tag, nicht nur die Uhrzeit.
      zahl: ereignisZahl(art, sammle(art, xs), minuten, erster, range === 'day' ? 'day' : 'year'),
      zusatz: null,
      geplant: xs.some((c) => c.geplant),
      streifen,
    };
  });
}

// ===========================================================================
// Vorgaben einer Erzeugeranlage (UEMS EZ-9, Konzept `vp-erzeuger-wago-konzept` §4.5, EW-12 A)
// ===========================================================================
//
// Die Zeilen sagen Urheber und Vorgabe („Netzbetreiber · 60 %“, beim Direktvermarkter „Abruf 80,0 kW“), ob die
// Anlage folgte, und die geschätzt nicht erzeugte Energie; die Euro-Schätzung nur, wenn EZ-7 sie liefert. Gezählt
// hat der Server — hier wird nur gesprochen.

const EURO = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Geschätzt nicht erzeugte Energie: „≈ 25,3 kWh“, eine bekannte Null „0 kWh“, unbekannt „—“. */
export function energieText(kwh: number | null): string {
  if (kwh == null) return '—';
  if (kwh === 0) return `0${NB}kWh`;
  return `≈${NB}${kwhText(kwh)}`;
}

/** Die Euro-Schätzung: „≈ 3,10 €“ — nur wenn sie bekannt ist. */
export function euroText(eur: number | null | undefined): string | null {
  if (eur == null) return null;
  const t = EURO.format(Math.abs(eur));
  return `≈${NB}${eur < 0 ? MINUS : ''}${t}${NB}€`;
}

function kwText(w: number): string {
  return `${zahlDe(w / 1000, 1)}${NB}kW`;
}

/** Das Wort der Zeile: Urheber und Vorgabe. */
export function vorgabeTitel(art: VorgabenArt, v: HistoryVorgabe | null): string {
  const wert = vorgabeWert(art, v);
  return wert ? `${EREIGNIS_ARTEN[art].label} · ${wert}` : EREIGNIS_ARTEN[art].label;
}

/** Die Vorgabe selbst: „60 %“, „Abruf 80,0 kW“, „Stopp“, bei „nicht bereit“ die Einheit — oder null. */
function vorgabeWert(art: VorgabenArt, v: HistoryVorgabe | null): string | null {
  if (!v || v.luecken > 0 || v.id == null) return null;
  if (art === 'nicht-bereit') return v.einheitName ?? `Einheit ${v.teNr ?? '?'}`;
  if (art === 'direktvermarkter') {
    if (v.art === 'dv_stopp') return 'Stopp';
    return v.vorgabeW != null ? `Abruf ${kwText(v.vorgabeW)}` : 'Abruf';
  }
  if (v.art === 'abschaltung') return 'Abschaltung';
  if (v.art === 'q_vorgabe') return `cos${NB}φ`;
  if (v.vorgabeProzent != null) return `${zahlDe(v.vorgabeProzent, 0)}${NB}%`;
  return v.vorgabeW != null ? `≤${NB}${kwText(v.vorgabeW)}` : null;
}

/** „3 weitere Wechsel während einer Datenlücke“ — unbekannt nach einem Neustart, nie 0. */
export function weitereWechselText(n: number | null, luecken = 1): string {
  const wo = luecken === 1 ? 'während einer Datenlücke' : 'während Datenlücken';
  if (n == null) return `weitere Wechsel ${wo} (Zahl unbekannt)`;
  return `${n} ${n === 1 ? 'weiterer Wechsel' : 'weitere Wechsel'} ${wo}`;
}

/** Folgte die Anlage? `bindend` = die Vorgabe war die wirksame Grenze. */
function folgtText(bindung: HistoryVorgabe['bindung']): string | null {
  if (bindung === 'bindend') return 'folgt ✓';
  if (bindung === 'nicht_bindend') return 'nicht bindend';
  return null;
}

function datumZeit(d: Date, bezug: Date): string {
  const jahr = d.getFullYear() !== bezug.getFullYear() ? String(d.getFullYear()) : '';
  return `${tag(d)}${jahr} ${hhmm(d)}`;
}

/** Eine Vorgabe (oder Datenlücke mit weiteren Wechseln) am Tag als Chronik-Zeile. */
function vorgabenZeileTag(c: EreignisChip): ChronikZeile {
  const art = c.art as VorgabenArt;
  const v = c.vorgabe;
  const meta: string[] = [];
  let zahl: string;
  if (v && v.luecken > 0) {
    meta.push(weitereWechselText(v.weitereWechsel));
    zahl = dauerText(c.minuten);
  } else {
    const beginn = v?.beginn ? new Date(v.beginn) : null;
    // Begann sie vor dem Tag, nennt die Zeile ihren wirklichen Beginn - der Block links zeigt nur den Tag.
    if (beginn && beginn.getTime() < c.start.getTime()) meta.push(`seit ${datumZeit(beginn, c.start)}`);
    // „nicht bereit“ trägt seine Dauer als Zahl rechts; sonst steht sie hier.
    else if (art !== 'nicht-bereit') meta.push(dauerText(c.minuten));
    if (art === 'nicht-bereit') {
      meta.push(v?.gruende.length ? v.gruende.join(', ') : 'ohne gemeldeten Grund');
      zahl = dauerText(c.minuten);
    } else {
      const folgt = folgtText(v?.bindung ?? null);
      if (folgt) meta.push(folgt);
      zahl = energieText(c.wert);
    }
    if (v?.unvollstaendig) meta.push('unvollständig');
  }
  return {
    key: c.key,
    art,
    info: c.info,
    titel: vorgabeTitel(art, v),
    titelWert: vorgabeWert(art, v),
    meta: meta.join(' · '),
    zahl,
    zahlUnter: art === 'nicht-bereit' ? null : euroText(v?.wertEur),
    vorgabe: v,
    geplant: false,
    fakten: [],
    start: c.start,
    ende: c.ende,
    satz: c.text,
  };
}

/** Die Vorgaben einer Art an einem Tag (Woche, Monat) bzw. in einem Monat (Jahr) als eine Zeile. */
function vorgabenZeileBuendel(key: string, art: VorgabenArt, xs: readonly EreignisChip[], range: HistoryRange): ChronikZeile {
  const anzahl = xs.reduce((n, c) => n + c.anzahl, 0);
  const minuten = xs.reduce((n, c) => n + c.minuten, 0);
  const start = new Date(Math.min(...xs.map((c) => c.start.getTime())));
  const ende = new Date(Math.max(...xs.map((c) => c.ende.getTime())));
  const luecken = xs.reduce((n, c) => n + (c.vorgabe?.luecken ?? 0), 0);
  const unvollstaendig = xs.reduce((n, c) => n + (c.vorgabe?.unvollstaendig ?? 0), 0);
  const weitere = xs.some((c) => (c.vorgabe?.luecken ?? 0) > 0 && c.vorgabe?.weitereWechsel == null)
    ? null
    : xs.reduce((n, c) => n + (c.vorgabe?.weitereWechsel ?? 0), 0);
  const euros = xs.map((c) => c.vorgabe?.wertEur).filter((v): v is number => v != null);
  const meta: string[] = [];
  if (anzahl > 0) meta.push(anzahl === 1 && range !== 'year' ? `${hhmm(start)}–${hhmm(ende)}` : `${anzahl}× · ${dauerText(minuten)}`);
  if (unvollstaendig > 0) meta.push(`${unvollstaendig} unvollständig`);
  if (luecken > 0) meta.push(weitereWechselText(weitere, luecken));
  return {
    key,
    art,
    info: EREIGNIS_ARTEN[art],
    titel: EREIGNIS_ARTEN[art].label,
    meta: meta.join(' · '),
    zahl: art === 'nicht-bereit' || anzahl === 0 ? dauerText(minuten) : energieText(sammle(art, xs)),
    zahlUnter: art === 'nicht-bereit' || euros.length === 0 ? null : euroText(euros.reduce((a, v) => a + v, 0)),
    vorgabe: null,
    geplant: false,
    fakten: [],
    start,
    ende,
    satz: xs.map((c) => c.text).join(' · '),
  };
}

/** Die Zählung einer Art über den ganzen Zeitraum (ganze Anlage bzw. alle Einheiten) — oder null. */
function vorgabenGesamt(v: HistoryVorgaben | null, art: VorgabenArt) {
  return v?.zaehlung.find((z) => z.periode == null && z.type === art && z.teNr == null) ?? null;
}

const ART_WORT: Record<string, [string, string]> = {
  abschaltung: ['Abschaltung', 'Abschaltungen'],
  q_vorgabe: ['cos φ-Vorgabe', 'cos φ-Vorgaben'],
  dv_stopp: ['Stopp', 'Stopps'],
};

/** „1 Abschaltung“, „4 Stopps“, „2 unvollständig“, „3 weitere Wechsel während Datenlücken“. */
function vorgabenZusatz(z: NonNullable<ReturnType<typeof vorgabenGesamt>>): string | null {
  const teile: string[] = [];
  for (const [art, [eins, viele]] of Object.entries(ART_WORT)) {
    const n = z.arten[art] ?? 0;
    if (n > 0) teile.push(`${n} ${n === 1 ? eins : viele}`);
  }
  if (z.unvollstaendig > 0) teile.push(`${z.unvollstaendig} unvollständig`);
  if (z.luecken > 0) teile.push(weitereWechselText(z.weitereWechsel, z.luecken));
  return teile.length ? teile.join(' · ') : null;
}

export interface VorgabenTeil {
  key: string;
  /** „Motor 1“ bzw. „März 2026“. */
  label: string;
  /** Je Art: „Direktvermarkter 2× · 3 Std“. */
  zeilen: { art: VorgabenArt; text: string }[];
}

/**
 * **„Nach Art“ im Einzelnen:** je Einheit (aufklappbar) und im Jahr je Monat — Anzahl und Dauer je Urheber, aus der
 * Zählung des Servers.
 */
export function vorgabenTeile(spur: EreignisSpurView): { einheiten: VorgabenTeil[]; monate: VorgabenTeil[] } {
  const z = spur.vorgaben?.zaehlung ?? [];
  const text = (x: (typeof z)[number]) => `${EREIGNIS_ARTEN[x.type].label} ${x.anzahl}× · ${dauerText(x.minutes)}`;
  const einheiten = new Map<number, VorgabenTeil>();
  for (const x of z) {
    if (x.periode != null || x.teNr == null) continue;
    const teil = einheiten.get(x.teNr) ?? { key: `te-${x.teNr}`, label: x.einheitName ?? `Einheit ${x.teNr}`, zeilen: [] };
    teil.zeilen.push({ art: x.type, text: text(x) });
    einheiten.set(x.teNr, teil);
  }
  const monate = new Map<string, VorgabenTeil>();
  for (const x of z) {
    if (x.periode == null) continue;
    const [jahr, monat] = x.periode.split('-').map(Number);
    const teil = monate.get(x.periode) ?? { key: x.periode, label: `${MONAT_LANG[monat - 1]} ${jahr}`, zeilen: [] };
    teil.zeilen.push({ art: x.type, text: text(x) });
    monate.set(x.periode, teil);
  }
  return {
    einheiten: [...einheiten.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t),
    monate: [...monate.values()],
  };
}

/** Die Kanäle der Vorgaben in Worten — der Zwilling ist `VorgabenCsv.KANAL` (EZ-7). */
export const KANAL_TEXT: Record<string, string> = {
  keiner: 'keiner',
  feste_grenze: 'feste Grenze',
  stufen: 'Stufen',
  fernwirktechnik: 'Fernwirktechnik',
  relais_ma: 'Relais und mA',
  modbus: 'Modbus',
};

const METHODE_TEXT: Record<NonNullable<ErzeugerVorgabe['methode']>, string> = {
  pv_prognose: 'aus der PV-Prognose',
  nennleistung_bereite_motoren: 'aus der Nennleistung der bereiten Motoren',
  dv_sollwert_davor: 'aus dem Sollwert des Direktvermarkters davor',
};

function zeitpunkt(iso: string): string {
  const d = new Date(iso);
  return `${tag(d)} ${hhmm(d)}`;
}

/**
 * **Das Detail einer Vorgabe** als Fakten-Zeilen (EZ-9): was EZ-7 an ihr belegt — Beginn und Ende (genau über „seit“
 * oder auf die Lesung), Vorgabe, Ist und verfügbar im Mittel, die Schätzung mit ihrer Grundlage, ob die Anlage folgte,
 * Kanal und Zählerstände. Unbekanntes steht als „—“, nie als 0.
 */
export function vorgabeFakten(v: ErzeugerVorgabe): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  out.push({ label: 'Beginn', value: `${zeitpunkt(v.beginn)}${v.beginn_genau ? '' : ' (erste Lesung)'}` });
  out.push({
    label: 'Ende',
    value: v.ende
      ? `${zeitpunkt(v.ende)}${v.ende_genau ? '' : ' (letzte Lesung)'}`
      : `läuft, zuletzt gesehen ${zeitpunkt(v.gesehen_bis)}`,
  });
  out.push({ label: 'Dauer', value: dauerText(v.dauer_s / 60) });
  const vorgabe = [
    v.vorgabe_prozent != null ? `${zahlDe(v.vorgabe_prozent, 0)}${NB}%` : null,
    v.vorgabe_w != null ? (v.urheber === 'direktvermarkter' ? `Abruf ${kwText(v.vorgabe_w)}` : kwText(v.vorgabe_w)) : null,
  ].filter(Boolean);
  if (vorgabe.length) out.push({ label: 'Vorgabe', value: vorgabe.join(' · ') });
  out.push({ label: 'Ist im Mittel', value: v.ist_mittel_w == null ? '—' : kwText(v.ist_mittel_w) });
  out.push({ label: 'Verfügbar im Mittel', value: v.verfuegbar_mittel_w == null ? '—' : kwText(v.verfuegbar_mittel_w) });
  if (v.art !== 'nicht_bereit' && v.art !== 'q_vorgabe') {
    out.push({
      label: 'Geschätzt nicht erzeugt',
      value: `${energieText(v.energie_kwh)}${v.energie_kwh != null && v.methode ? ` (${METHODE_TEXT[v.methode]})` : ''}`,
    });
    out.push({ label: 'Euro (Schätzung)', value: euroText(v.wert_eur) ?? '—' });
  }
  if (v.bindung === 'bindend') out.push({ label: 'Anlage folgte', value: 'ja, sie war die wirksame Grenze' });
  if (v.bindung === 'nicht_bindend') out.push({ label: 'Anlage folgte', value: 'nicht bindend, eine andere Grenze war strenger' });
  if (v.kanal) out.push({ label: 'Kanal', value: KANAL_TEXT[v.kanal] ?? v.kanal });
  if (v.zaehler_beginn != null || v.zaehler_ende != null) {
    out.push({ label: 'Zählerstand', value: `${v.zaehler_beginn ?? '—'} → ${v.zaehler_ende ?? '—'}` });
  }
  if (v.neustart) out.push({ label: 'Neustart', value: 'die Steuerung startete in dieser Vorgabe neu' });
  if (v.unvollstaendig) out.push({ label: 'Unvollständig', value: 'in dieser Vorgabe fehlen Lesungen' });
  return out;
}

/** Ein Rohwert in der Sprache des Bilds: die gesetzten Bits, das Wort eines Zustands, sonst die Zahl. */
export function rohwertText(w: ErzeugerVorgabeRohwert): string {
  if (w.bits) return `${w.bits.length ? w.bits.map((b) => b.text).join(', ') : 'kein Bit gesetzt'} (${w.wert})`;
  if (w.text || w.wort) return `${w.text ?? w.wort} (${w.wert})`;
  return zahlDe(w.wert, Number.isInteger(w.wert) ? 0 : 1);
}
