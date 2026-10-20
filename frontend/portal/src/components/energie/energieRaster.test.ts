import { describe, expect, it } from 'vitest';
import { NARROW_PX } from '../../chartStyle';
import { bilanzRand, spurLage, tagRand } from './energieRaster';

/** Die Spur sitzt nur dann unter ihrem Balken, wenn sie dieselben Ränder rechnet wie das Diagramm. */
describe('energieRaster — eine Quelle für Diagramm und Spur', () => {
  it('nimmt am Telefon die schmalen Ränder', () => {
    expect(bilanzRand(NARROW_PX - 1)).toEqual({ left: 48, right: 12 });
    expect(bilanzRand(800)).toEqual({ left: 56, right: 12 });
    expect(tagRand(NARROW_PX - 1)).toEqual({ left: 40, right: 12 });
    expect(tagRand(800)).toEqual({ left: 48, right: 12 });
  });

  it('legt eine Bilanz-Zelle genau in ihr Kategorie-Band', () => {
    // 31 Tage auf 800 px: Zeichenfläche 800 - 56 - 12 = 732 px.
    const band = 732 / 31;
    expect(spurLage('bilanz', 800, 31, 6, 6)).toEqual({ x: 56 + 6 * band, w: band });
    expect(spurLage('bilanz', 800, 31, 0, 30)).toEqual({ x: 56, w: 732 });
  });

  it('spannt am Tag wie die Bänder des Diagramms von Punkt zu Punkt', () => {
    // 96 Punkte, 95 Schritte auf 800 - 48 - 12 = 740 px.
    const schritt = 740 / 95;
    const lage = spurLage('tag', 800, 96, 41, 62);
    expect(lage.x).toBeCloseTo(48 + 41 * schritt);
    expect(lage.w).toBeCloseTo(21 * schritt);
    // Eine einzelne Viertelstunde bleibt einen Schritt breit, am Ende nie über die Achse.
    expect(spurLage('tag', 800, 96, 50, 50).w).toBeCloseTo(schritt);
    const ende = spurLage('tag', 800, 96, 95, 95);
    expect(ende.x).toBeCloseTo(48 + 740);
    expect(ende.w).toBe(0);
  });
});
