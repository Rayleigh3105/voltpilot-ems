/**
 * Drift guard: src/flows/catalog.json is the SYNCED COPY of the api's
 * canonical flowcatalog/catalog.json (served at /api/v1/admin/flow-catalog and
 * consumed by the server-side FlowGraphValidator). Client and server must
 * validate against the same data - change BOTH files together (the
 * flows-sync.test.js precedent). Skips when the api tree is not checked out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_CATALOG = resolve(
  process.cwd(),
  '../../services/api/src/main/resources/flowcatalog/catalog.json',
);
const PORTAL_CATALOG = resolve(process.cwd(), 'src/flows/catalog.json');

describe('catalog sync', () => {
  it.skipIf(!existsSync(API_CATALOG))('portal catalog equals the api catalog', () => {
    const api = JSON.parse(readFileSync(API_CATALOG, 'utf8'));
    const portal = JSON.parse(readFileSync(PORTAL_CATALOG, 'utf8'));
    expect(portal).toEqual(api);
  });
});
