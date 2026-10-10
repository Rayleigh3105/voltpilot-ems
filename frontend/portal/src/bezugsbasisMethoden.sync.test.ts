/**
 * Drift-Wächter (UEMS AP-17 IP-5): `src/bezugsbasis/bezugsbasis-methoden.json` ist die BYTE-GLEICHE Kopie der
 * Server-Ressource `services/api/src/main/resources/bezugsbasis/bezugsbasis-methoden.json`, und beide sind der Vertrag
 * `docs/contracts/v2/bezugsbasis-methoden.json` — alle drei zusammen ändern (Muster `berichtVorlagen.sync.test.ts`).
 * Überspringt, wenn der api-Baum nicht ausgecheckt ist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_METHODEN = resolve(process.cwd(), '../../services/api/src/main/resources/bezugsbasis/bezugsbasis-methoden.json');
const VERTRAG = resolve(process.cwd(), '../../docs/contracts/v2/bezugsbasis-methoden.json');
const PORTAL_METHODEN = resolve(process.cwd(), 'src/bezugsbasis/bezugsbasis-methoden.json');

describe('bezugsbasis-methoden sync', () => {
  it.skipIf(!existsSync(API_METHODEN))('die Portal-Kopie ist BYTE-gleich zur Server-Ressource', () => {
    expect(readFileSync(PORTAL_METHODEN, 'utf8')).toEqual(readFileSync(API_METHODEN, 'utf8'));
  });

  it.skipIf(!existsSync(VERTRAG))('die Portal-Kopie ist BYTE-gleich zum Vertrag', () => {
    expect(readFileSync(PORTAL_METHODEN, 'utf8')).toEqual(readFileSync(VERTRAG, 'utf8'));
  });
});
