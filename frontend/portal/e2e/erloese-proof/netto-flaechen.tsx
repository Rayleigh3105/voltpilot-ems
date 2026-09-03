/**
 * FIXTURE-HARNESS für den Browser-Beweis von P9 „EINE Zahl über die Flächen"
 * (Erlöse-Konzept `vp-erloese-seite-konzept-e2` §2.3 B11/B12, E9 (a)).
 *
 * Sie stellt die DREI Flächen nebeneinander, die bisher drei verschiedene
 * große Zahlen zeigten — Cockpit-Held, Portfolio-Summe, Erlöse-Held —, jede
 * gerechnet durch ihre ECHTE Ableitung (`cockpitHero`, `erloeseAggregat`,
 * `erloesErgebnis`) mit den Fixtures des Konzepts. So trifft eine Messung
 * (`scrollWidth === innerWidth` bei 375/768/1440) alle drei in EINEM Durchgang,
 * ohne Backend und ohne Simulator.
 *
 * ⚠ Kein zweiter Renderer: der Rumpf trägt genau die Klassen der Flächen
 * (`vp-hero-money*`, `vp-pf-*`); Zahlen und Sätze kommen ausschließlich aus
 * den Ableitungen und werden hier nirgends nachgebaut.
 */
import ReactDOM from 'react-dom/client';

import '../../designsystem/tokens/fonts.css';
import '../../designsystem/tokens/colors.css';
import '../../designsystem/tokens/typography.css';
import '../../designsystem/tokens/spacing.css';
import '../../designsystem/tokens/effects.css';
import '../../designsystem/components/core/core.css';
import '../../designsystem/components/shell/shell.css';
import '../../src/index.css';
import '../../src/components/CockpitBlocks.css';
import '../../src/components/PortfolioWelt.css';

import type { EarningsSite, SiteEarnings } from '../../src/api';
import { cockpitHero } from '../../src/cockpitWidgets';
import { CockpitErgebnis } from '../../src/components/erloese/CockpitErgebnis';
import { erloesErgebnis, signedEuro, steeringAttributionNote } from '../../src/erloesKomposition';
import { NETTO_WORT } from '../../src/erloesNetto';
import { erloeseAggregat } from '../../src/portfolioHistorie';

const NOW = new Date('2026-09-02T12:19:00+02:00');

/** `dv-tag-laufend` aus `derived.json` — der Fall aus dem Captain-Screenshot. */
const LAUFEND = {
  einspeiseErloesEur: 26.134,
  eigenverbrauchsWertEur: 38.684,
  stromkostenEur: 1.585,
  nettoErgebnisEur: 63.233,
  actualEur: -24.549,
  gesamtertragEur: 64.818,
  savedEur: -2.67,
  savedSpeicherEur: -4.12,
  savedSteuerungEur: 1.45,
  speicherDeltaKwh: 44.2,
  speicherWertCtKwh: 18.9,
  speicherWertEur: 8.3538,
  speicherWertBasis: 'plan',
  range: 'day',
  to: '2026-09-02T22:00:00Z',
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  tarifPriced: true,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: 8.11,
  arbitrageEur: null,
  firstCoveredDate: null,
  peakShaving: null,
  reason: null,
  coveredSlots: 96,
} as unknown as SiteEarnings;

/** `eeg-ohne-tarif` — die Anlage ohne bewerteten Eigenverbrauch. */
const OHNE_TARIF = {
  ...LAUFEND,
  einspeiseErloesEur: 1.995,
  eigenverbrauchsWertEur: null,
  stromkostenEur: 1.118,
  nettoErgebnisEur: 0.877,
  actualEur: -0.877,
  gesamtertragEur: 1.995,
  savedEur: 3.4,
  savedSpeicherEur: null,
  savedSteuerungEur: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  plantKind: 'eigenverbrauch',
  to: '2026-09-01T22:00:00Z',
} as unknown as SiteEarnings;

/** `dv-praemie-ruht` — Negativpreis-Tag, negativer Einspeise-Erlös. */
const NEGATIVPREIS = {
  ...LAUFEND,
  einspeiseErloesEur: -1.42,
  eigenverbrauchsWertEur: 30.1,
  stromkostenEur: 0.98,
  nettoErgebnisEur: 27.7,
  actualEur: 2.4,
  gesamtertragEur: 28.68,
  savedEur: 6.8,
  // Ohne gepflegte Batterie-Stammdaten gibt es keine Aufteilung — sie hier zu
  // erben ergaebe eine Summe, die nicht aufgeht (die Wache meldet das laut).
  savedSpeicherEur: null,
  savedSteuerungEur: null,
  to: '2026-08-24T22:00:00Z',
} as unknown as SiteEarnings;

function flotte(id: string, name: string, m: SiteEarnings): EarningsSite {
  return {
    id,
    name,
    einspeiseErloesEur: m.einspeiseErloesEur,
    eigenverbrauchsWertEur: m.eigenverbrauchsWertEur,
    gesamtertragEur: m.gesamtertragEur,
    actualEur: m.actualEur,
    savedEur: m.savedEur,
    arbitrageEur: null,
    anzulegenderWertCtKwh: null,
    peakShaving: null,
    coveredSlots: 96,
    reason: null,
    eingespeistKwh: 128.4,
    series: [],
  } as unknown as EarningsSite;
}

function CockpitHeld({ titel, money }: { titel: string; money: SiteEarnings }) {
  const view = cockpitHero({ money, range: 'day', now: NOW });
  if (!view.money) return null;
  return (
    <section className="probe">
      <h2>{titel}</h2>
      {/* ⚠ SEIT P5 rendert die Cockpit-Erlöskarte das C-Bauteil (§3.7). Diese
          Probe hielt vorher eine HANDKOPIE der alten Leisten-Markup — und wäre
          damit eine zweite, widersprechbare Fassung derselben Karte geworden. */}
      <div className="vp-rail-blk vp-hero-money">
        <CockpitErgebnis money={view.money} rings={view.rings} ringsNote={view.ringsNote} />
      </div>
    </section>
  );
}

function ErloesHeld({ titel, money }: { titel: string; money: SiteEarnings }) {
  const view = erloesErgebnis({ money, periodLabel: 'Mi., 02.09.2026', now: NOW });
  return (
    <section className="probe">
      <h2>{titel}</h2>
      <p className="vp-pf-summe">
        {view.nettoText}
        <span className="vp-pf-summe-l">{view.titel}</span>
      </p>
    </section>
  );
}

function PortfolioSumme({ titel, sites }: { titel: string; sites: EarningsSite[] }) {
  const a = erloeseAggregat(sites);
  const zurechnung = steeringAttributionNote(a.savedEur);
  return (
    <section className="probe vp-pf-summenkarte">
      <h2>{titel}</h2>
      <p className="vp-pf-summe">
        {a.nettoEur == null ? '—' : signedEuro(a.nettoEur)}
        <span className="vp-pf-summe-l">Unterm Strich im Zeitraum</span>
      </p>
      {zurechnung && <p className="vp-pf-zurechnung">{zurechnung}</p>}
      <ul className="vp-pf-teile" aria-label="Woraus sich das Ergebnis zusammensetzt">
        {a.einspeiseEur != null && (
          <li>
            <span className="vp-pf-teil-l">Einspeise-Erlös</span>
            <span className="vp-pf-teil-v">{signedEuro(a.einspeiseEur)}</span>
          </li>
        )}
        {a.eigenverbrauchEur != null && (
          <li>
            <span className="vp-pf-teil-l">Wert des Eigenverbrauchs</span>
            <span className="vp-pf-teil-v">{signedEuro(a.eigenverbrauchEur)}</span>
          </li>
        )}
        {a.stromkostenEur != null && (
          <li>
            <span className="vp-pf-teil-l">Stromkosten (Netzbezug)</span>
            <span className="vp-pf-teil-v">{signedEuro(-a.stromkostenEur)}</span>
          </li>
        )}
      </ul>
      {a.ohneErgebnis > 0 && (
        <p className="vp-note">
          {a.ohneErgebnis === 1
            ? 'Für eine Anlage liegt in diesem Zeitraum noch kein Ergebnis vor – sie fehlt in der Summe.'
            : `Für ${a.ohneErgebnis} Anlagen liegt in diesem Zeitraum noch kein Ergebnis vor – sie fehlen in der Summe.`}
        </p>
      )}
    </section>
  );
}

const ohneErgebnis = {
  id: 'x',
  name: 'Neubau',
  reason: 'no_prices',
  series: [],
} as unknown as EarningsSite;

function App() {
  return (
    <main className="huelle">
      <h1>P9 · {NETTO_WORT}: dieselbe Zahl auf drei Flächen</h1>
      <p className="hinweis">
        Alle Zahlen aus <code>derived.json</code>, gerechnet durch die echten Ableitungen.
      </p>
      <CockpitHeld titel="Cockpit-Held · laufender Tag" money={LAUFEND} />
      <ErloesHeld titel="Erlöse-Held · derselbe Tag" money={LAUFEND} />
      <CockpitHeld titel="Cockpit-Held · ohne Tarif" money={OHNE_TARIF} />
      <CockpitHeld titel="Cockpit-Held · Negativpreis-Tag" money={NEGATIVPREIS} />
      <PortfolioSumme
        titel="Portfolio-Summe · drei Anlagen"
        sites={[
          flotte('a', 'Solarpark Dachau', LAUFEND),
          flotte('b', 'Hof Lindenberg', OHNE_TARIF),
          flotte('c', 'Gut Mienbach', NEGATIVPREIS),
        ]}
      />
      <PortfolioSumme
        titel="Portfolio-Summe · eine Anlage ohne Ergebnis"
        sites={[flotte('a', 'Solarpark Dachau', LAUFEND), ohneErgebnis]}
      />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />);
