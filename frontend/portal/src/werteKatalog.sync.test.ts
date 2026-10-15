/**
 * Drift-Wächter (Alerting Scheibe 2, Konzept §6.3): `src/werteKatalog.ts` ist der TS-Zwilling der
 * Server-Ressource `services/api/src/main/resources/wertekatalog/katalog.json` - inhaltlich, nicht
 * byte-gleich (JSON-Formatierung darf abweichen, anders als beim `rechte-matrix.json`-Muster).
 * Beide zusammen ändern; ein neuer Eintrag im Katalog ohne seinen Zwilling wird hier rot.
 * Überspringt, wenn der api-Baum nicht ausgecheckt ist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WERTE_KATALOG } from './werteKatalog';

const API_KATALOG = resolve(process.cwd(), '../../services/api/src/main/resources/wertekatalog/katalog.json');

interface RohEintrag {
  wertart: string;
  name: string;
  satzname: string;
  bezug: string;
  form: string;
  leser: { art: string; feld?: string; arten?: string[]; bezugsfeld?: string };
  recht: string;
  bedingungen: string[];
  zustaende?: string[];
  vorschlag?: { dauer_s?: number; erholen_s?: number; schwere?: string; ziel?: string[] };
}

function sortiert<T extends { wertart: string }>(eintraege: readonly T[]): T[] {
  return [...eintraege].sort((a, b) => a.wertart.localeCompare(b.wertart));
}

describe('werte-katalog sync', () => {
  it.skipIf(!existsSync(API_KATALOG))('jeder Server-Eintrag hat einen inhaltlich gleichen TS-Zwilling', () => {
    const roh: { eintraege: RohEintrag[] } = JSON.parse(readFileSync(API_KATALOG, 'utf8'));
    expect(sortiert(WERTE_KATALOG)).toEqual(sortiert(roh.eintraege));
  });

  it.skipIf(!existsSync(API_KATALOG))('kein Server-Eintrag fehlt im Zwilling und keiner ist zusätzlich erfunden', () => {
    const roh: { eintraege: RohEintrag[] } = JSON.parse(readFileSync(API_KATALOG, 'utf8'));
    const serverWertarten = roh.eintraege.map((e) => e.wertart).sort();
    const portalWertarten = WERTE_KATALOG.map((e) => e.wertart).sort();
    expect(portalWertarten).toEqual(serverWertarten);
  });
});
