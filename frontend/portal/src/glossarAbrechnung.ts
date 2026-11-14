/*
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`): `glossar.ts` liegt als Ganzes im Einstiegs-Bündel; diese
 * Wörter braucht nur Verlauf › Energie (ein Lazy-Stück). Regel und Bedeutung: Fachmodell-Glossar „Abrechnung prüfen“
 * (`docs/fachmodell/glossar.md`), dort zuerst ändern.
 */
/**
 * **Abrechnung prüfen** (Bedienkonzept `vp-privatkunde-bedienkonzept` §7, Fachmodell-Glossar „Abrechnung prüfen“):
 * die Wörter der Karte und des fünften Abschnitts der Zeitleiste. Kein Urteil — „Unterschied“, nie „stimmt“.
 */
export const ABRECHNUNG_PRUEFEN = {
  titel: 'Abrechnung prüfen',
  zeitraum: 'Zeitraum',
  gemessen: 'Gemessen',
  lautRechnung: 'Laut Rechnung',
  unterschied: 'Unterschied',
  eintragen: 'eintragen',
  fruehere: 'Frühere Prüfungen',
  netzbezug: 'Netzbezug',
  einspeisung: 'Einspeisung',
  summiert: 'aus Messwerten summiert',
  standard: 'Gemessen am Netzanschluss. Für die Rechnung zählt der Zähler Ihres Messstellenbetreibers.',
} as const;
