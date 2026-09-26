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

/**
 * Die Blätter der Erlöse-Flächen.
 *
 * ⚠ `SpeicherBlock.css` ist mit P1 ENTFALLEN (die Speicher-Karte der Variante C
 *   hat keine grüne Fläche und keine Kennlinie mehr, E7 = a); an seiner Stelle
 *   steht `erloese/ErgebnisKarte.css` — das Blatt der ganzen Ergebnis-Fläche
 *   (Statement · Kontoauszug · Speicher-Karte · Preise-Zeile). Wer ein Blatt
 *   ergänzt, trägt es HIER ein, sonst prüft der Wächter es nie.
 */
const BLAETTER = [
  'Erloese.css',
  'erloese/ErgebnisKarte.css',
  'SteuerungFormel.css',
  // ⚠ SEIT P6 auch das Portfolio (Entscheid E2 = „beide", §3.10 Punkt 7:
  //   „Cockpit-Erlöskarte und Portfolio tragen dasselbe Kleid"). Es trägt die
  //   Ergebnis-Fläche selbst über `ErgebnisKarte.css`; eigen bleiben ihm nur
  //   die Anlagen-Tabelle und ihre Abdeckungs-Zeile — und die sollen die
  //   Skala nicht unterlaufen (E12 = a: der Pilot zieht jede Fläche nach).
  'PortfolioWelt.css',
  // Die Balkenliste von „Preise im Zeitraum" und „So verdient Ihre Anlage"
  // (Konzept „Erlöse · Preise und Verdienst", 25.09.2026) — und das Blatt der
  // Karte selbst, das bis dahin kein Wächter las.
  'erloese/Balkenliste.css',
  'SoVerdient.css',
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
//
// ⚠ SEIT DEM VERLAUF-PAKET P0 (Captain-Entscheid E2) heißt sie kanonisch
//   `--vp-c-fs/fw-*`; `--vp-erl-*` ist nur noch ein zweiter Name
//   (`--vp-erl-fs-12: var(--vp-c-fs-12)`). Der Wert steht also am C-Namen, und
//   ein Muster, das hinter `--vp-erl-fs-12:` eine Pixelzahl sucht, findet
//   nichts mehr. Gelesen wird deshalb der KANONISCHE Name — geprüft wird
//   unverändert der Erlöse-Name, den die Blätter schreiben. Dasselbe Vorgehen
//   wie `token()` in `erloeseKontrast.test.ts`, das einem Alias folgt.
// ⚠ **BEIDE Namen zählen** (E2, P0): `--vp-c-*` ist seit dem Entscheid der
//   KANONISCHE Name, `--vp-erl-*` nur noch sein Alias — wer neu schreibt,
//   nimmt den C-Namen (so tut es der Portfolio-Zwilling seit P8). Ein Wächter,
//   der nur den Alias annimmt, verböte genau die richtige Schreibweise.
const SKALA = new Set(
  [...index.matchAll(/--vp-c-fs-([a-z0-9-]+):\s*(\d+)px/g)].flatMap((m) => [
    `--vp-erl-fs-${m[1]}`,
    `--vp-c-fs-${m[1]}`,
  ]),
);
const SKALA_PX = new Set(
  [...index.matchAll(/--vp-c-fs-[a-z0-9-]+:\s*(\d+)px/g)].map((m) => `${m[1]}px`),
);
const GEWICHTE = new Set(
  [...index.matchAll(/--vp-c-fw-(\d+):\s*(\d+)/g)].flatMap((m) => [
    `--vp-erl-fw-${m[1]}`,
    `--vp-c-fw-${m[1]}`,
  ]),
);
const GEWICHTE_ZAHL = new Set(
  [...index.matchAll(/--vp-c-fw-\d+:\s*(\d+)/g)].map((m) => m[1]),
);

/** Jeder Erlöse-Name MUSS ein Alias auf seinen C-Namen sein — sonst zwei Werte. */
const ALIAS = new Set(
  [...index.matchAll(/--vp-erl-(fs|fw|lh)-([a-z0-9-]+):\s*var\(--vp-c-\1-\2\)/g)].map(
    (m) => `--vp-erl-${m[1]}-${m[2]}`,
  ),
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

  /* P0 des Verlaufs: der Alias darf NIE ein zweiter Wert werden. Stünde hinter
     `--vp-erl-fs-16` eines Tages wieder eine Pixelzahl, hätten die Erlöse-
     Blätter und der Rest des Verlaufs zwei Skalen, die sich lautlos trennen. */
  it('jeder Erlöse-Name ist ein reiner Alias auf seinen C-Namen', () => {
    // Seit P8 trägt `SKALA` beide Namen — geprüft wird hier nur der Alias.
    for (const name of [...SKALA].filter((n) => n.startsWith('--vp-erl-'))) {
      expect(ALIAS.has(name), `${name} ist kein Alias auf --vp-c-fs-*`).toBe(true);
    }
    for (const name of [...GEWICHTE].filter((n) => n.startsWith('--vp-erl-'))) {
      expect(ALIAS.has(name), `${name} ist kein Alias auf --vp-c-fw-*`).toBe(true);
    }
    for (const stufe of ['tight', 'title', 'text']) {
      expect(ALIAS.has(`--vp-erl-lh-${stufe}`), `--vp-erl-lh-${stufe} ist kein Alias`).toBe(true);
    }
  });
});

describe('Variante C · jede Schriftgröße der Erlöse-Blätter liegt auf der Skala', () => {
  for (const datei of BLAETTER) {
    it(datei, () => {
      const treffer = deklarationen(blatt[datei], 'font-size');
      expect(treffer.length, `${datei} setzt gar keine Schriftgröße`).toBeGreaterThan(0);
      for (const { wert, zeile } of treffer) {
        const tokenName = /var\((--vp-(?:erl|c)-fs-[a-z0-9-]+)/.exec(wert)?.[1];
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
        const tokenName = /var\((--vp-(?:erl|c)-fw-\d+)/.exec(wert)?.[1];
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
  // Blatt, das Form wieder selbst setzt, wäre die sechste. Seit P1 tragen die
  // Erlöse-Flächen nur noch `.vp-chip` selbst — die vier Alt-Klassen sind mit
  // ihrem Markup entfallen.
  const FORMEN = ['.vp-chip', '.vp-prov'];

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
