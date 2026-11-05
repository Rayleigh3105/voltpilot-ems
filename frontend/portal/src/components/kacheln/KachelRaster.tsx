import type { ReactNode } from 'react';
import { useRasterLuecken } from './rasterLuecken';

/**
 * Das Kachelraster des Cockpits: aufeinanderfolgende Kachel-Bausteine teilen
 * EIN Raster (`stapelMitRaster` in `AnlagenPage`). Steht neben der letzten
 * Kachel einer Zeile eine leere Spalte, übernimmt sie den Rest
 * (`rasterLuecken.ts`) - die Reihenfolge bleibt.
 */
export function KachelRaster({ children }: { children: ReactNode }) {
  const ref = useRasterLuecken<HTMLElement>();
  return (
    <section ref={ref} className="vp-kraster" aria-label="Kacheln">
      {children}
    </section>
  );
}
