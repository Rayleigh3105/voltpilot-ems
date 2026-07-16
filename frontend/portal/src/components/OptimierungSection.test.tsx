import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OptimierungSection } from './OptimierungSection';
import { api, type Earnings, type PeakShaving, type Site, type SiteAsset } from '../api';
import { optimizerApi, type OptimizerConfig } from '../optimizerApi';

const site: Site = {
  id: 's-1',
  name: 'Hof Sonnenfeld',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

function batteryAsset(overrides: Partial<SiteAsset> = {}): SiteAsset {
  return {
    id: 'a-1',
    type: 'battery',
    deviceId: 'd-1',
    capacityKwh: 10,
    maxChargeKw: 5,
    maxDischargeKw: 5,
    roundtripEfficiencyPct: 92,
    speicherschonung: 'ausgewogen',
    pvCapacityKwp: null,
    moduleCount: null,
    azimuthDeg: null,
    tiltDeg: null,
    commissionedOn: null,
    registry: null,
    registryUnitId: null,
    registryFetchedAt: null,
    ...overrides,
  };
}

function config(overrides: Partial<OptimizerConfig['overrides']> = {}): OptimizerConfig {
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
    overrides: {
      wearCostCtPerKwh: null,
      socMinPct: null,
      socMaxPct: null,
      backupReserveSocPct: null,
      ...overrides,
    },
    effective: { wearCostCtPerKwh: 4, socMinPct: 5, socMaxPct: 95, backupReserveSocPct: null },
    site: {
      netzladenErlaubt: false,
      plantKind: 'eigenverbrauch',
      tarifArt: 'dynamisch',
      tarifParamCtKwh: 18,
      anzulegenderWertCtKwh: null,
    },
  };
}

/** Minimal earnings response carrying (only) the PS-4 peakShaving block. */
function earningsWithPeak(peakShaving: PeakShaving | null): Earnings {
  return {
    range: 'month',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
    sites: [
      {
        id: 's-1',
        name: 'Hof Sonnenfeld',
        plantKind: 'eigenverbrauch',
        anzulegenderWertCtKwh: null,
        realizedExportCtKwh: null,
        marketValueSolarCtKwh: null,
        marketValueProvisional: null,
        baselineEur: null,
        actualEur: null,
        savedEur: null,
        arbitrageEur: null,
        pvShiftEur: null,
        coveredSlots: 0,
        firstCoveredDate: null,
        reason: 'no_data',
        dailySaved: [],
        tarifArt: 'dynamisch',
        tarifParamCtKwh: 18,
        einspeiseErloesEur: null,
        eigenverbrauchsWertEur: null,
        gesamtertragEur: null,
        selbstverbrauchKwh: null,
        eingespeistKwh: null,
        batterieBewegtKwh: null,
        expectedMarketValueSolarCtKwh: null,
        expectedMarketValueFrom: null,
        expectedMarketValueTo: null,
        expectedMarketValueSlots: null,
        series: [],
        monthlyStrip: [],
        peakShaving,
      },
    ],
    totals: {
      baselineEur: null,
      actualEur: null,
      savedEur: null,
      arbitrageEur: null,
      pvShiftEur: null,
      coveredSlots: 0,
      firstCoveredDate: null,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // The PS-4 proof fetch is fail-soft; default to "no block" so the existing
  // card behavior stays the baseline of every test.
  vi.spyOn(api, 'earnings').mockResolvedValue(earningsWithPeak(null));
});

describe('OptimierungSection (the customer module surface subpage)', () => {
  it('shows the active Marktoptimierung card with the Speicherschonung sub-line', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    render(<OptimierungSection site={site} />);

    expect(screen.getByText('Marktoptimierung')).toBeInTheDocument();
    // Dynamic Eigenverbrauch tariff: trades at the market, USES the energy.
    expect(
      screen.getByText('Ihr Speicher handelt am Strommarkt: günstig laden, teuer nutzen.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Umgang mit dem Speicher: Ausgewogen (empfohlen)'),
    ).toBeInTheDocument();
  });

  it('renders Lastspitzenkappung as the calm offer when no Leistungspreis is configured - no button', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    render(<OptimierungSection site={site} />);

    expect(screen.getByText('Lastspitzenkappung')).toBeInTheDocument();
    expect(screen.getByText('Verfügbar')).toBeInTheDocument();
    expect(screen.getByText(/mehrere tausend Euro Leistungspreis im Jahr/)).toBeInTheDocument();
    expect(
      screen.getByText('Einrichtung durch VoltPilot – sprechen Sie uns an.'),
    ).toBeInTheDocument();
    // Decision 2: info text ONLY - no CTA button, no mailto link.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/anfragen/i)).not.toBeInTheDocument();
  });

  it('renders the active state with the configured value when the SiteDto field is present', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    render(<OptimierungSection site={{ ...site, leistungspreisEurKw: 120 }} />);

    expect(screen.getByText('Von VoltPilot für Sie eingerichtet.')).toBeInTheDocument();
    expect(screen.getByText(/Leistungspreis: 120,00/)).toBeInTheDocument();
    expect(screen.queryByText('Verfügbar')).not.toBeInTheDocument();
  });

  it('shows the PS-4 proof rows on the active card once the earnings carry the block', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'earnings').mockResolvedValue(
      earningsWithPeak({
        leistungspreisEurKw: 120,
        abrechnung: 'monat',
        periodStart: '2026-07-01',
        peakKw: 62.4,
        baselinePeakKw: 74.4,
        avoidedKw: 12,
        avoidedEur: 1440,
        history: [],
      }),
    );
    render(<OptimierungSection site={{ ...site, leistungspreisEurKw: 120 }} />);

    expect(await screen.findByText('Gehaltene Spitze diese Periode')).toBeInTheDocument();
    expect(screen.getByText(/62,4/)).toBeInTheDocument();
    expect(screen.getByText('Vermiedene Spitze')).toBeInTheDocument();
    expect(screen.getByText(/12,0/)).toBeInTheDocument();
    expect(screen.getByText('Ersparte Leistungskosten')).toBeInTheDocument();
    expect(screen.getByText(/\+1\.440,00/)).toBeInTheDocument();
    // The counterfactual is one tap away (InfoTip on the avoided row).
    expect(screen.getByRole('button', { name: 'Vermiedene Spitze erklären' })).toBeInTheDocument();
  });

  it('says honestly when the running period has no measurements yet', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(api, 'earnings').mockResolvedValue(
      earningsWithPeak({
        leistungspreisEurKw: 120,
        abrechnung: 'jahr',
        periodStart: '2026-01-01',
        peakKw: null,
        baselinePeakKw: null,
        avoidedKw: null,
        avoidedEur: null,
        history: [],
      }),
    );
    render(<OptimierungSection site={{ ...site, leistungspreisEurKw: 120 }} />);

    expect(
      await screen.findByText('In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Gehaltene Spitze diese Periode')).not.toBeInTheDocument();
  });

  it('lists the automatic protections (§ 14a, Negativpreise)', () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    render(<OptimierungSection site={site} />);

    expect(screen.getByText('Automatisch aktiv')).toBeInTheDocument();
    expect(screen.getByText('§ 14a-Schutz:')).toBeInTheDocument();
    expect(screen.getByText('Negativpreis-Abregelung:')).toBeInTheDocument();
  });

  it('lets everyone change the Speicherschonung preset, carrying the battery data through', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([batteryAsset()]);
    const saveBattery = vi.spyOn(api, 'saveBattery').mockResolvedValue([]);
    render(<OptimierungSection site={site} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Umgang mit dem Speicher ändern' }));
    fireEvent.click(screen.getByRole('radio', { name: /Schonend/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(saveBattery).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({
          capacityKwh: 10,
          maxChargeKw: 5,
          maxDischargeKw: 5,
          deviceId: 'd-1',
          speicherschonung: 'schonend',
        }),
      ),
    );
  });

  it('hides the admin contract editor while the backend lacks the fields (defensive probe)', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const configCall = vi.spyOn(optimizerApi, 'configViaSwitcher').mockResolvedValue(config());
    render(<OptimierungSection site={site} isAdmin />);

    await waitFor(() => expect(configCall).toHaveBeenCalledWith('s-1'));
    expect(
      screen.queryByRole('button', { name: 'Für diese Anlage einrichten' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Leistungspreis/)).not.toBeInTheDocument();
  });

  it('offers the admin contract editor once the backend carries the fields, and PUTs full-representation', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    vi.spyOn(optimizerApi, 'configViaSwitcher').mockResolvedValue(
      config({ leistungspreisEurKw: null, backupReserveSocPct: 20 }),
    );
    const put = vi
      .spyOn(optimizerApi, 'updateConfigViaSwitcher')
      .mockResolvedValue(config({ leistungspreisEurKw: 120 }));
    render(<OptimierungSection site={site} isAdmin />);

    fireEvent.click(await screen.findByRole('button', { name: 'Für diese Anlage einrichten' }));
    fireEvent.change(screen.getByLabelText('Leistungspreis (€/kW) *'), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({
          leistungspreisEurKw: 120,
          leistungspreisAbrechnung: 'jahr',
          lastspitzenReserveKw: null,
          // The untouched overrides ride along (full-representation PUT).
          backupReserveSocPct: 20,
        }),
      ),
    );
    // The card flips to the managed active state from the PUT response.
    expect(await screen.findByText('Von VoltPilot für Sie eingerichtet.')).toBeInTheDocument();
  });

  it('a customer never triggers the admin config probe', async () => {
    vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
    const configCall = vi.spyOn(optimizerApi, 'configViaSwitcher');
    render(<OptimierungSection site={site} />);
    await waitFor(() => expect(api.siteAssets).toHaveBeenCalled());
    expect(configCall).not.toHaveBeenCalled();
  });
});
