import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Der Kontrast-Wächter der Erlöse-Seite** (Konzept
 * `vp-erloese-seite-konzept-e2` §3.9 Farbpaare, Paket P7).
 *
 * Der Browser-Beweis von P7 hat bei 375/768/1440 vier Stellen gemessen, die
 * unter der AA-Grenze für NORMALTEXT (4,5:1) lagen — jede davon, weil ein
 * Haus-Token auf einer anderen Fläche benutzt wurde als der, für die es
 * bemessen ist:
 *
 * | Stelle | Grund | vorher | nachher |
 * |---|---|---|---|
 * | `.vp-spb-still` / `.vp-spb-satz` | `--vp-text-gray` ist für WEISS bemessen, steht aber auf dem grünen Speicher-Grund | 4,45 | 5,06 |
 * | `.vp-spb-ton-warn .vp-spb-wert` | dito für `--vp-warn-ink` | 4,49 | 5,13 |
 * | `.vp-ez-chip-warn` | der Chip mischt sich seinen Grund aus dem eigenen Textton | 4,38 | 4,69 |
 * | `.vp-ez-t-minus` | `--vp-chart-discharge` ist eine CHART-Farbe, hier 16-px-Betrag | 4,23 | 5,07 |
 *
 * ⚠ Die Werte werden hier NACHGERECHNET, nicht nachgeschlagen (das
 * `fieldBorder.test.ts`-Muster): wer eine Mischung nachjustiert oder ein
 * Haus-Token nachdunkelt, bekommt hier die Antwort statt einer Vermutung.
 *
 * ⚠ Was hier bewusst NICHT geprüft wird: die Hero-Zahl (`clamp(2rem, …)`) —
 * sie ist WCAG-„large" und braucht nur 3:1; deshalb darf sie die reine
 * Haus-Rotfarbe behalten, während der 16-px-Betrag daneben sie nicht darf.
 */
const root = join(__dirname, '..');
const colors = readFileSync(join(root, 'designsystem', 'tokens', 'colors.css'), 'utf8');
const index = readFileSync(join(root, 'src', 'index.css'), 'utf8');
const erloese = readFileSync(join(root, 'src', 'components', 'Erloese.css'), 'utf8');
const speicher = readFileSync(join(root, 'src', 'components', 'SpeicherBlock.css'), 'utf8');

type RGB = [number, number, number];

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Ein Token AUS der Token-Datei bzw. `index.css` — nie hier festgeschrieben.
 * ⚠ Folgt einem Alias (`--vp-text: var(--vp-text-dark)`), sonst prüfte der Test
 * genau die Token nicht, die das Haus als Alias führt.
 */
function token(name: string, tiefe = 0): RGB {
  expect(tiefe, `Token --vp-${name}: Alias-Schleife`).toBeLessThan(5);
  for (const quelle of [colors, index]) {
    const alias = new RegExp(`--vp-${name}:\\s*var\\(--vp-([a-z0-9-]+)\\)`).exec(quelle);
    if (alias) return token(alias[1], tiefe + 1);
    const m = new RegExp(`--vp-${name}:\\s*#([0-9A-Fa-f]{6})`).exec(quelle);
    if (m) {
      const v = m[1];
      return [
        parseInt(v.slice(0, 2), 16),
        parseInt(v.slice(2, 4), 16),
        parseInt(v.slice(4, 6), 16),
      ];
    }
  }
  throw new Error(`Token --vp-${name} steht weder in colors.css noch in index.css`);
}

/** `color-mix(in srgb, <a> p%, <b>)` — der Mix, den der Browser rechnet. */
function mix(a: RGB, b: RGB, p: number): RGB {
  return [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as RGB;
}

/**
 * Liest den Anteil einer `color-mix`-Regel AUS dem Stylesheet. Der Test hängt
 * damit an der ausgelieferten Datei, nicht an einer Zahl in seinem eigenen Kopf.
 */
function anteil(css: string, regel: string, eigenschaft: string): number {
  const block = new RegExp(`${regel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
    css,
  );
  expect(block, `Regel ${regel} fehlt`).not.toBeNull();
  const m = new RegExp(`${eigenschaft}:\\s*color-mix\\(in srgb,[^)]*\\)\\s*(\\d+)%`).exec(block![1]);
  expect(m, `${regel} { ${eigenschaft} } ist keine color-mix-Regel mehr`).not.toBeNull();
  return Number(m![1]) / 100;
}

const WEISS = token('surface');
const GRUEN = token('flow-batt-soft'); // der Grund des Speicher-Blocks
const NEUTRAL = token('neutral-soft'); // der Grund der Chips
const AA = 4.5;

describe('Erlöse-Karte · Kontrast der Ebene 0 (P7-Browser-Beweis, nachgerechnet)', () => {
  it('der Zeilen-Betrag im Minus hält AA auf Weiss', () => {
    const p = anteil(erloese, '.vp-ez-t-minus', 'color');
    const ton = mix(token('chart-discharge'), token('text'), p);
    expect(contrast(ton, WEISS)).toBeGreaterThanOrEqual(AA);
  });

  it('die reine Haus-Rotfarbe REISST diese Grenze — deshalb gibt es die Mischung', () => {
    // Nicht-vakuum: ohne diesen Fall bewiese der Test oben nichts über die
    // Notwendigkeit der Änderung.
    expect(contrast(token('chart-discharge'), WEISS)).toBeLessThan(AA);
  });

  it('bleibt trotzdem erkennbar dieselbe Kosten-Farbe (kein zweiter Farbwert)', () => {
    const p = anteil(erloese, '.vp-ez-t-minus', 'color');
    expect(p).toBeGreaterThanOrEqual(0.8);
    expect(erloese).toContain('var(--vp-chart-discharge');
  });

  it('der Warn-Chip hält AA auf seinem selbst gemischten Grund', () => {
    const p = anteil(erloese, '.vp-ez-chip-warn', 'background');
    const grund = mix(token('warn-ink'), WEISS, p);
    expect(contrast(token('warn-ink'), grund)).toBeGreaterThanOrEqual(AA);
  });
});

describe('Speicher-Block · Kontrast auf dem grünen Grund (P7)', () => {
  it('die ruhigen Zeilen halten AA auf --vp-flow-batt-soft', () => {
    const p = anteil(speicher, '.vp-spb-still', 'color');
    expect(contrast(mix(token('text-gray'), token('text-dark'), p), GRUEN)).toBeGreaterThanOrEqual(
      AA,
    );
  });

  it('das unvermischte --vp-text-gray REISST sie — es ist für Weiss bemessen', () => {
    expect(contrast(token('text-gray'), GRUEN)).toBeLessThan(AA);
    expect(contrast(token('text-gray'), WEISS)).toBeGreaterThanOrEqual(AA);
  });

  it('der Warn-Betrag hält AA auf demselben Grund', () => {
    const p = anteil(speicher, '.vp-spb-ton-warn .vp-spb-wert', 'color');
    expect(contrast(mix(token('warn-ink'), token('text-dark'), p), GRUEN)).toBeGreaterThanOrEqual(
      AA,
    );
  });

  it('Chip und Abzeichen tragen KEINEN harten Hex mehr, sondern Token-Mischungen', () => {
    for (const regel of ['.vp-spb-chip', '.vp-spb-badge']) {
      const p = anteil(speicher, regel, 'color');
      expect(contrast(mix(token('text-gray'), token('text-dark'), p), NEUTRAL)).toBeGreaterThanOrEqual(
        AA,
      );
    }
    // Ein Farbwert OHNE `var(--…)` daneben ist im Erlöse-CSS nicht erlaubt:
    // jeder Hex hier ist ein Rückfall in `var(--token, #fallback)`.
    for (const [datei, css] of [
      ['SpeicherBlock.css', speicher],
      ['Erloese.css', erloese],
    ] as const) {
      // ⚠ Kommentare zuerst RAUS — sie nennen die alten Hex-Werte absichtlich.
      const ohneKommentar = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const zeile of ohneKommentar.split('\n')) {
        if (!/#[0-9a-fA-F]{3,8}\b/.test(zeile)) continue;
        expect(zeile, `${datei}: harter Hex ohne Token — ${zeile.trim()}`).toMatch(/var\(--vp-/);
      }
    }
  });
});
