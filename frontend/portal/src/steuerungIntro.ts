/**
 * Der ERKLÄRKASTEN der Steuerung — Steuerung Stufe 8 (Konzept
 * `data/vp-steuerung-konzept-b3` §3.9 „Erstbegegnung").
 *
 * Die Steuerungs-Seite hat seit dem Umbau drei Zonen mit drei verschiedenen
 * Fragen (§3.1). Wer sie zum ersten Mal öffnet, sieht drei Kapseln und muss
 * sich ihren Zusammenhang selbst erschliessen — genau der Befund, der die
 * ganze Runde ausgelöst hat („das versteht kein Mensch"). Der Kasten sagt ihn
 * in drei Sätzen und verschwindet danach für immer.
 *
 * **Drei Entscheidungen, die man kennen muss:**
 *
 *  1. **JE ORGANISATION gemerkt, nicht je Anlage.** Eine Erklärung, die man
 *     auf fünf Anlagen fünfmal wegklicken muss, ist keine Erklärung mehr,
 *     sondern eine Belästigung. Der Speicher ist deshalb die kunden-weite
 *     Schicht (`scope=tenant`, `layer=eigen`, `surface=cockpit`) — sie ist
 *     kunden-schreibbar (E2) und wird von KEINEM anderen Pfad gelesen: die
 *     Anlagen-Auflösung liest vom Mandanten nur die `vorgabe`, und die
 *     Portfolio-Fläche hat ihre eigene. Der Kasten kann dort also nichts
 *     überschreiben.
 *  2. **Kein neuer Speicher** (§4): die Marke wohnt in `document.seen`, dem
 *     Layout-Dokument, das es längst gibt. `saysSomething` liest sie nicht —
 *     ein Dokument mit nur einer Marke ist keine Anordnungs-Schicht.
 *  3. **`localStorage` ist verboten** (§7, die Haus-Regel): der Kasten muss
 *     auf jedem Gerät desselben Kunden weg sein, also gehört die Marke auf
 *     den Server.
 *
 * Rein + deterministisch: kein React, kein Netz.
 */
import type { CockpitLayoutDocument } from './cockpitLayout';

/** Der Schlüssel dieses einen Kastens. */
export const STEUERUNG_INTRO_KEY = 'steuerung-intro';

/** Die Überschrift — sie verspricht genau das, was die drei Zeilen liefern. */
export const STEUERUNG_INTRO_TITEL = 'Drei Zonen, drei Fragen';

/**
 * Die drei Sätze, in der Reihenfolge der Zonen (§3.1). Jeder nennt die Zone
 * beim Namen, unter dem sie auf der Seite steht — ein Erklärkasten, der andere
 * Wörter benutzt als die Überschriften darunter, erklärt nichts.
 */
export const STEUERUNG_INTRO_ZEILEN: readonly string[] = [
  'Jetzt zeigt, was Ihre Anlage gerade automatisch tut — und lässt Sie eingreifen.',
  'Regeln sind Ihre Wünsche: VoltPilot schlägt Ihnen welche vor, Sie entscheiden.',
  'Betriebsmodelle sind die Betriebsweise Ihres Speichers — davon läuft immer genau eines.',
];

/** Die Beschriftung des Wegklick-Knopfes. */
export const STEUERUNG_INTRO_SCHLIESSEN = 'Verstanden';

/**
 * Der Titel des Wegklick-Knopfes — er sagt, was das Wegklicken BEDEUTET.
 * „Verstanden" allein liesse offen, ob der Kasten morgen wieder da ist.
 */
export const STEUERUNG_INTRO_SCHLIESSEN_TITEL =
  'Diese Erklärung nicht mehr anzeigen — für alle Ihre Anlagen';

/**
 * Wurde dieser Kasten schon weggeklickt? Eine fehlende Antwort (älteres
 * Backend, Ladefehler) heisst **NICHT gesehen** — ein Erklärkasten, den man
 * einmal zu viel sieht, ist harmlos; einer, der beim ersten Mal fehlt, ist es
 * nicht.
 */
export function introGesehen(
  document: CockpitLayoutDocument | null | undefined,
  key: string = STEUERUNG_INTRO_KEY,
): boolean {
  return (document?.seen ?? []).includes(key);
}

/**
 * Das Dokument, das den Kasten als gesehen merkt — **additiv**: jede andere
 * Aussage des Dokuments (Anordnung, eigene Auswertungen) reist unverändert
 * mit. Ein Wegklicken darf nie eine Anordnung überschreiben.
 *
 * Ohne bestehendes Dokument entsteht das minimale, das nur die Marke trägt —
 * und das ist per `saysSomething` KEINE Anordnungs-Schicht.
 */
export function mitGesehen(
  document: CockpitLayoutDocument | null | undefined,
  key: string = STEUERUNG_INTRO_KEY,
): CockpitLayoutDocument {
  const basis: CockpitLayoutDocument = document ?? {
    order: [],
    hidden: [],
    shown: [],
    lead: null,
  };
  const seen = basis.seen ?? [];
  return { ...basis, seen: seen.includes(key) ? seen : [...seen, key] };
}
