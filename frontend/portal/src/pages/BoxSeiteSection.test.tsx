import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BoxSeiteSection } from './BoxSeiteSection';
import * as auth from '../auth';
import { adminApi } from '../admin/adminApi';
import { fleetApi } from '../admin/fleetApi';
import {
  api,
  type CommandHistory,
  type Device,
  type RegisterWriteTarget,
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

/** UNGENUTZT auf der Box: sie hat kein Register-Werkzeug (das wohnt am Gerät). */
function targets(over: Partial<RegisterWriteTarget>[] = []): RegisterWriteTarget[] {
  const basis: RegisterWriteTarget[] = [
    {
      lane: 'primary', deviceId: 'gw', entityId: null, label: 'Deye SUN-30K',
      brand: 'deye', model: 'SUN-30K-SG01HP3-EU', family: 'hybrid_3p',
      communication: 'solarman_v5', host: '192.168.0.28', port: 8899, unitId: 1,
      writable: true, reason: null,
    },
    {
      lane: 'entity', deviceId: 'gw', entityId: 'fr1', label: 'Dach Süd',
      brand: 'fronius_sunspec', model: 'Eco 27.0-3-S', family: null,
      communication: 'fronius_sunspec', host: '192.168.254.30', port: 502, unitId: 1,
      writable: true, reason: null,
    },
  ];
  return over.length ? basis.map((t, i) => ({ ...t, ...(over[i] ?? {}) })) : basis;
}

function stub(over: {
  entities?: () => Promise<SiteEntities>;
  commands?: CommandHistory;
  targets?: RegisterWriteTarget[];
  writes?: RegisterWriteEvent[];
} = {}) {
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
  vi.spyOn(api, 'registerWriteTargets').mockResolvedValue(over.targets ?? targets());
  vi.spyOn(api, 'registerWriteHistory').mockResolvedValue(over.writes ?? []);
  vi.spyOn(api, 'registerKnowledge').mockResolvedValue([
    {
      family: 'hybrid_3p', brand: 'deye', label: 'Deye 3-phasig',
      registers: [{
        address: 231, addressHex: '0x00E7', label: 'Einspeisegrenze',
        clazz: 'netz_compliance', scale: 10, unit: 'kW', note: null,
      }],
    },
  ]);
}


describe('BoxSeiteSection', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Der HELD: die drei Fragen, die eine Box beantwortet - verbunden? welche
   * Software? unter welcher Adresse? Und darunter die GERÄTE, die die Seite
   * ausmachen.
   */
  it('führt mit den drei Kacheln und den Geräten AN der Box', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);

    expect(await screen.findByRole('heading', { name: 'VoltPilot-Box Pilsting' }))
      .toBeInTheDocument();
    const kacheln = screen.getByTestId('box-kacheln');
    expect(within(kacheln).getByText('Verbindung')).toBeInTheDocument();
    expect(within(kacheln).getByText('Software')).toBeInTheDocument();
    expect(within(kacheln).getByText('Im Netzwerk')).toBeInTheDocument();

    expect(screen.getByText('Geräte an dieser Box')).toBeInTheDocument();
    // Beide gemeldeten Geräte führen auf ihre EIGENE Seite.
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('#/anlage/s-1/geraet/edge-45gz7da/inverter');
    expect(links).toContain('#/anlage/s-1/geraet/edge-45gz7da/src-7c1e9a2b');
    // Die Gefahrenzone gibt es NUR auf der Box.
    expect(screen.getByRole('button', { name: /Gerät entfernen/ })).toBeInTheDocument();
  });

  /**
   * ⚠ Was hier bewusst FEHLT, weil es die Box nie betraf: Register, Live-Werte,
   * „Misst & steuert". Die drei Sektionen standen bis Stufe 1 nur da, um ihre
   * Nicht-Zuständigkeit zu erklären.
   */
  it('zeigt KEINE Register-, Live- und Komponenten-Sektion', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Gelesene Register')).toBeNull();
    expect(screen.queryByText('Register schreiben')).toBeNull();
    expect(screen.queryByText(/kein Modbus-Gerät/)).toBeNull();
    expect(screen.queryByText('Live-Werte vom Gerät')).toBeNull();
    expect(screen.queryByText('Misst & steuert')).toBeNull();
  });

  /** D5: die eigene Adresse - und der Weg dorthin NUR, wenn er belegt ist. */
  it('sagt ehrlich, dass die Box ihre eigene Adresse noch nicht meldet', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(/meldet Ihre Box noch nicht/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Lokale Oberfläche/ })).toBeNull();
  });

  it('bietet die lokale Oberfläche an, sobald die Adresse BEWIESEN ist', async () => {
    stub();
    render(
      <BoxSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        devices={[{ ...box, lanHost: '192.168.20.14', lanSource: 'erreicht', lanSeenAt: FRISCH }]}
      />,
    );
    await screen.findByRole('heading', { level: 1 });
    const link = screen.getByRole('link', { name: /Lokale Oberfläche/ });
    expect(link.getAttribute('href')).toBe('http://192.168.20.14');
  });

  /**
   * Was die Box ÜBERBRINGT: die anlagenweiten Befehle - und der Weg zu allem
   * anderen führt auf die UNGEFILTERTE Befehle-Seite (Ziel-Attribution).
   */
  it('zeigt, was die Box überbringt, und führt auf die ganze Anlage', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    expect(await screen.findByText('Was Ihre Box überbringt')).toBeInTheDocument();
    expect(api.commandHistory).toHaveBeenCalledWith('s-1', { device: 'edge-45gz7da' });
    expect(screen.getByText(/stehen auf der\s+Seite dieses Geräts/)).toBeInTheDocument();
    const alle = screen.getByRole('link', { name: /Alle Befehle dieser Anlage/ });
    expect(alle.getAttribute('href')).toBe('#/anlage/s-1/befehle');
  });

  it('löst die EINE Box der Anlage auch ohne Referenz auf', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef={null} devices={[box]} />);
    expect(await screen.findByRole('heading', { name: 'VoltPilot-Box Pilsting' }))
      .toBeInTheDocument();
  });

  it('nennt den GRUND, wenn die Adresse keine Box dieser Anlage nennt', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-gibt-es-nicht" devices={[box]} />);
    expect(await screen.findByText(/nennt keine VoltPilot-Box dieser Anlage/))
      .toBeInTheDocument();
  });

  it('zeigt einen Fehlerzustand mit Wiederholen, wenn der TRAGENDE Abruf ausfällt', async () => {
    stub({ entities: () => Promise.reject(new Error('down')) });
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    expect(await screen.findByText(/konnte nicht geladen werden/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Erneut/ })).toBeInTheDocument();
  });

  it('führt zurück ins Anlagen-Modell', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    const back = await screen.findByRole('link', { name: /Zurück zu den Komponenten/ });
    expect(back.getAttribute('href')).toBe('#/anlage/s-1/modell');
  });
});

// ---------------------------------------------------------------------------
// Die PLATTFORM-Sicht auf DERSELBEN Seite (M7-Rollen-Tor) - sie zog mit der
// Box-Gattung mit, statt ein zweites Mal zu entstehen.
// ---------------------------------------------------------------------------

describe('BoxSeiteSection · Plattform-Sicht', () => {
  afterEach(() => vi.restoreAllMocks());

  function stubAdmin() {
    vi.spyOn(adminApi, 'listDevices').mockResolvedValue([
      {
        deviceId: 'gw',
        externalRef: 'edge-45gz7da',
        label: 'Pilsting',
        siteId: 's-1',
        siteName: 'Pilsting',
        tenantId: 't-1',
        tenantName: 'Kunde',
        kind: 'inverter',
        ist: 'edge-2026.08.1-9b37439a02c1',
        soll: 'edge-2026.08.1',
        sollSeq: 14,
        channel: 'stable',
        pinned: false,
        state: 'bestaetigt',
        reason: null,
        blocker: null,
        lastSeenAt: FRISCH,
        reportedAt: FRISCH,
        provisioned: false,
        note: null,
        provisionedAt: null,
      },
    ]);
    vi.spyOn(fleetApi, 'fleet').mockResolvedValue({
      sites: [],
      releases: [],
      journal: [],
      kpi: null,
    } as never);
    vi.spyOn(adminApi, 'controlCandidates').mockResolvedValue([]);
    vi.spyOn(adminApi, 'edgeUpdates').mockResolvedValue({
      releases: [],
      journal: [],
      rollout: null,
      fleet: [],
      kpi: null,
    } as never);
  }

  it('zeigt dem KUNDEN keine Plattform-Sicht', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(false);
    stub();
    stubAdmin();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('box-admin')).toBeNull();
    // Und die Admin-Reads werden gar nicht erst geholt.
    expect(adminApi.listDevices).not.toHaveBeenCalled();
  });

  it('zeigt dem PLATTFORM-ADMIN dieselbe Seite PLUS die Plattform-Sicht', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    stubAdmin();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    const block = await screen.findByTestId('box-admin');
    expect(within(block).getByText(/Plattform-Sicht/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('bleibt ohne Admin-Daten stehen - eine gescheiterte Plattform-Sicht kippt die Seite nicht', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    vi.spyOn(adminApi, 'listDevices').mockRejectedValue(new Error('down'));
    vi.spyOn(fleetApi, 'fleet').mockRejectedValue(new Error('down'));
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(adminApi.listDevices).toHaveBeenCalled());
    expect(screen.queryByTestId('box-admin')).toBeNull();
  });
});
