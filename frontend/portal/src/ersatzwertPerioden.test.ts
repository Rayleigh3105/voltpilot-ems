import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { periodenErsatzwerte, type ErsatzwertBeitrag, type PeriodenErgebnis } from './ersatzwertPerioden';

const datei = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/verbrauch-vectors.json'), 'utf8'));
describe('E7/E9: Perioden mit Ersatzwert, dieselben Vektoren wie Java', () => {
  for (const v of datei.ersatzwert_perioden as {
    name: string; basis: PeriodenErgebnis; von: string; bis: string;
    beitraege: ErsatzwertBeitrag[]; expected: PeriodenErgebnis;
  }[]) {
    it(v.name, () => {
      const vorher = structuredClone(v.basis);
      const ist = periodenErsatzwerte(v.basis, v.von, v.bis, v.beitraege);
      expect({ ...ist, menge: null }).toEqual({ ...v.expected, menge: null });
      if (v.expected.menge == null) expect(ist.menge).toBeNull();
      else expect(ist.menge).toBeCloseTo(v.expected.menge, 10);
      expect(v.basis).toEqual(vorher);
    });
  }
});
