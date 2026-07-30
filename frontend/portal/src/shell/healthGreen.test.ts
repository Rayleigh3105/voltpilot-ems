import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Der grüne „Alles in Ordnung"-Zustand kommt aus den BESTEHENDEN Design-Tokens
 * des Portals - `--vp-flow-batt` (das satte Grün von Energiefluss,
 * Gesundheits-Checkliste und Ladezustand), seine weiche Fläche `-soft` und
 * seine lesbare Tiefe `-ink`. Dieser Wächter hält das fest, damit niemand
 * später ein zweites, leicht anderes Grün danebenstellt.
 */
const root = join(__dirname, '..', '..');
const shellCss = readFileSync(join(root, 'src', 'shell', 'Shell.css'), 'utf8');
const indexCss = readFileSync(join(root, 'src', 'index.css'), 'utf8');

/** Der Regelkörper zu einem Selektor (erste Fundstelle). */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `Regel ${selector} fehlt`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** Die Werte, die die drei Grün-Tokens selbst tragen - alles andere wäre neu. */
const ERLAUBTE_GRUENS = ['#16a34a', '#e7f6ec', '#166534'];

describe('„Alles in Ordnung" ist satt grün - aus den bestehenden Tokens', () => {
  it('das Ink-Token ist definiert und trägt genau das bereits verwendete Grün', () => {
    expect(indexCss).toMatch(/--vp-flow-batt-ink:\s*#166534;/);
    expect(indexCss).toMatch(/--vp-flow-batt:\s*#16a34a;/);
    expect(indexCss).toMatch(/--vp-flow-batt-soft:\s*#e7f6ec;/);
  });

  it('das Abzeichen der Kopfzeile färbt Fläche, Rahmen und Schrift über die Tokens', () => {
    const ok = ruleBody(shellCss, '.vp-healthbadge.state-ok {');
    expect(ok).toMatch(/border-color:\s*var\(--vp-flow-batt[,)]/);
    expect(ok).toContain('--vp-flow-batt-soft');
    expect(ok).toContain('--vp-flow-batt-ink');
  });

  it('der Status-Punkt trägt dasselbe Grün, mit weichem Ring', () => {
    const dot = ruleBody(shellCss, '.state-ok .vp-health-dot {');
    expect(dot).toContain('--vp-flow-batt');
    expect(dot).toContain('box-shadow');
  });

  it('die Anlagen-Karte der Seitenleiste zieht mit', () => {
    const line = ruleBody(shellCss, '.vp-anlagenav-health.state-ok {');
    expect(line).toContain('--vp-flow-batt-ink');
  });

  it('Warn- und Hinweis-Zustand behalten ihre eigenen Farben', () => {
    expect(ruleBody(shellCss, '.vp-healthbadge.state-warnung {')).toContain('--vp-flow-pv');
    expect(ruleBody(shellCss, '.state-warnung .vp-health-dot {')).toContain('--vp-flow-pv');
    expect(ruleBody(shellCss, '.state-hinweis .vp-health-dot {')).toContain('--vp-gray');
  });

  it('erfindet KEIN neues Grün: jeder Hex im Shell-Stylesheet ist ein Token-Wert', () => {
    // Nur Grün-/Türkistöne prüfen (G dominiert deutlich) - Graustufen und die
    // Marken-Blautöne des Shells sind hier nicht gemeint.
    const hexes = shellCss.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    const gruen = hexes.filter((h) => {
      const r = parseInt(h.slice(1, 3), 16);
      const g = parseInt(h.slice(3, 5), 16);
      const b = parseInt(h.slice(5, 7), 16);
      return g > r + 12 && g >= b;
    });
    for (const h of gruen) {
      expect(ERLAUBTE_GRUENS, `unbekanntes Grün ${h} im Shell-Stylesheet`).toContain(
        h.toLowerCase(),
      );
    }
  });
});
