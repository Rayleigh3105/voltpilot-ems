import { describe, expect, it } from 'vitest';
import {
  componentLabel,
  componentRole,
  deviceState,
  deviceSummary,
  edgeBoxLine,
  MEASURED_VIA_INVERTER,
  newlyReported,
  plantHeadline,
  plantModel,
  reconnectCandidates,
  reconnectOffer,
  toComponentHealth,
  type ComponentRole,
  type PlantComponent,
} from './komponenten';
import type { AdoptableSource } from './rollen';
import type { Device, EntityLocalSetup, SiteEntity, SiteSource, SiteTopology } from './api';
import { NBSP } from './format';

function siteSource(sourceId: string, overrides: Partial<SiteSource> = {}): SiteSource {
  return {
    deviceId: 'gw',
    sourceId,
    kind: 'source',
    role: 'pv-generation',
    label: null,
    brand: null,
    model: null,
    pvKw: null,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: null,
    reportedAt: '',
    ...overrides,
  };
}

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
  const out: string[] = [model.headline.text];
  for (const d of model.devices) out.push(d.label, d.state, d.summary);
  for (const c of model.components) {
    out.push(c.label, c.summary, c.provenance ?? '', ...c.channels.map((ch) => ch.label));
  }
  for (const g of model.groups) out.push(g.label, g.headline ?? '', g.note ?? '');
  for (const n of model.newlyReported) out.push(n.roleLabel, n.summary);
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

  it('the inverter feeds the Speicher AND its own PV aspect', () => {
    const m = plantModel(entities, null, localSetup);
    // The composed backfill mints no producer for the modules hanging on the
    // inverter itself - without the PV aspect this plant would show NO PV.
    expect(m.components.map((c) => c.role)).toEqual(['storage', 'pv']);
    expect(m.components[1].id).toBe('batt#pv');
    expect(m.components[1].aspect).toBe('pv');
    expect(m.components[1].label).toBe('Solarmodule am SUN-12K');
    expect(m.devices).toHaveLength(1);
    const inv = m.devices[0];
    expect(inv.label).toBe('SUN-12K');
    expect(inv.componentIds).toEqual(['batt', 'batt#pv']);
    // Verbs, never Messwert counts (concept Teil 6).
    expect(inv.state).toBe('Liefert Daten');
    expect(inv.summary).toBe('Misst eigene PV und Speicher · steuert den Speicher');
    expect(inv.roles).toEqual(['pv', 'storage']);
    expect(m.components[0].deviceIds).toEqual(['inv']);
    expect(m.components[0].control).toBe(true);
    // Herkunft is a chip on every component, not a riddle.
    expect(m.components[0].provenance).toBe('gemessen über SUN-12K');
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

  it('feeds the wallbox and a silent device turns the Kopfsatz amber, naming it', () => {
    const m = plantModel(entities, null, localSetup);
    const dev = m.devices[0];
    expect(dev.componentIds).toEqual(['wb']);
    expect(dev.health).toBe('stale');
    expect(dev.state).toBe('Meldet sich gerade nicht');
    expect(dev.summary).toBe('Misst und steuert Wallbox Carport');
    expect(m.headline.tone).toBe('warn');
    expect(m.headline.text).toContain('Charger 3');
    expect(m.headline.text).toContain('meldet sich gerade nicht');
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

  it('marks the primary grid component and says what counts there', () => {
    const m = plantModel(entities, topology, localSetup);
    const grid = m.components[0];
    expect(grid.role).toBe('grid');
    expect(grid.primary).toBe(true);
    // § 14a itself moved into the row's InfoTip (concept Teil 6) - the line the
    // customer reads names the CONSEQUENCE, not the paragraph.
    expect(grid.summary).toBe('Maßgebliche Messung — hier zählen Bezug und Einspeisung');
  });

  it('shows the live value with a direction WORD, never a minus sign', () => {
    const m = plantModel(entities, topology, localSetup);
    // -2.1 kW at the connection point = Einspeisung; the sign never reaches the
    // customer (the portal-wide live.ts convention).
    expect(m.components[0].reading).toEqual({ value: 2.1, unit: 'kW', caption: 'Einspeisung' });
    const group = m.groups.find((g) => g.role === 'grid')!;
    expect(group.headline).toBe(`Einspeisung 2,1${NBSP}kW`);
    expect(group.note).toBeNull();
  });
});

describe('plantModel - a device with no components (inverter reporting, no entity)', () => {
  it('renders the box with a calm, honest sub-line', () => {
    const m = plantModel([], null, [inverter('inv', 'deye', 'SUN-30K')]);
    expect(m.components).toHaveLength(0);
    expect(m.devices).toHaveLength(1);
    expect(m.devices[0].componentIds).toEqual([]);
    expect(m.devices[0].state).toBe('Liefert Daten');
    expect(m.devices[0].summary).toBe('Noch keiner Komponente zugeordnet');
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

/** A bare component for the pure sub-line/headline units. */
function comp(role: PlantComponent['role'], overrides: Partial<PlantComponent> = {}): PlantComponent {
  return {
    id: `c-${role}`,
    entityId: `c-${role}`,
    aspect: 'main',
    label: role,
    role,
    summary: '',
    deviceIds: [],
    provenance: null,
    reading: null,
    channels: [],
    control: false,
    primary: false,
    health: 'ok',
    measuredVia: null,
    orphaned: false,
    ...overrides,
  };
}

describe('deviceState / deviceSummary — Klartext-Verben statt Zähl-Sprache', () => {
  it('names the state in words, and never reads „verbunden" when unreported', () => {
    expect(deviceState('ok')).toBe('Liefert Daten');
    expect(deviceState('stale')).toBe('Meldet sich gerade nicht');
    expect(deviceState('never')).toBe('Wartet auf die ersten Daten');
    // H2: an unreported device never reads green/„verbunden".
    expect(deviceState('unknown')).toBe('Noch keine Rückmeldung');
  });

  it('says what a device measures, never how many Messwerte it delivers', () => {
    expect(deviceSummary([comp('pv')])).toBe('Misst seine PV-Leistung');
    expect(deviceSummary([comp('grid')])).toBe('Misst den Netzanschluss');
    expect(deviceSummary([comp('storage', { control: true })])).toBe(
      'Misst und steuert den Speicher',
    );
    expect(
      deviceSummary([
        comp('grid'),
        comp('storage', { control: true, id: 's' }),
        comp('house', { id: 'h' }),
        comp('pv', { id: 'p' }),
      ]),
    ).toBe('Misst PV, Speicher, Netz und Haus · steuert den Speicher');
    // A hybrid measures only the modules on ITSELF, never the other inverters.
    expect(
      deviceSummary([comp('storage', { control: true }), comp('pv', { id: 'p', aspect: 'pv' })]),
    ).toBe('Misst eigene PV und Speicher · steuert den Speicher');
    expect(deviceSummary([])).toBe('Noch keiner Komponente zugeordnet');
  });
});

describe('plantHeadline — Job 1 in einem Satz', () => {
  it('counts what is shown and confirms when everything delivers', () => {
    const devices = [
      { id: 'a', label: 'Deye SUN-30K', brand: null, health: 'ok' as const, componentIds: [], roles: [], state: '', summary: '' },
    ];
    const h = plantHeadline(devices, [comp('storage'), comp('grid', { id: 'g' })]);
    expect(h.tone).toBe('ok');
    expect(h.text).toBe(
      'VoltPilot kennt Ihre Anlage als 2 Komponenten, gemessen von 1 Gerät — alle liefern Daten.',
    );
  });

  it('goes amber and NAMES the device that is not delivering', () => {
    const devices = [
      { id: 'a', label: 'Fronius WR2', brand: null, health: 'stale' as const, componentIds: [], roles: [], state: '', summary: '' },
    ];
    const h = plantHeadline(devices, [comp('pv')]);
    expect(h.tone).toBe('warn');
    expect(h.text).toContain('„Fronius WR2“');
    expect(h.text).toContain('meldet sich gerade nicht');
  });

  it('says so honestly when no device is reported at all', () => {
    const h = plantHeadline([], []);
    expect(h.tone).toBe('warn');
    expect(h.text).toContain('Noch kein Gerät gemeldet');
  });
});

describe('edgeBoxLine — die EINE VoltPilot-Box (Captain-Korrektur)', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  function device(overrides: Partial<Device> = {}): Device {
    return {
      id: 'd1',
      siteId: 's1',
      externalRef: 'VP-ABC123',
      kind: 'inverter',
      name: null,
      status: 'active',
      lastSeenAt: '2026-07-29T11:59:00Z',
      createdAt: null,
      ...overrides,
    };
  }

  it('names the ONE box and how many devices deliver through it', () => {
    const box = edgeBoxLine([device()], 3, now)!;
    expect(box.label).toBe('VoltPilot-Box VP-ABC123');
    expect(box.health).toBe('ok');
    expect(box.summary).toBe('Verbunden · empfängt Messwerte von 3 Geräten');
  });

  it('prefers the customer name and stays singular-correct for one device', () => {
    const box = edgeBoxLine([device({ name: 'Keller' })], 1, now)!;
    expect(box.label).toBe('VoltPilot-Box Keller');
    expect(box.summary).toBe('Verbunden · empfängt Messwerte von 1 Gerät');
  });

  it('is honest when the box itself is silent or has never reported', () => {
    expect(edgeBoxLine([device({ lastSeenAt: '2026-07-29T11:00:00Z' })], 2, now)!.summary).toContain(
      'Meldet sich gerade nicht',
    );
    expect(edgeBoxLine([device({ lastSeenAt: null })], 0, now)!.summary).toBe(
      'Wartet auf die ersten Daten · noch kein Gerät gemeldet',
    );
  });

  it('invents nothing without a claimed box, and never fakes a singular', () => {
    expect(edgeBoxLine([], 2, now)).toBeNull();
    expect(edgeBoxLine(null, 2, now)).toBeNull();
    expect(edgeBoxLine([device(), device({ id: 'd2', externalRef: 'VP-Z' })], 4, now)!.label).toBe(
      '2 VoltPilot-Boxen',
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
    expect(model.devices[0].state).toBe('Noch keine Rückmeldung');
  });
});

/** A minimal topology entity (its `health` is telemetry_v2 liveness). */
function topoEntity(id: string, entityType: string, category: string, health: string) {
  return { id, entityType, typeLabel: entityType, label: null, category, health, capabilities: [] };
}

describe('plantModel — F1: health from real data presence, not the edge echo', () => {
  it('takes the topology (telemetry_v2) liveness over a stale observed echo', () => {
    // The composed hybrid's edge `observed` is empty-by-construction (`never`)
    // on a migrated plant — but telemetry_v2 is current (topology `ok`).
    const entities = [
      entity('batt', 'battery-hybrid', {
        label: 'Batteriespeicher',
        observed: { health: 'never', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
      }),
    ];
    const topology: SiteTopology = {
      schemaVersion: '1.0',
      entities: [topoEntity('batt', 'battery-hybrid', 'storage', 'ok')],
      topology: { schema_version: '1.0', nodes: [] },
    };
    const m = plantModel(entities, topology, [inverter('inv', 'deye')]);
    // The false „noch keine Daten" is gone — the component reflects real data.
    expect(m.components[0].health).toBe('ok');
    expect(m.devices[0].health).toBe('ok');
    expect(m.devices[0].state).toBe('Liefert Daten');
  });

  it('a producer with no telemetry_v2 but /sources data reads "über den Wechselrichter gemessen"', () => {
    const entities = [
      entity('batt', 'battery-hybrid', { label: 'Speicher' }),
      entity('pv2', 'producer', {
        label: 'PV-Dach Ost',
        edgeSourceId: 'fro-2',
        observed: { health: 'never', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
        capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
      }),
    ];
    const topology: SiteTopology = {
      schemaVersion: '1.0',
      entities: [
        topoEntity('batt', 'battery-hybrid', 'storage', 'ok'),
        // A producer has no telemetry_v2 → topology liveness reads `never`.
        topoEntity('pv2', 'producer', 'producer', 'never'),
      ],
      topology: { schema_version: '1.0', nodes: [] },
    };
    const localSetup = [
      inverter('inv', 'deye'),
      source('fro-2', 'pv-generation', { brand: 'Fronius', label: 'Anlage', adoptedEntityId: 'pv2' }),
    ];
    const sources = [siteSource('fro-2', { pvKw: 19.9, health: 'ok', label: 'Fronius Anlage' })];
    const prod = plantModel(entities, topology, localSetup, sources).components.find((c) => c.id === 'pv2')!;
    // Delivering (via the inverter) → green, with the honest note, not „noch keine Daten".
    expect(prod.health).toBe('ok');
    expect(prod.measuredVia).toBe(MEASURED_VIA_INVERTER);
  });

  it('a producer with no reading stays honest (grey) but still names how it is measured', () => {
    const entities = [
      entity('batt', 'battery-hybrid', { label: 'Speicher' }),
      entity('pv2', 'producer', { label: 'PV Ost', edgeSourceId: 'fro-2' }),
    ];
    const topology: SiteTopology = {
      schemaVersion: '1.0',
      entities: [
        topoEntity('batt', 'battery-hybrid', 'storage', 'ok'),
        topoEntity('pv2', 'producer', 'producer', 'never'),
      ],
      topology: { schema_version: '1.0', nodes: [] },
    };
    const prod = plantModel(entities, topology, [inverter('inv', 'deye')], []).components.find(
      (c) => c.id === 'pv2',
    )!;
    expect(prod.health).toBe('never');
    expect(prod.measuredVia).toBe(MEASURED_VIA_INVERTER);
  });
});

// Variante A (vp-anlagenmodell-ux-w7): die Live-Werte sind der Kern. Erst mit
// Zahlen kann der Kunde prüfen „21,2 + 23,5 + 0,2 = 44,9 - stimmt". Deshalb ist
// die Gruppen-Summe per Konstruktion die Summe der GEZEIGTEN Zeilen, und eine
// Komponente ohne Wert wird gezählt statt als 0 gerechnet.
describe('plantModel — Rollen-Gruppen mit Live-Werten (Variante A)', () => {
  /** The captain's Pilsting plant: one hybrid + two Fronius behind ONE box. */
  function pilsting(sources: SiteSource[] | null) {
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
      entity('grid', 'grid-meter', { label: 'Netzanschluss' }),
      entity('haus', 'house-load', { label: 'Hausverbrauch' }),
      entity('fr1', 'producer', { label: 'Fronius Anlage', edgeSourceId: 'src-1' }),
      entity('fr2', 'producer', { label: 'Fronius Anlage WR2', edgeSourceId: 'src-2' }),
    ];
    const topology: SiteTopology = {
      schemaVersion: '1.0',
      entities: [
        {
          ...topoEntity('batt', 'battery-hybrid', 'storage', 'ok'),
          // MIG-B1 mirrors the COMPOSITE site PV onto the hybrid.
          capabilities: [
            { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 44.9 },
            { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: true, value: 9.3 },
            { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
          ],
        },
        {
          ...topoEntity('grid', 'grid-meter', 'meter', 'ok'),
          capabilities: [
            { channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -30 },
          ],
        },
        {
          ...topoEntity('haus', 'house-load', 'consumer', 'ok'),
          capabilities: [
            { channel: 'power_kw', unit: 'kW', role: 'consumer', primary: false, value: 5.5 },
          ],
        },
        topoEntity('fr1', 'producer', 'producer', 'never'),
        topoEntity('fr2', 'producer', 'producer', 'never'),
      ],
      topology: {
        schema_version: '1.0',
        nodes: [
          {
            role: 'pv',
            flow_active: true,
            members: [
              { entity_id: 'batt', label: 'Batteriespeicher', primary: false, value_kw: 44.9 },
              { entity_id: 'fr1', label: 'Fronius Anlage', primary: false },
              { entity_id: 'fr2', label: 'Fronius Anlage WR2', primary: false },
            ],
          },
        ],
      },
    };
    const localSetup = [
      inverter('inv', 'deye', null),
      source('src-1', 'pv-generation', {
        brand: 'fronius_sunspec',
        label: 'Fronius Anlage',
        adoptedEntityId: 'fr1',
      }),
      source('src-2', 'pv-generation', {
        brand: 'fronius_sunspec',
        label: 'Fronius Anlage WR2',
        adoptedEntityId: 'fr2',
      }),
    ];
    return plantModel(entities, topology, localSetup, sources);
  }

  it('splits the PV per device and the group Σ is exactly the sum of its rows', () => {
    const m = pilsting([
      siteSource('src-1', { pvKw: 21.2, health: 'ok', label: 'Fronius Anlage' }),
      siteSource('src-2', { pvKw: 23.5, health: 'ok', label: 'Fronius Anlage WR2' }),
    ]);
    const pv = m.groups.find((g) => g.role === 'pv')!;
    const values = pv.components.map((c) => c.reading?.value);
    // 21,2 + 23,5 + 0,2 = 44,9 - the number the customer checks the cockpit against.
    expect(values).toEqual([21.2, 23.5, 0.2]);
    expect(pv.headline).toBe(`Σ 44,9${NBSP}kW`);
    expect(pv.note).toBeNull();
    // The hybrid's own modules are a PV row of their own (aspect), else the
    // group would silently miss its share.
    expect(pv.components[2].id).toBe('batt#pv');
  });

  it('groups in canonical order with the storage headline on battery POWER', () => {
    const m = pilsting([]);
    expect(m.groups.map((g) => g.role)).toEqual(['pv', 'storage', 'grid', 'house']);
    const storage = m.groups.find((g) => g.role === 'storage')!;
    expect(storage.headline).toBe(`lädt 9,3${NBSP}kW`);
    // The ROW shows the state of charge (the concept's „76 % geladen").
    expect(storage.components[0].reading).toEqual({ value: 76, unit: '%', caption: 'geladen' });
    const grid = m.groups.find((g) => g.role === 'grid')!;
    expect(grid.headline).toBe(`Einspeisung 30,0${NBSP}kW`);
    const haus = m.groups.find((g) => g.role === 'house')!;
    expect(haus.headline).toBe(`5,5${NBSP}kW`);
  });

  it('counts a component without a value instead of rendering it as 0', () => {
    // Only ONE Fronius reports - the other has no own value anywhere.
    const m = pilsting([siteSource('src-1', { pvKw: 21.2, health: 'ok' })]);
    const pv = m.groups.find((g) => g.role === 'pv')!;
    const missing = pv.components.filter((c) => c.reading == null);
    expect(missing).toHaveLength(1);
    expect(pv.note).toBe('1 Komponente ohne aktuellen Wert');
    // The Σ still equals exactly what is shown (21,2 + 23,7 rest at the hybrid).
    const shown = pv.components
      .map((c) => c.reading?.value ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(pv.headline).toBe(`Σ ${shown.toFixed(1).replace('.', ',')}${NBSP}kW`);
  });

  it('names Herkunft per component and never a raw-token join', () => {
    const m = pilsting([siteSource('src-1', { pvKw: 21.2, health: 'ok' })]);
    const byId = new Map(m.components.map((c) => [c.id, c] as const));
    // An adopted 1:1 box measures ITSELF.
    expect(byId.get('fr1')!.provenance).toBe('misst selbst');
    // A composed component names the box it is read through.
    expect(byId.get('grid')!.provenance).toBe('gemessen über Deye');
    // The house is computed - it has no measuring device of its own.
    expect(byId.get('haus')!.provenance).toBeNull();
    expect(byId.get('haus')!.summary).toContain('braucht kein eigenes Messgerät');
    for (const d of m.devices) {
      expect(d.label).not.toContain(' · ');
      expect(d.label).not.toMatch(/[a-z]_[a-z]/);
    }
  });

  it('produces no forbidden customer words on the whole plant', () => {
    const strings = allStrings(pilsting([siteSource('src-1', { pvKw: 21.2, health: 'ok' })]));
    expect(strings.some((s) => FORBIDDEN.test(s))).toBe(false);
  });
});

describe('reconnectOffer — von „nicht mehr verbunden" zurück in den Fluss', () => {
  const orphan = entity('fr2', 'producer', {
    label: 'Fronius WR2',
    edgeSourceId: 'old-src',
    orphanedPin: true,
  });
  const reported = newlyReported(
    [source('new-src', 'pv-generation', { brand: 'fronius_sunspec', label: 'Fronius WR2' })],
    [orphan],
  );

  it('offers the reported device an orphaned component most likely IS', () => {
    const m = plantModel([orphan], null, [
      source('new-src', 'pv-generation', { brand: 'fronius_sunspec', label: 'Fronius WR2' }),
    ]);
    const c = m.components.find((x) => x.entityId === 'fr2')!;
    expect(c.orphaned).toBe(true);
    expect(reconnectOffer(c, [orphan], reported)?.id).toBe('new-src');
  });

  it('offers nothing for a healthy pin or without a matching report', () => {
    const healthy = { ...orphan, orphanedPin: false };
    const m = plantModel([healthy], null, []);
    expect(reconnectOffer(m.components[0], [healthy], reported)).toBeNull();
    const m2 = plantModel([orphan], null, []);
    expect(reconnectOffer(m2.components[0], [orphan], [])).toBeNull();
  });
});

describe('plantModel — Gerät↔Komponente wird über den Pin gematcht (PR #272)', () => {
  it('links by the entity edgeSourceId even without adoptedEntityId', () => {
    const entities = [
      entity('pv1', 'producer', { label: 'Fronius', edgeSourceId: 'src-1', deviceId: null }),
    ];
    // The reported item carries NO adoptedEntityId - only the entity's own pin.
    const m = plantModel(entities, null, [
      source('src-1', 'pv-generation', { brand: 'fronius_sunspec', label: 'Fronius' }),
    ]);
    expect(m.devices.map((d) => d.id)).toEqual(['src-1']);
    expect(m.components[0].deviceIds).toEqual(['src-1']);
    // …and it is therefore NOT offered as a new device any more.
    expect(m.newlyReported).toHaveLength(0);
  });
});

// Gerätenamen sind human (vp-vier-erzeuger-p9): das Anlagen-Modell benennt eine
// gemeldete Kiste über die EINE deviceName-Kette (Betreibername > Marke +
// Kurzmodell) - nie über den gespeicherten Roh-String. Die Pilsting-Regression:
// Geräte hießen "fronius_sunspec · fronius-eco-27-3-s · Fronius Anlage WR2 ·
// pv-generation", weil das local_setup-Label die Konkatenation trug.
describe('plantModel - device names are human (vp-vier-erzeuger-p9)', () => {
  const entities = [
    entity('p1', 'producer', { label: 'Fronius Anlage WR2', edgeSourceId: 'src-1', deviceId: null }),
    entity('p2', 'producer', { label: null, edgeSourceId: 'src-2', deviceId: null }),
  ];
  const localSetup: EntityLocalSetup[] = [
    {
      id: 'src-1',
      kind: 'source',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'fronius-eco-27-3-s',
      label: 'Fronius Anlage WR2',
      reportedAt: '',
      adoptedEntityId: 'p1',
    },
    {
      id: 'src-2',
      kind: 'source',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'fronius-eco-27-3-s',
      label: null,
      reportedAt: '',
      adoptedEntityId: 'p2',
    },
  ];

  it('the operator-given name wins; without one it is brand + short model', () => {
    const m = plantModel(entities, null, localSetup);
    const byId = new Map(m.devices.map((d) => [d.id, d.label] as const));
    expect(byId.get('src-1')).toBe('Fronius Anlage WR2');
    // fronius_sunspec is the Fronius brand read over SunSpec - the raw catalog
    // token never surfaces.
    expect(byId.get('src-2')).toBe('Fronius fronius-eco');
  });

  it('no device name is a raw-token join (no " · " chain, no snake_case id)', () => {
    const m = plantModel(entities, null, localSetup);
    for (const d of m.devices) {
      expect(d.label).not.toContain(' · ');
      expect(d.label).not.toMatch(/[a-z]_[a-z]/);
    }
  });

  it('an inverter without a label reads brand + short model, never bare ids', () => {
    const m = plantModel(
      [entity('batt', 'battery-hybrid')],
      null,
      [{ ...inverter('inv', 'deye'), model: 'SUN-30K-SG01HP3-EU' }],
    );
    expect(m.devices[0].label).toBe('Deye SUN-30K');
  });
});

// PR 3 (vp-vier-erzeuger-p9): orphaned pins are surfaced, and a newly reported
// source leads to "Wieder verbinden" instead of a duplicate adoption.
describe('orphaned pins + reconnect candidates', () => {
  const orphanedWr1 = entity('wr1', 'producer', {
    label: 'Fronius WR1',
    edgeSourceId: 'src-dead',
    orphanedPin: true,
    deviceId: null,
  });
  const healthyWr2 = entity('wr2', 'producer', {
    label: 'Fronius WR2',
    edgeSourceId: 'src-live',
    orphanedPin: false,
    deviceId: null,
  });

  it('plantModel marks a component whose pin the device no longer reports', () => {
    const m = plantModel([orphanedWr1, healthyWr2], null, []);
    const byId = new Map(m.components.map((c) => [c.id, c] as const));
    expect(byId.get('wr1')!.orphaned).toBe(true);
    expect(byId.get('wr2')!.orphaned).toBe(false);
  });

  it('an absent/null orphanedPin (older backend) never claims an orphan', () => {
    const m = plantModel([entity('p', 'producer', { edgeSourceId: 'src-x', deviceId: null })], null, []);
    expect(m.components[0].orphaned).toBe(false);
  });

  it('reconnectCandidates offers orphaned same-type entities only', () => {
    const source: AdoptableSource = {
      id: 'src-new',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'fronius-eco-27-3-s',
      label: 'Fronius Anlage WR2',
      roleLabel: 'PV-Erzeuger',
      summary: 'Fronius Anlage WR2',
      suggestedType: 'producer',
    };
    const wallboxOrphan = entity('wb', 'wallbox', {
      typeLabel: 'Wallbox',
      edgeSourceId: 'src-wb-dead',
      orphanedPin: true,
      deviceId: null,
    });
    const out = reconnectCandidates(source, [orphanedWr1, healthyWr2, wallboxOrphan]);
    expect(out).toEqual([{ entityId: 'wr1', label: 'Fronius WR1' }]);
    // A consumer source suggests a consumer type - the producer orphan never fits.
    const goe: AdoptableSource = { ...source, id: 'src-goe', role: 'consumer', brand: 'go-e', suggestedType: null };
    expect(reconnectCandidates(goe, [orphanedWr1, wallboxOrphan])).toEqual([
      { entityId: 'wb', label: 'Wallbox' },
    ]);
  });
});
