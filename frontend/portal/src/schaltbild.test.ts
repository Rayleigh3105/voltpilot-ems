import { describe, expect, it } from 'vitest';
import {
  BREITE,
  LUECKE_CT,
  LUECKE_LAN,
  LUECKE_WEG,
  SCHALTBILD_LEER,
  WEG_UNBEKANNT,
  schaltbild,
  type SchaltbildInput,
} from './schaltbild';
import { plantModel } from './komponenten';
import type {
  ControlStatus,
  CurtailmentStatus,
  Device,
  EdgeVersion,
  EntityLocalSetup,
  SiteEntity,
  SiteSource,
} from './api';
import type { SiteCharging } from './ladepunkte';

/**
 * Die Pilsting-Konstellation als EINE Vorlage - eine VoltPilot-Box, ein
 * Deye-Hybrid, ZWEI Fronius hinter EINER Adresse (der belegte
 * Datamanager-Fall), eine Säule und ein neu gemeldetes Gerät. Jeder Test
 * verändert daran genau das, was er prüft.
 */
const NOW = Date.parse('2026-08-21T13:24:24Z');
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

const GRID: SiteEntity = {
  id: 'ent-grid',
  entityType: 'grid-meter',
  typeLabel: 'Netzanschluss',
  role: 'grid',
  label: 'Netzanschluss',
  control: false,
  deviceId: 'dev-box',
  capabilities: { measure: [{ channel: 'power_kw' }] },
  guards: null,
  syncStatus: 'in_sync',
  observed: null,
  edgeSourceId: null,
};

const PV1: SiteEntity = {
  id: 'ent-pv1',
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
  edgeSourceId: 'src-fronius-1',
};

const PV2: SiteEntity = {
  ...PV1,
  id: 'ent-pv2',
  label: 'Fronius Anlage WR2',
  edgeSourceId: 'src-fronius-2',
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
    communication: 'solarman_v5',
    family: 'hybrid_3p',
    host: '192.168.254.210',
    port: 8899,
    unitId: 1,
    serial: '2985159064',
    intervalS: 5,
  },
  {
    id: 'src-fronius-1',
    kind: 'source',
    role: 'pv-generation',
    brand: 'fronius_sunspec',
    model: 'Eco 27.0-3-S',
    label: null,
    reportedAt: FRISCH,
    adoptedEntityId: 'ent-pv1',
    communication: 'fronius_sunspec',
    family: 'sunspec_live',
    host: '192.168.210.40',
    port: 502,
    unitId: 1,
    serial: null,
    intervalS: 5,
  },
  {
    id: 'src-fronius-2',
    kind: 'source',
    role: 'pv-generation',
    brand: 'fronius_sunspec',
    model: 'Eco 27.0-3-S',
    label: null,
    reportedAt: FRISCH,
    adoptedEntityId: 'ent-pv2',
    communication: 'fronius_sunspec',
    family: 'sunspec_live',
    host: '192.168.210.40',
    port: 502,
    unitId: 2,
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
    sourceId: 'src-fronius-1',
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
  {
    deviceId: 'dev-box',
    sourceId: 'src-fronius-2',
    kind: 'source',
    role: 'pv-generation',
    label: null,
    brand: 'fronius_sunspec',
    model: 'Eco 27.0-3-S',
    pvKw: 23.5,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: FRISCH,
    reportedAt: FRISCH,
  },
];

const CHARGING: SiteCharging = {
  budget: null,
  chargers: [
    {
      deviceId: 'dev-box',
      chargePointId: 'CARPORT-1',
      label: 'Carport',
      priority: false,
      connected: true,
      vendor: 'ABL',
      model: 'eMH2',
      firmware: '1.8',
      ready: true,
      note: null,
      lastSeen: FRISCH,
      entityId: null,
      reportedAt: FRISCH,
      connectors: [
        { connectorId: 1, status: 'Charging', charging: true, powerKw: 11 },
        { connectorId: 2, status: 'Available', charging: false, powerKw: null },
      ],
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

const CURTAILMENT: CurtailmentStatus = {
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
    reason: 'Der Wächter überwacht die Einspeisung.',
    capKw: null,
    limiting: false,
    blind: false,
    effective: true,
    reach: null,
  },
  deviceExportLimit: { limitKw: 70, register: '0x00e7', readAt: FRISCH },
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

function input(over: Partial<SchaltbildInput> = {}): SchaltbildInput {
  const entities = over.entities === undefined ? [HYBRID, GRID, PV1, PV2] : over.entities;
  const localSetup = over.localSetup ?? LOCAL_SETUP;
  const sources = over.sources ?? SOURCES;
  return {
    siteId: 'site-1',
    siteName: 'Pilsting',
    model: plantModel(entities as SiteEntity[], null, localSetup, sources),
    devices: [BOX],
    devicesFetchedAt: NOW,
    boxRef: 'edge-45gz7da',
    localSetup,
    sources,
    charging: CHARGING,
    control: CONTROL,
    curtailment: CURTAILMENT,
    edgeVersions: EDGE,
    maxFeedInKw: 70,
    now: NOW,
    ...over,
  } as SchaltbildInput;
}

/** Der Knoten mit dieser Kennung - auch als Untereinheit eines Containers. */
function knoten(bild: ReturnType<typeof schaltbild>, id: string) {
  const flach = bild.knoten.flatMap((k) => [k, ...k.einheiten]);
  return flach.find((k) => k.id === id);
}

const kanteVon = (bild: ReturnType<typeof schaltbild>, id: string) =>
  bild.kanten.find((k) => k.id === id);

describe('schaltbild · Knoten und Spalten', () => {
  it('zeichnet Cloud, Box, Geräte, Komponenten und den Netzanschlusspunkt', () => {
    const b = schaltbild(input());
    expect(b.leer).toBeNull();
    expect(b.spalten.map((s) => s.titel)).toEqual([
      'VOLTPILOT',
      'IHRE BOX',
      'WEGE',
      'GERÄTE',
      'KOMPONENTEN',
      'NETZ',
    ]);
    expect(knoten(b, 'cloud')?.titel).toBe('VoltPilot');
    expect(knoten(b, 'box')?.titel).toBe('VoltPilot-Box Pilsting');
    expect(knoten(b, 'netz')?.titel).toBe('Netzanschlusspunkt');
    expect(b.breite).toBe(BREITE);
    expect(b.hoehe).toBeGreaterThan(0);
  });

  it('führt mit dem HAUPTGERÄT und zeigt seine Adresse samt Logger-Nummer', () => {
    const b = schaltbild(input());
    const geraete = b.knoten.filter((k) => k.art === 'geraet' || k.art === 'gateway');
    expect(geraete[0].titel).toContain('Deye');
    const zeilen = geraete[0].zeilen.map((z) => z.text);
    expect(zeilen.some((t) => t.includes('192.168.254.210 : 8899'))).toBe(true);
    expect(zeilen.some((t) => t.includes('Logger 2985159064'))).toBe(true);
    expect(zeilen.some((t) => t.includes('alle 5 s'))).toBe(true);
  });

  it('sagt bei einer Anlage ohne Gerät ehrlich, dass es nichts zu zeichnen gibt', () => {
    const b = schaltbild(input({ entities: [], localSetup: [], sources: [], charging: null }));
    expect(b.leer).toBe(SCHALTBILD_LEER);
    expect(b.knoten).toEqual([]);
    expect(b.kanten).toEqual([]);
  });
});

describe('schaltbild · zwei Einheiten hinter EINER Adresse', () => {
  it('fasst sie zu EINEM Kästchen mit zwei Unter-Einheiten zusammen', () => {
    const b = schaltbild(input());
    const gw = b.knoten.find((k) => k.art === 'gateway');
    expect(gw).toBeTruthy();
    expect(gw!.titel).toContain('Fronius');
    expect(gw!.einheiten.map((e) => e.id)).toEqual(['src-fronius-1', 'src-fronius-2']);
    // Die Adresse steht EINMAL am Container, nicht zweimal.
    expect(gw!.zeilen.map((z) => z.text).join(' ')).toContain('192.168.210.40 : 502');
    expect(b.knoten.filter((k) => k.id === 'src-fronius-1')).toHaveLength(0);
  });

  it('lässt zwei Meldungen mit IDENTISCHER Einheit getrennt - das wäre keine Aussage', () => {
    const local = LOCAL_SETUP.map((l) =>
      l.id === 'src-fronius-2' ? { ...l, unitId: 1 } : l,
    );
    const b = schaltbild(input({ localSetup: local }));
    expect(b.knoten.some((k) => k.art === 'gateway')).toBe(false);
    expect(knoten(b, 'src-fronius-1')).toBeTruthy();
    expect(knoten(b, 'src-fronius-2')).toBeTruthy();
  });

  it('zieht die Mess-Kante von der EINHEIT, nicht vom Container-Rand', () => {
    const b = schaltbild(input());
    const gw = b.knoten.find((k) => k.art === 'gateway')!;
    const kante = kanteVon(b, `misst:${gw.id}:ent-pv2`);
    const einheit = gw.einheiten.find((e) => e.id === 'src-fronius-2')!;
    expect(kante?.y1).toBeCloseTo(einheit.y + einheit.h / 2, 5);
  });
});

describe('schaltbild · Wege und Bezüge sind UNTERSCHEIDBAR', () => {
  it('beschriftet den Weg mit dem Transport und zieht ihn von der Box zum Gerät', () => {
    const b = schaltbild(input());
    const weg = kanteVon(b, 'weg:inverter')!;
    expect(weg.art).toBe('weg');
    expect(weg.label).toBe('Solarman V5');
    expect(weg.x1).toBeLessThan(weg.x2);
    expect(weg.rolle).toBeNull();
  });

  it('dreht die OCPP-Kante um - die Säule wählt die Box an', () => {
    const b = schaltbild(input());
    const ocpp = kanteVon(b, 'weg:cp-CARPORT-1')!;
    expect(ocpp.art).toBe('ocpp');
    expect(ocpp.label).toBe('OCPP 1.6J');
    expect(ocpp.x1).toBeGreaterThan(ocpp.x2);
  });

  it('unterscheidet MESSEN von STEUERN und nennt die Rolle als Farbe', () => {
    const b = schaltbild(input());
    const speicher = kanteVon(b, 'misst:inverter:ent-batt')!;
    expect(speicher.art).toBe('steuert');
    expect(speicher.rolle).toBe('storage');
    const netz = kanteVon(b, 'misst:inverter:ent-grid')!;
    expect(netz.art).toBe('misst');
    expect(netz.rolle).toBe('grid');
  });

  it('nennt jede gezeichnete Linien-Art auch als WORT in der Legende', () => {
    const b = schaltbild(input());
    const arten = new Set(b.kanten.map((k) => k.art));
    for (const l of b.legende) expect(arten.has(l.art)).toBe(true);
    expect(b.legende.some((l) => l.art === 'misst')).toBe(true);
    expect(b.legende.some((l) => l.art === 'steuert')).toBe(true);
  });
});

describe('schaltbild · die ⚡-Regel wird nie geraten', () => {
  it('macht aus der Abregelung KEINE Erzeuger-Kante - die Freigabe zählt EINHEITEN', () => {
    // Die Rückmeldung sagt „2 von 2 freigegeben", nicht WELCHE zwei. Ein ⚡ an
    // einem Erzeuger wäre damit eine geratene Zusage über eine Kundenanlage.
    const b = schaltbild(input());
    const gw = b.knoten.find((k) => k.art === 'gateway')!;
    expect(kanteVon(b, `misst:${gw.id}:ent-pv1`)!.art).toBe('misst');
    expect(b.kanten.every((k) => k.label !== '⚡ Abregelung')).toBe(true);
    // Der Stand steht dort, wo die Einspeisegrenze wohnt - als Zahl.
    const netz = knoten(b, 'netz')!.zeilen.map((z) => z.text);
    expect(netz).toContain('Abregelung: 2 von 2 freigegeben');
  });

  it('nennt eine TEIL-Freigabe als Zahl UND als Lücke', () => {
    const b = schaltbild(input({ curtailment: { ...CURTAILMENT, certifiedUnits: 0 } }));
    const zeile = knoten(b, 'netz')!.zeilen.find((z) => z.text.startsWith('Abregelung'))!;
    expect(zeile.text).toBe('Abregelung: 0 von 2 freigegeben');
    expect(zeile.ton).toBe('warn');
    expect(b.luecken.some((l) => l.includes('nur teilweise begrenzen'))).toBe(true);
  });

  it('steuert den Speicher nur bei freigegebener UND eingeschalteter Steuerung', () => {
    const b = schaltbild(input({ control: { ...CONTROL, controlEnabled: false } }));
    expect(kanteVon(b, 'misst:inverter:ent-batt')!.art).toBe('misst');
  });

  it('markiert ein NEUES Gerät als eigene Linien-Art, nie als „Weg unbekannt"', () => {
    const local = [
      ...LOCAL_SETUP,
      {
        id: 'src-shelly',
        kind: 'source',
        role: 'consumer',
        brand: 'shelly',
        model: 'Plus 1PM',
        label: null,
        reportedAt: FRISCH,
        adoptedEntityId: null,
      } as EntityLocalSetup,
    ];
    const b = schaltbild(input({ localSetup: local }));
    const neu = b.knoten.find((k) => k.art === 'neu')!;
    expect(kanteVon(b, `weg:${neu.id}`)!.art).toBe('neu');
    // … und die „Weg unbekannt"-Lücke gilt ihm ausdrücklich NICHT.
    expect(b.luecken).not.toContain(LUECKE_WEG);
  });
});

describe('schaltbild · Lücken werden BENANNT, nie gefüllt', () => {
  it('nennt die eigene LAN-Adresse der Box und den Einbauort des Zählers', () => {
    const b = schaltbild(input());
    expect(b.luecken).toContain(LUECKE_LAN);
    expect(b.luecken).toContain(LUECKE_CT);
    const box = knoten(b, 'box')!;
    expect(box.zeilen.some((z) => z.text.includes('LAN-Adresse'))).toBe(true);
  });

  it('zeigt die Adresse IM Bild, sobald die Box eine meldet - und die Lücke ist weg (D5)', () => {
    const b = schaltbild(
      input({
        devices: [
          { ...BOX, lanHost: '192.168.254.51:8484', lanSeenAt: FRISCH, lanSource: 'erreicht' },
        ],
      }),
    );
    const box = knoten(b, 'box')!;
    expect(box.zeilen.some((z) => z.text === 'erreichbar über 192.168.254.51:8484')).toBe(true);
    expect(b.luecken).not.toContain(LUECKE_LAN);
    // Der Einbauort des Zählers bleibt eine Lücke - er ist nirgends erfasst.
    expect(b.luecken).toContain(LUECKE_CT);
  });

  it('markiert ein Gerät ohne gemeldeten Weg als unbekannt, statt einen zu erfinden', () => {
    const local = LOCAL_SETUP.map((l) =>
      l.id === 'inverter'
        ? { ...l, communication: null, host: null, port: null, serial: null, intervalS: null }
        : l,
    );
    const b = schaltbild(input({ localSetup: local }));
    const weg = kanteVon(b, 'weg:inverter')!;
    expect(weg.art).toBe('unbekannt');
    expect(weg.label).toBe(WEG_UNBEKANNT);
    expect(b.luecken).toContain(LUECKE_WEG);
  });

  it('zeigt ein NEUES Gerät gestrichelt und ohne Weg in eine Komponente', () => {
    const local = [
      ...LOCAL_SETUP,
      {
        id: 'src-shelly',
        kind: 'source',
        role: 'consumer',
        brand: 'shelly',
        model: 'Plus 1PM',
        label: null,
        reportedAt: FRISCH,
        adoptedEntityId: null,
      } as EntityLocalSetup,
    ];
    const b = schaltbild(input({ localSetup: local }));
    const neu = b.knoten.find((k) => k.art === 'neu')!;
    expect(neu.gestrichelt).toBe(true);
    expect(neu.href).toBeNull();
    expect(b.kanten.some((k) => k.id.startsWith(`misst:${neu.id}`))).toBe(false);
  });

  it('behauptet ohne gepflegte Einspeisegrenze keine', () => {
    const b = schaltbild(input({ maxFeedInKw: null, curtailment: null }));
    const netz = knoten(b, 'netz')!;
    const texte = netz.zeilen.map((z) => z.text);
    expect(texte.some((t) => t.includes('keine Einspeisegrenze hinterlegt'))).toBe(true);
    expect(texte.some((t) => t.includes('noch nicht gelesen'))).toBe(true);
  });

  it('markiert eine abweichende Geräte-Grenze, statt sie zu verschweigen', () => {
    const b = schaltbild(
      input({
        curtailment: {
          ...CURTAILMENT,
          deviceExportLimit: { limitKw: 33, register: '0x00e7', readAt: FRISCH },
        },
      }),
    );
    const zeile = knoten(b, 'netz')!.zeilen.find((z) => z.text.startsWith('Gerät meldet'))!;
    expect(zeile.text).toContain('⚠');
    expect(zeile.ton).toBe('warn');
  });
});

describe('schaltbild · Klickziele', () => {
  it('führt Box, Gerät, Einheit und Säule auf ihre Seite', () => {
    const b = schaltbild(input());
    // Die BOX ist ein TOR, kein Gerät: sie hat eine eigene Adresse (E3).
    expect(knoten(b, 'box')?.href).toBe('#/anlage/site-1/box/edge-45gz7da');
    expect(knoten(b, 'inverter')?.href).toBe('#/anlage/site-1/geraet/edge-45gz7da/inverter');
    expect(knoten(b, 'src-fronius-2')?.href).toBe(
      '#/anlage/site-1/geraet/edge-45gz7da/src-fronius-2',
    );
    expect(knoten(b, 'cp-CARPORT-1')?.href).toBe(
      '#/anlage/site-1/geraet/edge-45gz7da/cp-CARPORT-1',
    );
  });

  it('bietet OHNE eindeutige Box gar keinen Weg an, statt einen zu raten', () => {
    const b = schaltbild(input({ boxRef: null }));
    for (const k of b.knoten.flatMap((x) => [x, ...x.einheiten])) expect(k.href).toBeNull();
  });

  it('gibt jeder Komponente ihre Zeilen-Kennung als Sprungziel', () => {
    const b = schaltbild(input());
    const komp = b.knoten.filter((k) => k.art === 'komponente');
    expect(komp.length).toBeGreaterThan(0);
    for (const k of komp) expect(k.komponenteId).toBeTruthy();
  });
});

describe('schaltbild · Geometrie', () => {
  it('hält JEDES Kästchen innerhalb der Bildbreite und -höhe', () => {
    const b = schaltbild(input());
    for (const k of b.knoten.flatMap((x) => [x, ...x.einheiten])) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x + k.w).toBeLessThanOrEqual(b.breite);
      expect(k.y).toBeGreaterThanOrEqual(0);
      expect(k.y + k.h).toBeLessThanOrEqual(b.hoehe);
    }
  });

  it('lässt kein Kästchen einer Spalte ein anderes überlappen', () => {
    const b = schaltbild(input());
    const geraete = b.knoten
      .filter((k) => k.art === 'geraet' || k.art === 'gateway' || k.art === 'ladepunkt' || k.art === 'neu')
      .sort((a, c) => a.y - c.y);
    for (let i = 1; i < geraete.length; i += 1) {
      expect(geraete[i].y).toBeGreaterThanOrEqual(geraete[i - 1].y + geraete[i - 1].h);
    }
  });

  it('ist deterministisch - zweimal dieselbe Eingabe, zweimal dasselbe Bild', () => {
    expect(JSON.stringify(schaltbild(input()))).toBe(JSON.stringify(schaltbild(input())));
  });
});
