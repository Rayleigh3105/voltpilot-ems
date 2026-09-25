import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnlagenModellSection } from './AnlagenModellSection';
import {
  api,
  ApiError,
  type Device,
  type EdgeVersion,
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
  // Die Bestands-Tests pruefen die unveraenderte Zweitsicht. Slice-1-Tests
  // setzen danach bewusst den parameterlosen Anlagenbild-Einstieg.
  window.history.replaceState(null, '', `#/anlage/${site.id}/modell?ansicht=geraete`);
  vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.spyOn(api, 'siteSources').mockResolvedValue(sources);
  // Die aufgelöste Installateur-Ansicht (Stufe 3) liest diese zwei zusätzlich -
  // fail-soft, aber gestubbt, damit ein Admin-Render ruhig ist.
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  // Die Säulen der vereinten Liste (§13 R7) - fail-soft, aber gestubbt, damit
  // ein Render nicht auf einen echten Abruf wartet.
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
  vi.spyOn(api, 'edgeVersions').mockResolvedValue([]);
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

  it('führt Bearbeiten an den einen Inline-Ort auf der Geräteseite', async () => {
    stub();
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [{
        id: 'batt', role: 'inverter', entityType: 'battery-hybrid',
        templateRef: 'builtin:deye:sun-30k', definitionVersion: 3,
      }],
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const deye = await screen.findByRole('region', { name: 'Deye SUN-30K' });
    expect(await within(deye).findByRole('link', { name: /Bearbeiten/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/inv?bearbeiten=1',
    );
    expect(within(deye).queryByRole('button', { name: /Bearbeiten/ })).toBeNull();
  });

  it('bietet für synthetische Geräte keinen Bearbeiten-Link ins Leere an', async () => {
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
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [{
        id: syntheticId,
        role: 'pv-generation',
        entityType: 'producer',
        label: 'Freistehende PV',
        templateRef: 'builtin:missing:pv',
        definitionVersion: 1,
        edgeSourceId: 'missing-source',
      }],
    });

    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const synthetic = await screen.findByRole('region', { name: 'Freistehende PV' });
    expect(within(synthetic).queryByRole('link', { name: /Bearbeiten/ })).toBeNull();
    expect(within(synthetic).queryByRole('link', { name: /Geräteseite/ })).toBeNull();
    expect(within(synthetic).getByRole('link', { name: /umbenennen/ })).toHaveAttribute(
      'href',
      '#/anlage/s-1/modell?bearbeiten=1&komponente=synthetic-pv',
    );
  });

  it('öffnet eine nicht adressierbare Komponente inline im Anlagen-Modell', async () => {
    stub();
    window.history.replaceState(
      null,
      '',
      `#/anlage/${site.id}/modell?bearbeiten=1&komponente=grid`,
    );
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    expect(await screen.findByTestId('geraet-bearbeiten')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Netzanschluss bearbeiten' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Komponente umbenennen' })).toBeNull();
    expect(window.location.hash).toBe(`#/anlage/${site.id}/modell`);
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
    // D7: derselbe Anzeigename steht zusätzlich als Geräte-Titel über der
    // technischen Zeile; die Zeilenaktion bewusst an der Zeile suchen.
    const wr2 = (await screen.findAllByText('Fronius WR2'))
      .map((node) => node.closest('.vp-am-comp')).find(Boolean)!;
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

  /**
   * Geräteseiten Stufe 4, §5.3: die Batterie hat KEINE eigene Seite - ihr
   * Gesicht ist der Speicher-Teil des Hybrid-Blatts. Ihre Zeile führt deshalb
   * dorthin und markiert dort genau ihre Kachel.
   */
  it('§5.3 · die Speicher-Zeile führt auf das Hybrid-Blatt mit markierter Kachel', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Deye SUN-30K' });
    const speicher = screen.getByText('Speicher').closest('.vp-am-comp') as HTMLElement;
    const link = within(speicher).getByRole('link', { name: /Speicher am Wechselrichter/ });
    // Die Bühne heißt im Kern `buehne` - das alte `jetzt` bleibt als
    // Lesezeichen gültig, geschrieben wird der neue Name.
    expect(link.getAttribute('href')).toMatch(/abschnitt=buehne/);
    expect(link.getAttribute('href')).toMatch(/kachel=speicher/);
    // ⚠ Ein Parameter im Hash, nie eine zweite Raute (der HashRouter läse sie
    // als Route).
    expect((link.getAttribute('href') ?? '').slice(1)).not.toContain('#');
  });

  it('⚠ §5.3 · eine NICHT-Speicher-Zeile bekommt den Absprung nicht', async () => {
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Deye SUN-30K' });
    const netz = screen.getByText('Netzanschluss').closest('.vp-am-comp') as HTMLElement;
    expect(within(netz).queryByRole('link', { name: /Speicher am Wechselrichter/ })).toBeNull();
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
    expect(screen.getAllByRole('link', { name: /umbenennen/ }).length).toBeGreaterThan(0);
  });

  // Captain, 09.08.2026: renaming covers EVERY component of the plant - the
  // battery, the grid connection, the house consumption and the producers.
  it('offers the pencil on every renameable component, in every role group', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });
    const named = screen
      .getAllByRole('link', { name: /umbenennen/ })
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

  it('führt den Namens-Stift ohne Drawer auf den Inline-Ort der Geräteseite', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByRole('region', { name: 'Ihre Geräte' });

    const link = screen.getByRole('link', { name: /„Netzanschluss“ umbenennen/ });
    expect(link).toHaveAttribute(
      'href',
      '#/anlage/s-1/geraet/VP-ABC123/inv?bearbeiten=1&komponente=grid',
    );
    expect(screen.queryByRole('dialog', { name: 'Komponente umbenennen' })).toBeNull();
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
    window.location.hash = '#/anlage/s-1/modell?ansicht=geraete';
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
    // Seit dem Picker-System ist der Typ der Haus-Picker, kein `select`.
    fireEvent.click(screen.getByRole('combobox', { name: 'Typ' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Wallbox']);
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

/** Geräte-Erlebnis Slice 1: Anlagenbild führt, Liste bleibt synchron. */
describe('AnlagenModellSection — elektrisches Anlagenbild', () => {
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

  it('ist am Desktop der parameterlose Standardeinstieg ohne inline Anlege-Plätze', async () => {
    stub();
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [],
    });
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    expect(await screen.findByRole('tab', { name: 'Anlagenbild' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('anlagenbild-desktop')).toBeInTheDocument();
    for (const zone of ['PV', 'Speicher', 'Hausverteilung', 'Netz', 'Verbraucher']) {
      expect(screen.getAllByText(zone).length).toBeGreaterThan(0);
    }
    expect(await screen.findAllByRole('button', { name: 'Gerät hinzufügen' })).toHaveLength(1);
    for (const inline of [
      /PV-Wechselrichter hinzufügen/,
      /Speicher hinzufügen/,
      /Ladesäule anbinden/,
      /Verbraucher hinzufügen/,
    ]) {
      expect(screen.queryByText(inline)).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Verbindungen anzeigen' })).toBeNull();
    expect(document.getElementById('vp-anlagenliste')).toHaveAttribute('hidden');
    expect(window.location.hash).toBe(`#/anlage/${site.id}/modell`);
  });

  it('navigiert per Geräteklick direkt zur Detailseite und öffnet keinen Drawer', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    const create = vi.spyOn(api, 'createComponent');
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const geraet = await screen.findByRole('link', { name: /Deye SUN-30K/ });
    expect(geraet).toHaveAttribute('href', '#/anlage/s-1/geraet/VP-ABC123/inv');
    fireEvent.click(geraet);
    expect(screen.queryByRole('dialog', { name: 'Deye SUN-30K' })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('macht die früheren Zusatzangaben per Tastaturfokus erreichbar, ohne verschachtelte Aktion', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const node = await screen.findByRole('link', { name: /Fronius Anlage/ });
    node.focus();
    expect(node).toHaveFocus();
    const tooltipId = node.getAttribute('aria-describedby');
    expect(tooltipId).toBeTruthy();
    expect(document.getElementById(tooltipId as string)).toHaveAttribute('role', 'tooltip');
    expect(node.querySelector('a, button, [tabindex]')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('zeigt ein neues Gerät als Zuordnungsaufgabe und öffnet Übernehmen in der Primäransicht', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    fireEvent.click(await screen.findByRole('button', { name: /Neues Gerät gefunden/ }));
    const zuordnen = await screen.findByRole('dialog', { name: 'Gerät zuordnen' });
    await waitFor(() => expect(zuordnen).toHaveFocus());
  });

  it('rendert am Telefon einen vertikalen Pfad statt eines Mini-Canvas', async () => {
    stub();
    alsDesktop(false);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    expect(await screen.findByTestId('anlagenbild-mobil')).toBeInTheDocument();
    expect(screen.queryByTestId('anlagenbild-desktop')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Liste' })).toBeInTheDocument();
    const geraet = screen.getByRole('link', { name: /Fronius Anlage/ });
    expect(geraet).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryByRole('button', { name: /Info|Details/ })).toBeNull();
    fireEvent.click(geraet);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('bewahrt die synchronisierte Liste als zweite Ansicht', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    await screen.findByRole('link', { name: /Fronius Anlage/ });
    fireEvent.click(screen.getByRole('tab', { name: 'Liste' }));
    const karte = await screen.findByRole('region', { name: 'Fronius Anlage' });
    expect(karte).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Liste' })).toHaveAttribute('aria-selected', 'true');
  });

  it('enthält weder den Verbindungsschalter noch Kommunikationskanten', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    const { container } = render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByTestId('anlagenbild-desktop');
    expect(screen.queryByRole('button', { name: 'Verbindungen anzeigen' })).toBeNull();
    expect(container.querySelector('.vp-ab-wire.is-communication')).toBeNull();
    expect(container.querySelector('marker')).toBeNull();
  });

  it('bedient die erhaltenen Ansichts-Tabs per Pfeiltaste', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const bildTab = await screen.findByRole('tab', { name: 'Anlagenbild' });
    bildTab.focus();
    fireEvent.keyDown(bildTab, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Liste' })).toHaveFocus());
    expect(screen.getByRole('tab', { name: 'Liste' })).toHaveAttribute('tabindex', '0');
  });

  it('zeigt den Hybrid einmal unter PV, mit PV-Produktion und integrierter Speicherrolle', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const diagram = await screen.findByRole('region', { name: 'Elektrisches Anlagenbild' });
    const hybrid = within(diagram).getByRole('link', { name: /Deye SUN-30K/ });
    expect(within(diagram).getAllByRole('link', { name: /Deye SUN-30K/ })).toHaveLength(1);
    expect(hybrid).toHaveClass('zone-pv');
    expect(hybrid).toHaveTextContent(/5,8\s+kW/);
    expect(hybrid).toHaveTextContent('Speicher integriert');
    expect(hybrid).toHaveAccessibleName(
      /Deye SUN-30K.*PV-Produktion: 5,8\s+kW.*Speicher integriert/,
    );
  });

  it('trägt PV-Produktion und Speicherrolle auch mobil im Accessible Name', async () => {
    stub();
    alsDesktop(false);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const hybrid = await screen.findByRole('link', {
      name: /Deye SUN-30K.*PV-Produktion: 5,8\s+kW.*Speicher integriert/,
    });
    expect(hybrid).not.toHaveAttribute('aria-describedby');
    expect(hybrid).toHaveTextContent('Speicher integriert');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('macht die komplette Box-Karte zum Link und zeigt LAN-Adresse plus Edge-Stand', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    const edge: EdgeVersion = {
      deviceId: 'gw',
      siteId: 's-1',
      coreVersion: 'edge-2026.08.1-9b37439a1234',
      paletteVersion: null,
      reportedAt: new Date().toISOString(),
      newestRelease: 'edge-2026.08.1',
      upToDate: true,
    };
    vi.mocked(api.edgeVersions).mockResolvedValue([edge]);
    render(
      <AnlagenModellSection
        site={site}
        devices={[
          {
            ...boxDevice,
            lanHost: '192.168.20.14:8484',
            lanSource: 'erreicht',
            lanSeenAt: new Date().toISOString(),
          },
        ]}
      />,
    );

    expect(await screen.findByText('192.168.20.14:8484')).toBeInTheDocument();
    expect(screen.getByText('edge-2026.08.1 (Build 9b37439a)')).toBeInTheDocument();
    const boxLink = screen.getByRole('link', { name: /Datenverbindung zu VoltPilot/ });
    expect(boxLink).toHaveAttribute('href', '#/anlage/s-1/box/VP-ABC123');
    boxLink.focus();
    expect(boxLink).toHaveFocus();
    fireEvent.click(boxLink);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('zeigt fehlende Box-Metadaten ruhig und lässt keine öffentliche Adresse durch', async () => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(
      <AnlagenModellSection
        site={site}
        devices={[
          {
            ...boxDevice,
            lanHost: '203.0.113.42:8484',
            lanSource: 'erreicht',
            lanSeenAt: new Date().toISOString(),
          },
        ]}
      />,
    );

    expect(await screen.findByText('meldet Ihre Box noch nicht')).toBeInTheDocument();
    expect(screen.getByText('meldet keinen Stand')).toBeInTheDocument();
    const boxLink = screen.getByRole('link', { name: /Datenverbindung zu VoltPilot/ });
    expect(boxLink.outerHTML).not.toContain('203.0.113.42');
  });

  it.each([
    '[::ffff:127.0.0.1]:8484',
    '192.168.20.14:0',
  ])('hält die ungültige Kundennetz-Adresse %s aus Text und Accessible Name', async (lanHost) => {
    stub();
    alsDesktop(true);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    render(
      <AnlagenModellSection
        site={site}
        devices={[
          {
            ...boxDevice,
            lanHost,
            lanSource: 'erreicht',
            lanSeenAt: new Date().toISOString(),
          },
        ]}
      />,
    );

    expect(await screen.findByText('meldet Ihre Box noch nicht')).toBeInTheDocument();
    const boxLink = screen.getByRole('link', { name: /Datenverbindung zu VoltPilot/ });
    expect(boxLink).not.toHaveTextContent(lanHost);
    expect(boxLink.getAttribute('aria-label')).not.toContain(lanHost);
  });

  it('zeigt eine gültige ULA-Adresse in Text und Accessible Name', async () => {
    stub();
    alsDesktop(false);
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    const lanHost = '[fd12:3456:789a::14]:8484';
    render(
      <AnlagenModellSection
        site={site}
        devices={[
          {
            ...boxDevice,
            lanHost,
            lanSource: 'erreicht',
            lanSeenAt: new Date().toISOString(),
          },
        ]}
      />,
    );

    expect(await screen.findByText(lanHost)).toBeInTheDocument();
    const boxLink = screen.getByRole('link', { name: /Datenverbindung zu VoltPilot/ });
    expect(boxLink.getAttribute('aria-label')).toContain(lanHost);
  });
});

describe('die Ausnahme „ohne Ladestand" bleibt an der Komponente sichtbar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('nennt Zustand und Grund - inklusive dem, was dadurch AUS bleibt', async () => {
    stub();
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
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
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    expect((await screen.findAllByText('ohne Ladestand')).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/mit unplausiblen Testwerten angelegt am 21\.08\.2026/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Steuerung des Speichers bleibt deshalb aus/).length,
    ).toBeGreaterThan(0);
  });

  it('schweigt ohne Beleg - eine gewöhnliche Anlage sieht unverändert aus', async () => {
    stub();
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [
        { id: 'batt', definitionVersion: 2, syncStatus: 'in_sync', connection: { ip: '192.168.0.28' } },
      ],
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    await screen.findByText(/Box verbunden/);
    expect(screen.queryByText('ohne Ladestand')).toBeNull();
  });
});

/*
  Anlegen-Rework Stufe 2: der EINE Einstieg fuehrt in den neuen Schritt-Dialog.
  Der frühere Seiten-Drawer ist ERSATZLOS entfallen - er fragte zuerst nach der
  HERKUNFT der Vorlage („Gerät aus dem VoltPilot-Katalog"), eine Auskunft, die
  ein Kunde über sein Gerät gar nicht hat.
*/
describe('der Anlege-Einstieg', () => {
  afterEach(() => vi.restoreAllMocks());

  it('öffnet den Schritt-Dialog, der ZUERST nach dem Gerätetyp fragt', async () => {
    stub();
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [{ id: 'batt', role: 'inverter', definitionVersion: 2, syncStatus: 'in_sync' }],
    });
    vi.spyOn(api, 'componentTemplates').mockResolvedValue([]);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Gerät hinzufügen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gerät anbinden' });
    expect(within(dialog).getByText('Was möchten Sie anbinden?')).toBeInTheDocument();
    expect(within(dialog).getByTestId('typ-wechselrichter')).toBeInTheDocument();
    // ⚠ Die alte Frage nach der Vorlagen-HERKUNFT gibt es nirgends mehr.
    expect(screen.queryByText('Gerät aus dem VoltPilot-Katalog')).toBeNull();
  });

  it('bleibt auf einer box-verwalteten Anlage ehrlich abwesend', async () => {
    stub();
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'box',
      components: [{ id: 'batt', definitionVersion: 1, syncStatus: 'in_sync' }],
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);
    expect(await screen.findByText(/Diese Anlage wird an Ihrer VoltPilot-Box verwaltet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gerät hinzufügen' })).toBeNull();
    expect(screen.queryByText(/Speicher hinzufügen/)).toBeNull();
  });

  it('erfindet bei einer unbekannten Berechtigung keine Verwaltung durch die Box', async () => {
    stub();
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'read-only',
      components: [{ id: 'batt', definitionVersion: 1, syncStatus: 'in_sync' }],
    });
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    expect(
      await screen.findByText(/keine Gerätebearbeitung im Portal freigegeben/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/wird an Ihrer VoltPilot-Box verwaltet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gerät hinzufügen' })).toBeNull();
    expect(screen.queryByText(/Speicher hinzufügen/)).toBeNull();
  });

  it('fordert in der leeren portal-verwalteten Anlage aktiv zum ersten Gerät auf', async () => {
    stub();
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    vi.mocked(api.siteEntities).mockResolvedValue({
      registry: null,
      entities: [],
      localSetup: [],
      staleOnDevice: [],
    });
    vi.mocked(api.siteSources).mockResolvedValue([]);
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [],
    });
    render(<AnlagenModellSection site={site} devices={[]} />);

    expect(
      await screen.findByText('Ihre Anlage wartet auf das erste Gerät.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Gerät hinzufügen' })).toHaveLength(1);
    expect(screen.queryByText(/PV-Wechselrichter hinzufügen/)).toBeNull();
  });

  it('behält auch bei bestehender Anlage nur den einen generischen Anlegeweg', async () => {
    stub();
    window.history.replaceState(null, '', `#/anlage/${site.id}/modell`);
    vi.spyOn(api, 'siteComponents').mockResolvedValue({
      componentAuthority: 'portal',
      components: [{ id: 'batt', definitionVersion: 2, syncStatus: 'in_sync' }],
    });
    vi.spyOn(api, 'componentTemplates').mockResolvedValue([]);
    render(<AnlagenModellSection site={site} devices={[boxDevice]} />);

    const add = await screen.findByRole('button', { name: 'Gerät hinzufügen' });
    expect(screen.queryByText(/Speicher hinzufügen/)).toBeNull();
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Gerät anbinden' });
    expect(within(dialog).getByText('Was möchten Sie anbinden?')).toBeInTheDocument();
    expect(within(dialog).getByTestId('typ-wechselrichter')).toBeInTheDocument();
  });
});
