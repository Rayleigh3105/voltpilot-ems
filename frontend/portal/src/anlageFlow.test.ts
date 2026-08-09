import { describe, expect, it } from 'vitest';
import {
  buildMastrApply,
  DEVICE_ID_FIELD,
  DEVICE_ID_UNKNOWN_MSG,
  FLOW_STEPS,
  STARTKLAR_SATZ,
  initialFlowStep,
  mastrLocationLabel,
  mastrPvSummary,
  mastrStorageSummary,
  normalizeDeviceIdInput,
  normalizeSeeNummer,
  parseBatteryForm,
  parseDecimal,
  pickStorageNumber,
  validateSeeNummer,
  zoneForCountry,
} from './anlageFlow';
import type { MastrPreview } from './api';
import { NBSP } from './format';

function pvPreview(overrides: Partial<MastrPreview> = {}): MastrPreview {
  return {
    mastrNummer: 'SEE900000012345',
    kind: 'pv',
    name: null,
    status: 'In Betrieb',
    plantType: null,
    powerKw: 9.8,
    inverterPowerKw: null,
    moduleCount: 24,
    azimuthLabel: 'Süd',
    azimuthDeg: 180,
    tiltLabel: '30°',
    tiltDeg: 30,
    commissionedOn: '2023',
    storageCapacityKwh: null,
    chargePowerKw: null,
    batteryTechnology: null,
    plz: '89551',
    ort: 'Königsbronn',
    linkedUnitNumber: 'SEE900000067890',
    warnings: [],
    ...overrides,
  };
}

function storagePreview(overrides: Partial<MastrPreview> = {}): MastrPreview {
  return {
    mastrNummer: 'SEE900000067890',
    kind: 'storage',
    name: null,
    status: 'In Betrieb',
    plantType: null,
    powerKw: 5,
    inverterPowerKw: null,
    moduleCount: null,
    azimuthLabel: null,
    azimuthDeg: null,
    tiltLabel: null,
    tiltDeg: null,
    commissionedOn: '2023',
    storageCapacityKwh: 10,
    chargePowerKw: 5,
    batteryTechnology: 'Lithium',
    plz: null,
    ort: null,
    linkedUnitNumber: 'SEE900000012345',
    warnings: [],
    ...overrides,
  };
}

describe('the register-first "Anlage anlegen" flow (captain 2026-07-09)', () => {
  it('has exactly the four steps, Anlage -> Register -> Gerät -> Nutzung (AE5: device before the adaptive step)', () => {
    expect(FLOW_STEPS).toEqual(['Anlage', 'Register', 'Gerät', 'Nutzung']);
  });

  it('sagt die Schrittzahl ABGELEITET - die Copy kann nicht mehr veralten', () => {
    // Der behobene Fehler: „In drei Schritten" ueber VIER Schritt-Punkten,
    // seit AE5 den Nutzung-Schritt ergaenzte (Mobil-Umbau Stufe 4).
    expect(STARTKLAR_SATZ).toBe('In vier Schritten ist Ihre Anlage startklar.');
    expect(STARTKLAR_SATZ).toContain(
      ['null', 'einem', 'zwei', 'drei', 'vier', 'fünf', 'sechs'][FLOW_STEPS.length],
    );
  });

  it('starts fresh customers at the Anlage step', () => {
    expect(initialFlowStep(false)).toBe(1);
  });

  it('resumes a customer who already created an Anlage at the Register step', () => {
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

describe('parseBatteryForm (manual Speicher fallback, optional by design)', () => {
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

describe('validateSeeNummer (client-side SEE-number guard with friendly hints)', () => {
  it('accepts an empty field (optional) and a well-formed SEE number', () => {
    expect(validateSeeNummer('')).toBeNull();
    expect(validateSeeNummer('  SEE966831669444 ')).toBeNull();
    expect(validateSeeNummer('see966831669444')).toBeNull();
  });

  it.each([
    ['SES123456789012', /keine Einheit/],
    ['SSE123456789012', /Speicher-Anlage/],
    ['EEG123456789012', /EEG-Anlage/],
    ['ABR123456789012', /Betreibernummer/],
    ['SEE123', /beginnt mit SEE/],
  ])('flags the wrong prefix %s', (raw, msg) => {
    expect(validateSeeNummer(raw)).toMatch(msg);
  });
});

describe('normalizeSeeNummer', () => {
  it('strips whitespace and uppercases', () => {
    expect(normalizeSeeNummer('  see 9668 3166 9444 ')).toBe('SEE966831669444');
  });
});

describe('pickStorageNumber (auto-fill the linked storage number, captain decision 2)', () => {
  it('adopts the PV record linkedUnitNumber when the field is empty', () => {
    expect(pickStorageNumber(pvPreview(), '')).toEqual({
      number: 'SEE900000067890',
      autoFilled: true,
    });
  });

  it('prefers an explicitly typed storage number over the link', () => {
    expect(pickStorageNumber(pvPreview(), 'see900000099999')).toEqual({
      number: 'SEE900000099999',
      autoFilled: false,
    });
  });

  it('is null when there is neither an explicit number nor a link', () => {
    expect(pickStorageNumber(pvPreview({ linkedUnitNumber: null }), '')).toBeNull();
    expect(pickStorageNumber(null, '')).toBeNull();
  });
});

describe('buildMastrApply (maps confirmed previews onto the apply payload)', () => {
  it('maps PV and storage onto their assets together', () => {
    const input = buildMastrApply([pvPreview(), storagePreview()]);
    expect(input.pv).toEqual({
      mastrNummer: 'SEE900000012345',
      capacityKwp: 9.8,
      moduleCount: 24,
      azimuthDeg: 180,
      tiltDeg: 30,
      commissionedOn: '2023',
    });
    expect(input.storage).toEqual({
      mastrNummer: 'SEE900000067890',
      capacityKwh: 10,
      maxChargeKw: 5,
      maxDischargeKw: 5,
      commissionedOn: '2023',
    });
  });

  it('maps PV alone when no storage was confirmed', () => {
    const input = buildMastrApply([pvPreview()]);
    expect(input.pv).toBeDefined();
    expect(input.storage).toBeUndefined();
  });
});

describe('MaStR summary + plausibility helpers (Fertig screen)', () => {
  it('summarizes PV and storage as one line each', () => {
    expect(mastrPvSummary(pvPreview())).toBe('9,80 kWp · Süd 30°');
    expect(mastrStorageSummary(storagePreview())).toBe('10,0 kWh · 5,00 kW · Lithium');
  });

  it('falls back to "aus dem Register" when the record is bare', () => {
    expect(mastrPvSummary(pvPreview({ powerKw: null, azimuthLabel: null, tiltLabel: null }))).toBe(
      'aus dem Register',
    );
  });

  it('reads the plz/ort plausibility label, null when absent', () => {
    expect(mastrLocationLabel(pvPreview())).toBe('89551 Königsbronn');
    expect(mastrLocationLabel(pvPreview({ plz: null, ort: null }))).toBeNull();
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
