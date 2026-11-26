import { describe, expect, it } from 'vitest';
import { gueltigAbWert, heuteBerlin, preisGiltAbSatz, preisGiltAbStart } from './preisGiltAb';

// 26.11.2026 00:30 in Berlin ist in UTC noch der 25.11. - der Tag der Anlage zählt.
const JETZT = new Date('2026-11-25T23:30:00Z');

describe('preisGiltAb (vp-tarif-ab-tag)', () => {
  it('beginnt ab heute in Berlin, nicht am UTC-Tag', () => {
    expect(heuteBerlin(JETZT)).toBe('2026-11-26');
    expect(preisGiltAbStart(JETZT)).toEqual({ tag: '2026-11-26', schonImmer: false });
  });

  it('schickt einen Tag bis heute, „beginn“ für schon immer, nie die Zukunft', () => {
    expect(gueltigAbWert({ tag: '2026-11-26', schonImmer: false }, JETZT)).toBe('2026-11-26');
    expect(gueltigAbWert({ tag: '2026-10-01', schonImmer: false }, JETZT)).toBe('2026-10-01');
    expect(gueltigAbWert({ tag: '2026-11-27', schonImmer: false }, JETZT)).toBeNull();
    expect(gueltigAbWert({ tag: '', schonImmer: false }, JETZT)).toBeNull();
    expect(gueltigAbWert({ tag: '', schonImmer: true }, JETZT)).toBe('beginn');
  });

  it('sagt, was die Wahl mit den Erlösen macht', () => {
    expect(preisGiltAbSatz({ tag: '2026-11-26', schonImmer: false }, JETZT)).toBe(
      'Ab heute. Die Erlöse der Tage davor bleiben, wie sie waren.',
    );
    expect(preisGiltAbSatz({ tag: '2026-10-01', schonImmer: false }, JETZT)).toBe(
      'Ab dem 01.10.2026. Die Erlöse ab diesem Tag werden neu berechnet, die davor bleiben.',
    );
    expect(preisGiltAbSatz({ tag: '2026-10-01', schonImmer: true }, JETZT)).toBe(
      'Alle bisherigen Erlöse werden mit dem neuen Wert neu berechnet.',
    );
  });
});
