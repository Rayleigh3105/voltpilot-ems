/**
 * Drift-Wächter (Rollout B1): `src/rechte-matrix.json` ist die BYTE-GLEICHE Kopie des Vertrags
 * `docs/contracts/v2/rechte-matrix.json`. Das Portal-Image wird mit dem Build-Kontext
 * `frontend/portal` gebaut (`.forgejo/workflows/deploy*.yaml`), dort fehlt `docs/` — darum liest
 * der Produktionscode die Kopie. Nie von Hand ändern: `python3 docs/contracts/v2/tools/rechte_matrix.py`
 * schreibt sie aus dem Vertrag, `--check` prüft sie mit.
 *
 * Zweiter Fall: keine Produktionsquelle importiert etwas außerhalb von `frontend/portal` — sonst
 * bricht `docker build` mit TS2307, während `npm run build` im vollen Checkout grün bleibt.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PORTAL = process.cwd();
const VERTRAG = resolve(PORTAL, '../../docs/contracts/v2/rechte-matrix.json');
const KOPIE = resolve(PORTAL, 'src/rechte-matrix.json');

/** Die Dateien, die `tsc` im Image übersetzt: `tsconfig.json` nimmt `src` ohne Tests und `src/test`. */
function produktionsQuellen(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const pfad = join(dir, e.name);
    if (e.isDirectory()) return pfad === join(PORTAL, 'src/test') ? [] : produktionsQuellen(pfad);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [pfad] : [];
  });
}

describe('rechte-matrix sync', () => {
  it.skipIf(!existsSync(VERTRAG))('die Portal-Kopie ist BYTE-gleich zum Vertrag', () => {
    expect(readFileSync(KOPIE, 'utf8')).toEqual(readFileSync(VERTRAG, 'utf8'));
  });

  it('keine Produktionsquelle importiert außerhalb des Docker-Kontexts frontend/portal', () => {
    const draussen = produktionsQuellen(join(PORTAL, 'src')).flatMap((datei) =>
      [...readFileSync(datei, 'utf8').matchAll(/(?:from|import\(?)\s*['"](\.[^'"]*)['"]/g)]
        .map((m) => m[1])
        .filter((ziel) => relative(PORTAL, resolve(dirname(datei), ziel)).startsWith('..'))
        .map((ziel) => `${relative(PORTAL, datei)} → ${ziel}`),
    );
    expect(draussen).toEqual([]);
  });
});
