/**
 * Die FESTE VERTEILUNG einer Messstelle auf Kostenstellen (UEMS AP-10 §4.6, E11/E12) — der
 * TS-Zwilling von `services/api/.../uems/VerteilungRegeln.java`.
 *
 * Die EINE Wahrheit steht in `docs/contracts/v2/verteilung-vectors.json` (Prosa: `verteilung.md`);
 * beide Zwillinge fahren sie PER PFAD.
 *
 * Eine Verteilung ist eine eigene ZEITGÜLTIGE Beziehung Messstelle → Kostenstelle (Tage) mit
 * Anteil. An jedem Tag mit Zeilen sind es genau 100 %; ohne Zeile ist die Messstelle „nicht
 * verteilt" — das ist ein Zustand, kein Fehler. Sie wirkt JE TAG auf die Tagesmenge: kein
 * Stichtag, kein Mittel, keine Interpolation. Keine dynamischen Schlüssel.
 *
 * Rein: keine Netzzugriffe, keine Uhr, kein React.
 */
import { dez, dezRunde, dezText, dezVergleich, type Dez } from './bezugsdaten';
import {
  KEINE_WERTE,
  MENGE_NACHKOMMASTELLEN,
  NULL_BETRAG,
  dezKuerze,
  dezMal,
  dezPlus,
  dezVorzeichen,
  minusTage,
  tageZwischen,
} from './uemsBilanz';

/** Die Summe aller Zeilen eines Tages — genau so viel, nie „ungefähr". */
export const SUMME_PROZENT = dez('100');

export const ANTEIL_NACHKOMMASTELLEN = 1;
export { MENGE_NACHKOMMASTELLEN };

export const VERTEILT = 'verteilt';
export const NICHT_VERTEILT = 'nicht verteilt';

export const FEHLER_SUMME = 'verteilung_summe';
export const FEHLER_ZIEL = 'ziel_besteht_nicht';
export const FEHLER_ANTEIL = 'anteil_ungueltig';
export const FEHLER_UEBERLAPPT = 'formel_fassung_ueberlappt';
export const FEHLER_TAGESMENGEN = 'tagesmengen_noetig';
export const FEHLER_TERM_FAKTOR = 'verteilungs_term_ohne_faktor';
export const FEHLER_NICHT_VERTEILT = 'nicht_verteilt';

/** Der Satz, den ein Ziel bekommt, dessen Quelle ein unplausibler Rest ist. */
export const ERBE_REST_UNPLAUSIBEL = 'keine Werte (Rest unplausibel)';

export const GRUND_REST_UNPLAUSIBEL = 'rest_unplausibel';
export const GRUND_QUELLE_KEINE_WERTE = 'quelle_keine_werte';

// ------------------------------------------------------------------------------------ Tage

const gilt = (tag: string, ab: string | null, bis: string | null): boolean => {
  if (ab !== null && tag < ab) return false;
  return bis === null || tag <= bis;
};

// ------------------------------------------------------------------------------- Bausteine

/** Eine Zeile eines Verteilungs-Satzes: ein Ziel und sein Anteil. */
export interface Zeile {
  kostenstelle: string;
  anteil_prozent: Dez;
}

/** Ein zeitgültiges Ziel; `gueltig_bis === null` heißt „läuft". */
export interface Ziel {
  kostenstelle: string;
  gueltig_ab: string | null;
  gueltig_bis: string | null;
}

/** Eine zeitgültige Verteilungszeile, wie sie gespeichert ist. */
export interface Bestandszeile {
  kostenstelle: string;
  anteil_prozent: Dez;
  gueltig_ab: string | null;
  gueltig_bis: string | null;
  aufgehoben_am: string | null;
}

const text = (d: Dez): string => dezText(dezKuerze(d));

// ------------------------------------------------------------------------------- Satz (100 %)

export interface SatzUrteil {
  gueltig: boolean;
  summe: Dez;
  fehler: string | null;
  fakten: Record<string, string>;
}

/**
 * §4.6 — ein Verteilungs-Satz wird als GANZES geschrieben (alle Ziele eines Tages in einer
 * Anfrage), damit die 100 % überhaupt prüfbar sind. Geprüft wird in fester Reihenfolge: jeder
 * Anteil liegt in (0, 100], jedes Ziel besteht an diesem Tag, die Summe ist genau 100 %. Eine
 * Summe von 110 % wird abgelehnt, nie stillschweigend normiert.
 */
export function satz(tag: string, _messstelle: string, zeilen: Zeile[], ziele: Ziel[]): SatzUrteil {
  const summe = dezRunde(
    zeilen.reduce((s, z) => dezPlus(s, z.anteil_prozent), NULL_BETRAG),
    ANTEIL_NACHKOMMASTELLEN,
  );
  for (const z of zeilen) {
    if (dezVorzeichen(z.anteil_prozent) <= 0 || dezVergleich(z.anteil_prozent, SUMME_PROZENT) > 0) {
      return {
        gueltig: false,
        summe,
        fehler: FEHLER_ANTEIL,
        fakten: { kostenstelle: z.kostenstelle, anteil_prozent: text(z.anteil_prozent) },
      };
    }
  }
  for (const z of zeilen) {
    const ziel = ziele.find((y) => y.kostenstelle === z.kostenstelle);
    if (!ziel || !gilt(tag, ziel.gueltig_ab, ziel.gueltig_bis)) {
      return {
        gueltig: false,
        summe,
        fehler: FEHLER_ZIEL,
        fakten: { kostenstelle: z.kostenstelle, tag },
      };
    }
  }
  if (dezVergleich(summe, SUMME_PROZENT) !== 0) {
    return { gueltig: false, summe, fehler: FEHLER_SUMME, fakten: { summe: text(summe), tag } };
  }
  return { gueltig: true, summe, fehler: null, fakten: {} };
}

// ---------------------------------------------------------------------------------- Am Tag

export interface AmTagUrteil {
  zeilen: Zeile[];
  zustand: string;
}

/**
 * Welche Zeilen an einem Tag gelten. Eine Zeile endet mit ihrem Ziel: endet die Kostenstelle,
 * endet der Anteil — er wandert NIE still auf einen Nachfolger.
 */
export function amTag(tag: string, zeilen: Bestandszeile[], ziele: Ziel[]): AmTagUrteil {
  const gueltig: Zeile[] = [];
  for (const b of zeilen) {
    if (b.aufgehoben_am !== null && tag >= b.aufgehoben_am) continue;
    if (!gilt(tag, b.gueltig_ab, b.gueltig_bis)) continue;
    const ziel = ziele.find((y) => y.kostenstelle === b.kostenstelle);
    if (!ziel || !gilt(tag, ziel.gueltig_ab, ziel.gueltig_bis)) continue;
    gueltig.push({ kostenstelle: b.kostenstelle, anteil_prozent: b.anteil_prozent });
  }
  return { zeilen: gueltig, zustand: gueltig.length === 0 ? NICHT_VERTEILT : VERTEILT };
}

// ---------------------------------------------------------------------------------- Fassung

export interface Beendet {
  kostenstelle: string;
  gueltig_bis: string;
}

export interface NeueZeile {
  kostenstelle: string;
  anteil_prozent: Dez;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

export interface FassungUrteil {
  beendet: Beendet[];
  neu: NeueZeile[];
  rueckwirkend: boolean;
  tage_rueckwirkend: number;
  fehler: string | null;
}

/**
 * Eine neue Fassung beendet die laufende am VORTAG — nichts wird überschrieben. Beginnt sie vor
 * dem Beginn der laufenden, überlappte sie; das wird abgelehnt. Liegt ihr Beginn vor heute, ist
 * sie rückwirkend und bekommt ihr Abzeichen samt Zahl der Tage.
 */
export function fassung(
  heute: string,
  bestehend: Bestandszeile[],
  gueltigAb: string,
  zeilen: Zeile[],
): FassungUrteil {
  const rueckwirkend = gueltigAb < heute;
  const tage = tageZwischen(gueltigAb, heute);
  for (const b of bestehend) {
    if (b.gueltig_ab !== null && gueltigAb <= b.gueltig_ab) {
      return { beendet: [], neu: [], rueckwirkend, tage_rueckwirkend: tage, fehler: FEHLER_UEBERLAPPT };
    }
  }
  return {
    beendet: bestehend
      .filter((b) => b.gueltig_bis === null || b.gueltig_bis >= gueltigAb)
      .map((b) => ({ kostenstelle: b.kostenstelle, gueltig_bis: minusTage(gueltigAb, 1) })),
    neu: zeilen.map((z) => ({
      kostenstelle: z.kostenstelle,
      anteil_prozent: z.anteil_prozent,
      gueltig_ab: gueltigAb,
      gueltig_bis: null,
    })),
    rueckwirkend,
    tage_rueckwirkend: tage,
    fehler: null,
  };
}

// ------------------------------------------------------------------------------ Satz ab Tag

/** Eine Zeile, die eine Korrektur aufhebt: sie bleibt lesbar, gilt aber nie mehr. */
export interface Aufgehoben {
  kostenstelle: string;
  gueltig_ab: string;
}

export interface SatzAbTagUrteil {
  fehler: string | null;
  summe: Dez;
  fakten: Record<string, string>;
  aufgehoben: Aufgehoben[];
  beendet: Beendet[];
  neu: NeueZeile[];
  rueckwirkend: boolean;
  tage_rueckwirkend: number;
  unveraendert: boolean;
}

/**
 * AP-10 IP-8 — der Schreibweg `PUT …/verteilung` als EINE Regel: ab `tag` gilt GENAU dieser Satz
 * (`zeilen` leer = ab dem Tag „nicht verteilt"). Reihenfolge: Anteil in (0, 100] mit höchstens einer
 * Nachkommastelle → `satz` → neue Zeilen enden mit ihrem Ziel, danach kein Rest ≠ 100 % →
 * derselbe Stand steht schon da (`unveraendert`) → Korrektur hebt die Zeilen GENAU am Tag auf →
 * `fassung`.
 */
export function satzAbTag(
  heute: string,
  tag: string,
  zeilen: Zeile[],
  ziele: Ziel[],
  bestehend: Bestandszeile[],
  korrektur: boolean,
): SatzAbTagUrteil {
  const rueckwirkend = tag < heute;
  const tage = rueckwirkend ? tageZwischen(tag, heute) : 0;
  const summe = dezRunde(
    zeilen.reduce((s, z) => dezPlus(s, z.anteil_prozent), NULL_BETRAG),
    ANTEIL_NACHKOMMASTELLEN,
  );
  const abgelehnt = (fehler: string, fakten: Record<string, string>): SatzAbTagUrteil => ({
    fehler,
    summe,
    fakten,
    aufgehoben: [],
    beendet: [],
    neu: [],
    rueckwirkend,
    tage_rueckwirkend: tage,
    unveraendert: false,
  });
  for (const z of zeilen) {
    const a = z.anteil_prozent;
    if (
      dezVorzeichen(a) <= 0 ||
      dezVergleich(a, SUMME_PROZENT) > 0 ||
      dezKuerze(a).e > ANTEIL_NACHKOMMASTELLEN
    ) {
      return abgelehnt(FEHLER_ANTEIL, { kostenstelle: z.kostenstelle, anteil_prozent: text(a) });
    }
  }
  if (zeilen.length > 0) {
    const s = satz(tag, '', zeilen, ziele);
    if (!s.gueltig) return abgelehnt(s.fehler as string, s.fakten);
  }
  const neu: NeueZeile[] = zeilen.map((z) => ({
    kostenstelle: z.kostenstelle,
    anteil_prozent: z.anteil_prozent,
    gueltig_ab: tag,
    gueltig_bis: ziele.find((y) => y.kostenstelle === z.kostenstelle)?.gueltig_bis ?? null,
  }));
  // Ein Rest am Tag nach dem Ende eines Ziels: die übrigen Zeilen ergäben weniger als 100 %.
  const enden = [...new Set(neu.map((n) => n.gueltig_bis).filter((e): e is string => e !== null))].sort();
  for (const ende of enden) {
    const danach = minusTage(ende, -1);
    const rest = neu
      .filter((n) => gilt(danach, n.gueltig_ab, n.gueltig_bis))
      .reduce((s, n) => dezPlus(s, n.anteil_prozent), NULL_BETRAG);
    if (dezVorzeichen(rest) > 0 && dezVergleich(rest, SUMME_PROZENT) !== 0) {
      return abgelehnt(FEHLER_SUMME, { summe: text(rest), tag: danach });
    }
  }
  const wirksam = bestehend.filter((b) => b.aufgehoben_am === null);
  const stand = (k: string, a: Dez, bis: string | null): string => `${k}=${text(a)}@${bis}`;
  const spaeter = wirksam.some((b) => b.gueltig_ab !== null && b.gueltig_ab > tag);
  const vorher = wirksam
    .filter((b) => gilt(tag, b.gueltig_ab, b.gueltig_bis))
    .map((b) => stand(b.kostenstelle, b.anteil_prozent, b.gueltig_bis))
    .sort();
  const nachher = neu.map((n) => stand(n.kostenstelle, n.anteil_prozent, n.gueltig_bis)).sort();
  if (!spaeter && vorher.length === nachher.length && vorher.every((v, i) => v === nachher[i])) {
    return {
      fehler: null,
      summe,
      fakten: {},
      aufgehoben: [],
      beendet: [],
      neu: [],
      rueckwirkend,
      tage_rueckwirkend: tage,
      unveraendert: true,
    };
  }
  const aufgehoben: Aufgehoben[] = [];
  const rest: Bestandszeile[] = [];
  for (const b of wirksam) {
    if (korrektur && b.gueltig_ab === tag) aufgehoben.push({ kostenstelle: b.kostenstelle, gueltig_ab: tag });
    else rest.push(b);
  }
  const f = fassung(heute, rest, tag, zeilen);
  if (f.fehler !== null) {
    const laufend = rest.map((b) => b.gueltig_ab ?? '').sort().reverse()[0] ?? '';
    return abgelehnt(f.fehler, { gueltig_ab: tag, laufend_ab: laufend });
  }
  return {
    fehler: null,
    summe,
    fakten: {},
    aufgehoben,
    beendet: f.beendet,
    neu,
    rueckwirkend,
    tage_rueckwirkend: tage,
    unveraendert: false,
  };
}

// ----------------------------------------------------------------------------------- Mengen

/** Eine Tagesmenge der Quelle; `menge === null` heißt „keine Werte". */
export interface Tagesmenge {
  tag: string;
  menge: Dez | null;
}

/** Ein zeitgültiger Verteilungs-Abschnitt (eine Fassung). */
export interface Abschnitt {
  gueltig_ab: string | null;
  gueltig_bis: string | null;
  zeilen: Zeile[];
}

export interface MengenUrteil {
  je_ziel: Record<string, Dez>;
  summe: Dez | null;
  nicht_verteilt: Dez | null;
  fehler: string | null;
}

/**
 * E12 — die Verteilung wirkt JE TAG auf die Tagesmenge. Deckt GENAU EIN Abschnitt den ganzen
 * Zeitraum, genügt der Periodenbetrag (das Ergebnis ist dann exakt dasselbe). Wechselt die
 * Verteilung mitten in der Periode, sind Tagesmengen nötig: ein Periodenbetrag anteilig auf die
 * Abschnitte zu verteilen hieße, die Tagesmengen zu erfinden.
 */
export function mengen(
  von: string,
  bis: string,
  periodeMenge: Dez | null,
  tage: Tagesmenge[] | null,
  verteilung: Abschnitt[],
): MengenUrteil {
  const deckend = verteilung.filter(
    (a) => gilt(von, a.gueltig_ab, a.gueltig_bis) && gilt(bis, a.gueltig_ab, a.gueltig_bis),
  );
  if (tage === null || tage.length === 0) {
    if (deckend.length !== 1 || periodeMenge === null) {
      return { je_ziel: {}, summe: null, nicht_verteilt: null, fehler: FEHLER_TAGESMENGEN };
    }
    return verteile([{ tag: von, menge: periodeMenge }], deckend);
  }
  return verteile(tage, verteilung);
}

function verteile(tage: Tagesmenge[], verteilung: Abschnitt[]): MengenUrteil {
  const jeZiel: Record<string, Dez> = {};
  let summe = NULL_BETRAG;
  let offen = NULL_BETRAG;
  for (const t of tage) {
    if (t.menge === null) continue;
    summe = dezPlus(summe, t.menge);
    const abschnitt = verteilung.find((a) => gilt(t.tag, a.gueltig_ab, a.gueltig_bis));
    if (!abschnitt || abschnitt.zeilen.length === 0) {
      offen = dezPlus(offen, t.menge);
      continue;
    }
    for (const z of abschnitt.zeilen) {
      const anteil = anteilVon(t.menge, z.anteil_prozent);
      jeZiel[z.kostenstelle] = jeZiel[z.kostenstelle]
        ? dezPlus(jeZiel[z.kostenstelle], anteil)
        : anteil;
    }
  }
  const fertig: Record<string, Dez> = {};
  for (const [k, v] of Object.entries(jeZiel)) fertig[k] = dezKuerze(v);
  return { je_ziel: fertig, summe: dezKuerze(summe), nicht_verteilt: dezKuerze(offen), fehler: null };
}

/** `menge × anteil ÷ 100`, auf `MENGE_NACHKOMMASTELLEN` gerundet — exakt, nie über Gleitkomma. */
const anteilVon = (menge: Dez, anteilProzent: Dez): Dez => {
  const produkt = dezMal(menge, anteilProzent);
  return dezRunde({ z: produkt.z, e: produkt.e + 2 }, MENGE_NACHKOMMASTELLEN);
};

// ------------------------------------------------------------------------------------- Erbe

/** Die Quelle einer Verteilung: der Wert, der aufgeteilt wird. */
export interface Quelle {
  messstelle: string;
  menge: Dez | null;
  zustand: string;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
}

export interface ErbeUrteil {
  menge: Dez | null;
  zustand: string;
  abdeckung_prozent: number | null;
  version: number;
  kennzeichen: string[];
  grund: string | null;
}

/**
 * §4.5 Zeile „Verteilung" — das Ziel bekommt `Eingang × Anteil` und ERBT Zustand, Abdeckung,
 * Version und Kennzeichen der Quelle; dazu kommt „verteilt (n % von MS-xx)". Ein verteilter Wert
 * wird dadurch nie ein gemessener.
 *
 * Zwei Quellen werden NICHT verteilt: eine ohne Werte und ein unplausibler (negativer) Rest. Das
 * Ziel bekommt dann „keine Werte" — nie einen negativen Kostenstellen-Wert.
 */
export function erbe(
  quelle: Quelle,
  anteilProzent: Dez,
  // Fassung, Ziel und Einheit reisen in die Herkunft — die Rechnung selbst braucht sie nicht.
  _fassung: number,
  _ziel: string,
  _einheit: string,
): ErbeUrteil {
  if (quelle.menge === null || quelle.zustand === KEINE_WERTE) {
    return {
      menge: null,
      zustand: KEINE_WERTE,
      abdeckung_prozent: quelle.abdeckung_prozent,
      version: quelle.version,
      kennzeichen: [KEINE_WERTE],
      grund: GRUND_QUELLE_KEINE_WERTE,
    };
  }
  if (dezVorzeichen(quelle.menge) < 0) {
    return {
      menge: null,
      zustand: KEINE_WERTE,
      abdeckung_prozent: quelle.abdeckung_prozent,
      version: quelle.version,
      kennzeichen: [ERBE_REST_UNPLAUSIBEL],
      grund: GRUND_REST_UNPLAUSIBEL,
    };
  }
  return {
    menge: dezKuerze(anteilVon(quelle.menge, anteilProzent)),
    zustand: quelle.zustand,
    abdeckung_prozent: quelle.abdeckung_prozent,
    version: quelle.version,
    kennzeichen: [
      `verteilt (${text(anteilProzent)} % von ${quelle.messstelle})`,
      ...quelle.kennzeichen,
    ],
    grund: null,
  };
}

// ------------------------------------------------------------------------------------- Term

/**
 * Ein Term der Art `verteilung` (E11): er meint „Anteil der Kostenstelle X an der Messstelle Y"
 * und folgt der Verteilung — er trägt deshalb KEINEN eigenen Faktor.
 */
export interface VerteilungsTerm {
  art: string;
  verteilung_ziel: string;
  quell_messstelle: string;
  anteil: string;
  faktor: Dez | null;
  vorzeichen: string;
}

export interface TermUrteil {
  menge: Dez | null;
  anteil_prozent: Dez | null;
  kennzeichen: string[];
  fehler: string | null;
}

/**
 * Der Verteilungs-Term liest den Anteil des TAGES aus der Verteilung. Ein kopierter Faktor (etwa
 * 0,7 statt des Verweises) wird abgelehnt: er liefe der Verteilung davon, sobald sie sich ändert.
 * Gibt es am Tag keine Verteilungszeile, gibt es keinen Anteil — nie einen geratenen.
 */
export function term(
  t: VerteilungsTerm,
  tag: string,
  quelleMenge: Dez,
  verteilung: Abschnitt[],
): TermUrteil {
  if (t.faktor !== null && dezVergleich(t.faktor, dez('1')) !== 0) {
    return { menge: null, anteil_prozent: null, kennzeichen: [], fehler: FEHLER_TERM_FAKTOR };
  }
  const abschnitt = verteilung.find((a) => gilt(tag, a.gueltig_ab, a.gueltig_bis));
  const zeile = abschnitt?.zeilen.find((z) => z.kostenstelle === t.verteilung_ziel);
  if (!zeile) {
    return { menge: null, anteil_prozent: null, kennzeichen: [], fehler: FEHLER_NICHT_VERTEILT };
  }
  return {
    menge: dezKuerze(anteilVon(quelleMenge, zeile.anteil_prozent)),
    anteil_prozent: dezKuerze(zeile.anteil_prozent),
    kennzeichen: [`verteilt (${text(zeile.anteil_prozent)} % von ${t.quell_messstelle})`],
    fehler: null,
  };
}
