import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MesswerteSection } from './MesswerteSection';
import { ErloeseSection } from './ErloeseSection';
import { clearHistoryCache } from '../historyCache';
import { clearEarningsCache } from '../useSiteEarnings';
import { isoDate, shiftAnchor } from '../periodNav';
import { anlageSurface, type AnlageSurface } from '../surface';
import { api, type History, type Site, type SiteEarnings } from '../api';

/**
 * **Die Mobil-Fassungen beider Historie-Welten** (Konzept
 * `data/vp-mobile-views-x1` §5/§6, Captain-Abnahme 09.08.2026).
 *
 * Sie prüfen die STRUKTUR, die der gemessene Befund verlangt — Diagramm im
 * ersten Bildschirm, zwei klebende Bedienzeilen, Gelegenheits-Bedienung im
 * ⋯-Blatt, Erklärendes als benannte Aufklapper — und ausdrücklich die drei
 * Ehrlichkeitsregeln, die dabei nicht verloren gehen dürfen: das Abzeichen
 * bleibt, ein gesetzter Vergleich bleibt SICHTBAR, und die geplante Ersparnis
 * bleibt als „Geplant" gerahmt.
 *
 * Die Desktop-Fassung prüft `HistorieWelten.test.tsx` — ohne `matchMedia`
 * (jsdom-Vorgabe) antwortet `useIsPhone` `false`, deshalb messen die dortigen
 * Tests unverändert den Schreibtisch.
 */

vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));
vi.mock('../components/Tagesbild', () => ({
  Tagesbild: () => <div data-testid="day-chart" />,
}));
vi.mock('../HistoryChart', () => ({
  HistoryEnergieChart: () => <div data-testid="energie-chart" />,
}));

const site: Site = {
  id: 's-1',
  name: 'Testanlage',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: 6.9,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

const MARKT: AnlageSurface = anlageSurface({
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
  ],
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
});

function bucket(start: string, pv: number, load: number) {
  return {
    start,
    pvKwh: pv,
    loadKwh: load,
    gridImportKwh: 0.5,
    gridExportKwh: 1.5,
    batteryChargeKwh: 2,
    batteryDischargeKwh: 1,
    socMinPct: 70,
    socMaxPct: 76,
    socLastPct: 76,
    priceEurMwh: 80,
    costEur: 0,
  };
}

const history: History = {
  range: 'day',
  from: '',
  to: '',
  bucketMinutes: 15,
  buckets: [bucket('2026-07-24T10:00:00Z', 2.5, 0.5), bucket('2026-07-24T10:15:00Z', 1.5, 0.75)],
  totals: {
    consumptionKwh: 1.25,
    pvGenerationKwh: 4,
    gridImportKwh: 1,
    gridExportKwh: 3,
    gridCostEur: 0.06,
    tarifArt: 'dynamisch',
    batterySavingsPlannedEur: 4.12,
    autarkiePct: 64,
    eigenverbrauchPct: 21,
  },
  protocol: [
    {
      type: 'batterie-laden',
      start: '2026-07-24T10:00:00Z',
      end: '2026-07-24T10:15:00Z',
      text: 'Speicher geladen.',
      energyKwh: 2,
      avgPriceEurMwh: 80,
      avoidedCostEur: null,
      peakKw: null,
    },
  ],
  plan: [],
  coverage: {
    firstDataAt: '2026-06-19T12:00:00Z',
    lastDataAt: '2026-07-30T11:45:00Z',
    expectedFrom: '2026-06-30T22:00:00Z',
    expectedTo: '2026-07-30T11:45:00Z',
    expectedBuckets: 2000,
    measuredBuckets: 1880,
    gaps: 6,
    resolutionMinutes: 15,
  },
};

/** Dieselbe Anlage einen Tag früher — die Vorperiode für das eine Δ. */
const historyVorher: History = {
  ...history,
  buckets: [bucket('2026-07-23T10:00:00Z', 2, 0.5), bucket('2026-07-23T10:15:00Z', 1, 0.75)],
  totals: { ...history.totals, pvGenerationKwh: 3 },
};

const money: SiteEarnings = {
  siteId: 's-1',
  name: 'Testanlage',
  range: 'day',
  from: '2026-07-24T00:00:00Z',
  to: '2026-07-25T00:00:00Z',
  plantKind: 'direktvermarktung',
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  tarifPriced: true,
  anzulegenderWertCtKwh: 6.9,
  coveredSlots: 96,
  firstCoveredDate: '2026-06-19',
  reason: null,
  einspeiseErloesEur: 7.03,
  eigenverbrauchsWertEur: 3.57,
  stromkostenEur: 0.76,
  nettoErgebnisEur: 9.84,
  savedEur: 2.07,
  arbitrageEur: null,
  pvShiftEur: null,
  baselineEur: 5,
  actualEur: -9.84,
  marktpraemieEur: 0,
  bezugspreisCtKwh: 32.5,
  realizedExportCtKwh: 8.88,
  marketValueSolarCtKwh: 5.92,
  marketValueProvisional: true,
  bezogenKwh: 12.3,
  eingespeistKwh: 95.7,
  selbstverbrauchKwh: 9.7,
  batterieBewegtKwh: 41.2,
  gesamtertragEur: 10.6,
  expectedMarketValueSolarCtKwh: null,
  expectedMarketValueFrom: null,
  expectedMarketValueTo: null,
  expectedMarketValueSlots: null,
  series: [
    {
      start: '2026-07-24T10:00:00Z',
      einspeiseErloesEur: 3,
      eigenverbrauchsWertEur: 1,
      stromkostenEur: 0.4,
      nettoEur: 3.6,
    },
  ],
  peakShaving: null,
};

/**
 * Die Telefon-Grenze. `useIsPhone` fragt genau `(max-width: 720px)`; ohne diese
 * Attrappe ist `window.matchMedia` in jsdom gar nicht definiert und die Fläche
 * rendert (korrekt) den Schreibtisch.
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

beforeEach(() => {
  window.location.hash = '';
  clearHistoryCache();
  clearEarningsCache();
  vi.restoreAllMocks();
  stubPhone(true);
});

afterEach(() => {
  // Die Attrappe darf keine andere Datei erreichen.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

/**
 * Der Anker ist „jetzt" (kein Deep-Link), die Vergleichsperiode also der
 * gestrige Tag — beide Daten werden HIER gerechnet statt hartkodiert, damit der
 * Test nicht an einem bestimmten Kalendertag hängt.
 */
const HEUTE = isoDate(new Date());
const GESTERN = isoDate(shiftAnchor(new Date(), 'day', -1));

function stubHistory() {
  return vi.spyOn(api, 'history').mockImplementation(async (_id, _range, at) =>
    at === GESTERN ? historyVorher : history,
  );
}

async function renderMesswerte() {
  stubHistory();
  render(<MesswerteSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
  await screen.findByTestId('energie-chart');
}

async function renderErloese() {
  stubHistory();
  vi.spyOn(api, 'siteEarnings').mockResolvedValue(money);
  render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
  await screen.findByText('+ 9,84 €');
}

describe('Mobil · Messwerte führt mit dem DIAGRAMM (P3)', () => {
  it('stellt das Diagramm VOR die kWh-Summen — am Schreibtisch bleibt es umgekehrt', async () => {
    await renderMesswerte();
    const chart = screen.getByTestId('energie-chart');
    const summen = screen.getByLabelText('Energiemengen im Zeitraum');
    // `compareDocumentPosition` liest die echte DOM-Reihenfolge, nicht nur die
    // optische: ein Screenreader muss dieselbe Seite lesen wie das Auge.
    expect(
      chart.compareDocumentPosition(summen) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('zeigt alle sechs Summen — nur enger, nichts fällt weg', async () => {
    await renderMesswerte();
    const liste = screen.getByLabelText('Energiemengen im Zeitraum');
    for (const label of ['Erzeugt', 'Verbraucht', 'Bezogen', 'Eingespeist', 'Geladen', 'Entladen']) {
      expect(within(liste).getByText(label)).toBeInTheDocument();
    }
  });

  it('fasst die sechs Δ-Zeilen zu EINER zusammen, die ihre Größe NENNT', async () => {
    await renderMesswerte();
    // Die Vorperiode erzeugte 3 kWh, dieser Tag 4 → +33 % auf „Erzeugt".
    expect(HEUTE).not.toEqual(GESTERN);
    const meta = await screen.findByText(/33 % mehr als am Vortag/);
    expect(meta.closest('.vp-esum-meta')).toBeTruthy();
    expect(screen.getByText(/Erzeugt/, { selector: '.vp-esum-meta-delta' })).toBeInTheDocument();
    // Genau EINE Δ-Zeile auf der ganzen Fläche - nicht sechs.
    expect(document.querySelectorAll('.vp-delta')).toHaveLength(1);
  });
});

describe('Mobil · die klebende Bedienzeile hat GENAU ZWEI Zeilen (P4)', () => {
  it('trägt Perioden + ⋯ oben und ‹ Zeitraum › Heute darunter', async () => {
    await renderMesswerte();
    const leiste = document.querySelector('.vp-zeitleiste-mobil');
    expect(leiste).toBeTruthy();
    expect(leiste!.querySelectorAll(':scope > .vp-zl-row')).toHaveLength(2);
    expect(within(leiste as HTMLElement).getByRole('tab', { name: 'Tag' })).toBeInTheDocument();
    expect(
      within(leiste as HTMLElement).getByRole('button', { name: 'Zeitraum & Vergleich' }),
    ).toBeInTheDocument();
    expect(
      within(leiste as HTMLElement).getByRole('button', { name: 'Vorheriger Zeitraum' }),
    ).toBeInTheDocument();
  });

  it('hält Sprungfeld, Vergleichen und Abdeckung aus der Leiste heraus …', async () => {
    await renderMesswerte();
    const leiste = document.querySelector('.vp-zeitleiste-mobil') as HTMLElement;
    expect(within(leiste).queryByLabelText('Tag wählen')).toBeNull();
    expect(within(leiste).queryByText('Vergleichen')).toBeNull();
    expect(leiste.querySelector('.vp-zl-cover')).toBeNull();
  });

  it('… und zeigt sie ALLE im ⋯-Blatt', async () => {
    await renderMesswerte();
    fireEvent.click(screen.getByRole('button', { name: 'Zeitraum & Vergleich' }));
    const blatt = await screen.findByRole('dialog', { name: 'Zeitraum & Vergleich' });
    expect(within(blatt).getByLabelText('Tag wählen')).toBeInTheDocument();
    expect(within(blatt).getByText('Vergleichen')).toBeInTheDocument();
    // F4 · die Datenlage-Zeile reist mit (94 % von 2000 Viertelstunden).
    expect(within(blatt).getByText(/94 %/)).toBeInTheDocument();
  });

  it('schließt das Blatt mit Escape', async () => {
    await renderMesswerte();
    fireEvent.click(screen.getByRole('button', { name: 'Zeitraum & Vergleich' }));
    await screen.findByRole('dialog', { name: 'Zeitraum & Vergleich' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Zeitraum & Vergleich' })).toBeNull(),
    );
  });

  it('ZEIGT einen gesetzten Vergleich als Chip — Bedienung versteckt, Zustand sichtbar', async () => {
    await renderMesswerte();
    // Ohne Vergleich kein Chip (er sagte sonst nur „kein Vergleich").
    expect(document.querySelector('.vp-zl-chip')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Zeitraum & Vergleich' }));
    const blatt = await screen.findByRole('dialog', { name: 'Zeitraum & Vergleich' });
    // Im Tages-Zeitraum heißt die Vorperiode beim Datum („Sa., 08.08.2026").
    const optionen = within(blatt).getAllByRole('button', { pressed: false });
    const vorperiode = optionen.find((b) => /vorherigen Zeitraum/.test(b.title));
    expect(vorperiode).toBeTruthy();
    fireEvent.click(vorperiode as HTMLElement);

    const chip = await waitFor(() => {
      const el = document.querySelector('.vp-zl-chip');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(chip.textContent).toMatch(/^Vergleich: /);
    // Und er ist der Weg zurück in die Bedienung.
    fireEvent.click(chip);
    expect(screen.getByRole('dialog', { name: 'Zeitraum & Vergleich' })).toBeInTheDocument();
  });
});

describe('Mobil · der Welt-Kopf ist EINE Zeile, das Abzeichen bleibt', () => {
  it('lässt das Kartenpaar weg (die Welten sind Bar-Plätze) und behält „Gemessen"', async () => {
    await renderMesswerte();
    expect(screen.queryByRole('group', { name: 'Ansicht wechseln' })).toBeNull();
    const zeile = document.querySelector('.vp-welt-zeile');
    expect(zeile).toBeTruthy();
    expect(within(zeile as HTMLElement).getByText('Messwerte')).toBeInTheDocument();
    expect(within(zeile as HTMLElement).getByText('Gemessen')).toBeInTheDocument();
  });

  it('macht die Fußkarte zum Aufklapper — der Wortlaut bleibt erreichbar', async () => {
    await renderMesswerte();
    const knopf = screen.getByRole('button', { name: /Was diese Zahlen sind/ });
    expect(knopf).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(knopf);
    expect(await screen.findByText(/nicht geeignet/)).toBeInTheDocument();
  });
});

describe('Mobil · Erlöse führt mit dem ERGEBNIS (Falz)', () => {
  it('zeigt Zahl, Zurechnung und die drei Zeilen, die sie ERGEBEN', async () => {
    await renderErloese();
    expect(screen.getByText('+ 9,84 €')).toBeInTheDocument();
    const komposition = screen.getByLabelText('Woraus sich das Ergebnis zusammensetzt');
    expect(within(komposition).getByText('Einspeise-Erlös')).toBeInTheDocument();
    expect(within(komposition).getByText('Wert des Eigenverbrauchs')).toBeInTheDocument();
    expect(within(komposition).getByText(/Stromkosten/)).toBeInTheDocument();
    expect(screen.getByText(/durch VoltPilots Steuerung/)).toBeInTheDocument();
  });

  it('faltet Erklärendes in BENANNTE Aufklapper — zugeklappt, aber nie versteckt', async () => {
    await renderErloese();
    for (const titel of [
      'So verdient Ihre Anlage · der Markt-Vergleich',
      'Was den Preis gemacht hat',
      'Der Tag im Bild · Preis, Speicher, Ertrag',
      'Tagesprotokoll',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(titel.replace(/[·&]/g, '.')) }))
        .toHaveAttribute('aria-expanded', 'false');
    }
    // Der Tagesnachweis ist zugeklappt — sein Diagramm wird nicht gerendert.
    expect(screen.queryByTestId('day-chart')).toBeNull();
  });

  it('öffnet einen Aufklapper mit VOLLEM Inhalt und seinem eigenen Abzeichen', async () => {
    await renderErloese();
    fireEvent.click(screen.getByRole('button', { name: /Der Tag im Bild/ }));
    expect(await screen.findByTestId('day-chart')).toBeInTheDocument();
    const koerper = document.querySelector('.vp-welt-disclosure-body');
    expect(within(koerper as HTMLElement).getByText('Gemessen')).toBeInTheDocument();
  });

  it('rahmt die GEPLANTE Ersparnis als Fußnotiz — mit Abzeichen, nie als gleichrangige Karte', async () => {
    await renderErloese();
    const notiz = document.querySelector('.vp-geplant-notiz') as HTMLElement;
    expect(notiz).toBeTruthy();
    expect(within(notiz).getByText('Geplant')).toBeInTheDocument();
    expect(within(notiz).getByText('+ 4,12 €')).toBeInTheDocument();
    expect(notiz.textContent).toMatch(/nicht gemessen/);
    // Und sie steht NICHT mehr als eigene Karte da.
    expect(screen.queryByText(/Geplante Speicher-Ersparnis ·/)).toBeNull();
  });

  it('sagt ohne Fahrplan „—" MIT Grund statt einer erfundenen Null', async () => {
    stubHistory();
    vi.spyOn(api, 'history').mockResolvedValue({
      ...history,
      totals: { ...history.totals, batterySavingsPlannedEur: null },
    });
    vi.spyOn(api, 'siteEarnings').mockResolvedValue(money);
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByText('+ 9,84 €');
    const notiz = await waitFor(() => {
      const el = document.querySelector('.vp-geplant-notiz');
      expect(el?.textContent).toMatch(/kein Batterie-Fahrplan/);
      return el as HTMLElement;
    });
    expect(within(notiz).getByText('—')).toBeInTheDocument();
    expect(within(notiz).getByText('Geplant')).toBeInTheDocument();
  });
});

describe('Der Schreibtisch bleibt, was er war', () => {
  it('rendert ohne Telefon-Grenze den Welt-Kopf samt Kartenpaar und sechs Δ-fähige Kacheln', async () => {
    stubPhone(false);
    await renderMesswerte();
    expect(screen.getByRole('group', { name: 'Ansicht wechseln' })).toBeInTheDocument();
    expect(document.querySelector('.vp-welt-zeile')).toBeNull();
    expect(document.querySelector('.vp-zeitleiste-mobil')).toBeNull();
    expect(document.querySelectorAll('.vp-esum')).toHaveLength(6);
    expect(document.querySelector('.vp-esum-kompakt')).toBeNull();
  });

  it('behält in der Geld-Welt die vollen Karten statt der Aufklapper', async () => {
    stubPhone(false);
    await renderErloese();
    expect(screen.getByText(/Geplante Speicher-Ersparnis ·/)).toBeInTheDocument();
    expect(document.querySelector('.vp-geplant-notiz')).toBeNull();
    // Der Tagesnachweis steht offen da, nicht hinter einem Aufklapper.
    expect(screen.getByTestId('day-chart')).toBeInTheDocument();
  });
});
