import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WCAG-AA-Wächter für die in Slice 1 neu eingeführten kleinen Texte.
 *
 * Lighthouse fand drei knappe 4,35–4,44:1-Verstöße. Der Test pinnt deshalb
 * sowohl die Token-Verwendung an den betroffenen Selektoren als auch den
 * tatsächlich berechneten Kontrast gegen ihre drei hellen Hintergründe.
 */
const root = join(__dirname, '..');
const colors = readFileSync(join(root, 'designsystem', 'tokens', 'colors.css'), 'utf8');
const modellCss = readFileSync(join(__dirname, 'components', 'AnlagenModell.css'), 'utf8');
const bildCss = readFileSync(join(__dirname, 'components', 'AnlagenBild.css'), 'utf8');

type Rgb = [number, number, number];

function token(name: string): Rgb {
  const match = new RegExp(`--vp-${name}:\\s*#([0-9A-Fa-f]{6})`).exec(colors);
  expect(match, `Token --vp-${name} fehlt`).not.toBeNull();
  const hex = match![1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const linear = (value: number) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hell, dunkel] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hell + 0.05) / (dunkel + 0.05);
}

function tintAufSurface(): Rgb {
  const match = /--vp-tint:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(colors);
  expect(match, 'Token --vp-tint fehlt').not.toBeNull();
  const alpha = Number(match![4]);
  const tint = [Number(match![1]), Number(match![2]), Number(match![3])] as Rgb;
  const surface = token('surface');
  return tint.map((wert, i) => wert * alpha + surface[i] * (1 - alpha)) as Rgb;
}

describe('Anlagenbild · WCAG-AA-Kontrast', () => {
  it('setzt an Tabs, Berechtigung, Datenzeit und Wertkarten das AA-feste Aktions-Token ein', () => {
    expect(modellCss).toMatch(
      /\.vp-am-ansicht \.vp-seg\.vp-seg-compact \[role='tab'\]\s*\{[^}]*color:\s*var\(--vp-action\)/s,
    );
    expect(modellCss).toMatch(/\.vp-am-authority\s*\{[^}]*color:\s*var\(--vp-action\)/s);
    expect(bildCss).toMatch(
      /\.vp-ab-service small,\s*\.vp-ab-mobile-service small\s*\{[^}]*color:\s*var\(--vp-action\)/s,
    );
    expect(bildCss).toMatch(
      /\.vp-ab-hover-value span,\s*\.vp-ab-hover-value small\s*\{[^}]*color:\s*var\(--vp-action\)/s,
    );
  });

  it('setzt Rollen-Chips und Service-Schlüssel auf AA-feste Schrift vor bg-light', () => {
    expect(bildCss).toMatch(/\.vp-ab-role\s*\{[^}]*color:\s*var\(--vp-text-dark\)/s);
    expect(bildCss).toMatch(
      /\.vp-ab-service-fact \.k\s*\{[^}]*color:\s*var\(--vp-text-dark\)/s,
    );
    expect(contrast(token('text-dark'), token('bg-light'))).toBeGreaterThanOrEqual(4.5);
  });

  it('hält die Hover-Fläche passiv und beschränkt sie auf feine Zeiger', () => {
    expect(bildCss).toMatch(/\.vp-ab-hover\s*\{[^}]*pointer-events:\s*none/s);
    expect(bildCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\)[^{]*\{[^}]*\.vp-ab-node:hover \.vp-ab-hover/s,
    );
  });

  it('hält für normalen Text 4,5:1 gegen alle verwendeten hellen Flächen', () => {
    const ink = token('action');
    for (const background of [token('surface'), token('bg-light'), tintAufSurface()]) {
      expect(contrast(ink, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
