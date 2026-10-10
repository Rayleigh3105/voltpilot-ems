/**
 * Der Reiter „Energiebilanz“ einer Anlage als Fakt (UEMS AP-13 IP-8).
 *
 * ⚠ EIGENES MODUL (Bündel-Wächter `test/bundle-smoke.sh`, 09.10.2026): `useAnlageSurface` braucht beim ersten
 * Bild nur diese Projektion; `anlageEnergiebilanz.ts` zog dafür das ganze Bilanz-Bild samt `kennzahlKarte.ts`,
 * `uemsKennzahl.ts` und `uemsErgebnis.ts` ins Einstiegs-Bündel. `anlageEnergiebilanz.ts` reicht beides
 * unverändert weiter.
 */
import type { Bilanz } from './api';
import type { AnlageSurface } from './surface';

/** Der Reiter erscheint nur mit Hauptzähler in der Stellung (AP-13 §5.5) - sonst bleibt der Verlauf zeichengleich. */
export const hatHauptzaehler = (b: Bilanz | null | undefined): boolean => (b?.hauptzaehler.length ?? 0) > 0;

/** Die Projektion mit dem Reiter - derselbe Fakt in `useAnlageSurface` und auf der Bühne. */
export const mitEnergiebilanz = (surface: AnlageSurface, bilanz: Bilanz | null): AnlageSurface =>
  hatHauptzaehler(bilanz) ? { ...surface, energiebilanz: true } : surface;
