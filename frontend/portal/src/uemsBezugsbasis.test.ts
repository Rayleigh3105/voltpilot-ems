import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import * as b from './bezugsbasis';

const v2 = resolve(process.cwd(), '../../docs/contracts/v2');
const data = JSON.parse(readFileSync(resolve(v2, 'bezugsbasis-vectors.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(v2, 'bezugsbasis.schema.json'), 'utf8'));
const referenz = JSON.parse(readFileSync(resolve(v2, 'uems-referenzunternehmen.json'), 'utf8'));
function rechnen(fall: any) {
  const e = fall.eingang;
  switch (fall.operation) {
    case 'referenzperiode': return b.referenzperiode(e.text, e.laufender_monat);
    case 'basiswert': return b.basiswert(e.grundlage);
    case 'modell': return b.modell(e.methode, e.reihe);
    case 'abhaengigkeit': return b.abhaengigkeit(e.x1, e.x2);
    case 'vergleich': return b.vergleich(e);
    case 'roh_und_bereinigt': return b.rohUndBereinigt(e);
    case 'methoden_paar': return b.methodenPaar(e);
    case 'zeitraum': return b.zeitraum(e);
    case 'roh': return b.roh(e.aktuell, e.vorher);
    case 'runden': return b.runden(e.wert, e.stellen);
    default: throw new Error(`Ungeprüfte Operation: ${fall.operation}`);
  }
}
describe('AP-17 NW-1 · Bezugsbasis: dieselben Vektoren wie Java und Python', () => {
  for (const fall of data.cases) it(fall.name, () => expect(rechnen(fall)).toEqual(fall.erwartet));
  it('geschlossenes Schema, Startwerte und Vokabular', () => {
    expect(schemaVerstoesse(data, schema)).toEqual([]);
    expect(b.STARTWERTE).toEqual(data.startwerte);
    expect({ methode: b.METHODEN, urteil: b.URTEILE, grund: b.GRUENDE, datenlage: b.DATENLAGE, richtung: b.RICHTUNGEN,
      anpassungsgrund: b.ANPASSUNGSGRUENDE, faktor_art: b.FAKTOR_ARTEN, basis_zustand: b.BASIS_ZUSTAENDE,
      freigabe_status: b.FREIGABE_STATUS }).toEqual(data.vokabulare);
    expect(new Set(data.cases.map((c: any) => c.name)).size).toBe(data.cases.length);
  });
  it.each(['zusatz', 'zaehler'])('Schema lehnt ungültiges Feld %s ab', (key) => {
    const falsch = structuredClone(data);
    falsch.cases.find((c: any) => c.operation === 'basiswert').eingang.grundlage[0][key] = 1.5;
    expect(schemaVerstoesse(falsch, schema).length).toBeGreaterThan(0);
  });
  it('rundet kaufmännisch, nicht wie Math.round', () => {
    expect(Math.round(-20.5)).toBe(-20);
    expect(b.runden('-2.05', 1)).toBe('-2.1');
    expect(b.runden('81984.5', 0)).toBe('81985');
  });
  it('Dezember 2027 ist der Vergleich des Leistungsvergleichs VB-2028-0001', () => {
    const vb = referenz.leistungsvergleiche[0].vergleich;
    const dez = data.cases.find((c: any) => c.name.startsWith('R2 Dezember 2027 bereinigt')).erwartet;
    expect([Number(dez.erwartet), Number(dez.delta_prozent), Number(dez.band_prozent), dez.urteil])
      .toEqual([vb.erwartet, vb.delta_prozent, vb.band_prozent, vb.urteil]);
  });
});
