import { describe, expect, it } from 'vitest';
import { abweichungsGrafik, schoenerSchritt, spaltenGrafik, zielSkala, zusammenGrafik } from './auswertenGrafik';

/** Die Geometrie der großen Grafiken der Kennzahl-Seite (Konzept Auswerten a1 §6.12) - nur Lage, nie eine Menge. */
describe('Abweichung je Monat', () => {
  const zwoelf = (deltas: (string | null)[]) =>
    deltas.map((delta, i) => ({ periode: `2028-${String(i + 1).padStart(2, '0')}`, delta, art: delta === null ? ('leer' as const) : ('schlechter' as const) }));

  it('± 6 % mit Strichen bei ± 4 %, oben „mehr“, unten „weniger“; das Band ± 2 % um die Nulllinie', () => {
    const g = abweichungsGrafik(zwoelf(['2.2', '-1.0', null, ...Array(9).fill('3.6')]), '2.0');
    expect(g.achse.map((a) => a.text)).toEqual(['mehr', '+4 %', '0', '−4 %', 'weniger']);
    expect(g.nullY).toBe(71);
    // ± 2 % von ± 6 % sind ein Drittel der halben Fläche (134 / 2 / 3).
    expect(g.band.hoehe).toBeCloseTo(44.67, 1);
    // Säulen höchstens 16 breit; ein Monat ohne Abweichung bleibt leer und gestrichelt, nie eine Säule der Höhe 0.
    expect(g.saeulen.every((s) => s.w <= 16)).toBe(true);
    expect(g.saeulen[2]).toMatchObject({ art: 'leer', pfad: null });
    expect(g.saeulen[2].leer?.h).toBeGreaterThan(0);
  });

  it('größere Abweichungen strecken die Achse auf den nächsten runden Wert; am Rechner die halben Schritte dazu', () => {
    expect(abweichungsGrafik(zwoelf(['14.3', '-17.2']), '2.0').achse.map((a) => a.text)).toEqual(['mehr', '+10 %', '0', '−10 %', 'weniger']);
    expect(abweichungsGrafik(zwoelf(['2.2']), '2.0', { breite: 560, flaeche: 168, dicht: true }).linien).toHaveLength(5);
  });
});

describe('Säulen mit Vorjahr, Zusammengezählt, Ziel-Skala', () => {
  it('zwei runde Werte an der Achse, das Vorjahr als Punkt; ein Monat ohne Wert gestrichelt', () => {
    const g = spaltenGrafik(['20.64', null, '22.06'], ['20.64', '19.2', null]);
    expect(g.achse.map((a) => a.text)).toEqual(['10', '20']);
    expect(g.saeulen[1]).toMatchObject({ pfad: null });
    expect(g.punkte[2]).toBeNull();
    expect(g.punkte[0]?.y).toBeLessThan(g.nullY);
  });

  it('schöne Schritte: 1 · 2 · 2,5 · 5 · 10 je Zehnerpotenz', () => {
    expect([schoenerSchritt(8.8), schoenerSchritt(22.8), schoenerSchritt(0.118), schoenerSchritt(0)]).toEqual([10, 25, 0.2, 1]);
  });

  it('die zusammengezählte Linie bricht an einem Monat ohne Urteil ab und endet am letzten Punkt', () => {
    const g = zusammenGrafik(['53', '54', null, '8956', '6143']);
    expect(g.strecken).toHaveLength(2);
    expect(g.ende?.x).toBeGreaterThan(0);
    expect(g.linien.some((l) => l.istNull)).toBe(true);
  });

  it('die Ziel-Skala: mehr links, weniger rechts, die Bezugsbasis in der Mitte; sie wächst mit größeren Werten', () => {
    const s = zielSkala('2.2', '-4.0');
    expect(s.mitte).toBe(160);
    expect(s.jetzt!).toBeLessThan(s.mitte);
    expect(s.ziel).toBeGreaterThan(s.mitte);
    expect(s.texte.jetzt?.anker).toBe('s');
    expect(zielSkala(null, '-4.0').jetzt).toBeNull();
    // 12 % passen nicht auf ± 6 %: die Skala reicht dann ± 13 %, der Punkt bleibt innerhalb der Spur.
    const weit = zielSkala('12', '-4');
    expect(weit.jetzt!).toBeGreaterThanOrEqual(weit.spur.x);
  });
});
