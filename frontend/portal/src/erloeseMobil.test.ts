import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Die Mobil-Regeln der Erlöse-Seite als Wächter** (Konzept
 * `vp-erloese-seite-konzept-e2` §3.9, Paket P7).
 *
 * §3.9 nennt drei Regeln, die im Stylesheet stehen und die ein späterer Umbau
 * still brechen kann — der Browser sieht es erst bei 375 px:
 *
 * 1. **Jede antippbare Zeile ≥ 44 px.** Der Browser-Beweis von P7 hat bei 375
 *    genau EINEN Verstoß gemessen: `.vp-spb-chip-link` („Speicher-Daten
 *    fehlen ›") war als inline-`<a>` 152 × **21** px. Behoben über das
 *    `::before`-Muster des Hauses (`.vp-am-karte-go`), das die Trefferfläche
 *    weitet, ohne die Zeile auseinanderzuziehen.
 * 2. **Kein horizontaler Überlauf:** jedes Flex-Kind mit Text `min-width: 0`.
 * 3. **Beträge brechen nie um** (`white-space: nowrap`).
 *
 * ⚠ Was hier NICHT geprüft werden kann: die tatsächliche Pixelhöhe. jsdom
 * rechnet kein Layout — die gemessenen Zahlen stehen deshalb in der PR und
 * oben im Kommentar, hier steht die REGEL, die sie trägt.
 */
const root = join(__dirname, '..');
const erloese = readFileSync(join(root, 'src', 'components', 'Erloese.css'), 'utf8');
const speicher = readFileSync(join(root, 'src', 'components', 'SpeicherBlock.css'), 'utf8');

/** Der Rumpf EINER Regel, ohne Kommentare. */
function block(css: string, regel: string): string {
  const ohneKommentar = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = new RegExp(
    `(^|\\})\\s*${regel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  ).exec(ohneKommentar);
  expect(m, `Regel ${regel} fehlt`).not.toBeNull();
  return m![2];
}

describe('§3.9 · Trefferflächen (P7-Browser-Beweis bei 375 px)', () => {
  it('der Chip-Link des Speicher-Blocks weitet seine Trefferfläche über ::before', () => {
    // 21 px Elementhöhe + 2 × 12 px = 45 px ≥ 44 px.
    expect(block(speicher, '.vp-spb-chip-link')).toMatch(/position:\s*relative/);
    const vor = block(speicher, '.vp-spb-chip-link::before');
    expect(vor).toMatch(/position:\s*absolute/);
    const inset = /inset:\s*-(\d+)px/.exec(vor);
    expect(inset, '`inset` der Trefferfläche fehlt').not.toBeNull();
    expect(Number(inset![1])).toBeGreaterThanOrEqual(12);
  });

  it('die Zeilen der Ergebnis-Karte tragen ihre Mindesthöhe im Stylesheet', () => {
    // Am Telefon 50 px (zwei Zeilen: Balken unter dem Namen), ab 700 px 44 px.
    const m = /\.vp-ez-sum\s*\{[^}]*min-height:\s*(\d+)px/.exec(
      erloese.replace(/\/\*[\s\S]*?\*\//g, ''),
    );
    expect(m, 'min-height von .vp-ez-sum fehlt').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(44);
  });
});

describe('§3.9 · kein horizontaler Überlauf', () => {
  it('die Flex-Kinder mit Text tragen min-width: 0', () => {
    for (const regel of ['.vp-spb', '.vp-spb-zeile', '.vp-spb-label', '.vp-spb-satz']) {
      expect(block(speicher, regel), `${regel} ohne min-width: 0`).toMatch(/min-width:\s*0/);
    }
    expect(block(erloese, '.vp-ez-sum')).toMatch(/min-width:\s*0/);
  });

  it('die Beträge brechen nie um', () => {
    expect(block(speicher, '.vp-spb-wert')).toMatch(/white-space:\s*nowrap/);
    expect(block(erloese, '.vp-ez-val')).toMatch(/white-space:\s*nowrap/);
  });

  it('die Hero-Zahl darf notfalls umbrechen statt über die Karte zu laufen', () => {
    expect(block(erloese, '.vp-ez-hero')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
