import { describe, expect, it } from 'vitest';
import {
  assignChoices,
  componentActions,
  componentLabel,
  componentRole,
  currentChoice,
  deleteConsequences,
  deviceState,
  deviceSummary,
  edgeBoxLine,
  MEASURED_VIA_INVERTER,
  newlyReported,
  plantHeadline,
  plantModel,
  reconnectCandidates,
  swapNote,
  toComponentHealth,
  type AssignChoice,
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
    // Post-Label-Hygiene a COMPOSED row carries no label of its own: what the
    // row says is derived, and a label would mean a human gave it.
    entity('batt', 'battery-hybrid', {
      label: null,
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

  // Alias-Politur (`vp-entity-alias-k1`): the modules hang on THAT box, so the
  // aspect line must follow whatever the customer calls it - otherwise the same
  // inverter would carry two names one row apart.
  it('the PV aspect follows the carrier‘s own name', () => {
    const named = [{ ...entities[0], label: 'Wechselrichter Scheune' }];
    const m = plantModel(named, null, localSetup);
    expect(m.components[0].label).toBe('Wechselrichter Scheune');
    expect(m.components[1].label).toBe('Solarmodule am Wechselrichter Scheune');
    // …and it is NOT separately renameable: it belongs to its carrier, so a
    // pencil here would silently retitle the Speicher row too.
    expect(m.components[0].renameable).toBe(true);
    expect(m.components[1].renameable).toBe(false);
    // The dialog needs both halves: the name given, and the one that returns.
    expect(m.components[0].alias).toBe('Wechselrichter Scheune');
    expect(m.components[0].derivedLabel).toBe('Speicher');
    // An un-named component offers no alias, so the field starts empty.
    expect(plantModel(entities, null, localSetup).components[0].alias).toBeNull();
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

// vp-pin-werte-f8: die Live-Werte folgen STRIKT dem Pin. Captain-Beweis vom
// 2026-07-29, 17:00 (Anlage Pilsting): die als VERWAIST markierte Komponente
// „Fronius WR1" zeigte 20,1 kW, während der Geist-Eintrag, dessen Pin auf die
// LIEFERNDE Quelle zeigt, „–" zeigte - die Werte lagen positionsbasiert auf den
// falschen Zeilen.
describe('plantModel — Werte strikt per Pin (Pilsting: Kreuz-Pin + Geist + verwaist)', () => {
  function crossPinned() {
    const entities = [
      entity('batt', 'battery-hybrid', {
        label: 'Batteriespeicher',
        capabilities: {
          measure: [
            { channel: 'pv_power_kw', unit: 'kW' },
            { channel: 'soc_pct', unit: '%' },
          ],
        },
      }),
      // Der VERWAISTE: sein Pin zeigt auf eine Quelle, die es nicht mehr gibt.
      entity('wr1', 'producer', {
        label: 'Fronius WR1',
        edgeSourceId: 'src-weg',
        orphanedPin: true,
        deviceId: null,
      }),
      // Der GEIST: neu angelegt, gepinnt auf die Quelle, die wirklich liefert.
      entity('wr2', 'producer', {
        label: 'Fronius Anlage WR2',
        edgeSourceId: 'src-live',
        orphanedPin: false,
        deviceId: null,
      }),
    ];
    const topology: SiteTopology = {
      schemaVersion: '1.0',
      entities: [
        {
          ...topoEntity('batt', 'battery-hybrid', 'storage', 'ok'),
          capabilities: [
            { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 43.1 },
            { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
          ],
        },
        topoEntity('wr1', 'producer', 'producer', 'never'),
        topoEntity('wr2', 'producer', 'producer', 'never'),
      ],
      topology: {
        schema_version: '1.0',
        nodes: [
          {
            role: 'pv',
            flow_active: true,
            members: [
              { entity_id: 'batt', label: 'Batteriespeicher', primary: false, value_kw: 43.1 },
              { entity_id: 'wr1', label: 'Fronius WR1', primary: false },
              { entity_id: 'wr2', label: 'Fronius Anlage WR2', primary: false },
            ],
          },
        ],
      },
    };
    const localSetup = [
      inverter('inv', 'deye', null),
      source('src-live', 'pv-generation', {
        brand: 'fronius_sunspec',
        label: 'Fronius Anlage WR2',
        adoptedEntityId: 'wr2',
      }),
    ];
    return plantModel(entities, topology, localSetup, [
      siteSource('src-live', { pvKw: 20.1, health: 'ok', label: 'Fronius Anlage WR2' }),
    ]);
  }

  it('der Geist bekommt den Wert SEINER gepinnten Quelle, der Verwaiste keinen', () => {
    const byId = new Map(crossPinned().components.map((c) => [c.id, c] as const));
    // Der Geist ist gepinnt und bekommt genau 20,1 kW…
    expect(byId.get('wr2')!.reading?.value).toBe(20.1);
    // …der Verwaiste trägt NIE einen aktuellen Wert (sein Zustand ist
    // „nicht mehr verbunden" - ein Wert wäre ein Widerspruch).
    expect(byId.get('wr1')!.orphaned).toBe(true);
    expect(byId.get('wr1')!.reading).toBeNull();
  });

  it('die Rollen-Summe bleibt die Summe der Quellen, mit ehrlichem Hinweis', () => {
    const pv = crossPinned().groups.find((g) => g.role === 'pv')!;
    // 20,1 (WR2) + 23,0 (eigene Module am Deye) = 43,1 = die Verbund-Zahl.
    const shown = pv.components.map((c) => c.reading?.value).filter((v): v is number => v != null);
    expect(shown).toEqual([20.1, 23]);
    expect(pv.headline).toBe(`Σ 43,1${NBSP}kW`);
    expect(pv.note).toBe('1 Komponente ohne aktuellen Wert');
  });

  it('ohne Pin wird nichts zugeordnet - keine Positions-Zuordnung mehr', () => {
    const m = crossPinned();
    // Kontrollprobe: derselbe Aufbau, aber KEIN Pin auf der liefernden Quelle.
    const entities = m.components
      .filter((c) => c.aspect === 'main')
      .map((c) => c.id);
    expect(entities).toEqual(['batt', 'wr1', 'wr2']);
    const nopin = plantModel(
      [
        entity('wr1', 'producer', { label: 'Fronius WR1', deviceId: null }),
        entity('wr2', 'producer', { label: 'Fronius WR2', deviceId: null }),
      ],
      {
        schemaVersion: '1.0',
        entities: [
          topoEntity('wr1', 'producer', 'producer', 'never'),
          topoEntity('wr2', 'producer', 'producer', 'never'),
        ],
        topology: {
          schema_version: '1.0',
          nodes: [
            {
              role: 'pv',
              flow_active: true,
              members: [
                { entity_id: 'wr1', label: 'Fronius WR1', primary: false },
                { entity_id: 'wr2', label: 'Fronius WR2', primary: false },
              ],
            },
          ],
        },
      },
      [],
      [siteSource('src-live', { pvKw: 20.1, health: 'ok', label: 'Fronius Anlage WR2' })],
    );
    // Die erste Zeile rutscht NICHT auf den Wert der Quelle.
    expect(nopin.components.every((c) => c.reading == null)).toBe(true);
  });
});

/**
 * Die Pilsting-Konstellation vom 29.07. — JEDE gemeldete Quelle ist verpinnt,
 * nur an die falschen Komponenten:
 *   WR1  → verwaist (sein Gerät gibt es nicht mehr, zeigt „–"),
 *   WR2  → hängt am Gerät „Fronius Anlage" (zeigt dessen 4,0 kW),
 *   Geist→ hängt am Gerät „Fronius Anlage WR2" (zeigt dessen 16,9 kW).
 * Weil kein Gerät UNZUGEORDNET ist, gab es kein „Neues Gerät gefunden" — und
 * damit vor dieser Änderung überhaupt keinen Weg zur Bereinigung.
 */
const PILSTING = {
  entities: [
    entity('batt', 'battery-hybrid', { label: 'Batteriespeicher', control: true }),
    entity('haus', 'house-load', { label: 'Haus' }),
    entity('wr1', 'producer', {
      label: 'Fronius WR1',
      edgeSourceId: 'src-weg',
      orphanedPin: true,
      capacityKwp: 9.8,
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
    }),
    entity('wr2', 'producer', {
      label: 'Fronius WR2',
      edgeSourceId: 'src-a',
      orphanedPin: false,
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
    }),
    entity('geist', 'producer', {
      label: 'fronius_sunspec · fronius-eco-27-3-s',
      edgeSourceId: 'src-b',
      orphanedPin: false,
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
    }),
  ],
  localSetup: [
    inverter('inv', 'deye', null),
    source('src-a', 'pv-generation', { brand: 'fronius_sunspec', label: 'Fronius Anlage' }),
    source('src-b', 'pv-generation', { brand: 'fronius_sunspec', label: 'Fronius Anlage WR2' }),
  ],
  sources: [
    siteSource('src-a', { pvKw: 4.0, label: 'Fronius Anlage' }),
    siteSource('src-b', { pvKw: 16.9, label: 'Fronius Anlage WR2' }),
  ],
};

function pilstingComponent(id: string): PlantComponent {
  const m = plantModel(PILSTING.entities, null, PILSTING.localSetup, PILSTING.sources);
  return m.components.find((c) => c.entityId === id && c.aspect === 'main')!;
}

function pilstingEntity(id: string): SiteEntity {
  return PILSTING.entities.find((e) => e.id === id)!;
}

describe('componentActions — die Bereinigung hängt an der Komponente', () => {
  it('offers both levers on an adopted component, orphaned or not', () => {
    for (const id of ['wr1', 'wr2', 'geist']) {
      expect(componentActions(pilstingComponent(id), pilstingEntity(id))).toEqual({
        canRepin: true,
        canDelete: true,
      });
    }
  });

  it('never offers them on the platform-composed base components', () => {
    for (const id of ['batt', 'haus']) {
      expect(componentActions(pilstingComponent(id), pilstingEntity(id))).toEqual({
        canRepin: false,
        canDelete: false,
      });
    }
  });

  it('does not delete a platform-synthesized base row without a pin', () => {
    // A grid-meter the platform SYNTHESIZED from the gateway carries
    // sourceKind 'composed' and no pin - it IS the plant's Grundausstattung, so
    // the server refuses its delete with 422 and the button would only fail.
    const composed = entity('netz', 'grid-meter', {
      label: 'Netzanschluss',
      sourceKind: 'composed',
    });
    const m = plantModel([composed], null, []);
    expect(componentActions(m.components[0], composed)).toEqual({
      canRepin: true,
      canDelete: false,
    });
  });

  it('keeps a legacy synthesized grid-meter protected even with sourceKind NULL (SF-1)', () => {
    // A grid-meter composed BEFORE source_kind existed carries sourceKind
    // undefined/null (never back-filled). It has no pin, so it must stay
    // protected by its TYPE, not only by the marker.
    const legacy = entity('netz', 'grid-meter', { label: 'Netzanschluss' });
    const m = plantModel([legacy], null, []);
    expect(componentActions(m.components[0], legacy)).toEqual({
      canRepin: true,
      canDelete: false,
    });
  });

  it('deletes a customer-created component that was never connected (E2)', () => {
    // A producer the customer added and never pinned carries no 'composed'
    // marker - after E2 it is removable, not stuck as "Grundausstattung".
    const stranded = entity('pv-neu', 'producer', { label: 'PV Scheune' });
    const m = plantModel([stranded], null, []);
    expect(componentActions(m.components[0], stranded)).toEqual({
      canRepin: true,
      canDelete: true,
    });
  });

  it('offers nothing on the PV aspect row — it is not a component of its own', () => {
    const hybrid = entity('b', 'battery-hybrid', {
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
    });
    const m = plantModel([hybrid], null, []);
    const aspect = m.components.find((c) => c.aspect === 'pv')!;
    expect(componentActions(aspect, hybrid)).toEqual({ canRepin: false, canDelete: false });
  });
});

describe('assignChoices — jedes gemeldete Gerät, mit Wert und Besitzer', () => {
  it('lists every fitting device with its live value and who holds it', () => {
    const choices = assignChoices(
      pilstingComponent('wr1'),
      PILSTING.entities,
      PILSTING.localSetup,
      PILSTING.sources,
    );
    expect(choices.map((c) => c.sourceId)).toEqual(['src-a', 'src-b']);
    expect(choices[0]).toMatchObject({
      label: 'Fronius Anlage',
      valueLabel: `4,0${NBSP}kW`,
      heldByLabel: 'Fronius WR2',
      current: false,
    });
    expect(choices[1]).toMatchObject({
      label: 'Fronius Anlage WR2',
      valueLabel: `16,9${NBSP}kW`,
      heldByLabel: 'fronius_sunspec · fronius-eco-27-3-s',
    });
    // The orphan has no current assignment among the REPORTED devices.
    expect(currentChoice(choices)).toBeNull();
  });

  it('marks the current assignment and never offers a device of another role', () => {
    const localSetup = [
      ...PILSTING.localSetup,
      source('src-wb', 'consumer', { brand: 'go-e', label: 'Wallbox' }),
    ];
    const choices = assignChoices(
      pilstingComponent('wr2'),
      PILSTING.entities,
      localSetup,
      PILSTING.sources,
    );
    expect(choices.map((c) => c.sourceId)).toEqual(['src-a', 'src-b']);
    expect(currentChoice(choices)?.sourceId).toBe('src-a');
    // A device with no reading of its own says so instead of showing a 0.
    const noValue = assignChoices(
      pilstingComponent('wr2'),
      PILSTING.entities,
      PILSTING.localSetup,
      [],
    );
    expect(noValue.every((c) => c.valueLabel === null)).toBe(true);
  });

  it('never offers an UNREPORTED device — the server refuses a blind assignment', () => {
    const choices = assignChoices(
      pilstingComponent('wr1'),
      PILSTING.entities,
      PILSTING.localSetup,
      PILSTING.sources,
    );
    expect(choices.some((c) => c.sourceId === 'src-weg')).toBe(false);
  });
});

describe('swapNote — der Tausch sagt vorher, was mit der anderen Komponente passiert', () => {
  it('names the exchange when both components have a device', () => {
    const choices = assignChoices(
      pilstingComponent('wr2'),
      PILSTING.entities,
      PILSTING.localSetup,
      PILSTING.sources,
    );
    const target = choices.find((c) => c.sourceId === 'src-b')!;
    const note = swapNote(target, currentChoice(choices));
    expect(note).toContain('fronius_sunspec');
    expect(note).toContain('Fronius Anlage');
    expect(note).toContain('einem Schritt');
  });

  it('says plainly that the other side is left without a device (orphan case)', () => {
    const choices = assignChoices(
      pilstingComponent('wr1'),
      PILSTING.entities,
      PILSTING.localSetup,
      PILSTING.sources,
    );
    const note = swapNote(choices[0], currentChoice(choices));
    expect(note).toContain('„Fronius WR2“ ist danach keinem Gerät mehr zugeordnet');
  });

  it('has nothing to warn about for a free or the current device', () => {
    const free: AssignChoice = {
      sourceId: 'x',
      label: 'Neu',
      valueLabel: null,
      health: 'ok',
      heldByLabel: null,
      current: false,
    };
    expect(swapNote(free, null)).toBeNull();
    expect(swapNote({ ...free, heldByLabel: 'Andere', current: true }, null)).toBeNull();
  });
});

describe('deleteConsequences — was das Löschen wirklich tut', () => {
  it('names the freed device and the kWp that leave the plant total', () => {
    const choices = assignChoices(
      pilstingComponent('wr2'),
      PILSTING.entities,
      PILSTING.localSetup,
      PILSTING.sources,
    );
    const { lines } = deleteConsequences(
      pilstingComponent('wr2'),
      pilstingEntity('wr2'),
      currentChoice(choices)!.label,
    );
    expect(lines[0]).toContain('„Fronius WR2“ verschwindet');
    expect(lines.some((l) => l.includes('Neues Gerät gefunden'))).toBe(true);
    expect(lines.some((l) => l.includes('Fronius Anlage'))).toBe(true);
    expect(
      deleteConsequences(pilstingComponent('wr1'), pilstingEntity('wr1'), 'X').kwpNote,
    ).toBe(`Die hinterlegten 9,8${NBSP}kWp werden von der Gesamtleistung Ihrer Anlage abgezogen.`);
  });

  it('promises no returning device for an orphan — its device is gone', () => {
    // Der verwaiste Pin zeigt auf ein Gerät, das sich nicht mehr meldet: es
    // taucht auch nach dem Löschen nicht als „Neues Gerät gefunden" auf.
    const { lines, kwpNote } = deleteConsequences(
      pilstingComponent('wr1'),
      pilstingEntity('wr1'),
      null,
    );
    expect(lines.some((l) => l.includes('Neues Gerät gefunden'))).toBe(false);
    expect(kwpNote).not.toBeNull();
    // Eine komponierte Komponente hat gar keine Zuordnung - also auch nichts
    // freizugeben (und wird serverseitig ohnehin nicht gelöscht).
    const composed = entity('netz', 'grid-meter');
    const m = plantModel([composed], null, []);
    const c = deleteConsequences(m.components[0], composed, null);
    expect(c.lines.some((l) => l.includes('Neues Gerät gefunden'))).toBe(false);
    expect(c.kwpNote).toBeNull();
  });

  it('uses no forbidden customer vocabulary', () => {
    const { lines, kwpNote } = deleteConsequences(
      pilstingComponent('wr1'),
      pilstingEntity('wr1'),
      'Fronius Anlage WR2',
    );
    for (const l of [...lines, kwpNote ?? '']) expect(FORBIDDEN.test(l)).toBe(false);
    const choices = assignChoices(
      pilstingComponent('wr1'),
      PILSTING.entities,
      PILSTING.localSetup,
      PILSTING.sources,
    );
    for (const c of choices) {
      expect(FORBIDDEN.test(c.label)).toBe(false);
      expect(FORBIDDEN.test(swapNote(c, null) ?? '')).toBe(false);
    }
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

  // Alias-Kontinuität (Live-Fall Herzogau, 20.08.2026): eine Komponente OHNE
  // Pin ist genau der Fall, für den es „Wieder verbinden" gibt - vorher fiel
  // sie heraus (`orphanedPin` ist dort null, nicht true) und der Dialog bot nur
  // „Als neue Komponente anlegen" an: die namenlose Parallel-Komponente.
  it('reconnectCandidates also offers a component that carries no pin at all', () => {
    const source: AdoptableSource = {
      id: 'src-new',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'fronius-eco-27-3-s',
      label: 'Fronius',
      roleLabel: 'PV-Erzeuger',
      summary: 'Fronius',
      suggestedType: 'producer',
    };
    const unpinned = entity('wr3', 'producer', {
      typeLabel: 'Erzeuger',
      label: 'Dach Süd',
      edgeSourceId: null,
      orphanedPin: null,
      deviceId: null,
    });
    expect(reconnectCandidates(source, [unpinned, healthyWr2])).toEqual([
      { entityId: 'wr3', label: 'Dach Süd' },
    ]);
    // Eine LEBENDE Bindung bleibt draußen - sie gehört einem anderen Gerät.
    expect(reconnectCandidates(source, [healthyWr2])).toEqual([]);
  });
});

/**
 * P5b/P5d: WOHER der Ladestand kommt, steht in `soc_source_code` NEBEN dem
 * Wert - je Messzeitpunkt. Die Komponenten-Zeile liest ihn, damit Cockpit,
 * Geräteseite und Komponenten-Liste DIESELBE Wahrheit aus DERSELBEN Quelle
 * zeigen statt drei Vermutungen über den Gerätetyp.
 */
describe('plantModel — die Herkunft eines berechneten Ladestands (P5d)', () => {
  function batterieMit(code: number | null): ReturnType<typeof plantModel> {
    const entities = [
      entity('batt', 'user-defined-battery', {
        label: 'Selbstbau-Pack',
        capabilities: {
          measure: [
            { channel: 'soc_pct', unit: '%' },
            { channel: 'soc_source_code', unit: '' },
          ],
        },
      }),
    ];
    const caps = [
      { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 41 },
      ...(code == null
        ? []
        : [{ channel: 'soc_source_code', unit: '', role: null, primary: false, value: code }]),
    ];
    const topology: SiteTopology = {
      schemaVersion: '1.0',
      entities: [{ ...topoEntity('batt', 'user-defined-battery', 'storage', 'ok'), capabilities: caps }],
      topology: { schema_version: '1.0', nodes: [] },
    };
    return plantModel(entities, topology, [], null);
  }

  function ladestand(code: number | null) {
    return batterieMit(code).components.find((c) => c.entityId === 'batt')!.reading;
  }

  it('nennt die berechnete Herkunft als Wort unter der Zahl', () => {
    expect(ladestand(2)).toEqual({ value: 41, unit: '%', caption: 'berechnet: Kennlinie' });
    expect(ladestand(3)).toEqual({ value: 41, unit: '%', caption: 'berechnet: Ladungszählung' });
  });

  /**
   * Ohne den Kanal bleibt es beim neutralen „geladen": „gemessen" zu
   * schreiben, weil nichts dagegenspricht, wäre eine Behauptung über eine
   * Herkunft, die niemand gemeldet hat - und fast jede Katalog-Batterie
   * meldet den Kanal nie.
   */
  it('behauptet ohne den Kanal keine Herkunft', () => {
    expect(ladestand(null)?.caption).toBe('geladen');
    expect(ladestand(1)?.caption).toBe('geladen');
  });

  /** Ein Code außerhalb des Vokabulars wird verworfen, nie geraten. */
  it('rät bei einem unbekannten Code nicht', () => {
    expect(ladestand(7)?.caption).toBe('geladen');
    expect(ladestand(0)?.caption).toBe('geladen');
  });
});
