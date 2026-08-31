import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wächter für `--vp-field-border`.
 *
 * Das Token existiert aus EINEM Grund: der Rand eines Eingabefeldes ist die
 * einzige Angabe, wo das Feld anfängt und aufhört, und muss deshalb die
 * 3:1-Grenze für Nicht-Text-Kontrast halten (WCAG 1.4.11). `--vp-border`
 * (1,19:1) und `--vp-gray` (1,49:1) reissen sie deutlich.
 *
 * ⚠ Der Wert wird hier NACHGERECHNET, nicht nachgeschlagen: der im
 * Login-Konzept empfohlene 75-%-Mix landet bei 2,94:1 und hätte das
 * Versprechen des Tokens still gebrochen. Wer die Mischung nachjustiert,
 * bekommt hier die Antwort statt einer Vermutung.
 */
const root = join(__dirname, '..');
const colors = readFileSync(join(root, 'designsystem', 'tokens', 'colors.css'), 'utf8');
const input = readFileSync(join(root, 'designsystem', 'components', 'forms', 'Input.jsx'), 'utf8');
const picker = readFileSync(join(root, 'src', 'components', 'VpPicker.css'), 'utf8');

/** WCAG 2.x relative Luminanz (sRGB). */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hex(name: string): [number, number, number] {
  const m = new RegExp(`--vp-${name}:\\s*#([0-9A-Fa-f]{6})`).exec(colors);
  expect(m, `Token --vp-${name} fehlt in colors.css`).not.toBeNull();
  const v = m![1];
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** `color-mix(in srgb, <fg> <p>%, <bg>)` - der lineare sRGB-Mix, den CSS rechnet. */
function mix(
  fg: [number, number, number],
  bg: [number, number, number],
  p: number,
): [number, number, number] {
  return [0, 1, 2].map((i) => fg[i] * p + bg[i] * (1 - p)) as [number, number, number];
}

/** Das Fokus-Rand-Token, wie `Input` es wirklich setzt - nie hier geraten. */
function fokusToken(): string {
  const m = /focused \? 'var\(--vp-([a-z-]+)\)' : 'var\(--vp-field-border\)'/.exec(input);
  expect(m, 'Fokus-Rand von Input nicht gefunden').not.toBeNull();
  return m![1];
}

describe('--vp-field-border', () => {
  it('ist als color-mix aus --vp-text-gray und --vp-surface definiert (kein neuer Farbwert)', () => {
    expect(colors).toMatch(
      /--vp-field-border:\s*color-mix\(in srgb, var\(--vp-text-gray\) \d+%, var\(--vp-surface\)\)/,
    );
  });

  it('hält die 3:1-Grenze gegen Weiss (WCAG 1.4.11)', () => {
    const m = /--vp-field-border:\s*color-mix\(in srgb, var\(--vp-text-gray\) (\d+)%/.exec(colors);
    expect(m).not.toBeNull();
    const anteil = Number(m![1]) / 100;
    const wert = mix(hex('text-gray'), hex('surface'), anteil);
    expect(contrast(wert, hex('surface'))).toBeGreaterThanOrEqual(3);
  });

  it('ist stärker als die zwei Ränder, die die Grenze reissen', () => {
    const weiss = hex('surface');
    // Der dokumentierte Ausgangspunkt: beide Bestands-Ränder liegen unter 3:1.
    expect(contrast(hex('border'), weiss)).toBeLessThan(3);
    expect(contrast(hex('gray'), weiss)).toBeLessThan(3);
  });

  it('lässt den Fokus-Rand nicht schwächer werden als den Ruhe-Rand', () => {
    // `Input`/`VpPicker` färben den Rand beim Fokussieren um. Wäre der
    // Fokus-Ton blasser als der Ruhe-Ton, läse sich Fokussieren als Rücknahme.
    //
    // ⚠ Das Fokus-Token wird aus der KOMPONENTE gelesen, nicht hier
    // festgeschrieben: bis 08/2026 stand hier --vp-primary-deep (3,28:1) und
    // lag nur 0,07 über dem Ruhe-Rand - als --vp-text-gray für AA nachgedunkelt
    // wurde, wanderte der Ruhe-Rand auf 3,35:1 und überholte ihn.
    const m = /--vp-field-border:\s*color-mix\(in srgb, var\(--vp-text-gray\) (\d+)%/.exec(colors);
    const ruhe = mix(hex('text-gray'), hex('surface'), Number(m![1]) / 100);
    expect(contrast(hex(fokusToken()), hex('surface'))).toBeGreaterThanOrEqual(
      contrast(ruhe, hex('surface')),
    );
  });

  it('trägt in Input und VpPicker DASSELBE Fokus-Token', () => {
    // Der Picker-Auslöser sitzt neben echten Feldern; laufen die zwei Token
    // auseinander, fällt er auf. Genau das war bis 08/2026 der Fall.
    const ausPicker =
      /\.vp-picker-ausloeser:focus-visible\s*\{[^}]*?border-color:\s*var\(--vp-([a-z-]+)\)/.exec(
        picker,
      );
    expect(ausPicker, 'Fokus-Rand des Picker-Auslösers nicht gefunden').not.toBeNull();
    expect(ausPicker![1]).toBe(fokusToken());
  });
});
