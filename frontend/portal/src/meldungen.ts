/**
 * Das Meldungs-Center, rein (Alerting Scheibe 1+2, Konzept vp-alerting-konzept-m1 §6.8/§6.9).
 *
 * Die Kundenwörter dieser Fläche (Entscheid 6A, 15.10.2026): „Meldung", „Überwachung",
 * „Hinweis · Warnung · Dringend", „Gesehen". Sie stehen hier als Konstanten, bevor sie irgendwo
 * im Markup auftauchen (`frontend/portal/AGENTS.md` „Kundenwörter zuerst …"); der volle Eintrag im
 * Fachmodell-Glossar (`docs/fachmodell`) ist für diese Scheibe bewusst zurückgestellt - das
 * Glossar verlangt belegte Zeilenverweise gegen einen festgehaltenen Repo-Stand, den eine neue
 * Scheibe noch nicht hat; die Wörter selbst sind in der Fläche schon verbindlich.
 *
 * Scheibe 2 (§6.3, §6.4, §6.8) fügt vier Wörter derselben, noch zurückgestellten Familie hinzu:
 * „Überwachen" (das Menü-Verb am Wert), „überwacht" (die Marke an einem überwachten Wert),
 * „Rückkehrschwelle" und „Erholdauer" (die zwei genannten, änderbaren Vorgaben der Bedingung, §9).
 * Dieselbe Begründung wie oben gilt unverändert: sie sind Teil der noch nicht fachmodell-reifen
 * Überwachungs-Mechanik, nicht eigenständige, von ihr unabhängige Begriffe.
 *
 * Nur das Lazy-Stück `pages/MeldungenPage.tsx` importiert dieses Modul - die Glocke und die
 * Zustands-Anzeige im Einstiegs-Bündel nutzen das schlankere `meldungenApi.ts` direkt.
 */
import { meldungenApi } from './meldungenApi';
import type { Meldung, Schwere } from './meldungenApi';
import { energiezielRoute, hashForRoute, kennzahlRoute, messstelleRoute } from './nav';
import { katalogEintrag } from './werteKatalog';

export { meldungenApi };
export type { Meldung, MeldungZustand, Schwere, UeberwachungsRegel } from './meldungenApi';

export const WORT_MELDUNG = 'Meldung';
export const WORT_MELDUNGEN = 'Meldungen';
export const WORT_UEBERWACHUNG = 'Überwachung';
export const WORT_GESEHEN = 'Gesehen';

/** Das Menü-Verb am Wert (§6.8 "Überwachen" am Wert) - siehe Kommentar oben zur Zurückstellung. */
export const WORT_UEBERWACHEN = 'Überwachen';
/** Die Marke an einem bereits überwachten Wert (§6.8 "Marke „überwacht“"). */
export const WORT_UEBERWACHT = 'überwacht';
/** Die Rückkehrschwelle einer Bedingung (§6.4, §9) - VoltPilot wählt und nennt sie, änderbar im Blatt. */
export const WORT_RUECKKEHRSCHWELLE = 'Rückkehrschwelle';
/** Die Erholdauer einer Bedingung (§6.4, §9) - erst so lange zurück, dann "wieder normal". */
export const WORT_ERHOLDAUER = 'Erholdauer';

/** Hinweis · Warnung · Dringend (Entscheid 6A) - nicht Severity, nicht Priorität. */
export const SCHWERE_WORT: Record<Schwere, string> = {
  hinweis: 'Hinweis',
  warnung: 'Warnung',
  dringend: 'Dringend',
};

/** Reihenfolge in der Liste (§6.8 Entwurf 2): Dringend vor Warnung vor Hinweis. */
const SCHWERE_RANG: Record<Schwere, number> = { dringend: 0, warnung: 1, hinweis: 2 };

/**
 * Die Wertart als Satzname, großgeschrieben für den Satzanfang (§6.8 Meldungsliste). Seit
 * Scheibe 2 dient der Werte-Katalog (`werteKatalog.ts`) dem Portal wirklich - er deckt `box.erreichbar`
 * und `datenquelle.liefert_daten` (Scheibe 1) ebenso ab wie die neuen `anlagenfluss`-Wertarten;
 * eine unbekannte Wertart fällt auf ihren rohen Schlüssel zurück, nie auf eine erfundene Übersetzung.
 */
export function wertartSatzname(wertart: string): string {
  const satzname = katalogEintrag(wertart)?.satzname ?? wertart;
  return satzname.charAt(0).toUpperCase() + satzname.slice(1);
}

/** Jetzt-Reiter: Dringend vor Warnung vor Hinweis, darin das Älteste zuerst (§6.8). */
export function sortiereJetzt(meldungen: readonly Meldung[]): Meldung[] {
  return [...meldungen].sort((a, b) => {
    const rang = SCHWERE_RANG[a.schwere] - SCHWERE_RANG[b.schwere];
    return rang !== 0 ? rang : a.ausgeloestAm.localeCompare(b.ausgeloestAm);
  });
}

/** Verlauf-Reiter: jüngste zuerst. */
export function sortiereVerlauf(meldungen: readonly Meldung[]): Meldung[] {
  return [...meldungen].sort((a, b) => b.ausgeloestAm.localeCompare(a.ausgeloestAm));
}

/**
 * Die Marke „eigene Überwachung“ (Alerting Scheibe 5, §6.4 Nr. 7) - jede Meldung einer der fünf
 * Scheibe-5-Wertarten ist strukturell IMMER aus einer selbst angelegten Überwachung (Entscheid 9A:
 * kein Läufer sät eine davon ab Werk) - die Marke braucht dafür keine eigene Herkunfts-Abfrage.
 */
export const WORT_EIGENE_UEBERWACHUNG = 'eigene Überwachung';

/** Die fünf Wertarten dieser Scheibe (§6.3) - bezug `messstelle`/`kennzahl`/`energieziel`. */
const SCHEIBE_5_WERTARTEN = new Set([
  'kennzahl.bezugsbasis',
  'energieziel.kurs',
  'messstelle.menge',
  'messstelle.beobachtung',
  'messstelle.monat_unvollstaendig',
]);

/** Ob eine Meldung aus einer der fünf Scheibe-5-Wertarten stammt (§6.4 Nr. 7). */
export function istEigeneUeberwachung(wertart: string): boolean {
  return SCHEIBE_5_WERTARTEN.has(wertart);
}

/** Die Kennung aus einem rohen Bezug (`"kennzahl:<uuid>"` → `"<uuid>"`) - wie der Server ihn baut. */
function bezugId(bezugKennung: string | null): string | null {
  if (!bezugKennung) return null;
  const teile = bezugKennung.split(':');
  return teile.length === 2 ? teile[1] : null;
}

/**
 * „Zur Auffälligkeit zur Quelle“ (§6.4 Nr. 7): wohin eine Scheibe-5-Meldung führt - `null` für jede
 * andere Wertart (sie hat schon `anlageName`). Es gibt heute keine eigene Ebene „Auffälligkeiten“ an
 * der Kennzahl-Seite (nur `ebene: 'bezugsbasis'`, `nav.ts`) - „Zur Kennzahl“ führt auf die Kennzahl
 * selbst, auf der eine Auffälligkeit sichtbar wird, statt eine nicht vorhandene Adresse zu erfinden.
 */
export function meldungQuelleLink(m: Meldung): { label: string; hash: string } | null {
  const id = bezugId(m.bezugKennung);
  if (!id) return null;
  switch (m.wertart) {
    case 'kennzahl.bezugsbasis':
      return { label: 'Zur Kennzahl', hash: hashForRoute(kennzahlRoute(id)) };
    case 'energieziel.kurs':
      return { label: 'Zum Energieziel', hash: hashForRoute(energiezielRoute(id)) };
    case 'messstelle.menge':
    case 'messstelle.beobachtung':
    case 'messstelle.monat_unvollstaendig':
      return { label: 'Zur Messstelle', hash: hashForRoute(messstelleRoute(id)) };
    default:
      return null;
  }
}

/** `?anlage=<id>` aus der rohen Adresse - die Seite liest ihre Filter selbst (kein Routen-Feld, §6.2). */
export function anlageAusHash(hash: string): string | null {
  const frage = hash.indexOf('?');
  if (frage < 0) return null;
  return new URLSearchParams(hash.slice(frage + 1)).get('anlage');
}

/**
 * `?reiter=verlauf` aus der rohen Adresse (Alerting Scheibe 5, Entscheid 14A): das Energiemanagement-
 * Verzeichnis zeigt EINE Zeile, die direkt auf den Verlauf des Meldungs-Centers zeigt
 * (`#/meldungen?reiter=verlauf`) - derselbe Filter-Weg wie `anlageAusHash`, kein Routen-Feld.
 */
export function reiterAusHash(hash: string): 'jetzt' | 'verlauf' | 'regeln' | null {
  const frage = hash.indexOf('?');
  if (frage < 0) return null;
  const wert = new URLSearchParams(hash.slice(frage + 1)).get('reiter');
  return wert === 'jetzt' || wert === 'verlauf' || wert === 'regeln' ? wert : null;
}
