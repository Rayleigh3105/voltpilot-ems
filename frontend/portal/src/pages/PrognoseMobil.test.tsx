import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForecastQuality } from '../api';

/**
 * Die Mobil-Fassung der Prognosequalität (Mobil-Umbau Stufe 4) auf
 * Render-Ebene. Die Ableitungen sind in `prognose.test.ts` erschoepfend
 * geprueft - hier geht es um die REIHENFOLGE (Verdikt zuerst), darum, dass die
 * Essays erreichbar BLEIBEN, und darum, dass der Rechner unberuehrt ist.
 */

vi.mock('../ForecastQualityChart', () => ({
  ForecastQualityChart: () => <div data-testid="prognose-chart" />,
}));

const forecastQualityMock = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: { ...actual.api, forecastQuality: (...a: unknown[]) => forecastQualityMock(...a) },
  };
});

const { PrognosePage } = await import('./PrognosePage');

const QUALITY: ForecastQuality = {
  activeLoadModel: 'load-persistence',
  activePvModel: 'pv-physical',
  models: [
    {
      model: 'load-xgb',
      kind: 'load',
      status: 'ready',
      active: false,
      daysCollected: null,
      daysRequired: null,
      trainedAt: null,
      trainRows: null,
      featureImportance: [],
      updatedAt: null,
    },
    {
      model: 'pv-residual-xgb',
      kind: 'pv',
      status: 'collecting',
      active: false,
      daysCollected: 14,
      daysRequired: 21,
      trainedAt: null,
      trainRows: null,
      featureImportance: [],
      updatedAt: null,
    },
  ],
  accuracy: [
    { day: '2026-08-09', model: 'load-persistence', kind: 'load', maeKw: 0.75, nmaePct: null, biasKw: null, skillVsBaseline: null, nSlots: 96 },
    { day: '2026-08-09', model: 'pv-physical', kind: 'pv', maeKw: 1.36, nmaePct: null, biasKw: null, skillVsBaseline: null, nSlots: 96 },
    { day: '2026-08-09', model: 'load-xgb', kind: 'load', maeKw: 0.5, nmaePct: null, biasKw: null, skillVsBaseline: 0.3, nSlots: 96 },
  ],
  planAccuracy: [],
};

const SITE = { id: 'site-1', name: 'Sonnenhof Weber' } as never;

function setzeBreite(phone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: phone && query.includes('720px'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function rendere() {
  return render(
    <PrognosePage sites={[SITE]} selectedSite="site-1" onSelectSite={() => {}} />,
  );
}

describe('Prognosequalität - Mobil-Fassung', () => {
  beforeEach(() => forecastQualityMock.mockResolvedValue(QUALITY));
  afterEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - die Stellvertreter-Breite wieder abraeumen
    delete window.matchMedia;
  });

  it('fuehrt am Telefon mit dem Verdikt: 2 Arten x Ø-Abweichung', async () => {
    setzeBreite(true);
    rendere();

    await screen.findByText('Wie gut Ihre Anlage vorhersagt');
    expect(screen.getByText(/±0,75\s?kW/)).toBeInTheDocument();
    expect(screen.getByText(/±1,36\s?kW/)).toBeInTheDocument();
    // Beide Arten beim Namen - die Rahmung haengt daran.
    expect(screen.getByText('Verbrauchsprognose (Last)')).toBeInTheDocument();
    expect(screen.getByText('PV-Prognose (Erzeugung)')).toBeInTheDocument();
  });

  it('das Verdikt steht VOR der ersten Kurve', async () => {
    setzeBreite(true);
    rendere();
    const verdikt = await screen.findByText('Wie gut Ihre Anlage vorhersagt');
    const chart = screen.getAllByTestId('prognose-chart')[0];
    expect(verdikt.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('macht aus dem Kandidaten-Status eine Zwei-Zeilen-Wahrheit mit dem Ehrlichkeits-Satz', async () => {
    setzeBreite(true);
    rendere();
    await screen.findByText('Wie gut Ihre Anlage vorhersagt');

    expect(screen.getByText('in 1 von 1 Bewertung genauer')).toBeInTheDocument();
    expect(screen.getByText('sammelt Daten · Tag 14/21')).toBeInTheDocument();
    expect(
      screen.getByText(/Kandidaten beeinflussen Ihre Steuerung nicht/),
    ).toBeInTheDocument();
    // Die ausfuehrliche Kandidaten-Karte des Rechners ist am Telefon weg.
    expect(screen.queryByText(/Zuletzt trainiert am/)).not.toBeInTheDocument();
  });

  it('haelt die Essays erreichbar - als Aufklapper, Inhalt unveraendert', async () => {
    setzeBreite(true);
    rendere();
    await screen.findByText('Wie gut Ihre Anlage vorhersagt');

    const wasSeheIch = screen.getByText('Was sehe ich hier?').closest('details');
    expect(wasSeheIch).not.toBeNull();
    expect(wasSeheIch?.textContent).toContain('zwei getrennte Prognosen');

    const schatten = screen.getByText('So funktioniert der Schattenbetrieb').closest('details');
    expect(schatten).not.toBeNull();
    // Der Aufklapper beschreibt seit dem Prognose-Schalter (18.08.2026) die
    // ENTSCHEIDUNG und ihre Folgen; der Mechanismus („beeinflusst nichts")
    // steht jetzt dort, wo die Kandidaten stehen - am Telefon in
    // KANDIDAT_EHRLICHKEIT, oben eigens geprüft.
    expect(schatten?.textContent).toContain('nie automatisch aktiv');
    expect(schatten?.textContent).toContain('Rückweg');

    // Die load-bearing Rahmung bleibt SICHTBAR, nicht im Aufklapper.
    const rahmung = screen.getByText(/2 Prognosearten/);
    expect(rahmung.closest('details')).toBeNull();
  });

  it('laesst den Rechner unberuehrt: Essay zuerst, volle Kandidaten-Karte, kein Aufklapper', async () => {
    setzeBreite(false);
    rendere();

    await screen.findByText('Aktive Modelle');
    // Der Einleitungs-Essay steht wie bisher offen ganz oben.
    const essay = screen.getByText('Was sehe ich hier?');
    expect(essay.closest('details')).toBeNull();
    expect(screen.getByText('Lernende Kandidaten')).toBeInTheDocument();
    expect(screen.getByText(/Noch nicht trainiert/)).toBeInTheDocument();
    // Die Mobil-Verdikt-Karte existiert dort NICHT.
    expect(screen.queryByText('Wie gut Ihre Anlage vorhersagt')).not.toBeInTheDocument();
  });
});
