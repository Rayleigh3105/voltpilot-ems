import { describe, expect, it } from 'vitest';
import {
  creatableConsumerTypes,
  entitiesRecognisedSummary,
  entityGroupLabel,
} from './adaptiveOnboarding';
import type { EntityTypeDef } from './entitiesApi';
import type { SiteEntity } from './api';

function entity(role: string, over: Partial<SiteEntity> = {}): SiteEntity {
  return {
    id: `id-${role}-${over.label ?? ''}`,
    entityType: 'x',
    typeLabel: 'Typ',
    role,
    label: null,
    control: false,
    deviceId: null,
    capabilities: null,
    guards: null,
    syncStatus: 'in_sync',
    observed: null,
    ...over,
  };
}

describe('creatableConsumerTypes', () => {
  const catalog: EntityTypeDef[] = [
    { type: 'battery-hybrid', label: 'Speicher', category: 'storage', controllable: true, composed: true, default_failsafe: 'x' },
    { type: 'grid-meter', label: 'Netz', category: 'meter', controllable: false, composed: true, default_failsafe: 'x' },
    { type: 'wallbox', label: 'Wallbox', category: 'consumer', controllable: true, composed: false, default_failsafe: 'x' },
    { type: 'heating-rod', label: 'Heizstab', category: 'consumer', controllable: true, composed: false, default_failsafe: 'x' },
    { type: 'generic-load', label: 'Verbraucher', category: 'consumer', controllable: true, composed: false, default_failsafe: 'x' },
  ];

  it('keeps only the non-composed consumer types (Wallbox/Heizstab/generisch)', () => {
    expect(creatableConsumerTypes(catalog).map((t) => t.type)).toEqual([
      'wallbox',
      'heating-rod',
      'generic-load',
    ]);
  });
});

describe('entityGroupLabel / entitiesRecognisedSummary', () => {
  it('groups entities by role in plain German', () => {
    expect(entityGroupLabel(entity('pv'))).toBe('Erzeuger');
    expect(entityGroupLabel(entity('storage'))).toBe('Speicher');
    expect(entityGroupLabel(entity('grid'))).toBe('Netz');
    expect(entityGroupLabel(entity('consumer'))).toBe('Verbraucher');
    expect(entityGroupLabel(entity('mystery', { typeLabel: 'Sonderling' }))).toBe('Sonderling');
  });

  it('summarises the recognised devices, or null when none', () => {
    expect(entitiesRecognisedSummary([])).toBeNull();
    const s = entitiesRecognisedSummary([entity('pv'), entity('storage'), entity('grid')]);
    expect(s).toBe('3 Geräte erkannt: Erzeuger, Speicher, Netz.');
    expect(entitiesRecognisedSummary([entity('storage')])).toBe('1 Gerät erkannt: Speicher.');
  });
});
