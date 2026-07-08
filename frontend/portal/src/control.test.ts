import { describe, expect, it } from 'vitest';
import type { ControlStatus } from './api';
import { controlStrip } from './control';

const NOW = new Date('2026-07-08T12:00:10Z');

function status(over: Partial<ControlStatus>): ControlStatus {
  return {
    deviceId: 'd1',
    commandedKw: -4,
    confirmedKw: -4,
    allMatch: true,
    controlEnabled: true,
    certified: true,
    mismatchRoles: null,
    slotStart: '2026-07-08T12:00:00Z',
    checkedAt: '2026-07-08T12:00:07Z',
    ...over,
  };
}

describe('controlStrip', () => {
  it('returns null when there is no status yet (default)', () => {
    expect(controlStrip(null, NOW)).toBeNull();
  });

  it('stays honest for a controllable plant with no readback yet (report N4)', () => {
    const v = controlStrip(null, NOW, true)!;
    expect(v.state).toBe('preparing');
    expect(v.tone).toBe('off');
    expect(v.sentence).toContain('vorbereitet');
    // No register/Modbus jargon reaches the customer.
    expect(v.sentence.toLowerCase()).not.toContain('modbus');
  });

  it('is healthy when the inverter confirms the commanded setpoint', () => {
    const v = controlStrip(status({}), NOW)!;
    expect(v.state).toBe('healthy');
    expect(v.tone).toBe('ok');
    expect(v.sentence).toContain('bestätigt');
    expect(v.sentence).toContain('4,0');
    expect(v.agoNote).toContain('geprüft');
  });

  it('flags a mismatch when the read-back differs from the command', () => {
    const v = controlStrip(status({ allMatch: false, confirmedKw: -1.2, mismatchRoles: 'battery_power' }), NOW)!;
    expect(v.state).toBe('mismatch');
    expect(v.tone).toBe('warn');
    expect(v.sentence).toContain('meldet');
    expect(v.sentence).toContain('1,2');
    expect(v.agoNote).toContain('Abweichung');
  });

  it('goes stale when the last confirmation is older than the window', () => {
    const old = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    const v = controlStrip(status({ checkedAt: old }), NOW)!;
    expect(v.state).toBe('stale');
    expect(v.tone).toBe('off');
    expect(v.agoNote).toContain('zuletzt geprüft');
  });

  it('reads as off (Not-Aus) when control is disabled - calm, no euro/register jargon', () => {
    const v = controlStrip(status({ controlEnabled: false }), NOW)!;
    expect(v.state).toBe('off');
    expect(v.sentence).toContain('ausgeschaltet');
    expect(v.sentence).not.toMatch(/register|modbus|kill/i);
  });

  it('reads as pending when the model is not yet certified for control', () => {
    const v = controlStrip(status({ certified: false, controlEnabled: true }), NOW)!;
    expect(v.state).toBe('pending');
    expect(v.sentence).toContain('noch nicht freigegeben');
  });

  it('never leaks internal vocabulary into any state', () => {
    for (const over of [{}, { allMatch: false }, { controlEnabled: false }, { certified: false }]) {
      const v = controlStrip(status(over), NOW)!;
      expect(v.sentence).not.toMatch(/register|modbus|kill-switch|readback/i);
    }
  });
});
