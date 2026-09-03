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
  await screen.findByText('+ 9,84 €', { selector: '.vp-c-stm-zahl' });
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

  /**
   * ⚠ **P3 hat die Telefon-Eindampfung ERSETZT, nicht verloren.** Bis dahin
   * standen am Telefon sechs Kacheln OHNE Δ und darunter EINE zusammengefasste
   * Zeile — die Ledger-Zeile trägt ihre Sekundärzeile ohnehin unter dem Namen,
   * also steht der Vergleich jetzt AN SEINER Zahl, auf jeder Breite.
   */
  it('trägt das Δ in der ZEILE, zu der es gehört — auf jeder Breite', async () => {
    await renderMesswerte();
    // Die Vorperiode erzeugte 3 kWh, dieser Tag 4 → +33 % auf „Erzeugt".
    expect(HEUTE).not.toEqual(GESTERN);
    const delta = await screen.findByText(/33 % mehr als am Vortag/);
    // Es steht in der Sekundärzeile der Ledger-Zeile, nicht in einer Meta-Zeile.
    expect(delta.closest('.vp-c-led-sek')).toBeTruthy();
    const zeile = delta.closest('.vp-c-led-row') as HTMLElement;
    expect(within(zeile).getByText('Erzeugt')).toBeInTheDocument();
    // Die zusammengefasste Telefon-Zeile ist ersatzlos entfallen.
    expect(document.querySelector('.vp-esum-meta')).toBeNull();
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
    const blatt = await screen.findByRole('dialog', { name: 'Zeitraum & Vergleich' });
    // ⚠ Seit P2 (V9) ist das Blatt ein echtes Bottom-Sheet: der Fokus liegt IM
    // Sheet, und Escape hängt an ihm statt an `window`. Das ist die stärkere
    // Zusage — dieselbe Fokus-Falle, die auch Tab einfängt (Haus-Muster
    // `CenteredConfirmDialog`), nicht ein Fenster-Zuhörer, der auch feuert,
    // wenn der Fokus ganz woanders steht.
    fireEvent.keyDown(blatt, { key: 'Escape' });
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

/**
 * ⚠ Die Aufklapper des Verlaufs sind seit P2b ein natives `<details>`/`<summary>`
 * (der geteilte {@link Aufklapper}, Konzept §3.2 V8) — kein `<button>` mehr.
 * `getByRole('button')` findet ein `summary` NICHT: `dom-accessibility-api`
 * bildet es auf keinen Rang ab. Die Zeile wird deshalb über ihren Titel
 * adressiert; `aria-expanded` steht weiterhin daran und bleibt prüfbar.
 */
function aufklapper(name: RegExp): HTMLElement {
  const treffer = [...document.querySelectorAll('summary.vp-c-aufk-sum')].filter((s) =>
    name.test(s.textContent ?? ''),
  );
  if (treffer.length !== 1) {
    throw new Error(`${treffer.length} Aufklapper für ${name} — erwartet genau einen`);
  }
  return treffer[0] as HTMLElement;
}

describe('Mobil · der Welt-Kopf ist ganz entfallen, das Abzeichen bleibt', () => {
  it('rendert weder Kartenpaar noch Kopfzeile — und behält „Gemessen" an der Karte', async () => {
    await renderMesswerte();
    expect(screen.queryByRole('group', { name: 'Ansicht wechseln' })).toBeNull();
    // E3: auch die eine Kopf-ZEILE des Telefons ist weg (Bar-Slot + Reiter
    // sagen dasselbe). Übrig bleibt die unsichtbare Überschrift.
    expect(document.querySelector('.vp-welt-zeile')).toBeNull();
    const h1 = screen.getByRole('heading', { level: 1, name: /Messwerte/ });
    expect(h1).toHaveClass('vp-sr-only');
    // Das Ehrlichkeits-Abzeichen sitzt an den Karten, nicht am Kopf — seit P3
    // in der EINEN Chip-Form des Bereichs, im Label der Karte.
    const abzeichen = screen.getAllByText('Gemessen', { selector: '.vp-c-label .vp-chip' });
    expect(abzeichen.length).toBeGreaterThan(0);
  });

  it('macht die Fußkarte zum Aufklapper — der Wortlaut bleibt erreichbar', async () => {
    await renderMesswerte();
    const knopf = aufklapper(/Was diese Zahlen sind/);
    expect(knopf).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(knopf);
    expect(await screen.findByText(/nicht geeignet/)).toBeInTheDocument();
  });
});

describe('Mobil · Erlöse führt mit dem ERGEBNIS (Falz)', () => {
  it('zeigt Zahl, Zurechnung und die drei Zeilen, die sie ERGEBEN', async () => {
    await renderErloese();
    // Die EINE grosse Zahl - und derselbe Betrag ein zweites Mal als letzter
    // Balken des Wasserfalls (die Zeile „Ergebnis"), der die Addition beweist.
    expect(screen.getByText('+ 9,84 €', { selector: '.vp-c-stm-zahl' })).toBeInTheDocument();
    const komposition = screen.getByLabelText('Woraus sich das Ergebnis zusammensetzt');
    // Seit Revision 2 tragen die Zeilen 1-3-Wort-Namen (Konzept §3.12).
    // Die NAMEN der Zeilen - gezielt adressiert, weil dieselben Wörter seit
    // Ebene 1 auch in den Rechenzeilen darunter vorkommen.
    expect(
      [...komposition.querySelectorAll('.vp-c-led-name')].map((n) => n.textContent),
    ).toEqual(['Einspeise-Erlös', 'Eigenverbrauch', 'Netzbezug', 'Ergebnis']);
    // Der Speicher-Block (Erlöse-Konzept §3.5) haengt im Speicher-Slot der
    // Karte und steht damit NACH den vier Zeilen: der Falz zeigt zuerst, was
    // die Zahl ERGIBT.
    expect(screen.getAllByText(/^Speicher (heute|an diesem Tag|bisher|im Zeitraum)$/).length)
      .toBeGreaterThan(0);
    expect(screen.getByText('+ 2,07 €', { selector: '.vp-c-sp-wert' })).toBeInTheDocument();
    // ⚠ Und er nennt diesen Betrag NICHT „Steuerung": `savedEur` misst den
    //   GANZEN Speicher (Baseline = Anlage ohne Speicher), „Steuerung" ist
    //   erst `savedSteuerungEur` — ohne die Aufteilung wird sie nicht
    //   behauptet (§2.2 / §3.6, die zweite Wahrheit, die P1+P5 abgeräumt hat).
    expect(screen.queryByText(/durch VoltPilots Steuerung/)).not.toBeInTheDocument();
  });

  it('faltet Erklärendes in BENANNTE Aufklapper — zugeklappt, aber nie versteckt', async () => {
    await renderErloese();
    // P6/E5: „Was den Preis gemacht hat" ist ENTFALLEN — die Preise wohnen in
    // Ebene 2 der Ergebnis-Karte, also auch am Telefon.
    for (const titel of [
      'So verdient Ihre Anlage · der Markt-Vergleich',
      'Der Tag im Bild · Preis, Speicher, Ertrag',
      'Tagesprotokoll',
    ]) {
      expect(aufklapper(new RegExp(titel.replace(/[·&]/g, '.')))).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    }
    // Der Tagesnachweis ist zugeklappt — sein Diagramm wird nicht gerendert.
    expect(screen.queryByTestId('day-chart')).toBeNull();
  });

  it('öffnet einen Aufklapper mit VOLLEM Inhalt und seinem eigenen Abzeichen', async () => {
    await renderErloese();
    fireEvent.click(aufklapper(/Der Tag im Bild/));
    expect(await screen.findByTestId('day-chart')).toBeInTheDocument();
    // ⚠ Der Körper existiert seit P2b an JEDEM Aufklapper (natives `details`).
    //   Gemeint ist der des GEÖFFNETEN — sonst greift man den ersten der Seite.
    const koerper = document.querySelector('details.vp-c-aufk[open] .vp-c-aufk-body');
    expect(within(koerper as HTMLElement).getByText('Gemessen')).toBeInTheDocument();
  });

  // E6 (Runde 1, in u3 §3.2 (6) wiederhergestellt): die geplante Ersparnis
  // steht in den SCHRITTEN der Speicher-Karte — direkt hinter der Rechnung,
  // mit der sie sich vergleicht. Weder Karte noch gerahmte Fußnotiz, und
  // NICHT auf Ebene 0: eine Plan-Zahl neben lauter gemessenen hat sich mit
  // ihnen verwechselt.
  it('stellt die GEPLANTE Ersparnis in die Schritte der Speicher-Karte', async () => {
    await renderErloese();
    const speicher = document.querySelector('.vp-c-speicher') as HTMLElement;
    expect(speicher).toBeTruthy();
    const zeile = within(speicher).getByText(/^Fahrplan:/).closest('li') as HTMLElement;
    expect(zeile.textContent).toMatch(/4,12/);
    expect(zeile.textContent).toMatch(/eine Plan-Zahl, keine Messung/);
    expect(zeile.closest('details.vp-formel')).toBeTruthy();
    // Weder Karte noch Fußnotiz — die Zahl steht genau einmal.
    expect(screen.queryByText(/Geplante Speicher-Ersparnis ·/)).toBeNull();
    expect(document.querySelector('.vp-geplant-notiz')).toBeNull();
  });

  it('lässt die Plan-Zeile ohne Fahrplan WEG statt eine Null zu erfinden', async () => {
    stubHistory();
    vi.spyOn(api, 'history').mockResolvedValue({
      ...history,
      totals: { ...history.totals, batterySavingsPlannedEur: null },
    });
    vi.spyOn(api, 'siteEarnings').mockResolvedValue(money);
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);
    await screen.findByText('+ 9,84 €', { selector: '.vp-c-stm-zahl' });
    const speicher = document.querySelector('.vp-c-speicher') as HTMLElement;
    expect(speicher).toBeTruthy();
    expect(within(speicher).queryByText(/^Fahrplan:/)).toBeNull();
    expect(document.querySelector('.vp-geplant-notiz')).toBeNull();
  });
});

describe('Der Schreibtisch bleibt, was er war', () => {
  it('rendert ohne Telefon-Grenze die volle Zeit-Leiste und sechs Δ-fähige Kacheln', async () => {
    stubPhone(false);
    await renderMesswerte();
    // E3: kein Welt-Kopf, in KEINER Breite — weder Karte noch Kopfzeile.
    expect(screen.queryByRole('group', { name: 'Ansicht wechseln' })).toBeNull();
    expect(document.querySelector('.vp-welt-kopf')).toBeNull();
    expect(document.querySelector('.vp-welt-zeile')).toBeNull();
    expect(document.querySelector('.vp-zeitleiste-mobil')).toBeNull();
    // P3: am Rechner steht DIESELBE Ledger-Liste wie am Telefon — die frühere
    // Gabelung (dort ein `dl`-Raster, hier sechs Kacheln) ist entfallen.
    const liste = screen.getByLabelText('Energiemengen im Zeitraum');
    expect(within(liste).getAllByText(/^(Erzeugt|Verbraucht|Bezogen|Eingespeist|Geladen|Entladen)$/))
      .toHaveLength(6);
    expect(document.querySelector('.vp-esum')).toBeNull();
    expect(document.querySelector('.vp-esum-kompakt')).toBeNull();
  });

  it('behält in der Geld-Welt die vollen Karten statt der Aufklapper', async () => {
    stubPhone(false);
    await renderErloese();
    // Am Schreibtisch steht die Plan-Zeile an DERSELBEN Stelle wie am Telefon
    // (E6: die Reihenfolge der Ergebnis-Fläche ist auf jeder Breite gleich).
    const speicher = document.querySelector('.vp-c-speicher') as HTMLElement;
    expect(within(speicher).getByText(/^Fahrplan:/)).toBeInTheDocument();
    expect(document.querySelector('.vp-geplant-notiz')).toBeNull();
    // Der Tagesnachweis steht offen da, nicht hinter einem Aufklapper.
    expect(screen.getByTestId('day-chart')).toBeInTheDocument();
  });
});
