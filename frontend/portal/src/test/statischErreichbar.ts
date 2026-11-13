import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Der statische Import-Graph des Portals für die Bündel-Wächter in Vitest (`einstiegLuft.test.ts`,
 * `seitenBuendel.test.ts`). Nur STATISCHE Wertimporte zählen: `import()` ist die Lazy-Grenze, `import type`
 * wird vom Bauen gelöscht. Die Gegenprobe am echten Artefakt ist `test/bundle-smoke.sh`.
 */

/** Das Portal-Verzeichnis (`frontend/portal`), gegen das die Wächter ihre Pfade schreiben. */
export const PORTAL_ROOT = resolve(__dirname, '../..');

function aufloesen(von: string, spez: string): string | null {
  if (!spez.startsWith('.')) return null; // Pakete verfolgen wir nicht
  const basis = resolve(dirname(von), spez);
  for (const k of ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.jsx']) {
    try {
      if (statSync(basis + k).isFile()) return basis + k;
    } catch {
      /* weiter */
    }
  }
  return null;
}

/** Alle Module, die von `start` aus über Wert-Imports statisch erreichbar sind - mit einem Import-Weg je Modul. */
export function statischErreichbar(start: string): Map<string, string> {
  const weg = new Map<string, string>();
  const offen: Array<[string, string]> = [[resolve(PORTAL_ROOT, start), '']];
  while (offen.length) {
    const [datei, von] = offen.pop()!;
    if (weg.has(datei)) continue;
    weg.set(datei, von);
    let s: string;
    try {
      s = readFileSync(datei, 'utf8');
    } catch {
      continue;
    }
    s = s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(?:^|\n)\s*(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"]\s*;?/g, '\n');
    for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
      const p = aufloesen(datei, m[1]);
      if (p) offen.push([p, datei]);
    }
    for (const m of s.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) {
      const p = aufloesen(datei, m[1]);
      if (p) offen.push([p, datei]);
    }
  }
  return weg;
}
