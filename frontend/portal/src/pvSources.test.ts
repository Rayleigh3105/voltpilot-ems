import { describe, expect, it } from 'vitest';
import type { SiteSource } from './api';
import { breakdownLine, healthTitle, pvBreakdown, sourceLabel } from './pvSources';

const NBSP = ' ';

function src(over: Partial<SiteSource>): SiteSource {
  return {
    deviceId: 'd1',
    sourceId: 's1',
    kind: 'source',
    role: 'pv-generation',
    label: null,
    brand: null,
    model: null,
    pvKw: null,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: null,
    reportedAt: '2026-07-21T10:00:00Z',
    ...over,
  };
}

describe('pvBreakdown', () => {
  it('explains the captain’s three-inverter site', () => {
    const b = pvBreakdown([
      src({ sourceId: 'inverter', kind: 'primary', role: null, label: 'Deye', pvKw: 8.3 }),
      src({ sourceId: 'a', label: 'Fronius Anlage', pvKw: 21.3 }),
      src({ sourceId: 'b', label: 'Fronius WR 2', pvKw: 9.3 }),
    ])!;
    expect(b.parts.map((p) => p.label)).toEqual(['Deye', 'Fronius Anlage', 'Fronius WR 2']);
    expect(b.totalKw).toBeCloseTo(38.9, 9);
    expect(b.note).toBeNull();
    expect(breakdownLine(b)).toBe(
      `38,9${NBSP}kW = Deye 8,3 + Fronius Anlage 21,3 + Fronius WR 2 9,3`,
    );
  });

  it('stays out of the way on a single-inverter site (byte-identical today)', () => {
    expect(pvBreakdown([src({ sourceId: 'inverter', kind: 'primary', pvKw: 8.3 })])).toBeNull();
    expect(pvBreakdown([])).toBeNull();
    expect(pvBreakdown(null)).toBeNull();
  });

  it('ignores points that do not measure PV', () => {
    expect(
      pvBreakdown([
        src({ sourceId: 'inverter', kind: 'primary', role: null, pvKw: 8.3 }),
        src({ sourceId: 'meter', role: 'grid-meter', powerKw: -4.2 }),
        src({ sourceId: 'box', role: 'consumer', loadKw: 11 }),
      ]),
    ).toBeNull(); // only ONE PV part -> nothing to explain
  });

  it('keeps a stale part with its last value and flags it', () => {
    const b = pvBreakdown([
      src({ sourceId: 'inverter', kind: 'primary', role: null, label: 'Deye', pvKw: 8.3 }),
      src({ sourceId: 'a', label: 'Fronius', pvKw: 21.3, health: 'stale' }),
    ])!;
    expect(b.parts[1].health).toBe('stale');
    expect(b.totalKw).toBeCloseTo(29.6, 9);
  });

  it('names a producer that delivers nothing instead of counting it as 0', () => {
    const b = pvBreakdown([
      src({ sourceId: 'inverter', kind: 'primary', role: null, label: 'Deye', pvKw: 8.3 }),
      src({ sourceId: 'a', label: 'Fronius', pvKw: 21.3 }),
      src({ sourceId: 'b', label: 'Fronius WR 2', pvKw: null, health: 'stale' }),
    ])!;
    expect(b.parts).toHaveLength(2);
    expect(b.totalKw).toBeCloseTo(29.6, 9);
    expect(b.note).toBe('Fronius WR 2 liefert gerade keine Werte.');
  });

  it('is quiet about a point that never delivered at all', () => {
    const b = pvBreakdown([
      src({ sourceId: 'inverter', kind: 'primary', role: null, pvKw: 8.3, label: 'Deye' }),
      src({ sourceId: 'a', label: 'Fronius', pvKw: 21.3 }),
      src({ sourceId: 'b', label: 'Neu', pvKw: null, health: 'never' }),
    ])!;
    expect(b.note).toBeNull();
  });

  it('hides itself at night, when nothing generates', () => {
    expect(
      pvBreakdown([
        src({ sourceId: 'inverter', kind: 'primary', role: null, pvKw: 0 }),
        src({ sourceId: 'a', pvKw: 0 }),
      ]),
    ).toBeNull();
  });
});

describe('sourceLabel', () => {
  it('prefers the label, then brand/model, then a role word', () => {
    expect(sourceLabel(src({ label: 'Fronius WR 2', brand: 'fronius' }))).toBe('Fronius WR 2');
    // The derivation is the SHARED entityLabel.deviceName - brand cased, model
    // shortened - so this box reads identically in the energy flow.
    expect(sourceLabel(src({ brand: 'deye', model: 'SUN-12K' }))).toBe('Deye SUN-12K');
    expect(sourceLabel(src({ brand: 'deye', model: 'SUN-30K-SG01HP3-EU' }))).toBe('Deye SUN-30K');
    expect(sourceLabel(src({ kind: 'primary', role: null }))).toBe('Wechselrichter');
    expect(sourceLabel(src({ role: 'grid-meter' }))).toBe('Netz-Zähler');
    expect(sourceLabel(src({ sourceId: 'src-9' }))).toBe('src-9');
  });
});

describe('healthTitle', () => {
  it('speaks plain German, never internal vocabulary', () => {
    expect(healthTitle('ok', 'Deye')).toContain('aktuelle Werte');
    expect(healthTitle('stale', 'Deye')).toContain('zuletzt bekannter Wert');
    expect(healthTitle('never', 'Deye')).toContain('wartet auf erste Daten');
    for (const h of ['ok', 'stale', 'never'] as const) {
      expect(healthTitle(h, 'Deye')).not.toMatch(/stale|health|MQTT|Modbus/i);
    }
  });
});
