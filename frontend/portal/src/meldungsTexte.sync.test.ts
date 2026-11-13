/**
 * Drift-Wächter (Kunden-Alarmierung P1): `meldungsTexte.ts` spiegelt `meldung_allgemein` und je Eintrag
 * `meldung`/`zustandsworte` aus `services/api/src/main/resources/wertekatalog/katalog.json` inhaltlich.
 * Überspringt, wenn der api-Baum nicht ausgecheckt ist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MELDUNG_ALLGEMEIN, WERTART_TEXTE } from './meldungsTexte';

const API_KATALOG = resolve(process.cwd(), '../../services/api/src/main/resources/wertekatalog/katalog.json');

describe('meldungs-texte sync', () => {
  it.skipIf(!existsSync(API_KATALOG))('meldung_allgemein ist gleich', () => {
    const roh = JSON.parse(readFileSync(API_KATALOG, 'utf8'));
    expect(MELDUNG_ALLGEMEIN).toEqual(roh.meldung_allgemein);
  });

  it.skipIf(!existsSync(API_KATALOG))('je Wertart meldung und zustandsworte gleich', () => {
    const roh: { eintraege: { wertart: string; meldung?: unknown; zustandsworte?: unknown }[] } = JSON.parse(
      readFileSync(API_KATALOG, 'utf8'),
    );
    const server = Object.fromEntries(
      roh.eintraege
        .filter((e) => e.meldung !== undefined || e.zustandsworte !== undefined)
        .map((e) => [
          e.wertart,
          {
            ...(e.zustandsworte !== undefined ? { zustandsworte: e.zustandsworte } : {}),
            ...(e.meldung !== undefined ? { meldung: e.meldung } : {}),
          },
        ]),
    );
    expect(WERTART_TEXTE).toEqual(server);
  });
});
