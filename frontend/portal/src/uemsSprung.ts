/**
 * Sprungziel einer Herkunfts-Zeile und der EINE Weg aus dem Anlagen-Cockpit (UEMS AP-13, E10 · IP-11).
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): die Schale (`App.tsx`) und das
 * Cockpit (`CockpitMessstellenWeg`) brauchen beim ersten Bild nur diese zwei Fragen; `uemsOberflaechen.ts`
 * zog dafür die ganze Oberflächen-Logik samt `uemsEreignis.ts` ins Einstiegs-Bündel.
 * `uemsOberflaechen.ts` reicht alles hier unverändert weiter.
 */
import { UEMS_MESSSTELLE } from './glossarEinstieg';
import { berichtRoute, hashForRoute, kennzahlRoute, messstelleRoute, type Route } from './nav';

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
  | {
      art: 'messstelle';
      id: string;
      standortId?: string | null;
      periode?: string | null;
      version?: number | null;
      vergleich?: string | null;
      /** Aus „Stand an einem Tag ansehen“: die Seite liest diesen Tag, nur lesend. */
      stand?: string | null;
    }
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
        stand: o.stand ?? null,
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

// ------------------------------------------- 3c · Der EINE Weg aus dem Cockpit (IP-11, E2 = A, O18)

/** „Messstellen dieser Anlage“ — der Titel des Wegs unter der Bühne des Anlagen-Cockpits. */
export const COCKPIT_WEG_TITEL = `${UEMS_MESSSTELLE}n dieser Anlage`;

export interface CockpitWeg {
  titel: string;
  /** Die Zählung des Registers WÖRTLICH („9 von 9 Messstellen liefern Daten“) — im Portal wird nichts gezählt. */
  text: string;
  sprung: Sprung;
}

/**
 * Was das Anlagen-Cockpit von AP-13 bekommt — und NUR das (E2 = A, Q4): EINEN Weg zu den Messstellen
 * dieser Anlage, mit der Zählung des Registers und dem Sprung in genau dieses gefilterte Register.
 *
 * **Keine Zahl des Cockpits wird getauscht.** „Netzbezug heute 1 212 kWh“ (Rollup der Box) und
 * „MS-01 1 209 kWh“ sind zwei Abtastungen desselben Zählers (AP-07 W11), kein Fehler und kein Abgleich;
 * die Umstellung der Cockpit-Leiste auf Messstellen-Zahlen ist der Bestätigungsschritt in AP-14.
 *
 * `null` = kein Weg: eine Anlage ohne Messstelle bekommt keinen (O18 — ein reiner Betriebskunde sieht
 * keine Kachel, keinen Baustein und kein neues Wort).
 */
export function cockpitWeg(siteId: string, aggregat: { gesamt: number; text: string } | null): CockpitWeg | null {
  if (!aggregat || aggregat.gesamt === 0) return null;
  return {
    titel: COCKPIT_WEG_TITEL,
    text: aggregat.text,
    sprung: sprung({ page: 'portfolio-messstellen', siteId: null, sub: null }, { anlage: siteId }),
  };
}
