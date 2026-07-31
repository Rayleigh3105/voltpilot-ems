/**
 * **In der Vergangenheit navigieren** — die reine Wahrheit hinter der
 * Zeit-Leiste beider Historie-Welten (Konzept `data/vp-historie-konzept-t4`,
 * Features **F2** Zeitraum-Sprung und **F4** Datenabdeckung).
 *
 * Der behobene Befund (K4/K5): es gab genau EINE Geste in die Vergangenheit —
 * den ‹-Knopf, ein Zeitraum pro Klick. Vom 30.07. in den Januar waren das 7
 * Klicks im Monatsmodus und **211** im Tagesmodus. Und die Seite verschwieg
 * ihre Datenlage: ein „Jahr", das sechs Wochen Balken zeigt, ohne es zu sagen,
 * macht jede Zahl darunter unglaubwürdig.
 *
 * Kein React, kein Netz (das `fleet.ts`/`schedule.ts`-Muster) — die
 * Zeit-Leiste rendert nur, was hier entschieden wird.
 *
 * **Zwei Ehrlichkeitsregeln, die hier Gesetz sind:**
 * 1. **Der Sprung wird begrenzt, wo wir es WISSEN** — nie in die Zukunft, und
 *    nie vor die erste gemessene Viertelstunde. Ohne Abdeckungsdaten wird
 *    nichts begrenzt (kein geratenes Fenster).
 * 2. **Die Abdeckung rundet nie auf 100 % auf.** 99,6 % gemessen heißt „99 %";
 *    „durchgehend gemessen" sagt die Seite nur, wenn wirklich keine
 *    Viertelstunde fehlt.
 */
import type { HistoryCoverage, HistoryRange } from './api';
import { isoDate, isoWeek } from './periodNav';
import type { StripSlot } from './anlage';
import type { VergleichsModus } from './historieVergleich';

// --- F2: der Zeitraum-Sprung -------------------------------------------------

/** Welches native Eingabefeld zum Zeitraum passt. */
export type SprungFeld = 'date' | 'week' | 'month' | 'year';

/**
 * Das native Feld je Zeitraum. Tag/Monat/Woche bekommen das jeweilige
 * HTML-Feld (der Browser bringt seinen Kalender mit — kein selbstgebauter
 * Datumswähler, der am Telefon schlechter wäre als der des Systems); das Jahr
 * bekommt eine Auswahlliste, weil es dafür kein natives Feld gibt.
 */
export function sprungFeld(range: HistoryRange): SprungFeld {
  if (range === 'day') return 'date';
  if (range === 'week') return 'week';
  if (range === 'month') return 'month';
  return 'year';
}

/** Das Beschriftungswort des Sprungfelds (Aria-Label + Titel). */
export function sprungLabel(range: HistoryRange): string {
  switch (range) {
    case 'day':
      return 'Tag wählen';
    case 'week':
      return 'Woche wählen';
    case 'month':
      return 'Monat wählen';
    default:
      return 'Jahr wählen';
  }
}

/** `YYYY-MM` eines Datums (lokale Kalenderzeit wie `isoDate`). */
export function isoMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-Www` eines Datums — das Format des nativen `week`-Felds. */
export function isoWeekValue(d: Date): string {
  // Das Jahr des `week`-Werts ist das ISO-WOCHENJAHR, nicht das Kalenderjahr:
  // der 31.12.2026 liegt in KW 53 von 2026, der 01.01.2027 aber ebenfalls — ein
  // naives `getFullYear()` erzeugte dort einen Wert, den kein Browser annimmt.
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 4 - ((t.getDay() + 6) % 7 + 1));
  return `${t.getFullYear()}-W${String(isoWeek(d)).padStart(2, '0')}`;
}

/** Der Wert, den das Sprungfeld beim aktuellen Anker zeigt. */
export function sprungWert(anchor: Date, range: HistoryRange): string {
  switch (range) {
    case 'day':
      return isoDate(anchor);
    case 'week':
      return isoWeekValue(anchor);
    case 'month':
      return isoMonth(anchor);
    default:
      return String(anchor.getFullYear());
  }
}

/**
 * Der neue Anker aus einem Feldwert — oder `null`, wenn der Wert unbrauchbar
 * ist (leeres Feld, halb getippte Eingabe). Der Aufrufer springt dann nicht,
 * statt auf ein erfundenes Datum zu springen.
 *
 * Der Anker ist bewusst **12 Uhr mittags**: so kann keine Zeitzonen- oder
 * Sommerzeit-Verschiebung ihn über eine Tagesgrenze kippen (dieselbe
 * Konvention, mit der die Welten ihren `at=`-Parameter lesen).
 */
export function ankerAusWert(value: string, range: HistoryRange): Date | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (range === 'day') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (range === 'month') {
    if (!/^\d{4}-\d{2}$/.test(v)) return null;
    const d = new Date(`${v}-01T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (range === 'year') {
    if (!/^\d{4}$/.test(v)) return null;
    const d = new Date(Number(v), 0, 1, 12);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Woche: `YYYY-Www` -> der Montag dieser ISO-Woche.
  const m = /^(\d{4})-W(\d{1,2})$/.exec(v);
  if (!m) return null;
  const jahr = Number(m[1]);
  const woche = Number(m[2]);
  if (woche < 1 || woche > 53) return null;
  // Der 4. Januar liegt per Definition in KW 1; von seinem Montag aus zählen.
  const jan4 = new Date(jahr, 0, 4, 12);
  const montagKw1 = new Date(jan4);
  montagKw1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const d = new Date(montagKw1);
  d.setDate(montagKw1.getDate() + (woche - 1) * 7);
  return d;
}

/** Die Grenzen des Sprungfelds — nur, wo wir sie WISSEN. */
export interface SprungGrenzen {
  /** `min`-Attribut (Format wie {@link sprungWert}), sonst undefined. */
  min?: string;
  /** `max`-Attribut, sonst undefined. */
  max?: string;
}

/**
 * Nie in die Zukunft, und nie vor die erste gemessene Viertelstunde: beides
 * sind Zeiträume, in denen es nichts zu sehen gibt. Ohne Abdeckungsdaten wird
 * nur die Zukunft begrenzt — ein geratenes Startdatum wäre eine Behauptung.
 */
export function sprungGrenzen(
  range: HistoryRange,
  now: Date,
  coverage?: HistoryCoverage | null,
): SprungGrenzen {
  const grenzen: SprungGrenzen = { max: sprungWert(now, range) };
  const ab = coverage?.firstDataAt ? new Date(coverage.firstDataAt) : null;
  if (ab && !Number.isNaN(ab.getTime())) grenzen.min = sprungWert(ab, range);
  return grenzen;
}

/**
 * Die Jahre der Auswahlliste (neuestes zuerst): vom laufenden Jahr zurück bis
 * zum ersten Datenjahr. Ohne Abdeckungsdaten bleiben es {@link JAHRE_OHNE_DATEN}
 * Jahre, damit die Liste nie leer ist; ein per Lesezeichen geöffnetes Jahr
 * außerhalb der Liste wird immer mit aufgenommen (nie eine Sackgasse).
 */
export const JAHRE_OHNE_DATEN = 3;
export const JAHRE_MAX = 12;

export function sprungJahre(
  anchor: Date,
  now: Date,
  coverage?: HistoryCoverage | null,
): number[] {
  const bis = now.getFullYear();
  const ab = coverage?.firstDataAt ? new Date(coverage.firstDataAt) : null;
  const ersteszahr =
    ab && !Number.isNaN(ab.getTime()) ? ab.getFullYear() : bis - (JAHRE_OHNE_DATEN - 1);
  const von = Math.max(Math.min(ersteszahr, anchor.getFullYear()), bis - (JAHRE_MAX - 1));
  const jahre: number[] = [];
  for (let j = bis; j >= von; j--) jahre.push(j);
  if (!jahre.includes(anchor.getFullYear())) jahre.push(anchor.getFullYear());
  return jahre.sort((a, b) => b - a);
}

// --- F2: der Monatsstreifen als Sprungbrett ---------------------------------

/** Wie viele Monate der Streifen zeigt (wie in der Geld-Ansicht). */
export const STREIFEN_MONATE = 12;

const MONATE_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/**
 * Die Monats-Chips der Zeit-Leiste — derselbe `MonthStrip`-Baustein wie in der
 * Geld-Ansicht, hier aber als reiner **Navigator**: die Historie kennt keine
 * Monatswerte, ohne zwölf weitere Abrufe zu bezahlen, also trägt der Chip
 * bewusst KEINE Zahl statt einer erfundenen.
 *
 * Was er dafür trägt, ist die Datenlage: ein Monat, der vollständig vor der
 * ersten oder nach der letzten Messung liegt, ist als datenlos markiert
 * (`hasData: false`) — die Oberfläche graut ihn aus, statt den Kunden in eine
 * leere Fläche springen zu lassen. Ohne Abdeckungsdaten bleibt `hasData`
 * unbekannt (undefined) und nichts wird ausgegraut.
 */
export function streifenSlots(
  now: Date,
  coverage?: HistoryCoverage | null,
  count = STREIFEN_MONATE,
): StripSlot[] {
  const jetztKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ab = coverage?.firstDataAt ? new Date(coverage.firstDataAt) : null;
  const bis = coverage?.lastDataAt ? new Date(coverage.lastDataAt) : null;
  const abKey = ab && !Number.isNaN(ab.getTime()) ? isoMonth(ab) : null;
  const bisKey = bis && !Number.isNaN(bis.getTime()) ? isoMonth(bis) : null;

  const slots: StripSlot[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1, 12);
    const key = isoMonth(d);
    slots.push({
      month: `${key}-01`,
      label: MONATE_KURZ[d.getMonth()],
      value: null,
      isCurrent: key === jetztKey,
      hasData: abKey == null ? undefined : key >= abKey && (bisKey == null || key <= bisKey),
    });
  }
  return slots;
}

/**
 * Wohin ein Tipp auf einen Monats-Chip führt. Im Monatsmodus ist das der Monat
 * selbst; im Tagesmodus der erste Tag dieses Monats — außer beim laufenden
 * Monat, wo „heute" die nützlichere Antwort ist als „der 1.".
 */
export function streifenAnker(monthIso: string, range: HistoryRange, now: Date): Date | null {
  const anker = ankerAusWert(monthIso.slice(0, 7), 'month');
  if (!anker) return null;
  if (range !== 'day') return anker;
  const gleicherMonat =
    anker.getFullYear() === now.getFullYear() && anker.getMonth() === now.getMonth();
  return gleicherMonat ? new Date(now) : anker;
}

/** In welchen Zeiträumen der Streifen etwas nützt (Tag: 211 Klicks, Monat: 7). */
export function zeigtStreifen(range: HistoryRange): boolean {
  return range === 'day' || range === 'month';
}

// --- F4: die Datenabdeckung --------------------------------------------------

/** Was die Zeit-Leiste über die Datenlage sagt. */
export interface AbdeckungView {
  /** „Daten ab 19.06.2026" — null, wenn wir das nicht wissen. */
  abText: string | null;
  /** Füllstand des Balkens in Prozent (0..100), null = kein Balken. */
  balkenPct: number | null;
  /** Der Satz rechts vom Balken („94 % der Viertelstunden gemessen"). */
  satz: string | null;
  /** „· 6 Lücken" — null, wenn keine. */
  luecken: string | null;
  /** Der ausführliche Titel (Tooltip) mit den echten Zählern. */
  titel: string;
}

function datum(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Der Prozentsatz der Abdeckung — **rundet nie auf 100 % auf**. Erst wenn
 * wirklich keine Viertelstunde fehlt, steht dort 100; 99,6 % bleibt 99.
 */
export function abdeckungPct(measured: number, expected: number): number | null {
  if (!(expected > 0)) return null;
  if (measured >= expected) return 100;
  return Math.max(0, Math.min(99, Math.floor((measured / expected) * 100)));
}

/**
 * Die Datenlage in einem Satz. `null`, wenn es nichts Ehrliches zu sagen gibt
 * (kein Abdeckungsfeld vom Backend, oder die Anlage hat noch nie gemessen) —
 * dann zeigt die Zeit-Leiste gar keine Abdeckung, statt eine zu behaupten.
 */
export function abdeckungView(coverage?: HistoryCoverage | null): AbdeckungView | null {
  if (!coverage) return null;
  const abText = coverage.firstDataAt ? `Daten ab ${datum(coverage.firstDataAt)}` : null;
  const pct = abdeckungPct(coverage.measuredBuckets, coverage.expectedBuckets);
  if (pct == null) {
    // Ein Zeitraum, der noch gar nicht laufen konnte: die Herkunftsangabe ist
    // trotzdem nützlich, ein Balken wäre sinnlos.
    if (!abText) return null;
    return { abText, balkenPct: null, satz: null, luecken: null, titel: abText };
  }
  const einheit = coverage.resolutionMinutes === 15 ? 'Viertelstunden' : 'Messabschnitte';
  const satz = pct === 100 ? 'durchgehend gemessen' : `${pct} % der ${einheit} gemessen`;
  const luecken =
    coverage.gaps > 0 ? `${coverage.gaps} ${coverage.gaps === 1 ? 'Lücke' : 'Lücken'}` : null;
  const titel =
    `${coverage.measuredBuckets.toLocaleString('de-DE')} von ` +
    `${coverage.expectedBuckets.toLocaleString('de-DE')} ${einheit} dieses Zeitraums sind gemessen` +
    (luecken ? `, verteilt auf ${luecken}` : '') +
    (abText ? `. ${abText}.` : '.');
  return { abText, balkenPct: pct, satz, luecken, titel };
}

// --- F8: der Vergleichs-Zustand reist in der Adresse -------------------------

/**
 * Der Vergleichs-Modus (F8) im Hash — `v=vorperiode|vorjahr`, weggelassen für
 * „Aus". Bewusst hier statt im Link-Bauer der Welten: er ist ein Zustand der
 * ZEIT-Leiste, genau wie Zeitraum und Anker, und beide Welten teilen ihn sich
 * damit über denselben Parameter (der Welt-Wechsel nimmt ihn mit).
 */
export const VERGLEICH_PARAM = 'v';

function queryTeil(hashOrQuery: string): string {
  const q = hashOrQuery.indexOf('?');
  return q >= 0 ? hashOrQuery.slice(q + 1) : '';
}

/** Der Modus aus einer Adresse — unbekannte/fehlende Werte sind „Aus". */
export function parseVergleichModus(hashOrQuery: string): VergleichsModus {
  const v = new URLSearchParams(queryTeil(hashOrQuery)).get(VERGLEICH_PARAM);
  return v === 'vorperiode' || v === 'vorjahr' ? v : 'aus';
}

/**
 * Denselben Link mit Vergleichs-Modus — hängt sich an das bestehende
 * `?z=…&at=…`-Vokabular an, statt ein zweites zu erfinden. „Aus" schreibt
 * nichts, damit ein Link ohne Vergleich zeichengleich zu vorher bleibt.
 */
export function mitVergleich(hash: string, modus: VergleichsModus): string {
  if (modus === 'aus') return hash;
  return `${hash}${hash.includes('?') ? '&' : '?'}${VERGLEICH_PARAM}=${modus}`;
}
