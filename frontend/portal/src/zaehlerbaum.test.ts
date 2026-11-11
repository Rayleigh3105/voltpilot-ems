import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effektiveEltern, haengtAnPruefen, type ElternKandidat, type Zuordnung } from './zaehlerbaum';

/**
 * Die Regeln des Zählerbaums gegen die EINE geteilte Vektor-Datei - dieselbe,
 * die der Java-Zwilling
 * `services/api/.../components/ZaehlerbaumRegelnVectorsTest` fährt.
 *
 * Wer eine Regel ändert, ändert beide Seiten UND die Vektor-Datei. vitest
 * läuft mit cwd = frontend/portal, das Repo-Wurzelverzeichnis liegt zwei
 * Ebenen darüber.
 */
const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

type Json = any;

const lies = (pfad: string): Json => JSON.parse(readFileSync(pfad, 'utf8'));
const vectors: Json = lies(resolve(V2, 'zaehlerbaum-vectors.json'));
const faelle: Json[] = vectors.cases;

const zuordnung = (z: Json): Zuordnung => ({ komponenteId: z.komponenteId, haengtAn: z.haengtAn ?? null });

const eltern = (e: Json): ElternKandidat | null =>
  e === null
    ? null
    : { id: e.id, anlage: e.anlage, rolle: e.rolle ?? null, entityType: e.entityType ?? null };

describe('zaehlerbaum-vectors.json', () => {
  it('hat mindestens zehn Fälle mit eindeutigen Namen', () => {
    const namen = faelle.map((f) => f.name as string);
    expect(namen.length).toBeGreaterThanOrEqual(10);
    expect(new Set(namen).size).toBe(namen.length);
  });

  for (const f of faelle) {
    it(`${f.name}: ${f.note}`, () => {
      const input = f.input;
      const urteil = haengtAnPruefen(
        input.komponenteId,
        input.eigeneAnlage,
        input.eigeneRolle ?? null,
        eltern(input.eltern),
        (input.baum as Json[]).map(zuordnung),
      );
      expect(urteil.gueltig).toBe(f.expected.gueltig);
      expect(urteil.grund).toBe(f.expected.grund ?? null);
      expect(urteil.kette).toEqual(f.expected.kette ?? []);
    });
  }
});

describe('zaehlerbaum-vectors.json · effektiveEltern', () => {
  const faelleEE: Json[] = vectors.cases_effektive_eltern;

  it('hat mindestens sechs Fälle mit eindeutigen Namen', () => {
    const namen = faelleEE.map((f) => f.name as string);
    expect(namen.length).toBeGreaterThanOrEqual(6);
    expect(new Set(namen).size).toBe(namen.length);
  });

  for (const f of faelleEE) {
    it(`${f.name}: ${f.note}`, () => {
      const { komponente, netzanschlussId } = f.input;
      expect(effektiveEltern(komponente, netzanschlussId ?? null)).toBe(f.expected ?? null);
    });
  }
});

describe('haengtAnPruefen · Zyklus-Schutz', () => {
  it('terminiert auch bei einer tiefen, kreisfreien Kette', () => {
    const baum: Zuordnung[] = [];
    let vorher = 'netz-1';
    for (let i = 0; i < 50; i++) {
      baum.push({ komponenteId: `uv-${i}`, haengtAn: vorher });
      vorher = `uv-${i}`;
    }
    const kandidat: ElternKandidat = { id: vorher, anlage: 'anlage-a', rolle: 'consumer', entityType: 'sub-meter' };
    const urteil = haengtAnPruefen('maschine-neu', 'anlage-a', 'consumer', kandidat, baum);
    expect(urteil.gueltig).toBe(true);
  });
});
