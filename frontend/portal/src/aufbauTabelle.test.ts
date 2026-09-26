import { describe, expect, it } from 'vitest';
import type { Device, EntityLocalSetup } from './api';
import { aufbauBaum, type AufbauEingabe } from './aufbauBaum';
import {
  LEERER_FILTER,
  OHNE_BOX,
  OHNE_MARKE,
  aktiveFilter,
  artVon,
  aufbauZahlen,
  filterAktiv,
  filterOptionen,
  kurzfilter,
  mitFilter,
  tabellenZeilen,
  type Aufklappzustand,
  type AufbauFilter,
  type TabellenZeile,
} from './aufbauTabelle';
import type { PlantComponent } from './komponenten';
import type { ChargePoint, SiteCharging } from './ladepunkte';
import type { GeraeteKarte } from './zentraleListe';

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
  zustandWort: 'liefert Daten',
  zustandZeit: 'vor 12 Sek.',
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
    komp({ id: 'batt', role: 'storage', label: 'Speicher', reading: { value: 64, unit: '%', caption: 'geladen' } }),
    komp({ id: 'batt#pv', role: 'pv', aspect: 'pv', label: 'Solarmodule', reading: { value: 6.2, unit: 'kW', caption: null } }),
    komp({ id: 'grid', role: 'grid', label: 'Netzanschluss', reading: { value: 3.4, unit: 'kW', caption: 'Einspeisung' } }),
  ],
});
const HEIZSTAB = karte({
  id: 'heizstab',
  art: 'geraet',
  titel: 'Heizstab',
  untertitel: 'Verbraucher',
  ton: 'warn',
  zustand: 'meldet sich nicht · vor 2 Std.',
  zustandWort: 'meldet sich nicht',
  zustandZeit: 'vor 2 Std.',
  komponenten: [komp({ id: 'heiz', role: 'consumer', label: 'Heizstab' })],
});
const SAEULE = karte({ id: 'cp-CP-1', art: 'ladepunkt', titel: 'Wallbox Carport', untertitel: 'Ladesäule · 1 Stecker' });
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
  {
    id: 'heizstab',
    kind: 'source',
    role: 'consumer',
    brand: 'shelly',
    model: null,
    label: 'Heizstab',
    reportedAt: FRISCH,
    adoptedEntityId: 'heiz',
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

const eingabe = (o: Partial<AufbauEingabe> = {}): AufbauEingabe => ({
  siteId: 's-1',
  siteName: 'Sonnenhof',
  standorte: null,
  devices: [box({ id: 'b-1', externalRef: 'VP-DEMO-0001', name: 'Box Scheune' })],
  devicesFetchedAt: NOW,
  karten: [karte({ id: 'box:VP-DEMO-0001', art: 'box' }), HYBRID, HEIZSTAB, SAEULE, FUND],
  localSetup: LOCAL_SETUP,
  charging: { budget: null, chargers: [saeule()] } as unknown as SiteCharging,
  registryBoxId: 'b-1',
  overview: null,
  now: NOW,
  ...o,
});

const ALLES_OFFEN: Aufklappzustand = { offen: (_id, vorgabe) => vorgabe, geraete: new Set() };
const zeilen = (f: Partial<AufbauFilter> = {}, z: Aufklappzustand = ALLES_OFFEN, e = eingabe()) =>
  tabellenZeilen(aufbauBaum(e), { ...LEERER_FILTER, ...f }, z);
const kurz = (rows: TabellenZeile[]) => rows.map((r) => `${r.typ}:${r.key}`);

describe('tabellenZeilen — ohne Suche und Filter', () => {
  it('legt Anlage, Box und Geräte in Lese-Reihenfolge mit Ebenen aus', () => {
    const rows = zeilen();
    expect(kurz(rows)).toEqual([
      'anlage:s-1',
      'box:b-1',
      'geraet:inverter',
      'geraet:heizstab',
      'geraet:cp-CP-1',
      'fund:neu:src-7',
    ]);
    expect(rows.map((r) => r.ebene)).toEqual([0, 1, 2, 2, 2, 2]);
  });

  it('bietet nur Geräten mit mehreren Komponenten die Unterzeilen an', () => {
    const rows = zeilen();
    const hybrid = rows.find((r) => r.key === 'inverter');
    const heiz = rows.find((r) => r.key === 'heizstab');
    expect(hybrid?.typ === 'geraet' && hybrid.teilbar).toBe(true);
    expect(heiz?.typ === 'geraet' && heiz.teilbar).toBe(false);
  });

  it('klappt die Messwerte eines Geräts als Unterzeilen eine Ebene tiefer auf (K5)', () => {
    const rows = zeilen({}, { ...ALLES_OFFEN, geraete: new Set(['inverter']) });
    const teile = rows.filter((r) => r.typ === 'teil');
    expect(teile.map((r) => (r.typ === 'teil' ? r.komponente.label : ''))).toEqual([
      'Speicher',
      'Solarmodule',
      'Netzanschluss',
    ]);
    expect(teile.every((r) => r.ebene === 3)).toBe(true);
    // Die Unterzeilen stehen direkt unter ihrem Gerät.
    expect(kurz(rows).indexOf('teil:inverter::batt')).toBe(kurz(rows).indexOf('geraet:inverter') + 1);
  });

  it('zeigt eine zugeklappte Anlage als EINE Zeile', () => {
    const rows = zeilen({}, { offen: (id) => id !== 's-1', geraete: new Set() });
    expect(kurz(rows)).toEqual(['anlage:s-1']);
    expect(rows[0].typ === 'anlage' && rows[0].offen).toBe(false);
  });

  it('nennt eine Box ohne Gerät und eine Anlage ohne Box ehrlich', () => {
    const leer = zeilen({}, ALLES_OFFEN, eingabe({ karten: [] }));
    expect(leer.find((r) => r.typ === 'leer')).toMatchObject({ text: 'Noch kein Gerät an dieser Box', ebene: 2 });
    const ohneBox = zeilen({}, ALLES_OFFEN, eingabe({ devices: [], karten: [] }));
    expect(ohneBox.find((r) => r.typ === 'leer')).toMatchObject({
      text: 'Noch keine VoltPilot-Box',
      boxHinzufuegen: true,
    });
  });
});

describe('tabellenZeilen — Suche', () => {
  it('findet ein Gerät über sein Modell in jeder Schreibweise', () => {
    expect(kurz(zeilen({ q: 'sun12k' }))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:inverter']);
    expect(kurz(zeilen({ q: 'SUN-12K' }))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:inverter']);
  });

  it('findet eine Ladesäule über ihre Kennung', () => {
    expect(kurz(zeilen({ q: 'cp-1' }))).toContain('geraet:cp-CP-1');
    expect(kurz(zeilen({ q: 'cp-1' }))).not.toContain('geraet:inverter');
  });

  it('findet ein Gerät über den Namen seiner Komponente', () => {
    expect(kurz(zeilen({ q: 'netzanschluss' }))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:inverter']);
  });

  it('zeigt über den Box-Namen alle Geräte dieser Box', () => {
    const rows = zeilen({ q: 'scheune' });
    expect(rows.filter((r) => r.typ === 'geraet' || r.typ === 'fund')).toHaveLength(4);
  });

  it('öffnet Gruppen mit Treffern, auch wenn sie zugeklappt waren', () => {
    const zu: Aufklappzustand = { offen: () => false, geraete: new Set() };
    expect(kurz(zeilen({ q: 'heizstab' }, zu))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:heizstab']);
  });

  it('verlangt JEDEN Begriff (UND) und liefert ohne Treffer keine Zeile', () => {
    expect(kurz(zeilen({ q: 'deye heizstab' }))).toEqual([]);
    expect(zeilen({ q: 'gibtsnicht' })).toEqual([]);
  });
});

describe('tabellenZeilen — Filter', () => {
  it('filtert nach Zustand: nur das Gemeldete', () => {
    expect(kurz(zeilen({ zustand: ['gemeldet'] }))).toEqual(['anlage:s-1', 'box:b-1', 'fund:neu:src-7']);
  });

  it('filtert nach Zustand: was Aufmerksamkeit braucht', () => {
    expect(kurz(zeilen({ zustand: ['achtung'] }))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:heizstab']);
  });

  it('filtert nach Hersteller - ohne Angabe ist ein eigener Wert', () => {
    expect(kurz(zeilen({ marke: ['Deye'] }))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:inverter']);
    expect(kurz(zeilen({ marke: [OHNE_MARKE] }))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:cp-CP-1']);
  });

  it('filtert nach Art, ohne die Rolle („Hauptgerät") mitzuzählen', () => {
    const baum = aufbauBaum(eingabe());
    expect(artVon(baum.anlagen[0].boxen[0].geraete[0])).toBe('Hybrid-Wechselrichter');
    expect(kurz(zeilen({ art: ['Hybrid-Wechselrichter'] }))).toEqual(['anlage:s-1', 'box:b-1', 'geraet:inverter']);
  });

  it('verbindet Filter verschiedener Art mit UND, Werte eines Filters mit ODER', () => {
    expect(kurz(zeilen({ art: ['Ladesäule', 'Verbraucher'] }))).toEqual([
      'anlage:s-1',
      'box:b-1',
      'geraet:heizstab',
      'geraet:cp-CP-1',
    ]);
    expect(kurz(zeilen({ art: ['Ladesäule', 'Verbraucher'], zustand: ['ok'] }))).toEqual([
      'anlage:s-1',
      'box:b-1',
      'geraet:cp-CP-1',
    ]);
  });

  it('filtert nach Box - bei zwei Boxen steht das Gemeldete „ohne sichere Box"', () => {
    const zwei = eingabe({
      devices: [
        box({ id: 'b-1', externalRef: 'VP-1', name: 'Box Scheune' }),
        box({ id: 'b-2', externalRef: 'VP-2', name: 'Box Halle' }),
      ],
    });
    const optionen = filterOptionen(aufbauBaum(zwei));
    expect(optionen.box.map((o) => o.label)).toEqual(['Box Scheune', 'Box Halle', 'Ohne sichere Box']);
    expect(kurz(zeilen({ box: [OHNE_BOX] }, ALLES_OFFEN, zwei))).toEqual(['anlage:s-1', 'fund:neu:src-7']);
  });
});

describe('filterOptionen, aktiveFilter, aufbauZahlen', () => {
  it('zählt je Eintrag und stellt „Ohne Herstellerangabe" ans Ende', () => {
    const o = filterOptionen(aufbauBaum(eingabe()));
    expect(o.art.map((x) => `${x.label} ${x.anzahl}`)).toEqual([
      'Hybrid-Wechselrichter 1',
      'Ladesäule 1',
      'Verbraucher 1',
      'Von der Box gemeldet 1',
    ]);
    expect(o.zustand.map((x) => x.label)).toEqual(['In Ordnung', 'Braucht Aufmerksamkeit', 'Von der Box gemeldet']);
    expect(o.marke.map((x) => x.label)).toEqual(['Deye', 'Fronius', 'Shelly', OHNE_MARKE]);
  });

  it('beschriftet aktive Filter als Chips', () => {
    const o = filterOptionen(aufbauBaum(eingabe()));
    const f = mitFilter(mitFilter(LEERER_FILTER, 'zustand', ['achtung']), 'marke', ['Deye']);
    expect(aktiveFilter(f, o).map((a) => a.label)).toEqual(['Zustand: Braucht Aufmerksamkeit', 'Hersteller: Deye']);
  });

  it('zählt Geräte, Treffer, Aufmerksamkeit und Gemeldetes der geöffneten Anlage', () => {
    const baum = aufbauBaum(eingabe());
    expect(aufbauZahlen(baum, LEERER_FILTER)).toEqual({ geraete: 3, treffer: 3, achtung: 1, gemeldet: 1, aktiv: false });
    expect(aufbauZahlen(baum, { ...LEERER_FILTER, q: 'deye' })).toMatchObject({ treffer: 1, aktiv: true });
  });

  it('ersetzt mit einem Kurzfilter Suche und Filter', () => {
    expect(kurzfilter('gemeldet')).toEqual({ ...LEERER_FILTER, zustand: ['gemeldet'] });
    expect(filterAktiv(kurzfilter('ok'))).toBe(true);
    expect(filterAktiv(LEERER_FILTER)).toBe(false);
  });
});
