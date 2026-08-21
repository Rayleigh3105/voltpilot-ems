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
vi.mock('./WhatIfCompareChart', () => ({
  WhatIfCompareChart: () => <div data-testid="whatif-chart" />,
}));

const { listSites, diagnostics, config, updateConfig, whatIf } = vi.hoisted(() => ({
  listSites: vi.fn(),
  diagnostics: vi.fn(),
  config: vi.fn(),
  updateConfig: vi.fn(),
  whatIf: vi.fn(),
}));

vi.mock('../../admin/adminApi', () => ({
  adminApi: { listSites },
}));
vi.mock('../../optimizerApi', () => ({
  optimizerApi: { diagnostics, config, updateConfig, whatIf },
}));

const tenants: Tenant[] = [
  { id: 't-1', name: 'Demo GmbH', segment: 'B2C', plan: 'basic', betriebsart: null, betriebsartEffective: 'endkunde', createdAt: '2026-01-01T00:00:00Z' },
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
    availableRunsDate: '2026-06-12',
    firstRunDate: '2026-06-10',
    lastRunDate: '2026-06-12',
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
    priceSource: 'spot',
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

/**
 * Seit dem Picker-System (`vp-picker-system`) sind Mandant/Anlage/Lauf der
 * Haus-Picker, kein Browser-Auswahlfeld: geöffnet wird der Auslöser, gewählt
 * wird die Zeile. Der Tag ist der Haus-Kalender (Wochenstart Montag).
 */
function waehle(name: string, option: string | RegExp): void {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

/** Öffnet den Tages-Kalender und klickt den Tag des Monats an. */
function waehleTag(tag: number): void {
  fireEvent.click(screen.getByRole('combobox', { name: 'Tag' }));
  fireEvent.click(screen.getAllByRole('gridcell', { name: String(tag) })[0]);
}

beforeEach(() => {
  listSites.mockReset();
  diagnostics.mockReset();
  config.mockReset();
  updateConfig.mockReset();
  whatIf.mockReset();
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
    waehle('Mandant', 'Demo GmbH');
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
    waehle('Mandant', 'Demo GmbH');
    await waitFor(() => expect(listSites).toHaveBeenCalledWith('t-1'));
    waehle('Anlage', 'Hof Lindenberg');
    await waitFor(() => expect(diagnostics).toHaveBeenCalledWith('t-1', 's-1', null, null));
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
    await openSite(
      makeDiag({
        slots: [],
        availableRuns: [],
        availableRunsDate: null,
        firstRunDate: null,
        lastRunDate: null,
        generatedAt: null,
        planId: null,
      }),
    );
    expect(await screen.findByText(/noch kein Optimizer-Lauf/)).toBeInTheDocument();
    // Without any run there is no day to navigate - no date picker.
    expect(screen.queryByLabelText('Tag')).not.toBeInTheDocument();
  });
});

describe('OptimizerPage - date-navigable run picker', () => {
  async function openSite(diag: OptimizerDiagnostics) {
    listSites.mockResolvedValue(sites);
    diagnostics.mockResolvedValue(diag);
    config.mockResolvedValue(makeConfig());
    render(<OptimizerPage tenants={tenants} />);
    waehle('Mandant', 'Demo GmbH');
    await waitFor(() => expect(listSites).toHaveBeenCalledWith('t-1'));
    waehle('Anlage', 'Hof Lindenberg');
    await waitFor(() => expect(diagnostics).toHaveBeenCalledWith('t-1', 's-1', null, null));
  }

  it('bounds the Tag picker by the run-date range and loads the picked day', async () => {
    await openSite(makeDiag());
    expect(await screen.findByRole('combobox', { name: 'Tag' }))
      .toHaveTextContent('12.06.2026');
    // Nie ausserhalb des Lauf-Fensters: der 09.06. ist gesperrt, der 10.06. nicht.
    fireEvent.click(screen.getByRole('combobox', { name: 'Tag' }));
    expect(screen.getAllByRole('gridcell', { name: '9' })[0]).toBeDisabled();
    expect(screen.getAllByRole('gridcell', { name: '10' })[0]).not.toBeDisabled();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Escape' });

    // Picking an older day fetches THAT day's newest run + run list.
    diagnostics.mockResolvedValue(
      makeDiag({
        generatedAt: '2026-06-10T10:00:00Z',
        availableRuns: ['2026-06-10T10:00:00Z', '2026-06-10T09:45:00Z'],
        availableRunsDate: '2026-06-10',
      }),
    );
    waehleTag(10);
    await waitFor(() =>
      expect(diagnostics).toHaveBeenCalledWith('t-1', 's-1', null, '2026-06-10'),
    );
    const runTrigger = await screen.findByRole('combobox', { name: 'Lauf' });
    await waitFor(() => expect(runTrigger.textContent).toMatch(/10\.06\./));

    // Picking one of the day's runs keeps the day scope.
    fireEvent.click(runTrigger);
    const zeilen = screen.getAllByRole('option');
    expect(zeilen).toHaveLength(2);
    fireEvent.click(zeilen[1]);
    await waitFor(() =>
      expect(diagnostics).toHaveBeenCalledWith(
        't-1',
        's-1',
        '2026-06-10T09:45:00Z',
        '2026-06-10',
      ),
    );
  });

  it('shows an honest empty state for a day without runs, keeping the picker usable', async () => {
    await openSite(makeDiag());
    diagnostics.mockResolvedValue(
      makeDiag({
        generatedAt: null,
        planId: null,
        slots: [],
        availableRuns: [],
        availableRunsDate: '2026-06-11',
      }),
    );
    waehleTag(11);
    // Both the EmptyState heading and the disabled picker's placeholder row
    // carry the phrase - target the heading.
    expect(
      await screen.findByRole('heading', { name: 'Keine Läufe an diesem Tag' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/zwischen dem 10\.06\.2026 und dem 12\.06\.2026/)).toBeInTheDocument();
    // The date picker stays rendered so the admin can navigate away.
    expect(screen.getByRole('combobox', { name: 'Tag' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Lauf' })).toBeDisabled();
  });
});

describe('OptimizerPage - config PUT round-trip', () => {
  async function openConfig(cfg = makeConfig()) {
    listSites.mockResolvedValue(sites);
    diagnostics.mockResolvedValue(makeDiag());
    config.mockResolvedValue(cfg);
    render(<OptimizerPage tenants={tenants} />);
    waehle('Mandant', 'Demo GmbH');
    await waitFor(() => expect(listSites).toHaveBeenCalledWith('t-1'));
    waehle('Anlage', 'Hof Lindenberg');
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
    // Both the config panel and the what-if panel explain the same absence,
    // each in its own section - so match ALL of them, not one.
    expect(screen.getAllByText(/keinen Batteriespeicher/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Verschleißkosten-Override in ct/kWh')).toBeDisabled();
    // The backup reserve stays editable (site-scoped, not battery-scoped).
    expect(screen.getByLabelText('Backup-Reserve-Override in Prozent')).not.toBeDisabled();
  });
});

describe('OptimizerPage - what-if re-optimize', () => {
  function makeWhatIf(over: Record<string, unknown> = {}) {
    const plan = (o: Record<string, unknown> = {}) => ({
      slotMinutes: 15,
      costEur: -1,
      baselineCostEur: 2,
      savingsEur: 3,
      wearCostEur: 1,
      netSavingsEur: 2,
      terminalValueEurPerKwh: 0.2,
      bankedValueEur: 0.5,
      chargedKwh: 10,
      dischargedKwh: 9,
      gridImportKwh: 20,
      gridExportKwh: 5,
      curtailedKwh: 0,
      cycles: 1,
      socStartPct: 20,
      socEndPct: 40,
      peakTargetKw: null,
      fallback14a: false,
      knobs: {
        wearCostCtPerKwh: 4,
        backupReserveSocPct: null,
        socMinPct: 5,
        socMaxPct: 95,
        netzladenErlaubt: false,
      },
      slots: [],
      ...o,
    });
    return {
      siteId: 's-1',
      computedAt: '2026-08-03T10:00:00Z',
      horizonSlots: 96,
      slotMinutes: 15,
      appliedOverrides: { wearCostCtPerKwh: 8 },
      baseline: plan(),
      variant: plan({ netSavingsEur: 3.5 }),
      delta: { netSavingsEur: 1.5 },
      ...over,
    };
  }

  async function openSite() {
    listSites.mockResolvedValue(sites);
    diagnostics.mockResolvedValue(makeDiag());
    config.mockResolvedValue(makeConfig());
    render(<OptimizerPage tenants={tenants} />);
    waehle('Mandant', 'Demo GmbH');
    await waitFor(() => expect(listSites).toHaveBeenCalledWith('t-1'));
    waehle('Anlage', 'Hof Lindenberg');
    await waitFor(() => expect(diagnostics).toHaveBeenCalledWith('t-1', 's-1', null, null));
  }

  it('always states that nothing is sent to the plant', async () => {
    await openSite();
    expect(
      await screen.findByText(/es wird nichts an die Anlage gesendet/i),
    ).toBeInTheDocument();
    // ... and it says so BEFORE any run, not only next to a result.
    expect(whatIf).not.toHaveBeenCalled();
  });

  it('posts only the moved knob and renders the comparison', async () => {
    await openSite();
    whatIf.mockResolvedValue(makeWhatIf());

    fireEvent.change(await screen.findByLabelText('Vorschau: Verschleißkosten in ct/kWh'), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Neu rechnen' }));

    await waitFor(() =>
      expect(whatIf).toHaveBeenCalledWith('t-1', 's-1', { wearCostCtPerKwh: 8 }),
    );
    expect(await screen.findByTestId('whatif-chart')).toBeInTheDocument();
    expect(screen.getByText(/mehr Ersparnis/)).toBeInTheDocument();
    // The persisted run above is untouched - its own chart is still there.
    expect(screen.getByTestId('plan-chart')).toBeInTheDocument();
  });

  it('a Speicherschonung preset fills the wear field, it does not post on its own', async () => {
    await openSite();
    fireEvent.click(await screen.findByRole('button', { name: 'Schonend' }));
    expect((screen.getByLabelText('Vorschau: Verschleißkosten in ct/kWh') as HTMLInputElement).value).toBe('8');
    expect(whatIf).not.toHaveBeenCalled();
  });

  it('refuses an impossible knob client-side without a round trip', async () => {
    await openSite();
    fireEvent.change(await screen.findByLabelText('Vorschau: SoC-Untergrenze in %'), {
      target: { value: '80' },
    });
    fireEvent.change(screen.getByLabelText('Vorschau: SoC-Obergrenze in %'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neu rechnen' }));
    expect(await screen.findByText(/SoC-Band ungültig/)).toBeInTheDocument();
    expect(whatIf).not.toHaveBeenCalled();
  });

  it('shows the failure and DROPS the stale result - never a silent old answer', async () => {
    await openSite();
    whatIf.mockResolvedValueOnce(makeWhatIf());
    fireEvent.change(await screen.findByLabelText('Vorschau: Verschleißkosten in ct/kWh'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neu rechnen' }));
    expect(await screen.findByTestId('whatif-chart')).toBeInTheDocument();

    whatIf.mockRejectedValueOnce(new Error('boom'));
    fireEvent.change(screen.getByLabelText('Vorschau: Verschleißkosten in ct/kWh'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neu rechnen' }));

    expect(await screen.findByText(/fehlgeschlagen/)).toBeInTheDocument();
    expect(screen.queryByTestId('whatif-chart')).not.toBeInTheDocument();
  });
});
