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
  it('zeigt „Was den Preis gemacht hat" nirgends mehr — die Preise stehen in Ebene 2', async () => {
    stub();
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    expect(screen.queryByText('Was den Preis gemacht hat')).toBeNull();
    const ebene2 = document.querySelector('details.vp-e2') as HTMLElement;
    expect(within(ebene2).getByText('Preise & Vergütung')).toBeInTheDocument();
    // Nur die TABELLE — das Glossar darunter nennt dieselben Begriffe noch
    // einmal, dort aber als Erklärung statt als Wert.
    const tabelle = ebene2.querySelector('table.vp-e2t') as HTMLElement;
    for (const label of ['Bezugspreis', 'Monatsmarktwert Solar', 'Anzulegender Wert', 'Speicher']) {
      expect(within(tabelle).getByText(label)).toBeInTheDocument();
    }
  });

  it('zeigt den Planwert als ZEILE des Speicher-Blocks, nicht als Karte', async () => {
    stub();
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    expect(screen.queryByText(/Geplante Speicher-Ersparnis/)).toBeNull();
    const plan = document.querySelector('.vp-spb-plan') as HTMLElement;
    expect(plan.textContent).toMatch(/Vorab geplant hatte der Fahrplan/);
    expect(plan.textContent).toMatch(/9,40/);
    expect(within(plan).getByText('Geplant')).toBeInTheDocument();
    // Die Zeile steht IM Speicher-Block, also innerhalb der Ergebnis-Karte.
    expect(plan.closest('.vp-spb')).toBeTruthy();
  });

  it('lässt die Plan-Zeile ohne Fahrplan weg — nie eine erfundene Null', async () => {
    stub({}, { ...history, totals: { ...history.totals, batterySavingsPlannedEur: null } });
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    expect(document.querySelector('.vp-spb-plan')).toBeNull();
  });
});

describe('B10 · das Geld steht genau einmal', () => {
  it('wiederholt die Zurechnung nicht im Kopf des Tagesbilds', async () => {
    stub();
    render(<ErloeseSection site={site()} surface={SURFACE('direktvermarktung')} onOpenWelt={() => {}} />);
    await screen.findByLabelText('Woraus sich das Ergebnis zusammensetzt');

    // Sie steht im Speicher-Block der Ergebnis-Karte …
    expect(document.querySelector('.vp-spb')).toBeTruthy();
    // … und NUR dort: weder als Kopf-Satz des Tagesbilds noch als Karte.
    expect(screen.queryByText(/hat die Steuerung an diesem Tag/)).toBeNull();
    expect(screen.queryByText(/Ohne Speicher wären es/)).toBeNull();
  });
});
