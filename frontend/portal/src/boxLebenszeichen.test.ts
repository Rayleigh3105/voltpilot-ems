import { describe, expect, it } from 'vitest';
import { boxSchonAngemeldetOnline } from './boxLebenszeichen';

const NOW = new Date('2026-08-03T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('boxSchonAngemeldetOnline (vp-einrichtung-verbunden-keine-wahl)', () => {
  it('null/fehlend - die Box hat sich nie angemeldet', () => {
    expect(boxSchonAngemeldetOnline(null, NOW)).toBe(false);
    expect(boxSchonAngemeldetOnline(undefined, NOW)).toBe(false);
  });

  it('nie zugeordnet (schluesselAbgeholtAm null): zuletztAbgefragtAm vor 2 Min zählt als online, vor 4 Min nicht mehr', () => {
    expect(boxSchonAngemeldetOnline(
      { zuletztAngefragtAm: ago(5 * 60_000), schluesselAbgeholtAm: null, zuletztAbgefragtAm: ago(2 * 60_000) },
      NOW,
    )).toBe(true);
    expect(boxSchonAngemeldetOnline(
      { zuletztAngefragtAm: ago(5 * 60_000), schluesselAbgeholtAm: null, zuletztAbgefragtAm: ago(4 * 60_000) },
      NOW,
    )).toBe(false);
  });

  it('schon einmal ausgestellt (schluesselAbgeholtAm gesetzt): das weitere 11-Min-Fenster gilt', () => {
    expect(boxSchonAngemeldetOnline(
      { zuletztAngefragtAm: ago(20 * 60_000), schluesselAbgeholtAm: ago(20 * 60_000), zuletztAbgefragtAm: ago(10 * 60_000) },
      NOW,
    )).toBe(true);
    expect(boxSchonAngemeldetOnline(
      { zuletztAngefragtAm: ago(20 * 60_000), schluesselAbgeholtAm: ago(20 * 60_000), zuletztAbgefragtAm: ago(12 * 60_000) },
      NOW,
    )).toBe(false);
  });

  it('ohne zuletztAbgefragtAm fällt es auf zuletztAngefragtAm (die CSR) zurück', () => {
    expect(boxSchonAngemeldetOnline(
      { zuletztAngefragtAm: ago(60_000), schluesselAbgeholtAm: null },
      NOW,
    )).toBe(true);
  });
});
