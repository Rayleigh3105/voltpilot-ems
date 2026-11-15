import type { Energieziel } from './api';

/**
 * Der Name eines Energieziels, ohne das ganze Bild (`energiezielBild.ts` reicht ihn unverändert weiter).
 *
 * Eigenes Modul, weil die Meldungen ihn für ihre Ortswahl brauchen (`NeueUeberwachung`): über `energiezielBild.ts`
 * zog diese eine Zeile Energieziele, Bezugsbasis, Kennzahl- und Messstellen-Bild mit in jeden Aufruf der Meldungen
 * (Performance Welle 3, gut 50 kB gz). Rollup beschneidet ein Modul mit Top-Level-Code nicht.
 */
const zp = (zielperiode: string) => [zielperiode.slice(0, 7), zielperiode.slice(8)] as const;

/** Name vor Kennzeichen (V6): „Energieziel 2029“, über den Jahreswechsel „Energieziel 2028/29“. */
export function energiezielName(ez: Pick<Energieziel, 'zielperiode'>): string {
  const [von, bis] = zp(ez.zielperiode);
  return von.slice(0, 4) === bis.slice(0, 4) ? `Energieziel ${bis.slice(0, 4)}` : `Energieziel ${von.slice(0, 4)}/${bis.slice(2, 4)}`;
}
