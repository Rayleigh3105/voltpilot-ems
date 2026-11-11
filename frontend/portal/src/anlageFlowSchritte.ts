/**
 * Die Schrittleiste des Anlege-Flusses.
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): das Cockpit (`anlegeNurMessen.ts`) braucht
 * beim ersten Bild nur die Namen der Schritte; `anlageFlow.ts` zog dafür die ganze Logik des Anlege-Flusses ins
 * Einstiegs-Bündel. `anlageFlow.ts` reicht die Leiste unverändert weiter.
 */

/**
 * Die Schrittleiste des Anlege-Flusses (Anlage-Flow a1, Konzept §5.3): drei feste Schritte, die Leiste
 * ändert sich nie - Adresse (wo die Anlage steht) · Box (die Kennung) · Anlage (bestätigen, was dazugehört).
 * Der frühere Schritt „Register“ ist ein Link in „Anlage“ (R4), „Betrieb“ ist entfallen (D6, R14): die
 * Steuerung schlägt den Betrieb später vor.
 */
export const FLOW_STEPS = ['Adresse', 'Box', 'Anlage'] as const;
