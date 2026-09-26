import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Die Knoten des Energieflusses tragen ihr Symbol als VERSCHACHTELTES `<svg>`
 * (`Icon` rendert `<svg width="16" height="16">` IM Diagramm-`<svg>`). Eine
 * Regel `.vp-flow-wrap svg { width: 100%; height: 100% }` trifft deshalb auch
 * jedes Symbol - und weil Chromium/WebKit CSS über die width/height-Attribute
 * stellen, wurde jedes 16-px-Symbol auf die ganze Diagrammfläche aufgeblasen:
 * dicke grüne/orange/türkise Bänder quer über Kreise und Beschriftungen, am
 * Rechner wie am Telefon.
 *
 * Größenregeln für das Diagramm dürfen nur das DIREKTE Kind treffen
 * (`.vp-flow-wrap > svg`). Der Wächter liest alle Stylesheets roh.
 */
const SRC = join(process.cwd(), 'src');

function css(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...css(full));
    else if (name.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Selektoren wie `.vp-flow-wrap svg` / `.vp-flow-adaptive svg` (Nachfahre, nicht `>`). */
const NACHFAHRE = /\.vp-flow-(?:wrap|adaptive)\s+svg\b/;

describe('Energiefluss-Symbole', () => {
  it('keine Größenregel trifft die verschachtelten Symbol-SVGs', () => {
    const treffer: string[] = [];
    for (const file of css(SRC)) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      text.split('\n').forEach((line, i) => {
        if (NACHFAHRE.test(line)) treffer.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(treffer).toEqual([]);
  });

  it('das Diagramm selbst behält seine Größenregel als Kind-Selektor', () => {
    const index = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(index).toMatch(/\.vp-flow-wrap > svg \{[^}]*width: 100%/);
  });
});
