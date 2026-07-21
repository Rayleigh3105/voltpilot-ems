import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SteuerungSection } from './SteuerungSection';
import { api, type Site } from '../api';
import { optimizerApi } from '../optimizerApi';
import * as flowsApi from '../flows/flowsApi';
import { NODE_MARKET } from '../usageProfile';

// The read-only canvas preview needs real layout; the derivation it renders is
// covered by the flow-editor tests.
vi.mock('../components/flows/FlowCanvas', () => ({
  FlowCanvas: () => <div data-testid="canvas" />,
}));

const site: Site = {
  id: 's-1',
  name: 'Halle Nord',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'fest',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
  leistungspreisEurKw: 120,
  peakReserveSocPct: 30,
};

const BOUND = {
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  validate: vi.fn(),
  simulate: vi.fn(),
  simulationResult: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  remove: vi.fn(),
  versions: vi.fn(),
  entities: vi.fn(),
  governance: vi.fn(),
  socBands: vi.fn(),
};

function setup(overrides: Partial<typeof BOUND> = {}) {
  const bound = { ...BOUND, ...overrides };
  vi.spyOn(flowsApi, 'customerFlowApi').mockReturnValue(
    bound as unknown as flowsApi.BoundFlowApi,
  );
  return bound;
}

beforeEach(() => {
  vi.restoreAllMocks();
  BOUND.list.mockResolvedValue([]);
  BOUND.entities.mockResolvedValue([
    { id: 'e-batt', entityType: 'battery-hybrid', label: 'Speicher', measure: ['soc_pct'], actuate: ['setpoint_kw'] },
    { id: 'e-pv', entityType: 'producer', label: 'PV-Dach', measure: ['pv_power_kw'], actuate: [] },
  ]);
  BOUND.governance.mockResolvedValue({ gatedNodes: [] });
  BOUND.deactivate.mockResolvedValue({
    deactivated: true, published: true, message: 'Pausiert.', lifecycle: 'retired',
  });
  vi.spyOn(api, 'usageProfile').mockResolvedValue({
    signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  } as never);
  vi.spyOn(api, 'earnings').mockResolvedValue({
    sites: [
      {
        id: 's-1',
        eigenverbrauchsWertEur: 88.25,
        einspeiseErloesEur: 11,
        savedEur: 42.5,
        peakShaving: {
          leistungspreisEurKw: 120,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: 180,
          baselinePeakKw: 210,
          avoidedKw: 30,
          avoidedEur: 3600,
          history: [],
        },
      },
    ],
  } as never);
  vi.spyOn(api, 'entityStrategies').mockResolvedValue({});
  vi.spyOn(optimizerApi, 'configViaSwitcher').mockResolvedValue({
    effective: { socMinPct: 5, socMaxPct: 95, backupReserveSocPct: 20, wearCostCtPerKwh: 4 },
  } as never);
});

describe('SteuerungSection (M2)', () => {
  it('renders the four parts: active modes with contribution, co-optimization, Automationen, toolbox', async () => {
    setup();
    render(<SteuerungSection site={site} />);

    // 1 · Aktive Modi - peak (master data) + Eigenverbrauch (storage ∧ PV).
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Aktive Modi' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Lastspitzenkappung' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Eigenverbrauch' })).toBeInTheDocument();
    // ...with their REAL contribution numbers.
    expect(screen.getByText(/3\.600/)).toBeInTheDocument();
    expect(screen.getByText(/88,25/)).toBeInTheDocument();
    // ...and the master-data honesty line, without an "open flow" affordance.
    expect(screen.getAllByText(/Von VoltPilot eingerichtet/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pausieren' })).toBeNull();

    // 2 · Ko-Optimierung + der Reservierungs-Stack.
    expect(
      screen.getByText('2 Modi, ein Speicher — VoltPilot optimiert sie gemeinsam.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Notstrom-Reserve/)).toBeInTheDocument();
    expect(screen.getByText(/Lastspitzen-Reserve/)).toBeInTheDocument();

    // 3 · Automationen keeps the U3 mechanics.
    expect(screen.getByRole('heading', { name: 'Automationen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Baukasten/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Profi-Ansicht/ })).toBeInTheDocument();
    expect(screen.getByText('Wallbox nur bei PV-Überschuss')).toBeInTheDocument();

    // 4 · Die Werkzeugkiste - alles, was NICHT läuft, mit Voraussetzungen + Gate.
    expect(screen.getByRole('heading', { name: '＋ Modus hinzufügen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Marktvermarktung' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Eigene Regel' })).toBeInTheDocument();
    expect(screen.getAllByText('VoltPilot richtet ein').length).toBeGreaterThan(0);
    // Already-active modes are NOT offered again (no active/offer mixing).
    expect(screen.getAllByRole('heading', { name: 'Lastspitzenkappung' })).toHaveLength(1);
  });

  it('offers Details/Pausieren for a flow-backed mode and deactivates it', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([
      {
        flowId: 'f-market',
        name: 'Marktoptimierung',
        activeVersion: 1,
        latestVersion: 1,
        latestLifecycle: 'active',
        latestDocument: {
          schema_version: '1.0',
          name: 'Marktoptimierung',
          runtime: 'edge',
          nodes: [{ id: 'n1', type: NODE_MARKET, type_version: '1.0.0' }],
          edges: [],
          triggers: [],
        },
        simulation: null,
      },
    ]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SteuerungSection site={site} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pausieren' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pausieren' }));
    await waitFor(() => expect(bound.deactivate).toHaveBeenCalledWith('f-market'));
  });

  it('stays honest when the optional endpoints are unavailable (older backend / 403)', async () => {
    setup();
    vi.spyOn(api, 'earnings').mockRejectedValue(new Error('nope'));
    vi.spyOn(optimizerApi, 'configViaSwitcher').mockRejectedValue(new Error('403'));
    render(<SteuerungSection site={site} />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Aktive Modi' })).toBeInTheDocument());
    // No fabricated numbers - the contribution rows read "—".
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // The peak reserve still comes from the SiteDto echo, so the stack renders.
    expect(screen.getByText(/Lastspitzen-Reserve/)).toBeInTheDocument();
    expect(screen.queryByText(/Notstrom-Reserve/)).toBeNull();
  });

  it('shows no co-optimization strip with a single battery mode', async () => {
    setup();
    render(<SteuerungSection site={{ ...site, leistungspreisEurKw: null }} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Aktive Modi' })).toBeInTheDocument());
    expect(screen.queryByText(/ein Speicher — VoltPilot optimiert/)).toBeNull();
  });
});
