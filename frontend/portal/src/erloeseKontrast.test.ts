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

/** Der Rumpf einer Regel AUS dem ausgelieferten Stylesheet. */
function regel(css: string, selektor: string): string {
  // ⚠ Kommentare zuerst RAUS — sie nennen Selektoren, und der Rumpf dahinter
  // wäre dann der einer FREMDEN Regel.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // ⚠ Der Selektor braucht eine GRENZE: ohne sie trifft `.vp-chip` auch
  // `.vp-chip-static` und der Test liest den Rumpf einer fremden Regel.
  const block = new RegExp(
    `${selektor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])[^{}]*\\{([^}]*)\\}`,
  ).exec(css);
  expect(block, `Regel ${selektor} fehlt`).not.toBeNull();
  return block![1];
}

const WEISS = token('surface');
const GRUEN = token('flow-batt-soft'); // der Grund des Speicher-Blocks
const NEUTRAL = token('neutral-soft'); // der Grund der Chips
const AA = 4.5;

describe('Erlöse-Karte · Kontrast der Ebene 0 (P7-Browser-Beweis, nachgerechnet)', () => {
  it('der Zeilen-Betrag im Minus hält AA auf der Karte', () => {
    // ⚠ Seit P0 ist das EINE Minus-Farbe (`--vp-c-destructive`) statt der
    // P7-Mischung — die Rechnung hängt weiter an der ausgelieferten Datei.
    expect(regel(erloese, '.vp-ez-t-minus')).toMatch(/color:\s*var\(--vp-c-destructive/);
    expect(contrast(token('c-destructive'), token('c-card'))).toBeGreaterThanOrEqual(AA);
  });

  it('die reine Haus-Rotfarbe REISST diese Grenze — deshalb hat C ein eigenes Token', () => {
    // Nicht-vakuum: ohne diesen Fall bewiese der Test oben nichts über die
    // Notwendigkeit der Änderung.
    expect(contrast(token('chart-discharge'), WEISS)).toBeLessThan(AA);
  });

  it('die Farbe steht nie allein — das Vorzeichen wird mitgeschrieben (E8)', () => {
    expect(erloese).toMatch(/Das Vorzeichen wird immer mitgeschrieben|Vorzeichen wird immer mitgeschrieben/);
  });

  it('der Warn-Chip hält AA auf dem Warn-Grund der Variante C', () => {
    // Der Chip trägt seine Form seit P0 nicht mehr selbst: `.vp-chip--warn`
    // steht EINMAL in `index.css`.
    expect(regel(index, '.vp-chip--warn')).toMatch(/background:\s*var\(--vp-c-warn-bg/);
    expect(contrast(token('c-warn-fg'), token('c-warn-bg'))).toBeGreaterThanOrEqual(AA);
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
    // Seit P0 tragen sie ihre Form gar nicht mehr selbst — sie hängen an der
    // EINEN `.vp-chip` (`index.css`), und deren Paar wird dort nachgerechnet.
    const basis = regel(index, '.vp-chip');
    expect(basis).toMatch(/background:\s*var\(--vp-c-muted/);
    expect(basis).toMatch(/color:\s*var\(--vp-c-muted-fg/);
    for (const klasse of ['.vp-spb-chip', '.vp-spb-badge']) {
      expect(index, `${klasse} hängt nicht an .vp-chip`).toContain(`${klasse},`);
      expect(speicher, `${klasse} setzt seine Form wieder selbst`).not.toMatch(
        new RegExp(`\\${klasse}\\s*\\{[^}]*border-radius`),
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

/* ---------------------------------------------------------------------------
 * Die Paare der Variante C (Konzept `vp-erloese-lesbar-konzept-u3` §3.10).
 * Sie werden AUS `index.css` gelesen, nicht hier hineingeschrieben — der Test
 * hängt damit an den ausgelieferten Tokens.
 * ------------------------------------------------------------------------ */
describe('Variante C · jedes Paar hält AA (P0)', () => {
  const paare: Array<[string, string, string]> = [
    ['Fliesstext auf der Karte', 'c-fg', 'c-card'],
    ['Sekundärzeile auf der Karte', 'c-muted-fg', 'c-card'],
    ['Sekundärzeile auf dem Chip', 'c-muted-fg', 'c-muted'],
    ['Fliesstext auf dem Seitengrund', 'c-fg', 'c-bg'],
    ['Minus-Betrag auf der Karte', 'c-destructive', 'c-card'],
    ['Warn-Wort auf dem Warn-Grund', 'c-warn-fg', 'c-warn-bg'],
    ['Primär-Wort auf der Karte', 'c-primary', 'c-card'],
  ];

  for (const [was, vorne, hinten] of paare) {
    it(`${was} (${vorne} auf ${hinten})`, () => {
      expect(contrast(token(vorne), token(hinten))).toBeGreaterThanOrEqual(AA);
    });
  }

  it('die weisse Schrift der App-Leisten hält AA auf dem dunklen Grund', () => {
    expect(contrast([255, 255, 255], token('c-fg'))).toBeGreaterThanOrEqual(AA);
  });

  it('die 3-px-Kante des aktiven Eintrags ist auf dem Leisten-Grund erkennbar', () => {
    // Eine KANTE ist kein Text: der Maßstab ist die 3:1-Grenze für
    // Bedien-Elemente (WCAG 1.4.11), nicht AA.
    expect(contrast(token('c-secondary'), token('c-fg'))).toBeGreaterThanOrEqual(3);
  });
});
