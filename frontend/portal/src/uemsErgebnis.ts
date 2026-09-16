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
 * Sechs Dinge wohnen hier, und die Flächen erfinden keinen zweiten Wortlaut:
 *  1. das geschlossene Zustands-Vokabular (vollständig · unvollständig ·
 *     keine Werte · mit Ersatzwert) mit seiner Regel für Zahl und Kennzeichen;
 *  2. die geschlossene Liste der Kennzeichen-Sätze mit Rang — die
 *     Reihenfolge ist Vertrag;
 *  3. die Rundung als Funktion des Vertrags (E11): Wertbezug und EBENE bestimmen die
 *     Nachkommastellen, nie die Fläche. Gerechnet wird ungerundet, gerundet
 *     nur beim Anzeigen, exakt als Dezimaltext (`dez.ts`) — `0.15` rundet wie
 *     `BigDecimal` auf `0,2`, nicht wie ein Binärbruch auf `0,1`;
 *  4. die Sommerzeit-Beschriftung (E10): Ortszeit des Standorts, die doppelte
 *     Stunde mit MESZ/MEZ, die fehlende erscheint nicht;
 *  5. seit 1.6 die Herkunft der Menge am Zustandswort (E1): „vollständig
 *     (Menge aus Zählerständen)“ neben „Verlauf 85 %“; seit 1.7 die Fassung
 *     der Periode als Kennzeichen („vorläufig“ · „endgültig“, `fassung`).
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import { iso, mitternacht, offsetMinuten, stundenDesTages, tagPlus, zwei } from './bezugsPeriode';
import { dez, dezRunde, dezTeile, dezText, type Dez } from './dez';
import { METHODE_TEXT } from './uemsEreignis';

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
  // Eine Menge in der Anzeige-Einheit mit den Stellen der KENNZEICHEN_EBENE (seit 1.3).
  menge: '(?:0|[1-9][0-9]{0,2}(?:\\.[0-9]{3})*),[0-9]\u00a0(?:kWh|kvarh|kVAh|m³)',
  // Seit 1.4 (AP-08 IP-13): der Name einer Ersatzwert-Methode in Kundensprache und die Kennung.
  ersatzwert_methode:
    '(?:Zuwachs gleichmäßig verteilen|Zuwachs nach dem Profil der Vorperiode verteilen'
    + '|Zuwachs nach dem Profil der Vergleichsquelle verteilen|Ablesestand nachtragen'
    + '|Wert eingeben \\(mit Beleg\\)|Vorperiode übernehmen|Vergleichsquelle übernehmen)',
  ersatzwert_kennung: 'EW-[0-9]{4}-[0-9]{4,}',
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
    { von: 'uhr', bis: 'uhr', zuwachs: 'menge' }, 'Lücke: Zuwachs gemessen', 30, false, false),
  m('luecke_zuwachs_ohne_einheit', 'Lücke {von}–{bis}: Zuwachs gemessen, nicht auf Viertelstunden verteilbar',
    { von: 'uhr', bis: 'uhr' }, 'Lücke: Zuwachs gemessen', 30, false, false),
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
  // Seit 1.4 (AP-08 IP-13): zuletzt, was ein Mensch gesetzt hat — nach allem, was gemessen ist.
  m('mit_ersatzwert', 'mit Ersatzwert (Methode „{methode}“, {kennung})',
    { methode: 'ersatzwert_methode', kennung: 'ersatzwert_kennung' }, 'mit Ersatzwert (Methode …)', 70, false, false),
  // Seit 1.5 (AP-08 IP-17): ganz zuletzt die Version — sie sagt etwas über die ganze Zahl, nicht über einen Teil.
  // Version 1 ist das Original und nie „korrigiert“.
  m('korrigiert', 'korrigiert (Version {version})', { version: 'ganzzahl_ab_2' }, 'korrigiert (Version n)', 80, false, true),
  // Seit 1.7 (AP-08 IP-11, Captain 14.09.2026): ganz zuletzt die Fassung — ob die ganze Zahl sich noch ändern kann.
  // Höchstens EINE je Liste (FASSUNG_KENNZEICHEN); sie ist nicht der Zustand (Vollständigkeit).
  m('vorlaeufig', 'vorläufig', {}, 'vorläufig', 90, false, true),
  m('endgueltig', 'endgültig', {}, 'endgültig', 90, false, true),
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
  // Punkt, drei Stellen, ohne Einheit („Zuwachs 337.600“); seit AP-08 IP-6 gespeichert.
  {
    schluessel: 'luecke_zuwachs',
    muster: 'Lücke {von}–{bis}: Zuwachs {zuwachs} gemessen, nicht auf Viertelstunden verteilbar',
    platzhalter: { von: 'uhr', bis: 'uhr', zuwachs: 'dezimal_punkt' },
    bisFassung: '1.2',
  },
];

export type Vorgesehen = { wort: string; anfang: string; wortlautMit: string };

/** Wörter des Vokabulars, deren Wortlaut ein späteres Paket festlegt. */
export const VORGESEHEN: Vorgesehen[] = [
  { wort: 'nachgeliefert', anfang: 'nachgeliefert', wortlautMit: 'AP-08 IP-10 (Chip „nachgeliefert“ am Verlauf)' },
  { wort: 'Ablesezeitraum', anfang: 'Ablesezeitraum', wortlautMit: 'AP-09 (Ablesungen einer Messstelle ohne Datenquelle, F17)' },
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

/**
 * „mit Ersatzwert (Methode „Zuwachs gleichmäßig verteilen“, EW-2026-0003)“ — Rang 70, seit 1.4. Die Methode
 * spricht ihren Namen in Kundensprache (`METHODE_TEXT`), nie das Vertragswort.
 */
export const ersatzwert = (methode: string, kennung: string): string => {
  const name = METHODE_TEXT[methode];
  if (name === undefined) throw new Error(`unbekannte Ersatzwert-Methode ${methode}`);
  return sprich('mit_ersatzwert', { methode: name, kennung });
};

/**
 * „korrigiert (Version 2)“ — Rang 80, seit 1.5 (AP-08 IP-17). Die Cloud speichert den Satz an jeder Stufe, deren
 * Version die Korrektur-Kaskade schreibt; Version 1 ist das Original und hat ihn nie.
 */
export const korrigiert = (version: number): string => {
  if (!Number.isInteger(version) || version < 2) throw new Error(`Version ${version} ist nie korrigiert`);
  return sprich('korrigiert', { version: String(version) });
};

/**
 * Seit 1.7 (AP-08 IP-11): je Wert des Feldes `fassung` der Route „Werte je
 * Messstelle“ der Schlüssel des Kennzeichens, das gesprochen wird.
 */
export const FASSUNG_KENNZEICHEN: Record<string, string> = {
  vorlaeufig: 'vorlaeufig',
  endgueltig: 'endgueltig',
};

/**
 * „vorläufig“ bzw. „endgültig“ — Rang 90, seit 1.7 (Captain 14.09.2026 „Ja,
 * immer zeigen“: wer eine Zahl abrechnet, muss wissen, ob sie sich noch ändern
 * kann). Gesprochen wird, was die Route für GENAU diese Periode liefert, in
 * beiden Fällen; `null` (die Route kennt keine Fassung) spricht nichts — nie
 * „endgültig“ als Vorgabe. Ein fremder Wert (auch ein Zustandswort) wird nicht
 * gesprochen.
 */
export const fassung = (wert: string | null): string | null => {
  if (wert === null) return null;
  if (!Object.prototype.hasOwnProperty.call(FASSUNG_KENNZEICHEN, wert)) throw new Error(`unbekannte Fassung ${wert}`);
  return sprich(FASSUNG_KENNZEICHEN[wert], {});
};

// ------------------------------------------------------------------ Grund einer fehlenden Zahl (seit 1.11)

/**
 * Seit 1.11 (AP-13 IP-1, E11 = A): der Kundensatz zu EINEM Code des Feldes
 * `grund` der Route „Werte je Messstelle“ (`MessstelleWerteWert.grund`); die
 * Art jedes Platzhalters steht in `GRUND_PLATZHALTER`.
 */
export type Grund = { code: string; muster: string; platzhalter: Record<string, string> };

/** Je Platzhalter-Art der Gründe der reguläre Ausdruck (ohne fangende Gruppen). */
export const GRUND_PLATZHALTER: Record<string, string> = {
  text: '.+',
  datum: '(?:0[1-9]|[12][0-9]|3[01])\\.(?:0[1-9]|1[0-2])\\.[0-9]{4}',
  anteil: 'positiven|negativen',
  version: '[1-9][0-9]*',
};

/** Das Wort, mit dem `anteil_nicht_gespeichert` das Feld `quellen[].anteil` beugt — nie die Fläche. */
export const GRUND_ANTEIL: Record<'positiv' | 'negativ', string> = { positiv: 'positiven', negativ: 'negativen' };

/** Die acht Gründe in der Reihenfolge der Route — je Code GENAU ein Satz. */
export const GRUENDE: Grund[] = [
  {
    code: 'keine_quelle',
    muster: 'Keine Quelle: {messstelle} hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0.',
    platzhalter: { messstelle: 'text' },
  },
  {
    code: 'quelle_teilweise',
    muster:
      'Die Quelle deckt den Zeitraum nur zum Teil: {quelle} gilt seit {ab} — die gespeicherte Zahl gehört nicht ganz dieser Messstelle.',
    platzhalter: { quelle: 'text', ab: 'datum' },
  },
  {
    code: 'anteil_nicht_gespeichert',
    muster: 'Die Quelle liest nur den {anteil} Anteil von {kanal}; eine Menge je Anteil ist nicht gespeichert.',
    platzhalter: { anteil: 'anteil', kanal: 'text' },
  },
  {
    code: 'berechnet',
    muster:
      'Für eine berechnete Messstelle gibt es hier keine gespeicherte Zahl: Stunden werden nie gespeichert, eine Formel aus Momentanwerten gar nicht.',
    platzhalter: {},
  },
  {
    code: 'noch_nicht_gebildet',
    muster: 'Noch nicht gerechnet — der Wert erscheint von selbst, Sie müssen nichts tun.',
    platzhalter: {},
  },
  {
    code: 'ohne_menge_gespeichert',
    muster: 'Dieser Zeitraum ist ohne Menge gespeichert (Stand vor der Umstellung) — der Verlauf ist bekannt, die Zahl nicht.',
    platzhalter: {},
  },
  {
    code: 'version_nicht_gespeichert',
    muster: 'Version {n} ist für diesen Zeitraum nicht gespeichert; der neueste Stand ist Version {max}.',
    platzhalter: { n: 'version', max: 'version' },
  },
  {
    code: 'version_nicht_gebildet',
    muster:
      'Eine Stunde hat keine eigenen Versionen — eine ihrer Viertelstunden trägt eine spätere Version. Die Viertelstunden zeigen sie.',
    platzhalter: {},
  },
];

/**
 * Der Satz, warum eine Zahl fehlt — seit 1.11 (AP-13 IP-1, E11 = A, D5): die
 * Karte zeigt „—“ UND diesen Satz. Sprache, keine Regel: ob ein Grund gilt,
 * entscheidet die Route. `null` (die Route nennt keinen Grund) spricht nichts;
 * ein fremder Code (auch ein Grund der Kennzahl oder ein Zustandswort) und
 * Platzhalter, die nicht GENAU die des Satzes sind, sind Programmfehler. Die
 * Werte selbst prüft er nicht — wie `sprich`.
 */
export const grundSatz = (code: string | null, werte: Record<string, string>): string | null => {
  if (code === null) return null;
  const g = GRUENDE.find((x) => x.code === code);
  if (!g) throw new Error(`unbekannter Grund ${code}`);
  const soll = Object.keys(g.platzhalter).sort().join(',');
  const ist = Object.keys(werte).sort().join(',');
  if (soll !== ist) throw new Error(`Grund ${code} braucht [${soll}], bekam [${ist}]`);
  return g.muster.replace(PLATZ, (_, name: string) => werte[name]);
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
/** Der Anfang des Verlaufs („Verlauf 85 %“) — exportiert seit AP-11 IP-13, damit die Kennzahl-Karte dasselbe Wort spricht. */
export const ABDECKUNG = 'Verlauf ';

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
    // Seit 1.7: eine Periode hat höchstens EINE Fassung — „vorläufig · endgültig“ ist doppelt.
    const fassungen = Object.values(FASSUNG_KENNZEICHEN);
    if (fassungen.includes(km.schluessel) && fassungen.some((f) => f !== km.schluessel && gesehen.has(f))) {
      v.add('kennzeichen_doppelt');
    }
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

/** Die Teile eines Kundensatzes in der Reihenfolge des Vertrags — für eine Fläche, die sie nebeneinander setzt. */
export type Teile = { zahl: string; zustand: string; abdeckung: string | null; kennzeichen: string[] };

/**
 * Der Kundensatz eines gültigen Ergebnisses in seinen Teilen (seit 1.6, AP-08
 * IP-11): zusammengefügt mit {@link TRENNER} ist es Zeichen für Zeichen
 * {@link satz}. Eine Karte stellt sie nebeneinander, formuliert aber nichts
 * um. Ein ungültiges Ergebnis wird nicht gesprochen.
 */
export const teile = (e: Ergebnis): Teile => {
  const verstoesse = pruefe(e);
  if (verstoesse.length > 0) throw new Error(`Ergebnis verletzt den Vertrag: ${verstoesse.join(', ')}`);
  return {
    zahl: zahl(e.wert, e.einheit, e.ebene),
    zustand: e.zustand,
    abdeckung: e.abdeckungProzent === null ? null : ABDECKUNG + zahl(e.abdeckungProzent, PROZENT, null),
    kennzeichen: [...e.kennzeichen],
  };
};

/**
 * Der Kundensatz eines gültigen Ergebnisses: Zahl · Zustand · Verlauf ·
 * Kennzeichen („2.304 kWh · vollständig · Verlauf 85 %“). Ein ungültiges wird
 * nicht gesprochen — die Fläche fragt vorher `pruefe`.
 */
export const satz = (e: Ergebnis): string => {
  const t = teile(e);
  return [t.zahl, t.zustand, ...(t.abdeckung === null ? [] : [t.abdeckung]), ...t.kennzeichen].join(TRENNER);
};

// ------------------------------------------------------------------ Herkunft der Menge (seit 1.6, E1)

/**
 * Je Herleitung der Quellenbindung (geschlossen, `messstelle.schema.json`) die
 * Herkunft, die am Zustandswort steht; `null` = das Wort steht allein
 * (`integration` spricht ihr Kennzeichen, ein Momentanwert hat keine Menge).
 */
export const MENGEN_HERKUNFT: Record<string, string | null> = {
  zaehlerstand: 'Menge aus Zählerständen',
  differenzen: 'Menge aus Zählerständen',
  integration: null,
  momentanwert: null,
};

/** Die Zustandswörter, an denen eine Herkunft stehen darf. */
export const HERKUNFT_ZUSTAENDE: string[] = [VOLLSTAENDIG, UNVOLLSTAENDIG];

/**
 * E1 — das Zustandswort mit der Herkunft seiner Menge: „vollständig (Menge aus
 * Zählerständen)“, damit es neben „Verlauf 85 %“ lesbar ist. Nur an
 * vollständig/unvollständig, nur MIT Zahl; ohne Herleitung (berechnete
 * Messstelle) steht das Wort allein. Ein fremdes Wort wird nicht gesprochen.
 */
export const zustandMitHerkunft = (zustand: string, herleitung: string | null, wert: Betrag): string => {
  if (!ZUSTAENDE.some((z) => z.wort === zustand)) throw new Error(`unbekannter Zustand ${zustand}`);
  if (herleitung !== null && !Object.prototype.hasOwnProperty.call(MENGEN_HERKUNFT, herleitung)) {
    throw new Error(`unbekannte Herleitung ${herleitung}`);
  }
  const herkunft = herleitung === null ? null : MENGEN_HERKUNFT[herleitung];
  if (herkunft === null || wert === null || !HERKUNFT_ZUSTAENDE.includes(zustand)) return zustand;
  return `${zustand} (${herkunft})`;
};

// ------------------------------------------------------------------ Rundung (E11)

export const EBENEN = ['viertelstunde', 'stunde', 'tag', 'monat', 'jahr'];

export const KWH = 'kWh';
export const KW = 'kW';
export const PROZENT = '%';
export const KUBIKMETER = 'm³';
/** Scheinleistung — gemessen eine Nachkommastelle wie kW (E11, seit 1.2). */
export const KVA = 'kVA';
/** Blindarbeit — Arbeit wie die Wirkarbeit, darum dieselben Stellen je Ebene wie kWh (seit 1.3). */
export const KVARH = 'kvarh';
/**
 * Scheinarbeit — Arbeit wie die Wirkarbeit, darum dieselben Stellen je Ebene wie kWh, aber eine EIGENE
 * Anzeige-Einheit: Scheinarbeit ist nicht in Wirkarbeit umrechenbar (seit 1.8).
 */
export const KVAH = 'kVAh';

export type Stellen = { einheit: string; ebene: string | null; stellen: number };

/** Die Stellen je Einheit und Ebene; `ebene: null` = für jede Ebene gleich. */
export const STELLEN: Stellen[] = [
  { einheit: KWH, ebene: 'viertelstunde', stellen: 1 },
  { einheit: KWH, ebene: 'stunde', stellen: 1 },
  { einheit: KWH, ebene: 'tag', stellen: 0 },
  { einheit: KWH, ebene: 'monat', stellen: 0 },
  { einheit: KWH, ebene: 'jahr', stellen: 0 },
  { einheit: KVARH, ebene: 'viertelstunde', stellen: 1 },
  { einheit: KVARH, ebene: 'stunde', stellen: 1 },
  { einheit: KVARH, ebene: 'tag', stellen: 0 },
  { einheit: KVARH, ebene: 'monat', stellen: 0 },
  { einheit: KVARH, ebene: 'jahr', stellen: 0 },
  { einheit: KVAH, ebene: 'viertelstunde', stellen: 1 },
  { einheit: KVAH, ebene: 'stunde', stellen: 1 },
  { einheit: KVAH, ebene: 'tag', stellen: 0 },
  { einheit: KVAH, ebene: 'monat', stellen: 0 },
  { einheit: KVAH, ebene: 'jahr', stellen: 0 },
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
  else if (ebene === null && (einheit === KWH || einheit === KVARH || einheit === KVAH)) v.push('ebene_fehlt');
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

/** Anzeige-Bezug; unabhängig von der fachlichen Mengenherkunft. */
export type Wertbezug = 'gemessen' | 'vereinbart';

/**
 * E11 — die angezeigte Zahl mit Einheit: kaufmännisch gerundet auf die Stellen
 * der Ebene, Tausenderpunkt, Komma, geschütztes Leerzeichen („2.304 kWh“,
 * „96,5 kW“, „85 %“). Kein Wert ist „—“, nie 0. Gerechnet wird damit nie.
 * Vereinbarte Werte ohne angehängte Nullen; echte Dezimalstellen bleiben exakt (seit 1.12).
 */
export const zahl = (wert: Betrag, einheit: string, ebene: string | null, wertbezug: Wertbezug = 'gemessen'): string => {
  const s = stellen(einheit, ebene);
  if (wert === null) return OHNE_ZAHL;
  const d = zuDez(wert);
  if (wertbezug === 'vereinbart') {
    while (d.e > 0 && d.z % 10n === 0n) {
      d.z /= 10n;
      d.e--;
    }
    return text(d, einheit);
  }
  return text(dezRunde(d, s), einheit);
};

/**
 * Dieselbe Schreibweise wie `zahl` mit FESTEN Stellen — für eine Einheit ohne Ebene: der Quotient
 * einer Kennzahl („0,15 kWh je Stück“, AP-11 U4, `kennzahl.md`). Additiv seit AP-11 IP-3.
 */
export const zahlMitStellen = (wert: Betrag, stellen: number, einheit: string): string =>
  wert === null ? OHNE_ZAHL : text(dezRunde(zuDez(wert), stellen), einheit);

/**
 * Die Anzeige-Einheit einer GESPEICHERTEN Einheit (seit 1.3, Ableitung aus E11): gespeichert bleibt,
 * was der Zähler liefert; angezeigt wird kWh · kvarh · kVAh (seit 1.8, nie als kWh) · m³ —
 * „1.482.300 kWh“, nie „1.482,3 MWh“.
 * `faktor`: gespeicherter Wert × faktor ÷ teiler = Wert in der Anzeige-Einheit; `teiler` (seit 1.8,
 * fehlt = 1) für Faktoren ohne endlichen Dezimalbruch (Wmin → kWh ÷ 60000).
 */
export type AnzeigeEinheit = { gespeichert: string; angezeigt: string; faktor: string; teiler?: string };

export const ANZEIGE_EINHEITEN: AnzeigeEinheit[] = [
  { gespeichert: 'Wh', angezeigt: KWH, faktor: '0.001' },
  { gespeichert: 'kWh', angezeigt: KWH, faktor: '1' },
  { gespeichert: 'MWh', angezeigt: KWH, faktor: '1000' },
  { gespeichert: 'Wmin', angezeigt: KWH, faktor: '1', teiler: '60000' },
  { gespeichert: 'varh', angezeigt: KVARH, faktor: '0.001' },
  { gespeichert: 'kvarh', angezeigt: KVARH, faktor: '1' },
  { gespeichert: 'VAh', angezeigt: KVAH, faktor: '0.001' },
  { gespeichert: 'kVAh', angezeigt: KVAH, faktor: '1' },
  { gespeichert: KUBIKMETER, angezeigt: KUBIKMETER, faktor: '1' },
];

/** Die Ebene, deren Stellen eine Menge IN einem Kennzeichen spricht — ein Satz rundet auf jeder Ebene gleich. */
export const KENNZEICHEN_EBENE = 'viertelstunde';

/** Die Verstöße einer gespeicherten Einheit und Ebene; leer = anzeigbar. */
export const pruefeMenge = (gespeichert: string, ebene: string | null): Verstoss[] => {
  const a = ANZEIGE_EINHEITEN.find((x) => x.gespeichert === gespeichert);
  return a ? pruefeZahl(a.angezeigt, ebene) : ['einheit_unbekannt'];
};

/**
 * E11 für eine Menge in ihrer GESPEICHERTEN Einheit: in die Anzeige-Einheit umgerechnet, dann {@link zahl}.
 * Mit einem `teiler` wird der EXAKTE Quotient kaufmännisch gerundet („2999 Wmin“ → „0,0 kWh“).
 */
export const menge = (wert: Betrag, gespeichert: string, ebene: string | null): string => {
  const v = pruefeMenge(gespeichert, ebene);
  if (v.length > 0) throw new Error(`keine Anzeige für ${gespeichert} / ${ebene}: ${v.join(', ')}`);
  const a = ANZEIGE_EINHEITEN.find((x) => x.gespeichert === gespeichert)!;
  if (wert === null) return zahl(null, a.angezeigt, ebene);
  const w = zuDez(wert);
  const f = dez(a.faktor);
  const produkt = { z: w.z * f.z, e: w.e + f.e };
  if (a.teiler === undefined) return zahl(dezText(produkt), a.angezeigt, ebene);
  return zahl(dezText(dezTeile(produkt, Number(a.teiler), stellen(a.angezeigt, ebene))), a.angezeigt, ebene);
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
 * Der Zusatz der Zeitzone AN einem Zeitpunkt: „MEZ“/„MESZ“ bei Normalzeit UTC+01:00, sonst der
 * Offset — dieselbe Regel wie der Zusatz von `uhr`. Additiv seit AP-12 IP-3 für den Kopf eines
 * Berichts („Datenstand 10.11.2026 08:55 (MEZ)“, `bericht.md` D5).
 */
export const zoneKurz = (zeit: number, zone: string): string => {
  const offset = offsetMinuten(zeit, zone);
  const normalzeit = offsetMinuten(Date.UTC(new Date(zeit + offset * 60000).getUTCFullYear(), 0, 1), zone);
  return zusatz(normalzeit, offset);
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
