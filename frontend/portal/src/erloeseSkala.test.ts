/**
 * Der SKALA-WÄCHTER der Variante C (Konzept `vp-erloese-lesbar-konzept-u3`
 * §3.1/§3.10, Paket P0).
 *
 * Befund B1/B7 der Runde: die vier Erlöse-Blätter trugen 14 verschiedene
 * Schriftgrößen und Gewichte von 500 bis 800 — jede Karte für sich plausibel,
 * zusammen kein Maßstab. Seit P0 liegt jede Größe auf der Sechser-Skala und
 * jedes Gewicht in {400,600,700,800}.
 *
 * Der Test liest die AUSGELIEFERTEN Stylesheets, nicht eine Zahl in seinem
 * eigenen Kopf: eine neue Regel mit `font-size: 0.82rem` fällt hier auf,
 * bevor sie eine Fläche erreicht.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const index = readFileSync(join(root, 'src', 'index.css'), 'utf8');

/** Die vier Blätter der Erlöse-Flächen. */
const BLAETTER = [
  'Erloese.css',
  'SpeicherBlock.css',
  'SteuerungFormel.css',
  'ErloesKomposition.css',
] as const;

const blatt = Object.fromEntries(
  BLAETTER.map((f) => [f, readFileSync(join(root, 'src', 'components', f), 'utf8')]),
) as Record<(typeof BLAETTER)[number], string>;

/** ⚠ Kommentare zuerst RAUS — sie nennen die abgelösten Werte absichtlich. */
function ohneKommentar(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Jede Deklaration einer Eigenschaft, mit ihrer Zeile für die Fehlermeldung. */
function deklarationen(css: string, eigenschaft: string): Array<{ wert: string; zeile: string }> {
  const treffer: Array<{ wert: string; zeile: string }> = [];
  for (const zeile of ohneKommentar(css).split('\n')) {
    const m = new RegExp(`(?:^|[;{])\\s*${eigenschaft}:\\s*([^;}]+)`).exec(zeile);
    if (m) treffer.push({ wert: m[1].trim(), zeile: zeile.trim() });
  }
  return treffer;
}

// Die Skala steht EINMAL — in `index.css`. Der Test liest sie von dort, damit
// er nicht zu einer zweiten Wahrheit über dieselben Zahlen wird.
const SKALA = new Set(
  [...index.matchAll(/--vp-erl-fs-([a-z0-9-]+):\s*(\d+)px/g)].map((m) => `--vp-erl-fs-${m[1]}`),
);
const SKALA_PX = new Set(
  [...index.matchAll(/--vp-erl-fs-[a-z0-9-]+:\s*(\d+)px/g)].map((m) => `${m[1]}px`),
);
const GEWICHTE = new Set(
  [...index.matchAll(/--vp-erl-fw-(\d+):\s*(\d+)/g)].map((m) => `--vp-erl-fw-${m[1]}`),
);
const GEWICHTE_ZAHL = new Set(
  [...index.matchAll(/--vp-erl-fw-\d+:\s*(\d+)/g)].map((m) => m[1]),
);

describe('Variante C · die Skala steht und ist vollständig', () => {
  it('index.css trägt die sechs Stufen plus die Telefon-Stufe des Heros', () => {
    expect([...SKALA_PX].sort((a, b) => parseInt(a) - parseInt(b))).toEqual([
      '12px',
      '14px',
      '16px',
      '20px',
      '24px',
      '36px',
      '48px',
    ]);
  });

  it('und genau die vier erlaubten Gewichte', () => {
    expect([...GEWICHTE_ZAHL].sort()).toEqual(['400', '600', '700', '800']);
  });
});

describe('Variante C · jede Schriftgröße der Erlöse-Blätter liegt auf der Skala', () => {
  for (const datei of BLAETTER) {
    it(datei, () => {
      const treffer = deklarationen(blatt[datei], 'font-size');
      expect(treffer.length, `${datei} setzt gar keine Schriftgröße`).toBeGreaterThan(0);
      for (const { wert, zeile } of treffer) {
        const tokenName = /var\((--vp-erl-fs-[a-z0-9-]+)/.exec(wert)?.[1];
        expect(
          tokenName !== undefined && SKALA.has(tokenName),
          `${datei}: Schriftgröße neben der Skala — ${zeile}`,
        ).toBe(true);
        // Der Rückfall im `var(--token, …)` muss DIESELBE Stufe nennen.
        const fallback = /,\s*(\d+px)\s*\)/.exec(wert)?.[1];
        if (fallback) {
          expect(SKALA_PX.has(fallback), `${datei}: Rückfall neben der Skala — ${zeile}`).toBe(true);
        }
      }
    });
  }
});

describe('Variante C · jedes Gewicht liegt in {400,600,700,800}', () => {
  for (const datei of BLAETTER) {
    it(datei, () => {
      for (const { wert, zeile } of deklarationen(blatt[datei], 'font-weight')) {
        const tokenName = /var\((--vp-erl-fw-\d+)/.exec(wert)?.[1];
        expect(
          tokenName !== undefined && GEWICHTE.has(tokenName),
          `${datei}: Gewicht neben der Skala — ${zeile}`,
        ).toBe(true);
        const fallback = /,\s*(\d+)\s*\)/.exec(wert)?.[1];
        if (fallback) {
          expect(GEWICHTE_ZAHL.has(fallback), `${datei}: Rückfall neben der Skala — ${zeile}`).toBe(
            true,
          );
        }
      }
    });
  }
});

describe('Variante C · die zwei Anti-Muster des Skills', () => {
  it('keine Monospace-Schrift in den Rechenzeilen — Tabellenziffern statt Schreibmaschine', () => {
    for (const datei of BLAETTER) {
      expect(ohneKommentar(blatt[datei]), `${datei} trägt noch Monospace`).not.toMatch(
        /font-family:[^;}]*monospace/i,
      );
    }
  });

  it('kein Blatt setzt seine Schrift an der Variante C vorbei', () => {
    for (const datei of BLAETTER) {
      for (const { wert, zeile } of deklarationen(blatt[datei], 'font-family')) {
        expect(wert, `${datei}: fremde Schrift — ${zeile}`).toContain('var(--vp-c-font');
      }
    }
  });
});

describe('Variante C · die Chips tragen ihre Form nur noch EINMAL', () => {
  // §3.10 / Prinzip 5: fünf Chip-Formen sind auf `.vp-chip` gefallen. Ein
  // Blatt, das Form wieder selbst setzt, wäre die sechste.
  const FORMEN = ['.vp-ez-chip', '.vp-spb-chip', '.vp-spb-badge', '.vp-prov'];

  it('alle hängen an der EINEN Basis in index.css', () => {
    for (const form of FORMEN) {
      // Der letzte Selektor der Gruppe steht vor `{`, die anderen vor `,`.
      expect(index, `${form} hängt nicht an .vp-chip`).toMatch(
        new RegExp(`\\${form}(?![\\w-])\\s*[,{]`),
      );
    }
  });

  it('und keines der Blätter gibt ihnen wieder eine eigene', () => {
    for (const datei of BLAETTER) {
      const css = ohneKommentar(blatt[datei]);
      for (const form of FORMEN) {
        const eigen = new RegExp(`\\${form}(?![\\w-])[^{}]*\\{([^}]*)\\}`).exec(css);
        if (!eigen) continue;
        expect(eigen[1], `${datei}: ${form} setzt seine Form wieder selbst`).not.toMatch(
          /border-radius|font-size|font-weight/,
        );
      }
    }
  });
});
