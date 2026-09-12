/**
 * Die Anzeige-Rolle „gilt als Gesamt-PV meiner Anlage" (Konzept
 * `vp-helfer-konzept-h1` §2.2). Sie ist eine reine ANZEIGE-Wahl je Standort:
 * welcher berechnete Wert (Gesamtwert) auf dem Cockpit als PV gilt. Es gibt
 * dafür (noch) kein Server-Feld — der Formel-Vertrag AP-10 trägt nur die
 * Rechnung, nicht die Rolle. Bis es eines gibt, lebt die Wahl je Gerät im
 * Browser (`localStorage`); der berechnete Wert selbst liegt im Server und ist
 * überall auffindbar. Genau EINE je Standort.
 *
 * ⚠ Kein Rechnen, keine Steuerung — nur, welchen bereits gespeicherten Wert die
 * Übersicht als PV zeigt. Die Steuerung bleibt unberührt (Konzept §2.6).
 */

const PREFIX = 'vp:gesamtwert-pv:';

function verfuegbar(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Die als Gesamt-PV markierte Messstelle dieses Standorts, oder null. */
export function gesamtPv(siteId: string): string | null {
  const s = verfuegbar();
  if (!s) return null;
  try {
    return s.getItem(PREFIX + siteId);
  } catch {
    return null;
  }
}

/** Setzt (genau eine) oder löscht die Gesamt-PV-Markierung des Standorts. */
export function setzeGesamtPv(siteId: string, messstelleId: string | null): void {
  const s = verfuegbar();
  if (!s) return;
  try {
    if (messstelleId) s.setItem(PREFIX + siteId, messstelleId);
    else s.removeItem(PREFIX + siteId);
  } catch {
    /* ein voller/gesperrter Speicher ist kein Grund, die Fläche zu stürzen */
  }
}

/** Ist DIESE Messstelle die Gesamt-PV des Standorts? */
export function istGesamtPv(siteId: string, messstelleId: string): boolean {
  return gesamtPv(siteId) === messstelleId;
}
