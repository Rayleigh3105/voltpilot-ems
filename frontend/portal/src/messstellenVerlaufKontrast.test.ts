import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Der Kontrast-Wächter des Messstellen-Verlaufs** (UEMS AP-13 IP-4 = AP-08 IP-10, V3: Farbe UND Wort je Zustand).
 *
 * Die Farben des Bildes stehen als eigene Namen in `components/MessstellenVerlauf.css` (`--vp-mv-voll` …) und zeigen auf
 * Haus-Tokens. Hier wird NACHGERECHNET, nicht nachgeschlagen (das `erloeseKontrast.test.ts`-Muster): wer ein Token
 * nachdunkelt oder einen Namen auf ein anderes Token legt, bekommt hier die Antwort.
 *
 * | Paar | Grenze | warum |
 * |---|---|---|
 * | Balken „vollständig“ / „unvollständig“ / Ersatzwert-Strich auf der Karte | 3:1 | Grafik (WCAG 1.4.11) |
 * | Schraffur „keine Werte“: Strich auf ihrem Grund und auf der Karte | 3:1 | die Fläche muss als Fläche lesbar sein |
 * | Marke (Kreis, Spanne) auf der Karte, ihre Nummer auf dem Kreis | 4,5:1 | Text 11 px |
 * | Skala, Zeitachse, Legende auf der Karte | 4,5:1 | Text 11–12 px |
 *
 * ⚠ Blau gegen Bernstein ist zusätzlich mit dem dataviz-Prüfer gemessen (Rot-Grün-Schwäche ΔE 28); Grün gegen Bernstein
 * trennte nicht (ΔE 5,8) — deshalb ist „vollständig“ die Verbrauchs-Linie und nicht das Grün des Abzeichens.
 */
const root = join(__dirname, '..');
const quellen = [
  readFileSync(join(root, 'designsystem', 'tokens', 'colors.css'), 'utf8'),
  readFileSync(join(root, 'src', 'index.css'), 'utf8'),
].map((css) => css.replace(/\/\*[\s\S]*?\*\//g, ''));
const verlauf = readFileSync(join(root, 'src', 'components', 'MessstellenVerlauf.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type RGB = [number, number, number];

function hex(wert: string): RGB {
  const h = wert.trim().replace('#', '');
  const voll = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  expect(voll, `keine Hex-Farbe: ${wert}`).toMatch(/^[0-9a-fA-F]{6}$/);
  return [0, 2, 4].map((i) => parseInt(voll.slice(i, i + 2), 16)) as RGB;
}

/** Der Wert einer Variable — zuerst die eigenen Namen des Verlaufs, dann die Haus-Tokens; folgt `var(…)`. */
function farbe(name: string, tiefe = 0): RGB {
  expect(tiefe, `--${name}: Alias-Schleife`).toBeLessThan(6);
  for (const css of [verlauf, ...quellen]) {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
    if (!m) continue;
    const v = m[1].trim();
    const alias = /^var\(--([\w-]+)(?:,\s*([^)]+))?\)$/.exec(v);
    return alias ? farbe(alias[1], tiefe + 1) : hex(v);
  }
  throw new Error(`--${name} ist nirgends definiert`);
}

function luminanz([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function kontrast(a: RGB, b: RGB): number {
  const [hell, dunkel] = [luminanz(a), luminanz(b)].sort((x, y) => y - x);
  return (hell + 0.05) / (dunkel + 0.05);
}

describe('Messstellen-Verlauf · Kontrast der Zustände, der Schraffur und der Marken', () => {
  const karte = farbe('vp-surface');

  it('die Namen des Verlaufs zeigen auf Haus-Tokens — keine zweite Palette', () => {
    for (const name of ['voll', 'teil', 'ersatz', 'luecke-strich', 'luecke-grund', 'marke']) {
      expect(verlauf, name).toMatch(new RegExp(`--vp-mv-${name}:\\s*var\\(--vp-[\\w-]+\\);`));
    }
    expect(verlauf).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it.each([
    ['vollständig', 'vp-mv-voll'],
    ['unvollständig', 'vp-mv-teil'],
    ['mit Ersatzwert (Strich)', 'vp-mv-ersatz'],
    ['keine Werte (Strich auf der Karte)', 'vp-mv-luecke-strich'],
  ])('%s: Grafik ≥ 3:1 auf der Karte', (_wort, name) => {
    expect(kontrast(farbe(name), karte)).toBeGreaterThanOrEqual(3);
  });

  it('die Schraffur „keine Werte“ ist auf ihrem eigenen Grund lesbar (≥ 3:1)', () => {
    expect(kontrast(farbe('vp-mv-luecke-strich'), farbe('vp-mv-luecke-grund'))).toBeGreaterThanOrEqual(3);
  });

  it('vollständig und unvollständig sind nicht dieselbe Helligkeit allein — sie trennen sich im Farbton (dataviz-Prüfer), und beide tragen ihr Wort', () => {
    expect(farbe('vp-mv-voll')).not.toEqual(farbe('vp-mv-teil'));
  });

  it('Marke und ihre Nummer, Skala, Zeitachse und Legende: Text ≥ 4,5:1', () => {
    expect(kontrast(farbe('vp-mv-marke'), karte)).toBeGreaterThanOrEqual(4.5);
    expect(kontrast(farbe('vp-surface'), farbe('vp-mv-marke'))).toBeGreaterThanOrEqual(4.5);
    expect(kontrast(farbe('vp-c-muted-fg'), karte)).toBeGreaterThanOrEqual(4.5);
  });
});
