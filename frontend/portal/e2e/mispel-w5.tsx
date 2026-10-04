import './erloese-minus-uhr';

import React from 'react';
import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/shell/Shell.css';
import '../src/components/Historie.css';
import '../src/components/Erloese.css';
import '../src/components/SoVerdient.css';
import '../src/components/Verlauf.css';
import '../src/components/BereichTabs.css';
import '../src/components/SteuerungFormel.css';
import '../src/components/FahrplanTagesbild.css';

import { Card } from '../designsystem/components/core/Card';
import { api } from '../src/api';
import type { Earnings, EarningsSite, Overview, OverviewSite, SiteEarnings, Site } from '../src/api';
import { AnlagenTabelle } from '../src/components/AnlagenTabelle';
import { MobileMoneyCard } from '../src/components/CockpitBlocks';
import { CockpitErgebnis } from '../src/components/erloese/CockpitErgebnis';
import { FahrplanAntworten } from '../src/components/FahrplanAntworten';
import { KennzahlLeiste } from '../src/components/KennzahlLeiste';
import { cockpitHero } from '../src/cockpitWidgets';
import { antwortBringt } from '../src/fahrplanAntworten';
import type { MispelMonat } from '../src/mispelMengen';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { anlagenZeilen, leistenZellen, portfolioKennzahlen } from '../src/portfolioCockpit';
import { speicherAussage } from '../src/speicherAussage';
import VEKTOREN from '../src/speicherAussage.vektoren.json';
import MISPEL from './mispel-mengen-fixtures.json';

/**
 * **Bühne „Netzladen nach MiSpeL“** (MiSpeL MP-18c, Bedienkonzept BK-W5 = A):
 * die vier Flächen — Erlöse-Seite (echte `ErloeseSection`), Cockpit-Karte,
 * Fahrplan-Antwort „Was hat es gebracht?“ und Portfolio — mit dem
 * Beispieltag des Bedienkonzepts (Kühlhaus Seebach, Mi. 17.11.2027,
 * Abgrenzungsoption; `src/speicherAussage.vektoren.json`).
 *
 * `?fall=offen|bestimmt|heute|monat|haendler|ohne` · `?flaeche=erloese|
 * cockpit|fahrplan|portfolio` · `?jetzt=…` (feste Uhr, `erloese-minus-uhr.ts`).
 *
 * - `offen`: abgeschlossener Tag, Monatslauf noch nicht gelaufen (Gutschrift offen)
 * - `bestimmt`: derselbe Tag nach dem Monatslauf (Gutschrift (20) bestimmt)
 * - `heute`: der Tag läuft (Cockpit am Abend)
 * - `monat`: November nach dem Monatslauf — Stromrechnung, Gutschrift, zusammen
 * - `haendler`: Förderweg „ungeförderte Direktvermarktung“ — „geschätzt“
 * - `ohne`: dieselbe Anlage ohne MiSpeL — wie bisher
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seiten kennen die Bühne nicht.
 */

interface Vektor {
  name: string;
  money: Partial<SiteEarnings>;
}
const V = (VEKTOREN as unknown as { faelle: Vektor[] }).faelle;
const SEEBACH = V.find((f) => f.name.startsWith('MiSpeL 17.11.2027 abgeschlossen'))!.money;

const params = new URLSearchParams(window.location.search);
const fallId = params.get('fall') ?? 'offen';
const flaeche = params.get('flaeche') ?? 'erloese';
const monat = fallId === 'monat';
const haendler = fallId === 'haendler';
const ohneMispel = fallId === 'ohne' || haendler;

const SITE: Site = {
  id: 'seebach',
  name: 'Kühlhaus Seebach',
  biddingZone: 'DE-LU',
  latitude: 48.4,
  longitude: 11.7,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: 6.95,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 8,
  netzladenErlaubt: true,
  maxFeedInKw: 600,
};

/** Die Kasse des Beispieltags (Bedienkonzept BK-W5, `rechnung.py`). */
const K = {
  netto: 53.54,
  einsp: 55.66,
  ev: 147.52,
  strom: 149.64,
  eingespeist: 344.6,
  selbst: 567.4,
  bezogen: 624.6,
  pv: 640,
  last: 880,
  plan: 0.62,
  autarkie: 29,
};

function stunden(at: string, n: number, netto: number) {
  const t0 = Date.parse(`${at}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    start: new Date(t0 + i * 3600_000).toISOString(),
    einspeiseErloesEur: Math.max(0, netto * 0.3) + 1,
    eigenverbrauchsWertEur: Math.abs(netto) * 0.8 + 3,
    stromkostenEur: Math.abs(netto) * 0.2 + 4,
    nettoEur: netto,
  }));
}

function tagesGeld(): SiteEarnings {
  const basis = {
    siteId: SITE.id,
    name: SITE.name,
    plantKind: 'direktvermarktung',
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 8,
    tarifPriced: true,
    exportVerguetungPriced: false,
    anzulegenderWertCtKwh: 6.95,
    coveredSlots: 96,
    firstCoveredDate: '2027-01-01',
    reason: null,
    nettoErgebnisEur: K.netto,
    einspeiseErloesEur: K.einsp,
    eigenverbrauchsWertEur: K.ev,
    stromkostenEur: K.strom,
    actualEur: K.strom - K.einsp,
    baselineEur: null,
    arbitrageEur: 12.4,
    pvShiftEur: null,
    // An Tagen der Abgrenzungsoption nur auf (23)¼ = 344,6 − 214,6 kWh (A1 S. 38).
    marktpraemieEur: ohneMispel ? 1.9 : 0.72,
    bezugspreisCtKwh: 24,
    realizedExportCtKwh: 15.6,
    marketValueSolarCtKwh: 6.4,
    marketValueProvisional: false,
    bezogenKwh: K.bezogen,
    eingespeistKwh: K.eingespeist,
    selbstverbrauchKwh: K.selbst,
    batterieBewegtKwh: 538,
    gesamtertragEur: K.einsp + K.ev,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    steuerungSplitReason: null,
    series: stunden('2027-11-16', 24, K.netto / 24),
    ...(SEEBACH as Partial<SiteEarnings>),
  } as SiteEarnings;
  if (!ohneMispel) return basis;
  // Ohne MiSpeL (oder im Händler-Modus): dieselbe Kasse, keine Tagessummen, der Server schickt den Rückfall.
  return {
    ...basis,
    steuerungGruende: ['anders_geladen'],
    mispelNetzstromverbrauchSpeicherKwh: null,
    mispelNetzeinspeisungSpeicherKwh: null,
    mispelMengenQuelle: null,
  } as SiteEarnings;
}

function monatsGeld(): SiteEarnings {
  return {
    ...tagesGeld(),
    range: 'month',
    from: '2027-10-31T23:00:00Z',
    to: '2027-11-30T23:00:00Z',
    savedEur: 120.14,
    savedSpeicherEur: 125.0,
    savedSteuerungEur: -4.86,
    steuerungVortagEur: null,
    steuerungMonatBisherEur: null,
    steuerungPlannedEur: null,
    steuerungGruende: null,
    speicherVorsprungKwh: null,
    speicherVorsprungEur: null,
    vergleichSocStartKwh: null,
    vergleichSocEndKwh: null,
    mispelNetzstromverbrauchSpeicherKwh: null,
    mispelNetzeinspeisungSpeicherKwh: null,
    mispelMengenQuelle: null,
    nettoErgebnisEur: 1388.2,
    einspeiseErloesEur: 1210.4,
    eigenverbrauchsWertEur: 3104.6,
    stromkostenEur: 2926.8,
    series: stunden('2027-11-01', 24, 50),
  } as SiteEarnings;
}

/** Der Monatslauf November 2027: offen bis zum Lauf, dann bestimmt (Bedienkonzept: (20) 1.926,667 kWh). */
function mispelMonat(): MispelMonat {
  const fx = (MISPEL as unknown as Record<string, MispelMonat>)['monat-2026-11'];
  const bestimmt = fallId === 'bestimmt' || monat;
  const betrag = (eur: number, satzCt: number) => ({
    stand: bestimmt ? ('bestimmt' as const) : ('offen' as const),
    eur: bestimmt ? eur : null,
    mengeKwh: bestimmt ? 1926.667 : null,
    formel: '(20)',
    satzCt,
    grund: bestimmt ? null : 'monatslauf_offen',
  });
  return {
    ...fx,
    monat: '2027-11',
    foerderweg: haendler ? 'ungefoerdert' : ohneMispel ? null : 'marktpraemie_abgrenzung',
    foerderwegBegriff: haendler ? 'ungeförderte Direktvermarktung' : 'Marktprämie mit Abgrenzungsoption',
    mispel: !ohneMispel,
    abgrenzung: !ohneMispel,
    stand: bestimmt ? 'endgueltig' : 'vorlaeufig',
    teile: fx.teile.map((t) => ({
      ...t,
      ersterTag: '2027-11-01',
      letzterTag: '2027-11-30',
      umlagereduziert: { ...t.umlagereduziert, kwh: bestimmt ? 1926.667 : t.umlagereduziert.kwh },
    })),
    wert: bestimmt
      ? {
          vermiedeneUmlagen: betrag(67.54, 2.946),
          vermiedenesNetzentgelt: betrag(186.17, 8.12),
          marktpraemie: { stand: 'offen', eur: null, mengeKwh: null, formel: '(32)', satzCt: null, grund: 'jahresmarktwert_offen' },
          summeOhneMarktpraemieEur: 253.71,
          ustPct: 19,
        }
      : null,
  } as MispelMonat;
}

api.siteEarnings = (async (_id: string, range: string) => {
  if (range === 'year') {
    return { ...monatsGeld(), range: 'year', savedEur: 400, savedSpeicherEur: 382.66, savedSteuerungEur: 17.34 };
  }
  return range === 'month' ? monatsGeld() : tagesGeld();
}) as unknown as typeof api.siteEarnings;
api.mispelMonat = (async () => mispelMonat()) as typeof api.mispelMonat;
api.mispelJahr = (async () => {
  throw new Error('Bühne: kein Jahr');
}) as typeof api.mispelJahr;
api.ladepunktErtraege = (async () => {
  throw new Error('Bühne: kein Ladepunkt');
}) as typeof api.ladepunktErtraege;

api.history = (async () => ({
  range: monat ? 'month' : 'day',
  from: monat ? '2027-10-31T23:00:00Z' : SEEBACH.from,
  to: monat ? '2027-11-30T23:00:00Z' : SEEBACH.to,
  buckets: [],
  totals: {
    pvGenerationKwh: monat ? 9800 : K.pv,
    consumptionKwh: monat ? 26400 : K.last,
    gridImportKwh: K.bezogen,
    gridExportKwh: K.eingespeist,
    autarkiePct: K.autarkie,
    steuerungPlannedEur: monat ? null : K.plan,
  },
  protocol: [],
  plan: [],
  coverage: { firstDataAt: '2027-01-01T00:00:00Z', resolutionMinutes: 15, expected: 96, measured: 96, gaps: 0 },
  events: [],
})) as unknown as typeof api.history;

if (flaeche === 'erloese') {
  window.location.hash = monat
    ? '#/anlage/seebach/erloese?z=monat&at=2027-11-17'
    : '#/anlage/seebach/erloese?z=tag&at=2027-11-17';
}

function Cockpit() {
  const money = tagesGeld();
  const view = cockpitHero({
    totals: { pvGenerationKwh: K.pv, consumptionKwh: K.last, autarkiePct: K.autarkie } as never,
    money,
    range: 'day',
    at: new Date('2027-11-17T12:00:00'),
    now: new Date(),
    jahrAnker: null,
  });
  const seg = (
    <div className="vp-seg vp-seg-compact" role="tablist" aria-label="Zeitraum">
      {['Heute', 'Monat', 'Jahr', 'Gesamt'].map((t, i) => (
        <button key={t} type="button" role="tab" aria-selected={i === 0}>
          {t}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <div data-frame="cockpit-telefon" style={{ maxWidth: 375, minWidth: 0 }}>
        <MobileMoneyCard view={view} periodSeg={seg} nachtragHref="#/anlage/seebach/technik" />
      </div>
      <div style={{ height: 24 }} />
      <div data-frame="cockpit-leiste" style={{ maxWidth: 360, minWidth: 0 }}>
        <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
          <CockpitErgebnis
            money={view.money!}
            periodSeg={seg}
            rings={view.rings}
            ringsNote={view.ringsNote}
            nachtragHref="#/anlage/seebach/technik"
          />
        </Card>
      </div>
    </>
  );
}

function Fahrplan() {
  const aussage = speicherAussage(tagesGeld(), { now: new Date(), steuerungGeplantEur: K.plan });
  const antwort = antwortBringt(aussage, fallId === 'heute' ? 'heute' : 'gestern');
  return (
    <div data-frame="fahrplan" style={{ maxWidth: 560, minWidth: 0 }}>
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <FahrplanAntworten antworten={antwort ? [antwort] : []} gewaehlt={null} onWahl={() => {}} form="liste" />
        {aussage?.geplant && <p className="vp-tb-antwort-zusatz" data-planwert>{aussage.geplant}</p>}
      </Card>
    </div>
  );
}

function Portfolio() {
  const now = new Date();
  const money = tagesGeld();
  const seebach = {
    ...money,
    id: SITE.id,
    dailySaved: [
      { day: '2027-11-16', savedEur: 9.99, savedSteuerungEur: 6.18 },
      { day: '2027-11-17', savedEur: money.savedEur ?? 0, savedSteuerungEur: money.savedSteuerungEur ?? 0 },
    ],
  } as unknown as EarningsSite;
  const earnings = { range: 'day', from: money.from, to: money.to, sites: [seebach] } as unknown as Earnings;
  const overview = {
    sites: [
      {
        id: SITE.id,
        name: SITE.name,
        plantKind: 'direktvermarktung',
        netzladenErlaubt: true,
        batteryWithoutDevice: false,
        deviceCount: 4,
        onlineCount: 4,
        waitingCount: 0,
        worstStatus: 'online',
        plannedSavingsTodayEur: null,
        energyToday: { pvKwh: K.pv, loadKwh: K.last, gridImportKwh: K.bezogen, gridExportKwh: K.eingespeist },
        lastSeenAt: new Date(now.getTime() - 60_000).toISOString(),
        live: { ts: new Date(now.getTime() - 60_000).toISOString(), pvKw: 0, loadKw: 32.7, gridKw: -107, socPct: 41 },
      } as unknown as OverviewSite,
    ],
    totals: {},
    dailySavings: [],
  } as unknown as Overview;
  const k = portfolioKennzahlen(overview, earnings, now);
  const zellen = leistenZellen({
    order: ['erloese', 'pv-jetzt', 'erzeugung-heute', 'verbrauch-heute'],
    kennzahlen: k,
    anlagen: 1,
    tonalitaet: 'direktvermarktung',
  });
  const zeilen = anlagenZeilen({ overview, earnings, dichte: 'komfortabel', now });
  return (
    <div className="vp-portfolio" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <KennzahlLeiste zellen={zellen} label="Heute" />
      <AnlagenTabelle
        zeilen={zeilen}
        spalten={['pv-jetzt', 'speicher', 'netz-heute', 'erloese']}
        dichte="komfortabel"
        offen={null}
        onToggle={() => {}}
        onOeffnen={() => {}}
        vorschau={null}
      />
    </div>
  );
}

function Inhalt() {
  if (flaeche === 'cockpit') return <Cockpit />;
  if (flaeche === 'fahrplan') return <Fahrplan />;
  if (flaeche === 'portfolio') return <Portfolio />;
  return <ErloeseSection site={SITE} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--vp-c-bg, #f8fafc)' }}>
      <main className="vp-main" data-fall={fallId} data-flaeche={flaeche} style={{ padding: '16px', minWidth: 0 }}>
        <Inhalt />
      </main>
    </div>
  </React.StrictMode>,
);
