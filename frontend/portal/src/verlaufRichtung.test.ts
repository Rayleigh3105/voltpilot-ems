import { describe, expect, it } from 'vitest';
import { richtungsWert, statKacheln, vorzeichenRegel } from './verlaufRichtung';
import type { VerlaufStats } from './verlauf';

const NBSP = ' ';
const kw = (s: string) => s.replace(' ', NBSP);

function stats(min: number | null, max: number | null, avg: number | null, last: number | null): VerlaufStats {
  return {
    min: min == null ? null : { value: min, t: '2026-10-22T10:00:00Z' },
    max: max == null ? null : { value: max, t: '2026-10-05T10:00:00Z' },
    avg,
    last,
  };
}

describe('vorzeichenRegel — nur aus den Verträgen', () => {
  it('Netz: power_kw am Netzanschluss, grid_power_kw und die v1-Reihe netz', () => {
    expect(vorzeichenRegel('power_kw', 'grid')).toBe('netz');
    expect(vorzeichenRegel('grid_power_kw', 'grid')).toBe('netz');
    expect(vorzeichenRegel('netz', 'grid')).toBe('netz');
  });
  it('Speicher: battery_power_kw (+ laden, − entladen)', () => {
    expect(vorzeichenRegel('battery_power_kw', 'storage')).toBe('batterie');
  });
  it('alles andere bleibt ohne Regel - power_kw an einem Verbraucher hat keine Richtung', () => {
    expect(vorzeichenRegel('power_kw', 'consumer')).toBeNull();
    expect(vorzeichenRegel('power_kw', 'storage')).toBeNull();
    expect(vorzeichenRegel('pv_power_kw', 'pv')).toBeNull();
    expect(vorzeichenRegel('soc_pct', 'storage')).toBeNull();
    expect(vorzeichenRegel('load_kw', 'house')).toBeNull();
  });
});

describe('richtungsWert — Betrag ohne Minus, Richtung in Worten', () => {
  it('Bezug: positiv', () => {
    expect(richtungsWert(11.3, 'kW', 'netz')).toEqual({ betrag: kw('11,3 kW'), wort: 'Bezug' });
  });
  it('Einspeisung: negativ, ohne Minus', () => {
    expect(richtungsWert(-0.5, 'kW', 'netz')).toEqual({ betrag: kw('0,5 kW'), wort: 'Einspeisung' });
  });
  it('null bleibt richtungslos - auch knapp daneben, was als 0,0 erscheint', () => {
    expect(richtungsWert(0, 'kW', 'netz')).toEqual({ betrag: kw('0,0 kW'), wort: null });
    expect(richtungsWert(-0.04, 'kW', 'netz')).toEqual({ betrag: kw('0,0 kW'), wort: null });
    expect(richtungsWert(0.049, 'kW', 'netz')).toEqual({ betrag: kw('0,0 kW'), wort: null });
    expect(richtungsWert(-0.05, 'kW', 'netz').wort).toBe('Einspeisung');
  });
  it('fehlend ist keine Null', () => {
    expect(richtungsWert(null, 'kW', 'netz')).toEqual({ betrag: '-', wort: null });
  });
  it('Speicher: Laden / Entladen', () => {
    expect(richtungsWert(2.4, 'kW', 'batterie').wort).toBe('Laden');
    expect(richtungsWert(-2.4, 'kW', 'batterie')).toEqual({ betrag: kw('2,4 kW'), wort: 'Entladen' });
  });
});

describe('statKacheln — die vier Kacheln', () => {
  it('Bildschirmfoto: kreuzt null - höchster Bezug und höchste Einspeisung', () => {
    const k = statKacheln(stats(-9.1, 11.3, -0.5, -0.6), 'kW', 'netz');
    expect(k.min).toEqual({ label: 'Höchste Einspeisung', wert: kw('9,1 kW'), wort: null });
    expect(k.max).toEqual({ label: 'Höchster Bezug', wert: kw('11,3 kW'), wort: null });
    expect(k.avg).toEqual({ label: 'Durchschnitt', wert: kw('0,5 kW'), wort: 'Einspeisung' });
    expect(k.last).toEqual({ label: 'Letzter Wert', wert: kw('0,6 kW'), wort: 'Einspeisung' });
  });
  it('nur Bezug: niedrigster und höchster Bezug', () => {
    const k = statKacheln(stats(0.8, 6.2, 3.1, 2), 'kW', 'netz');
    expect(k.min.label).toBe('Niedrigster Bezug');
    expect(k.max.label).toBe('Höchster Bezug');
    expect(k.avg.wort).toBe('Bezug');
  });
  it('nur Einspeisung: das Minimum ist die höchste, das Maximum die niedrigste Einspeisung', () => {
    const k = statKacheln(stats(-7, -1.5, -4, -2), 'kW', 'netz');
    expect(k.min).toEqual({ label: 'Höchste Einspeisung', wert: kw('7,0 kW'), wort: null });
    expect(k.max).toEqual({ label: 'Niedrigste Einspeisung', wert: kw('1,5 kW'), wort: null });
  });
  it('ein Extrem bei 0,0 liegt auf der Seite des anderen', () => {
    const k = statKacheln(stats(0, 4, 2, 0), 'kW', 'netz');
    expect(k.min).toEqual({ label: 'Niedrigster Bezug', wert: kw('0,0 kW'), wort: null });
    expect(k.last).toEqual({ label: 'Letzter Wert', wert: kw('0,0 kW'), wort: null });
  });
  it('alles 0,0: neutrale Namen, nie „−0,0“', () => {
    const k = statKacheln(stats(-0.01, 0.02, 0, -0.01), 'kW', 'netz');
    expect(k.min).toEqual({ label: 'Minimum', wert: kw('0,0 kW'), wort: null });
    expect(k.max).toEqual({ label: 'Maximum', wert: kw('0,0 kW'), wort: null });
  });
  it('Speicher kreuzt null: höchste Lade- und Entladeleistung', () => {
    const k = statKacheln(stats(-5, 3, 0.4, -1.2), 'kW', 'batterie');
    expect(k.min.label).toBe('Höchste Entladeleistung');
    expect(k.max.label).toBe('Höchste Ladeleistung');
    expect(k.avg.wort).toBe('Laden');
    expect(k.last).toEqual({ label: 'Letzter Wert', wert: kw('1,2 kW'), wort: 'Entladen' });
  });
  it('ohne Regel bleibt alles wie bisher - auch ein negativer Wert', () => {
    const k = statKacheln(stats(-1, 5, 2, 3), 'kW', null);
    expect(k.min).toEqual({ label: 'Minimum', wert: kw('-1,0 kW'), wort: null });
    expect(k.max.label).toBe('Maximum');
    expect(k.avg.label).toBe('Durchschnitt');
    expect(k.last.label).toBe('Letzter Wert');
  });
  it('fehlende Werte bleiben „-“', () => {
    const k = statKacheln(stats(null, null, null, null), 'kW', 'netz');
    expect(k.min).toEqual({ label: 'Minimum', wert: '-', wort: null });
    expect(k.avg).toEqual({ label: 'Durchschnitt', wert: '-', wort: null });
  });
});
