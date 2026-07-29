import { describe, expect, it } from 'vitest';
import {
  deviceName,
  shortEntityLabel,
  shortLabelsForRole,
  shortModel,
  stripParenthetical,
} from './entityLabel';

describe('shortModel', () => {
  it('shortens a model code to what a human says out loud', () => {
    expect(shortModel('SUN-30K-SG01HP3-EU')).toBe('SUN-30K');
    expect(shortModel('SUN-12K')).toBe('SUN-12K');
    expect(shortModel('Symo')).toBe('Symo');
    expect(shortModel('  ')).toBe('');
  });
});

describe('deviceName · ONE name per box', () => {
  it('prefers the name the device carries on the edge', () => {
    expect(deviceName({ edgeLabel: 'Fronius WR 2', brand: 'fronius', model: 'Symo' })).toBe(
      'Fronius WR 2',
    );
  });

  it('falls back to brand + SHORT model, brand properly cased', () => {
    expect(deviceName({ brand: 'deye', model: 'SUN-30K-SG01HP3-EU' })).toBe('Deye SUN-30K');
    expect(deviceName({ brand: 'Fronius' })).toBe('Fronius');
    // Transport-suffixed catalog brand tokens read as their customer brand -
    // a raw id like "fronius_sunspec" never surfaces (vp-vier-erzeuger-p9).
    expect(deviceName({ brand: 'fronius_sunspec', model: 'Eco 27' })).toBe('Fronius Eco 27');
    expect(deviceName({ brand: 'generic_modbus' })).toBe('Modbus-Gerät');
    expect(deviceName({ brand: 'go-e', model: 'Charger 3' })).toBe('go-e Charger 3');
  });

  it('then the stored label without its qualifier, then the type label', () => {
    expect(deviceName({ storedLabel: 'Batteriespeicher (Hybrid-Wechselrichter)' })).toBe(
      'Batteriespeicher',
    );
    expect(deviceName({ typeLabel: 'Erzeuger' })).toBe('Erzeuger');
  });

  it('returns null when nothing is nameable, so each caller keeps its own last resort', () => {
    expect(deviceName({})).toBeNull();
    expect(deviceName({ edgeLabel: '  ', brand: null, model: null })).toBeNull();
  });

  it('is the SAME derivation both surfaces use, so a box cannot read two ways', () => {
    // The defect: the flow said "Fronius WR1" while the breakdown said
    // "Fronius Anlage" for the same box - and the two were even crossed.
    const box = { edgeLabel: 'Fronius Anlage WR 2', brand: 'fronius', model: 'Symo' };
    expect(deviceName(box)).toBe(deviceName({ ...box }));
    expect(deviceName(box)).toBe('Fronius Anlage WR 2');
  });
});

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
