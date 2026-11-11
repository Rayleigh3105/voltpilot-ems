import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PriceBucket, PriceHistory } from '../api';

/**
 * Die Preis-Seite auf Render-Ebene (Konzept „Preise und Wetter", Fassung 3,
 * Entscheide E1–E8 = A vom 20.10.2026). Die Ableitungen prüft
 * `preisZeitstrahl.test.ts` erschöpfend — hier geht es um die REIHENFOLGE
 * (Antwort zuerst), die Bedienung (tippen, Kacheln, Blätter) und darum, dass
 * nichts erfunden wird.
 */

vi.mock('../PriceHistoryChart', () => ({
  PriceHistoryChart: () => <div data-testid="rueckblick-chart" />,
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

/** Dienstag, 20.10.2026, 00:00 Ortszeit. Die Uhr steht im Test fest. */
const TAG = new Date(2026, 9, 20, 0, 0, 0, 0).getTime();
const VIERTEL = 15 * 60_000;
const um = (h: number, m = 0) => new Date(2026, 9, 20, h, m, 0, 0);

/** Zwei Tage in ct/kWh: mittags billig (14), abends teuer (26), morgen früh am teuersten (28). */
function zweiTage(tage = 2): number[] {
  return Array.from({ length: 96 * tage }, (_, i) => {
    const h = (i % 96) / 4;
    const morgen = i >= 96;
    if (!morgen && h >= 12 && h < 16) return 14;
    if (!morgen && h >= 17.5 && h < 20) return 26;
    if (morgen && h >= 7 && h < 9.5) return 28;
    if (morgen && h >= 2 && h < 5) return 16;
    return 20 + (i % 5) * 0.1;
  });
}

function historie(cts: readonly number[]): PriceHistory {
  const buckets: PriceBucket[] = cts.map((ct, i) => ({
    ts: new Date(TAG + i * VIERTEL).toISOString(),
    avgEurMwh: ct * 10,
    minEurMwh: ct * 10,
    maxEurMwh: ct * 10,
  }));
  return {
    biddingZone: 'DE-LU',
    currency: 'EUR',
    bucket: 'PT15M',
    from: buckets[0].ts,
    to: buckets[buckets.length - 1].ts,
    buckets,
    summary: {
      avgEurMwh: 200,
      minEurMwh: 140,
      maxEurMwh: 280,
      cheapestTs: buckets[Math.min(48, buckets.length - 1)].ts,
      mostExpensiveTs: buckets[Math.min(130, buckets.length - 1)].ts,
      count: buckets.length,
      coverageStart: buckets[0].ts,
      coverageEnd: buckets[buckets.length - 1].ts,
    },
  };
}

const SITE = { id: 'site-1', name: 'Sonnenhof Weber', biddingZone: 'DE-LU' } as never;

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

/** jsdom legt nichts aus: das Bild braucht eine Breite, um zu zeichnen. */
function gibBreite(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => px });
}

function rendere() {
  return render(<MarktpreisePage sites={[SITE]} selectedSite="site-1" onSelectSite={() => {}} embedded />);
}

const antwort = () => document.querySelector('.vp-pz-antwort') as HTMLElement;

describe('Preis-Seite · Fassung 3', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(um(13, 45));
    window.location.hash = '#/anlage/site-1/marktpreise';
    priceHistoryMock.mockResolvedValue(historie(zweiTage()));
    scheduleMock.mockResolvedValue({ slots: [], slotMinutes: 15, generatedAt: null, deviceId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // @ts-expect-error - die Stellvertreter wieder abräumen
    delete window.matchMedia;
    // @ts-expect-error - dito
    delete HTMLElement.prototype.clientWidth;
  });

  it.each([
    ['am Telefon', true],
    ['am Rechner', false],
  ])('führt %s mit der Antwort - keine Zeitleiste davor', async (_name, phone) => {
    setzeBreite(phone as boolean);
    rendere();
    await screen.findByText('Börsenpreis · jetzt 13:45');
    const a = antwort();
    expect(a.querySelector('.vp-pz-zahl-wert b')?.textContent).toBe('14,0');
    expect(within(a).getByText('günstig')).toHaveClass('vp-chip');
    expect(a.textContent).toContain('noch bis 16:00');
    // Regel 1: keine Bedienung vor der Antwort.
    expect(document.querySelector('.vp-zeitleiste')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('nennt die zwei Fenster nur nach vorn, mit Tag', async () => {
    setzeBreite(true);
    rendere();
    const guenstig = await screen.findByRole('button', { name: /Am günstigsten/ });
    expect(guenstig.textContent).toContain('jetzt bis 15:45');
    const teuer = screen.getByRole('button', { name: /Am teuersten/ });
    expect(teuer.textContent).toContain('morgen 07:00–09:00');
    expect(teuer.textContent).toMatch(/in 17½\s?Std/);
  });

  it('eine Kachel antippen zeigt ihr Fenster oben; „Jetzt" führt zurück', async () => {
    setzeBreite(true);
    rendere();
    const teuer = await screen.findByRole('button', { name: /Am teuersten/ });
    fireEvent.click(teuer);
    expect(teuer).toHaveAttribute('aria-pressed', 'true');
    expect(antwort().textContent).toContain('Am teuersten · 2 Std');
    expect(antwort().querySelector('.vp-pz-zahl-wert b')?.textContent).toBe('28,0');

    fireEvent.click(within(antwort()).getByRole('button', { name: /Jetzt/ }));
    expect(antwort().textContent).toContain('Börsenpreis · jetzt 13:45');
    expect(teuer).toHaveAttribute('aria-pressed', 'false');
  });

  it('Pfeiltasten im Bild wählen eine Viertelstunde; ‹ › gehen weiter', async () => {
    setzeBreite(false);
    rendere();
    await screen.findByText('Börsenpreis · jetzt 13:45');
    const bild = document.querySelector('.vp-pz-bild') as HTMLElement;
    fireEvent.keyDown(bild, { key: 'ArrowRight' });
    expect(antwort().textContent).toContain('Di 20.10. 14:00–14:15');
    expect(antwort().textContent).toMatch(/in 15\s?Min/);

    fireEvent.click(within(antwort()).getByRole('button', { name: '15 Minuten später' }));
    expect(antwort().textContent).toContain('14:15–14:30');
    fireEvent.keyDown(bild, { key: 'Escape' });
    expect(antwort().textContent).toContain('Börsenpreis · jetzt 13:45');
  });

  it('der Finger TIPPT: ein Tipp wählt, ein Wisch nicht (Cockpit-Entscheid b1)', async () => {
    setzeBreite(true);
    gibBreite(360);
    rendere();
    await screen.findByText('Börsenpreis · jetzt 13:45');
    const bild = document.querySelector('.vp-pz-bild') as HTMLElement;
    await waitFor(() => expect(bild.querySelector('svg')).not.toBeNull());

    // Wischen (über 10 px) wählt nichts - die Seite gehört dem Finger zum Scrollen.
    fireEvent.pointerDown(bild, { clientX: 200, clientY: 100, pointerType: 'touch', pointerId: 1 });
    fireEvent.pointerUp(bild, { clientX: 240, clientY: 100, pointerType: 'touch', pointerId: 1 });
    expect(antwort().textContent).toContain('Börsenpreis · jetzt 13:45');

    fireEvent.pointerDown(bild, { clientX: 200, clientY: 100, pointerType: 'touch', pointerId: 2 });
    fireEvent.pointerUp(bild, { clientX: 202, clientY: 101, pointerType: 'touch', pointerId: 2 });
    expect(antwort().textContent).not.toContain('Börsenpreis · jetzt');
    expect(within(antwort()).getByRole('button', { name: /Jetzt/ })).toBeInTheDocument();
  });

  it('zeigt Jetzt-Marke und Tagesband im Bild; ohne Folgetag steht das IM Bild', async () => {
    setzeBreite(true);
    gibBreite(360);
    vi.setSystemTime(um(9, 30));
    priceHistoryMock.mockResolvedValue(historie(zweiTage(1)));
    rendere();
    await screen.findByText('Börsenpreis · jetzt 09:30');
    const bild = document.querySelector('.vp-pz-bild') as HTMLElement;
    await waitFor(() => expect(bild.querySelector('svg')).not.toBeNull());
    const text = bild.querySelector('svg')!.textContent ?? '';
    expect(text).toContain('Jetzt');
    expect(text).toContain('Heute');
    expect(text).toMatch(/Preise für\s*morgen/);
    expect(text).toContain('ab ca. 13 Uhr');
  });

  it('erfindet ohne laufende Viertelstunde KEINEN Jetzt-Preis', async () => {
    setzeBreite(true);
    priceHistoryMock.mockResolvedValue(historie(zweiTage().slice(0, 24)));
    rendere();
    expect(await screen.findByText('Für jetzt liegt noch kein Börsenpreis vor.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Am günstigsten/ })).toBeNull();
  });

  it('zeigt den Speicher laut Plan nur, wenn der Plan etwas tut', async () => {
    setzeBreite(true);
    scheduleMock.mockResolvedValue({
      slots: [{ start: um(14).toISOString(), batteryKw: 3 }],
      slotMinutes: 15,
      generatedAt: null,
      deviceId: null,
    });
    const { unmount } = rendere();
    expect(await screen.findByText('Speicher laut Plan:')).toBeInTheDocument();
    unmount();

    scheduleMock.mockResolvedValue({ slots: [{ start: um(14).toISOString(), batteryKw: 0 }], slotMinutes: 15 });
    rendere();
    await screen.findByText('Börsenpreis · jetzt 13:45');
    await waitFor(() => expect(scheduleMock).toHaveBeenCalled());
    expect(screen.queryByText('Speicher laut Plan:')).toBeNull();
  });

  it('der Rückblick ist ein Blatt mit Woche, Monat, Jahr - und schreibt die Adresse', async () => {
    setzeBreite(true);
    rendere();
    fireEvent.click(await screen.findByRole('button', { name: /Rückblick/ }));
    const blatt = await screen.findByRole('dialog');
    expect(within(blatt).getByRole('tab', { name: 'Woche' })).toHaveAttribute('aria-selected', 'true');
    await within(blatt).findByTestId('rueckblick-chart');
    expect(priceHistoryMock).toHaveBeenLastCalledWith('site-1', 'week', '2026-10-20');
    expect(window.location.hash).toBe('#/anlage/site-1/marktpreise?z=woche&at=2026-10-20');
    expect(within(blatt).getByText(/Profi-Detail/)).toBeInTheDocument();
  });

  it('das Erklär-Blatt nennt den Endpreis und die Profi-Zahlen in EUR/MWh', async () => {
    setzeBreite(true);
    rendere();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Was ist der Börsenpreis?' }))[0]);
    const blatt = await screen.findByRole('dialog');
    expect(blatt.textContent).toContain('Ihr Endpreis ist höher');
    expect(blatt.textContent).toMatch(/140,0\s?EUR\/MWh/);
    expect(blatt.textContent).toContain('DE-LU');
  });

  it('der Weg zum Fahrplan bleibt', async () => {
    setzeBreite(true);
    rendere();
    const weg = (await screen.findByText('Ihr Fahrplan')).closest('a') as HTMLAnchorElement;
    expect(weg.getAttribute('href')).toBe('#/anlage/site-1/fahrplan');
  });
});
