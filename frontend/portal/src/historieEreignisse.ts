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

/** Die Arten, die diese Oberfläche kennt (der Server darf mehr schicken). */
export type EreignisArt =
  | 'negativpreis'
  | 'abregelung'
  | 'netzgrenze'
  | 'netzladen'
  | 'datenluecke'
  | 'geraet-still';

/**
 * Der Farbschlüssel des Chips/Bandes — aufgelöst wird er erst beim Zeichnen
 * über `chartTheme()`, damit dieses Modul rein bleibt (dieselbe Trennung wie
 * `EnergieFarbe` in `energieBilanz.ts`).
 */
export type EreignisFarbe = 'discharge' | 'pv' | 'flowGrid' | 'gridCharge' | 'cloud';

export interface EreignisArtInfo {
  /** Das kurze Wort in der Legende. */
  label: string;
  farbe: EreignisFarbe;
  /** Der Satz, der die Art erklärt (Titel der Legende). */
  erklaerung: string;
}

/** Kanonische Reihenfolge: erst der Markt, dann die Anlage, zuletzt die Lücken. */
export const ART_ORDER: readonly EreignisArt[] = [
  'negativpreis',
  'abregelung',
  'netzgrenze',
  'netzladen',
  'datenluecke',
  'geraet-still',
];

export const EREIGNIS_ARTEN: Record<EreignisArt, EreignisArtInfo> = {
  negativpreis: {
    label: 'Negative Preise',
    farbe: 'discharge',
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
    farbe: 'flowGrid',
    erklaerung: 'Ihr Gerät hat eine Begrenzung des Netzbetreibers (§ 14a) gemeldet.',
  },
  netzladen: {
    label: 'Netzladen',
    farbe: 'gridCharge',
    erklaerung:
      'Der Speicher hat mehr geladen, als die Sonne in dieser Zeit lieferte — der Rest kam aus dem Netz.',
  },
  datenluecke: {
    label: 'Datenlücke',
    farbe: 'cloud',
    erklaerung: 'In diesem Abschnitt fehlen Messwerte. Eine Lücke ist keine gemessene Null.',
  },
  'geraet-still': {
    label: 'Gerät still',
    farbe: 'cloud',
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
    chips.push({
      key: `${e.type}-${e.start}-${i}`,
      art: e.type as EreignisArt,
      info,
      zeit,
      text: e.text,
      titel: `${zeit} · ${e.text}`,
      vonIndex: spanne ? spanne[0] : -1,
      bisIndex: spanne ? spanne[1] : -1,
      sprungAt: tagesSprung(e.start, history.range),
    });
  });
  const vorhanden = ART_ORDER.filter((a) => chips.some((c) => c.art === a));
  return {
    chips,
    leerText: chips.length === 0 ? 'Keine besonderen Ereignisse in diesem Zeitraum.' : null,
    hinweis: spurHinweis(history.range),
    arten: vorhanden.map((art) => ({ art, info: EREIGNIS_ARTEN[art] })),
  };
}
