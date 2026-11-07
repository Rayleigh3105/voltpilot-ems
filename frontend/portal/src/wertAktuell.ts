/**
 * Trägt ein Gerät gerade einen AKTUELLEN Wert? Gesund (`ok`), nicht verwaist, mit Lesung.
 *
 * Die EINE Regel für den Anlagenkopf und die Gruppenköpfe der Anlage (`aufbauBaum.komponenteAktuell`,
 * PR 1778/1779) und für die Erzeugung des Cockpit-Flusses (`flussBilanz`): sonst zählten Anlage und
 * Cockpit verschiedene Geräte zur selben Sonne. Ein eigenes, abhängigkeitsfreies Modul, damit das
 * Cockpit die Regel teilt, ohne den Anlagen-Baum mitzuladen.
 */
export function wertAktuell(x: { health: string; verwaist: boolean; hatWert: boolean }): boolean {
  return x.health === 'ok' && !x.verwaist && x.hatWert;
}
