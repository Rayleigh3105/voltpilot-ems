import { describe, expect, it } from 'vitest';
import type { Device, EntityLocalSetup, OverviewSite, StandorteAmStichtag } from './api';
import {
  OHNE_STANDORT,
  anlagenWerte,
  aufbauBaum,
  aufbauWurzel,
  komponentenWerte,
  ladeWert,
  type AufbauEingabe,
} from './aufbauBaum';
import type { PlantComponent } from './komponenten';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import type { GeraeteKarte } from './zentraleListe';

/** `fmtNum` trennt Zahl und Einheit mit einem geschützten Leerzeichen. */
const plain = (s: string) => s.replace(/\u00a0/g, ' ');
const texte = (werte: { text: string }[]) => werte.map((w) => plain(w.text));

const NOW = Date.parse('2026-09-10T10:00:00Z');
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
