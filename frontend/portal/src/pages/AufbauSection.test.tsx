import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AufbauSection } from './AufbauSection';
import {
  api,
  ApiError,
  type Device,
  type Site,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
  type StandorteAmStichtag,
  type UemsDatenquelle,
} from '../api';
import * as auth from '../auth';
import { entitiesApi } from '../entitiesApi';
import { consumersApi } from '../consumers/consumersApi';
import { OHNE_STANDORT } from '../aufbauBaum';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';

/*
  Der Reiter „Aufbau" (Konzept „Anlage – neu gedacht", E1–E6 = A). Die
  Verteilung auf Standort → Anlage → Box → Gerät prüft `aufbauBaum.test.ts`
  erschöpfend; hier steht, was nur die Fläche beantworten kann - und der
  Kein-Verlust-Beweis gegenüber der früheren Geräteliste: jede Handlung des
  alten Orts hat im Baum oder im Kurzblick ihren neuen.
*/

// Der Anlage-Assistent ist ein eigenes, lazy geladenes Stück; hier zählt nur,
// dass er AM Standort geöffnet wird.
vi.mock('../components/AnlageAnlegenDrawerLazy', () => ({
  AnlageAnlegenDrawerLazy: ({ open, standortId }: { open: boolean; standortId?: string | null }) =>
    open ? <div data-testid="anlage-anlegen" data-standort={standortId ?? ''} /> : null,
}));

const site: Site = {
  id: 's-1',
  name: 'Testanlage',
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

/** ONE VoltPilot-Box, a hybrid + a Fronius behind it, and a newly reported go-e. */
const entities: SiteEntities = {
  registry: null,
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      role: 'storage',
      label: null,
      control: true,
      deviceId: 'gw',
      capabilities: {
        measure: [
          { channel: 'pv_power_kw', unit: 'kW' },
          { channel: 'soc_pct', unit: '%' },
        ],
      },
      guards: null,
      syncStatus: 'in_sync',
      observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
      edgeSourceId: null,
    },
    {
      id: 'grid',
      entityType: 'grid-meter',
      typeLabel: 'Netzanschluss',
      role: 'grid',
      label: null,
      control: false,
      deviceId: 'gw',
      capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
      guards: null,
      syncStatus: 'in_sync',
      observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
      edgeSourceId: null,
    },
    {
      id: 'fr1',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      role: 'pv',
      label: 'Fronius Anlage',
      control: false,
      deviceId: 'gw',
      capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
      guards: null,
      syncStatus: 'in_sync',
      observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
      edgeSourceId: 'src-1',
    },
  ],
  localSetup: [
    { id: 'inv', kind: 'inverter', role: null, brand: 'deye', model: 'SUN-30K-SG01HP3-EU', label: null, reportedAt: '', adoptedEntityId: null },
    { id: 'src-1', kind: 'source', role: 'pv-generation', brand: 'fronius_sunspec', model: null, label: 'Fronius Anlage', reportedAt: '', adoptedEntityId: 'fr1' },
    { id: 'goe-1', kind: 'source', role: 'consumer', brand: 'go-e', label: 'Charger 3', reportedAt: '', adoptedEntityId: null },
  ],
  staleOnDevice: [],
};

const topology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      label: 'Batteriespeicher',
      category: 'storage',
      health: 'ok',
      capabilities: [
        { channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: false, value: 27 },
        { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: true, value: 9.3 },
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
      ],
    },
    {
      id: 'grid',
      entityType: 'grid-meter',
      typeLabel: 'Netzanschluss',
      label: 'Netzanschluss',
      category: 'meter',
      health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -30 }],
    },
    {
      id: 'fr1',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      label: 'Fronius Anlage',
      category: 'producer',
      health: 'never',
      capabilities: [],
    },
  ],
  topology: {
    schema_version: '1.0',
    nodes: [
      {
        role: 'pv',
        flow_active: true,
        members: [
          { entity_id: 'batt', label: 'Batteriespeicher', primary: false, value_kw: 27 },
          { entity_id: 'fr1', label: 'Fronius Anlage', primary: false },
        ],
      },
    ],
  },
};

const sources: SiteSource[] = [
  {
    deviceId: 'gw',
    sourceId: 'src-1',
    kind: 'source',
    role: 'pv-generation',
    label: 'Fronius Anlage',
    brand: 'fronius_sunspec',
    model: null,
    pvKw: 21.2,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: null,
    reportedAt: '',
  },
];

const boxDevice: Device = {
  id: 'gw',
  siteId: 's-1',
  externalRef: 'VP-ABC123',
  kind: 'inverter',
  name: null,
  status: 'active',
  lastSeenAt: new Date().toISOString(),
  createdAt: null,
};

function standortMit(anlagen: { id: string; name: string }[]): StandorteAmStichtag {
  return {
    stichtag: '2026-09-25',
    nichtGezeigt: [],
    nochNichtZugeordnet: null,
    standorte: [
      {
        id: 'st-1',
        kurzzeichen: 'ST-1',
        name: 'Sonnenhof',
        adresse: { strasse: 'Sonnenweg 1', plz: '80331', ort: 'München', land: 'DE' },
        zeitzone: 'Europe/Berlin',
        zustand: 'aktiv',
        esFehlt: [],
        bestand: 'vorhanden',
        bestandText: null,
        anlagen: anlagen.map((a) => ({ ...a, gueltigAb: '2026-08-01', gueltigBis: null })),
        anlagenZahl: anlagen.length,
        gebaeudeZahl: 0,
        bereichZahl: 0,
        flaecheM2: null,
        flaecheQuelle: null,
      },
    ],
  } as StandorteAmStichtag;
}

const CATALOG = {
  catalog_version: '1.0.0',
  types: [
    { type: 'wallbox', label: 'Wallbox', category: 'consumer', controllable: true, composed: false, default_failsafe: 'release' },
    { type: 'grid-meter', label: 'Netzanschlusszähler', category: 'meter', controllable: false, composed: true, default_failsafe: 'measure-only' },
  ],
};

/** Alles gestubbt; was ein Test nicht braucht, fällt fail-soft aus (Standort, Übersicht, Fassung). */
function stub(hash = `#/anlage/${site.id}/modell`) {
  window.history.replaceState(null, '', hash);
  vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.spyOn(api, 'siteSources').mockResolvedValue(sources);
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
  vi.spyOn(api, 'siteComponents').mockRejectedValue(new ApiError(404, 'Not Found'));
  vi.spyOn(api, 'standorte').mockRejectedValue(new ApiError(404, 'Not Found'));
  vi.spyOn(api, 'overview').mockRejectedValue(new ApiError(503, 'Unavailable'));
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(entitiesApi, 'typeCatalog').mockResolvedValue(CATALOG as never);
  vi.spyOn(consumersApi, 'list').mockResolvedValue([]);
  vi.spyOn(api, 'siteComponentTemplates').mockResolvedValue([]);
}

/** Ein Katalog-Modell, wie `GET /component-templates` es liefert. */
const DEYE_12K = {
  templateRef: 'builtin:deye:sun-12k-sg04lp3-eu',
  kind: 'builtin',
  version: 1,
  brand: 'deye',
  brandLabel: 'Deye',
  model: 'sun-12k-sg04lp3-eu',
  modelLabel: 'SUN-12K-SG04LP3-EU',
  deviceType: 'inverter',
  communication: 'solarman_v5',
  communicationLabel: 'Solarman-V5 (WiFi-Datenlogger, TCP 8899)',
  transportSchema: [
    { key: 'host', label: 'IP-Adresse', type: 'text', required: true },
    { key: 'serial', label: 'Logger-Seriennummer', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', default: 8899 },
  ],
};

function portalVerwaltet(extra: object = {}) {
  vi.spyOn(api, 'siteComponents').mockResolvedValue({
    componentAuthority: 'portal',
    components: [
      { id: 'batt', role: 'inverter', entityType: 'battery-hybrid', templateRef: 'builtin:deye:sun-30k', definitionVersion: 3, syncStatus: 'in_sync' },
    ],
    ...extra,
  } as never);
  vi.spyOn(api, 'componentTemplates').mockResolvedValue([]);
}

function rendere(props: Partial<Parameters<typeof AufbauSection>[0]> = {}) {
  return render(
    <AufbauSection
      site={site}
      sites={[site]}
      devices={[boxDevice]}
      devicesFetchedAt={Date.now()}
      {...props}
    />,
  );
}

/** Die Baum-Zeile eines Geräts (Kennung auf der Box). */
async function zeile(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector(`[data-aufbau-geraet="${id}"]`);
    if (!el) throw new Error(`keine Zeile ${id}`);
    return el as HTMLElement;
  });
}

/** Die Zeile, die einen Titel trägt. */
async function zeileMit(titel: string): Promise<HTMLElement> {
  const treffer = await screen.findAllByText(titel);
  const el = treffer.map((n) => n.closest('[data-aufbau-geraet]')).find(Boolean);
  if (!el) throw new Error(`keine Zeile mit ${titel}`);
  return el as HTMLElement;
}

/** Tippen öffnet den Kurzblick (E2). */
async function kurzblick(el: HTMLElement | Promise<HTMLElement>) {
  fireEvent.click(await el);
  return screen.findByRole('dialog');
}

/** Technische Sicht: der Zeilenmenü-Eintrag „Technisch …“ öffnet den Kurzblick eines Geräts mit eigener Seite. */
async function technischerKurzblick(el: HTMLElement | Promise<HTMLElement>) {
  fireEvent.click(within(await el).getByRole('button', { name: /Weitere Aktionen/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Technisch/ }));
  return screen.findByRole('dialog');
}

/** Die Zeile einer Komponente im Kurzblick. */
function komponente(dialog: HTMLElement, label: string): HTMLElement {
  return within(dialog).getByText(label).closest('li') as HTMLElement;
}

const FORBIDDEN = /Entität|Messpunkt|Quelle|Mess-Einheit|Kanal/;

describe('AufbauSection · der Baum', () => {
  afterEach(() => vi.restoreAllMocks());

  it('steht als Tabelle mit allen Ebenen da - Standort, Anlage, Box, Geräte - auch mit EINER Box', async () => {
    stub();
    vi.mocked(api.standorte).mockResolvedValue(standortMit([{ id: 's-1', name: 'Testanlage' }]));
    rendere();

    const ort = await screen.findByLabelText('Standort Sonnenhof');
    expect(ort).toHaveTextContent('ST-1');
    expect(ort).toHaveTextContent('Sonnenweg 1 · 80331 München');
    expect(ort).toHaveTextContent('1 Anlage · 1 Box');

    const tabelle = screen.getByRole('table', { name: /Aufbau/ });
    expect(within(tabelle).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Gerät',
      'Art',
      'Zustand',
      'Wert',
      '',
    ]);
    const anlage = within(tabelle).getByRole('button', { name: /Anlage Testanlage/ });
    expect(anlage).toHaveAttribute('aria-expanded', 'true');
    expect(anlage).toHaveTextContent('Sie sind hier');

    // Die Box ist ein TOR mit eigener Seite.
    expect(within(tabelle).getByRole('link', { name: 'VoltPilot-Box' })).toHaveAttribute(
      'href',
      '#/anlage/s-1/box/VP-ABC123',
    );
    // Die Geräte stehen darunter - ihr Name führt direkt auf die Geräteseite, kein Modal mehr dazwischen.
    for (const id of ['inv', 'src-1']) {
      const z = await zeile(id);
      expect(z).toHaveAttribute('role', 'row');
      expect(within(z).getByRole('link', { name: new RegExp(id === 'inv' ? 'Deye' : 'Fronius') })).toHaveAttribute(
        'href',
        expect.stringContaining(`/geraet/VP-ABC123/${id}`),
      );
    }
  });

  it('bleibt ohne Standort-Auskunft ehrlich - keine erfundene Adresse', async () => {
    stub();
    rendere();
    const ort = await screen.findByLabelText('Standort');
    expect(ort).toHaveTextContent('Ihre Anlage');
    expect(screen.queryByText(/Adresse/)).toBeNull();
  });

  it('sagt es, wenn die Anlage noch keinem Standort zugeordnet ist', async () => {
    stub();
    vi.mocked(api.standorte).mockResolvedValue({
      stichtag: '2026-09-25',
      standorte: [],
      nichtGezeigt: [],
      nochNichtZugeordnet: { anlagenZahl: 1, anlagen: [{ id: 's-1', name: 'Testanlage' }] },
    });
    rendere();
    expect(await screen.findByText(OHNE_STANDORT)).toBeInTheDocument();
  });

  it('trägt den Hauptwert in der Zeile und die Messwerte als Unterzeilen - die Richtung bleibt ein Wort', async () => {
    stub();
    rendere();
    const deye = await zeile('inv');
    expect(deye).toHaveTextContent('Deye SUN-30K');
    // Der Ladestand steht als ganze Zahl - wie am Kopf der Anlage.
    expect(deye).toHaveTextContent('76 %');
    // Die weiteren Messwerte klappen darunter auf (K5).
    fireEvent.click(within(deye).getByRole('button', { name: /Messwerte von .* aufklappen/ }));
    const teile = await waitFor(() => {
      const t = [...document.querySelectorAll('[data-komponente-zeile]')];
      if (t.length === 0) throw new Error('keine Unterzeilen');
      return t;
    });
    const text = teile.map((t) => t.textContent ?? '').join(' | ');
    expect(text).toContain('Einspeisung');
    expect(text).not.toMatch(/[-−]30,0/);
    // Der Fronius liefert über die Box - sein Wert steht an seiner Zeile.
    expect(await zeile('src-1')).toHaveTextContent('21,2');
  });

  it('findet Geräte über die Suche und filtert nach Zustand - Gruppen bleiben sichtbar', async () => {
    stub();
    rendere();
    await zeile('inv');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Geräte suchen' }), { target: { value: 'sun30k' } });
    await waitFor(() => expect(document.querySelector('[data-aufbau-geraet="src-1"]')).toBeNull());
    expect(await zeile('inv')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'VoltPilot-Box' })).toBeInTheDocument();
    expect(screen.getByText(/von \d+ Geräten/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Geräte suchen' }), { target: { value: 'gibtsnicht' } });
    expect(await screen.findByText(/Kein Gerät passt zu „gibtsnicht"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Suche und Filter zurücksetzen' }));
    expect(await zeile('src-1')).toBeInTheDocument();

    // Der Kurzfilter zeigt nur, was die Box meldet - als entfernbarer Chip.
    fireEvent.click(await screen.findByRole('button', { name: /von der Box gemeldet/ }));
    await waitFor(() => expect(document.querySelector('[data-aufbau-geraet="inv"]')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Zustand: Von der Box gemeldet entfernen' }));
    expect(await zeile('inv')).toBeInTheDocument();
  });

  it('hält die Filter am Telefon hinter EINEM Knopf im Suchfeld - mit der Zahl der aktiven', async () => {
    stub();
    rendere();
    await zeile('inv');
    const knopf = screen.getByRole('button', { name: 'Filter' });
    expect(knopf).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(knopf.getAttribute('aria-controls') ?? '')).toHaveAttribute('aria-label', 'Filter');
    fireEvent.click(knopf);
    expect(knopf).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(await screen.findByRole('button', { name: /von der Box gemeldet/ }));
    expect(await screen.findByRole('button', { name: 'Filter, 1 aktiv' })).toBeInTheDocument();
  });

  it('zeigt ein neues Gerät gestrichelt im Baum - Übernehmen öffnet den Zuordnen-Dialog', async () => {
    stub();
    rendere();
    const neu = await zeile('neu:goe-1');
    expect(neu).toHaveTextContent('go-e gefunden');
    expect(neu).toHaveTextContent('noch nicht übernommen');
    // Ein Fund hat keine Geräteseite und keinen Kurzblick - dort steht die Übernahme.
    expect(neu.tagName).not.toBe('BUTTON');
    fireEvent.click(within(neu).getByRole('button', { name: 'Übernehmen' }));
    expect(await screen.findByText('Gerät zuordnen')).toBeInTheDocument();
    expect(screen.getByText('Was misst dieses Gerät?')).toBeInTheDocument();
    expect(screen.getByText('Wallbox')).toBeInTheDocument();
  });

  it('zeigt den ehrlichen Rückweg, wenn die Übernahme dem Kunden fehlt (403)', async () => {
    stub();
    vi.spyOn(entitiesApi, 'adopt').mockRejectedValue(new ApiError(403, 'Forbidden'));
    rendere();
    fireEvent.click(within(await zeile('neu:goe-1')).getByRole('button', { name: 'Übernehmen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/VoltPilot/));
  });

  it('nennt eine Ausnahme schon in der Zeile - „ohne Ladestand" - und den Grund im InfoTip', async () => {
    stub();
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'portal',
      components: [
        {
          id: 'batt',
          definitionVersion: 2,
          syncStatus: 'in_sync',
          connection: {
            ip: '192.168.0.28',
            allow_missing_soc: true,
            reading_override: {
              channel: 'soc_pct',
              accepted_at: '2026-08-21T13:41:07Z',
              accepted_by: 'sub-1',
              origin: 'kunde',
            },
          },
        },
      ],
    } as never);
    rendere();
    const deye = await waitFor(async () => {
      const z = await zeile('inv');
      expect(z).toHaveTextContent('ohne Ladestand');
      return z;
    });

    // Das Gerät hat eine eigene Seite - der Klick führt dorthin; der Grund hinter „ohne Ladestand" steht jetzt
    // an einem InfoTip derselben Zeile, kein Kurzblick mehr dazwischen.
    fireEvent.click(within(deye).getByRole('button', { name: 'Erklärung anzeigen' }));
    const tip = screen.getByRole('tooltip');
    expect(within(tip).getByText(/mit unplausiblen Testwerten angelegt am 21\.08\.2026/)).toBeInTheDocument();
    expect(within(tip).getByText(/Steuerung des Speichers bleibt deshalb aus/)).toBeInTheDocument();
  });

  it('schweigt ohne Beleg - eine gewöhnliche Anlage trägt keine Ausnahme', async () => {
    stub();
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'portal',
      components: [{ id: 'batt', definitionVersion: 2, syncStatus: 'in_sync', connection: { ip: '192.168.0.28' } }],
    } as never);
    rendere();
    await zeile('inv');
    expect(screen.queryByText('ohne Ladestand')).toBeNull();
  });

  it('spricht in der Kundensicht keine technischen Wörter', async () => {
    stub();
    const { container } = rendere();
    const deye = await zeile('inv');
    expect(FORBIDDEN.test(container.textContent ?? '')).toBe(false);
    // Das „…"-Zeilenmenü (Regel erstellen, Zuordnung ändern) trägt jetzt eigenen Text - auch er bleibt kundentauglich.
    fireEvent.click(within(deye).getByRole('button', { name: /Weitere Aktionen/ }));
    const menu = await screen.findByRole('menu');
    expect(FORBIDDEN.test(menu.textContent ?? '')).toBe(false);
  });
});

/** Eine Datenquelle der Testanlage, gelesen von der Box `gw`, die Daten liefert. */
const datenquelle = (o: Partial<UemsDatenquelle> & Pick<UemsDatenquelle, 'id' | 'kennzeichen'>): UemsDatenquelle => ({
  name: null, anlage: 's-1', protokoll: 'sunspec_modbus', adresse: '192.168.10.20:502', geraete_ids: [1], netz: null,
  mehrere_leser: false, steuerquelle: false, vergleichsquelle: false, kadenz_s: 10, archiviert_am: null,
  zustaendige_box: { id: 'gw', name: null, heimat_anlage: 's-1' }, zeitraeume: [],
  rueckmeldung: {
    zustand: 'liefert', fehlerklasse: null, seit: null, gelesen_am: new Date().toISOString(), anfragen_pro_minute: 6,
    messwerte_pro_minute: 30, gemeldet_am: new Date().toISOString(), text: 'Liefert Daten',
  },
  ...o,
});

describe('AufbauSection · Gerät an einem Gateway hinzufügen (GE-5)', () => {
  afterEach(() => vi.restoreAllMocks());

  const ZAEHLER = {
    templateRef: 'builtin:janitza:umg-604',
    kind: 'builtin',
    version: 1,
    brand: 'janitza',
    brandLabel: 'Janitza',
    model: 'umg-604',
    modelLabel: 'UMG 604',
    deviceType: 'meter',
    communication: 'modbus_tcp',
    communicationLabel: 'Modbus TCP',
    transportSchema: [
      { key: 'ip', label: 'IP-Adresse', type: 'text', required: true },
      { key: 'port', label: 'Port', type: 'number', default: 502 },
      { key: 'unit_id', label: 'Geräte-ID', type: 'number', default: 1 },
    ],
  };

  it('die Gateway-Zeile führt auf die Seite des Gateways — Name und Zeile', async () => {
    stub();
    vi.spyOn(api, 'datenquellen').mockResolvedValue({
      datenquellen: [datenquelle({ id: 'dq-3', kennzeichen: 'DQ-3', name: 'Zählergateway', protokoll: 'modbus_tcp', geraete_ids: [1, 2] })],
    });
    const gr = (id: string, entity: string, nr: number) => ({
      id, kennzeichen: id.toUpperCase(), einbau_kennzeichen: id.toUpperCase(), ausgebaut_am: null, data_source_id: 'dq-3', geraete_id: nr,
      komponenten: [{ entity_id: entity, gueltig_ab: '2026-09-01T00:00:00Z', gueltig_bis: null }],
    });
    vi.spyOn(api, 'uemsGeraete').mockResolvedValue({ geraete: [gr('gr-batt', 'batt', 1), gr('gr-fr1', 'fr1', 2)] });
    const { container } = rendere();
    const gateway = await waitFor(() => {
      const el = container.querySelector('[data-aufbau-weg="dq-3"]');
      if (!el) throw new Error('keine Gateway-Zeile');
      return el as HTMLElement;
    });
    expect(within(gateway).getByRole('link', { name: 'Zählergateway' }))
      .toHaveAttribute('href', '#/anlage/s-1/geraet/VP-ABC123/dq-3');
    fireEvent.click(within(gateway).getByText('2 Geräte'));
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/VP-ABC123/dq-3');
  });

  it('`?neu=geraet&an=DQ-3` öffnet den Katalog; das Modell kommt mit Adresse, Port und freier Geräte-ID des Gateways', async () => {
    stub(`#/anlage/${site.id}/modell?neu=geraet&an=DQ-3`);
    portalVerwaltet();
    vi.mocked(api.componentTemplates).mockResolvedValue([ZAEHLER] as never);
    vi.spyOn(api, 'datenquellen').mockResolvedValue({
      datenquellen: [datenquelle({ id: 'dq-3', kennzeichen: 'DQ-3', protokoll: 'modbus_tcp', adresse: '192.168.10.31:502', geraete_ids: [1, 2] })],
    });
    vi.spyOn(api, 'uemsGeraete').mockResolvedValue({ geraete: [] });
    rendere();

    const katalog = await screen.findByRole('dialog', { name: 'Gerät hinzufügen' });
    // Einmal je Adresse: der Parameter ist verbraucht, ein Neuladen öffnet nichts erneut.
    expect(window.location.hash).toBe(`#/anlage/${site.id}/modell`);
    fireEvent.change(within(katalog).getByRole('searchbox', { name: 'Katalog durchsuchen' }), { target: { value: 'umg' } });
    fireEvent.click(await within(katalog).findByRole('button', { name: /UMG\s*604/ }));

    const seite = await screen.findByRole('dialog', { name: 'Gerät einrichten' });
    await waitFor(() => expect((within(seite).getByLabelText(/IP-Adresse/) as HTMLInputElement).value).toBe('192.168.10.31'));
    expect((within(seite).getByLabelText(/Geräte-ID/) as HTMLInputElement).value).toBe('3');
    expect((within(seite).getByLabelText(/^Port/) as HTMLInputElement).value).toBe('502');
  });
});

describe('AufbauSection · ein Eintrag je Kasten (GE-1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('liest die Verweise der Anlage: der Fronius trägt seinen Weg, ein Weg ohne Gerät steht als Anschluss da — keine Datenquellen-Zeile', async () => {
    stub();
    portalVerwaltet();
    vi.spyOn(api, 'datenquellen').mockResolvedValue({
      datenquellen: [
        datenquelle({ id: 'dq-1', kennzeichen: 'DQ-1' }),
        datenquelle({ id: 'dq-2', kennzeichen: 'DQ-2', protokoll: 'modbus_tcp', adresse: '192.168.10.40:502', rueckmeldung: null }),
      ],
    });
    const uems = vi.spyOn(api, 'uemsGeraete').mockResolvedValue({
      geraete: [{
        id: 'gr-fr1', kennzeichen: 'GR-2', einbau_kennzeichen: 'GR-2', ausgebaut_am: null, data_source_id: 'dq-1',
        komponenten: [{ entity_id: 'fr1', gueltig_ab: '2026-09-01T00:00:00Z', gueltig_bis: null }],
      }],
    });
    const { container } = rendere();
    const fronius = await zeile('src-1');
    await waitFor(() => expect(fronius).toHaveTextContent('SunSpec-Modbus · 192.168.10.20:502'));
    expect(uems).toHaveBeenCalledWith('s-1');
    const anschluss = container.querySelector('[data-aufbau-weg="dq-2"]') as HTMLElement;
    expect(anschluss).toHaveTextContent('Anschluss ohne Gerät');
    expect(anschluss).toHaveTextContent('Kennung DQ-2');
    expect(within(anschluss).getByRole('button', { name: 'Gerät an Anschluss DQ-2 hinzufügen' })).toBeInTheDocument();
    expect(container.querySelector('[data-aufbau-weg="dq-1"]')).toBeNull();
    expect(container.querySelector('.vp-auf-t-zeile.is-box')).toHaveTextContent('2 Geräte · 1 Anschluss offen');
    expect(container.textContent).not.toMatch(/Datenquelle/);
    // Das Gerät hat eine eigene Seite - der Klick springt dorthin, kein Kurzblick mehr dazwischen.
    expect(within(fronius).getByRole('link', { name: /Fronius/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/src-1',
    );
  });

  it('ohne Antwort von `…/geraete` bleibt es fail-soft: die Geräte wie vorher, kein geratener Anschluss', async () => {
    stub();
    vi.spyOn(api, 'datenquellen').mockResolvedValue({ datenquellen: [datenquelle({ id: 'dq-1', kennzeichen: 'DQ-1' })] });
    vi.spyOn(api, 'uemsGeraete').mockRejectedValue(new ApiError(503, 'Unavailable'));
    const { container } = rendere();
    const fronius = await zeile('src-1');
    await waitFor(() => expect(api.uemsGeraete).toHaveBeenCalled());
    expect(fronius).not.toHaveTextContent('192.168.10.20');
    expect(container.querySelector('[data-aufbau-weg]')).toBeNull();
    expect(container.querySelector('.vp-auf-t-zeile.is-box')).toHaveTextContent('2 Geräte');
  });
});

describe('AufbauSection · ein Gerät mit eigener Seite springt direkt dorthin (kein Modal mehr)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('springt beim Tippen auf die Zeile direkt auf die Geräteseite - kein Kurzblick dazwischen', async () => {
    stub();
    rendere();
    const deye = await zeile('inv');
    // Titel UND Zeile sind dasselbe Ziel - „Bearbeiten", Sofortmaßnahmen und Entfernen stehen bereits dort.
    expect(within(deye).getByRole('link', { name: 'Deye SUN-30K' })).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/inv',
    );
    fireEvent.click(deye);
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/VP-ABC123/inv');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('trägt an mehreren Komponenten je eine eigene Zeile im „…“-Menü - Regel erstellen, Zuordnung ändern', async () => {
    stub();
    rendere();
    const deye = await zeile('inv');
    fireEvent.click(within(deye).getByRole('button', { name: /Weitere Aktionen/ }));
    const eintraege = (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
    // Speicher und Netzanschluss sind von VoltPilot zusammengesetzt - keine Aufräum-Hebel, aber beide messen,
    // also bietet jede ihre eigene Regel-Brücke; nur der Netzanschluss ist re-pinnbar.
    expect(eintraege.some((t) => t?.includes('Regel mit dieser Komponente erstellen · Speicher'))).toBe(true);
    expect(eintraege.some((t) => t?.includes('Regel mit dieser Komponente erstellen · Netzanschluss'))).toBe(true);
    expect(eintraege.some((t) => t?.includes('Zuordnung ändern · Netzanschluss'))).toBe(true);
    // Von VoltPilot zusammengesetzte Komponenten (Speicher) bekommen keine Aufräum-Hebel und keine Freigabe -
    // die Freigabe eines Plattform-Speichers erteilt VoltPilot, nicht der Kunde.
    expect(eintraege.some((t) => t?.includes('Zuordnung ändern · Speicher'))).toBe(false);
    expect(eintraege.some((t) => t?.includes('Komponente löschen · Speicher'))).toBe(false);
    expect(eintraege.some((t) => t?.includes('Steuern freigeben'))).toBe(false);
  });

  it('führt „Regel mit dieser Komponente erstellen" aus dem Zeilenmenü in den Baukasten', async () => {
    stub();
    rendere();
    const fronius = await zeile('src-1');
    fireEvent.click(within(fronius).getByRole('button', { name: /Weitere Aktionen/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Regel mit dieser Komponente erstellen/ }));
    expect(window.location.hash).toContain('/steuerung?komponente=fr1');
  });
});

describe('AufbauSection · der Kurzblick (E2) - für Geräte ohne eigene Seite', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bietet einem Gerät ohne Seite weder Bearbeiten noch Geräteseite - der Stift bleibt im Aufbau', async () => {
    stub();
    const syntheticId = 'synthetic-pv';
    vi.mocked(api.siteEntities).mockResolvedValue({
      ...entities,
      entities: [
        ...entities.entities,
        {
          id: syntheticId,
          entityType: 'producer',
          typeLabel: 'Erzeuger',
          role: 'pv',
          label: 'Freistehende PV',
          control: false,
          deviceId: 'missing-device',
          capabilities: { measure: [{ channel: 'pv_power_kw', unit: 'kW' }] },
          guards: null,
          syncStatus: 'in_sync',
          observed: null,
          edgeSourceId: 'missing-source',
        },
      ],
    });
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'portal',
      components: [
        {
          id: syntheticId,
          role: 'pv-generation',
          entityType: 'producer',
          label: 'Freistehende PV',
          templateRef: 'builtin:missing:pv',
          definitionVersion: 1,
          edgeSourceId: 'missing-source',
        },
      ],
    } as never);
    rendere();

    const dialog = await kurzblick(zeileMit('Freistehende PV'));
    expect(within(dialog).queryByRole('link', { name: /Bearbeiten/ })).toBeNull();
    expect(within(dialog).queryByRole('link', { name: /Geräteseite/ })).toBeNull();
    expect(within(dialog).getByRole('link', { name: /umbenennen/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/modell?bearbeiten=1&komponente=synthetic-pv',
    );
  });

  it('öffnet eine nicht adressierbare Komponente per Adresse inline im Aufbau', async () => {
    stub(`#/anlage/${site.id}/modell?bearbeiten=1&komponente=grid`);
    rendere();
    expect(await screen.findByTestId('geraet-bearbeiten')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Netzanschluss bearbeiten' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Komponente umbenennen' })).toBeNull();
    expect(window.location.hash).toBe(`#/anlage/${site.id}/modell`);
  });

  // Das Umbenennen je Komponente und der markierte Speicher-Abschnitt („§5.3") sind seit diesem Wechsel Sache
  // der Geräteseite selbst (sie bietet beides inline, Inhalt der Geräteseite ist nicht Gegenstand dieser Fläche).
});

/**
 * Die Pilsting-Lage (29.07.): alle gemeldeten Geräte sind verpinnt, nur an die
 * falschen Komponenten - der Baum muss trotzdem einen Weg zur Bereinigung haben.
 */
describe('AufbauSection · nicht mehr verbunden', () => {
  afterEach(() => vi.restoreAllMocks());

  const pilsting: SiteEntities = {
    registry: null,
    entities: [
      { ...entities.entities[2], id: 'wr1', label: 'Fronius WR1', edgeSourceId: 'src-weg', orphanedPin: true, capacityKwp: 9.8 },
      { ...entities.entities[2], id: 'wr2', label: 'Fronius WR2', edgeSourceId: 'src-a', orphanedPin: false },
      { ...entities.entities[2], id: 'geist', label: 'Geist', edgeSourceId: 'src-b', orphanedPin: false },
    ],
    localSetup: [
      { id: 'src-a', kind: 'source', role: 'pv-generation', brand: 'fronius_sunspec', model: null, label: 'Fronius Anlage', reportedAt: '', adoptedEntityId: 'wr2' },
      { id: 'src-b', kind: 'source', role: 'pv-generation', brand: 'fronius_sunspec', model: null, label: 'Fronius Anlage WR2', reportedAt: '', adoptedEntityId: 'geist' },
    ],
    staleOnDevice: [],
  };

  function stubPilsting() {
    stub();
    vi.mocked(api.siteEntities).mockResolvedValue(pilsting);
    vi.mocked(api.topology).mockResolvedValue({ ...topology, entities: [], topology: { schema_version: '1.0', nodes: [] } });
    vi.mocked(api.siteSources).mockResolvedValue([
      { ...sources[0], sourceId: 'src-a', label: 'Fronius Anlage', pvKw: 4 },
      { ...sources[0], sourceId: 'src-b', label: 'Fronius Anlage WR2', pvKw: 16.9 },
    ]);
  }

  it('warnt im Baum und bietet im Kurzblick „wieder verbinden" UND „löschen"', async () => {
    stubPilsting();
    rendere();
    const verwaist = await zeile('verwaist');
    expect(verwaist).toHaveTextContent('Nicht mehr verbunden');
    // Nichts ist frei - also auch kein Fund im Baum …
    expect(document.querySelector('[data-aufbau-geraet^="neu:"]')).toBeNull();
    // … und beide Hebel stehen trotzdem an der Warnung.
    const dialog = await kurzblick(verwaist);
    expect(within(dialog).getByText(/nicht mehr mit einem gemeldeten Gerät verbunden/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'wieder verbinden' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'löschen' })).toBeInTheDocument();
  });

  it('führt „wieder verbinden" in die Zuordnung', async () => {
    stub();
    vi.mocked(api.siteEntities).mockResolvedValue({
      ...entities,
      entities: [{ ...entities.entities[2], id: 'fr2', label: 'Fronius WR2', edgeSourceId: 'gone', orphanedPin: true }],
      localSetup: [
        { id: 'new-src', kind: 'source', role: 'pv-generation', brand: 'fronius_sunspec', model: null, label: 'Fronius WR2', reportedAt: '', adoptedEntityId: null },
      ],
    });
    vi.mocked(api.topology).mockResolvedValue({ ...topology, entities: [], topology: { schema_version: '1.0', nodes: [] } });
    vi.mocked(api.siteSources).mockResolvedValue([]);
    rendere();

    const dialog = await kurzblick(zeile('verwaist'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'wieder verbinden' }));
    expect(await screen.findByText('Zuordnung ändern')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Fronius WR2/ })).toBeInTheDocument();
  });

  it('tauscht zwei gekreuzte Zuordnungen in EINEM Schritt', async () => {
    stubPilsting();
    const repin = vi.spyOn(entitiesApi, 'repin').mockResolvedValue({
      id: 'wr2',
      entityType: 'producer',
      role: 'pv-generation',
      label: 'Fronius WR2',
      deviceId: null,
    });
    rendere();

    // Dieses Gerät hat eine eigene Seite - „Zuordnung ändern" kommt jetzt aus dem „…"-Zeilenmenü, nicht mehr dem Kurzblick.
    const zeileWr2 = await zeileMit('Fronius WR2');
    fireEvent.click(within(zeileWr2).getByRole('button', { name: /Weitere Aktionen/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Zuordnung ändern/ }));

    expect(await screen.findByText('aktuell zugeordnet')).toBeInTheDocument();
    expect(screen.getByText(/gehört derzeit zu „Geist“/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Fronius Anlage WR2/ }));
    expect(screen.getByRole('status').textContent).toMatch(/in einem Schritt getauscht/);
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));

    await waitFor(() => expect(repin).toHaveBeenCalledWith('s-1', 'wr2', 'src-b', { swap: true }));
    expect(repin).toHaveBeenCalledTimes(1);
  });

  it('löscht eine Komponente erst nach den genannten Folgen', async () => {
    stubPilsting();
    const remove = vi.spyOn(entitiesApi, 'removeComponent').mockResolvedValue(undefined);
    rendere();

    const dialog = await kurzblick(zeile('verwaist'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'löschen' }));
    expect(await screen.findByRole('button', { name: 'Endgültig löschen' })).toBeInTheDocument();
    expect(screen.getByText(/„Fronius WR1“ verschwindet/)).toBeInTheDocument();
    expect(screen.getByText(/9,8/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('s-1', 'wr1'));
  });

  it('zeigt den ehrlichen Hinweis, wenn das Aufräumen dem Kunden fehlt (403)', async () => {
    stubPilsting();
    vi.spyOn(entitiesApi, 'removeComponent').mockRejectedValue(new ApiError(403, 'Forbidden'));
    rendere();

    const dialog = await kurzblick(zeile('verwaist'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'löschen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/VoltPilot/));
  });
});

describe('AufbauSection · Steuern freigeben an der Komponente', () => {
  afterEach(() => vi.restoreAllMocks());

  /** EIN selbst gebautes Gerät, wahlweise schon freigegeben. */
  function stubSelbstbau(freigegeben: boolean) {
    stub();
    vi.mocked(api.siteEntities).mockResolvedValue({
      registry: null,
      entities: [
        {
          id: 'sb',
          entityType: freigegeben ? 'modbus-load' : 'modbus-generic',
          typeLabel: 'Messgerät',
          role: 'consumer',
          label: 'Heizstab Keller',
          control: freigegeben,
          deviceId: 'gw',
          capabilities: {
            measure: [{ channel: 'power_kw', unit: 'kW' }],
            ...(freigegeben ? { actuate: [{ command: 'on_off' }] } : {}),
          },
          guards: null,
          syncStatus: 'in_sync',
          observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
          edgeSourceId: null,
        },
      ],
      localSetup: [],
    } as unknown as SiteEntities);
    vi.mocked(api.topology).mockResolvedValue({
      schemaVersion: '1.0',
      entities: [],
      topology: { nodes: [], flows: [] },
    } as unknown as SiteTopology);
    vi.mocked(api.siteSources).mockResolvedValue([]);
  }

  it('sagt „Nur messen" - ein Gerät ohne Freigabe ist in Ordnung, kein Fehler', async () => {
    stubSelbstbau(false);
    rendere();
    const dialog = await kurzblick(zeileMit('Heizstab Keller'));
    const marke = within(dialog).getByText('Nur messen').closest('.vp-auf-marke') as HTMLElement;
    expect(marke.className).not.toContain('warn');
    expect(marke.getAttribute('title')).toContain('liefert Messwerte');
  });

  it('öffnet den Freigabe-Assistenten aus dem Kurzblick', async () => {
    stubSelbstbau(false);
    rendere();
    const dialog = await kurzblick(zeileMit('Heizstab Keller'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Steuern freigeben/ }));
    expect(await screen.findByText('Wie wird geschaltet?')).toBeInTheDocument();
  });

  it('sagt nach der Freigabe, WER sie erteilt hat - und bietet den Rückweg', async () => {
    stubSelbstbau(true);
    rendere();
    const dialog = await kurzblick(zeileMit('Heizstab Keller'));
    expect(within(dialog).getByText('Von Ihnen freigegeben')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Steuerung dieses Geräts/ }));
    expect(await screen.findByRole('button', { name: 'Freigabe zurücknehmen' })).toBeInTheDocument();
  });

  it('führt in den vorbefüllten Regel-Einstieg (Brücke)', async () => {
    stubSelbstbau(true);
    rendere();
    const dialog = await kurzblick(zeileMit('Heizstab Keller'));
    expect(
      within(dialog).getByRole('link', { name: /Regel mit dieser Komponente erstellen/ }).getAttribute('href'),
    ).toContain('/steuerung?komponente=');
  });
});

describe('AufbauSection · Hinzufügen (K6)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bietet „Gerät hinzufügen" und im Menü VoltPilot-Box und Anlage an', async () => {
    stub();
    portalVerwaltet();
    rendere();
    await waitFor(() => expect(screen.getByRole('button', { name: /Gerät hinzufügen/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Box oder Anlage hinzufügen' }));
    expect(await screen.findByRole('menuitem', { name: /VoltPilot-Box hinzufügen/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Anlage hinzufügen/ })).toBeInTheDocument();
  });

  it('beginnt mit „Gerät hinzufügen" im Katalog - ein Modell öffnet seine Einrichten-Seite, der Pfeil führt zurück', async () => {
    stub();
    portalVerwaltet();
    vi.mocked(api.componentTemplates).mockResolvedValue([DEYE_12K] as never);
    rendere();
    await waitFor(() => expect(screen.getByRole('button', { name: /Gerät hinzufügen/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Gerät hinzufügen/ }));
    const katalog = await screen.findByRole('dialog', { name: 'Gerät hinzufügen' });
    fireEvent.change(within(katalog).getByRole('searchbox', { name: 'Katalog durchsuchen' }), { target: { value: '12k' } });
    // Der Treffer ist markiert (<mark>) - jsdom setzt dort Leerzeichen in den Namen.
    fireEvent.click(await within(katalog).findByRole('button', { name: /SUN-\s*12K\s*-SG04LP3-EU/ }));

    const seite = await screen.findByRole('dialog', { name: 'Gerät einrichten' });
    expect(within(seite).getByText('Anschluss')).toBeInTheDocument();
    expect(within(seite).getByText('Test mit echten Werten')).toBeInTheDocument();
    fireEvent.click(within(seite).getByRole('button', { name: 'Zurück zum Katalog' }));
    expect(await screen.findByRole('dialog', { name: 'Gerät hinzufügen' })).toBeInTheDocument();
  });

  it('beginnt mit „+ Gerät" an der Box ebenfalls im Katalog', async () => {
    stub();
    portalVerwaltet();
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät an VoltPilot-Box hinzufügen' }));
    expect(await screen.findByRole('dialog', { name: 'Gerät hinzufügen' })).toBeInTheDocument();
  });

  it('stellt im Katalog obenan, was die Box meldet - „Übernehmen" öffnet die Zuordnung', async () => {
    stub();
    portalVerwaltet();
    rendere();
    await waitFor(() => expect(screen.getByRole('button', { name: /Gerät hinzufügen/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Gerät hinzufügen/ }));
    const katalog = await screen.findByRole('dialog', { name: 'Gerät hinzufügen' });
    const gemeldet = await within(katalog).findByRole('region', { name: 'Von Ihrer Box gemeldet' });
    fireEvent.click(within(gemeldet).getByRole('button', { name: /go-e gefunden/ }));
    expect(await screen.findByText('Gerät zuordnen')).toBeInTheDocument();
  });

  it('öffnet über den Katalog auch die Wege ohne Vorlage - hier die Ladesäule mit OCPP', async () => {
    stub();
    portalVerwaltet();
    rendere();
    await waitFor(() => expect(screen.getByRole('button', { name: /Gerät hinzufügen/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Gerät hinzufügen/ }));
    const katalog = await screen.findByRole('dialog', { name: 'Gerät hinzufügen' });
    fireEvent.click(await within(katalog).findByRole('button', { name: /Ladesäule mit OCPP 1\.6/ }));
    expect(await screen.findByTestId('typ-ladesaeule')).toBeInTheDocument();
  });

  it('meldet eine VoltPilot-Box mit der Geräte-ID an', async () => {
    stub();
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Box oder Anlage hinzufügen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /VoltPilot-Box hinzufügen/ }));
    expect(await screen.findByRole('dialog', { name: 'VoltPilot-Box hinzufügen' })).toBeInTheDocument();
  });

  it('legt eine weitere Anlage AM Standort an', async () => {
    stub();
    vi.mocked(api.standorte).mockResolvedValue(standortMit([{ id: 's-1', name: 'Testanlage' }]));
    rendere();
    await screen.findByLabelText('Standort Sonnenhof');
    fireEvent.click(screen.getByRole('button', { name: 'Box oder Anlage hinzufügen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Anlage hinzufügen/ }));
    expect(await screen.findByTestId('anlage-anlegen')).toHaveAttribute('data-standort', 'st-1');
  });

  it('bleibt auf einer box-verwalteten Anlage ehrlich - kein Gerät aus dem Portal', async () => {
    stub();
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'box',
      components: [{ id: 'batt', definitionVersion: 1, syncStatus: 'in_sync' }],
    } as never);
    rendere();
    expect(await screen.findByText(/Diese Anlage wird an Ihrer VoltPilot-Box verwaltet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Gerät an .* hinzufügen/ })).toBeNull();
    const knopf = screen.getByRole('button', { name: /Gerät hinzufügen/ });
    expect(knopf).toBeDisabled();
    // Nie ein stummer grauer Knopf: der Grund steht EINMAL über der Tabelle
    // (oben geprüft) und am Knopf - nicht ein zweites Mal als Satz darunter.
    expect(knopf).toHaveAttribute('title', 'Geräte dieser Anlage verwalten Sie an Ihrer VoltPilot-Box.');
    expect(screen.queryByText('Geräte dieser Anlage verwalten Sie an Ihrer VoltPilot-Box.')).toBeNull();
  });

  it('erfindet bei einer unbekannten Berechtigung keine Verwaltung durch die Box', async () => {
    stub();
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'read-only',
      components: [{ id: 'batt', definitionVersion: 1, syncStatus: 'in_sync' }],
    } as never);
    rendere();
    expect(await screen.findAllByText(/keine Gerätebearbeitung im Portal freigegeben/)).not.toHaveLength(0);
    expect(screen.queryByText(/wird an Ihrer VoltPilot-Box verwaltet/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Gerät an .* hinzufügen/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Gerät hinzufügen/ })).toBeDisabled();
  });

  it('fordert ohne Box aktiv zur ersten VoltPilot-Box auf', async () => {
    stub();
    vi.mocked(api.siteEntities).mockResolvedValue({ registry: null, entities: [], localSetup: [], staleOnDevice: [] });
    vi.mocked(api.siteSources).mockResolvedValue([]);
    rendere({ devices: [] });
    fireEvent.click(await screen.findByRole('button', { name: /Noch keine VoltPilot-Box – jetzt hinzufügen/ }));
    expect(await screen.findByRole('dialog', { name: 'VoltPilot-Box hinzufügen' })).toBeInTheDocument();
  });

  it('sagt an einer leeren Box, dass dort noch kein Gerät hängt', async () => {
    stub();
    vi.mocked(api.siteEntities).mockResolvedValue({ registry: null, entities: [], localSetup: [], staleOnDevice: [] });
    vi.mocked(api.siteSources).mockResolvedValue([]);
    rendere();
    expect(await screen.findByText('Noch kein Gerät an dieser Box')).toBeInTheDocument();
  });
});

describe('AufbauSection · Rechte (UEMS AP-03 IP-12)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ohne „geraet.einrichten“ wird „Gerät hinzufügen“ zum Satz, das Menü nennt nur noch die Anlage', async () => {
    const me = rechteSeed('JW').me;
    const ohne = (rechte: readonly string[]) => rechte.filter((r) => r !== 'geraet.einrichten');
    setSelbstauskunft({
      ...me,
      unternehmen_rechte: ohne(me.unternehmen_rechte),
      standorte: me.standorte.map((st) => ({ ...st, rechte: ohne(st.rechte) })),
    });
    stub();
    portalVerwaltet();
    rendere();
    const menue = await screen.findByRole('button', { name: 'Box oder Anlage hinzufügen' });
    expect(screen.queryByRole('button', { name: /Gerät hinzufügen/ })).toBeNull();
    expect(screen.getAllByRole('note').length).toBeGreaterThan(0);
    fireEvent.click(menue);
    expect(await screen.findByRole('menuitem', { name: /Anlage hinzufügen/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /VoltPilot-Box hinzufügen/ })).toBeNull();
  });
});

describe('AufbauSection · mehrere Boxen und Anlagen (UEMS)', () => {
  afterEach(() => vi.restoreAllMocks());

  const garage: Device = { ...boxDevice, id: 'gw2', externalRef: 'VP-XYZ789', name: 'Garage' };

  it('stellt die führende Box zuerst - ihre Geräte darunter, die zweite Box ehrlich leer', async () => {
    stub();
    vi.mocked(api.siteEntities).mockResolvedValue({
      ...entities,
      registry: { revision: 'r1', composedAt: '', deviceId: 'gw2', reportedRevision: 'r1', reportedAt: '' },
    });
    rendere({ devices: [boxDevice, garage] });

    await zeile('inv');
    const boxen = screen.getAllByRole('link', { name: /^(Garage|VoltPilot-Box)$/ });
    expect(boxen.map((b) => b.getAttribute('href'))).toEqual([
      '#/anlage/s-1/box/VP-XYZ789',
      '#/anlage/s-1/box/VP-ABC123',
    ]);
    const zeileVon = (el: Element) => el.closest('[role="row"]') as HTMLElement;
    expect(zeileVon(boxen[0])).toHaveTextContent('führend');
    expect(zeileVon(boxen[1])).not.toHaveTextContent('führend');
    // Die Geräte meldet die führende Box: sie stehen zwischen ihr und der zweiten Box.
    const reihen = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    const garageAt = reihen.findIndex((t) => t.includes('VP-XYZ789'));
    const zweiteAt = reihen.findIndex((t) => t.includes('VP-ABC123'));
    const deyeAt = reihen.findIndex((t) => t.includes('Deye SUN-30K'));
    expect(garageAt).toBeLessThan(deyeAt);
    expect(deyeAt).toBeLessThan(zweiteAt);
    expect(reihen[zweiteAt + 1]).toContain('Noch kein Gerät an dieser Box');
    expect(screen.getByLabelText('Standort')).toHaveTextContent('2 Boxen');
  });

  it('verwaltet die Box dort, wo sie steht - Name, Typ, Neu-Verbinden, Entfernen (E5)', async () => {
    stub();
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'VoltPilot-Box verwalten' }));
    const dialog = await screen.findByRole('dialog', { name: 'VP-ABC123' });
    expect(within(dialog).getByRole('button', { name: /Gerät entfernen/ })).toBeInTheDocument();
  });

  it('lädt eine Nachbar-Anlage erst beim Aufklappen - ihre Geräte führen auf ihre Seiten', async () => {
    stub();
    const halle: Site = { ...site, id: 's-2', name: 'Halle' };
    const halleBox: Device = { ...boxDevice, id: 'gw3', siteId: 's-2', externalRef: 'VP-HAL001' };
    vi.mocked(api.standorte).mockResolvedValue(
      standortMit([
        { id: 's-1', name: 'Testanlage' },
        { id: 's-2', name: 'Halle' },
      ]),
    );
    vi.mocked(api.siteEntities).mockImplementation(async (id: string) =>
      id === 's-2'
        ? {
            registry: null,
            entities: [
              { ...entities.entities[2], id: 'pv-h', label: 'Dach Halle', deviceId: 'gw3', edgeSourceId: 'src-h' },
            ],
            localSetup: [
              { id: 'src-h', kind: 'source', role: 'pv-generation', brand: 'fronius_sunspec', model: null, label: 'Dach Halle', reportedAt: '', adoptedEntityId: 'pv-h' },
            ],
            staleOnDevice: [],
          }
        : entities,
    );
    rendere({ sites: [site, halle], devices: [boxDevice, halleBox] });

    const nachbar = await screen.findByRole('button', { name: /Anlage Halle/ });
    expect(nachbar).toHaveAttribute('aria-expanded', 'false');
    expect(api.siteEntities).not.toHaveBeenCalledWith('s-2');
    expect(screen.getByRole('link', { name: 'Zu Anlage Halle wechseln' })).toHaveAttribute('href', '#/anlage/s-2/modell');

    fireEvent.click(nachbar);
    await waitFor(() => expect(screen.getByRole('button', { name: /Anlage Halle/ })).toHaveAttribute('aria-expanded', 'true'));
    await waitFor(() => expect(api.siteEntities).toHaveBeenCalledWith('s-2'));

    const geraet = await screen.findByRole('link', { name: /Dach Halle/ });
    expect(geraet.getAttribute('href')).toContain('#/anlage/s-2/geraet/VP-HAL001/');
    // Keine Handlungen an einer fremden Anlage von hier aus - nur der Weg dorthin.
    expect(screen.queryByRole('button', { name: /Dach Halle/ })).toBeNull();
  });
});

describe('AufbauSection · der Sprung auf EINE Komponente', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('springt auf das Gerät der genannten Komponente und hebt es kurz hervor', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub(`#/anlage/s-1/modell?komponente=grid`);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    rendere();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('[data-aufbau-geraet="inv"]')?.className).toContain('is-angesprungen'));
  });

  it('reißt niemanden mit, wenn keine Komponente genannt ist', async () => {
    stub();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    rendere();
    await zeile('inv');
    expect(scroll).not.toHaveBeenCalled();
  });

  it('behauptet nichts über eine Komponente, die es nicht gibt', async () => {
    stub(`#/anlage/s-1/modell?komponente=gibt-es-nicht`);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    rendere();
    await zeile('inv');
    expect(scroll).not.toHaveBeenCalled();
    expect(document.querySelector('.is-angesprungen')).toBeNull();
  });
});

/*
  Die technische Sicht steht - wie vorher - ausschließlich hinter dem EINEN Tor
  `showTechnicalLayer()`: der Kunde sieht nichts davon, ein Plattform-Admin
  sieht sie ZUSÄTZLICH, an denselben Zeilen.
*/
describe('AufbauSection · die technische Sicht', () => {
  afterEach(() => vi.restoreAllMocks());

  async function adminRender() {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    rendere();
    await zeile('inv');
  }

  it('springt beim Tippen direkt auf die Geräteseite - der technische Rumpf liegt hinter „Technisch …“', async () => {
    await adminRender();
    window.location.hash = '';
    fireEvent.click(await zeile('inv'));
    expect(window.location.hash).toBe('#/anlage/s-1/geraet/VP-ABC123/inv');
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = await technischerKurzblick(zeile('inv'));
    expect(within(dialog).getAllByTestId('tech-zeile').length).toBeGreaterThan(0);
  });

  it('bietet „Technisch …“ dem Kunden nicht an', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    rendere();
    fireEvent.click(within(await zeile('inv')).getByRole('button', { name: /Weitere Aktionen/ }));
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: /Technisch/ })).toBeNull();
  });

  it('trägt den technischen Rumpf an der Komponente im Kurzblick', async () => {
    await adminRender();
    const dialog = await technischerKurzblick(zeile('inv'));
    const zeilen = within(dialog).getAllByTestId('tech-zeile');
    const alle = zeilen.map((z) => z.textContent ?? '').join(' ');
    expect(alle).toContain('Netzanschluss');
    expect(alle).toContain('Aktiv');
    fireEvent.click(within(dialog).getAllByRole('button', { name: /Technisch bearbeiten/ })[0]);
    expect(await screen.findByText('Entität bearbeiten')).toBeInTheDocument();
    expect(screen.getByLabelText('Bezeichnung')).toBeInTheDocument();
  });

  it('entfernt technisch - mit der Folgenliste UND dem Häkchen für den Wert', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    vi.mocked(api.siteEntities).mockResolvedValue({
      ...entities,
      entities: entities.entities.map((e) => (e.id === 'grid' ? { ...e, role: 'grid-meter' } : e)),
    });
    const remove = vi.spyOn(entitiesApi, 'remove').mockResolvedValue(undefined as never);
    rendere();

    const dialog = await technischerKurzblick(zeile('inv'));
    const netz = within(dialog)
      .getAllByTestId('tech-zeile')
      .find((z) => (z.textContent ?? '').includes('Netzanschluss')) as HTMLElement;
    fireEvent.click(within(netz).getByRole('button', { name: /Entfernen/ }));
    const bestaetigen = await screen.findByRole('dialog', { name: 'Komponente entfernen?' });
    fireEvent.click(within(bestaetigen).getByRole('checkbox'));
    fireEvent.click(within(bestaetigen).getByRole('button', { name: 'Entfernen' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('s-1', 'grid', { purgePoint: true }));
  });

  it('bietet die technische Übernahme NEBEN der geführten', async () => {
    await adminRender();
    const neu = await zeile('neu:goe-1');
    expect(within(neu).getByRole('button', { name: 'Übernehmen' })).toBeInTheDocument();
    fireEvent.click(within(neu).getByRole('button', { name: 'technisch' }));
    expect(await screen.findByText('Gerät übernehmen')).toBeInTheDocument();
    expect(screen.getByLabelText('Als Typ übernehmen')).toBeInTheDocument();
  });

  it('legt eine Komponente technisch an - nur nicht zusammengesetzte Typen', async () => {
    await adminRender();
    await waitFor(() => expect(entitiesApi.typeCatalog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Komponente anlegen \(technisch\)/ }));
    expect(await screen.findByText('Entität anlegen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Typ' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Wallbox']);
  });

  it('zeigt den Registry-Stand und die Rollen-Zuordnung', async () => {
    await adminRender();
    expect(await screen.findByText('Diese Anlage wurde noch nicht an das Gerät übertragen.')).toBeInTheDocument();
    expect(await screen.findByText('Rollen & Zuordnung')).toBeInTheDocument();
  });

  it('hält ALLES davon hinter dem EINEN Tor - ein Kunde sieht nichts davon', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    rendere();
    // Kein Kurzblick mehr für dieses Gerät - der Klick würde auf die Geräteseite springen; die Abwesenheit
    // technischer Elemente gilt ohnehin für die ganze Fläche, nicht nur innerhalb eines Dialogs.
    await zeile('inv');
    expect(screen.queryAllByTestId('tech-zeile')).toHaveLength(0);
    expect(screen.queryByText('Rollen & Zuordnung')).toBeNull();
    expect(screen.queryByRole('button', { name: /Technisch bearbeiten/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Komponente anlegen \(technisch\)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^technisch/ })).toBeNull();
    expect(api.entityStrategies).not.toHaveBeenCalled();
  });
});
