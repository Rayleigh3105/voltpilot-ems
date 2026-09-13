/**
 * Die ENERGIEBILANZ eines elektrischen Systems (UEMS AP-10 §4.3–§4.9) — der TS-Zwilling von
 * `services/api/.../uems/BilanzAbleitung.java` und `BilanzwertHerkunft.java`.
 *
 * Die EINE Wahrheit steht in `docs/contracts/v2/bilanz-vectors.json` (Prosa: `bilanz.md`); beide
 * Zwillinge fahren sie PER PFAD. Wer eine Regel ändert, ändert die Vektor-Datei UND beide Seiten.
 *
 * Was dieses Modul NICHT nachbaut: die gewichtete Summe des Formel-Vertrags (PR #688). `richtung`
 * und `live` RUFEN `uemsMessstelleFormel.ts` auf. Die exakte Dezimalrechnung stützt sich auf den
 * Bezugsdaten-Vertrag (`bezugsdaten.ts`, Typ `Dez` samt Parsen, Runden, Vergleichen und Textform);
 * hier kommen nur die drei Rechenarten dazu, die dort nicht ausgeführt werden.
 *
 * Die Grenze des Captains: ein Rest ist eine DIFFERENZ. Er heißt „nicht zugeordnet" und nennt nie
 * eine Ursache. Ein negativer Rest wird negativ gezeigt, nie auf 0 geklemmt; `null` und 0 sehen
 * nie gleich aus.
 *
 * Rein: keine Netzzugriffe, keine Uhr, kein React.
 */
import { dez, dezRunde, dezText, dezVergleich, type Dez } from './bezugsdaten';
import {
  formelGroesse,
  gewichteteSumme,
  type Summand as FormelSummand,
  type Term as FormelTerm,
} from './uemsMessstelleFormel';
import { SALDIERT as KATALOG_SALDIERT, groessePruefen } from './uemsMessstelle';
import { zahl } from './uemsErgebnis';

// ------------------------------------------------------------------------ Wörter und Schwellen

/** Die Zustandswörter sind die der Verbrauchsregel AP-08 — nie ein zweiter Wortlaut. */
export const VOLLSTAENDIG = 'vollständig';
export const UNVOLLSTAENDIG = 'unvollständig';
export const KEINE_WERTE = 'keine Werte';
export const MIT_ERSATZWERT = 'mit Ersatzwert';

/** Von gut nach schlecht; der „schlechteste Eingang" ist der letzte vorkommende. */
export const ZUSTAND_RANG = [VOLLSTAENDIG, MIT_ERSATZWERT, UNVOLLSTAENDIG, KEINE_WERTE];

/** Bis hierher (einschließlich) rechnet eine Differenz; danach gibt es „keine Werte". */
const RANG_RECHENBAR = ZUSTAND_RANG.indexOf(MIT_ERSATZWERT);

export const MENGE_NACHKOMMASTELLEN = 6;

export const BERECHNET_DIFFERENZ = 'berechnet (Differenz)';
export const BERECHNET_SUMME = 'berechnet (Summe)';
export const BERECHNET_SALDO = 'berechnet (Saldo)';
export const NICHT_ZUGEORDNET = 'nicht zugeordnet';
export const UNPLAUSIBEL_NEGATIV = 'unplausibel (negativ)';
/**
 * BEFRISTET (AP-10 IP-9, W12): Live-Wert und Verlauf einer berechneten Messstelle (PR #688) kommen aus
 * den Geräte-Verdichtungen. Das Kennzeichen steht an beiden Antworten, bis AP-10 IP-10 es entfernt
 * (`vokabulare.kennzeichen_befristet` der Vektor-Datei).
 */
export const VORLAEUFIG_GERAETE_VERDICHTUNG = 'vorläufig (Geräte-Verdichtung)';
/** Das Katalog-Wort steht EINMAL — im Größen-Katalog der Messstelle (AP-10 IP-4). */
export const SALDIERT = KATALOG_SALDIERT;
export const SALDIERT_KENNZEICHEN = 'saldiert (Bezug − Abgabe)';

/**
 * Die Kundensätze des Rests, WÖRTLICH die Vorlagen aus `saetze` der Vektor-Datei (`rest_zugeordnet`,
 * `rest_negativ`, `rest_keine_werte`); der Test hält sie dort fest. Ein Rest heißt „nicht
 * zugeordnet" — nie „Verlust", und er nennt keine Ursache. `{zahl}` ist Zahl mit Einheit aus
 * `uemsErgebnis.zahl` (E11).
 */
export const SATZ_REST_ZUGEORDNET = '{zahl} sind keiner Messstelle zugeordnet';
export const SATZ_REST_NEGATIV = 'Messwerte passen nicht zusammen ({zahl})';
export const SATZ_REST_KEINE_WERTE = 'nicht zugeordnet: keine Werte';

/** Wörter, die eine URSACHE behaupten — kein Satz dieses Vertrags darf sie tragen. */
export const VERBOTENE_WOERTER = ['Verlust', 'Verluste', 'Verlusten', 'Schwund', 'Diebstahl', 'Leckage'];

/**
 * Was ein berechneter Wert von einem Eingang ERBT: was über die PERIODE spricht, nicht was über
 * einen einzelnen Messwert spricht. Alles andere bleibt am Eingang und ist nur in der Herkunft
 * sichtbar.
 */
export const KENNZEICHEN_ERBEND: Array<{ muster: string; als: string }> = [
  { muster: '^ab \\d{2}\\.\\d{2}\\.\\d{4}$', als: '{0}' },
  { muster: '^mit Ersatzwert$', als: '{0}' },
  { muster: '^verteilt \\(.+\\)$', als: 'enthält {0}' },
];

export const ZUFLUSS = 'zufluss';
export const ABFLUSS = 'abfluss';
export const ZUGEORDNET = 'zugeordnet';
export const AUSSERHALB = 'ausserhalb';

// --------------------------------------------------- Dezimalrechnung (exakt, auf `Dez` aus AP-09)

const zehn = (n: number): bigint => 10n ** BigInt(n);

const gleichstellen = (a: Dez, b: Dez): [bigint, bigint, number] => {
  const e = Math.max(a.e, b.e);
  return [a.z * zehn(e - a.e), b.z * zehn(e - b.e), e];
};

export const dezPlus = (a: Dez, b: Dez): Dez => {
  const [x, y, e] = gleichstellen(a, b);
  return { z: x + y, e };
};

export const dezMinus = (a: Dez, b: Dez): Dez => {
  const [x, y, e] = gleichstellen(a, b);
  return { z: x - y, e };
};

export const dezMal = (a: Dez, b: Dez): Dez => ({ z: a.z * b.z, e: a.e + b.e });

export const NULL_BETRAG: Dez = { z: 0n, e: 0 };

export const dezVorzeichen = (d: Dez): number => (d.z < 0n ? -1 : d.z > 0n ? 1 : 0);

/** Nachlaufende Nullen weg — dieselbe Form, die `BigDecimal.stripTrailingZeros()` liefert. */
export const dezKuerze = (d: Dez): Dez => {
  let { z, e } = d;
  while (e > 0 && z % 10n === 0n) {
    z /= 10n;
    e -= 1;
  }
  return { z, e };
};

// ------------------------------------------------------------------------------ Tage (Muster A)

const TAG_MS = 86400000;

const tagMs = (t: string): number =>
  Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)));

const tagVon = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Der Tag `n` Tage vor `t` — die Vortags-Regel jeder zeitgültigen Beziehung. */
export const minusTage = (t: string, n: number): string => tagVon(tagMs(t) - n * TAG_MS);

/** Ganze Tage zwischen zwei Tagen (`von` eingeschlossen, `bis` ausgeschlossen). */
export const tageZwischen = (von: string, bis: string): number =>
  Math.round((tagMs(bis) - tagMs(von)) / TAG_MS);

const rang = (zustand: string): number => {
  const i = ZUSTAND_RANG.indexOf(zustand);
  if (i < 0) throw new Error(`unbekannter Zustand ${zustand} — bekannt sind ${ZUSTAND_RANG.join(', ')}`);
  return i;
};

const schlechtester = (zustaende: string[]): string =>
  zustaende.reduce((schlecht, z) => (rang(z) > rang(schlecht) ? z : schlecht), VOLLSTAENDIG);

const kleinsteAbdeckung = (werte: Array<number | null>): number | null =>
  werte.reduce<number | null>((min, w) => (w === null ? min : min === null || w < min ? w : min), null);

/** Die geerbten Kennzeichen der Eingänge, in der Reihenfolge ihres ersten Vorkommens. */
const geerbt = (kennzeichen: string[][]): string[] => {
  const raus: string[] = [];
  for (const liste of kennzeichen) {
    for (const k of liste) {
      const regel = KENNZEICHEN_ERBEND.find((r) => new RegExp(r.muster).test(k));
      if (!regel) continue;
      const wort = regel.als.replace('{0}', k);
      if (!raus.includes(wort)) raus.push(wort);
    }
  }
  return raus;
};

const korrigiert = (version: number): string => `korrigiert (Version ${version})`;

// -------------------------------------------------------------------------------- Bilanz-Rolle

export interface RolleEingang {
  stellung: string;
  richtung: string | null;
  art: string;
  medium: string;
  unterzaehler_von: string | null;
}

export interface RolleAnteil {
  rolle: string;
  anteil: string;
}

/** `rollen` leer heißt: diese Messstelle kommt in KEINER Bilanz vor — `grund` sagt warum. */
export interface RolleUrteil {
  rollen: RolleAnteil[];
  ziel: string | null;
  grund: string | null;
}

const keineRolle = (grund: string): RolleUrteil => ({ rollen: [], ziel: null, grund });
const einfach = (rolle: string): RolleUrteil => ({
  rollen: [{ rolle, anteil: 'gesamt' }],
  ziel: null,
  grund: null,
});

/**
 * §4.3 — die Bilanz-Rolle wird aus der Stellung ABGELEITET, nie gewählt. Ein Speicher mit der
 * Richtung „Laden / Entladen" geht mit ZWEI Anteilen ein (E4): der positive ist ein Abfluss, der
 * negative ein Zufluss — nie als Saldo, nie nur mit einer Hälfte.
 */
export function rolle(e: RolleEingang): RolleUrteil {
  if (e.art === 'berechnet') return keineRolle('berechnet');
  if (e.medium !== 'Strom') return keineRolle('medium');
  if (e.stellung === 'keine') return keineRolle('keine_stellung');
  switch (e.stellung) {
    case 'Abzweig':
      return { rollen: [{ rolle: AUSSERHALB, anteil: 'gesamt' }], ziel: null, grund: 'kein_vorgaenger' };
    case 'Hauptzähler':
      if (e.richtung === 'Bezug') return einfach(ZUFLUSS);
      if (e.richtung === 'Abgabe') return einfach(ABFLUSS);
      return keineRolle('richtung_unbestimmt');
    case 'Erzeuger':
      return einfach(ZUFLUSS);
    case 'Speicher':
      if (e.richtung === 'Laden / Entladen') {
        return {
          rollen: [
            { rolle: ABFLUSS, anteil: 'positiv' },
            { rolle: ZUFLUSS, anteil: 'negativ' },
          ],
          ziel: null,
          grund: null,
        };
      }
      if (e.richtung === 'Laden') return einfach(ABFLUSS);
      if (e.richtung === 'Entladen') return einfach(ZUFLUSS);
      return keineRolle('richtung_unbestimmt');
    case 'Unterzähler':
      return e.unterzaehler_von === null
        ? keineRolle('kein_vorgaenger')
        : { rollen: [{ rolle: ZUGEORDNET, anteil: 'gesamt' }], ziel: e.unterzaehler_von, grund: null };
    default:
      return keineRolle('keine_stellung');
  }
}

// ------------------------------------------------------------------------------------ Eingänge

/**
 * Ein Eingang einer Bilanz: eine Messstelle mit ihrer Rolle und dem, was AP-08 an ihrem
 * Periodenwert sagt. `menge === null` heißt „keine Werte" — nie „gemessen 0".
 */
export interface Eingang {
  messstelle: string;
  rolle: string;
  anteil: string;
  menge: Dez | null;
  zustand: string;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
}

const summiere = (eingaenge: Eingang[], welche: string): Dez =>
  eingaenge
    .filter((e) => e.rolle === welche)
    .reduce((summe, e) => dezPlus(summe, e.menge as Dez), NULL_BETRAG);

// ---------------------------------------------------------------------------------------- Rest

export interface RestUrteil {
  zufluss: Dez | null;
  abfluss: Dez | null;
  zugeordnet: Dez | null;
  verbrauch_system: Dez | null;
  menge: Dez | null;
  groesse: string | null;
  richtung: string | null;
  einheit: string;
  zustand: string;
  abdeckung_prozent: number | null;
  fehlend: string[];
  kennzeichen: string[];
  kundensatz: string;
}

/**
 * §4.3 — `Rest(X, T) = Σ Zufluss − Σ Abfluss − Σ zugeordnet(X)`, Ergebnis fest Wirkenergie · Bezug
 * (E1). §4.5 Zeile „Differenz": vollständig nur, wenn ALLE Eingänge vollständig sind; sonst
 * „keine Werte" und Menge `null` — nie eine um den fehlenden Eingang verkleinerte Differenz, die
 * zu HOCH wäre.
 */
export function rest(
  // Wessen Bilanz das ist — sie steht im Vertrag und in der Herkunft, die Rechnung braucht sie nicht.
  _hauptzaehler: string,
  einheit: string,
  // Die Ebene der Periode (tag, monat …) — sie bestimmt die Stellen der Zahl im Kundensatz (E11).
  zahlEbene: string | null,
  version: number,
  vermerke: string[],
  eingaenge: Eingang[],
): RestUrteil {
  const fehlend: string[] = [];
  for (const e of eingaenge) {
    if ((e.menge === null || rang(e.zustand) > RANG_RECHENBAR) && !fehlend.includes(e.messstelle)) {
      fehlend.push(e.messstelle);
    }
  }
  const zustand = schlechtester(eingaenge.map((e) => e.zustand));
  const abdeckung = kleinsteAbdeckung(eingaenge.map((e) => e.abdeckung_prozent));
  const r = richtung('rest', 'berechnet', 'Intervallmenge', null);
  const kennzeichen = [BERECHNET_DIFFERENZ];

  if (fehlend.length > 0) {
    kennzeichen.push(KEINE_WERTE);
    kennzeichen.push(...geerbt(eingaenge.map((e) => e.kennzeichen)));
    kennzeichen.push(...vermerke);
    if (version > 1) kennzeichen.push(korrigiert(version));
    return {
      zufluss: null,
      abfluss: null,
      zugeordnet: null,
      verbrauch_system: null,
      menge: null,
      groesse: r.groesse,
      richtung: r.richtung,
      einheit,
      zustand: KEINE_WERTE,
      abdeckung_prozent: abdeckung,
      fehlend,
      kennzeichen,
      kundensatz: SATZ_REST_KEINE_WERTE,
    };
  }

  const zufluss = summiere(eingaenge, ZUFLUSS);
  const abfluss = summiere(eingaenge, ABFLUSS);
  const zugeordnet = summiere(eingaenge, ZUGEORDNET);
  const verbrauch = dezMinus(zufluss, abfluss);
  const menge = dezRunde(dezMinus(verbrauch, zugeordnet), MENGE_NACHKOMMASTELLEN);
  const negativ = dezVorzeichen(menge) < 0;
  kennzeichen.push(negativ ? UNPLAUSIBEL_NEGATIV : NICHT_ZUGEORDNET);
  kennzeichen.push(...geerbt(eingaenge.map((e) => e.kennzeichen)));
  kennzeichen.push(...vermerke);
  if (version > 1) kennzeichen.push(korrigiert(version));
  const kundensatz = (negativ ? SATZ_REST_NEGATIV : SATZ_REST_ZUGEORDNET)
    .replace('{zahl}', zahl(dezText(menge), einheit, zahlEbene));
  return {
    zufluss,
    abfluss,
    zugeordnet,
    verbrauch_system: verbrauch,
    menge,
    groesse: r.groesse,
    richtung: r.richtung,
    einheit,
    zustand,
    abdeckung_prozent: abdeckung,
    fehlend: [],
    kennzeichen,
    kundensatz,
  };
}

// ----------------------------------------------------------------------- Rest aus der Stellung

/** Fehler: an diesem Tag ist die Messstelle kein Hauptzähler Bezug — es gibt keinen Rest (§4.3). */
export const REST_OHNE_HAUPTZAEHLER = 'rest_ohne_hauptzaehler';

/**
 * Eine zeitgültige elektrische Stellung einer Messstelle (AP-04 `messstelle_stellung`), mit den
 * Merkmalen der Messstelle, die die Rolle braucht. `ab`/`bis` sind TAGE (`JJJJ-MM-TT`), der letzte
 * Tag gehört dazu; `null` heißt offen.
 */
export interface StellungZeile {
  messstelle: string;
  anlage: string | null;
  stellung: string;
  richtung: string | null;
  art: string;
  medium: string;
  unterzaehler_von: string | null;
  ab: string | null;
  bis: string | null;
}

/** Ein Term des Rests: welche Messstelle mit welcher Rolle und welchem Anteil eingeht. */
export interface RestTerm {
  messstelle: string;
  rolle: string;
  anteil: string;
}

/**
 * Die Fassung eines Rests an EINEM Tag, aus der Stellung abgeleitet. `fehler !== null` heißt: an
 * diesem Tag gibt es keinen Rest (`terme` leer). `ausserhalb` nennt die Abzweige desselben Systems.
 */
export interface RestFassung {
  hauptzaehler: string;
  anlage: string | null;
  terme: RestTerm[];
  ausserhalb: string[];
  fehler: string | null;
}

/**
 * §4.3 / E3 — der Rest eines Hauptzählers X an einem TAG, aus den Stellungen dieses Tages: ein `rest`
 * speichert keine Terme. Zieht ein Unterzähler um, ändern sich beide Reste am selben Tag, ohne dass
 * jemand eine Formel anfasst (F7).
 *
 * - X muss an dem Tag Hauptzähler mit der Rolle Zufluss sein (Richtung Bezug), sonst
 *   `rest_ohne_hauptzaehler`.
 * - Zufluss und Abfluss sind X selbst und die Erzeuger, Speicher (mit beiden Anteilen, E4) und der
 *   Hauptzähler Abgabe DESSELBEN Systems (Anlage); ein zweiter Hauptzähler Bezug (den der
 *   Messstellen-Vertrag §6 nicht zulässt) ginge nicht als zweiter Zufluss ein.
 * - Zugeordnet sind genau die Unterzähler VON X — ein Unterzähler eines Unterzählers zählt im Rest
 *   von X nicht doppelt.
 *
 * Reihenfolge: Zufluss (X zuerst) · Abfluss · zugeordnet, je in der Reihenfolge der Zeilen. Vermerke
 * wie „Stellung geändert (…)" leitet diese Regel NICHT ab.
 */
export function restAusStellung(hauptzaehler: string, tag: string, zeilen: StellungZeile[]): RestFassung {
  const amTag = zeilen.filter((z) => (z.ab === null || z.ab <= tag) && (z.bis === null || tag <= z.bis));
  const x = amTag.find((z) => z.messstelle === hauptzaehler);
  const rolleVon = (z: StellungZeile): RolleUrteil =>
    rolle({
      stellung: z.stellung,
      richtung: z.richtung,
      art: z.art,
      medium: z.medium,
      unterzaehler_von: z.unterzaehler_von,
    });
  const xRollen = x ? rolleVon(x).rollen : [];
  const xIstZufluss = xRollen.length === 1 && xRollen[0].rolle === ZUFLUSS && xRollen[0].anteil === 'gesamt';
  if (!x || x.stellung !== 'Hauptzähler' || !xIstZufluss) {
    return { hauptzaehler, anlage: null, terme: [], ausserhalb: [], fehler: REST_OHNE_HAUPTZAEHLER };
  }
  const zufluss: RestTerm[] = [{ messstelle: x.messstelle, rolle: ZUFLUSS, anteil: 'gesamt' }];
  const abfluss: RestTerm[] = [];
  const zugeordnet: RestTerm[] = [];
  const ausserhalb: string[] = [];
  for (const z of amTag) {
    if (z.messstelle === x.messstelle) continue;
    const u = rolleVon(z);
    if (u.ziel === hauptzaehler) {
      zugeordnet.push({ messstelle: z.messstelle, rolle: ZUGEORDNET, anteil: 'gesamt' });
      continue;
    }
    const imSystem = x.anlage !== null && x.anlage === z.anlage;
    const zweiterBezug = z.stellung === 'Hauptzähler' && z.richtung === 'Bezug';
    if (!imSystem || u.ziel !== null || zweiterBezug) continue;
    for (const r of u.rollen) {
      if (r.rolle === ZUFLUSS) zufluss.push({ messstelle: z.messstelle, rolle: ZUFLUSS, anteil: r.anteil });
      else if (r.rolle === ABFLUSS) abfluss.push({ messstelle: z.messstelle, rolle: ABFLUSS, anteil: r.anteil });
      else if (r.rolle === AUSSERHALB) ausserhalb.push(z.messstelle);
    }
  }
  return { hauptzaehler, anlage: x.anlage, terme: [...zufluss, ...abfluss, ...zugeordnet], ausserhalb, fehler: null };
}

// --------------------------------------------------------------------------------------- Summe

/** Ein Summand einer gewichteten Summe auf der MENGEN-Ebene (der Live-Wert läuft über `live`). */
export interface Summand {
  messstelle: string;
  menge: Dez | null;
  zustand: string;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
  vorzeichen: string;
  faktor: Dez;
}

export interface SummeUrteil {
  menge: Dez;
  zustand: string;
  abdeckung_prozent: number | null;
  vorhanden: number;
  gesamt: number;
  fehlend: string[];
  kennzeichen: string[];
  anzeige: string | null;
}

/**
 * §4.5 Zeile „Summe" — die Summe der VORHANDENEN Eingänge, Zustand „schlechtester Eingang"; fehlt
 * einer, heißt die Zahl „mindestens …" und NENNT ihn. Eine Summe verschweigt nie einen Summanden.
 */
export function summe(einheit: string, zahlEbene: string | null, eingaenge: Summand[]): SummeUrteil {
  const s = summeOhneAnzeige(eingaenge);
  const anzeige =
    s.fehlend.length === 0
      ? null
      : `mindestens ${zahl(dezText(s.menge), einheit, zahlEbene)} (${s.fehlend.join(', ')} ${
          s.fehlend.length === 1 ? 'fehlt' : 'fehlen'
        })`;
  return { ...s, anzeige };
}

/** Die Summe ohne Kundensatz — die Standort-Ebene (`ebene`) spricht ihn nicht. */
function summeOhneAnzeige(eingaenge: Summand[]): SummeUrteil {
  let menge = NULL_BETRAG;
  let vorhanden = 0;
  const fehlend: string[] = [];
  for (const s of eingaenge) {
    if (s.menge === null || rang(s.zustand) > RANG_RECHENBAR) {
      if (!fehlend.includes(s.messstelle)) fehlend.push(s.messstelle);
      continue;
    }
    const teil = dezMal(s.menge, s.faktor);
    menge = s.vorzeichen === '-' ? dezMinus(menge, teil) : dezPlus(menge, teil);
    vorhanden += 1;
  }
  menge = dezRunde(menge, MENGE_NACHKOMMASTELLEN);
  // Eine Summe mit noch einem Wert ist HÖCHSTENS „unvollständig": „keine Werte" heißt sie erst,
  // wenn KEIN Eingang einen Wert hat — sonst sähen 1 055 kWh und gar nichts gleich aus.
  let zustand = schlechtester(eingaenge.map((e) => e.zustand));
  if (vorhanden === 0) zustand = KEINE_WERTE;
  else if (rang(zustand) > rang(UNVOLLSTAENDIG)) zustand = UNVOLLSTAENDIG;
  const kennzeichen = [BERECHNET_SUMME, ...geerbt(eingaenge.map((e) => e.kennzeichen))];
  return {
    menge,
    zustand,
    abdeckung_prozent: kleinsteAbdeckung(eingaenge.map((e) => e.abdeckung_prozent)),
    vorhanden,
    gesamt: eingaenge.length,
    fehlend,
    kennzeichen,
    anzeige: null,
  };
}

// --------------------------------------------------------------------------------------- Saldo

export interface SaldoUrteil {
  menge: Dez | null;
  groesse: string | null;
  richtung: string | null;
  einheit: string | null;
  zustand: string | null;
  abdeckung_prozent: number | null;
  fehlend: string[];
  kennzeichen: string[];
  fehler: string | null;
  grund: string | null;
}

/**
 * §4.4/§4.5 — genau zwei Eingänge derselben Grenze: Bezug minus Abgabe. Das Ergebnis ist
 * Wirkenergie · `saldiert`, ein Katalog-Eintrag NUR für berechnete Messstellen. Ein Saldo geht nie
 * als Zufluss in eine Rest-Bilanz ein — dort zählen Bezug und Abgabe einzeln.
 */
export function saldo(einheit: string, art: string, eingaenge: Eingang[]): SaldoUrteil {
  const r = richtung('saldo', art, 'Intervallmenge', null);
  const bezug = eingaenge.filter((e) => e.rolle === ZUFLUSS).length;
  const abgabe = eingaenge.filter((e) => e.rolle === ABFLUSS).length;
  if (r.fehler !== null || eingaenge.length !== 2 || bezug !== 1 || abgabe !== 1) {
    return {
      menge: null,
      groesse: null,
      richtung: null,
      einheit: null,
      zustand: null,
      abdeckung_prozent: null,
      fehlend: [],
      kennzeichen: [],
      fehler: 'groessen_gemischt',
      grund: r.fehler !== null ? r.grund : 'saldo_braucht_zwei',
    };
  }
  const fehlend = eingaenge
    .filter((e) => e.menge === null || rang(e.zustand) > RANG_RECHENBAR)
    .map((e) => e.messstelle);
  const kennzeichen = [
    BERECHNET_SALDO,
    SALDIERT_KENNZEICHEN,
    ...geerbt(eingaenge.map((e) => e.kennzeichen)),
  ];
  const abdeckung = kleinsteAbdeckung(eingaenge.map((e) => e.abdeckung_prozent));
  if (fehlend.length > 0) {
    return {
      menge: null,
      groesse: r.groesse,
      richtung: r.richtung,
      einheit,
      zustand: KEINE_WERTE,
      abdeckung_prozent: abdeckung,
      fehlend,
      kennzeichen,
      fehler: null,
      grund: null,
    };
  }
  return {
    menge: dezRunde(dezMinus(summiere(eingaenge, ZUFLUSS), summiere(eingaenge, ABFLUSS)), MENGE_NACHKOMMASTELLEN),
    groesse: r.groesse,
    richtung: r.richtung,
    einheit,
    zustand: schlechtester(eingaenge.map((e) => e.zustand)),
    abdeckung_prozent: abdeckung,
    fehlend: [],
    kennzeichen,
    fehler: null,
    grund: null,
  };
}

// ------------------------------------------------------------------------------------ Richtung

export interface RichtungUrteil {
  groesse: string | null;
  richtung: string | null;
  einheit: string | null;
  wertart: string | null;
  fehler: string | null;
  grund: string | null;
}

/**
 * E1 — die Ergebnis-Richtung ist JE TYP eine Regel, keine Ableitung aus Vorzeichen: 100 minus 60
 * minus 30 ergibt 10 kWh *Bezug*, nicht „richtungslos".
 *
 * - `gewichtete_summe`: unverändert der Formel-Vertrag (PR #688) — `formelGroesse` wird
 *   AUFGERUFEN, nie nachgebaut.
 * - `rest`: fest Wirkenergie · Bezug. Der Live-Wert ist ein Momentanwert und trägt die
 *   Katalog-Richtung der Wirkleistung (`richtungslos`).
 * - `saldo`: Wirkenergie · `saldiert` — zulässig NUR für `art = berechnet`.
 */
export function richtung(
  typ: string,
  art: string,
  wertart: string | null,
  terme: FormelTerm[] | null,
): RichtungUrteil {
  if (typ === 'gewichtete_summe') {
    const u = formelGroesse(terme ?? []);
    if (u.fehler !== null) {
      return { groesse: null, richtung: null, einheit: null, wertart: null, fehler: u.fehler, grund: u.grund };
    }
    const g = u.hauptgroesse;
    return g === null
      ? { groesse: null, richtung: null, einheit: null, wertart: null, fehler: null, grund: null }
      : {
          groesse: g.groesse,
          richtung: g.richtung,
          einheit: g.einheit,
          wertart: g.wertart,
          fehler: null,
          grund: null,
        };
  }
  if (typ === 'rest') {
    return wertart === 'Momentanwert'
      ? {
          groesse: 'Wirkleistung',
          richtung: 'richtungslos',
          einheit: 'kW',
          wertart: 'Momentanwert',
          fehler: null,
          grund: null,
        }
      : { groesse: 'Wirkenergie', richtung: 'Bezug', einheit: 'kWh', wertart, fehler: null, grund: null };
  }
  if (typ === 'saldo') {
    // Ob `saldiert` an dieser Messstelle stehen darf, sagt der KATALOG (AP-10 IP-4) — nicht eine
    // zweite Liste hier: nur `art = berechnet` darf die Richtung tragen.
    const imKatalog = groessePruefen(
      'Strom',
      { groesse: 'Wirkenergie', richtung: SALDIERT, einheit: 'kWh', wertart: 'Intervallmenge' },
      art,
    );
    return imKatalog.fehler === null
      ? { groesse: 'Wirkenergie', richtung: SALDIERT, einheit: 'kWh', wertart, fehler: null, grund: null }
      : {
          groesse: null,
          richtung: null,
          einheit: null,
          wertart: null,
          fehler: 'groessen_gemischt',
          grund: 'saldiert_nur_berechnet',
        };
  }
  throw new Error(`unbekannter Formel-Typ ${typ}`);
}

// --------------------------------------------------------------------------------------- Ebene

/** Ein System (eine Anlage) als Zeile einer Standort- oder Unternehmens-Summe. */
export interface SystemZeile {
  anlage: string;
  kurzname: string;
  messstelle: string;
  menge: Dez | null;
  zustand: string;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
}

export interface EbeneUrteil {
  menge: Dez;
  zustand: string;
  abdeckung_prozent: number | null;
  mit_werten: number;
  gesamt: number;
  fehlend: string[];
  kennzeichen: string[];
  anzeige_kennzeichen: string[];
}

/**
 * §4.8 — Standort und Unternehmen bilanzieren als SUMME über ihre Systeme, mit „x von y" und OHNE
 * eigenen Rest: ein Standort hat keine eigene Bilanzgrenze. Das geerbte Kennzeichen eines Systems
 * wird in der Anzeige seinem Namen vorangestellt („Lindach ab 15.10.2026") — an der Zahl selbst
 * steht nur, was die Regel sagt.
 */
export function ebene(
  // Die Einheit der Ebene steht im Vertrag; die Summe der Systeme spricht keinen Zahlensatz.
  _einheit: string,
  wort: string,
  systeme: SystemZeile[],
): EbeneUrteil {
  const s = summeOhneAnzeige(
    systeme.map((z) => ({
      messstelle: z.messstelle,
      menge: z.menge,
      zustand: z.zustand,
      abdeckung_prozent: z.abdeckung_prozent,
      version: z.version,
      kennzeichen: [],
      vorzeichen: '+',
      faktor: dez('1'),
    })),
  );
  const anzeige: string[] = [];
  for (const z of systeme) {
    for (const k of geerbt([z.kennzeichen])) anzeige.push(`${z.kurzname} ${k}`);
  }
  return {
    menge: s.menge,
    zustand: s.zustand,
    abdeckung_prozent: s.abdeckung_prozent,
    mit_werten: s.vorhanden,
    gesamt: systeme.length,
    fehlend: s.fehlend,
    kennzeichen: [BERECHNET_SUMME, `${s.vorhanden} von ${systeme.length} ${wort}`],
    anzeige_kennzeichen: anzeige,
  };
}

// ----------------------------------------------------------------------------------- Live-Wert

/** Ein Term des Live-Werts; `grund` sagt, WARUM ein Wert fehlt (nie geraten). */
export interface LiveTerm {
  messstelle: string;
  vorzeichen: string;
  faktor: number;
  wert: number | null;
  einheit: string;
  grund: string | null;
}

export interface Fehlender {
  term: string;
  grund: string;
}

export interface LiveUrteil {
  wert: number | null;
  unvollstaendig: boolean;
  fehlende: Fehlender[];
}

/**
 * §4.5 letzte Zeile — der Live-Wert ist `null` statt einer Teilsumme; die Antwort nennt, welcher
 * Term fehlt und warum. Gerechnet wird mit `gewichteteSumme` (PR #688) — dieselbe Summe wie im
 * Formel-Vertrag, nicht eine zweite.
 */
export function live(einheit: string, terme: LiveTerm[]): LiveUrteil {
  const u = gewichteteSumme(
    einheit,
    terme.map(
      (t): FormelSummand => ({
        vorzeichen: t.vorzeichen === '-' ? '-' : '+',
        faktor: t.faktor,
        wert: t.wert,
        einheit: t.einheit,
      }),
    ),
  );
  return {
    wert: u.wert,
    unvollstaendig: u.unvollstaendig,
    fehlende: u.fehlende.map((i) => ({ term: terme[i].messstelle, grund: terme[i].grund ?? 'kein_wert' })),
  };
}

// -------------------------------------------------------------------------------- Gebäude-Sicht

export interface GebaeudeZeile {
  messstelle: string;
  rolle: string;
  menge: Dez;
  im_gebaeude: boolean;
}

export interface GebaeudeUrteil {
  gemessen_im_gebaeude: Dez;
  im_system_ausserhalb: Dez;
  rest_nicht_verortet: Dez | null;
  zufluss_im_gebaeude: Dez | null;
  gebaeudeverbrauch: null;
  grund: string;
}

/**
 * §4.8 — ein Gebäude ist eine SICHT (Ort × Stellung), keine Bilanzgrenze. `gebaeudeverbrauch` ist
 * deshalb IMMER `null`: eine Summe daraus wäre eine Behauptung, für die es keinen Messwert gibt.
 */
export function gebaeude(
  // Gebäude, Anlage und Einheit benennen die SICHT; gerechnet wird nur über die Zeilen.
  _gebaeude: string,
  _anlage: string,
  _einheit: string,
  zeilen: GebaeudeZeile[],
  restMenge: Dez | null,
): GebaeudeUrteil {
  let drin = NULL_BETRAG;
  let draussen = NULL_BETRAG;
  let zufluss: Dez | null = null;
  for (const z of zeilen) {
    if (z.rolle === ZUGEORDNET) {
      if (z.im_gebaeude) drin = dezPlus(drin, z.menge);
      else draussen = dezPlus(draussen, z.menge);
    } else if (z.rolle === ZUFLUSS && z.im_gebaeude) {
      zufluss = zufluss === null ? z.menge : dezPlus(zufluss, z.menge);
    }
  }
  return {
    gemessen_im_gebaeude: drin,
    im_system_ausserhalb: draussen,
    rest_nicht_verortet: restMenge,
    zufluss_im_gebaeude: zufluss,
    gebaeudeverbrauch: null,
    grund: 'kein_gebaeude_rest',
  };
}

// ----------------------------------------------------------------------------------- Versorgung

/** Wo eine Messstelle an einem Tag hängt: ihr Ort und der Weg von dort zur Wurzel. */
export interface Verortung {
  messstelle: string;
  anlage: string;
  stellung: string;
  ort_pfad: string[];
}

export interface VersorgungUrteil {
  versorgt: Record<string, string[]>;
  ausserhalb_gebaeude: string[];
  nicht_messbar: string[];
}

/**
 * §4.8/AP-00 Inv. 9 — „System AN versorgt Gebäude G an T" gilt genau dann, wenn eine Messstelle
 * mit Stellung ≠ „keine" in AN an T ihren Ort in G oder darunter hat. Es gibt kein gepflegtes
 * Feld: eine Messstelle ohne Gebäude wird GENANNT, ein Gebäude ohne Messstelle heißt „nicht
 * messbar" — nie „versorgt von …".
 */
export function versorgung(
  // Der Tag ist schon in den hereingereichten Verortungen aufgelöst — er benennt sie nur.
  _tag: string,
  gebaeudeListe: string[],
  messstellen: Verortung[],
): VersorgungUrteil {
  const versorgt: Record<string, string[]> = {};
  const ausserhalb: string[] = [];
  const messbar = new Set<string>();
  for (const v of messstellen) {
    if (v.stellung === 'keine') continue;
    const g = v.ort_pfad.find((o) => gebaeudeListe.includes(o));
    if (g === undefined) {
      ausserhalb.push(v.messstelle);
      continue;
    }
    messbar.add(g);
    const liste = versorgt[v.anlage] ?? (versorgt[v.anlage] = []);
    if (!liste.includes(g)) liste.push(g);
  }
  for (const liste of Object.values(versorgt)) liste.sort();
  return {
    versorgt,
    ausserhalb_gebaeude: ausserhalb,
    nicht_messbar: gebaeudeListe.filter((g) => !messbar.has(g)),
  };
}

// ------------------------------------------------------------------------------------- Herkunft

export interface HerkunftEingangswert {
  messstelle: string;
  bilanz_rolle: string | null;
  anteil: string | null;
  menge: string | null;
  zustand: string;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
}

export interface Verteilungsbezug {
  fassung: number;
  ziel: string;
  anteil_prozent: string;
}

export interface HerkunftErgebnis {
  menge: string | null;
  zustand: string | null;
  abdeckung_prozent: number | null;
  kennzeichen: string[] | null;
}

export interface HerkunftEingang {
  art: string | null;
  messstelle: string | null;
  periode: { art: string | null; schluessel: string | null };
  formel_typ: string | null;
  formel_fassung: number | string | null;
  periode_ende: string | null;
  berechnet_am: string | null;
  version: number;
  ausloeser: string | null;
  verteilung: Verteilungsbezug | null;
  eingaenge: HerkunftEingangswert[];
  ergebnis: HerkunftErgebnis | null;
}

export interface HerkunftUrteil {
  satz: Record<string, unknown> | null;
  fehlt: string[];
}

/**
 * §4.7/E13 — der Herkunfts-Satz eines berechneten oder verteilten Werts (Form:
 * `bilanzwert-herkunft.schema.json`). Eine halbe Herkunft wird nie ausgeliefert: fehlt eine
 * Pflichtangabe, ist der Satz `null` und `fehlt` nennt jede fehlende. Ab Version 2 ist der
 * Auslöser Pflicht — eine Neuberechnung, die ihre Ursache verschweigt, ist keine Herkunft.
 */
export function herkunft(e: HerkunftEingang): HerkunftUrteil {
  const fehlt: string[] = [];
  if (e.art !== 'berechnet' && e.art !== 'verteilt') fehlt.push('art');
  if (!e.messstelle || !e.messstelle.trim()) fehlt.push('messstelle');
  if (e.periode.art === null || e.periode.schluessel === null) fehlt.push('periode');
  if (e.art === 'verteilt') {
    if (e.verteilung === null) fehlt.push('verteilung');
    if (e.eingaenge.length !== 1) fehlt.push('eingaenge');
  } else if (e.art === 'berechnet') {
    if (e.formel_typ === null) fehlt.push('formel_typ');
    if (e.eingaenge.length === 0) fehlt.push('eingaenge');
    if (e.formel_typ === 'rest' && e.eingaenge.some((w) => w.bilanz_rolle === null)) {
      fehlt.push('bilanz_rolle');
    }
  }
  if (!e.berechnet_am || !e.berechnet_am.trim()) fehlt.push('berechnet_am');
  if (e.version > 1 && (!e.ausloeser || !e.ausloeser.trim())) fehlt.push('ausloeser');
  if (e.ergebnis === null || e.ergebnis.zustand === null || e.ergebnis.kennzeichen === null) {
    fehlt.push('ergebnis');
  }
  if (fehlt.length > 0) return { satz: null, fehlt };

  const ergebnis = e.ergebnis as HerkunftErgebnis;
  return {
    satz: {
      art: e.art,
      messstelle: e.messstelle,
      periode: { art: e.periode.art, schluessel: e.periode.schluessel },
      formel_typ: e.art === 'berechnet' ? e.formel_typ : null,
      formel_fassung: e.art === 'berechnet' ? e.formel_fassung ?? null : null,
      periode_ende: e.periode_ende,
      berechnet_am: e.berechnet_am,
      version: e.version,
      ausloeser: e.ausloeser,
      verteilung: e.verteilung,
      eingaenge: e.eingaenge.map((w) => ({
        messstelle: w.messstelle,
        bilanz_rolle: w.bilanz_rolle,
        anteil: w.anteil,
        menge: w.menge,
        zustand: w.zustand,
        abdeckung_prozent: w.abdeckung_prozent,
        version: w.version,
        kennzeichen: [...w.kennzeichen],
      })),
      kennzeichen: [...(ergebnis.kennzeichen as string[])],
      menge: ergebnis.menge,
      zustand: ergebnis.zustand,
      abdeckung_prozent: ergebnis.abdeckung_prozent,
    },
    fehlt: [],
  };
}

/** Beträge reisen als Dezimaltext — dieselbe Form, in der sie im Vertrag stehen. */
export const betragText = (d: Dez | null): string | null => (d === null ? null : dezText(d));

/** Numerisch: „10" und „10.000000" sind derselbe Betrag. */
export const betragGleich = (a: Dez | null, b: string | null): boolean =>
  a === null || b === null ? a === null && b === null : dezVergleich(a, dez(b)) === 0;
