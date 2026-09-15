import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

/**
 * WAGO-Referenzdatensatz (UEMS AP-05 IP-1): das Schema
 * `docs/contracts/v2/wago-referenzdatensatz.schema.json` und seine Beispiele unter
 * `fixtures/wago-referenzdatensatz/`. Die gültigen halten; das ungültige bricht GENAU
 * die Regel, die sein Name nennt — mit der einen Reparatur hält es.
 *
 * Das Schema darf nur Schlüsselwörter benutzen, die der Läufer kennt: ein unbekanntes
 * (`if`, `not`, `format` …) würde er still übergehen, und dann urteilte ajv anders als
 * dieser Test.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const FIXTURES = resolve(V2, 'fixtures/wago-referenzdatensatz');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const schema: Json = lies(resolve(V2, 'wago-referenzdatensatz.schema.json'));
const beispiele = readdirSync(FIXTURES)
  .filter((n) => n.endsWith('.json'))
  .sort();

const LAEUFER_SCHLUESSEL = new Set([
  '$schema', '$id', '$comment', '$defs', '$ref', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties', 'items', 'anyOf',
  'enum', 'const', 'pattern', 'minItems', 'minLength', 'maxLength', 'minimum', 'maximum',
]);

const fremdeSchluessel = (s: Json, pfad: string): string[] => {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return [];
  return Object.entries(s).flatMap(([k, v]: [string, Json]) => {
    const hier = LAEUFER_SCHLUESSEL.has(k) ? [] : [`${pfad}.${k}`];
    if (k === 'properties' || k === '$defs') {
      return [...hier, ...Object.entries(v).flatMap(([n, t]) => fremdeSchluessel(t, `${pfad}.${k}.${n}`))];
    }
    if (k === 'items' || k === 'additionalProperties') return [...hier, ...fremdeSchluessel(v, `${pfad}.${k}`)];
    if (k === 'anyOf') return [...hier, ...(v as Json[]).flatMap((t, i) => fremdeSchluessel(t, `${pfad}.anyOf[${i}]`))];
    return hier;
  });
};

/** Die eine Reparatur je ungültigem Beispiel: danach muss es halten. */
const REPARATUR: Record<string, (d: Json) => void> = {
  'wago-referenzdatensatz.invalid.simulator-belegt.json': (d) => {
    d.faelle[0].belegt = false;
  },
};

const KEIN_KANAL = new Set(['quality', 'events', 'samples']);

describe('WAGO-Referenzdatensatz: Schema und Beispiele', () => {
  it('das Schema bleibt in der Teilmenge des Schema-Läufers', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(fremdeSchluessel(schema, '$')).toEqual([]);
  });

  it('es gibt zwei gültige und ein ungültiges Beispiel, alle im README', () => {
    expect(beispiele.filter((n) => n.includes('.valid.'))).toHaveLength(2);
    expect(beispiele.filter((n) => n.includes('.invalid.'))).toHaveLength(1);
    const readme = readFileSync(resolve(FIXTURES, 'README.md'), 'utf8');
    for (const n of beispiele) expect(readme).toContain(`\`${n}\``);
  });

  it.each(beispiele.filter((n) => n.includes('.valid.')))('%s hält das Schema', (n) => {
    expect(schemaVerstoesse(lies(resolve(FIXTURES, n)), schema)).toEqual([]);
  });

  it.each(beispiele.filter((n) => n.includes('.invalid.')))('%s fällt an genau einer Stelle und hält nach seiner Reparatur', (n) => {
    const daten = lies(resolve(FIXTURES, n));
    const verstoesse = schemaVerstoesse(daten, schema);
    expect(verstoesse).toHaveLength(1);
    expect(verstoesse[0]).toMatch(/^\$\.faelle\[0\]: .* passt zu keinem Zweig von anyOf$/);
    expect(REPARATUR[n]).toBeDefined();
    REPARATUR[n](daten);
    expect(schemaVerstoesse(daten, schema)).toEqual([]);
  });

  it.each(beispiele)('%s: jeder erwartete Kanal hat Einheit und Wertart, beide nennen dieselben Kanäle', (n) => {
    const d = lies(resolve(FIXTURES, n));
    expect(Object.keys(d.wertart).sort()).toEqual(Object.keys(d.einheiten).sort());
    for (const fall of d.faelle) {
      for (const kanal of Object.keys(fall.expected).filter((k) => !KEIN_KANAL.has(k))) {
        expect(d.einheiten, `${fall.name}: ${kanal}`).toHaveProperty(kanal);
      }
    }
  });
});
