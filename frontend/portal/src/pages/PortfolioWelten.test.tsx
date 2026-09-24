import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PortfolioMesswerte } from './PortfolioMesswerte';
import { PortfolioErloese } from './PortfolioErloese';
import { clearHistoryCache } from '../historyCache';
import { clearPortfolioEarningsCache } from '../usePortfolioHistorie';
import { api, type Earnings, type EarningsSite, type History, type Site } from '../api';

/**
 * **Die zwei Welten eine Ebene höher** (PR G): Σ oben, Anlagen-Tabelle
 * darunter, Zeilen-Klick öffnet DIESELBE Welt DIESER Anlage im GLEICHEN
 * Zeitraum. Geprüft wird genau das — plus die Ehrlichkeit der Ebene: eine
 * Anlage ohne Daten steht ehrlich in der Tabelle und fließt nicht als 0 in die
 * Summe.
 */

function site(id: string, name: string, over: Partial<Site> = {}): Site {
  return {
    id,
    name,
    biddingZone: 'DE-LU',
    latitude: null,
    longitude: null,
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    netzladenErlaubt: false,
    maxFeedInKw: null,
    ...over,
  };
}

const DACHAU = site('a', 'Solarpark Dachau', { plantKind: 'direktvermarktung' });
const LINDENBERG = site('b', 'Hof Lindenberg');

function history(pv: number | null): History {
  return {
    range: 'month',
    from: '',
    to: '',
    bucketMinutes: 1440,
    buckets:
      pv == null
        ? []
        : [
            {
              start: '2026-07-01T00:00:00Z',
              pvKwh: pv,
              loadKwh: 4,
              gridImportKwh: 1,
              gridExportKwh: 7,
              batteryChargeKwh: 2,
              batteryDischargeKwh: 1,
              socMinPct: null,
              socMaxPct: null,
              socLastPct: null,
              priceEurMwh: null,
              costEur: null,
            },
          ],
    totals: {
      consumptionKwh: null,
      pvGenerationKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      gridCostEur: null,
      tarifArt: 'ohne',
      batterySavingsPlannedEur: null,
      autarkiePct: null,
      eigenverbrauchPct: null,
    },
    protocol: [],
    plan: [],
  };
}

function earningsSite(over: Partial<EarningsSite> & { id: string; name: string }): EarningsSite {
  return {
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    realizedExportCtKwh: null,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    baselineEur: null,
    actualEur: null,
    savedEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 0,
    firstCoveredDate: null,
    reason: null,
    dailySaved: [],
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    einspeiseErloesEur: null,
    eigenverbrauchsWertEur: null,
    gesamtertragEur: null,
    selbstverbrauchKwh: null,
    eingespeistKwh: null,
    batterieBewegtKwh: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: [],
    monthlyStrip: [],
    ...over,
  };
}

const earnings: Earnings = {
  range: 'month',
  from: '',
  to: '',
  sites: [
    earningsSite({
      id: 'a',
      name: 'Solarpark Dachau',
      einspeiseErloesEur: 900,
      eigenverbrauchsWertEur: 99.26,
      gesamtertragEur: 999.26,
      // Stromkosten 40 EUR => actual = stromkosten - einspeise = -860; das
      // Ergebnis unterm Strich sind 900 + 99,26 - 40 = 959,26 EUR (E9 / P9).
      actualEur: -860,
      savedEur: 161.44,
      // ⚠ DIE MESSLATTE IST DERSELBE SPEICHER OHNE SMARTE STEUERUNG (Captain
      //   04.09.2026): die Spalte und die Karte zeigen `savedSteuerungEur`.
      savedSpeicherEur: 100.0,
      savedSteuerungEur: 61.44,
      steuerungSplitReason: null,
      eingespeistKwh: 9573.8,
      coveredSlots: 2880,
      series: [
        { start: '2026-07-01T00:00:00Z', gesamtertragEur: 400 },
        { start: '2026-07-02T00:00:00Z', gesamtertragEur: 599.26 },
      ],
    }),
    earningsSite({ id: 'b', name: 'Hof Lindenberg', reason: 'no_prices' }),
  ],
  totals: {
    baselineEur: null,
    actualEur: null,
    savedEur: 161.44,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 2880,
    firstCoveredDate: null,
  },
};

beforeEach(() => {
  // Ein fester Anker: der Zeitraum muss im Sprung-Link auftauchen, und ein
  // „heute" des Testrechners wäre kein prüfbarer Wert.
  window.location.hash = '#/portfolio/messwerte?z=monat&at=2026-07-15';
  // jsdom kennt kein `scrollTo` (die Navigation ruft es wie die Schale auf).
  vi.stubGlobal('scrollTo', vi.fn());
  clearHistoryCache();
  clearPortfolioEarningsCache();
  vi.restoreAllMocks();
});

const nb = (t: string | null | undefined) => (t ?? '').replace(/ /g, ' ');

/** Die Kennzahl-Kachel mit diesem Namen (Label-Zeile). */
function kachel(name: string): HTMLElement {
  const gruppe = screen.getByRole('group', { name: /aller Anlagen · / });
  return within(gruppe).getByText(name).closest('.vp-vr-kpi') as HTMLElement;
}

describe('Meine Anlagen · Energie', () => {
  it('trägt die Zeitleiste der Anlage mit allen vier Zeiträumen und die Statuszeile', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    expect(screen.getByRole('heading', { level: 1, name: /Energie aller Anlagen/ })).toHaveClass('vp-sr-only');
    const seg = screen.getByRole('tablist', { name: 'Zeitraum' });
    expect(within(seg).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Tag', 'Woche', 'Monat', 'Jahr']);
    await screen.findByRole('group', { name: 'Energie aller Anlagen · Juli 2026' });
    expect(screen.getByText('Gemessen')).toBeInTheDocument();
    // Kein Erklärtext-Kasten mehr: die Erklärung steht im ⓘ der Statuszeile.
    expect(screen.queryByText('Was diese Zahlen sind')).toBeNull();
  });

  it('summiert über die Anlagen und zählt eine Anlage ohne Daten nie als 0', async () => {
    vi.spyOn(api, 'history').mockImplementation((siteId: string) =>
      Promise.resolve(siteId === 'a' ? history(16) : history(null)),
    );
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);
    await screen.findByRole('group', { name: 'Energie aller Anlagen · Juli 2026' });

    expect(nb(kachel('Erzeugung').textContent)).toMatch(/16,0 kWh/);
    // Die Anlage ohne Daten steht mit ihrem Grund in der Liste — nie als 0.
    const liste = screen.getByRole('list', { name: /Erzeugung je Anlage/ });
    const lindenberg = within(liste).getByText('Hof Lindenberg').closest('a') as HTMLElement;
    expect(lindenberg).toHaveTextContent('Keine Messwerte in diesem Zeitraum');
    expect(nb(lindenberg.textContent)).not.toMatch(/0,0 kWh/);
    expect(screen.getByText(/1 von 2 Anlagen mit Messwerten/)).toBeInTheDocument();
  });

  it('öffnet aus einer Zeile DIESELBE Seite DIESER Anlage im GLEICHEN Zeitraum', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);
    const liste = await screen.findByRole('list', { name: /Erzeugung je Anlage/ });
    const link = within(liste).getByText('Solarpark Dachau').closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/anlage/a/messwerte?z=monat&at=2026-07-15');
  });

  it('Tabelle: alle sechs Mengen, Summe über die Anlagen, Zeile öffnet die Anlage', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);
    await screen.findByRole('list', { name: /Erzeugung je Anlage/ });
    fireEvent.click(screen.getByRole('button', { name: 'Tabelle' }));

    const tabelle = screen.getByRole('table');
    expect(within(tabelle).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Anlage',
      'Erzeugung',
      'Verbrauch',
      'Netzbezug',
      'Einspeisung',
      'Speicher geladen',
      'Speicher entladen',
    ]);
    const summe = within(tabelle).getByText('Summe').closest('tr') as HTMLElement;
    expect(nb(summe.textContent)).toMatch(/32,0 kWh/);
    fireEvent.click(within(tabelle).getByRole('button', { name: 'Hof Lindenberg' }));
    expect(window.location.hash).toBe('#/anlage/b/messwerte?z=monat&at=2026-07-15');
  });

  it('bleibt bei einem fehlgeschlagenen Abruf ehrlich statt still', async () => {
    vi.spyOn(api, 'history').mockImplementation((siteId: string) =>
      siteId === 'a' ? Promise.resolve(history(16)) : Promise.reject(new Error('kaputt')),
    );
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    expect(await screen.findByText('Konnte nicht geladen werden')).toBeInTheDocument();
    expect(screen.getByText(/1 nicht geladen/)).toBeInTheDocument();
  });
});

describe('Meine Anlagen · Erlöse', () => {
  beforeEach(() => {
    window.location.hash = '#/portfolio/erloese?z=monat&at=2026-07-15';
  });

  it('bietet KEINE Woche an - der mandantenweite Endpunkt kennt keine', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);

    const seg = screen.getByRole('tablist', { name: 'Zeitraum' });
    expect(within(seg).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Tag', 'Monat', 'Jahr']);
    await screen.findByRole('group', { name: 'Erlöse aller Anlagen · Juli 2026' });
  });

  it('Kennzahlen: Ergebnis aus den drei Posten und die Kachel „VoltPilot-Steuerung"', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);
    await screen.findByRole('group', { name: 'Erlöse aller Anlagen · Juli 2026' });

    // 900 + 99,26 − 40 = 959,26 € (E9 / P9).
    expect(nb(kachel('Ergebnis').textContent)).toMatch(/\+ 959,26 €/);
    expect(nb(kachel('Einspeisung').textContent)).toMatch(/\+ 900,00 €/);
    expect(nb(kachel('Netzbezug').textContent)).toMatch(/− 40,00 €/);
    // ⚠ DIE MESSLATTE IST DERSELBE SPEICHER OHNE SMARTE STEUERUNG: die Kachel
    //   zeigt `savedSteuerungEur`, nie `savedEur` (161,44 €).
    const st = kachel('VoltPilot-Steuerung');
    expect(nb(st.textContent)).toMatch(/\+ 61,44 €/);
    expect(st).toHaveTextContent('mehr als ohne smarte Steuerung');
    expect(nb(document.body.textContent)).not.toMatch(/161,44/);
    // Kein Kontoauszug und kein „davon" mehr.
    expect(screen.queryByText('Kontoauszug')).toBeNull();
    expect(screen.queryByText(/davon/)).toBeNull();
  });

  it('Ergebnis je Anlage: Balken, Mehrwert je Anlage, ehrlicher Grund ohne Ergebnis', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);
    const liste = await screen.findByRole('list', { name: /Ergebnis je Anlage/ });

    const dachau = within(liste).getByText('Solarpark Dachau').closest('a') as HTMLAnchorElement;
    expect(nb(dachau.textContent)).toMatch(/\+ 959,26 €/);
    expect(nb(dachau.textContent)).toMatch(/VoltPilot-Steuerung \+ 61,44 €/);
    expect(dachau.getAttribute('href')).toBe('#/anlage/a/erloese?z=monat&at=2026-07-15');
    const lindenberg = within(liste).getByText('Hof Lindenberg').closest('a') as HTMLElement;
    expect(lindenberg).toHaveTextContent('Noch keine Börsenpreise für den Zeitraum');
  });

  it('Tabelle: alle Posten je Anlage und die Summe, Zeile öffnet die Anlage', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);
    await screen.findByRole('list', { name: /Ergebnis je Anlage/ });
    fireEvent.click(screen.getByRole('button', { name: 'Tabelle' }));

    const tabelle = screen.getByRole('table');
    expect(within(tabelle).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Anlage',
      'Ergebnis',
      'Eigenverbrauch',
      'Einspeisung',
      'Netzbezug',
      'VoltPilot-Steuerung',
    ]);
    const summe = within(tabelle).getByText('Summe').closest('tr') as HTMLElement;
    expect(nb(summe.textContent)).toMatch(/\+ 959,26 €/);
    fireEvent.click(within(tabelle).getByRole('button', { name: 'Solarpark Dachau' }));
    await waitFor(() => expect(window.location.hash).toBe('#/anlage/a/erloese?z=monat&at=2026-07-15'));
  });

  it('sagt ehrlich, wenn im Zeitraum nichts bewertet werden konnte', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue({
      ...earnings,
      sites: [earningsSite({ id: 'a', name: 'Solarpark Dachau', reason: 'no_data' })],
    });
    render(<PortfolioErloese sites={[DACHAU]} />);

    expect(await screen.findByText('Noch kein Ergebnis für diesen Zeitraum')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /Ergebnis je Anlage/ })).toBeNull();
  });
});
