import { describe, expect, it } from 'vitest';
import {
  DEVICE_ID_FIELD,
  DEVICE_ID_UNKNOWN_MSG,
  FLOW_STEPS,
  initialFlowStep,
  normalizeDeviceIdInput,
  parseBatteryForm,
  parseDecimal,
  zoneForCountry,
} from './anlageFlow';

describe('the one "Anlage anlegen" flow (captain decision 5)', () => {
  it('has exactly the three captain-decided steps, Anlage first', () => {
    expect(FLOW_STEPS).toEqual(['Anlage', 'Gerät', 'Speicher']);
  });

  it('starts fresh customers at the Anlage step', () => {
    expect(initialFlowStep(false)).toBe(1);
  });

  it('resumes a customer who already created an Anlage at the Gerät step', () => {
    expect(initialFlowStep(true)).toBe(2);
  });
});

describe('zoneForCountry (bidding zone derived from the address, no jargon in the UI)', () => {
  it('maps DACH countries and defaults everything else to DE-LU', () => {
    expect(zoneForCountry('DE')).toBe('DE-LU');
    expect(zoneForCountry('at')).toBe('AT');
    expect(zoneForCountry('CH')).toBe('CH');
    expect(zoneForCountry('FR')).toBe('DE-LU');
    expect(zoneForCountry(null)).toBe('DE-LU');
    expect(zoneForCountry(undefined)).toBe('DE-LU');
  });
});

describe('normalizeDeviceIdInput (mirrors the api claim canonicalization as you type)', () => {
  it('uppercases sticker IDs', () => {
    expect(normalizeDeviceIdInput('vp-demo-0001')).toBe('VP-DEMO-0001');
  });

  it('lowercases self-generated edge references (mobile autoCapitalize)', () => {
    expect(normalizeDeviceIdInput('Edge-K7M2XQP')).toBe('edge-k7m2xqp');
  });

  it('leaves other refs alone', () => {
    expect(normalizeDeviceIdInput('demo-inverter-01')).toBe('demo-inverter-01');
  });
});

describe('parseDecimal (German comma accepted)', () => {
  it('parses plain and comma decimals', () => {
    expect(parseDecimal('10')).toBe(10);
    expect(parseDecimal('7,5')).toBe(7.5);
    expect(parseDecimal(' 12 ')).toBe(12);
  });

  it('is null for empty or garbage', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
  });
});

describe('parseBatteryForm (Speicher step, optional by design)', () => {
  it('accepts the three positive values incl. German commas', () => {
    const r = parseBatteryForm({ capacity: '10,5', maxCharge: '5', maxDischarge: '4,6' });
    expect(r).toEqual({
      ok: true,
      value: { capacityKwh: 10.5, maxChargeKw: 5, maxDischargeKw: 4.6 },
    });
  });

  it('never includes a deviceId - the claimed inverter auto-links backend-side', () => {
    const r = parseBatteryForm({ capacity: '10', maxCharge: '5', maxDischarge: '5' });
    expect(r.ok).toBe(true);
    if (r.ok) expect('deviceId' in r.value).toBe(false);
  });

  it.each([
    { capacity: '', maxCharge: '5', maxDischarge: '5' },
    { capacity: '0', maxCharge: '5', maxDischarge: '5' },
    { capacity: '10', maxCharge: '-1', maxDischarge: '5' },
    { capacity: '10', maxCharge: '5', maxDischarge: 'abc' },
  ])('refuses non-positive/garbage input with one German message (%o)', (input) => {
    const r = parseBatteryForm(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positive Zahlen/);
  });
});

describe('device-ID field copy (one voice across flow and Geräte drawer)', () => {
  it('speaks Anlage/Gerät language, never internal vocabulary', () => {
    const all = `${DEVICE_ID_FIELD.label} ${DEVICE_ID_FIELD.help} ${DEVICE_ID_UNKNOWN_MSG}`;
    expect(all).not.toMatch(/Standort/);
    expect(all).not.toMatch(/beanspruch/i);
    expect(all).not.toMatch(/Mandant/);
  });
});
