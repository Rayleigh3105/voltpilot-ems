import type { MessstelleWerte, MessstelleZuordnung } from './api';

/**
 * „Werte kommen an der Box an, gehören aber zu keiner Messreihe“ (Untersuchung Messkunde-Portalweg, 21.09.2026):
 * der Komponente fehlt die Datenquelle, der Writer legt die Werte ohne Reihe ab. Register und Werte-Route tragen
 * dafür dasselbe Wort (`zuordnung: 'nicht_zugeordnet'`); die Liste zeigt den Satz des Servers, die Werte-Karte
 * diesen hier — mit demselben Anfang, damit beide Flächen dasselbe sagen.
 *
 * Informieren statt bevormunden: keine Zahl ändert sich, kein Wort über Steuern oder Geld. Der Weg ist der
 * Messen-Assistent, Schritt 2 („Datenquellen aus Ihren Geräten“, `DQ_TITEL`) — seit AP-01 E5 = A mit Knopf
 * (`ZUORDNUNG_KNOPF`, nur mit Recht); was vorher ankam, wird dabei nicht nachträglich zugeordnet — der Satz
 * verspricht es darum auch nicht.
 */
export const ZUORDNUNG_ETIKETT = 'Daten kommen an – noch keiner Messreihe zugeordnet';

export const ZUORDNUNG_SATZ =
  'Die Box empfängt Werte dieses Zählers, sie gehören aber noch zu keiner Messreihe – darum steht hier noch nichts. ' +
  'Zuordnen lässt sich der Zähler im Messen-Assistenten, Schritt 2 „Datenquellen aus Ihren Geräten“. ' +
  'Werte, die vorher angekommen sind, bleiben ohne Messreihe.';

/** Der Fall, wenn eine der beiden Antworten ihn trägt (ein fehlendes Feld heißt: kein Fall). */
export function zuordnungDerWerte(...antworten: (MessstelleWerte | null | undefined)[]): MessstelleZuordnung | null {
  return antworten.some((a) => a?.zuordnung === 'nicht_zugeordnet') ? 'nicht_zugeordnet' : null;
}
