import { currentUser } from './auth';

/**
 * „Später einrichten“ je Kundenbereich (Anlage-Flow a1, F6). Der Wunsch lebte nur im Speicher der
 * Seite: nach jedem Neuladen und jeder Anmeldung kam der Vollbild-Assistent wieder, beim Register,
 * mit leeren Feldern. Jetzt hält ihn der Browser je Kundenbereich; der Weg zurück bleibt das Banner
 * „Einrichtung fortsetzen“. Ein gesperrter Speicher (privates Fenster) ist kein Fehler - dann gilt
 * wieder „nicht später“, wie vorher.
 */
const SCHLUESSEL = 'vp.einrichtung.spaeter';

function schluessel(): string {
  return `${SCHLUESSEL}.${currentUser().tenantId ?? ''}`;
}

export function einrichtungSpaeter(isAdmin: boolean): boolean {
  if (isAdmin) return false;
  try {
    return localStorage.getItem(schluessel()) === '1';
  } catch {
    return false;
  }
}

export function merkeEinrichtungSpaeter(spaeter: boolean): void {
  try {
    if (spaeter) localStorage.setItem(schluessel(), '1');
    else localStorage.removeItem(schluessel());
  } catch {
    // Speicher gesperrt: der Wunsch gilt bis zum nächsten Laden.
  }
}
