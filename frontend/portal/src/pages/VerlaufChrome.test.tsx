import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PriceBucket, PriceHistory } from '../api';

/**
 * **Paket P1 · EIN Chrome für alle sechs Verlauf-Reiter** (Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §3.2 V1/V3, §7 Zeile P1).
 *
 * Geprüft wird der VERTRAG des Chromes, nicht das Aussehen einer Karte:
 *
 *  1. **V1** — kein sichtbarer Seitenkopf mehr über den Bereichs-Reitern; die
 *     Überschrift ist unsichtbar (`.vp-sr-only`), der Lead-Satz WÖRTLICH am Fuß.
 *  2. **V3** — die Zeit-Leiste ist DIESELBE Komponente wie auf Messwerten und
 *     Erlösen (`.vp-zeitleiste`), keine nachgebaute; ihr Zeitraum steht in der
 *     Adresse, und ein Lesezeichen OHNE Parameter bleibt gültig.
 *  3. **E4 b2** — sie klebt am Telefon und kollabiert beim Scrollen auf ihre
 *     erste Zeile (`data-kollabiert`).
 *
 * Die Karten-Rümpfe der Reiter gehören den Paketen P3–P7 und werden hier
 * bewusst nicht angefasst.
 */

vi.mock('../PriceHistoryChart', () => ({
  PriceHistoryChart: () => <div data-testid="preis-chart" />,
}));
vi.mock('../ForecastQualityChart', () => ({
  ForecastQualityChart: () => <div data-testid="pq-chart" />,
}));

const priceHistoryMock = vi.fn();
const scheduleMock = vi.fn();
const forecastQualityMock = vi.fn();
const forecastModelsMock = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      priceHistory: (...a: unknown[]) => priceHistoryMock(...a),
      schedule: (...a: unknown[]) => scheduleMock(...a),
      forecastQuality: (...a: unknown[]) => forecastQualityMock(...a),
      forecastModels: (...a: unknown[]) => forecastModelsMock(...a),
    },
  };
});

const { MarktpreisePage } = await import('./DataPages');
const { PrognosePage } = await import('./PrognosePage');

const SITE = { id: 'site-22', name: 'Hof Lindenberg', biddingZone: 'DE-LU' } as never;

function reihe(): PriceBucket[] {
  const start = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000 - 4 * 15 * 60_000;
  return Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(start + i * 15 * 60_000).toISOString(),
    avgEurMwh: 40 + i,
    minEurMwh: 40 + i,
    maxEurMwh: 40 + i,
  }));
}

function historie(): PriceHistory {
  const buckets = reihe();
  return {
    biddingZone: 'DE-LU',
    currency: 'EUR',
    bucket: 'PT15M',
    from: buckets[0].ts,
    to: buckets[buckets.length - 1].ts,
    buckets,
    summary: {
      avgEurMwh: 46,
      minEurMwh: 40,
      maxEurMwh: 51,
      cheapestTs: buckets[0].ts,
      mostExpensiveTs: buckets[11].ts,
      count: buckets.length,
      coverageStart: buckets[0].ts,
      coverageEnd: buckets[buckets.length - 1].ts,
    },
  };
}

/** Telefon- bzw. Rechner-Breite (dieselbe Grenze wie `useIsPhone`: 720 px). */
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

beforeEach(() => {
  priceHistoryMock.mockResolvedValue(historie());
  scheduleMock.mockResolvedValue({
    slots: [],
    slotMinutes: 15,
    generatedAt: null,
    deviceId: null,
  });
  forecastQualityMock.mockResolvedValue({
    activeLoadModel: 'load-persistence',
    activePvModel: 'pv-physical',
    models: [],
    accuracy: [],
    planAccuracy: [],
  });
  forecastModelsMock.mockRejectedValue(new Error('offline'));
  window.location.hash = '';
});

afterEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — die Stellvertreter-Breite wieder abräumen
  delete window.matchMedia;
});

describe('P1 · V1 — der Seitenkopf ist unsichtbar', () => {
  it('Marktpreise trägt eine sr-only-h1 und den früheren Lead-Satz am Fuß', async () => {
    setzeBreite(false);
    render(
      <MarktpreisePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await screen.findByTestId('preis-chart');

    const h1 = screen.getByRole('heading', { level: 1, name: 'Marktpreise' });
    expect(h1).toHaveClass('vp-sr-only');
    // Kein sichtbarer Kopf mehr - der war der Grund, warum die Reiterleiste sprang.
    expect(document.querySelector('.vp-page-head')).toBeNull();
    // Der Lead-Satz ist NICHT verloren, nur umgezogen (wörtlich).
    expect(
      screen.getByText('Was Strom an der Börse kostet - heute, morgen und im Rückblick.'),
    ).toBeInTheDocument();
  });

  it('Prognose trägt ihn nur als REITER — als eigene Seite bleibt der Kopf sichtbar', async () => {
    setzeBreite(false);
    const { unmount } = render(
      <PrognosePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await waitFor(() => expect(forecastQualityMock).toHaveBeenCalled());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Prognosequalität' }),
    ).toHaveClass('vp-sr-only');
    unmount();

    render(<PrognosePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} />);
    await waitFor(() => expect(forecastQualityMock).toHaveBeenCalled());
    expect(
      screen.getByRole('heading', { level: 1, name: 'Prognosequalität' }),
    ).not.toHaveClass('vp-sr-only');
  });
});

describe('P1 · V3 — EINE Zeit-Leiste, ihr Zeitraum in der Adresse', () => {
  it('Marktpreise baut die Leiste nicht mehr nach und schreibt z=/at= mit', async () => {
    setzeBreite(false);
    render(
      <MarktpreisePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await screen.findByTestId('preis-chart');

    // Die geteilte Leiste, nicht die alte `.vp-seg` in einem `vp-page-head`.
    expect(document.querySelector('.vp-zeitleiste')).not.toBeNull();
    expect(window.location.hash).toContain('/marktpreise?z=tag');

    fireEvent.click(screen.getByRole('tab', { name: 'Woche' }));
    await waitFor(() => expect(window.location.hash).toContain('z=woche'));
  });

  it('ein Lesezeichen OHNE Parameter bleibt gültig (Vorgabe Tag)', async () => {
    setzeBreite(false);
    window.location.hash = '#/anlage/site-22/marktpreise';
    render(
      <MarktpreisePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await screen.findByTestId('preis-chart');
    expect(screen.getByRole('tab', { name: 'Tag' })).toHaveAttribute('aria-selected', 'true');
  });

  it('ein Lesezeichen MIT z= öffnet genau diesen Zeitraum', async () => {
    setzeBreite(false);
    window.location.hash = '#/anlage/site-22/marktpreise?z=monat';
    render(
      <MarktpreisePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await screen.findByTestId('preis-chart');
    expect(screen.getByRole('tab', { name: 'Monat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('das Prognose-Fenster ist ein ECHTER Schalter: es setzt das Fenster des Abrufs', async () => {
    setzeBreite(false);
    render(
      <PrognosePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await waitFor(() => expect(forecastQualityMock).toHaveBeenCalledWith('site-22', 7));

    fireEvent.click(screen.getByRole('tab', { name: '30 Tage' }));
    await waitFor(() => expect(forecastQualityMock).toHaveBeenCalledWith('site-22', 30));
    expect(window.location.hash).toContain('z=monat');
  });
});

describe('P1 · E4 b2 — die Leiste klebt am Telefon und kollabiert beim Scrollen', () => {
  /** Ein steuerbarer `IntersectionObserver`: jsdom bringt keinen mit. */
  function stelleWaechter() {
    const rueckrufe: ((e: { isIntersecting: boolean; boundingClientRect: { top: number } }[]) => void)[] = [];
    class FakeIO {
      constructor(cb: (e: never[]) => void) {
        rueckrufe.push(cb as never);
      }
      observe() {}
      disconnect() {}
    }
    // @ts-expect-error — Stellvertreter für jsdom
    window.IntersectionObserver = FakeIO;
    // @ts-expect-error — dieselbe Referenz, `useScrolledPast` prüft `typeof`
    globalThis.IntersectionObserver = FakeIO;
    return {
      /** „Der Wächter ist nach OBEN aus dem Bild gescrollt" ⇒ die Leiste klebt. */
      scrolleNachUnten: () =>
        rueckrufe.forEach((cb) => cb([{ isIntersecting: false, boundingClientRect: { top: -12 } }])),
      scrolleZurueck: () =>
        rueckrufe.forEach((cb) => cb([{ isIntersecting: true, boundingClientRect: { top: 8 } }])),
    };
  }

  afterEach(() => {
    // @ts-expect-error — Stellvertreter abräumen
    delete window.IntersectionObserver;
    // @ts-expect-error — dito
    delete globalThis.IntersectionObserver;
  });

  it('kollabiert auf die erste Zeile und kommt beim Hochscrollen zurück', async () => {
    const waechter = stelleWaechter();
    setzeBreite(true);
    render(
      <MarktpreisePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await screen.findByTestId('preis-chart');

    const leiste = document.querySelector('.vp-zeitleiste-mobil') as HTMLElement;
    expect(leiste).not.toBeNull();
    // Der 1-px-Wächter steht IM Fluss über der Leiste - ohne ihn feuerte nichts.
    expect(document.querySelector('.vp-zl-wache')).not.toBeNull();
    // Oben angekommen: beide Zeilen.
    expect(leiste.getAttribute('data-kollabiert')).toBeNull();

    waechter.scrolleNachUnten();
    await waitFor(() =>
      expect(
        (document.querySelector('.vp-zeitleiste-mobil') as HTMLElement).getAttribute(
          'data-kollabiert',
        ),
      ).toBe('ja'),
    );
    // Die erste Zeile (das Segment) BLEIBT - sie ist der Zeitraum-Schalter.
    expect(document.querySelector('.vp-zl-row-1')).not.toBeNull();
    expect(document.querySelector('.vp-zl-row-2')).not.toBeNull();

    waechter.scrolleZurueck();
    await waitFor(() =>
      expect(
        (document.querySelector('.vp-zeitleiste-mobil') as HTMLElement).getAttribute(
          'data-kollabiert',
        ),
      ).toBeNull(),
    );
  });

  it('ohne Beobachter kollabiert NICHTS — statt dass etwas kollabiert, das niemand auslöste', async () => {
    setzeBreite(true);
    render(
      <MarktpreisePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await screen.findByTestId('preis-chart');
    expect(
      (document.querySelector('.vp-zeitleiste-mobil') as HTMLElement).getAttribute(
        'data-kollabiert',
      ),
    ).toBeNull();
  });

  it('am Rechner gibt es weder Wächter noch Kollaps — dort ist die Leiste EINE Zeile', async () => {
    stelleWaechter();
    setzeBreite(false);
    render(
      <MarktpreisePage sites={[SITE]} selectedSite="site-22" onSelectSite={() => {}} embedded />,
    );
    await screen.findByTestId('preis-chart');
    expect(document.querySelector('.vp-zeitleiste-mobil')).toBeNull();
    expect(document.querySelector('.vp-zl-wache')).toBeNull();
  });
});
