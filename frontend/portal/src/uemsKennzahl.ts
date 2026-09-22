/**
 * Die Regeln der KENNZAHL (UEMS AP-11 IP-3) — der TypeScript-Zwilling zu
 * `services/api .../uems/KennzahlRegeln.java`, beide gegen `docs/contracts/v2/kennzahl-vectors.json`.
 *
 * Eine Kennzahl TEILT: Menge je Bezugsgröße (`quotient`), Teil am Ganzen (`anteil`), Summe durch
 * Summe über Kennzahlen oder Teilperioden (`zusammenfassung`). Ein Mittel von Quotienten bildet
 * dieses Modul nirgends — es gibt keine Funktion, die durch die Zahl der Teile teilt.
 *
 * Wiederverwendet, nicht kopiert (E1): der Kreis ist `zyklus` aus `uemsMessstelleFormel.ts`, die
 * Grenzen einer Periode `spanneVon` aus `bezugsPeriode.ts`, Zahl und Einheit einer Anzeige
 * `uemsErgebnis.ts`. Den Eintrag einer Fassung, die Fassung eines Tages und den Stichtag eines
 * Stammdatums prüft nur der Java-Zwilling (`zwillinge_grund` der Vektor-Datei); wer anlegen darf,
 * entscheidet `rechte.darf`.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr. Noch ruft keine Fläche an (AP-11 IP-13 ff.).
 */
import { dez, dezRunde, dezText, dezVergleich, halbAuf, type Dez } from './dez';
import { dezKuerze, dezMal, dezMinus, dezPlus } from './uemsBilanz';
import { mitternacht, spanneVon, tagPlus } from './bezugsPeriode';
import {
  ANZEIGE_EINHEITEN,
  KEINE_WERTE,
  MIT_ERSATZWERT,
  OHNE_ZAHL as ERGEBNIS_OHNE_ZAHL,
  PROZENT,
  UNVOLLSTAENDIG,
  VOLLSTAENDIG,
  zahl,
  zahlMitStellen,
} from './uemsErgebnis';
import { zyklus as formelZyklus } from './uemsMessstelleFormel';
import { datumText } from './uemsOrtsbaum';

// ============================================================ Vokabulare (§7)

export const QUOTIENT = 'quotient';
export const ANTEIL = 'anteil';
export const ZUSAMMENFASSUNG = 'zusammenfassung';
export const RECHENFORMEN = [QUOTIENT, ANTEIL, ZUSAMMENFASSUNG];
export const RECHENFORMEN_VORGESEHEN = ['produkt'];
export const MESSSTELLE = 'messstelle';
export const BEZUGSGROESSE = 'bezugsgroesse';
export const KENNZAHL = 'kennzahl';
/**
 * Wie eine BEZUGSFLÄCHE der Ortsstruktur in einer ANFRAGE genannt wird (§3): `kennzeichen` ist dann das
 * Kurzzeichen des Standorts, Gebäudes oder Bereichs. Gespeichert wird daraus eine Bezugsgröße mit Wertart
 * `stammdatum` in m² — darum kein Wort in `EINGANG_ARTEN`, sondern nur in `EINGANG_ARTEN_ANFRAGE`.
 */
export const BEZUGSFLAECHE = 'bezugsflaeche';
export const EINGANG_ARTEN = [MESSSTELLE, BEZUGSGROESSE, KENNZAHL];
export const EINGANG_ARTEN_ANFRAGE = [MESSSTELLE, BEZUGSGROESSE, BEZUGSFLAECHE, KENNZAHL];
export const EINGANG_ROLLEN = ['zaehler', 'nenner', 'paar'];
export const PERIODENWERT = 'periodenwert';
export const STAMMDATUM = 'stammdatum';
export const STAND = 'stand';
export const MOMENTANWERT = 'Momentanwert';
export const WIRKSAM = 'wirksam';
export const ZURUECKGENOMMEN = 'zurueckgenommen';
export const PERIODEN = ['tag', 'woche', 'monat', 'jahr'];
export const GELTUNG_ARTEN = ['unternehmen', 'standort', 'gebaeude', 'bereich', 'prozess', 'kostenstelle', 'messstelle'];
export const ZUSTAND_RANG = [VOLLSTAENDIG, MIT_ERSATZWERT, UNVOLLSTAENDIG, KEINE_WERTE];
export const UNTERGRENZE = 'untergrenze';
export const OBERGRENZE = 'obergrenze';
export const UNBESTIMMT = 'unbestimmt';
export const RICHTUNGEN = [UNTERGRENZE, OBERGRENZE, UNBESTIMMT];
export const NENNER_FEHLT = 'nenner_fehlt';
export const NENNER_NULL = 'nenner_null';
export const ZAEHLER_FEHLT = 'zaehler_fehlt';
export const PERIODE_NICHT_ZU_ENDE = 'periode_nicht_zu_ende';
export const VOR_BESTEHEN = 'vor_bestehen';
export const GRUENDE_OHNE_ZAHL = [
  NENNER_FEHLT, NENNER_NULL, ZAEHLER_FEHLT, PERIODE_NICHT_ZU_ENDE, VOR_BESTEHEN, 'haengt_an_kreis', 'eingang_archiviert',
];
export const PERIODE_PASST_NICHT = 'periode_passt_nicht';
export const EINHEIT_UNPASSEND = 'einheit_unpassend';
export const GROESSE_UNBEKANNT = 'groesse_unbekannt';
export const EINGANG_AUSSERHALB_GELTUNG = 'eingang_ausserhalb_geltung';
export const FORMEL_ZYKLUS = 'formel_zyklus';
export const GELTUNG_UNBEKANNT = 'geltung_unbekannt';
export const EINGANG_UNBEKANNT = 'eingang_unbekannt';
export const RECHENFORM_UNBEKANNT = 'rechenform_unbekannt';
export const ANFRAGE_UNGUELTIG = 'anfrage_ungueltig';
export const FEHLER = [
  PERIODE_PASST_NICHT, EINHEIT_UNPASSEND, GROESSE_UNBEKANNT, EINGANG_AUSSERHALB_GELTUNG, FORMEL_ZYKLUS,
  'fassung_ueberlappt', GELTUNG_UNBEKANNT, EINGANG_UNBEKANNT, RECHENFORM_UNBEKANNT, ANFRAGE_UNGUELTIG,
];
export const MIT_WERT = 'mit_wert';
export const HINWEIS_OHNE_WERT = 'hinweis_ohne_wert';
export const NICHT_SICHTBAR = 'nicht_sichtbar';
export const SICHTBARKEIT = [MIT_WERT, HINWEIS_OHNE_WERT, NICHT_SICHTBAR];
export const PROTOKOLL = ['kennzahl_fassung_eingetragen', 'kennzahl_geaendert', 'kennzahl_archiviert'];
export const EREIGNISSE_RESERVIERT = ['correction/bezugsgroesse', 'kennzahl_neu_gebildet/kennzahl'];
export const STANDORT = 'standort';
export const UNTERNEHMEN = 'unternehmen';
/** G1: Rechte-Geltungsbereich je Fach-Geltungsbereich. */
export const RECHTE_GELTUNG: Record<string, string> = {
  unternehmen: UNTERNEHMEN, standort: STANDORT, gebaeude: STANDORT, bereich: STANDORT,
  prozess: UNTERNEHMEN, kostenstelle: UNTERNEHMEN, messstelle: STANDORT,
};
export const KENNUNG: Record<string, string> = {
  standort: 'kennzahl.standort_definieren',
  unternehmen: 'kennzahl.unternehmen_definieren',
};
export const ANSEHEN = 'messwerte.ansehen';
export const RECHTE = ['kennzahl.standort_definieren', 'kennzahl.unternehmen_definieren', ANSEHEN];
export const VORLAEUFIG = 'vorläufig';
export const ENDGUELTIG = 'endgültig';

// ============================================================ Perioden (E3)

export const AUFGEHEN: Record<string, string[]> = {
  tag: ['tag', 'woche', 'monat', 'jahr'], woche: ['woche'], monat: ['monat', 'jahr'], jahr: ['jahr'],
};
export type PeriodenWoerter = { werte: string; werte_dativ: string; wert: string; je: string; teile: string; ende: string };
export const PERIODEN_WOERTER: Record<string, PeriodenWoerter> = {
  tag: { werte: 'Tageswerte', werte_dativ: 'Tageswerten', wert: 'Tageswert', je: 'Tag', teile: 'Tage', ende: 'Tagesende' },
  woche: { werte: 'Wochenwerte', werte_dativ: 'Wochenwerten', wert: 'Wochenwert', je: 'Woche', teile: 'Wochen', ende: 'Ende der Woche' },
  monat: { werte: 'Monatswerte', werte_dativ: 'Monatswerten', wert: 'Monatswert', je: 'Monat', teile: 'Monate', ende: 'Monatsende' },
  jahr: { werte: 'Jahreswerte', werte_dativ: 'Jahreswerten', wert: 'Jahreswert', je: 'Jahr', teile: 'Jahre', ende: 'Jahresende' },
};
export const MONATSNAMEN = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ============================================================ Zahlen und Einheiten (E11)

export const WERT_NACHKOMMASTELLEN = 10;
export const VERGLEICH_NACHKOMMASTELLEN = 4;
export const ANZEIGE_NACHKOMMASTELLEN = 2;
export const ANTEIL_FAKTOR = '100';
export const JE = ' je ';
export const EINHEIT_TRENNER = '/';
export const EINZAHL: Record<string, string> = { Personen: 'Person', Schichten: 'Schicht' };
export const OHNE_ZAHL = ERGEBNIS_OHNE_ZAHL;
const NBSP = String.fromCharCode(160);
export const VERBOTENE_WOERTER = ['Mittel', 'Durchschnitt', 'KPI', 'Metrik', 'Kenngröße', 'Dashboard', 'Widget', 'Template'];

// ============================================================ Kundensätze (§5.8)

export const SAETZE: Record<string, string> = {
  periode_zu_grob: '{objekt} führt {q_werte}. Eine Kennzahl je {g_je} ist damit nicht bildbar — ein {q_wert} wird nie auf {g_teile} verteilt.',
  periode_geht_nicht_auf: '{objekt} führt {q_werte}. Eine Kennzahl je {g_je} ist daraus nicht bildbar — {q_werte} gehen nicht restlos in {g_werte_dativ} auf.',
  nur_stammdaten: 'Eine Kennzahl braucht mindestens einen Eingang mit Werten je Periode — Stammdaten allein haben keine Periode.',
  zusammenfassung_zu_klein: 'Eine Zusammenfassung braucht mindestens zwei Kennzahlen.',
  einheit_anteil: 'Ein Anteil braucht zwei Werte derselben Größe — {zaehler} ({zaehler_einheit}) und {nenner} ({nenner_einheit}) ergeben einen Quotienten, keinen Anteil.',
  einheit_paare: 'Eine Zusammenfassung braucht Kennzahlen derselben Rechenform und Einheit — {erste} ({erste_einheit}) und {andere} ({andere_einheit}) passen nicht zusammen.',
  einheit_momentanwert: '{objekt} ist ein Momentanwert ({einheit}) — eine Kennzahl rechnet nur mit Mengen.',
  einheit_stand: '{objekt} führt Stände — eine Kennzahl rechnet nur mit Werten je Periode oder einem Stammdatum.',
  einheit_verhaeltnis: '{objekt} ist schon ein Verhältnis ({einheit}) — daraus entsteht keine prüfbare Einheit.',
  groesse_unbekannt: 'Dieser Messwert hat keine Vertrags-Messgröße — er kann keine Menge sein.',
  eingang_ausserhalb_geltung: '{objekt} liegt in {eingang_standort} — eine Kennzahl für {kennzahl_standort} kann sie nicht lesen.',
  formel_zyklus: 'Diese Berechnung würde im Kreis laufen: {kette}. Eine Kennzahl kann sich nicht selbst enthalten.',
  eingang_unbekannt: 'Die {art} {objekt} gibt es nicht.',
  rechenform_unbekannt: 'Diese Rechenform gibt es noch nicht.',
  geltung_unbekannt_unternehmen: 'Dieses Unternehmen gibt es nicht (mehr).',
  geltung_unbekannt_standort: 'Diesen Standort gibt es nicht (mehr).',
  geltung_unbekannt_gebaeude: 'Dieses Gebäude gibt es nicht (mehr).',
  geltung_unbekannt_bereich: 'Diesen Bereich gibt es nicht (mehr).',
  geltung_unbekannt_prozess: 'Diesen Prozess gibt es nicht (mehr).',
  geltung_unbekannt_kostenstelle: 'Diese Kostenstelle gibt es nicht (mehr).',
  geltung_unbekannt_messstelle: 'Diese Messstelle gibt es nicht (mehr).',
  nenner_fehlt: 'Für {periode} fehlt der Wert der Bezugsgröße {objekt}.',
  nenner_fehlt_messstelle: 'Für {periode} fehlt der Wert von {objekt}.',
  zaehler_fehlt: 'Für {periode} fehlt die Menge {objekt}.',
  nenner_null: `Nenner 0 (0${NBSP}{einheit}) — ein Wert je {einheit_je} ist ohne {einheit} nicht bildbar.`,
  periode_nicht_zu_ende: 'Der Wert der Bezugsgröße für {periode} kann erst nach {ende} eingegeben werden.',
  anzeige_untergrenze: 'mindestens {zahl}',
  anzeige_obergrenze: 'höchstens {zahl}',
  wort_messstelle: 'Messstelle',
  wort_bezugsgroesse: 'Bezugsgröße',
  wort_kennzahl: 'Kennzahl',
};

const fuelle = (vorlage: string, werte: Record<string, string>): string =>
  Object.entries(werte).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), vorlage);

// ============================================================ Kennzeichen (ergebnis-zustand 1.9)

export const PLATZHALTER: Record<string, string> = {
  datum: '(?:0[1-9]|[12][0-9]|3[01])\\.(?:0[1-9]|1[0-2])\\.[0-9]{4}',
  text: '.+',
  bezeichnung: '(?!Berechnung\\b).+',
  objekt: '(?:MS-[0-9]{2,}|BZ-[0-9]+|KZ-[0-9]{4,})',
  geltung: '(?:U|[A-Z]{1,2}-[0-9]+|[0-9]{4})',
  ganzzahl: '(?:0|[1-9][0-9]*)',
  ganzzahl_ab_2: '(?:[2-9]|[1-9][0-9]+)',
  wort: '(?:Gebäuden|Standorten|Bereichen|Prozessen|Kostenstellen|Messstellen|Kennzahlen|Tagen|Wochen|Monaten|Jahren|Systemen)',
};

export type Kennzeichen = {
  schluessel: string;
  muster: string;
  platzhalter: Record<string, string>;
  rang: number;
  herkunft: string;
  stelle: string;
  ohne_zahl: boolean;
};

export const BERECHNET_KENNZAHL = 'berechnet (Kennzahl)';
export const GEWICHTET = 'gewichtet (Summe ÷ Summe)';
export const RICHTUNG_UNBESTIMMT = 'Richtung unbestimmt — Menge und Bezugsgröße unvollständig';
export const UNPLAUSIBEL_UEBER_100 = `unplausibel (über 100${NBSP}%)`;
export const UNPLAUSIBEL_NEGATIV = 'unplausibel (negativ)';

const k = (
  schluessel: string, muster: string, platzhalter: Record<string, string>, rang: number, herkunft: string,
  stelle: string, ohne_zahl: boolean,
): Kennzeichen => ({ schluessel, muster, platzhalter, rang, herkunft, stelle, ohne_zahl });
const T = { text: 'text' };

export const KENNZEICHEN: Kennzeichen[] = [
  k('berechnet_kennzahl', BERECHNET_KENNZAHL, {}, 10, 'eigen', 'wert', false),
  k('enthaelt_berechnet', 'enthält berechnet ({text})', T, 20, 'geerbt', 'wert', false),
  k('enthaelt_verteilt', 'enthält verteilt ({text})', T, 21, 'geerbt', 'wert', false),
  k('gewichtet', GEWICHTET, {}, 30, 'eigen', 'wert', false),
  k('untergrenze', 'Untergrenze — Menge unvollständig ({text})', T, 40, 'eigen', 'wert', false),
  k('obergrenze', 'Obergrenze — Bezugsgröße unvollständig ({text})', T, 40, 'eigen', 'wert', false),
  k('richtung_unbestimmt', RICHTUNG_UNBESTIMMT, {}, 40, 'eigen', 'wert', false),
  k('nenner_null', 'Nenner 0 ({text})', T, 41, 'eigen', 'wert', true),
  k('ab', 'ab {datum}', { datum: 'datum' }, 50, 'geerbt', 'wert', false),
  k('mit_ersatzwert', 'mit Ersatzwert ({text})', T, 51, 'geerbt', 'wert', false),
  k('stammdatum_geaendert', '{bezeichnung} geändert am {datum} ({wechsel})', { bezeichnung: 'bezeichnung', datum: 'datum', wechsel: 'text' }, 52, 'geerbt', 'wert', false),
  k('betriebszeit_annahme', 'aus Leistung über {text} kW (Annahme)', T, 53, 'geerbt', 'wert', false),
  k('berechnung_geaendert_am', 'Berechnung geändert am {datum} (Fassung {von} → {nach})', { datum: 'datum', von: 'ganzzahl', nach: 'ganzzahl_ab_2' }, 55, 'eigen', 'wert', false),
  k('x_von_y', '{mit} von {gesamt} {wort}', { mit: 'ganzzahl', gesamt: 'ganzzahl', wort: 'wort' }, 60, 'beides', 'wert', false),
  k('x_von_y_fehlt', '{mit} von {gesamt} {wort} ({fehlt})', { mit: 'ganzzahl', gesamt: 'ganzzahl', wort: 'wort', fehlt: 'text' }, 60, 'eigen', 'wert', false),
  k('ab_mit_geltung', '{geltung} ab {datum}', { geltung: 'geltung', datum: 'datum' }, 70, 'geerbt', 'wert', false),
  k('unplausibel_ueber_100', UNPLAUSIBEL_UEBER_100, {}, 80, 'eigen', 'wert', false),
  k('unplausibel_negativ', UNPLAUSIBEL_NEGATIV, {}, 80, 'eigen', 'wert', false),
  k('eingang_ausserhalb', 'Eingang {objekt} seit {datum} außerhalb von {name}', { objekt: 'objekt', datum: 'datum', name: 'text' }, 81, 'eigen', 'wert', false),
  k('bezugsgroesse_archiviert', 'Bezugsgröße archiviert ({objekt})', { objekt: 'objekt' }, 82, 'eigen', 'wert', false),
  k('eingang_archiviert', 'Eingang archiviert ({objekt})', { objekt: 'objekt' }, 82, 'eigen', 'wert', false),
  k('korrigiert', 'korrigiert (Version {version})', { version: 'ganzzahl_ab_2' }, 90, 'eigen', 'wert', true),
  k('berechnung_geaendert', 'Berechnung geändert (Fassung {fassung})', { fassung: 'ganzzahl_ab_2' }, 90, 'eigen', 'wert', true),
  k('nenner_zurueckgenommen', 'Nenner zurückgenommen ({text})', T, 91, 'eigen', 'wert', true),
  k('stichtag', 'Stichtag {datum}', { datum: 'datum' }, 100, 'eigen', 'eingang', false),
];

export type Erbregel = { muster: string; als: string; von: string[] };

/** Q8: welcher Satz eines Eingangs an die Kennzahl erbt, und als was. */
export const ERBEND: Erbregel[] = [
  { muster: '^berechnet \\((?!Kennzahl\\)$).+\\)$', als: 'enthält {0}', von: [MESSSTELLE] },
  { muster: '^verteilt \\(.+\\)$', als: 'enthält {0}', von: [MESSSTELLE] },
  { muster: '^enthält (?:berechnet|verteilt) \\(.+\\)$', als: '{0}', von: [MESSSTELLE] },
  { muster: '^ab \\d{2}\\.\\d{2}\\.\\d{4}$', als: '{0}', von: [MESSSTELLE, BEZUGSGROESSE] },
  { muster: '^ab \\d{2}\\.\\d{2}\\.\\d{4}$', als: '{geltung} {0}', von: [KENNZAHL] },
  { muster: '^mit Ersatzwert \\(.+\\)$', als: '{0}', von: [MESSSTELLE] },
  { muster: '^(?!Berechnung\\b).+ geändert am \\d{2}\\.\\d{2}\\.\\d{4} \\(.+\\)$', als: '{0}', von: [BEZUGSGROESSE] },
  { muster: '^\\d+ von \\d+ Systemen$', als: '{0}', von: [MESSSTELLE] },
  { muster: '^aus Leistung über .+ kW \\(Annahme\\)$', als: '{0}', von: [BEZUGSGROESSE, KENNZAHL] },
];

const MUSTER = new Map<string, RegExp>(
  KENNZEICHEN.map((kz) => {
    const teile = kz.muster.split(/(\{[a-z_]+\})/);
    const quelle = teile
      .map((t) => {
        const m = /^\{([a-z_]+)\}$/.exec(t);
        return m ? `(?:${PLATZHALTER[kz.platzhalter[m[1]]]})` : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    return [kz.schluessel, new RegExp(`^${quelle}$`)];
  }),
);

/** Das EINE Muster, auf das ein Satz passt — `null`, wenn keines oder mehrere passen. */
export const erkenne = (satz: string): Kennzeichen | null => {
  const passend = KENNZEICHEN.filter((kz) => MUSTER.get(kz.schluessel)!.test(satz));
  return passend.length === 1 ? passend[0] : null;
};

/** Die Verstöße einer Kennzeichen-Liste eines Werts; leer = in Ordnung. */
export const kennzeichenPruefen = (liste: string[]): string[] => {
  let unbekannt = false;
  let stelle = false;
  let doppelt = false;
  let reihenfolge = false;
  const gesehen = new Set<string>();
  let rang = 0;
  for (const satz of liste) {
    if (gesehen.has(satz)) doppelt = true;
    gesehen.add(satz);
    const kz = erkenne(satz);
    if (!kz) {
      unbekannt = true;
      continue;
    }
    if (kz.stelle !== 'wert') stelle = true;
    if (kz.rang < rang) reihenfolge = true;
    rang = Math.max(rang, kz.rang);
  }
  return [
    ...(unbekannt ? ['kennzeichen_unbekannt'] : []),
    ...(stelle ? ['kennzeichen_stelle'] : []),
    ...(doppelt ? ['kennzeichen_doppelt'] : []),
    ...(reihenfolge ? ['kennzeichen_reihenfolge'] : []),
  ];
};

const rangVon = (satz: string): number => {
  const kz = erkenne(satz);
  if (!kz) throw new Error(`kein Kennzeichen einer Kennzahl: ${satz}`);
  return kz.rang;
};

/** Jeder Satz einmal, nach Rang geordnet; gleicher Rang bleibt in der Folge der Entstehung. */
export const ordne = (saetze: string[]): string[] => [...new Set(saetze)].sort((a, b) => rangVon(a) - rangVon(b));

/** Die Sätze eines Eingangs, die nach Q8 erben — in ihrer Folge. */
export const erbe = (art: string, geltung: string | null, kennzeichen: string[]): string[] => {
  const raus: string[] = [];
  for (const satz of kennzeichen) {
    const regel = ERBEND.find((r) => r.von.includes(art) && new RegExp(r.muster).test(satz));
    if (regel) raus.push(regel.als.replace('{0}', satz).replace('{geltung} ', geltung === null ? '' : `${geltung} `));
  }
  return raus;
};

// ============================================================ Wert (Q1–Q9, V3, E5)

export type Periode = { art: string; schluessel: string };
export type Eingang = {
  art: string;
  objekt: string;
  name: string | null;
  geltung: string | null;
  wertart: string | null;
  status: string | null;
  wert: Dez | null;
  einheit: string;
  zustand: string | null;
  abdeckung_prozent: Dez | null;
  endgueltig: boolean;
  ursache: string | null;
  kennzeichen: string[];
};
export type Teil = {
  objekt: string;
  geltung: string | null;
  zaehler: Dez | null;
  nenner: Dez | null;
  zustand: string;
  richtung: string | null;
  abdeckung_prozent: Dez | null;
  endgueltig: boolean;
  kennzeichen: string[];
};
export type Antrag = {
  rechenform: string;
  periode: Periode;
  einheit: string;
  zaehler: Eingang | null;
  nenner: Eingang | null;
  komplement: boolean;
  mengen_nicht_negativ: boolean;
  teile: Teil[] | null;
  teile_art: string | null;
  teile_wort: string | null;
  teile_periode_art: string | null;
  teile_rechenform: string | null;
  bestehen_ab: string | null;
  hinweise: string[];
  bisher: { version: number; endgueltig: boolean } | null;
  anlass: { art: string; fassung: number | null } | null;
};
export type Ergebnis = {
  wert: Dez | null;
  zaehler: Dez | null;
  nenner: Dez | null;
  zustand: string;
  richtung: string | null;
  grund: string | null;
  abdeckung_prozent: Dez;
  fassung: string | null;
  version: number | null;
  kennzeichen: string[];
  anzeige: string;
  kundensatz: string | null;
};

const HUNDERT = dez(ANTEIL_FAKTOR);
const EINS = dez('1');
const NULL_DEZ = dez('0');
const vorzeichen = (d: Dez): number => (d.z < 0n ? -1 : d.z > 0n ? 1 : 0);
const kleiner = (a: Dez, b: Dez): Dez => (dezVergleich(a, b) <= 0 ? a : b);

/** Geteilt, kaufmännisch auf `stellen` gerundet — die Rechnung, die `BigDecimal.divide(…, HALF_UP)` macht. */
const geteilt = (a: Dez, b: Dez, stellen: number): Dez => ({
  z: halbAuf(a.z * 10n ** BigInt(b.e + stellen), b.z * 10n ** BigInt(a.e)),
  e: stellen,
});

type Seite = { wert: Dez | null; zustand: string; abdeckung: Dez; endgueltig: boolean; zurueckgenommen: boolean };

/** B3/U2: eine Messstelle auf ihre Anzeige-Einheit (Wh → kWh); eine Bezugsgröße wird nie umgerechnet. */
const normiert = (e: Eingang): Dez => {
  const ae = e.art === MESSSTELLE ? ANZEIGE_EINHEITEN.find((a) => a.gespeichert === e.einheit) : undefined;
  if (!ae || e.wert === null) return e.wert as Dez;
  const mal = dezMal(e.wert, dez(ae.faktor));
  return !ae.teiler || ae.teiler === '1' ? mal : geteilt(mal, dez(ae.teiler), WERT_NACHKOMMASTELLEN);
};

const seite = (e: Eingang): Seite => {
  if (e.art === BEZUGSGROESSE && (e.wertart === PERIODENWERT || e.wertart === STAMMDATUM)) {
    const da = e.wertart === PERIODENWERT ? e.status === WIRKSAM && e.wert !== null : e.wert !== null;
    return {
      wert: da ? e.wert : null,
      zustand: da ? (e.kennzeichen.some(k => k.startsWith('aus Leistung über ')) && e.zustand === UNVOLLSTAENDIG ? UNVOLLSTAENDIG : VOLLSTAENDIG) : KEINE_WERTE,
      abdeckung: da ? e.abdeckung_prozent ?? HUNDERT : NULL_DEZ,
      endgueltig: e.endgueltig,
      zurueckgenommen: e.status === ZURUECKGENOMMEN,
    };
  }
  const keine = e.zustand === KEINE_WERTE || e.wert === null;
  return {
    wert: keine ? null : normiert(e),
    zustand: keine ? KEINE_WERTE : (e.zustand as string),
    abdeckung: e.abdeckung_prozent ?? (keine ? NULL_DEZ : HUNDERT),
    endgueltig: e.endgueltig,
    zurueckgenommen: false,
  };
};

const schlechter = (a: string, b: string): string => (ZUSTAND_RANG.indexOf(a) >= ZUSTAND_RANG.indexOf(b) ? a : b);

const version = (bisher: Antrag['bisher'], mitZahl: boolean): number | null =>
  bisher === null ? (mitZahl ? 1 : null) : bisher.endgueltig ? bisher.version + 1 : bisher.version;

const versionSatz = (a: Antrag): string[] => {
  if (a.bisher === null || !a.bisher.endgueltig) return [];
  if (a.anlass === null) throw new Error('Ein endgültiger Wert wird nur mit Anlass neu gebildet');
  return [
    a.anlass.art === 'definition'
      ? `Berechnung geändert (Fassung ${a.anlass.fassung})`
      : `korrigiert (Version ${a.bisher.version + 1})`,
  ];
};

const plausibel = (wert: Dez, anteil: boolean, mengenNichtNegativ: boolean): string[] => {
  if (anteil && dezVergleich(wert, HUNDERT) > 0) return [UNPLAUSIBEL_UEBER_100];
  if ((anteil || mengenNichtNegativ) && vorzeichen(wert) < 0) return [UNPLAUSIBEL_NEGATIV];
  return [];
};

const mitName = (e: Eingang): string => (e.name === null ? e.objekt : `${e.objekt} ${e.name}`);

/** „kWh/Stück“ → „kWh je Stück“. */
export const einheitWort = (einheit: string): string => einheit.split(EINHEIT_TRENNER).join(JE);
const einzahl = (einheit: string): string => EINZAHL[einheit] ?? einheit;

/** „November 2026“ · „02.12.2026“ · „KW 40/2026“ · „2026“. */
export const periodeText = (art: string, schluessel: string): string => {
  if (art === 'monat') return `${MONATSNAMEN[Number(schluessel.slice(5, 7)) - 1]} ${schluessel.slice(0, 4)}`;
  if (art === 'jahr') return schluessel;
  if (art === 'woche') return `KW ${Number(schluessel.slice(6))}/${schluessel.slice(0, 4)}`;
  return datumText(schluessel);
};

/** U4: „0,15 kWh je Stück“, „mindestens 30,83 kWh je Person“, „51 %“; ohne Zahl „—“. */
export const anzeige = (wert: Dez | null, einheit: string, richtung: string | null): string => {
  if (wert === null) return OHNE_ZAHL;
  const text = einheit === PROZENT
    ? zahl(dezText(wert), PROZENT, null)
    : zahlMitStellen(dezText(wert), ANZEIGE_NACHKOMMASTELLEN, einheitWort(einheit));
  if (richtung === UNTERGRENZE) return fuelle(SAETZE.anzeige_untergrenze, { zahl: text });
  if (richtung === OBERGRENZE) return fuelle(SAETZE.anzeige_obergrenze, { zahl: text });
  return text;
};

const teileQuotient = (a: Antrag): Ergebnis => {
  const zE = a.zaehler as Eingang;
  const nE = a.nenner as Eingang;
  const z = seite(zE);
  const n = seite(nE);
  const anteil = a.rechenform === ANTEIL;
  const grund = n.wert === null ? NENNER_FEHLT : vorzeichen(n.wert) === 0 ? NENNER_NULL : z.wert === null ? ZAEHLER_FEHLT : null;
  const abdeckung = kleiner(z.abdeckung, n.abdeckung);
  const v = version(a.bisher, grund === null);
  const fassung = v === null ? null : z.endgueltig && n.endgueltig ? ENDGUELTIG : VORLAEUFIG;
  if (grund !== null) {
    const periode = periodeText(a.periode.art, a.periode.schluessel);
    const kennzeichen = [
      ...(grund === NENNER_NULL ? [`Nenner 0 (${nE.objekt} ${periode}: 0${NBSP}${nE.einheit})`] : []),
      ...(n.zurueckgenommen ? [`Nenner zurückgenommen (${nE.objekt} ${periode})`] : []),
      ...versionSatz(a),
    ];
    const kundensatz = grund === NENNER_FEHLT
      ? fuelle(SAETZE[nE.art === BEZUGSGROESSE ? 'nenner_fehlt' : 'nenner_fehlt_messstelle'], { periode, objekt: mitName(nE) })
      : grund === NENNER_NULL
        ? fuelle(SAETZE.nenner_null, { einheit: nE.einheit, einheit_je: einzahl(nE.einheit) })
        : fuelle(SAETZE.zaehler_fehlt, { periode, objekt: mitName(zE) });
    return {
      wert: null, zaehler: z.wert, nenner: n.wert, zustand: KEINE_WERTE, richtung: null, grund,
      abdeckung_prozent: abdeckung, fassung, version: v, kennzeichen: ordne(kennzeichen), anzeige: OHNE_ZAHL, kundensatz,
    };
  }
  let wert = geteilt(dezMal(z.wert as Dez, anteil ? HUNDERT : EINS), n.wert as Dez, WERT_NACHKOMMASTELLEN);
  if (anteil && a.komplement) wert = dezMinus(HUNDERT, wert);
  const zustand = schlechter(z.zustand, n.zustand);
  let richtung: string | null = null;
  if (zustand === UNVOLLSTAENDIG) {
    const zu = z.zustand === UNVOLLSTAENDIG;
    const nu = n.zustand === UNVOLLSTAENDIG;
    richtung = zu && nu ? UNBESTIMMT : zu ? UNTERGRENZE : OBERGRENZE;
  }
  const kennzeichen = [
    BERECHNET_KENNZAHL,
    ...erbe(zE.art, zE.geltung, zE.kennzeichen),
    ...erbe(nE.art, nE.geltung, nE.kennzeichen),
    ...(richtung === UNTERGRENZE ? [`Untergrenze — Menge unvollständig (${zE.ursache ?? zE.objekt})`] : []),
    ...(richtung === OBERGRENZE ? [`Obergrenze — Bezugsgröße unvollständig (${nE.ursache ?? nE.objekt})`] : []),
    ...(richtung === UNBESTIMMT ? [RICHTUNG_UNBESTIMMT] : []),
    ...plausibel(wert, anteil, a.mengen_nicht_negativ),
    ...a.hinweise,
    ...versionSatz(a),
  ];
  return {
    wert, zaehler: z.wert, nenner: n.wert, zustand, richtung, grund: null, abdeckung_prozent: abdeckung, fassung,
    version: v, kennzeichen: ordne(kennzeichen), anzeige: anzeige(wert, anteil ? PROZENT : a.einheit, richtung),
    kundensatz: null,
  };
};

const ZEIT_VEREINIGT = new Set([
  'enthaelt_berechnet', 'enthaelt_verteilt', 'betriebszeit_annahme', 'mit_ersatzwert', 'stammdatum_geaendert', 'berechnung_geaendert_am',
  'eingang_ausserhalb', 'bezugsgroesse_archiviert', 'eingang_archiviert',
]);

/** Zeit: das eigene „ab …“ ersetzt jedes „ab …“ der Teile; „x von y …“ nur, wenn es in JEDER Teilperiode steht. */
const erbeZeit = (a: Antrag): string[] => {
  const teile = a.teile as Teil[];
  const raus: string[] = [];
  const [erster] = spanneVon(a.periode.schluessel, a.periode.art);
  if (a.bestehen_ab !== null && a.bestehen_ab > erster) raus.push(`ab ${datumText(a.bestehen_ab)}`);
  for (const t of teile) {
    for (const satz of t.kennzeichen) {
      const kz = erkenne(satz);
      if (!kz) continue;
      if (ZEIT_VEREINIGT.has(kz.schluessel)) raus.push(satz);
      else if (kz.schluessel === 'x_von_y' && teile.every((u) => u.kennzeichen.includes(satz))) raus.push(satz);
    }
  }
  return raus;
};

/** Q5 — Summe durch Summe über die Paare (Ebene) oder Teilperioden (Zeit) mit Zähler UND Nenner. */
const summeDurchSumme = (a: Antrag): Ergebnis => {
  const teile = a.teile as Teil[];
  const zeit = a.teile_art === 'zeit';
  const mit = teile.filter((t) => t.zaehler !== null && t.nenner !== null);
  const ohne = teile.filter((t) => t.zaehler === null || t.nenner === null);
  const anteil = a.teile_rechenform === ANTEIL;
  const summeZ = mit.reduce((s, t) => dezPlus(s, t.zaehler as Dez), NULL_DEZ);
  const summeN = mit.reduce((s, t) => dezPlus(s, t.nenner as Dez), NULL_DEZ);
  const abdeckung = mit.length === 0
    ? NULL_DEZ
    : mit.map((t) => t.abdeckung_prozent ?? HUNDERT).reduce((x, y) => kleiner(x, y));
  const grund = mit.length === 0
    ? ohne.some((t) => t.nenner === null) ? NENNER_FEHLT : ZAEHLER_FEHLT
    : vorzeichen(summeN) === 0 ? NENNER_NULL : null;
  const v = version(a.bisher, grund === null);
  const fassung = v === null ? null : teile.every((t) => t.endgueltig) ? ENDGUELTIG : VORLAEUFIG;
  if (grund !== null) {
    return {
      wert: null, zaehler: mit.length === 0 ? null : summeZ, nenner: mit.length === 0 ? null : summeN,
      zustand: KEINE_WERTE, richtung: null, grund, abdeckung_prozent: abdeckung, fassung, version: v,
      kennzeichen: ordne(versionSatz(a)), anzeige: OHNE_ZAHL, kundensatz: null,
    };
  }
  const wert = geteilt(dezMal(summeZ, anteil ? HUNDERT : EINS), summeN, WERT_NACHKOMMASTELLEN);
  let zustand = mit.map((t) => t.zustand).reduce(schlechter, VOLLSTAENDIG);
  if (ohne.length > 0) zustand = schlechter(zustand, UNVOLLSTAENDIG);
  let richtung: string | null = null;
  const kennzeichen: string[] = [BERECHNET_KENNZAHL, GEWICHTET];
  if (zustand === UNVOLLSTAENDIG) {
    const unvollstaendig = mit.filter((t) => t.zustand === UNVOLLSTAENDIG);
    const richtungen = new Set(unvollstaendig.map((t) => t.richtung ?? UNBESTIMMT));
    richtung = ohne.length > 0 || richtungen.size !== 1 ? UNBESTIMMT : [...richtungen][0];
    const welche = unvollstaendig.map((t) => t.objekt).join(', ');
    kennzeichen.push(
      richtung === UNTERGRENZE ? `Untergrenze — Menge unvollständig (${welche})`
        : richtung === OBERGRENZE ? `Obergrenze — Bezugsgröße unvollständig (${welche})`
          : RICHTUNG_UNBESTIMMT,
    );
  }
  const fehlend = ohne.map((t) => (zeit ? periodeText(a.teile_periode_art as string, t.objekt) : t.objekt));
  const xVonY = `${mit.length} von ${teile.length} ${a.teile_wort}`;
  if (ohne.length > 0) kennzeichen.push(`${xVonY} (${fehlend.join(', ')} ${ohne.length === 1 ? 'fehlt' : 'fehlen'})`);
  else if (!zeit) kennzeichen.push(xVonY);
  if (zeit) kennzeichen.push(...erbeZeit(a));
  else for (const t of mit) kennzeichen.push(...erbe(KENNZAHL, t.geltung, t.kennzeichen));
  kennzeichen.push(...plausibel(wert, anteil, a.mengen_nicht_negativ), ...a.hinweise, ...versionSatz(a));
  return {
    wert, zaehler: summeZ, nenner: summeN, zustand, richtung, grund: null, abdeckung_prozent: abdeckung, fassung,
    version: v, kennzeichen: ordne(kennzeichen), anzeige: anzeige(wert, anteil ? PROZENT : a.einheit, richtung),
    kundensatz: null,
  };
};

/** Der Wert einer Kennzahl in einer Periode — Rechenform, Qualität, Kennzeichen, Version, Anzeige. */
export const wert = (a: Antrag): Ergebnis => {
  if (a.rechenform === QUOTIENT || a.rechenform === ANTEIL) return teileQuotient(a);
  if (a.rechenform === ZUSAMMENFASSUNG) return summeDurchSumme(a);
  throw new Error(`Rechenform ${a.rechenform}`);
};

// ============================================================ Einheit (U1–U3)

export type EinheitSeite = { art: string; objekt: string; einheit: string; groesse: string | null; wertart: string | null };
export type Paar = { objekt: string; rechenform: string; einheit: string };
export type EinheitUrteil = { einheit: string | null; anzeige: string | null; fehler: string | null; kundensatz: string | null };

const einheitFehler = (fehler: string, satz: string, werte: Record<string, string>): EinheitUrteil => ({
  einheit: null, anzeige: null, fehler, kundensatz: fuelle(SAETZE[satz], werte),
});

const anzeigeEinheit = (einheit: string): string | null =>
  ANZEIGE_EINHEITEN.find((a) => a.gespeichert === einheit)?.angezeigt ?? null;

const seitenFehler = (s: EinheitSeite): EinheitUrteil | null => {
  const werte = { objekt: s.objekt, einheit: s.einheit };
  if (s.art === MESSSTELLE) {
    if (s.wertart === MOMENTANWERT) return einheitFehler(EINHEIT_UNPASSEND, 'einheit_momentanwert', werte);
    return s.groesse === null || anzeigeEinheit(s.einheit) === null ? einheitFehler(GROESSE_UNBEKANNT, 'groesse_unbekannt', {}) : null;
  }
  if (s.art === BEZUGSGROESSE) return s.wertart === STAND ? einheitFehler(EINHEIT_UNPASSEND, 'einheit_stand', werte) : null;
  return s.einheit.includes(EINHEIT_TRENNER) ? einheitFehler(EINHEIT_UNPASSEND, 'einheit_verhaeltnis', werte) : null;
};

const seitenEinheit = (s: EinheitSeite): string =>
  s.art === MESSSTELLE ? (anzeigeEinheit(s.einheit) as string) : s.art === BEZUGSGROESSE ? einzahl(s.einheit) : s.einheit;

/** U1–U3: die Ergebnis-Einheit als ungekürztes Paar, % oder die Einheit der Paare — nie geraten. */
export const einheit = (
  rechenform: string, zaehler: EinheitSeite | null, nenner: EinheitSeite | null, paare: Paar[] | null,
): EinheitUrteil => {
  if (rechenform === ZUSAMMENFASSUNG) {
    if (paare === null || paare.length < 2) return einheitFehler(ANFRAGE_UNGUELTIG, 'zusammenfassung_zu_klein', {});
    const erste = paare[0];
    const andere = paare.find((p) => p.rechenform !== erste.rechenform || p.einheit !== erste.einheit);
    if (andere) {
      return einheitFehler(EINHEIT_UNPASSEND, 'einheit_paare', {
        erste: erste.objekt, erste_einheit: erste.einheit, andere: andere.objekt, andere_einheit: andere.einheit,
      });
    }
    return { einheit: erste.einheit, anzeige: einheitWort(erste.einheit), fehler: null, kundensatz: null };
  }
  const z = zaehler as EinheitSeite;
  const n = nenner as EinheitSeite;
  const fehler = seitenFehler(z) ?? seitenFehler(n);
  if (fehler) return fehler;
  if (rechenform === ANTEIL) {
    const gleich = z.art === MESSSTELLE && n.art === MESSSTELLE && z.groesse === n.groesse && seitenEinheit(z) === seitenEinheit(n);
    return gleich
      ? { einheit: PROZENT, anzeige: PROZENT, fehler: null, kundensatz: null }
      : einheitFehler(EINHEIT_UNPASSEND, 'einheit_anteil', {
        zaehler: z.objekt, zaehler_einheit: z.einheit, nenner: n.objekt, nenner_einheit: n.einheit,
      });
  }
  const paar = `${seitenEinheit(z)}${EINHEIT_TRENNER}${seitenEinheit(n)}`;
  return { einheit: paar, anzeige: einheitWort(paar), fehler: null, kundensatz: null };
};

// ============================================================ Perioden (P1–P6)

export type PeriodenEingang = { art: string; objekt: string; name: string | null; wertart: string | null; periode_art: string | null };
export type PeriodenUrteil = { grundperiode: string | null; perioden: string[]; fehler: string | null; kundensatz: string | null };

const periodenSatz = (eingaenge: PeriodenEingang[], ziel: string): string => {
  const q = eingaenge.find((e) => !AUFGEHEN[e.periode_art as string].includes(ziel)) as PeriodenEingang;
  const qw = PERIODEN_WOERTER[q.periode_art as string];
  const gw = PERIODEN_WOERTER[ziel];
  const objekt = q.name === null ? q.objekt : `${q.objekt} ${q.name}`;
  return PERIODEN.indexOf(q.periode_art as string) > PERIODEN.indexOf(ziel)
    ? fuelle(SAETZE.periode_zu_grob, { objekt, q_werte: qw.werte, g_je: gw.je, q_wert: qw.wert, g_teile: gw.teile })
    : fuelle(SAETZE.periode_geht_nicht_auf, { objekt, q_werte: qw.werte, g_je: gw.je, g_werte_dativ: gw.werte_dativ });
};

/** P1–P3: Grundperiode = die gröbste Periode, in der alle Periodenwert-Eingänge aufgehen; nie verteilt. */
export const periode = (gewuenscht: string | null, eingaenge: PeriodenEingang[]): PeriodenUrteil => {
  const mitPeriode = eingaenge.filter((e) => e.periode_art !== null && e.wertart !== STAMMDATUM);
  if (mitPeriode.length === 0) {
    return { grundperiode: null, perioden: [], fehler: ANFRAGE_UNGUELTIG, kundensatz: SAETZE.nur_stammdaten };
  }
  const grund = PERIODEN.find(
    (p) => mitPeriode.some((e) => e.periode_art === p) && mitPeriode.every((e) => AUFGEHEN[e.periode_art as string].includes(p)),
  );
  if (grund === undefined) {
    const grobste = mitPeriode
      .map((e) => e.periode_art as string)
      .reduce((x, y) => (PERIODEN.indexOf(y) > PERIODEN.indexOf(x) ? y : x));
    return { grundperiode: null, perioden: [], fehler: PERIODE_PASST_NICHT, kundensatz: periodenSatz(mitPeriode, grobste) };
  }
  const perioden = AUFGEHEN[grund];
  if (gewuenscht !== null && !perioden.includes(gewuenscht)) {
    return { grundperiode: grund, perioden, fehler: PERIODE_PASST_NICHT, kundensatz: periodenSatz(mitPeriode, gewuenscht) };
  }
  return { grundperiode: grund, perioden, fehler: null, kundensatz: null };
};

/** P4: vor dem Bestehen eines Eingangs ist kein Fehlbestand — „ab TT.MM.JJJJ“, ganz davor keine Zeile. */
export const bestehen = (p: Periode, seit: string): { grund: string | null; kennzeichen: string[] } => {
  const [von, bis] = spanneVon(p.schluessel, p.art);
  if (seit > bis) return { grund: VOR_BESTEHEN, kennzeichen: [] };
  return { grund: null, kennzeichen: seit > von ? [`ab ${datumText(seit)}`] : [] };
};

export type LaufendUrteil = { laeuft: boolean; grund: string | null; fassung: string | null; kundensatz: string | null };

/** P6: die laufende Periode hat keinen Live-Wert; ein Periodenwert-Nenner gibt es erst nach ihrem Ende. */
export const laufend = (
  p: Periode, jetzt: string, zone: string, nennerArt: string | null, nennerWertart: string | null,
): LaufendUrteil => {
  const [, bis] = spanneVon(p.schluessel, p.art);
  const laeuft = Date.parse(jetzt) < mitternacht(tagPlus(bis, 1), zone);
  if (!laeuft) return { laeuft: false, grund: null, fassung: null, kundensatz: null };
  if (nennerArt === BEZUGSGROESSE && nennerWertart === PERIODENWERT) {
    return {
      laeuft: true, grund: PERIODE_NICHT_ZU_ENDE, fassung: null,
      kundensatz: fuelle(SAETZE.periode_nicht_zu_ende, { periode: periodeText(p.art, p.schluessel), ende: PERIODEN_WOERTER[p.art].ende }),
    };
  }
  return { laeuft: true, grund: null, fassung: VORLAEUFIG, kundensatz: null };
};

// ============================================================ Definition (Q10, E2)

export type KreisUrteil = { zyklus: boolean; kette: string[]; fehler: string | null; kundensatz: string | null };

/** Q10: der Kreis über Kennzahl-Verweise — `zyklus` der Formel-Maschine, aufgerufen, nicht kopiert. */
export const zyklus = (kennzeichen: string, verweise: string[], bestehende: Record<string, string[]>): KreisUrteil => {
  const u = formelZyklus(kennzeichen, verweise, bestehende);
  return u.zyklus
    ? { zyklus: true, kette: u.kette, fehler: FORMEL_ZYKLUS, kundensatz: fuelle(SAETZE.formel_zyklus, { kette: u.kette.join(' → ') }) }
    : { zyklus: false, kette: [], fehler: null, kundensatz: null };
};

/** E2: der geschlossene Satz der Rechenformen; `produkt` ist vorgesehen, nicht gebaut. */
export const rechenform = (form: string): { fehler: string | null; kundensatz: string | null } =>
  RECHENFORMEN.includes(form) ? { fehler: null, kundensatz: null } : { fehler: RECHENFORM_UNBEKANNT, kundensatz: SAETZE.rechenform_unbekannt };

// ============================================================ Geltung und Rechte (G1, G3, R3)

export type GeltungUrteil = {
  rechte_geltung: string; standort: string | null; kennung: string; fehler: string | null; kundensatz: string | null;
};

/** G1: der Rechte-Geltungsbereich und die Kennung zum Definieren; ein Standort-Objekt ohne Standort gibt es nicht. */
export const geltung = (geltungArt: string, standort: string | null): GeltungUrteil => {
  const rechte = RECHTE_GELTUNG[geltungArt];
  if (rechte === undefined) throw new Error(`Geltungsbereich ${geltungArt}`);
  if (rechte === STANDORT && standort === null) {
    return { rechte_geltung: rechte, standort: null, kennung: KENNUNG[rechte], fehler: GELTUNG_UNBEKANNT, kundensatz: SAETZE[`geltung_unbekannt_${geltungArt}`] };
  }
  return { rechte_geltung: rechte, standort: rechte === UNTERNEHMEN ? null : standort, kennung: KENNUNG[rechte], fehler: null, kundensatz: null };
};

export type KennzahlOrt = { rechte_geltung: string; standort: string | null; standort_name: string; geltung_name: string };
export type EingangOrt = { objekt: string; standort: string | null; standort_name: string; im_geltungsobjekt: boolean; seit: string | null };

/** G3: außerhalb des STANDORTS abgelehnt, außerhalb des Geltungsobjekts ein Kennzeichen je Periode. */
export const eingangGeltung = (kz: KennzahlOrt, e: EingangOrt): { fehler: string | null; kundensatz: string | null; kennzeichen: string[] } => {
  if (kz.rechte_geltung === STANDORT && e.standort !== null && e.standort !== kz.standort) {
    return {
      fehler: EINGANG_AUSSERHALB_GELTUNG,
      kundensatz: fuelle(SAETZE.eingang_ausserhalb_geltung, { objekt: e.objekt, eingang_standort: e.standort_name, kennzahl_standort: kz.standort_name }),
      kennzeichen: [],
    };
  }
  if (e.im_geltungsobjekt) return { fehler: null, kundensatz: null, kennzeichen: [] };
  if (e.seit === null) throw new Error('Ein Eingang außerhalb des Geltungsobjekts nennt, seit wann');
  return { fehler: null, kundensatz: null, kennzeichen: [`Eingang ${e.objekt} seit ${datumText(e.seit)} außerhalb von ${kz.geltung_name}`] };
};

/** R3 = R-A1 ∧ R-A6, R-A7 als Zeile ohne Wert — die Wahrheitswerte liefert `rechte.darf`. */
export const sichtbarkeit = (rechteGeltungImZugriff: boolean, eingangsStandorteImZugriff: boolean[], dritter: boolean): string => {
  if (rechteGeltungImZugriff && eingangsStandorteImZugriff.every(Boolean)) return MIT_WERT;
  const innen = eingangsStandorteImZugriff.some(Boolean);
  const aussen = eingangsStandorteImZugriff.some((b) => !b);
  return !dritter && innen && aussen ? HINWEIS_OHNE_WERT : NICHT_SICHTBAR;
};

// ============================================================ Vorlage und Kopie (E9)

export const vorlage = (form: string, nameVorschlag: string, zweckVorschlag: string, geltungName: string) => ({
  rechenform: form,
  name: nameVorschlag.split('{Geltungsbereich}').join(geltungName),
  zweck: zweckVorschlag,
});

export type Quelle = { kennzeichen: string; name: string; zweck: string; rechenform: string; geltung_name: string };

/** K20: Form, Name, Zweck übernommen; Eingänge, Geltungsbereich und Kennzeichen neu; Fassung 1 „gilt seit Beginn“. */
export const kopie = (q: Quelle, neueGeltungName: string) => {
  const endung = ` — ${q.geltung_name}`;
  const name = q.name.endsWith(endung) ? `${q.name.slice(0, q.name.length - endung.length)} — ${neueGeltungName}` : q.name;
  return { rechenform: q.rechenform, name, zweck: q.zweck, fassung_nummer: 1, gueltig_ab: null, eingaenge: [] as string[], kennzeichen: null };
};

// ============================================================ Herkunft (kennzahlwert-herkunft.md)

export type HerkunftEingang = {
  rolle: string; art: string; objekt: string; wert: Dez | null; zaehler: Dez | null; nenner: Dez | null; einheit: string;
  zustand: string; abdeckung_prozent: Dez | null; version: number | null; fassung: number | null; kennzeichen: string[];
};
export type HerkunftAntrag = {
  kennzahl: string | null; rechenform: string; definition_fassung: number | null; periode: Periode;
  berechnet_am: string | null; version: number | null; anlass: string | null; eingaenge: HerkunftEingang[];
  ergebnis: {
    wert: Dez | null; einheit: string; zustand: string; richtung: string | null; grund: string | null;
    abdeckung_prozent: Dez | null; kennzeichen: string[];
  };
};

const betrag = (d: Dez | null): string | null => (d === null ? null : dezText(dezKuerze(d)));

/** Die Hülle: der Satz in der Form des Schemas — oder `null` mit jeder fehlenden Angabe. */
export const herkunft = (a: HerkunftAntrag): { satz: Record<string, unknown> | null; fehlt: string[] } => {
  const fehlt = [
    ...(a.kennzahl === null ? ['kennzahl'] : []),
    ...(a.definition_fassung === null ? ['definition_fassung'] : []),
    ...(a.berechnet_am === null ? ['berechnet_am'] : []),
    ...(a.eingaenge.length === 0 ? ['eingaenge'] : []),
    ...(a.version !== null && a.version >= 2 && (a.anlass === null || a.anlass.trim() === '') ? ['anlass'] : []),
  ];
  if (fehlt.length > 0) return { satz: null, fehlt };
  return {
    satz: {
      art: KENNZAHL,
      kennzahl: a.kennzahl,
      rechenform: a.rechenform,
      definition_fassung: a.definition_fassung,
      periode: { art: a.periode.art, schluessel: a.periode.schluessel },
      berechnet_am: a.berechnet_am,
      version: a.version,
      anlass: a.anlass,
      eingaenge: a.eingaenge.map((e) => ({
        rolle: e.rolle, art: e.art, objekt: e.objekt, wert: betrag(e.wert), zaehler: betrag(e.zaehler), nenner: betrag(e.nenner),
        einheit: e.einheit, zustand: e.zustand, abdeckung_prozent: betrag(e.abdeckung_prozent), version: e.version,
        fassung: e.fassung, kennzeichen: e.kennzeichen,
      })),
      ergebnis: {
        wert: betrag(a.ergebnis.wert), einheit: a.ergebnis.einheit, zustand: a.ergebnis.zustand, richtung: a.ergebnis.richtung,
        grund: a.ergebnis.grund, abdeckung_prozent: betrag(a.ergebnis.abdeckung_prozent), kennzeichen: a.ergebnis.kennzeichen,
      },
    },
    fehlt: [],
  };
};

/** Ein Kundensatz zu einem Code: `eingang_unbekannt` mit Art und Objekt, `geltung_unbekannt` je Art. */
export const satz = (code: string, werte: Record<string, string>): string => {
  if (code === EINGANG_UNBEKANNT) return fuelle(SAETZE[code], { art: SAETZE[`wort_${werte.art}`], objekt: werte.objekt });
  if (code === GELTUNG_UNBEKANNT) return SAETZE[`geltung_unbekannt_${werte.geltung_art}`];
  return fuelle(SAETZE[code], werte);
};

/** Auf die Vergleichs-Stellen gerundet — für Tests und Anzeigen, die zwei Beträge vergleichen. */
export const vergleichbar = (d: Dez): Dez => dezRunde(d, VERGLEICH_NACHKOMMASTELLEN);
