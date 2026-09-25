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
} from '../api';
import * as auth from '../auth';
import { entitiesApi } from '../entitiesApi';
import { consumersApi } from '../consumers/consumersApi';
import { OHNE_STANDORT } from '../aufbauBaum';

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
}

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

/** Die Zeile einer Komponente im Kurzblick. */
function komponente(dialog: HTMLElement, label: string): HTMLElement {
  return within(dialog).getByText(label).closest('li') as HTMLElement;
}

const FORBIDDEN = /Entität|Messpunkt|Quelle|Mess-Einheit|Kanal/;

describe('AufbauSection · der Baum', () => {
  afterEach(() => vi.restoreAllMocks());

  it('steht mit allen Ebenen da - Standort, Anlage, Box, Geräte - auch mit EINER Box (E3)', async () => {
    stub();
    vi.mocked(api.standorte).mockResolvedValue(standortMit([{ id: 's-1', name: 'Testanlage' }]));
    rendere();

    const wurzel = await screen.findByRole('region', { name: 'Standort Sonnenhof' });
    expect(wurzel).toHaveTextContent('ST-1');
    expect(wurzel).toHaveTextContent('Sonnenweg 1 · 80331 München');
    expect(wurzel).toHaveTextContent('1 Anlage');
    expect(wurzel).toHaveTextContent('1 Box');

    const baum = screen.getByRole('list', { name: 'Anlagen an diesem Standort' });
    const anlage = within(baum).getByRole('button', { name: /Anlage Testanlage/ });
    expect(anlage).toHaveAttribute('aria-expanded', 'true');
    expect(anlage).toHaveTextContent('Sie sind hier');

    // Die Box ist ein TOR mit eigener Seite.
    expect(within(baum).getByRole('link', { name: /VP-ABC123/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/box/VP-ABC123',
    );
    // Die Geräte stehen darunter - Tippen öffnet den Kurzblick.
    expect(await zeile('inv')).toHaveAttribute('aria-haspopup', 'dialog');
    expect(await zeile('src-1')).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('bleibt ohne Standort-Auskunft ehrlich - keine erfundene Adresse', async () => {
    stub();
    rendere();
    const wurzel = await screen.findByRole('region', { name: 'Aufbau' });
    expect(within(wurzel).getByRole('heading', { name: 'Ihre Anlage' })).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: OHNE_STANDORT })).toBeInTheDocument();
  });

  it('zeigt Werte als kurze Chips - die Richtung bleibt ein Wort, nie ein Minus', async () => {
    stub();
    rendere();
    const deye = await zeile('inv');
    expect(deye).toHaveTextContent('Deye SUN-30K');
    // Der Ladestand steht als ganze Zahl - wie am Kopf der Anlage.
    expect(deye).toHaveTextContent('76 %');
    expect(deye).toHaveTextContent('Einspeisung');
    expect(deye.textContent).not.toMatch(/[-−]30,0/);
    // Der Fronius liefert über die Box - sein Wert steht an seiner Zeile.
    expect(await zeile('src-1')).toHaveTextContent('21,2');
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

  it('nennt eine Ausnahme schon in der Zeile - „ohne Ladestand" - und den Grund im Kurzblick', async () => {
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
    await waitFor(async () => expect(await zeile('inv')).toHaveTextContent('ohne Ladestand'));

    const dialog = await kurzblick(zeile('inv'));
    const speicher = komponente(dialog, 'Speicher');
    expect(within(speicher).getByText('ohne Ladestand')).toBeInTheDocument();
    expect(within(speicher).getByText(/mit unplausiblen Testwerten angelegt am 21\.08\.2026/)).toBeInTheDocument();
    expect(within(speicher).getByText(/Steuerung des Speichers bleibt deshalb aus/)).toBeInTheDocument();
    // Die PV-Zeile desselben Hybrids ist davon nicht betroffen.
    expect(within(dialog).getAllByText(/mit unplausiblen Testwerten/)).toHaveLength(1);
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
    await zeile('inv');
    expect(FORBIDDEN.test(container.textContent ?? '')).toBe(false);
    const dialog = await kurzblick(zeile('inv'));
    expect(FORBIDDEN.test(dialog.textContent ?? '')).toBe(false);
  });
});

describe('AufbauSection · der Kurzblick (E2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('öffnet beim Tippen - und die Geräteseite ist EINEN Tipp weiter', async () => {
    stub();
    rendere();
    const dialog = await kurzblick(zeile('inv'));
    expect(dialog).toHaveAccessibleName('Deye SUN-30K');
    expect(within(dialog).getByText(/an VoltPilot-Box/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Geräteseite öffnen/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/inv',
    );
    // Der Register-Weg wird GENAU EINMAL genannt - kein zweiter Einstieg.
    expect(within(dialog).getAllByText(/Register lesen und schreiben Sie auf der Geräteseite/)).toHaveLength(1);
    expect(screen.queryByTestId('am-register-experte')).toBeNull();
    expect(screen.queryByTestId('am-regwrite')).toBeNull();
  });

  it('trägt EIN Gerät mit mehreren Komponenten - Speicher, Solarmodule, Netzanschluss', async () => {
    stub();
    rendere();
    const dialog = await kurzblick(zeile('inv'));
    const speicher = komponente(dialog, 'Speicher');
    expect(speicher).toHaveTextContent('76,0');
    expect(speicher).toHaveTextContent('Wird von VoltPilot gesteuert');
    expect(komponente(dialog, 'Netzanschluss')).toHaveTextContent('Einspeisung');
    // Dieselbe Aufteilung wie der Energiefluss: 27 kW am Hybrid, 21,2 davon
    // liefert der Fronius - die eigenen Module tragen 5,8 kW.
    expect(komponente(dialog, 'Solarmodule am Deye SUN-30K')).toHaveTextContent('5,8');
  });

  it('führt Bearbeiten an den EINEN Inline-Ort auf der Geräteseite', async () => {
    stub();
    portalVerwaltet();
    rendere();
    await waitFor(() => expect(api.siteComponents).toHaveBeenCalled());
    const dialog = await kurzblick(zeile('inv'));
    expect(await within(dialog).findByRole('link', { name: /Bearbeiten/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/inv?bearbeiten=1',
    );
  });

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

  it('bietet den Namens-Stift an jeder benennbaren Komponente - nicht an der PV-Zeile des Hybrids', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    rendere();
    const deye = await kurzblick(zeile('inv'));
    const namen = within(deye)
      .getAllByRole('link', { name: /umbenennen/ })
      .map((a) => a.getAttribute('aria-label'));
    expect(namen).toContain('„Speicher“ umbenennen');
    expect(namen).toContain('„Netzanschluss“ umbenennen');
    expect(namen.some((n) => n?.includes('Solarmodule'))).toBe(false);
    // Der Stift führt ohne Dialog auf den Inline-Ort der Geräteseite.
    expect(within(deye).getByRole('link', { name: '„Netzanschluss“ umbenennen' })).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/inv?bearbeiten=1&komponente=grid',
    );
    expect(screen.queryByRole('dialog', { name: 'Komponente umbenennen' })).toBeNull();

    fireEvent.click(within(deye).getByRole('button', { name: 'Schließen' }));
    const fronius = await kurzblick(zeile('src-1'));
    expect(within(fronius).getByRole('link', { name: /Fronius Anlage“ umbenennen/ })).toBeInTheDocument();
  });

  it('§5.3 · die Speicher-Zeile führt auf das Hybrid-Blatt mit markierter Kachel - nur sie', async () => {
    stub();
    rendere();
    const dialog = await kurzblick(zeile('inv'));
    const link = within(komponente(dialog, 'Speicher')).getByRole('link', { name: /Speicher am Wechselrichter/ });
    expect(link.getAttribute('href')).toMatch(/abschnitt=buehne/);
    expect(link.getAttribute('href')).toMatch(/kachel=speicher/);
    // Ein Parameter im Hash, nie eine zweite Raute.
    expect((link.getAttribute('href') ?? '').slice(1)).not.toContain('#');
    expect(
      within(komponente(dialog, 'Netzanschluss')).queryByRole('link', { name: /Speicher am Wechselrichter/ }),
    ).toBeNull();
  });

  it('bietet an den von VoltPilot zusammengesetzten Komponenten keine Aufräum-Hebel', async () => {
    stub();
    rendere();
    const dialog = await kurzblick(zeile('inv'));
    const speicher = komponente(dialog, 'Speicher');
    expect(within(speicher).queryByRole('button', { name: /Komponente löschen/ })).toBeNull();
    expect(within(speicher).queryByRole('button', { name: /Zuordnung ändern/ })).toBeNull();
    // Die Freigabe eines Plattform-Speichers erteilt VoltPilot, nicht der Kunde.
    expect(within(dialog).queryByRole('button', { name: /Steuern freigeben/ })).toBeNull();
  });
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

    const dialog = await kurzblick(zeileMit('Fronius WR2'));
    fireEvent.click(within(dialog).getByText(/Mehr zu/));
    fireEvent.click(within(dialog).getByRole('button', { name: /Zuordnung ändern/ }));

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

describe('AufbauSection · Hinzufügen (E4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fragt am Standort: Gerät, VoltPilot-Box oder Anlage - und nennt Funde zuerst', async () => {
    stub();
    portalVerwaltet();
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Hinzufügen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hinzufügen' });
    expect(within(dialog).getByText('Was möchten Sie hinzufügen?')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Gerät/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^VoltPilot-Box/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Anlage/ })).toBeInTheDocument();
    // Was die Box schon meldet, steht davor - mit dem kürzesten Weg.
    expect(within(dialog).getByText('go-e gefunden')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Übernehmen' }));
    expect(await screen.findByText('Gerät zuordnen')).toBeInTheDocument();
  });

  it('beginnt mit „Gerät" den Assistenten, der ZUERST nach dem Gerätetyp fragt', async () => {
    stub();
    portalVerwaltet();
    rendere();
    await waitFor(() => expect(api.siteComponents).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Hinzufügen' }));
    const wahl = await screen.findByRole('dialog', { name: 'Hinzufügen' });
    await waitFor(() => expect(within(wahl).getByRole('button', { name: /^Gerät/ })).toBeEnabled());
    fireEvent.click(within(wahl).getByRole('button', { name: /^Gerät/ }));
    const flow = await screen.findByRole('dialog', { name: 'Gerät anbinden' });
    expect(within(flow).getByText('Was möchten Sie anbinden?')).toBeInTheDocument();
    expect(within(flow).getByTestId('typ-wechselrichter')).toBeInTheDocument();
    expect(screen.queryByText('Gerät aus dem VoltPilot-Katalog')).toBeNull();
  });

  it('beginnt mit „+ Gerät" an der Box direkt beim Gerät', async () => {
    stub();
    portalVerwaltet();
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Gerät an VoltPilot-Box hinzufügen' }));
    expect(await screen.findByRole('dialog', { name: 'Gerät anbinden' })).toBeInTheDocument();
  });

  it('meldet eine VoltPilot-Box mit der Geräte-ID an', async () => {
    stub();
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: 'Hinzufügen' }));
    const wahl = await screen.findByRole('dialog', { name: 'Hinzufügen' });
    fireEvent.click(within(wahl).getByRole('button', { name: /^VoltPilot-Box/ }));
    expect(await screen.findByRole('dialog', { name: 'VoltPilot-Box hinzufügen' })).toBeInTheDocument();
  });

  it('legt eine weitere Anlage AM Standort an', async () => {
    stub();
    vi.mocked(api.standorte).mockResolvedValue(standortMit([{ id: 's-1', name: 'Testanlage' }]));
    rendere();
    await screen.findByRole('region', { name: 'Standort Sonnenhof' });
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    const wahl = await screen.findByRole('dialog', { name: 'Hinzufügen' });
    expect(within(wahl).getByRole('button', { name: /^Anlage/ })).toHaveTextContent('am Standort Sonnenhof');
    fireEvent.click(within(wahl).getByRole('button', { name: /^Anlage/ }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    const wahl = await screen.findByRole('dialog', { name: 'Hinzufügen' });
    expect(within(wahl).getByRole('button', { name: /^Gerät/ })).toBeDisabled();
  });

  it('erfindet bei einer unbekannten Berechtigung keine Verwaltung durch die Box', async () => {
    stub();
    vi.mocked(api.siteComponents).mockResolvedValue({
      componentAuthority: 'read-only',
      components: [{ id: 'batt', definitionVersion: 1, syncStatus: 'in_sync' }],
    } as never);
    rendere();
    expect(await screen.findByText(/keine Gerätebearbeitung im Portal freigegeben/)).toBeInTheDocument();
    expect(screen.queryByText(/wird an Ihrer VoltPilot-Box verwaltet/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Gerät an .* hinzufügen/ })).toBeNull();
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
    const boxen = screen.getAllByRole('link', { name: /VP-/ });
    expect(boxen.map((b) => b.getAttribute('href'))).toEqual([
      '#/anlage/s-1/box/VP-XYZ789',
      '#/anlage/s-1/box/VP-ABC123',
    ]);
    expect(boxen[0]).toHaveTextContent('führende Box');
    expect(boxen[1]).not.toHaveTextContent('führende Box');
    // Die Geräte meldet die führende Box.
    const garageKnoten = boxen[0].closest('li') as HTMLElement;
    expect(within(garageKnoten).getByText('Deye SUN-30K')).toBeInTheDocument();
    expect(within(boxen[1].closest('li') as HTMLElement).getByText('Noch kein Gerät an dieser Box')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Aufbau' })).toHaveTextContent('2 Boxen');
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

    fireEvent.click(nachbar);
    expect(nachbar).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(api.siteEntities).toHaveBeenCalledWith('s-2'));

    const knoten = nachbar.closest('li') as HTMLElement;
    const geraet = await within(knoten).findByRole('link', { name: /Dach Halle/ });
    expect(geraet.getAttribute('href')).toContain('#/anlage/s-2/geraet/VP-HAL001/');
    // Keine Handlungen an einer fremden Anlage von hier aus - nur der Weg dorthin.
    expect(within(knoten).queryByRole('button', { name: /Dach Halle/ })).toBeNull();
    expect(within(knoten).getByRole('link', { name: /Zu dieser Anlage wechseln/ })).toHaveAttribute(
      'href',
      '#/anlage/s-2/modell',
    );
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

  it('trägt den technischen Rumpf an der Komponente im Kurzblick', async () => {
    await adminRender();
    const dialog = await kurzblick(zeile('inv'));
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

    const dialog = await kurzblick(zeile('inv'));
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
    const dialog = await kurzblick(zeile('inv'));
    expect(within(dialog).queryAllByTestId('tech-zeile')).toHaveLength(0);
    expect(screen.queryByText('Rollen & Zuordnung')).toBeNull();
    expect(screen.queryByRole('button', { name: /Technisch bearbeiten/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Komponente anlegen \(technisch\)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^technisch/ })).toBeNull();
    expect(api.entityStrategies).not.toHaveBeenCalled();
  });
});
