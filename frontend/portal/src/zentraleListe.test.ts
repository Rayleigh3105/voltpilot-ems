import { describe, expect, it } from 'vitest';
import {
  zentraleListe,
  zentraleSatz,
  type GeraeteKarte,
  type ZentraleListeInput,
} from './zentraleListe';
import { plantModel } from './komponenten';
import type {
  Device,
  EntityLocalSetup,
  SiteEntity,
  SiteSource,
  SiteTopology,
} from './api';
import type { SiteCharging } from './ladepunkte';

/**
 * Die Pilsting-Konstellation der Revision 2: eine Box, ein Deye-Hybrid
 * (Speicher · Netz · Haus · eigene PV), zwei Fronius, eine Säule und ein neu
 * gemeldeter Shelly.
 */
const NOW = Date.parse('2026-08-20T13:24:24Z');
const FRISCH = new Date(NOW - 12_000).toISOString();

const BOX: Device = {
  id: 'gw',
  siteId: 's-1',
  externalRef: 'edge-45gz7da',
  kind: 'inverter',
  name: 'Pilsting',
  status: 'active',
  lastSeenAt: FRISCH,
  createdAt: null,
};

const ent = (o: Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType' | 'role'>): SiteEntity => ({
  typeLabel: '',
  label: null,
  control: false,
  deviceId: 'gw',
  capabilities: null,
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
  ...o,
} as SiteEntity);

const ENTITIES: SiteEntity[] = [
  ent({
    id: 'batt',
    entityType: 'battery-hybrid',
    typeLabel: 'Batteriespeicher',
    role: 'storage',
    label: 'Wechselrichter Scheune',
    control: true,
    capabilities: { measure: [{ channel: 'soc_pct' }, { channel: 'pv_power_kw' }] },
  }),
  ent({ id: 'grid', entityType: 'grid-meter', typeLabel: 'Netzanschluss', role: 'grid' }),
  ent({ id: 'haus', entityType: 'house-load', typeLabel: 'Hausverbrauch', role: 'house' }),
  ent({
    id: 'fr1',
    entityType: 'producer',
    typeLabel: 'Erzeuger',
    role: 'pv',
    label: 'Dach Süd',
    edgeSourceId: 'src-a',
    capabilities: { measure: [{ channel: 'pv_power_kw' }] },
  }),
];

const LOCAL: EntityLocalSetup[] = [
  {
    id: 'inverter',
    kind: 'inverter',
    role: null,
    brand: 'deye',
    model: 'SUN-30K-SG01HP3-EU',
    label: null,
    reportedAt: FRISCH,
    adoptedEntityId: null,
  },
  {
    id: 'src-a',
    kind: 'source',
    role: 'pv-generation',
    brand: 'fronius_sunspec',
    model: 'Eco 27.0-3-S',
    label: null,
    reportedAt: FRISCH,
    adoptedEntityId: 'fr1',
  },
  // Ein NEU gemeldeter Shelly - noch keine Komponente.
  {
    id: 'shelly-1',
    kind: 'source',
    role: 'consumer',
    brand: 'shelly',
    model: 'Plus 1PM',
    label: 'Heizstab',
    reportedAt: FRISCH,
    adoptedEntityId: null,
  },
];

const SOURCES: SiteSource[] = [
  {
    deviceId: 'gw',
    sourceId: 'inverter',
    kind: 'primary',
    role: null,
    label: null,
    brand: 'deye',
    model: 'SUN-30K-SG01HP3-EU',
    pvKw: 0.2,
    powerKw: -30,
    loadKw: 5.5,
    health: 'ok',
    readAt: FRISCH,
    reportedAt: FRISCH,
  },
  {
    deviceId: 'gw',
    sourceId: 'src-a',
    kind: 'source',
    role: 'pv-generation',
    label: null,
    brand: 'fronius_sunspec',
    model: 'Eco 27.0-3-S',
    pvKw: 21.2,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: FRISCH,
    reportedAt: FRISCH,
  },
];

const TOPOLOGY = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      label: 'Wechselrichter Scheune',
      category: 'storage',
      health: 'ok',
      capabilities: [
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
        { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 0.2 },
      ],
    },
    {
      id: 'grid',
      entityType: 'grid-meter',
      typeLabel: 'Netzanschluss',
      label: null,
      category: 'meter',
      health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -30 }],
    },
    {
      id: 'haus',
      entityType: 'house-load',
      typeLabel: 'Hausverbrauch',
      label: null,
      category: 'consumer',
      health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'consumer', primary: false, value: 5.5 }],
    },
    {
      id: 'fr1',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      label: 'Dach Süd',
      category: 'producer',
      health: 'ok',
      capabilities: [{ channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 21.2 }],
    },
  ],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const CHARGING: SiteCharging = {
  budget: null,
  chargers: [
    {
      deviceId: 'gw',
      chargePointId: 'CARPORT-1',
      label: 'Ladepunkt „Carport"',
      priority: false,
      connected: true,
      ready: true,
      lastSeen: FRISCH,
      reportedAt: FRISCH,
      connectors: [
        { connectorId: 1, status: 'Charging', charging: true, powerKw: 11 },
        { connectorId: 2, status: 'Available', charging: false, powerKw: null },
      ],
    },
  ],
};

function input(over: Partial<ZentraleListeInput> = {}): ZentraleListeInput {
  const entities = over.model ? [] : ENTITIES;
  return {
    siteId: 's-1',
    model: plantModel(entities, TOPOLOGY, LOCAL, SOURCES),
    devices: [BOX],
    devicesFetchedAt: NOW,
    boxRef: 'edge-45gz7da',
    localSetup: LOCAL,
    sources: SOURCES,
    charging: CHARGING,
    now: NOW,
    ...over,
  };
}

const karte = (k: GeraeteKarte[], id: string) => k.find((x) => x.id === id);

describe('zentraleListe · die Reihenfolge und die Karten-Arten', () => {
  it('führt mit der EINEN Box, dann die Geräte, die Säule, zuletzt die Ausnahme', () => {
    const k = zentraleListe(input());
    expect(k.map((x) => x.art)).toEqual(['box', 'geraet', 'geraet', 'ladepunkt', 'neu']);
  });

  it('nennt die Box beim Namen und sagt, wie viele Geräte an ihr hängen', () => {
    const box = karte(zentraleListe(input()), 'box:edge-45gz7da')!;
    expect(box.titel).toBe('VoltPilot-Box Pilsting');
    expect(box.zustand).toMatch(/^verbunden · vor/);
    expect(box.zusatz).toMatch(/2 Geräte angebunden/);
    // Die BOX führt auf ihre EIGENE Seite (E3) - sie ist ein Tor, kein Gerät.
    expect(box.href).toBe('#/anlage/s-1/box/edge-45gz7da');
  });

  it('trägt an der KARTE den technischen Namen - der Kundenname lebt an der ZEILE', () => {
    const k = zentraleListe(input());
    const deye = karte(k, 'inverter')!;
    expect(deye.titel).toBe('Deye SUN-30K');
    expect(deye.titel).not.toContain('Scheune');
    expect(deye.komponenten.map((c) => c.label)).toContain('Wechselrichter Scheune');
  });

  it('gibt dem Hybrid EHRLICH seine vier Zeilen - EIN Gerät, mehrere Komponenten', () => {
    const deye = karte(zentraleListe(input()), 'inverter')!;
    const rollen = deye.komponenten.map((c) => c.role).sort();
    expect(rollen).toEqual(['grid', 'house', 'pv', 'storage']);
    expect(deye.untertitel).toBe('Hybrid-Wechselrichter · Hauptgerät');
  });

  it('macht aus dem 1:1-Fall EINE Karte mit EINER Zeile (die Doppelung ist weg)', () => {
    const fr = karte(zentraleListe(input()), 'src-a')!;
    expect(fr.titel).toBe('Fronius Eco 27.0-3');
    expect(fr.komponenten.map((c) => c.label)).toEqual(['Dach Süd']);
    expect(fr.untertitel).toBe('PV-Wechselrichter');
  });

  it('reiht die Säule als GERÄTE-Karte ein und nennt ihre Stecker', () => {
    const cp = karte(zentraleListe(input()), 'cp-CARPORT-1')!;
    expect(cp.art).toBe('ladepunkt');
    expect(cp.titel).toBe('Ladepunkt „Carport"');
    expect(cp.untertitel).toBe('Ladesäule · 2 Stecker · 1 lädt');
    expect(cp.href).toBe('#/anlage/s-1/geraet/edge-45gz7da/cp-CARPORT-1');
  });

  it('führt das neu gemeldete Gerät ALS Ausnahme, mit dem Weg zur Übernahme', () => {
    const neu = zentraleListe(input()).find((x) => x.art === 'neu')!;
    expect(neu.titel).toBe('Neues Gerät gefunden');
    expect(neu.quelle?.id).toBe('shelly-1');
    expect(neu.href).toBeNull();
  });

  it('lässt das HAUPTGERÄT führen, auch wenn das Modell anders sortiert', () => {
    const karten = zentraleListe(input()).filter((k) => k.art === 'geraet');
    expect(karten[0].untertitel).toMatch(/Hauptgerät/);
  });
});

describe('zentraleListe · Ehrlichkeit', () => {
  it('bietet KEINEN Weg an, wo keine Box bekannt ist', () => {
    const k = zentraleListe(input({ boxRef: null }));
    expect(k.every((x) => x.href === null)).toBe(true);
  });

  it('bietet KEINEN Weg auf ein synthetisches Gerät an', () => {
    // Eine Komponente mit Gerätebindung, aber ohne gemeldete Quelle - dahinter
    // steckt kein Eintrag, die Seite fände nichts.
    const nurSynthetisch = plantModel([ENTITIES[1]], TOPOLOGY, [], []);
    const k = zentraleListe(input({ model: nurSynthetisch, localSetup: [], sources: [], charging: null }));
    const geraet = k.find((x) => x.art === 'geraet')!;
    expect(geraet.id.startsWith('dev:')).toBe(true);
    expect(geraet.href).toBeNull();
  });

  it('sagt an einer Karte OHNE Zeile, dass sie noch nichts misst', () => {
    const ohnePin = plantModel(
      [],
      TOPOLOGY,
      [LOCAL[0]],
      [SOURCES[0]],
    );
    const geraet = zentraleListe(
      input({ model: ohnePin, localSetup: [LOCAL[0]], charging: null }),
    ).find((x) => x.art === 'geraet')!;
    expect(geraet.komponenten).toEqual([]);
    expect(geraet.zusatz).toBe('Misst noch nichts.');
  });

  it('trägt den ZWEITEN Frische-Anker: ein Gerät altert gegen seinen Lesezeitpunkt', () => {
    const alt = SOURCES.map((s) =>
      s.sourceId === 'src-a' ? { ...s, readAt: new Date(NOW - 3 * 3600_000).toISOString() } : s,
    );
    const fr = karte(zentraleListe(input({ sources: alt })), 'src-a')!;
    expect(fr.zustand).toMatch(/vor 3.Std\./);
  });

  it('gibt einer verwaisten Komponente eine EIGENE Karte, nie ein erfundenes Gerät', () => {
    const verwaist = ENTITIES.map((e) =>
      e.id === 'fr1' ? { ...e, orphanedPin: true } : e,
    );
    const k = zentraleListe(
      input({ model: plantModel(verwaist, TOPOLOGY, LOCAL, SOURCES) }),
    );
    const w = k.find((x) => x.art === 'verwaist')!;
    expect(w.titel).toBe('Nicht mehr verbunden');
    expect(w.untertitel).toBe('1 Komponente wartet auf ihr Gerät');
    expect(w.komponenten.map((c) => c.label)).toEqual(['Dach Süd']);
    // Und sie steht ganz am Ende - die Ausnahmen kommen nach dem Normalfall.
    expect(k[k.length - 1].art).toBe('verwaist');
  });

  it('kommt ohne Säulen-Antwort aus (älteres Backend)', () => {
    const k = zentraleListe(input({ charging: null }));
    expect(k.some((x) => x.art === 'ladepunkt')).toBe(false);
    expect(k.some((x) => x.art === 'geraet')).toBe(true);
  });
});

describe('zentraleSatz · EIN Satz über die Gesundheit', () => {
  it('ist grün, wenn Box und alle Geräte liefern', () => {
    const ohneAusnahmen = zentraleListe(
      input({
        model: plantModel(ENTITIES, TOPOLOGY, LOCAL.slice(0, 2), SOURCES),
        localSetup: LOCAL.slice(0, 2),
        charging: null,
      }),
    );
    const s = zentraleSatz(ohneAusnahmen);
    expect(s.ton).toBe('ok');
    expect(s.text).toBe('Box verbunden · alle 2 Geräte liefern Daten.');
  });

  it('nennt das neue Gerät - und wird dadurch bernstein', () => {
    const s = zentraleSatz(zentraleListe(input({ charging: null })));
    expect(s.ton).toBe('warn');
    expect(s.text).toContain('1 neues Gerät wartet auf Übernahme');
  });

  it('NENNT ein schweigendes Gerät beim Namen (die plantHeadline-Regel)', () => {
    const still = SOURCES.map((s) =>
      s.sourceId === 'src-a' ? { ...s, health: 'stale' as const } : s,
    );
    const entitiesStill = ENTITIES.map((e) =>
      e.id === 'fr1'
        ? { ...e, observed: { health: 'stale' } as unknown as SiteEntity['observed'] }
        : e,
    );
    const topoStill = {
      ...TOPOLOGY,
      entities: TOPOLOGY.entities.map((e) => (e.id === 'fr1' ? { ...e, health: 'stale' } : e)),
    } as SiteTopology;
    const k = zentraleListe(
      input({
        model: plantModel(entitiesStill, topoStill, LOCAL.slice(0, 2), still),
        localSetup: LOCAL.slice(0, 2),
        sources: still,
        charging: null,
      }),
    );
    const s = zentraleSatz(k);
    expect(s.ton).toBe('warn');
    expect(s.text).toContain('„Fronius Eco 27.0-3"');
  });

  it('sagt bei einer leeren Anlage, was als Nächstes passiert', () => {
    const leer = zentraleListe(
      input({ model: plantModel([], null, [], []), devices: [], charging: null, localSetup: [], sources: [] }),
    );
    const s = zentraleSatz(leer);
    expect(s.ton).toBe('warn');
    expect(s.text).toMatch(/Noch kein Gerät verbunden/);
  });
});
