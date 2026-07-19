import { describe, expect, it } from 'vitest';
import {
  PROFILE_OPTIONS,
  autoStartSummary,
  creatableConsumerTypes,
  entitiesRecognisedSummary,
  entityGroupLabel,
  initialProfileChoice,
  overrideForChoice,
  profileChoiceChanged,
  profileLabel,
} from './adaptiveOnboarding';
import type { AutoStartOutcome, EntityTypeDef } from './entitiesApi';
import type { SiteEntity, SiteUsageProfile } from './api';

function profile(over: string | null, derived = 'private'): SiteUsageProfile {
  return {
    usageProfile: over ?? derived,
    derivedProfile: derived,
    override: over,
    emphasis: { money: 'minimal', peak: 'hidden', flow: 'prominent', devices: 'prominent' },
    signals: {
      hasStorage: true,
      hasPv: true,
      hasControllableConsumer: false,
      activeStrategyNodeTypes: [],
      plantKind: 'eigenverbrauch',
      hasLeistungspreis: false,
    },
  };
}

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

describe('PROFILE_OPTIONS (AE5 profile choice)', () => {
  it('offers auto first, then the three profiles', () => {
    expect(PROFILE_OPTIONS.map((o) => o.value)).toEqual(['auto', 'arbitrage', 'peak', 'private']);
  });

  it('never leaks internal vocabulary in the copy', () => {
    const text = PROFILE_OPTIONS.map((o) => `${o.label} ${o.sentence}`).join(' ');
    expect(text).not.toMatch(/MILP|optimizer|Modul|RLS|Keycloak|Flow-Node|Node-RED|profile/i);
  });
});

describe('initialProfileChoice / overrideForChoice', () => {
  it('is "auto" when no override is stored', () => {
    expect(initialProfileChoice(profile(null))).toBe('auto');
    expect(initialProfileChoice(null)).toBe('auto');
  });

  it('is the stored override when set', () => {
    expect(initialProfileChoice(profile('arbitrage'))).toBe('arbitrage');
    expect(initialProfileChoice(profile('peak'))).toBe('peak');
  });

  it('treats a garbage override as auto (fail-safe)', () => {
    expect(initialProfileChoice(profile('bogus'))).toBe('auto');
  });

  it('maps a choice onto the PUT override (auto -> null)', () => {
    expect(overrideForChoice('auto')).toBeNull();
    expect(overrideForChoice('arbitrage')).toBe('arbitrage');
    expect(overrideForChoice('private')).toBe('private');
  });
});

describe('profileChoiceChanged (write only on a real change)', () => {
  it('is false when the choice equals the stored state', () => {
    expect(profileChoiceChanged('auto', profile(null))).toBe(false);
    expect(profileChoiceChanged('peak', profile('peak'))).toBe(false);
  });

  it('is true when the customer picks something different', () => {
    expect(profileChoiceChanged('arbitrage', profile(null))).toBe(true); // auto -> arbitrage
    expect(profileChoiceChanged('auto', profile('peak'))).toBe(true); // peak -> auto (clear)
  });
});

describe('profileLabel', () => {
  it('gives a plain German label per profile, private as the fallback', () => {
    expect(profileLabel('arbitrage')).toBe('Markterlös');
    expect(profileLabel('peak')).toBe('Lastspitzen');
    expect(profileLabel('private')).toBe('Eigenverbrauch');
    expect(profileLabel(null)).toBe('Eigenverbrauch');
  });
});

describe('autoStartSummary', () => {
  const created: AutoStartOutcome = {
    created: true,
    reason: null,
    profile: 'arbitrage',
    flowId: 'f1',
    version: 1,
    name: 'Marktoptimierung',
    message: 'x',
  };

  it('names the seeded flow when one was created', () => {
    expect(autoStartSummary(created)).toContain('Marktoptimierung');
    expect(autoStartSummary(created)).toContain('Flow-Editor');
  });

  it('is honest and calm for the skip reasons', () => {
    expect(autoStartSummary({ ...created, created: false, name: null, reason: 'already_has_flow' })).toMatch(
      /bereits ein Flow/,
    );
    expect(autoStartSummary({ ...created, created: false, name: null, reason: 'no_battery' })).toMatch(
      /Speicher/,
    );
  });

  it('is null when there is nothing to say (no outcome / not_found)', () => {
    expect(autoStartSummary(null)).toBeNull();
    expect(autoStartSummary({ ...created, created: false, name: null, reason: 'not_found' })).toBeNull();
  });
});

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
