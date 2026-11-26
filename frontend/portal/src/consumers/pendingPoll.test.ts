import { describe, expect, it } from 'vitest';
import { wartetAufBestaetigung } from './pendingPoll';

describe('wartetAufBestaetigung', () => {
  it('ist falsch ohne Handeingriffe', () => {
    expect(wartetAufBestaetigung([], [])).toBe(false);
    expect(wartetAufBestaetigung(null, null)).toBe(false);
  });

  it('ist wahr ohne jede Rückmeldung des Verbrauchers', () => {
    expect(wartetAufBestaetigung([{ entityId: 'rod-1' }], [])).toBe(true);
  });

  it('ist wahr, solange confirmed nicht true ist (unbekannt oder Abweichung)', () => {
    expect(wartetAufBestaetigung(
      [{ entityId: 'rod-1' }],
      [{ entityId: 'rod-1', confirmed: null }],
    )).toBe(true);
    expect(wartetAufBestaetigung(
      [{ entityId: 'rod-1' }],
      [{ entityId: 'rod-1', confirmed: false }],
    )).toBe(true);
  });

  it('ist falsch, sobald der Verbraucher bestätigt', () => {
    expect(wartetAufBestaetigung(
      [{ entityId: 'rod-1' }],
      [{ entityId: 'rod-1', confirmed: true }],
    )).toBe(false);
  });

  it('bleibt wahr, solange IRGENDEIN Handeingriff unbestätigt ist', () => {
    expect(wartetAufBestaetigung(
      [{ entityId: 'rod-1' }, { entityId: 'wallbox-2' }],
      [{ entityId: 'rod-1', confirmed: true }, { entityId: 'wallbox-2', confirmed: false }],
    )).toBe(true);
  });
});
