import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMastrApply,
  DEVICE_ID_FIELD,
  DEVICE_ID_UNKNOWN_MSG,
  FLOW_STEPS,
  STARTKLAR_SATZ,
  mastrLocationLabel,
  normalizeDeviceIdInput,
  normalizeSeeNummer,
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

describe('der Anlege-Fluss (Anlage-Flow a1, Konzept §5.3)', () => {
  it('hat drei feste Schritte - Adresse, Box, Anlage; „Register“ und „Betrieb“ sind keine Schritte mehr (R4, D6)', () => {
    expect(FLOW_STEPS).toEqual(['Adresse', 'Box', 'Anlage']);
  });

  it('sagt die Schrittzahl ABGELEITET - die Copy kann nicht mehr veralten', () => {
    expect(STARTKLAR_SATZ).toBe('In drei Schritten ist Ihre Anlage startklar.');
    expect(STARTKLAR_SATZ).toContain(
      ['null', 'einem', 'zwei', 'drei', 'vier', 'fünf', 'sechs'][FLOW_STEPS.length],
    );
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
    expect(normalizeDeviceIdInput('Edge-K7M2XQ3')).toBe('edge-k7m2xq3');
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

describe('MaStR plausibility helper („Aus dem Register holen“)', () => {
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

  // The example must be a reference the api ACCEPTS: "edge-" + six body
  // characters + the check character of refCheckChar (edge-app/core/internal/
  // agent/agent.go) / EdgeRef.isValid - a wrong one is rejected with 422.
  it('shows an example reference with a valid check character', () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const ref = /edge-[a-z0-9]{7}/.exec(DEVICE_ID_FIELD.placeholder)?.[0] ?? '';
    const body = ref.slice(5, 11);
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum += (i + 1) * alphabet.indexOf(body[i]);
    expect(ref).toHaveLength(12);
    expect(ref[11]).toBe(alphabet[sum % alphabet.length]);
  });

  // The help names the box web app's REAL path to the reference, in the
  // box's own words - no menu entry the box does not have.
  it('points to the labels the box web app really shows', () => {
    const box = readFileSync(
      join(process.cwd(), '../../edge-app/core/internal/web/static/einrichten.html'),
      'utf8',
    );
    for (const label of ['Einrichten', 'Kopplung mit dem VoltPilot-Portal', 'Referenz-ID dieses Geräts']) {
      expect(DEVICE_ID_FIELD.help).toContain(`„${label}"`);
      expect(box).toContain(label);
    }
  });
});
