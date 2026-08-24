import { describe, expect, it } from 'vitest';
import type { Earnings, EarningsSite, Overview, OverviewSite, RoleCounts } from './api';
import {
  hasEntities,
  modeChips,
  portfolioKpis,
  roleBadges,
  siteNowKw,
  siteSavedToday,
  siteSoc,
  siteStatus,
  portfolioSurfaceInput,
} from './portfolio';
import { activeModes } from './surface';

const NOW = new Date('2026-07-20T12:00:00Z');

function site(over: Partial<OverviewSite>): OverviewSite {
  return {
    id: 's1',
    name: 'Werk',
    plantKind: 'direktvermarktung',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: NOW.toISOString(),
    live: { ts: NOW.toISOString(), pvKw: 4.2, loadKw: 1.1, gridKw: -0.9, socPct: 61 },
    plannedSavingsTodayEur: 1.1,
    roleCounts: { pv: 3, storage: 2, consumer: 1, grid: 1 },
    usageProfile: 'arbitrage',
    ...over,
  };
}

function earningsSite(over: Partial<EarningsSite>): EarningsSite {
  return {
    id: 's1',
    name: 'Werk',
    plantKind: 'direktvermarktung',
    anzulegenderWertCtKwh: null,
    realizedExportCtKwh: null,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    baselineEur: null,
    actualEur: null,
    savedEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 0,
    firstCoveredDate: null,
    reason: null,
    dailySaved: [],
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    einspeiseErloesEur: null,
    eigenverbrauchsWertEur: null,
    gesamtertragEur: null,
    selbstverbrauchKwh: null,
    eingespeistKwh: null,
    batterieBewegtKwh: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: [],
    monthlyStrip: [],
    ...over,
  };
}

describe('roleBadges (Σ per role)', () => {
  it('shows only non-zero roles in canonical order (pv, storage, consumer, grid)', () => {
    const counts: RoleCounts = { pv: 3, storage: 2, consumer: 1, grid: 1 };
    const badges = roleBadges(counts);
    expect(badges.map((b) => b.role)).toEqual(['pv', 'storage', 'consumer', 'grid']);
    expect(badges.map((b) => b.count)).toEqual([3, 2, 1, 1]);
    // Icons come from the design-system Icon set, never emoji glyphs.
    expect(badges.map((b) => b.icon)).toEqual(['sun', 'battery', 'zap', 'activity']);
    expect(badges[1].label).toBe('Speicher');
  });

  it('drops zero roles and treats an all-zero / absent count as no entities', () => {
    expect(roleBadges({ pv: 0, storage: 2, consumer: 0, grid: 0 }).map((b) => b.role)).toEqual([
      'storage',
    ]);
    expect(roleBadges({ pv: 0, storage: 0, consumer: 0, grid: 0 })).toEqual([]);
    expect(roleBadges(undefined)).toEqual([]);
    expect(hasEntities({ pv: 0, storage: 0, consumer: 0, grid: 0 })).toBe(false);
    expect(hasEntities({ pv: 1, storage: 0, consumer: 0, grid: 0 })).toBe(true);
    expect(hasEntities(undefined)).toBe(false);
  });
});

describe('modeChips (M6: the projection per portfolio row)', () => {
  it('shows the SET of active modes, not one winning face', () => {
    // Direktvermarktung + Speicher/PV + Leistungspreis = three modes at once -
    // exactly what the retired single Profil-Chip could never say.
    const chips = modeChips(
      site({ plantKind: 'direktvermarktung', usageProfile: 'peak' }),
      { tarifArt: 'dynamisch', leistungspreisEurKw: 95 },
    );
    expect(chips.map((c) => c.kind)).toEqual(['lastspitzenkappung', 'marktvermarktung']);
    expect(chips.map((c) => c.label)).toEqual(['Lastspitzenkappung', 'Marktoptimierung']);
    // The keys are the M0 mode keys (stable React keys).
    expect(chips.map((c) => c.key)).toEqual(['lastspitzenkappung', 'marktvermarktung']);
  });

  it('a non-DV PV+Speicher Anlage has no mode chip (Eigenverbrauch ist Grundverhalten)', () => {
    const chips = modeChips(
      site({ plantKind: 'eigenverbrauch', usageProfile: 'private' }),
      { tarifArt: 'fest', leistungspreisEurKw: null },
    );
    expect(chips.map((c) => c.kind)).toEqual([]);
  });

  it('trusts the server AE7 winner for a flow-driven mode the master data cannot explain', () => {
    // No Leistungspreis in the master data, but the api derived "peak" - so a
    // peak strategy FLOW is active. The chip appears rather than going missing.
    const chips = modeChips(
      site({ plantKind: 'eigenverbrauch', usageProfile: 'peak' }),
      { tarifArt: 'ohne', leistungspreisEurKw: null },
    );
    expect(chips.map((c) => c.kind)).toContain('lastspitzenkappung');
    // ... and it is honestly labelled flow-driven, not "von VoltPilot eingerichtet".
    const modes = activeModes(portfolioSurfaceInput(
      site({ plantKind: 'eigenverbrauch', usageProfile: 'peak' }),
      { tarifArt: 'ohne', leistungspreisEurKw: null },
    ));
    expect(modes.find((m) => m.kind === 'lastspitzenkappung')?.origin).toBe('flow');
  });

  it('keeps a leistungspreis-driven peak mode master-data-driven (no faked flow)', () => {
    const modes = activeModes(portfolioSurfaceInput(
      site({ plantKind: 'eigenverbrauch', usageProfile: 'peak' }),
      { tarifArt: 'ohne', leistungspreisEurKw: 120 },
    ));
    expect(modes.find((m) => m.kind === 'lastspitzenkappung')?.origin).toBe('masterdata');
  });

  it('a never-migrated Anlage has NO chips - the cell reads "—", never a face', () => {
    expect(
      modeChips(
        site({
          plantKind: 'eigenverbrauch',
          netzladenErlaubt: false,
          roleCounts: undefined,
          usageProfile: undefined,
        }),
        null,
      ),
    ).toEqual([]);
    // Same for an older backend that omits roleCounts AND usageProfile while
    // the SiteDto carries no tariff/Leistungspreis either.
    expect(
      modeChips(site({ plantKind: 'eigenverbrauch', roleCounts: undefined, usageProfile: undefined }), {
        tarifArt: 'ohne',
        leistungspreisEurKw: null,
      }),
    ).toEqual([]);
  });

  it('honours the F4 rule: Netzladen on a dynamic tariff IS market mode', () => {
    const chips = modeChips(
      site({ plantKind: 'eigenverbrauch', netzladenErlaubt: true, usageProfile: 'private' }),
      { tarifArt: 'dynamisch', leistungspreisEurKw: null },
    );
    expect(chips.map((c) => c.kind)).toEqual(['marktvermarktung']);
  });
});

describe('per-row derivations', () => {
  it('siteStatus reduces the fleet liveness rules to a one-word verdict', () => {
    expect(siteStatus(site({ deviceCount: 0, onlineCount: 0 }))).toEqual({
      label: 'Kein Gerät',
      tone: 'off',
    });
    expect(siteStatus(site({ deviceCount: 2, onlineCount: 1, waitingCount: 0 })).tone).toBe('warn');
    expect(siteStatus(site({ deviceCount: 2, onlineCount: 1, waitingCount: 0 })).label).toBe(
      'Meldet sich nicht',
    );
    expect(siteStatus(site({ deviceCount: 1, onlineCount: 0, waitingCount: 1 }))).toEqual({
      label: 'Wartet auf Daten',
      tone: 'warn',
    });
    expect(siteStatus(site({}))).toEqual({ label: 'Online', tone: 'ok' });
  });

  it('siteSoc sanitizes the live reading, siteNowKw only shows a FRESH PV value', () => {
    expect(siteSoc(site({ live: { ts: NOW.toISOString(), pvKw: 1, loadKw: 0, gridKw: 0, socPct: 61 } }))).toBe(61);
    // Implausible SoC → null (never a spike).
    expect(siteSoc(site({ live: { ts: NOW.toISOString(), pvKw: 1, loadKw: 0, gridKw: 0, socPct: 1270 } }))).toBeNull();
    expect(siteSoc(site({ live: null }))).toBeNull();
    // Fresh live → PV shows; a stale snapshot (old ts) hides the number.
    expect(siteNowKw(site({}), NOW)).toBe(4.2);
    const stale = site({
      onlineCount: 1,
      live: { ts: '2026-07-20T10:00:00Z', pvKw: 4.2, loadKw: 1, gridKw: 0, socPct: 61 },
    });
    expect(siteNowKw(stale, NOW)).toBeNull();
  });

  it('siteSavedToday reads the site 14-day series at the Berlin day', () => {
    const es = earningsSite({ dailySaved: [{ day: '2026-07-20', savedEur: 3.5 }] });
    expect(siteSavedToday(es, NOW)).toBe(3.5);
    expect(siteSavedToday(earningsSite({ dailySaved: [] }), NOW)).toBeNull();
    expect(siteSavedToday(null, NOW)).toBeNull();
  });
});

describe('portfolioKpis (aggregate KPI row)', () => {
  const overview: Overview = {
    sites: [
      site({ id: 'a', live: { ts: NOW.toISOString(), pvKw: 4, loadKw: 1, gridKw: 0, socPct: 60 } }),
      site({ id: 'b', live: { ts: NOW.toISOString(), pvKw: 2, loadKw: 1, gridKw: 0, socPct: 80 } }),
      site({ id: 'c', live: null }),
    ],
    totals: {
      sites: 3,
      devices: 3,
      online: 3,
      plannedSavingsTodayEur: 1,
      liveSitesCovered: 2,
      storageCapacityKwh: 130,
      storagePowerKw: 60,
    },
    dailySavings: [],
  };

  const earnings: Earnings = {
    range: 'month',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
    sites: [
      earningsSite({
        id: 'a',
        savedEur: 20,
        dailySaved: [{ day: '2026-07-20', savedEur: 2 }],
        peakShaving: {
          leistungspreisEurKw: 100,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: 40,
          baselinePeakKw: 55,
          avoidedKw: 15,
          avoidedEur: 1500,
          history: [],
        },
      }),
      earningsSite({
        id: 'b',
        savedEur: 12,
        dailySaved: [{ day: '2026-07-20', savedEur: 1.5 }],
        peakShaving: null,
      }),
    ],
    totals: {
      baselineEur: null,
      actualEur: null,
      savedEur: 32,
      arbitrageEur: null,
      pvShiftEur: null,
      coveredSlots: 10,
      firstCoveredDate: '2026-07-01',
    },
  };

  it('aggregates storage, SoC, Erlös and vermiedene Spitze honestly', () => {
    const k = portfolioKpis(overview, earnings, NOW);
    expect(k.storageKwh).toBe(130);
    expect(k.storageKw).toBe(60);
    // Ø SoC over the two sites with a plausible reading (the null-live site skipped).
    expect(k.portfolioSoc).toBe(70);
    expect(k.erloesRange).toBe(32);
    expect(k.erloesHeute).toBe(3.5);
    // Only the module-active site contributes to the avoided-peak sum.
    expect(k.avoidedPeakEur).toBe(1500);
    expect(k.avoidedPeakKw).toBe(15);
  });

  it('nulls (never fake zeros) when nothing is computable', () => {
    const k = portfolioKpis(
      { sites: [site({ live: null })], totals: { ...overview.totals, storageCapacityKwh: null, storagePowerKw: null } , dailySavings: [] },
      { ...earnings, sites: [], totals: { ...earnings.totals, savedEur: null } },
      NOW,
    );
    expect(k.storageKwh).toBeNull();
    expect(k.storageKw).toBeNull();
    expect(k.portfolioSoc).toBeNull();
    expect(k.erloesHeute).toBeNull();
    expect(k.erloesRange).toBeNull();
    expect(k.avoidedPeakEur).toBeNull();
  });

  it('degrades safely when the responses are null (still loading)', () => {
    const k = portfolioKpis(null, null, NOW);
    expect(k.storageKwh).toBeNull();
    expect(k.portfolioSoc).toBeNull();
    expect(k.erloesHeute).toBeNull();
    expect(k.avoidedPeakEur).toBeNull();
  });
});
