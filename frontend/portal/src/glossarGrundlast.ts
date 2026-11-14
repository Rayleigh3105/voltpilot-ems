/**
 * Die Wörter der **Grundlast** (Bedienkonzept `vp-privatkunde-bedienkonzept` §5, BK-1 bis BK-3 = A).
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 14.11.2026): `glossar.ts` liegt im Einstiegs-Bündel; jedes
 * Wort dort wiegt im ersten Bild mit, auch wenn es nur eine nachgeladene Karte braucht. Diese Wörter brauchen nur die
 * Karte im Verlauf und die Kachel im Cockpit (beide nachgeladen) - deshalb stehen sie hier und werden von `glossar.ts`
 * NICHT weitergereicht (das zöge sie zurück in den Einstieg). Gegenstück zu `glossarEinstieg.ts`; zuerst ins
 * Fachmodell-Glossar (Pflegeregel: `docs/fachmodell/README.md`).
 *
 * Grundlast = was im Haus immer läuft, auch nachts; gemessen als niedrigste Viertelstunde der Nacht, in Watt. Nicht
 * die „Grundlast“ der Bezugsbasis (`UEMS_GRUNDLAST` in `glossar.ts`, der feste Teil eines Modells in kWh je Periode).
 * Im Laden-Rahmen heißt die höchste Hauslast der letzten 7 Tage seit 14.11.2026 {@link HAUSLAST}.
 * Glossar: `docs/fachmodell/glossar.md` › Grundlast (Privatkunde).
 */
export const GRUNDLAST = 'Grundlast';
export const GRUNDLAST_TYPISCHE_NACHT = 'typische Nacht';
export const GRUNDLAST_LAEUFT_IMMER = 'läuft immer';
export const GRUNDLAST_UNTERZEILE = 'läuft immer, auch nachts';
export const HAUSLAST = 'Hauslast';
