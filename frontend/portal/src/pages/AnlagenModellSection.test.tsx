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
  // Die aufgelöste Installateur-Ansicht (Stufe 3) liest diese zwei zusätzlich -
  // fail-soft, aber gestubbt, damit ein Admin-Render ruhig ist.
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  // Die Säulen der vereinten Liste (§13 R7) - fail-soft, aber gestubbt, damit
  // ein Render nicht auf einen echten Abruf wartet.
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
  vi.spyOn(entitiesApi, 'typeCatalog').mockResolvedValue({
    catalog_version: '1.0.0',
    types: [
      {
        type: 'wallbox',
        label: 'Wallbox',
        category: 'consumer',
        controllable: true,
        composed: false,
        default_failsafe: 'release',
      },
      {
        type: 'grid-meter',
        label: 'Netzanschlusszähler',
        category: 'meter',
        controllable: false,
        composed: true,
        default_failsafe: 'measure-only',
      },
    ],
  });
}

const FORBIDDEN = /Entität|Messpunkt|Quelle|Mess-Einheit|Kanal/;

describe('AnlagenModellSection — Variante A', () => {
  afterEach(() => vi.restoreAllMocks());

  it('führt mit EINEM Gesundheits-Satz und der EINEN Box (Revision 2)', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    // 1 · EIN Satz statt der früheren Vier-Zahlen-Kopfzeile.
    expect(await screen.findByText(/Box verbunden/)).toBeInTheDocument();
    // Die frühere Zähl-Kopfzeile ist ERSATZLOS weg.
    expect(screen.queryByText(/VoltPilot kennt Ihre Anlage als/)).toBeNull();

    // 2 · die EINE Box führt die Liste an.
    const liste = screen.getByRole('region', { name: 'Ihre Geräte' });
    expect(within(liste).getByRole('region', { name: 'VoltPilot-Box VP-ABC123' })).toBeInTheDocument();
    expect(screen.getByText(/einzige Verbindung zu VoltPilot/)).toBeInTheDocument();
  });

  it('macht aus Gerät UND Komponente EINE Karte - die Doppelung ist weg', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    // Der Fronius: EINE Karte (technischer Name) mit EINER Zeile (Kundenname).
    const fronius = await screen.findByRole('region', { name: 'Fronius Anlage' });
    expect(fronius.textContent).toContain('PV-Wechselrichter');
    expect(fronius.textContent).toContain('21,2');

    // Der Hybrid trägt EHRLICH mehrere Zeilen - EIN Gerät, vier Komponenten.
    const deye = screen.getByRole('region', { name: 'Deye SUN-30K' });
    expect(deye.textContent).toContain('Hybrid-Wechselrichter');
    expect(deye.textContent).toContain('Netzanschluss');
    expect(deye.textContent).toContain('Solarmodule');
    // Die Richtung bleibt ein WORT, nie ein Minus.
    expect(deye.textContent).toContain('Einspeisung');
    expect(deye.textContent).not.toContain('-30,0');
    expect(deye.textContent).not.toContain('−30,0');
    // Der Speicher-Zustand bleibt an seiner Zeile.
    expect(deye.textContent).toContain('76,0');
    expect(deye.textContent).toContain('Wird von VoltPilot gesteuert');
  });

  it('führt von jeder Karte auf ihre Geräteseite - und nie ins Leere', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const deye = await screen.findByRole('region', { name: 'Deye SUN-30K' });
    expect(within(deye).getByRole('link', { name: /Geräteseite/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/inv',
    );
    // Die „Neues Gerät"-Karte hat KEINE Seite - dort steht die Übernahme.
    const neu = screen.getByRole('region', { name: 'Neues Gerät gefunden' });
    expect(within(neu).queryByRole('link', { name: /Geräteseite/ })).toBeNull();
    expect(within(neu).getByRole('button', { name: /Übernehmen/ })).toBeInTheDocument();
  });

  it('hat KEINE Rollen-Gruppen und KEINE Summen mehr (R8)', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    // Die Rollen-Gruppen sind in den Karten aufgegangen…
    expect(screen.queryByRole('region', { name: 'PV-Erzeugung' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Speicher' })).toBeNull();
    // …und die Σ-Kopfzahlen wohnen im Cockpit, nicht hier.
    expect(screen.queryByText(/Σ/)).toBeNull();
    // Das „Antippen markiert"-Versprechen ist ersatzlos weg.
    expect(screen.queryByText(/antippen markiert/i)).toBeNull();
    // Der Register-Weg wird als EIN Satz genannt.
    expect(screen.getByText(/auf der Seite des jeweiligen Geräts/)).toBeInTheDocument();
  });

  it('shows the newly reported device and opens the one-move assign dialog', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const neu = await screen.findByRole('region', { name: 'Neues Gerät gefunden' });
    fireEvent.click(within(neu).getByRole('button', { name: /Übernehmen/ }));
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

    const neu = await screen.findByRole('region', { name: 'Neues Gerät gefunden' });
    fireEvent.click(within(neu).getByRole('button', { name: /Übernehmen/ }));
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

    // Der Speicher ist eine ZEILE in der Karte seines Geräts (§13 R2) - die
    // Zusicherung gilt der ZEILE, nicht der Karte: ein echter Netz-Zähler in
    // derselben Karte darf seine Hebel behalten.
    await screen.findByRole('region', { name: 'Deye SUN-30K' });
    const speicher = screen.getByText('Speicher').closest('.vp-am-comp') as HTMLElement;
    expect(within(speicher).queryByRole('button', { name: /Komponente löschen/ })).toBeNull();
    expect(within(speicher).queryByRole('button', { name: /Zuordnung ändern/ })).toBeNull();
  });

  it('uses no forbidden customer vocabulary in the customer view', async () => {
    stub();
    const { container } = render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    expect(FORBIDDEN.test(container.textContent ?? '')).toBe(false);
  });

  // M7 role-gate: two views, one product. A customer never sees the technical
  // installer layer; a platform-admin sees it ADDED to the same page.
  it('hides the installer layer for a customer - but NOT the rename pencil', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    expect(screen.queryByText(/Installateur-Ansicht/)).toBeNull();
    expect(screen.queryByText('Rollen & Zuordnung')).toBeNull();
    // Naming your own plant is not a technical act (concept
    // `vp-entity-alias-k1`): the pencil is open to every customer since the
    // customer label route exists.
    expect(screen.getAllByRole('button', { name: /umbenennen/ }).length).toBeGreaterThan(0);
  });

  // Captain, 09.08.2026: renaming covers EVERY component of the plant - the
  // battery, the grid connection, the house consumption and the producers.
  it('offers the pencil on every renameable component, in every role group', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    const named = screen
      .getAllByRole('button', { name: /umbenennen/ })
      .map((b) => b.getAttribute('aria-label'));
    // The platform-COMPOSED rows are explicitly included - only their type and
    // role stay ours, never their name.
    expect(named.some((n) => n?.includes('Netzanschluss'))).toBe(true);
    expect(named.some((n) => n?.includes('Speicher'))).toBe(true);
    // …and the producer, so all three role groups of this plant are covered.
    expect(named.some((n) => n?.includes('Fronius'))).toBe(true);
    // …and the PV aspect line is NOT separately renameable (it follows its
    // carrier, so its own pencil would retitle two rows at once).
    expect(named.some((n) => n?.includes('Solarmodule'))).toBe(false);
  });

  it('renames through the CUSTOMER route and can reset back to the derivation', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    const rename = vi.spyOn(entitiesApi, 'rename').mockResolvedValue({
      id: 'grid',
      entityType: 'grid-meter',
      role: 'grid',
      label: 'Hausanschluss',
      deviceId: null,
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });

    fireEvent.click(screen.getByRole('button', { name: /„Netzanschluss“ umbenennen/ }));
    const field = await screen.findByLabelText('Eigener Name');
    // The field carries the ALIAS, so an un-named component starts EMPTY and
    // the placeholder shows what VoltPilot would call it instead.
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'Netzanschluss');
    // The honesty line is the promise the route keeps by construction.
    expect(
      screen.getByText('Der Name ist reine Darstellung — er ändert nie die Steuerung.'),
    ).toBeInTheDocument();
    // Nothing to undo yet, so no reset offer.
    expect(screen.queryByRole('button', { name: 'Zurücksetzen' })).toBeNull();

    fireEvent.change(field, { target: { value: '  Hausanschluss  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith('s-1', 'grid', 'Hausanschluss'));
  });

  it('shows the installer layer for a platform-admin', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    // The customer picture is still there…
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    // …plus the technical layer added on top - seit Stufe 3 IN der Liste
    // statt in einem eigenen `<details>`-Block darunter.
    expect(await screen.findByText('Rollen & Zuordnung')).toBeInTheDocument();
    expect(screen.queryByText(/Installateur-Ansicht/)).toBeNull();
  });
});

/*
  Anlagen-Zentrale Stufe 3 (PR 3c): der Weg ZURÜCK auf eine Komponente. Cockpit,
  Regel-Karte und Schaltbild fragen alle dasselbe - und landen an DERSELBEN
  Stelle: der Zeile in ihrer Geräte-Karte.
*/
describe('Der Sprung auf EINE Komponente (Stufe 3, PR 3c)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('springt auf die genannte Komponente und hebt sie kurz hervor', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#/anlage/s-1/modell?komponente=grid';
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });

    await waitFor(() => expect(scroll).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.querySelector('[data-komponente="grid"]')?.className)
        .toContain('is-angesprungen'),
    );
  });

  it('reißt niemanden nach oben, wenn keine Komponente genannt ist', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#/anlage/s-1/modell';
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    expect(scroll).not.toHaveBeenCalled();
  });

  it('behauptet nichts über eine Komponente, die es nicht gibt', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#/anlage/s-1/modell?komponente=gibt-es-nicht';
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    expect(scroll).not.toHaveBeenCalled();
    expect(document.querySelector('.is-angesprungen')).toBeNull();
  });
});

/*
  Anlagen-Zentrale Stufe 3 (PR 3a): die Installateur-Ansicht ist AUFGELÖST -
  ihre drei Fähigkeiten wohnen jetzt IN der Liste. Diese Suite ist der
  Kein-Verlust-Beweis: jede Fähigkeit des alten Orts hat hier ihren neuen.
*/
describe('Die aufgelöste Installateur-Ansicht (Stufe 3)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function adminRender() {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
  }

  it('trägt den technischen Rumpf AN der Komponente - Typ, Soll/Ist, Rollen, Guards', async () => {
    await adminRender();
    const zeilen = await screen.findAllByTestId('tech-zeile');
    expect(zeilen.length).toBeGreaterThan(0);
    // Der TYP steht dort, wo er hingehört: an der Komponente, nicht in einer
    // zweiten Karte weiter unten.
    const alle = zeilen.map((z) => z.textContent ?? '').join(' ');
    expect(alle).toContain('Netzanschluss');
    // Der Soll/Ist-Stand der Entität (`in_sync` → „Aktiv").
    expect(alle).toContain('Aktiv');
    // Und die zwei Handlungen des alten Orts.
    expect(screen.getAllByRole('button', { name: /Technisch bearbeiten/ }).length)
      .toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Entfernen/ }).length).toBeGreaterThan(0);
  });

  it('öffnet „Technisch bearbeiten" mit dem Typ der Komponente', async () => {
    await adminRender();
    fireEvent.click((await screen.findAllByRole('button', { name: /Technisch bearbeiten/ }))[0]);
    expect(await screen.findByText('Entität bearbeiten')).toBeInTheDocument();
    expect(screen.getByLabelText('Bezeichnung')).toBeInTheDocument();
  });

  it('entfernt technisch - mit der Folgenliste UND dem Messpunkt-Häkchen', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    // ⚠ Die kWp-Folge (der k3-Bereinigungs-Hebel) hängt an der
    // MESSPUNKT-Rolle - nur eine komponierte Zeile trägt das Häkchen.
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      ...entities,
      entities: entities.entities.map((e) =>
        e.id === 'grid' ? { ...e, role: 'grid-meter' } : e,
      ),
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });

    const remove = vi.spyOn(entitiesApi, 'remove').mockResolvedValue(undefined as never);
    const zeilen = await screen.findAllByTestId('tech-zeile');
    const netz = zeilen.find((z) => (z.textContent ?? '').includes('Netzanschluss'));
    fireEvent.click(within(netz as HTMLElement).getByRole('button', { name: /Entfernen/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Komponente entfernen?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Entfernen' }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith('s-1', 'grid', { purgePoint: true }),
    );
  });

  it('bietet die TECHNISCHE Übernahme neben der geführten - nie statt ihr', async () => {
    await adminRender();
    // Die geführte Übernahme des Kunden…
    expect(screen.getByRole('button', { name: /^Übernehmen/ })).toBeInTheDocument();
    // …und die technische daneben.
    fireEvent.click(screen.getByRole('button', { name: /^technisch/ }));
    expect(await screen.findByText('Gerät übernehmen')).toBeInTheDocument();
    expect(screen.getByLabelText('Als Typ übernehmen')).toBeInTheDocument();
  });

  it('legt eine Komponente technisch an - auch ohne den Kunden-Assistenten', async () => {
    await adminRender();
    fireEvent.click(screen.getByRole('button', { name: /Komponente anlegen \(technisch\)/ }));
    expect(await screen.findByText('Entität anlegen')).toBeInTheDocument();
    // Nur NICHT-komponierte Typen sind anlegbar (ein Netzanschluss entsteht
    // aus den Stammdaten, nie von Hand).
    const typ = screen.getByLabelText('Typ') as HTMLSelectElement;
    expect([...typ.options].map((o) => o.value)).toEqual(['wallbox']);
  });

  it('zeigt den Registry-Stand - eine ANDERE Tatsache als die Komponenten-Fassung', async () => {
    await adminRender();
    expect(
      await screen.findByText('Diese Anlage wurde noch nicht an das Gerät übertragen.'),
    ).toBeInTheDocument();
  });

  it('hält ALLES davon hinter dem EINEN Tor - ein Kunde sieht nichts davon', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    expect(screen.queryAllByTestId('tech-zeile')).toHaveLength(0);
    expect(screen.queryByText('Rollen & Zuordnung')).toBeNull();
    expect(screen.queryByRole('button', { name: /Technisch bearbeiten/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Komponente anlegen \(technisch\)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^technisch/ })).toBeNull();
  });
});

describe('der Freigabe-Zustand an der Komponente (Einheitsmodell Stufe 4)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Eine Anlage mit EINEM selbst gebauten Gerät, wahlweise schon freigegeben. */
  function selbstbau(freigegeben: boolean): SiteEntities {
    return {
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
          observed: {
            health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '',
          },
          edgeSourceId: null,
        },
      ],
      localSetup: [],
    } as unknown as SiteEntities;
  }

  function stubSelbstbau(freigegeben: boolean) {
    vi.spyOn(api, 'siteEntities').mockResolvedValue(selbstbau(freigegeben));
    vi.spyOn(api, 'topology').mockResolvedValue({
      schemaVersion: '1.0', entities: [], topology: { nodes: [], flows: [] },
    } as unknown as SiteTopology);
    vi.spyOn(api, 'siteSources').mockResolvedValue([]);
    vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
    vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
    vi.spyOn(entitiesApi, 'typeCatalog').mockResolvedValue({ catalog_version: '1.0.0', types: [] });
  }

  it('sagt „Nur messen" - ein Gerät ohne Freigabe ist in Ordnung, kein Fehler', async () => {
    stubSelbstbau(false);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    const zeile = await screen.findByText('Nur messen');
    expect(zeile).toBeInTheDocument();
    // Kein Warnton und kein Wort, das nach Defekt klingt.
    expect(zeile.className).not.toContain('warn');
    expect(zeile.getAttribute('title')).toContain('liefert Messwerte');
  });

  it('öffnet den Freigabe-Assistenten von der Komponente aus', async () => {
    stubSelbstbau(false);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByText('Nur messen');
    fireEvent.click(screen.getByText('Details'));
    fireEvent.click(screen.getByRole('button', { name: /Steuern freigeben/ }));
    // Der Assistent ist ein EIGENER Schritt an der fertigen Komponente.
    expect(await screen.findByText('Wie wird geschaltet?')).toBeInTheDocument();
  });

  it('sagt nach der Freigabe, WER sie erteilt hat - und bietet den Rückweg', async () => {
    stubSelbstbau(true);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    // Selbst gebaut ⇒ die Freigabe kann nur vom Kunden kommen.
    expect(await screen.findByText('Von Ihnen freigegeben')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Details'));
    fireEvent.click(screen.getByRole('button', { name: /Steuerung dieses Geräts/ }));
    expect(await screen.findByRole('button', { name: 'Freigabe zurücknehmen' }))
      .toBeInTheDocument();
  });

  it('führt von der Komponente in den vorbefüllten Regel-Einstieg (Brücke)', async () => {
    stubSelbstbau(true);
    const hash = window.location.hash;
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByText('Von Ihnen freigegeben');
    fireEvent.click(screen.getByText('Details'));
    fireEvent.click(screen.getByRole('button', { name: /Regel mit dieser Komponente erstellen/ }));
    // Die Brücke ist ein ABSPRUNG mit Vorbefüllung, nie eine gemeinsame
    // Leinwand: sie adressiert die Steuerung mit DIESER Komponente.
    expect(window.location.hash).toContain('/steuerung?komponente=');
    window.location.hash = hash;
  });

  it('bietet an einer PLATTFORM-Komponente keinen Selbstbau-Freigabeweg', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Deye SUN-30K' });
    // Der Speicher ist steuerbar - aber seine Freigabe erteilt VoltPilot, nicht
    // der Kunde über einen Modbus-Schalt-Test.
    expect(screen.queryByRole('button', { name: /Steuern freigeben/ })).toBeNull();
  });
});

describe('Der Register-Weg wohnt seit der Geräteseite DORT (Zentrale Stufe 1, §7.5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('trägt den Verweis GENAU EINMAL und keinen zweiten Einstieg mehr', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    await screen.findByRole('region', { name: 'Ihre Geräte' });
    // Der Aufklapper ist ERSATZLOS weg: die Fußzeile nennt den Ort, und zwei
    // Einstiege in dieselbe Zwei-Schritt-Strecke wären zwei Orte, an denen
    // dieselbe Sicherheits-Zusage gepflegt werden müsste.
    expect(screen.queryByTestId('am-register-experte')).toBeNull();
    expect(screen.queryByTestId('am-regwrite')).toBeNull();
    expect(screen.getAllByText(/auf der Seite des jeweiligen Geräts/)).toHaveLength(1);
  });
});

/**
 * Anlagen-Zentrale Stufe 2: der Reiter „Schaltbild" — er ist eine ZWEITE
 * Sicht auf denselben Lesesatz, kein zweiter Einstieg.
 */
describe('AnlagenModellSection — der Reiter „Schaltbild" (Stufe 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  /** Der Rechner-Fall: `matchMedia` sagt „mindestens 1024 px". */
  function alsDesktop(desktop: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width') ? desktop : !desktop,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
  }

  it('zeigt den Reiter am Rechner und öffnet das Bild über denselben Lesesatz', async () => {
    stub();
    alsDesktop(true);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    const reiter = await screen.findByRole('tab', { name: 'Schaltbild' });
    fireEvent.click(reiter);

    // Die Struktur ist da …
    expect(await screen.findByLabelText('Struktur-Schaltbild Ihrer Anlage')).toBeInTheDocument();
    expect(screen.getByText('KOMPONENTEN')).toBeInTheDocument();
    // … und die Liste ist ausgeblendet, nicht entfernt (ein Reiter, zwei Sichten).
    expect(screen.getByLabelText('Ihre Geräte')).toHaveAttribute('hidden');
    // Ein Lesezeichen öffnet exakt diese Ansicht wieder.
    expect(window.location.hash).toBe(`#/anlage/${site.id}/modell?ansicht=schaltbild`);
  });

  it('nennt eine LÜCKE im Bild, statt sie zu füllen', async () => {
    stub();
    alsDesktop(true);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Schaltbild' }));
    expect(await screen.findByText(/LAN-Adresse Ihrer Box/)).toBeInTheDocument();
    expect(screen.getByText(/Stromwandler am Netzanschluss/)).toBeInTheDocument();
  });

  it('gibt es am TELEFON gar nicht — dort IST die Liste die Struktur', async () => {
    stub();
    alsDesktop(false);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell?ansicht=schaltbild`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    expect(await screen.findByLabelText('Ihre Geräte')).not.toHaveAttribute('hidden');
    expect(screen.queryByRole('tab', { name: 'Schaltbild' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Struktur-Schaltbild Ihrer Anlage')).not.toBeInTheDocument();
  });

  it('springt von einer Komponente im Bild zurück zu IHRER Zeile in der Liste', async () => {
    stub();
    alsDesktop(true);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Schaltbild' }));
    const bild = await screen.findByLabelText('Struktur-Schaltbild Ihrer Anlage');
    const knopf = within(bild).getAllByRole('button')[0];
    fireEvent.click(knopf);
    // Der Klick führt IN die Liste zurück (das Bild erklärt, die Zeile handelt).
    await waitFor(() => expect(screen.getByLabelText('Ihre Geräte')).not.toHaveAttribute('hidden'));
    expect(document.querySelector('[data-komponente]')).toBeTruthy();
  });
});
