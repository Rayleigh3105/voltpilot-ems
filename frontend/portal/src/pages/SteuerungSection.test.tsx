import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SteuerungSection } from './SteuerungSection';
import { api, type Site } from '../api';
import { optimizerApi } from '../optimizerApi';
import * as flowsApi from '../flows/flowsApi';
import type { SiteProfile } from '../profiles';

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

function profile(over: Partial<SiteProfile> & { id: string; label: string }): SiteProfile {
  return {
    state: null,
    derivedActive: false,
    active: false,
    unlocks: { views: [], widgets: [], moneyStream: null },
    requirements: [],
    blockedReason: null,
    origin: null,
    flowRef: null,
    gatedNodeTypes: [],
    gatedNodesEnabled: true,
    ...over,
  };
}

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
    { id: 'e-wb', entityType: 'wallbox', label: 'Wallbox', measure: ['power_kw'], actuate: ['on_off'] },
  ]);
  BOUND.governance.mockResolvedValue({ gatedNodes: [] });
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
  vi.spyOn(api, 'siteProfiles').mockResolvedValue({
    profiles: [
      profile({ id: 'lastspitzenkappung', label: 'Lastspitzenkappung', active: true }),
      profile({
        id: 'marktvermarktung',
        label: 'Marktvermarktung',
        active: true,
        blockedReason: 'Läuft noch nicht: Ihrer Anlage fehlt ein dynamischer Tarif.',
      }),
      profile({ id: 'eigenverbrauch', label: 'Eigenverbrauch', active: false }),
    ],
  });
  vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] });
  vi.spyOn(optimizerApi, 'configViaSwitcher').mockResolvedValue({
    effective: { socMinPct: 5, socMaxPct: 95, backupReserveSocPct: 20, wearCostCtPerKwh: 4 },
  } as never);
});

describe('SteuerungSection (Portal v3 M4)', () => {
  it('renders exactly two capsules plus the protection line', async () => {
    setup();
    const { container } = render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Modus-Profile' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Automationen' })).toBeInTheDocument();
    expect(container.querySelectorAll('section.vp-capsule')).toHaveLength(2);

    // The retired four-part surface is gone - no toolbox, no active/offer mix.
    expect(screen.queryByRole('heading', { name: 'Aktive Modi' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '＋ Modus hinzufügen' })).toBeNull();

    // The narrow always-on protection line.
    expect(screen.getByText(/Läuft immer mit/)).toBeInTheDocument();
    expect(screen.getByText('§ 14a-Schutz')).toBeInTheDocument();
    expect(screen.getByText('Negativpreis-Abregelung')).toBeInTheDocument();
    // EEG appears because grid charging is barred on this site.
    expect(screen.getByText('EEG: nur Solarladen')).toBeInTheDocument();
  });

  it('profile rows carry a real number, a real switch and the honest blocked reason', async () => {
    setup();
    render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /Lastspitzenkappung/ })).toBeInTheDocument());
    // Real contribution, not a fabricated 0.
    expect(screen.getByText(/3\.600/)).toBeInTheDocument();
    // The blocked profile states M3s reason - never an "Angefragt" prompt.
    expect(screen.getByText(/dynamischer Tarif/)).toBeInTheDocument();
    expect(screen.queryByText(/Angefragt/)).toBeNull();
    // The off profile still has a real switch.
    const off = screen.getByRole('switch', { name: /Eigenverbrauch einschalten/ });
    expect(off).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(off);
    await waitFor(() =>
      expect(api.setSiteProfile).toHaveBeenCalledWith('s-1', 'eigenverbrauch', 'an'));
  });

  it('renders the co-optimization reserve stack in the profile capsule', async () => {
    setup();
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByText('2 Modi, ein Speicher — VoltPilot optimiert sie gemeinsam.'))
        .toBeInTheDocument());
    expect(screen.getByText(/Notstrom-Reserve/)).toBeInTheDocument();
    expect(screen.getByText(/Lastspitzen-Reserve/)).toBeInTheDocument();
  });

  it('tapping a profile row opens its Modus-Container (v3.1-M2)', async () => {
    setup();
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Lastspitzenkappung öffnen/ })).toBeInTheDocument());
    // The retired "Profile verwalten" door is gone.
    expect(screen.queryByRole('button', { name: /Profile verwalten/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Lastspitzenkappung öffnen/ }));

    // The container replaces the two capsules: its back link + the mode's own
    // views section render, the capsules do not.
    expect(await screen.findByRole('button', { name: /Zur Steuerung/ })).toBeInTheDocument();
    expect(screen.getByText('Ansichten dieses Modus')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Automationen' })).toBeNull();

    // Back returns to the two capsules.
    fireEvent.click(screen.getByRole('button', { name: /Zur Steuerung/ }));
    expect(await screen.findByRole('heading', { name: 'Automationen' })).toBeInTheDocument();
  });

  it('toggling a row switch does not open the container', async () => {
    setup();
    render(<SteuerungSection site={site} />);
    const off = await screen.findByRole('switch', { name: /Eigenverbrauch einschalten/ });
    fireEvent.click(off);
    await waitFor(() =>
      expect(api.setSiteProfile).toHaveBeenCalledWith('s-1', 'eigenverbrauch', 'an'));
    // Still on the capsule surface - the switch never navigated into a container.
    expect(screen.queryByRole('button', { name: /Zur Steuerung/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Automationen' })).toBeInTheDocument();
  });

  it('has exactly ONE "Neue Automation" entry, whose dialog offers template → builder → editor', async () => {
    setup();
    render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Automationen' })).toBeInTheDocument());
    const plus = screen.getAllByRole('button', { name: /Neue Automation/ });
    expect(plus).toHaveLength(1);
    // No second door into the builder on the page itself.
    expect(screen.queryByRole('button', { name: /Profi-Ansicht/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Baukasten \(geführt\)/ })).toBeNull();

    fireEvent.click(plus[0]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('1 · Vorlage verwenden');
    expect(dialog).toHaveTextContent('2 · Geführter Baukasten');
    expect(dialog).toHaveTextContent('3 · Node-RED-Editor');
  });

  it('the dialog lists only fitting templates and hides the rest behind an honest counted line', async () => {
    setup();
    // Wallbox but NO grid meter: the PV-surplus template cannot run here.
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Neue Automation/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Neue Automation/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Heizstab-Zeitplan');
    expect(dialog).not.toHaveTextContent('Wallbox nur bei PV-Überschuss');

    const disclose = screen.getByRole('button', { name: /passt nicht zu Ihrer Anlage/ });
    expect(disclose).toHaveTextContent('1 weitere Vorlage passt nicht zu Ihrer Anlage');
    fireEvent.click(disclose);
    expect(await screen.findByText('Wallbox nur bei PV-Überschuss')).toBeInTheDocument();
    expect(screen.getByText(/fehlt Ihrer Anlage noch ein Netz-Zähler/)).toBeInTheDocument();
  });

  it('lists automations with their live state and no invented switch count', async () => {
    const bound = setup();
    bound.list.mockResolvedValue([
      {
        flowId: 'f-wb',
        name: 'Wallbox nur bei PV-Überschuss',
        activeVersion: 2,
        latestVersion: 2,
        latestLifecycle: 'active',
        latestDocument: {
          schema_version: '1.0', name: 'x', runtime: 'edge',
          nodes: [{ id: 'n1', type: 'vp.entity.control', type_version: '1.0.0' }],
          edges: [], triggers: [],
        },
        simulation: null,
      },
    ]);
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByText('Wallbox nur bei PV-Überschuss')).toBeInTheDocument());
    expect(screen.getByText('Läuft')).toBeInTheDocument();
    expect(screen.queryByText(/× geschaltet/)).toBeNull();
  });

  it('stays honest when the optional endpoints are unavailable (older backend / 403)', async () => {
    setup();
    vi.spyOn(api, 'earnings').mockRejectedValue(new Error('nope'));
    vi.spyOn(optimizerApi, 'configViaSwitcher').mockRejectedValue(new Error('403'));
    render(<SteuerungSection site={site} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Modus-Profile' })).toBeInTheDocument());
    // No fabricated numbers - the contribution reads "—".
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // The peak reserve still comes from the SiteDto echo, so the stack renders.
    expect(screen.getByText(/Lastspitzen-Reserve/)).toBeInTheDocument();
    expect(screen.queryByText(/Notstrom-Reserve/)).toBeNull();
  });

  it('shows no co-optimization strip with a single battery mode', async () => {
    setup();
    render(<SteuerungSection site={{ ...site, leistungspreisEurKw: null }} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Modus-Profile' })).toBeInTheDocument());
    expect(screen.queryByText(/ein Speicher — VoltPilot optimiert/)).toBeNull();
  });

  it('renders a calm empty profile capsule when the backend has no profiles', async () => {
    setup();
    vi.spyOn(api, 'siteProfiles').mockRejectedValue(new Error('older backend'));
    render(<SteuerungSection site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Modus-Profile' })).toBeInTheDocument());
    expect(screen.getByText(/noch keine Profile hinterlegt/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
