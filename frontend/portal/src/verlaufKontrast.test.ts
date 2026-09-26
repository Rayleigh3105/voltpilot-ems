/**
 * **Der KONTRAST-WÄCHTER des Bereichs „Verlauf"** (Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §3.1/E3.2, Paket P0).
 *
 * Er rechnet bei jedem Lauf nach, was `index.css` in seinen Kommentaren
 * behauptet: die Text-Paare der Variante C halten AA (4,5:1), und jede
 * Reihen-Farbe der Verlauf-Charts steht ≥ 3:1 über BEIDEN Gründen
 * (`--vp-c-card` und `--vp-c-bg`) und ist von jeder anderen Reihe um
 * mindestens ΔE 15 getrennt.
 *
 * ## Warum ΔE und nicht nur Kontrast
 *
 * Zwei Linien können jede für sich gut auf dem Grund liegen und trotzdem
 * NEBENEINANDER ununterscheidbar sein — genau das ist dem Haus schon einmal
 * passiert (Netz-Linie gegen Batterie-Laden-Grün, ΔE 9,8, dokumentiert an
 * `--vp-chart-grid-line` in `index.css`). Der Kontrast beantwortet „sehe ich
 * die Linie?", ΔE beantwortet „sehe ich, WELCHE Linie das ist".
 *
 * Gerechnet wird CIE76 auf D65 — dieselbe einfache Formel, mit der der Ton
 * `#036672` damals ausgewählt wurde; sie ist streng genug, um die Fälle zu
 * finden, um die es hier geht, und braucht keine Bibliothek.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const colors = readFileSync(join(root, 'designsystem', 'tokens', 'colors.css'), 'utf8');
const index = readFileSync(join(root, 'src', 'index.css'), 'utf8');

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

/** CIE76 · Lab über D65. */
function lab(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE(a: RGB, b: RGB): number {
  const [A, B] = [lab(a), lab(b)];
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/**
 * Ein Token AUS der Token-Datei bzw. `index.css` — nie hier festgeschrieben.
 * ⚠ Folgt einem Alias (`--vp-c-fs-…: var(--vp-…)`), sonst prüfte der Test
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

const AA = 4.5;
/** dataviz `contrast-data`: „Data lines/bars vs background ≥ 3:1". */
const DATEN = 3;
/** Die Grenze, unter der zwei Reihen nebeneinander verschwimmen (E3.2). */
const DE_MIN = 15;

describe('Verlauf P0 · die Text-Paare der Variante C halten AA', () => {
  const paare: Array<[string, string, string]> = [
    ['Aktion/Link auf der Karte', 'c-primary', 'c-card'],
    ['Sekundärzeile auf dem Chip', 'c-muted-fg', 'c-muted'],
    ['Sekundärzeile auf der Karte', 'c-muted-fg', 'c-card'],
    ['Minus-Betrag auf der Summenzeile', 'c-destructive', 'c-muted'],
    ['Warn-Wort auf dem Warn-Grund', 'c-warn-fg', 'c-warn-bg'],
    // Die zwei Gründe des Verlaufs — der Fliesstext steht auf beiden.
    ['Fliesstext auf der Karte', 'c-fg', 'c-card'],
    ['Fliesstext auf dem Seitengrund', 'c-fg', 'c-bg'],
  ];
  for (const [was, vorne, hinten] of paare) {
    it(`${was} (${vorne} auf ${hinten})`, () => {
      expect(contrast(token(vorne), token(hinten))).toBeGreaterThanOrEqual(AA);
    });
  }
});

/** Die Reihen der Zuordnungstabelle — Namen AUS `index.css`, nicht von Hand. */
const REIHEN = [...index.matchAll(/--vp-c-chart-([a-z0-9-]+):\s*#[0-9a-fA-F]{6}/g)].map(
  (m) => `c-chart-${m[1]}`,
);

describe('Verlauf P0 · E3.2: die Zuordnungstabelle ist vollständig', () => {
  it('acht Reihen, jede mit ihrem eigenen Namen', () => {
    expect(REIHEN.sort()).toEqual([
      'c-chart-batt',
      'c-chart-grid',
      'c-chart-kosten',
      'c-chart-load',
      'c-chart-price',
      'c-chart-price-2',
      'c-chart-pv',
      'c-chart-soc',
    ]);
  });

  it('jede Reihe ist ein Ton, den das Portal schon führt — keine neue Farbe', () => {
    /* Die Zuordnung darf umbenennen, nicht erfinden: jeder Wert muss als
       Hex irgendwo in `colors.css` oder `index.css` AUSSERHALB des eigenen
       `--vp-c-chart-*`-Blocks schon stehen. Sonst hat der Verlauf eine
       Farbe, die im Flussbild und in der Anlagen-Fläche fehlt. */
    for (const name of REIHEN) {
      const wert = new RegExp(`--vp-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(index)![1].toLowerCase();
      const andere = (colors + index)
        .replace(new RegExp(`--vp-c-chart-[a-z0-9-]+:\\s*${wert}`, 'gi'), '')
        .toLowerCase();
      expect(andere.includes(wert), `--vp-${name} (${wert}) ist eine NEUE Farbe`).toBe(true);
    }
  });
});

describe('Verlauf P0 · jede Reihe ist über beiden Gründen sichtbar (≥ 3:1)', () => {
  for (const name of REIHEN) {
    for (const grund of ['c-card', 'c-bg'] as const) {
      it(`${name} auf ${grund}`, () => {
        expect(contrast(token(name), token(grund))).toBeGreaterThanOrEqual(DATEN);
      });
    }
  }
});

describe('Verlauf P0 · zwei Reihen sind nie zu verwechseln (ΔE ≥ 15)', () => {
  /**
   * ⚠ `-batt` und `-soc` sind EINE Rolle in zwei Stufen (Fläche/Balken satt,
   *   Linie tief) — die K-Regel „eine Speicher-Farbe". Sie stehen trotzdem
   *   MIT in der Prüfung: sie liegen im selben Chart nebeneinander (Balken +
   *   Ladestandslinie), und wenn sie sich dort nicht unterscheiden lassen,
   *   hilft es niemandem, dass sie „dieselbe Rolle" sind. Gemessen trennen
   *   sie über die Helligkeit deutlich — die Regel kostet hier also nichts.
   */
  for (let i = 0; i < REIHEN.length; i++) {
    for (let j = i + 1; j < REIHEN.length; j++) {
      const [a, b] = [REIHEN[i], REIHEN[j]];
      it(`${a} × ${b}`, () => {
        const d = deltaE(token(a), token(b));
        expect(d, `${a} × ${b}: ΔE ${d.toFixed(1)} — zu nah`).toBeGreaterThanOrEqual(DE_MIN);
      });
    }
  }
});

describe('Verlauf P0 · der Scrim ist gegen die KOMPONIERTE Fläche gemessen', () => {
  /**
   * pro-rules „Scrim and modal legibility: **Measure the composed result**".
   *
   * ⚠ Der Scrim ist KEIN Text-Kontrast-Fall, und ein 4,5:1 oder 3:1 gegen die
   *   Sheet-Karte wäre die falsche Frage: das Sheet ist deckend, sein Inhalt
   *   hält seinen Kontrast ohnehin. Was der Scrim leisten MUSS, ist zweierlei
   *   — die Seite dahinter zurücktreten lassen, und eine sichtbare Stufe zum
   *   Sheet davor bilden. Beides wird hier an der komponierten Farbe
   *   nachgerechnet, nicht am Prozentwert geglaubt.
   *
   * Gemessen bei den 40 % der Variante C: die Seite verliert von 13,98:1 auf
   * 6,00:1, ihre Sekundärzeilen fallen von 7,24:1 auf 4,08:1 (also unter AA —
   * sie sind nicht mehr zum Lesen da), und das Sheet steht mit 2,44:1 über
   * dem abgedunkelten Grund.
   */
  const anteil = () => {
    const m = /--vp-c-scrim:\s*color-mix\(in srgb,\s*var\(--vp-c-fg\)\s*(\d+)%/.exec(index);
    expect(m, '--vp-c-scrim ist keine color-mix-Regel auf --vp-c-fg mehr').not.toBeNull();
    return Number(m![1]) / 100;
  };
  const ueber = (unten: RGB): RGB => {
    const p = anteil();
    const fg = token('c-fg');
    return [0, 1, 2].map((k) => fg[k] * p + unten[k] * (1 - p)) as RGB;
  };

  it('er dunkelt den Seitengrund wirklich ab', () => {
    expect(contrast(ueber(token('c-bg')), token('c-bg'))).toBeGreaterThanOrEqual(2);
  });

  it('das Sheet davor bildet eine sichtbare Stufe zum abgedunkelten Grund', () => {
    expect(contrast(token('c-card'), ueber(token('c-bg')))).toBeGreaterThanOrEqual(2);
  });

  it('die Seite dahinter tritt zurück — ihr Text verliert mehr als die Hälfte', () => {
    const vorher = contrast(token('c-fg'), token('c-bg'));
    const nachher = contrast(ueber(token('c-fg')), ueber(token('c-bg')));
    expect(nachher).toBeLessThan(vorher / 2);
  });

  it('und ihre Sekundärzeilen fallen unter AA — sie sind nicht mehr zum Lesen da', () => {
    expect(contrast(ueber(token('c-muted-fg')), ueber(token('c-bg')))).toBeLessThan(AA);
  });
});
