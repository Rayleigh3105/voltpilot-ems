import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * V10 · Die drei Zustände einer Verlauf-Karte reservieren ihren Platz
 * (Konzept `data/vp-verlauf-sprache-konzept-v5` §3.2 V10, App-Kriterium A10).
 *
 * Der Wächter prüft die HÖHEN und die Skala des Blattes — die Fläche selbst
 * prüft `components/VerlaufZustaende.test.tsx`. Beides zusammen ist die
 * Zusage: der Ladezustand ist so hoch wie der Inhalt, der danach kommt.
 */

const root = join(__dirname, '..');
const zustaende = readFileSync(join(root, 'src/components/VerlaufZustaende.css'), 'utf8');
const index = readFileSync(join(root, 'src/index.css'), 'utf8');

/** Der Rumpf EINER Regel — Kommentare vorher raus, sie nennen Selektoren. */
function regel(css: string, sel: string): string {
  const ohne = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of ohne.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      m[1]
        .split(',')
        .map((t) => t.trim())
        .includes(sel)
    ) {
      return m[2];
    }
  }
  throw new Error(`Regel ${sel} fehlt`);
}

const hoehe = (rumpf: string): string => {
  const m = /(?:^|[;{])\s*height:\s*([^;]+);/.exec(rumpf);
  if (!m) throw new Error(`keine height in »${rumpf.trim()}«`);
  return m[1].trim();
};

describe('P2b · der Ladezustand reserviert die Höhe des späteren Inhalts', () => {
  it('das Diagramm ist ein ZWILLING von `.vp-chart` — Zeichen für Zeichen', () => {
    // ⚠ Ohne diese Gleichheit springt die Karte beim Zeitraumwechsel um die
    //   Differenz. Wer die eine Formel ändert, ändert die andere mit.
    expect(hoehe(regel(zustaende, '.vp-c-zst-chart'))).toBe(hoehe(regel(index, '.vp-chart')));
  });

  it('am Telefon sind das die 260 px des Konzepts', () => {
    // `clamp(260px, 40vw, 340px)` bei 375 px Breite: 40vw = 150 → der Boden.
    const h = hoehe(regel(zustaende, '.vp-c-zst-chart'));
    const boden = /clamp\(\s*(\d+)px/.exec(h);
    expect(boden?.[1]).toBe('260');
  });

  it('Label 18, Kernsatz 24, Legende 44 — die Anatomie der Karte', () => {
    expect(hoehe(regel(zustaende, '.vp-c-zst-label'))).toBe('18px');
    expect(hoehe(regel(zustaende, '.vp-c-zst-satz'))).toBe('24px');
    expect(hoehe(regel(zustaende, '.vp-c-zst-legende'))).toBe('44px');
  });
});

describe('P2b · Leer und Fehler sprechen die Sprache des Bereichs', () => {
  it('der Leer-Satz und der Fehler-Satz stehen in Textgrösse (16)', () => {
    expect(regel(zustaende, '.vp-c-zst-text')).toMatch(/font-size:\s*var\(--vp-c-fs-16\)/);
  });

  it('das Leer-Label ist ein Label (12/700) — keine 1,25-rem-Überschrift', () => {
    const r = regel(zustaende, '.vp-c-zst-leer-label');
    expect(r).toMatch(/font-size:\s*var\(--vp-c-fs-12\)/);
    expect(r).toMatch(/font-weight:\s*var\(--vp-c-fw-700\)/);
  });

  it('der Wiederholen-Knopf ist 44 px, der Weg weitet sich über ein Overlay', () => {
    expect(regel(zustaende, '.vp-c-zst-knopf.vp-btn')).toMatch(/min-height:\s*44px/);
    const overlay = regel(zustaende, '.vp-c-zst-weg::before');
    expect(overlay).toMatch(/position:\s*absolute/);
    expect(overlay).toMatch(/inset:\s*-12px/);
  });

  it('das Blatt bringt keinen eigenen Rahmen mit — die Karte stellt der Aufrufer', () => {
    const ohneKommentar = zustaende.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(ohneKommentar).not.toMatch(/\.vp-c-zst-(leer|fehler)\s*\{[^}]*border:/);
  });
});
