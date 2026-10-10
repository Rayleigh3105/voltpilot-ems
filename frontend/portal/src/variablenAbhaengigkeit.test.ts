import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERGEBNISSE,
  GRUENDE,
  MINDEST_PAARE,
  OHNE_ZAHL,
  SCHWELLE,
  abhaengigSatz,
  pruefeAbhaengigkeit,
  rText,
} from './variablenAbhaengigkeit';

/**
 * Die Abhängigkeits-Regel G4 (UEMS AP-17 IP-11a) gegen die geteilte Vektor-Datei
 * `docs/contracts/v2/variablen-vorschlag-vectors.json` — per Pfad, dieselbe Datei,
 * die der Java-Zwilling `VariablenAbhaengigkeitVectorsTest` fährt.
 */

type Json = any;

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');
const vektoren: Json = JSON.parse(readFileSync(resolve(V2, 'variablen-vorschlag-vectors.json'), 'utf8'));

describe('variablenAbhaengigkeit — Vertrag', () => {
  it('Schwelle, Vokabular und Sätze sind die der Datei', () => {
    expect(SCHWELLE).toBe(vektoren.schwelle);
    expect(MINDEST_PAARE).toBe(vektoren.mindest_paare);
    expect([...ERGEBNISSE]).toEqual(vektoren.ergebnisse);
    expect([...GRUENDE]).toEqual(vektoren.gruende);
    expect(OHNE_ZAHL).toBe(vektoren.saetze.ohne_zahl);
    expect(abhaengigSatz('{kandidat}', '{variable_1}', 0.5).replace('0,500', '{r}')).toBe(vektoren.saetze.abhaengig);
  });

  for (const f of vektoren.faelle as Json[]) {
    it(f.name, () => {
      const paare = (f.x as number[]).map((x, i) => ({ x, y: f.y[i] as number }));
      const e = pruefeAbhaengigkeit(paare);
      expect(e.ergebnis).toBe(f.ergebnis);
      expect(e.paare).toBe(f.paare);
      expect(e.grund).toBe(f.grund);
      if (f.r === null) {
        expect(e.r).toBeNull();
      } else {
        expect(e.r).toBeCloseTo(f.r, 12);
        expect(rText(e.r as number)).toBe(f.r_text);
      }
      if (f.satz) expect(abhaengigSatz(f.kandidat, f.variable_1, e.r as number)).toBe(f.satz);
    });
  }
});
