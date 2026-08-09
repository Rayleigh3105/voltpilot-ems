import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Der Fokusring eines fokussierbaren SVG-Knotens (der aufklappbare PV-Knoten
 * des Energieflusses) darf NUR bei Tastaturfokus erscheinen.
 *
 * Der behobene Fehler war KEIN `:focus-visible`-Missgriff, sondern der
 * UA-Fokusring: Chrome hängt ihn bei HTML an `:focus-visible`, bei einem
 * SVG-Element aber am nackten `:focus` (Chrome 151 gemessen: nach einem echten
 * Mausklick auf ein `<g tabindex role="button">` ist `:focus-visible` FALSE und
 * die berechnete Kontur trotzdem `rgb(0,95,204) auto 5px`; derselbe Klick auf
 * ein `div[tabindex]` zeichnet nichts). Der blaue Rahmen blieb deshalb nach
 * jedem Klick/Tipp stehen.
 *
 * jsdom kennt weder `:focus-visible` noch einen UA-Ring, also ist dies - wie
 * `healthGreen.test.ts` - ein quellenlesender Wächter über die zwei Regeln, an
 * denen das Verhalten wirklich hängt.
 */
const root = join(__dirname, '..');
const src = join(root, 'src');
const indexCss = readFileSync(join(src, 'index.css'), 'utf8');

/** Alle CSS-Dateien unter `src/` (die komponenten-lokalen Blätter). */
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return name.endsWith('.css') ? [p] : [];
  });
}

describe('Fokusring auf fokussierbaren SVG-Knoten', () => {
  it('schaltet den UA-Ring am nackten :focus ab - sonst bleibt er nach dem Klick stehen', () => {
    expect(indexCss).toMatch(/svg\[tabindex\]:focus,\s*\n\s*svg \[tabindex\]:focus \{\s*\n\s*outline: none;/);
  });

  it('zeichnet den Haus-Ring bei Tastaturfokus - die Bedienung per Tab bleibt sichtbar', () => {
    const at = indexCss.indexOf('svg [tabindex]:focus-visible');
    expect(at, 'die :focus-visible-Regel fehlt').toBeGreaterThan(-1);
    const body = indexCss.slice(indexCss.indexOf('{', at), indexCss.indexOf('}', at));
    expect(body).toContain('var(--vp-focus-ring-color)');
    expect(body).toContain('outline-offset');
  });

  it('notiert die Wiederherstellung NACH der Abschaltung - gleiche Spezifität, die letzte gewinnt', () => {
    expect(indexCss.indexOf('svg [tabindex]:focus-visible')).toBeGreaterThan(
      indexCss.indexOf('svg [tabindex]:focus {'),
    );
  });

  it('wiederholt den Ring nirgends je SVG-Stelle - eine Klassenregel verlöre gegen svg [tabindex]:focus', () => {
    for (const file of cssFiles(src)) {
      const css = readFileSync(file, 'utf8');
      expect(css, `${file} zeichnet einen eigenen Ring auf .vp-flow-node-btn`).not.toMatch(
        /\.vp-flow-node-btn:focus(-visible)?\s*[,{]/,
      );
    }
  });
});
