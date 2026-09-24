/**
 * Das ZEITRASTER der Verlauf-Diagramme (Konzept „Verlauf-Rework", Leitlinie
 * „Lücken bleiben leer").
 *
 * Die Antworten von `GET …/history` und `GET …/earnings` liefern nur Eimer,
 * die es gibt. Ein Diagramm, das nur diese Eimer auf eine Kategorie-Achse
 * legt, lässt eine Messlücke verschwinden: der 27. fehlt dann einfach auf der
 * Achse, und die Linie verbindet den 26. mit dem 28. Dieses Modul legt
 * deshalb das VOLLE Raster des Zeitraums an und sagt für jede Zelle, warum
 * sie leer ist:
 *
 * - `ok`: es gibt Werte,
 * - `luecke`: die Zeit ist vorbei, es kam aber nichts an (fehlend ist keine Null),
 * - `zukunft`: die Zeit liegt nach „jetzt",
 * - `vorher`: die Zeit liegt vor der ersten je gemessenen Viertelstunde.
 *
 * Rein und framework-frei; Datumsgrenzen folgen der Browser-Uhr wie
 * `periodNav.ts` (die API rechnet in Europe/Berlin, das Portal zeigt lokal).
 */
import type { HistoryBucket, HistoryRange, SiteEarningsBucket } from './api';

export type RasterZustand = 'ok' | 'luecke' | 'zukunft' | 'vorher';

/** Eine Zelle des feinen Rasters (Viertelstunde bzw. Stunde). */
export interface RasterSlot<T> {
  start: Date;
  zustand: RasterZustand;
  wert: T | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Das feine Raster einer Antwort mit festen Eimern (Tag: 15 min, Woche: 60 min):
 * von `from` bis `to` in `bucketMinutes`-Schritten, jeder Eimer an seinem
 * Platz. Sommerzeit-Tage bekommen dadurch von selbst 92 bzw. 100 Zellen.
 */
export function feinesRaster<T extends { start: string }>(opts: {
  from: string;
  to: string;
  bucketMinutes: number;
  buckets: readonly T[];
  now: Date;
  firstDataAt?: string | null;
}): RasterSlot<T>[] {
  const from = ms(opts.from);
  const to = ms(opts.to);
  const step = opts.bucketMinutes * 60_000;
  if (from == null || to == null || !(step > 0) || to <= from) return [];
  const byStart = new Map<number, T>();
  for (const b of opts.buckets) {
    const t = ms(b.start);
    if (t != null) byStart.set(t, b);
  }
  const now = opts.now.getTime();
  const first = ms(opts.firstDataAt);
  const out: RasterSlot<T>[] = [];
  // Obergrenze gegen fehlerhafte Antworten: mehr als ein Jahr Viertelstunden
  // zeichnet keine Verlaufsseite.
  const max = Math.min(Math.round((to - from) / step), 40_000);
  for (let i = 0; i < max; i++) {
    const t = from + i * step;
    const wert = byStart.get(t) ?? null;
    const zustand: RasterZustand = wert
      ? 'ok'
      : t >= now
        ? 'zukunft'
        : first != null && t + step <= first
          ? 'vorher'
          : 'luecke';
    out.push({ start: new Date(t), zustand, wert });
  }
  return out;
}

// --- Kalenderzellen (Tage, Monate) -------------------------------------------

/** Lokaler Tagesschlüssel `JJJJ-MM-TT`. */
export function tagSchluessel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Lokaler Monatsschlüssel `JJJJ-MM`. */
export function monatSchluessel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export interface Kalenderzelle {
  /** `JJJJ-MM-TT` bzw. `JJJJ-MM`. */
  schluessel: string;
  /** Beginn der Zelle (lokale Mitternacht). */
  start: Date;
  /** Ende der Zelle (exklusiv). */
  ende: Date;
  art: 'tag' | 'monat';
}

/**
 * Die Kalenderzellen eines Zeitraums: Woche und Monat in Tagen, Jahr in
 * Monaten. Der Tag selbst hat keine Kalenderzellen (er nutzt das feine Raster).
 */
export function kalenderzellen(anchor: Date, range: Exclude<HistoryRange, 'day'>): Kalenderzelle[] {
  if (range === 'year') {
    return Array.from({ length: 12 }, (_, m) => {
      const start = new Date(anchor.getFullYear(), m, 1);
      return { schluessel: monatSchluessel(start), start, ende: new Date(anchor.getFullYear(), m + 1, 1), art: 'monat' as const };
    });
  }
  let first: Date;
  let n: number;
  if (range === 'week') {
    first = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - ((anchor.getDay() + 6) % 7));
    n = 7;
  } else {
    first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    n = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  }
  return Array.from({ length: n }, (_, i) => {
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    return { schluessel: tagSchluessel(start), start, ende: new Date(first.getFullYear(), first.getMonth(), first.getDate() + i + 1), art: 'tag' as const };
  });
}

/** Zustand einer Kalenderzelle: läuft sie noch, liegt sie vor den Daten, in der Zukunft? */
export type ZellenZustand = 'ok' | 'laeuft' | 'luecke' | 'zukunft' | 'vorher';

export function zellenZustand(zelle: Kalenderzelle, hatWerte: boolean, now: Date, firstDataAt?: string | null): ZellenZustand {
  const t0 = zelle.start.getTime();
  const t1 = zelle.ende.getTime();
  const jetzt = now.getTime();
  if (t0 >= jetzt) return 'zukunft';
  const first = ms(firstDataAt);
  if (!hatWerte && first != null && t1 <= first) return 'vorher';
  // Die laufende Zelle ist keine Lücke, auch wenn noch nichts angekommen ist.
  if (jetzt < t1) return 'laeuft';
  return hatWerte ? 'ok' : 'luecke';
}

// --- Energie je Kalenderzelle ------------------------------------------------

export interface EnergieZelle extends Kalenderzelle {
  zustand: ZellenZustand;
  pvKwh: number | null;
  loadKwh: number | null;
  importKwh: number | null;
  exportKwh: number | null;
  ladenKwh: number | null;
  entladenKwh: number | null;
}

const add = (a: number | null, v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? (a ?? 0) + v : a;

/**
 * Die Energiemengen je Tag bzw. Monat — aus den Eimern der Antwort summiert
 * (Regel aus `energieBilanz.ts`: eine Summe ist `null`, wenn KEIN Eimer den
 * Kanal trug, nie eine erfundene 0).
 */
export function energieZellen(
  buckets: readonly HistoryBucket[],
  anchor: Date,
  range: Exclude<HistoryRange, 'day'>,
  now: Date,
  firstDataAt?: string | null,
): EnergieZelle[] {
  const zellen = kalenderzellen(anchor, range);
  const key = range === 'year' ? monatSchluessel : tagSchluessel;
  const sums = new Map<string, Omit<EnergieZelle, keyof Kalenderzelle | 'zustand'>>();
  for (const b of buckets) {
    const t = ms(b.start);
    if (t == null) continue;
    const k = key(new Date(t));
    const s = sums.get(k) ?? { pvKwh: null, loadKwh: null, importKwh: null, exportKwh: null, ladenKwh: null, entladenKwh: null };
    s.pvKwh = add(s.pvKwh, b.pvKwh);
    s.loadKwh = add(s.loadKwh, b.loadKwh);
    s.importKwh = add(s.importKwh, b.gridImportKwh);
    s.exportKwh = add(s.exportKwh, b.gridExportKwh);
    s.ladenKwh = add(s.ladenKwh, b.batteryChargeKwh);
    s.entladenKwh = add(s.entladenKwh, b.batteryDischargeKwh);
    sums.set(k, s);
  }
  return zellen.map((z) => {
    const s = sums.get(z.schluessel);
    const hat = !!s && Object.values(s).some((v) => v != null);
    return {
      ...z,
      zustand: zellenZustand(z, hat, now, firstDataAt),
      pvKwh: s?.pvKwh ?? null,
      loadKwh: s?.loadKwh ?? null,
      importKwh: s?.importKwh ?? null,
      exportKwh: s?.exportKwh ?? null,
      ladenKwh: s?.ladenKwh ?? null,
      entladenKwh: s?.entladenKwh ?? null,
    };
  });
}

// --- Geld je Zelle --------------------------------------------------------------

export interface GeldZelle {
  schluessel: string;
  start: Date;
  zustand: ZellenZustand;
  einspeiseEur: number | null;
  eigenverbrauchEur: number | null;
  stromkostenEur: number | null;
  nettoEur: number | null;
}

/**
 * Das Raster der Erlöse: Tag in Stunden, Woche und Monat in Tagen, Jahr in
 * Monaten — jede Zelle mit dem Eimer der Serie, der in sie fällt.
 */
export function geldZellen(
  series: readonly SiteEarningsBucket[],
  anchor: Date,
  range: HistoryRange,
  now: Date,
  firstDataAt?: string | null,
): GeldZelle[] {
  let zellen: { schluessel: string; start: Date; ende: Date }[];
  let key: (d: Date) => string;
  if (range === 'day') {
    const d0 = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    zellen = Array.from({ length: 24 }, (_, h) => {
      const start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), h);
      return { schluessel: `${tagSchluessel(start)}T${String(h).padStart(2, '0')}`, start, ende: new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), h + 1) };
    });
    key = (d) => `${tagSchluessel(d)}T${String(d.getHours()).padStart(2, '0')}`;
  } else {
    zellen = kalenderzellen(anchor, range);
    key = range === 'year' ? monatSchluessel : tagSchluessel;
  }
  const map = new Map<string, SiteEarningsBucket>();
  for (const b of series) {
    const t = ms(b.start);
    if (t != null) map.set(key(new Date(t)), b);
  }
  return zellen.map((z) => {
    const b = map.get(z.schluessel) ?? null;
    const hat = !!b && [b.einspeiseErloesEur, b.eigenverbrauchsWertEur, b.stromkostenEur, b.nettoEur].some((v) => v != null);
    return {
      schluessel: z.schluessel,
      start: z.start,
      zustand: zellenZustand({ ...z, art: 'tag' }, hat, now, firstDataAt),
      einspeiseEur: b?.einspeiseErloesEur ?? null,
      eigenverbrauchEur: b?.eigenverbrauchsWertEur ?? null,
      stromkostenEur: b?.stromkostenEur ?? null,
      nettoEur: b?.nettoEur ?? null,
    };
  });
}

/** Hat die Zelle Werte, die ein Diagramm zeichnen darf? */
export function zeichenbar(z: { zustand: ZellenZustand | RasterZustand }): boolean {
  return z.zustand === 'ok' || z.zustand === 'laeuft';
}

// --- Beschriftung je Zelle -------------------------------------------------------

const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONAT_KURZ = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONAT_LANG = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const p2 = (n: number) => String(n).padStart(2, '0');

/** Wie fein eine Zelle ist — entscheidet über ihre Beschriftung. */
export type ZellenArt = 'viertelstunde' | 'stunde' | 'tag' | 'monat';

/** Die Zellenart eines Zeitraums: Tag in Stunden (Geld) bzw. Viertelstunden (Energie). */
export function zellenArtFuer(range: HistoryRange, fein: 'viertelstunde' | 'stunde' = 'stunde'): ZellenArt {
  if (range === 'day') return fein;
  return range === 'year' ? 'monat' : 'tag';
}

/**
 * Achsen- und Tooltip-Beschriftung einer Zelle: „13" / „Mi., 09.09. · 13–14 Uhr",
 * „Mo 7." / „Mo., 07.09.2026", „Sep" / „September 2026".
 */
export function zellenBeschriftung(
  start: Date,
  art: ZellenArt,
  range: HistoryRange,
): { achse: string; titel: string } {
  const tag = `${WT[start.getDay()]}., ${p2(start.getDate())}.${p2(start.getMonth() + 1)}.`;
  if (art === 'viertelstunde') {
    const hm = `${p2(start.getHours())}:${p2(start.getMinutes())}`;
    return { achse: hm, titel: `${tag} · ${hm} Uhr` };
  }
  if (art === 'stunde') {
    const h = start.getHours();
    return { achse: p2(h), titel: `${tag} · ${h}–${h + 1} Uhr` };
  }
  if (art === 'monat') {
    return {
      achse: MONAT_KURZ[start.getMonth()],
      titel: `${MONAT_LANG[start.getMonth()]} ${start.getFullYear()}`,
    };
  }
  return {
    achse: range === 'week' ? `${WT[start.getDay()]} ${start.getDate()}.` : String(start.getDate()),
    titel: `${tag}${start.getFullYear()}`,
  };
}
