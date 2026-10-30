import { sichtbareListe } from '../test/rollenFixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BoxSeiteSection } from './BoxSeiteSection';
import { BAUSTEIN_ORDNUNG } from '../geraetRahmen';
import * as auth from '../auth';
import { adminApi } from '../admin/adminApi';
import { ApiError } from '../api';
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
  type UemsDatenquelle,
  type UemsGeraet,
} from '../api';
import { consumersApi } from '../consumers/consumersApi';
import { gatewayForm, goreForm } from '../test/boxGeraeteFixtures';
import { gsVerlauf } from '../test/geraetesucheFixtures';
import { aufbauHash } from '../nav';

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
  topology?: SiteTopology | null;
  sources?: SiteSource[];
  datenquellen?: readonly UemsDatenquelle[] | null;
  uemsGeraete?: readonly UemsGeraet[] | null;
} = {}) {
  vi.spyOn(api, 'siteEntities').mockImplementation(
    over.entities ?? (() => Promise.resolve(entities)),
  );
  vi.spyOn(api, 'topology').mockResolvedValue((over.topology === undefined ? topology : over.topology) as SiteTopology);
  vi.spyOn(api, 'siteSources').mockResolvedValue(over.sources ?? sources);
  // GE-4: dieselben Abrufe wie Anlage › Aufbau — Wege, ihre Verweise auf Geräte und die Verbraucher.
  vi.spyOn(api, 'datenquellen').mockResolvedValue({ datenquellen: [...(over.datenquellen ?? [])] } as never);
  vi.spyOn(api, 'uemsGeraete').mockImplementation(() => over.uemsGeraete === null
    ? Promise.reject(new Error('down'))
    : Promise.resolve({ geraete: [...(over.uemsGeraete ?? [])] }));
  vi.spyOn(consumersApi, 'list').mockResolvedValue([]);
  vi.spyOn(api, 'gemeinsameSteuerung').mockRejectedValue(new Error('nicht gebraucht'));
  vi.spyOn(api, 'standorte').mockRejectedValue(new Error('nicht gebraucht'));
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
  vi.spyOn(api, 'edgeVersions').mockResolvedValue(sichtbareListe([
    {
      deviceId: 'gw',
      siteId: 's-1',
      coreVersion: 'edge-2026.08.10',
      paletteVersion: '0.9.0',
      reportedAt: FRISCH,
    },
  ]));
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
   * Die BÜHNE: verbunden? wie viele Geräte liefern? Darunter die GERÄTE, die
   * die Seite ausmachen - und Software und Adresse in „Gerät & Verbindung".
   */
  it('führt mit dem Zustand der Kette und den Geräten AN der Box', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);

    expect(await screen.findByRole('heading', { name: 'VoltPilot-Box Pilsting' }))
      .toBeInTheDocument();
    const buehne = screen.getByTestId('geraet-held');
    expect(within(buehne).getByTestId('geraet-heldsatz')).toHaveTextContent(/Geräten liefern Daten/);

    // Die drei Fragen von früher stehen als Zeilen in „Gerät & Verbindung".
    const details = screen.getByTestId('baustein-details');
    expect(within(details).getByText('Verbindung')).toBeInTheDocument();
    expect(within(details).getByText('Software')).toBeInTheDocument();
    expect(within(details).getByText('Im Netzwerk')).toBeInTheDocument();

    const geraete = screen.getByTestId('box-geraete');
    // Beide gemeldeten Geräte führen auf ihre EIGENE Seite.
    const links = within(geraete).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('#/anlage/s-1/geraet/edge-45gz7da/inverter');
    expect(links).toContain('#/anlage/s-1/geraet/edge-45gz7da/src-7c1e9a2b');
    // V7: das Unumkehrbare wohnt im Menü „⋯" - kein roter Kasten mehr.
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect(screen.getByRole('menuitem', { name: /Gerät entfernen/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Datenaufzeichnungen löschen/ })).toBeInTheDocument();
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

  /** D5: die eigene Adresse - und der Weg dorthin nur im Kundennetz. */
  it('sagt ehrlich, dass die Box ihre eigene Adresse noch nicht meldet', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(/meldet Ihre Box noch nicht/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Lokale Oberfläche/ })).toBeNull();
  });

  it('bietet die lokale Oberfläche am gemeldeten Kundennetz-Endpunkt an', async () => {
    stub();
    render(
      <BoxSeiteSection
        site={site}
        boxRef="edge-45gz7da"
        devices={[{
          ...box,
          lanHost: '192.168.20.14:8484',
          lanSource: 'schnittstelle',
          lanSeenAt: FRISCH,
        }]}
      />,
    );
    await screen.findByRole('heading', { level: 1 });
    const link = screen.getByRole('link', { name: /Lokale Oberfläche/ });
    expect(link.getAttribute('href')).toBe('http://192.168.20.14:8484');
  });

  /**
   * Was die Box ÜBERBRINGT: die anlagenweiten Befehle - und der Weg zu allem
   * anderen führt auf die UNGEFILTERTE Befehle-Seite (Ziel-Attribution).
   */
  it('zeigt, was die Box überbringt, und führt auf die ganze Anlage', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    const aktivitaet = await screen.findByTestId('baustein-aktivitaet');
    expect(api.commandHistory).toHaveBeenCalledWith('s-1', expect.objectContaining({
      device: 'edge-45gz7da',
    }));
    // Der Hinweis „die Befehle eines Geräts stehen auf seiner Seite" steht
    // hinter dem ⓘ der Karte - nicht als Dauertext.
    fireEvent.click(within(aktivitaet).getByRole('button', { name: /Hinweise zu „Aktivität"/ }));
    expect(screen.getByText(/stehen auf der\s+Seite dieses Geräts/)).toBeInTheDocument();
    const alle = within(aktivitaet).getByRole('link', { name: /Alle/ });
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

  it('traegt GENAU EINEN Rueckweg: die Brotkrume Anlage - Komponenten - Box', async () => {
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    const pfad = await screen.findByRole('navigation', { name: 'Pfad zur Geräteseite' });
    expect(within(pfad).getByRole('link', { name: 'Anlage' }).getAttribute('href'))
      .toBe('#/anlage/s-1');
    expect(within(pfad).getByRole('link', { name: 'Aufbau' }).getAttribute('href'))
      .toBe('#/anlage/s-1/modell');
    expect(screen.queryByRole('link', { name: /Zurück zu den Komponenten/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Die PLATTFORM-Sicht auf DERSELBEN Seite (M7-Rollen-Tor) - sie zog mit der
// Box-Gattung mit, statt ein zweites Mal zu entstehen.
// ---------------------------------------------------------------------------

describe('BoxSeiteSection · Plattform-Sicht', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Die Technik-Ansicht ist eine ADRESSE - sie bliebe sonst für den nächsten Test offen.
    window.location.hash = '';
  });

  function stubAdmin() {
    vi.spyOn(adminApi, 'fernwartungBox').mockRejectedValue(
      new ApiError(404, 'Für edge-45gz7da ist kein Tunnel-Schlüssel hinterlegt.'),
    );
    vi.spyOn(adminApi, 'fernwartung').mockRejectedValue(new Error('nicht gebraucht'));
    vi.spyOn(adminApi, 'fernwartungTechniker').mockResolvedValue([]);
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
    // Und die Admin-Reads werden gar nicht erst geholt - auch die
    // Fernwartung nicht (O3: der Kunde sieht die Fenster nicht).
    expect(adminApi.listDevices).not.toHaveBeenCalled();
    expect(adminApi.fernwartungBox).not.toHaveBeenCalled();
    expect(screen.queryByTestId('fw-karte')).toBeNull();
  });

  it('zeigt dem PLATTFORM-ADMIN dieselbe Seite PLUS die Plattform-Sicht', async () => {
    vi.spyOn(auth, 'isPlatformAdmin').mockReturnValue(true);
    stub();
    stubAdmin();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    await screen.findByRole('heading', { level: 1 });
    // Sie ist der LETZTE Teil von „Technik & Diagnose" (E1 a) - eine eigene
    // Ansicht, nie ein Kasten auf der Kunden-Seite.
    await waitFor(() => expect(screen.getByTestId('geraet-technik-oeffnen')).toHaveTextContent(/Plattform-Sicht/));
    fireEvent.click(screen.getByTestId('geraet-technik-oeffnen'));
    const technik = await screen.findByTestId('geraet-technik');
    const teil = within(technik).getByText('Plattform-Sicht (Admin)').closest('[data-technik]') as HTMLElement;
    expect(teil.getAttribute('data-technik')).toBe('plattform');
    expect(within(teil).getByTestId('box-admin')).toBeTruthy();
    // Die Fernwartung dieser Box: ohne hinterlegten Schlüssel sagt sie das.
    expect(await within(teil).findByText(/kein Tunnel-Schlüssel hinterlegt/)).toBeTruthy();
    expect(adminApi.fernwartungBox).toHaveBeenCalledWith('edge-45gz7da');
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

// ---------------------------------------------------------------------------
// Geräteseiten Stufe 1: DER RAHMEN - dieselbe Ordnung wie an jedem Gerät
// ---------------------------------------------------------------------------

describe('BoxSeiteSection · Kern', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lässt AUS, was eine Box nicht hat - und sortiert nie um', async () => {
    window.location.hash = '#/anlage/s-1/box/edge-45gz7da';
    stub();
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    const rahmen = await screen.findByTestId('box-rahmen');
    const ids = Array.from(rahmen.querySelectorAll('[data-baustein]'))
      .map((el) => el.getAttribute('data-baustein')!)
      .filter((id) => id !== 'modul');

    // Dieselbe Ordnung wie an jedem Gerät, auch wenn Bausteine fehlen.
    expect(ids).toEqual([...ids].sort(
      (a, b) => BAUSTEIN_ORDNUNG.indexOf(a as never) - BAUSTEIN_ORDNUNG.indexOf(b as never),
    ));
    // Eine Box hat keine Knöpfe und keine Hauptgröße über den Tag.
    expect(ids).not.toContain('steuerung');
    expect(ids).not.toContain('heute');
    expect(ids).toEqual(['buehne', 'aktivitaet', 'details']);
    // Die Geräte an der Box stehen als eigener Baustein direkt neben der Bühne (GE-4: „Geräte an dieser Box“ —
    // vorher „Datenquellen und Geräte“, UEMS AP-06 IP-16).
    expect(screen.getByTestId('baustein-modul')).toHaveTextContent('Geräte an dieser Box');
    expect(screen.getByTestId('baustein-modul')).not.toHaveTextContent('Datenquellen und Geräte');
    // Register hat ein Rechner nicht - Technik & Diagnose führt nur Rohdaten.
    expect(screen.getByTestId('geraet-technik-oeffnen')).toHaveTextContent('Rohdaten');
    expect(screen.getByTestId('geraet-technik-oeffnen')).not.toHaveTextContent('Register');
  });
});

// ---------------------------------------------------------------------------
// GE-4 (Konzept „Ein Gerät, ein Eintrag"): „Geräte an dieser Box" aus DERSELBEN Zuordnung wie der Aufbau
// ---------------------------------------------------------------------------

describe('BoxSeiteSection · Geräte an dieser Box (GE-4)', () => {
  afterEach(() => vi.restoreAllMocks());

  const amOrt = (id: string, name: string): Site => ({ ...site, id, name });

  /**
   * Gore (Neue Halle): vorher stand die Steuerung hier zweimal — als „DQ-1" in „Datenquellen und Geräte" und als Gerät
   * darunter, ohne Bezug. Jetzt EINE Zeile mit ihrer Anbindung und Last; die Summe steht über der Liste.
   */
  it('Gore: die Steuerung EINMAL — mit Anbindung, Last, Box-Wechsel und der Summe, ohne Zeile für DQ-1', async () => {
    const d = goreForm(Date.now());
    stub({
      entities: () => Promise.resolve(d.entities!),
      topology: d.topology,
      sources: [],
      datenquellen: d.datenquellen,
      uemsGeraete: d.uemsGeraete,
    });
    render(<BoxSeiteSection site={amOrt('site-gore', 'Neue Halle')} boxRef="edge-5mz8bdd" devices={[...d.devices]} />);

    const liste = await screen.findByTestId('box-geraete');
    await waitFor(() => expect(liste).toHaveTextContent('Modbus TCP · 192.168.4.165:503 · Last 51 %'));
    expect(within(liste).getAllByRole('link').map((a) => a.getAttribute('href')))
      .toEqual(['#/anlage/site-gore/geraet/edge-5mz8bdd/as-e-as']);
    expect(liste).toHaveTextContent('Anlagensteuerung');
    expect(liste).toHaveTextContent('WAGO PFC200');
    expect(screen.getByTestId('box-last'))
      .toHaveTextContent('Zusammen 12 von 30 Anfragen/min · 305 von 600 Messwerten/min · Last 51 %');
    const modul = screen.getByTestId('baustein-modul');
    expect(modul).not.toHaveTextContent('DQ-1');
    expect(modul).not.toHaveTextContent('Datenquellen und Geräte');
    // Bühne und Liste zählen dieselben Geräte.
    expect(screen.getByTestId('geraet-heldsatz')).toHaveTextContent('1 von 1 Gerät liefert Daten.');
    // Der Box-Wechsel steht an der Zeile, deren Weg es ist.
    expect(within(modul).getByRole('button', { name: 'Zuständige Box wechseln für Anlagensteuerung' })).toBeInTheDocument();
  });

  it('Gateway-Form: das Gateway mit seinen vier Geräten darunter, ein offener Anschluss mit „Gerät hinzufügen"', async () => {
    const d = gatewayForm(Date.now());
    stub({
      entities: () => Promise.resolve(d.entities!),
      topology: d.topology,
      sources: d.sources ?? [],
      datenquellen: d.datenquellen,
      uemsGeraete: d.uemsGeraete,
    });
    render(<BoxSeiteSection site={amOrt('site-hs', 'Halle Süd')} boxRef="VP-HS-0001" devices={[...d.devices]} />);

    const liste = await screen.findByTestId('box-geraete');
    await waitFor(() => expect(within(liste).getByText('Zählergateway Halle')).toBeInTheDocument());
    const gateway = liste.querySelector('[data-box-weg="DQ-3"]') as HTMLElement;
    expect(gateway).toHaveTextContent('4 Geräte · Last 23 %');
    // GE-5: die Gateway-Zeile führt auf die Seite des Gateways.
    expect(gateway.querySelector(':scope > a.vp-geraet-zeile')).toHaveAttribute('href', '#/anlage/site-hs/geraet/VP-HS-0001/dq-3');
    const dahinter = within(gateway).getByRole('list', { name: 'Geräte hinter Zählergateway Halle' });
    expect(within(dahinter).getAllByRole('link')).toHaveLength(4);
    expect(within(dahinter).getAllByRole('link')[1]).toHaveTextContent('Geräte-ID 2');
    // Den Box-Wechsel trägt das Gateway — für alle vier; die Geräte dahinter haben keinen eigenen.
    expect(within(gateway).getAllByRole('button', { name: /Zuständige Box wechseln/ })).toHaveLength(1);

    const offen = liste.querySelector('[data-box-weg="DQ-5"]') as HTMLElement;
    expect(offen).toHaveTextContent('Anschluss ohne Gerät');
    expect(offen).toHaveTextContent('Kennung DQ-5');
    expect(within(offen).getByRole('link', { name: 'Gerät an Anschluss DQ-5 hinzufügen' }))
      .toHaveAttribute('href', '#/anlage/site-hs/modell?neu=geraet');

    expect(screen.getByTestId('box-last'))
      .toHaveTextContent('Zusammen 12 von 30 Anfragen/min · 186 von 600 Messwerten/min · Last 40 %');
    expect(screen.getByTestId('geraet-heldsatz')).toHaveTextContent('5 von 5 Geräten liefern Daten.');
  });

  it('ohne `…/geraete` zeigt sie keinen geratenen Anschluss — und sagt, dass die Zuordnung fehlt', async () => {
    const d = goreForm(Date.now());
    stub({
      entities: () => Promise.resolve(d.entities!),
      topology: d.topology,
      sources: [],
      datenquellen: d.datenquellen,
      uemsGeraete: null,
    });
    render(<BoxSeiteSection site={amOrt('site-gore', 'Neue Halle')} boxRef="edge-5mz8bdd" devices={[...d.devices]} />);
    const modul = await screen.findByTestId('baustein-modul');
    await waitFor(() => expect(modul).toHaveTextContent('ist gerade nicht bekannt'));
    expect(modul).not.toHaveTextContent('Anschluss ohne Gerät');
    expect(modul).not.toHaveTextContent('192.168.4.165');
    expect(screen.getByTestId('box-last')).toHaveTextContent('Last 51 %');
  });
});

describe('BoxSeiteSection · Gerätesuche (Bericht §4 „Einstiege“, m1/m8/d1)', () => {
  afterEach(() => vi.restoreAllMocks());
  const verlauf = () => gsVerlauf(Date.now()).map((e) => ({ ...e, deviceId: box.id }));

  it('„Geräte suchen“ im Kopf der Karte führt mit der Box in den Aufbau; die letzte Suche steht darunter', async () => {
    stub();
    vi.spyOn(api, 'geraetesucheVerlauf').mockResolvedValue({ suchen: verlauf() });
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    const knopf = await screen.findByTestId('geraete-suchen');
    expect(knopf).toHaveAttribute('href', aufbauHash(site.id, 'suche', { box: box.id }));
    expect(knopf).toHaveTextContent('Geräte suchen');
    const letzte = await screen.findByTestId('letzte-suche');
    expect(letzte).toHaveTextContent(/^Letzte Suche heute \d\d:\d\d · 2 Energie-Geräte, 2 davon noch nicht übernommen/);
    expect(within(letzte).getByRole('link', { name: 'Letzte Suchen' }))
      .toHaveAttribute('href', aufbauHash(site.id, 'suche', { box: box.id, verlauf: true }));
    expect(screen.queryByTestId('geraetesuche-grund')).toBeNull();
  });

  it('ohne die Fähigkeit: ausgegraut, mit „Update nötig für: Gerätesuche“ und „Update planen“', async () => {
    stub();
    vi.mocked(api.edgeVersions).mockResolvedValue(sichtbareListe([
      { deviceId: 'gw', siteId: 's-1', coreVersion: 'edge-2026.10.1', paletteVersion: null, reportedAt: FRISCH, capabilities: ['data_sources'] },
    ]));
    vi.spyOn(api, 'geraetesucheVerlauf').mockResolvedValue({ suchen: [] });
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    const grund = await screen.findByTestId('geraetesuche-grund');
    expect(grund).toHaveTextContent('Update nötig für: Gerätesuche');
    expect(within(grund).getByRole('link', { name: /Update planen/ })).toBeInTheDocument();
    const knopf = screen.getByRole('button', { name: 'Geräte suchen' });
    expect(knopf).toBeDisabled();
    expect(knopf).toHaveAttribute('aria-describedby', 'box-geraetesuche-grund');
  });

  it('eine laufende Suche lässt sich mitansehen - mit Person und Dauer', async () => {
    stub();
    const [, zweite] = verlauf();
    vi.spyOn(api, 'geraetesucheVerlauf').mockResolvedValue({
      suchen: [{ ...zweite, zustand: 'laeuft', gestartetAm: new Date(Date.now() - 12_000).toISOString(), dauerMs: null }],
    });
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[box]} />);
    expect(await screen.findByTestId('geraetesuche-grund')).toHaveTextContent(/Suche läuft · seit 1\d s · gestartet von Anna Weber \(VoltPilot-Service\)/);
    expect(screen.getByRole('link', { name: 'Mitansehen' }))
      .toHaveAttribute('href', aufbauHash(site.id, 'suche', { box: box.id, such: zweite.suchId }));
  });

  it('leere Box (m1): „An dieser Box meldet sich noch kein Gerät.“ mit dem Hauptknopf; offline sagt es warum', async () => {
    stub({ entities: () => Promise.resolve({ registry: null, entities: [], localSetup: [], staleOnDevice: [] }), sources: [] });
    vi.spyOn(api, 'geraetesucheVerlauf').mockResolvedValue({ suchen: [] });
    const alt = { ...box, lastSeenAt: new Date(Date.now() - 30 * 60_000).toISOString() };
    render(<BoxSeiteSection site={site} boxRef="edge-45gz7da" devices={[alt]} />);
    const leer = await screen.findByTestId('geraetesuche-leer');
    expect(within(leer).getByText('An dieser Box meldet sich noch kein Gerät.')).toBeInTheDocument();
    expect(within(leer).getByRole('button', { name: 'Geräte suchen' })).toBeDisabled();
    expect(within(leer).getByTestId('geraetesuche-grund')).toHaveTextContent(/^Ihre Box meldet sich gerade nicht \(zuletzt \d\d:\d\d\)/);
    expect(within(leer).getByRole('link', { name: 'Von Hand hinzufügen' })).toHaveAttribute('href', aufbauHash(site.id, 'geraet'));
  });
});
