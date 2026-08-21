import { describe, expect, it } from 'vitest';
import {
  boxGeraeteListe,
  boxSeite,
  grenzenZeilen,
  softwareKachel,
  type BoxSeiteInput,
} from './boxSeite';
import { LAN_UNBEKANNT } from './geraetSeite';
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
 * Die BOX-Seite als reine Ableitung (Geräteseiten Stufe 1, Gattung A).
 *
 * Dieselbe Pilsting-Konstellation wie in `geraetSeite.test.ts` - die Box, ihr
 * Deye-Hybrid und die übernommene Fronius-Quelle -, hier aber aus der Sicht des
 * TORS: verbunden? welche Software? unter welcher Adresse? und was hängt daran?
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


function input(over: Partial<BoxSeiteInput> = {}): BoxSeiteInput {
  return {
    ref: 'edge-45gz7da',
    siteName: 'Pilsting',
    siteId: 'site-1',
    devices: [BOX],
    devicesFetchedAt: NOW,
    edgeVersions: EDGE,
    control: CONTROL,
    curtailment: null,
    geraete: boxGeraeteListe(LOCAL_SETUP, SOURCES, null, NOW),
    now: NOW,
    ...over,
  };
}

const kachel = (v: ReturnType<typeof boxSeite>, key: string) =>
  v.kacheln.find((k) => k.key === key)!;

const zeile = (rows: { label: string; wert: string; detail?: string | null }[], label: string) =>
  rows.find((r) => r.label === label);

describe('boxSeite · Identität', () => {
  it('nennt die Box beim Namen und trägt ihre Kennung', () => {
    const v = boxSeite(input());
    expect(v.gefunden).toBe(true);
    expect(v.titel).toBe('VoltPilot-Box Pilsting');
    expect(v.kennung).toBe('edge-45gz7da');
    expect(v.unterzeile).toContain('Pilsting');
  });

  it('löst die EINE Box der Anlage auch ohne Referenz auf', () => {
    // Eine Anlage hat per Captain-Korrektur genau EINE Box; die Adresse muss
    // sie deshalb nicht tragen (`#/anlage/{id}/box`).
    expect(boxSeite(input({ ref: null })).titel).toBe('VoltPilot-Box Pilsting');
  });

  it('nennt den GRUND, wenn die Referenz keine Box dieser Anlage ist', () => {
    const v = boxSeite(input({ ref: 'edge-fremd' }));
    expect(v.gefunden).toBe(false);
    expect(v.grund).toMatch(/keine VoltPilot-Box/);
    expect(v.kacheln).toEqual([]);
  });

  it('misst die BOX gegen ihre Telemetrie, nie gegen eine laufende Uhr', () => {
    const v = boxSeite(input());
    expect(v.zustand.wort).toBe('verbunden');
    expect(v.zustand.ton).toBe('ok');
    // Ein STEHENDER Schnappschuss altert nicht weiter: die Bezugszeit ist die
    // Antwortzeit des Servers (die `liveness.ts`-Lehre).
    const spaeter = boxSeite(input({ now: NOW + 30 * 60_000 }));
    expect(spaeter.zustand.wort).toBe('verbunden');
  });
});

describe('boxSeite · die drei Kacheln', () => {
  it('führt mit Verbindung, Software und der Adresse im Netzwerk', () => {
    const v = boxSeite(input());
    expect(v.kacheln.map((k) => k.key)).toEqual(['verbindung', 'software', 'netzwerk']);
    expect(kachel(v, 'verbindung').wert).toBe('verbunden');
    expect(kachel(v, 'verbindung').satz).toMatch(/von außen ist sie nicht erreichbar/);
  });

  it('sagt ehrlich, dass die Box ihre eigene Adresse noch nicht meldet', () => {
    const k = kachel(boxSeite(input()), 'netzwerk');
    expect(k.wert).toBe(LAN_UNBEKANNT);
    // ⚠ Ein Weg wird nur angeboten, wo er BELEGT ist.
    expect(k.url).toBeNull();
  });

  it('bietet die lokale Oberfläche NUR bei einer BEWIESENEN Adresse an (D5)', () => {
    const erreicht = kachel(
      boxSeite(input({
        devices: [{
          ...BOX,
          lanHost: '192.168.254.51',
          lanSeenAt: new Date(NOW - 60_000).toISOString(),
          lanSource: 'erreicht',
        }],
      })),
      'netzwerk',
    );
    expect(erreicht.wert).toBe('192.168.254.51');
    expect(erreicht.url).toBe('http://192.168.254.51');
    expect(erreicht.satz).toMatch(/zuletzt erreicht/);

    // Die SCHWÄCHERE Schnittstellen-Adresse sagt, WO die Box steckt - nicht,
    // dass dort etwas antwortet. Also kein Weg dorthin.
    const gemeldet = kachel(
      boxSeite(input({
        devices: [{
          ...BOX, lanHost: '192.168.0.31', lanSeenAt: FRISCH, lanSource: 'schnittstelle',
        }],
      })),
      'netzwerk',
    );
    expect(gemeldet.wert).toBe('192.168.0.31');
    expect(gemeldet.url).toBeNull();
    expect(gemeldet.satz).toMatch(/sagt erst ein Aufruf/);
  });
});

describe('boxSeite · der Software-Stand', () => {
  const edge = (over: Partial<EdgeVersion>): EdgeVersion => ({
    deviceId: 'dev-box', siteId: 'site-1', coreVersion: 'edge-2026.08.10',
    paletteVersion: '0.9.0', reportedAt: FRISCH, ...over,
  });

  it('sagt „aktuell", wenn die Box den Soll-Stand fährt', () => {
    const k = softwareKachel(edge({ newestRelease: 'edge-2026.08.10', upToDate: true }));
    expect(k.ton).toBe('ok');
    expect(k.satz).toMatch(/neuesten Stand/);
  });

  it('nennt den neueren Stand - und sagt, dass der Kunde nichts tun muss', () => {
    const k = softwareKachel(edge({ newestRelease: 'edge-2026.08.11', upToDate: false }));
    expect(k.ton).toBe('warn');
    expect(k.satz).toContain('edge-2026.08.11');
    expect(k.satz).toMatch(/müssen nichts tun/);
  });

  it('⚠ macht aus „nicht bewertbar" NIE ein „veraltet"', () => {
    // Nicht registriert: eine Lücke im REGISTER, keine Alters-Aussage.
    const offen = softwareKachel(edge({
      coreVersion: '665d59b8c0de', newestRelease: 'edge-2026.08.11', upToDate: null,
    }));
    expect(offen.ton).toBe('off');
    expect(offen.satz).toMatch(/lässt sich daraus nicht sagen/);
    expect(offen.satz).not.toMatch(/veraltet\b(?!.*bewertet)/);

    // Leeres Register: ohne Maßstab wird gar nichts bewertet.
    const ohne = softwareKachel(edge({ newestRelease: null, upToDate: null }));
    expect(ohne.ton).toBe('off');
    expect(ohne.satz).toMatch(/noch nicht hinterlegt/);
  });

  it('trennt Tag und Build - aber eine nackte SHA bleibt VERBATIM', () => {
    expect(softwareKachel(edge({
      coreVersion: 'edge-2026.08.10-9b37439a02c1',
      newestRelease: 'edge-2026.08.10',
      upToDate: true,
    })).wert).toBe('edge-2026.08.10 (Build 9b37439a)');
    expect(softwareKachel(edge({ coreVersion: '665d59b8c0de' })).wert).toBe('665d59b8c0de');
  });

  it('sagt „meldet keinen Stand" statt eine Version zu erfinden', () => {
    expect(softwareKachel(edge({ coreVersion: null }).newestRelease === undefined
      ? edge({ coreVersion: null })
      : edge({ coreVersion: null })).wert).toBe('meldet keinen Stand');
    expect(softwareKachel(null).ton).toBe('off');
  });
});

describe('boxSeite · die Geräte an ihr', () => {
  it('listet jedes gemeldete Gerät mit seiner Art und seinem Zustand', () => {
    const v = boxSeite(input());
    expect(v.geraete.map((g) => g.geraetId)).toEqual(['inverter', 'src-7c1e9a2b']);
    expect(v.geraete[0].name).toBe('Deye SUN-30K');
    expect(v.geraete[0].art).toBe('Hauptgerät');
    expect(v.geraete[1].art).toBe('PV-Wechselrichter');
    expect(v.geraeteLeer).toBeNull();
  });

  it('reiht eine OCPP-Säule ein', () => {
    const geraete = boxGeraeteListe(LOCAL_SETUP, SOURCES, [{
      deviceId: 'dev-box', chargePointId: 'CARPORT-1', label: 'Ladepunkt „Carport"',
      priority: false, connected: true, vendor: 'ABL', model: 'eMH2', firmware: '1.4.2',
      ready: true, lastSeen: FRISCH, reportedAt: FRISCH, connectors: [],
    }], NOW);
    expect(geraete.map((g) => g.geraetId)).toContain('cp-CARPORT-1');
  });

  it('sagt es, wenn sich noch kein Gerät gemeldet hat', () => {
    const v = boxSeite(input({ geraete: [] }));
    expect(v.geraeteLeer).toMatch(/noch kein Gerät/);
  });
});

describe('boxSeite · Schutz & Grenzen', () => {
  it('nennt nur, was BELEGT ist', () => {
    const v = boxSeite(input());
    // Ohne Wächter-Block und mit einem Steuer-Beleg der Box: nur der Not-Aus.
    expect(v.grenzen.map((z) => z.label)).toEqual(['Not-Aus']);
    expect(zeile(v.grenzen, 'Not-Aus')?.wert).toMatch(/darf steuern/);
  });

  it('behauptet ohne jede Meldung GAR KEINE Grenze - und sagt das', () => {
    const v = boxSeite(input({ control: null }));
    expect(v.grenzen).toEqual([]);
    expect(v.grenzenLeer).toMatch(/meldet die Box gerade nichts/);
  });

  it('⚠ nimmt einen Beleg nur an, wenn er DIESER Box gehört', () => {
    // Die `eigenerBeleg`-Regel: eine Anlage kann mehrere Geräte haben.
    const fremd = grenzenZeilen({ ...CONTROL, deviceId: 'anderes-geraet' }, null, 'dev-box');
    expect(fremd).toEqual([]);
  });

  it('nennt den Einspeise-Wächter samt seiner Reichweite', () => {
    const curtailment = {
      deviceId: 'dev-box',
      units: 2, certifiedUnits: 0, controlEnabled: true, active: false,
      appliedCapKw: null, allMatch: null, possibleOverride: false, checkedAt: FRISCH,
      exportGuard: {
        limitKw: 70, state: 'ok', reason: null, capKw: null, limiting: false,
        blind: false, effective: false,
        reach: 'kein freigegebener Wechselrichter - die Begrenzung erreicht gerade kein Gerät',
      },
      deviceExportLimit: null,
    } as unknown as CurtailmentStatus;
    const rows = grenzenZeilen(CONTROL, curtailment, 'dev-box');
    const z = zeile(rows, 'Einspeise-Begrenzung')!;
    expect(z.wert).toContain('70');
    // Der SATZ der Box wird durchgereicht, nie neu formuliert.
    expect(z.detail).toMatch(/erreicht gerade kein Gerät/);
    expect(z.ton).toBe('warn');
  });
});
