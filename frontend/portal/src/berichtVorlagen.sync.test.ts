/**
 * Drift-Wächter (UEMS AP-12 IP-5): `src/berichte/bericht-vorlagen.json` ist die BYTE-GLEICHE Kopie der
 * Server-Ressource `services/api/src/main/resources/berichte/bericht-vorlagen.json`, und beide sind der Vertrag
 * `docs/contracts/v2/bericht-vorlagen.json` — alle drei zusammen ändern (Muster `anwendungen.sync.test.ts`).
 * Überspringt, wenn der api-Baum nicht ausgecheckt ist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_VORLAGEN = resolve(process.cwd(), '../../services/api/src/main/resources/berichte/bericht-vorlagen.json');
const VERTRAG = resolve(process.cwd(), '../../docs/contracts/v2/bericht-vorlagen.json');
const PORTAL_VORLAGEN = resolve(process.cwd(), 'src/berichte/bericht-vorlagen.json');

describe('bericht-vorlagen sync', () => {
  it.skipIf(!existsSync(API_VORLAGEN))('die Portal-Kopie ist BYTE-gleich zur Server-Ressource', () => {
    expect(readFileSync(PORTAL_VORLAGEN, 'utf8')).toEqual(readFileSync(API_VORLAGEN, 'utf8'));
  });

  it.skipIf(!existsSync(VERTRAG))('die Portal-Kopie ist BYTE-gleich zum Vertrag', () => {
    expect(readFileSync(PORTAL_VORLAGEN, 'utf8')).toEqual(readFileSync(VERTRAG, 'utf8'));
  });
});
