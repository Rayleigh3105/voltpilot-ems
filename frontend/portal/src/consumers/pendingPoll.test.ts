import { describe, expect, it } from 'vitest';
import { wartetAufBestaetigung, wunschDes } from './pendingPoll';
import type { ConsumerRuntimeStatus } from './status';

const s = (x: Partial<ConsumerRuntimeStatus> & { entityId: string }): ConsumerRuntimeStatus =>
  ({ state: 'running_manual', reportedAt: '2026-11-27T10:00:00Z', ...x });

const start = (entityId: string) => ({ entityId, kind: 'start', targetCommand: 'on_off' });

describe('wartetAufBestaetigung', () => {
  it('ist falsch ohne Handeingriffe', () => {
    expect(wartetAufBestaetigung([], [])).toBe(false);
    expect(wartetAufBestaetigung(null, null)).toBe(false);
  });

  it('ist wahr ohne jede Rückmeldung des Verbrauchers', () => {
    expect(wartetAufBestaetigung([start('rod-1')], [])).toBe(true);
  });

  it('ist wahr, solange confirmed nicht true ist (unbekannt oder Abweichung)', () => {
    expect(wartetAufBestaetigung([start('rod-1')], [s({ entityId: 'rod-1', confirmed: null })])).toBe(true);
    expect(wartetAufBestaetigung([start('rod-1')], [s({ entityId: 'rod-1', confirmed: false })])).toBe(true);
  });

  it('ist falsch, sobald der Verbraucher den Wunsch bestätigt', () => {
    expect(wartetAufBestaetigung([start('rod-1')], [s({ entityId: 'rod-1', confirmed: true })])).toBe(false);
  });

  it('bleibt wahr, solange IRGENDEIN Handeingriff unbestätigt ist', () => {
    expect(wartetAufBestaetigung(
      [start('rod-1'), start('wallbox-2')],
      [s({ entityId: 'rod-1', confirmed: true }), s({ entityId: 'wallbox-2', confirmed: false })],
    )).toBe(true);
  });

  // vp-schalten-3s (Captain-Befund 27.11.2026): L1 war von Hand an und ist bestätigt, „Aus“ ist unterwegs. Der
  // VORIGE Stand ist confirmed - die Fläche muss trotzdem im schnellen Takt bleiben, bis „aus“ zurückgelesen ist.
  it('wartet beim Heizstab auf den gewünschten Stand, nicht auf irgendein confirmed', () => {
    const aus = [{ entityId: 'stab', kind: 'stop', targetCommand: 'setpoint_kw', targetValue: 0 }];
    const l1an = s({ entityId: 'stab', confirmed: true, stufe: { commanded: 1, confirmed: 1, outputs_on: [0] } });
    const allesAus = s({ entityId: 'stab', state: 'waiting', confirmed: true,
      stufe: { commanded: 0, confirmed: 0, outputs_on: [] } });
    expect(wartetAufBestaetigung(aus, [l1an])).toBe(true);
    expect(wartetAufBestaetigung(aus, [{ ...l1an, reasonCode: 'guard_min_on' }])).toBe(true);
    expect(wartetAufBestaetigung(aus, [allesAus])).toBe(false);
  });

  it('liest den Wunsch aus dem Handeingriff', () => {
    expect(wunschDes({ entityId: 'x', kind: 'start', targetCommand: 'setpoint_kw', targetValue: 1.5,
      targetOutputs: [1] })).toEqual({ art: 'start', kommando: 'setpoint_kw', wert: 1.5, ausgaenge: [1] });
  });
});
