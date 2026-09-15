/**
 * UEMS AP-13 IP-1 — das REINE Modul der Messdaten- und Analyseoberflächen.
 *
 * Die Flächen der Pakete IP-2 … IP-13 (Ebenen-Seiten, Werte, Verlauf,
 * Vergleich, Sprünge) fragen hier, statt es an jeder Stelle neu zu entscheiden:
 *  1. ob zwei Messstellen PASSEND sind (E6, VG1/VG4) — gleiche Größe, Richtung,
 *     Einheit und Wertart der Hauptgröße (AP-04 E1), sonst mit dem Grund, den
 *     der Picker neben die Messstelle schreibt;
 *  2. die KACHELN einer Ebene aus dem Lesemodell (AP-01 E4, O17) — über
 *     `ebenenBereiche`, nie aus einer festen Liste; eine Kachel nur mit Seite;
 *  3. das SPRUNGZIEL einer Herkunfts-Zeile (E10, D1–D3) — mit Periode und
 *     Version im Hash; ein Objekt ohne Seite bleibt Text (`null`);
 *  4. das Raster des VERLAUFS je Zeitraum (E5, V1) — das der Route, nie summiert;
 *  5. den ZONE-SATZ im Kopf jeder Fläche (E12, V7) — aus `zeitzone` und
 *     `zeitzone_herkunft` der Antwort, nie aus dem Browser.
 *
 * Hier wird NICHTS gerechnet: keine Menge, keine Summe, kein Δ. Zahlen, Zustände
 * und Sätze sprechen die Zwillinge (`uemsErgebnis`, `uemsBilanz`, `uemsBericht`);
 * der Grund einer fehlenden Zahl ist `uemsErgebnis.grundSatz`. Die Fälle O1…O19
 * stehen byte-gleich in `test/oberflaechenFaelle.json`.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type { MessstelleGroesse, MessstelleWerte, MessstelleWerteRaster } from './api';
import {
  EBENEN_LEISTE_AB,
  EBENEN_SEITEN,
  ebenenBereiche,
  type EbenenBereichId,
  type EbenenLesemodell,
  type EbenenOrt,
  type EbenenSeiten,
} from './ebenenNav';
import { berichtRoute, hashForRoute, kennzahlRoute, messstelleRoute, type Route } from './nav';

// ------------------------------------------------------------------ 1 · passend (E6)

/** Bis zu drei Messstellen liegen in einem Bild (VG1): die eigene und zwei weitere. */
export const VERGLEICH_HOECHSTENS = 3;

export const NICHT_PASSEND = 'nicht passend';

/** Die Teile der Hauptgröße in der Reihenfolge, in der der erste Unterschied den Grund nennt. */
export type PassendTeil = 'groesse' | 'richtung' | 'einheit' | 'wertart';

export type Passend = { passend: true } | { passend: false; teil: PassendTeil; grund: string };

/**
 * Ob `andere` neben `basis` in ein Bild darf. Der ERSTE Unterschied nennt den
 * Grund in den Wörtern des Messstellen-Vertrags: eine andere Größe mit ihrer
 * Einheit („Volumen in m³“), sonst die Richtung („Erzeugung“, „Laden / Entladen“),
 * die Einheit oder die Wertart. Kein Urteil, keine Umrechnung — eine Messstelle
 * in m³ wird nie „ungefähr passend“.
 */
export function passend(basis: MessstelleGroesse, andere: MessstelleGroesse): Passend {
  if (andere.groesse !== basis.groesse) return { passend: false, teil: 'groesse', grund: `${andere.groesse} in ${andere.einheit}` };
  if (andere.richtung !== basis.richtung) return { passend: false, teil: 'richtung', grund: andere.richtung };
  if (andere.einheit !== basis.einheit) return { passend: false, teil: 'einheit', grund: `in ${andere.einheit}` };
  if (andere.wertart !== basis.wertart) return { passend: false, teil: 'wertart', grund: andere.wertart };
  return { passend: true };
}

/** „nicht passend: Volumen in m³“ — die Erklärung im Picker; eine passende Messstelle hat keine. */
export const passendSatz = (p: Passend): string | null => (p.passend ? null : `${NICHT_PASSEND}: ${p.grund}`);

/** Ob noch eine weitere Messstelle dazu darf, wenn `reihen` schon im Bild liegen (die eigene mitgezählt). */
export const weitereWaehlbar = (reihen: number): boolean => reihen < VERGLEICH_HOECHSTENS;

// ------------------------------------------------------------------ 2 · Kacheln je Lesemodell (O17)

/** Was eine Ebene zeigt: alle Bereiche aus dem Lesemodell, die davon mit Seite, und ob die Leiste erscheint. */
export interface EbenenBild {
  bereiche: EbenenBereichId[];
  kacheln: EbenenBereichId[];
  leiste: boolean;
}

/**
 * Die Kacheln einer Ebene — dieselbe Regel wie `ebenenLeiste`, aber ohne die
 * Kacheln unter der Schwelle wegzuwerfen: die Bühne und der gemessene Weg (IP-13)
 * brauchen „2 Kacheln, keine Leiste“ ebenso wie „4 Kacheln, Leiste“. Seit IP-2
 * stehen Gebäude und Anlagen des Standorts in `EBENEN_SEITEN` — Werk Ahrenberg
 * vier Kacheln, Werk Lindach drei; wer eine weitere Seite einhängt, trägt sie dort ein.
 */
export function kacheln(ort: EbenenOrt, lm: EbenenLesemodell, seiten: EbenenSeiten = EBENEN_SEITEN): EbenenBild {
  const ziele = seiten(ort);
  const bereiche = ebenenBereiche(ort, lm).map((b) => b.key);
  const mitSeite = bereiche.filter((key) => ziele[key] !== undefined);
  return { bereiche, kacheln: mitSeite, leiste: mitSeite.length >= EBENEN_LEISTE_AB };
}

// ------------------------------------------------------------------ 3 · Sprungziel (E10)

/**
 * Das Objekt einer Herkunfts-Zeile. Eine Seite haben heute Messstelle (mit
 * Periode und Version, D2), Kennzahl, Bericht und Gerät. Ohne Seite bleiben
 * Bezugsgröße (AP-09), Ereignis (AP-07) und Box (AP-06 IP-16) — D3 — sowie
 * Kostenstelle und Gebäude, bis IP-9 und IP-2 ihre Seiten einhängen.
 */
export type SprungObjekt =
  | { art: 'messstelle'; id: string; standortId?: string | null; periode?: string | null; version?: number | null }
  | { art: 'kennzahl'; id: string }
  | { art: 'bericht'; kennung: string }
  | { art: 'geraet'; siteId: string; ref: string; geraetId?: string | null }
  | { art: 'bezugsgroesse' | 'ereignis' | 'box' | 'kostenstelle' | 'gebaeude'; kennzeichen: string };

export interface Sprung {
  route: Route;
  hash: string;
}

const sprung = (route: Route, parameter: Record<string, string | null> = {}): Sprung => {
  const query = new URLSearchParams(
    Object.entries(parameter).filter((e): e is [string, string] => e[1] !== null),
  ).toString();
  return { route, hash: `${hashForRoute(route)}${query ? `?${query}` : ''}` };
};

/**
 * Wohin eine Herkunfts-Zeile springt — oder `null`: dann bleibt sie Text mit
 * Kennzeichen, und keine Fläche wird dafür erfunden (D3). Eine Messstelle öffnet
 * ihre Seite im Bereich, aus dem sie kommt, mit `periode=` und `version=`, wenn
 * die Zeile sie nennt (`#/portfolio/messstellen/MS-12?periode=2026-10&version=2`).
 */
export function sprungziel(o: SprungObjekt): Sprung | null {
  switch (o.art) {
    case 'messstelle':
      return sprung(messstelleRoute(o.id, o.standortId), {
        periode: o.periode ?? null,
        version: o.version == null ? null : String(o.version),
      });
    case 'kennzahl':
      return sprung(kennzahlRoute(o.id));
    case 'bericht':
      return sprung(berichtRoute(o.kennung));
    case 'geraet':
      return sprung({ page: 'anlagen', siteId: o.siteId, sub: 'geraet', geraet: { ref: o.ref, geraetId: o.geraetId ?? null } });
    default:
      return null;
  }
}

// ------------------------------------------------------------------ 4 · Zeitraum → Raster (E5)

/** Die vier Zeiträume der Zeit-Leiste — kein freies Von–Bis im ersten Ausbau (V1). */
export type Zeitraum = 'tag' | 'woche' | 'monat' | 'jahr';

export const ZEITRAEUME: readonly Zeitraum[] = ['tag', 'woche', 'monat', 'jahr'];

/** Tag in Viertelstunden, Woche in Stunden, Monat in Tagen, Jahr in Monaten — das Raster der Route. */
export const VERLAUF_RASTER: Readonly<Record<Zeitraum, MessstelleWerteRaster>> = {
  tag: 'viertelstunde',
  woche: 'stunde',
  monat: 'tag',
  jahr: 'monat',
};

export const verlaufRaster = (zeitraum: Zeitraum): MessstelleWerteRaster => VERLAUF_RASTER[zeitraum];

// ------------------------------------------------------------------ 5 · Zone-Satz (E12)

/** Woher die Zone der Antwort kommt, in Kundenwörtern. */
export const ZONE_HERKUNFT: Readonly<Record<MessstelleWerte['zeitzone_herkunft'], string>> = {
  standort: 'Zeitzone des Standorts',
  unternehmen: 'Zeitzone des Unternehmens',
  vorgabe: 'Vorgabe',
};

/**
 * „Zeiten in Europe/Berlin (Zeitzone des Standorts Werk Ahrenberg)“ — einmal im
 * Kopf jeder UEMS-Fläche, immer (E12 = A). Die Zone und ihre Herkunft kommen aus
 * der Antwort; der Name des Standorts nur, wenn die Zone von ihm stammt.
 */
export function zoneSatz(
  zeitzone: string,
  herkunft: MessstelleWerte['zeitzone_herkunft'],
  standortName?: string | null,
): string {
  const woher = herkunft === 'standort' && standortName ? `${ZONE_HERKUNFT.standort} ${standortName}` : ZONE_HERKUNFT[herkunft];
  return `Zeiten in ${zeitzone} (${woher})`;
}
