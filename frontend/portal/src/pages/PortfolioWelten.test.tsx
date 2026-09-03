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

  it('trägt seit E3 KEINE Welt-Kopf-Karte mehr und hält den Streifen im ⋯-Blatt', async () => {
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    const { container } = render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    // E3/E12: der Kopf ist eine unsichtbare Überschrift — die Icon-Kachel und
    // die Karte sind weg, der Kontext-Satz reist IN der Überschrift mit.
    const kopf = screen.getByRole('heading', { level: 1, name: /Messwerte/ });
    expect(kopf).toHaveClass('vp-sr-only');
    expect(kopf).toHaveTextContent('2 Anlagen · Juli 2026');
    expect(container.querySelector('.vp-welt-kopf')).toBeNull();

    // E3: der Monatsstreifen war die zweite Zeile der Leiste — er wohnt jetzt
    // hinter dem ⋯-Knopf, damit die Leiste EINE Zeile bleibt.
    const leiste = container.querySelector('.vp-zeitleiste') as HTMLElement;
    expect(within(leiste).queryByLabelText('Monat anspringen')).toBeNull();
    fireEvent.click(within(leiste).getByRole('button', { name: /Zeitraum & Monat/ }));
    expect(screen.getByLabelText('Monat anspringen')).toBeInTheDocument();
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

  it('führt mit dem Statement, dem Kontoauszug und der Speicher-Karte (Variante C, P6)', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);

    // DIE EINE ZAHL — das `Statement` der Variante C, ohne Rahmen auf dem
    // Grund (§3.10 Punkt 7: „Portfolio trägt dasselbe Kleid"). Sie ist seit
    // E9/P9 das Ergebnis UNTERM STRICH und IST die Summe der drei Teile
    // (900 + 99,26 − 40); sie steht oben UND in der Zeile ihrer Anlage,
    // deshalb wird sie gezielt im Statement gesucht.
    expect(
      await screen.findByText('+ 959,26 €', { selector: '.vp-c-stm-zahl' }),
    ).toBeInTheDocument();
    // Das Label IST die Überschrift der Fläche (die Versalien macht das CSS).
    expect(screen.getByRole('heading', { name: /Unterm Strich · Juli 2026/ })).toBeInTheDocument();
    // Der Satz nennt zusätzlich, über wie viele Anlagen summiert wurde — und
    // zählt nur die BEITRAGENDEN (die zweite Anlage fehlt in der Summe).
    expect(screen.getByText('Juli 2026 unterm Strich · 1 Anlage')).toBeInTheDocument();

    // DER KONTOAUSZUG — vier Zeilen mit Balken statt der früheren Prosa-Liste
    // (Befund B13 „die drei Teile als Prosa").
    const teile = screen.getByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(teile).toHaveTextContent('Einspeise-Erlös');
    expect(teile).toHaveTextContent('+ 900,00 €');
    expect(teile).toHaveTextContent('Eigenverbrauch');
    expect(teile).toHaveTextContent('Netzbezug');
    expect(teile).toHaveTextContent('− 40,00 €');
    expect(teile).toHaveTextContent('Ergebnis');

    // DIE SPEICHER-KARTE — der Wortlaut ist „Speicher", nicht „durch
    // VoltPilots Steuerung" (Befund B13: `savedEur` ist der Wert des GANZEN
    // Speichersystems).
    expect(screen.getByText('Speicher im Zeitraum')).toBeInTheDocument();
    // Der Betrag steht auch in der Tabellenzeile der Anlage — hier gezielt in
    // der Karte gesucht.
    expect(
      screen.getByText('+ 161,44 €', { selector: '.vp-c-sp-wert' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/durch VoltPilots Steuerung/)).toBeNull();
    // Statt einer erfundenen Flotten-Aufteilung der Ort, an dem sie steht.
    expect(screen.getByText('je Anlage in der Tabelle')).toBeInTheDocument();
    expect(screen.queryByText('davon Steuerung')).toBeNull();

    // Und die Anlage ohne bewertete Viertelstunde nennt ihren Grund - UND sie
    // wird an der Summe genannt, statt still als 0 mitgezählt zu werden.
    expect(screen.getByText('Noch keine Börsenpreise für den Zeitraum.')).toBeInTheDocument();
    expect(
      screen.getByText(/Für eine Anlage liegt in diesem Zeitraum noch kein Ergebnis vor/),
    ).toBeInTheDocument();
    expect(screen.getByText('1 von 2 Anlagen mit Daten in diesem Zeitraum')).toBeInTheDocument();
  });

  it('nennt die Speicher-Spalte „Speicher" und zeigt am Schreibtisch alle vier Spalten', async () => {
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);

    // ⚠ Befund B13: die Spalte hiess „Durch Steuerung" — dieselbe Zahl, die
    //   die Karte darüber „Speicher" nennt. Ein Wort je Zahl.
    const kopf = await screen.findByRole('columnheader', { name: 'Speicher' });
    expect(kopf).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Durch Steuerung' })).toBeNull();

    // ⚠ Seit P8 (E6 a) fällt am Telefon KEINE Spalte mehr weg: die frühere
    //   Notlösung `.vp-pf-col-kwh` („Eingespeist unter 720 px ausblenden")
    //   gehörte der Tabellen-Klappform. Die Liste trägt alle Werte in ihrer
    //   Sekundärzeile — die Klasse ist ersatzlos entfallen.
    expect(document.querySelectorAll('.vp-pf-col-kwh').length).toBe(0);
    expect(screen.getByRole('columnheader', { name: 'Eingespeist' })).toBeInTheDocument();
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

/**
 * **E6 · die Weiche Liste/Tabelle** (Captain-Entscheid 03.09.2026, wörtlich:
 * „a) am Telefon immer Liste (V7), ab 700 px Tabelle").
 *
 * Ohne `matchMedia` sagt `useIsPhone` „Schreibtisch" — die übrigen Tests
 * dieser Datei prüfen deshalb unverändert die Tabelle. Dieser Block stubbt
 * das Telefon ausdrücklich und prüft den ZWEITEN Baum aus DENSELBEN Daten.
 */
function stubPhone(matches: boolean) {
  const mql = {
    matches,
    media: '(max-width: 720px)',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => mql,
  });
}

describe('Portfolio · E6 · am Telefon Liste, ab 721 px Tabelle', () => {
  beforeEach(() => stubPhone(true));
  afterEach(() => {
    // Die Attrappe darf keine andere Datei erreichen.
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  });

  it('Messwerte: keine `table`, sondern eine Liste mit ALLEN vier Spalten', async () => {
    window.location.hash = '#/portfolio/messwerte?z=monat&at=2026-07-15';
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    const { container } = render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    const liste = await screen.findByLabelText('Anlagen');
    expect(container.querySelector('table')).toBeNull();

    // Der führende Wert steht rechts, die übrigen drei als Etikett/Wert-Paare
    // darunter — kein `data-label`, also auch keine erfundene Tabellen-Semantik.
    const zeile = within(liste).getByRole('link', { name: /Hof Lindenberg/ });
    expect(zeile).toHaveAttribute('href', '#/anlage/b/messwerte?z=monat&at=2026-07-15');
    for (const etikett of ['Verbraucht', 'Bezogen', 'Eingespeist']) {
      expect(within(liste).getAllByText(etikett).length).toBeGreaterThan(0);
    }
    expect(liste.querySelectorAll('[data-label]').length).toBe(0);
  });

  it('Erlöse: keine `table`, und „Eingespeist" fällt am Telefon NICHT mehr weg', async () => {
    window.location.hash = '#/portfolio/erloese?z=monat&at=2026-07-15';
    vi.spyOn(api, 'earnings').mockResolvedValue(earnings);
    const { container } = render(<PortfolioErloese sites={[DACHAU, LINDENBERG]} />);

    const liste = await screen.findByLabelText('Anlagen');
    expect(container.querySelector('table')).toBeNull();
    expect(within(liste).getAllByText('Eingespeist').length).toBeGreaterThan(0);
  });

  it('ab 721 px ist es dieselbe Zeile als echte Tabelle', async () => {
    stubPhone(false);
    window.location.hash = '#/portfolio/messwerte?z=monat&at=2026-07-15';
    vi.spyOn(api, 'history').mockResolvedValue(history(16));
    const { container } = render(<PortfolioMesswerte sites={[DACHAU, LINDENBERG]} />);

    await screen.findByRole('columnheader', { name: 'Erzeugt' });
    expect(container.querySelector('table.vp-c-pft')).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Hof Lindenberg' }),
    ).toHaveAttribute('href', '#/anlage/b/messwerte?z=monat&at=2026-07-15');
  });
});
