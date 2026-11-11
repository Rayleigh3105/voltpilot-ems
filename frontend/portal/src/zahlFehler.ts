/**
 * Die Sätze an den Zahlenfeldern des Anlege-Schritts (Anlage-Flow a1, F4) - dieselben Grenzen wie der
 * Server (`CreateSiteRequest`) und wie `zahlInGrenzen` in `fleet.ts`. Eigenes Modul: der Anlege-Schritt
 * wird nachgeladen, die Sätze gehören nicht ins Einstiegs-Bündel.
 */

/** Nachkommastellen einer getippten Zahl („29,995“ → 3). */
function nachkommastellen(text: string): number {
  return text.trim().replace(',', '.').split('.')[1]?.length ?? 0;
}

/**
 * Was am Feld eines ct/kWh-Werts steht (anzulegender Wert, Arbeitspreis, Aufschlag) - dieselben
 * Grenzen wie der Server (`CreateSiteRequest`: höchstens drei Nachkommastellen, unter 100.000, nicht
 * negativ; Anlage-Flow a1, F4). `null`: leer oder in Ordnung.
 */
export function ctFehler(text: string, beispiel: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const value = Number(t.replace(',', '.'));
  if (!Number.isFinite(value)) return `Bitte geben Sie eine Zahl in ct/kWh an, z. B. ${beispiel}.`;
  if (value < 0) return 'Der Wert darf nicht negativ sein.';
  if (nachkommastellen(t) > 3 || value >= 100_000) {
    return `Höchstens drei Nachkommastellen und unter 100.000 ct/kWh, z. B. ${beispiel}.`;
  }
  return null;
}

/**
 * Was am Feld „Maximale Einspeiseleistung“ steht - dieselben Grenzen wie der Server (höchstens zwei
 * Nachkommastellen, unter 1.000.000 kW, größer als 0; Anlage-Flow a1, F4). `null`: leer oder in Ordnung.
 */
export function einspeisegrenzeFehler(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const value = Number(t.replace(',', '.'));
  if (!Number.isFinite(value)) return 'Bitte geben Sie die maximale Einspeiseleistung als Zahl in kW an, z. B. 75.';
  if (value <= 0) return 'Die Einspeisegrenze muss größer als 0 kW sein.';
  if (nachkommastellen(t) > 2 || value >= 1_000_000) {
    return 'Höchstens zwei Nachkommastellen und unter 1.000.000 kW, z. B. 29,99.';
  }
  return null;
}
