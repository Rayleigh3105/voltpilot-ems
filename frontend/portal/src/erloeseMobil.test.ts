import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **Der 375-px-Wächter der Ergebnis-Fläche** (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.9/§2 Prinzip 7; die Befunde des
 * P7-Browser-Beweises).
 *
 * Er prüft AM STYLESHEET, was der Browser-Beweis am gerenderten Bild misst:
 * Trefferflächen ≥ 44 px, kein horizontaler Überlauf, keine umbrechende Zahl.
 * Beides zusammen — der Beweis findet, was die Regel nicht kennt; die Regel
 * hält, was der Beweis einmal gefunden hat.
 *
 * ⚠ SEIT VARIANTE C liest er `components/erloese/ErgebnisKarte.css`: der
 *   `.vp-ez-*`-Block und `SpeicherBlock.css` sind mit der alten Anatomie
 *   entfallen (Statement auf der Fläche, drei eigene Karten). Die geprüften
 *   EIGENSCHAFTEN sind wörtlich dieselben geblieben — nur ihre Träger heissen
 *   anders.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const karte = readFileSync(
  join(root, 'src', 'components', 'erloese', 'ErgebnisKarte.css'),
  'utf8',
);

/**
 * Die Rümpfe ALLER Regeln, deren Selektor-Liste den gesuchten Selektor EXAKT
 * enthält — aneinandergehängt.
 *
 * ⚠ Der Vergleich muss exakt sein: `.vp-c-sp-sek` ist ein Präfix von
 *   `.vp-c-sp-sek a`, und eine Präfix-Suche liefert den Rumpf der falschen
 *   Regel — der Wächter prüfte dann eine Eigenschaft, die er gar nicht meint.
 *   Und die VEREINIGUNG, weil eine Eigenschaft (Farbe hier, Trefferfläche
 *   dort) legitim auf zwei Regeln verteilt sein darf.
 */
function block(css: string, regel: string): string {
  const ohneKommentar = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const treffer: string[] = [];
  for (const m of ohneKommentar.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selektoren = m[1]
      .split(',')
      .map((t) => t.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    if (selektoren.includes(regel)) treffer.push(m[2]);
  }
  expect(treffer.length, `Regel ${regel} fehlt`).toBeGreaterThan(0);
  return treffer.join('\n');
}

describe('§3.9 · Trefferflächen (Browser-Beweis bei 375 px)', () => {
  it('jeder Textlink der Fläche weitet seine Trefferfläche über ::before', () => {
    // 21 px Zeilenhöhe + 2 × 12 px = 45 px ≥ 44 px.
    expect(block(karte, '.vp-c-led-sek a')).toMatch(/position:\s*relative/);
    const vor = block(karte, '.vp-c-led-sek a::before');
    expect(vor).toMatch(/position:\s*absolute/);
    const inset = /inset:\s*-(\d+)px/.exec(vor);
    expect(inset, '`inset` der Trefferfläche fehlt').not.toBeNull();
    expect(Number(inset![1])).toBeGreaterThanOrEqual(12);
  });

  it('die Ledger-Zeile trägt ihre Mindesthöhe im Stylesheet', () => {
    // Am Telefon 48 px (drei Zeilen: Name/Betrag, Balken, Sekundärzeile),
    // ab 700 px 56 px.
    const m = /\.vp-c-led-sum\s*\{[^}]*min-height:\s*(\d+)px/.exec(
      karte.replace(/\/\*[\s\S]*?\*\//g, ''),
    );
    expect(m, 'min-height von .vp-c-led-sum fehlt').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(44);
  });

  it('die Speicher-Zeile und der Preise-Auslöser ebenso', () => {
    expect(block(karte, '.vp-c-sp-zeile')).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
    expect(block(karte, '.vp-c-preise > summary')).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
  });
});

describe('§3.9 · kein horizontaler Überlauf', () => {
  it('jedes Grid-Kind mit Text trägt min-width: 0', () => {
    for (const regel of [
      '.vp-c-led-sum',
      '.vp-c-led-name',
      '.vp-c-led-sek',
      '.vp-c-sp-zeile',
      '.vp-c-sp-label',
      '.vp-c-sp-sek',
    ]) {
      expect(block(karte, regel), `${regel} ohne min-width: 0`).toMatch(/min-width:\s*0/);
    }
  });

  it('die Beträge brechen nie um', () => {
    expect(block(karte, '.vp-c-led-val')).toMatch(/white-space:\s*nowrap/);
    expect(block(karte, '.vp-c-sp-wert')).toMatch(/white-space:\s*nowrap/);
  });

  it('die Statement-Zahl darf notfalls umbrechen statt über die Fläche zu laufen', () => {
    expect(block(karte, '.vp-c-stm-zahl')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
