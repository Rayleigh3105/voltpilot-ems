import { describe, expect, it } from 'vitest';
import { eigeneSpalten, lueckenFuellen, type Kasten } from './rasterLuecken';

/** Ein Kasten im Raster: Spalte `s` (0-basiert), `breite` Spalten, Zeile `z`, `hoehe` Zeilen. */
function kasten(s: number, breite: number, z: number, hoehe = 1, spalte = 100, abstand = 10): Kasten {
  const left = s * (spalte + abstand);
  const top = z * 200;
  return { left, right: left + breite * spalte + (breite - 1) * abstand, top, bottom: top + hoehe * 200 - 10 };
}

const RAND4 = { left: 0, right: 4 * 100 + 3 * 10 };
const RAND2 = { left: 0, right: 2 * 100 + 10 };

describe('lueckenFuellen', () => {
  it('Telefon: eine kleine Kachel vor einer breiten übernimmt die freie Spalte', () => {
    // Autarkie · Eigenverbrauch · Speicher (klein) · Sonne (breit)
    const k = [kasten(0, 1, 0), kasten(1, 1, 0), kasten(0, 1, 1), kasten(0, 2, 2)];
    expect([...lueckenFuellen(k, RAND2, 100, 10)]).toEqual([[2, 1]]);
  });

  it('Rechner: drei kleine Kacheln in vier Spalten - die dritte nimmt die vierte Spalte mit', () => {
    const k = [kasten(0, 1, 0), kasten(1, 1, 0), kasten(2, 1, 0), kasten(0, 2, 1), kasten(2, 2, 1)];
    expect([...lueckenFuellen(k, RAND4, 100, 10)]).toEqual([[2, 1]]);
  });

  it('eine volle Zeile bleibt, wie sie ist', () => {
    const k = [kasten(0, 2, 0), kasten(2, 2, 0)];
    expect(lueckenFuellen(k, RAND4, 100, 10).size).toBe(0);
  });

  it('eine hohe Kachel rechts aus der Zeile davor zählt als belegt', () => {
    // Zeile 0: klein, klein, hoch (2 Spalten, 2 Zeilen); Zeile 1: klein, klein.
    const k = [kasten(0, 1, 0), kasten(1, 1, 0), kasten(2, 2, 0, 2), kasten(0, 1, 1), kasten(1, 1, 1)];
    expect(lueckenFuellen(k, RAND4, 100, 10).size).toBe(0);
  });

  it('die letzte Zeile mit einer einzelnen kleinen Kachel wird ganz gefüllt', () => {
    const k = [kasten(0, 2, 0), kasten(2, 2, 0), kasten(0, 1, 1)];
    expect([...lueckenFuellen(k, RAND4, 100, 10)]).toEqual([[2, 3]]);
  });

  it('ein unsichtbarer Platz (Breite 0) zählt nicht', () => {
    const k = [kasten(0, 1, 0), { left: 0, right: 0, top: 0, bottom: 0 }, kasten(1, 1, 0)];
    expect(lueckenFuellen(k, RAND2, 100, 10).size).toBe(0);
  });

  it('eigeneSpalten liest die Spaltenzahl aus der Breite', () => {
    expect(eigeneSpalten(kasten(0, 1, 0), 100, 10)).toBe(1);
    expect(eigeneSpalten(kasten(0, 2, 0), 100, 10)).toBe(2);
  });
});
