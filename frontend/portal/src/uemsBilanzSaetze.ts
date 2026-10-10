/**
 * Die Kundensätze des Rests einer Bilanz (UEMS AP-10), Vorlagen des Vertrags `bilanz-vectors.json`.
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): das Cockpit (`quoteUnplausibel.ts`)
 * braucht beim ersten Bild nur den einen Satz; `uemsBilanz.ts` zog dafür den ganzen Bilanz-Zwilling samt
 * `uemsErgebnis.ts` und `uemsMessstelle.ts` ins Einstiegs-Bündel. `uemsBilanz.ts` reicht die Sätze unverändert
 * weiter, und sein Test hält sie weiter gegen die Vektor-Datei.
 */

/**
 * Die Kundensätze des Rests, WÖRTLICH die Vorlagen aus `saetze` der Vektor-Datei (`rest_zugeordnet`,
 * `rest_negativ`, `rest_keine_werte`); der Test hält sie dort fest. Ein Rest heißt „nicht
 * zugeordnet" — nie „Verlust", und er nennt keine Ursache. `{zahl}` ist Zahl mit Einheit aus
 * `uemsErgebnis.zahl` (E11).
 */
export const SATZ_REST_ZUGEORDNET = '{zahl} sind keiner Messstelle zugeordnet';
export const SATZ_REST_NEGATIV = 'Messwerte passen nicht zusammen ({zahl})';
export const SATZ_REST_KEINE_WERTE = 'nicht zugeordnet: keine Werte';
