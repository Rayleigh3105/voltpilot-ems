import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaVerstoesse } from './test/uemsSchemaLaeufer';
import { fehlerklasse } from './uemsDatenquelle';
const dir = resolve(process.cwd(), '../../docs/contracts/v2');
const vectors = JSON.parse(readFileSync(resolve(dir, 'data-source-status-vectors.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(dir, 'data-source-status.schema.json'), 'utf8'));
describe('shared source status wire vectors', () => {
  for (const v of vectors.cases) it(v.name, () => {
    expect(schemaVerstoesse(v.expected, schema)).toEqual([]);
    for (const row of v.expected) {
      if (row.health === 'ok') { expect(row.since).toBeUndefined(); expect(row.error_class).toBeUndefined(); }
      else expect(Number.isFinite(Date.parse(row.since))).toBe(true);
      if (row.error_class) expect(fehlerklasse(row.error_class, 'box')?.code).toBe(row.error_class);
    }
  });
});
