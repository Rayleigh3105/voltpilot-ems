import type { SiteAsset } from './api';

/**
 * Die Leistung der Solarmodule, wie sie die Anlagen-Daten kennen (Anlage-Flow a1, F17) - eigenes kleines
 * Modul: die Einrichtungs-Karte im Cockpit (`AnlageSetup.tsx`, Einstiegs-Bündel) braucht nur diese Regel,
 * nicht den ganzen Schritt 3 (`anlageBestaetigen.ts` reicht sie weiter).
 */

/**
 * Was der Schritt über die Leistung der Solarmodule weiß - und wohin eine getippte Zahl geht.
 *
 * Die Anlage trägt EINE PV-Summe (`asset.pv_capacity_kwp`): die Hauptanlage plus jeder übernommene Erzeuger.
 * Steht schon eine Zahl darin (Register oder eine frühere Angabe), ist sie eine Tatsache und wird nie ein
 * zweites Mal gebucht - ein gemeldeter Erzeuger wird dann ohne eigene kWp übernommen (sonst stünde dieselbe
 * Anlage doppelt in der Prognose). Sonst fragt der Schritt: mit einem gemeldeten Erzeuger bucht dessen
 * Übernahme die Zahl, ohne ihn die Anlage selbst (`PUT /pv`).
 */
export type PvLage =
  | { art: 'bekannt'; kwp: number; ausRegister: boolean; mastrNummer: string | null }
  | { art: 'frage'; ziel: 'erzeuger' | 'anlage' };

export function pvLage(assets: readonly SiteAsset[] | null, erzeuger: readonly unknown[]): PvLage {
  const pv = (assets ?? []).find((a) => a.type === 'pv');
  if (pv?.pvCapacityKwp != null && pv.pvCapacityKwp > 0) {
    return { art: 'bekannt', kwp: pv.pvCapacityKwp, ausRegister: pv.registry != null, mastrNummer: pv.registryUnitId };
  }
  return { art: 'frage', ziel: erzeuger.length > 0 ? 'erzeuger' : 'anlage' };
}

/** Die Zeile eines übernommenen Registerwerts: „9,8 kWp aus dem Register“. */
export function kwpText(kwp: number): string {
  return `${kwp.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kWp`;
}

