/**
 * Der ERGEBNIS-ZUSTAND einer abgeleiteten Zahl und ihre Sätze (UEMS AP-08
 * IP-8, §4.1, §4.5, E10, E11) — der TS-Zwilling von
 * `services/api .../uems/ErgebnisZustand`. Eine Zahl ohne ihren Zustand ist
 * eine Behauptung.
 *
 * Der Vertrag steht in `docs/contracts/v2/ergebnis-zustand-vectors.json`
 * (Prosa: `ergebnis-zustand.md`). Wer eine Regel oder einen Satz ändert,
 * ändert die Datei UND beide Zwillinge; `uemsErgebnis.test.ts` fährt dieselbe
 * Datei per Pfad.
 *
 * Vier Dinge wohnen hier, und die Flächen erfinden keinen zweiten Wortlaut:
 *  1. das geschlossene Zustands-Vokabular (vollständig · unvollständig ·
 *     keine Werte · mit Ersatzwert) mit seiner Regel für Zahl und Kennzeichen;
 *  2. die geschlossene Liste der Kennzeichen-Sätze mit Rang — die
 *     Reihenfolge ist Vertrag;
 *  3. die Rundung als Funktion des Vertrags (E11): die EBENE bestimmt die
 *     Nachkommastellen, nie die Fläche. Gerechnet wird ungerundet, gerundet
 *     nur beim Anzeigen, exakt als Dezimaltext (`dez.ts`) — `0.15` rundet wie
 *     `BigDecimal` auf `0,2`, nicht wie ein Binärbruch auf `0,1`;
 *  4. die Sommerzeit-Beschriftung (E10): Ortszeit des Standorts, die doppelte
 *     Stunde mit MESZ/MEZ, die fehlende erscheint nicht.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import { iso, mitternacht, offsetMinuten, stundenDesTages, tagPlus, zwei } from './bezugsPeriode';
import { dez, dezRunde, type Dez } from './dez';

// ------------------------------------------------------------------ Zustände (§4.5)

export const VOLLSTAENDIG = 'vollständig';
export const UNVOLLSTAENDIG = 'unvollständig';
export const KEINE_WERTE = 'keine Werte';
export const MIT_ERSATZWERT = 'mit Ersatzwert';

export type Zustand = { wort: string; zahl: 'pflicht' | 'erlaubt' | 'verboten'; kennzeichen: string };

export const ZUSTAENDE: Zustand[] = [
  { wort: VOLLSTAENDIG, zahl: 'pflicht', kennzeichen: 'kein_fehlbestand' },
  { wort: UNVOLLSTAENDIG, zahl: 'erlaubt', kennzeichen: 'mindestens_ein_fehlbestand' },
  { wort: KEINE_WERTE, zahl: 'verboten', kennzeichen: 'kein_fehlbestand' },
  { wort: MIT_ERSATZWERT, zahl: 'pflicht', kennzeichen: 'frei' },
];

// ------------------------------------------------------------------ Kennzeichen

/** Je Platzhalter-Art der Ausdruck, der den eingesetzten Text erkennt (ohne fangende Gruppe). */
export const PLATZHALTER: Record<string, string> = {
  uhr: '(?:[01][0-9]|2[0-3]):[0-5][0-9](?: (?:MESZ|MEZ|UTC[+-](?:[01][0-9]|2[0-3]):[0-5][0-9]))?',
  text: '.+',
  ganzzahl: '(?:0|[1-9][0-9]*)',
  ganzzahl_ab_2: '(?:[2-9]|[1-9][0-9]+)',
  sekunden: '[0-5][0-9]',
  dezimal_punkt: '(?:0|[1-9][0-9]*)\\.[0-9]{3}',
  dezimal_klartext: '(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?',
};

export type Muster = {
  schluessel: string;
  muster: string;
  platzhalter: Record<string, string>;
  /** Das Wort des Kennzeichen-Vokabulars; `null` = keins (Befund in der Vektor-Datei). */
  wort: string | null;
  /** In einer Liste steigt der Rang nie. */
  rang: number;
  /** Der Satz nennt einen nicht gezählten Teil. */
  fehlbestand: boolean;
  einmalig: boolean;
  /** Der unmittelbar vorangehende Satz muss eines dieser Muster sein. */
  folgtAuf: string[] | null;
  /** Der unmittelbar folgende Satz muss dieses Muster sein. */
  verlangtDanach: string | null;
};

const m = (
  schluessel: string,
  muster: string,
  platzhalter: Record<string, string>,
  wort: string | null,
  rang: number,
  fehlbestand: boolean,
  einmalig: boolean,
  folgtAuf: string[] | null = null,
  verlangtDanach: string | null = null,
): Muster => ({ schluessel, muster, platzhalter, wort, rang, fehlbestand, einmalig, folgtAuf, verlangtDanach });

export const KENNZEICHEN: Muster[] = [
  m('anteil_positiv', 'positiver Anteil von {quelle}', { quelle: 'text' }, 'positiver Anteil', 10, false, true),
  m('anteil_negativ', 'negativer Anteil von {quelle}', { quelle: 'text' }, 'negativer Anteil', 10, false, true),
  m('anfang_nicht_gemessen', 'Anfang nicht gemessen (kein Stand an der Periodengrenze)', {}, null, 20, true, true),
  m('ende_nicht_gemessen', 'Ende nicht gemessen (kein Stand an der Periodengrenze)', {}, null, 21, true, true),
  m('nur_ein_stand', 'nur ein Stand in der Periode — keine Menge bildbar', {}, null, 22, true, true),
  m('geraetegrenze_mit', 'Gerätegrenze {uhr} mit Ableseständen', { uhr: 'uhr' }, 'Gerätegrenze', 30, false, false),
  m('geraetegrenze_ohne', 'Gerätegrenze {uhr} ohne Ablesestände', { uhr: 'uhr' }, 'Gerätegrenze', 30, false, false,
    null, 'zuwachs_nicht_messbar'),
  m('zuwachs_nicht_messbar', 'Zuwachs am Wechsel nicht messbar (Ablesestände fehlen)', {}, 'Gerätegrenze', 30,
    true, false, ['geraetegrenze_ohne']),
  m('luecke_am_wechsel', 'Lücke am Wechsel {von}–{bis} (nicht aufgefüllt)', { von: 'uhr', bis: 'uhr' },
    'Gerätegrenze', 30, false, false, ['geraetegrenze_mit', 'zuwachs_nicht_messbar']),
  m('ueberlauf', 'Überlauf {uhr} (Wertebereich {modul})', { uhr: 'uhr', modul: 'dezimal_klartext' }, 'Überlauf',
    30, false, false),
  m('ruecksetzung', 'Rücksetzung {uhr} ohne Endstand — bis zu 1 Kadenz nicht gezählt', { uhr: 'uhr' },
    'Rücksetzung', 30, true, false),
  m('luecke_zuwachs', 'Lücke {von}–{bis}: Zuwachs {zuwachs} gemessen, nicht auf Viertelstunden verteilbar',
    { von: 'uhr', bis: 'uhr', zuwachs: 'dezimal_punkt' }, 'Lücke: Zuwachs gemessen', 30, false, false),
  m('neustart', 'Neustart {uhr}: bis zu {verlust_s} s Zählung möglicherweise verloren',
    { uhr: 'uhr', verlust_s: 'ganzzahl' }, 'Neustart-Verlust', 40, true, false),
  m('intervallmenge_fehlt', '1 von {erwartet} Intervallmengen fehlt — Menge ist die Summe der gemessenen',
    { erwartet: 'ganzzahl' }, null, 50, true, true),
  m('intervallmengen_fehlen', '{fehlend} von {erwartet} Intervallmengen fehlen — Menge ist die Summe der gemessenen',
    { fehlend: 'ganzzahl_ab_2', erwartet: 'ganzzahl' }, null, 50, true, true),
  m('gemessene_zeit', 'gemessene Zeit {minuten}:{sekunden} min von {periode_min} min',
    { minuten: 'ganzzahl', sekunden: 'sekunden', periode_min: 'ganzzahl' }, null, 50, true, true),
  m('aus_leistung_integriert', 'aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit)', {},
    'aus Leistung integriert', 60, false, true),
];

/**
 * Ein Wortlaut, den eine frühere Fassung sprach und der gespeichert sein kann.
 * Er wird als das Muster `schluessel` ERKANNT, aber nie mehr gesprochen.
 */
export type FruehereFassung = {
  schluessel: string;
  muster: string;
  platzhalter: Record<string, string>;
  /** Die letzte Fassung des Vertrags, die ihn sprach. */
  bisFassung: string;
};

export const FRUEHERE_FASSUNGEN: FruehereFassung[] = [
  // Falscher Dativ; in endgültigen Viertelstunden gespeichert und von Tag/Monat/Jahr übernommen.
  { schluessel: 'geraetegrenze_mit', muster: 'Gerätegrenze {uhr} mit Ablesestände', platzhalter: { uhr: 'uhr' }, bisFassung: '1.0' },
];

export type Vorgesehen = { wort: string; anfang: string; wortlautMit: string };

/** Wörter des Vokabulars, deren Wortlaut ein späteres Paket festlegt. */
export const VORGESEHEN: Vorgesehen[] = [
  { wort: 'nachgeliefert', anfang: 'nachgeliefert', wortlautMit: 'AP-08 IP-10 (Chip „nachgeliefert“ am Verlauf)' },
  { wort: 'korrigiert (Version n)', anfang: 'korrigiert (Version ', wortlautMit: 'AP-08 IP-17/IP-18 (Versionen)' },
  { wort: 'vorläufig', anfang: 'vorläufig', wortlautMit: 'AP-08 IP-9 (Fassung vorläufig/endgültig im Lese-Modell)' },
  { wort: 'endgültig', anfang: 'endgültig', wortlautMit: 'AP-08 IP-9 (Fassung vorläufig/endgültig im Lese-Modell)' },
  { wort: 'Ablesezeitraum', anfang: 'Ablesezeitraum', wortlautMit: 'AP-09 (Ablesungen einer Messstelle ohne Datenquelle, F17)' },
  { wort: 'mit Ersatzwert (Methode …)', anfang: 'mit Ersatzwert (', wortlautMit: 'AP-08 IP-13 (Ersatzwert-Methoden)' },
];

const PLATZ = /\{([a-z_]+)\}/g;

const woertlich = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const erkenner = (k: Muster, text: string, platzhalter: Record<string, string>, fruehereFassung: boolean) => {
  const namen: string[] = [];
  let ausdruck = '^';
  let stelle = 0;
  for (const treffer of text.matchAll(PLATZ)) {
    ausdruck += woertlich(text.slice(stelle, treffer.index));
    namen.push(treffer[1]);
    ausdruck += `(${PLATZHALTER[platzhalter[treffer[1]]]})`;
    stelle = (treffer.index ?? 0) + treffer[0].length;
  }
  ausdruck += `${woertlich(text.slice(stelle))}$`;
  return { muster: k, ausdruck: new RegExp(ausdruck, 'u'), namen, fruehereFassung };
};

const ERKENNER = [
  ...KENNZEICHEN.map((k) => erkenner(k, k.muster, k.platzhalter, false)),
  ...FRUEHERE_FASSUNGEN.map((f) => {
    const k = KENNZEICHEN.find((x) => x.schluessel === f.schluessel);
    if (!k) throw new Error(`frühere Fassung ohne Muster ${f.schluessel}`);
    return erkenner(k, f.muster, f.platzhalter, true);
  }),
];

/** Das Muster zu einem Schlüssel; ein unbekannter Schlüssel ist ein Programmfehler. */
export const muster = (schluessel: string): Muster => {
  const gefunden = KENNZEICHEN.find((k) => k.schluessel === schluessel);
  if (!gefunden) throw new Error(`unbekanntes Kennzeichen ${schluessel}`);
  return gefunden;
};

/** Den Satz eines Musters sprechen — geprüft wird nur, dass GENAU seine Platzhalter belegt sind. */
export const sprich = (schluessel: string, werte: Record<string, string>): string => {
  const k = muster(schluessel);
  const soll = Object.keys(k.platzhalter).sort().join(',');
  const ist = Object.keys(werte).sort().join(',');
  if (soll !== ist) throw new Error(`Kennzeichen ${schluessel} braucht [${soll}], bekam [${ist}]`);
  return k.muster.replace(PLATZ, (_, name: string) => werte[name]);
};

/** Der feste Anfang eines Musters bis zum ersten Platzhalter. */
export const anfang = (schluessel: string): string => {
  const text = muster(schluessel).muster;
  const platz = text.indexOf('{');
  return platz < 0 ? text : text.slice(0, platz);
};

/** `fruehereFassung`: der Satz trägt den Wortlaut einer früheren Fassung (gespeichert, nie mehr gesprochen). */
export type Erkannt = { muster: Muster; werte: Record<string, string>; fruehereFassung: boolean };

/** Welches Muster ein Satz trägt, oder `null`. Zwei Treffer wären ein Fehler der LISTE. */
export const erkenne = (satz: string): Erkannt | null => {
  let gefunden: Erkannt | null = null;
  for (const e of ERKENNER) {
    const treffer = e.ausdruck.exec(satz);
    if (!treffer) continue;
    if (gefunden) throw new Error(`„${satz}“ passt auf ${gefunden.muster.schluessel} und ${e.muster.schluessel}`);
    const werte: Record<string, string> = {};
    e.namen.forEach((name, i) => {
      werte[name] = treffer[i + 1];
    });
    gefunden = { muster: e.muster, werte, fruehereFassung: e.fruehereFassung };
  }
  return gefunden;
};

/** Ob ein Satz mit einem vorgesehenen Wort beginnt, dessen Wortlaut noch nicht Vertrag ist. */
export const vorgesehen = (satz: string): boolean =>
  erkenne(satz) === null && VORGESEHEN.some((v) => satz.startsWith(v.anfang));

// ------------------------------------------------------------------ Prüfen und Sprechen

/** Das geschlossene Vokabular der Verstöße — in dieser Reihenfolge meldet `pruefe` sie. */
export const VERSTOESSE = [
  'zustand_unbekannt',
  'einheit_unbekannt',
  'ebene_unbekannt',
  'ebene_fehlt',
  'zahl_fehlt',
  'zahl_verboten',
  'kennzeichen_unbekannt',
  'kennzeichen_vorgesehen',
  'kennzeichen_doppelt',
  'kennzeichen_reihenfolge',
  'kennzeichen_folge',
  'vollstaendig_mit_fehlbestand',
  'unvollstaendig_ohne_grund',
  'keine_werte_mit_fehlbestand',
] as const;

export type Verstoss = (typeof VERSTOESSE)[number];

/** Eine Zahl, wie sie reist: Dezimaltext (bevorzugt) oder Zahl; `null` = keine Zahl, nie 0. */
export type Betrag = string | number | null;

export type Ergebnis = {
  wert: Betrag;
  einheit: string;
  /** `viertelstunde` … `jahr`; für kWh Pflicht. */
  ebene: string | null;
  zustand: string;
  /** Der Verlauf in Prozent; `null` = nicht nennen. */
  abdeckungProzent: Betrag;
  kennzeichen: string[];
};

export const TRENNER = ' · ';
export const OHNE_ZAHL = '—';
const ABDECKUNG = 'Verlauf ';

/** Alle Verstöße eines Ergebnisses gegen den Vertrag, geordnet und ohne Doppel; leer = gültig. */
export const pruefe = (e: Ergebnis): Verstoss[] => {
  const v = new Set<Verstoss>(pruefeZahl(e.einheit, e.ebene));
  const z = ZUSTAENDE.find((x) => x.wort === e.zustand);
  if (!z) v.add('zustand_unbekannt');
  else if (z.zahl === 'pflicht' && e.wert === null) v.add('zahl_fehlt');
  else if (z.zahl === 'verboten' && e.wert !== null) v.add('zahl_verboten');

  const erkannt = e.kennzeichen.map(erkenne);
  const gesehen = new Set<string>();
  let rang = Number.NEGATIVE_INFINITY;
  let fehlbestand = false;
  erkannt.forEach((k, i) => {
    if (!k) {
      v.add(vorgesehen(e.kennzeichen[i]) ? 'kennzeichen_vorgesehen' : 'kennzeichen_unbekannt');
      return;
    }
    const km = k.muster;
    if (gesehen.has(km.schluessel) && km.einmalig) v.add('kennzeichen_doppelt');
    gesehen.add(km.schluessel);
    if (km.rang < rang) v.add('kennzeichen_reihenfolge');
    rang = Math.max(rang, km.rang);
    const davor = i > 0 ? erkannt[i - 1] : null;
    if (km.folgtAuf && (!davor || !km.folgtAuf.includes(davor.muster.schluessel))) v.add('kennzeichen_folge');
    const danach = i + 1 < erkannt.length ? erkannt[i + 1] : null;
    if (km.verlangtDanach && (!danach || danach.muster.schluessel !== km.verlangtDanach)) v.add('kennzeichen_folge');
    fehlbestand = fehlbestand || km.fehlbestand;
  });

  if (z) {
    if (z.kennzeichen === 'kein_fehlbestand' && fehlbestand) {
      v.add(z.wort === VOLLSTAENDIG ? 'vollstaendig_mit_fehlbestand' : 'keine_werte_mit_fehlbestand');
    }
    if (z.kennzeichen === 'mindestens_ein_fehlbestand' && !fehlbestand) v.add('unvollstaendig_ohne_grund');
  }
  return VERSTOESSE.filter((x) => v.has(x));
};

/**
 * Der Kundensatz eines gültigen Ergebnisses: Zahl · Zustand · Verlauf ·
 * Kennzeichen („2.304 kWh · vollständig · Verlauf 85 %“). Ein ungültiges wird
 * nicht gesprochen — die Fläche fragt vorher `pruefe`.
 */
export const satz = (e: Ergebnis): string => {
  const verstoesse = pruefe(e);
  if (verstoesse.length > 0) throw new Error(`Ergebnis verletzt den Vertrag: ${verstoesse.join(', ')}`);
  const teile = [zahl(e.wert, e.einheit, e.ebene), e.zustand];
  if (e.abdeckungProzent !== null) teile.push(ABDECKUNG + zahl(e.abdeckungProzent, PROZENT, null));
  return [...teile, ...e.kennzeichen].join(TRENNER);
};

// ------------------------------------------------------------------ Rundung (E11)

export const EBENEN = ['viertelstunde', 'stunde', 'tag', 'monat', 'jahr'];

export const KWH = 'kWh';
export const KW = 'kW';
export const PROZENT = '%';
export const KUBIKMETER = 'm³';
/** Scheinleistung (Anschlussleistung) — „Leistung eine Nachkommastelle“ wie kW (E11, seit 1.2). */
export const KVA = 'kVA';

export type Stellen = { einheit: string; ebene: string | null; stellen: number };

/** Die Stellen je Einheit und Ebene; `ebene: null` = für jede Ebene gleich. */
export const STELLEN: Stellen[] = [
  { einheit: KWH, ebene: 'viertelstunde', stellen: 1 },
  { einheit: KWH, ebene: 'stunde', stellen: 1 },
  { einheit: KWH, ebene: 'tag', stellen: 0 },
  { einheit: KWH, ebene: 'monat', stellen: 0 },
  { einheit: KWH, ebene: 'jahr', stellen: 0 },
  { einheit: KW, ebene: null, stellen: 1 },
  { einheit: PROZENT, ebene: null, stellen: 0 },
  { einheit: KUBIKMETER, ebene: null, stellen: 1 },
  { einheit: KVA, ebene: null, stellen: 1 },
];

export const TAUSENDER = '.';
export const DEZIMAL = ',';
/** U+00A0 — geschütztes Leerzeichen vor der Einheit. */
export const VOR_EINHEIT = ' ';
/** U+2212 — das Minuszeichen der Anzeige, nicht der Bindestrich. */
export const MINUS = '−';

/** Die Verstöße von Einheit und Ebene allein; leer = anzeigbar. */
export const pruefeZahl = (einheit: string, ebene: string | null): Verstoss[] => {
  const v: Verstoss[] = [];
  if (!STELLEN.some((s) => s.einheit === einheit)) v.push('einheit_unbekannt');
  if (ebene !== null && !EBENEN.includes(ebene)) v.push('ebene_unbekannt');
  else if (ebene === null && einheit === KWH) v.push('ebene_fehlt');
  return v;
};

/** Die Nachkommastellen — bestimmt von Einheit und EBENE, nie von der Fläche. */
export const stellen = (einheit: string, ebene: string | null): number => {
  const v = pruefeZahl(einheit, ebene);
  if (v.length > 0) throw new Error(`keine Anzeige für ${einheit} / ${ebene}: ${v.join(', ')}`);
  const s = STELLEN.find((x) => x.einheit === einheit && (x.ebene === null || x.ebene === ebene));
  if (!s) throw new Error(`keine Stellen für ${einheit} / ${ebene}`);
  return s.stellen;
};

/** Ein Betrag als exakter Dezimalwert; eine Zahl über ihre kürzeste Dezimalschreibweise. */
const zuDez = (wert: string | number): Dez => {
  if (typeof wert === 'string') return dez(wert);
  const kurz = String(wert);
  return dez(/e/i.test(kurz) ? wert.toFixed(20) : kurz);
};

const text = (d: Dez, einheit: string): string => {
  const negativ = d.z < 0n;
  const ziffern = (negativ ? -d.z : d.z).toString().padStart(d.e + 1, '0');
  const ganz = ziffern.slice(0, ziffern.length - d.e).replace(/\B(?=(\d{3})+(?!\d))/g, TAUSENDER);
  const bruch = d.e > 0 ? DEZIMAL + ziffern.slice(ziffern.length - d.e) : '';
  return `${negativ ? MINUS : ''}${ganz}${bruch}${VOR_EINHEIT}${einheit}`;
};

/**
 * E11 — die angezeigte Zahl mit Einheit: kaufmännisch gerundet auf die Stellen
 * der Ebene, Tausenderpunkt, Komma, geschütztes Leerzeichen („2.304 kWh“,
 * „96,5 kW“, „85 %“). Kein Wert ist „—“, nie 0. Gerechnet wird damit nie.
 */
export const zahl = (wert: Betrag, einheit: string, ebene: string | null): string => {
  const s = stellen(einheit, ebene);
  return wert === null ? OHNE_ZAHL : text(dezRunde(zuDez(wert), s), einheit);
};

export type Rundungsdifferenz = { summeDerAngezeigten: string; differenz: string | null; satz: string | null };

/**
 * E11 — die Differenz zwischen der Summe der ANGEZEIGTEN Teile und der
 * angezeigten Summe (Teile minus Summe). Sie wird genannt, nie in einen Teil
 * „korrigiert“.
 */
export const rundungsdifferenz = (
  einheit: string,
  teile: Array<string | number>,
  ebeneTeile: string,
  summe: string | number,
  ebeneSumme: string,
): Rundungsdifferenz => {
  const st = stellen(einheit, ebeneTeile);
  const ss = stellen(einheit, ebeneSumme);
  const angezeigt: Dez = { z: teile.reduce((acc, t) => acc + dezRunde(zuDez(t), st).z, 0n), e: st };
  const e = Math.max(st, ss);
  const differenz: Dez = { z: dezRunde(angezeigt, e).z - dezRunde(dezRunde(zuDez(summe), ss), e).z, e };
  const summeText = text(angezeigt, einheit);
  if (differenz.z === 0n) return { summeDerAngezeigten: summeText, differenz: null, satz: null };
  const differenzText = text(differenz, einheit);
  return {
    summeDerAngezeigten: summeText,
    differenz: differenzText,
    satz: `Summe der angezeigten Werte ${summeText}${TRENNER}Rundungsdifferenz ${differenzText}`,
  };
};

// ------------------------------------------------------------------ Sommerzeit (E10)

export const TAGESDAUER: Record<number, string> = {
  23: '23 Stunden (Zeitumstellung)',
  25: '25 Stunden (Zeitumstellung)',
};

/** Die Schrittweite je Raster, in Minuten. */
export const SCHRITTE: Record<string, number> = { viertelstunde: 15, stunde: 60 };

/**
 * E10 — was die Tageskarte über die Länge des Tages sagt: „25 Stunden
 * (Zeitumstellung)“ bzw. „23 Stunden (Zeitumstellung)“, an einem
 * 24-Stunden-Tag nichts (`null`). Die Stundenzahl zählt `bezugsPeriode.ts`.
 */
export const tagesdauer = (tag: string, zone: string): string | null => TAGESDAUER[stundenDesTages(tag, zone)] ?? null;

export type Feld = { beschriftung: string; von: string };

const wanduhr = (ms: number): string => {
  const d = new Date(ms);
  return `${zwei(d.getUTCHours())}:${zwei(d.getUTCMinutes())}`;
};

const zusatz = (normalzeit: number, offset: number): string => {
  if (normalzeit === 60 && (offset === 60 || offset === 120)) return offset === 60 ? 'MEZ' : 'MESZ';
  const abs = Math.abs(offset);
  return `UTC${offset < 0 ? '-' : '+'}${zwei(Math.floor(abs / 60))}:${zwei(abs % 60)}`;
};

/**
 * E10 — die Uhrzeit IN einem Kennzeichen: Wanduhr `HH:MM` in `zone`. Gibt es
 * diese Wanduhr an dem Tag zweimal (Sommerzeit-Ende), trägt sie denselben
 * Zusatz wie `raster`: „02:30 MESZ“ bzw. „02:30 MEZ“, sonst den Offset.
 */
export const uhr = (zeit: number, zone: string): string => {
  const offset = offsetMinuten(zeit, zone);
  const wand = zeit + offset * 60000;
  const text = wanduhr(wand);
  // Zweimal gibt es die Wanduhr, wenn ein anderer Offset der Nachbarschaft sie ebenfalls trifft.
  const doppelt = [offsetMinuten(zeit - 3 * 3600000, zone), offsetMinuten(zeit + 3 * 3600000, zone)]
    .some((anderer) => anderer !== offset && offsetMinuten(wand - anderer * 60000, zone) === anderer);
  if (!doppelt) return text;
  const normalzeit = offsetMinuten(Date.UTC(new Date(wand).getUTCFullYear(), 0, 1), zone);
  return `${text} ${zusatz(normalzeit, offset)}`;
};

/**
 * E10 — die Viertelstunden oder Stunden eines Kalendertages in der Ortszeit
 * des Standorts. Eine Beschriftung, die an diesem Tag zweimal vorkommt, trägt
 * ihren Zusatz: MESZ/MEZ in einer Zone mit Normalzeit UTC+01:00, sonst ihren
 * Offset („UTC+00:00“). Die fehlende Stunde erscheint nicht. `von` ist der
 * Beginn als ISO-8601 mit Offset — die Form des Exports.
 */
export const raster = (tag: string, zone: string, schritt: string): Feld[] => {
  const minuten = SCHRITTE[schritt];
  if (minuten === undefined) throw new Error(`unbekannter Schritt ${schritt}`);
  const ende = mitternacht(tagPlus(tag, 1), zone);
  const normalzeit = offsetMinuten(Date.UTC(Number(tag.slice(0, 4)), 0, 1), zone);
  const roh: Array<{ schlicht: string; zusatz: string; von: string }> = [];
  for (let t = mitternacht(tag, zone); t < ende; t += minuten * 60000) {
    const offset = offsetMinuten(t, zone);
    const wand = t + offset * 60000;
    roh.push({
      schlicht: `${wanduhr(wand)}–${wanduhr(wand + minuten * 60000)}`,
      zusatz: zusatz(normalzeit, offset),
      von: iso(t, zone),
    });
  }
  const anzahl = new Map<string, number>();
  for (const r of roh) anzahl.set(r.schlicht, (anzahl.get(r.schlicht) ?? 0) + 1);
  return roh.map((r) => ({
    beschriftung: (anzahl.get(r.schlicht) ?? 0) > 1 ? `${r.schlicht} ${r.zusatz}` : r.schlicht,
    von: r.von,
  }));
};
