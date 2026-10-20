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
import type { History, HistoryEvent, HistoryRange } from './api';
import { isoDate } from './periodNav';
import { monatSchluessel, tagSchluessel } from './verlaufRaster';

/** Die Arten, die diese Oberfläche kennt (der Server darf mehr schicken). */
export type EreignisArt =
  | 'negativpreis'
  | 'abregelung'
  | 'netzgrenze'
  | 'netzladen'
  | 'abendverkauf'
  | 'datenluecke'
  | 'geraet-still';

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
  'abregelung',
  'netzgrenze',
  'netzladen',
  'abendverkauf',
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
}

export interface EreignisSpurView {
  chips: EreignisChip[];
  /** Der ruhige Satz, wenn nichts Auffälliges passiert ist — sonst null. */
  leerText: string | null;
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
    });
  });
  const vorhanden = ART_ORDER.filter((a) => chips.some((c) => c.art === a));
  return {
    chips,
    leerText: chips.length === 0 ? 'Nichts Auffälliges' : null,
    hinweis: spurHinweis(history.range),
    arten: vorhanden.map((art) => ({ art, info: EREIGNIS_ARTEN[art] })),
  };
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
      klein: `bis ${hhmm(c.ende)}`,
      label: `${hhmm(c.start)}–${hhmm(c.ende)} Uhr`,
      sprung: null,
      zeilen: [
        {
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
      geplant: xs.some((c) => c.geplant),
      streifen: zellen.map((z, i) => ({ an: an.has(i), zukunft: !!z.zukunft && !an.has(i) })),
    };
  });
}
