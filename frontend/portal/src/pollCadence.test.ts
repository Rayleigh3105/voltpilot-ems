import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { LIST_POLL_MS, LIVE_POLL_MS } from './pollCadence';

/**
 * DIE POLL-TAKTE HABEN EINEN ORT - und dieser Test hält ihn.
 *
 * Vor dem 31.08.2026 stand die 30 an rund fünfzehn Stellen als Literal; wer
 * den Takt ändern wollte, musste sie alle finden. Der Inventar-Teil unten
 * verweigert deshalb jedes NEUE Poll-Literal (das
 * `MigrationInventar`-/Vektor-Muster des Hauses).
 */

/** Der MESSTAKT der Box: schneller zu fragen bringt keinen neuen Wert. */
const BOX_MEASUREMENT_MS = 5_000;

describe('Die Takte selbst', () => {
  it('fragt nie schneller, als die Box misst', () => {
    expect(LIVE_POLL_MS).toBeGreaterThanOrEqual(BOX_MEASUREMENT_MS);
  });

  it('hält den Live-Takt kürzer als den Listen-Takt', () => {
    expect(LIVE_POLL_MS).toBeLessThan(LIST_POLL_MS);
  });

  it('bleibt beim Listen-Takt unter dem 5-Minuten-Lebendigkeits-Fenster', () => {
    // `liveness.ts` urteilt gegen 5 Minuten; ein Takt darüber könnte ein
    // verstummtes Gerät erst mit Verzögerung als solches erkennen.
    expect(LIST_POLL_MS).toBeLessThan(5 * 60_000);
  });
});

/**
 * Dateien mit einer EIGENEN, begründeten Kadenz - sie sind kein Poll-Takt der
 * Live-/Listen-Flächen und bleiben ausdrücklich bei ihrer Zahl:
 * `LadesaeuleAnbinden` wartet auf die Anmeldung EINER Säule.
 */
const AUSNAHMEN = new Set(['src/components/LadesaeuleAnbinden.tsx']);

/** Nur DIESE Zahlen sind Poll-Takte; 60_000/5_000/2000 haben eigene Gründe. */
const TAKT_LITERAL = /(?:setInterval\s*\(|useFreshnessPoll\s*\(|pollMs\s*[:=])/;
const VERBOTEN = /\b(?:30_000|30000|10_000|10000)\b/;

function quellen(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) quellen(full, out);
    else if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.includes('.test.'))
      out.push(full);
  }
  return out;
}

describe('Kein zweiter Ort für einen Poll-Takt', () => {
  it('nennt die Kadenz nirgends mehr als nackte Zahl', () => {
    const root = join(__dirname, '..');
    const treffer: string[] = [];
    for (const file of quellen(__dirname)) {
      const rel = relative(root, file).split('\\').join('/');
      if (rel === 'src/pollCadence.ts' || AUSNAHMEN.has(rel)) continue;
      const zeilen = readFileSync(file, 'utf8').split('\n');
      zeilen.forEach((zeile, i) => {
        if (TAKT_LITERAL.test(zeile) && VERBOTEN.test(zeile)) treffer.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      treffer,
      'Poll-Takte kommen aus src/pollCadence.ts, nie als Literal an der Aufrufstelle',
    ).toEqual([]);
  });
});
