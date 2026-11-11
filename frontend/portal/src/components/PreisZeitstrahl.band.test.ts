import { describe, expect, it } from 'vitest';
import { bandBeschriftung } from './PreisZeitstrahl';

describe('bandBeschriftung (Tagesband im Preisbild)', () => {
  const fassungen = ['Donnerstag, 10. September', 'Do 10.09.', 'Do'];
  it('nimmt die längste Fassung, die passt', () => {
    expect(bandBeschriftung(fassungen, 400)).toBe('Donnerstag, 10. September');
    expect(bandBeschriftung(fassungen, 90)).toBe('Do 10.09.');
  });
  it('ein schmaler Tag (abends) bekommt nur den Wochentag statt einer abgeschnittenen Datumsangabe', () => {
    expect(bandBeschriftung(fassungen, 50)).toBe('Do');
  });
  it('zu schmal für jede Fassung: keine Beschriftung', () => {
    expect(bandBeschriftung(fassungen, 20)).toBeNull();
  });
});
