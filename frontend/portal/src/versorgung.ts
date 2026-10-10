import type { Versorgung, VersorgungAnlage } from './api';

export interface VersorgungZeile {
  key: string;
  text: string;
  messstellen: string;
  messbar: boolean;
}

/** Der kurze Systemname in der Sicht: „Werk Ahrenberg – Halle 1“ wird „Halle 1“. */
function systemName(a: VersorgungAnlage): string {
  const teile = a.name.split(' – ');
  const name = teile.length > 1 ? teile[teile.length - 1] : a.name;
  return `System ${name}${a.netzanschlussKennzeichen ? ` (${a.netzanschlussKennzeichen})` : ''}`;
}

/** F15 — die API liefert die Ableitung; das Portal formuliert sie, ohne Orte oder Stellungen nachzurechnen. */
export function versorgungZeilen(versorgung: Versorgung): VersorgungZeile[] {
  const zeilen: VersorgungZeile[] = [];
  for (const g of versorgung.gebaeude) {
    if (!g.messbar || g.systeme.length === 0) {
      zeilen.push({ key: g.gebaeude.id, text: `${g.gebaeude.name} · nicht messbar`, messstellen: '', messbar: false });
      continue;
    }
    zeilen.push(...g.systeme.map((s) => ({
      key: `${g.gebaeude.id}:${s.anlage.id}`,
      text: `${g.gebaeude.name} ← ${systemName(s.anlage)}`,
      messstellen: s.messstellen.map((m) => m.kennzeichen).join(', '),
      messbar: true,
    })));
  }
  return zeilen;
}

export function ausserhalbSatz(versorgung: Versorgung): string | null {
  const n = versorgung.ausserhalbGebaeude.length;
  if (n === 0) return null;
  return n === 1 ? '1 Messstelle außerhalb eines Gebäudes' : `${n} Messstellen außerhalb eines Gebäudes`;
}
