import { describe, expect, it } from 'vitest';
import {
  bankedValueLine,
  chargeKind,
  curtailmentToday,
  daypart,
  hasGridCharge,
  HORIZON_HINT,
  horizonHint,
  planHourBars,
  planSentence,
  PV_SOURCE_DEADBAND_KW,
  savingsTodayEur,
  SLOT_DEADBAND_KW,
  todaySlots,
} from './schedule';
import { NBSP } from './format';

/**
 * Fahrplan slot-kind derivation: a charging slot whose charge EXCEEDS the
 * slot's available PV is a grid-charge slot ("Laden aus dem Netz", türkis).
 * On an EEG plan (charge <= pv - curtail enforced by the optimizer) that kind
 * can never occur - the chart legend must then not advertise the color. Since
 * FK3 (PV-bus semantics) an EEG site legitimately charges solar WHILE the
 * house imports its load, so charging-while-importing alone is NOT cyan;
 * slots without a PV value keep the old import-based fallback.
 */
describe('chargeKind', () => {
  it('charging while net-importing is Netzladen when no PV data exists (fallback)', () => {
    expect(chargeKind(4.0, 6.5)).toBe('netzladen');
    expect(chargeKind(4.0, 6.5, null)).toBe('netzladen');
  });

  it('charging while exporting or balanced is Solarladen (PV surplus)', () => {
    expect(chargeKind(4.0, -1.2)).toBe('solarladen');
    expect(chargeKind(4.0, 0)).toBe('solarladen');
    // Import inside the deadband is solver noise, not a grid charge.
    expect(chargeKind(4.0, SLOT_DEADBAND_KW)).toBe('solarladen');
  });

  it('FK3 cloudy day: charging solar while the house imports is NOT Netzladen', () => {
    // EEG site, cloudy day: the battery charges the full 3 kW PV production
    // while the house imports its 1 kW load - grid never feeds the battery.
    expect(chargeKind(3.0, 1.0, 3.0)).toBe('solarladen');
    // Charge below the available PV while importing stays solar too.
    expect(chargeKind(2.0, 4.0, 3.0)).toBe('solarladen');
  });

  it('charge beyond the available PV is Netzladen (grid energy enters the battery)', () => {
    expect(chargeKind(5.0, 4.5, 1.0)).toBe('netzladen');
    // Night grid charge: no PV at all.
    expect(chargeKind(6.0, 7.0, 0)).toBe('netzladen');
  });

  it('keeps a deadband so forecast jitter does not flicker the color', () => {
    expect(chargeKind(3.0 + PV_SOURCE_DEADBAND_KW, 1.0, 3.0)).toBe('solarladen');
    expect(chargeKind(3.0 + PV_SOURCE_DEADBAND_KW + 0.01, 1.0, 3.0)).toBe('netzladen');
  });

  it('a curtailed slot has less PV available for charging', () => {
    // 10 kW PV fully curtailed: the 5 kW charge can only come from the grid.
    expect(chargeKind(5.0, 5.0, 10.0, 10.0)).toBe('netzladen');
    // Partially curtailed: 10 - 6 = 4 kW available still covers a 3 kW charge.
    expect(chargeKind(3.0, 1.0, 10.0, 6.0)).toBe('solarladen');
  });

  it('an exporting slot never reads Netzladen even when charge exceeds the PV value', () => {
    // Export means the site has surplus - grid energy cannot flow inward.
    expect(chargeKind(5.0, -1.0, 1.0)).toBe('solarladen');
  });

  it('negative battery power is Entladen regardless of grid direction', () => {
    expect(chargeKind(-3.0, 2.0)).toBe('entladen');
    expect(chargeKind(-3.0, -2.0)).toBe('entladen');
  });

  it('idle, deadband and unknown slots are Ruhe', () => {
    expect(chargeKind(0, 5.0)).toBe('ruhe');
    expect(chargeKind(SLOT_DEADBAND_KW, 5.0)).toBe('ruhe');
    expect(chargeKind(null, 5.0)).toBe('ruhe');
  });

  it('importing for the HOUSE while the battery rests is never Netzladen', () => {
    // High grid draw with an idle battery is normal consumption - only the
    // combination charging AND importing marks grid-fed storage.
    expect(chargeKind(0, 9.0)).toBe('ruhe');
  });
});

describe('hasGridCharge (legend gate)', () => {
  it('true as soon as one slot charges from the grid', () => {
    expect(
      hasGridCharge([
        { batteryKw: 2.0, gridKw: -1.0 },
        { batteryKw: 3.0, gridKw: 4.0 },
      ]),
    ).toBe(true);
  });

  it('false for an EEG-shaped plan (charging only while not importing)', () => {
    expect(
      hasGridCharge([
        { batteryKw: 2.0, gridKw: -1.0 },
        { batteryKw: -2.0, gridKw: 3.0 },
        { batteryKw: null, gridKw: null },
        { batteryKw: 0, gridKw: 2.0 },
      ]),
    ).toBe(false);
  });

  it('false for an FK3 EEG cloudy-day plan (solar charge while the house imports)', () => {
    expect(
      hasGridCharge([
        { batteryKw: 3.0, gridKw: 1.0, pvKw: 3.0, curtailKw: 0 },
        { batteryKw: 2.5, gridKw: 0.5, pvKw: 2.5, curtailKw: null },
        { batteryKw: -2.0, gridKw: 3.0, pvKw: 0, curtailKw: 0 },
      ]),
    ).toBe(false);
  });

  it('true when a slot charges beyond its available PV', () => {
    expect(
      hasGridCharge([
        { batteryKw: 3.0, gridKw: 1.0, pvKw: 3.0 },
        { batteryKw: 5.0, gridKw: 4.5, pvKw: 1.0 },
      ]),
    ).toBe(true);
  });
});

// ---- Anlagen-Seite mini preview -------------------------------------------

/** A local 2026-07-07; slots are built in local time like the plan renders. */
const NOW = new Date(2026, 6, 7, 9, 30);

/** One 15-min slot starting at local hour:minute of NOW's day (or day+1). */
function slot(
  hour: number,
  minute: number,
  batteryKw: number | null,
  gridKw: number | null = null,
  dayOffset = 0,
  pvKw: number | null = null,
): { start: string; batteryKw: number | null; gridKw: number | null; pvKw: number | null } {
  return {
    start: new Date(2026, 6, 7 + dayOffset, hour, minute).toISOString(),
    batteryKw,
    gridKw,
    pvKw,
  };
}

/** hours -> four 15-min slots each, constant power. */
function hours(
  fromH: number,
  toH: number,
  batteryKw: number,
  gridKw: number | null = null,
  pvKw: number | null = null,
): ReturnType<typeof slot>[] {
  const out: ReturnType<typeof slot>[] = [];
  for (let h = fromH; h < toH; h++) {
    for (const m of [0, 15, 30, 45]) out.push(slot(h, m, batteryKw, gridKw, 0, pvKw));
  }
  return out;
}

describe('todaySlots / savingsTodayEur', () => {
  it('keeps only the local calendar day and prices only covered slots', () => {
    const slots = [
      { ...slot(10, 0, 2), costEur: -0.1, baselineCostEur: 0.2 },
      { ...slot(11, 0, 2), costEur: null, baselineCostEur: null },
      { ...slot(10, 0, 2, null, 1), costEur: -5, baselineCostEur: 5 }, // tomorrow
    ];
    expect(todaySlots(slots, NOW)).toHaveLength(2);
    expect(savingsTodayEur(slots, NOW)).toBeCloseTo(0.3, 10);
  });

  it('is null (never a fake zero) when no slot of today carries costs', () => {
    expect(savingsTodayEur([], NOW)).toBeNull();
    expect(
      savingsTodayEur([{ ...slot(10, 0, 2), costEur: null, baselineCostEur: null }], NOW),
    ).toBeNull();
  });
});

describe('planSentence', () => {
  it('composes the captain mockup sentence: charge at noon, sell in the evening', () => {
    const slots = [...hours(11, 14, 4, -3), ...hours(17, 20, -5, -5)];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Mittags laden, abends verkaufen (17–20 Uhr).',
    );
  });

  it('says "nutzen" instead of "verkaufen" for Eigenverbrauch plants', () => {
    const slots = [...hours(11, 14, 4, -3), ...hours(18, 21, -5, 0)];
    expect(planSentence(slots, 'eigenverbrauch', NOW)).toBe(
      'Mittags laden, abends nutzen (18–21 Uhr).',
    );
  });

  it('calls a mostly grid-fed charge window "günstig laden"', () => {
    // Night charge: no PV, all grid - explicit pv 0 exercises the FK3 rule.
    const slots = [...hours(2, 4, 6, 7, 0), ...hours(18, 20, -5, -5)];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Nachts günstig laden, abends verkaufen (18–20 Uhr).',
    );
  });

  it('an FK3 cloudy-day solar charge with parallel house import says plain "laden"', () => {
    // Charge == PV while the house imports its load: solar, never "günstig".
    const slots = [...hours(11, 14, 3, 1, 3), ...hours(18, 20, -5, -5)];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Mittags laden, abends verkaufen (18–20 Uhr).',
    );
  });

  it('handles charge-only and discharge-only days', () => {
    expect(planSentence(hours(11, 14, 4, -3), 'eigenverbrauch', NOW)).toBe(
      'Mittags laden (11–14 Uhr).',
    );
    expect(planSentence(hours(17, 20, -5, -5), 'direktvermarktung', NOW)).toBe(
      'Abends verkaufen (17–20 Uhr).',
    );
  });

  it('picks the DOMINANT window by energy, not the first one', () => {
    const slots = [
      ...hours(7, 8, -1, 0), // small morning discharge
      ...hours(11, 13, 4, -3),
      ...hours(17, 20, -5, -5), // the big evening one
    ];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Mittags laden, abends verkaufen (17–20 Uhr).',
    );
  });

  it('bridges a short idle dip inside one window', () => {
    const slots = [
      ...hours(17, 18, -5, -5),
      slot(18, 0, 0),
      slot(18, 15, 0),
      slot(18, 30, -5, -5),
      slot(18, 45, -5, -5),
      ...hours(19, 20, -5, -5),
    ];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Abends verkaufen (17–20 Uhr).',
    );
  });

  it('is null without today slots and calm on an all-idle day', () => {
    expect(planSentence([], 'eigenverbrauch', NOW)).toBeNull();
    expect(planSentence([slot(10, 0, 2, null, 1)], 'eigenverbrauch', NOW)).toBeNull();
    expect(planSentence(hours(8, 20, 0, 1), 'eigenverbrauch', NOW)).toBe(
      'Der Speicher hält heute seine Ladung.',
    );
  });
});

describe('planHourBars', () => {
  it('condenses today to 24 hourly bars with the dominant direction', () => {
    const bars = planHourBars([...hours(11, 12, 4, -3), ...hours(18, 19, -5, 2)], NOW);
    expect(bars).toHaveLength(24);
    expect(bars[11]).toEqual({ hour: 11, kind: 'solarladen', kw: 4 });
    expect(bars[18]).toEqual({ hour: 18, kind: 'entladen', kw: 5 });
    // Hours without plan data stay null, planned-idle hours are 0.
    expect(bars[0].kw).toBeNull();
  });

  it('marks an hour cyan when most of its charge energy is grid-fed', () => {
    const bars = planHourBars(
      [
        slot(3, 0, 6, 7, 0, 0),
        slot(3, 15, 6, 7, 0, 0),
        slot(3, 30, 6, 7, 0, 0),
        slot(3, 45, 1, -1, 0, 1),
      ],
      NOW,
    );
    expect(bars[3].kind).toBe('netzladen');
  });

  it('keeps an FK3 cloudy-day hour green (solar charge while the house imports)', () => {
    const bars = planHourBars(
      [
        slot(12, 0, 3, 1, 0, 3),
        slot(12, 15, 3, 1, 0, 3),
        slot(12, 30, 3, 1, 0, 3),
        slot(12, 45, 3, 1, 0, 3),
      ],
      NOW,
    );
    expect(bars[12]).toEqual({ hour: 12, kind: 'solarladen', kw: 3 });
  });

  it('renders a planned-idle hour as ruhe with kw 0', () => {
    const bars = planHourBars(hours(9, 10, 0, 1), NOW);
    expect(bars[9]).toEqual({ hour: 9, kind: 'ruhe', kw: 0 });
  });
});

/** One 15-min curtailment slot at local hour of NOW's day (or day+1). */
function cslot(hour: number, curtailKw: number | null, priceEurMwh: number | null, dayOffset = 0) {
  return {
    start: new Date(2026, 6, 7 + dayOffset, hour, 0).toISOString(),
    curtailKw,
    priceEurMwh,
  };
}

describe('curtailmentToday', () => {
  it('is null when nothing is curtailed today', () => {
    expect(curtailmentToday([cslot(10, 0, 50), cslot(11, null, 40)], NOW)).toBeNull();
  });

  it('sums curtailed energy and avoids the negative-price loss only', () => {
    // 8 kW held back for 15 min at -60 EUR/MWh => 2 kWh, avoided 2*0.06 = 0.12 €.
    // 4 kW held back for 15 min at +30 EUR/MWh => 1 kWh, no avoided loss (price > 0).
    const r = curtailmentToday([cslot(12, 8, -60), cslot(13, 4, 30)], NOW)!;
    expect(r.curtailedKwh).toBeCloseTo(3, 6);
    expect(r.avoidedLossEur).toBeCloseTo(0.12, 6);
  });

  it('ignores tomorrow slots and sub-deadband noise', () => {
    const r = curtailmentToday(
      [cslot(12, 6, -80), cslot(9, 0.005, -80), cslot(12, 6, -80, 1)],
      NOW,
    )!;
    // Only today's 6 kW slot counts: 1.5 kWh, avoided 1.5*0.08 = 0.12 €.
    expect(r.curtailedKwh).toBeCloseTo(1.5, 6);
    expect(r.avoidedLossEur).toBeCloseTo(0.12, 6);
  });
});

/**
 * FK2: the banked-terminal-value line under the savings stat. On bank days the
 * plan correctly stores energy into the next day and the headline savings read
 * negative (the audit's -0,99 € while 7,89 € of value was stored) - the line
 * is what keeps the correct plan from looking broken.
 */
describe('bankedValueLine', () => {
  it('positive banked value reads as stored into the next day', () => {
    expect(bankedValueLine(7.89)).toBe(`davon in den Folgetag gespeichert: +7,89${NBSP}€`);
  });

  it('negative banked value reads sign-honest as a withdrawal from yesterday', () => {
    expect(bankedValueLine(-2.03)).toBe(`aus dem Vortag entnommen: 2,03${NBSP}€`);
  });

  it('hides on missing data and noise-level values - never a fake 0', () => {
    expect(bankedValueLine(null)).toBeNull();
    expect(bankedValueLine(undefined)).toBeNull();
    expect(bankedValueLine(0)).toBeNull();
    expect(bankedValueLine(0.004)).toBeNull();
    expect(bankedValueLine(-0.004)).toBeNull();
    expect(bankedValueLine(Number.NaN)).toBeNull();
  });
});

/**
 * FK2 part b: before the ~13:00 day-ahead publication the horizon ends at
 * today's midnight, so the morning plan shows an evening "hold" that flips to
 * discharge in the afternoon. The hint marks exactly that state, derived from
 * the plan's own slot range.
 */
describe('horizonHint', () => {
  // NOW is 09:30 local; a plan whose last slot starts 23:45 today ends at
  // exactly local midnight - the pre-publication morning shape.
  it('shows while the horizon ends within today', () => {
    const slots = [slot(9, 15, 0), slot(23, 45, 0)];
    expect(horizonHint(slots, NOW)).toBe(HORIZON_HINT);
    expect(HORIZON_HINT).toContain('ab ca. 13 Uhr');
  });

  it('stays silent once the plan reaches into tomorrow', () => {
    const slots = [slot(9, 15, 0), slot(23, 45, 0), slot(0, 0, 0, null, 1)];
    expect(horizonHint(slots, NOW)).toBeNull();
  });

  it('stays silent for an entirely stale plan and for no plan', () => {
    // Horizon ended at 08:00, before NOW (09:30) - a stale plan is a
    // different problem than the pre-publication horizon.
    const stale = [slot(6, 0, 0), slot(7, 45, 0)];
    expect(horizonHint(stale, NOW)).toBeNull();
    expect(horizonHint([], NOW)).toBeNull();
  });
});

describe('daypart', () => {
  it('maps local hours onto German dayparts', () => {
    expect(daypart(3)).toBe('nachts');
    expect(daypart(23.5)).toBe('nachts');
    expect(daypart(8)).toBe('morgens');
    expect(daypart(12.5)).toBe('mittags');
    expect(daypart(16)).toBe('nachmittags');
    expect(daypart(19)).toBe('abends');
  });
});
