import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GeraetSeiteSection } from './GeraetSeiteSection';
import {
  api,
  type CommandHistory,
  type Device,
  type Site,
  type SiteEntities,
  type SiteSource,
  type SiteTopology,
} from '../api';

const site: Site = {
  id: 's-1',
  name: 'Pilsting',
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

const FRISCH = new Date().toISOString();

const box: Device = {
  id: 'gw',
  siteId: 's-1',
  externalRef: 'edge-45gz7da',
  kind: 'inverter',
  name: 'Pilsting',
  status: 'active',
  lastSeenAt: FRISCH,
  createdAt: null,
};

const entities: SiteEntities = {
  registry: null,
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Batteriespeicher',
      role: 'storage',
      label: 'Wechselrichter Scheune',
      control: true,
      deviceId: 'gw',
      capabilities: {
        measure: [{ channel: 'soc_pct' }, { channel: 'battery_power_kw' }],
        actuate: [{ command: 'setpoint_kw' }],
      },
      guards: null,
      syncStatus: 'in_sync',
      observed: null,
      edgeSourceId: null,
    },
    {
      id: 'fr1',
      entityType: 'producer',
      typeLabel: 'Erzeuger',
      role: 'pv',
      label: 'Dach Süd',
      control: false,
      deviceId: 'gw',
      capabilities: { measure: [{ channel: 'pv_power_kw' }] },
      guards: null,
      syncStatus: 'in_sync',
      observed: null,
      edgeSourceId: 'src-7c1e9a2b',
    },
  ],
  localSetup: [
    {
      id: 'inverter',
      kind: 'inverter',
      role: null,
      brand: 'deye',
      model: 'SUN-30K-SG01HP3-EU',
      label: null,
      reportedAt: FRISCH,
      adoptedEntityId: null,
    },
    {
      id: 'src-7c1e9a2b',
      kind: 'source',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'Eco 27.0-3-S',
      label: null,
      reportedAt: FRISCH,
      adoptedEntityId: 'fr1',
    },
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
      label: 'Wechselrichter Scheune',
      category: 'storage',
      health: 'ok',
      capabilities: [
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 76 },
        { channel: 'battery_power_kw', unit: 'kW', role: 'storage', primary: false, value: 9.3 },
      ],
    },
  ],
  topology: { schema_version: '1.0', nodes: [] },
} as unknown as SiteTopology;

const sources: SiteSource[] = [
  {
    deviceId: 'gw',
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
    deviceId: 'gw',
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

/**
 * Der Verlauf DIESES Geräts (Sektion F). Voreinstellung: die Box, eine
 * bestätigte Batterie-Periode.
 */
function commands(over: Partial<CommandHistory> = {}): CommandHistory {
  return {
    recordingSince: '2026-08-01T00:00:00Z',
    accuracySeconds: 15,
    from: '2026-08-16T00:00:00Z',
    to: '2026-08-16T12:00:00Z',
    entityId: null,
    entityLabel: null,
    deviceRef: 'edge-45gz7da',
    deviceIsBox: true,
    writes: true,
    truncated: false,
    entries: [
      {
        id: 1,
        stream: 'batterie',
        kind: 'periode',
        eventKind: null,
        startedAt: '2026-08-16T10:00:00Z',
        endedAt: '2026-08-16T10:30:00Z',
        mode: 'plan',
        path: 'remote',
        whyKind: null,
        whyRef: null,
        commandedKwFirst: -6.5,
        commandedKwLast: -6.5,
        commandedKwMin: -6.5,
        commandedKwMax: -6.5,
        verdict: 'bestaetigt',
        cycles: null,
        cyclesConfirmed: null,
        cyclesNoAnswer: null,
        cyclesMismatch: null,
        controlEnabled: true,
        released: true,
        foreignInfluence: false,
        entityId: 'batt',
        source: 'cloud_abgeleitet',
        detail: null,
      },
    ],
    control: null,
    curtailment: null,
    ...over,
  };
}

function stub(over: { entities?: () => Promise<SiteEntities>; commands?: CommandHistory } = {}) {
  vi.spyOn(api, 'siteEntities').mockImplementation(
    over.entities ?? (() => Promise.resolve(entities)),
  );
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.spyOn(api, 'siteSources').mockResolvedValue(sources);
  vi.spyOn(api, 'siteComponents').mockResolvedValue({
    componentAuthority: 'portal',
    components: [
      {
        id: 'fr1',
        communication: 'fronius_sunspec',
        connection: { ip: '192.168.254.30', port: 502, unit_id: 1, interval_s: 5 },
        definitionVersion: 3,
        edgeSourceId: 'src-7c1e9a2b',
      },
    ],
  });
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null);
  vi.spyOn(api, 'curtailmentStatus').mockResolvedValue(null);
  vi.spyOn(api, 'edgeVersions').mockResolvedValue([
    {
      deviceId: 'gw',
      siteId: 's-1',
      coreVersion: 'edge-2026.08.10',
      paletteVersion: '0.9.0',
      reportedAt: FRISCH,
    },
  ]);
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(api, 'commandHistory').mockResolvedValue(over.commands ?? commands());
}

describe('GeraetSeiteSection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('zeigt die BOX mit ihren Geräten und der Gefahrenzone', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId={null} devices={[box]} />);

    expect(await screen.findByRole('heading', { name: 'VoltPilot-Box Pilsting' })).toBeInTheDocument();
    expect(screen.getByText('Geräte an dieser Box')).toBeInTheDocument();
    // Beide gemeldeten Geräte führen auf ihre EIGENE Seite.
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('#/anlage/s-1/geraet/edge-45gz7da/inverter');
    expect(links).toContain('#/anlage/s-1/geraet/edge-45gz7da/src-7c1e9a2b');
    // Die Gefahrenzone gibt es NUR auf der Box.
    expect(screen.getByRole('button', { name: /Gerät entfernen/ })).toBeInTheDocument();
  });

  it('sagt ehrlich, dass die Box ihre eigene Adresse noch nicht meldet', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId={null} devices={[box]} />);
    expect(await screen.findByText('Eigene Adresse im Netzwerk')).toBeInTheDocument();
    expect(screen.getByText('meldet Ihre Box noch nicht')).toBeInTheDocument();
  });

  it('führt ein GERÄT unter seinem technischen Namen samt Live-Werten', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );

    expect(await screen.findByRole('heading', { name: 'Deye SUN-30K' })).toBeInTheDocument();
    // Der KUNDENname lebt an der Komponente, nie am Gerät.
    expect(screen.getByRole('heading', { name: 'Deye SUN-30K' }).textContent).not.toContain('Scheune');
    expect(screen.getByText('Live-Werte vom Gerät')).toBeInTheDocument();
    expect(screen.getByText('Solarstrom')).toBeInTheDocument();
    // Die Richtung ist ein WORT, nie ein Minus.
    expect(screen.getByText('Einspeisung')).toBeInTheDocument();
    // Keine Gefahrenzone an einem Gerät HINTER der Box.
    expect(screen.queryByRole('button', { name: /Gerät entfernen/ })).not.toBeInTheDocument();
  });

  it('listet die Komponenten dieses Geräts mit dem Weg in die Zentrale', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    expect(await screen.findByText('Misst & steuert')).toBeInTheDocument();
    // Der Träger UND seine PV-Aspekt-Zeile („Solarmodule am …") - die
    // Aspekt-Zeile FOLGT dem Alias ihres Trägers, deshalb steht der Name
    // zweimal da (`komponenten.ts`).
    expect(screen.getAllByText(/Wechselrichter Scheune/).length).toBeGreaterThanOrEqual(2);
    const zentrale = screen.getAllByRole('link', { name: /In der Zentrale/ });
    expect(zentrale[0].getAttribute('href')).toBe('#/anlage/s-1/modell');
  });

  it('zeigt die gespeicherte Anbindung eines Geräts', async () => {
    stub();
    render(
      <GeraetSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        geraetId="src-7c1e9a2b"
        devices={[box]}
      />,
    );
    expect(await screen.findByText('192.168.254.30 : 502')).toBeInTheDocument();
    expect(screen.getByText('Modbus-Adresse 1')).toBeInTheDocument();
    expect(screen.getByText('wird im Portal gepflegt (Fassung 3)')).toBeInTheDocument();
  });

  it('nennt den GRUND, wenn die Adresse kein Gerät meint - nie eine leere Seite', async () => {
    stub();
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="src-weg" devices={[box]} />,
    );
    expect(await screen.findByText(/nicht \(mehr\) zu finden/)).toBeInTheDocument();
    expect(screen.getByText(/meldet sich an Ihrer Box gerade nicht/)).toBeInTheDocument();
  });

  it('bleibt bedienbar, wenn ein NEBENabruf ausfällt', async () => {
    stub();
    vi.spyOn(api, 'siteSources').mockRejectedValue(new Error('down'));
    vi.spyOn(api, 'siteComponents').mockRejectedValue(new Error('down'));
    vi.spyOn(api, 'topology').mockRejectedValue(new Error('down'));
    render(
      <GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId="inverter" devices={[box]} />,
    );
    expect(await screen.findByRole('heading', { name: 'Deye SUN-30K' })).toBeInTheDocument();
    // Die zwei Sektionen sagen WARUM sie leer sind, statt still zu bleiben.
    await waitFor(() =>
      expect(screen.getByText(/meldet keine Verbindungsdaten/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/noch keine Messwerte geliefert/)).toBeInTheDocument();
  });

  it('zeigt einen Fehlerzustand mit Wiederholen, wenn der TRAGENDE Abruf ausfällt', async () => {
    stub({ entities: () => Promise.reject(new Error('down')) });
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId={null} devices={[box]} />);
    expect(await screen.findByText(/konnte nicht geladen werden/)).toBeInTheDocument();
  });

  it('führt zurück ins Anlagen-Modell', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId={null} devices={[box]} />);
    const back = await screen.findByRole('link', { name: /Zurück zum Anlagen-Modell/ });
    expect(back.getAttribute('href')).toBe('#/anlage/s-1/modell');
  });

  it('zeigt die Befehle DIESES Geräts und führt auf die volle Liste', async () => {
    stub();
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId={null} devices={[box]} />);

    expect(await screen.findByText('Befehle an dieses Gerät')).toBeInTheDocument();
    // Der Server entscheidet, was zu diesem Gerät gehört - die Fläche fragt ihn
    // mit der Adresse, unter der die Seite geöffnet wurde.
    expect(api.commandHistory).toHaveBeenCalledWith('s-1', { device: 'edge-45gz7da' });
    const alle = screen.getByRole('link', { name: /Alle anzeigen/ });
    expect(alle.getAttribute('href')).toBe('#/anlage/s-1/befehle?geraet=edge-45gz7da');
    // Die Box trägt jede Zeile - der Grenz-Satz gehört ihr nicht.
    expect(screen.queryByText(/Anlagenweite Befehle/)).not.toBeInTheDocument();
  });

  it('erklärt an einem Gerät HINTER der Box, wo die anlagenweiten Befehle stehen', async () => {
    stub({ commands: commands({ deviceIsBox: false, deviceRef: 'src-7c1e9a2b', entries: [] }) });
    render(
      <GeraetSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        geraetId="src-7c1e9a2b"
        devices={[box]}
      />,
    );
    expect(await screen.findByText(/Anlagenweite Befehle/)).toBeInTheDocument();
    // Ohne Zeile steht der GRUND da, nie ein leerer Kasten.
    expect(screen.getByText(/kein Befehl geschickt/)).toBeInTheDocument();
  });

  it('sagt die F4-Antwort, wenn an dieses Gerät gar nicht geschrieben wird', async () => {
    stub({ commands: commands({ writes: false, entries: [] }) });
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId={null} devices={[box]} />);
    expect(await screen.findByText(/nur gelesen/)).toBeInTheDocument();
  });

  it('bleibt bedienbar, wenn der Verlauf ausfällt', async () => {
    stub();
    vi.spyOn(api, 'commandHistory').mockRejectedValue(new Error('down'));
    render(<GeraetSeiteSection site={site} boxRef="edge-45gz7da" geraetId={null} devices={[box]} />);
    // Die Sektion bleibt - sie sagt, dass noch nicht aufgezeichnet wurde,
    // statt eine leere Behauptung zu machen.
    expect(await screen.findByText('Befehle an dieses Gerät')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Aufzeichnung hat noch nicht begonnen/)).toBeInTheDocument(),
    );
  });
});
