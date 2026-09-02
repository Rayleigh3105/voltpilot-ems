import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErloeseSection } from './ErloeseSection';
import { clearHistoryCache } from '../historyCache';
import { clearEarningsCache } from '../useSiteEarnings';
import { anlageSurface, type AnlageSurface } from '../surface';
import { api, type Site, type SiteEarnings, type SiteEarningsBucket } from '../api';

/**
 * P2 · der Vergleich eines LAUFENDEN Zeitraums auf der Erlöse-Karte
 * (Konzept `data/vp-erloese-seite-konzept-e2` §3.7, E3 = a, Befund B3).
 *
 * Der Befund war eine Aussage, keine Rechnung: um 12:19 stand über einem
 * normalen Tag „53 % weniger als am Vortag" in Warnrot — verglichen wurden
 * fünf Stunden mit vierundzwanzig. Dieser Test rendert die ECHTE Karte mit den
 * Stunden-Eimern der Konzept-Fixture `dv-tag-laufend` / `dv-tag-abgeschlossen`
 * und nagelt fest, dass die Zahl im DOM ankommt — die Ableitung selbst prüft
 * `vergleichLaufend.test.ts`.
 */

vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));
vi.mock('../components/Tagesbild', () => ({ Tagesbild: () => <div data-testid="day-chart" /> }));

/** Mi., 02.09.2026, 12:19 Berlin — der Zeitpunkt des Screenshots. */
const NOW = new Date('2026-09-02T12:19:00+02:00');

const site: Site = {
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
};

const MARKT: AnlageSurface = anlageSurface({
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
  ],
  config: { plantKind: 'direktvermarktung', tarifArt: 'fest' },
});

/** Stunden-Eimer aus UTC-Start + Netto — nur was der Vergleich liest. */
const eimer = (start: string, nettoEur: number): SiteEarningsBucket => ({
  start,
  einspeiseErloesEur: null,
  eigenverbrauchsWertEur: null,
  stromkostenEur: null,
  nettoEur,
});

/** `dv-tag-laufend` — 13 Eimer, Berliner Stunden 0…12 (12 läuft noch). */
const HEUTE = [
  -0.243, -0.243, -0.243, -0.243, -0.243, 0.574, 2.397, 5.478, 8.321, 10.446, 12.088, 12.57, 12.574,
].map((v, i) => eimer(new Date(Date.UTC(2026, 8, 1, 22 + i)).toISOString(), v));

/** `dv-tag-abgeschlossen` — der volle Vortag, 24 Eimer. */
const VORTAG = [
  -0.143, -0.143, -0.143, -0.143, -0.143, 0.789, 2.97, 6.846, 10.731, 13.839, 16.162, 16.948,
  16.948, 15.41, 13.087, 9.969, 6.083, 2.201, 0.578, -0.115, -0.145, -0.148, -0.15, -0.151,
].map((v, i) => eimer(new Date(Date.UTC(2026, 7, 31, 22 + i)).toISOString(), v));

function money(over: Partial<SiteEarnings>): SiteEarnings {
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
    savedEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    baselineEur: null,
    actualEur: null,
    marktpraemieEur: null,
    bezugspreisCtKwh: 25,
    realizedExportCtKwh: null,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    bezogenKwh: 6.3,
    eingespeistKwh: 345.2,
    selbstverbrauchKwh: 154.7,
    batterieBewegtKwh: null,
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

/** Der laufende Tag und sein Vortag — nach `at` unterschieden, wie im Betrieb. */
function stubTage() {
  vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie im Test'));
  vi.spyOn(api, 'siteEarnings').mockImplementation(async (_id, _range, at) =>
    at === '2026-09-01'
      ? money({ nettoErgebnisEur: 135.224, series: VORTAG, from: '2026-08-31T22:00:00Z', to: '2026-09-01T22:00:00Z' })
      : money({}),
  );
}

beforeEach(() => {
  window.location.hash = '';
  clearHistoryCache();
  clearEarningsCache();
  vi.restoreAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Erlöse-Karte · laufender Tag (B3)', () => {
  it('vergleicht bis zur gleichen Stunde — kein „53 % weniger" mehr', async () => {
    stubTage();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    const chip = await screen.findByText('25 % weniger');
    expect(chip).toBeInTheDocument();
    expect(screen.queryByText(/53 %/)).not.toBeInTheDocument();
    // Die Grundlage steht daneben, damit die Zahl nachprüfbar ist.
    expect(screen.getByText(/Bis 12 Uhr: heute/)).toHaveTextContent(
      'Bis 12 Uhr: heute 50,66 € · gestern 67,57 €',
    );
  });

  it('wertet den halben Tag NICHT — der Chip bleibt ruhig', async () => {
    stubTage();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    const chip = await screen.findByText('25 % weniger');
    expect(chip.closest('.vp-delta')).toHaveClass('vp-delta-neutral');
    expect(chip.closest('.vp-delta')).not.toHaveClass('vp-delta-schlecht');
  });

  it('sagt, was mit was verglichen wurde — statt „gegen den vollständigen Zeitraum"', async () => {
    stubTage();
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    await screen.findByText('25 % weniger');
    expect(screen.getByText(/Verglichen wird bis 12 Uhr/)).toHaveTextContent(
      'der Vortag ebenfalls bis 12 Uhr',
    );
    // Der alte, jetzt falsche Satz ist weg.
    expect(screen.queryByText(/verglichen wird mit dem vollständigen Zeitraum/)).not.toBeInTheDocument();
  });
});

describe('Erlöse-Karte · abgeschlossener Tag bleibt unverändert', () => {
  it('behält Wort UND Ton', async () => {
    window.location.hash = '#/anlage/s-1/erloese?r=day&at=2026-09-01';
    vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie im Test'));
    vi.spyOn(api, 'siteEarnings').mockImplementation(async (_id, _range, at) =>
      at === '2026-08-31'
        ? money({ nettoErgebnisEur: 119.983, series: [], from: '2026-08-30T22:00:00Z', to: '2026-08-31T22:00:00Z' })
        : money({ nettoErgebnisEur: 135.224, series: VORTAG, from: '2026-08-31T22:00:00Z', to: '2026-09-01T22:00:00Z' }),
    );
    render(<ErloeseSection site={site} surface={MARKT} onOpenWelt={() => {}} />);

    const zeile = await screen.findByText('13 % mehr als am Vortag');
    expect(zeile.closest('.vp-delta')).toHaveClass('vp-delta-gut');
    expect(screen.queryByText(/Bis \d+ Uhr/)).not.toBeInTheDocument();
  });
});
