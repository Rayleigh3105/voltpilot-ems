/**
 * Drift-Wächter: `src/kennzahlen/kennzahl-vorlagen.json` ist die SYNCED COPY der
 * kanonischen Server-Ressource `services/api/src/main/resources/kennzahlen/
 * kennzahl-vorlagen.json` (UEMS AP-11 IP-10, E9 = A). Server und Portal belegen
 * den Assistenten mit denselben Vorlagen vor — **beide Dateien zusammen ändern**
 * (das `anwendungen.sync.test.ts`-Muster). Überspringt, wenn der api-Baum nicht
 * ausgecheckt ist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_KATALOG = resolve(
  process.cwd(),
  '../../services/api/src/main/resources/kennzahlen/kennzahl-vorlagen.json',
);
const PORTAL_KATALOG = resolve(process.cwd(), 'src/kennzahlen/kennzahl-vorlagen.json');

describe('kennzahl-vorlagen catalog sync', () => {
  it.skipIf(!existsSync(API_KATALOG))('die Portal-Kopie ist BYTE-gleich', () => {
    expect(readFileSync(PORTAL_KATALOG, 'utf8')).toEqual(readFileSync(API_KATALOG, 'utf8'));
  });
});
