import { describe, expect, it } from 'vitest';
import { compassLabel, fmtNum, fmtRelative, GERADE_EBEN, NBSP, seitDauer } from './format';

const NOW = new Date('2026-09-10T10:00:00Z');
const vor = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

describe('fmtNum — echtes Minus statt ASCII-Bindestrich (Zählerbaum-Konzept N2)', () => {
  it('setzt bei einem negativen Wert U+2212, nie "-"', () => {
    expect(fmtNum(-2.9, 'kW')).toBe(`−2,9${NBSP}kW`);
    expect(fmtNum(-2.9, 'kW')).not.toContain('-');
  });

  it('bleibt bei null und positiven Werten unverändert', () => {
    expect(fmtNum(null, 'kW')).toBe('-');
    expect(fmtNum(2.9, 'kW')).toBe(`2,9${NBSP}kW`);
    expect(fmtNum(0, 'kW')).toBe(`0,0${NBSP}kW`);
  });
});

describe('fmtRelative — Datenalter in Worten', () => {
  it('sagt „gerade eben" statt „vor 0 Sek."', () => {
    expect(fmtRelative(vor(0), NOW)).toBe(GERADE_EBEN);
    expect(fmtRelative(vor(4), NOW)).toBe(GERADE_EBEN);
    // Eine Uhr, die vorgeht, macht die Messung nicht „vor −3 Sek.".
    expect(fmtRelative(vor(-3), NOW)).toBe(GERADE_EBEN);
  });

  it('zählt ab fünf Sekunden wie bisher', () => {
    expect(fmtRelative(vor(5), NOW)).toBe(`vor 5${NBSP}Sek.`);
    expect(fmtRelative(vor(12 * 60), NOW)).toBe(`vor 12${NBSP}Min.`);
    expect(fmtRelative(vor(3 * 3600), NOW)).toBe(`vor 3${NBSP}Std.`);
    expect(fmtRelative(null, NOW)).toBe('noch nie');
  });
});

describe('compassLabel — Himmelsrichtung statt Gradzahl (N4)', () => {
  it('benennt alle 8 Hauptausrichtungen des Registers', () => {
    expect(compassLabel(0)).toBe('Nord');
    expect(compassLabel(45)).toBe('Nord-Ost');
    expect(compassLabel(90)).toBe('Ost');
    expect(compassLabel(135)).toBe('Süd-Ost');
    expect(compassLabel(180)).toBe('Süd');
    expect(compassLabel(225)).toBe('Süd-West');
    expect(compassLabel(270)).toBe('West');
    expect(compassLabel(315)).toBe('Nord-West');
  });

  it('erfindet keine Richtung für eine manuell eingetragene Gradzahl', () => {
    expect(compassLabel(190)).toBeNull();
  });
});

describe('seitDauer — die Dauer eines anhaltenden Zustands', () => {
  it('bleibt ein Satz, auch direkt nach Beginn', () => {
    expect(seitDauer(vor(2), NOW)).toBe('seit wenigen Sekunden');
    expect(seitDauer(vor(3 * 3600), NOW)).toBe(`seit 3${NBSP}Std.`);
    expect(seitDauer(null, NOW)).toBeNull();
  });
});
