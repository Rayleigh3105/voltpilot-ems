/**
 * Die einmalige Karte „Ihre Anlage ist live“ über dem Cockpit (Anlage-Flow a1, D7). Der Anlege-Fluss endet
 * ohne Warte-Bildschirm im Cockpit, wie es heute ist; sobald die neue Anlage ihre ersten Werte zeigt,
 * erscheint die Karte darüber - einmal, mit genau einem nächsten Schritt. Der Browser merkt sich je Anlage,
 * dass sie noch aussteht; das Schließen oder der Schritt räumt sie ab.
 *
 * Bewusst klein und ohne Abhängigkeiten: das Cockpit gehört zum Einstiegs-Bündel, die Karte selbst wird
 * nachgeladen (`components/ErsteWerteKarte.tsx`). Ein gesperrter Speicher (privates Fenster) ist kein
 * Fehler - dann erscheint die Karte eben nicht.
 */
const SCHLUESSEL = 'vp.erste-werte.';

export function merkeErsteWerte(siteId: string): void {
  try {
    localStorage.setItem(SCHLUESSEL + siteId, '1');
  } catch {
    // Speicher gesperrt: keine Karte.
  }
}

export function ersteWerteOffen(siteId: string): boolean {
  try {
    return localStorage.getItem(SCHLUESSEL + siteId) === '1';
  } catch {
    return false;
  }
}

export function ersteWerteErledigt(siteId: string): void {
  try {
    localStorage.removeItem(SCHLUESSEL + siteId);
  } catch {
    // Speicher gesperrt: nichts zu räumen.
  }
}
