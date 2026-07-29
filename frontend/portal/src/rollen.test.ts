import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityLocalSetup, SiteTopology } from './api';
import * as auth from './auth';
import {
  ROLE_ORDER,
  adoptableSources,
  adoptedSources,
  assignToRole,
  assignableCapabilities,
  inverterSetup,
  isAutoAssigned,
  resetAssignments,
  roleBoxes,
  rolePillsFor,
  setPrimaryAssignment,
  showTechnicalLayer,
  sourceRoleLabel,
  sourceSummary,
  suggestEntityType,
} from './rollen';

/** A hybrid (PV + Speicher) + a producer (PV) + a grid meter, with values. */
function topology(): SiteTopology {
  return {
    schemaVersion: '1.0',
    entities: [
      {
        id: 'battery',
        entityType: 'battery-hybrid',
        typeLabel: 'Batteriespeicher (Hybrid)',
        label: 'Hybrid-Wechselrichter',
        category: 'storage',
        health: 'ok',
        capabilities: [
          { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 62.5 },
          { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: true, value: 12.4 },
          { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: true, value: 18.9 },
        ],
      },
      {
        id: 'producer',
        entityType: 'producer',
        typeLabel: 'Erzeuger (PV)',
        label: 'AC-PV Nord',
        category: 'producer',
        health: 'ok',
        capabilities: [
          { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 44.2 },
        ],
      },
      {
        id: 'grid',
        entityType: 'grid-meter',
        typeLabel: 'Netzanschlusszähler',
        label: 'Netzanschluss',
        category: 'meter',
        health: 'ok',
        capabilities: [
          { channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -49.7 },
        ],
      },
    ],
    topology: {
      schema_version: '1.0',
      nodes: [
        {
          role: 'pv',
          value_kw: 63.1,
          flow_active: true,
          direction: 'in',
          members: [],
        },
        {
          role: 'storage',
          value_kw: 12.4,
          soc_pct: 62.5,
          flow_active: true,
          direction: 'out',
          members: [],
        },
        {
          role: 'grid',
          value_kw: 49.7,
          flow_active: true,
          direction: 'out',
          members: [],
        },
      ],
    },
  };
}

describe('roleBoxes', () => {
  it('groups capabilities into role boxes with Σ, SoC and direction from the hub', () => {
    const boxes = roleBoxes(topology());
    expect(boxes.map((b) => b.role)).toEqual(['pv', 'storage', 'grid']);

    const pv = boxes.find((b) => b.role === 'pv')!;
    expect(pv.label).toBe('PV-Erzeugung');
    expect(pv.sumKw).toBe(63.1);
    expect(pv.direction).toBe('in');
    expect(pv.members).toHaveLength(2); // hybrid pv + producer pv

    const storage = boxes.find((b) => b.role === 'storage')!;
    expect(storage.socPct).toBe(62.5);
    expect(storage.members.find((m) => m.isSoc)?.value).toBe(62.5);

    const grid = boxes.find((b) => b.role === 'grid')!;
    expect(grid.members).toHaveLength(1);
    expect(grid.members[0].primary).toBe(true); // maßgeblich
  });

  // G5: the Speicher box carried the SAME device name twice (its Ladestand and
  // its Batterieleistung) and read as a duplicate. The measurement name is what
  // tells them apart - and only where it is actually needed.
  it('names the measurement when one device feeds a role twice, and only then', () => {
    const boxes = roleBoxes(topology());

    const storage = boxes.find((b) => b.role === 'storage')!;
    expect(storage.members).toHaveLength(2);
    expect(storage.members.every((m) => m.entityLabel === 'Hybrid-Wechselrichter')).toBe(true);
    expect(storage.members.every((m) => m.needsChannelLabel)).toBe(true);
    expect(storage.members.map((m) => m.channelLabel).sort()).toEqual([
      'Batterieleistung',
      'Ladestand',
    ]);

    // PV has two members, but from two DIFFERENT devices - their names already
    // differ, so the box stays calm.
    const pv = boxes.find((b) => b.role === 'pv')!;
    expect(pv.members.map((m) => m.needsChannelLabel)).toEqual([false, false]);

    const grid = boxes.find((b) => b.role === 'grid')!;
    expect(grid.members[0].needsChannelLabel).toBe(false);
  });

  it('omits roles with no members (no empty Verbraucher box)', () => {
    expect(roleBoxes(topology()).some((b) => b.role === 'consumer')).toBe(false);
  });
});

describe('rolePillsFor', () => {
  it('shows several roles for a hybrid, one for a producer, with primary flags', () => {
    const t = topology();
    const battery = rolePillsFor('battery', t);
    expect(battery.map((p) => p.role)).toEqual(['pv', 'storage']);
    expect(battery.every((p) => p.primary)).toBe(true);

    const producer = rolePillsFor('producer', t);
    expect(producer.map((p) => p.role)).toEqual(['pv']);
    expect(producer[0].primary).toBe(false);
  });

  it('returns nothing for an unknown entity', () => {
    expect(rolePillsFor('nope', topology())).toEqual([]);
  });
});

describe('isAutoAssigned', () => {
  it('true when every capability resolves to its default role', () => {
    expect(isAutoAssigned(topology())).toBe(true);
  });

  it('false when a capability was re-assigned away from its default', () => {
    const t = topology();
    t.entities[1].capabilities[0].role = 'consumer'; // producer PV -> consumer override
    expect(isAutoAssigned(t)).toBe(false);
  });
});

describe('assignableCapabilities', () => {
  it('lists capabilities not already in the target role, excluding SoC', () => {
    const caps = assignableCapabilities(topology(), 'consumer');
    // everything except the two SoC exclusions and none is currently consumer
    expect(caps.some((c) => c.channel === 'soc_pct')).toBe(false);
    expect(caps.find((c) => c.entityId === 'grid')?.currentRole).toBe('grid');
    expect(caps).toHaveLength(4); // hybrid pv, hybrid battery_power, producer pv, grid power
  });
});

describe('assignment payloads', () => {
  it('assignToRole / setPrimary / reset build the PUT bodies', () => {
    expect(assignToRole('e1', 'power_kw', 'grid')).toEqual([
      { entityId: 'e1', channel: 'power_kw', role: 'grid', primary: false },
    ]);
    expect(setPrimaryAssignment('e1', 'power_kw', 'grid')).toEqual([
      { entityId: 'e1', channel: 'power_kw', role: 'grid', primary: true },
    ]);
    const reset = resetAssignments(topology());
    expect(reset).toHaveLength(5); // 3 + 1 + 1 capabilities
    expect(reset.every((a) => a.role === '')).toBe(true);
  });
});

describe('adoption suggestions', () => {
  it('suggests a catalog type from the reported role + brand', () => {
    expect(suggestEntityType('pv-generation', null)).toBe('producer');
    expect(suggestEntityType('grid-meter', null)).toBe('grid-meter');
    expect(suggestEntityType('consumer', 'go-e')).toBe('wallbox');
    expect(suggestEntityType('consumer', 'Irgendwas')).toBe('generic-load');
    expect(suggestEntityType(null, null)).toBeNull();
  });

  it('roleLabel + summary render the report line', () => {
    expect(sourceRoleLabel('consumer')).toBe('Verbraucher');
    expect(sourceRoleLabel(null)).toBe('Energiequelle');
    // The summary is the ONE deviceName chain: the operator-given name wins …
    expect(sourceSummary(src('goe-1', 'source', 'consumer', 'go-e', 'Wallbox Carport'))).toBe(
      'Wallbox Carport',
    );
    // … without one it is brand + model, never a raw "brand · label" join, and
    // a transport-suffixed catalog brand reads as its customer brand.
    expect(
      sourceSummary({
        ...src('goe-2', 'source', 'consumer', 'go-e', null),
        model: 'Charger 3',
      }),
    ).toBe('go-e Charger 3');
    expect(
      sourceSummary({
        ...src('pv-1', 'source', 'pv-generation', 'fronius_sunspec', null),
        model: 'Eco 27',
      }),
    ).toBe('Fronius Eco 27');
    expect(sourceSummary(src('x', 'source', 'consumer', null, null))).toBe('x');
  });

  it('partitions local setup into adoptable, adopted and inverter', () => {
    const setup: EntityLocalSetup[] = [
      src('inv', 'inverter', null, 'deye', 'SUN-12K'),
      src('goe-1', 'source', 'consumer', 'go-e', 'Charger 3'),
      { ...src('pv-2', 'source', 'pv-generation', 'Fronius', 'Eco'), adoptedEntityId: 'ent-9' },
    ];
    const adoptable = adoptableSources(setup);
    expect(adoptable.map((s) => s.id)).toEqual(['goe-1']);
    expect(adoptable[0].suggestedType).toBe('wallbox');
    expect(adoptable[0].roleLabel).toBe('Verbraucher');
    expect(adoptedSources(setup).map((s) => s.id)).toEqual(['pv-2']);
    expect(inverterSetup(setup).map((s) => s.id)).toEqual(['inv']);
  });
});

it('ROLE_ORDER is the canonical four', () => {
  expect(ROLE_ORDER).toEqual(['pv', 'storage', 'grid', 'consumer']);
});

/**
 * M7: the ONE technical-layer decision. Today it is exactly `isPlatformAdmin()`;
 * a future installer role plugs in here and nowhere else.
 */
describe('showTechnicalLayer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is closed for a customer (no platform-admin role)', () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    expect(showTechnicalLayer()).toBe(false);
  });

  it('is open for a platform-admin', () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    expect(showTechnicalLayer()).toBe(true);
  });

  it('defaults closed without any token (the customer default)', () => {
    // No keycloak token in the test env -> isPlatformAdmin() is false.
    expect(showTechnicalLayer()).toBe(false);
  });
});

function src(
  id: string,
  kind: string,
  role: string | null,
  brand: string | null,
  label: string | null,
): EntityLocalSetup {
  return { id, kind, role, brand, label, reportedAt: '2026-07-20T10:00:00Z', adoptedEntityId: null };
}
