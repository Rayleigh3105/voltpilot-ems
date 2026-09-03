import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForecastQuality } from '../api';

/**
 * Der Reiter „Prognose" auf Render-Ebene (Konzept
 * `vp-verlauf-sprache-konzept-v5` §4.5, Paket P7). Die Ableitungen sind in
 * `prognose.test.ts` erschoepfend geprueft - hier geht es um die REIHENFOLGE
 * (das Verdikt zuerst), darum, dass die Essays erreichbar BLEIBEN, und darum,
 * dass BEIDE Breiten dieselbe Fläche zeigen.
 *
 * ⚠ **Der frühere Telefon/Rechner-Zwilling ist mit P7 entfallen.** Bis dahin
 *   prüfte die letzte Zusicherung dieser Datei, dass der Rechner die alte
 *   Fassung behält (Essay offen ganz oben, keine Aufklapper, keine
 *   Verdikt-Karte). Genau das war die zweite Sprache, die der Bereich
 *   abschafft: derselbe Essay lag zweimal im Baum. An ihrer Stelle steht jetzt
 *   die Gegenprobe „an beiden Breiten dieselben Karten".
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

describe('Prognosequalität - der Reiter in den C-Bausteinen (P7)', () => {
  beforeEach(() => forecastQualityMock.mockResolvedValue(QUALITY));
  afterEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - die Stellvertreter-Breite wieder abraeumen
    delete window.matchMedia;
  });

  it('fuehrt mit dem Verdikt: 2 Arten x Ø-Abweichung als V5-Zeilen', async () => {
    setzeBreite(true);
    rendere();

    await screen.findByText('Wie gut Ihre Anlage vorhersagt');
    // Die 24-px-Zahl der Sektion — E8 = a: KEIN Hero, sondern eine Zeile je Art.
    expect(screen.getByText(/±0,75\s?kW/)).toBeInTheDocument();
    expect(screen.getByText(/±1,36\s?kW/)).toBeInTheDocument();
    // Beide Arten beim Namen - die Rahmung haengt daran. Sie stehen seit P7 an
    // mehreren Orten (Zeile, Aufklapper, Kurven-Label), deshalb `getAllByText`.
    expect(screen.getAllByText('Verbrauchsprognose (Last)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PV-Prognose (Erzeugung)').length).toBeGreaterThan(0);
    // Die Sekundärzeile sagt, WAS die Zahl ist - nie nur „letzte 7 Tage".
    expect(
      screen.getAllByText(/Mittlere Abweichung je Viertelstunde/).length,
    ).toBeGreaterThan(0);
  });

  it('das Verdikt steht VOR der ersten Kurve', async () => {
    setzeBreite(true);
    rendere();
    const verdikt = await screen.findByText('Wie gut Ihre Anlage vorhersagt');
    const chart = screen.getAllByTestId('prognose-chart')[0];
    expect(verdikt.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('macht aus jedem Kandidaten eine V5-Zeile mit dem Ehrlichkeits-Satz', async () => {
    setzeBreite(true);
    rendere();
    await screen.findByText('Wie gut Ihre Anlage vorhersagt');

    // Der STAND steht in einem eigenen Element - er ist der Satz, den
    // `kandidatenZeilen` formuliert, nicht ein Stueck einer laengeren Zeile.
    expect(screen.getByText('in 1 von 1 Bewertung genauer')).toBeInTheDocument();
    expect(screen.getByText('sammelt Daten · Tag 14/21')).toBeInTheDocument();
    expect(
      screen.getByText(/Kandidaten beeinflussen Ihre Steuerung nicht/),
    ).toBeInTheDocument();
    // Der Fortschritt als Zahl RECHTS in der Zeile (Tabellenziffern) - der
    // Satz „sammelt Daten · Tag 14/21" nennt ihn daneben in Worten.
    const werte = screen
      .getAllByText(/14\s?\/\s?21/)
      .filter((e) => e.classList.contains('vp-c-led-val'));
    expect(werte).toHaveLength(1);
    // Und der Chip statt des `Badge variant="tint"` (gemessen 3,05 : 1).
    const chip = screen.getByText('Schattenbetrieb');
    expect(chip).toHaveClass('vp-chip');
    // Die Vertiefung (Trainingsstand, Merkmale, Beleg) ist erreichbar, aber im
    // Aufklapper - nicht mehr im taeglichen Scrollweg.
    expect(screen.getByText(/Noch nicht trainiert/).closest('details')).not.toBeNull();
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

  it('zeigt an BEIDEN Breiten dieselben Karten - der Zwilling ist weg', async () => {
    const karten = ['Wie gut Ihre Anlage vorhersagt', 'Aktive Modelle', 'Lernende Kandidaten'];
    for (const phone of [true, false]) {
      setzeBreite(phone);
      const { unmount } = rendere();
      await screen.findByText('Wie gut Ihre Anlage vorhersagt');
      for (const k of karten) expect(screen.getByText(k)).toBeInTheDocument();
      // Der Essay ist auf BEIDEN Breiten ein Aufklapper - er stand am Rechner
      // offen VOR der Antwort, die man bei jedem Besuch sucht.
      expect(screen.getByText('Was sehe ich hier?').closest('details')).not.toBeNull();
      // ... und er liegt dabei GENAU EINMAL im Baum (bis P7 zweimal).
      expect(screen.getAllByText('Was sehe ich hier?')).toHaveLength(1);
      unmount();
    }
  });

  it('nennt den leeren Zustand beim Namen, statt eine 0 zu behaupten', async () => {
    forecastQualityMock.mockResolvedValue({ ...QUALITY, accuracy: [] });
    setzeBreite(true);
    rendere();

    expect(
      await screen.findByText(/Die erste Bewertung entsteht nach dem ersten vollständigen Tag/),
    ).toBeInTheDocument();
    // Ohne Bewertung sagt die Zeile den GRUND, nie „±0 kW".
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Noch keine Bewertung').length).toBeGreaterThan(0);
  });
});
