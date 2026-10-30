import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GERAETESUCHE_ABGLEICH, GERAETESUCHE_ANBINDUNGEN, GERAETESUCHE_ARTEN, GERAETESUCHE_ERKENNER,
  GERAETESUCHE_ERKENNUNGEN, GERAETESUCHE_FAEHIGKEIT, GERAETESUCHE_FEHLER_START, GERAETESUCHE_GRUENDE,
  GERAETESUCHE_GRUPPEN, GERAETESUCHE_HINDERNISSE, GERAETESUCHE_SCHRITTE, GERAETESUCHE_ZUSTAENDE,
  nochNichtAnbindbar,
} from './geraetesuche';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

type Json = Record<string, unknown>;
const vertrag = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts', name), 'utf8')) as Json;

interface Fall { name: string; payload: unknown; schema_lehnt_ab?: boolean }
type Familie = Record<'gueltig' | 'ungueltig' | 'fund_ueberlesen' | 'toleriert', Fall[] | undefined>;

const vektoren = vertrag('v2/geraetesuche-vectors.json') as Json & {
  api: { gruppen: string[]; abgleich: string[]; zustand: string[]; fehler_start: Record<string, string[]>;
    gruppe_faelle: { anbindung: string; gruppe: string }[] };
  gruende: Record<string, string[]>;
  erkenner: string[];
  auftrag: Familie; stand: Familie; ergebnis: Familie;
};
const schemas = {
  auftrag: vertrag('v2/mqtt-geraetesuche.schema.json'),
  stand: vertrag('v2/mqtt-geraetesuche-stand.schema.json'),
  ergebnis: vertrag('v2/mqtt-geraetesuche-ergebnis.schema.json'),
};
const defs = schemas.stand.$defs as Record<string, Json & { enum?: string[]; properties?: Record<string, Json> }>;

describe('Gerätesuche: Vertrag im Portal', () => {
  it('spricht die Wörter der Antwort wie die geteilten Vektoren', () => {
    expect([...GERAETESUCHE_GRUPPEN]).toEqual(vektoren.api.gruppen);
    expect([...GERAETESUCHE_ABGLEICH]).toEqual(vektoren.api.abgleich);
    expect([...GERAETESUCHE_ZUSTAENDE]).toEqual(vektoren.api.zustand);
    expect(GERAETESUCHE_FEHLER_START).toEqual(vektoren.api.fehler_start);
    expect(GERAETESUCHE_GRUENDE).toEqual(vektoren.gruende);
    expect([...GERAETESUCHE_ERKENNER]).toEqual(vektoren.erkenner);
  });

  it('spricht die Wörter des Fundes wie die Schemas', () => {
    const fund = defs.fund.properties as Record<string, { enum: string[] }>;
    expect([...GERAETESUCHE_ARTEN]).toEqual(defs.art.enum);
    expect([...GERAETESUCHE_ANBINDUNGEN]).toEqual(defs.anbindung.enum);
    expect([...GERAETESUCHE_ERKENNUNGEN]).toEqual(fund.erkennung.enum);
    expect([...GERAETESUCHE_HINDERNISSE]).toEqual(fund.hindernis.enum);
    expect([...GERAETESUCHE_SCHRITTE]).toEqual((schemas.stand.properties as Record<string, { enum: string[] }>).schritt.enum);
  });

  it('kennt das Fähigkeitswort aus dem Herzschlag, die Tabellenzeile kommt mit dem Knopf', () => {
    const supports = vertrag('v2/edge-supports-vectors.json') as { capabilities: { name: string; advertised: boolean }[] };
    const tabelle = vertrag('v2/edge-capabilities.json') as { faehigkeiten: { code: string; ab_release: string | null }[] };
    // Gemeldet von beiden Box-Arten, seit das Suchmodul der Box gebaut ist (Paket 2).
    expect(supports.capabilities.find((c) => c.name === GERAETESUCHE_FAEHIGKEIT)?.advertised).toBe(true);
    // Ohne Knopf kein „Update nötig für: Gerätesuche“ auf Box-Karte und Flotte. Das Portal-Paket trägt die Zeile
    // zusammen mit dem Knopf ein, mit `ab_release` null (edge-supports.md „Je Box-Art“).
    expect(tabelle.faehigkeiten.find((f) => f.code === GERAETESUCHE_FAEHIGKEIT)).toBeUndefined();
  });

  it('„noch nicht anbindbar“ ist genau die Gruppe nicht_anbindbar', () => {
    for (const f of vektoren.api.gruppe_faelle) {
      if (f.gruppe === 'nicht_anbindbar') expect(nochNichtAnbindbar(f.anbindung as never)).toBe(true);
      if (f.gruppe === 'bereit' || f.gruppe === 'vielleicht') expect(nochNichtAnbindbar(f.anbindung as never)).toBe(false);
    }
  });

  it.each(['auftrag', 'stand', 'ergebnis'] as const)('jeder %s-Fall hält sich an sein Schema wie angegeben', (familie) => {
    let n = 0;
    for (const klasse of ['gueltig', 'ungueltig', 'fund_ueberlesen', 'toleriert'] as const) {
      for (const c of vektoren[familie][klasse] ?? []) {
        const v = schemaVerstoesse(c.payload as never, schemas[familie] as never);
        const lehntAb = klasse !== 'gueltig' && c.schema_lehnt_ab === true;
        expect(v.length > 0, `${familie}/${c.name}: ${v.join('; ')}`).toBe(lehntAb);
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  it('OCPP „klopft an“: das Feld rejected gegen sein Schema', () => {
    const schema = vertrag('ocpp-klopft-an.schema.json');
    const faelle = vertrag('ocpp-klopft-an-vectors.json').lesen as
      { name: string; block: { rejected?: unknown }; schema_lehnt_ab?: boolean }[];
    for (const c of faelle) {
      if (c.block.rejected === undefined) continue;
      const v = schemaVerstoesse(c.block.rejected as never, schema as never);
      expect(v.length > 0, c.name).toBe(c.schema_lehnt_ab === true);
    }
  });

  it('DP-3 A: kein Feld trägt eine MAC, einen Hostnamen oder einen Namen', () => {
    const verboten = /(^|_)(mac|hostname|host_name|name)($|_)/i;
    const felder: string[] = [];
    const lauf = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(lauf);
      else if (x && typeof x === 'object') {
        const o = x as Json;
        if (o.properties && typeof o.properties === 'object') felder.push(...Object.keys(o.properties));
        Object.values(o).forEach(lauf);
      }
    };
    Object.values(schemas).forEach(lauf);
    expect(felder.length).toBeGreaterThan(40);
    expect(felder.filter((f) => verboten.test(f))).toEqual([]);
    expect(GERAETESUCHE_ARTEN.some((a) => ['telefon_tablet', 'rechner', 'unbekannt'].includes(a))).toBe(false);
  });
});
