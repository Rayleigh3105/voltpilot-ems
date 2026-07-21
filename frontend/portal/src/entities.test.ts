import { describe, expect, it } from 'vitest';
import type { SiteEntities, SiteEntity } from './api';
import {
  actuateCommands,
  entitiesSummary,
  failsafeLabel,
  guardRows,
  hasDrift,
  healthLabel,
  healthTone,
  isEmpty,
  measureChannels,
  parseChannelList,
  syncVerdict,
} from './entities';

function entity(over: Partial<SiteEntity> = {}): SiteEntity {
  return {
    id: 'e1',
    entityType: 'wallbox',
    typeLabel: 'Wallbox',
    role: 'wallbox',
    label: 'Wallbox Carport',
    control: true,
    deviceId: null,
    capabilities: {
      measure: [{ channel: 'power_kw', unit: 'kW' }],
      actuate: [{ command: 'setpoint_kw', min: 0, max: 11 }, { command: 'on_off' }],
    },
    guards: {
      limits: { max_consumption_kw: 11 },
      failsafe: { behavior: 'release' },
    },
    syncStatus: 'in_sync',
    observed: {
      health: 'ok',
      lastTelemetryAt: '2026-07-19T10:00:00Z',
      channels: ['power_kw'],
      appliedType: 'wallbox',
      reportedAt: '2026-07-19T10:00:05Z',
    },
    ...over,
  };
}

describe('syncVerdict', () => {
  it('maps every status to a tone + copy, only in_sync is green', () => {
    expect(syncVerdict('in_sync').tone).toBe('ok');
    expect(syncVerdict('pending').tone).toBe('pending');
    expect(syncVerdict('missing_on_device').tone).toBe('warn');
    expect(syncVerdict('unreported').tone).toBe('off');
    expect(syncVerdict('never_pushed').tone).toBe('off');
    // German copy, no jargon.
    expect(syncVerdict('in_sync').label).toBe('Aktiv');
    expect(syncVerdict('missing_on_device').detail).toContain('online');
  });
});

describe('hasDrift', () => {
  it('is true only for the two mismatch states', () => {
    expect(hasDrift('pending')).toBe(true);
    expect(hasDrift('missing_on_device')).toBe(true);
    expect(hasDrift('in_sync')).toBe(false);
    expect(hasDrift('unreported')).toBe(false);
    expect(hasDrift('never_pushed')).toBe(false);
  });
});

describe('health', () => {
  it('labels + tones ok/stale/never and null', () => {
    expect(healthLabel(entity().observed)).toBe('Liefert Daten');
    expect(healthTone(entity().observed)).toBe('ok');
    expect(healthLabel(null)).toBe('Noch keine Daten');
    expect(healthTone(null)).toBe('off');
    const stale = entity({ observed: { ...entity().observed!, health: 'stale' } }).observed;
    expect(healthLabel(stale)).toBe('Keine aktuellen Daten');
    expect(healthTone(stale)).toBe('warn');
    const never = entity({ observed: { ...entity().observed!, health: 'never' } }).observed;
    expect(healthTone(never)).toBe('off');
  });
});

describe('capabilities + guards', () => {
  it('lists measure channels and actuate commands', () => {
    expect(measureChannels(entity())).toEqual(['power_kw']);
    expect(actuateCommands(entity())).toEqual(['setpoint_kw', 'on_off']);
  });

  it('renders guard limits + failsafe as German rows', () => {
    const rows = guardRows(entity());
    expect(rows).toContainEqual({ label: 'Max. Leistung', value: '11 kW' });
    expect(rows).toContainEqual({ label: 'Rückfallverhalten', value: 'Freigeben' });
  });

  it('renders a battery guard block with SoC percent + grid boolean', () => {
    const battery = entity({
      entityType: 'battery-hybrid',
      guards: {
        limits: {
          max_charge_kw: 30,
          soc_min_pct: 5,
          soc_max_pct: 95,
          charge_from_grid_allowed: false,
        },
        failsafe: { behavior: 'self-consumption' },
      },
    });
    const rows = guardRows(battery);
    expect(rows).toContainEqual({ label: 'Max. Ladeleistung', value: '30 kW' });
    expect(rows).toContainEqual({ label: 'Min. Ladestand', value: '5 %' });
    expect(rows).toContainEqual({ label: 'Netzladen erlaubt', value: 'nein' });
    expect(rows).toContainEqual({ label: 'Rückfallverhalten', value: 'Eigenverbrauch' });
  });

  it('maps failsafe behaviors to German', () => {
    expect(failsafeLabel('measure-only')).toBe('Nur messen');
    expect(failsafeLabel('off')).toBe('Aus');
    expect(failsafeLabel('unknown-x')).toBe('unknown-x');
  });
});

describe('summary + empty', () => {
  it('empty when no entities and no local setup', () => {
    const data: SiteEntities = { registry: null, entities: [], localSetup: [], staleOnDevice: [] };
    expect(isEmpty(data)).toBe(true);
    expect(entitiesSummary(data)).toBeNull();
  });

  it('summarizes count, live and drifting', () => {
    const data: SiteEntities = {
      registry: null,
      entities: [
        entity(),
        entity({ id: 'e2', syncStatus: 'pending', observed: null }),
      ],
      localSetup: [],
      staleOnDevice: [],
    };
    const s = entitiesSummary(data)!;
    expect(s).toContain('2 Entitäten');
    expect(s).toContain('1 liefern Daten');
    expect(s).toContain('1 wird noch übernommen');
  });

  it('not empty when only local setup exists', () => {
    const data: SiteEntities = {
      registry: null,
      entities: [],
      localSetup: [{ id: 'inverter', kind: 'inverter', label: 'deye', reportedAt: 'x' }],
      staleOnDevice: [],
    };
    expect(isEmpty(data)).toBe(false);
  });
});

describe('parseChannelList (MB-M1 modbus-generic drawer)', () => {
  it('splits on commas/whitespace, dedupes and keeps order', () => {
    expect(parseChannelList('leistung_kw, wasser_temp_c')).toEqual([
      'leistung_kw',
      'wasser_temp_c',
    ]);
    expect(parseChannelList('  a_1\n b2,,a_1 ;c ')).toEqual(['a_1', 'b2', 'c']);
    expect(parseChannelList('')).toEqual([]);
  });

  it('refuses entries outside the open channel vocabulary', () => {
    expect(parseChannelList('Leistung')).toBeNull(); // upper case
    expect(parseChannelList('1kanal')).toBeNull(); // leading digit
    expect(parseChannelList('wasser-temp')).toBeNull(); // hyphen
    expect(parseChannelList('ok_kanal, kaputt!')).toBeNull();
  });
});
