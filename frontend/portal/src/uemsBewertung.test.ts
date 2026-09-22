import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import * as b from './uemsBewertung';

const v2 = resolve(process.cwd(), '../../docs/contracts/v2');
const data = JSON.parse(readFileSync(resolve(v2, 'bewertung-vectors.json'), 'utf8'));
const messabdeckung = JSON.parse(readFileSync(resolve(v2, 'messabdeckung.json'), 'utf8'));
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
  it('rechnet die Ahrenberg-Messabdeckung aus dem übernommenen Vektor', () => {
    const messstellen = messabdeckung.je_einsatz.filter((e: any) => e.traeger === 'Strom').flatMap((e: any) => [
      ...e.gemessen.map((m: any) => ({ kennung: m.messstelle, traeger: 'Strom', art: 'gemessen', direkt: true,
        archiviert: false, wert: m.oktober_2026.replaceAll(' ', '').split(/kWh|m³/)[0], ersatz: '0' })),
      ...e.geplant.map((m: any) => ({ kennung: m.messstelle, traeger: 'Strom', art: 'gemessen', direkt: true,
        archiviert: false, wert: null, ersatz: '0' })),
    ]);
    const reste = Object.entries(messabdeckung.rest_je_anlage).map(([kennung, r]: any) => ({ kennung, wert: String(r.kwh) }));
    const aus = b.abdeckung({ messstellen, traeger: 'Strom', reste, nenner: String(messabdeckung.summe.nenner_kwh),
      offene_bedarfe: [], schwelle: b.STARTWERTE.K8 });
    expect(aus).toMatchObject({ menge: String(messabdeckung.summe.gemessen_zugeordnet_kwh), ersatz: '0',
      ungemessen: String(messabdeckung.summe.ungemessen_kwh),
      abdeckung_prozent: String(messabdeckung.summe.abdeckung_prozent), K8: messabdeckung.summe.K8 });
    expect(aus.gemessen).toHaveLength(9);
    expect(aus.geplant).toEqual(['MS-23']);
  });
});
