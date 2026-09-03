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

/**
 * ⚠ Die Uhr steht FEST auf 12:00 Ortszeit. Ohne sie hinge jeder Fall an der
 * Laufzeit: eine Reihe „ab jetzt minus eine Stunde" überquert kurz vor
 * Mitternacht die Tagesgrenze, und der Sonderzustand „morgen gibt es noch
 * nicht" wäre dann zufällig sein Gegenteil. Nur `Date` wird gefälscht —
 * `setTimeout` bleibt echt, damit `waitFor` arbeitet.
 */
const UHR = new Date(2026, 8, 3, 12, 0, 0);

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

/** Ein ganzer lokaler Tag in Viertelstunden — mit benennbaren Preisfenstern. */
function tagesReihe(tag: Date): PriceBucket[] {
  const mitternacht = new Date(tag.getFullYear(), tag.getMonth(), tag.getDate(), 0, 0, 0, 0);
  return Array.from({ length: 96 }, (_, i) => {
    // 11:45-15:15 unter Null (Solarspitze), 18:15-20:30 teuer, sonst mittel.
    const p = i >= 47 && i <= 61 ? -20 : i >= 73 && i <= 82 ? 180 : 60;
    return {
      ts: new Date(mitternacht.getTime() + i * 15 * 60_000).toISOString(),
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

describe('Marktpreise — der Reiter in den C-Bausteinen (P4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(UHR);
    priceHistoryMock.mockResolvedValue(historie(heutigeReihe(new Date())));
    scheduleMock.mockResolvedValue({
      slots: [],
      slotMinutes: 15,
      generatedAt: null,
      deviceId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // @ts-expect-error - die Stellvertreter-Breite wieder abraeumen
    delete window.matchMedia;
  });

  /**
   * **E8** (Captain 03.09.2026, wörtlich: „a) Statement auf Marktpreise,
   * Lastspitzen, Wetter"). Bis P4 gab es die Zahl nur am Telefon; am Rechner
   * standen drei `KpiCard` mit den ZEITRAUM-Zahlen — also genau nicht die
   * Antwort auf „was kostet Strom gerade?".
   */
  it.each([
    ['am Telefon', true],
    ['am Rechner', false],
  ])('führt %s mit dem Statement, nicht mit KPI-Karten', async (_name, phone) => {
    setzeBreite(phone as boolean);
    rendere();

    // Der Ton lebt im WORT (Chip), nicht in der Farbe der Zahl.
    const chip = await screen.findByText('unter Null');
    expect(chip).toHaveClass('vp-chip');
    const zahl = document.querySelector('.vp-c-stm-zahl');
    expect(zahl?.textContent).toMatch(/-2,00\s?ct\/kWh/);
    expect(screen.getByText(/Börsenpreis jetzt/)).toBeInTheDocument();

    // Die drei KPI-Karten und die drei Chips sind BEIDE weg — ihre Aussage
    // tragen jetzt die Ledger-Zeilen (V5).
    expect(document.querySelector('.vp-kpis')).toBeNull();
    expect(document.querySelector('.vp-mp-chip')).toBeNull();
    const zeilen = document.querySelector('[aria-label="Preis-Kennzahlen des Tages"]');
    expect(zeilen).not.toBeNull();
    const namen = [...zeilen!.querySelectorAll('.vp-c-led-name')].map((n) => n.textContent);
    expect(namen).toEqual(['Günstigste Zeit', 'Teuerste Zeit', 'Ø im Zeitraum']);
  });

  /**
   * **E6** (Captain 03.09.2026, wörtlich: „a) am Telefon immer Liste (V7), ab
   * 700 px Tabelle"). Der EUR/MWh-Grundsatz der Seite bleibt: die Zahlen sind
   * da, nur eine Ebene tiefer — und auf JEDER Breite im selben Aufklapper.
   */
  it('legt EUR/MWh in den Aufklapper — am Telefon als LISTE, nie als Tabelle', async () => {
    setzeBreite(true);
    rendere();
    await screen.findByText('unter Null');

    const aufklapper = screen.getByText(/Profi-Detail/).closest('details');
    expect(aufklapper).not.toBeNull();
    const body = aufklapper as HTMLElement;
    expect(within(body).getByText('Ø im Zeitraum')).toBeInTheDocument();
    expect(within(body).getByText(/^76,00\s?EUR\/MWh$/)).toBeInTheDocument();
    expect(within(body).getByText(/energy-charts\.info/)).toBeInTheDocument();
    // E6: unter 721 px trägt der ganze Reiter KEINE Tabelle.
    expect(document.querySelector('table')).toBeNull();
    expect(body.querySelector('.vp-c-led')).not.toBeNull();
  });

  it('macht ab 721 px eine echte Tabelle aus denselben Zahlen', async () => {
    setzeBreite(false);
    rendere();
    await screen.findByText('unter Null');

    const tab = document.querySelector('table.vp-mp-tab');
    expect(tab).not.toBeNull();
    expect(within(tab as HTMLElement).getByText(/^76,00\s?EUR\/MWh$/)).toBeInTheDocument();
    // Der Aufklapper ist derselbe — nur sein Inhalt wechselt die Form.
    expect(tab!.closest('details')).not.toBeNull();
  });

  it('zeigt am Telefon einen Tag und schaltet im SEGMENT zum anderen', async () => {
    setzeBreite(true);
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

    const knopf = async (name: string) => {
      const seg = document.querySelector('.vp-mp-tagseg') as HTMLElement;
      return within(seg).getByText(name);
    };
    await waitFor(() => expect(document.querySelector('.vp-mp-tagseg')).not.toBeNull());
    expect(await knopf('Heute')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('preis-chart')).toHaveAttribute('data-fokus', 'heute');

    fireEvent.click(await knopf('Morgen'));
    await waitFor(() =>
      expect(screen.getByTestId('preis-chart')).toHaveAttribute('data-fokus', 'morgen'),
    );
    expect(await knopf('Morgen')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(await knopf('Heute'));
    await waitFor(() =>
      expect(screen.getByTestId('preis-chart')).toHaveAttribute('data-fokus', 'heute'),
    );
  });

  /**
   * §4.3 Sonderzustand: vor ~12:45 hat die Börse den Folgetag noch nicht
   * veröffentlicht. Bis P4 verschwand die Zeile dann ersatzlos.
   */
  it('nennt den GRUND, wenn es morgen noch nicht gibt', async () => {
    setzeBreite(true);
    rendere();
    await screen.findByText('unter Null');

    const seg = document.querySelector('.vp-mp-tagseg') as HTMLElement;
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Heute']);
    expect(screen.getByText('Morgen ab ca. 13 Uhr')).toHaveClass('vp-chip');
  });

  it('erfindet ohne laufende Viertelstunde KEINEN Jetzt-Preis', async () => {
    setzeBreite(true);
    // Eine Reihe, die nur die Vergangenheit abdeckt.
    const alt = new Date(Date.now() - 6 * 3600_000);
    priceHistoryMock.mockResolvedValue(historie(heutigeReihe(alt)));
    rendere();

    await screen.findByTestId('preis-chart');
    expect(document.querySelector('.vp-c-stm-zahl')).toBeNull();
    expect(screen.queryByText(/Börsenpreis jetzt/)).not.toBeInTheDocument();
    expect(screen.queryByText('unter Null')).not.toBeInTheDocument();
    // Die Kennzahlen bleiben - sie beschreiben den ZEITRAUM, nicht das Jetzt.
    const zeilen = document.querySelector('[aria-label="Preis-Kennzahlen des Tages"]');
    expect(within(zeilen as HTMLElement).getByText('Ø im Zeitraum')).toBeInTheDocument();
  });

  /**
   * ⚠ **Bewusste Änderung gegenüber dem Mobil-Umbau:** der Bezugspreis reiste
   * bis P4 nur am Telefon, weil nur dort ein Held stand. Mit E8 steht das
   * Statement auf JEDER Breite, also braucht auch der Rechner die eine Zahl,
   * die es einordnet. Der Zeitraum-Zaun bleibt: im Rückblick gibt es kein
   * „jetzt", das ein Bezugspreis erklären könnte.
   */
  it('holt den Bezugspreis auf jeder Breite — aber nur am TAG', async () => {
    setzeBreite(false);
    rendere();
    await screen.findByTestId('preis-chart');
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledTimes(1));
  });

  it('behält den Weg zum Fahrplan — als 48-px-Zeile, nicht als Satzfragment', async () => {
    setzeBreite(true);
    rendere();
    await screen.findByText('unter Null');
    const weg = document.querySelector('a.vp-mp-weg') as HTMLAnchorElement;
    expect(weg).not.toBeNull();
    expect(weg.getAttribute('href')).toBe('#/anlage/site-1/fahrplan');
    expect(weg.textContent).toContain('Ihr Fahrplan nutzt genau diese Preise');
  });

  /**
   * §4.3 · die benannten Preisfenster wandern aus dem 0,74-rem-Fuß des
   * Diagramms in die Karte — als Ledger-Zeilen (16 px), Wort links, Zeitraum
   * rechts.
   */
  it('trägt die benannten Preisfenster als Ledger-Zeilen', async () => {
    setzeBreite(true);
    priceHistoryMock.mockResolvedValue(historie(tagesReihe(UHR)));
    rendere();
    await screen.findByTestId('preis-chart');
    const liste = document.querySelector('[aria-label="Benannte Preisfenster"]');
    expect(liste).not.toBeNull();
    expect(liste!.querySelectorAll('.vp-c-led-row').length).toBeGreaterThan(0);
    expect(liste!.textContent).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}/);
  });
});
