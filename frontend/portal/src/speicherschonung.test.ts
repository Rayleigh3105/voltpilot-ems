import { describe, expect, it } from 'vitest';
import {
  presetOf,
  SPEICHERSCHONUNG_OPTIONS,
  speicherschonungLabel,
} from './speicherschonung';

describe('speicherschonung (FK4 presets)', () => {
  it('offers exactly the three presets with Ausgewogen recommended', () => {
    expect(SPEICHERSCHONUNG_OPTIONS.map((o) => o.value)).toEqual([
      'aggressiv',
      'ausgewogen',
      'schonend',
    ]);
    expect(SPEICHERSCHONUNG_OPTIONS.filter((o) => o.recommended).map((o) => o.value)).toEqual([
      'ausgewogen',
    ]);
    // Customer copy never leaks the raw ct/kWh numbers (admin-only detail).
    for (const o of SPEICHERSCHONUNG_OPTIONS) {
      expect(o.sentence).not.toMatch(/ct|kWh|€/);
    }
  });

  it('labels the effective preset, honestly naming an admin-configured custom value', () => {
    expect(speicherschonungLabel('aggressiv')).toBe('Aggressiv');
    expect(speicherschonungLabel('ausgewogen')).toBe('Ausgewogen (empfohlen)');
    expect(speicherschonungLabel('schonend')).toBe('Schonend');
    expect(speicherschonungLabel('individuell')).toBe(
      'Individuell (durch VoltPilot konfiguriert)',
    );
    // Null/unknown falls back like the server derives a stored NULL.
    expect(speicherschonungLabel(null)).toBe('Ausgewogen (empfohlen)');
    expect(speicherschonungLabel('unbekannt')).toBe('Ausgewogen (empfohlen)');
  });

  it('pre-selects only real presets in the editor (individuell selects nothing)', () => {
    expect(presetOf('schonend')).toBe('schonend');
    expect(presetOf('aggressiv')).toBe('aggressiv');
    expect(presetOf('individuell')).toBeNull();
    expect(presetOf(null)).toBeNull();
    expect(presetOf(undefined)).toBeNull();
  });
});
