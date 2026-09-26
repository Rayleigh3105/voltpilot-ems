import { describe, expect, it } from 'vitest';

import { balkenliste, ctWert, istMinus, lage, skalaFuer, type BalkenZeile } from './balkenliste';
import { NBSP } from './format';

function zeile(id: string, von: number, bis: number): BalkenZeile {
  return {
    id,
    name: id,
    rolle: 'einspeisung',
    wert: ctWert(bis),
    vorhanden: true,
    segmente: [{ rolle: 'einspeisung', von, bis }],
    unter: null,
  };
}

describe('balkenliste · die Skala ist ehrlich ab 0', () => {
  it('beginnt bei 0 und reicht bis zum größten Wert — kein erfundener Kopfraum', () => {
    const s = skalaFuer([zeile('a', 0, 25), zeile('b', 0, 9.3)]);
    expect(s).toEqual({ min: 0, max: 25 });
    expect(lage(25, s)).toBe(100);
    expect(lage(9.3, s)).toBeCloseTo(37.2, 6);
  });

  it('zieht den Anfang für einen negativen Wert nach links, statt ihn abzuschneiden', () => {
    const s = skalaFuer([zeile('a', 0, 6.2), zeile('b', 0, -0.35)]);
    expect(s.min).toBe(-0.35);
    expect(s.max).toBe(6.2);
    // Die Null liegt IN der Spur — dort steht die Nulllinie.
    expect(lage(0, s)).toBeGreaterThan(0);
    expect(lage(0, s)).toBeLessThan(10);
  });

  it('hat ohne Werte eine gültige Spanne statt einer Division durch null', () => {
    const s = skalaFuer([]);
    expect(s).toEqual({ min: 0, max: 1 });
    expect(Number.isFinite(lage(0.5, s))).toBe(true);
  });

  it('wird nie von Hand gesetzt — `balkenliste()` rechnet sie aus den Zeilen', () => {
    const l = balkenliste('Preise', [zeile('a', 0, 12)]);
    expect(l.skala).toEqual({ min: 0, max: 12 });
    expect(l.label).toBe('Preise');
  });
});

describe('balkenliste · ct-Werte in Kundenschreibweise', () => {
  it('schreibt eine Nachkommastelle und hält Zahl und Einheit zusammen', () => {
    expect(ctWert(25)).toBe(`25,0${NBSP}ct`);
    expect(ctWert(9.31)).toBe(`9,3${NBSP}ct`);
  });

  it('setzt das typografische Minus nur, wo nach dem Runden etwas übrig bleibt', () => {
    expect(ctWert(-0.35)).toBe(`−${NBSP}0,4${NBSP}ct`);
    expect(ctWert(-0.04)).toBe(`0,0${NBSP}ct`);
    expect(istMinus(-0.35)).toBe(true);
    expect(istMinus(-0.04)).toBe(false);
  });

  it('schreibt „—" für einen fehlenden Wert — nie eine Null', () => {
    expect(ctWert(null)).toBe('—');
    expect(ctWert(undefined)).toBe('—');
    expect(ctWert(Number.NaN)).toBe('—');
  });
});
