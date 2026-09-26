import { describe, expect, it } from 'vitest';
import type { Earnings, EarningsSite, Overview, OverviewSite } from './api';
import {
  anlagenZeilen,
  leistenZellen,
  portfolioKennzahlen,
  vorteilUnterzeile,
} from './portfolioCockpit';

/**
 * **„Meine Anlagen" am 24.09.2026, 19:58** (Konzept `vp-erloese-minus-winter-k1`
 * §7.3, E5 = A; z1-Nebenkorrekturen): Herzogau liefert die Tageszahl nach
 * Definition A samt Einordnung, Mienbach schweigt seit dem 12.08.
 *
 * - Die Kachel „Mehrerlös heute" bleibt eine Tageszahl, bekommt Grund-Wort und
 *   Monatszeile und zählt nur BEITRAGENDE Anlagen („1 von 2 Anlagen").
 * - Die Tabellenzelle trägt das Kurzwort.
 * - Ein Ladestand vom 12.08. steht nie als aktuelle Zahl da.
 */
const JETZT = new Date('2026-09-24T19:58:00+02:00');

const MIENBACH_OV = {
  id: 'mienbach',
  name: 'Mienbach',
  plantKind: 'eigenverbrauch',
  netzladenErlaubt: false,
  batteryWithoutDevice: false,
  deviceCount: 1,
  onlineCount: 0,
  waitingCount: 0,
  worstStatus: 'offline',
  lastSeenAt: '2026-08-12T06:30:09.837Z',
  live: { ts: '2026-08-12T06:30:09.797Z', pvKw: 0.11, loadKw: 0.992, gridKw: 0.924, socPct: 6 },
  plannedSavingsTodayEur: null,
} as unknown as OverviewSite;

const HERZOGAU_OV = {
  ...MIENBACH_OV,
  id: 'herzogau',
  name: 'Pilsting / Herzogau',
  plantKind: 'direktvermarktung',
  onlineCount: 3,
  worstStatus: 'online',
  lastSeenAt: '2026-09-24T17:58:50.649Z',
  live: { ts: '2026-09-24T17:58:50.642Z', pvKw: 0, loadKw: 3.088, gridKw: 0.108, socPct: 29 },
} as unknown as OverviewSite;

const OVERVIEW = { sites: [MIENBACH_OV, HERZOGAU_OV], totals: {}, dailySavings: [] } as unknown as Overview;

const HERZOGAU_E = {
  id: 'herzogau',
  name: 'Pilsting / Herzogau',
  plantKind: 'direktvermarktung',
  savedEur: -0.784,
  savedSpeicherEur: 9.02,
  savedSteuerungEur: -9.804,
  dailySaved: [
    { day: '2026-09-23', savedEur: 9.99, savedSteuerungEur: 12.7755 },
    { day: '2026-09-24', savedEur: -0.784, savedSteuerungEur: -9.804 },
  ],
  vergleichSocStartKwh: 38.6,
  vergleichSocEndKwh: 13.8,
  speicherVorsprungKwh: 5.0,
  steuerungVortagEur: 12.7755,
  steuerungMonatBisherEur: 116.9402,
  steuerungPlannedEur: -9.8972,
  steuerungGruende: ['gestern_verkauft', 'haelt_energie_fuer_morgen'],
} as unknown as EarningsSite;

const MIENBACH_E = {
  id: 'mienbach',
  name: 'Mienbach',
  plantKind: 'eigenverbrauch',
  savedEur: null,
  savedSteuerungEur: null,
  reason: 'no_data',
  dailySaved: [],
} as unknown as EarningsSite;

const EARNINGS = {
  range: 'day',
  from: '2026-09-23T22:00:00Z',
  to: '2026-09-24T22:00:00Z',
  sites: [MIENBACH_E, HERZOGAU_E],
} as unknown as Earnings;

const sp = (s: string | null | undefined) => (s == null ? s : s.replace(/ /g, ' '));

describe('Portfolio · Kachel „Mehrerlös heute" (E5 = A)', () => {
  const k = portfolioKennzahlen(OVERVIEW, EARNINGS, JETZT);
  const zelle = leistenZellen({
    order: ['erloese'],
    kennzahlen: k,
    anlagen: 2,
    tonalitaet: 'direktvermarktung',
  })[0];

  it('bleibt die Tageszahl — Mienbach steckt nicht darin', () => {
    expect(k.erloesHeuteEur).toBeCloseTo(-9.804, 6);
    expect(k.erloesHeuteAnlagen).toBe(1);
    expect(zelle.label).toBe('Mehrerlös heute');
  });

  it('zählt nur beitragende Anlagen: „1 von 2 Anlagen"', () => {
    expect(zelle.unterzeile).toBe('gegenüber Speicher ohne Steuerung · 1 von 2 Anlagen');
    expect(vorteilUnterzeile(2, 2)).toBe('gegenüber Speicher ohne Steuerung · 2 Anlagen');
    expect(vorteilUnterzeile(1, 1)).toBe('gegenüber Speicher ohne Steuerung');
  });

  it('trägt Grund-Wort mit Zahl und die Monatszeile — ohne Paar, ohne Chip', () => {
    expect(sp(zelle.einordnung)).toBe('gestern verkauft + 12,78 € · September + 116,94 €');
  });

  it('nennt bei mehreren beitragenden Anlagen keinen Grund, aber den Monat', () => {
    const zweite = { ...HERZOGAU_E, id: 'b', steuerungGruende: ['so_geplant'] } as EarningsSite;
    const kk = portfolioKennzahlen(
      { ...OVERVIEW, sites: [HERZOGAU_OV, { ...HERZOGAU_OV, id: 'b' }] } as Overview,
      { ...EARNINGS, sites: [HERZOGAU_E, zweite] } as Earnings,
      JETZT,
    );
    expect(kk.erloesHeuteAnlagen).toBe(2);
    expect(sp(kk.erloesHeuteEinordnung)).toBe('September + 233,88 €');
  });

  it('ein Plus-Tag bekommt nur die Monatszeile', () => {
    const plus = {
      ...HERZOGAU_E,
      savedSteuerungEur: 2,
      savedEur: 11.02,
      dailySaved: [{ day: '2026-09-24', savedEur: 11.02, savedSteuerungEur: 2 }],
      steuerungGruende: [],
    } as unknown as EarningsSite;
    const kk = portfolioKennzahlen(OVERVIEW, { ...EARNINGS, sites: [plus] } as Earnings, JETZT);
    expect(sp(kk.erloesHeuteEinordnung)).toBe('September + 116,94 €');
  });
});

describe('Portfolio · Tabelle', () => {
  const zeilen = anlagenZeilen({ overview: OVERVIEW, earnings: EARNINGS, dichte: 'komfortabel', now: JETZT });
  const herzogau = zeilen.find((z) => z.id === 'herzogau')!;
  const mienbach = zeilen.find((z) => z.id === 'mienbach')!;

  it('die Heute-Zelle trägt das Kurzwort des Grundes', () => {
    expect(herzogau.heuteEur).toBeCloseTo(-9.804, 6);
    expect(herzogau.heuteGrund).toBe('gestern verkauft');
    expect(mienbach.heuteEur).toBeNull();
    expect(mienbach.heuteGrund).toBeNull();
  });

  it('ein Ladestand vom 12.08. ist datiert, der von vor zwei Minuten nicht', () => {
    expect(mienbach.ladestandPct).toBe(6);
    expect(mienbach.ladestandStand).toBe('am 12.08.');
    expect(herzogau.ladestandStand).toBeNull();
  });
});
