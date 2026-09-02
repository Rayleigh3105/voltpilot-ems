import { describe, expect, it, vi, beforeEach } from 'vitest';
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

describe('Portfolio · Welt A „Messwerte"', () => {
  it('führt mit dem Welt-Kopf der Ebene und der Zeit-Leiste', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    const kopf = screen.getByRole('heading', { level: 1, name: /Messwerte/ });
    expect(kopf).toHaveTextContent('Portfolio');
    expect(screen.getByText(/2 Anlagen · Juli 2026/)).toBeInTheDocument();
    // Alle vier Zeiträume - die Messwerte-Welt kann sie alle beantworten.
    const seg = screen.getByRole('tablist', { name: 'Zeitraum' });
    expect(within(seg).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Tag',
      'Woche',
      'Monat',
      'Jahr',
    ]);
    await screen.findByLabelText('Energiemengen aller Anlagen');
  });

  it('summiert über die Anlagen und zählt eine Anlage ohne Daten nie als 0', async () => {
    vi.spyOn(api, 'history').mockImplementation((siteId: string) =>
      Promise.resolve(history(siteId === 'a' ? 16 : null)),
    );
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    const summen = await screen.findByLabelText('Energiemengen aller Anlagen');
    // 16 kWh der EINEN messenden Anlage - kein Mittel über zwei.
    expect(summen).toHaveTextContent('16 kWh');
    // Und die Summe sagt, worüber sie spricht.
    expect(
      await screen.findByText('1 von 2 Anlagen mit Daten in diesem Zeitraum'),
    ).toBeInTheDocument();
    // Die stille Anlage steht mit ihrem Grund in der Tabelle.
    expect(screen.getByText('Keine Messwerte in diesem Zeitraum.')).toBeInTheDocument();
  });

  it('öffnet aus einer Zeile DIESELBE Welt DIESER Anlage im GLEICHEN Zeitraum', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    const link = await screen.findByRole('link', { name: 'Hof Lindenberg' });
    // Der Link trägt Welt UND Zeitraum - Mittelklick/neuer Tab landen richtig.
    expect(link).toHaveAttribute('href', '#/anlage/b/messwerte?z=monat&at=2026-07-15');
    fireEvent.click(link);
    await waitFor(() =>
      expect(window.location.hash).toBe('#/anlage/b/messwerte?z=monat&at=2026-07-15'),
    );
  });

  it('rendert im Welt-Kopf keine zweite Messwerte/Erlöse-Navigation', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    expect(screen.queryByRole('group', { name: 'Ansicht wechseln' })).toBeNull();
    await screen.findByLabelText('Energiemengen aller Anlagen');
  });

  it('bleibt bei einem fehlgeschlagenen Abruf ehrlich statt still', async () => {
    vi.spyOn(api, 'history').mockImplementation((siteId: string) =>
      siteId === 'a' ? Promise.resolve(history(16)) : Promise.reject(new Error('kaputt')),
    );
    render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    expect(await screen.findByText('Konnte nicht geladen werden.')).toBeInTheDocument();
    expect(
      screen.getByText(/1 Anlage konnte nicht geladen werden/),
    ).toBeInTheDocument();
  });
});

describe('Portfolio · Welt B „Erlöse"', () => {
  beforeEach(() => {
    window.location.hash = '#/portfolio/erloese?z=monat&at=2026-07-15';
  });

  it('bietet KEINE Woche an - der mandantenweite Endpunkt kennt keine', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);

    const seg = screen.getByRole('tablist', { name: 'Zeitraum' });
    expect(within(seg).getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Tag',
      'Monat',
      'Jahr',
    ]);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');
  });

  it('führt mit der Summe, ihren Teilen und der Zurechnung der Steuerung', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);

    // Die große Zahl ist seit E9 / P9 das Ergebnis UNTERM STRICH - dieselbe
    // Größe, die die Anlagen-Seite zeigt, in die ein Klick auf eine Zeile
    // führt - und sie IST die Summe der drei gezeigten Teile
    // (900 + 99,26 - 40). Sie steht oben UND in der Zeile ihrer Anlage,
    // deshalb wird sie hier gezielt in der Summenzeile gesucht.
    expect(await screen.findByText(/959,26 €/, { selector: '.vp-pf-summe' })).toBeInTheDocument();
    expect(screen.getByText('Unterm Strich im Zeitraum')).toBeInTheDocument();
    const teile = screen.getByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(teile).toHaveTextContent('Einspeise-Erlös');
    expect(teile).toHaveTextContent('900,00 €');
    expect(teile).toHaveTextContent('Wert des Eigenverbrauchs');
    expect(teile).toHaveTextContent('Stromkosten (Netzbezug)');
    expect(teile).toHaveTextContent('− 40,00 €');
    // Die Steuerung ist eine ZURECHNUNG unter der Zahl, nie ein Summand.
    expect(screen.getByText(/davon 161,44 € durch VoltPilots Steuerung/)).toBeInTheDocument();
    // Und die Anlage ohne bewertete Viertelstunde nennt ihren Grund - UND sie
    // wird an der Summe genannt, statt still als 0 mitgezählt zu werden.
    expect(screen.getByText('Noch keine Börsenpreise für den Zeitraum.')).toBeInTheDocument();
    expect(
      screen.getByText(/Für eine Anlage liegt in diesem Zeitraum noch kein Ergebnis vor/),
    ).toBeInTheDocument();
    expect(screen.getByText('1 von 2 Anlagen mit Daten in diesem Zeitraum')).toBeInTheDocument();
  });

  it('öffnet aus einer Zeile die Erlöse-Welt DIESER Anlage im gleichen Zeitraum', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);

    const link = await screen.findByRole('link', { name: 'Solarpark Dachau' });
    expect(link).toHaveAttribute('href', '#/anlage/a/erloese?z=monat&at=2026-07-15');
    fireEvent.click(link);
    await waitFor(() =>
      expect(window.location.hash).toBe('#/anlage/a/erloese?z=monat&at=2026-07-15'),
    );
  });

  it('sagt ehrlich, wenn im Zeitraum nichts bewertet werden konnte', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue({
      ...earnings,
      sites: [earningsSite({ id: 'a', name: 'Solarpark Dachau', reason: 'no_data' })],
    });
    render(<PortfolioErloese sites={[DACHAU]} />);

    expect(await screen.findByText('Noch kein Ergebnis für diesen Zeitraum')).toBeInTheDocument();
    expect(screen.queryByLabelText('Woraus sich das Ergebnis zusammensetzt')).toBeNull();
  });
});
