import { describe, expect, it } from 'vitest';
import { hasValue, isReportedTotal, NO_DATA, numOrNoData } from './nodata';
import { NBSP } from './format';

/**
 * X1 (Audit) — die EINE „keine Daten ⇒ —, nie eine erfundene 0"-Regel. Vorher
 * standen auf EINEM Bildschirm drei verschiedene Striche und eine 0, die es
 * nicht gab.
 */
describe('nodata — the one honesty helper', () => {
  it('uses exactly one mark for „kein Wert"', () => {
    expect(NO_DATA).toBe('—');
  });

  it('hasValue: a MEASURED 0 is a value, absent/NaN is not', () => {
    expect(hasValue(0)).toBe(true);
    expect(hasValue(-2.1)).toBe(true);
    expect(hasValue(null)).toBe(false);
    expect(hasValue(undefined)).toBe(false);
    expect(hasValue(Number.NaN)).toBe(false);
    expect(hasValue(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('numOrNoData: formats a real number, else the dash — never a 0', () => {
    expect(numOrNoData(5.85, 'kW', 1)).toBe(`5,9${NBSP}kW`);
    expect(numOrNoData(0, 'kW', 1)).toBe(`0,0${NBSP}kW`);
    expect(numOrNoData(87, '%', 0)).toBe(`87${NBSP}%`);
    expect(numOrNoData(null, 'kW')).toBe(NO_DATA);
    expect(numOrNoData(undefined, '%', 0)).toBe(NO_DATA);
    expect(numOrNoData(Number.NaN, 'kW')).toBe(NO_DATA);
  });

  it('isReportedTotal: a 0-bucket day total counts as NOT reported', () => {
    // The history endpoint answers `pvGenerationKwh: 0.0` on a day with zero
    // buckets while correctly nulling the cost fields - so a 0 here cannot be
    // told apart from "nothing measured" and must not be printed.
    expect(isReportedTotal(32.1)).toBe(true);
    expect(isReportedTotal(0)).toBe(false);
    expect(isReportedTotal(null)).toBe(false);
    expect(isReportedTotal(undefined)).toBe(false);
  });
});
