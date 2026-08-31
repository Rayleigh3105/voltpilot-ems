import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ⚠ EIN BAUTEIL BRINGT SEIN STYLESHEET SELBST MIT (die RegelKarten-Lehre;
 * beim P7-Browser-Beweis gefunden, NICHT im Unit-Test).
 *
 * `FahrzeugDialog` trägt `vp-fz-*` und wird seit P7 von ZWEI Wirten geöffnet:
 * der Fahrzeuge-Karte (Verbraucher-Zone) UND dem Ladevorgangs-Verlauf. Solange
 * es nur den ersten gab, war der Dialog zufällig gestylt, weil dieser Wirt die
 * Datei importierte; im zweiten wäre er eine ungestylte Fläche gewesen -
 * Karten als nackte Knöpfe, die Folgenliste als bare `<ul>`.
 *
 * jsdom rendert kein Stylesheet, dieser Wächter liest deshalb den QUELLTEXT.
 */
const dir = join(__dirname, 'components');
const dialog = readFileSync(join(dir, 'FahrzeugDialog.tsx'), 'utf8');
const karte = readFileSync(join(dir, 'FahrzeugeKarte.tsx'), 'utf8');
const css = readFileSync(join(dir, 'FahrzeugeKarte.css'), 'utf8');

describe('Die P7-Flächen bringen ihr Stylesheet selbst mit', () => {
  it('der Dialog importiert die Datei, deren Klassen er trägt', () => {
    expect(dialog).toMatch(/import '\.\/FahrzeugeKarte\.css'/);
  });

  it('die Karte ebenso', () => {
    expect(karte).toMatch(/import '\.\/FahrzeugeKarte\.css'/);
  });

  // ⚠ Und die Datei muss die Klassen wirklich tragen - ein Import auf eine
  // Datei ohne die Regeln wäre derselbe Defekt mit einer grünen Zeile davor.
  it('und die Datei trägt jede `vp-fz-`-Klasse, die die zwei benutzen', () => {
    const benutzt = new Set(
      [...`${dialog}${karte}`.matchAll(/vp-fz-[a-z-]+/g)].map((m) => m[0]),
    );
    expect(benutzt.size).toBeGreaterThan(3);
    for (const klasse of benutzt) {
      expect(css, `${klasse} fehlt in FahrzeugeKarte.css`).toContain(`.${klasse}`);
    }
  });
});
