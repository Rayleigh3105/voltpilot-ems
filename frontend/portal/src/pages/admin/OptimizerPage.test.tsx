import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OptimizerPage } from './OptimizerPage';
import type { Tenant } from '../../admin/adminApi';
import type { OptimizerConfig, OptimizerDiagnostics } from '../../optimizerApi';

// The ECharts plan chart needs canvas + ResizeObserver jsdom lacks; the page
// logic under test (pickers, null states, waterfall, config PUT) is
// chart-independent, so stub it.
vi.mock('./OptimizerPlanChart', () => ({
  OptimizerPlanChart: () => <div data-testid="plan-chart" />,
}));

const { listSites, diagnostics, config, updateConfig } = vi.hoisted(() => ({
  listSites: vi.fn(),
  diagnostics: vi.fn(),
  config: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('../../admin/adminApi', () => ({
  adminApi: { listSites },
}));
vi.mock('../../optimizerApi', () => ({
  optimizerApi: { diagnostics, config, updateConfig },
}));

const tenants: Tenant[] = [
  { id: 't-1', name: 'Demo GmbH', segment: 'B2C', plan: 'basic', createdAt: '2026-01-01T00:00:00Z' },
];

const sites = [
  {
    id: 's-1',
    name: 'Hof Lindenberg',
    biddingZone: 'DE-LU',
    latitude: null,
    longitude: null,
    plantKind: 'eigenverbrauch' as const,
    anzulegenderWertCtKwh: null,
    tarifArt: 'dynamisch' as const,
    tarifParamCtKwh: 18,
    netzladenErlaubt: false,
  },
];

function makeDiag(over: Partial<OptimizerDiagnostics> = {}): OptimizerDiagnostics {
  return {
    siteId: 's-1',
    planId: 'p-1',
    generatedAt: '2026-06-12T00:00:00Z',
    slotMinutes: 15,
    availableRuns: ['2026-06-12T00:00:00Z'],
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 18,
    anzulegenderWertCtKwh: null,
    backupReserveSocPct: null,
    battery: {
      capacityKwh: 10,
      roundtripEfficiencyPct: 92,
      wearCostCtPerKwh: 4,
      wearCostSource: 'platform-default',
      socMinPct: 5,
      socMaxPct: 95,
    },
    activeLoadModel: 'load-persistence',
    activePvModel: 'pv-physical',
    storedEnergyValueIsApproximation: true,
    slots: [
      {
        time: '2026-06-12T17:00:00Z',
        batteryKw: -4,
        gridKw: 1,
        socPct: 60,
        loadKw: 2,
        pvKw: 0,
        curtailKw: null,
        costEur: 0.05,
        baselineCostEur: 0.55,
        wearCostEur: 0.02,
        solverPriceCtKwh: 15,
        importPriceCtKwh: 33,
        exportValueCtKwh: 7.9,
        wearCostCtKwh: 0.4,
        valueOfStoredEnergyCtKwh: 20,
        decisionLabel: 'entladen',
        whyText: 'Entlädt in den Abendverbrauch, weil der Bezug teurer ist als der Speicherwert.',
      },
    ],
    ...over,
  };
}

function makeConfig(over: Partial<OptimizerConfig> = {}): OptimizerConfig {
  return {
    siteId: 's-1',
    hasBattery: true,
    defaults: {
      wearCostCtPerKwh: 4,
      socMinPct: 5,
      socMaxPct: 95,
      terminalValueQuantile: 0.3,
      terminalValueCtPerKwh: null,
    },
    overrides: { wearCostCtPerKwh: null, socMinPct: null, socMaxPct: null, backupReserveSocPct: null },
    effective: { wearCostCtPerKwh: 4, socMinPct: 5, socMaxPct: 95, backupReserveSocPct: null },
    site: {
      netzladenErlaubt: false,
      plantKind: 'eigenverbrauch',
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
      anzulegenderWertCtKwh: null,
    },
    ...over,
  };
}

beforeEach(() => {
  listSites.mockReset();
  diagnostics.mockReset();
  config.mockReset();
  updateConfig.mockReset();
});

describe('OptimizerPage - picker gating', () => {
  it('prompts for a Mandant before anything loads', () => {
    render(<OptimizerPage tenants={tenants} />);
    expect(screen.getByText(/Wählen Sie oben einen Mandanten/)).toBeInTheDocument();
    expect(listSites).not.toHaveBeenCalled();
  });

  it('loads sites after a Mandant is chosen', async () => {
    listSites.mockResolvedValue(sites);
    render(<OptimizerPage tenants={tenants} />);
    fireEvent.change(screen.getByLabelText('Mandant'), { target: { value: 't-1' } });
    await waitFor(() => expect(listSites).toHaveBeenCalledWith('t-1'));
    expect(await screen.findByText(/Wählen Sie eine Anlage/)).toBeInTheDocument();
  });
});

describe('OptimizerPage - diagnostics rendering', () => {
  async function openSite(diag: OptimizerDiagnostics, cfg = makeConfig()) {
    listSites.mockResolvedValue(sites);
    diagnostics.mockResolvedValue(diag);
    config.mockResolvedValue(cfg);
    render(<OptimizerPage tenants={tenants} />);
    fireEvent.change(screen.getByLabelText('Mandant'), { target: { value: 't-1' } });
    await screen.findByRole('option', { name: 'Hof Lindenberg' });
    fireEvent.change(screen.getByLabelText('Anlage'), { target: { value: 's-1' } });
    await waitFor(() => expect(diagnostics).toHaveBeenCalledWith('t-1', 's-1', null));
  }

  it('renders verdict, plan, slot breakdown and objective KPIs', async () => {
    await openSite(makeDiag());
    // Verdict: net saving 0.55-0.05-0.02 = 0.48 EUR -> good (also echoed in
    // the plan insight + the Netto KPI, so there are several matches).
    expect((await screen.findAllByText(/0,48 €\/Tag/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('plan-chart')).toBeInTheDocument();
    // Explain-a-slot waterfall shows the real ct/kWh components + whyText.
    expect(screen.getByText('Bezugspreis (real)')).toBeInTheDocument();
    expect(screen.getByText(/Entlädt in den Abendverbrauch/)).toBeInTheDocument();
    // Objective breakdown labels present.
    expect(screen.getByText(/Netto-Ersparnis \(real\)/)).toBeInTheDocument();
  });

  it('honours null discipline: no wear persisted shows "—", never 0', async () => {
    const d = makeDiag();
    d.slots = d.slots.map((s) => ({ ...s, wearCostEur: null }));
    await openSite(d);
    // Verschleißkosten KPI shows the honest em-dash + "nicht bepreist".
    expect(await screen.findByText(/nicht bepreist \(vor P2\)/)).toBeInTheDocument();
  });

  it('shows the empty-run state when a site has no plan', async () => {
    await openSite(makeDiag({ slots: [], availableRuns: [] }));
    expect(await screen.findByText(/noch kein Optimizer-Lauf/)).toBeInTheDocument();
  });
});

describe('OptimizerPage - config PUT round-trip', () => {
  async function openConfig(cfg = makeConfig()) {
    listSites.mockResolvedValue(sites);
    diagnostics.mockResolvedValue(makeDiag());
    config.mockResolvedValue(cfg);
    render(<OptimizerPage tenants={tenants} />);
    fireEvent.change(screen.getByLabelText('Mandant'), { target: { value: 't-1' } });
    await screen.findByRole('option', { name: 'Hof Lindenberg' });
    fireEvent.change(screen.getByLabelText('Anlage'), { target: { value: 's-1' } });
    await screen.findByText('Optimizer konfigurieren');
  }

  it('sends only-changed overrides with empty fields as null (clear to default)', async () => {
    updateConfig.mockImplementation((_t, _s, body) =>
      Promise.resolve(makeConfig({ overrides: { ...makeConfig().overrides, wearCostCtPerKwh: 3 } })),
    );
    await openConfig();
    fireEvent.change(screen.getByLabelText('Verschleißkosten-Override in ct/kWh'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith('t-1', 's-1', {
        wearCostCtPerKwh: 3,
        socMinPct: null,
        socMaxPct: null,
        backupReserveSocPct: null,
      }),
    );
    expect(await screen.findByText(/Gespeichert/)).toBeInTheDocument();
  });

  it('validates the SoC band client-side without a round-trip', async () => {
    await openConfig();
    // Untergrenze 96 crosses the default 95 max -> invalid window, no PUT.
    fireEvent.change(screen.getByLabelText('SoC-Untergrenze-Override in Prozent'), {
      target: { value: '96' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
    expect(await screen.findByText(/SoC-Band ungültig/)).toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('disables battery overrides and explains why on a battery-less site', async () => {
    await openConfig(
      makeConfig({
        hasBattery: false,
        effective: { wearCostCtPerKwh: null, socMinPct: null, socMaxPct: null, backupReserveSocPct: null },
      }),
    );
    expect(screen.getByText(/keinen Batteriespeicher/)).toBeInTheDocument();
    expect(screen.getByLabelText('Verschleißkosten-Override in ct/kWh')).toBeDisabled();
    // The backup reserve stays editable (site-scoped, not battery-scoped).
    expect(screen.getByLabelText('Backup-Reserve-Override in Prozent')).not.toBeDisabled();
  });
});
