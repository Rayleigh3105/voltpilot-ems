import { describe, expect, it } from 'vitest';
import {
  coordFieldValue,
  isValidLat,
  isValidLon,
  LAT_ERROR,
  LON_ERROR,
  parseCoordInput,
  roundCoord,
  syncFromFields,
} from './geo';

describe('parseCoordInput', () => {
  it('treats an empty field as null (coordinates are optional)', () => {
    expect(parseCoordInput('')).toBeNull();
    expect(parseCoordInput('   ')).toBeNull();
  });
  it('accepts German comma and dot decimals', () => {
    expect(parseCoordInput('52,52')).toBeCloseTo(52.52);
    expect(parseCoordInput('13.405')).toBeCloseTo(13.405);
    expect(parseCoordInput('-9,5')).toBeCloseTo(-9.5);
  });
  it('returns NaN for an unparseable value', () => {
    expect(parseCoordInput('abc')).toBeNaN();
    expect(parseCoordInput('1,2,3')).toBeNaN();
  });
});

describe('roundCoord / coordFieldValue', () => {
  it('rounds a dragged coordinate to 5 decimals', () => {
    expect(roundCoord(52.5200349)).toBe(52.52003);
  });
  it('formats null as an empty field and a number as a dot-decimal string', () => {
    expect(coordFieldValue(null)).toBe('');
    expect(coordFieldValue(undefined)).toBe('');
    expect(coordFieldValue(52.52)).toBe('52.52');
  });
});

describe('isValidLat / isValidLon', () => {
  it('bounds latitude to [-90, 90] and longitude to [-180, 180]', () => {
    expect(isValidLat(90)).toBe(true);
    expect(isValidLat(-90)).toBe(true);
    expect(isValidLat(90.1)).toBe(false);
    expect(isValidLon(180)).toBe(true);
    expect(isValidLon(-181)).toBe(false);
  });
});

describe('syncFromFields (pin <-> manual field sync)', () => {
  it('propagates two valid coordinates with no errors', () => {
    const s = syncFromFields('52,52', '13,405');
    expect(s.ok).toBe(true);
    expect(s.lat).toBeCloseTo(52.52);
    expect(s.lon).toBeCloseTo(13.405);
    expect(s.latError).toBeNull();
    expect(s.lonError).toBeNull();
  });

  it('keeps empty fields as null and valid (location optional)', () => {
    const s = syncFromFields('', '');
    expect(s.ok).toBe(true);
    expect(s.lat).toBeNull();
    expect(s.lon).toBeNull();
  });

  it('flags an out-of-range latitude and does not propagate it', () => {
    const s = syncFromFields('123', '13,405');
    expect(s.ok).toBe(false);
    expect(s.latError).toBe(LAT_ERROR);
    expect(s.lat).toBeNull();
    // The valid longitude is still parsed through.
    expect(s.lon).toBeCloseTo(13.405);
  });

  it('flags an unparseable longitude', () => {
    const s = syncFromFields('52,52', 'xx');
    expect(s.ok).toBe(false);
    expect(s.lonError).toBe(LON_ERROR);
    expect(s.lon).toBeNull();
  });
});
