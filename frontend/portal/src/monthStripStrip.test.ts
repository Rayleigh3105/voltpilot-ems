/**
 * B5-Wächter (Perf-Audit `vp-portal-perf-a4`): der 12-Monats-Streifen des
 * FLOTTEN-`/earnings` (`monthlyStrip`) wird serverseitig nur noch auf
 * `?strip=true` berechnet (fixe ~173 ms je Aufruf, auch im 30-s-Poll). Das ist
 * sicher, WEIL keine Kundenfläche die Streifen-WERTE der Flotten-Antwort
 * rendert: der `MonthStrip`-Baustein ist überall ein reiner Sprung-Navigator
 * (`showValues={false}`, aus `streifenSlots` datumsabgeleitet), und das
 * einzige `EarningsMonth[]`-Verbrauchermuster (`stripSlots`) ist tot.
 *
 * Dieser Test liest die QUELLEN (das `copy.test.ts`/`migration.test.ts`-Muster)
 * und nagelt die Invariante fest: taucht je wieder ein WERT-tragender
 * Monats-Streifen auf (der `monthlyStrip` bräuchte bzw. den site-scoped Zwilling
 * aus B2), schlägt genau dieser Test an und zwingt den Autor, die Daten
 * anzufordern statt einen leeren Streifen zu rendern.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src') + '/';
const API = join(SRC, 'api.ts');

/** Alle Portal-Quelldateien (ohne Tests). */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extrahiert die öffnenden `<MonthStrip …>`-Tags eines Quelltextes. Zählt
 * Klammer-Tiefe, damit ein `>` INNERHALB eines Prop-Ausdrucks (die
 * `onSelect`-Pfeilfunktion `=>`) nicht fälschlich als Tag-Ende gilt.
 */
function monthStripTags(src: string): string[] {
  const tags: string[] = [];
  const needle = '<MonthStrip';
  let i = src.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + needle.length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(src.slice(i, j + 1));
    i = src.indexOf(needle, j + 1);
  }
  return tags;
}

describe('B5 · der Flotten-Monats-Streifen ist opt-in und hat keine Wert-Fläche', () => {
  it('`monthlyStrip` bleibt im Vertrag (ein opt-in-Aufrufer kann ihn holen)', () => {
    // Rückwärtskompatibel: das Feld existiert weiter (leer ohne strip=true), ein
    // künftiger `?strip=true`-Aufrufer bekommt echte Werte.
    expect(readFileSync(API, 'utf8')).toContain('monthlyStrip');
  });

  it('KEINE Fläche liest `monthlyStrip` (kein Verbraucher der Flotten-Streifenwerte)', () => {
    const offenders = sourceFiles()
      .filter((f) => f !== API)
      .filter((f) => /\.monthlyStrip\b/.test(readFileSync(f, 'utf8')));
    expect(offenders, `\`.monthlyStrip\` wird gelesen in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('JEDER gerenderte <MonthStrip> ist ein Navigator (showValues={false})', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      for (const tag of monthStripTags(readFileSync(f, 'utf8'))) {
        if (!/showValues=\{false\}/.test(tag)) offenders.push(`${f}:\n${tag}`);
      }
    }
    expect(
      offenders,
      `Ein <MonthStrip> ohne showValues={false} bräuchte Monatswerte - dafür ` +
        `muss die Fläche sie anfordern (strip=true / site-Zwilling):\n${offenders.join('\n\n')}`,
    ).toEqual([]);
  });
});
