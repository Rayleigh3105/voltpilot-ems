import { describe, expect, it } from 'vitest';
import { shortEntityLabel, shortLabelsForRole, stripParenthetical } from './entityLabel';

describe('stripParenthetical', () => {
  it('drops a trailing qualifier but keeps the name', () => {
    expect(stripParenthetical('Netzanschluss (Messung über Wechselrichter)')).toBe(
      'Netzanschluss',
    );
    expect(stripParenthetical('Wallbox Garage')).toBe('Wallbox Garage');
  });
});

describe('shortEntityLabel', () => {
  it('shortens the composed labels of a migrated hybrid plant', () => {
    // The four names that truncated on the real plant.
    expect(
      shortEntityLabel({
        entityType: 'battery-hybrid',
        role: 'storage',
        label: 'Batteriespeicher (Hybrid-Wechselrichter)',
      }),
    ).toBe('Batteriespeicher');
    expect(
      shortEntityLabel({
        entityType: 'grid-meter',
        role: 'grid',
        label: 'Netzanschluss (Messung über Wechselrichter)',
      }),
    ).toBe('Netz');
    expect(
      shortEntityLabel({
        entityType: 'house-load',
        role: 'consumer',
        label: 'Hausverbrauch (Messung über Wechselrichter)',
      }),
    ).toBe('Hausverbrauch');
    expect(
      shortEntityLabel({ entityType: 'producer', role: 'pv', label: 'PV-Erzeugung (Fronius)' }),
    ).toBe('Erzeuger');
  });

  it('names a hybrid per ASPECT - its pv side is an Erzeuger', () => {
    const hybrid = {
      entityType: 'battery-hybrid',
      label: 'Batteriespeicher (Hybrid-Wechselrichter)',
    };
    expect(shortEntityLabel({ ...hybrid, role: 'pv' })).toBe('Erzeuger');
    expect(shortEntityLabel({ ...hybrid, role: 'storage' })).toBe('Batteriespeicher');
  });

  it('uses the TYPE word for consumers', () => {
    expect(shortEntityLabel({ entityType: 'wallbox', role: 'consumer' })).toBe('Wallbox');
    expect(shortEntityLabel({ entityType: 'heating-rod', role: 'consumer' })).toBe('Heizstab');
    expect(shortEntityLabel({ entityType: 'generic-load', role: 'consumer' })).toBe('Verbraucher');
  });

  it('every derived label is short enough for a flow-diagram line', () => {
    const cases: Array<[string, 'pv' | 'storage' | 'grid' | 'consumer']> = [
      ['producer', 'pv'],
      ['battery-hybrid', 'storage'],
      ['grid-meter', 'grid'],
      ['house-load', 'consumer'],
      ['wallbox', 'consumer'],
      ['heating-rod', 'consumer'],
    ];
    for (const [entityType, role] of cases) {
      expect(shortEntityLabel({ entityType, role }).length).toBeLessThanOrEqual(16);
    }
  });

  it('falls back honestly for an unknown type without a role', () => {
    expect(shortEntityLabel({ entityType: 'exotic-thing', label: 'Sondermessung (Keller)' })).toBe(
      'Sondermessung',
    );
    expect(shortEntityLabel({ entityType: 'exotic-thing', typeLabel: 'Sonstiges' })).toBe(
      'Sonstiges',
    );
    expect(shortEntityLabel({})).toBe('Gerät');
  });

  it('never returns a stored label when role/type resolve it', () => {
    expect(shortEntityLabel({ entityType: 'grid-meter', role: 'grid', label: 'ZZZ' })).toBe('Netz');
  });
});

describe('shortLabelsForRole', () => {
  it('leaves distinct short words alone', () => {
    expect(
      shortLabelsForRole(
        [
          { entityType: 'wallbox', label: 'Wallbox (go-e)' },
          { entityType: 'heating-rod', label: 'Heizstab (Keller)' },
        ],
        'consumer',
      ),
    ).toEqual(['Wallbox', 'Heizstab']);
  });

  it('keeps two same-type devices apart via their own compact names', () => {
    expect(
      shortLabelsForRole(
        [
          { entityType: 'producer', label: 'Deye (Ost)' },
          { entityType: 'producer', label: 'Fronius WR 2' },
        ],
        'pv',
      ),
    ).toEqual(['Deye', 'Fronius WR 2']);
  });

  it('falls back to the short word when the own name is itself too long', () => {
    expect(
      shortLabelsForRole(
        [
          { entityType: 'producer', label: 'PV-Erzeugung Dachfläche Nordwest komplett' },
          { entityType: 'producer', label: 'Fronius' },
        ],
        'pv',
      ),
    ).toEqual(['Erzeuger', 'Fronius']);
  });
});
