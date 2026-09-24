import { describe, expect, it } from 'vitest';
import { fmtRelative, GERADE_EBEN, NBSP, seitDauer } from './format';

const NOW = new Date('2026-09-10T10:00:00Z');
const vor = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

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

describe('seitDauer — die Dauer eines anhaltenden Zustands', () => {
  it('bleibt ein Satz, auch direkt nach Beginn', () => {
    expect(seitDauer(vor(2), NOW)).toBe('seit wenigen Sekunden');
    expect(seitDauer(vor(3 * 3600), NOW)).toBe(`seit 3${NBSP}Std.`);
    expect(seitDauer(null, NOW)).toBeNull();
  });
});
