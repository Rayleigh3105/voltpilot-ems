import { dez, dezText, dezVergleich, type Dez } from './dez';
function plus(a: Dez, b: Dez): Dez { const e = Math.max(a.e, b.e); return { z: a.z * 10n ** BigInt(e - a.e) + b.z * 10n ** BigInt(e - b.e), e }; }
/** Vertragszwilling K7; die Portalfläche zeigt ausschließlich gespeicherte Werte. */
export function gradtage(tage: { mittel: string | null; zustand: string }[], raum: string, grenze: string) {
  const r = dez(raum), g = dez(grenze);
  if (dezVergleich(r, g) <= 0) throw new Error('Raumtemperatur muss über Heizgrenze liegen');
  let summe: Dez | null = null;
  let voll = tage.length > 0;
  for (const tag of tage) {
    voll = voll && tag.mittel !== null && tag.zustand === 'vollständig';
    if (tag.mittel !== null) {
      const m = dez(tag.mittel), wert = dezVergleich(m, g) < 0 ? plus(r, { ...m, z: -m.z }) : dez('0');
      summe = summe === null ? wert : plus(summe, wert);
    }
  }
  return { betrag: summe, zustand: summe === null ? 'keine Werte' : voll ? 'vollständig' : 'unvollständig',
    kennzeichen: [`Gradtage G${dezText(r)}/${dezText(g)}`, ...(voll ? [] : ['Tagesmittel fehlen oder sind unvollständig'])] };
}
