import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { faehigkeiten } from './uemsDatenquelle';
import { BOX_FAEHIGKEITEN } from './boxUebersicht';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';

const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/edge-supports-vectors.json'), 'utf8')) as {
  capabilities: { name: string; meaning: string; advertised: boolean }[];
  cases: { name: string; supports: string[] | null; table: string[]; expected: string[] }[];
};
const schema = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/edge-supports.schema.json'), 'utf8'));
describe('edge supports contract', () => {
  it('keeps the portal table aligned with the packaged cloud table', () => {
    const table = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/edge-capabilities.json'), 'utf8'));
    expect(BOX_FAEHIGKEITEN).toEqual(table.faehigkeiten.map((c: { code: string; name: string; ab_release: string | null }) => ({
      code: c.code, name: c.name, ab_release: c.ab_release,
    })));
  });
  it.each(vectors.cases)('$name', (v) => {
    if (v.supports !== null) expect(schemaVerstoesse(v.supports, schema)).toEqual([]);
    const table = vectors.capabilities.map((c) => ({ code: c.name, name: c.meaning,
      ab_release: v.table.includes(c.name) ? 'released' : null }));
    const result = faehigkeiten({ version: 'released', release: 'released', supports: v.supports }, table, ['released']);
    expect(result.faehigkeiten.filter((c) => c.status === 'vorhanden').map((c) => c.code)).toEqual(v.expected);
  });
});
