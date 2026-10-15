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
import { GeldKachel } from '../src/components/kacheln/CockpitKacheln';
import '../src/components/kacheln/Kacheln.css';
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
 * **Oktober mit Bestand** (Bedienkonzept `vp-herzogau-p3-kachel-konzept`,
 * Captain 14.10.2026 HZ-3 A, P3-1 bis P3-4 A): `?fall=okt-1308` (Di 13.10.,
 * 08:15, laufend), `okt-1310` (Rückblick 13.10.), `okt-1210` (Rückblick
 * 12.10.), `okt-1410` (Mi 14.10. vor dem ersten Eimer), `okt-monat`. Die
 * Kasse und die alten Felder sind die der Ist-Bilder des Konzepts, die neuen
 * Felder (`steuerungZeitraum`, `…MitBestandEur`) kommen aus
 * `speicherAussage.vektoren.json` (erzeugt aus dem Vertrag `mit_bestand`).
 * Der Stub antwortet nach `range` UND `at` (Nebenbefund 4 des Konzepts).
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
const oktober = fallId.startsWith('okt-');
const monat = fallId === 'monat-09' || fallId === 'okt-monat';
const tag = TAGE[monat || oktober ? 'herzogau-2409' : fallId] ?? TAGE['herzogau-2409'];
const vk = vektor(tag.vektor);

// ---------------------------------------------------------------- Oktober mit Bestand

type Kasse = Tag['kasse'];
/** Ein Oktober-Tag: Kasse und alte Felder wie die Ist-Bilder des Konzepts, neue aus dem Vektor. */
interface OktTag {
  at: string;
  kasse: Kasse;
  alt: Partial<SiteEarnings>;
  vektor: string | null;
}
const OKT: Record<string, OktTag> = {
  '13-laufend': {
    at: '2026-10-13',
    kasse: { netto: -8.22, einsp: 0, ev: 0.32, strom: 8.54, eingespeist: 0, selbst: 1.3, bezogen: 34.2, pv: 1.3, last: 35.5, plan: null, autarkie: 4 },
    alt: {
      savedEur: 0, savedSpeicherEur: 8, savedSteuerungEur: -8, speicherDeltaKwh: 0, speicherWertEur: 0, speicherWertCtKwh: 28.7,
      speicherWertBasis: 'plan', vergleichSocStartKwh: 36.6, vergleichSocEndKwh: 3.3, speicherVorsprungKwh: 0, speicherVorsprungEur: 0,
      steuerungVortagEur: 12.1, steuerungMonatBisherEur: 25.85, steuerungPlannedEur: null, steuerungGruende: ['gestern_verkauft'],
    },
    vektor: 'Oktober Herzogau mit Bestand · Di 13.10., 08:15',
  },
  '13': {
    at: '2026-10-13',
    kasse: { netto: 42.49, einsp: 11.55, ev: 42.62, strom: 11.68, eingespeist: 78.1, selbst: 170.5, bezogen: 46.7, pv: 255.1, last: 217.2, plan: null, autarkie: 78 },
    alt: {
      savedEur: 1.27, savedSpeicherEur: 5.75, savedSteuerungEur: -4.48, speicherDeltaKwh: 4.3, speicherWertEur: 1.13, speicherWertCtKwh: 26.3,
      speicherWertBasis: 'plan', vergleichSocStartKwh: 36.6, vergleichSocEndKwh: 31.9, speicherVorsprungKwh: -24.4, speicherVorsprungEur: -6.42,
      steuerungVortagEur: 12.1, steuerungMonatBisherEur: 29.37, steuerungPlannedEur: null, steuerungGruende: ['gestern_verkauft'],
    },
    vektor: 'Oktober Herzogau mit Bestand · Rückblick Di 13.10.',
  },
  '12': {
    at: '2026-10-12',
    kasse: { netto: 66.27, einsp: 26.92, ev: 48.98, strom: 9.63, eingespeist: 124.6, selbst: 195.9, bezogen: 38.5, pv: 296.3, last: 234.5, plan: null, autarkie: 84 },
    alt: {
      savedEur: 12.67, savedSpeicherEur: 0.57, savedSteuerungEur: 12.1, speicherDeltaKwh: -30.2, speicherWertEur: -8.67, speicherWertCtKwh: 28.7,
      speicherWertBasis: 'plan', vergleichSocStartKwh: 23.4, vergleichSocEndKwh: 36.6, speicherVorsprungKwh: -33.4, speicherVorsprungEur: -9.59,
      steuerungVortagEur: -2.65, steuerungMonatBisherEur: 33.85, steuerungPlannedEur: null, steuerungGruende: [],
    },
    vektor: 'Oktober Herzogau mit Bestand · Rückblick Mo 12.10.',
  },
};
const jetztIst = () => new Date();
/** Der Oktober-Tag hinter `at`: am 13.10. hängt er an der Uhr (läuft er noch?). */
function oktTag(at: string): OktTag | null {
  if (at === '2026-10-12') return OKT['12'];
  if (at === '2026-10-13') return jetztIst().getTime() < Date.parse('2026-10-13T22:00:00Z') ? OKT['13-laufend'] : OKT['13'];
  return null;
}
function oktGeld(t: OktTag): SiteEarnings {
  const k = t.kasse;
  const neu = t.vektor ? (vektor(t.vektor).money as Partial<SiteEarnings>) : {};
  const from = new Date(Date.parse(`${t.at}T00:00:00+02:00`)).toISOString().replace('.000', '');
  const to = new Date(Date.parse(`${t.at}T00:00:00+02:00`) + 86_400_000).toISOString().replace('.000', '');
  return {
    ...basisGeld(k, t.at),
    ...neu,
    ...t.alt,
    range: 'day',
    from,
    to,
  } as SiteEarnings;
}
/** Mi 14.10. vor dem ersten Eimer: keine Kasse, aber Monat und 7 Tage mit Bestand. */
function oktLeer(): SiteEarnings {
  const rueck = oktGeld(OKT['13']);
  const z = rueck.steuerungZeitraum!;
  return {
    ...basisGeld(OKT['13'].kasse, '2026-10-14'),
    range: 'day',
    from: '2026-10-13T22:00:00Z',
    to: '2026-10-14T22:00:00Z',
    coveredSlots: 0,
    reason: 'no_data',
    nettoErgebnisEur: null,
    einspeiseErloesEur: null,
    eigenverbrauchsWertEur: null,
    stromkostenEur: null,
    savedEur: null,
    savedSpeicherEur: null,
    savedSteuerungEur: null,
    savedSteuerungMitBestandEur: null,
    bezogenKwh: null,
    eingespeistKwh: null,
    selbstverbrauchKwh: null,
    gesamtertragEur: null,
    series: [],
    steuerungZeitraum: { ...z, monat: { ...z.monat, bis: '2026-10-14' }, heute: null },
  } as unknown as SiteEarnings;
}
function oktMonat(range: 'week' | 'month' | 'year'): SiteEarnings {
  const m = vektor('Oktober Herzogau mit Bestand · Monat Oktober').money as Partial<SiteEarnings>;
  return {
    ...basisGeld(OKT['13'].kasse, '2026-10-01'),
    ...m,
    range,
    nettoErgebnisEur: 512.4,
    einspeiseErloesEur: 210.3,
    eigenverbrauchsWertEur: 401.6,
    stromkostenEur: 99.5,
    series: stunden('2026-10-01', 24, 20),
  } as SiteEarnings;
}

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
  return { ...basisGeld(tag.kasse, tag.at), ...(vk.money as Partial<SiteEarnings>) } as SiteEarnings;
}

function basisGeld(k: Kasse, at: string): SiteEarnings {
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
    series: stunden(at, 14, k.netto / 14),
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

api.siteEarnings = (async (_id: string, range: string, at?: string | null) => {
  if (oktober) {
    // Nach `range` UND `at` (Nebenbefund 4): jeder Tag hat seine Antwort.
    if (range === 'week' || range === 'month' || range === 'year') return oktMonat(range);
    const t = oktTag(at ?? '2026-10-13');
    return t ? oktGeld(t) : oktLeer();
  }
  if (range === 'year') {
    return { ...monatsGeld(), range: 'year', savedEur: 400, savedSpeicherEur: 88.79, savedSteuerungEur: 311.21 };
  }
  if (range === 'week') return { ...monatsGeld(), range: 'week' };
  return range === 'month' ? monatsGeld() : tagesGeld();
}) as unknown as typeof api.siteEarnings;

api.history = (async (_id: string, range: string, at?: string | null) => {
  const k = oktober ? (oktTag(at ?? '2026-10-13')?.kasse ?? OKT['13'].kasse) : tag.kasse;
  const g = oktober ? fallGeld() : vk.money;
  return {
    range: monat ? 'month' : 'day',
    from: g.from,
    to: g.to,
    buckets: [],
    totals: {
      pvGenerationKwh: monat ? 7420 : k.pv,
      consumptionKwh: monat ? 4347 : k.last,
      gridImportKwh: k.bezogen,
      gridExportKwh: k.eingespeist,
      autarkiePct: k.autarkie,
      steuerungPlannedEur: monat ? null : k.plan,
    },
    protocol: [],
    plan: [],
    coverage: { firstDataAt: '2026-07-17T00:00:00Z', resolutionMinutes: 15, expected: 96, measured: 80, gaps: 0 },
    events: [],
  };
}) as unknown as typeof api.history;

// Die Adresse trägt Zeitraum und Tag — so öffnet die echte Seite genau diesen Fall.
const OKT_AT: Record<string, string> = {
  'okt-1308': '2026-10-13',
  'okt-1310': '2026-10-13',
  'okt-1210': '2026-10-12',
  'okt-1410': '2026-10-14',
  'okt-monat': '2026-10-13',
};
if (flaeche === 'erloese') {
  window.location.hash = oktober
    ? `#/anlage/herzogau/erloese?z=${monat ? 'monat' : 'tag'}&at=${OKT_AT[fallId] ?? '2026-10-13'}`
    : monat
      ? '#/anlage/herzogau/erloese?z=monat&at=2026-09-24'
      : `#/anlage/herzogau/erloese?z=tag&at=${tag.at}`;
}

/** Das Geld, das Cockpit und Portfolio dieses Falls zeigen. */
function fallGeld(): SiteEarnings {
  if (oktober) {
    if (monat) return oktMonat('month');
    const t = oktTag(OKT_AT[fallId] ?? '2026-10-13');
    return t ? oktGeld(t) : oktLeer();
  }
  return monat ? monatsGeld() : tagesGeld();
}
const fallKasse = (): Kasse => (oktober ? (oktTag(OKT_AT[fallId] ?? '2026-10-13')?.kasse ?? OKT['13'].kasse) : tag.kasse);

function Cockpit() {
  const money = fallGeld();
  const kasse = fallKasse();
  const now = new Date();
  const view = cockpitHero({
    totals: {
      pvGenerationKwh: monat ? 7420 : kasse.pv,
      consumptionKwh: monat ? 4347 : kasse.last,
      autarkiePct: kasse.autarkie,
    } as never,
    money,
    range: monat ? 'month' : 'day',
    at: new Date(`${oktober ? (OKT_AT[fallId] ?? '2026-10-13') : monat ? '2026-09-24' : tag.at}T12:00:00`),
    now,
    jahrAnker: monat && !oktober ? { eur: 311.21, jahr: 2026, laeuft: true } : null,
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
      {/* Die Kachel „Unterm Strich“, wie das Anlagen-Cockpit sie heute zeigt. */}
      <div data-frame="cockpit-kachel" style={{ maxWidth: 560, minWidth: 0 }}>
        <GeldKachel money={view.money} periodSeg={seg} />
      </div>
      <div style={{ height: 24 }} />
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

/** Die 14-Tage-Reihe der Mandanten-Route im Oktober: je Tag Kasse und Zahl mit Bestand. */
function oktReihe(money: SiteEarnings): EarningsSite['dailySaved'] {
  // Die Fenster 6.–12. (08:15) und 7.–13. (Rückblick) ergeben zusammen die Tage 6.–13.10.
  const jeTag = new Map<string, NonNullable<SiteEarnings['steuerungZeitraum']>['tage'][number]>();
  for (const t of [...oktGeld(OKT['13-laufend']).steuerungZeitraum!.tage, ...oktGeld(OKT['13']).steuerungZeitraum!.tage]) {
    jeTag.set(t.tag, t);
  }
  const tage = [...jeTag.values()]
    .sort((a, b) => a.tag.localeCompare(b.tag))
    .map((t) => ({
      day: t.tag,
      savedEur: 0,
      savedSteuerungEur: t.steuerungEur ?? 0,
      mitBestandEur: t.mitBestandEur,
    }));
  const heute = money.steuerungZeitraum?.heute;
  return heute && heute.tag === '2026-10-13'
    ? [...tage.filter((t) => t.day !== '2026-10-13'), { day: heute.tag, savedEur: 0, savedSteuerungEur: heute.steuerungEur ?? 0, mitBestandEur: heute.mitBestandEur }]
    : tage;
}

function Portfolio() {
  const now = new Date();
  const money = fallGeld();
  const herzogau = {
    ...money,
    id: SITE.id,
    ...(oktober
      ? {
          dailySaved: oktReihe(money),
          steuerungMonatMitBestandEur: money.steuerungZeitraum?.monat.mitBestandEur ?? null,
        }
      : {
          dailySaved: [
            { day: '2026-09-23', savedEur: 9.99, savedSteuerungEur: money.steuerungVortagEur ?? 0 },
            { day: tag.at, savedEur: money.savedEur ?? 0, savedSteuerungEur: money.savedSteuerungEur ?? 0 },
          ],
        }),
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
      energyToday: { pvKwh: fallKasse().pv, loadKwh: fallKasse().last, gridImportKwh: fallKasse().bezogen, gridExportKwh: fallKasse().eingespeist },
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
