import { describe, expect, it } from 'vitest';
import {
  componentLabel,
  componentRole,
  deviceSummary,
  newlyReported,
  plantModel,
  toComponentHealth,
  type ComponentRole,
} from './komponenten';
import type { EntityLocalSetup, SiteEntity, SiteTopology } from './api';

/** A minimal v2 entity for the model derivation. */
function entity(
  id: string,
  entityType: string,
  overrides: Partial<SiteEntity> = {},
): SiteEntity {
  return {
    id,
    entityType,
    typeLabel: entityType,
    role: entityType,
    label: null,
    control: false,
    deviceId: 'gw',
    capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
    guards: null,
    syncStatus: 'in_sync',
    observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
    edgeSourceId: null,
    ...overrides,
  };
}

function source(
  id: string,
  role: string | null,
  overrides: Partial<EntityLocalSetup> = {},
): EntityLocalSetup {
  return {
    id,
    kind: 'source',
    role,
    brand: null,
    label: null,
    reportedAt: '',
    adoptedEntityId: null,
    ...overrides,
  };
}

function inverter(id: string, brand: string, label: string | null = null): EntityLocalSetup {
  return { id, kind: 'inverter', role: null, brand, label, reportedAt: '', adoptedEntityId: null };
}

/** The forbidden customer words (D3): they must not appear in ANY produced label. */
const FORBIDDEN = /Entität|Messpunkt|Quelle|Mess-Einheit|Kanal/i;

function allStrings(model: ReturnType<typeof plantModel>): string[] {
  const out: string[] = [];
  for (const d of model.devices) out.push(d.label, d.summary);
  for (const c of model.components) {
    out.push(c.label, c.summary, ...c.channels.map((ch) => ch.label));
  }
  for (const n of model.newlyReported) out.push(n.roleLabel, n.summary);
  for (const e of model.effects) out.push(e.title, e.summary);
  return out.filter((s) => s.length > 0);
}

describe('componentRole', () => {
  it('maps the pilot/composed types to their customer bucket', () => {
    const cases: [string, string | null, ComponentRole][] = [
      ['battery-hybrid', null, 'storage'],
      ['producer', null, 'pv'],
      ['grid-meter', null, 'grid'],
      ['house-load', null, 'house'],
      ['wallbox', 'consumer', 'consumer'],
      ['heating-rod', 'consumer', 'consumer'],
      ['modbus-generic', 'meter', 'grid'],
    ];
    for (const [type, cat, role] of cases) {
      expect(componentRole(type, cat)).toBe(role);
    }
  });

  it('falls back to the category when the type is unknown', () => {
    expect(componentRole('mystery', 'storage')).toBe('storage');
    expect(componentRole('mystery', 'producer')).toBe('pv');
    expect(componentRole('mystery', null)).toBe('consumer');
  });
});

describe('componentLabel', () => {
  it('prefers the own label, else a role default, and keeps a consumer type name', () => {
    expect(componentLabel('PV-Dach Süd', 'pv', 'Producer')).toBe('PV-Dach Süd');
    expect(componentLabel('  ', 'storage', 'Batteriespeicher')).toBe('Speicher');
    expect(componentLabel(null, 'consumer', 'Wallbox')).toBe('Wallbox');
    expect(componentLabel(null, 'house', 'House Load')).toBe('Haus');
  });
});

describe('plantModel - hybrid only', () => {
  const entities = [
    entity('batt', 'battery-hybrid', {
      label: 'Batteriespeicher',
      control: true,
      capabilities: {
        measure: [
          { channel: 'pv_power_kw', unit: 'kW' },
          { channel: 'battery_power_kw', unit: 'kW' },
          { channel: 'soc_pct', unit: '%' },
        ],
      },
    }),
  ];
  const localSetup = [inverter('inv', 'deye', 'SUN-12K')];

  it('the inverter feeds the single Speicher component', () => {
    const m = plantModel(entities, null, localSetup);
    expect(m.components.map((c) => c.role)).toEqual(['storage']);
    expect(m.devices).toHaveLength(1);
    const inv = m.devices[0];
    expect(inv.label).toBe('SUN-12K');
    expect(inv.componentIds).toEqual(['batt']);
    expect(inv.messwertCount).toBe(3);
    expect(inv.summary).toBe('verbunden · liefert 3 Messwerte');
    expect(m.components[0].deviceIds).toEqual(['inv']);
    expect(m.components[0].control).toBe(true);
  });

  it('produces no forbidden customer words', () => {
    expect(allStrings(plantModel(entities, null, localSetup)).some((s) => FORBIDDEN.test(s))).toBe(
      false,
    );
  });
});

describe('plantModel - hybrid + a second producer', () => {
  const entities = [
    entity('batt', 'battery-hybrid', { label: 'Speicher', control: true }),
    entity('pv2', 'producer', {
      label: 'PV-Dach Ost',
      deviceId: 'gw',
      edgeSourceId: 'fro-2',
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
    }),
  ];
  const localSetup = [
    inverter('inv', 'deye', 'SUN-12K'),
    source('fro-2', 'pv-generation', { brand: 'Fronius', label: 'WR 2', adoptedEntityId: 'pv2' }),
  ];

  it('maps the adopted producer to its own device and the hybrid to the inverter', () => {
    const m = plantModel(entities, null, localSetup);
    expect(m.components.map((c) => [c.id, c.role])).toEqual([
      ['batt', 'storage'],
      ['pv2', 'pv'],
    ]);
    const inv = m.devices.find((d) => d.id === 'inv')!;
    const fro = m.devices.find((d) => d.id === 'fro-2')!;
    expect(inv.componentIds).toEqual(['batt']);
    expect(fro.componentIds).toEqual(['pv2']);
    expect(fro.label).toBe('WR 2');
    // The producer component points back at its own device.
    expect(m.components.find((c) => c.id === 'pv2')!.deviceIds).toEqual(['fro-2']);
  });
});

describe('plantModel - a wallbox (adopted consumer source)', () => {
  const entities = [
    entity('wb', 'wallbox', {
      label: 'Wallbox Carport',
      control: true,
      edgeSourceId: 'goe-1',
      observed: { health: 'stale', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
    }),
  ];
  const localSetup = [
    source('goe-1', 'consumer', { brand: 'go-e', label: 'Charger 3', adoptedEntityId: 'wb' }),
  ];

  it('feeds the wallbox and a silent device turns the Gesundheit card amber', () => {
    const m = plantModel(entities, null, localSetup);
    const dev = m.devices[0];
    expect(dev.componentIds).toEqual(['wb']);
    expect(dev.health).toBe('stale');
    expect(dev.summary).toBe('meldet gerade keine Daten · liefert 1 Messwert');
    const health = m.effects.find((e) => e.key === 'gesundheit')!;
    expect(health.tone).toBe('warn');
    expect(health.summary).toContain('Charger 3');
  });
});

describe('plantModel - a grid meter is maßgeblich when the topology says so', () => {
  const entities = [entity('grid', 'grid-meter', { label: 'Netz-Zähler', deviceId: 'gw' })];
  const localSetup = [inverter('inv', 'deye')];
  const topology: SiteTopology = {
    schemaVersion: '1.0',
    entities: [
      {
        id: 'grid',
        entityType: 'grid-meter',
        typeLabel: 'Netzanschlusszähler',
        label: 'Netz-Zähler',
        category: 'meter',
        health: 'ok',
        capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -2.1 }],
      },
    ],
    topology: { schema_version: '1.0', nodes: [] },
  };

  it('marks the primary grid component and names § 14a', () => {
    const m = plantModel(entities, topology, localSetup);
    const grid = m.components[0];
    expect(grid.role).toBe('grid');
    expect(grid.primary).toBe(true);
    expect(grid.summary).toContain('Maßgebliche Messung');
    expect(grid.summary).toContain('§ 14a');
  });
});

describe('plantModel - a device with no components (inverter reporting, no entity)', () => {
  it('renders the box with no measurements and a calm sub-line', () => {
    const m = plantModel([], null, [inverter('inv', 'deye', 'SUN-30K')]);
    expect(m.components).toHaveLength(0);
    expect(m.devices).toHaveLength(1);
    expect(m.devices[0].componentIds).toEqual([]);
    expect(m.devices[0].messwertCount).toBe(0);
    expect(m.devices[0].summary).toBe('verbunden');
  });
});

describe('newlyReported - the "Neues Gerät gefunden" set', () => {
  const localSetup = [
    inverter('inv', 'deye'),
    source('shelly', 'grid-meter', { brand: 'Shelly', label: '3EM' }), // unadopted
    source('goe-1', 'consumer', { brand: 'go-e', adoptedEntityId: 'wb' }), // already adopted
  ];

  it('lists only reported-but-unassigned sources with a customer-safe role word', () => {
    const list = newlyReported(localSetup, [entity('wb', 'wallbox', { edgeSourceId: 'goe-1' })]);
    expect(list.map((s) => s.id)).toEqual(['shelly']);
    expect(list[0].roleLabel).toBe('Netz-Zähler');
    // never "Energiequelle" / "Quelle"
    expect(list.some((s) => FORBIDDEN.test(s.roleLabel))).toBe(false);
  });

  it('drops a source already claimed by an entity edgeSourceId', () => {
    const ls = [source('x', 'consumer', { brand: 'go-e' })];
    expect(newlyReported(ls, [entity('e', 'wallbox', { edgeSourceId: 'x' })])).toHaveLength(0);
  });
});

describe('deviceSummary', () => {
  it('is honest about the state and the count', () => {
    expect(deviceSummary({ health: 'ok', messwertCount: 4 })).toBe('verbunden · liefert 4 Messwerte');
    expect(deviceSummary({ health: 'ok', messwertCount: 1 })).toBe('verbunden · liefert 1 Messwert');
    expect(deviceSummary({ health: 'stale', messwertCount: 0 })).toBe('meldet gerade keine Daten');
    expect(deviceSummary({ health: 'never', messwertCount: 2 })).toBe(
      'noch keine Daten · liefert 2 Messwerte',
    );
    // H2: an unreported device never reads „verbunden".
    expect(deviceSummary({ health: 'unknown', messwertCount: 3 })).toBe(
      'noch keine Rückmeldung · liefert 3 Messwerte',
    );
  });
});

describe('toComponentHealth — H2: health never fails OPEN', () => {
  it('only a literal ok is ok', () => {
    expect(toComponentHealth('ok')).toBe('ok');
    expect(toComponentHealth('stale')).toBe('stale');
    expect(toComponentHealth('never')).toBe('never');
  });

  it('anything unreported becomes `unknown`, NOT `ok`', () => {
    // On deploy day no edge sends the E1b heartbeat, so `observed` is null for
    // every component - and the old mapping painted every dot green while the
    // cockpit on the same plant said „Ihr Gerät meldet sich nicht".
    expect(toComponentHealth(undefined)).toBe('unknown');
    expect(toComponentHealth(null)).toBe('unknown');
    // the honest word the API itself returns
    expect(toComponentHealth('unreported')).toBe('unknown');
    // and any future word the portal does not know yet
    expect(toComponentHealth('degraded')).toBe('unknown');
  });

  it('an entity without an observed report renders a grey component', () => {
    const model = plantModel(
      [entity('e-batt', 'battery-hybrid', { observed: null })],
      null,
      [inverter('inv', 'deye')],
    );
    expect(model.components[0].health).toBe('unknown');
    expect(model.devices[0].health).toBe('unknown');
    expect(model.devices[0].summary).toContain('noch keine Rückmeldung');
  });
});
