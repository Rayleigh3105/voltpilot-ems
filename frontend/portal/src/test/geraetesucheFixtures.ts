import type { Device, SiteComponentRow, SiteComponents, Site } from '../api';
import type {
  Geraetesuche,
  GeraetesucheFund,
  GeraetesucheGruppeWort,
  GeraetesucheVerlaufEintrag,
} from '../geraetesuche';
import type { ComponentTemplate } from '../komponentenAssistent';

/**
 * Fiktive Gerätesuchen für Vitest und die E2E-Bühne `e2e/geraetesuche.tsx` - ein Fall je Zustand des Such-Modals
 * (Konzept vp-portal-geraetesuche-konzept m2–m10, d1–d4). Hof Seewiesen und seine Box sind erfunden; Seriennummern und
 * Adressen ebenso. Zeiten hängen an `jetzt`, damit „Heute, 09:12" in jedem Lauf stimmt. Nur `import type` aus `api`:
 * die Datei darf nie ins Produktionsbündel.
 */

export const GS_SITE_ID = '7c0e4c1a-5d1b-4a8e-9a43-2f5e1b6c9d01';
export const GS_BOX_ID = '3f9a2b7e-1c4d-4e5f-8a6b-7c8d9e0f1a2b';
export const GS_SUCH_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';

export const gsAnlage: Site = {
  id: GS_SITE_ID,
  name: 'Hof Seewiesen',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

export function gsBox(jetzt: number, over: Partial<Device> = {}): Device {
  return {
    id: GS_BOX_ID,
    siteId: GS_SITE_ID,
    externalRef: 'edge-seewiesen',
    kind: 'edge',
    name: 'Seewiesen',
    status: 'active',
    lastSeenAt: new Date(jetzt - 20_000).toISOString(),
    createdAt: '2026-10-28T08:15:30Z',
    ...over,
  };
}

const feld = (key: string, label: string, type: string, extra: Record<string, unknown> = {}) => ({ key, label, type, ...extra });

const deyeFelder = [
  feld('ip', 'IP-Adresse des Datenloggers', 'text', { required: true }),
  feld('port', 'Port', 'number', { default: 8899 }),
  feld('serial', 'Datenlogger-Seriennummer', 'text', { required: true }),
  feld('mb_slave_id', 'Modbus-Slave-ID', 'number', { default: 1 }),
];

const deye = (ref: string, label: string, kw: number): ComponentTemplate => ({
  templateRef: `builtin:deye:${ref}`,
  kind: 'builtin',
  version: 1,
  brand: 'deye',
  brandLabel: 'Deye',
  model: ref,
  modelLabel: label,
  deviceType: 'inverter',
  family: 'hybrid_3p',
  familyLabel: 'Hybrid, 3-phasig',
  communication: 'solarman_v5',
  communicationLabel: 'Solarman-V5 (WiFi-Datenlogger, TCP 8899)',
  transportSchema: deyeFelder as ComponentTemplate['transportSchema'],
  ratedKw: kw,
  certificationStatus: 'builtin',
});

/** Die acht Deye-Hochvolt-Hybride des Katalogs (`HP3`) - die Suche kennt die Bauart, nie die Leistung. */
export const GS_DEYE_HV: ComponentTemplate[] = [
  deye('sun-25k-sg02hp3', 'SUN-25K-SG02HP3-EU-AM3', 25),
  deye('sun-29.9k-sg01hp3', 'SUN-29.9K-SG01HP3-EU', 29.9),
  deye('sun-29.9k-sg02hp3', 'SUN-29.9K-SG02HP3-EU-AM3', 29.9),
  deye('sun-30k-sg01hp3', 'SUN-30K-SG01HP3-EU', 30),
  deye('sun-30k-sg02hp3', 'SUN-30K-SG02HP3-EU-AM3', 30),
  deye('sun-35k-sg01hp3', 'SUN-35K-SG01HP3-EU', 35),
  deye('sun-40k-sg01hp3', 'SUN-40K-SG01HP3-EU', 40),
  deye('sun-50k-sg01hp3', 'SUN-50K-SG01HP3-EU', 50),
];

export const GS_SHELLY: ComponentTemplate = {
  templateRef: 'builtin:shelly:shelly_http',
  kind: 'builtin',
  version: 1,
  brand: 'shelly',
  brandLabel: 'Shelly',
  model: 'shelly_http',
  modelLabel: 'Shelly Relais / Schaltaktor',
  deviceType: 'switch',
  family: 'shelly_http',
  familyLabel: 'Shelly HTTP API',
  communication: 'shelly_http',
  communicationLabel: 'Shelly HTTP API (lokal)',
  transportSchema: [
    feld('ip', 'IP-Adresse des Shelly', 'text', { required: true }),
    feld('port', 'Port', 'number', { default: 80 }),
    feld('channel', 'Schaltkanal', 'number', { default: 0 }),
  ] as ComponentTemplate['transportSchema'],
  ratedKw: null,
  certificationStatus: 'builtin',
};

export const GS_GOE: ComponentTemplate = {
  templateRef: 'builtin:go-e:goe_http_api',
  kind: 'builtin',
  version: 1,
  brand: 'go-e',
  brandLabel: 'go-e',
  model: 'goe_http_api',
  modelLabel: 'go-e Charger',
  deviceType: 'wallbox',
  family: 'goe_http_api',
  familyLabel: 'go-e HTTP API (v2)',
  communication: 'goe_http_api',
  communicationLabel: 'go-e HTTP API v2 (HTTP/JSON)',
  transportSchema: [
    feld('ip', 'IP-Adresse der Wallbox', 'text', { required: true }),
    feld('port', 'Port', 'number', { default: 80 }),
  ] as ComponentTemplate['transportSchema'],
  ratedKw: null,
  certificationStatus: 'builtin',
};

export const GS_TEMPLATES: ComponentTemplate[] = [...GS_DEYE_HV, GS_SHELLY, GS_GOE];

function fund(over: Partial<GeraetesucheFund> & Pick<GeraetesucheFund, 'schluessel' | 'erkenner' | 'art'>): GeraetesucheFund {
  return {
    hersteller: null,
    modell: null,
    seriennummer: null,
    firmware: null,
    familie: null,
    spannung: null,
    kanaele: null,
    erkennung: 'sicher',
    merkmale: [],
    anbindung: 'uebernehmen',
    hindernis: null,
    verbindung: {},
    liestBoxSchon: false,
    abgleich: 'neu',
    komponente: null,
    bekannteAdresse: null,
    vorlagen: [],
    ...over,
  };
}

export const gsDeye = fund({
  schluessel: 'solarman:3115580613',
  erkenner: 'solarman',
  art: 'wechselrichter',
  hersteller: 'deye',
  familie: 'hybrid_3p',
  spannung: 'hv',
  seriennummer: '2409066698',
  merkmale: ['v5_kopf_seriennummer', 'deye_typ_0x0006', 'deye_seriennummer_0x0003'],
  verbindung: { communication: 'solarman_v5', ip: '192.168.178.34', port: 8899, serial: 3115580613, unit_id: 1 },
  vorlagen: GS_DEYE_HV.map((t) => t.templateRef),
});

export const gsShelly = fund({
  schluessel: 'shelly:192.168.178.43:80',
  erkenner: 'shelly',
  art: 'schaltaktor',
  hersteller: 'shelly',
  modell: 'SPSW-003XE16EU',
  firmware: '1.4.4',
  kanaele: 3,
  merkmale: ['shelly_gen2_antwort'],
  verbindung: { communication: 'shelly_http', ip: '192.168.178.43', port: 80 },
  vorlagen: [GS_SHELLY.templateRef],
});

export const gsGoe = fund({
  schluessel: 'goe:204117',
  erkenner: 'goe',
  art: 'wallbox',
  hersteller: 'go-e',
  seriennummer: '204117',
  firmware: '56.1',
  merkmale: ['goe_api_v2_sse'],
  verbindung: { communication: 'goe_http_api', ip: '192.168.178.52', port: 80 },
  vorlagen: [GS_GOE.templateRef],
});

const gsRouter = fund({
  schluessel: 'netztechnik:192.168.178.1:80',
  erkenner: 'netztechnik',
  art: 'router',
  hersteller: 'avm',
  modell: 'FRITZ!Box 7590',
  erkennung: 'wahrscheinlich',
  merkmale: ['seitentitel'],
  anbindung: 'nur_anzeige',
  verbindung: { ip: '192.168.178.1', port: 80 },
});

const gsZugangspunkt = fund({
  schluessel: 'netztechnik:192.168.178.2:80',
  erkenner: 'netztechnik',
  art: 'zugangspunkt',
  hersteller: 'tp-link',
  erkennung: 'wahrscheinlich',
  merkmale: ['seitentitel'],
  anbindung: 'nur_anzeige',
  verbindung: { ip: '192.168.178.2', port: 80 },
});

const gsFronius = fund({
  schluessel: 'fronius_solar_api:31254789',
  erkenner: 'fronius_solar_api',
  art: 'wechselrichter',
  hersteller: 'fronius',
  modell: 'Symo GEN24 10.0',
  seriennummer: '31254789',
  merkmale: ['solar_api_version', 'solar_api_inverter_info'],
  anbindung: 'nicht_mit_dieser_box',
  verbindung: { communication: 'fronius_solar_api', ip: '192.168.178.60', port: 80 },
});

const gsShellyZaehler = fund({
  schluessel: 'shelly:192.168.178.47:80',
  erkenner: 'shelly',
  art: 'zaehler',
  hersteller: 'shelly',
  modell: 'SPEM-003CEBEU',
  merkmale: ['shelly_gen2_antwort'],
  anbindung: 'kein_leseweg',
  verbindung: { ip: '192.168.178.47', port: 80 },
});

const gsModbus = fund({
  schluessel: 'modbus_offen:192.168.178.70:502',
  erkenner: 'modbus_offen',
  art: 'modbus_geraet',
  erkennung: 'unbekannt',
  merkmale: ['modbus_port_offen'],
  anbindung: 'selbst_beschreiben',
  verbindung: { communication: 'modbus_tcp', ip: '192.168.178.70', port: 502 },
});

const gsShellyGeschuetzt = fund({
  ...gsShelly,
  schluessel: 'shelly:192.168.178.44:80',
  modell: 'SNSW-001P16EU',
  kanaele: 1,
  merkmale: ['shelly_gen2_antwort', 'auth_en'],
  hindernis: 'geschuetzt',
  verbindung: { communication: 'shelly_http', ip: '192.168.178.44', port: 80 },
});

const gsWallboxNeueAdresse = fund({
  ...gsGoe,
  abgleich: 'adresse_geaendert',
  komponente: { id: '8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a', name: 'Wallbox Garage' },
  bekannteAdresse: '192.168.178.51:80',
});

const gsDeyeEingerichtet = fund({
  ...gsDeye,
  abgleich: 'schon_eingerichtet',
  liestBoxSchon: true,
  komponente: { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Wechselrichter' },
});

const gruppen = (g: Partial<Record<GeraetesucheGruppeWort, GeraetesucheFund[]>>) =>
  (['braucht_hilfe', 'bereit', 'nicht_anbindbar', 'vielleicht', 'schon_eingerichtet', 'weitere'] as const).map((w) => ({
    gruppe: w,
    funde: g[w] ?? [],
  }));

const netze = [
  { rolle: 'kundennetz' as const, netz: '192.168.178.0/24', boxAdresse: '192.168.178.20', ausschnitt: false, erreichbar: true, aktiv: 9 },
  { rolle: 'box_netz' as const, netz: '192.168.2.0/24', boxAdresse: '192.168.2.1', ausschnitt: false, erreichbar: true, aktiv: 0 },
];

const VON_IHNEN = { name: 'Jonas Wendlinger', rolle: 'kundenadministrator', art: 'kunde' as const };
const VON_SERVICE = { name: 'Anna Weber', rolle: 'voltpilot_betrieb', art: 'voltpilot' as const };

/** Ein Zustand der Suche; `gestartet` liegt `vorS` Sekunden vor `jetzt`. */
function suche(jetzt: number, vorS: number, over: Partial<Geraetesuche>): Geraetesuche {
  const gestartet = jetzt - vorS * 1000;
  return {
    suchId: GS_SUCH_ID,
    deviceId: GS_BOX_ID,
    zustand: 'fertig',
    grund: null,
    gestartetAm: new Date(gestartet).toISOString(),
    gestartetVon: VON_IHNEN,
    beendetAm: new Date(gestartet + 38_120).toISOString(),
    dauerMs: 38_120,
    schritt: null,
    erledigt: null,
    gesamt: null,
    restSekunden: null,
    netze,
    erkenner: ['solarman', 'shelly', 'goe', 'netztechnik', 'modbus_offen', 'sunspec', 'fronius_solar_api', 'kaco_aiswei',
      'kostal', 'huawei', 'sma', 'victron', 'opendtu_ahoy', 'ebyte', 'wago', 'mdns', 'ssdp', 'funkmodul'],
    gruppen: gruppen({}),
    weitere: { telefonTablet: 2, rechner: 1, unbekannt: 0 },
    ladesaeulenKlopfenAn: [],
    ...over,
  };
}

/** Alle Fälle, die das Modal kennt - die Bühne wählt einen über `?fall=`. */
export function geraetesucheFaelle(jetzt: number) {
  const laufend = (over: Partial<Geraetesuche> = {}) =>
    suche(jetzt, 12, { zustand: 'laeuft', beendetAm: null, dauerMs: null, erkenner: null, ...over });
  return {
    wartet: laufend({ zustand: 'wartet', netze: [], weitere: { telefonTablet: null, rechner: null, unbekannt: null } }),
    laeuft: laufend({
      schritt: 'geraete_ansprechen', erledigt: 3, gesamt: 4, restSekunden: 15,
      gruppen: gruppen({ bereit: [gsShelly] }),
      weitere: { telefonTablet: null, rechner: null, unbekannt: null },
    }),
    fertig: suche(jetzt, 60, {
      gruppen: gruppen({ bereit: [gsDeye, gsShelly], weitere: [gsRouter, gsZugangspunkt] }),
      weitere: { telefonTablet: 1, rechner: null, unbekannt: null },
    }),
    /** Stufe 2 (V2): jede Gruppe belegt, dazu eine Ladesäule, die anklopft. */
    breit: suche(jetzt, 60, {
      gruppen: gruppen({
        braucht_hilfe: [gsShellyGeschuetzt],
        bereit: [gsDeye, gsShelly, gsGoe],
        nicht_anbindbar: [gsFronius, gsShellyZaehler],
        vielleicht: [gsModbus],
        weitere: [gsRouter],
      }),
      ladesaeulenKlopfenAn: [{
        chargePointId: 'CP-HOF-1', ip: '192.168.178.81',
        zuerst: new Date(jetzt - 3_600_000).toISOString(), zuletzt: new Date(jetzt - 120_000).toISOString(), versuche: 14,
      }],
    }),
    hinweis: suche(jetzt, 30, {
      gruppen: gruppen({ braucht_hilfe: [gsWallboxNeueAdresse], bereit: [gsShelly], schon_eingerichtet: [gsDeyeEingerichtet] }),
    }),
    nichts: suche(jetzt, 45, {
      gruppen: gruppen({}),
      weitere: { telefonTablet: 2, rechner: 1, unbekannt: null },
      erkenner: ['solarman', 'shelly', 'goe', 'netztechnik', 'modbus_offen'],
    }),
    abgebrochen: suche(jetzt, 20, {
      zustand: 'abgebrochen', grund: 'auf_wunsch', dauerMs: 12_400,
      gruppen: gruppen({ bereit: [gsShelly] }),
    }),
    keineAntwort: suche(jetzt, 90, {
      zustand: 'keine_antwort', dauerMs: null, beendetAm: null, erkenner: null,
      gruppen: gruppen({ bereit: [gsShelly] }),
    }),
    abgelehnt: suche(jetzt, 5, {
      zustand: 'abgelehnt', grund: 'lan_host_fehlt', dauerMs: 0, netze: [], erkenner: null,
      weitere: { telefonTablet: null, rechner: null, unbekannt: null },
    }),
    fehlgeschlagen: suche(jetzt, 15, {
      zustand: 'fehlgeschlagen', grund: 'interner_fehler', dauerMs: 4_200,
      weitere: { telefonTablet: null, rechner: null, unbekannt: null },
    }),
    /** Mitansehen: gestartet vom VoltPilot-Service. */
    fremd: laufend({
      gestartetVon: VON_SERVICE, schritt: 'nachbarn_finden', erledigt: 120, gesamt: 254, restSekunden: 30,
      weitere: { telefonTablet: null, rechner: null, unbekannt: null },
    }),
  };
}

export type GeraetesucheFall = keyof ReturnType<typeof geraetesucheFaelle>;

const zaehler = (z: Partial<Record<GeraetesucheGruppeWort, number>>) => ({
  braucht_hilfe: 0, bereit: 0, nicht_anbindbar: 0, vielleicht: 0, schon_eingerichtet: 0, weitere: 0, ...z,
});

/** „Letzte Suchen" (m10): heute, vorgestern abgebrochen vom Service, vor drei Tagen ohne Energie-Geräte. */
export function gsVerlauf(jetzt: number): GeraetesucheVerlaufEintrag[] {
  const vor = (s: number) => new Date(jetzt - s * 1000).toISOString();
  return [
    { suchId: GS_SUCH_ID, deviceId: GS_BOX_ID, zustand: 'fertig', grund: null, gestartetAm: vor(60), gestartetVon: VON_IHNEN,
      dauerMs: 38_120, zaehler: zaehler({ bereit: 2, weitere: 2 }) },
    { suchId: '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e', deviceId: GS_BOX_ID, zustand: 'abgebrochen', grund: 'auf_wunsch',
      gestartetAm: vor(2 * 86_400 + 3_600), gestartetVon: VON_SERVICE, dauerMs: 12_000, zaehler: zaehler({ bereit: 1 }) },
    { suchId: '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f', deviceId: GS_BOX_ID, zustand: 'fertig', grund: null,
      gestartetAm: vor(3 * 86_400), gestartetVon: VON_IHNEN, dauerMs: 41_500, zaehler: zaehler({ weitere: 3 }) },
  ];
}

/** Die Komponenten der Anlage: die Wallbox an ihrer alten Adresse (DP-7 A), sonst leer. */
export const gsWallboxZeile: SiteComponentRow = {
  id: '8d7c6b5a-4f3e-4d2c-9b1a-0f9e8d7c6b5a',
  role: 'consumer',
  label: 'Wallbox Garage',
  brand: 'go-e',
  model: 'goe_http_api',
  communication: 'goe_http_api',
  connection: { ip: '192.168.178.51', port: 80 },
  templateRef: GS_GOE.templateRef,
  templateVersion: 1,
  definitionVersion: 3,
  syncStatus: 'in_sync',
};

export const gsKomponenten: SiteComponents = { componentAuthority: 'portal', components: [gsWallboxZeile] };
