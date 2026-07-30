import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnlagenModellSection } from './AnlagenModellSection';
import {
  api,
  ApiError,
  type Device,
  type Site,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
} from '../api';
import * as auth from '../auth';
import { entitiesApi } from '../entitiesApi';

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

/** The captain's plant shape: ONE VoltPilot-Box, a hybrid + a Fronius behind it. */
const entities: SiteEntities = {
  registry: null,
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      role: 'storage',
      label: 'Batteriespeicher',
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
      label: 'Netzanschluss',
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
    // A newly reported go-e wallbox — not adopted yet.
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

function stub() {
  vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.spyOn(api, 'siteSources').mockResolvedValue(sources);
  // The installer panel (EntitaetenSection) also reads these — fail-soft, but
  // stub them so an admin render is quiet.
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(entitiesApi, 'typeCatalog').mockResolvedValue({ catalog_version: '1.0.0', types: [] });
}

const FORBIDDEN = /Entität|Messpunkt|Quelle|Mess-Einheit|Kanal/;

describe('AnlagenModellSection — Variante A', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leads with the Kopfsatz and shows the ONE box with its devices behind it', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    // 1 · der Kopfsatz beantwortet „richtig erkannt?" in einer Zeile.
    expect(
      await screen.findByText(/VoltPilot kennt Ihre Anlage als 4 Komponenten, gemessen von 2 Geräten/),
    ).toBeInTheDocument();

    // 2 · die EINE VoltPilot-Box ist der Vermittler; die Geräte hängen an ihr.
    expect(screen.getByText('VoltPilot-Box VP-ABC123')).toBeInTheDocument();
    expect(screen.getByText('Verbunden · empfängt Messwerte von 2 Geräten')).toBeInTheDocument();
    expect(screen.getByText(/einzige Verbindung zu VoltPilot/)).toBeInTheDocument();
    // Never a second "box": the inverters read as devices behind it.
    expect(screen.getAllByText(/VoltPilot-Box/)).toHaveLength(2); // name + hint sentence
    const strip = screen.getByRole('region', { name: 'Ihre Geräte' });
    expect(within(strip).getByRole('button', { name: /Deye SUN-30K/ })).toBeInTheDocument();

    // The device verb sub-line replaces the old „liefert N Messwerte".
    expect(screen.queryByText(/liefert \d+ Messwert/)).toBeNull();
  });

  it('renders the role groups with live values that add up', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const pv = await screen.findByRole('region', { name: 'PV-Erzeugung' });
    // 21,2 (Fronius, from /sources) + 5,8 (the hybrid's own modules) = 27,0
    expect(pv.textContent).toContain('21,2');
    expect(pv.textContent).toContain('5,8');
    expect(pv.textContent).toContain('Σ 27,0');
    // Herkunft per component.
    expect(pv.textContent).toContain('misst selbst');
    expect(pv.textContent).toContain('gemessen über Deye SUN-30K');

    // The battery: SoC on the row, power in the headline.
    const storage = screen.getByRole('region', { name: 'Speicher' });
    expect(storage.textContent).toContain('76,0');
    expect(storage.textContent).toContain('geladen');
    expect(storage.textContent).toContain('lädt 9,3');
    // Steuern ist ein Abzeichen, kein Nebensatz.
    expect(storage.textContent).toContain('Wird von VoltPilot gesteuert');

    // The grid: a direction WORD, never a minus sign.
    const grid = screen.getByRole('region', { name: 'Netzanschluss' });
    expect(grid.textContent).toContain('Einspeisung 30,0');
    expect(grid.textContent).not.toContain('-30,0');
    expect(grid.textContent).not.toContain('−30,0');
  });

  it('highlights a device on click and the third column is gone', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const strip = await screen.findByRole('region', { name: 'Ihre Geräte' });
    const device = within(strip).getByRole('button', { name: /Deye SUN-30K/ });
    expect(device).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(device);
    expect(device).toHaveAttribute('aria-pressed', 'true');

    // Die aufgelöste dritte Spalte („Ihre Anlage" mit fünf Erklärkarten).
    expect(screen.queryByRole('region', { name: 'Ihre Anlage' })).toBeNull();
    expect(screen.queryByText('Cockpit & Energiefluss')).toBeNull();
    // …ihr Rest lebt in der Fußzeile.
    expect(screen.getByText('→ Messwerte')).toHaveAttribute('href', '#/anlage/s-1/messwerte');
    expect(screen.getByText('→ Steuerung')).toHaveAttribute('href', '#/anlage/s-1/steuerung');
    expect(screen.getByText(/Schutzgrenzen/)).toBeInTheDocument();
    // …und „Guard-Kette" ist raus.
    expect(screen.queryByText(/Guard-Kette/)).toBeNull();
  });

  it('shows the newly reported device and opens the one-move assign dialog', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const found = await screen.findByText('Neues Gerät gefunden');
    fireEvent.click(found);
    expect(await screen.findByText('Gerät zuordnen')).toBeInTheDocument();
    expect(screen.getByText('Was misst dieses Gerät?')).toBeInTheDocument();
    // The guided type for a go-e source is a Wallbox.
    expect(screen.getByText('Wallbox')).toBeInTheDocument();
  });

  it('leads an orphaned pin back into the assignment picker', async () => {
    const orphaned: SiteEntities = {
      ...entities,
      entities: [
        { ...entities.entities[2], id: 'fr2', label: 'Fronius WR2', edgeSourceId: 'gone', orphanedPin: true },
      ],
      localSetup: [
        { id: 'new-src', kind: 'source', role: 'pv-generation', brand: 'fronius_sunspec', model: null, label: 'Fronius WR2', reportedAt: '', adoptedEntityId: null },
      ],
    };
    vi.spyOn(api, 'siteEntities').mockResolvedValue(orphaned);
    vi.spyOn(api, 'topology').mockResolvedValue({ ...topology, entities: [], topology: { schema_version: '1.0', nodes: [] } });
    vi.spyOn(api, 'siteSources').mockResolvedValue([]);

    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    expect(
      await screen.findByText(/nicht mehr mit einem gemeldeten Gerät verbunden/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'wieder verbinden' }));
    expect(await screen.findByText('Zuordnung ändern')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Fronius WR2/ })).toBeInTheDocument();
  });

  it('shows the honest fallback when the customer adopt twin is absent (403)', async () => {
    stub();
    vi.spyOn(entitiesApi, 'adopt').mockRejectedValue(new ApiError(403, 'Forbidden'));
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    fireEvent.click(await screen.findByText('Neues Gerät gefunden'));
    fireEvent.click(await screen.findByRole('button', { name: 'Fertig' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/VoltPilot/));
  });

  /**
   * Die gemeldete Pilsting-Lage (29.07.): ALLE gemeldeten Geräte sind verpinnt,
   * nur an die falschen Komponenten — deshalb gab es kein „Neues Gerät
   * gefunden" und damit vorher keinen einzigen Weg zur Bereinigung.
   */
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
    vi.spyOn(api, 'siteEntities').mockResolvedValue(pilsting);
    vi.spyOn(api, 'topology').mockResolvedValue({
      ...topology,
      entities: [],
      topology: { schema_version: '1.0', nodes: [] },
    });
    vi.spyOn(api, 'siteSources').mockResolvedValue([
      { ...sources[0], sourceId: 'src-a', label: 'Fronius Anlage', pvKw: 4 },
      { ...sources[0], sourceId: 'src-b', label: 'Fronius Anlage WR2', pvKw: 16.9 },
    ]);
  }

  it('offers reconnect AND delete on the orphan even though no device is free', async () => {
    stubPilsting();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    await screen.findByText(/nicht mehr mit einem gemeldeten Gerät verbunden/);
    // The dead end: nothing is unassigned, so there is no „Neues Gerät" card…
    expect(screen.queryByText('Neues Gerät gefunden')).toBeNull();
    // …and both levers sit right next to the warning anyway.
    expect(screen.getByRole('button', { name: 'wieder verbinden' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'löschen' })).toBeInTheDocument();
  });

  it('swaps two crossed assignments in ONE step, never leaving a half state', async () => {
    stubPilsting();
    const repin = vi.spyOn(entitiesApi, 'repin').mockResolvedValue({
      id: 'wr2',
      entityType: 'producer',
      role: 'pv-generation',
      label: 'Fronius WR2',
      deviceId: null,
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    // A HEALTHY component keeps its actions in the calm Details fold.
    const wr2 = (await screen.findAllByText('Fronius WR2'))[0].closest('.vp-am-comp')!;
    fireEvent.click(within(wr2 as HTMLElement).getByRole('button', { name: /Zuordnung ändern/ }));

    // The dialog is up (its title and the row button share the same words, so
    // the marker of the CURRENT assignment is the unambiguous handle).
    expect(await screen.findByText('aktuell zugeordnet')).toBeInTheDocument();
    expect(screen.getByText(/gehört derzeit zu „Geist“/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Fronius Anlage WR2/ }));
    // The consequence is stated BEFORE the customer commits.
    expect(screen.getByRole('status').textContent).toMatch(/in einem Schritt getauscht/);
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));

    // ONE call, swap requested — no client-side "release, then set".
    await waitFor(() =>
      expect(repin).toHaveBeenCalledWith('s-1', 'wr2', 'src-b', { swap: true }),
    );
    expect(repin).toHaveBeenCalledTimes(1);
  });

  it('deletes a component after naming the consequences, freeing its device', async () => {
    stubPilsting();
    const remove = vi.spyOn(entitiesApi, 'removeComponent').mockResolvedValue(undefined);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    await screen.findByText(/nicht mehr mit einem gemeldeten Gerät verbunden/);
    fireEvent.click(screen.getByRole('button', { name: 'löschen' }));

    expect(await screen.findByRole('button', { name: 'Endgültig löschen' })).toBeInTheDocument();
    expect(screen.getByText(/„Fronius WR1“ verschwindet/)).toBeInTheDocument();
    // The kWp hanging on the plant total is NAMED, not vaguely warned about.
    expect(screen.getByText(/9,8/)).toBeInTheDocument();
    // Its device is GONE, so no promise that it comes back (the orphan case).
    expect(screen.queryByText(/Neues Gerät gefunden/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('s-1', 'wr1'));
  });

  it('shows the honest hint when the cleanup routes are absent (403)', async () => {
    stubPilsting();
    vi.spyOn(entitiesApi, 'removeComponent').mockRejectedValue(new ApiError(403, 'Forbidden'));
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    await screen.findByText(/nicht mehr mit einem gemeldeten Gerät verbunden/);
    fireEvent.click(screen.getByRole('button', { name: 'löschen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/VoltPilot/));
  });

  it('never offers the cleanup levers on the platform-composed components', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const storage = await screen.findByRole('region', { name: 'Speicher' });
    expect(within(storage).queryByRole('button', { name: /Komponente löschen/ })).toBeNull();
    expect(within(storage).queryByRole('button', { name: /Zuordnung ändern/ })).toBeNull();
  });

  it('uses no forbidden customer vocabulary in the customer view', async () => {
    stub();
    const { container } = render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Komponenten' });
    expect(FORBIDDEN.test(container.textContent ?? '')).toBe(false);
  });

  // M7 role-gate: two views, one product. A customer never sees the technical
  // installer layer; a platform-admin sees it ADDED to the same page.
  it('hides the installer layer and the rename pencil for a customer', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Komponenten' });
    expect(screen.queryByText(/Installateur-Ansicht/)).toBeNull();
    expect(screen.queryByText('Rollen & Zuordnung')).toBeNull();
    // The label PUT is admin-only today, so the customer gets no pencil.
    expect(screen.queryByRole('button', { name: /umbenennen/ })).toBeNull();
  });

  it('shows the installer layer and a working rename for a platform-admin', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    const update = vi
      .spyOn(entitiesApi, 'update')
      .mockResolvedValue(entities.entities[0]);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    // The customer picture is still there…
    await screen.findByRole('region', { name: 'Komponenten' });
    // …plus the installer panel added on top.
    expect(screen.getByText(/Installateur-Ansicht/)).toBeInTheDocument();
    expect(await screen.findByText('Rollen & Zuordnung')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /„Netzanschluss“ umbenennen/ }));
    fireEvent.change(await screen.findByLabelText('Name der Komponente'), {
      target: { value: 'Hausanschluss' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('s-1', 'grid', { label: 'Hausanschluss' }),
    );
  });
});
