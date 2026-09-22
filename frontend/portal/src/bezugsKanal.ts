import { erbe, BEZUGSGROESSE } from './uemsKennzahl';
import type { BezugsKanalbindung } from './api';
import { spanneVon, mitternacht, tagPlus } from './bezugsPeriode';
/** K6: dieselben halboffenen Minutenintervalle wie im Server, bezogen auf ganze Kalenderperioden. */
export function periodeGebunden(key: string, art: string, zone: string, bindungen: BezugsKanalbindung[]): boolean {
  try {
    const [von, bis] = spanneVon(key, art);
    if (!von || !bis) return false;
    const a = mitternacht(von, zone), z = mitternacht(tagPlus(bis, 1), zone);
    return bindungen.some(b => Date.parse(b.von) < z && (b.bis === null || Date.parse(b.bis) > a));
  } catch { return false; }
}

/** Zahlen einer Gradtag-Regel anzeigen; gemessene Zustandsnamen bleiben wortgleich. */
export const kanalRegelText = (regel: string): string => regel.startsWith('Gradtage G') ? regel.replace(/\./g, ',') : regel;

/** Dieselben wertbezogenen Kennzeichen wie an einer Kennzahl; Quellenbeschreibungen bleiben in der Herkunft. */
export const wertKennzeichen = (saetze: string[]): string[] => erbe(BEZUGSGROESSE, null, saetze);
