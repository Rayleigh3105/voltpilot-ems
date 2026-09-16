import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as R from './uemsRollen';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

const v = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/rollen-zuordnung-vectors.json'), 'utf8'));
// Dieselbe vollständige Datei liest RollenZuordnungRegelnVectorsTest; kein eigener Fixture-Abzug.
const auswerten: Record<string, (i: any) => unknown> = {
  rolle: (i) => R.rolle(i.rolle),
  wert: (i) => R.wertGueltig(i.quelle),
  frische: (i) => R.frische(i.jetzt, i.zustand),
  netz: (i) => R.netz(i.anlage, i.zuordnungen),
  zaehlung: (i) => R.zaehlung(i.anlage, i.rolle, i.jetzt, i.zuordnungen),
  aenderung: (i) => R.aenderung(i.alt, i.neu),
};

describe('Rollen-Zuordnung — gemeinsamer Vertrag', () => {
  it('alle Vektoren halten das Schema, unbekannte Felder scheitern', () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/rollen-zuordnung.schema.json'), 'utf8'));
    expect(schemaVerstoesse(v, schema)).toEqual([]);
    expect(schemaVerstoesse({ ...v, unbemerkt: true }, schema)).not.toEqual([]);
  });
  it('alle Familien und geschlossenen Vokabulare sind verdrahtet', () => {
    expect(Object.keys(auswerten).sort()).toEqual([...v.familien].sort());
    expect(Object.keys(v.cases).sort()).toEqual([...v.familien].sort());
    expect(R.ROLLEN).toEqual(v.rollen);
    expect(R.GRUENDE).toEqual(v.gruende);
    expect(R.PROTOKOLL).toEqual(v.protokoll);
    expect(R.FRISCHE_SEKUNDEN).toBe(v.frische_sekunden);
  });
  for (const familie of v.familien) {
    describe(familie, () => {
      it('enthält Fälle', () => expect(v.cases[familie].length).toBeGreaterThan(0));
      for (const c of v.cases[familie]) {
        it(c.name, () => {
          if (c.expected_error) expect(() => auswerten[familie](c.input)).toThrow(c.expected_error);
          else expect(auswerten[familie](c.input)).toEqual(c.expected);
        });
      }
    });
  }
});
