// Die Kennung der v1-Messwerte als eigenes, winziges Modul: `livePuls.ts` (im Einstieg) braucht nur
// sie. Läge sie in `verlauf.ts`, zöge dieser eine Wert das ganze Verlaufs-Modul ins erste Bild
// (Bündel-Wächter `test/bundle-smoke.sh`). `verlauf.ts` reicht sie unverändert weiter.

/**
 * A synthetic entityId for a v1 site-level measurement. It carries no colon so
 * it round-trips through the `m={entityId}:{channel}` deep-link cleanly.
 */
export const V1_ENTITY = 'anlage';
