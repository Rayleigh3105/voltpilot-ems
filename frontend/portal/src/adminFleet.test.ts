import { describe, expect, it } from 'vitest';
import type { ControlStatus, CurtailmentStatus } from './api';
import type { AdminFleetSite } from './admin/fleetApi';
import {
  compareVersions,
  controlMatrixInputs,
  controlMatrixRows,
  edgeStand,
  fleetPulse,
  fleetRows,
  newestCoreVersion,
  sourceHealth,
} from './adminFleet';

const NOW = new Date('2026-08-03T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/**
 * Eine Zeile, wie sie der EINE Flotten-Endpunkt liefert. Die Pflege-Punkte sind
 * server-abgeleitet - dieses Modul rendert sie, es leitet sie nicht ab.
 */
function site(over: Partial<AdminFleetSite> = {}): AdminFleetSite {
  return {
    siteId: 's1',
    siteName: 'Anlage A',
    tenantId: 't1',
    tenantName: 'Demo C&I',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    tarifArt: 'fest',
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: ago(10_000),
    lastPlanGeneratedAt: ago(7 * 60_000),
    hasStorage: false,
    batteryWithoutDevice: false,
    sources: null,
    edge: null,
    control: null,
    curtailment: null,
    kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: 'x' },
    forecast: [],
    pflege: [],
    ...over,
  };
}

describe('fleetRows', () => {
  it('reads one row per site across ALL tenants', () => {
    const rows = fleetRows(
      [
        site(),
        site({ siteId: 's2', siteName: 'Anlage B', tenantId: 't2', tenantName: 'Nordwind' }),
      ],
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenantName).sort()).toEqual(['Demo C&I', 'Nordwind']);
  });

  it('sorts attention first - a silent device beats a healthy plant', () => {
    const rows = fleetRows(
      [
        site({ siteId: 'ok', siteName: 'Gesund' }),
        site({
          siteId: 'still',
          siteName: 'Still',
          worstStatus: 'stale',
          onlineCount: 0,
          lastSeenAt: ago(3 * 3600_000),
        }),
        site({ siteId: 'planalt', siteName: 'Planalt', lastPlanGeneratedAt: ago(5 * 3600_000) }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.siteName)).toEqual(['Still', 'Planalt', 'Gesund']);
  });

  it('states a missing measurement as a gap, never as a zero', () => {
    const [row] = fleetRows(
      [site({ deviceCount: 0, onlineCount: 0, lastSeenAt: null, lastPlanGeneratedAt: null })],
      NOW,
    );
    expect(row.liveText).toBe('—');
    expect(row.deviceText).toBe('kein Gerät');
    expect(row.planText).toBe('kein aktueller Plan');
    // Nichts gemeldet -> unbekannt, nie "0 gesund".
    expect(row.sources).toBeNull();
    expect(row.edge.text).toBe('unbekannt');
  });

  it('a healthy row still SAYS so instead of leaving an empty cell', () => {
    const [row] = fleetRows([site()], NOW);
    expect(row.signals.map((s) => s.id)).toEqual(['ok']);
    expect(row.signals[0].label).toBe('Alles in Ordnung');
    expect(row.pflege).toEqual([]);
  });

  it('renders the SERVER-derived Pflege findings as chips, reason and all', () => {
    const [row] = fleetRows(
      [
        site({
          pflege: [
            { code: 'tarif-fehlt', label: 'Stromtarif fehlt', detail: null },
            {
              code: 'kwp-unplausibel',
              label: 'kWp unplausibel',
              detail: 'Gemessene PV-Spitze 420,0 kW über 30,0 kWp installiert.',
            },
          ],
        }),
      ],
      NOW,
    );
    expect(row.pflege.map((p) => p.code)).toEqual(['tarif-fehlt', 'kwp-unplausibel']);
    const chips = row.signals.map((s) => s.label);
    expect(chips).toContain('Stromtarif fehlt');
    expect(chips).toContain('kWp unplausibel');
    // Die Begründung reist am Chip mit - ein Signal ohne Grund wäre nur Alarm.
    expect(row.signals.find((s) => s.id === 'pflege-kwp-unplausibel')?.title).toContain('420,0 kW');
    expect(row.signals.find((s) => s.id === 'pflege-tarif-fehlt')?.title).toBeUndefined();
  });

  it('carries the B4 verdicts through untouched (they are the server’s truth)', () => {
    const [row] = fleetRows(
      [
        site({
          kwp: {
            configuredKwp: 30,
            observedPeakKw: 420,
            buckets: 2000,
            verdict: 'zu_hoch',
            reason: 'Gemessene PV-Spitze 420,0 kW über 30,0 kWp installiert.',
          },
          forecast: [
            { kind: 'load', nmaePct: 60, days: 14, fleetMedianPct: 13, outlier: true, reason: 'r' },
          ],
        }),
      ],
      NOW,
    );
    expect(row.kwp.verdict).toBe('zu_hoch');
    expect(row.forecast[0].outlier).toBe(true);
  });
});

describe('fleetPulse', () => {
  it('counts what the rows say, nothing else', () => {
    const rows = fleetRows(
      [
        site({ siteId: 'a', worstStatus: 'stale', onlineCount: 0, lastSeenAt: ago(3 * 3600_000) }),
        site({ siteId: 'b', lastPlanGeneratedAt: ago(5 * 3600_000) }),
        site({ siteId: 'c', deviceCount: 1, onlineCount: 0, waitingCount: 1, worstStatus: 'waiting' }),
        site({
          siteId: 'd',
          pflege: [{ code: 'tarif-fehlt', label: 'Stromtarif fehlt', detail: null }],
        }),
      ],
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

describe('sourceHealth', () => {
  it('no report at all is "unknown", never "0 healthy"', () => {
    expect(sourceHealth(null)).toBeNull();
    expect(sourceHealth({ total: 0, ok: 0, stale: 0, never: 0 })).toBeNull();
  });

  it('a stale source turns the cell amber and is counted', () => {
    const h = sourceHealth({ total: 3, ok: 2, stale: 1, never: 0 })!;
    expect(h.text).toBe('2/3 liefern');
    expect(h.tone).toBe('warn');
    expect(h.stale).toBe(1);
  });

  it('a never-delivering source is off, not a warning', () => {
    expect(sourceHealth({ total: 2, ok: 1, stale: 0, never: 1 })!.tone).toBe('off');
    expect(sourceHealth({ total: 2, ok: 2, stale: 0, never: 0 })!.tone).toBe('ok');
  });
});

describe('edgeStand', () => {
  const edge = (core: string | null) => ({
    coreVersion: core,
    paletteVersion: '0.3.0',
    reportedAt: ago(60_000),
  });

  it('a device that never reported is UNKNOWN, never outdated', () => {
    const stand = edgeStand(null, '1.5.0');
    expect(stand.text).toBe('unbekannt');
    expect(stand.outdated).toBe(false);
    expect(stand.tone).toBe('off');
    // Auch ein Block ohne Kernversion behauptet kein Alter.
    expect(edgeStand(edge(null), '1.5.0').text).toBe('unbekannt');
  });

  it('marks a reported version behind the newest known one', () => {
    expect(edgeStand(edge('1.4.2'), '1.5.0').outdated).toBe(true);
    expect(edgeStand(edge('1.5.0'), '1.5.0').outdated).toBe(false);
  });

  it('without a yardstick nothing is outdated', () => {
    const stand = edgeStand(edge('1.4.2'), null);
    expect(stand.outdated).toBe(false);
    expect(stand.text).toBe('1.4.2');
  });

  it('newestCoreVersion ignores what nobody reported', () => {
    expect(newestCoreVersion([site()])).toBeNull();
    expect(
      newestCoreVersion([
        site({ edge: edge('1.4.2') }),
        site({ siteId: 's2', edge: edge(null) }),
        site({ siteId: 's3', edge: edge('1.10.0') }),
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

describe('controlMatrixInputs', () => {
  it('takes only the storage plants - and keeps a plant WITHOUT any proof', () => {
    const inputs = controlMatrixInputs([
      site({ siteId: 'pv', hasStorage: false }),
      site({ siteId: 'batt', hasStorage: true }),
    ]);
    expect(inputs.map((i) => i.siteId)).toEqual(['batt']);
    expect(inputs[0].control).toBeNull();
    expect(inputs[0].curtailment).toBeNull();
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
