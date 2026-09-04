import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ErloeseSection } from './ErloeseSection';
import { clearHistoryCache } from '../historyCache';
import { clearEarningsCache } from '../useSiteEarnings';
import { anlageSurface, type AnlageSurface } from '../surface';
import { api, type History, type PlantKind, type Site, type SiteEarnings } from '../api';

/**
 * **P6 · das KARTEN-INVENTAR der Erlöse-Seite** (Konzept
 * `data/vp-erloese-seite-konzept-e2` §3.1, Entscheide E1/E5/E6/E11).
 *
 * Die Seite trug sechs gleichrangige Karten; die Frage-Leiter des Konzepts
 * kennt vier: „Wie viel? → Ist das gut? → Wann? → Was ist passiert?". Zwei
 * Karten sind darin AUFGEGANGEN, nicht verschwunden:
 *
 *   - „Was den Preis gemacht hat" → Ebene 2 der Ergebnis-Karte (E5),
 *   - „Geplante Speicher-Ersparnis" → Zeile 4 des Speicher-Blocks (E6).
 *
 * Dieser Test ist der Wächter über die REIHENFOLGE und die MENGE — er rendert
 * die echte Seite je Anlagenart (Direktvermarktung / EEG) und Zeitraum
 * (Tag / Monat). Was die einzelnen Ableitungen sagen, nageln
 * `erloesKomposition.test.ts` und `erloesEbenen.test.ts` fest.
 */

vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));
vi.mock('../components/Tagesbild', () => ({ Tagesbild: () => <div data-testid="day-chart" /> }));

const NOW = new Date('2026-09-02T12:19:00+02:00');

function site(over: Partial<Site> = {}): Site {
  return {
    id: 's-1',
    name: 'Testanlage',
    biddingZone: 'DE-LU',
    latitude: null,
    longitude: null,
    plantKind: 'direktvermarktung',
    anzulegenderWertCtKwh: 8.11,
    tarifArt: 'fest',
    tarifParamCtKwh: 25,
    netzladenErlaubt: false,
    maxFeedInKw: null,
    ...over,
  };
}

const SURFACE = (plantKind: PlantKind): AnlageSurface =>
  anlageSurface({
    entities: [
      {
        id: 'batt',
        entityType: 'battery-hybrid',
        capabilities: { measure: [{ channel: 'soc_pct' }] },
      },
    ],
    config: { plantKind, tarifArt: 'fest' },
  });

function money(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return {
    siteId: 's-1',
    name: 'Testanlage',
    range: 'day',
    from: '2026-09-01T22:00:00Z',
    to: '2026-09-02T22:00:00Z',
    plantKind: 'direktvermarktung',
    tarifArt: 'fest',
    tarifParamCtKwh: 25,
    tarifPriced: true,
    anzulegenderWertCtKwh: 8.11,
    coveredSlots: 96,
    firstCoveredDate: '2026-06-19',
    reason: null,
    einspeiseErloesEur: 26.134,
    eigenverbrauchsWertEur: 38.684,
    stromkostenEur: 1.585,
    nettoErgebnisEur: 63.233,
    savedEur: 2.67,
    // ⚠ Die Kundenfläche zeigt seit dem 04.09.2026 `savedSteuerungEur` gegen
    //   DENSELBEN Speicher ohne smarte Steuerung.
    savedSpeicherEur: 1.22,
    savedSteuerungEur: 1.45,
    steuerungSplitReason: null,
    savedSpeicherEur: 1.22,
    savedSteuerungEur: 1.45,
    arbitrageEur: null,
    pvShiftEur: null,
    baselineEur: 4.1,
    actualEur: 1.43,
    marktpraemieEur: 4.79,
    bezugspreisCtKwh: 25,
    realizedExportCtKwh: 6.18,
    marketValueSolarCtKwh: 5.8,
    marketValueProvisional: true,
    bezogenKwh: 6.3,
    eingespeistKwh: 345.2,
    selbstverbrauchKwh: 154.7,
    batterieBewegtKwh: 40,
    gesamtertragEur: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: [
      {
        start: '2026-09-02T08:00:00Z',
        einspeiseErloesEur: 12,
        eigenverbrauchsWertEur: 20,
        stromkostenEur: 0.5,
        nettoEur: 31.5,
      },
      {
        start: '2026-09-02T09:00:00Z',
        einspeiseErloesEur: 14.134,
        eigenverbrauchsWertEur: 18.684,
        stromkostenEur: 1.085,
        nettoEur: 31.733,
      },
    ],
    peakShaving: null,
    ...over,
  };
}

const history: History = {
  range: 'day',
  from: '',
  to: '',
  bucketMinutes: 15,
  buckets: [],
  totals: {
    consumptionKwh: 4,
    pvGenerationKwh: 9,
    gridImportKwh: 1,
    gridExportKwh: 3,
    gridCostEur: 0.3,
    tarifArt: 'fest',
    batterySavingsPlannedEur: 9.4,
    // ⚠ Die Plan-Zeile hängt NUR hieran; `batterySavingsPlannedEur` misst
    //   gegen „ohne Speicher" und ist eine Betreiber-Zahl.
    steuerungPlannedEur: 3.2,
    autarkiePct: 0.7,
    eigenverbrauchPct: 0.6,
  },
  protocol: [],
  plan: [],
};

/** Die Kartenköpfe der Seite, in DOM-Reihenfolge. */
function kartenKoepfe(): string[] {
  return Array.from(document.querySelectorAll('.vp-welt-body h2')).map((h) =>
    (h.textContent ?? '').trim(),
  );
}

function stub(over: Partial<SiteEarnings> = {}, hist: History | null = history) {
  if (hist) vi.spyOn(api, 'history').mockResolvedValue(hist);
  else vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie'));
  vi.spyOn(api, 'siteEarnings').mockResolvedValue(money(over));
}

beforeEach(() => {
  window.location.hash = '';
  clearHistoryCache();
  clearEarningsCache();
  vi.restoreAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  // Schreibtisch-Breite: die vier Karten stehen offen da.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('E1 · vier Karten in der Reihenfolge der Frage-Leiter', () => {
  it('Direktvermarktung am TAG: Ergebnis → So verdient → Verlauf → Tag im Bild', async () => {
    stub();
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    const koepfe = kartenKoepfe();
    expect(koepfe[0]).toMatch(/^Ergebnis/);
    expect(koepfe[1]).toMatch(/So verdient Ihre Anlage/);
    expect(koepfe[2]).toMatch(/^Geld im Verlauf/);
    expect(koepfe[3]).toBe('Der Tag im Bild');
    expect(koepfe[4]).toBe('Tagesprotokoll');
    expect(koepfe).toHaveLength(5);
  });

  it('EEG am TAG: dieselbe Leiter OHNE die Markt-Karte (E11 / Befund B9)', async () => {
    stub({ plantKind: 'eigenverbrauch', exportVerguetungPriced: true });
    render(
      <ErloeseSection
        site={site({ plantKind: 'eigenverbrauch' })}
        surface={SURFACE('eigenverbrauch')}
        onOpenWelt={() => {}}
      />,
    );
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    expect(kartenKoepfe()).toEqual([
      expect.stringMatching(/^Ergebnis/),
      expect.stringMatching(/^Geld im Verlauf/),
      'Der Tag im Bild',
      'Tagesprotokoll',
    ]);
    // Und der Verdikt-Satz gegen den Monatsdurchschnitt fehlt ganz — für eine
    // feste Vergütung wäre er ein Minderertrag, den es nicht gibt.
    expect(screen.queryByText(/Monatsdurchschnitt/)).toBeNull();
  });

  it('MONAT: der Tagesnachweis entfällt, der Rest bleibt in Reihenfolge', async () => {
    window.location.hash = '#/anlage/s-1/erloese?z=monat';
    stub({ range: 'month' });
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    const koepfe = kartenKoepfe();
    expect(koepfe[0]).toMatch(/^Ergebnis/);
    expect(koepfe[1]).toMatch(/So verdient Ihre Anlage/);
    expect(koepfe[2]).toMatch(/^Geld im Verlauf/);
    expect(koepfe).toHaveLength(3);
  });
});

describe('E5/E6 · die zwei absorbierten Karten', () => {
  it('zeigt „Was den Preis gemacht hat" nirgends mehr — die Preise stehen in der Preise-Zeile', async () => {
    stub();
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    expect(screen.queryByText('Was den Preis gemacht hat')).toBeNull();
    // Anatomie C (§3.10 (4)): „Preise & Vergütung" ist eine EIGENE flache
    // Karte, keine vierte Zeile in einer fremden.
    const preise = document.querySelector('details.vp-c-preise') as HTMLElement;
    expect(within(preise).getByText('Preise & Vergütung')).toBeInTheDocument();
    // Nur die TABELLE — das Glossar darunter nennt dieselben Begriffe noch
    // einmal, dort aber als Erklärung statt als Wert.
    const tabelle = preise.querySelector('table.vp-e2t') as HTMLElement;
    for (const label of ['Bezugspreis', 'Monatsmarktwert Solar', 'Anzulegender Wert', 'Speicher']) {
      expect(within(tabelle).getByText(label)).toBeInTheDocument();
    }
  });

  it('zeigt den Planwert als SCHRITT der Speicher-Rechnung, nicht als Karte (E6)', async () => {
    stub();
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    expect(screen.queryByText(/Geplante Speicher-Ersparnis/)).toBeNull();
    // E6 aus Runde 1, in u3 §3.2 (6) wiederhergestellt: der Planwert steht
    // direkt hinter der Rechnung, mit der er sich vergleicht — also IM
    // Aufklapper der Speicher-Karte, nie neben lauter gemessenen Zahlen.
    const speicher = document.querySelector('.vp-c-speicher') as HTMLElement;
    expect(speicher).toBeTruthy();
    const plan = within(speicher).getByText(/^Fahrplan:/).closest('li') as HTMLElement;
    // ⚠ Die Zahl ist `steuerungPlannedEur` — der geplante Mehrwert DER
    //   STEUERUNG; `batterySavingsPlannedEur` (9,40 €) misst gegen „ohne
    //   Speicher" und erreicht die Kundenfläche nicht mehr.
    expect(plan.textContent).toMatch(/3,20/);
    expect(plan.textContent).not.toMatch(/9,40/);
    expect(plan.textContent).toMatch(/Mehrwert der Steuerung/);
    expect(plan.textContent).toMatch(/eine Plan-Zahl, keine Messung/);
    // … und zwar im Aufklapper, nicht auf Ebene 0.
    expect(plan.closest('details.vp-formel')).toBeTruthy();
  });

  it('lässt die Plan-Zeile ohne Fahrplan weg — nie eine erfundene Null', async () => {
    stub({}, { ...history, totals: { ...history.totals, steuerungPlannedEur: null } });
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    const speicher = document.querySelector('.vp-c-speicher') as HTMLElement;
    expect(speicher).toBeTruthy();
    expect(within(speicher).queryByText(/^Fahrplan:/)).toBeNull();
  });
});

describe('B10 · das Geld steht genau einmal', () => {
  it('wiederholt die Zurechnung nicht im Kopf des Tagesbilds', async () => {
    stub();
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    // Sie steht in der Speicher-Karte …
    expect(document.querySelector('.vp-c-speicher')).toBeTruthy();
    // … und NUR dort: weder als Kopf-Satz des Tagesbilds noch als Karte.
    expect(screen.queryByText(/hat die Steuerung an diesem Tag/)).toBeNull();
    expect(screen.queryByText(/Ohne Speicher wären es/)).toBeNull();
  });
});

/* ⚠ Die LASTSPITZEN-Zeile gehört einer EIGENEN Abrechnungsperiode und geht nie
   in die grosse Zahl ein (u3 §3.2 „Lastspitzen-Zeile"). Sie steht deshalb
   AUSSERHALB des Wasserfalls, mit ihrem Perioden-Etikett — und der Nebensatz,
   der das erklärt, kostet auf Ebene 0 nichts mehr: er wohnt im ⓘ. */
describe('Lastspitzen · eigene Periode, nie im Wasserfall', () => {
  const PEAK_SURFACE = anlageSurface({
    entities: [
      {
        id: 'batt',
        entityType: 'battery-hybrid',
        capabilities: { measure: [{ channel: 'soc_pct' }] },
      },
    ],
    config: { plantKind: 'direktvermarktung', tarifArt: 'fest', leistungspreisEurKw: 120 },
  });

  it('steht neben dem Kontoauszug, nennt ihre Periode und erklärt sich erst im ⓘ', async () => {
    stub({
      peakShaving: {
        leistungspreisEurKw: 120,
        abrechnungLeistung: 'jahr',
        periodStart: '2026-01-01',
        avoidedKw: 10.04,
        avoidedEur: 1204,
        measuredPeakKw: 61.2,
        baselinePeakKw: 71.24,
        history: [],
      },
    } as Partial<SiteEarnings>);
    render(<ErloeseSection site={site()} surface={PEAK_SURFACE} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    const extra = document.querySelector('.vp-c-led-extra') as HTMLElement;
    expect(extra).toBeTruthy();
    expect(extra).toHaveAttribute('aria-label', 'Ausserhalb des Zeitraum-Ergebnisses');
    // … und sie ist NICHT Teil des Wasserfalls.
    const auszug = screen.getByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(auszug).not.toBe(extra);
    expect(within(auszug).queryByText(/Vermiedene Leistungskosten/)).toBeNull();

    expect(within(extra).getByText(/Vermiedene Leistungskosten/)).toBeInTheDocument();
    expect(extra.textContent).toMatch(/eigene Periode, nicht im Ergebnis/);
    // Der ERKLÄRSATZ steht im ⓘ, nicht auf Ebene 0 (B6/§3.12).
    expect(screen.queryByText(/werden getrennt ausgewiesen/)).toBeNull();
    expect(
      within(extra).getByRole('button', { name: 'Warum steht das getrennt?' }),
    ).toBeInTheDocument();
  });
});
