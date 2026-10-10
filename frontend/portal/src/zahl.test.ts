import { describe, expect, it } from 'vitest';
import { zahl, zahlText, parseDecimal, ablesestandWert } from './zahl';
describe('gemeinsame Zahleneingabe', () => {
  it.each([['1.234,5', 1234.5], ['48.200', 48200], ['48200', 48200], ['48 200', 48200], ['0', 0], ['-1,2', -1.2]])('%s', (s, n) => expect(zahl(s)).toBe(n));
  it.each(['', 'abc', '1.23,4', '1,2,3', 'Infinity', '1e3', '0x10'])('weist %s zurück', s => expect(zahl(s)).toBeNull());
  it('überträgt Dezimaltext ohne Zahlkonvertierung und gruppiert für die API', () => {
    expect(zahlText('12345678901234567890,123456789')).toBe('12.345.678.901.234.567.890,123456789');
    expect(zahlText('48 200')).toBe('48.200');
  });
  it('erhält die Bestandsdeutung einfacher Dezimalpunkte und Exponenten', () => {
    expect(parseDecimal('1.234')).toBe(1.234);
    expect(parseDecimal('1e3')).toBe(1000);
    expect(parseDecimal('1.234,5')).toBeNull();
    expect(ablesestandWert('1.234')).toBe(1234);
    expect(ablesestandWert('1234.5')).toBe(1234.5);
  });
});
