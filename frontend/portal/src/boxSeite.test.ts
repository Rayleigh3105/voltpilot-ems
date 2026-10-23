import { describe, expect, it } from 'vitest';
import {
  boxSeite,
  grenzenZeilen,
  KEINE_GERAETE,
  softwareKachel,
  type BoxSeiteInput,
} from './boxSeite';
import { aufbauDerAnlage, type AnlageDaten } from './boxGeraete';
import { lastText } from './boxUebersicht';
import { kastenSatz } from './aufbauTabelle';
import { LAN_UNBEKANNT } from './geraetSeite';
import { dq, gatewayForm, goreDq1, goreForm, hsWege, liefert } from './test/boxGeraeteFixtures';
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


/** Pilsting durch DIESELBE Kette wie Anlage › Aufbau (`aufbauDerAnlage`); Katalog-Geräte tragen keinen Weg. */
function pilsting(over: Partial<AnlageDaten> = {}): AnlageDaten {
  return {
    siteId: 'site-1',
    siteName: 'Pilsting',
    entities: { registry: null, entities: [HYBRID, PRODUCER], localSetup: LOCAL_SETUP, staleOnDevice: [] },
    topology: TOPOLOGY,
    sources: SOURCES,
    devices: [BOX],
    devicesFetchedAt: NOW,
    datenquellen: [],
    uemsGeraete: [],
    now: NOW,
    ...over,
  };
}

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
    anlage: aufbauDerAnlage(pilsting()),
    zuordnung: true,
    datenquellen: [],
    now: NOW,
    ...over,
  };
}

/** Die Box-Seite einer Form: dieselben Daten für den Aufbau der Anlage und für die Seite. */
function seiteVon(d: AnlageDaten, ref: string) {
  return boxSeite({
    ref,
    siteName: d.siteName,
    siteId: d.siteId,
    devices: [...d.devices],
    devicesFetchedAt: d.devicesFetchedAt,
    edgeVersions: [],
    control: null,
    curtailment: null,
    anlage: aufbauDerAnlage(d),
    zuordnung: d.uemsGeraete != null,
    datenquellen: d.datenquellen ? [...d.datenquellen] : null,
    anlagenNamen: new Map([['site-2', 'Halle 2']]),
    now: d.now,
  });
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
    expect(v.grund).toMatch(/nennt keine VoltPilot-Box/);
    expect(v.kacheln).toEqual([]);
  });

  it('bietet bei mehreren Boxen ohne Kennung eine Wahl statt einer Entfernungs-Behauptung', () => {
    const zweite = { ...BOX, id: 'dev-box-2', externalRef: 'edge-zwei', name: 'Halle 2' };
    const v = boxSeite(input({ ref: null, devices: [BOX, zweite] }));
    expect(v.gefunden).toBe(false);
    expect(v.auswahl.map((b) => b.name)).toEqual(['Pilsting', 'Halle 2']);
    expect(v.grund).not.toMatch(/entfernt/i);
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

  it('bietet die lokale Oberfläche am Kundennetz-Endpunkt an', () => {
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
    // Alte reine IP-Belege bekommen den festen Web-Port, sonst führte der
    // Link fälschlich auf Port 80.
    expect(erreicht.url).toBe('http://192.168.254.51:8484');
    expect(erreicht.satz).toMatch(/zuletzt erreicht/);

    // Der vom Host erkannte Endpunkt ist genau die kundenfähige Adresse und
    // bleibt auch dann maßgeblich, wenn Support die Box über VPN erreicht.
    const gemeldet = kachel(
      boxSeite(input({
        devices: [{
          ...BOX, lanHost: '192.168.0.31:8484', lanSeenAt: FRISCH, lanSource: 'schnittstelle',
        }],
      })),
      'netzwerk',
    );
    expect(gemeldet.wert).toBe('192.168.0.31:8484');
    expect(gemeldet.url).toBe('http://192.168.0.31:8484');
    expect(gemeldet.satz).toMatch(/Kundennetz/);
  });

  it('verwirft WAN und Loopback vor Text und Link', () => {
    for (const lanHost of ['8.8.8.8:8484', '127.0.0.1:8484', '[::ffff:127.0.0.1]:8484']) {
      const k = kachel(boxSeite(input({
        devices: [{ ...BOX, lanHost, lanSeenAt: FRISCH, lanSource: 'erreicht' }],
      })), 'netzwerk');
      expect(k.wert).toBe(LAN_UNBEKANNT);
      expect(k.url).toBeNull();
      expect(JSON.stringify(k)).not.toContain(lanHost);
    }
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
  it('listet jedes Gerät aus dem Aufbau mit seiner Art, seinem Zustand und dem Weg auf seine Seite', () => {
    const v = boxSeite(input());
    const g = v.geraete!;
    expect(g.eintraege.map((e) => e.id)).toEqual(['inverter', 'src-7c1e9a2b']);
    expect(g.eintraege.map((e) => e.href)).toEqual([
      '#/anlage/site-1/geraet/edge-45gz7da/inverter',
      '#/anlage/site-1/geraet/edge-45gz7da/src-7c1e9a2b',
    ]);
    // Katalog-Geräte tragen keinen gespeicherten Weg: keine Anbindung, keine Last — und keine geratene.
    expect(g.eintraege.map((e) => e.anbindung)).toEqual([null, null]);
    expect([g.summe, g.summeLeer, g.gateways, g.offen]).toEqual([null, null, [], []]);
    expect(v.buehneSatz).toBe('2 von 2 Geräten liefern Daten.');
    expect(v.geraeteLeer).toBeNull();
  });

  it('reiht eine OCPP-Säule ein', () => {
    const charging = {
      budget: null,
      chargers: [{
        deviceId: 'dev-box', chargePointId: 'CARPORT-1', label: 'Ladepunkt „Carport"',
        priority: false, connected: true, vendor: 'ABL', model: 'eMH2', firmware: '1.4.2',
        ready: true, lastSeen: FRISCH, reportedAt: FRISCH, connectors: [],
      }],
    } as unknown as SiteCharging;
    const v = boxSeite(input({ anlage: aufbauDerAnlage(pilsting({ charging })) }));
    expect(v.geraete!.eintraege.map((e) => e.id)).toContain('cp-CARPORT-1');
  });

  it('ein von der Box gemeldetes, nicht übernommenes Gerät zählt nicht als Gerät — wie im Aufbau', () => {
    const fund = { id: 'src-neu', kind: 'source', role: 'grid-meter', brand: 'eastron', model: 'SDM630', label: null,
      reportedAt: FRISCH, adoptedEntityId: null } as EntityLocalSetup;
    const d = pilsting({ entities: { registry: null, entities: [HYBRID, PRODUCER], localSetup: [...LOCAL_SETUP, fund], staleOnDevice: [] } });
    const v = boxSeite(input({ anlage: aufbauDerAnlage(d) }));
    expect(v.geraete!.anzahl).toBe(2);
    expect(v.geraete!.gemeldet).toBe(1);
    expect(v.buehneSatz).toBe('2 von 2 Geräten liefern Daten.');
  });

  /**
   * GE-4, Gore (Neue Halle): vorher stand die Steuerung hier zweimal — als „DQ-1" in der Liste der Datenquellen und
   * als Gerät, ohne Bezug. Jetzt ist DQ-1 ihre Anbindung, über den gespeicherten Verweis `geraet.data_source_id`.
   */
  it('Gore: EIN Gerät „Anlagensteuerung" mit Anbindung und Last, keine Zeile für DQ-1, Summe darüber', () => {
    const d = goreForm(NOW);
    const v = seiteVon(d, 'edge-5mz8bdd');
    const g = v.geraete!;
    expect(g.eintraege).toEqual([{
      id: 'as-e-as',
      titel: 'Anlagensteuerung',
      typ: 'WAGO PFC200',
      anbindung: 'Modbus TCP · 192.168.4.165:503 · Last 51\u00a0%',
      zustand: 'Liefert Daten',
      ton: 'ok',
      href: '#/anlage/site-gore/geraet/edge-5mz8bdd/as-e-as',
      quelleId: 'dq-1',
    }]);
    expect([g.gateways, g.offen]).toEqual([[], []]);
    expect(g.summe).toBe('Zusammen 12 von 30 Anfragen/min · 305 von 600 Messwerten/min · Last 51\u00a0%');
    // Bühne, Liste und Aufbau zählen dieselben Geräte.
    expect(v.buehneSatz).toBe('1 von 1 Gerät liefert Daten.');
    const ast = aufbauDerAnlage(d)!.boxen[0];
    expect(kastenSatz(ast.geraete, ast.wege)).toBe('1 Gerät');
    expect(g.kurz).toBe('1 Gerät · Last 51\u00a0%');
  });

  it('Gore mit gestörtem Weg: das Gerät steht auf Achtung und liefert nicht — ein Zustand für Bühne und Liste', () => {
    const gestoert = goreDq1(NOW, {
      rueckmeldung: { ...liefert(NOW, 12, 305)!, zustand: 'liefert_nicht', fehlerklasse: 'unreachable', seit: new Date(NOW - 60_000).toISOString() },
    });
    const v = seiteVon(goreForm(NOW, { datenquellen: [gestoert] }), 'edge-5mz8bdd');
    expect(v.geraete!.eintraege.map((e) => [e.ton, e.zustand.split(' · ')[0]])).toEqual([['warn', 'Liefert keine Daten']]);
    expect(v.buehneSatz).toBe('0 von 1 Gerät liefert Daten.');
  });

  it('meldet die Box keine Zahlen, steht keine Last da — nie „0 %"', () => {
    const v = seiteVon(goreForm(NOW, { datenquellen: [goreDq1(NOW, { rueckmeldung: null })] }), 'edge-5mz8bdd');
    const g = v.geraete!;
    expect(g.eintraege[0].anbindung).toBe('Modbus TCP · 192.168.4.165:503');
    expect(g.summe).toBeNull();
    expect(g.summeLeer).toBe('Ihre Last meldet die Box noch nicht je Anschluss.');
    expect(g.kurz).toBe('1 Gerät · Last nicht gemeldet');
    expect(lastText(0.2)).toBe('Last unter 1\u00a0%');
    expect(lastText(0)).toBe('Last 0\u00a0%');
  });

  it('ohne `…/geraete` bleibt die Zuordnung unbekannt: keine Anbindung, die Last zählt trotzdem', () => {
    const v = seiteVon(goreForm(NOW, { uemsGeraete: null }), 'edge-5mz8bdd');
    const g = v.geraete!;
    expect(g.eintraege.map((e) => [e.id, e.anbindung])).toEqual([['as-e-as', null]]);
    expect(g.offen).toEqual([]);
    expect(g.zuordnungUnbekannt).toBe(true);
    expect(g.summe).toContain('Last 51');
  });

  it('Gateway-Form: ein Gerät direkt, das Gateway mit vier Geräten darunter, ein offener Anschluss — Last je Weg und Summe', () => {
    const d = gatewayForm(NOW);
    const v = seiteVon(d, 'VP-HS-0001');
    const g = v.geraete!;
    expect(g.eintraege.map((e) => [e.titel, e.anbindung])).toEqual([
      ['Wechselrichter Dach', 'SunSpec-Modbus · 192.168.10.20:502 · Last 13\u00a0%'],
    ]);
    expect(g.gateways.map((w) => [w.titel, w.weg, w.zeile, w.geraete.map((e) => e.anbindung)])).toEqual([[
      'Zählergateway Halle',
      'Modbus TCP · 192.168.10.31:502 · Geräte-IDs 1–4 · Kennung DQ-3',
      '4 Geräte · Last 23\u00a0%',
      ['Geräte-ID 1', 'Geräte-ID 2', 'Geräte-ID 3', 'Geräte-ID 4'],
    ]]);
    // Hinter dem Gateway wechselt niemand die Box für EIN Gerät: der Weg gehört dem Gateway.
    expect(g.gateways[0].geraete.every((e) => e.quelleId === null && e.href != null)).toBe(true);
    expect(g.offen.map((w) => [w.titel, w.weg])).toEqual([
      ['Anschluss ohne Gerät', 'Modbus TCP · 192.168.10.40:502 · Geräte-ID 1 · Kennung DQ-5 · Last 3\u00a0%'],
    ]);
    expect(g.summe).toBe('Zusammen 12 von 30 Anfragen/min · 186 von 600 Messwerten/min · Last 40\u00a0%');
    expect([g.anzahl, g.liefern]).toEqual([5, 5]);
    expect(v.buehneSatz).toBe('5 von 5 Geräten liefern Daten.');
    const ast = aufbauDerAnlage(d)!.boxen[0];
    expect(kastenSatz(ast.geraete, ast.wege)).toBe('5 Geräte · 1 Gateway · 1 Anschluss offen');
  });

  it('ein Weg ohne Meldung wird in der Summe genannt, nicht als Null gezählt', () => {
    const [wr, gw, offen] = hsWege(NOW);
    const g = seiteVon(gatewayForm(NOW, { datenquellen: [wr, gw, { ...offen, rueckmeldung: null }] }), 'VP-HS-0001').geraete!;
    expect(g.summe).toBe('Zusammen 11 von 30 Anfragen/min · 176 von 600 Messwerten/min · Last 37\u00a0% · ohne Meldung: DQ-5');
    expect(g.offen[0].weg).not.toContain('Last');
  });

  it('zwei Boxen: das Gerät steht an der Box, die seinen Weg liest — und nur dort', () => {
    const hof: Device = { ...BOX, id: 'box-hof', siteId: 'site-hs', externalRef: 'VP-HS-0002', name: 'Box Hof' };
    const [wr, gw, offen] = hsWege(NOW);
    const d = gatewayForm(NOW, {
      devices: [...gatewayForm(NOW).devices, hof],
      datenquellen: [{ ...wr, zustaendige_box: { id: 'box-hof', name: 'Box Hof', heimat_anlage: 'site-hs' } }, gw, offen],
    });
    const halle = seiteVon(d, 'VP-HS-0001').geraete!;
    const hofSeite = seiteVon(d, 'VP-HS-0002').geraete!;
    expect(halle.eintraege.map((e) => e.id)).toEqual([]);
    expect(hofSeite.eintraege.map((e) => [e.id, e.href])).toEqual([['src-wr', '#/anlage/site-hs/geraet/VP-HS-0002/src-wr']]);
    expect(hofSeite.summe).toContain('Last 13');
    expect([halle.anzahl, hofSeite.anzahl]).toEqual([4, 1]);
  });

  it('liest die Box einen Weg einer anderen Anlage, zählt er in die Last und wird genannt', () => {
    const fremd = dq({ id: 'dq-7', kennzeichen: 'DQ-7', anlage: 'site-2', rueckmeldung: liefert(NOW, 3, 60) }, { id: 'box-gore', name: null });
    const g = seiteVon(goreForm(NOW, { datenquellen: [goreDq1(NOW), fremd] }), 'edge-5mz8bdd').geraete!;
    expect(g.fremd).toBe('Außerdem liest diese Box für Halle 2: DQ-7 — dort im Aufbau.');
    expect(g.summe).toBe('Zusammen 15 von 30 Anfragen/min · 365 von 600 Messwerten/min · Last 61\u00a0%');
    expect(g.eintraege).toHaveLength(1);
  });

  it('nur angefangene Anschlüsse: die Bühne sagt, worauf sie warten', () => {
    const [, , offen] = hsWege(NOW);
    const v = seiteVon(gatewayForm(NOW, {
      entities: { registry: null, entities: [], localSetup: [], staleOnDevice: [] }, datenquellen: [offen], uemsGeraete: [],
    }), 'VP-HS-0001');
    expect(v.geraete!.offen).toHaveLength(1);
    expect(v.buehneSatz).toBe('Noch kein Gerät — 1 Anschluss wartet auf ein Gerät.');
    expect(v.geraeteLeer).toBeNull();
  });

  it('sagt es, wenn sich noch kein Gerät gemeldet hat', () => {
    const v = boxSeite(input({
      anlage: aufbauDerAnlage(pilsting({ entities: { registry: null, entities: [], localSetup: [], staleOnDevice: [] } })),
    }));
    expect(v.geraeteLeer).toBe(KEINE_GERAETE);
    expect(v.buehneSatz).toBe(KEINE_GERAETE);
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

  // ── Die ABREGELUNG ist ein anlagenweiter Befehl und wohnt deshalb hier ────

  // Zwei abregel-fähige Fronius an DERSELBEN Box - die Pilsting/Herzogau-Form.
  const FRONIUS_2: EntityLocalSetup = {
    ...LOCAL_SETUP[1], id: 'src-fronius-2', label: 'Fronius WR 2', adoptedEntityId: null,
  };
  const SETUP: EntityLocalSetup[] = [...LOCAL_SETUP, FRONIUS_2];

  const CURTAIL = {
    deviceId: 'dev-box', units: 2, certifiedUnits: 2, controlEnabled: true, active: true,
    appliedCapKw: 16.4, allMatch: true, possibleOverride: false, checkedAt: FRISCH,
    exportGuard: null, deviceExportLimit: null,
  } as unknown as CurtailmentStatus;

  it('nennt die Abregel-Ziele beim NAMEN, sobald die Box ihre Einheiten meldet', () => {
    const mitListe = {
      ...CURTAIL,
      perUnit: [
        { sourceId: 'src-7c1e9a2b', certified: true, appliedCapKw: 8.2, match: true },
        { sourceId: 'src-fronius-2', certified: true, appliedCapKw: 8.2, match: true },
      ],
    } as unknown as CurtailmentStatus;
    const rows = grenzenZeilen(CONTROL, mitListe, 'dev-box', SETUP);
    const z = zeile(rows, 'Abregelung')!;
    expect(z.wert).toBe('2 von 2 Wechselrichtern freigegeben');
    expect(z.detail).toBe('Geht an Fronius Eco 27.0-3 und Fronius WR 2.');
    expect(z.ton).toBe('ok');
  });

  it('sagt ohne gemeldete Einheiten ehrlich „an alle freigegebenen"', () => {
    // Der Zustand bis zum Edge-Release: die Zahl steht, ein Name wird nicht
    // geraten (E2 - nur die Box weiß, welche Einheit sie beschrieben hat).
    const z = zeile(grenzenZeilen(CONTROL, CURTAIL, 'dev-box', SETUP), 'Abregelung')!;
    expect(z.detail).toBe(
      'Geht an alle freigegebenen Wechselrichter (2 von 2 Wechselrichtern freigegeben).',
    );
  });

  it('behauptet ohne abregel-fähige Einheit GAR KEINE Abregel-Zeile', () => {
    const ohne = { ...CURTAIL, units: 0, certifiedUnits: 0 } as unknown as CurtailmentStatus;
    expect(zeile(grenzenZeilen(CONTROL, ohne, 'dev-box', SETUP), 'Abregelung')).toBeUndefined();
  });
});
