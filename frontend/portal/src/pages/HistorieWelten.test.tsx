import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MesswerteSection } from './MesswerteSection';
import { ErloeseSection } from './ErloeseSection';
import { clearHistoryCache } from '../historyCache';
import { anlageSurface, type AnlageSurface } from '../surface';
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
  HistoryEnergieChart: () => <div data-testid="energie-chart" />,
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

/** Eine Anlage MIT Geld-Modus - nur dann gibt es die Erlöse-Welt. */
const MARKT: AnlageSurface = anlageSurface({
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
  ],
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
});

/** Eine Privat-Anlage ohne Geld-Modus. */
const PRIVAT: AnlageSurface = anlageSurface({
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
  ],
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest' },
});

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
      capabilities: {
        measure: [{ channel: 'soc_pct', unit: '%' }, { channel: 'pv_power_kw', unit: 'kW' }],
      },
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
    tarifArt: 'ohne',
    batterySavingsPlannedEur: null,
    autarkiePct: null,
    eigenverbrauchPct: null,
  },
  protocol: [],
  plan: [],
};

/** A day with real buckets: two 15-min slots incl. battery charge/discharge. */
const historyWithData: History = {
  range: 'day',
  from: '',
  to: '',
  bucketMinutes: 15,
  buckets: [
    {
      start: '2026-07-24T10:00:00Z',
      pvKwh: 2.5,
      loadKwh: 0.5,
      gridImportKwh: 0,
      gridExportKwh: 1.5,
      batteryChargeKwh: 2,
      batteryDischargeKwh: 0,
      socMinPct: 70,
      socMaxPct: 76,
      socLastPct: 76,
      priceEurMwh: 80,
      costEur: 0,
    },
    {
      start: '2026-07-24T10:15:00Z',
      pvKwh: 0,
      loadKwh: 0.75,
      gridImportKwh: 0.5,
      gridExportKwh: 0,
      batteryChargeKwh: 1,
      batteryDischargeKwh: 3,
      socMinPct: 68,
      socMaxPct: 74,
      socLastPct: 74,
      priceEurMwh: 120,
      costEur: 0.06,
    },
  ],
  totals: {
    consumptionKwh: 1.25,
    pvGenerationKwh: 2.5,
    gridImportKwh: 0.5,
    gridExportKwh: 1.5,
    gridCostEur: 0.06,
    tarifArt: 'ohne',
    batterySavingsPlannedEur: 0.42,
    autarkiePct: 60,
    eigenverbrauchPct: 40,
  },
  protocol: [
    {
      type: 'batterie-laden',
      start: '2026-07-24T10:00:00Z',
      end: '2026-07-24T10:15:00Z',
      text: 'Speicher geladen.',
      energyKwh: 2,
      avgPriceEurMwh: 80,
      avoidedCostEur: null,
      peakKw: null,
    },
  ],
  plan: [],
};

beforeEach(() => {
  window.location.hash = '';
  clearHistoryCache();
  vi.restoreAllMocks();
});

/**
 * Die Historie ist ZWEI WELTEN (Konzept `data/vp-historie-konzept-t4`,
 * Captain-Struktur H1): zwei Routen, ein Skelett, ein Ehrlichkeits-Abzeichen je
 * Karte - und der frühere dritte Umschalter ist ersatzlos weg.
 */
describe('Welt A · Messwerte', () => {
  it('führt mit ihrem Welt-Kopf statt mit drei gestapelten Umschaltern', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    // Der Welt-Kopf beantwortet „wo bin ich?" - Titel + Abzeichen.
    expect(screen.getByRole('heading', { level: 1, name: /Messwerte/ })).toBeInTheDocument();
    // Die früheren Umschalter „Energie | Erlöse" und „Übersicht | Messwerte"
    // existieren nicht mehr.
    expect(screen.queryByRole('tab', { name: 'Energie' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Übersicht' })).toBeNull();
    // Übrig bleiben genau ZWEI Bedienzeilen: Welt-Kartenpaar + Zeit-Leiste.
    expect(screen.getByRole('group', { name: 'Ansicht wechseln' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Zeitraum' })).toBeInTheDocument();
    await screen.findByLabelText('Energiemengen im Zeitraum');
  });

  it('zeigt die sechs Energiemengen des Zeitraums, mit dem Abzeichen „Gemessen"', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    const row = await screen.findByLabelText('Energiemengen im Zeitraum');
    for (const label of ['Erzeugt', 'Verbraucht', 'Bezogen', 'Eingespeist', 'Geladen', 'Entladen']) {
      expect(row).toHaveTextContent(label);
    }
    // Laden/entladen kommen NICHT aus totals - sie werden über die Buckets
    // gebildet (2,0 + 1,0 kWh geladen, 0 + 3,0 kWh entladen).
    expect(row).toHaveTextContent('3 kWh');
    expect(screen.getByRole('heading', { level: 2, name: /Energie im Zeitraum · / })).toBeInTheDocument();
    expect(screen.getByTestId('energie-chart')).toBeInTheDocument();
    // Jede Karte dieser Welt trägt „Gemessen" - und keine „Bewertet".
    expect(screen.getAllByText('Gemessen').length).toBeGreaterThan(1);
    expect(screen.queryByText('Bewertet')).toBeNull();
  });

  it('trägt die STROMKOSTEN nicht mehr — eine bewertete Zahl in einer gemessenen Karte', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');
    expect(screen.queryByText(/Stromkosten/)).toBeNull();
    expect(screen.queryByText(/zu Börsenpreisen/)).toBeNull();
    // Autarkie/Eigenverbrauch (gemessene Quoten) bleiben.
    expect(screen.getByText('Autarkie')).toBeInTheDocument();
  });

  it('nennt beim VERGANGENEN Zeitraum ausdrücklich sein Etikett', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');
    fireEvent.click(screen.getByLabelText('Vorheriger Zeitraum'));
    await waitFor(() => expect(screen.getByText(/nicht für heute/)).toBeInTheDocument());
  });

  it('schließt die Fußkarte „Was diese Zahlen sind" an', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    expect(screen.getByText('Was diese Zahlen sind')).toBeInTheDocument();
    expect(screen.getByText(/für eine Abrechnung/)).toBeInTheDocument();
    await screen.findByText('Keine Messwerte in diesem Zeitraum');
  });
});

describe('Der Explorer ist ein Abschnitt DIESER Welt (der dritte Umschalter entfällt)', () => {
  it('ist zugeklappt und öffnet auf Klick die Messwert-Auswahl', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
    vi.spyOn(api, 'topology').mockResolvedValue(topology);
    const eh = vi.spyOn(api, 'entityHistory').mockResolvedValue(entityHistory(true));

    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    const toggle = screen.getByRole('button', { name: /Einzelne Messwerte vergleichen/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Batteriespeicher')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Die Leiste gruppiert nach Komponente, mit deutschen Messwert-Namen.
    await screen.findByText('Batteriespeicher');
    expect(screen.getByText('Netzanschluss')).toBeInTheDocument();
    expect(screen.getAllByText('Ladestand').length).toBeGreaterThan(0);
    await waitFor(() => expect(eh).toHaveBeenCalledWith('s-1', 'batt', 'day', expect.any(String)));
  });

  it('öffnet ein Deep-Link (?m=…) direkt aufgeklappt - alte Lesezeichen bleiben gültig', async () => {
    window.location.hash = '#/anlage/s-1/messwerte?m=grid:power_kw&z=woche';
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    vi.spyOn(api, 'siteEntities').mockResolvedValue(entities);
    vi.spyOn(api, 'topology').mockResolvedValue(topology);
    const eh = vi.spyOn(api, 'entityHistory').mockResolvedValue({
      ...entityHistory(true),
      range: 'week',
    });

    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    expect(screen.getByRole('button', { name: /Einzelne Messwerte vergleichen/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Woche' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(eh).toHaveBeenCalledWith('s-1', 'grid', 'week', expect.any(String)));
  });
});

describe('Welt B · Erlöse', () => {
  it('trennt die BEWERTETE Zahl von der GEPLANTEN — je Karte ein Abzeichen', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await screen.findByLabelText('Geld im Zeitraum');
    expect(screen.getByText(/Stromkosten \(Netzbezug\)/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Geplante Speicher-Ersparnis/ })).toBeInTheDocument();
    // Beide Abzeichen existieren - und zwar an verschiedenen Karten.
    expect(screen.getAllByText('Bewertet').length).toBeGreaterThan(0);
    expect(screen.getByText('Geplant')).toBeInTheDocument();
    // Der Tages-Nachweis + das Tagesprotokoll bleiben hier.
    expect(screen.getByTestId('day-chart')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Tagesprotokoll' })).toBeInTheDocument();
    // Die Energiemengen führen NICHT in der Geld-Welt.
    expect(screen.queryByLabelText('Energiemengen im Zeitraum')).toBeNull();
  });

  it('sagt in der Fußkarte, dass sie bewertet und nicht abgerechnet ist', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    expect(screen.getByText(/Bewertet, nicht abgerechnet/)).toBeInTheDocument();
    await screen.findByText('Keine Daten in diesem Zeitraum');
  });
});

describe('Der Welt-Wechsel: ein Klick, der Zeitraum reist mit, KEIN neuer Abruf', () => {
  it('führt in die andere Welt und trägt Zeitraum + Anker im Link', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    const opened: string[] = [];
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={(w) => opened.push(w)} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');

    fireEvent.click(screen.getByRole('tab', { name: 'Monat' }));
    const link = screen.getByRole('link', { name: /Erlöse/ });
    await waitFor(() =>
      expect(link.getAttribute('href')).toMatch(
        /^#\/anlage\/s-1\/erloese\?z=monat&at=\d{4}-\d{2}-\d{2}$/,
      ),
    );
    fireEvent.click(link);
    expect(opened).toEqual(['erloese']);
  });

  it('holt beim Wechsel NICHT dieselbe Antwort erneut (P2)', async () => {
    const hist = vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    const mess = render(
      <MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />,
    );
    await screen.findByLabelText('Energiemengen im Zeitraum');
    const nachErstemAufbau = hist.mock.calls.length;
    expect(nachErstemAufbau).toBeGreaterThan(0);

    // Der Welt-Wechsel montiert die andere Fläche - vorher war das ein zweiter,
    // identischer Abruf derselben Periode.
    mess.unmount();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Geld im Zeitraum');
    expect(hist.mock.calls.length).toBe(nachErstemAufbau);

    // Und zurück - ebenfalls ohne Abruf.
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findAllByLabelText('Energiemengen im Zeitraum');
    expect(hist.mock.calls.length).toBe(nachErstemAufbau);
  });

  it('zeigt beim Blättern die alte Periode gedimmt statt eines Skeletts (P5)', async () => {
    let resolve: ((h: History) => void) | null = null;
    vi.spyOn(api, 'history')
      .mockResolvedValueOnce(historyWithData)
      .mockImplementationOnce(() => new Promise<History>((r) => (resolve = r)));

    const { container } = render(
      <MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />,
    );
    await screen.findByLabelText('Energiemengen im Zeitraum');
    expect(container.querySelector('.vp-welt-stale')).toBeNull();

    fireEvent.click(screen.getByLabelText('Vorheriger Zeitraum'));
    // Die Zahlen der vorherigen Periode stehen noch da, nur gedimmt.
    await waitFor(() => expect(container.querySelector('.vp-welt-stale')).toBeTruthy());
    expect(screen.getByLabelText('Energiemengen im Zeitraum')).toBeInTheDocument();

    resolve?.(historyEmpty);
    await waitFor(() => expect(container.querySelector('.vp-welt-stale')).toBeNull());
  });
});

describe('Die Erlöse-Welt folgt dem Lese-Modell, ist aber nie eine Sackgasse', () => {
  it('bietet auf einer Privat-Anlage KEIN Kartenpaar (es gibt nur eine Welt)', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    render(<MesswerteSection site={site} surface={PRIVAT} onOpenWelt={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Ansicht wechseln' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Erlöse/ })).toBeNull();
    await screen.findByText('Keine Messwerte in diesem Zeitraum');
  });

  it('führt aus einer per Lesezeichen geöffneten Erlöse-Welt immer zurück', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    render(<ErloeseSection site={site} surface={PRIVAT} onOpenWelt={() => {}} />);
    expect(screen.getByRole('link', { name: /Messwerte/ })).toBeInTheDocument();
    await screen.findByText('Keine Daten in diesem Zeitraum');
  });
});
