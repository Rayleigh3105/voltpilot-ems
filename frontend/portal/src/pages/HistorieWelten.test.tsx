import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MesswerteSection } from './MesswerteSection';
import { ErloeseSection } from './ErloeseSection';
import { clearHistoryCache } from '../historyCache';
import { clearEarningsCache } from '../useSiteEarnings';
import { isoDate } from '../periodNav';
import { anlageSurface, type AnlageSurface } from '../surface';
import {
  api,
  type EntityHistory,
  type History,
  type Site,
  type SiteEarnings,
  type SiteEntities,
  type SiteTopology,
} from '../api';

// The explorer chart uses useEChart (canvas); jsdom has neither, so stub it.
vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));
vi.mock('../components/Tagesbild', () => ({
  Tagesbild: () => <div data-testid="day-chart" />,
}));
vi.mock('../HistoryChart', () => ({
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
  // F4: 1880/2000 Viertelstunden = 94 %, verteilt auf 6 Lücken. Die Zeitpunkte
  // stehen bewusst mittags, damit die Zeitzone des Testrechners das Datum nicht
  // über eine Tagesgrenze kippt.
  coverage: {
    firstDataAt: '2026-06-19T12:00:00Z',
    lastDataAt: '2026-07-30T11:45:00Z',
    expectedFrom: '2026-06-30T22:00:00Z',
    expectedTo: '2026-07-30T11:45:00Z',
    expectedBuckets: 2000,
    measuredBuckets: 1880,
    gaps: 6,
    resolutionMinutes: 15,
  },
};

/**
 * Die Geld-Antwort der Erlöse-Welt (F1): der anlagen-scharfe Endpunkt
 * `GET /sites/{id}/earnings`. Die Zahlen sind so gewählt, dass die Komposition
 * die große Zahl WIRKLICH ergibt (1.059,40 − 60,14 = 999,26).
 */
const moneyWithData: SiteEarnings = {
  siteId: 's-1',
  name: 'Testanlage',
  range: 'day',
  from: '2026-07-24T00:00:00Z',
  to: '2026-07-25T00:00:00Z',
  plantKind: 'direktvermarktung',
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  tarifPriced: false,
  anzulegenderWertCtKwh: null,
  coveredSlots: 96,
  firstCoveredDate: '2026-06-19',
  reason: null,
  einspeiseErloesEur: 1059.4,
  eigenverbrauchsWertEur: null,
  stromkostenEur: 60.14,
  nettoErgebnisEur: 999.26,
  savedEur: 161.44,
  arbitrageEur: null,
  pvShiftEur: null,
  baselineEur: 100,
  actualEur: -999.26,
  marktpraemieEur: null,
  bezugspreisCtKwh: 4.9,
  realizedExportCtKwh: 8.88,
  marketValueSolarCtKwh: 5.92,
  marketValueProvisional: true,
  bezogenKwh: 1227.3,
  eingespeistKwh: 9573.8,
  selbstverbrauchKwh: 97.3,
  batterieBewegtKwh: 4147.2,
  gesamtertragEur: null,
  expectedMarketValueSolarCtKwh: null,
  expectedMarketValueFrom: null,
  expectedMarketValueTo: null,
  expectedMarketValueSlots: null,
  series: [
    {
      start: '2026-07-24T10:00:00Z',
      einspeiseErloesEur: 30,
      eigenverbrauchsWertEur: null,
      stromkostenEur: 4,
      nettoEur: 26,
    },
  ],
  peakShaving: null,
};

/** Ein Zeitraum ohne eine einzige bewertete Viertelstunde. */
const moneyEmpty: SiteEarnings = {
  ...moneyWithData,
  coveredSlots: 0,
  reason: 'no_data',
  einspeiseErloesEur: null,
  eigenverbrauchsWertEur: null,
  stromkostenEur: null,
  nettoErgebnisEur: null,
  savedEur: null,
  baselineEur: null,
  actualEur: null,
  bezugspreisCtKwh: null,
  realizedExportCtKwh: null,
  marketValueSolarCtKwh: null,
  marketValueProvisional: null,
  bezogenKwh: null,
  eingespeistKwh: null,
  selbstverbrauchKwh: null,
  batterieBewegtKwh: null,
  series: [],
};

/** Die Geld-Welt braucht IHREN Endpunkt - die Historie trägt nur noch den Plan. */
function stubMoney(m: SiteEarnings = moneyWithData) {
  return vi.spyOn(api, 'siteEarnings').mockResolvedValue(m);
}

beforeEach(() => {
  window.location.hash = '';
  clearHistoryCache();
  clearEarningsCache();
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
  it('führt mit dem GEMESSENEN Ergebnis und macht es nachrechenbar (F1)', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    stubMoney();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    // Die eine große Zahl - Vorzeichen als eigenes Zeichen.
    expect(await screen.findByText('+ 999,26 €')).toBeInTheDocument();
    // ... und die Zeilen, aus denen sie entsteht.
    const komposition = screen.getByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(komposition).toHaveTextContent('Einspeise-Erlös');
    expect(komposition).toHaveTextContent('1.059,40 €');
    expect(komposition).toHaveTextContent('Stromkosten (Netzbezug)');
    expect(komposition).toHaveTextContent('60,14 €');
    // Die Zurechnung der Steuerung ist eine UNTERZEILE, kein weiterer Summand.
    expect(screen.getByText(/durch VoltPilots Steuerung/)).toHaveTextContent('161,44');
    expect(komposition).not.toHaveTextContent('161,44');
  });

  // Diagnose vp-tagesbild-minus-f3: die gemessene Kasse kennt eingelagerte
  // Energie nur als entgangenen Erlös. Ohne den zweiten Posten stand über
  // einem einwandfreien Plan „−4,69 €".
  it('stellt das BESTANDSKONTO neben die Kasse - und nie in die grosse Zahl', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    stubMoney({
      ...moneyWithData,
      savedEur: -4.69,
      speicherDeltaKwh: 44.2,
      speicherWertCtKwh: 18.9,
      speicherWertEur: 8.3538,
      speicherWertBasis: 'plan',
    });
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    const satz = await screen.findByText(/44,2 kWh/);
    expect(satz).toHaveTextContent('in den Folgetag gespeichert');
    expect(satz).toHaveTextContent('+8,35 €');
    // Der Betrag ist nach dem PLAN bewertet und sagt das selbst.
    expect(satz.closest('p')).toHaveTextContent('Geplant');
    // Die grosse Zahl bleibt die gemessene Kasse.
    expect(screen.getByText('+ 999,26 €')).toBeInTheDocument();
    const komposition = screen.getByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(komposition).not.toHaveTextContent('8,35');
  });

  it('bleibt ohne die Bestandsfelder zeichengleich zu vorher', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    stubMoney();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(screen.queryByText(/im Speicher/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Folgetag gespeichert/)).not.toBeInTheDocument();
  });

  it('zeigt Geld im Verlauf und die Preise dahinter - für JEDEN Zeitraum', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    stubMoney({ ...moneyWithData, range: 'month' });
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    expect(screen.getByRole('heading', { level: 2, name: /Geld im Verlauf/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Was den Preis gemacht hat' })).toBeInTheDocument();
    expect(screen.getByText('Ø Bezugspreis')).toBeInTheDocument();
    expect(screen.getByText('4,9 ct/kWh')).toBeInTheDocument();
    // Die drei EXPORT-Zeilen leben seit dem Kombinations-Bild eine Karte höher
    // (Absorption, Konzept D2) - dieselbe Wahrheit steht nie zweimal auf einer
    // Seite. Die Einordnung trägt dort der Verdikt-Chip.
    expect(screen.queryByText('8,9 ct/kWh')).not.toBeInTheDocument();
    expect(screen.queryByText('3,0 ct über dem Monatsdurchschnitt')).not.toBeInTheDocument();
    expect(screen.getByText('+ 3,0 ct über dem Monatsdurchschnitt')).toBeInTheDocument();
  });

  // Der reale Kundenfall vom 05.08.2026: „+ 0,00 € · Marktprämie" ohne ein Wort
  // dazu. Die Zustände selbst sind in `marktpraemie.test.ts` festgenagelt.
  it('erklärt die Marktprämie-Null - statt sie nackt stehen zu lassen', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    stubMoney({
      ...moneyWithData,
      marktpraemieEur: 0,
      anzulegenderWertCtKwh: 6.9,
      marketValueSolarCtKwh: 7.0,
      marketValueProvisional: true,
    });
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(screen.getByText(/Ihre Vergütung kommt diesen Monat voll aus dem Markt/)).toBeInTheDocument();
    expect(screen.getByText(/die Prämie kann sich noch ändern/)).toBeInTheDocument();
    // Der Monat ist die Abrechnungseinheit und steht in der Überschrift; die
    // Tagesansicht sagt zusätzlich, dass die Zahl eine Zurechnung ist.
    expect(screen.getByText('Marktprämie · Juli 2026')).toBeInTheDocument();
    expect(screen.getByText('anteilig — abgerechnet je Monat')).toBeInTheDocument();
  });

  it('zeigt ohne anzulegenden Wert „—" MIT Weg - nie eine erfundene Null', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    stubMoney();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(screen.getByText(/Kein anzulegender Wert hinterlegt/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zu den Einstellungen' })).toHaveAttribute(
      'href',
      '#/anlage/s-1/technik?abschnitt=geld',
    );
  });

  it('trennt die BEWERTETE Zahl von der GEPLANTEN — je Karte ein Abzeichen', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    stubMoney();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(screen.getByRole('heading', { level: 2, name: /Geplante Speicher-Ersparnis/ })).toBeInTheDocument();
    // Beide Abzeichen existieren - und zwar an verschiedenen Karten.
    expect(screen.getAllByText('Bewertet').length).toBeGreaterThan(0);
    expect(screen.getByText('Geplant')).toBeInTheDocument();
    // Die geplante Zahl kommt weiterhin aus der Historie-Antwort.
    expect(screen.getByText('0,42 €')).toBeInTheDocument();
    // Der Tages-Nachweis + das Tagesprotokoll bleiben hier.
    expect(screen.getByTestId('day-chart')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Tagesprotokoll' })).toBeInTheDocument();
    // Die Energiemengen führen NICHT in der Geld-Welt.
    expect(screen.queryByLabelText('Energiemengen im Zeitraum')).toBeNull();
  });

  it('sagt in der Fußkarte, dass sie bewertet und nicht abgerechnet ist', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    stubMoney(moneyEmpty);
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    expect(screen.getByText(/Bewertet, nicht abgerechnet/)).toBeInTheDocument();
    // Ein leerer Zeitraum nennt seinen Grund, statt eine Null zu zeigen.
    await screen.findByText('Noch kein Ergebnis für diesen Zeitraum');
    expect(screen.getByText(/noch keine Messwerte/)).toBeInTheDocument();
    expect(screen.queryByText('0,00 €')).toBeNull();
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
    stubMoney();
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
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(hist.mock.calls.length).toBe(nachErstemAufbau);

    // Und zurück - ebenfalls ohne Abruf.
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findAllByLabelText('Energiemengen im Zeitraum');
    expect(hist.mock.calls.length).toBe(nachErstemAufbau);
  });

  it('zeigt beim Blättern die alte Periode gedimmt statt eines Skeletts (P5)', async () => {
    // Seit F3 läuft ein ZWEITER Abruf (die Vorperiode) über denselben Endpunkt,
    // deshalb wird hier nach ANKER unterschieden statt nach Aufrufreihenfolge.
    const heute = isoDate(new Date());
    const offen: ((h: History) => void)[] = [];
    vi.spyOn(api, 'history').mockImplementation((_s, _r, at) =>
      at === heute
        ? Promise.resolve(historyWithData)
        : new Promise<History>((r) => offen.push(r)),
    );

    const { container } = render(
      <MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />,
    );
    await screen.findByLabelText('Energiemengen im Zeitraum');
    expect(container.querySelector('.vp-welt-stale')).toBeNull();

    fireEvent.click(screen.getByLabelText('Vorheriger Zeitraum'));
    // Die Zahlen der vorherigen Periode stehen noch da, nur gedimmt.
    await waitFor(() => expect(container.querySelector('.vp-welt-stale')).toBeTruthy());
    expect(screen.getByLabelText('Energiemengen im Zeitraum')).toBeInTheDocument();

    offen.forEach((r) => r(historyEmpty));
    await waitFor(() => expect(container.querySelector('.vp-welt-stale')).toBeNull());
  });

  it('sagt es, wenn eine Periode NICHT geladen werden konnte (P5) - statt still stehenzubleiben', async () => {
    const heute = isoDate(new Date());
    vi.spyOn(api, 'history').mockImplementation((_s, _r, at) =>
      at === heute ? Promise.resolve(historyWithData) : Promise.reject(new Error('kaputt')),
    );

    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');
    fireEvent.click(screen.getByLabelText('Vorheriger Zeitraum'));

    await screen.findByText(/konnte nicht geladen werden/);
    // Die zuletzt geladenen Zahlen bleiben stehen - nur eben beschriftet.
    expect(screen.getByLabelText('Energiemengen im Zeitraum')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });
});

/**
 * PR D · F2 — der Zeitraum-Sprung. Vorher gab es GENAU EINE Geste in die
 * Vergangenheit (‹, ein Zeitraum pro Klick): 211 Klicks vom 30.07. in einen
 * Januar-Tag.
 */
describe('F2 · In der Vergangenheit navigieren', () => {
  it('bietet neben dem Schrittknopf ein Sprungfeld - begrenzt auf die echte Datenlage', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    const { container } = render(
      <MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />,
    );
    await screen.findByLabelText('Energiemengen im Zeitraum');

    const feld = screen.getByLabelText('Tag wählen') as HTMLInputElement;
    expect(feld.type).toBe('date');
    expect(feld.value).toBe(isoDate(new Date()));
    // Nie in die Zukunft, nie vor die erste gemessene Viertelstunde.
    expect(feld.max).toBe(isoDate(new Date()));
    expect(feld.min).toBe('2026-06-19');

    // EIN Sprung, kein Klick-Marathon.
    fireEvent.change(feld, { target: { value: '2026-01-15' } });
    await waitFor(() =>
      expect(container.querySelector('.vp-period-nav .label')).toHaveTextContent('15.01.2026'),
    );
  });

  it('wechselt mit dem Zeitraum auch die Art des Sprungfelds', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');

    fireEvent.click(screen.getByRole('tab', { name: 'Monat' }));
    expect((screen.getByLabelText('Monat wählen') as HTMLInputElement).type).toBe('month');
    fireEvent.click(screen.getByRole('tab', { name: 'Woche' }));
    expect((screen.getByLabelText('Woche wählen') as HTMLInputElement).type).toBe('week');
    // Für das Jahr gibt es kein natives Feld - also eine Auswahlliste.
    fireEvent.click(screen.getByRole('tab', { name: 'Jahr' }));
    expect(screen.getByLabelText('Jahr wählen').tagName).toBe('SELECT');
  });

  it('trägt den Monatsstreifen der Geld-Ansicht - hier als Navigator OHNE erfundene Zahlen', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    const { container } = render(
      <MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />,
    );
    await screen.findByLabelText('Energiemengen im Zeitraum');

    const streifen = screen.getByRole('tablist', { name: 'Monat anspringen' });
    const chips = within(streifen).getAllByRole('tab');
    expect(chips).toHaveLength(12);
    // Kein Chip behauptet einen Wert (die Historie kennt keine Monatswerte).
    expect(streifen.querySelector('.mv')).toBeNull();
    // Monate vor der ersten Messung sind nicht anspringbar.
    expect(chips.some((c) => (c as HTMLButtonElement).disabled)).toBe(true);

    fireEvent.click(within(streifen).getAllByRole('tab', { name: /Jul/ })[0]);
    await waitFor(() =>
      expect(container.querySelector('.vp-period-nav .label')?.textContent).toContain('2026'),
    );
  });

  it('zeigt den Streifen nur dort, wo Blättern wirklich weh tut', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');
    expect(screen.getByRole('tablist', { name: 'Monat anspringen' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Jahr' }));
    expect(screen.queryByRole('tablist', { name: 'Monat anspringen' })).toBeNull();
  });
});

/**
 * PR D · F4 — die Datenlage. Vorher war eine Lücke von einer gemessenen Null
 * nicht unterscheidbar, und ein „Jahr" durfte sechs Wochen zeigen, ohne es zu
 * sagen.
 */
describe('F4 · Datenabdeckung in der Zeit-Leiste', () => {
  it('sagt ab wann es Daten gibt, wie viel gemessen ist und wie viele Lücken', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(historyWithData);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');

    expect(screen.getByText('Daten ab 19.06.2026')).toBeInTheDocument();
    expect(screen.getByText('94 % der Viertelstunden gemessen')).toBeInTheDocument();
    expect(screen.getByText('· 6 Lücken')).toBeInTheDocument();
  });

  it('behauptet ohne Abdeckungsdaten GAR KEINE - auch in der Geld-Welt', async () => {
    const ohne: History = { ...historyWithData, coverage: null };
    vi.spyOn(api, 'history').mockResolvedValue(ohne);
    stubMoney();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(screen.queryByText(/Daten ab/)).toBeNull();
    expect(screen.queryByText(/gemessen$/)).toBeNull();
  });
});

/**
 * PR D · F3 — Δ zur Vorperiode: die billigste Form von „nachschauen".
 */
describe('F3 · Vergleich mit der Vorperiode', () => {
  /** Eine Antwort mit frei gesetzten Summen (die Buckets tragen die Wahrheit). */
  function tag(pv: number, bezug: number | null): History {
    return {
      ...historyWithData,
      buckets: [
        {
          ...historyWithData.buckets[0],
          pvKwh: pv,
          gridImportKwh: bezug,
          batteryChargeKwh: null,
          batteryDischargeKwh: null,
        },
      ],
    };
  }

  it('zeigt je Kennzahl das Δ und wertet nur, wo die Richtung eindeutig ist', async () => {
    const heute = isoDate(new Date());
    vi.spyOn(api, 'history').mockImplementation((_s, _r, at) =>
      Promise.resolve(at === heute ? tag(118, 91) : tag(100, 100)),
    );
    const { container } = render(
      <MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />,
    );
    await screen.findByLabelText('Energiemengen im Zeitraum');

    // +18 % Erzeugung ist eindeutig gut, −9 % Netzbezug ebenfalls.
    await screen.findByText('18 % mehr als am Vortag');
    expect(screen.getByText('9 % weniger als am Vortag')).toBeInTheDocument();
    expect(container.querySelectorAll('.vp-delta-gut').length).toBe(2);
    // Die Karte nennt, womit verglichen wird.
    expect(screen.getByText(/^Vergleich: /)).toBeInTheDocument();
  });

  it('vergleicht NIE gegen eine erfundene Null', async () => {
    const heute = isoDate(new Date());
    // Die Vorperiode trug den Netzbezug gar nicht.
    vi.spyOn(api, 'history').mockImplementation((_s, _r, at) =>
      Promise.resolve(at === heute ? tag(118, 91) : tag(100, null)),
    );
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByText('18 % mehr als am Vortag');
    expect(screen.queryByText(/als am Vortag/)).not.toBeNull();
    // Kein Δ auf der Bezogen-Kachel - lieber keine Aussage als eine falsche.
    expect(screen.queryByText(/% weniger als am Vortag/)).toBeNull();
  });

  it('beschriftet eine LAUFENDE Periode als solche', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(tag(118, 91));
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Energiemengen im Zeitraum');
    // Der laufende Tag gegen einen vollen Vortag - das muss dastehen.
    await waitFor(() =>
      expect(screen.getByText(/läuft noch — verglichen wird mit dem vollständigen/))
        .toBeInTheDocument(),
    );
  });

  it('holt die Vorperiode gar nicht erst, wenn der Zeitraum leer ist', async () => {
    const hist = vi.spyOn(api, 'history').mockResolvedValue(historyEmpty);
    render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByText('Keine Messwerte in diesem Zeitraum');
    // Nur der EINE Abruf der gezeigten Periode (im StrictMode-freien Test).
    const anker = new Set(hist.mock.calls.map((c) => c[2]));
    expect(anker.size).toBe(1);
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
    stubMoney(moneyEmpty);
    render(<ErloeseSection site={site} surface={PRIVAT} onOpenWelt={() => {}} />);
    expect(screen.getByRole('link', { name: /Messwerte/ })).toBeInTheDocument();
    await screen.findByText('Noch kein Ergebnis für diesen Zeitraum');
  });
});
