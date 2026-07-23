import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HistorieSection } from './HistorieSection';
import {
  api,
  type EntityHistory,
  type History,
  type Site,
  type SiteEntities,
  type SiteTopology,
} from '../api';

// The explorer chart uses useEChart (canvas); jsdom has neither, so stub it.
vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));
vi.mock('../HistoryChart', () => ({
  HistoryDayChart: () => <div data-testid="day-chart" />,
  HistoryEnergyChart: () => <div data-testid="energy-chart" />,
}));

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

const entities: SiteEntities = {
  registry: null,
  entities: [
    {
      id: 'batt',
      entityType: 'battery-hybrid',
      typeLabel: 'Speicher',
      role: 'battery-hybrid',
      label: 'Batteriespeicher',
      control: true,
      deviceId: 'gw',
      capabilities: { measure: [{ channel: 'soc_pct', unit: '%' }, { channel: 'pv_power_kw', unit: 'kW' }] },
      guards: null,
      syncStatus: 'in_sync',
      observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
      edgeSourceId: null,
    },
    {
      id: 'grid',
      entityType: 'grid-meter',
      typeLabel: 'Netz',
      role: 'grid-meter',
      label: 'Netzanschluss',
      control: false,
      deviceId: 'gw',
      capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
      guards: null,
      syncStatus: 'in_sync',
      observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
      edgeSourceId: null,
    },
  ],
  localSetup: [
    { id: 'inv', kind: 'inverter', role: null, brand: 'deye', label: 'SUN-12K', reportedAt: '', adoptedEntityId: null },
  ],
  staleOnDevice: [],
};

const topology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', typeLabel: 'Speicher', label: 'Batteriespeicher', category: 'storage', health: 'ok', capabilities: [] },
    { id: 'grid', entityType: 'grid-meter', typeLabel: 'Netz', label: 'Netzanschluss', category: 'meter', health: 'ok', capabilities: [] },
  ],
  topology: { schema_version: '1.0', nodes: [] },
};

function entityHistory(withData: boolean): EntityHistory {
  return {
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    channels: {
      soc_pct: withData
        ? [{ start: '2026-05-01T10:00:00Z', avg: 80, min: 80, max: 80, last: 80, n: 1 }]
        : [{ start: '2026-05-01T10:00:00Z', avg: null, min: null, max: null, last: null, n: 0 }],
      pv_power_kw: [{ start: '2026-05-01T10:00:00Z', avg: 3.2, min: 3.2, max: 3.2, last: 3.2, n: 1 }],
      power_kw: [{ start: '2026-05-01T10:00:00Z', avg: -1.1, min: -1.1, max: -1.1, last: -1.1, n: 1 }],
    },
  };
}

const historyEmpty: History = {
  range: 'day',
  from: '',
  to: '',
  bucketMinutes: 15,
  buckets: [],
  totals: {
    consumptionKwh: 0,
    pvGenerationKwh: 0,
    gridImportKwh: 0,
    gridExportKwh: 0,
    gridCostEur: null,
    batterySavingsEur: null,
    autarkiePct: null,
    eigenverbrauchPct: null,
  },
  protocol: [],
  plan: [],
};

beforeEach(() => {
  window.location.hash = '';
  vi.restoreAllMocks();
});

describe('HistorieSection', () => {
  it('defaults to the Bilanz face (Geld führt, Q1)', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    render(<HistorieSection site={site} />);
    expect(screen.getByRole('tab', { name: 'Bilanz & Erlöse' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Messwerte' })).toHaveAttribute('aria-selected', 'false');
    await screen.findByText('Keine Daten in diesem Zeitraum');
  });

  it('opens the explorer, lists measurements grouped by Komponente and shows a chart', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
    vi.spyOn(api, 'topology').mockResolvedValue(topology);
    const eh = vi.spyOn(api, 'entityHistory').mockResolvedValue(entityHistory(true));

    render(<HistorieSection site={site} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Messwerte' }));

    // The rail groups by Komponente, with German measurement names.
    await screen.findByText('Batteriespeicher');
    expect(screen.getByText('Netzanschluss')).toBeInTheDocument();
    expect(screen.getAllByText('Ladestand').length).toBeGreaterThan(0);
    expect(screen.getByText('PV-Leistung')).toBeInTheDocument();

    // The first measurement (Ladestand) is fetched + charted with stats.
    await waitFor(() => expect(eh).toHaveBeenCalledWith('s-1', 'batt', 'day', expect.any(String)));
    await screen.findByLabelText('Kennzahlen im Zeitraum');
    expect(screen.getByText('Durchschnitt')).toBeInTheDocument();
  });

  it('a deep link (?m=…) opens the explorer pre-focused on that measurement', async () => {
    window.location.hash = '#/anlage/s-1/historie?m=grid:power_kw&z=woche';
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
    vi.spyOn(api, 'topology').mockResolvedValue(topology);
    const eh = vi.spyOn(api, 'entityHistory').mockResolvedValue({
      ...entityHistory(true),
      range: 'week',
    });

    render(<HistorieSection site={site} />);
    // Messwerte tab is active, range is Woche, and the grid channel is fetched.
    expect(screen.getByRole('tab', { name: 'Messwerte' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Woche' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(eh).toHaveBeenCalledWith('s-1', 'grid', 'week', expect.any(String)));
  });

  it('shows an honest empty state when the selected measurement has no values', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
    vi.spyOn(api, 'topology').mockResolvedValue(topology);
    vi.spyOn(api, 'entityHistory').mockResolvedValue(entityHistory(false));

    render(<HistorieSection site={site} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Messwerte' }));
    await screen.findByText('Keine Werte in diesem Zeitraum');
  });

  it('falls back to the site-level measurements for an entity-less site', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    vi.spyOn(api, 'siteEntities').mockResolvedValue({
      registry: null,
      entities: [],
      localSetup: [],
      staleOnDevice: [],
    });
    vi.spyOn(api, 'topology').mockResolvedValue({
      schemaVersion: '1.0',
      entities: [],
      topology: { schema_version: '1.0', nodes: [] },
    });

    render(<HistorieSection site={site} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Messwerte' }));
    // The v1 site-level measurements appear (PV-Leistung / Hausverbrauch / Netz / Ladestand).
    await screen.findByText('PV-Leistung');
    expect(screen.getByText('Hausverbrauch')).toBeInTheDocument();
    // The v1 fallback reads the shared History endpoint, not entityHistory.
    expect(screen.getByText(/Netz \(Bezug/)).toBeInTheDocument();
  });
});
