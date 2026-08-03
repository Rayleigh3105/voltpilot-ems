import { describe, expect, it } from 'vitest';
import type {
  ControlStatus,
  CurtailmentStatus,
  EdgeVersion,
  Overview,
  OverviewSite,
  Site,
  SiteSource,
} from './api';
import {
  compareVersions,
  controlMatrixRows,
  edgeStand,
  fleetLoadNote,
  fleetPulse,
  fleetRows,
  newestCoreVersion,
  pflegeItems,
  sourceHealth,
  type FleetTenantData,
} from './adminFleet';

const NOW = new Date('2026-08-03T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function site(over: Partial<OverviewSite> = {}): OverviewSite {
  return {
    id: 's1',
    name: 'Anlage A',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: ago(10_000),
    live: null,
    plannedSavingsTodayEur: 1,
    lastPlanGeneratedAt: ago(7 * 60_000),
    ...over,
  } as OverviewSite;
}

function overview(sites: OverviewSite[]): Overview {
  return {
    sites,
    totals: {
      sites: sites.length,
      devices: 0,
      online: 0,
      plannedSavingsTodayEur: null,
      liveSitesCovered: 0,
    },
    dailySavings: [],
  };
}

function tenantData(over: Partial<FleetTenantData> = {}): FleetTenantData {
  return {
    tenant: { id: 't1', name: 'Demo C&I' },
    overview: overview([site()]),
    sites: null,
    edgeVersions: null,
    ...over,
  };
}

function masterSite(over: Partial<Site> = {}): Site {
  return { id: 's1', name: 'Anlage A', tarifArt: 'fest', ...over } as Site;
}

describe('fleetRows', () => {
  it('reads one row per site across ALL tenants', () => {
    const rows = fleetRows(
      [
        tenantData(),
        tenantData({
          tenant: { id: 't2', name: 'Nordwind' },
          overview: overview([site({ id: 's2', name: 'Anlage B' })]),
        }),
      ],
      {},
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenantName).sort()).toEqual(['Demo C&I', 'Nordwind']);
  });

  it('sorts attention first - a silent device beats a healthy plant', () => {
    const rows = fleetRows(
      [
        tenantData({
          overview: overview([
            site({ id: 'ok', name: 'Gesund' }),
            site({
              id: 'still',
              name: 'Still',
              worstStatus: 'stale',
              onlineCount: 0,
              lastSeenAt: ago(3 * 3600_000),
            }),
            site({ id: 'planalt', name: 'Planalt', lastPlanGeneratedAt: ago(5 * 3600_000) }),
          ]),
        }),
      ],
      {},
      NOW,
    );
    expect(rows.map((r) => r.siteName)).toEqual(['Still', 'Planalt', 'Gesund']);
  });

  it('a dead tenant does not empty the pulse - the others still render', () => {
    const rows = fleetRows(
      [
        tenantData({ tenant: { id: 't1', name: 'Kaputt' }, overview: null }),
        tenantData({
          tenant: { id: 't2', name: 'Heil' },
          overview: overview([site({ id: 's9', name: 'Läuft' })]),
        }),
      ],
      {},
      NOW,
    );
    expect(rows.map((r) => r.siteName)).toEqual(['Läuft']);
  });

  it('states a missing measurement as a gap, never as a zero', () => {
    const [row] = fleetRows(
      [
        tenantData({
          overview: overview([
            site({ deviceCount: 0, onlineCount: 0, lastSeenAt: null, lastPlanGeneratedAt: null }),
          ]),
        }),
      ],
      {},
      NOW,
    );
    expect(row.liveText).toBe('—');
    expect(row.deviceText).toBe('kein Gerät');
    expect(row.planText).toBe('kein aktueller Plan');
    // Quellen + Pflege wurden nicht geladen -> unbekannt, nicht "gesund"/"leer".
    expect(row.sources).toBeNull();
    expect(row.pflege).toBeNull();
  });

  it('a healthy row still SAYS so instead of leaving an empty cell', () => {
    const [row] = fleetRows([tenantData({ sites: [masterSite()] })], {}, NOW);
    expect(row.signals.map((s) => s.id)).toEqual(['ok']);
    expect(row.signals[0].label).toBe('Alles in Ordnung');
    expect(row.pflege).toEqual([]);
  });

  it('carries the Pflege findings as chips once the master data is loaded', () => {
    const [row] = fleetRows(
      [
        tenantData({
          overview: overview([site({ batteryWithoutDevice: true })]),
          sites: [masterSite({ tarifArt: 'ohne' })],
        }),
      ],
      {},
      NOW,
    );
    expect(row.pflege?.map((p) => p.id)).toEqual(['tarif', 'speicher-ohne-geraet']);
    expect(row.signals.map((s) => s.label)).toContain('Stromtarif fehlt');
    expect(row.signals.map((s) => s.label)).toContain('Speicher ohne Gerät');
  });
});

describe('fleetPulse', () => {
  it('counts what the rows say, nothing else', () => {
    const rows = fleetRows(
      [
        tenantData({
          overview: overview([
            site({ id: 'a', worstStatus: 'stale', onlineCount: 0, lastSeenAt: ago(3 * 3600_000) }),
            site({ id: 'b', lastPlanGeneratedAt: ago(5 * 3600_000) }),
            site({ id: 'c', deviceCount: 1, onlineCount: 0, waitingCount: 1, worstStatus: 'waiting' }),
            site({ id: 'd' }),
          ]),
          sites: [masterSite({ id: 'd', tarifArt: 'ohne' })],
        }),
      ],
      {},
      NOW,
    );
    const p = fleetPulse(rows);
    expect(p.sites).toBe(4);
    expect(p.gestoert).toBe(1);
    expect(p.planAlt).toBe(1);
    expect(p.wartet).toBe(1);
    expect(p.pflegeOffen).toBe(1);
  });
});

describe('fleetLoadNote', () => {
  it('names a partial outage instead of hiding it', () => {
    expect(fleetLoadNote([tenantData()])).toBeNull();
    expect(fleetLoadNote([tenantData({ overview: null })])).toContain('Demo C&I');
    const two = fleetLoadNote([
      tenantData({ tenant: { id: 'a', name: 'A' }, overview: null }),
      tenantData({ tenant: { id: 'b', name: 'B' }, overview: null }),
    ]);
    expect(two).toContain('2 Mandanten');
    expect(two).toContain('A, B');
  });
});

describe('sourceHealth', () => {
  const src = (health: SiteSource['health']): SiteSource =>
    ({ sourceId: `s-${health}-${Math.random()}`, health }) as SiteSource;

  it('an empty list is "no report", never "0 healthy"', () => {
    expect(sourceHealth([])).toBeNull();
  });

  it('a stale source turns the cell amber and is counted', () => {
    const h = sourceHealth([src('ok'), src('stale'), src('ok')])!;
    expect(h.text).toBe('2/3 liefern');
    expect(h.tone).toBe('warn');
    expect(h.stale).toBe(1);
  });

  it('a never-delivering source is off, not a warning', () => {
    expect(sourceHealth([src('ok'), src('never')])!.tone).toBe('off');
    expect(sourceHealth([src('ok'), src('ok')])!.tone).toBe('ok');
  });
});

describe('edgeStand', () => {
  const v = (siteId: string, core: string | null): EdgeVersion => ({
    deviceId: `d-${siteId}`,
    siteId,
    coreVersion: core,
    paletteVersion: '0.3.0',
    reportedAt: ago(60_000),
  });

  it('a device that never reported is UNKNOWN, never outdated', () => {
    const stand = edgeStand([], 's1', '1.5.0');
    expect(stand.text).toBe('unbekannt');
    expect(stand.outdated).toBe(false);
    expect(stand.tone).toBe('off');
  });

  it('says nothing at all while the versions were not loaded', () => {
    expect(edgeStand(null, 's1', '1.5.0').text).toBe('—');
  });

  it('marks a reported version behind the newest known one', () => {
    expect(edgeStand([v('s1', '1.4.2')], 's1', '1.5.0').outdated).toBe(true);
    expect(edgeStand([v('s1', '1.5.0')], 's1', '1.5.0').outdated).toBe(false);
  });

  it('without a yardstick nothing is outdated', () => {
    const stand = edgeStand([v('s1', '1.4.2')], 's1', null);
    expect(stand.outdated).toBe(false);
    expect(stand.text).toBe('1.4.2');
  });

  it('newestCoreVersion ignores what nobody reported', () => {
    expect(newestCoreVersion([tenantData()])).toBeNull();
    expect(
      newestCoreVersion([
        tenantData({ edgeVersions: [v('s1', '1.4.2'), v('s2', null)] }),
        tenantData({ edgeVersions: [v('s3', '1.10.0')] }),
      ]),
    ).toBe('1.10.0');
  });
});

describe('compareVersions', () => {
  it('compares number blocks, not strings (1.10.0 > 1.9.3)', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
    expect(compareVersions('1.9.3', '1.10.0')).toBe(-1);
    expect(compareVersions('1.4.2', '1.4.2')).toBe(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });

  it('ignores a non-numeric suffix instead of guessing', () => {
    expect(compareVersions('1.4.2-rc1', '1.4.2')).toBe(0);
  });
});

describe('pflegeItems', () => {
  it('is an existence check, never a second price calculation', () => {
    expect(pflegeItems(masterSite({ tarifArt: 'dynamisch' }), site())).toEqual([]);
    expect(pflegeItems(masterSite({ tarifArt: 'ohne' }), site()).map((p) => p.id)).toEqual(['tarif']);
    expect(pflegeItems(undefined, site({ batteryWithoutDevice: true })).map((p) => p.id)).toEqual([
      'speicher-ohne-geraet',
    ]);
  });
});

describe('controlMatrixRows (B2 - die Pilsting-Sicht)', () => {
  const control = (over: Partial<ControlStatus> = {}): ControlStatus =>
    ({
      deviceId: 'd1',
      commandedKw: -4,
      confirmedKw: -4,
      allMatch: true,
      controlEnabled: true,
      certified: true,
      mismatchRoles: null,
      slotStart: null,
      checkedAt: ago(41_000),
      executionMode: 'trim',
      ...over,
    }) as ControlStatus;

  const curtail = (over: Partial<CurtailmentStatus> = {}): CurtailmentStatus =>
    ({
      deviceId: 'd1',
      units: 2,
      certifiedUnits: 2,
      controlEnabled: true,
      active: true,
      appliedCapKw: 12.5,
      allMatch: true,
      possibleOverride: false,
      checkedAt: ago(41_000),
      ...over,
    }) as CurtailmentStatus;

  const input = (over: Partial<Parameters<typeof controlMatrixRows>[0][0]> = {}) => ({
    siteId: 's1',
    siteName: 'PV-Park Pilsting',
    tenantId: 't1',
    tenantName: 'Energiehof P.',
    control: control(),
    curtailment: curtail(),
    ...over,
  });

  it('puts "0 von 2 Wechselrichtern freigegeben" front and centre', () => {
    const [row] = controlMatrixRows(
      [input({ curtailment: curtail({ certifiedUnits: 0, active: false }) })],
      NOW,
    );
    expect(row.curtail.text).toBe('0 von 2 Wechselrichtern freigegeben');
    expect(row.curtail.tone).toBe('warn');
  });

  it('a confirmed limit is the only shape that reads as executed', () => {
    const [row] = controlMatrixRows([input()], NOW);
    expect(row.curtail.tone).toBe('ok');
    expect(row.curtail.detail).toContain('bestätigt');
    expect(row.battery.tone).toBe('ok');
    expect(row.executionText).toBe('Solar-Überschuss');
  });

  it('a possible override is a warning, not a confirmation', () => {
    const [row] = controlMatrixRows([input({ curtailment: curtail({ possibleOverride: true }) })], NOW);
    expect(row.curtail.tone).toBe('warn');
    expect(row.curtail.detail).toContain('übersteuert');
  });

  it('says "kein Abregel-Aktor" instead of inventing a release count', () => {
    const [row] = controlMatrixRows([input({ curtailment: null })], NOW);
    expect(row.curtail.text).toBe('kein Abregel-Aktor');
    expect(row.curtail.tone).toBe('off');
  });

  it('an aged proof confirms NOTHING - it says the proof is old', () => {
    const old = ago(22 * 60_000);
    const [row] = controlMatrixRows(
      [
        input({
          control: control({ checkedAt: old }),
          curtailment: curtail({ checkedAt: old }),
        }),
      ],
      NOW,
    );
    expect(row.belegStale).toBe(true);
    expect(row.battery.tone).toBe('off');
    expect(row.curtail.tone).toBe('off');
  });

  it('a site without any proof stays in the table and says so', () => {
    const [row] = controlMatrixRows([input({ control: null, curtailment: null })], NOW);
    expect(row.battery.text).toBe('kein Beleg');
    expect(row.belegText).toBe('kein Beleg');
    expect(row.executionText).toBe('—');
  });

  it('names the kill-switch and the missing certification apart', () => {
    expect(
      controlMatrixRows([input({ control: control({ controlEnabled: false }) })], NOW)[0].battery.text,
    ).toBe('Steuerung aus');
    expect(
      controlMatrixRows([input({ control: control({ certified: false }) })], NOW)[0].battery.text,
    ).toBe('nicht zertifiziert');
  });

  it('sorts the plants that need somebody to the top', () => {
    const rows = controlMatrixRows(
      [
        input({ siteId: 'ok', siteName: 'Gesund' }),
        input({
          siteId: 'bad',
          siteName: 'Ungefreigegeben',
          curtailment: curtail({ certifiedUnits: 0, active: false }),
        }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.siteName)).toEqual(['Ungefreigegeben', 'Gesund']);
  });
});
