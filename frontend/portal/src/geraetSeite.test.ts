import { describe, expect, it } from 'vitest';
import {
  chargePointIdOf,
  chargerGeraetId,
  geraetSeite,
  KEIN_VERBINDUNGS_VERLAUF,
  LAN_UNBEKANNT,
  NUR_GELESEN,
  pvEinstiegEntityId,
  type GeraetSeiteInput,
} from './geraetSeite';
import { plantModel } from './komponenten';
import type {
  ControlStatus,
  CurtailmentStatus,
  Device,
  EdgeVersion,
  EntityLocalSetup,
  SiteComponents,
  SiteEntity,
  SiteSource,
  SiteTopology,
} from './api';
import type { SiteCharging } from './ladepunkte';

/**
 * Die Pilsting-Konstellation als EINE Vorlage: eine VoltPilot-Box, ein
 * Deye-Hybrid als Hauptgerät (Speicher · Netz · Haus · eigene PV), ein Fronius
 * als übernommene Quelle, ein neu gemeldeter Shelly und eine OCPP-Säule. Jeder
 * Test verändert daran genau das, was er prüft.
 */
const NOW = Date.parse('2026-08-20T13:24:24Z');
const FRISCH = new Date(NOW - 12_000).toISOString();

const BOX: Device = {
  id: 'dev-box',
  siteId: 'site-1',
  externalRef: 'edge-45gz7da',
  kind: 'inverter',
  name: 'Pilsting',
  status: 'active',
  lastSeenAt: FRISCH,
  createdAt: '2026-07-01T10:00:00Z',
};

const HYBRID: SiteEntity = {
  id: 'ent-batt',
  entityType: 'battery-hybrid',
  typeLabel: 'Batteriespeicher',
  role: 'storage',
  label: 'Wechselrichter Scheune',
  control: true,
  deviceId: 'dev-box',
  capabilities: {
    measure: [{ channel: 'soc_pct' }, { channel: 'battery_power_kw' }, { channel: 'pv_power_kw' }],
    actuate: [{ command: 'setpoint_kw' }],
  },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
};

const PRODUCER: SiteEntity = {
  id: 'ent-pv',
  entityType: 'producer',
  typeLabel: 'Erzeuger',
  role: 'pv',
  label: 'Dach Süd',
  control: false,
  deviceId: 'dev-box',
  capabilities: { measure: [{ channel: 'pv_power_kw' }] },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: 'src-7c1e9a2b',
};

const LOCAL_SETUP: EntityLocalSetup[] = [
  {
    id: 'inverter',
    kind: 'inverter',
    role: null,
    brand: 'deye',
    model: 'SUN-30K-SG01HP3-EU',
    label: null,
    reportedAt: FRISCH,
    adoptedEntityId: null,
    // Die sechs Verbindungsfelder (Stufe 2, PR 2b) - beim Deye der
    // Solarman-Weg samt Logger-Nummer.
    communication: 'solarman_v5',
    family: 'hybrid_3p',
    host: '192.168.254.210',
    port: 8899,
    unitId: 1,
    serial: '2985159064',
    intervalS: 5,
  },
  {
    id: 'src-7c1e9a2b',
    kind: 'source',
    role: 'pv-generation',
    brand: 'fronius_sunspec',
    model: 'Eco 27.0-3-S',
    label: null,
    reportedAt: FRISCH,
    adoptedEntityId: 'ent-pv',
    communication: 'fronius_sunspec',
    family: 'sunspec_live',
    host: '192.168.210.40',
    port: 502,
    unitId: 1,
    serial: null,
    intervalS: 5,
  },
];

const SOURCES: SiteSource[] = [
  {
    deviceId: 'dev-box',
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
    deviceId: 'dev-box',
    sourceId: 'src-7c1e9a2b',
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

const TOPOLOGY: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'ent-batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      label: 'Wechselrichter Scheune',
      category: 'storage',
      health: 'ok',
      capabilities: [
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
        { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: false, value: 9.3 },
        { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 0.2 },
      ],
    },
    {
      id: 'ent-pv',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      label: 'Dach Süd',
      category: 'producer',
      health: 'ok',
      capabilities: [{ channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 21.2 }],
    },
  ],
  topology: { schemaVersion: '1.0', nodes: [] } as unknown as SiteTopology['topology'],
};

const COMPONENTS: SiteComponents = {
  componentAuthority: 'portal',
  appliedRevision: 'rev-14',
  components: [
    {
      id: 'ent-pv',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'Eco 27.0-3-S',
      family: 'sunspec_live',
      communication: 'fronius_sunspec',
      connection: { ip: '192.168.254.30', port: 502, unit_id: 1, interval_s: 5 },
      definitionVersion: 3,
      edgeSourceId: 'src-7c1e9a2b',
      syncStatus: 'in_sync',
    },
  ],
};

const CONTROL: ControlStatus = {
  deviceId: 'dev-box',
  commandedKw: 9.3,
  confirmedKw: 9.3,
  allMatch: true,
  controlEnabled: true,
  certified: true,
  mismatchRoles: null,
  slotStart: null,
  checkedAt: FRISCH,
};

const EDGE: EdgeVersion[] = [
  {
    deviceId: 'dev-box',
    siteId: 'site-1',
    coreVersion: 'edge-2026.08.10',
    paletteVersion: '0.9.0',
    reportedAt: FRISCH,
  },
];

function input(over: Partial<GeraetSeiteInput> = {}): GeraetSeiteInput {
  const entities = over.entities ?? [HYBRID, PRODUCER];
  const localSetup = over.localSetup ?? LOCAL_SETUP;
  const sources = over.sources ?? SOURCES;
  const topology = 'model' in over ? null : TOPOLOGY;
  return {
    ref: 'edge-45gz7da',
    // ⚠ Vorgabe ist seit Geräteseiten Stufe 1 das HAUPTGERÄT: die Box hat ihre
    // eigene Gattung (`boxSeite.ts`), diese Fläche zeigt nur Geräte DAHINTER.
    geraetId: 'inverter',
    siteName: 'Pilsting',
    devices: [BOX],
    devicesFetchedAt: NOW,
    entities,
    localSetup,
    sources,
    components: COMPONENTS,
    control: CONTROL,
    curtailment: null,
    edgeVersions: EDGE,
    charging: null,
    strategies: null,
    model: plantModel(entities, topology, localSetup, sources),
    now: NOW,
    ...over,
  };
}

const zeile = (rows: { label: string; wert: string; detail?: string | null }[], label: string) =>
  rows.find((r) => r.label === label);

describe('geraetSeite · Identität und Titel', () => {
  it('trägt als Seitentitel den TECHNISCHEN Gerätenamen, nie den Kundennamen', () => {
    // Die Komponente heißt „Wechselrichter Scheune"; das GERÄT bleibt Marke + Modell
    // (w7 R6 - ein Gerät wird nie umbenannt, nur seine Komponenten).
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    expect(v.kopf.titel).toBe('Deye SUN-30K');
    expect(v.kopf.titel).not.toContain('Scheune');
    expect(v.art).toBe('hauptgeraet');
  });

  it('nennt einen Hybrid einen Hybrid, weil ein Speicher an ihm hängt', () => {
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    expect(v.kopf.unterzeile).toContain('Hybrid-Wechselrichter');
    expect(v.kopf.unterzeile).toContain('Pilsting');
  });

  it('nennt eine gemeldete Quelle nach ihrer Rolle', () => {
    const v = geraetSeite(input({ geraetId: 'src-7c1e9a2b' }));
    expect(v.art).toBe('quelle');
    // Der Modellname geht durch die HAUS-Kürzung (`shortModel`): der Kunde
    // sagt „Eco 27.0-3", nicht den vollen Katalogschlüssel.
    expect(v.kopf.titel).toBe('Fronius Eco 27.0-3');
    expect(v.kopf.unterzeile).toContain('PV-Wechselrichter');
  });

  it('nennt den GRUND, wenn die Adresse kein Gerät dieser Anlage meint', () => {
    const v = geraetSeite(input({ geraetId: 'src-weg' }));
    expect(v.gefunden).toBe(false);
    expect(v.grund).toMatch(/meldet sich an Ihrer Box gerade nicht/);
    expect(v.verbindung).toEqual([]);
  });

});

describe('geraetSeite · A Verbindung & Gesundheit', () => {
  it('zeigt die Anbindung so, wie die Box sie gespeichert hat', () => {
    const v = geraetSeite(input({ geraetId: 'src-7c1e9a2b' }));
    expect(zeile(v.verbindung, 'Anbindung')?.wert).toBe('SunSpec über das Netzwerk');
    expect(zeile(v.verbindung, 'Adresse')?.wert).toBe('192.168.254.30 : 502');
    expect(zeile(v.verbindung, 'Adresse')?.detail).toBe('Modbus-Adresse 1');
    expect(zeile(v.verbindung, 'Lesetakt')?.wert).toBe('alle 5 s');
    expect(v.verbindungLeer).toBeNull();
  });

  it('beschriftet ein box-verwaltetes Gerät aus dem GEMELDETEN Weg (PR 2b)', () => {
    // Der Deye hat keine gespeicherte Definition (`/components` kennt nur den
    // Fronius) - bis Stufe 2 stand hier deshalb „meldet keine
    // Verbindungsdaten", obwohl die Box ihre Adresse in jedem Herzschlag
    // meldet. Jetzt reist sie auf `/entities.localSetup` mit.
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    expect(v.verbindungLeer).toBeNull();
    expect(zeile(v.verbindung, 'Anbindung')?.wert).toBe('Solarman-Logger (WLAN-Stick)');
    expect(zeile(v.verbindung, 'Adresse')?.wert).toBe('192.168.254.210 : 8899');
    expect(zeile(v.verbindung, 'Adresse')?.detail).toBe('Logger-Nr. 2985159064');
    expect(zeile(v.verbindung, 'Lesetakt')?.wert).toBe('alle 5 s');
  });

  it('lässt das gespeicherte SOLL führen, wo es vorliegt', () => {
    // Der Fronius meldet 192.168.210.40, gepflegt ist 192.168.254.30 - die
    // Seite zeigt die gepflegte Wahrheit, nicht zwei Adressen nebeneinander.
    const v = geraetSeite(input({ geraetId: 'src-7c1e9a2b' }));
    expect(zeile(v.verbindung, 'Adresse')?.wert).toBe('192.168.254.30 : 502');
  });

  it('NENNT den Grund, wenn ein älterer Box-Stand keine Verbindungsdaten meldet', () => {
    const alt = LOCAL_SETUP.map((l) =>
      l.id === 'inverter'
        ? {
            ...l,
            communication: null,
            family: null,
            host: null,
            port: null,
            unitId: null,
            serial: null,
            intervalS: null,
          }
        : l,
    );
    const v = geraetSeite(input({ geraetId: 'inverter', localSetup: alt }));
    expect(v.verbindungLeer).toMatch(/meldet keine Verbindungsdaten/);
    // aber der Zustand steht trotzdem da - eine leere Sektion gibt es nicht.
    expect(zeile(v.verbindung, 'Zustand')).toBeTruthy();
  });

  it('erfindet keinen Verbindungs-Verlauf', () => {
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    expect(zeile(v.verbindung, 'Zustand')?.detail).toBe(KEIN_VERBINDUNGS_VERLAUF);
  });

  it('nennt den Pflege-Ort samt Fassung', () => {
    const v = geraetSeite(input({ geraetId: 'src-7c1e9a2b' }));
    expect(zeile(v.verbindung, 'Einrichtung')?.wert).toBe('wird im Portal gepflegt (Fassung 3)');
    expect(v.kopf.pflegeOrt).toBe('Einrichtung: im Portal');
  });

  it('sagt bei einer box-verwalteten Anlage, dass an der Box gepflegt wird', () => {
    const v = geraetSeite(
      input({
        geraetId: 'src-7c1e9a2b',
        components: { ...COMPONENTS, componentAuthority: 'box' },
      }),
    );
    expect(v.kopf.pflegeOrt).toBe('Einrichtung: an Ihrer Box');
  });
});

describe('geraetSeite · Zustand und Frische-Anker', () => {
  it('misst ein GERÄT gegen seinen eigenen Lesezeitpunkt', () => {
    const stale = SOURCES.map((s) =>
      s.sourceId === 'src-7c1e9a2b'
        ? { ...s, health: 'stale' as const, readAt: new Date(NOW - 2 * 3600_000).toISOString() }
        : s,
    );
    const v = geraetSeite(input({ geraetId: 'src-7c1e9a2b', sources: stale }));
    expect(v.kopf.zustand.wort).toBe('meldet sich gerade nicht');
    expect(v.kopf.zustand.ton).toBe('warn');
    expect(v.kopf.zustand.detail).toMatch(/^zuletzt vor/);
  });

  it('sagt „noch keine Rückmeldung" statt „offline", wenn gar nichts gemeldet wurde', () => {
    const v = geraetSeite(input({ geraetId: 'inverter', sources: [] }));
    expect(v.kopf.zustand.wort).toBe('noch keine Rückmeldung');
    expect(v.kopf.zustand.ton).toBe('off');
  });
});

describe('geraetSeite · B Live-Werte', () => {
  it('zeigt die Messwerte DIESES Geräts, Richtung als Wort', () => {
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    const labels = v.live.map((k) => k.label);
    expect(labels).toEqual(['Solarstrom', 'Ladestand', 'Netz', 'Haus']);
    expect(v.live.find((k) => k.label === 'Netz')?.wort).toBe('Einspeisung');
    expect(v.live.find((k) => k.label === 'Netz')?.wert).not.toContain('-');
    expect(v.live.find((k) => k.label === 'Haus')?.wort).toBe('abgeleitet');
    expect(v.liveStand).toBeTruthy();
  });

  it('NENNT den Grund, wenn ein Gerät noch nichts geliefert hat', () => {
    // Weder gemeldete Quelle noch Topologie-Wert - dann gibt es nichts zu
    // zeigen, und die Sektion sagt WARUM statt leer zu bleiben.
    const v = geraetSeite(
      input({
        geraetId: 'inverter',
        sources: [],
        model: plantModel([HYBRID, PRODUCER], null, LOCAL_SETUP, []),
      }),
    );
    expect(v.live).toEqual([]);
    expect(v.liveLeer).toMatch(/noch keine Messwerte geliefert/);
  });

});

describe('geraetSeite · PV-Produktion-Einstieg (Fix b, vp-agg-konzept3-r8)', () => {
  // Ein Hybrid, dessen komponierte Speicher-Entität ihren `pv_power_kw`-Kanal
  // verloren hat (der reproduzierte Captain-Fall): der Speicher bleibt, der
  // PV-Aspekt entsteht nicht mehr.
  const DAMAGED_HYBRID: SiteEntity = {
    ...HYBRID,
    capabilities: {
      measure: [{ channel: 'soc_pct' }, { channel: 'battery_power_kw' }],
      actuate: [{ command: 'setpoint_kw' }],
    },
  };
  // Dieselbe Quelle, aber ohne echten PV-Wert: dann meldet das Gerät keine
  // Erzeugung (fehlend ist keine 0).
  const STUMME_QUELLEN: SiteSource[] = SOURCES.map((s) =>
    s.sourceId === 'inverter' ? { ...s, pvKw: null } : s,
  );

  it('meldet Erzeugung, sobald die Quelle einen PV-Wert echot (auch 0)', () => {
    // SOURCES.inverter.pvKw === 0.2
    const v = geraetSeite(input({ geraetId: 'inverter', entities: [HYBRID] }));
    expect(v.meldetErzeugung).toBe(true);
  });

  it('gesunder Hybrid: der Einstieg läuft über den vorhandenen PV-Aspekt', () => {
    const v = geraetSeite(
      input({ geraetId: 'inverter', entities: [HYBRID], model: plantModel([HYBRID], null, LOCAL_SETUP, SOURCES) }),
    );
    expect(v.komponenten.some((c) => c.role === 'pv')).toBe(true);
    // Der PV-Aspekt trägt die entityId seines Trägers (des Speichers).
    expect(pvEinstiegEntityId(v)).toBe('ent-batt');
  });

  it('CAPTAIN-FALL: Hybrid OHNE PV-Aspekt, aber mit gemeldetem Solarstrom, seedet die Speicher-Entität', () => {
    const v = geraetSeite(
      input({
        geraetId: 'inverter',
        entities: [DAMAGED_HYBRID],
        model: plantModel([DAMAGED_HYBRID], null, LOCAL_SETUP, SOURCES),
      }),
    );
    // Kein PV-Aspekt mehr - genau das versteckte heute die Karte.
    expect(v.komponenten.some((c) => c.role === 'pv')).toBe(false);
    // ... aber das Gerät meldet Erzeugung, also bleibt der Einstieg erreichbar
    // und startet auf der Träger-Entität (dem Speicher).
    expect(v.meldetErzeugung).toBe(true);
    expect(pvEinstiegEntityId(v)).toBe('ent-batt');
  });

  it('kein erzeugendes Gerät (kein PV-Aspekt, kein PV-Echo): weiterhin KEIN Einstieg', () => {
    const v = geraetSeite(
      input({
        geraetId: 'inverter',
        entities: [DAMAGED_HYBRID],
        sources: STUMME_QUELLEN,
        model: plantModel([DAMAGED_HYBRID], null, LOCAL_SETUP, STUMME_QUELLEN),
      }),
    );
    expect(v.meldetErzeugung).toBe(false);
    expect(pvEinstiegEntityId(v)).toBeNull();
  });
});

describe('geraetSeite · C Misst & steuert', () => {
  it('führt die Komponenten DIESES Geräts - dieselben Zeilen wie die Zentrale', () => {
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    // Der Hybrid trägt die komponierten Zeilen samt seiner PV-Aspekt-Zeile -
    // dieselbe Zuordnung, die `plantModel` für die Zentrale rechnet.
    const labels = v.komponenten.map((c) => c.label);
    expect(labels).toContain('Wechselrichter Scheune');
    expect(labels).toContain('Solarmodule am Wechselrichter Scheune');
    expect(v.komponentenLeer).toBeNull();
  });

  it('sagt es, wenn ein Gerät noch nichts misst', () => {
    const fremd: EntityLocalSetup[] = [
      ...LOCAL_SETUP,
      {
        id: 'src-neu',
        kind: 'source',
        role: 'consumer',
        brand: 'shelly',
        model: 'Plus 1PM',
        label: null,
        reportedAt: FRISCH,
        adoptedEntityId: null,
      },
    ];
    const v = geraetSeite(input({ geraetId: 'src-neu', localSetup: fremd }));
    expect(v.komponenten).toEqual([]);
    expect(v.komponentenLeer).toMatch(/misst noch nichts/);
  });
});

describe('geraetSeite · G Steuerungs-Bezüge', () => {
  it('sagt die k3-F4-Zeile an einem nur gelesenen Gerät', () => {
    const v = geraetSeite(input({ geraetId: 'src-7c1e9a2b' }));
    expect(zeile(v.steuerung, 'Steuerung')?.wert).toBe(NUR_GELESEN);
  });

  it('nennt am steuernden Gerät die Freigabe und den Not-Aus', () => {
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    expect(zeile(v.steuerung, 'VoltPilot steuert')?.wert).toContain('Wechselrichter Scheune');
    expect(zeile(v.steuerung, 'Freigabe')?.wert).toBe('freigegeben');
    expect(zeile(v.steuerung, 'Not-Aus an der Box')?.wert).toMatch(/^aus/);
  });

  it('schreibt einen Steuerungs-Beleg NIE einem fremden Gerät zu', () => {
    const fremd: ControlStatus = { ...CONTROL, deviceId: 'dev-andere-box' };
    const v = geraetSeite(input({ geraetId: 'inverter', control: fremd }));
    expect(zeile(v.steuerung, 'Freigabe')).toBeUndefined();
    expect(zeile(v.steuerung, 'Not-Aus an der Box')).toBeUndefined();
  });

  it('nennt die Regeln, die eine Komponente dieses Geräts anfassen', () => {
    const v = geraetSeite(
      input({
        geraetId: 'inverter',
        strategies: { 'ent-batt': [{ flowId: 'f1', flowName: 'Speicher schützen' }] },
      }),
    );
    expect(zeile(v.steuerung, 'Regeln, die dieses Gerät nutzen')?.wert).toBe('Speicher schützen');
  });

  it('nennt den Einspeise-Wächter nur an einem ERZEUGENDEN Gerät', () => {
    const guard: CurtailmentStatus = {
      deviceId: 'dev-box',
      units: 2,
      certifiedUnits: 2,
      controlEnabled: true,
      active: false,
      appliedCapKw: null,
      allMatch: null,
      possibleOverride: false,
      checkedAt: FRISCH,
      exportGuard: {
        limitKw: 70,
        state: 'ueberwacht',
        reason: null,
        capKw: null,
        limiting: false,
        blind: false,
        effective: true,
        reach: null,
      },
      deviceExportLimit: null,
    };
    const mitPv = geraetSeite(input({ geraetId: 'src-7c1e9a2b', curtailment: guard }));
    expect(zeile(mitPv.steuerung, 'Einspeise-Wächter')?.wert).toMatch(/überwacht 70,0/);

    // Ein Gerät ohne PV-Komponente bekommt den Satz nicht - er wäre eine
    // Aussage über ein fremdes Gerät.
    const nurNetz: SiteEntity = {
      ...PRODUCER,
      id: 'ent-meter',
      entityType: 'grid-meter',
      role: 'grid',
      label: 'Netzanschluss',
      capabilities: { measure: [{ channel: 'power_kw' }] },
    };
    const ohnePv = geraetSeite(
      input({
        geraetId: 'src-7c1e9a2b',
        curtailment: guard,
        entities: [nurNetz],
        model: plantModel([nurNetz], null, LOCAL_SETUP, SOURCES),
      }),
    );
    expect(zeile(ohnePv.steuerung, 'Einspeise-Wächter')).toBeUndefined();
  });
});

describe('geraetSeite · H Software und I Diagnose', () => {
  it('sagt ehrlich, dass ein Modbus-Gerät seine Firmware nicht meldet', () => {
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    expect(zeile(v.software, 'Firmware des Geräts')?.wert).toBe('liest Ihre Box nicht aus');
  });

  it('führt in der Diagnose die Rohkanäle und die Kennung auf der Box', () => {
    const v = geraetSeite(input({ geraetId: 'inverter' }));
    expect(zeile(v.diagnose, 'Kennung auf der Box')?.wert).toBe('inverter');
    expect(zeile(v.diagnose, 'Rohkanäle')?.wert).toContain('soc_pct');
  });
});

describe('geraetSeite · die Ladesäule', () => {
  const charging: SiteCharging = {
    budget: null,
    chargers: [
      {
        deviceId: 'dev-box',
        chargePointId: 'CARPORT-1',
        label: 'Ladepunkt „Carport"',
        priority: false,
        connected: true,
        vendor: 'ABL',
        model: 'eMH2',
        firmware: '1.4.2',
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

  it('kennt die Säule unter ihrer cp-Kennung', () => {
    expect(chargerGeraetId('CARPORT-1')).toBe('cp-CARPORT-1');
    expect(chargePointIdOf('cp-CARPORT-1')).toBe('CARPORT-1');
    expect(chargePointIdOf('src-abc')).toBeNull();
    expect(chargePointIdOf(null)).toBeNull();
  });

  it('zeigt Stecker statt Modbus-Werte und nennt OCPP als Anbindung', () => {
    const v = geraetSeite(input({ geraetId: 'cp-CARPORT-1', charging }));
    expect(v.art).toBe('ladepunkt');
    expect(v.kopf.titel).toBe('Ladepunkt „Carport"');
    expect(zeile(v.verbindung, 'Anbindung')?.wert).toMatch(/OCPP/);
    expect(v.live.map((k) => k.label)).toEqual(['Stecker 1', 'Stecker 2']);
    expect(v.live[0].wort).toBe('lädt');
    expect(v.live[1].wert).toBe('—');
    expect(zeile(v.software, 'Firmware der Säule')?.wert).toBe('1.4.2');
  });

  it('nennt die OCPP-Kennung, nie unser internes cp-Präfix', () => {
    const v = geraetSeite(input({ geraetId: 'cp-CARPORT-1', charging }));
    expect(v.kopf.kennung).toBe('CARPORT-1');
    // Eine Säule trägt keine Komponenten-Konfiguration - also behauptet die
    // Seite auch keinen Pflege-Ort für sie.
    expect(v.kopf.pflegeOrt).toBeNull();
  });

});

// ============================================================================
// P4 - „BMS": was das Gerät über eine per CAN GEKOPPELTE Batterie meldet
// ============================================================================
// Der Block existiert nur, wenn die Kopplung besteht. Heute besteht sie an
// KEINER Anlage (der Deye läuft im Spannungsmodus und antwortet auf die
// BMS-Register mit lauter Nullen), also ist „keine Zeile" der Normalfall -
// und ausdrücklich nicht „0 %".
describe('geraetSeite · BMS (P4)', () => {
  const mitBms = (bms: Record<string, number> | null | undefined): SiteSource[] =>
    SOURCES.map((s) => (s.sourceId === 'inverter' ? { ...s, bms } : s));

  it('bleibt LEER, solange keine Batterie per CAN gekoppelt ist', () => {
    expect(geraetSeite(input({ geraetId: 'inverter' })).bms).toEqual([]);
    expect(geraetSeite(input({ geraetId: 'inverter', sources: mitBms(null) })).bms).toEqual([]);
    // Auch ein leeres Objekt ist keine Kopplung - es entsteht keine Zeile.
    expect(geraetSeite(input({ geraetId: 'inverter', sources: mitBms({}) })).bms).toEqual([]);
  });

  it('zeigt Ladestand, Messwerte, beide Grenzpaare und die Codes', () => {
    const v = geraetSeite(input({
      geraetId: 'inverter',
      sources: mitBms({
        bms_soc_pct: 47, bms_voltage_v: 642, bms_current_a: -30,
        bms_charge_limit_a: 270, bms_discharge_limit_a: 342,
        bms_max_charge_limit_a: 400, bms_max_discharge_limit_a: 500,
        bms_charge_voltage_v: 736, bms_discharge_voltage_v: 574,
        bms_alarm: 0, bms_fault: 0, bms_type: 10,
      }),
    }));
    expect(zeile(v.bms, 'Ladestand laut BMS')?.wert).toMatch(/^47/);
    expect(zeile(v.bms, 'Strom')?.wert).toMatch(/^-30,0/);
    // Zwei GETRENNTE Paare: „gerade erlaubt" ist nicht „Maximum des Speichers".
    expect(zeile(v.bms, 'Erlaubt gerade')?.wert).toMatch(/270.*laden.*342.*abgeben/);
    expect(zeile(v.bms, 'Maximum des Speichers')?.wert).toMatch(/400.*laden.*500.*abgeben/);
    expect(zeile(v.bms, 'Spannungsfenster')?.wert).toMatch(/574,0.*bis.*736,0/);
    expect(zeile(v.bms, 'Alarm')?.wert).toBe('keiner gemeldet');
    expect(zeile(v.bms, 'BMS-Protokoll')?.wert).toBe('Shenggao Electric CAN');
  });

  it('zeigt einen Alarm-Code als CODE - es wird nichts gedeutet', () => {
    const v = geraetSeite(input({
      geraetId: 'inverter',
      sources: mitBms({ bms_alarm: 4, bms_fault: 0 }),
    }));
    const alarm = zeile(v.bms, 'Alarm');
    expect(alarm?.wert).toBe('Code 4');
    expect(alarm?.ton).toBe('warn');
    expect(zeile(v.bms, 'Fehler')?.ton).toBe('ok');
  });

  it('löst eine unbekannte BMS-Kennung NICHT auf einen Vorgabewert auf', () => {
    const v = geraetSeite(input({ geraetId: 'inverter', sources: mitBms({ bms_type: 42 }) }));
    expect(zeile(v.bms, 'BMS-Protokoll')?.wert).toBe('Kennung 42');
  });

  it('füllt einen fehlenden Kanal NICHT auf - er fehlt einfach', () => {
    const v = geraetSeite(input({ geraetId: 'inverter', sources: mitBms({ bms_soc_pct: 47 }) }));
    expect(v.bms.map((z) => z.label)).toEqual(['Ladestand laut BMS']);
  });

  it('nennt eine halbe Grenze halb - der fehlende Teil ist —, nie eine 0', () => {
    const v = geraetSeite(input({
      geraetId: 'inverter',
      sources: mitBms({ bms_charge_limit_a: 270 }),
    }));
    expect(zeile(v.bms, 'Erlaubt gerade')?.wert).toMatch(/270.*laden.*—.*abgeben/);
  });
});
