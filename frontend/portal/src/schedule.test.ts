import { describe, expect, it } from 'vitest';
import {
  chargeKind,
  curtailmentToday,
  daypart,
  hasGridCharge,
  planHourBars,
  planSentence,
  savingsTodayEur,
  SLOT_DEADBAND_KW,
  todaySlots,
} from './schedule';

/**
 * Fahrplan slot-kind derivation: a charging slot that net-imports is a
 * grid-charge slot ("Laden aus dem Netz", türkis). On an EEG plan
 * (charge <= PV surplus enforced by the optimizer) that kind can never occur -
 * the chart legend must then not advertise the color.
 */
describe('chargeKind', () => {
  it('charging while net-importing is Netzladen (türkis)', () => {
    expect(chargeKind(4.0, 6.5)).toBe('netzladen');
  });

  it('charging while exporting or balanced is Solarladen (PV surplus)', () => {
    expect(chargeKind(4.0, -1.2)).toBe('solarladen');
    expect(chargeKind(4.0, 0)).toBe('solarladen');
    // Import inside the deadband is solver noise, not a grid charge.
    expect(chargeKind(4.0, SLOT_DEADBAND_KW)).toBe('solarladen');
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
): { start: string; batteryKw: number | null; gridKw: number | null } {
  return {
    start: new Date(2026, 6, 7 + dayOffset, hour, minute).toISOString(),
    batteryKw,
    gridKw,
  };
}

/** hours -> four 15-min slots each, constant power. */
function hours(
  fromH: number,
  toH: number,
  batteryKw: number,
  gridKw: number | null = null,
): ReturnType<typeof slot>[] {
  const out: ReturnType<typeof slot>[] = [];
  for (let h = fromH; h < toH; h++) {
    for (const m of [0, 15, 30, 45]) out.push(slot(h, m, batteryKw, gridKw));
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
    const slots = [...hours(2, 4, 6, 7), ...hours(18, 20, -5, -5)];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Nachts günstig laden, abends verkaufen (18–20 Uhr).',
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

  it('marks an hour cyan when most of its charge energy net-imports', () => {
    const bars = planHourBars(
      [slot(3, 0, 6, 7), slot(3, 15, 6, 7), slot(3, 30, 6, 7), slot(3, 45, 1, -1)],
      NOW,
    );
    expect(bars[3].kind).toBe('netzladen');
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
