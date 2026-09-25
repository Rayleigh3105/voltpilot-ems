import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ErloeseSection } from './ErloeseSection';
import { clearHistoryCache } from '../historyCache';
import { clearEarningsCache } from '../useSiteEarnings';
import { api, type History, type Site, type SiteEarnings, type SiteEarningsBucket } from '../api';

/**
 * **Verlauf › Erlöse** — die neue Seite (Konzept „Verlauf-Rework", Paket P2,
 * Entscheide E3/E5 = A) als ganze Fläche gerendert.
 *
 * Er ersetzt die Karten-Tests der Vorgänger-Seite und hält deren Zusagen,
 * die weiter gelten: die Lastspitze ist nie Teil des Ergebnisses, der
 * Planwert steht nur in der Rechnung hinter der Steuerung, ein laufender Tag
 * wird bis zur gleichen Stunde verglichen, Admin-Zahlen erreichen die Fläche
 * nie, und Zeitraum und Vergleich reisen in der Adresse.
 */

vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));

/** Mi., 02.09.2026, 12:19 Berlin. */
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

const eimer = (start: string, nettoEur: number, teile = true): SiteEarningsBucket => ({
  start,
  einspeiseErloesEur: teile ? nettoEur / 2 : null,
  eigenverbrauchsWertEur: teile ? nettoEur / 2 + 0.1 : null,
  stromkostenEur: teile ? 0.1 : null,
  nettoEur,
});

/** Berliner Stunden 0…12 des laufenden Tages (12 läuft noch). */
const HEUTE = [
  -0.243, -0.243, -0.243, -0.243, -0.243, 0.574, 2.397, 5.478, 8.321, 10.446, 12.088, 12.57, 12.574,
].map((v, i) => eimer(new Date(Date.UTC(2026, 8, 1, 22 + i)).toISOString(), v));

/** Der volle Vortag, 24 Stunden. */
const VORTAG = [
  -0.143, -0.143, -0.143, -0.143, -0.143, 0.789, 2.97, 6.846, 10.731, 13.839, 16.162, 16.948,
  16.948, 15.41, 13.087, 9.969, 6.083, 2.201, 0.578, -0.115, -0.145, -0.148, -0.15, -0.151,
].map((v, i) => eimer(new Date(Date.UTC(2026, 7, 31, 22 + i)).toISOString(), v));

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
    steuerungSplitReason: null,
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
    series: HEUTE,
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
    steuerungPlannedEur: 3.2,
    autarkiePct: 0.7,
    eigenverbrauchPct: 0.6,
  },
  protocol: [],
  plan: [],
};

/** Der laufende Tag und sein Vortag — nach `at` unterschieden, wie im Betrieb. */
function stub(over: Partial<SiteEarnings> = {}, hist: History | null = history) {
  if (hist) vi.spyOn(api, 'history').mockResolvedValue(hist);
  else vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie'));
  return vi.spyOn(api, 'siteEarnings').mockImplementation(async (_id, _range, at) =>
    at === '2026-09-01'
      ? money({ nettoErgebnisEur: 135.224, series: VORTAG, from: '2026-08-31T22:00:00Z', to: '2026-09-01T22:00:00Z' })
      : money(over),
  );
}

const nb = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

async function geladen() {
  return screen.findByRole('group', { name: /^Erlöse · / });
}

/** Die Kartentitel in DOM-Reihenfolge — nur der Titel, ohne Unterzeile und ⓘ. */
function kartenTitel(): string[] {
  return Array.from(document.querySelectorAll('.vp-vr-body h2')).map((h) => nb(h.childNodes[0]?.textContent));
}

beforeEach(() => {
  window.location.hash = '#/anlage/s-1/erloese';
  clearHistoryCache();
  clearEarningsCache();
  vi.restoreAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
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

describe('Aufbau · Kennzahlen, Verlauf, Abrechnung, Kontext', () => {
  it('Direktvermarktung: Verlauf und Abrechnung, darunter Preise und die Markt-Karte', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    const kpis = await geladen();

    expect(nb(within(kpis).getByText('Ergebnis').closest('.vp-vr-kpi')?.textContent)).toMatch(/\+ 63,23 €/);
    expect(kartenTitel()).toEqual([
      'Erlöse je Stunde',
      'Abrechnung',
      'Preise im Zeitraum',
      'So verdient Ihre Anlage',
    ]);
  });

  it('Preise und „So verdient" stehen in EINER Reihe, die Lastspitze rückt darunter', async () => {
    stub({
      peakShaving: {
        leistungspreisEurKw: 120,
        abrechnung: 'jahr',
        periodStart: '2026-01-01',
        peakKw: 61.2,
        baselinePeakKw: 71.24,
        avoidedKw: 10.04,
        avoidedEur: 1204,
        history: [],
      },
    });
    render(<ErloeseSection site={site()} />);
    await geladen();

    const preise = screen.getByRole('region', { name: 'Preise im Zeitraum' });
    const verdient = screen.getByRole('region', { name: 'So verdient Ihre Anlage' });
    const spitze = screen.getByRole('region', { name: 'Lastspitze' });
    expect(preise.parentElement).toBe(verdient.parentElement);
    expect(spitze.parentElement).not.toBe(preise.parentElement);
    // Der Monat steht als Unterzeile neben dem Titel, wie bei der Abrechnung.
    const titel = within(verdient).getByRole('heading', { level: 2 });
    expect(within(titel).getByText('September 2026').tagName).toBe('SMALL');
  });

  it('EEG: ohne Markt-Karte — eine feste Vergütung hat keinen Monatsdurchschnitt', async () => {
    stub({ plantKind: 'eigenverbrauch', exportVerguetungPriced: true });
    render(<ErloeseSection site={site({ plantKind: 'eigenverbrauch' })} />);
    await geladen();

    expect(kartenTitel().some((t) => /So verdient/.test(t))).toBe(false);
    expect(screen.queryByText(/Monatsdurchschnitt/)).toBeNull();
  });

  it('zeigt nie die Admin-Zahlen gegen „ohne Speicher"', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    await geladen();

    const text = nb(document.body.textContent);
    expect(text).not.toMatch(/2,67/);
    expect(text).not.toMatch(/4,10 €/);
    expect(text).not.toMatch(/Ohne Speicher wären/i);
  });
});

describe('Preise im Zeitraum · was eine Kilowattstunde wert war', () => {
  it('zeigt drei Balken mit DENSELBEN Ø-Preisen wie die Abrechnung', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    await geladen();

    const karte = screen.getByRole('region', { name: 'Preise im Zeitraum' });
    const liste = within(karte).getByRole('list', { name: 'Preise je Kilowattstunde' });
    const zeilen = within(liste).getAllByRole('listitem').map((li) => nb(li.textContent));
    expect(zeilen[0]).toMatch(/^Eigenverbrauch\s*25,0 ct\s*gespart: vermiedener Netzbezug$/);
    expect(zeilen[1]).toMatch(/^Einspeisung.*7,6 ct\s*verdient: Börse \+ Marktprämie$/);
    expect(zeilen[2]).toMatch(/^Netzbezug\s*25,2 ct\s*bezahlt: fester Tarif 25 ct\/kWh$/);
    // Die Antwort über den Balken — und die Fußzeile mit Speicher und Bewertung.
    expect(within(karte).getByText('Selbst genutzter Strom war mehr wert als eingespeister.')).toBeInTheDocument();
    expect(nb(karte.textContent)).toMatch(/Speicher lädt nur Sonnenstrom · Bewertung: heutige Tarif- und Vergütungsangaben/);
    // Die Direktvermarktungs-Größen stehen nicht mehr doppelt in dieser Karte.
    expect(within(karte).queryByText(/Anzulegender Wert/)).toBeNull();
    expect(within(karte).queryByText(/Monatsmarktwert/)).toBeNull();
  });

  it('legt den Satz „Bei 0,0 ct Börsenpreis" wortgleich ins ⓘ an der Einspeisung', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    await geladen();

    const karte = screen.getByRole('region', { name: 'Preise im Zeitraum' });
    expect(within(karte).getByRole('button', { name: 'Erklärung: Bei 0,0 ct Börsenpreis' })).toBeInTheDocument();
  });
});

describe('Abrechnung · Menge × Ø Preis = Betrag', () => {
  it('nennt je Posten Menge, Ø Preis und Betrag — Netzbezug negativ', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    await geladen();

    const karte = screen.getByRole('region', { name: 'Abrechnung' });
    const zeile = (name: string) => nb(within(karte).getByText(name).closest('tr')?.textContent);
    expect(zeile('Eigenverbrauch')).toMatch(/154,7 kWh · Ø 25,0 ct\/kWh.*\+ 38,68 €/);
    expect(zeile('Einspeisung')).toMatch(/345,2 kWh · Ø 7,6 ct\/kWh · Prämie 4,79 €.*\+ 26,13 €/);
    expect(zeile('Netzbezug')).toMatch(/6,3 kWh · Ø 25,2 ct\/kWh.*− 1,59 €/);
    expect(zeile('Ergebnis')).toMatch(/\+ 63,23 €/);
    // Der Mehrwert der Steuerung ist kein Anteil des Ergebnisses — er steht im Band.
    expect(within(karte).queryByText(/Mehrwert/)).toBeNull();
    // 38,68 + 26,13 − 1,59 = 63,22 ≠ 63,23: die Rundung wird gesagt, nicht versteckt.
    expect(within(karte).getByText(/Posten einzeln gerundet/)).toBeInTheDocument();
  });

  it('führt die vermiedenen Leistungskosten UNTER dem Strich — nie im Ergebnis', async () => {
    stub({
      peakShaving: {
        leistungspreisEurKw: 120,
        abrechnung: 'jahr',
        periodStart: '2026-01-01',
        peakKw: 61.2,
        baselinePeakKw: 71.24,
        avoidedKw: 10.04,
        avoidedEur: 1204,
        history: [],
      },
    });
    render(<ErloeseSection site={site()} />);
    await geladen();

    const karte = screen.getByRole('region', { name: 'Abrechnung' });
    expect(nb(within(karte).getByText('Ergebnis').closest('tr')?.textContent)).toMatch(/\+ 63,23 €/);
    const extra = within(karte).getByText('Vermiedene Leistungskosten').closest('.vp-vr-bill-extra') as HTMLElement;
    expect(nb(extra.textContent)).toMatch(/Abrechnungsjahr 2026 · nicht im Ergebnis/);
    expect(nb(extra.textContent)).toMatch(/\+ 1\.204,00 €/);
    expect(within(extra).getByRole('button', { name: 'Erklärung: Vermiedene Leistungskosten' })).toBeInTheDocument();

    const spitze = screen.getByRole('region', { name: 'Lastspitze' });
    expect(nb(spitze.textContent)).toMatch(/ohne Speichereinsatz\s*71,2 kW/);
    expect(nb(spitze.textContent)).toMatch(/gehalten\s*61,2 kW/);
  });
});

/** Die Kachel „VoltPilot-Steuerung" und ihr geöffnetes ⓘ (Maßstab + Rechnung). */
function steuerKachel(): HTMLElement {
  return screen.getByText('VoltPilot-Steuerung').closest('.vp-vr-kpi') as HTMLElement;
}
async function steuerErklaerung(): Promise<HTMLElement> {
  fireEvent.click(within(steuerKachel()).getByRole('button', { name: 'Erklärung: Mehrwert durch VoltPilot' }));
  await screen.findAllByText(/Verglichen wird mit/);
  return document.querySelector('.vp-vr-mw-info') as HTMLElement;
}

describe('Kachel „VoltPilot-Steuerung" · der Mehrwert in der Kennzahlenzeile', () => {
  it('Betrag und Unterzeile lesen sich als ein Satz; die Kachel ist leicht hervorgehoben', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    const kpis = await geladen();

    const kachel = steuerKachel();
    expect(kpis.contains(kachel)).toBe(true);
    expect(kachel.classList.contains('hervor')).toBe(true);
    expect(nb(kachel.querySelector('.vp-vr-kpi-v')?.textContent)).toBe('+ 1,45 €');
    expect(kachel.querySelector('.vp-vr-kpi-s')?.textContent).toBe('bisher mehr als ohne smarte Steuerung');
  });

  it('ohne Speicherdaten: „—" und der Weg zum Nachtragen', async () => {
    stub({ savedSpeicherEur: null, savedSteuerungEur: null, steuerungSplitReason: 'no_battery_data' });
    render(<ErloeseSection site={site()} />);
    await geladen();

    const kachel = steuerKachel();
    expect(kachel.querySelector('.vp-vr-kpi-v')?.textContent).toBe('—');
    expect(within(kachel).getByRole('link', { name: 'nachtragen ›' })).toBeInTheDocument();
  });
});

describe('Steuerung · Planwert nur in der Rechnung (im ⓘ)', () => {
  it('zeigt den geplanten Mehrwert als Schritt der Rechnung — 3,20 €, nie die 9,40 € gegen „ohne Speicher"', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    await geladen();

    const info = await steuerErklaerung();
    const plan = within(info).getByText(/^Fahrplan:/).closest('li') as HTMLElement;
    expect(plan.textContent).toMatch(/3,20/);
    expect(plan.textContent).not.toMatch(/9,40/);
  });

  it('lässt die Plan-Zeile ohne Fahrplan weg', async () => {
    stub({}, { ...history, totals: { ...history.totals, steuerungPlannedEur: null } });
    render(<ErloeseSection site={site()} />);
    await geladen();

    const info = await steuerErklaerung();
    expect(within(info).queryByText(/^Fahrplan:/)).toBeNull();
  });
});

describe('Vergleich · Wertung nur, wo sie ehrlich ist', () => {
  it('laufender Tag: bis zur gleichen Stunde, nie „53 % weniger"', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    const kpis = await geladen();

    const haupt = within(kpis).getByText('Ergebnis').closest('.vp-vr-kpi') as HTMLElement;
    expect(await within(haupt).findByText(/25 % weniger als gestern bis 12 Uhr/)).toBeInTheDocument();
    expect(nb(document.body.textContent)).not.toMatch(/53 %/);
    // Wie verglichen wurde, steht im ⓘ.
    fireEvent.click(within(haupt).getByRole('button', { name: 'Erklärung: Ergebnis' }));
    expect(await screen.findByText(/Verglichen wird bis 12 Uhr/)).toBeInTheDocument();
  });

  it('abgeschlossener Tag: Prozent mit Richtung', async () => {
    window.location.hash = '#/anlage/s-1/erloese?z=tag&at=2026-09-01';
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie'));
    vi.spyOn(api, 'siteEarnings').mockImplementation(async (_id, _range, at) =>
      at === '2026-08-31'
        ? money({ nettoErgebnisEur: 119.983, series: [], from: '2026-08-30T22:00:00Z', to: '2026-08-31T22:00:00Z' })
        : money({ nettoErgebnisEur: 135.224, series: VORTAG, from: '2026-08-31T22:00:00Z', to: '2026-09-01T22:00:00Z' }),
    );
    render(<ErloeseSection site={site()} />);
    const kpis = await geladen();

    expect(await within(kpis).findByText('13 % mehr als am Vortag')).toBeInTheDocument();
    expect(nb(kpis.textContent)).not.toMatch(/bis \d+ Uhr/);
  });

  it('laufender Monat: nur der Betrag des ganzen Vormonats, kein Prozent', async () => {
    window.location.hash = '#/anlage/s-1/erloese?z=monat&at=2026-09-02';
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie'));
    vi.spyOn(api, 'siteEarnings').mockImplementation(async (_id, range, at) =>
      range === 'month' && at === '2026-08-01'
        ? money({ range: 'month', nettoErgebnisEur: 812.4, series: [] })
        : money({ range: 'month', from: '2026-08-31T22:00:00Z', to: '2026-09-30T22:00:00Z' }),
    );
    render(<ErloeseSection site={site()} />);
    const kpis = await geladen();

    expect(await within(kpis).findByText(/ganzer August: \+ 812,40 €/)).toBeInTheDocument();
    const haupt = within(kpis).getByText('Ergebnis').closest('.vp-vr-kpi') as HTMLElement;
    expect(nb(haupt.textContent)).not.toMatch(/%/);
  });
});

describe('Adresse · Zeitraum und Vergleich reisen mit', () => {
  it('schreibt den gewählten Zeitraum in die Adresse', async () => {
    stub();
    render(<ErloeseSection site={site()} />);
    await geladen();

    fireEvent.click(screen.getByRole('tab', { name: 'Woche' }));
    expect(window.location.hash).toBe('#/anlage/s-1/erloese?z=woche&at=2026-09-02');
  });

  it('öffnet aus der Tabelle heraus den Tag', async () => {
    window.location.hash = '#/anlage/s-1/erloese?z=woche&at=2026-09-02';
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie'));
    vi.spyOn(api, 'siteEarnings').mockResolvedValue(
      money({
        range: 'week',
        series: [eimer('2026-08-30T22:00:00Z', 4), eimer('2026-08-31T22:00:00Z', 5)],
      }),
    );
    render(<ErloeseSection site={site()} />);
    await geladen();

    fireEvent.click(screen.getByRole('button', { name: 'Tabelle' }));
    const tabelle = screen.getByRole('table', { name: /Erlöse je Tag/ });
    expect(within(tabelle).getByText('Summe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Als CSV herunterladen' })).toBeInTheDocument();

    fireEvent.click(within(tabelle).getByRole('button', { name: 'Mo., 31.08.' }));
    expect(window.location.hash).toBe('#/anlage/s-1/erloese?z=tag&at=2026-08-31');
  });
});

describe('Zustände', () => {
  it('Fehler: sagt es und bietet den erneuten Versuch', async () => {
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie'));
    vi.spyOn(api, 'siteEarnings').mockRejectedValue(new Error('Netzwerk'));
    render(<ErloeseSection site={site()} />);

    expect(await screen.findByText(/Die Erlöse konnten nicht geladen werden/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('dimmt die alten Zahlen, solange der neue Zeitraum lädt', async () => {
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie'));
    const spy = vi.spyOn(api, 'siteEarnings').mockResolvedValueOnce(money());
    render(<ErloeseSection site={site()} />);
    await geladen();

    spy.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Monat' }));
    });
    expect(document.querySelector('.vp-vr-body.alt')).toBeTruthy();
  });
});
