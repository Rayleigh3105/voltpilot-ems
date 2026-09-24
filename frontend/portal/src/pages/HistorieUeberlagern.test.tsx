import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MesswerteSection } from './MesswerteSection';
import { ErloeseSection } from './ErloeseSection';
import { clearHistoryCache } from '../historyCache';
import { clearEarningsCache } from '../useSiteEarnings';
import { anlageSurface, type AnlageSurface } from '../surface';
import { api, type History, type Site, type SiteEarnings } from '../api';

/**
 * **F8 · zwei Zeiträume überlagern** — die Verdrahtung beider Welten.
 *
 * Die reinen Regeln (welcher Anker, welche Wahl, welche Beschriftung, welche
 * Ehrlichkeit) stehen in `historieVergleich.test.ts`/`historieZeit.test.ts`;
 * hier wird geprüft, dass die Seiten sie WIRKLICH lesen: dass die Überlagerung
 * am Diagramm ankommt, dass der zweite Abruf über den bestehenden Cache läuft
 * (Cache-Treffer = 0 Abrufe), dass der Zustand in der Adresse reist und dass
 * eine datenlose Vergleichsperiode GESAGT statt gezeichnet wird.
 */

vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));

/** Das Diagramm wird durch eine Attrappe ersetzt, die ihre Prop-Werte zeigt. */
vi.mock('../HistoryChart', () => ({
  HistoryEnergieChart: (p: {
    vergleich?: History | null;
    legende?: { satz: string } | null;
  }) => {
    return (
      <div data-testid="energie-chart" data-vergleich={p.vergleich ? 'ja' : 'nein'}>
        {p.legende?.satz ?? ''}
      </div>
    );
  },
}));

vi.mock('../components/erloese/ErloeseChart', () => ({
  ErloeseChart: (p: { d: { vergleichNetto: (number | null)[] | null }; vergleichName: string | null }) => (
    <div
      data-testid="geld-chart"
      data-vergleich={p.d.vergleichNetto?.some((v) => v != null) ? 'ja' : 'nein'}
    >
      {p.vergleichName ?? ''}
    </div>
  ),
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

const MARKT: AnlageSurface = anlageSurface({
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
  ],
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
});

function bucket(start: string) {
  return {
    start,
    pvKwh: 2.5,
    loadKwh: 1,
    gridImportKwh: 0.5,
    gridExportKwh: 1,
    batteryChargeKwh: 1,
    batteryDischargeKwh: 0.5,
    socMinPct: 70,
    socMaxPct: 76,
    socLastPct: 76,
    priceEurMwh: 80,
    costEur: 0.04,
  };
}

/** Eine Anlage, die seit 2024 misst — so steht das Vorjahr zur Wahl. */
const coverage = {
  firstDataAt: '2024-01-05T12:00:00Z',
  lastDataAt: '2026-07-30T11:45:00Z',
  expectedFrom: '2026-07-01T00:00:00Z',
  expectedTo: '2026-07-30T11:45:00Z',
  expectedBuckets: 2000,
  measuredBuckets: 1880,
  gaps: 6,
  resolutionMinutes: 15,
};

function history(over: Partial<History> = {}): History {
  return {
    range: 'month',
    from: '',
    to: '',
    bucketMinutes: 1440,
    buckets: [bucket('2026-07-01T00:00:00Z'), bucket('2026-07-02T00:00:00Z')],
    totals: {
      consumptionKwh: 2,
      pvGenerationKwh: 5,
      gridImportKwh: 1,
      gridExportKwh: 2,
      gridCostEur: 0.08,
      tarifArt: 'ohne',
      batterySavingsPlannedEur: 0.42,
      autarkiePct: 60,
      eigenverbrauchPct: 40,
    },
    protocol: [],
    plan: [],
    coverage,
    ...over,
  };
}

const money: SiteEarnings = {
  siteId: 's-1',
  name: 'Testanlage',
  range: 'month',
  from: '2026-07-01T00:00:00Z',
  to: '2026-08-01T00:00:00Z',
  plantKind: 'direktvermarktung',
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  tarifPriced: false,
  anzulegenderWertCtKwh: null,
  coveredSlots: 96,
  firstCoveredDate: '2024-01-05',
  reason: null,
  einspeiseErloesEur: 100,
  eigenverbrauchsWertEur: null,
  stromkostenEur: 40,
  nettoErgebnisEur: 60,
  savedEur: 12,
  arbitrageEur: null,
  pvShiftEur: null,
  baselineEur: 10,
  actualEur: -60,
  marktpraemieEur: null,
  bezugspreisCtKwh: 4.9,
  realizedExportCtKwh: 8.88,
  marketValueSolarCtKwh: 5.92,
  marketValueProvisional: true,
  bezogenKwh: 100,
  eingespeistKwh: 500,
  selbstverbrauchKwh: 50,
  batterieBewegtKwh: 200,
  gesamtertragEur: null,
  expectedMarketValueSolarCtKwh: null,
  expectedMarketValueFrom: null,
  expectedMarketValueTo: null,
  expectedMarketValueSlots: null,
  series: [
    {
      start: '2026-07-01T00:00:00Z',
      einspeiseErloesEur: 30,
      eigenverbrauchsWertEur: null,
      stromkostenEur: 4,
      nettoEur: 26,
    },
  ],
  peakShaving: null,
};

/** Der Anker, mit dem ein Abruf lief (`at`) — daran hängt der ganze Vergleich. */
function ankerDerAbrufe(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => String(c[2] ?? c[3] ?? ''));
}

beforeEach(() => {
  window.location.hash = '#/anlage/s-1/messwerte?z=monat&at=2026-07-15';
  clearHistoryCache();
  clearEarningsCache();
  vi.restoreAllMocks();
});

/**
 * ⚠ Seit E3 (`vp-erloese-lesbar-konzept-u3` §3.5) liegt „Vergleichen" HINTER
 * dem Datum-Feld der Zeit-Leiste — die Leiste klebt und trägt deshalb nur
 * noch, was man ständig braucht. Jeder Zugriff auf den Umschalter geht also
 * durch den ⋯-Knopf; der gesetzte Vergleich bleibt daneben als Chip sichtbar.
 */
async function oeffneVergleich() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Monat, Vergleich & Datenlage' }),
  );
}

describe('F8 · der „Vergleichen"-Umschalter der Zeit-Leiste', () => {
  it('steht standardmäßig auf „Aus" und überlagert dann NICHTS', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history());
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    const gruppe = await screen.findByRole('group', { name: 'Vergleichen' });
    expect(gruppe).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aus' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() =>
      expect(screen.getByTestId('energie-chart')).toHaveAttribute('data-vergleich', 'nein'),
    );
  });

  it('bietet beim Monat die Vorperiode UND das Vorjahr an, beim Tag nur die Vorperiode', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history());
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    await screen.findByRole('group', { name: 'Vergleichen' });
    expect(screen.getByRole('button', { name: 'Juni 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Juli 2025' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Tag' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Juli 2025' })).toBeNull());
  });

  it('legt auf Klick die Vorperiode über das Diagramm und benennt beide Zeiträume', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history());
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    fireEvent.click(await screen.findByRole('button', { name: 'Juni 2026' }));
    const chart = await screen.findByTestId('energie-chart');
    await waitFor(() => expect(chart).toHaveAttribute('data-vergleich', 'ja'));
    expect(chart).toHaveTextContent('Durchgezogen: Juli 2026 · blass gestrichelt: Juni 2026');
  });

  it('holt beim Vorjahr WIRKLICH den verschobenen Anker — und Δ-Kopf wie Überlagerung nennen ihn', async () => {
    const spy = vi.spyOn(api, 'history').mockResolvedValue(history());
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    fireEvent.click(await screen.findByRole('button', { name: 'Juli 2025' }));
    await waitFor(() => expect(ankerDerAbrufe(spy)).toContain('2025-07-01'));
    // Eine Quelle: derselbe Zeitraum steht im Karten-Kopf, im Zustands-Chip
    // der Zeit-Leiste (E3) und in der Legende.
    await waitFor(() => expect(screen.getAllByText('Vergleich: Juli 2025').length)
      .toBeGreaterThan(0));
    expect(screen.getByTestId('energie-chart')).toHaveTextContent('blass gestrichelt: Juli 2025');
  });

  it('kostet KEINEN zusätzlichen Abruf, wenn die Vergleichsperiode schon im Cache liegt', async () => {
    const spy = vi.spyOn(api, 'history').mockResolvedValue(history());
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    // „Aus" holt die Vorperiode bereits für das Δ (F3) - der zweite Abruf ist
    // technisch derselbe. Einschalten darf ihn deshalb nicht wiederholen.
    await waitFor(() => expect(ankerDerAbrufe(spy)).toContain('2026-06-01'));
    const vorher = spy.mock.calls.length;
    await oeffneVergleich();
    fireEvent.click(screen.getByRole('button', { name: 'Juni 2026' }));
    await waitFor(() =>
      expect(screen.getByTestId('energie-chart')).toHaveAttribute('data-vergleich', 'ja'),
    );
    expect(spy.mock.calls.length).toBe(vorher);
  });

  it('SAGT eine datenlose Vergleichsperiode, statt eine leere Reihe zu zeichnen', async () => {
    vi.spyOn(api, 'history').mockImplementation(async (_id, _r, at) =>
      at === '2025-07-01' ? history({ buckets: [] }) : history(),
    );
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    fireEvent.click(await screen.findByRole('button', { name: 'Juli 2025' }));
    await waitFor(() =>
      expect(
        screen.getByText('Keine Daten für Juli 2025 — es gibt nichts zu überlagern.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('energie-chart')).toHaveAttribute('data-vergleich', 'nein');
  });
});

describe('F8 · der Zustand reist in der Adresse und über den Welt-Wechsel', () => {
  it('schreibt die Wahl in den Hash und nimmt sie in die andere Welt mit', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history());
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    fireEvent.click(await screen.findByRole('button', { name: 'Juli 2025' }));
    await waitFor(() => expect(window.location.hash).toContain('v=vorjahr'));
    expect(window.location.hash).toContain('z=monat');

    // E3: der Welt-Wechsel wohnt in den Bereichs-Reitern, die Fläche trägt
    // keinen eigenen Link mehr. Der Zustand steht in der ADRESSE — genau die
    // reicht `AnlageSeite.oeffneReiter` beim Wechsel weiter.
    expect(screen.queryByRole('link', { name: /Erlöse/ })).toBeNull();
    expect(window.location.hash).toMatch(/^#\/anlage\/s-1\/messwerte\?/);
  });

  it('nimmt einen mitgebrachten Vergleich aus dem Lesezeichen an', async () => {
    window.location.hash = '#/anlage/s-1/messwerte?z=monat&at=2026-07-15&v=vorjahr';
    vi.spyOn(api, 'history').mockResolvedValue(history());
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    expect(await screen.findByRole('button', { name: 'Juli 2025' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('lässt ein „Vorjahr" aus dem Lesezeichen auf einem Tages-Zeitraum zurückfallen', async () => {
    window.location.hash = '#/anlage/s-1/messwerte?z=tag&at=2026-07-15&v=vorjahr';
    vi.spyOn(api, 'history').mockResolvedValue(history({ range: 'day' }));
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    const gruppe = await screen.findByRole('group', { name: 'Vergleichen' });
    expect(gruppe).not.toHaveTextContent('2025');
    // Zurückgefallen auf die Vorperiode - überlagert wird trotzdem.
    await waitFor(() =>
      expect(screen.getByTestId('energie-chart')).toHaveAttribute('data-vergleich', 'ja'),
    );
  });
});

describe('F8 · dieselbe Geste in der Erlöse-Welt', () => {
  beforeEach(() => {
    window.location.hash = '#/anlage/s-1/erloese?z=monat&at=2026-07-15';
  });

  it('überlagert den Geld-Verlauf mit derselben Wahl', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history());
    // Die Vergleichsperiode trägt IHRE Tage — überlagert wird nach Position im
    // Zeitraum (1. Juni neben 1. Juli), nie ein Datum auf ein fremdes gelegt.
    vi.spyOn(api, 'siteEarnings').mockImplementation(async (_id, _r, at) =>
      at === '2026-06-01'
        ? {
            ...money,
            from: '2026-06-01T00:00:00Z',
            to: '2026-07-01T00:00:00Z',
            series: money.series.map((b) => ({ ...b, start: b.start.replace('2026-07-', '2026-06-') })),
          }
        : money,
    );
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    fireEvent.click(await screen.findByRole('button', { name: 'Juni 2026' }));
    const chart = await screen.findByTestId('geld-chart');
    await waitFor(() => expect(chart).toHaveAttribute('data-vergleich', 'ja'));
    expect(chart).toHaveTextContent('Juni 2026');
    // Die Legende nennt die überlagerte Reihe beim Namen.
    expect(screen.getByText('Ergebnis Juni 2026')).toBeInTheDocument();
  });

  it('sagt auch hier eine Vergleichsperiode ohne bewertete Viertelstunden', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history());
    vi.spyOn(api, 'siteEarnings').mockImplementation(async (_id, _r, at) =>
      at === '2026-06-01' ? { ...money, series: [], coveredSlots: 0, reason: 'no_data' } : money,
    );
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await oeffneVergleich();
    fireEvent.click(await screen.findByRole('button', { name: 'Juni 2026' }));
    await waitFor(() =>
      expect(
        screen.getByText('Keine Daten für Juni 2026 — es gibt nichts zu überlagern.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('geld-chart')).toHaveAttribute('data-vergleich', 'nein');
  });
});
