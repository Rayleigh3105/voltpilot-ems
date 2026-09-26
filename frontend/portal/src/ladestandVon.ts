/**
 * Der Satz „Ladestand von: <Batterie>" - die EINE Formulierung, damit Cockpit
 * und Geräteseite sie nicht zweimal verschieden erfinden (P6).
 *
 * ⚠ EIGENES MODUL, nicht in `batterieAnschluss.ts` (UX-Review V-01,
 * 24.09.2026): das Cockpit brauchte aus dem 1 800-Zeilen-Anschluss-Assistenten
 * nur diese drei Zeilen - und zog dafür das ganze Modul samt `selbstbau.ts` ins
 * Einstiegs-Bündel. `batterieAnschluss.ts` reicht es unverändert weiter.
 */
export function ladestandVon(label: string | null | undefined): string | null {
  const name = (label ?? '').trim();
  return name === '' ? null : `Ladestand von: ${name}`;
}
