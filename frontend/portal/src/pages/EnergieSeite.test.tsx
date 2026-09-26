import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MesswerteSection } from './MesswerteSection';
import { EinzelwerteSection } from './EinzelwerteSection';
import { clearHistoryCache } from '../historyCache';
import { api, type History, type Site } from '../api';

/**
 * **Verlauf › Energie** und **Verlauf › Messwerte** (Konzept „Verlauf-Rework",
 * Paket P3) als ganze Flächen. Die Ableitungen prüft `energieSeite.test.ts`.
 */

vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));
vi.mock('../components/VerlaufExplorer', () => ({
  VerlaufExplorer: (p: { initialTargets: unknown[] }) => (
    <div data-testid="explorer" data-ziele={p.initialTargets.length} />
  ),
}));
vi.mock('../components/GesamtwertKarten', () => ({ GesamtwertKarten: () => <div data-testid="summenwerte" /> }));
vi.mock('../components/SiteMeasurementComparison', () => ({
  SiteMeasurementComparison: () => <div data-testid="weitere" />,
}));

const site: Site = {
  id: 's-1',
  name: 'Testanlage',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'fest',
  tarifParamCtKwh: 30,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

const leer: History = {
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
    tarifArt: 'fest',
    batterySavingsPlannedEur: null,
    autarkiePct: null,
    eigenverbrauchPct: null,
  },
  protocol: [],
  plan: [],
  coverage: {
    firstDataAt: '2026-06-19T12:00:00Z',
    lastDataAt: '2026-07-30T11:45:00Z',
    expectedFrom: '2026-07-30T22:00:00Z',
    expectedTo: '2026-07-31T22:00:00Z',
    expectedBuckets: 96,
    measuredBuckets: 0,
    gaps: 1,
    resolutionMinutes: 15,
  },
};

beforeEach(() => {
  window.location.hash = '#/anlage/s-1/messwerte';
  clearHistoryCache();
  vi.restoreAllMocks();
});

describe('Energie', () => {
  it('nennt sich „Energie" und trägt die Stromkosten nicht', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(leer);
    render(<MesswerteSection site={site} />);
    expect(screen.getByRole('heading', { level: 1, name: /Energie/ })).toBeInTheDocument();
    await screen.findByText('Keine Messwerte in diesem Zeitraum');
    expect(screen.queryByText(/Stromkosten/)).toBeNull();
  });

  it('führt aus dem Leerzustand zum letzten Tag mit Daten — und holt keine Vorperiode', async () => {
    const hist = vi.spyOn(api, 'history').mockResolvedValue(leer);
    render(<MesswerteSection site={site} />);
    await screen.findByText('Keine Messwerte in diesem Zeitraum');
    expect(new Set(hist.mock.calls.map((c) => c[2])).size).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /Zum letzten Tag mit Daten/ }));
    expect(window.location.hash).toBe('#/anlage/s-1/messwerte?z=tag&at=2026-07-30');
  });

  it('sagt, wenn die Historie nicht geladen werden konnte', async () => {
    vi.spyOn(api, 'history').mockRejectedValue(new Error('kaputt'));
    render(<MesswerteSection site={site} />);
    expect(await screen.findByText(/Die Historie konnte nicht geladen werden/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });
});

describe('Messwerte (einzelne Werte)', () => {
  it('zeigt Auswahl, Summenwerte und weitere Messwerte unter derselben Zeitleiste', () => {
    window.location.hash = '#/anlage/s-1/einzelwerte';
    render(<EinzelwerteSection site={site} />);
    expect(screen.getByRole('heading', { level: 1, name: /Messwerte/ })).toBeInTheDocument();
    expect(screen.getByTestId('explorer')).toBeInTheDocument();
    const summen = screen.getByRole('region', { name: 'Summenwerte' });
    expect(within(summen).getByTestId('summenwerte')).toBeInTheDocument();
    expect(screen.getByTestId('weitere')).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Zeitraum' })).toBeInTheDocument();
  });

  it('übernimmt die Messwerte eines Lesezeichens', () => {
    window.location.hash = '#/anlage/s-1/einzelwerte?m=batt:soc_pct&m=grid:power_kw&z=woche';
    render(<EinzelwerteSection site={site} />);
    expect(screen.getByTestId('explorer')).toHaveAttribute('data-ziele', '2');
  });
});
