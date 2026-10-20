import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HistoryBucket, WeatherPoint } from '../api';

/**
 * Die Wetter-Seite auf Render-Ebene (Konzept „Preise und Wetter", Fassung 3,
 * E5 = A „Wetter zuerst"). Die Ableitungen prüft `wetterTag.test.ts`; hier
 * geht es um die Reihenfolge, die drei Tage, das Bild und die ehrlichen
 * Zustände ohne Prognose, ohne Standort und bei einem Ladefehler.
 */

const weatherMock = vi.fn();
const scheduleMock = vi.fn();
const historyMock = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      weather: (...a: unknown[]) => weatherMock(...a),
      schedule: (...a: unknown[]) => scheduleMock(...a),
      history: (...a: unknown[]) => historyMock(...a),
    },
  };
});

const { WetterSection } = await import('./DataPages');

const um = (h: number, m = 0, tag = 0) => new Date(2026, 9, 20 + tag, h, m, 0, 0);
const SITE = { id: 'site-1', name: 'Sonnenhof', biddingZone: 'DE-LU' } as never;

/** Drei Tage: heute sonnig, morgen wechselnd, übermorgen bewölkt; hell von 8 bis 18 Uhr. */
function punkte(): WeatherPoint[] {
  const out: WeatherPoint[] = [];
  [10, 50, 90].forEach((wolken, tag) => {
    for (let h = 0; h < 24; h++) {
      const hell = h >= 8 && h < 18;
      out.push({
        ts: um(h, 0, tag).toISOString(),
        temperatureC: 8 + (hell ? h - 8 : 0),
        cloudCoverPct: wolken,
        ghiWM2: hell ? 400 : 0,
        dniWM2: hell ? (wolken < 50 ? 300 : 40) : 0,
        dhiWM2: null,
      });
    }
  });
  return out;
}

/** PV-Prognose des Fahrplans ab jetzt bis morgen Abend: 4 kW in den hellen Stunden. */
function plan() {
  const slots = [];
  for (let q = 0; q < 96 * 2; q++) {
    const t = um(0, q * 15);
    if (t < um(13, 45)) continue;
    const h = (q % 96) / 4;
    slots.push({ start: t.toISOString(), batteryKw: 0, pvKw: h >= 8 && h < 18 ? 4 : 0 });
  }
  return { slots, slotMinutes: 15, generatedAt: null, deviceId: null };
}

/** Gemessen bis 13:45: 2 kW in den hellen Stunden. */
function historie() {
  const buckets: Partial<HistoryBucket>[] = [];
  for (let q = 0; q < 55; q++) {
    const h = q / 4;
    buckets.push({ start: um(0, q * 15).toISOString(), pvKwh: h >= 8 && h < 18 ? 0.5 : 0 });
  }
  return { range: 'day', from: um(0).toISOString(), to: um(24).toISOString(), bucketMinutes: 15, buckets, totals: {}, protocol: [], plan: [] };
}

function setzeBreite(art: 'telefon' | 'rechner') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: art === 'telefon' ? query.includes('max-width: 720px') : query.includes('min-width: 1024px'),
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

const antwort = () => document.querySelector('.vp-pz-antwort') as HTMLElement;

describe('Wetter-Seite · Fassung 3', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(um(13, 50));
    weatherMock.mockResolvedValue({ runAt: um(13).toISOString(), points: punkte() });
    scheduleMock.mockResolvedValue(plan());
    historyMock.mockResolvedValue(historie());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    // @ts-expect-error - Stellvertreter abräumen
    delete window.matchMedia;
  });

  it('führt mit dem Wetter: Symbol, Temperatur, Wort - dann zwei Zahlen für die Anlage', async () => {
    setzeBreite('telefon');
    render(<WetterSection site={SITE} />);
    await screen.findByText('Wetter am Standort · jetzt 13:50');
    const a = antwort();
    expect(a.querySelector('.vp-wt-temp b')?.textContent).toMatch(/^13\s?°C$/);
    expect(within(a).getByText('sonnig')).toBeInTheDocument();
    expect(a.textContent).toContain('Sonne bis ca. 18 Uhr');
    await waitFor(() => expect(a.textContent).toContain('Sonnenstrom jetzt'));
    expect(a.textContent).toContain('gemessen');
    // Gemessen 8:00-13:45 (11,5 kWh) + erwartet 13:45-18:00 (17 kWh).
    expect(a.textContent).toMatch(/≈\s?29\s?kWh/);
    expect(a.textContent).toContain('12 schon erzeugt');
  });

  it('trägt drei Tage als Karten; eine Karte wählt den Tag für das Bild', async () => {
    setzeBreite('telefon');
    render(<WetterSection site={SITE} />);
    const tage = await screen.findByRole('tablist', { name: 'Tag wählen' });
    const karten = within(tage).getAllByRole('tab');
    expect(karten.map((k) => k.querySelector('.vp-wt-tag-name')?.textContent)).toEqual(['Heute', 'Morgen', 'Do 22.10.']);
    expect(karten[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Sonnenstrom heute' })).toBeInTheDocument();

    fireEvent.click(karten[1]);
    expect(karten[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Sonnenstrom morgen' })).toBeInTheDocument();

    // Übermorgen reicht die Prognose nicht: Sonnenstärke, und das Bild sagt warum.
    fireEvent.click(karten[2]);
    expect(screen.getByRole('heading', { name: 'Sonnenstärke Do 22.10.' })).toBeInTheDocument();
    expect(screen.getByText(/reicht noch nicht bis zu diesem Tag/)).toBeInTheDocument();
  });

  it('Pfeiltasten im Bild wählen eine Viertelstunde; „Jetzt" führt zurück', async () => {
    setzeBreite('rechner');
    render(<WetterSection site={SITE} />);
    await screen.findByText('Wetter am Standort · jetzt 13:50');
    const bild = document.querySelector('.vp-pz-bild') as HTMLElement;
    fireEvent.keyDown(bild, { key: 'ArrowRight' });
    expect(antwort().textContent).toContain('heute 14:00 Uhr');
    expect(antwort().textContent).toContain('erwartet');
    fireEvent.click(within(antwort()).getByRole('button', { name: /Jetzt/ }));
    expect(antwort().textContent).toContain('Wetter am Standort · jetzt 13:50');
  });

  it('zeigt am Rechner die Stunden neben dem Bild, am Telefon im Blatt', async () => {
    setzeBreite('rechner');
    const { unmount } = render(<WetterSection site={SITE} />);
    expect(await screen.findByRole('heading', { name: 'Stunde für Stunde' })).toBeInTheDocument();
    expect(document.querySelector('.vp-wt-tabelle')).not.toBeNull();
    unmount();

    setzeBreite('telefon');
    render(<WetterSection site={SITE} />);
    await screen.findByText('Wetter am Standort · jetzt 13:50');
    expect(document.querySelector('.vp-wt-tabelle')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Stunde für Stunde/ }));
    const blatt = await screen.findByRole('dialog');
    expect(within(blatt).getByText('jetzt')).toBeInTheDocument();
  });

  it('führt ohne Fahrplan die Sonnenstärke und SAGT es', async () => {
    setzeBreite('telefon');
    scheduleMock.mockRejectedValue(new Error('kein Plan'));
    historyMock.mockRejectedValue(new Error('offline'));
    render(<WetterSection site={SITE} />);
    expect(await screen.findByRole('heading', { name: 'Sonnenstärke heute' })).toBeInTheDocument();
    expect(screen.getByText(/keine Sonnenstrom-Prognose vor/)).toBeInTheDocument();
    expect(antwort().textContent).toContain('Sonnenstärke jetzt');
    expect(antwort().textContent).toContain('Sonne heute');
  });

  it('zeigt ohne Vorhersage den Leer-Zustand MIT dem Weg zum Standort', async () => {
    setzeBreite('telefon');
    weatherMock.mockResolvedValue({ runAt: null, points: [] });
    render(<WetterSection site={SITE} />);
    expect(await screen.findByText(/braucht dafür einen Standort/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Standort in den Einstellungen/ })).toBeInTheDocument();
  });

  it('zeigt einen Ladefehler als Fehler-Zustand mit dem Weg zurück', async () => {
    setzeBreite('telefon');
    weatherMock.mockRejectedValueOnce(new Error('kaputt'));
    render(<WetterSection site={SITE} />);
    expect(await screen.findByText(/konnte nicht geladen werden/)).toBeInTheDocument();
  });
});
