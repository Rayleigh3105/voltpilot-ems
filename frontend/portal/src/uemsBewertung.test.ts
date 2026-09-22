import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import * as b from './uemsBewertung';

const v2 = resolve(process.cwd(), '../../docs/contracts/v2');
const data = JSON.parse(readFileSync(resolve(v2, 'bewertung-vectors.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(v2, 'bewertung.schema.json'), 'utf8'));
function rechnen(fall: any) {
  const e = fall.eingang;
  switch (fall.operation) {
    case 'nenner': return b.nenner(e.anlagen);
    case 'menge': return b.menge(e.messstellen, e.traeger);
    case 'rangliste': case 'urteil': return b.urteil(e);
    case 'abdeckung': return b.abdeckung(e);
    case 'prozess_summe_passt': return b.prozessSummePasst(e.gemessen, e.summen);
    case 'toleranz': return b.toleranz(e.fuehrend, e.vergleich, e.toleranz);
    default: throw new Error(`Ungeprüfte Operation: ${fall.operation}`);
  }
}
describe('AP-16 NW-1 · Bewertung: dieselben Vektoren wie Java und Python', () => {
  for (const fall of data.cases) it(fall.name, () => expect(rechnen(fall)).toEqual(fall.erwartet));
  it('geschlossenes Schema, Startwerte und Vokabular', () => {
    expect(schemaVerstoesse(data, schema)).toEqual([]);
    expect(b.STARTWERTE).toEqual(data.startwerte);
    expect(b.TRAEGER).toEqual(data.vokabulare.traeger);
    expect(b.URTEILE).toEqual(data.vokabulare.urteil);
    expect(b.ABDECKUNG).toEqual(data.vokabulare.abdeckung);
    expect(b.EINSTUFUNGEN).toEqual(data.vokabulare.einstufung);
    expect(new Set(data.cases.map((c: any) => c.name)).size).toBe(data.cases.length);
  });
  it.each(['zusatz', 'zufluss'])('Schema lehnt ungültiges Feld %s ab', (key) => {
    const falsch = structuredClone(data);
    falsch.cases[0].eingang.anlagen[0][key] = 1.5;
    expect(schemaVerstoesse(falsch, schema).length).toBeGreaterThan(0);
  });
});
