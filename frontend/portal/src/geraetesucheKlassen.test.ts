import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Das Portal lädt alle Stylesheets in EIN Dokument; eine Klasse gehört darum genau einer Fläche.
 * Die Gerätesuche und die Gemeinsame Steuerung hießen beide `vp-gs-…`: `.vp-gs-wahl` (Flex-Zeile der Steuerung) schob
 * die drei Blöcke der Modellwahl nebeneinander - die E2E-Bühne sah das nicht, weil sie das andere Blatt nicht lud.
 * Dieser Wächter liest den Text und sperrt jede gemeinsame `.vp-gs-`-Klasse beider Familien.
 */
const ORDNER = join(process.cwd(), 'src/components');
const klassen = (datei: string) =>
  new Set(readFileSync(join(ORDNER, datei), 'utf8').match(/\.vp-gs-[a-z0-9-]+/g) ?? []);
const dateien = (anfang: string) => readdirSync(ORDNER).filter((d) => d.startsWith(anfang) && d.endsWith('.css'));

describe('Klassen der Gerätesuche und der Gemeinsamen Steuerung', () => {
  it('teilen keinen `.vp-gs-`-Namen', () => {
    const suche = new Set(dateien('Geraetesuche').flatMap((d) => [...klassen(d)]));
    const steuerung = new Set(dateien('GemeinsameSteuerung').flatMap((d) => [...klassen(d)]));
    expect(suche.size).toBeGreaterThan(10);
    expect(steuerung.size).toBeGreaterThan(5);
    expect([...suche].filter((k) => steuerung.has(k))).toEqual([]);
  });
});
