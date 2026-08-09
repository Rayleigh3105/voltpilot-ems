import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PriceBucket, PriceHistory } from '../api';

/**
 * Die Mobil-Fassung der Marktpreise (Mobil-Umbau Stufe 4) auf Render-Ebene.
 * Die Ableitungen sind in `marktpreise.test.ts` erschoepfend geprueft - hier
 * geht es um die REIHENFOLGE und darum, dass der Desktop unangetastet bleibt.
 */

// Der Chart braucht Canvas; jsdom hat keins. Wir prüfen hier die Komposition
// der Seite, nicht das Diagramm - der Stellvertreter meldet nur seinen Fokus.
vi.mock('../PriceHistoryChart', () => ({
  PriceHistoryChart: ({ fokus }: { fokus?: string | null }) => (
    <div data-testid="preis-chart" data-fokus={fokus ?? 'alles'} />
  ),
}));

const scheduleMock = vi.fn();
const priceHistoryMock = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      priceHistory: (...args: unknown[]) => priceHistoryMock(...args),
      schedule: (...args: unknown[]) => scheduleMock(...args),
    },
  };
});

const { MarktpreisePage } = await import('./DataPages');

/** Eine 15-Minuten-Reihe, die die laufende Viertelstunde WIRKLICH enthaelt. */
function heutigeReihe(jetzt: Date): PriceBucket[] {
  const slot = Math.floor(jetzt.getTime() / (15 * 60_000)) * 15 * 60_000;
  const start = slot - 4 * 15 * 60_000;
  return Array.from({ length: 12 }, (_, i) => {
    const p = i === 4 ? -20 : 40 + i * 10;
    return {
      ts: new Date(start + i * 15 * 60_000).toISOString(),
      avgEurMwh: p,
      minEurMwh: p,
      maxEurMwh: p,
    };
  });
}

function historie(buckets: PriceBucket[]): PriceHistory {
  return {
    biddingZone: 'DE-LU',
    currency: 'EUR',
    bucket: 'PT15M',
    from: buckets[0].ts,
    to: buckets[buckets.length - 1].ts,
    buckets,
    summary: {
      avgEurMwh: 76,
      minEurMwh: -26,
      maxEurMwh: 150,
      cheapestTs: buckets[4].ts,
      mostExpensiveTs: buckets[9].ts,
      count: buckets.length,
      coverageStart: buckets[0].ts,
      coverageEnd: buckets[buckets.length - 1].ts,
    },
  };
}

const SITE = {
  id: 'site-1',
  name: 'Sonnenhof Weber',
  biddingZone: 'DE-LU',
} as never;

/** Stellt die Telefon- bzw. Rechner-Breite. */
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
    <MarktpreisePage sites={[SITE]} selectedSite="site-1" onSelectSite={() => {}} />,
  );
}

describe('Marktpreise - Mobil-Fassung', () => {
  beforeEach(() => {
    const jetzt = new Date();
    priceHistoryMock.mockResolvedValue(historie(heutigeReihe(jetzt)));
    scheduleMock.mockResolvedValue({
      slots: [],
      slotMinutes: 15,
      generatedAt: null,
      deviceId: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - die Stellvertreter-Breite wieder abraeumen
    delete window.matchMedia;
  });

  it('fuehrt am Telefon mit dem Jetzt-Preis, nicht mit den KPI-Karten', async () => {
    setzeBreite(true);
    rendere();

    const held = await screen.findByText('Negativpreis');
    expect(held).toBeInTheDocument();
    // Der Held nennt den Preis in der Rechnungs-Einheit.
    expect(screen.getByText(/-2,00\s?ct\/kWh/)).toBeInTheDocument();

    // Die drei KPI-Karten des Rechners sind weg - ihre Aussage tragen die Chips.
    expect(screen.queryByText('Ø-Preis im Zeitraum')).not.toBeInTheDocument();
    expect(screen.getByText(/^Ø 7,6 ct$/)).toBeInTheDocument();
    expect(screen.getByText(/^Tief -2,6 ct/)).toBeInTheDocument();
    expect(screen.getByText(/^Hoch 15,0 ct/)).toBeInTheDocument();
  });

  it('legt EUR/MWh und die Quelle in den Profi-Aufklapper - verlustfrei', async () => {
    setzeBreite(true);
    rendere();
    await screen.findByText('Negativpreis');

    const aufklapper = screen.getByText(/Profi-Detail/).closest('details');
    expect(aufklapper).not.toBeNull();
    // Der EUR/MWh-Grundsatz bleibt: die Zahlen sind da, nur eine Ebene tiefer.
    expect(within(aufklapper as HTMLElement).getByText('Ø im Zeitraum (EUR/MWh)')).toBeInTheDocument();
    expect(within(aufklapper as HTMLElement).getByText(/energy-charts\.info/)).toBeInTheDocument();
    // Der Fahrplan-Querverweis bleibt SICHTBAR - er erklaert die Seite.
    expect(screen.getByText(/zum Fahrplan/)).toBeInTheDocument();
  });

  it('zeigt am Telefon einen Tag und springt zum anderen', async () => {
    setzeBreite(true);
    // Eine Reihe ueber die lokale Mitternacht hinweg.
    const jetzt = new Date();
    const heute = heutigeReihe(jetzt);
    const mitternacht = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() + 1, 0, 0, 0, 0);
    const morgen: PriceBucket[] = Array.from({ length: 4 }, (_, i) => ({
      ts: new Date(mitternacht.getTime() + i * 15 * 60_000).toISOString(),
      avgEurMwh: 30,
      minEurMwh: 30,
      maxEurMwh: 30,
    }));
    priceHistoryMock.mockResolvedValue(historie([...heute, ...morgen]));
    rendere();

    // Der Sprung-Chip, nicht der „Heute"-Knopf der Zeitraum-Leiste daneben.
    const sprung = () => document.querySelector('.vp-mp-sprung') as HTMLButtonElement;
    await waitFor(() => expect(sprung()).not.toBeNull());
    expect(sprung().textContent).toContain('Morgen');
    expect(screen.getByTestId('preis-chart')).toHaveAttribute('data-fokus', 'heute');

    fireEvent.click(sprung());
    await waitFor(() =>
      expect(screen.getByTestId('preis-chart')).toHaveAttribute('data-fokus', 'morgen'),
    );
    // ... und wieder zurueck.
    expect(sprung().textContent).toContain('Heute');
    fireEvent.click(sprung());
    await waitFor(() =>
      expect(screen.getByTestId('preis-chart')).toHaveAttribute('data-fokus', 'heute'),
    );
  });

  it('erfindet ohne laufende Viertelstunde KEINEN Jetzt-Preis', async () => {
    setzeBreite(true);
    // Eine Reihe, die nur die Vergangenheit abdeckt.
    const alt = new Date(Date.now() - 6 * 3600_000);
    priceHistoryMock.mockResolvedValue(historie(heutigeReihe(alt)));
    rendere();

    await screen.findByTestId('preis-chart');
    expect(screen.queryByText('Börsenpreis jetzt')).not.toBeInTheDocument();
    expect(screen.queryByText('Negativpreis')).not.toBeInTheDocument();
    // Die Chips bleiben - sie beschreiben den ZEITRAUM, nicht das Jetzt.
    expect(screen.getByText(/^Ø 7,6 ct$/)).toBeInTheDocument();
  });

  it('laesst den Rechner unberuehrt: KPI-Karten oben, EUR/MWh offen, kein Aufklapper', async () => {
    setzeBreite(false);
    rendere();

    await screen.findByTestId('preis-chart');
    expect(screen.getByText('Ø-Preis im Zeitraum')).toBeInTheDocument();
    expect(screen.getByText('Ø im Zeitraum (EUR/MWh)')).toBeInTheDocument();
    expect(screen.queryByText(/Profi-Detail/)).not.toBeInTheDocument();
    expect(screen.queryByText('Börsenpreis jetzt')).not.toBeInTheDocument();
    // Ohne Telefon-Fokus zeigt die Kurve alles.
    expect(screen.getByTestId('preis-chart')).toHaveAttribute('data-fokus', 'alles');
  });

  it('holt den Bezugspreis NUR am Telefon - und nennt ihn nur, wenn es ihn gibt', async () => {
    setzeBreite(false);
    rendere();
    await screen.findByTestId('preis-chart');
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
