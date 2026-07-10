import { describe, expect, it } from 'vitest';
import {
  buildConfigRequest,
  configFormFromOverrides,
  decisionLabelText,
  defaultSlotIndex,
  fmtCt,
  fmtEur,
  modeBadge,
  notableSlots,
  objectiveTotals,
  parseField,
  slotWaterfall,
  verdict,
} from './optimizer';
import type { OptimizerDiagnostics, OptimizerSlot } from './optimizerApi';

/** A slot with everything null except the given overrides (honest defaults). */
function slot(over: Partial<OptimizerSlot> = {}): OptimizerSlot {
  return {
    time: '2026-06-12T10:00:00Z',
    batteryKw: null,
    gridKw: null,
    socPct: null,
    loadKw: null,
    pvKw: null,
    curtailKw: null,
    costEur: null,
    baselineCostEur: null,
    wearCostEur: null,
    solverPriceCtKwh: null,
    importPriceCtKwh: null,
    exportValueCtKwh: null,
    wearCostCtKwh: null,
    valueOfStoredEnergyCtKwh: null,
    decisionLabel: 'ruhe',
    whyText: null,
    ...over,
  };
}

function diag(slots: OptimizerSlot[], over: Partial<OptimizerDiagnostics> = {}): OptimizerDiagnostics {
  return {
    siteId: 's-1',
    planId: 'p-1',
    generatedAt: '2026-06-12T00:00:00Z',
    slotMinutes: 15,
    availableRuns: ['2026-06-12T00:00:00Z'],
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 18,
    anzulegenderWertCtKwh: null,
    backupReserveSocPct: null,
    battery: {
      capacityKwh: 10,
      roundtripEfficiencyPct: 92,
      wearCostCtPerKwh: 4,
      wearCostSource: 'platform-default',
      socMinPct: 5,
      socMaxPct: 95,
    },
    activeLoadModel: 'load-persistence',
    activePvModel: 'pv-physical',
    storedEnergyValueIsApproximation: true,
    slots,
    ...over,
  };
}

describe('formatting - honest null discipline', () => {
  it('fmtCt / fmtEur render "—" for null, never a fabricated 0', () => {
    expect(fmtCt(null)).toBe('—');
    expect(fmtEur(null)).toBe('—');
    expect(fmtEur(undefined)).toBe('—');
    expect(fmtEur(NaN)).toBe('—');
  });

  it('formats de-DE with a real minus sign', () => {
    expect(fmtCt(7.9)).toBe('7,9 ct/kWh');
    expect(fmtCt(-2.5)).toBe('−2,5 ct/kWh');
    expect(fmtEur(1.16)).toBe('1,16 €');
    expect(fmtEur(-2.76)).toBe('−2,76 €');
  });
});

describe('decisionLabelText / modeBadge', () => {
  it('maps the four decision labels to German', () => {
    expect(decisionLabelText('solarladen')).toBe('Lädt Solarstrom');
    expect(decisionLabelText('netzladen')).toBe('Lädt aus dem Netz');
    expect(decisionLabelText('entladen')).toBe('Entlädt');
    expect(decisionLabelText('ruhe')).toBe('Hält');
    expect(decisionLabelText('unknown')).toBe('unknown');
  });

  it('mode badge reflects the grid-charging switch', () => {
    expect(modeBadge(false)).toEqual({ text: 'EEG · Nur Solarladen', tone: 'off' });
    expect(modeBadge(true).tone).toBe('ok');
  });
});

describe('objectiveTotals', () => {
  it('sums real savings from the asymmetric persisted cashflows', () => {
    const d = diag([
      slot({ costEur: 0.1, baselineCostEur: 0.4 }), // saves 0.30
      slot({ costEur: -0.2, baselineCostEur: 0.1 }), // saves 0.30
      slot({ costEur: null, baselineCostEur: 0.5 }), // not priced -> ignored
    ]);
    const t = objectiveTotals(d);
    expect(t.grossSavingsEur).toBeCloseTo(0.6, 6);
    expect(t.pricedSlotCount).toBe(2);
    expect(t.slotCount).toBe(3);
  });

  it('grossSavings is null (not 0) when no slot is priced', () => {
    const t = objectiveTotals(diag([slot(), slot()]));
    expect(t.grossSavingsEur).toBeNull();
    expect(t.netSavingsEur).toBeNull();
  });

  it('wear is null before P2 and net equals gross when wear unknown', () => {
    const t = objectiveTotals(diag([slot({ costEur: 0.1, baselineCostEur: 0.5 })]));
    expect(t.wearEur).toBeNull();
    expect(t.wearKnown).toBe(false);
    expect(t.netSavingsEur).toBeCloseTo(0.4, 6);
  });

  it('net = gross - wear once wear is persisted', () => {
    const t = objectiveTotals(
      diag([
        slot({ costEur: 0.1, baselineCostEur: 0.5, wearCostEur: 0.05 }),
        slot({ costEur: 0.0, baselineCostEur: 0.2, wearCostEur: 0.03 }),
      ]),
    );
    expect(t.grossSavingsEur).toBeCloseTo(0.6, 6);
    expect(t.wearEur).toBeCloseTo(0.08, 6);
    expect(t.netSavingsEur).toBeCloseTo(0.52, 6);
    expect(t.wearKnown).toBe(true);
  });

  it('spot context = (baseline grid - plan grid) x spot, over 15-min slots', () => {
    // baseline grid = load - pv = 2 - 0 = 2 kW; plan grid = 0 kW (battery covers it)
    // 15 min => 0.5 kWh diff x 20 ct/kWh spot = 0.10 EUR saved to spot.
    const t = objectiveTotals(
      diag([slot({ loadKw: 2, pvKw: 0, gridKw: 0, solverPriceCtKwh: 20 })]),
    );
    expect(t.spotSavingsEur).toBeCloseTo(0.1, 6);
  });

  it('spot context is null without spot+grid coverage', () => {
    expect(objectiveTotals(diag([slot({ costEur: 0.1, baselineCostEur: 0.5 })])).spotSavingsEur).toBeNull();
  });
});

describe('verdict', () => {
  it('positive net saving reads good', () => {
    const v = verdict(diag([slot({ costEur: 0.1, baselineCostEur: 0.9, wearCostEur: 0.05 })]), 'Hof X');
    expect(v.tone).toBe('good');
    expect(v.eur).toBeCloseTo(0.75, 6);
    expect(v.text).toContain('Hof X');
    expect(v.text).toContain('nach Verschleiß');
  });

  it('negative net saving reads bad', () => {
    const v = verdict(diag([slot({ costEur: 0.9, baselineCostEur: 0.1 })]), 'Hof Y');
    expect(v.tone).toBe('bad');
    expect(v.eur).toBeCloseTo(-0.8, 6);
  });

  it('flat/near-zero reads neutral', () => {
    const v = verdict(diag([slot({ costEur: 0.5, baselineCostEur: 0.5 })]), 'Hof Z');
    expect(v.tone).toBe('neutral');
  });

  it('no priced slot => neutral, null eur, honest copy', () => {
    const v = verdict(diag([slot()]), 'Hof Q');
    expect(v.tone).toBe('neutral');
    expect(v.eur).toBeNull();
    expect(v.text).toContain('kein bewertbarer Plan');
  });
});

describe('slotWaterfall', () => {
  it('always shows spot/import/export/wear; keeps null rows as "—"', () => {
    const rows = slotWaterfall(slot({ solverPriceCtKwh: 5, importPriceCtKwh: 23, exportValueCtKwh: 7.9 }));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.spot.ctKwh).toBe(5);
    expect(byKey.import.ctKwh).toBe(23);
    expect(byKey.export.ctKwh).toBe(7.9);
    expect(byKey.wear.ctKwh).toBeNull(); // pre-P2 slot: kept, shown as "—"
    expect(byKey.stored).toBeUndefined(); // dropped when null
  });

  it('includes the approximate stored-energy row when present', () => {
    const rows = slotWaterfall(slot({ valueOfStoredEnergyCtKwh: 12.5, wearCostCtKwh: 0.4 }));
    const stored = rows.find((r) => r.key === 'stored');
    expect(stored?.ctKwh).toBe(12.5);
    expect(stored?.approximate).toBe(true);
    expect(rows.find((r) => r.key === 'wear')?.ctKwh).toBe(0.4);
  });

  it('classifies gains vs costs for bar colour', () => {
    const rows = slotWaterfall(slot({ importPriceCtKwh: 20, exportValueCtKwh: 8 }));
    expect(rows.find((r) => r.key === 'import')?.kind).toBe('cost');
    expect(rows.find((r) => r.key === 'export')?.kind).toBe('gain');
  });
});

describe('notableSlots / defaultSlotIndex', () => {
  it('finds first discharge / charge / grid-import', () => {
    const slots = [
      slot({ batteryKw: 0, gridKw: 0 }),
      slot({ batteryKw: 3, gridKw: -1 }), // charge (solar)
      slot({ batteryKw: 0, gridKw: 2 }), // grid import, battery idle
      slot({ batteryKw: -4, gridKw: 1 }), // discharge
    ];
    expect(notableSlots(slots)).toEqual({
      firstDischarge: 3,
      firstCharge: 1,
      firstGridImport: 2,
    });
  });

  it('defaultSlotIndex prefers first discharge, else first charge, else mid', () => {
    expect(defaultSlotIndex([slot({ batteryKw: 3 }), slot({ batteryKw: -2 })])).toBe(1);
    expect(defaultSlotIndex([slot({ batteryKw: 3 }), slot()])).toBe(0);
    expect(defaultSlotIndex([slot(), slot(), slot()])).toBe(1);
    expect(defaultSlotIndex([])).toBe(-1);
  });
});

describe('config form <-> request round-trip (null clears override)', () => {
  it('seeds the form from overrides; null -> empty string', () => {
    expect(
      configFormFromOverrides({ wearCostCtPerKwh: 3, socMinPct: null, socMaxPct: 90, backupReserveSocPct: null }),
    ).toEqual({ wearCostCtPerKwh: '3', socMinPct: '', socMaxPct: '90', backupReserveSocPct: '' });
  });

  it('parseField: empty -> null (clear), invalid -> undefined, de/en decimals ok', () => {
    expect(parseField('')).toBeNull();
    expect(parseField('  ')).toBeNull();
    expect(parseField('3,5')).toBe(3.5);
    expect(parseField('3.5')).toBe(3.5);
    expect(parseField('abc')).toBeUndefined();
  });

  it('builds a body where empty fields are null (server clears to default)', () => {
    const r = buildConfigRequest(
      { wearCostCtPerKwh: '3,5', socMinPct: '', socMaxPct: '', backupReserveSocPct: '20' },
      { socMinPct: 5, socMaxPct: 95 },
    );
    expect(r.ok).toBe(true);
    expect(r.body).toEqual({
      wearCostCtPerKwh: 3.5,
      socMinPct: null,
      socMaxPct: null,
      backupReserveSocPct: 20,
    });
  });

  it('rejects a non-numeric field with a German message', () => {
    const r = buildConfigRequest(
      { wearCostCtPerKwh: 'x', socMinPct: '', socMaxPct: '', backupReserveSocPct: '' },
      { socMinPct: 5, socMaxPct: 95 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Verschleißkosten');
  });

  it('rejects out-of-range percentages', () => {
    expect(
      buildConfigRequest(
        { wearCostCtPerKwh: '', socMinPct: '', socMaxPct: '', backupReserveSocPct: '150' },
        { socMinPct: 5, socMaxPct: 95 },
      ).ok,
    ).toBe(false);
    expect(
      buildConfigRequest(
        { wearCostCtPerKwh: '-1', socMinPct: '', socMaxPct: '', backupReserveSocPct: '' },
        { socMinPct: 5, socMaxPct: 95 },
      ).ok,
    ).toBe(false);
  });

  it('rejects an effective band with min >= max (mirrors the server 400)', () => {
    // override min 96 crosses the platform default max 95 -> invalid window
    const r = buildConfigRequest(
      { wearCostCtPerKwh: '', socMinPct: '96', socMaxPct: '', backupReserveSocPct: '' },
      { socMinPct: 5, socMaxPct: 95 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('SoC-Band');
  });

  it('accepts a one-sided override that still forms a valid window', () => {
    const r = buildConfigRequest(
      { wearCostCtPerKwh: '', socMinPct: '10', socMaxPct: '', backupReserveSocPct: '' },
      { socMinPct: 5, socMaxPct: 95 },
    );
    expect(r.ok).toBe(true);
    expect(r.body?.socMinPct).toBe(10);
    expect(r.body?.socMaxPct).toBeNull();
  });
});
