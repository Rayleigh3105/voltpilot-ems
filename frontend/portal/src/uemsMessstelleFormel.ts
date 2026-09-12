/**
 * Die REINEN Regeln der FORMEL einer berechneten Messstelle — UEMS AP-10,
 * Formel-Typ „gewichtete Summe" (Prosa: `../../docs/contracts/v2/messstelle-formel.md`,
 * Konzept vp-helfer-konzept-h1 §2.2/§2.3). Der Zwilling in der api ist
 * `services/api/.../uems/MessstelleFormelRegeln.java`; beide fahren dieselben
 * Vektoren (`../../docs/contracts/v2/messstelle-formel-vectors.json`).
 *
 * Ergänzt `uemsMessstelle.ts` additiv und stützt sich auf dessen Größen-Katalog
 * (`GROESSEN_KATALOG`, `KANAL_EINHEITEN`, `groessePruefen`) — der Helfer ist der
 * erste AP-10-Formel-Typ, kein zweites Modell.
 *
 * Ableitung ist REIN, die Fläche rendert nur (Portal-Hausregel). Die harte
 * Ehrlichkeitsregel lebt in `gewichteteSumme`: `null` statt Teilsumme.
 */
import { GROESSEN_KATALOG, KANAL_EINHEITEN, groessePruefen, type Groesse } from './uemsMessstelle';

/** Auf wie viele Nachkommastellen die Summe gerundet wird (deterministisch über die Zwillinge). */
export const SUMME_NACHKOMMASTELLEN = 6;

/** Die umrechenbaren Einheiten je Größe — dieselbe Tabelle wie der Messstellen-Vertrag. */
export const EINHEITEN_NORMIERUNG: Record<string, string[]> = KANAL_EINHEITEN;

export const FEHLER = [
  { code: 'groessen_gemischt', status: 422, geprueft_von: 'MessstelleFormelRegeln' },
  { code: 'formel_zyklus', status: 422, geprueft_von: 'MessstelleFormelRegeln' },
] as const;
export type FehlerCode = (typeof FEHLER)[number]['code'];

const RICHTUNGSLOS = 'richtungslos';

// ----------------------------------------------------------- Größe ableiten

/** Ein Term, so wie er zur Ableitung der Hauptgröße gesehen wird. */
export interface Term {
  groesse: string;
  richtung: string;
  einheit: string;
  wertart: string;
  vorzeichen: '+' | '-';
}

export interface GroesseUrteil {
  fehler: FehlerCode | null;
  grund: string | null;
  hauptgroesse: Groesse | null;
}

const katalog = (groesse: string) => GROESSEN_KATALOG.find((e) => e.groesse === groesse);

/**
 * Leitet die Hauptgröße der berechneten Messstelle aus ihren Termen ab (§2.2). Alle Terme
 * müssen dieselbe Größe und Wertart tragen — sonst `groessen_gemischt` mit dem ersten verletzten
 * Merkmal. Die Einheit ist die Katalog-Einheit der Größe. Die Richtung ist die gemeinsame
 * Richtung, wenn alle Terme dieselbe tragen und alle mit `+` eingehen; sonst `richtungslos`
 * (ein Netto). Ergibt sich eine Größe, die der Katalog nicht kennt, ist das `groessen_gemischt`.
 * Ohne Term gibt es keine Hauptgröße (kein Fehler; die Messstelle bleibt Entwurf).
 */
export function formelGroesse(terme: Term[]): GroesseUrteil {
  if (terme.length === 0) {
    return { fehler: null, grund: null, hauptgroesse: null };
  }
  const erster = terme[0];
  for (const t of terme) {
    if (t.groesse !== erster.groesse) {
      return gemischt('groesse');
    }
    if (t.wertart !== erster.wertart) {
      return gemischt('wertart');
    }
  }
  const e = katalog(erster.groesse);
  if (!e) {
    return gemischt('groesse');
  }
  const alleGleicheRichtung = terme.every((t) => t.richtung === erster.richtung);
  const allePlus = terme.every((t) => t.vorzeichen === '+');
  const richtung = alleGleicheRichtung && allePlus ? erster.richtung : RICHTUNGSLOS;
  const haupt: Groesse = { groesse: erster.groesse, richtung, einheit: e.einheit, wertart: erster.wertart };
  const imKatalog = groessePruefen(e.medien[0], haupt);
  if (imKatalog.fehler) {
    return gemischt(imKatalog.grund);
  }
  return { fehler: null, grund: null, hauptgroesse: haupt };
}

const gemischt = (grund: string | null): GroesseUrteil => ({
  fehler: 'groessen_gemischt',
  grund,
  hauptgroesse: null,
});

// ----------------------------------------------------------------- Zyklus

export interface ZyklusUrteil {
  zyklus: boolean;
  kette: string[];
}

/**
 * Verkettet die Formel der Messstelle `kennzeichen` (mit den messstelle-Termen `verweise`) im
 * Kreis? `bestehende` bildet jede andere berechnete Messstelle auf die Messstellen ab, die SIE
 * verkettet. Das Urteil trägt bei einem Kreis dessen Kette (`[kennzeichen, …, kennzeichen]`).
 */
export function zyklus(
  kennzeichen: string,
  verweise: string[],
  bestehende: Record<string, string[]>,
): ZyklusUrteil {
  const graph: Record<string, string[]> = { ...bestehende, [kennzeichen]: verweise };
  const pfad: string[] = [kennzeichen];
  const gefunden = suche(kennzeichen, kennzeichen, graph, pfad, new Set<string>());
  return gefunden ?? { zyklus: false, kette: [] };
}

function suche(
  ziel: string,
  aktuell: string,
  graph: Record<string, string[]>,
  pfad: string[],
  besucht: Set<string>,
): ZyklusUrteil | null {
  besucht.add(aktuell);
  for (const naechste of graph[aktuell] ?? []) {
    pfad.push(naechste);
    if (naechste === ziel) {
      return { zyklus: true, kette: [...pfad] };
    }
    if (!besucht.has(naechste)) {
      const r = suche(ziel, naechste, graph, pfad, besucht);
      if (r) {
        return r;
      }
    }
    pfad.pop();
  }
  return null;
}

// -------------------------------------------------------- Gewichtete Summe

/** Ein Summand: Vorzeichen, Faktor, Wert (oder `null`, wenn er fehlt/veraltet) und Einheit. */
export interface Summand {
  vorzeichen: '+' | '-';
  faktor: number;
  wert: number | null;
  einheit: string;
}

export interface SummeUrteil {
  wert: number | null;
  unvollstaendig: boolean;
  fehlende: number[];
}

/**
 * Die gewichtete Summe auf die `zielEinheit` (§2.3). Die harte Ehrlichkeitsregel: fehlt oder
 * veraltet EIN Pflicht-Term (`wert === null`), ist das Ergebnis `null` („unvollständig"), NIE
 * eine stillschweigend reduzierte Teilsumme. Sonst die Summe der `vorzeichen · faktor ·
 * normiert(wert)`, gerundet auf `SUMME_NACHKOMMASTELLEN`.
 */
export function gewichteteSumme(zielEinheit: string, terme: Summand[]): SummeUrteil {
  const fehlende: number[] = [];
  terme.forEach((t, i) => {
    if (t.wert === null) {
      fehlende.push(i);
    }
  });
  if (fehlende.length > 0) {
    return { wert: null, unvollstaendig: true, fehlende };
  }
  let summe = 0;
  for (const t of terme) {
    const wert = normiere(t.wert as number, t.einheit, zielEinheit);
    summe += (t.vorzeichen === '-' ? -1 : 1) * t.faktor * wert;
  }
  return { wert: runde(summe), unvollstaendig: false, fehlende: [] };
}

/**
 * Rechnet `wert` von `von` auf `nach` um (Zehnerpotenzen je Größe, `EINHEITEN_NORMIERUNG`).
 * Gleiche Einheit → unverändert; eine unbekannte Paarung bleibt ebenfalls unverändert.
 */
export function normiere(wert: number, von: string, nach: string): number {
  if (!von || von === nach) {
    return wert;
  }
  for (const familie of Object.values(EINHEITEN_NORMIERUNG)) {
    const vonIndex = familie.indexOf(von);
    const nachIndex = familie.indexOf(nach);
    if (vonIndex >= 0 && nachIndex >= 0) {
      const stufen = vonIndex - nachIndex;
      const faktor = Math.pow(1000, Math.abs(stufen));
      return stufen >= 0 ? wert * faktor : wert / faktor;
    }
  }
  return wert;
}

function runde(wert: number): number {
  const faktor = Math.pow(10, SUMME_NACHKOMMASTELLEN);
  return Math.round(wert * faktor) / faktor;
}
