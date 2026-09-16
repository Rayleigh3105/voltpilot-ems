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
 *     `zeitzone_herkunft` der Antwort, nie aus dem Browser;
 *  6. die AUSKUNFT statt einer Fehlermeldung (IP-6, Z2–Z4): der Satz einer
 *     400-Ablehnung je Grund, die 404 „gibt es nicht“ bzw. „nicht mehr
 *     gespeichert“, und die Leerzustände Vergleich und Energiebilanz.
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
import { UEMS_HAUPTZAEHLER } from './glossar';
import { berichtRoute, hashForRoute, kennzahlRoute, messstelleRoute, type Route } from './nav';
import { zahlText } from './uemsEreignis';

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
 * Bezugsgröße (AP-09), Ereignis (AP-07) und Box (AP-06 IP-16) — D3. Die
 * Kostenstelle hat seit IP-9 ihre Karte im Reiter „Kostenstellen“ der Welt
 * Messstellen (`#/portfolio/messstellen?reiter=kostenstellen&kostenstelle=4200`,
 * mit Zeitraum). Das Gebäude hat seit IP-2 die Seite „Standort › Gebäude“, aber
 * seine Zeile nennt keinen Standort — der Sprung dorthin kommt mit IP-11, bis
 * dahin bleibt sie Text.
 */
export type SprungObjekt =
  | { art: 'messstelle'; id: string; standortId?: string | null; periode?: string | null; version?: number | null; vergleich?: string | null }
  | { art: 'kennzahl'; id: string }
  | { art: 'bericht'; kennung: string }
  | { art: 'geraet'; siteId: string; ref: string; geraetId?: string | null }
  | { art: 'kostenstelle'; kennzeichen: string; periode?: 'tag' | 'monat' | 'jahr' | null; am?: string | null }
  | { art: 'bezugsgroesse' | 'ereignis' | 'box' | 'gebaeude'; kennzeichen: string };

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
        // AP-13 IP-5: die Wahl des Umschalters; „aus“ ist die Vorgabe und steht nie in der Adresse.
        v: o.vergleich ?? null,
      });
    case 'kennzahl':
      return sprung(kennzahlRoute(o.id));
    case 'bericht':
      return sprung(berichtRoute(o.kennung));
    case 'geraet':
      return sprung({ page: 'anlagen', siteId: o.siteId, sub: 'geraet', geraet: { ref: o.ref, geraetId: o.geraetId ?? null } });
    case 'kostenstelle':
      // AP-13 IP-9: die Karte der Kostenstelle im Reiter „Kostenstellen“ — der Zeitraum nur mit beiden Angaben.
      return sprung(
        { page: 'portfolio-messstellen', siteId: null, sub: null },
        {
          reiter: 'kostenstellen',
          periode: o.periode && o.am ? o.periode : null,
          am: o.periode && o.am ? o.am : null,
          kostenstelle: o.kennzeichen,
        },
      );
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

// ------------------------------------------------------------------ 6 · Auskunft statt Fehlermeldung (IP-6, Z2–Z4)

/**
 * Die Gründe einer 400 `anfrage_ungueltig` der Werte-Route, denen §5.8 je einen Satz gibt — geschlossen, in der
 * Reihenfolge von `MessstelleWerteRegeln.Grund` (Java). Die zwei weiteren Gründe dort (`raster_ohne_versionen`,
 * `nicht_genau_eine_periode`) gehören der Versions-Historie, nicht der Werte-Route.
 */
export const ABLEHNUNG_GRUENDE = [
  'fehlt',
  'raster_unbekannt',
  'form',
  'nicht_im_raster',
  'von_nicht_vor_bis',
  'ausserhalb',
  'zu_viele_schritte',
  'version_ungueltig',
] as const;

export type AblehnungGrund = (typeof ABLEHNUNG_GRUENDE)[number];

/** So viele Schritte trägt eine Antwort höchstens, in Stunden ein Viertel — Zwilling von `MessstelleWerteRegeln` (2 200 / 550). */
export const HOECHSTENS_SCHRITTE = 2200;
export const HOECHSTENS_STUNDEN = 550;

/** Das Feld einer Ablehnung in Kundenwörtern — „Raster“ ist kein Wort der Oberflächen (E15). */
const FELD_WORT: Readonly<Record<string, string>> = { von: 'Beginn', bis: 'Ende', raster: 'Einteilung', version: 'Version' };

/** Die Grenze, auf der ein Zeitpunkt liegen muss, je Einteilung der Anfrage. */
const GRENZE: Readonly<Record<MessstelleWerteRaster, string>> = {
  viertelstunde: 'Viertelstundengrenze',
  stunde: 'Stundengrenze',
  tag: 'Tagesgrenze',
  monat: 'Monatsgrenze',
  jahr: 'Jahresgrenze',
};

export const ZEITRAUM_UNLESBAR = 'Der Zeitraum konnte nicht gelesen werden ({was}). Wählen Sie einen anderen Zeitraum.';
export const ZEITRAUM_UNLESBAR_OHNE_GRUND = 'Der Zeitraum konnte nicht gelesen werden. Wählen Sie einen anderen Zeitraum.';
export const ZU_VIELE_SCHRITTE =
  'Dieser Zeitraum hat zu viele Schritte (höchstens {schritte}, in Stunden {stunden}). Wählen Sie einen kürzeren Zeitraum.';
export const VERSION_UNLESBAR = 'Die Version in der Adresse konnte nicht gelesen werden (erlaubt sind ganze Zahlen ab 1).';

/** Was in der Klammer von `ZEITRAUM_UNLESBAR` steht — je Grund, mit dem Feld und der Grenze der Anfrage. */
const WAS: Readonly<Record<Exclude<AblehnungGrund, 'zu_viele_schritte' | 'version_ungueltig'>, string>> = {
  fehlt: '{feld} fehlt',
  raster_unbekannt: 'diese Einteilung gibt es nicht',
  form: '{feld} ist kein gültiges Datum',
  nicht_im_raster: '{feld} liegt nicht auf einer {grenze}',
  von_nicht_vor_bis: 'Beginn liegt nicht vor dem Ende',
  ausserhalb: '{feld} liegt vor 2000 oder nach 2100',
};

/**
 * Der Satz einer 400-Ablehnung der Werte-Route (Z2, §5.8): je Grund einer, mit `feld` der Antwort und dem Raster der
 * Anfrage („Beginn liegt nicht auf einer Tagesgrenze“). Ein fremder Grund oder ein Feld, das der Satz braucht und die
 * Antwort nicht nennt, spricht den Satz ohne Klammer — nie eine geratene Ursache.
 */
export function ablehnungSatz(grund: string, feld: string | null, raster: MessstelleWerteRaster): string {
  if (grund === 'zu_viele_schritte') {
    return ZU_VIELE_SCHRITTE.replace('{schritte}', zahlText(HOECHSTENS_SCHRITTE)).replace('{stunden}', zahlText(HOECHSTENS_STUNDEN));
  }
  if (grund === 'version_ungueltig') return VERSION_UNLESBAR;
  const muster = Object.prototype.hasOwnProperty.call(WAS, grund) ? WAS[grund as keyof typeof WAS] : null;
  const wort = feld !== null && Object.prototype.hasOwnProperty.call(FELD_WORT, feld) ? FELD_WORT[feld] : null;
  if (muster === null || (muster.includes('{feld}') && wort === null)) return ZEITRAUM_UNLESBAR_OHNE_GRUND;
  return ZEITRAUM_UNLESBAR.replace('{was}', muster.replace('{feld}', wort ?? '').replace('{grenze}', GRENZE[raster]));
}

/** Z3: eine fremde oder unbekannte Messstelle — nie 403, das verriete, dass es sie gibt (AP-03). */
export const MESSSTELLE_GIBT_ES_NICHT = 'Diese Messstelle gibt es nicht.';
/** Z3/V9 ohne Satz der Route: die Frist der Speicherklasse (AP-12 §5.8 `wert_nicht_mehr_gespeichert_ohne_stand`). */
export const WERT_NICHT_MEHR_GESPEICHERT = 'Dieser Wert wird nicht mehr gespeichert (Aufbewahrung 10 Jahre).';
/** Z5: die Route antwortet nicht — je Abschnitt, mit „Erneut versuchen“; die anderen Abschnitte bleiben stehen. */
export const WERTE_NICHT_ABRUFBAR = 'Die Werte sind gerade nicht abrufbar.';
export const VERLAUF_NICHT_ABRUFBAR = 'Der Verlauf ist gerade nicht abrufbar.';

/**
 * Was eine gescheiterte Anfrage an die Werte-Route dem Kunden sagt. Nur `nicht_abrufbar` ist eine Störung (mit
 * „Erneut versuchen“); die anderen drei sind Auskünfte — dieselbe Anfrage gäbe dieselbe Antwort.
 *  - `abgelehnt` (400): der Satz des Grundes; `neueste` bietet „Neueste zeigen“, wenn die Version der Adresse schuld ist.
 *  - `gibt_es_nicht` (404): die Messstelle — auch eine fremde.
 *  - `nicht_mehr_gespeichert` (404 `wert_nicht_mehr_gespeichert`, V9/O19): der Satz der Route. ⚠ `sprung` ist heute
 *    IMMER `null`: den Code sendet die Route erst mit AP-12 IP-16, und ihr Körper nennt den Berichtsstand nur im Satz,
 *    nicht als Feld — ein Sprung ohne Kennung ginge ins Leere.
 */
export type Auskunft =
  | { art: 'abgelehnt'; satz: string; neueste: boolean }
  | { art: 'gibt_es_nicht'; satz: string }
  | { art: 'nicht_mehr_gespeichert'; satz: string; sprung: Sprung | null }
  | { art: 'nicht_abrufbar' };

/** Die Auskunft zu Status und JSON-Körper einer Ablehnung (`ApiError.status`/`.body`); `status` `null` = kein Server. */
export function auskunft(status: number | null, body: unknown, raster: MessstelleWerteRaster): Auskunft {
  const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const text = (feld: string): string | null => (typeof b[feld] === 'string' && b[feld] !== '' ? (b[feld] as string) : null);
  if (status === 400) {
    const grund = text('code') === 'anfrage_ungueltig' ? text('grund') : null;
    return {
      art: 'abgelehnt',
      satz: grund === null ? ZEITRAUM_UNLESBAR_OHNE_GRUND : ablehnungSatz(grund, text('feld'), raster),
      neueste: grund === 'version_ungueltig',
    };
  }
  if (status === 404) {
    if (text('code') === 'wert_nicht_mehr_gespeichert') {
      return { art: 'nicht_mehr_gespeichert', satz: text('message') ?? WERT_NICHT_MEHR_GESPEICHERT, sprung: null };
    }
    return { art: 'gibt_es_nicht', satz: MESSSTELLE_GIBT_ES_NICHT };
  }
  return { art: 'nicht_abrufbar' };
}

/**
 * Ein Leerzustand nach dem Muster AP-01 IP-8 (Z4): Titel · Satz · der benannte nächste Schritt. `schritt` ist ein NAME:
 * der Wirt macht ihn nur zum Knopf, wenn er das Ziel kennt und das Recht besteht — sonst steht er nicht da.
 */
export interface Leerzustand {
  titel: string;
  satz: string;
  schritt: string | null;
}

/**
 * Z4 · Vergleich ohne passende Messstelle (der Wirt ist IP-5): keine der anderen ist `passend` — der Satz nennt, was
 * gemessen werden müsste. `null`, sobald eine passt. Ohne nächsten Schritt: eine passende Messstelle entsteht nicht im
 * Vergleich.
 */
export function vergleichOhnePassende(basis: MessstelleGroesse, andere: readonly MessstelleGroesse[]): Leerzustand | null {
  if (andere.some((a) => passend(basis, a).passend)) return null;
  return {
    titel: 'Keine passende Messstelle',
    satz: `Keine weitere Messstelle misst ${basis.groesse} ${basis.richtung} in ${basis.einheit}.`,
    schritt: null,
  };
}

/** Z4 · Energiebilanz ohne Hauptzähler (der Wirt ist IP-8, §5.5): „Stellung eintragen“ nur mit Weg und Recht. */
export const OHNE_HAUPTZAEHLER: Leerzustand = {
  titel: `Kein ${UEMS_HAUPTZAEHLER}`,
  satz: `Diese Anlage hat keinen ${UEMS_HAUPTZAEHLER} in der elektrischen Stellung.`,
  schritt: 'Stellung eintragen',
};
