import { ersatzwert, erkenne } from './uemsErgebnis';

/** E7/E9; Zwilling von ErsatzwertPerioden.anwenden. Keine Verteilung einer gröberen Eingabe. */
export interface PeriodenErgebnis {
  menge: number | null;
  zustand: string;
  kennzeichen: string[];
  abdeckung_prozent: number | null;
}
export interface ErsatzwertBeitrag {
  von: string;
  bis: string;
  vorher: number | null;
  nachher: number | null;
  vorher_kennzeichen: string[];
  nachher_kennzeichen: string[];
  kennung: string;
  methode: string;
}

export function periodenErsatzwerte(
  basis: PeriodenErgebnis, von: string, bis: string, beitraege: ErsatzwertBeitrag[],
): PeriodenErgebnis {
  let menge = basis.menge;
  let kennzeichen = [...basis.kennzeichen];
  let wirkt = false;
  const ab = Date.parse(von), ende = Date.parse(bis);
  for (const b of beitraege) {
    const bv = Date.parse(b.von), bb = Date.parse(b.bis);
    if (bv < ab || bb > ende || b.nachher == null) continue;
    const ganz = bv === ab && bb === ende;
    menge = ganz ? b.nachher : (menge ?? 0) - (b.vorher ?? 0) + b.nachher;
    kennzeichen = ganz ? [] : kennzeichen.filter(k => !b.vorher_kennzeichen.includes(k));
    for (const k of b.nachher_kennzeichen) {
      if (erkenne(k)?.muster.schluessel !== 'korrigiert' && !kennzeichen.includes(k)) kennzeichen.push(k);
    }
    const satz = ersatzwert(b.methode, b.kennung);
    if (!kennzeichen.includes(satz)) kennzeichen.push(satz);
    wirkt = true;
  }
  return wirkt ? { ...basis, menge, zustand: 'mit Ersatzwert', kennzeichen } : basis;
}
