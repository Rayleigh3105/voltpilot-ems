/**
 * Die ABLEITUNGEN der Energie-Seite (Konzept „Verlauf-Rework", Paket P3,
 * Entscheid E4 = A) aus EINER Antwort (`GET /sites/{id}/history`).
 *
 * - **Kennzahlen:** die sechs Energiemengen des Zeitraums (dieselben Summen
 *   wie `energieBilanz.energieSummen`), jede mit ehrlichem Vergleich: ein
 *   laufender Tag bis zur gleichen Stunde, eine laufende Woche/Monat/Jahr nur
 *   mit der Menge der ganzen Vergleichsperiode, ein abgeschlossener Zeitraum
 *   mit Prozent und Richtung.
 * - **Tag:** drei Felder über EINER Zeitachse (Erzeugung/Verbrauch, Netz,
 *   Ladestand; auf Wunsch der Börsenpreis) — nie zwei Skalen in einem Feld.
 * - **Woche/Monat/Jahr:** die gespiegelte Bilanz je Tag bzw. Monat — oben
 *   woher die Energie kam, unten wohin sie ging.
 * - **Quoten, Spitzen, Tabelle, CSV.**
 *
 * Fehlend ist keine Null: jede Menge ist `null`, wenn kein Messwert sie trug.
 * Rein und framework-frei; Datumsgrenzen folgen der Browser-Uhr wie
 * `periodNav.ts`.
 */
import type { History, HistoryBucket, HistoryRange } from './api';
import { energieSummen, isCurrentPeriod, type EnergieSummeKey } from './energieBilanz';
import { delta, ENERGIE_WERTUNG, vergleichsName, type VergleichsModus } from './historieVergleich';
import { vollerVergleichsName } from './vergleichLaufend';
import { fmtNum, NBSP } from './format';
import { mengeText } from './erloeseSeite';
import { quoteSatz, quoteUnplausibel, quoteZahl } from './quoteUnplausibel';
import {
  energieZellen,
  feinesRaster,
  tagSchluessel,
  zeichenbar,
  zellenArtFuer,
  zellenBeschriftung,
  zellenZustand,
  type EnergieZelle,
  type RasterZustand,
  type ZellenZustand,
} from './verlaufRaster';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Die Rolle einer Reihe — sie wählt die Farbe aus der Zuordnungstabelle. */
export type EnergieRolle = 'pv' | 'load' | 'grid' | 'batt';

// ---------------------------------------------------------------------------
// Kennzahlen
// ---------------------------------------------------------------------------

export const ENERGIE_KENNZAHLEN: ReadonlyArray<{
  key: EnergieSummeKey;
  label: string;
  rolle: EnergieRolle;
}> = [
  { key: 'erzeugt', label: 'Erzeugung', rolle: 'pv' },
  { key: 'verbraucht', label: 'Verbrauch', rolle: 'load' },
  { key: 'bezogen', label: 'Netzbezug', rolle: 'grid' },
  { key: 'eingespeist', label: 'Einspeisung', rolle: 'grid' },
  { key: 'geladen', label: 'Speicher geladen', rolle: 'batt' },
  { key: 'entladen', label: 'Speicher entladen', rolle: 'batt' },
];

const FELD: Record<EnergieSummeKey, keyof HistoryBucket> = {
  erzeugt: 'pvKwh',
  verbraucht: 'loadKwh',
  bezogen: 'gridImportKwh',
  eingespeist: 'gridExportKwh',
  geladen: 'batteryChargeKwh',
  entladen: 'batteryDischargeKwh',
};

export interface EnergieKennzahl {
  key: EnergieSummeKey;
  label: string;
  rolle: EnergieRolle;
  wert: string;
  ton: 'leer' | null;
  unter: string | null;
  pfeil: '↑' | '↓' | null;
  info: { titel: string; text: string };
}

/** Summe eines Kanals über die Eimer, die vor `bisMs` beginnen — `null` ohne Wert. */
function summeBis(buckets: readonly HistoryBucket[], feld: keyof HistoryBucket, bis: (t: Date) => boolean) {
  let s = 0;
  let hat = false;
  for (const b of buckets) {
    const t = new Date(b.start);
    if (Number.isNaN(t.getTime()) || !bis(t)) continue;
    const v = num(b[feld]);
    if (v == null) continue;
    s += v;
    hat = true;
  }
  return hat ? s : null;
}

const PFEIL = (r: string | undefined): '↑' | '↓' | null => (r === 'mehr' ? '↑' : r === 'weniger' ? '↓' : null);

export function energieKennzahlen(input: {
  history: History | null;
  vorher: History | null;
  anchor: Date;
  range: HistoryRange;
  now: Date;
  modus: VergleichsModus;
}): EnergieKennzahl[] {
  const { history, vorher, anchor, range, now, modus } = input;
  const summen = energieSummen(history?.buckets ?? []);
  const vorherSummen = vorher ? energieSummen(vorher.buckets) : null;
  const laeuft = isCurrentPeriod(anchor, range, now);
  const stunde = now.getHours();

  return ENERGIE_KENNZAHLEN.map((k) => {
    const s = summen.find((x) => x.key === k.key);
    const kwh = s?.kwh ?? null;
    let unter: string | null = null;
    let pfeil: '↑' | '↓' | null = null;
    const vorherKwh = vorherSummen?.find((x) => x.key === k.key)?.kwh ?? null;

    if (history && vorher && kwh != null) {
      if (!laeuft) {
        const d = delta(kwh, vorherKwh, ENERGIE_WERTUNG[k.key], vergleichsName(anchor, range, modus));
        if (d) {
          unter = d.text;
          pfeil = PFEIL(d.richtung);
        }
      } else if (range === 'day' && stunde > 0) {
        // Gleiche Stunde gegen gleiche Stunde — die laufende bleibt bei beiden draußen.
        const heute = summeBis(history.buckets, FELD[k.key], (t) => t.getHours() < stunde);
        const gestern = summeBis(vorher.buckets, FELD[k.key], (t) => t.getHours() < stunde);
        const d = delta(heute, gestern, null, 'dem Vortag');
        if (d) {
          unter =
            d.richtung === 'gleich'
              ? `etwa wie gestern bis ${stunde} Uhr`
              : `${d.pct} % ${d.richtung} als gestern bis ${stunde} Uhr`;
          pfeil = PFEIL(d.richtung);
        }
      } else if (range !== 'day' && vorherKwh != null) {
        unter = `${vollerVergleichsName(anchor, range, modus)}: ${mengeText(vorherKwh)}`;
      }
    }

    return {
      key: k.key,
      label: k.label,
      rolle: k.rolle,
      wert: mengeText(kwh) ?? '—',
      ton: kwh == null ? 'leer' : null,
      unter,
      pfeil,
      info: { titel: k.label, text: s?.hinweis ?? '' },
    };
  });
}

// ---------------------------------------------------------------------------
// Tag: drei Felder über einer Zeitachse
// ---------------------------------------------------------------------------

export interface TagesBand {
  von: number;
  bis: number;
  art: 'luecke' | 'vorher' | 'negativpreis';
}

export interface EnergieTag {
  achse: string[];
  titel: string[];
  zustand: RasterZustand[];
  /** Leistung in kW (Mittel des Messabschnitts). */
  pv: (number | null)[];
  load: (number | null)[];
  /** Netz: + Bezug, − Einspeisung. */
  netz: (number | null)[];
  /** Speicher: + Laden, − Entladen. */
  speicher: (number | null)[];
  soc: (number | null)[];
  /** Börsenpreis in ct/kWh. */
  preis: (number | null)[];
  hatSoc: boolean;
  hatPreis: boolean;
  /** Index der laufenden Viertelstunde — `null`, wenn der Tag nicht heute ist. */
  jetzt: number | null;
  baender: TagesBand[];
  leer: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function tagesGrenzen(anchor: Date): { from: string; to: string } {
  const d0 = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const d1 = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1);
  return { from: d0.toISOString(), to: d1.toISOString() };
}

export function energieTag(history: History, anchor: Date, now: Date): EnergieTag {
  const { from, to } = tagesGrenzen(anchor);
  const minuten = history.bucketMinutes > 0 ? history.bucketMinutes : 15;
  const raster = feinesRaster({
    from,
    to,
    bucketMinutes: minuten,
    buckets: history.buckets,
    now,
    firstDataAt: history.coverage?.firstDataAt ?? null,
  });
  const faktor = 60 / minuten;
  const kw = (v: number | null | undefined) => (num(v) == null ? null : r2((v as number) * faktor));
  const diff = (a: unknown, b: unknown) => {
    const x = num(a);
    const y = num(b);
    if (x == null && y == null) return null;
    return r2(((x ?? 0) - (y ?? 0)) * faktor);
  };
  const pv = raster.map((s) => (s.wert ? kw(s.wert.pvKwh) : null));
  const load = raster.map((s) => (s.wert ? kw(s.wert.loadKwh) : null));
  const netz = raster.map((s) => (s.wert ? diff(s.wert.gridImportKwh, s.wert.gridExportKwh) : null));
  const speicher = raster.map((s) =>
    s.wert ? diff(s.wert.batteryChargeKwh, s.wert.batteryDischargeKwh) : null,
  );
  const soc = raster.map((s) => (s.wert ? num(s.wert.socLastPct) : null));
  const preis = raster.map((s) => {
    const p = s.wert ? num(s.wert.priceEurMwh) : null;
    return p == null ? null : r2(p / 10);
  });

  const texte = raster.map((s) => zellenBeschriftung(s.start, 'viertelstunde', 'day'));
  const nowMs = now.getTime();
  const jetztIdx = raster.findIndex((s) => s.start.getTime() <= nowMs && nowMs < s.start.getTime() + minuten * 60_000);

  // Bänder: zusammenhängende Lücken bzw. die Zeit vor der ersten Messung …
  const baender: TagesBand[] = [];
  let i = 0;
  while (i < raster.length) {
    const z = raster[i].zustand;
    if (z === 'luecke' || z === 'vorher') {
      let j = i;
      while (j + 1 < raster.length && raster[j + 1].zustand === z) j++;
      baender.push({ von: i, bis: j, art: z });
      i = j + 1;
    } else i++;
  }
  // … und die negativen Börsenpreise aus den Ereignissen des Tages.
  for (const e of history.events ?? []) {
    if (e.type !== 'negativpreis') continue;
    const a = new Date(e.start).getTime();
    const b = new Date(e.end).getTime();
    const von = raster.findIndex((s) => s.start.getTime() >= a);
    let bis = -1;
    raster.forEach((s, k) => {
      if (s.start.getTime() < b) bis = k;
    });
    if (von >= 0 && bis >= von) baender.push({ von, bis, art: 'negativpreis' });
  }

  return {
    achse: texte.map((t) => t.achse),
    titel: texte.map((t) => t.titel),
    zustand: raster.map((s) => s.zustand),
    pv,
    load,
    netz,
    speicher,
    soc,
    preis,
    hatSoc: soc.some((v) => v != null),
    hatPreis: preis.some((v) => v != null),
    jetzt: jetztIdx >= 0 ? jetztIdx : null,
    baender,
    leer: !raster.some((s) => s.zustand === 'ok'),
  };
}

// ---------------------------------------------------------------------------
// Woche/Monat/Jahr: die gespiegelte Bilanz
// ---------------------------------------------------------------------------

export interface EnergieBilanzView {
  range: Exclude<HistoryRange, 'day'>;
  zellen: EnergieZelle[];
  achse: string[];
  titel: string[];
  leer: boolean;
  drill: 'tag' | 'monat';
}

export function energieBilanzView(
  history: History,
  anchor: Date,
  range: Exclude<HistoryRange, 'day'>,
  now: Date,
): EnergieBilanzView {
  const zellen = energieZellen(history.buckets, anchor, range, now, history.coverage?.firstDataAt ?? null);
  const art = zellenArtFuer(range);
  const texte = zellen.map((z) => zellenBeschriftung(z.start, art, range));
  return {
    range,
    zellen,
    achse: texte.map((t) => t.achse),
    titel: texte.map((t) => t.titel),
    leer: !zellen.some((z) => zeichenbar(z) && z.pvKwh != null),
    drill: range === 'year' ? 'monat' : 'tag',
  };
}

// ---------------------------------------------------------------------------
// Quoten
// ---------------------------------------------------------------------------

export interface QuotenTeil {
  label: string;
  rolle: EnergieRolle;
  menge: string;
  anteilPct: number;
}

export interface Quote {
  key: 'autarkie' | 'eigenverbrauch';
  name: string;
  wert: string;
  pct: number | null;
  teile: QuotenTeil[];
  info: string;
  /**
   * Die Quote liegt außerhalb 0…100 % (AP-10 E16 Nr. 5): die Zahl steht
   * ungeklemmt, statt der Erklärung steht der Satz aus dem Bilanz-Vertrag, und
   * es gibt keinen Balken - eine Füllung bräuchte wieder eine Klemme.
   */
  unplausibel: boolean;
}

function pctText(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}${NBSP}%`;
}

export function energieQuoten(history: History): Quote[] {
  const summen = energieSummen(history.buckets);
  const kwh = (k: EnergieSummeKey) => summen.find((s) => s.key === k)?.kwh ?? null;
  const pv = kwh('erzeugt');
  const load = kwh('verbraucht');
  const imp = kwh('bezogen');
  const exp = kwh('eingespeist');
  const aut = num(history.totals.autarkiePct);
  const eig = num(history.totals.eigenverbrauchPct);
  const teil = (label: string, rolle: EnergieRolle, v: number | null, anteil: number | null): QuotenTeil[] =>
    v == null || anteil == null ? [] : [{ label, rolle, menge: mengeText(Math.max(0, v)) ?? '—', anteilPct: anteil }];
  return [
    quote(
      'autarkie',
      'Autarkie',
      aut,
      history.totals.autarkieUnplausibel,
      [
        ...teil('aus eigener Anlage', 'pv', load != null && imp != null ? load - imp : null, aut),
        ...teil('aus dem Netz', 'grid', imp, aut == null ? null : 100 - aut),
      ],
      'Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben — der Rest kam aus dem Netz.',
    ),
    quote(
      'eigenverbrauch',
      'Eigenverbrauch',
      eig,
      history.totals.eigenverbrauchUnplausibel,
      [
        ...teil('selbst genutzt', 'pv', pv != null && exp != null ? pv - exp : null, eig),
        ...teil('eingespeist', 'grid', exp, eig == null ? null : 100 - eig),
      ],
      'Anteil Ihrer Erzeugung, den Sie selbst genutzt statt eingespeist haben.',
    ),
  ];
}

/**
 * Eine Quote. Außerhalb 0…100 % wird die Zahl NICHT in den Bereich gebogen
 * (AP-10 E16 Nr. 5, vorher `messwerteZeilen.messwerteQuoten`): sie steht
 * ungeklemmt, und statt der Erklärung, die einen echten Anteil voraussetzt,
 * steht der Satz aus dem Bilanz-Vertrag.
 */
function quote(
  key: Quote['key'],
  name: string,
  pct: number | null,
  flag: boolean | null | undefined,
  teile: QuotenTeil[],
  info: string,
): Quote {
  if (pct != null && Number.isFinite(pct) && quoteUnplausibel(pct, flag)) {
    return { key, name, wert: quoteZahl(pct), pct, teile: [], info: quoteSatz(pct), unplausibel: true };
  }
  return { key, name, wert: pctText(pct), pct, teile, info, unplausibel: false };
}

// ---------------------------------------------------------------------------
// Spitzenwerte
// ---------------------------------------------------------------------------

export interface Spitze {
  label: string;
  rolle: EnergieRolle;
  wert: string;
  wann: string | null;
}

const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * Die Spitzen des Zeitraums in seiner Auflösung: am Tag das höchste
 * 15-Minuten-Mittel, in der Woche das höchste Stundenmittel, im Monat und Jahr
 * der stärkste Tag.
 */
export function energieSpitzen(history: History, range: HistoryRange): { titel: string; zeilen: Spitze[] } {
  const minuten = history.bucketMinutes > 0 ? history.bucketMinutes : 15;
  const tageswerte = minuten >= 1440;
  const faktor = tageswerte ? 1 : 60 / minuten;
  const einheit = tageswerte ? 'kWh' : 'kW';
  const wann = (d: Date) =>
    range === 'day'
      ? `${p2(d.getHours())}:${p2(d.getMinutes())} Uhr`
      : range === 'week' && !tageswerte
        ? `${WT[d.getDay()]}. ${d.getHours()} Uhr`
        : `${WT[d.getDay()]}., ${p2(d.getDate())}.${p2(d.getMonth() + 1)}.`;
  const max = (feld: keyof HistoryBucket, label: string, rolle: EnergieRolle): Spitze => {
    let best: { v: number; t: Date } | null = null;
    for (const b of history.buckets) {
      const v = num(b[feld]);
      if (v == null) continue;
      if (!best || v > best.v) best = { v, t: new Date(b.start) };
    }
    return {
      label,
      rolle,
      wert: best ? fmtNum(best.v * faktor, einheit, 1) : '—',
      wann: best ? wann(best.t) : null,
    };
  };
  return {
    titel: tageswerte ? 'Stärkste Tage' : range === 'day' ? 'Spitzen · 15-Minuten-Mittel' : 'Spitzen · Stundenmittel',
    zeilen: [
      max('pvKwh', 'Erzeugung', 'pv'),
      max('loadKwh', 'Verbrauch', 'load'),
      max('gridImportKwh', 'Netzbezug', 'grid'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Tabelle und CSV
// ---------------------------------------------------------------------------

export const ENERGIE_SPALTEN = [
  'Zeitraum',
  'Erzeugung',
  'Verbrauch',
  'Netzbezug',
  'Einspeisung',
  'Geladen',
  'Entladen',
] as const;

export interface EnergieTabellenZelle {
  schluessel: string;
  start: Date;
  zustand: ZellenZustand;
  werte: (number | null)[];
}

/** Die Zeilen der Tabelle: Stunden am Tag, Tage in Woche und Monat, Monate im Jahr. */
export function energieTabellenZellen(
  history: History,
  anchor: Date,
  range: HistoryRange,
  now: Date,
): EnergieTabellenZelle[] {
  const first = history.coverage?.firstDataAt ?? null;
  const felder: (keyof HistoryBucket)[] = [
    'pvKwh',
    'loadKwh',
    'gridImportKwh',
    'gridExportKwh',
    'batteryChargeKwh',
    'batteryDischargeKwh',
  ];
  if (range !== 'day') {
    return energieZellen(history.buckets, anchor, range, now, first).map((z) => ({
      schluessel: z.schluessel,
      start: z.start,
      zustand: z.zustand,
      werte: [z.pvKwh, z.loadKwh, z.importKwh, z.exportKwh, z.ladenKwh, z.entladenKwh],
    }));
  }
  const d0 = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const sums = new Map<number, (number | null)[]>();
  for (const b of history.buckets) {
    const t = new Date(b.start);
    if (Number.isNaN(t.getTime()) || tagSchluessel(t) !== tagSchluessel(d0)) continue;
    const s = sums.get(t.getHours()) ?? felder.map(() => null);
    felder.forEach((f, i) => {
      const v = num(b[f]);
      if (v != null) s[i] = (s[i] ?? 0) + v;
    });
    sums.set(t.getHours(), s);
  }
  return Array.from({ length: 24 }, (_, h) => {
    const start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), h);
    const ende = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), h + 1);
    const werte = sums.get(h) ?? felder.map(() => null);
    const hat = werte.some((v) => v != null);
    return {
      schluessel: `${tagSchluessel(start)}T${p2(h)}`,
      start,
      zustand: zellenZustand({ schluessel: '', start, ende, art: 'tag' }, hat, now, first),
      werte,
    };
  });
}

function kwhZelle(v: number | null): { text: string; ton: null } {
  return { text: v == null ? '—' : fmtNum(v, 'kWh', 1), ton: null };
}

function tabellenKopf(start: Date, range: HistoryRange): string {
  if (range === 'day') return `${start.getHours()}–${start.getHours() + 1} Uhr`;
  if (range === 'year') return start.toLocaleDateString('de-DE', { month: 'long' });
  return `${WT[start.getDay()]}., ${p2(start.getDate())}.${p2(start.getMonth() + 1)}.`;
}

export function energieTabelle(
  zellen: readonly EnergieTabellenZelle[],
  history: History,
  range: HistoryRange,
): {
  zeilen: { id: string; kopf: string; zellen: { text: string; ton: null }[] | null; leer?: string }[];
  summe: { id: string; kopf: string; zellen: { text: string; ton: null }[] } | null;
} {
  const zeilen: { id: string; kopf: string; zellen: { text: string; ton: null }[] | null; leer?: string }[] = [];
  for (const z of zellen) {
    if (z.zustand === 'zukunft' || z.zustand === 'vorher') continue;
    const kopf = `${tabellenKopf(z.start, range)}${z.zustand === 'laeuft' ? ' · läuft' : ''}`;
    if (!z.werte.some((v) => v != null)) {
      zeilen.push({ id: z.schluessel, kopf, zellen: null, leer: z.zustand === 'laeuft' ? 'noch keine Werte' : 'keine Messwerte' });
      continue;
    }
    zeilen.push({ id: z.schluessel, kopf, zellen: z.werte.map(kwhZelle) });
  }
  const summen = energieSummen(history.buckets);
  const summe = summen.every((s) => s.kwh == null)
    ? null
    : { id: 'summe', kopf: 'Summe', zellen: summen.map((s) => kwhZelle(s.kwh)) };
  return { zeilen, summe };
}

function csvZahl(v: number | null): string {
  return v == null ? '' : (Math.round(v * 1000) / 1000).toFixed(3).replace('.', ',');
}

function isoLokal(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Die Tabelle als CSV (Semikolon, Dezimalkomma, kWh mit drei Stellen). */
export function energieCsv(zellen: readonly EnergieTabellenZelle[], history: History, range: HistoryRange): string {
  const kopf = [
    'Beginn',
    'Zeitraum',
    'Erzeugung kWh',
    'Verbrauch kWh',
    'Netzbezug kWh',
    'Einspeisung kWh',
    'Geladen kWh',
    'Entladen kWh',
  ];
  const out = [kopf.join(';')];
  for (const z of zellen) {
    if (z.zustand === 'zukunft' || z.zustand === 'vorher') continue;
    out.push([isoLokal(z.start), `"${tabellenKopf(z.start, range)}"`, ...z.werte.map(csvZahl)].join(';'));
  }
  const summen = energieSummen(history.buckets);
  if (!summen.every((s) => s.kwh == null)) {
    out.push(['', '"Summe"', ...summen.map((s) => csvZahl(s.kwh))].join(';'));
  }
  return `${out.join('\r\n')}\r\n`;
}

/** Die Auflösung der Werte in Worten — für die Statuszeile. */
export function aufloesungText(history: History | null): string | null {
  if (!history) return null;
  const m = history.bucketMinutes;
  if (m === 15) return '15-Minuten-Werte';
  if (m === 60) return 'Stundenwerte';
  if (m >= 1440) return 'Tageswerte';
  return m > 0 ? `${m}-Minuten-Werte` : null;
}

/**
 * Die Höhenklasse des Tagesdiagramms — eine Stelle für Diagramm UND seinen
 * Platzhalter, damit beim Nachladen nichts springt.
 */
export function tagHoehe(tag: EnergieTag, preisSichtbar: boolean): 'mittel' | 'hoch' | 'sehrhoch' {
  const felder = 2 + (tag.hatSoc ? 1 : 0) + (preisSichtbar && tag.hatPreis ? 1 : 0);
  return felder === 2 ? 'mittel' : felder === 3 ? 'hoch' : 'sehrhoch';
}
