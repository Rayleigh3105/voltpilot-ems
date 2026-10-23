import { describe, expect, it } from 'vitest';
import type {
  Device,
  EntityLocalSetup,
  OverviewSite,
  SiteEntity,
  SiteTopology,
  StandorteAmStichtag,
  UemsDatenquelle,
  UemsGeraet,
} from './api';
import {
  OHNE_STANDORT,
  anlagenWerte,
  aufbauBaum,
  aufbauWurzel,
  komponentenWerte,
  ladeWert,
  type AufbauEingabe,
} from './aufbauBaum';
import { aufbauZahlen, kastenSatz, LEERER_FILTER, tabellenZeilen, type TabellenZeile } from './aufbauTabelle';
import { plantModel, type PlantComponent } from './komponenten';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import { zentraleListe, zentraleSatz, type GeraeteKarte } from './zentraleListe';

/** `fmtNum` trennt Zahl und Einheit mit einem geschützten Leerzeichen. */
const plain = (s: string) => s.replace(/\u00a0/g, ' ');
const texte = (werte: { text: string }[]) => werte.map((w) => plain(w.text));

const NOW = Date.parse('2026-09-10T10:00:00Z');
/** Jede Anlage, Box und jedes Gateway offen, kein Gerät aufgeklappt. */
const ALLES_OFFEN = { offen: () => true, geraete: new Set<string>() };
const FRISCH = new Date(NOW - 12_000).toISOString();

const box = (o: Partial<Device> & Pick<Device, 'id' | 'externalRef'>): Device => ({
  siteId: 's-1',
  kind: 'inverter',
  name: null,
  status: 'active',
  lastSeenAt: FRISCH,
  createdAt: null,
  ...o,
});

const komp = (o: Partial<PlantComponent> & Pick<PlantComponent, 'id' | 'role'>): PlantComponent => ({
  entityId: o.id,
  aspect: 'main',
  label: o.id,
  alias: null,
  derivedLabel: o.id,
  renameable: true,
  summary: '',
  deviceIds: [],
  provenance: null,
  reading: null,
  channels: [],
  control: false,
  schaltbar: false,
  freigabeQuelle: null,
  freigabeFaehig: false,
  primary: false,
  health: 'ok',
  measuredVia: null,
  orphaned: false,
  ...o,
});

const karte = (o: Partial<GeraeteKarte> & Pick<GeraeteKarte, 'id' | 'art'>): GeraeteKarte => ({
  titel: o.id,
  technischerName: null,
  untertitel: 'Gerät',
  zustand: 'liefert Daten · vor 12 Sek.',
  ton: 'ok',
  href: null,
  komponenten: [],
  zusatz: null,
  ...o,
});

const HYBRID = karte({
  id: 'inverter',
  art: 'geraet',
  titel: 'Speicher Scheune',
  untertitel: 'Hybrid-Wechselrichter · Hauptgerät',
  komponenten: [
    komp({ id: 'batt', role: 'storage', reading: { value: 64, unit: '%', caption: 'geladen' } }),
    komp({ id: 'batt#pv', role: 'pv', aspect: 'pv', reading: { value: 6.2, unit: 'kW', caption: null } }),
    komp({ id: 'grid', role: 'grid', reading: { value: 3.4, unit: 'kW', caption: 'Einspeisung' } }),
    // Ohne Messwert kein Chip - nie eine erfundene 0.
    komp({ id: 'haus', role: 'house', reading: null }),
  ],
});
const SAEULE = karte({ id: 'cp-CP-1', art: 'ladepunkt', titel: 'Wallbox Carport' });
const FUND = karte({
  id: 'neu:src-7',
  art: 'neu',
  titel: 'Neues Gerät gefunden',
  untertitel: 'Erzeuger · 192.0.2.31',
  ton: 'warn',
  quelle: {
    id: 'src-7',
    role: 'pv-generation',
    brand: 'fronius',
    model: null,
    label: null,
    roleLabel: 'Erzeuger',
    summary: 'Erzeuger · 192.0.2.31',
    suggestedType: 'producer',
  },
});

const LOCAL_SETUP: EntityLocalSetup[] = [
  {
    id: 'inverter',
    kind: 'inverter',
    role: 'storage',
    brand: 'deye',
    model: 'SUN-12K-SG04LP3-EU',
    label: 'Speicher Scheune',
    reportedAt: FRISCH,
    adoptedEntityId: 'batt',
  } as EntityLocalSetup,
];

const saeule = (o: Partial<ChargePoint> = {}): ChargePoint => ({
  deviceId: 'b-1',
  chargePointId: 'CP-1',
  priority: false,
  connected: true,
  ready: true,
  connectors: [{ connectorId: 1, charging: true, powerKw: 1.4, status: 'Charging' }],
  ...o,
});

const CHARGING = (c: ChargePoint): SiteCharging => ({ budget: null, chargers: [c] } as unknown as SiteCharging);

const OVERVIEW_SITE = (o: Partial<OverviewSite> = {}): OverviewSite =>
  ({
    id: 's-1',
    name: 'Sonnenhof',
    onlineCount: 1,
    live: { ts: FRISCH, pvKw: 11, loadKw: 5.4, gridKw: -3.4, socPct: 64 },
    ...o,
  }) as OverviewSite;

const STANDORTE = (anlagen: { id: string; name: string }[]): StandorteAmStichtag =>
  ({
    stichtag: '2026-09-10',
    standorte: [
      {
        id: 'st-1',
        kurzzeichen: 'ST-1',
        name: 'Sonnenhof',
        adresse: { strasse: 'Sonnenweg 1', plz: '80331', ort: 'München', land: 'DE' },
        zeitzone: 'Europe/Berlin',
        zustand: 'aktiv',
        esFehlt: [],
        anlagen: anlagen.map((a) => ({ ...a, gueltigAb: '2026-01-01', gueltigBis: null })),
      },
    ],
    nichtGezeigt: [],
    nochNichtZugeordnet: null,
  }) as unknown as StandorteAmStichtag;

const eingabe = (o: Partial<AufbauEingabe> = {}): AufbauEingabe => ({
  siteId: 's-1',
  siteName: 'Sonnenhof',
  standorte: null,
  devices: [box({ id: 'b-1', externalRef: 'VP-DEMO-0001', name: 'Box Scheune' })],
  devicesFetchedAt: NOW,
  karten: [karte({ id: 'box:VP-DEMO-0001', art: 'box' }), HYBRID, SAEULE, FUND],
  localSetup: LOCAL_SETUP,
  charging: CHARGING(saeule()),
  registryBoxId: 'b-1',
  overview: [OVERVIEW_SITE()],
  now: NOW,
  ...o,
});

describe('aufbauBaum — eine Box', () => {
  it('hängt jedes Gerät und den Fund unter die EINE Box, ohne Box-Karte als Gerät', () => {
    const baum = aufbauBaum(eingabe());
    const [anlage] = baum.anlagen;
    expect(anlage.aktuell).toBe(true);
    expect(anlage.boxen).toHaveLength(1);
    const [b] = anlage.boxen;
    expect(b.name).toBe('Box Scheune');
    expect(b.ref).toBe('VP-DEMO-0001');
    expect(b.href).toBe('#/anlage/s-1/box/VP-DEMO-0001');
    expect(b.geraete.map((g) => g.id)).toEqual(['inverter', 'cp-CP-1', 'neu:src-7']);
    expect(anlage.ohneBox).toEqual([]);
    // Angelegte Geräte zählen, ein Fund nicht.
    expect(anlage.geraeteZahl).toBe(2);
  });

  it('nennt keine führende Box, solange es nur eine gibt', () => {
    expect(aufbauBaum(eingabe()).anlagen[0].boxen[0].fuehrend).toBe(false);
  });

  it('nennt eine Box ohne eigenen Namen „VoltPilot-Box"', () => {
    const baum = aufbauBaum(eingabe({ devices: [box({ id: 'b-1', externalRef: 'VP-1', name: '  ' })] }));
    expect(baum.anlagen[0].boxen[0].name).toBe('VoltPilot-Box');
  });
});

describe('aufbauBaum — Geräte-Zeilen', () => {
  it('macht aus den Komponenten Chips - nur mit Messwert, nie eine 0', () => {
    const g = aufbauBaum(eingabe()).anlagen[0].boxen[0].geraete[0];
    expect(texte(g.werte)).toEqual(['64 % geladen', '6,2 kW', '3,4 kW Einspeisung']);
    expect(g.werte.map((w) => plain(w.label))).toEqual([
      'Speicher 64 % geladen',
      'PV 6,2 kW',
      'Netz 3,4 kW Einspeisung',
    ]);
  });

  it('färbt den Hybrid als Speicher und nennt sein Modell statt der Art', () => {
    const g = aufbauBaum(eingabe()).anlagen[0].boxen[0].geraete[0];
    expect(g.kategorie).toBe('battery');
    expect(g.icon).toBe('battery');
    expect(g.unterzeile).toBe('Deye SUN-12K');
  });

  it('fällt ohne Bestandsmeldung auf die Art des Geräts zurück', () => {
    const g = aufbauBaum(eingabe({ localSetup: null })).anlagen[0].boxen[0].geraete[0];
    expect(g.unterzeile).toBe('Hybrid-Wechselrichter · Hauptgerät');
  });

  it('zeigt an der Ladesäule ihren Ladestrom, sonst „frei"', () => {
    const laedt = aufbauBaum(eingabe()).anlagen[0].boxen[0].geraete[1];
    expect(laedt.kategorie).toBe('ev');
    expect(texte(laedt.werte)).toEqual(['lädt 1,4 kW']);
    const frei = aufbauBaum(
      eingabe({
        charging: CHARGING(saeule({ connectors: [{ connectorId: 1, charging: false, status: 'Available' }] })),
      }),
    ).anlagen[0].boxen[0].geraete[1];
    expect(texte(frei.werte)).toEqual(['frei']);
  });

  it('benennt einen Fund nach seinem Hersteller', () => {
    const fund = aufbauBaum(eingabe()).anlagen[0].boxen[0].geraete[2];
    expect(fund.art).toBe('neu');
    expect(fund.titel).toBe('Fronius gefunden');
    expect(fund.kategorie).toBe('fund');
  });
});

describe('aufbauBaum — mehrere Boxen', () => {
  const zwei = () =>
    eingabe({
      devices: [
        box({ id: 'b-2', externalRef: 'VP-DEMO-0003', name: 'Box Halle' }),
        box({ id: 'b-1', externalRef: 'VP-DEMO-0001', name: 'Box Scheune' }),
      ],
      charging: CHARGING(saeule({ deviceId: 'b-2' })),
    });

  it('stellt die führende Box nach oben und nennt sie so', () => {
    const [anlage] = aufbauBaum(zwei()).anlagen;
    expect(anlage.boxen.map((b) => [b.name, b.fuehrend])).toEqual([
      ['Box Scheune', true],
      ['Box Halle', false],
    ]);
  });

  it('hängt angelegte Geräte unter die führende, Säulen unter ihre eigene Box', () => {
    const [anlage] = aufbauBaum(zwei()).anlagen;
    expect(anlage.boxen[0].geraete.map((g) => g.id)).toEqual(['inverter']);
    expect(anlage.boxen[1].geraete.map((g) => g.id)).toEqual(['cp-CP-1']);
  });

  it('rät für einen Fund keine Box - er steht unter der Anlage', () => {
    const [anlage] = aufbauBaum(zwei()).anlagen;
    expect(anlage.ohneBox.map((g) => g.id)).toEqual(['neu:src-7']);
  });

  it('ohne bekannte führende Box steht nichts unter einer geratenen Box', () => {
    const [anlage] = aufbauBaum({ ...zwei(), registryBoxId: null }).anlagen;
    expect(anlage.boxen.every((b) => !b.fuehrend)).toBe(true);
    expect(anlage.ohneBox.map((g) => g.id)).toEqual(['inverter', 'neu:src-7']);
  });
});

describe('aufbauBaum — Standort als Wurzel', () => {
  it('hat ohne Standort-Antwort keine Wurzel (älteres Backend)', () => {
    expect(aufbauBaum(eingabe()).wurzel).toBeNull();
  });

  it('nimmt den Standort der Anlage mit Adresse und stellt die Nachbarn dahinter', () => {
    const baum = aufbauBaum(
      eingabe({
        standorte: STANDORTE([
          { id: 's-2', name: 'Werkstatt am Bach' },
          { id: 's-1', name: 'Sonnenhof' },
        ]),
        devices: [
          box({ id: 'b-1', externalRef: 'VP-DEMO-0001' }),
          box({ id: 'b-3', externalRef: 'VP-DEMO-0002', siteId: 's-2' }),
        ],
      }),
    );
    expect(baum.wurzel).toEqual({
      art: 'standort',
      id: 'st-1',
      name: 'Sonnenhof',
      kurzzeichen: 'ST-1',
      adresse: 'Sonnenweg 1 · 80331 München',
      entwurf: false,
    });
    expect(baum.anlagen.map((a) => [a.name, a.aktuell])).toEqual([
      ['Sonnenhof', true],
      ['Werkstatt am Bach', false],
    ]);
    expect(baum.boxZahl).toBe(2);
    // Die Geräte der Nachbar-Anlage sind noch nicht geladen - keine erfundene 0.
    expect(baum.anlagen[1].geraeteZahl).toBeNull();
    expect(baum.anlagen[1].boxen.map((b) => b.ref)).toEqual(['VP-DEMO-0002']);
  });

  it('nennt an einer Nachbar-Anlage mit zwei Boxen die führende nach dem Server-Fakt — nie nach der Reihenfolge', () => {
    const mit = (fuehrtAnlage: boolean | undefined) =>
      aufbauBaum(
        eingabe({
          standorte: STANDORTE([{ id: 's-1', name: 'Sonnenhof' }, { id: 's-2', name: 'Werkstatt am Bach' }]),
          devices: [
            box({ id: 'b-1', externalRef: 'VP-1' }),
            box({ id: 'b-3', externalRef: 'VP-3', name: 'Box Werkstatt', siteId: 's-2' }),
            box({ id: 'b-4', externalRef: 'VP-4', name: 'Box Lager', siteId: 's-2', fuehrtAnlage }),
          ],
        }),
      ).anlagen[1].boxen.map((b) => [b.name, b.fuehrend]);
    expect(mit(true)).toEqual([
      ['Box Lager', true],
      ['Box Werkstatt', false],
    ]);
    expect(mit(undefined)).toEqual([
      ['Box Werkstatt', false],
      ['Box Lager', false],
    ]);
  });

  it('zeigt die Geräte einer Nachbar-Anlage, sobald sie geladen sind', () => {
    const baum = aufbauBaum(
      eingabe({
        standorte: STANDORTE([{ id: 's-1', name: 'Sonnenhof' }, { id: 's-2', name: 'Werkstatt am Bach' }]),
        devices: [box({ id: 'b-1', externalRef: 'VP-1' }), box({ id: 'b-3', externalRef: 'VP-2', siteId: 's-2' })],
        nachbarKarten: { 's-2': [karte({ id: 'wr', art: 'geraet', titel: 'Wechselrichter' })] },
      }),
    );
    expect(baum.anlagen[1].boxen[0].geraete.map((g) => g.titel)).toEqual(['Wechselrichter']);
    expect(baum.anlagen[1].geraeteZahl).toBe(1);
  });

  it('sagt ehrlich „noch keinem Standort zugeordnet" - ohne fremde Anlagen als Nachbarn', () => {
    const { wurzel, nachbarn } = aufbauWurzel(
      {
        stichtag: '2026-09-10',
        standorte: [],
        nichtGezeigt: [],
        nochNichtZugeordnet: {
          anlagenZahl: 2,
          anlagen: [
            { id: 's-1', name: 'Sonnenhof' },
            { id: 's-9', name: 'Anderswo' },
          ],
        },
      },
      's-1',
    );
    expect(wurzel?.art).toBe('ohne-standort');
    expect(wurzel?.name).toBe(OHNE_STANDORT);
    expect(nachbarn).toEqual([]);
  });

  it('markiert einen Standort im Entwurf', () => {
    const st = STANDORTE([{ id: 's-1', name: 'Sonnenhof' }]);
    st.standorte[0].zustand = 'entwurf';
    st.standorte[0].adresse = null;
    const { wurzel } = aufbauWurzel(st, 's-1');
    expect(wurzel?.entwurf).toBe(true);
    expect(wurzel?.adresse).toBeNull();
  });
});

describe('anlagenWerte — Live-Chips der Anlage', () => {
  it('nennt PV, Speicher und Netz mit Richtungswort statt Vorzeichen', () => {
    const { werte, stand } = anlagenWerte(OVERVIEW_SITE(), NOW);
    expect(stand).toBe('aktuell');
    expect(texte(werte)).toEqual(['11,0 kW', '64 %', 'Einspeisung 3,4 kW']);
  });

  it('zeigt veraltete Werte nicht als aktuell', () => {
    const alt = new Date(NOW - 60 * 60_000).toISOString();
    const { werte, stand } = anlagenWerte(
      OVERVIEW_SITE({ live: { ts: alt, pvKw: 1, loadKw: 1, gridKw: 1, socPct: 50 } }),
      NOW,
    );
    expect(stand).toBe('veraltet');
    expect(werte).toEqual([]);
  });

  it('lässt fehlende Werte weg statt sie als 0 zu zeigen', () => {
    const { werte } = anlagenWerte(
      OVERVIEW_SITE({ live: { ts: FRISCH, pvKw: null, loadKw: 1, gridKw: 0.01, socPct: null } }),
      NOW,
    );
    expect(texte(werte)).toEqual(['ausgeglichen']);
  });

  it('kennt ohne Übersicht keinen Stand', () => {
    expect(anlagenWerte(null, NOW)).toEqual({ werte: [], stand: 'unbekannt' });
  });
});

describe('Chips einzeln', () => {
  it('komponentenWerte übernimmt das Richtungswort der Komponente', () => {
    expect(
      texte(komponentenWerte([komp({ id: 'g', role: 'grid', reading: { value: 2, unit: 'kW', caption: 'Bezug' } })])),
    ).toEqual(['2,0 kW Bezug']);
  });

  it('ladeWert schweigt, wenn weder geladen wird noch alles frei ist', () => {
    expect(
      ladeWert(saeule({ connectors: [{ connectorId: 1, charging: false, status: 'Faulted' }] })),
    ).toBeNull();
    expect(ladeWert(saeule({ connectors: [{ connectorId: 1, charging: true, powerKw: null }] }))?.text).toBe(
      'lädt',
    );
  });
});

/**
 * EZ-20, Gore Pleinfeld „Neue Halle“: eine reine Erzeugeranlage — Box + Anlagensteuerung (WAGO, drei
 * Growatt-Einheiten über DQ-1), kein Speicher, kein eigener Wechselrichter. In der Datenbank liegen nur die beim
 * Verbinden der Box zusammengesetzten Netz und Haus (über die Box) und die Steuerung
 * (`AnlagensteuerungAnlegewegDbTest`). Der Aufbau zeigte daraus ein zweites Gerät „Wechselrichter“ — das
 * Ersatzgerät, das `plantModel` den übrigen Komponenten der Box gab. Echte Kette: Entitäten → `plantModel` →
 * `zentraleListe` → `aufbauBaum`.
 */
describe('aufbauBaum — reine Erzeugeranlage (EZ-20)', () => {
  const GORE_BOX = box({ id: 'box-gore', siteId: 'site-gore', externalRef: 'edge-5mz8bdd' });
  const ent = (o: Partial<SiteEntity> & Pick<SiteEntity, 'id' | 'entityType'>): SiteEntity =>
    ({
      typeLabel: o.entityType,
      role: o.entityType,
      label: null,
      control: false,
      deviceId: null,
      capabilities: { measure: [] },
      guards: null,
      syncStatus: 'in_sync',
      observed: null,
      edgeSourceId: null,
      ...o,
    }) as unknown as SiteEntity;
  const NETZ = ent({ id: 'e-netz', entityType: 'grid-meter', deviceId: 'box-gore', sourceKind: 'composed' });
  const HAUS = ent({ id: 'e-haus', entityType: 'house-load', deviceId: 'box-gore', sourceKind: 'composed' });
  const STEUERUNG = ent({ id: 'e-as', entityType: 'anlagensteuerung', typeLabel: 'Anlagensteuerung', label: 'Anlagensteuerung' });
  const SPEICHER = ent({ id: 'e-batt', entityType: 'battery-hybrid', role: 'battery-hybrid', deviceId: 'box-gore' });
  const DQ1 = {
    id: 'dq-1', kennzeichen: 'DQ-1', name: null, anlage: 'site-gore', protokoll: 'modbus_tcp',
    adresse: '192.168.4.165:503', geraete_ids: [1], netz: null, mehrere_leser: false, steuerquelle: false,
    vergleichsquelle: false, kadenz_s: 5, archiviert_am: null,
    zustaendige_box: { id: 'box-gore', name: null, heimat_anlage: 'site-gore' }, zeitraeume: [], rueckmeldung: null,
  } as unknown as UemsDatenquelle;
  // Der gespeicherte Verweis Weg → Gerät (GE-1): das UEMS-Gerät der Steuerung trägt `data_source_id` = DQ-1.
  const GR_STEUERUNG: UemsGeraet = {
    id: 'gr-as', kennzeichen: 'GR-1', einbau_kennzeichen: 'GR-1', ausgebaut_am: null, data_source_id: 'dq-1',
    geraeteart: 'controller', hersteller: 'WAGO', typ: 'PFC200',
    komponenten: [{ entity_id: 'e-as', gueltig_ab: '2026-10-21T08:00:00Z', gueltig_bis: null }],
  };

  const gore = (
    entities: SiteEntity[],
    localSetup: EntityLocalSetup[] = [],
    topology: SiteTopology | null = null,
    uemsGeraete: UemsGeraet[] | null = [GR_STEUERUNG],
  ) => {
    const model = plantModel(entities, topology, localSetup, []);
    const karten = zentraleListe({
      siteId: 'site-gore', model, devices: [GORE_BOX], devicesFetchedAt: NOW, boxRef: 'edge-5mz8bdd',
      localSetup, sources: [], charging: null, now: NOW,
    });
    const baum = aufbauBaum({
      siteId: 'site-gore', siteName: 'Neue Halle', standorte: null, devices: [GORE_BOX], devicesFetchedAt: NOW,
      karten, localSetup, charging: null, registryBoxId: 'box-gore', overview: null, datenquellen: [DQ1],
      uemsGeraete: { 'site-gore': uemsGeraete }, now: NOW,
    });
    return { model, karten, baum, box: baum.anlagen[0].boxen[0] };
  };
  const zeilen = (b: { geraete: { titel: string; artWort: string }[] }) => b.geraete.map((g) => `${g.titel} · ${g.artWort}`);

  /**
   * GE-1 (Konzept „Ein Gerät, ein Eintrag", Captain 23.10.2026): vorher stand DQ-1 als zweite Zeile
   * „DQ-1 · Datenquelle" neben der Steuerung, und die Box sagte „1 Gerät · liest 1 Datenquelle". Jetzt ist DQ-1
   * die Anbindung der Steuerung — über den gespeicherten Verweis `geraet.data_source_id`, nie über die Adresse.
   */
  it('zeigt nur die Anlagensteuerung: EINE Zeile mit ihrer Anbindung, keine Zeile für DQ-1, Box „1 Gerät"', () => {
    const { model, karten, baum, box: b } = gore([NETZ, HAUS, STEUERUNG]);
    expect(zeilen(b)).toEqual(['Anlagensteuerung · Gerät an Ihrer Box']);
    expect(b.geraete[0].id).toBe('as-e-as');
    expect(b.wege).toEqual([]);
    expect(b.geraete[0].anbindungen.map((a) => [a.kennzeichen, a.weg, a.box?.id])).toEqual([
      ['DQ-1', 'Modbus TCP · 192.168.4.165:503', 'box-gore'],
    ]);
    expect([b.geraete[0].unterzeile, b.geraete[0].anbindungText]).toEqual(['WAGO PFC200', 'Modbus TCP · 192.168.4.165:503']);
    expect(kastenSatz(b.geraete, b.wege)).toBe('1 Gerät');
    expect(tabellenZeilen(baum, LEERER_FILTER, ALLES_OFFEN).map((z) => z.typ)).toEqual(['anlage', 'box', 'geraet']);
    expect(baum.anlagen[0].geraeteZahl).toBe(1);
    expect(aufbauZahlen(baum, LEERER_FILTER).geraete).toBe(1);
    expect(karten.find((k) => k.art === 'box')?.zusatz).toBe('Vermittelt zwischen Ihren Geräten und VoltPilot — 1 Gerät angebunden.');
    // Netz und Haus bleiben Komponenten der Anlage (Energiefluss, Cockpit) — nur ohne erfundenes Gerät.
    const grund = model.components.filter((c) => c.role === 'grid' || c.role === 'house');
    expect(grund.map((c) => [c.entityId, c.deviceIds, c.provenance])).toEqual([
      ['e-netz', [], null],
      ['e-haus', [], null],
    ]);
  });

  it('mit Speicher bleibt der Wechselrichter mit Speicher, Netz und Haus wie heute', () => {
    const { box: b } = gore([SPEICHER, NETZ, HAUS, STEUERUNG]);
    expect(zeilen(b)).toEqual(['Anlagensteuerung · Gerät an Ihrer Box', 'Wechselrichter · Gerät an Ihrer Box']);
    expect(b.geraete[1].karte.komponenten.map((c) => c.entityId)).toEqual(['e-batt', 'e-netz', 'e-haus']);
  });

  it('mit eigenem, von der Box gemeldetem Wechselrichter bleibt er das Hauptgerät für Netz und Haus', () => {
    const LOCAL: EntityLocalSetup[] = [
      { id: 'inverter', kind: 'inverter', role: null, brand: 'Deye', model: 'SUN-12K', label: null, reportedAt: FRISCH, adoptedEntityId: null } as EntityLocalSetup,
    ];
    const { box: b } = gore([NETZ, HAUS, STEUERUNG], LOCAL);
    expect(b.geraete.map((g) => g.id)).toEqual(['inverter', 'as-e-as']);
    expect(b.geraete[0].karte.komponenten.map((c) => c.entityId)).toEqual(['e-netz', 'e-haus']);
  });

  it('ohne Anlagensteuerung bleibt das Ersatzgerät für Netz und Haus wie heute', () => {
    const { box: b } = gore([NETZ, HAUS]);
    expect(zeilen(b)).toEqual(['Wechselrichter · Gerät an Ihrer Box']);
  });

  /**
   * EZ-22, Gore nach EZ-21: die Steuerung trägt ihren Pin, die Box meldet dafür eine Quelle der Rolle
   * `plant-controller`, und die Werte kommen an. Der Aufbau sagte trotzdem „Wartet auf die ersten Daten" und
   * „1 braucht Aufmerksamkeit": die Lebendigkeit der Topologie war für eine Steuerung immer `never` (kein
   * telemetry_v2-Kanal), und über den Pin wurde die Quelle zum Gerät mit Zähler-Gesicht. Jetzt liefert der
   * Server die Lebendigkeit aus der jüngsten Lesung des Erzeuger-Bilds, und das Gerät bleibt `as-…`.
   */
  const PIN = 'src-as-192.168.4.165-503-1';
  const MIT_PIN = { ...STEUERUNG, edgeSourceId: PIN } as SiteEntity;
  const QUELLE: EntityLocalSetup = {
    id: PIN, kind: 'source', role: 'plant-controller', brand: null, model: null, label: 'Anlagensteuerung',
    reportedAt: FRISCH, adoptedEntityId: null,
  } as EntityLocalSetup;
  const lebendig = (health: string): SiteTopology => ({
    schemaVersion: '1.0',
    entities: [
      { id: 'e-netz', entityType: 'grid-meter', typeLabel: 'Netz', label: null, category: 'meter', health: 'never', capabilities: [] },
      { id: 'e-as', entityType: 'anlagensteuerung', typeLabel: 'Anlagensteuerung', label: 'Anlagensteuerung', category: 'meter', health, capabilities: [] },
    ],
    topology: { schema_version: '1.0', nodes: [] },
  } as unknown as SiteTopology);

  it('liest die Steuerung, sagen Aufbau-Zeile, Kopfsatz und Zähler „liefert Daten" - ein Gerät `as-…`, keine Quelle', () => {
    const { model, karten, baum, box: b } = gore([NETZ, HAUS, MIT_PIN], [QUELLE], lebendig('ok'));
    expect(b.geraete.map((g) => g.id)).toEqual(['as-e-as']);
    expect(b.geraete[0].zustandWort).toBe('Liefert Daten');
    expect(b.geraete[0].ton).toBe('ok');
    expect(model.devices.some((d) => d.id === PIN)).toBe(false);
    expect(model.newlyReported).toEqual([]);
    expect(zentraleSatz(karten).text).toBe('Box verbunden · Ihr Gerät liefert Daten.');
    expect(aufbauZahlen(baum, LEERER_FILTER)).toMatchObject({ geraete: 1, achtung: 0, gemeldet: 0 });
  });

  it('ohne Lesung bleibt es ehrlich: „Wartet auf die ersten Daten", ohne Topologie „Noch keine Rückmeldung"', () => {
    const nie = gore([NETZ, HAUS, MIT_PIN], [QUELLE], lebendig('never'));
    expect(nie.box.geraete.map((g) => [g.id, g.zustandWort])).toEqual([['as-e-as', 'Wartet auf die ersten Daten']]);
    expect(zentraleSatz(nie.karten).text).toBe('Box verbunden · „Anlagensteuerung" Wartet auf die ersten Daten.');
    expect(aufbauZahlen(nie.baum, LEERER_FILTER).achtung).toBe(1);
    expect(gore([NETZ, HAUS, MIT_PIN], [QUELLE]).box.geraete[0].zustandWort).toBe('Noch keine Rückmeldung');
  });
});

/**
 * GE-1 — „Der Aufbau zeigt, was man anfassen kann — je Kasten ein Eintrag" (Konzept „Ein Gerät, ein Eintrag",
 * §7/§9, entschieden 23.10.2026). Eine Datenquelle ist der WEG zu einem Gerät: 1 : 1 steht sie an der
 * Gerätezeile, 1 : N als Gateway mit den Geräten darunter, 1 : 0 als „Anschluss ohne Gerät".
 */
describe('aufbauBaum — ein Eintrag je Kasten (GE-1)', () => {
  const BOX_A = box({ id: 'box-a', externalRef: 'VP-HS-0001', name: 'Box Halle' });
  const BOX_B = box({ id: 'box-b', externalRef: 'VP-HS-0002', name: 'Box Hof' });
  const geraet = (id: string, titel: string, untertitel = 'Zähler') =>
    karte({ id, art: 'geraet', titel, untertitel, komponenten: [komp({ id: `k-${id}`, role: 'grid' })] });
  const LIEFERT = {
    zustand: 'liefert', fehlerklasse: null, seit: null, gelesen_am: FRISCH, anfragen_pro_minute: 6,
    messwerte_pro_minute: 30, gemeldet_am: FRISCH, text: 'Liefert Daten',
  } as const;
  const dq = (o: Partial<UemsDatenquelle> & Pick<UemsDatenquelle, 'id' | 'kennzeichen'>): UemsDatenquelle => ({
    name: null, anlage: 's-1', protokoll: 'modbus_tcp', adresse: '192.168.10.31:502', geraete_ids: [1], netz: null,
    mehrere_leser: false, steuerquelle: false, vergleichsquelle: false, kadenz_s: 10, archiviert_am: null,
    zustaendige_box: { id: 'box-a', name: 'Box Halle', heimat_anlage: 's-1' }, zeitraeume: [], rueckmeldung: LIEFERT,
    ...o,
  });
  /** Ein UEMS-Gerät, das die Komponente `k-<karte>` speist und (vielleicht) auf einen Weg zeigt. */
  const gr = (karteId: string, dataSource: string | null, o: Partial<UemsGeraet> = {}): UemsGeraet => ({
    id: `gr-${karteId}`, kennzeichen: `GR-${karteId}`, einbau_kennzeichen: `GR-${karteId}`, ausgebaut_am: null,
    data_source_id: dataSource, komponenten: [{ entity_id: `k-${karteId}`, gueltig_ab: '2026-09-01T00:00:00Z', gueltig_bis: null }],
    ...o,
  });
  const mit = (o: Partial<AufbauEingabe>): AufbauEingabe =>
    eingabe({
      devices: [BOX_A], karten: [], localSetup: null, charging: null, registryBoxId: 'box-a', overview: null,
      datenquellen: [], uemsGeraete: { 's-1': [] }, ...o,
    });
  const typen = (zeilen: TabellenZeile[]) =>
    zeilen.map((z) => `${z.typ}@${z.ebene}${'geraet' in z ? `:${z.geraet.id}` : 'weg' in z ? `:${z.weg.kennzeichen}` : ''}`);

  describe('Gateway (1 : N)', () => {
    const GW = dq({ id: 'dq-3', kennzeichen: 'DQ-3', name: 'Zählergateway Halle', geraete_ids: [1, 2, 3, 4] });
    const WR = dq({ id: 'dq-1', kennzeichen: 'DQ-1', protokoll: 'sunspec_modbus', adresse: '192.168.10.20:502' });
    const zaehler = ['haupt', 'kompressor', 'licht', 'buero'];
    const eingabeGateway = () =>
      mit({
        karten: [geraet('wr', 'Wechselrichter Dach', 'PV-Wechselrichter'), ...zaehler.map((z) => geraet(z, z))],
        datenquellen: [GW, WR],
        uemsGeraete: { 's-1': [gr('wr', 'dq-1'), ...zaehler.map((z, i) => gr(z, 'dq-3', { geraete_id: i + 1 }))] },
      });

    it('eine Zeile „Gateway", die vier Geräte eine Ebene tiefer; Box „5 Geräte · 1 Gateway"', () => {
      const baum = aufbauBaum(eingabeGateway());
      const b = baum.anlagen[0].boxen[0];
      expect(b.wege.map((w) => [w.art, w.titel, w.weg, w.geraete.map((g) => g.id)])).toEqual([
        ['gateway', 'Zählergateway Halle', 'Modbus TCP · 192.168.10.31:502 · Geräte-IDs 1–4 · Kennung DQ-3', zaehler],
      ]);
      expect(typen(tabellenZeilen(baum, LEERER_FILTER, ALLES_OFFEN))).toEqual([
        'anlage@0', 'box@1', 'geraet@2:wr', 'gateway@2:DQ-3',
        'geraet@3:haupt', 'geraet@3:kompressor', 'geraet@3:licht', 'geraet@3:buero',
      ]);
      expect(kastenSatz(b.geraete, b.wege)).toBe('5 Geräte · 1 Gateway');
      expect(aufbauZahlen(baum, LEERER_FILTER)).toMatchObject({ geraete: 5, gateways: 1, achtung: 0 });
    });

    it('nur das Gateway und seine vier Zähler: „4 Geräte · 1 Gateway" (Abnahme §9)', () => {
      const e = eingabeGateway();
      const b = aufbauBaum({ ...e, karten: e.karten!.slice(1), datenquellen: [GW] }).anlagen[0].boxen[0];
      expect(kastenSatz(b.geraete, b.wege)).toBe('4 Geräte · 1 Gateway');
    });

    it('ein Gerät hinter dem Gateway nennt seine Geräte-ID und „über das Gateway"; der 1 : 1-Weg steht am Gerät', () => {
      const b = aufbauBaum(eingabeGateway()).anlagen[0].boxen[0];
      const kompressor = b.geraete.find((g) => g.id === 'kompressor')!;
      expect([kompressor.anbindungText, kompressor.artWort, kompressor.gateway]).toEqual([
        'Geräte-ID 2', 'Zähler · über das Gateway', { id: 'dq-3', titel: 'Zählergateway Halle' },
      ]);
      const wr = b.geraete.find((g) => g.id === 'wr')!;
      expect([wr.anbindungText, wr.gateway]).toEqual(['SunSpec-Modbus · 192.168.10.20:502', null]);
    });

    it('zugeklappt verschwinden seine Geräte; mit Suche steht es nur mit dem Treffer da', () => {
      const baum = aufbauBaum(eingabeGateway());
      const zu = { offen: (id: string) => id !== 'dq-3', geraete: new Set<string>() };
      expect(typen(tabellenZeilen(baum, LEERER_FILTER, zu))).toEqual(['anlage@0', 'box@1', 'geraet@2:wr', 'gateway@2:DQ-3']);
      expect(typen(tabellenZeilen(baum, { ...LEERER_FILTER, q: 'licht' }, ALLES_OFFEN))).toEqual([
        'anlage@0', 'box@1', 'gateway@2:DQ-3', 'geraet@3:licht',
      ]);
      // Die Kennung des Weges findet ihre Geräte — DQ-3 bleibt das Suchwort des Supports (GD-5 A).
      expect(typen(tabellenZeilen(baum, { ...LEERER_FILTER, q: 'DQ-1' }, ALLES_OFFEN))).toEqual(['anlage@0', 'box@1', 'geraet@2:wr']);
    });
  });

  describe('Anschluss ohne Gerät (1 : 0)', () => {
    const ENTWURF = dq({ id: 'dq-5', kennzeichen: 'DQ-5', adresse: '192.168.10.40:502', rueckmeldung: null });

    it('ein Weg ohne Gerät steht als „Anschluss ohne Gerät" da — Box „1 Gerät · 1 Anschluss offen"', () => {
      const baum = aufbauBaum(mit({ karten: [geraet('wr', 'Wechselrichter')], datenquellen: [ENTWURF] }));
      const b = baum.anlagen[0].boxen[0];
      expect(b.wege.map((w) => [w.art, w.titel, w.weg, w.zustandWort, w.zustandZeit])).toEqual([
        ['offen', 'Anschluss ohne Gerät', 'Modbus TCP · 192.168.10.40:502 · Geräte-ID 1 · Kennung DQ-5', 'Angefangen', null],
      ]);
      expect(typen(tabellenZeilen(baum, LEERER_FILTER, ALLES_OFFEN))).toEqual(['anlage@0', 'box@1', 'geraet@2:wr', 'anschluss@2:DQ-5']);
      expect(kastenSatz(b.geraete, b.wege)).toBe('1 Gerät · 1 Anschluss offen');
      // Ein Anschluss ist kein Gerät: er zählt weder als Gerät noch in „brauchen Aufmerksamkeit".
      expect(aufbauZahlen(baum, LEERER_FILTER)).toMatchObject({ geraete: 1, gateways: 0, achtung: 0 });
    });

    it('auch ohne zuständige Box sichtbar (vorher unsichtbar) — „von keiner Box gelesen"', () => {
      const ohneBox = { ...ENTWURF, zustaendige_box: null };
      const b = aufbauBaum(mit({ datenquellen: [ohneBox] })).anlagen[0].boxen[0];
      expect(b.wege.map((w) => [w.titel, w.zustandWort, w.zustandZeit])).toEqual([
        ['Anschluss ohne Gerät', 'Angefangen', 'von keiner Box gelesen'],
      ]);
      // An einer Anlage ganz ohne Box steht er direkt unter der Anlage.
      const baum = aufbauBaum(mit({ devices: [], datenquellen: [ohneBox] }));
      expect(baum.anlagen[0].wegeOhneBox.map((w) => w.kennzeichen)).toEqual(['DQ-5']);
      expect(typen(tabellenZeilen(baum, LEERER_FILTER, ALLES_OFFEN))).toEqual(['anlage@0', 'anschluss@1:DQ-5', 'leer@1']);
    });

    it('ein archivierter Weg steht nirgends; ohne `GET …/geraete` rät der Aufbau keinen Anschluss', () => {
      expect(aufbauBaum(mit({ datenquellen: [{ ...ENTWURF, archiviert_am: FRISCH }] })).anlagen[0].boxen[0].wege).toEqual([]);
      const unbekannt = aufbauBaum(mit({ karten: [geraet('wr', 'Wechselrichter')], datenquellen: [ENTWURF], uemsGeraete: {} }));
      expect(unbekannt.anlagen[0].boxen[0].wege).toEqual([]);
      expect(unbekannt.anlagen[0].boxen[0].geraete[0].anbindungen).toEqual([]);
    });
  });

  describe('Zustand: der schlechtere aus Gerätewerten und Box-Rückmeldung', () => {
    const GESTOERT = dq({
      id: 'dq-1', kennzeichen: 'DQ-1',
      rueckmeldung: { ...LIEFERT, zustand: 'liefert_nicht', fehlerklasse: 'no_answer', seit: '2026-09-10T09:12:00Z', text: 'Liefert keine Daten' },
    });

    it('ein Weg „liefert nicht" stellt sein Gerät auf Achtung, mit Grund, und es zählt in „brauchen Aufmerksamkeit"', () => {
      const baum = aufbauBaum(mit({ karten: [geraet('z', 'Hauptzähler')], datenquellen: [GESTOERT], uemsGeraete: { 's-1': [gr('z', 'dq-1')] } }));
      const g = baum.anlagen[0].boxen[0].geraete[0];
      expect([g.ton, g.zustandWort]).toEqual(['warn', 'Liefert keine Daten']);
      expect(g.zustandZeit).toMatch(/^Zeitüberschreitung · Seit /);
      expect(aufbauZahlen(baum, LEERER_FILTER).achtung).toBe(1);
      expect(typen(tabellenZeilen(baum, { ...LEERER_FILTER, zustand: ['achtung'] }, ALLES_OFFEN))).toEqual(['anlage@0', 'box@1', 'geraet@2:z']);
    });

    it('„Box meldet noch nicht je Quelle" ist keine Störung — das Gerät bleibt, wie seine Werte es sagen', () => {
      const noch = { ...GESTOERT, rueckmeldung: { ...LIEFERT, zustand: 'meldet_noch_nicht_je_quelle' as const } };
      for (const q of [noch, { ...GESTOERT, rueckmeldung: null }]) {
        const baum = aufbauBaum(mit({ karten: [geraet('z', 'Hauptzähler')], datenquellen: [q], uemsGeraete: { 's-1': [gr('z', 'dq-1')] } }));
        const g = baum.anlagen[0].boxen[0].geraete[0];
        expect([g.ton, g.zustandWort]).toEqual(['ok', 'liefert Daten · vor 12 Sek.']);
        expect(aufbauZahlen(baum, LEERER_FILTER).achtung).toBe(0);
      }
    });

    it('hinter einem gestörten Gateway steht jedes Gerät auf Achtung', () => {
      const gw = { ...GESTOERT, geraete_ids: [1, 2] };
      const baum = aufbauBaum(mit({
        karten: [geraet('a', 'Zähler A'), geraet('b', 'Zähler B')],
        datenquellen: [gw],
        uemsGeraete: { 's-1': [gr('a', 'dq-1'), gr('b', 'dq-1')] },
      }));
      const [w] = baum.anlagen[0].boxen[0].wege;
      expect([w.art, w.ton, w.zustandWort]).toEqual(['gateway', 'warn', 'Liefert keine Daten']);
      expect(aufbauZahlen(baum, LEERER_FILTER)).toMatchObject({ geraete: 2, achtung: 2 });
    });
  });

  describe('Identität: nur gespeicherte Verweise', () => {
    // Zwei Box-Quellen an DERSELBEN Adresse wie DQ-1 (Unit 1 und 2) — aber ohne gespeicherten Verweis.
    const PIN_1 = karte({ id: 'src-192.168.4.165-503-1', art: 'geraet', titel: 'Zähler 1', komponenten: [komp({ id: 'k-1', role: 'grid' })] });
    const PIN_2 = karte({ id: 'src-192.168.4.165-503-2', art: 'geraet', titel: 'Zähler 2', komponenten: [komp({ id: 'k-2', role: 'grid' })] });
    const DQ_GLEICH = dq({ id: 'dq-1', kennzeichen: 'DQ-1', adresse: '192.168.4.165:503', geraete_ids: [1, 2] });

    it('Gegenprobe: gleiche Adresse ohne Verweis legt NICHTS zusammen — kein Gateway, keine Anbindung, der Weg bleibt offen', () => {
      const ohneVerweis = [{ ...gr('x', null), komponenten: [{ entity_id: 'k-1', gueltig_ab: '2026-09-01T00:00:00Z', gueltig_bis: null }] }];
      const baum = aufbauBaum(mit({ karten: [PIN_1, PIN_2], datenquellen: [DQ_GLEICH], uemsGeraete: { 's-1': ohneVerweis } }));
      const b = baum.anlagen[0].boxen[0];
      expect(b.geraete.map((g) => [g.id, g.anbindungen.length, g.gateway])).toEqual([
        ['src-192.168.4.165-503-1', 0, null],
        ['src-192.168.4.165-503-2', 0, null],
      ]);
      expect(b.wege.map((w) => [w.art, w.kennzeichen])).toEqual([['offen', 'DQ-1']]);
    });

    it('nur das Gerät mit Verweis trägt den Weg — der Nachbar an derselben Adresse nicht', () => {
      const v = (id: string, entity: string, ds: string | null): UemsGeraet => ({
        ...gr(id, ds), komponenten: [{ entity_id: entity, gueltig_ab: '2026-09-01T00:00:00Z', gueltig_bis: null }],
      });
      const b = aufbauBaum(mit({
        karten: [PIN_1, PIN_2], datenquellen: [DQ_GLEICH], uemsGeraete: { 's-1': [v('a', 'k-1', 'dq-1'), v('b', 'k-2', null)] },
      })).anlagen[0].boxen[0];
      expect(b.geraete.map((g) => g.anbindungen.map((a) => a.kennzeichen))).toEqual([['DQ-1'], []]);
      expect(b.wege).toEqual([]);
    });

    it('ein ausgebautes Gerät oder eine beendete Zuordnung trägt keinen Weg mehr', () => {
      for (const alt of [
        gr('z', 'dq-1', { ausgebaut_am: '2026-09-09T00:00:00Z' }),
        gr('z', 'dq-1', { komponenten: [{ entity_id: 'k-z', gueltig_ab: '2026-09-01T00:00:00Z', gueltig_bis: '2026-09-09T00:00:00Z' }] }),
      ]) {
        const b = aufbauBaum(mit({ karten: [geraet('z', 'Zähler')], datenquellen: [dq({ id: 'dq-1', kennzeichen: 'DQ-1' })], uemsGeraete: { 's-1': [alt] } })).anlagen[0].boxen[0];
        expect(b.geraete[0].anbindungen).toEqual([]);
        expect(b.wege.map((w) => w.art)).toEqual(['offen']);
      }
    });
  });

  describe('zwei Boxen: das Gerät steht unter der Box, die seinen Weg liest', () => {
    const WEG_B = dq({ id: 'dq-2', kennzeichen: 'DQ-2', zustaendige_box: { id: 'box-b', name: 'Box Hof', heimat_anlage: 's-1' } });
    const zwei = (o: Partial<AufbauEingabe> = {}) =>
      mit({
        devices: [BOX_A, BOX_B],
        karten: [geraet('wr', 'Wechselrichter'), geraet('z', 'Zähler Hof')],
        datenquellen: [WEG_B],
        uemsGeraete: { 's-1': [gr('z', 'dq-2')] },
        ...o,
      });

    it('der Zähler hängt unter Box Hof (sie liest DQ-2), nicht unter der führenden Box Halle', () => {
      const [a, b] = aufbauBaum(zwei()).anlagen[0].boxen;
      expect([a.name, a.fuehrend, a.geraete.map((g) => g.id)]).toEqual(['Box Halle', true, ['wr']]);
      expect([b.name, b.geraete.map((g) => g.id)]).toEqual(['Box Hof', ['z']]);
      expect(b.geraete[0].anbindungText).toBe('Modbus TCP · 192.168.10.31:502');
    });

    it('liest eine Box einer anderen Anlage den Weg, bleibt das Gerät in seiner Anlage und sagt, wer liest', () => {
      const fremd = { ...WEG_B, zustaendige_box: { id: 'box-x', name: 'Box Nachbarhalle', heimat_anlage: 's-2' } };
      const boxX = box({ id: 'box-x', externalRef: 'VP-NB-0001', name: 'Box Nachbarhalle', siteId: 's-2' });
      const [a] = aufbauBaum(zwei({ devices: [BOX_A, BOX_B, boxX], datenquellen: [fremd] })).anlagen[0].boxen;
      expect(a.geraete.find((g) => g.id === 'z')?.anbindungText).toBe('Modbus TCP · 192.168.10.31:502 · gelesen von Box Nachbarhalle');
    });

    it('am Standort: jeder Weg bleibt bei seiner Anlage — die Nachbar-Anlage zeigt ihren erst mit ihren Geräten', () => {
      const standort = mit({
        standorte: STANDORTE([{ id: 's-1', name: 'Halle 1' }, { id: 's-2', name: 'Halle 2' }]),
        devices: [BOX_A, box({ id: 'box-n', externalRef: 'VP-N-1', name: 'Box Halle 2', siteId: 's-2' })],
        datenquellen: [dq({ id: 'dq-9', kennzeichen: 'DQ-9', anlage: 's-2', zustaendige_box: { id: 'box-n', name: 'Box Halle 2', heimat_anlage: 's-2' } })],
        uemsGeraete: { 's-1': [], 's-2': [gr('n', 'dq-9')] },
      });
      const vorher = aufbauBaum(standort);
      expect(vorher.anlagen.map((x) => x.boxen.map((b) => b.wege.length))).toEqual([[0], [0]]);
      const nachher = aufbauBaum({ ...standort, nachbarKarten: { 's-2': [geraet('n', 'Zähler Halle 2')] } });
      expect(nachher.anlagen[1].boxen[0].geraete.map((g) => [g.id, g.anbindungen[0]?.kennzeichen])).toEqual([['n', 'DQ-9']]);
      expect(nachher.anlagen[0].boxen[0].wege).toEqual([]);
    });
  });
});

