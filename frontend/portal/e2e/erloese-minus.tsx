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

import { Card } from '../designsystem/components/core/Card';
import { api } from '../src/api';
import type { Earnings, EarningsSite, Overview, OverviewSite, SiteEarnings, Site } from '../src/api';
import { AnlagenTabelle } from '../src/components/AnlagenTabelle';
import { MobileMoneyCard } from '../src/components/CockpitBlocks';
import { CockpitErgebnis } from '../src/components/erloese/CockpitErgebnis';
import { KennzahlLeiste } from '../src/components/KennzahlLeiste';
import { cockpitHero } from '../src/cockpitWidgets';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { anlagenZeilen, leistenZellen, portfolioKennzahlen } from '../src/portfolioCockpit';
import VEKTOREN from '../src/speicherAussage.vektoren.json';

/**
 * **Beweis-Harness „Minus-Tage einordnen"** (Konzept
 * `vp-erloese-minus-winter-k1` §7.3/§8, Paket P4): die vier Flächen —
 * Erlöse-Seite (echte `ErloeseSection`), Cockpit-Karte, Portfolio-Kachel und
 * Tabelle — mit den Zahlen der Referenzanlage aus
 * `src/speicherAussage.vektoren.json`.
 *
 * `?fall=herzogau-2409|plus-2309|winter-0909|monat-09` · `?flaeche=erloese|
 * cockpit|portfolio` · `?jetzt=…` (feste Uhr, `erloese-minus-uhr.ts`).
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seiten kennen die Harness nicht.
 */

interface Vektor {
  name: string;
  now: string;
  money: Partial<SiteEarnings>;
}
const V = (VEKTOREN as unknown as { faelle: Vektor[] }).faelle;
const vektor = (prefix: string) => V.find((f) => f.name.startsWith(prefix))!;

const SITE: Site = {
  id: 'herzogau',
  name: 'Pilsting / Herzogau',
  biddingZone: 'DE-LU',
  latitude: 48.7,
  longitude: 12.6,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: 6.9,
  tarifArt: 'fest',
  tarifParamCtKwh: 25,
  netzladenErlaubt: false,
  maxFeedInKw: 30,
};

/** Ein Tag der Referenzanlage: Vektor (Steuerung + Einordnung) + Kasse aus dem Konzept. */
interface Tag {
  vektor: string;
  at: string;
  kasse: {
    netto: number;
    einsp: number;
    ev: number;
    strom: number;
    eingespeist: number;
    selbst: number;
    bezogen: number;
    pv: number;
    last: number;
    plan: number | null;
    autarkie: number;
  };
}

const TAGE: Record<string, Tag> = {
  'herzogau-2409': {
    vektor: '24.09. laufend, Stand 19:58',
    at: '2026-09-24',
    kasse: { netto: 14.1, einsp: 0.8, ev: 23.91, strom: 10.61, eingespeist: 7.3, selbst: 95.6, bezogen: 42.4, pv: 116.2, last: 138.1, plan: -9.8972, autarkie: 69 },
  },
  'plus-2309': {
    vektor: '23.09. abgeschlossen',
    at: '2026-09-23',
    kasse: { netto: 73.46, einsp: 31.44, ev: 50.3, strom: 8.29, eingespeist: 174.4, selbst: 201.2, bezogen: 33.2, pv: 377.3, last: 234.4, plan: 23.7872, autarkie: 86 },
  },
  'winter-0909': {
    vektor: '09.09. abgeschlossen',
    at: '2026-09-09',
    kasse: { netto: 0.62, einsp: 0.79, ev: 22.69, strom: 22.86, eingespeist: 5.6, selbst: 90.8, bezogen: 91.5, pv: 96.3, last: 182.1, plan: -19.6757, autarkie: 50 },
  },
};

const params = new URLSearchParams(window.location.search);
const fallId = params.get('fall') ?? 'herzogau-2409';
const flaeche = params.get('flaeche') ?? 'erloese';
const monat = fallId === 'monat-09';
const tag = TAGE[monat ? 'herzogau-2409' : fallId] ?? TAGE['herzogau-2409'];
const vk = vektor(tag.vektor);

function stunden(at: string, n: number, netto: number) {
  const t0 = Date.parse(`${at}T04:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    start: new Date(t0 + i * 3600_000).toISOString(),
    einspeiseErloesEur: Math.max(0, netto * 0.3),
    eigenverbrauchsWertEur: Math.abs(netto) * 0.8 + 0.4,
    stromkostenEur: Math.abs(netto) * 0.2 + 0.3,
    nettoEur: netto,
  }));
}

function tagesGeld(): SiteEarnings {
  const k = tag.kasse;
  return {
    siteId: SITE.id,
    name: SITE.name,
    plantKind: 'direktvermarktung',
    tarifArt: 'fest',
    tarifParamCtKwh: 25,
    tarifPriced: true,
    exportVerguetungPriced: false,
    anzulegenderWertCtKwh: 6.9,
    coveredSlots: 80,
    firstCoveredDate: '2026-07-17',
    reason: null,
    nettoErgebnisEur: k.netto,
    einspeiseErloesEur: k.einsp,
    eigenverbrauchsWertEur: k.ev,
    stromkostenEur: k.strom,
    actualEur: k.strom - k.einsp,
    baselineEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    marktpraemieEur: 0,
    bezugspreisCtKwh: 25,
    realizedExportCtKwh: 10.9,
    marketValueSolarCtKwh: 6.9,
    marketValueProvisional: true,
    bezogenKwh: k.bezogen,
    eingespeistKwh: k.eingespeist,
    selbstverbrauchKwh: k.selbst,
    batterieBewegtKwh: 40,
    gesamtertragEur: k.einsp + k.ev,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    steuerungSplitReason: null,
    series: stunden(tag.at, 14, k.netto / 14),
    ...(vk.money as Partial<SiteEarnings>),
  } as SiteEarnings;
}

function monatsGeld(): SiteEarnings {
  const m = V.find((f) => f.name.startsWith('Monat September'))!.money;
  return {
    ...tagesGeld(),
    ...(m as Partial<SiteEarnings>),
    nettoErgebnisEur: 1167.36,
    einspeiseErloesEur: 398.09,
    eigenverbrauchsWertEur: 928.02,
    stromkostenEur: 158.74,
    selbstverbrauchKwh: 3712,
    eingespeistKwh: 3134,
    bezogenKwh: 635,
    series: stunden('2026-09-01', 24, 48),
  } as SiteEarnings;
}

api.siteEarnings = (async (_id: string, range: string) => {
  if (range === 'year') {
    return { ...monatsGeld(), range: 'year', savedEur: 400, savedSpeicherEur: 88.79, savedSteuerungEur: 311.21 };
  }
  return range === 'month' ? monatsGeld() : tagesGeld();
}) as unknown as typeof api.siteEarnings;

api.history = (async () => ({
  range: monat ? 'month' : 'day',
  from: vk.money.from,
  to: vk.money.to,
  buckets: [],
  totals: {
    pvGenerationKwh: monat ? 7420 : tag.kasse.pv,
    consumptionKwh: monat ? 4347 : tag.kasse.last,
    gridImportKwh: tag.kasse.bezogen,
    gridExportKwh: tag.kasse.eingespeist,
    autarkiePct: tag.kasse.autarkie,
    steuerungPlannedEur: monat ? null : tag.kasse.plan,
  },
  protocol: [],
  plan: [],
  coverage: { firstDataAt: '2026-07-17T00:00:00Z', resolutionMinutes: 15, expected: 96, measured: 80, gaps: 0 },
  events: [],
})) as unknown as typeof api.history;

// Die Adresse trägt Zeitraum und Tag — so öffnet die echte Seite genau diesen Fall.
if (flaeche === 'erloese') {
  window.location.hash = monat
    ? '#/anlage/herzogau/erloese?z=monat&at=2026-09-24'
    : `#/anlage/herzogau/erloese?z=tag&at=${tag.at}`;
}

function Cockpit() {
  const money = monat ? monatsGeld() : tagesGeld();
  const now = new Date();
  const view = cockpitHero({
    totals: {
      pvGenerationKwh: monat ? 7420 : tag.kasse.pv,
      consumptionKwh: monat ? 4347 : tag.kasse.last,
      autarkiePct: tag.kasse.autarkie,
    } as never,
    money,
    range: monat ? 'month' : 'day',
    at: new Date(`${monat ? '2026-09-24' : tag.at}T12:00:00`),
    now,
    jahrAnker: monat ? { eur: 311.21, jahr: 2026, laeuft: true } : null,
  });
  const seg = (
    <div className="vp-seg vp-seg-compact" role="tablist" aria-label="Zeitraum">
      {['Heute', 'Monat', 'Jahr', 'Gesamt'].map((t, i) => (
        <button key={t} type="button" role="tab" aria-selected={monat ? i === 1 : i === 0}>
          {t}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <div data-frame="cockpit-telefon" style={{ maxWidth: 375, minWidth: 0 }}>
        <MobileMoneyCard view={view} periodSeg={seg} nachtragHref="#/anlage/herzogau/technik" />
      </div>
      <div style={{ height: 24 }} />
      <div data-frame="cockpit-leiste" style={{ maxWidth: 360, minWidth: 0 }}>
        <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
          <CockpitErgebnis
            money={view.money!}
            periodSeg={seg}
            rings={view.rings}
            ringsNote={view.ringsNote}
            nachtragHref="#/anlage/herzogau/technik"
          />
        </Card>
      </div>
    </>
  );
}

function Portfolio() {
  const now = new Date();
  const money = tagesGeld();
  const herzogau = {
    ...money,
    id: SITE.id,
    dailySaved: [
      { day: '2026-09-23', savedEur: 9.99, savedSteuerungEur: money.steuerungVortagEur ?? 0 },
      { day: tag.at, savedEur: money.savedEur ?? 0, savedSteuerungEur: money.savedSteuerungEur ?? 0 },
    ],
  } as unknown as EarningsSite;
  const mienbach = {
    id: 'mienbach',
    name: 'Mienbach',
    plantKind: 'eigenverbrauch',
    savedEur: null,
    savedSteuerungEur: null,
    reason: 'no_data',
    dailySaved: [],
  } as unknown as EarningsSite;
  const earnings = { range: 'day', from: money.from, to: money.to, sites: [mienbach, herzogau] } as unknown as Earnings;
  const ov = (id: string, name: string, extra: Partial<OverviewSite>) =>
    ({
      id,
      name,
      plantKind: 'direktvermarktung',
      netzladenErlaubt: false,
      batteryWithoutDevice: false,
      deviceCount: 3,
      onlineCount: 3,
      waitingCount: 0,
      worstStatus: 'online',
      plannedSavingsTodayEur: null,
      energyToday: { pvKwh: tag.kasse.pv, loadKwh: tag.kasse.last, gridImportKwh: tag.kasse.bezogen, gridExportKwh: tag.kasse.eingespeist },
      ...extra,
    }) as unknown as OverviewSite;
  const overview = {
    sites: [
      ov('mienbach', 'Mienbach', {
        plantKind: 'eigenverbrauch',
        onlineCount: 0,
        worstStatus: 'offline',
        lastSeenAt: '2026-08-12T06:30:09.837Z',
        live: { ts: '2026-08-12T06:30:09.797Z', pvKw: 0.11, loadKw: 0.992, gridKw: 0.924, socPct: 6 },
        energyToday: null,
      } as never),
      ov(SITE.id, SITE.name, {
        lastSeenAt: new Date(now.getTime() - 60_000).toISOString(),
        live: { ts: new Date(now.getTime() - 60_000).toISOString(), pvKw: 0, loadKw: 3.1, gridKw: 0.1, socPct: 29 },
      } as never),
    ],
    totals: {},
    dailySavings: [],
  } as unknown as Overview;
  const k = portfolioKennzahlen(overview, earnings, now);
  const zellen = leistenZellen({
    order: ['erloese', 'pv-jetzt', 'erzeugung-heute', 'verbrauch-heute'],
    kennzahlen: k,
    anlagen: 2,
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
