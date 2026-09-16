import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rechenstellen } from './test/oberflaechenArithmetik';
import ausnahmen from './test/oberflaechenArithmetik.json';

/** Q5: Flächen dürfen Quellen wählen und darstellen; Mengen bilden ausschließlich die Vertrags-Zwillinge. */
describe('AP-13 Q5 · keine Rechnung in Portal-Ableitungen', () => {
  for (const [datei, erlaubt] of Object.entries(ausnahmen.dateien)) {
    it(datei, () => {
      const gefunden = rechenstellen(readFileSync(resolve('src', datei), 'utf8'));
      expect(gefunden.importe, 'Neue Laufzeitimporte fachlich prüfen; Mengen-Arithmetik nur über Vertrags-Zwillinge.').toEqual(erlaubt.importe);
      expect(gefunden.operationen, 'Neue Rechnung: keine Summe, Mittelwerte, Anteile oder Δ in der Fläche.').toEqual(erlaubt.operationen);
    });
  }

  it.each([
    'return Number(a.menge) + Number(b.menge);',
    'return zeilen.reduce((summe, z) => summe + z.menge, 0);',
    'return (a.menge - b.menge) / b.menge * 100;',
    'a.menge += b.menge; return a.menge;',
    'return Math.max(a.menge, b.menge);',
    'return BigInt(a.menge) * 2n;',
    'return +a.menge;',
    "return import('./dez');",
  ])('Mutationsprobe erkennt %s', (rechnung) => {
    const original = readFileSync(resolve('src/uemsOberflaechen.ts'), 'utf8');
    const mutiert = rechenstellen(`${original}\nexport function verboteneMenge(a: any, b: any, zeilen: any[]) { ${rechnung} }`);
    expect(mutiert.operationen.filter((o) => !ausnahmen.dateien['uemsOberflaechen.ts'].operationen.includes(o))).not.toEqual([]);
  });

  it('erkennt einen importierten Rechenhelfer auch unter anderem Namen', () => {
    const gefunden = rechenstellen("import { add as nurAnzeige } from './dez';\nexport const menge = nurAnzeige(a, b);");
    expect(gefunden.importe).toEqual(['./dez:add as nurAnzeige']);
    expect(ausnahmen.dateien['uemsOberflaechen.ts'].importe).not.toContain(gefunden.importe[0]);
  });
});
