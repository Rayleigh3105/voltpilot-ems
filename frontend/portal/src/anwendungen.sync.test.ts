/**
 * Drift-Wächter: `src/anwendungen/catalog.json` ist die SYNCED COPY der
 * kanonischen Server-Ressource `services/api/src/main/resources/anwendungen/
 * catalog.json`. Server und Portal beschreiben dieselbe Anwendung mit denselben
 * Worten — **beide Dateien zusammen ändern** (das
 * `src/flows/catalog.sync.test.ts`-Muster). Überspringt, wenn der api-Baum
 * nicht ausgecheckt ist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_CATALOG = resolve(
  process.cwd(),
  '../../services/api/src/main/resources/anwendungen/catalog.json',
);
const PORTAL_CATALOG = resolve(process.cwd(), 'src/anwendungen/catalog.json');

describe('anwendungen catalog sync', () => {
  it.skipIf(!existsSync(API_CATALOG))('die Portal-Kopie ist BYTE-gleich', () => {
    expect(readFileSync(PORTAL_CATALOG, 'utf8')).toEqual(readFileSync(API_CATALOG, 'utf8'));
  });
});
