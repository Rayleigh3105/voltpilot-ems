import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WeatherForecast, WeatherPoint } from '../api';

/**
 * **Paket P5 · der Reiter „Wetter" in den C-Bausteinen** (Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §4.6; Captain-Entscheide **E8 (a)**
 * Statement und **E7 (a)** Tooltip + Legenden-Schalter, KEIN Zoom).
 *
 * Geprüft wird der VERTRAG der Karte, nicht ihr Aussehen:
 *
 *  1. **Statement** — die EINE Zahl trägt die stärkste kommende Stunde, der
 *     Satz sagt WANN. Die frühere `h2` „Vorhersage {Anlage}" samt Icon-Kachel
 *     ist ersatzlos entfallen.
 *  2. **V5** — die vier Kennzahlen stehen als Zeilen, nicht als 2×2-Raster; ein
 *     fehlender Wert liest „—", nie eine 0.
 *  3. **V8** — „Temperatur & Sonnenstärke im Verlauf" ist ein Aufklapper, und
 *     er ist ZU, bis jemand fragt.
 *  4. **§4.6 Sonderzustände** — ohne Fahrplan führt die Sonnenstärke und die
 *     Fläche sagt es; ohne Koordinaten steht der Leer-Zustand MIT dem Weg;
 *     ein Ladefehler steht als Fehler-Zustand mit „Erneut versuchen".
 */

vi.mock('../WeatherChart', () => ({
  WeatherChart: ({ modus }: { modus?: string }) => (
    <div data-testid={modus === 'kontext' ? 'wetter-chart-kontext' : 'wetter-chart'} />
  ),
}));

const weatherMock = vi.fn();
const scheduleMock = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      weather: (...a: unknown[]) => weatherMock(...a),
      schedule: (...a: unknown[]) => scheduleMock(...a),
    },
  };
});

const { WetterSection } = await import('./DataPages');

const SITE = { id: 'site-22', name: 'Hof Lindenberg', biddingZone: 'DE-LU' } as never;

/** Stündliche Vorhersage ab der VOLLEN Stunde vor jetzt — wie die echte API. */
function punkte(stunden = 30): WeatherPoint[] {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() - 1);
  return Array.from({ length: stunden }, (_, i) => {
    const t = new Date(start.getTime() + i * 3_600_000);
    const h = t.getHours();
    const tag = h >= 7 && h <= 19;
    return {
      ts: t.toISOString(),
      temperatureC: 19.2,
      cloudCoverPct: 100,
      ghiWM2: tag ? 400 : 0,
      dniWM2: null,
      dhiWM2: null,
    };
  });
}

function forecast(p = punkte()): WeatherForecast {
  return { runAt: new Date().toISOString(), points: p };
}

/** Ein Fahrplan über die kommenden Stunden — die kW-Reihe des Statements. */
function plan(stunden = 30) {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() - 1);
  const slots = [];
  for (let i = 0; i < stunden * 4; i++) {
    const t = new Date(start.getTime() + i * 900_000);
    const h = t.getHours() + t.getMinutes() / 60;
    const kw = h >= 7 && h <= 19 ? Math.max(0, 12 * Math.sin(((h - 7) / 12) * Math.PI)) : 0;
    slots.push({ start: t.toISOString(), pvKw: Number(kw.toFixed(3)) });
  }
  return { slots };
}

beforeEach(() => {
  weatherMock.mockReset();
  scheduleMock.mockReset();
  scheduleMock.mockResolvedValue(plan());
});
afterEach(() => vi.restoreAllMocks());

describe('P5 · Wetter in den C-Bausteinen', () => {
  it('führt mit dem Statement statt einer h2 samt Icon-Kachel (E8 a)', async () => {
    weatherMock.mockResolvedValue(forecast());
    const { container } = render(<WetterSection site={SITE} />);

    const zahl = await waitFor(() => {
      const el = container.querySelector('.vp-c-stm-zahl');
      expect(el?.textContent).toMatch(/kW$/);
      return el as HTMLElement;
    });
    // Die Zahl trägt eine echte Leistung, keinen Platzhalter.
    expect(zahl.textContent).not.toBe('—');
    expect(container.querySelector('.vp-c-stm-ein')?.textContent).toMatch(/erwartete Spitze/);
    // Die frühere Überschrift ist ERSATZLOS weg — nicht nur versteckt.
    expect(screen.queryByRole('heading', { name: /Vorhersage Hof Lindenberg/ })).toBeNull();
    // Das Label trägt das Datum, weil es hier KEINE Zeit-Leiste gibt (§4.6).
    expect(container.querySelector('.vp-c-label-text')?.textContent).toMatch(/^Vorhersage · /);
    expect(container.querySelector('.vp-zeitleiste')).toBeNull();
  });

  it('stellt das Bild direkt hinter das Statement und die Kennzahlen als Zeilen (V5/V6)', async () => {
    weatherMock.mockResolvedValue(forecast());
    const { container } = render(<WetterSection site={SITE} />);
    await screen.findByTestId('wetter-chart');

    const knoten = Array.from(
      container.querySelectorAll('.vp-c-stm, [data-testid="wetter-chart"], .vp-c-led'),
    );
    expect(knoten.map((n) => n.getAttribute('data-testid') ?? n.className.split(' ')[0])).toEqual([
      'vp-c-stm',
      'wetter-chart',
      'vp-c-led',
    ]);

    const zeilen = Array.from(container.querySelectorAll('.vp-c-led-row .vp-c-led-name')).map(
      (n) => n.textContent,
    );
    expect(zeilen).toEqual(['Temperatur', 'Bewölkung', 'Vorhersagehorizont', 'Spitze heute']);
    const werte = Array.from(container.querySelectorAll('.vp-c-led-row .vp-c-led-val')).map(
      (n) => n.textContent,
    );
    expect(werte[0]).toBe('19,2\u202f°C');
    expect(werte[1]).toBe('100\u202f%');
    // Das 2×2-Raster mit seinen 21,6-px-Werten ist entfallen.
    expect(container.querySelector('.vp-grid-stats-4')).toBeNull();
    expect(container.querySelector('.vp-grid-stats')).toBeNull();
  });

  it('legt das zweite Bild in einen Aufklapper, der ZU beginnt (V8)', async () => {
    weatherMock.mockResolvedValue(forecast());
    const { container } = render(<WetterSection site={SITE} />);
    await screen.findByTestId('wetter-chart');

    const auf = container.querySelector('details') as HTMLDetailsElement;
    expect(auf.open).toBe(false);
    expect(auf.textContent).toMatch(/Temperatur & Sonnenstärke im Verlauf/);
    expect(screen.queryByTestId('wetter-chart-kontext')).toBeNull();

    fireEvent.click(container.querySelector('summary') as HTMLElement);
    expect(await screen.findByTestId('wetter-chart-kontext')).toBeTruthy();
  });

  it('führt ohne Fahrplan die Sonnenstärke und SAGT es (§4.6)', async () => {
    weatherMock.mockResolvedValue(forecast());
    scheduleMock.mockResolvedValue({ slots: [] });
    const { container } = render(<WetterSection site={SITE} />);

    await waitFor(() => {
      expect(container.querySelector('.vp-c-stm-zahl')?.textContent).toMatch(/W\/m²$/);
    });
    expect(container.querySelector('.vp-c-stm-ein')?.textContent).toMatch(
      /ohne Fahrplan zeigen wir die Sonnenstärke/i,
    );
    // „Spitze heute" behauptet dann KEINE 0, sondern sagt „—".
    const werte = Array.from(container.querySelectorAll('.vp-c-led-row .vp-c-led-val')).map(
      (n) => n.textContent,
    );
    expect(werte[3]).toBe('—');
  });

  it('zeigt ohne Koordinaten den Leer-Zustand MIT dem Weg (§4.6)', async () => {
    weatherMock.mockResolvedValue(forecast([]));
    const { container } = render(<WetterSection site={SITE} />);

    const weg = await screen.findByRole('button', {
      name: /Standort in den Einstellungen ergänzen/,
    });
    expect(container.querySelector('.vp-c-zst-leer')).toBeTruthy();
    fireEvent.click(weg);
    expect(window.location.hash).toBe('#/anlage/site-22/technik');
  });

  it('zeigt einen Ladefehler als Fehler-Zustand mit dem Weg zurück', async () => {
    weatherMock.mockRejectedValue(new Error('502'));
    const { container } = render(<WetterSection site={SITE} />);

    await waitFor(() => expect(container.querySelector('.vp-c-zst-fehler')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Erneut versuchen/ })).toBeTruthy();
    expect(container.querySelector('.vp-c-stm')).toBeNull();
  });
});
