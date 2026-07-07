import { describe, expect, it } from 'vitest';
import { chargeKind, hasGridCharge, SLOT_DEADBAND_KW } from './schedule';

/**
 * Fahrplan slot-kind derivation: a charging slot that net-imports is a
 * grid-charge slot ("Laden aus dem Netz", türkis). On an EEG plan
 * (charge <= PV surplus enforced by the optimizer) that kind can never occur -
 * the chart legend must then not advertise the color.
 */
describe('chargeKind', () => {
  it('charging while net-importing is Netzladen (türkis)', () => {
    expect(chargeKind(4.0, 6.5)).toBe('netzladen');
  });

  it('charging while exporting or balanced is Solarladen (PV surplus)', () => {
    expect(chargeKind(4.0, -1.2)).toBe('solarladen');
    expect(chargeKind(4.0, 0)).toBe('solarladen');
    // Import inside the deadband is solver noise, not a grid charge.
    expect(chargeKind(4.0, SLOT_DEADBAND_KW)).toBe('solarladen');
  });

  it('negative battery power is Entladen regardless of grid direction', () => {
    expect(chargeKind(-3.0, 2.0)).toBe('entladen');
    expect(chargeKind(-3.0, -2.0)).toBe('entladen');
  });

  it('idle, deadband and unknown slots are Ruhe', () => {
    expect(chargeKind(0, 5.0)).toBe('ruhe');
    expect(chargeKind(SLOT_DEADBAND_KW, 5.0)).toBe('ruhe');
    expect(chargeKind(null, 5.0)).toBe('ruhe');
  });

  it('importing for the HOUSE while the battery rests is never Netzladen', () => {
    // High grid draw with an idle battery is normal consumption - only the
    // combination charging AND importing marks grid-fed storage.
    expect(chargeKind(0, 9.0)).toBe('ruhe');
  });
});

describe('hasGridCharge (legend gate)', () => {
  it('true as soon as one slot charges from the grid', () => {
    expect(
      hasGridCharge([
        { batteryKw: 2.0, gridKw: -1.0 },
        { batteryKw: 3.0, gridKw: 4.0 },
      ]),
    ).toBe(true);
  });

  it('false for an EEG-shaped plan (charging only while not importing)', () => {
    expect(
      hasGridCharge([
        { batteryKw: 2.0, gridKw: -1.0 },
        { batteryKw: -2.0, gridKw: 3.0 },
        { batteryKw: null, gridKw: null },
        { batteryKw: 0, gridKw: 2.0 },
      ]),
    ).toBe(false);
  });
});
