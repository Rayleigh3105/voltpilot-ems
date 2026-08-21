/**
 * Die REGELN des Datums-Pickers - Kalendergitter, deutsche Formate, Grenzen.
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab.
 *
 * ⚠ ALLE Werte reisen als ISO-Zeichenketten (`JJJJ-MM-TT`, `JJJJ-MM`,
 * `JJJJ-Www`) - byte-gleich mit dem, was die nativen Felder lieferten, die der
 * Picker ablöst. Das ist die Zusage „keine Verhaltensänderung der Formulare":
 * jeder Aufrufer, jede Validierung und jeder Server sehen weiterhin dasselbe.
 *
 * ⚠ Gerechnet wird in LOKALER Kalenderzeit, nie über `Date.parse` einer nackten
 * ISO-Zeichenkette (die liest der Browser als UTC und schiebt sie je nach Zone
 * über eine Tagesgrenze). Ein Datum entsteht deshalb immer über
 * `new Date(jahr, monat, tag)`.
 */

/** Die Wochentage ab MONTAG - die deutsche Woche beginnt am Montag. */
export const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;

export const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
] as const;

/** Was der Picker auswählt. */
export type DatumsArt = 'tag' | 'woche' | 'monat';

function zwei(n: number): string {
  return String(n).padStart(2, '0');
}

/** `JJJJ-MM-TT` eines Datums in LOKALER Kalenderzeit. */
export function isoTag(d: Date): string {
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
}

/** `JJJJ-MM` eines Datums. */
export function isoMonat(d: Date): string {
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}`;
}

/**
 * Die ISO-8601-Kalenderwoche als `JJJJ-Www`.
 *
 * ⚠ Das JAHR der Kalenderwoche ist nicht immer das Kalenderjahr: der
 * 1. Januar kann zur letzten Woche des Vorjahres gehören (und der 31. Dezember
 * zur ersten des Folgejahres). Gerechnet wird deshalb über den DONNERSTAG der
 * Woche - er liegt per ISO-Definition immer im richtigen Jahr.
 */
export function isoWoche(d: Date): string {
  const do_ = donnerstagDerWoche(d);
  const jahresbeginn = new Date(do_.getFullYear(), 0, 1);
  const tage = Math.round((do_.getTime() - jahresbeginn.getTime()) / 86_400_000);
  const kw = Math.floor(tage / 7) + 1;
  return `${do_.getFullYear()}-W${zwei(kw)}`;
}

/** Die Kalenderwochen-NUMMER (für die Spalte links im Gitter). */
export function kwNummer(d: Date): number {
  return Number(isoWoche(d).slice(-2));
}

function donnerstagDerWoche(d: Date): Date {
  const mo = montagDerWoche(d);
  return new Date(mo.getFullYear(), mo.getMonth(), mo.getDate() + 3);
}

/** Der Montag der Woche, in der `d` liegt. */
export function montagDerWoche(d: Date): Date {
  // getDay(): 0 = Sonntag … 6 = Samstag. Montag-basiert: 0 = Montag.
  const versatz = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - versatz);
}

/**
 * Der Wert eines Datums für die gewählte Art - genau das Format, das das
 * abgelöste native Feld geliefert hat.
 */
export function wertVon(d: Date, art: DatumsArt): string {
  if (art === 'monat') return isoMonat(d);
  if (art === 'woche') return isoWoche(d);
  return isoTag(d);
}

/**
 * Ein Wert zurück in ein Datum - oder `null`, wenn er unbrauchbar ist.
 *
 * ⚠ Der Anker ist bewusst 12 Uhr MITTAGS (dieselbe Konvention wie
 * `historieZeit.ankerAusWert`): so kann keine Sommerzeit-Umstellung ihn über
 * eine Tagesgrenze kippen.
 */
export function datumVon(wert: string, art: DatumsArt): Date | null {
  const v = (wert ?? '').trim();
  if (v === '') return null;
  if (art === 'tag') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d;
  }
  if (art === 'monat') {
    const m = /^(\d{4})-(\d{2})$/.exec(v);
    if (!m) return null;
    const mon = Number(m[2]);
    if (mon < 1 || mon > 12) return null;
    return new Date(Number(m[1]), mon - 1, 1, 12);
  }
  const m = /^(\d{4})-W(\d{1,2})$/.exec(v);
  if (!m) return null;
  const jahr = Number(m[1]);
  const kw = Number(m[2]);
  if (kw < 1 || kw > 53) return null;
  // Der 4. Januar liegt per ISO-Definition immer in Kalenderwoche 1.
  const vierter = new Date(jahr, 0, 4, 12);
  const mo = montagDerWoche(vierter);
  const ziel = new Date(mo.getFullYear(), mo.getMonth(), mo.getDate() + (kw - 1) * 7, 12);
  // Eine 53. Woche gibt es nicht in jedem Jahr - dann ist der Wert unbrauchbar.
  return isoWoche(ziel) === `${jahr}-W${zwei(kw)}` ? ziel : null;
}

/** Ein Tag im Gitter. */
export interface GitterTag {
  /** `JJJJ-MM-TT`. */
  iso: string;
  /** Die Tageszahl (1-31). */
  tag: number;
  /** Gehört der Tag zum angezeigten Monat? (Sonst ist er ein Randtag.) */
  imMonat: boolean;
}

/** Eine Zeile des Gitters: die Kalenderwoche und ihre sieben Tage. */
export interface GitterWoche {
  /** `JJJJ-Www` - der Wert, den die Wochen-Auswahl liefert. */
  woche: string;
  /** Die Nummer für die Spalte links. */
  kw: number;
  tage: GitterTag[];
}

/**
 * Das Kalendergitter eines Monats: SECHS Zeilen à sieben Tage, MONTAG zuerst.
 *
 * ⚠ Immer sechs Zeilen, auch wenn fünf reichen würden - sonst springt das
 * Panel beim Blättern in der Höhe, und der Klickpunkt unter dem Zeiger wandert
 * weg. Die Randtage sind echte, wählbare Tage (sie tragen `imMonat: false` und
 * werden nur blasser gezeichnet), genau wie im nativen Kalender.
 */
export function monatsGitter(jahr: number, monat0: number): GitterWoche[] {
  const erster = new Date(jahr, monat0, 1, 12);
  const start = montagDerWoche(erster);
  const wochen: GitterWoche[] = [];
  for (let w = 0; w < 6; w += 1) {
    const tage: GitterTag[] = [];
    for (let t = 0; t < 7; t += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + t, 12);
      tage.push({ iso: isoTag(d), tag: d.getDate(), imMonat: d.getMonth() === monat0 });
    }
    const mo = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7, 12);
    wochen.push({ woche: isoWoche(mo), kw: kwNummer(mo), tage });
  }
  return wochen;
}

/** Die Monatsüberschrift des Panels („August 2026"). */
export function monatsTitel(jahr: number, monat0: number): string {
  return `${MONATE[monat0]} ${jahr}`;
}

/**
 * Der ANGEZEIGTE Wert im Auslöser - deutsch, nie ISO.
 *
 * Ein Kunde liest „21.08.2026", nicht „2026-08-21"; die ISO-Form bleibt der
 * WERT und verlässt das Formular unverändert.
 */
export function anzeige(wert: string, art: DatumsArt): string | null {
  const d = datumVon(wert, art);
  if (!d) return null;
  if (art === 'monat') return `${MONATE[d.getMonth()]} ${d.getFullYear()}`;
  if (art === 'woche') {
    const mo = montagDerWoche(d);
    const so = new Date(mo.getFullYear(), mo.getMonth(), mo.getDate() + 6, 12);
    return `KW ${kwNummer(d)} · ${zwei(mo.getDate())}.${zwei(mo.getMonth() + 1)}.`
      + `–${zwei(so.getDate())}.${zwei(so.getMonth() + 1)}.${so.getFullYear()}`;
  }
  return `${zwei(d.getDate())}.${zwei(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Ist der Wert innerhalb der Grenzen? Verglichen wird auf der GLEICHEN Art wie
 * die Grenze notiert ist - ISO-Zeichenketten derselben Form sind
 * lexikografisch sortierbar, das ist die ganze Arithmetik.
 */
export function imBereich(wert: string, min?: string | null, max?: string | null): boolean {
  if (min && wert < min) return false;
  if (max && wert > max) return false;
  return true;
}

/**
 * Ist ein TAG wählbar, wenn die Grenzen als Tages-ISO notiert sind?
 * Für Woche/Monat wird der Wert der jeweiligen Art verglichen.
 */
export function tagWaehlbar(
  iso: string,
  art: DatumsArt,
  min?: string | null,
  max?: string | null,
): boolean {
  const d = datumVon(iso, 'tag');
  if (!d) return false;
  return imBereich(wertVon(d, art), min, max);
}

/** Der Monat davor/danach als `[jahr, monat0]`. */
export function blaettern(jahr: number, monat0: number, schritt: number): [number, number] {
  const d = new Date(jahr, monat0 + schritt, 1, 12);
  return [d.getFullYear(), d.getMonth()];
}

/**
 * Bewegung im Gitter mit den Pfeiltasten: ±1 Tag, ±7 Tage, Monatssprung.
 * Liefert das neue ISO-Datum - der Aufrufer blättert das Panel, wenn es den
 * Monat verlässt.
 */
export function verschiebe(iso: string, tage: number, monate = 0): string {
  const d = datumVon(iso, 'tag');
  if (!d) return iso;
  const ziel = new Date(d.getFullYear(), d.getMonth() + monate, d.getDate() + tage, 12);
  // Ein Monatssprung vom 31. in einen kürzeren Monat läuft sonst über: der
  // 31. März minus einen Monat wäre der 3. März. Auf den letzten Tag klemmen.
  if (monate !== 0 && ziel.getDate() !== d.getDate()) {
    return isoTag(new Date(ziel.getFullYear(), ziel.getMonth(), 0, 12));
  }
  return isoTag(ziel);
}
