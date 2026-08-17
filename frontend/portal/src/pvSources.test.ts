import { describe, expect, it } from 'vitest';
import type { SiteSource } from './api';
import {
  breakdownLine,
  healthTitle,
  isMeasuredZero,
  NO_GENERATION_NOTE,
  pvBreakdown,
  sourceLabel,
} from './pvSources';

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

// Herzogau 17.08.2026 (`vp-herzogau-runde2-m6` §4.5): „Deye Heizhaus 0,0 kW"
// stand als selbstbewusster Anteil neben zwei produzierenden Fronius - mit
// grünem Punkt und ohne jede Einordnung. Der Kunde las das als „VoltPilot
// behauptet, mein Wechselrichter sei tot".
describe('pvBreakdown — die gemessene Null wird EINGEORDNET', () => {
  it('eine 0 neben produzierenden Geschwistern bekommt die ruhige Zeile', () => {
    const b = pvBreakdown([
      src({ sourceId: 'deye', kind: 'primary', role: null, label: 'Deye Heizhaus', pvKw: 0 }),
      src({ sourceId: 'a', label: 'Fronius West', pvKw: 4.0 }),
      src({ sourceId: 'b', label: 'Fronius Ost', pvKw: 4.6 }),
    ])!;
    expect(b.parts.find((p) => p.label === 'Deye Heizhaus')!.note).toBe(NO_GENERATION_NOTE);
    // Kein Alarm-Wortschatz: 0 ist ein Zustand, kein Fehler.
    expect(NO_GENERATION_NOTE).not.toMatch(/fehler|störung|defekt|ausfall/i);
    // Die produzierenden Geschwister bekommen KEINE Zeile.
    expect(b.parts.filter((p) => p.note != null)).toHaveLength(1);
    // Die Summe bleibt unangetastet - die Zeile ordnet ein, sie rechnet nicht.
    expect(b.totalKw).toBeCloseTo(8.6, 9);
  });

  it('nachts (alle 0) gibt es GAR KEINE Aufteilung, also auch keine Kennzeichnung', () => {
    expect(
      pvBreakdown([
        src({ sourceId: 'deye', kind: 'primary', role: null, pvKw: 0 }),
        src({ sourceId: 'a', pvKw: 0 }),
        src({ sourceId: 'b', pvKw: 0 }),
      ]),
    ).toBeNull();
  });

  it('`null` bleibt eine Lücke und wird nie zur gemessenen Null', () => {
    const b = pvBreakdown([
      src({ sourceId: 'deye', kind: 'primary', role: null, label: 'Deye', pvKw: null }),
      src({ sourceId: 'a', label: 'Fronius West', pvKw: 4.0 }),
      src({ sourceId: 'b', label: 'Fronius Ost', pvKw: 4.6 }),
    ])!;
    // Der ungelesene Erzeuger ist KEIN Teil (keine 0-Zeile), sondern benannt.
    expect(b.parts.map((p) => p.label)).toEqual(['Fronius West', 'Fronius Ost']);
    expect(b.note).toContain('Deye');
    expect(b.parts.every((p) => p.note == null)).toBe(true);
    expect(isMeasuredZero(null)).toBe(false);
    expect(isMeasuredZero(0)).toBe(true);
    // Ein Wert im Totband gilt als Null, ein echter Beitrag nicht.
    expect(isMeasuredZero(0.02)).toBe(true);
    expect(isMeasuredZero(0.4)).toBe(false);
  });

  it('trägt den jüngsten Messzeitpunkt als Bezugszeit des Alters-Ausweises', () => {
    const b = pvBreakdown([
      src({ sourceId: 'deye', kind: 'primary', role: null, pvKw: 0, readAt: '2026-08-17T10:00:00Z' }),
      src({ sourceId: 'a', pvKw: 4.0, readAt: '2026-08-17T10:27:00Z' }),
    ])!;
    expect(b.asOf).toBe('2026-08-17T10:27:00Z');
    // Ohne `readAt` fällt es auf den Meldezeitpunkt zurück, nie auf „jetzt".
    const ohne = pvBreakdown([
      src({ sourceId: 'deye', kind: 'primary', role: null, pvKw: 0 }),
      src({ sourceId: 'a', pvKw: 4.0 }),
    ])!;
    expect(ohne.asOf).toBe('2026-07-21T10:00:00Z');
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
