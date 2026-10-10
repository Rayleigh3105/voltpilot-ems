/**
 * Die Schrittleiste des Anlege-Flusses.
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): das Cockpit (`anlegeNurMessen.ts`) braucht
 * beim ersten Bild nur die Namen der Schritte; `anlageFlow.ts` zog dafür die ganze Logik des Anlege-Flusses ins
 * Einstiegs-Bündel. `anlageFlow.ts` reicht die Leiste unverändert weiter.
 */

/**
 * The step rail of the flow, in order (register-first). AE5 (spec §3) moved the
 * device claim ("Gerät") ahead of the adaptive last step: the entity bootstrap +
 * usage-profile + auto-start seeding need the Anlage's master data AND its
 * gateway device in place, so it is the last, adaptive step.
 *
 * Its LABEL is **„Betrieb"** since Steuerung Stufe 0 „Entwirrung"
 * (Captain 25.08.2026: „Anwendung" ist kein Kundenwort mehr; der Schritt fragt
 * nach dem BETRIEB der Anlage — Profil, EIN Betriebsmodell, Speicherschonung).
 * Es war davor „Anwendungen" und davor „Nutzung"; die Komponenten-Id und jede
 * Route bleiben.
 */
export const FLOW_STEPS = ['Anlage', 'Register', 'Gerät', 'Betrieb'] as const;
