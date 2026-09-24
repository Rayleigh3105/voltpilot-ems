import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import * as v from './verbesserung';

const v2 = resolve(process.cwd(), '../../docs/contracts/v2');
const data = JSON.parse(readFileSync(resolve(v2, 'verbesserung-vectors.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(v2, 'verbesserung.schema.json'), 'utf8'));
function rechnen(fall: any) {
  const e = fall.eingang;
  switch (fall.operation) {
    case 'wirkung': return v.wirkung(e);
    case 'zielstand': return v.zielstand(e);
    case 'frist': return v.frist(e);
    case 'satz': return v.satz(e.schluessel, e.werte);
    default: throw new Error(`Ungeprüfte Operation: ${fall.operation}`);
  }
}
const quelle = (pfad: string) => readFileSync(resolve(process.cwd(), pfad), 'utf8');
// Ein Mittel der Monats-Δ: durch die Zahl der Teile geteilt, oder eine Mittelwert-Funktion (WK3, Z3, U5).
const MITTEL = /\bmittel\w*\(|average|\.mean\(|statistics\.|\/\s*[\w.]*\.length\b|\/\s*len\(|\.divide\(|\/\s*\w+\.size\(\)/i;

describe('AP-18 NW-1 · Ziele, Maßnahmen, Abweichungen: dieselben Vektoren wie Java und Python', () => {
  for (const fall of data.cases) it(fall.name, () => expect(rechnen(fall)).toEqual(fall.erwartet));
  it('geschlossenes Schema, Startwerte, Vokabular und Sätze', () => {
    expect(schemaVerstoesse(data, schema)).toEqual([]);
    expect(v.STARTWERTE).toEqual(data.startwerte);
    expect(v.VOKABULARE).toEqual(data.vokabulare);
    expect(v.SAETZE).toEqual(data.saetze);
    expect(new Set(data.cases.map((c: any) => c.name)).size).toBe(data.cases.length);
  });
  it('Schema lehnt ein unbekanntes Feld ab', () => {
    const falsch = structuredClone(data);
    falsch.cases.find((c: any) => c.operation === 'wirkung').eingang.zusatz = 1.5;
    expect(schemaVerstoesse(falsch, schema).length).toBeGreaterThan(0);
  });
  it('ein Mittel der Monats-Δ wird in keinem Zwilling gebildet — die Summe kommt aus zeitraum der Bezugsbasis', () => {
    const zwillinge = {
      ts: quelle('src/verbesserung.ts'),
      java: quelle('../../services/api/src/main/java/com/voltpilot/api/uems/VerbesserungRegeln.java'),
      py: quelle('../../services/optimization/voltpilot_optimization/verbesserung.py'),
    };
    for (const [sprache, text] of Object.entries(zwillinge)) {
      expect(MITTEL.test(text), sprache).toBe(false);
      expect(/zeitraum\(/.test(text) && /vergleich\(/.test(text), sprache).toBe(true);
    }
    expect(MITTEL.test('return summe(ds) / ds.length;')).toBe(true);
  });
  it('die Pflichtfälle der §8-Zeile sind eigene Vektoren', () => {
    const namen: string[] = data.cases.map((c: any) => c.name);
    for (const p of ['R5 Februar bis Oktober 2028: 2,4 % weniger, 8 von 12, März ausgeschlossen', 'R6 Januar 2028 Umsetzungsmonat nicht gezählt',
      'R10 11 von 12 → kein Vorschlag']) expect(namen.some(n => n.startsWith(p)), p).toBe(true);
  });
});
