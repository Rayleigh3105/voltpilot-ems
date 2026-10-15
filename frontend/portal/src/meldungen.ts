/**
 * Das Meldungs-Center, rein (Alerting Scheibe 1, Konzept vp-alerting-konzept-m1 §6.8/§6.9).
 *
 * Die Kundenwörter dieser Fläche (Entscheid 6A, 15.10.2026): „Meldung", „Überwachung",
 * „Hinweis · Warnung · Dringend", „Gesehen". Sie stehen hier als Konstanten, bevor sie irgendwo
 * im Markup auftauchen (`frontend/portal/AGENTS.md` „Kundenwörter zuerst …"); der volle Eintrag im
 * Fachmodell-Glossar (`docs/fachmodell`) ist für diese Scheibe bewusst zurückgestellt - das
 * Glossar verlangt belegte Zeilenverweise gegen einen festgehaltenen Repo-Stand, den eine neue
 * Scheibe noch nicht hat; die Wörter selbst sind in der Fläche schon verbindlich.
 *
 * Nur das Lazy-Stück `pages/MeldungenPage.tsx` importiert dieses Modul - die Glocke und die
 * Zustands-Anzeige im Einstiegs-Bündel nutzen das schlankere `meldungenApi.ts` direkt.
 */
import { meldungenApi } from './meldungenApi';
import type { Meldung, Schwere } from './meldungenApi';

export { meldungenApi };
export type { Meldung, MeldungZustand, Schwere, UeberwachungsRegel } from './meldungenApi';

export const WORT_MELDUNG = 'Meldung';
export const WORT_MELDUNGEN = 'Meldungen';
export const WORT_UEBERWACHUNG = 'Überwachung';
export const WORT_GESEHEN = 'Gesehen';

/** Hinweis · Warnung · Dringend (Entscheid 6A) - nicht Severity, nicht Priorität. */
export const SCHWERE_WORT: Record<Schwere, string> = {
  hinweis: 'Hinweis',
  warnung: 'Warnung',
  dringend: 'Dringend',
};

/** Reihenfolge in der Liste (§6.8 Entwurf 2): Dringend vor Warnung vor Hinweis. */
const SCHWERE_RANG: Record<Schwere, number> = { dringend: 0, warnung: 1, hinweis: 2 };

/** Die Wertart als Satzname, solange der Werte-Katalog selbst dem Portal noch nicht dient (Scheibe 2). */
const WERTART_SATZNAME: Record<string, string> = {
  'box.erreichbar': 'Die Box',
  'datenquelle.liefert_daten': 'Die Datenquelle',
};

export function wertartSatzname(wertart: string): string {
  return WERTART_SATZNAME[wertart] ?? wertart;
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

/** `?anlage=<id>` aus der rohen Adresse - die Seite liest ihre Filter selbst (kein Routen-Feld, §6.2). */
export function anlageAusHash(hash: string): string | null {
  const frage = hash.indexOf('?');
  if (frage < 0) return null;
  return new URLSearchParams(hash.slice(frage + 1)).get('anlage');
}
