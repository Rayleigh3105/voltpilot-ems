import { describe, expect, it } from 'vitest';
import {
  BAND_WORT,
  bandLabelWidthPx,
  bandWordRuns,
  bandLegende,
  bandRole,
  bandRoleColor,
  bandRoles,
  bankedValueLine,
  chargeKind,
  CURTAIL_BAND_CAUSE,
  CURTAIL_BAND_WORD,
  CURTAIL_DEADBAND_KW,
  CURTAIL_LEGEND_LABEL,
  curtailArea,
  curtailBandLabel,
  curtailmentPlannedLine,
  curtailmentToday,
  curtailSpans,
  curtailTickData,
  curtailTooltip,
  dayBoundaries,
  daypart,
  DUTY_HINT,
  dutyLabel,
  dutyTooltip,
  forecastLines,
  hasCurtailment,
  hasGridCharge,
  HORIZON_HINT,
  horizonHint,
  planCoversNow,
  planHourBars,
  planInsightParts,
  planKernaussage,
  plannedDayCosts,
  phaseBandRuns,
  planSentence,
  planStaleNote,
  planStreifenSkala,
  planStreifenTicks,
  LOAD_FORECAST_LABEL,
  MEASURED_LOAD_LABEL,
  MEASURED_PV_LABEL,
  measuredLoadLine,
  measuredNote,
  measuredPvLine,
  needsPointMarkers,
  todaySlots,
  toggleSeries,
  powerAxisMax,
  PLAN_STALE_AFTER_MS,
  PV_FORECAST_LABEL,
  PV_SOURCE_DEADBAND_KW,
  priceSpread,
  savingsTodayEur,
  SLOT_DEADBAND_KW,
  slotAktionSatz,
  slotBarColor,
  slotBarMark,
  slotDuty,
  socRange,
  socRangeLine,
} from './schedule';
import { chartTheme, type ChartTheme } from './chartTheme';
import { eurAmount, NBSP } from './format';

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

describe('hasCurtailment (legend gate for the orange Abregeln entry)', () => {
  it('true as soon as one slot really holds PV back', () => {
    expect(hasCurtailment([{ curtailKw: null }, { curtailKw: 4.2 }])).toBe(true);
  });

  it('false for a plan that never curtails - the legend must not advertise it', () => {
    expect(hasCurtailment([{ curtailKw: null }, { curtailKw: 0 }, {}])).toBe(false);
  });

  it('ignores solver noise below the deadband', () => {
    expect(hasCurtailment([{ curtailKw: CURTAIL_DEADBAND_KW }])).toBe(false);
  });

  it('spricht im PLAN-Wortlaut - die Cloud kennt keinen Ausführungs-Beleg', () => {
    expect(CURTAIL_LEGEND_LABEL).toContain('geplant');
  });
});

// ---- Abregeln SICHTBAR machen (Scout vp-pilsting-abregeln Frage 4) ---------

describe('curtailSpans (das orange Band)', () => {
  it('fasst zusammenhängende Abregel-Slots zu EINEM Block zusammen', () => {
    expect(
      curtailSpans([
        { curtailKw: null },
        { curtailKw: 4 },
        { curtailKw: 3 },
        { curtailKw: 0 },
        { curtailKw: 2 },
        { curtailKw: 1 },
      ]),
    ).toEqual([
      { from: 1, to: 2 },
      { from: 4, to: 5 },
    ]);
  });

  it('verbreitert einen Ein-Slot-Block, weil er auf der Kategorie-Achse sonst null Pixel breit wäre', () => {
    expect(curtailSpans([{ curtailKw: null }, { curtailKw: 4 }, { curtailKw: null }])).toEqual([
      { from: 1, to: 2 },
    ]);
    // Am Ende der Reihe gibt es keinen Nachbarn rechts - dann nach links.
    expect(curtailSpans([{ curtailKw: null }, { curtailKw: 4 }])).toEqual([{ from: 0, to: 1 }]);
  });

  it('liefert nichts für einen Plan, der nie abregelt (auch nicht bei Rauschen)', () => {
    expect(curtailSpans([{ curtailKw: null }, { curtailKw: 0 }, {}])).toEqual([]);
    expect(curtailSpans([{ curtailKw: CURTAIL_DEADBAND_KW }])).toEqual([]);
  });
});

describe('curtailTickData (die exakte Slot-Wahrheit am Nullpunkt)', () => {
  it('markiert GENAU die abregelnden Slots mit der Null, sonst Lücke', () => {
    expect(
      curtailTickData([{ curtailKw: null }, { curtailKw: 4 }, { curtailKw: 0 }, {}]),
    ).toEqual([null, 0, null, null]);
  });

  it('behauptet keine Leistung - der Wert ist immer die Null (Höhe kommt in Pixeln)', () => {
    expect(curtailTickData([{ curtailKw: 42 }])).toEqual([0]);
  });
});

describe('curtailArea (die gedrosselte Menge in der Prognosen-Ebene)', () => {
  it('spannt zwischen Einspeise-Cap und PV-Prognose, Cap + Höhe = PV exakt', () => {
    const area = curtailArea([{ pvKw: 10, curtailKw: 4 }]);
    expect(area.cap).toEqual([6]);
    expect(area.delta).toEqual([4]);
    expect(area.cap[0]! + area.delta[0]!).toBe(10);
    expect(area.present).toBe(true);
  });

  it('lässt einen Slot ohne PV-Wert LEER statt eine 0 zu erfinden', () => {
    const area = curtailArea([{ pvKw: null, curtailKw: 4 }, { curtailKw: 3 }]);
    expect(area).toEqual({ cap: [null, null], delta: [null, null], present: false });
  });

  it('lässt nicht abregelnde Slots leer und klemmt einen negativen Cap auf 0', () => {
    const area = curtailArea([
      { pvKw: 9, curtailKw: null },
      { pvKw: 2, curtailKw: 5 },
    ]);
    expect(area.cap).toEqual([null, 0]);
    expect(area.delta).toEqual([null, 2]);
  });
});

describe('curtailTooltip (die Menge im Tooltip)', () => {
  it('nennt Menge und Einspeise-Cap', () => {
    expect(curtailTooltip({ curtailKw: 4.25, pvKw: 10 })).toBe(
      'Abregeln geplant: 4,25 kW (Einspeise-Cap 5,75 kW)',
    );
  });

  it('lässt den Cap weg, wenn der Lauf keine PV-Prognose trägt', () => {
    expect(curtailTooltip({ curtailKw: 3, pvKw: null })).toBe('Abregeln geplant: 3 kW');
  });

  it('schweigt in einem Slot ohne Abregelung', () => {
    expect(curtailTooltip({ curtailKw: null, pvKw: 10 })).toBeNull();
    expect(curtailTooltip({ curtailKw: CURTAIL_DEADBAND_KW, pvKw: 10 })).toBeNull();
  });

  it('besteht nur aus Konstanten + Zahlen (XSS-Regel der Chart-Formatter)', () => {
    expect(curtailTooltip({ curtailKw: 4, pvKw: 10 })).not.toMatch(/[<>]/);
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

  it('plannedDayCosts liefert die drei Zahlen EINER Rechnung', () => {
    const slots = [
      { ...slot(10, 0, 2), costEur: 0.55, baselineCostEur: 0.9 },
      { ...slot(11, 0, 2), costEur: 1.0, baselineCostEur: 1.0 },
    ];
    const g = plannedDayCosts(slots, NOW)!;
    expect(g.actualEur).toBeCloseTo(1.55, 10);
    expect(g.baselineEur).toBeCloseTo(1.9, 10);
    // Die Ersparnis ist die DIFFERENZ der zwei gezeigten Zahlen, nie eine
    // eigenständige dritte Größe.
    expect(g.savedEur).toBeCloseTo(g.baselineEur - g.actualEur, 10);
    expect(savingsTodayEur(slots, NOW)).toBeCloseTo(g.savedEur, 10);
  });

  it('plannedDayCosts überspringt eine halbe Zeile - beide Summen über DIESELBEN Slots', () => {
    const slots = [
      { ...slot(10, 0, 2), costEur: 0.55, baselineCostEur: 0.9 },
      { ...slot(11, 0, 2), costEur: null, baselineCostEur: 7.0 },
    ];
    const g = plannedDayCosts(slots, NOW)!;
    expect(g.baselineEur).toBeCloseTo(0.9, 10);
    expect(g.actualEur).toBeCloseTo(0.55, 10);
  });

  it('plannedDayCosts ist null ohne bepreiste Viertelstunde', () => {
    expect(plannedDayCosts([], NOW)).toBeNull();
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

  // Herzogau 17.08.2026 (`vp-nacht-ruhe-warum-q8` §0): die drei Nacht-Balken
  // lagen WEIT unter dem Hausverbrauch - der Fahrplan plante in genau diesen
  // Slots Netz-BEZUG. Die Kopfzeile sagte trotzdem „nachts verkaufen".
  it('DV: eine Entladung UNTER der Hauslast deckt den Verbrauch, sie verkauft nicht', () => {
    // Entladung 3 kW, aber der Netzanschluss bezieht weiter 4 kW -> netto
    // Import, es verlässt nichts den Netzverknüpfungspunkt.
    const slots = [...hours(11, 14, 4, -3), ...hours(23, 24, -3, 4)];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Mittags laden, nachts den Verbrauch decken (23–24 Uhr).',
    );
    expect(planSentence(hours(23, 24, -3, 4), 'direktvermarktung', NOW)).toBe(
      'Nachts den Verbrauch decken (23–24 Uhr).',
    );
  });

  it('DV: erst der NETTO-Export macht daraus einen Verkauf', () => {
    expect(planSentence(hours(17, 20, -5, -5), 'direktvermarktung', NOW)).toBe(
      'Abends verkaufen (17–20 Uhr).',
    );
    // Ein ausgeglichener Netzanschluss ist kein Verkauf (Totband).
    expect(planSentence(hours(17, 20, -5, 0), 'direktvermarktung', NOW)).toBe(
      'Abends den Verbrauch decken (17–20 Uhr).',
    );
    // Ohne geplanten Netzwert (ältere Plan-Zeilen) bleibt die vorsichtigere,
    // immer wahre Aussage stehen statt eines behaupteten Erlöses.
    expect(planSentence(hours(17, 20, -5, null), 'direktvermarktung', NOW)).toBe(
      'Abends den Verbrauch decken (17–20 Uhr).',
    );
    // Eigenverbrauch spricht unverändert „nutzen" - die Regel gilt nur dem
    // Verkaufs-Wort.
    expect(planSentence(hours(17, 20, -5, 4), 'eigenverbrauch', NOW)).toBe(
      'Abends nutzen (17–20 Uhr).',
    );
  });

  it('DV: nennt Lastdeckung und Verkauf gemeinsam, wenn ein Entladefenster beides tut', () => {
    const slots = [...hours(19, 20, -5, 1), ...hours(20, 21, -5, -4)];
    expect(planSentence(slots, 'direktvermarktung', NOW)).toBe(
      'Abends den Verbrauch decken und Überschuss verkaufen (19–21 Uhr).',
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

  it('names the recorded reason on an all-idle day, or stays silent', () => {
    const idle = (slotRole: string | null, extra: Record<string, unknown> = {}) =>
      hours(8, 20, 0, 1).map((s) => ({ ...s, slotRole, priceEurMwh: 200, ...extra }));

    // No reason recorded -> the bare observation, exactly as before.
    expect(planSentence(idle(null), 'eigenverbrauch', NOW)).toBe(
      'Der Speicher hält heute seine Ladung.',
    );
    expect(
      planSentence(idle('reserve_halten', { slotFlags: ['reserve_backup'] }), 'eigenverbrauch', NOW),
    ).toBe('Der Speicher hält seine Ladung heute als Notstrom-Reserve zurück.');
    expect(
      planSentence(idle('reserve_halten', { slotFlags: ['reserve_peak'] }), 'eigenverbrauch', NOW),
    ).toBe(
      'Der Speicher hält seine Ladung heute als Reserve für die Lastspitzenkappung zurück.',
    );
    expect(
      planSentence(idle('warten', { storedValueCtKwh: 28.3 }), 'eigenverbrauch', NOW),
    ).toBe(
      'Der Speicher hält heute seine Ladung - sie ist mit 28,3 ct/kWh bewertet, ' +
        'mehr als der höchste Preis heute (20,0 ct/kWh).',
    );
    expect(planSentence(idle('warten'), 'eigenverbrauch', NOW)).toBe(
      'Der Speicher wartet heute - weder Laden noch Entladen ist eingeplant.',
    );
  });
});

describe('planStreifenSkala (K1 · die Maßstabs-Zeile des Ministreifens)', () => {
  it('nennt beide Spitzen ohne eine überholte Form-Legende', () => {
    const bars = planHourBars([...hours(11, 12, 10.9, -3), ...hours(18, 19, -7, 2)], NOW);
    const satz = planStreifenSkala(bars)!;
    expect(satz).toContain('Höchstens 10,9');
    expect(satz).toContain('laden');
    expect(satz).toContain('7,0');
    expect(satz).toContain('abgeben');
    expect(satz).not.toContain('Umriss');
  });

  it('nennt nur, was der Plan wirklich vorsieht', () => {
    const nurLaden = planStreifenSkala(planHourBars(hours(11, 12, 4, -3), NOW))!;
    expect(nurLaden).toContain('laden');
    expect(nurLaden).not.toContain('abgeben');
  });

  it('behauptet an einem Tag ohne Bewegung GAR NICHTS', () => {
    expect(planStreifenSkala(planHourBars([], NOW))).toBeNull();
  });
});

describe('planStreifenTicks (die Stundenskala steht ÜBER ihrer Stunde)', () => {
  it('setzt jede Stunde auf ihren Anteil des Tages', () => {
    const ticks = planStreifenTicks();
    expect(ticks.map((t) => t.hour)).toEqual([0, 6, 12, 18, 24]);
    expect(ticks.map((t) => t.pct)).toEqual([0, 25, 50, 75, 100]);
  });

  it('bleibt für eine eigene Auswahl richtig', () => {
    expect(planStreifenTicks([12])).toEqual([{ hour: 12, pct: 50 }]);
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

describe('curtailmentPlannedLine · Plan, nie ein realisiertes Euro-Verb', () => {
  const energy = (kwh: number) => `${kwh} kWh`;
  const eur = (v: number) => `${v} €`;

  it('sagt „geplant" und stellt den vermiedenen Verlust in den Konjunktiv', () => {
    expect(curtailmentPlannedLine({ curtailedKwh: 3, avoidedLossEur: 0.12 }, energy, eur)).toBe(
      'Heute geplant: 3 kWh abregeln (würde rund 0.12 € Verlust bei negativen Preisen vermeiden).',
    );
  });

  it('behauptet nirgends eine ausgeführte Abregelung', () => {
    const s = curtailmentPlannedLine({ curtailedKwh: 3, avoidedLossEur: 0.12 }, energy, eur);
    expect(s).not.toMatch(/abgeregelt|vermieden\b(?! )/);
    expect(s).not.toContain('vermieden.');
  });

  it('lässt den Euro-Teil unter dem Totband weg statt „0,00 €" zu zeigen', () => {
    expect(curtailmentPlannedLine({ curtailedKwh: 1.5, avoidedLossEur: 0 }, energy, eur)).toBe(
      'Heute geplant: 1.5 kWh abregeln.',
    );
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

// ---------------------------------------------------------------------------
// Audit fixes F2 / F3 / F4 / F5 (report `vp-audit-view`, section 3 Fahrplan)
// ---------------------------------------------------------------------------

/**
 * F2: a plan generated yesterday was presented as today's ("So plant Ihr
 * Speicher den Tag" over a date-less time axis). The banner states only what
 * the plan itself proves - when it was made, that nothing newer exists, and
 * whether it still covers the current moment.
 */
describe('planStaleNote', () => {
  const iso = (h: number, m: number, dayOffset = 0) =>
    new Date(2026, 6, 7 + dayOffset, h, m).toISOString();

  it('stays silent for a fresh plan and without a generation time', () => {
    // NOW is 09:30; a run from 09:00 is one of the last few 15-min cycles.
    expect(planStaleNote(iso(9, 0), [slot(9, 0, 2), slot(23, 45, 0)], NOW)).toBeNull();
    expect(planStaleNote(null, [slot(9, 0, 2)], NOW)).toBeNull();
    expect(planStaleNote(undefined, [slot(9, 0, 2)], NOW)).toBeNull();
    expect(planStaleNote('nonsense', [slot(9, 0, 2)], NOW)).toBeNull();
  });

  it('fires once the newest run is older than two hours', () => {
    const justInside = new Date(NOW.getTime() - PLAN_STALE_AFTER_MS + 60_000).toISOString();
    expect(planStaleNote(justInside, [slot(9, 0, 2), slot(23, 45, 0)], NOW)).toBeNull();
    const justOutside = new Date(NOW.getTime() - PLAN_STALE_AFTER_MS - 60_000).toISOString();
    const note = planStaleNote(justOutside, [slot(9, 0, 2), slot(23, 45, 0)], NOW);
    expect(note).toContain('von heute');
    expect(note).toContain('seitdem wurde kein neuer Fahrplan berechnet');
  });

  it("names yesterday's run and says the bars are a past window (the audit case)", () => {
    // The real dump: newest run 22.07. 10:29, the plan ends the same evening.
    const note = planStaleNote(
      iso(10, 29, -1),
      [slot(10, 30, -3, null, -1), slot(23, 45, 0, null, -1)],
      NOW,
    );
    expect(note).toContain('von gestern, 10:29 Uhr');
    expect(note).toContain('bereits vergangenen Zeitraum');
  });

  it('dates an older run and drops the past-window clause while the plan still runs', () => {
    const note = planStaleNote(iso(10, 29, -3), [slot(9, 0, 2), slot(23, 45, 0)], NOW);
    expect(note).toContain('vom 04.07., 10:29 Uhr');
    expect(note).not.toContain('bereits vergangenen Zeitraum');
  });

  it('planCoversNow follows the plan horizon, not the calendar day', () => {
    expect(planCoversNow([slot(9, 0, 2), slot(23, 45, 0)], NOW)).toBe(true);
    expect(planCoversNow([slot(6, 0, 2), slot(8, 0, 0)], NOW)).toBe(false);
    expect(planCoversNow([slot(10, 0, 2), slot(23, 45, 0)], NOW)).toBe(false);
    expect(planCoversNow([], NOW)).toBe(false);
    // The last slot still counts until its own end (09:15 + 15 min > 09:30 is
    // false, so use the slot that contains NOW).
    expect(planCoversNow([slot(9, 30, 2)], NOW)).toBe(true);
  });
});

/**
 * F3: the takeaway claimed "bei flachem Preisverlauf bleibt der Speicher
 * überwiegend in Ruhe" while the plant visibly cycled over a 3 -> 17 ct curve,
 * because that clause was merely the else-branch of the savings clause.
 */
describe('planInsightParts', () => {
  const text = (parts: ReturnType<typeof planInsightParts>) =>
    (parts ?? []).map((p) => p.text).join('');
  const priced = (
    hour: number,
    batteryKw: number | null,
    priceEurMwh: number | null,
    costEur: number | null = null,
    baselineCostEur: number | null = null,
  ) => ({ ...slot(hour, 0, batteryKw), priceEurMwh, costEur, baselineCostEur });

  it('never calls a cycling plan flat, even when today saves nothing', () => {
    const parts = planInsightParts([priced(3, 5, 30), priced(19, -5, 170)], NOW);
    const s = text(parts);
    expect(s).toContain('lädt günstig');
    expect(s).toContain('entlädt teuer');
    expect(s).not.toContain('flach');
    expect(s).not.toContain('in Ruhe');
  });

  it('appends the savings clause only when today really saves', () => {
    const parts = planInsightParts(
      [priced(3, 5, 30, -0.2, 0.1), priced(19, -5, 170, -0.5, 0.2)],
      NOW,
    );
    expect(text(parts)).toContain('das spart heute rund');
    expect((parts ?? []).some((p) => p.strong && p.text.includes('€'))).toBe(true);
  });

  it('keeps the idle wording for a plan that really does nothing', () => {
    const parts = planInsightParts([priced(3, 0, 30), priced(19, 0, 32)], NOW);
    const s = text(parts);
    expect(s).toContain('in Ruhe');
    expect(s).not.toContain('lädt günstig');
  });

  /**
   * The idle sentence used to assert "die Preisunterschiede lohnen kein Laden
   * und Entladen" as a blanket fallback that inspected no price at all. That
   * is what hid the flat-tariff freeze (scout vp-fahrplan-idle-n7): the plan
   * was idle over a 20 ct spread and told its owner the spread was too small.
   * It must now name the reason the optimizer RECORDED, or say nothing.
   */
  describe('names the recorded reason instead of asserting one', () => {
    const why = (
      hour: number,
      slotRole: string | null,
      slotFlags: string[] | null = null,
      storedValueCtKwh: number | null = null,
      priceEurMwh: number | null = 200,
    ) => ({ ...priced(hour, 0, priceEurMwh), slotRole, slotFlags, storedValueCtKwh });

    it('never repeats the unverified price-difference claim', () => {
      for (const slots of [
        [why(3, null), why(19, null)],
        [why(3, 'warten'), why(19, 'warten')],
        [why(3, 'reserve_halten', ['reserve_backup'])],
        [why(3, 'warten', null, 28.3, 200)],
      ]) {
        expect(text(planInsightParts(slots, NOW))).not.toContain(
          'Preisunterschiede lohnen kein Laden und Entladen',
        );
      }
    });

    it('states only the observation when no reason was computed', () => {
      // Pre-feature rows (an older optimizer, or a failed explain pass): keep
      // "in Ruhe" and drop the causal clause entirely.
      const s = text(planInsightParts([why(3, null), why(19, null)], NOW));
      expect(s).toBe('Der Speicher bleibt in diesem Zeitraum in Ruhe.');
      expect(s).not.toContain(' - ');
    });

    it('names a backup reserve', () => {
      const s = text(
        planInsightParts([why(3, 'reserve_halten', ['reserve_backup', 'soc_floor'])], NOW),
      );
      expect(s).toBe('Der Speicher hält seine Ladung als Notstrom-Reserve zurück.');
    });

    it('names a peak-shaving reserve', () => {
      const s = text(
        planInsightParts([why(3, 'reserve_halten', ['reserve_peak', 'soc_floor'])], NOW),
      );
      expect(s).toBe(
        'Der Speicher hält seine Ladung als Reserve für die Lastspitzenkappung zurück.',
      );
    });

    it('names the stored-energy valuation that outranks the whole window', () => {
      // THE sentence that would have exposed the freeze in one glance: stored
      // energy valued at 28.3 ct against a 20 ct peak.
      const s = text(
        planInsightParts(
          [why(3, 'warten', null, 28.3, 200), why(19, 'warten', null, 28.3, 180)],
          NOW,
        ),
      );
      expect(s).toContain('hält seine Ladung');
      expect(s).toContain('28,3');
      expect(s).toContain('20,0');
      expect(s).toContain('mehr als der höchste Preis im Zeitraum');
    });

    it('falls back to plain waiting when the valuation does not outrank the window', () => {
      const s = text(
        planInsightParts([why(3, 'warten', null, 12.0, 200)], NOW),
      );
      expect(s).toBe(
        'Der Speicher wartet - weder Laden noch Entladen ist in diesem Zeitraum eingeplant.',
      );
    });

    it('does not claim "mehr als" on a tie', () => {
      // Equal at the shown precision is a tie, and a tie is honestly just
      // waiting - the sentence must never read "20,0 ct, mehr als 20,0 ct".
      const s = text(planInsightParts([why(3, 'warten', null, 20.0, 200)], NOW));
      expect(s).not.toContain('mehr als');
      expect(s).toContain('wartet');
    });

    it('makes no claim for an idle stretch under an unexpected role', () => {
      const s = text(planInsightParts([why(3, 'irgendwas_neues')], NOW));
      expect(s).toBe('Der Speicher bleibt in diesem Zeitraum in Ruhe.');
    });

    it('reads the reason from the IDLE slots, by dominant role', () => {
      const slots = [
        why(3, 'warten', null, 28.3, 200),
        why(4, 'warten', null, 28.3, 200),
        why(5, 'reserve_halten', ['reserve_backup']),
      ];
      expect(text(planInsightParts(slots, NOW))).toContain('mehr als der höchste Preis');
    });
  });

  it('describes a one-directional plan without inventing the other half', () => {
    expect(text(planInsightParts([priced(12, 5, 20)], NOW))).toContain('lädt');
    expect(text(planInsightParts([priced(19, -5, 180)], NOW))).toContain('entlädt');
    // Nothing priced at all: no sentence rather than a made-up one.
    expect(planInsightParts([priced(12, 5, null)], NOW)).toBeNull();
  });
});

/** F4: the SoC band must be readable without hovering (touch has no hover). */
describe('socRange / socRangeLine', () => {
  const s = (socPct: number | null) => ({ ...slot(10, 0, 0), socPct });

  it('names the planned band', () => {
    expect(socRange([s(12.4), s(88.2), s(50)])).toEqual({ min: 12.4, max: 88.2 });
    expect(socRangeLine([s(12.4), s(88.2), s(50)])).toBe(
      `Geplanter Ladestand: 12${NBSP}% bis 88${NBSP}% im Tagesverlauf.`,
    );
  });

  it('collapses a flat trajectory into one value', () => {
    expect(socRangeLine([s(40), s(40.3)])).toBe(
      `Geplanter Ladestand: durchgehend rund 40${NBSP}%.`,
    );
  });

  it('stays absent without SoC data (never a fabricated 0 %)', () => {
    expect(socRange([s(null), s(null)])).toBeNull();
    expect(socRangeLine([s(null)])).toBeNull();
    expect(socRangeLine([])).toBeNull();
  });
});

/**
 * K5: Laden, Netzladen und Abgeben sind gefüllte Zustände mit eigenen Tönen;
 * Position und Wort tragen die Richtung zusätzlich.
 * F5 gilt unverändert weiter: Entladen verdient Geld und wird nie rot.
 */
describe('slotBarMark / slotBarColor', () => {
  const t = {
    charge: '#2E9E5B',
    gridCharge: '#00ACC1',
    battDischarge: '#8B1E3F',
    discharge: '#E53935',
    surface: '#FFFFFF',
  } as ChartTheme;

  it('zeichnet Laden und Abgeben gefüllt in getrennten Farben', () => {
    expect(slotBarMark('entladen', t)).toEqual({ color: t.battDischarge, form: 'filled' });
    expect(slotBarMark('solarladen', t)).toEqual({ color: t.charge, form: 'filled' });
    expect(slotBarColor('entladen', t)).not.toBe(slotBarColor('solarladen', t));
  });

  it('malt Entladen nie im Kosten-Rot (F5, unverändert)', () => {
    expect(slotBarColor('entladen', t)).not.toBe(t.discharge);
  });

  it('behält Netzladen als EIGENEN Ton - die EEG-Unterscheidung ist compliance-tragend', () => {
    expect(slotBarMark('netzladen', t)).toEqual({ color: t.gridCharge, form: 'filled' });
    expect(slotBarColor('netzladen', t)).not.toBe(t.charge);
  });

  it('führt in der echten Palette genau den eigenen Entladen-Ton', () => {
    const real = chartTheme();
    expect(slotBarColor('entladen', real)).toBe(real.battDischarge);
    expect(real.battDischarge).not.toBe(real.charge);
    expect(real.battDischarge).not.toBe(real.discharge);
  });
});


/**
 * K1/M11: die Kernaussage des Fahrplans. Sie ist ZUSAMMENGESETZT (planSentence
 * + savingsTodayEur + die persistierte Baseline) - hier wird vor allem
 * festgenagelt, was sie NICHT behauptet.
 */
describe('planKernaussage', () => {
  const heute = (h: number, min = 0) => {
    const d = new Date();
    d.setHours(h, min, 0, 0);
    return d.toISOString();
  };
  const slot = (h: number, batteryKw: number, cost: number, baseline: number) => ({
    start: heute(h),
    batteryKw,
    gridKw: batteryKw > 0 ? 1 : -1,
    costEur: cost,
    baselineCostEur: baseline,
  });

  it('setzt Satz, Zahl und Vergleichsanker aus den vorhandenen Ableitungen zusammen', () => {
    const slots = [slot(12, 5, 0.1, 0.6), slot(19, -5, 0.2, 0.9)];
    const k = planKernaussage(slots, 'direktvermarktung', new Date());
    // Die Aktivität IST planSentence - keine zweite Formulierung; sie wird nur
    // hinter dem Halbsatz eingebettet, der die Zahl benennt.
    const aktivitaet = planSentence(slots, 'direktvermarktung', new Date())!;
    expect(k.satz).toContain(aktivitaet[0].toLowerCase() + aktivitaet.slice(1));
    expect(k.satz).toContain('verkaufen');
    expect(k.wert).toBe(eurAmount(savingsTodayEur(slots, new Date()) ?? 0));
    // K8: keine Zahl ohne Vergleichsanker - die Baseline liegt im Plan. Eine
    // Direktvermarktungs-Anlage vergleicht sich per proofLine mit der
    // UNGEREGELTEN Anlage, nicht mit einer fehlenden Batterie.
    expect(k.anker).toContain('Stromkosten mit VoltPilot');
    expect(k.anker).toContain('Ungeregelt wären es');
    expect(k.grund).toBeNull();
    expect(k.ton).toBe('ok');
  });

  /**
   * Der behobene Kundenbefund (11.08.2026): über „Ohne Speicher wären es
   * 1,90 €." stand die ERSPARNIS 0,35 € - Ersparnis gegen Kosten, was sich
   * las, als mache der Speicher es schlechter.
   */
  it('vergleicht Kosten gegen Kosten und benennt die Zahl als Ersparnis', () => {
    // Kosten mit VoltPilot 1,55 €, ohne Speicher 1,90 € => Ersparnis 0,35 €.
    const slots = [slot(12, 5, 0.55, 0.9), slot(19, -5, 1.0, 1.0)];
    const k = planKernaussage(slots, 'eigenverbrauch', new Date());
    expect(k.wert).toBe(eurAmount(0.35));
    expect(k.satz).toContain('spart der Fahrplan heute ein');
    // Beide Seiten des Ankers sind KOSTEN, beide beschriftet, und ihre
    // Differenz ist genau die Zahl oben.
    expect(k.anker).toBe(
      `Stromkosten mit VoltPilot ${eurAmount(1.55)} · Ohne Speicher wären es ${eurAmount(1.9)}.`,
    );
    // Der alte, einseitige Wortlaut darf nicht zurückkommen.
    expect(k.anker).not.toMatch(/^Ohne Speicher wären es/);
  });

  it('nennt eine negative Ersparnis ehrlich und tönt sie nie als Gewinn', () => {
    // Kosten mit VoltPilot 2,40 €, ohne Speicher 1,90 € => -0,50 €.
    const slots = [slot(12, 5, 1.4, 0.9), slot(19, -5, 1.0, 1.0)];
    const k = planKernaussage(slots, 'eigenverbrauch', new Date());
    // Der Betrag ist absolut, die Richtung steht im Wort.
    expect(k.wert).toBe(eurAmount(0.5));
    expect(k.wert).not.toContain('-');
    expect(k.satz).toContain('kostet der Fahrplan heute mehr als ohne Speicher');
    expect(k.ton).toBe('calm');
    expect(k.anker).toBe(
      `Stromkosten mit VoltPilot ${eurAmount(2.4)} · Ohne Speicher wären es ${eurAmount(1.9)}.`,
    );
  });

  it('folgt der Veräußerungsform auch im Halbsatz zur Zahl', () => {
    const slots = [slot(12, 5, 0.1, 0.6), slot(19, -5, 0.2, 0.9)];
    expect(planKernaussage(slots, 'direktvermarktung', new Date()).satz).toContain(
      'verdient der Fahrplan heute mehr',
    );
    const teuer = [slot(12, 5, 1.4, 0.9), slot(19, -5, 1.0, 1.0)];
    expect(planKernaussage(teuer, 'direktvermarktung', new Date()).satz).toContain(
      'weniger heraus als eine ungeregelte Anlage',
    );
  });

  it('rechnet Wert UND Anker über DIESELBEN Slots', () => {
    // Der zweite Slot trägt nur eine Baseline - er gehört in keine der beiden
    // Zahlen, sonst verglichen sie verschiedene Zeitfenster.
    const slots = [
      slot(12, 5, 0.55, 0.9),
      { start: heute(19), batteryKw: -5, gridKw: -1, costEur: null, baselineCostEur: 7.0 },
    ];
    const k = planKernaussage(slots, 'eigenverbrauch', new Date());
    expect(k.wert).toBe(eurAmount(0.35));
    expect(k.anker).toContain(eurAmount(0.9));
    expect(k.anker).not.toContain(eurAmount(7.9));
  });

  it('sagt ohne Fahrplan den ehrlichen GRUND statt eines erfundenen Satzes', () => {
    const k = planKernaussage([], 'eigenverbrauch', new Date());
    expect(k.satz).toBeNull();
    expect(k.wert).toBeNull();
    expect(k.grund).toBe('Für heute liegt noch kein Fahrplan vor.');
  });

  it('nennt keine Zahl und keinen Anker ohne bepreiste Slots - nie eine erfundene 0', () => {
    const slots = [
      { start: heute(12), batteryKw: 5, gridKw: 1, costEur: null, baselineCostEur: null },
      { start: heute(19), batteryKw: -5, gridKw: -1, costEur: null, baselineCostEur: null },
    ];
    const k = planKernaussage(slots, 'eigenverbrauch', new Date());
    expect(k.satz).not.toBeNull();
    expect(k.wert).toBeNull();
    expect(k.anker).toBeNull();
  });

  it('behandelt eine Ersparnis im Rauschen wie keine', () => {
    const slots = [slot(12, 5, 0.1, 0.1), slot(19, -5, 0.2, 0.2)];
    const k = planKernaussage(slots, 'eigenverbrauch', new Date());
    expect(k.wert).toBeNull();
    expect(k.anker).toBeNull();
    expect(k.ton).toBe('calm');
    // Ohne Zahl bleibt es bei der reinen Aktivität - kein benennender Halbsatz
    // zu einer Zahl, die gar nicht dasteht.
    expect(k.satz).toBe(planSentence(slots, 'eigenverbrauch', new Date()));
  });

  it('folgt der Veräußerungsform im Wortlaut', () => {
    const slots = [slot(12, 5, 0.1, 0.6), slot(19, -5, 0.2, 0.9)];
    expect(planKernaussage(slots, 'eigenverbrauch', new Date()).satz).toContain('nutzen');
  });
});

// ---- Forecast lines (PV + Verbrauch) over the Fahrplan ----------------------

describe('forecastLines / powerAxisMax / toggleSeries', () => {
  it('builds both slot-aligned series and reports their peaks', () => {
    const f = forecastLines([
      { pvKw: 0, loadKw: 1.2 },
      { pvKw: 4.5, loadKw: 0.8 },
      { pvKw: 2, loadKw: 3.4 },
    ]);
    expect(f.pv.label).toBe(PV_FORECAST_LABEL);
    expect(f.load.label).toBe(LOAD_FORECAST_LABEL);
    expect(f.pv.values).toEqual([0, 4.5, 2]);
    expect(f.load.values).toEqual([1.2, 0.8, 3.4]);
    expect(f.pv.present).toBe(true);
    expect(f.load.present).toBe(true);
    expect(f.pv.maxKw).toBe(4.5);
    expect(f.load.maxKw).toBe(3.4);
  });

  it('keeps a missing value ABSENT (a gap), never a fabricated 0', () => {
    const f = forecastLines([{ pvKw: 3, loadKw: null }, { pvKw: null, loadKw: undefined }]);
    expect(f.pv.values).toEqual([3, null]);
    expect(f.load.values).toEqual([null, null]);
    // A line nothing carries is simply not present - the chart omits it.
    expect(f.load.present).toBe(false);
    expect(f.load.maxKw).toBeNull();
  });

  it('is absent on a pre-feature run that carries neither input', () => {
    const f = forecastLines([{ pvKw: null }, {}]);
    expect(f.pv.present).toBe(false);
    expect(f.load.present).toBe(false);
  });

  it('lifts the kW axis so a big PV forecast is not clipped by a small battery', () => {
    const f = forecastLines([{ pvKw: 60, loadKw: 12 }]);
    const none = new Set<string>();
    expect(powerAxisMax(15, f, none)).toBe(60);
    // Hiding the PV line re-tightens the scale to what is still visible.
    expect(powerAxisMax(15, f, new Set([PV_FORECAST_LABEL]))).toBe(15);
    // The peak-shaving Ziel still participates.
    expect(powerAxisMax(15, f, new Set([PV_FORECAST_LABEL, LOAD_FORECAST_LABEL]), 180)).toBe(180);
    // An all-idle plan without forecasts keeps a sane axis.
    expect(powerAxisMax(0, forecastLines([{}]), none)).toBe(1);
  });

  it('toggles one series without touching the others (new set each time)', () => {
    const a = toggleSeries(new Set<string>(), PV_FORECAST_LABEL);
    expect([...a]).toEqual([PV_FORECAST_LABEL]);
    const b = toggleSeries(a, LOAD_FORECAST_LABEL);
    expect(b.has(PV_FORECAST_LABEL)).toBe(true);
    expect(b.has(LOAD_FORECAST_LABEL)).toBe(true);
    const c = toggleSeries(b, PV_FORECAST_LABEL);
    expect([...c]).toEqual([LOAD_FORECAST_LABEL]);
    expect(a.has(LOAD_FORECAST_LABEL)).toBe(false); // untouched original
  });
});

// ---- P3 "Ist-Last": the MEASURED consumption next to its forecast -----------

describe('measuredLoadLine / needsPointMarkers / measuredLoadNote', () => {
  const NOW = new Date('2026-07-30T19:22:48Z');
  const at = (iso: string) => `2026-07-30T${iso}:00Z`;

  it('builds the measured series slot-aligned with the plan', () => {
    const line = measuredLoadLine([
      { measuredLoadKw: 5.851 },
      { measuredLoadKw: 7.117 },
      { measuredLoadKw: null },
    ]);
    expect(line.label).toBe(MEASURED_LOAD_LABEL);
    expect(line.values).toEqual([5.851, 7.117, null]);
    expect(line.present).toBe(true);
    expect(line.count).toBe(2);
    expect(line.maxKw).toBe(7.117);
  });

  it('keeps an unmeasured slot ABSENT (a gap), never a fabricated 0', () => {
    const line = measuredLoadLine([{ measuredLoadKw: null }, {}, { measuredLoadKw: undefined }]);
    expect(line.values).toEqual([null, null, null]);
    expect(line.present).toBe(false);
    expect(line.count).toBe(0);
    expect(line.maxKw).toBeNull();
  });

  it('lifts the kW axis so a measured spike is not clipped by a small battery', () => {
    const f = forecastLines([{ pvKw: 2, loadKw: 4.33 }]);
    const ist = measuredLoadLine([{ measuredLoadKw: 26 }]);
    const none = new Set<string>();
    expect(powerAxisMax(15, [f.pv, f.load, ist], none)).toBe(26);
    // Hiding the Ist line re-tightens the scale, like every other line.
    expect(powerAxisMax(15, [f.pv, f.load, ist], new Set([MEASURED_LOAD_LABEL]))).toBe(15);
  });

  it('asks for point markers while the plan has only a slot or two in the past', () => {
    // The normal MPC case: one completed + one running slot - a bare stroke
    // between two points would be nearly invisible.
    expect(needsPointMarkers(measuredLoadLine([{ measuredLoadKw: 7.1 }]))).toBe(true);
    const many = Array.from({ length: 9 }, () => ({ measuredLoadKw: 3 }));
    expect(needsPointMarkers(measuredLoadLine(many))).toBe(false);
    expect(needsPointMarkers(measuredLoadLine([{ measuredLoadKw: null }]))).toBe(false);
  });

  it('names the reason when past slots carry no measurement, and stays silent otherwise', () => {
    const past = [
      { start: at('19:00'), loadKw: 4.33 },
      { start: at('19:15'), loadKw: 4.33 },
    ];
    expect(measuredNote(past, NOW)).toContain('keine Messwerte des Verbrauchs');
    // Present line -> nothing to explain.
    expect(
      measuredNote([{ start: at('19:00'), loadKw: 4.33, measuredLoadKw: 7.1 }], NOW),
    ).toBeNull();
    // A plan entirely ahead has nothing to compare yet - claiming a gap there
    // would be noise, not honesty.
    expect(
      measuredNote(
        [
          { start: at('19:30'), loadKw: 4.33 },
          { start: at('19:45'), loadKw: 4.33 },
        ],
        NOW,
      ),
    ).toBeNull();
    expect(measuredNote([], NOW)).toBeNull();
  });

  it('never claims a missing measurement for a channel the plan does not forecast', () => {
    // A plan without a PV-Prognose (PV-less plant / pre-feature run) must not
    // be told its PV measurements are missing - there is no line to pair with.
    const loadOnly = [{ start: at('19:00'), loadKw: 4.33 }];
    expect(measuredNote(loadOnly, NOW)).toBe(
      'Für die bereits vergangenen Viertelstunden liegen keine Messwerte des Verbrauchs vor.',
    );
    // A run carrying neither forecast says nothing at all.
    expect(measuredNote([{ start: at('19:00') }], NOW)).toBeNull();
  });
});

// ---- The Ist-PV mirror: measured PV next to its PV-Prognose -----------------

describe('measuredPvLine / measuredNote (PV)', () => {
  const NOW = new Date('2026-07-30T19:22:48Z');
  const at = (iso: string) => `2026-07-30T${iso}:00Z`;

  it('builds the measured PV series slot-aligned with the plan', () => {
    const line = measuredPvLine([
      { measuredPvKw: 15.3 },
      { measuredPvKw: 11.02 },
      { measuredPvKw: null },
    ]);
    expect(line.label).toBe(MEASURED_PV_LABEL);
    expect(line.values).toEqual([15.3, 11.02, null]);
    expect(line.present).toBe(true);
    expect(line.count).toBe(2);
    expect(line.maxKw).toBe(15.3);
  });

  it('keeps an unmeasured slot ABSENT (a gap), never a fabricated 0', () => {
    // A device without a PV channel must not read as "die Sonne schien nicht".
    const line = measuredPvLine([{ measuredPvKw: null }, {}, { measuredPvKw: undefined }]);
    expect(line.values).toEqual([null, null, null]);
    expect(line.present).toBe(false);
    expect(line.count).toBe(0);
    expect(line.maxKw).toBeNull();
  });

  it('is independent of the measured load - one channel may be there without the other', () => {
    const slots = [
      { measuredLoadKw: 5.851, measuredPvKw: null },
      { measuredLoadKw: null, measuredPvKw: 15.3 },
    ];
    expect(measuredLoadLine(slots).values).toEqual([5.851, null]);
    expect(measuredPvLine(slots).values).toEqual([null, 15.3]);
  });

  it('lifts the kW axis and is switchable like every other line', () => {
    const f = forecastLines([{ pvKw: 12, loadKw: 4.33 }]);
    const istPv = measuredPvLine([{ measuredPvKw: 26 }]);
    expect(powerAxisMax(15, [f.pv, f.load, istPv], new Set())).toBe(26);
    expect(powerAxisMax(15, [f.pv, f.load, istPv], new Set([MEASURED_PV_LABEL]))).toBe(15);
    expect([...toggleSeries(new Set(), MEASURED_PV_LABEL)]).toEqual([MEASURED_PV_LABEL]);
  });

  it('asks for point markers while only a slot or two lies in the past', () => {
    expect(needsPointMarkers(measuredPvLine([{ measuredPvKw: 15.3 }]))).toBe(true);
    const many = Array.from({ length: 9 }, () => ({ measuredPvKw: 3 }));
    expect(needsPointMarkers(measuredPvLine(many))).toBe(false);
  });

  it('names both channels in ONE sentence when both measurements are missing', () => {
    const past = [{ start: at('19:00'), pvKw: 12, loadKw: 4.33 }];
    expect(measuredNote(past, NOW)).toBe(
      'Für die bereits vergangenen Viertelstunden liegen keine Messwerte '
        + 'von Verbrauch und PV-Erzeugung vor.',
    );
    // Only the PV twin missing -> only the PV is named.
    expect(
      measuredNote([{ start: at('19:00'), pvKw: 12, loadKw: 4.33, measuredLoadKw: 7.1 }], NOW),
    ).toBe('Für die bereits vergangenen Viertelstunden liegen keine Messwerte der PV-Erzeugung vor.');
    // Both twins there -> silence.
    expect(
      measuredNote(
        [{ start: at('19:00'), pvKw: 12, loadKw: 4.33, measuredLoadKw: 7.1, measuredPvKw: 15.3 }],
        NOW,
      ),
    ).toBeNull();
  });
});

describe('slotDuty / dutyLabel / dutyTooltip (Duty-Vorschau)', () => {
  it('erkennt beide Pflichten - und die Entladeseite gewinnt einen Widerspruch', () => {
    expect(slotDuty({ coverLoadFromBattery: true })).toBe('verbrauch-folgen');
    expect(slotDuty({ chargeFromSurplusOnly: true })).toBe('ueberschuss-laden');
    // Physikalisch unmöglich (Entladen vs. Laden); käme es doch an, wird nicht
    // geraten, sondern deterministisch die Entladeseite genommen.
    expect(slotDuty({ coverLoadFromBattery: true, chargeFromSurplusOnly: true })).toBe(
      'verbrauch-folgen',
    );
  });

  it('markiert NUR bei einem ausdrücklichen true (die Spalten sind dreiwertig)', () => {
    // false = bewertet, keine Pflicht. null/undefined = gar nicht bewertet
    // (älterer Lauf, Schalter aus, älteres Backend). Beides markiert nichts.
    expect(slotDuty({ coverLoadFromBattery: false, chargeFromSurplusOnly: false })).toBeNull();
    expect(slotDuty({ coverLoadFromBattery: null, chargeFromSurplusOnly: null })).toBeNull();
    expect(slotDuty({})).toBeNull();
  });

  it('hält die Worte an EINER Stelle - Film und Tooltip teilen sie', () => {
    expect(dutyLabel('verbrauch-folgen')).toBe('folgt dem gemessenen Verbrauch');
    expect(dutyLabel('ueberschuss-laden')).toBe('lädt nur den Solar-Überschuss');
    expect(dutyLabel('verbrauch-folgen', true)).toBe('folgt zeitweise dem gemessenen Verbrauch');
    expect(dutyLabel('ueberschuss-laden', true)).toBe('lädt zeitweise nur den Solar-Überschuss');
    // Der Tooltip sagt zuerst, WAS der Balken ist, dann was passiert.
    expect(dutyTooltip('verbrauch-folgen')).toBe(
      'Vorhersage, kein fester Befehl — folgt dem gemessenen Verbrauch',
    );
    // Der ausführliche Satz nennt keine internen Begriffe (Duty/Slot/Trim).
    for (const hint of Object.values(DUTY_HINT)) {
      expect(hint).toContain('Vorhersage');
      expect(hint).not.toMatch(/Duty|Slot|Trim|Setpoint/i);
    }
  });
});

/* ---------------------------------------------------------------------------
 * M4 · Das Spannenband (Chart-Redesign Stufe 2)
 *
 * Bezugspreis und Einspeisewert liegen je Viertelstunde vor und wurden nirgends
 * als Kurvenpaar gezeigt - gezeichnet war der nackte Börsenpreis, also genau
 * die Zahl, mit der der Optimierer NICHT entscheidet. Die Fläche dazwischen ist
 * der Grund fürs Laden und Entladen.
 * ------------------------------------------------------------------------- */
describe('priceSpread (das Spannenband)', () => {
  const s = (imp: number | null, exp: number | null) => ({
    importPriceCtKwh: imp,
    exportValueCtKwh: exp,
  });

  it('reicht beide Linien durch und baut die Fläche exakt dazwischen', () => {
    const r = priceSpread([s(30.4, 8.1), s(12, 7)]);
    expect(r.present).toBe(true);
    expect(r.importCt).toEqual([30.4, 12]);
    expect(r.exportCt).toEqual([8.1, 7]);
    // Gestapelt: Basis + Höhe treffen die obere Linie exakt.
    expect(r.base).toEqual([8.1, 7]);
    expect(r.delta[0]).toBeCloseTo(22.3, 6);
    expect(r.base[0]! + r.delta[0]!).toBeCloseTo(30.4, 6);
  });

  it('nennt die größte Spanne samt ihrer Mitte - das Namensschild (K10)', () => {
    const r = priceSpread([s(12, 7), s(30.4, 8.1), s(20, 15)]);
    expect(r.widestIndex).toBe(1);
    expect(r.widestCt).toBeCloseTo(22.3, 6);
    expect(r.widestMidCt).toBeCloseTo((30.4 + 8.1) / 2, 6);
  });

  it('lässt eine unbewertbare Viertelstunde eine LÜCKE, nie eine 0', () => {
    const r = priceSpread([s(30, 8), s(null, null), s(null, 8)]);
    expect(r.importCt).toEqual([30, null, null]);
    expect(r.base).toEqual([8, null, null]);
    expect(r.delta).toEqual([22, null, null]);
  });

  it('trägt ohne BEIDE Größen gar kein Band (älterer Lauf)', () => {
    expect(priceSpread([s(30, null), s(28, null)]).present).toBe(false);
    expect(priceSpread([s(null, 8)]).present).toBe(false);
    expect(priceSpread([]).present).toBe(false);
  });

  it('zeichnet die Fläche auch, wenn der Einspeisewert OBEN liegt', () => {
    // Bei einem negativen Börsenpreis kann die feste Vergütung über dem
    // Bezugspreis liegen. Die Fläche ist definiert als „zwischen den Linien",
    // in jeder Reihenfolge - eine negative Stapelhöhe zeichnete sich sonst
    // nach unten aus dem Band heraus.
    const r = priceSpread([s(-2, 6.4)]);
    expect(r.base).toEqual([-2]);
    expect(r.delta[0]).toBeCloseTo(8.4, 6);
    expect(r.widestMidCt).toBeCloseTo(2.2, 6);
  });

  it('hängt kein Namensschild an eine Spanne, die nur Rauschen ist', () => {
    const r = priceSpread([s(20.0, 20.01)]);
    expect(r.present).toBe(true);
    expect(r.widestIndex).toBeNull();
    expect(r.widestCt).toBeNull();
  });

  it('verwirft unbrauchbare Zahlen, statt sie zu zeichnen', () => {
    const r = priceSpread([{ importPriceCtKwh: Number.NaN, exportValueCtKwh: 8 }]);
    expect(r.importCt).toEqual([null]);
    expect(r.present).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * K5 · Das Abregel-Band trägt sein WORT - und nennt die Ursache nur belegt
 * ------------------------------------------------------------------------- */
describe('curtailBandLabel', () => {
  it('nennt „Preis unter 0", wenn ALLE abregelnden Slots negativ notieren', () => {
    const label = curtailBandLabel([
      { curtailKw: 4, exportValueCtKwh: -1.5 },
      { curtailKw: 2, exportValueCtKwh: -0.4 },
      { curtailKw: null, exportValueCtKwh: 6 },
    ]);
    expect(label).toBe(`${CURTAIL_BAND_WORD}${CURTAIL_BAND_CAUSE}`);
  });

  it('behauptet KEINE Ursache an einer Einspeisegrenze (positiver Preis)', () => {
    // FK1: `site.max_feed_in_kw` lässt den Optimierer auch bei gutem Preis
    // abregeln - „Preis unter 0" wäre dort schlicht falsch.
    expect(curtailBandLabel([{ curtailKw: 4, exportValueCtKwh: 6.4 }])).toBe(CURTAIL_BAND_WORD);
  });

  it('nennt die Ursache nicht, wenn nur EIN Teil der Blöcke negativ ist', () => {
    expect(
      curtailBandLabel([
        { curtailKw: 4, exportValueCtKwh: -1.5 },
        { curtailKw: 4, exportValueCtKwh: 8 },
      ]),
    ).toBe(CURTAIL_BAND_WORD);
  });

  it('nimmt ersatzweise den Börsenpreis, wenn kein Einspeisewert vorliegt', () => {
    expect(curtailBandLabel([{ curtailKw: 4, priceEurMwh: -30 }])).toBe(
      `${CURTAIL_BAND_WORD}${CURTAIL_BAND_CAUSE}`,
    );
    expect(curtailBandLabel([{ curtailKw: 4, priceEurMwh: 80 }])).toBe(CURTAIL_BAND_WORD);
  });

  it('behauptet ohne jedes Preissignal nur das Wort', () => {
    expect(curtailBandLabel([{ curtailKw: 4 }])).toBe(CURTAIL_BAND_WORD);
    expect(curtailBandLabel([])).toBe(CURTAIL_BAND_WORD);
  });
});

describe('K7 · was der Plan in dieser Viertelstunde vorhat, als SATZ', () => {
  it('nennt die Quelle des Ladestroms — sie ist vom Plan BELEGT', () => {
    // Mehr Ladung als geplante PV ⇒ Netzladen (die FK3-Semantik von chargeKind).
    expect(slotAktionSatz({ batteryKw: 5, gridKw: 6, pvKw: 0 })).toBe(
      'Speichert 5 kW günstigen Strom aus dem Netz.',
    );
    // Ladung innerhalb der geplanten PV ⇒ Solarladen.
    expect(slotAktionSatz({ batteryKw: 4, gridKw: 1, pvKw: 6 })).toBe(
      'Speichert 4 kW eigenen Solarstrom.',
    );
  });

  it('spricht Entladen und Ruhe in Kundendeutsch', () => {
    expect(slotAktionSatz({ batteryKw: -3.5, gridKw: -1 })).toBe(
      'Deckt den Verbrauch mit 3,5 kW aus dem Speicher.',
    );
    // Ruhe bekommt KEINE Menge - „0,0 kW" wäre Rauschen.
    expect(slotAktionSatz({ batteryKw: 0, gridKw: 0 })).toBe('Der Speicher hält seine Ladung.');
  });

  it('nennt die Menge IMMER ohne Vorzeichen — die Richtung trägt das Wort', () => {
    for (const satz of [
      slotAktionSatz({ batteryKw: -3.5, gridKw: -1 }),
      slotAktionSatz({ batteryKw: -12, gridKw: -12 }),
    ]) {
      expect(satz).not.toMatch(/[-−]\s*\d/);
    }
  });

  it('sagt ohne geplante Batterieleistung GAR NICHTS', () => {
    expect(slotAktionSatz({ batteryKw: null, gridKw: 1 })).toBeNull();
    expect(slotAktionSatz({})).toBeNull();
  });

  it('besteht aus Konstanten und formatierten Zahlen (XSS-Regel der Formatter)', () => {
    const satz = slotAktionSatz({ batteryKw: 4, gridKw: 1, pvKw: 6 })!;
    expect(satz).not.toMatch(/[<>]/);
  });
});

/* ---------------------------------------------------------------------------
 * 48-h-Horizont (Captain-Entscheid 28.08.2026)
 *
 * Der Optimierer plant seit dem 28.08.2026 bis zu 48 h weit, damit eine
 * Mittags-Entscheidung den ABEND DES FOLGETAGS schon sieht. Für die Fläche
 * heißt das: der Plan überquert Mitternacht zweimal, und die Ableitungen, die
 * „heute" meinen, müssen weiterhin heute meinen.
 * ------------------------------------------------------------------------- */
describe('dayBoundaries · die Tageswechsel eines langen Plans', () => {
  const NOW_48 = new Date('2026-08-28T18:30:00');

  /** `n` Viertelstunden ab lokal 18:30 des 28.08. */
  function langeSlots(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      start: new Date(NOW_48.getTime() + i * 15 * 60_000).toISOString(),
    }));
  }

  it('findet BEIDE Grenzen eines 48-h-Plans und benennt sie relativ zu jetzt', () => {
    const grenzen = dayBoundaries(langeSlots(192), NOW_48);
    expect(grenzen.map((g) => g.label)).toEqual(['Morgen', 'Übermorgen']);
    // 18:30 + 5,5 h = Mitternacht -> Index 22, dann volle 96 Slots später
    expect(grenzen[0].index).toBe(22);
    expect(grenzen[1].index).toBe(22 + 96);
  });

  it('findet genau eine Grenze im 24-h-Plan - das bisherige Bild', () => {
    const grenzen = dayBoundaries(langeSlots(96), NOW_48);
    expect(grenzen).toHaveLength(1);
    expect(grenzen[0].label).toBe('Morgen');
  });

  it('behauptet ohne Tageswechsel gar nichts', () => {
    expect(dayBoundaries(langeSlots(4), NOW_48)).toEqual([]);
    expect(dayBoundaries([], NOW_48)).toEqual([]);
  });

  it('beschriftet RELATIV zu jetzt, nicht durchgezählt', () => {
    // Ein Plan, dessen erster Slot schon MORGEN liegt (ein Lauf kurz vor
    // Mitternacht, dessen frühe Slots abgelaufen sind): sein erster Wechsel
    // ist „Übermorgen", nicht „Morgen".
    const start = new Date('2026-08-29T22:00:00');
    const slots = Array.from({ length: 40 }, (_, i) => ({
      start: new Date(start.getTime() + i * 15 * 60_000).toISOString(),
    }));
    expect(dayBoundaries(slots, NOW_48)[0].label).toBe('Übermorgen');
  });

  it('nennt jenseits von übermorgen das DATUM statt eines erfundenen Wortes', () => {
    const grenzen = dayBoundaries(langeSlots(192 + 96), NOW_48);
    expect(grenzen.map((g) => g.label)).toEqual(['Morgen', 'Übermorgen', '31.08.']);
  });
});

describe('die Tages-Ableitungen bleiben bei HEUTE, auch über 48 h', () => {
  const NOW_48 = new Date('2026-08-28T18:30:00');

  function planSlot(i: number) {
    return {
      start: new Date(NOW_48.getTime() + i * 15 * 60_000).toISOString(),
      batteryKw: 3,
      gridKw: -1,
      pvKw: 10,
      curtailKw: null,
    };
  }

  it('todaySlots zählt nur den heutigen Kalendertag eines 192-Slot-Plans', () => {
    const slots = Array.from({ length: 192 }, (_, i) => planSlot(i));
    // 18:30 bis Mitternacht = 22 Viertelstunden
    expect(todaySlots(slots, NOW_48)).toHaveLength(22);
  });

  it('planHourBars bleibt eine 24-Stunden-Zeile', () => {
    const slots = Array.from({ length: 192 }, (_, i) => planSlot(i));
    const bars = planHourBars(slots, NOW_48);
    expect(bars).toHaveLength(24);
    // die Stunden VOR 18:30 tragen heute keinen Plan mehr
    expect(bars[10].kw).toBeNull();
    expect(bars[19].kind).toBe('solarladen');
  });
});

describe('socRangeLine benennt den Zeitraum, den es wirklich beschreibt', () => {
  function socSlot(i: number, pct: number) {
    return {
      socPct: pct,
      start: new Date(new Date('2026-08-28T18:30:00').getTime() + i * 15 * 60_000).toISOString(),
    };
  }

  it('sagt „im Tagesverlauf", solange der Plan höchstens zwei Tage berührt', () => {
    const slots = Array.from({ length: 96 }, (_, i) => socSlot(i, 10 + (i % 80)));
    expect(socRangeLine(slots)).toContain('im Tagesverlauf');
  });

  it('sagt „im Planungszeitraum", sobald ein 48-h-Plan drei Tage berührt', () => {
    const slots = Array.from({ length: 192 }, (_, i) => socSlot(i, 10 + (i % 80)));
    expect(socRangeLine(slots)).toContain('im Planungszeitraum');
    expect(socRangeLine(slots)).not.toContain('Tagesverlauf');
  });

  it('bleibt ohne Zeitstempel byte-identisch zum bisherigen Satz', () => {
    expect(socRangeLine([{ socPct: 12.4 }, { socPct: 88.2 }])).toContain('im Tagesverlauf');
  });
});

/* ---------------------------------------------------------------------------
 * Das Phasen-Band (Fahrplan-UX r7, Variante A+C): die dritte Chart-Spur.
 * Reine Ableitung - die Fläche zeichnet nur, was hier entsteht.
 * ------------------------------------------------------------------------- */

type BandSlot = {
  batteryKw: number | null;
  gridKw?: number | null;
  pvKw?: number | null;
  curtailKw?: number | null;
};

describe('bandRole ordnet einen Slot seiner Phase zu', () => {
  it('gibt Abregeln Vorrang vor der Batterie-Richtung (ein Slot drosselt UND ruht)', () => {
    // Batterie steht still, aber der Slot regelt ab - die Drosselung ist die Aussage.
    expect(bandRole({ batteryKw: 0, curtailKw: 12 })).toBe('abregeln');
    // Auch über einer Ladung gewinnt die Drosselung.
    expect(bandRole({ batteryKw: 6, gridKw: 0, curtailKw: 5 })).toBe('abregeln');
  });

  it('folgt sonst chargeKind: solarladen · netzladen · entladen · ruhe', () => {
    expect(bandRole({ batteryKw: 6, gridKw: 0 })).toBe('solarladen');
    expect(bandRole({ batteryKw: 6, gridKw: 5, pvKw: null })).toBe('netzladen');
    expect(bandRole({ batteryKw: -6 })).toBe('entladen');
    expect(bandRole({ batteryKw: 0 })).toBe('ruhe');
    // Genau dieselbe Antwort wie chargeKind, wo nicht abgeregelt wird.
    expect(bandRole({ batteryKw: 6, gridKw: 5, pvKw: null })).toBe(
      chargeKind(6, 5, null, null),
    );
  });

  it('bandRoles bildet je Slot in Plan-Reihenfolge ab', () => {
    const slots: BandSlot[] = [
      { batteryKw: 6, gridKw: 0 },
      { batteryKw: -6 },
      { batteryKw: 0, curtailKw: 8 },
    ];
    expect(bandRoles(slots)).toEqual(['solarladen', 'entladen', 'abregeln']);
  });
});

describe('phaseBandRuns fasst gleiche Phasen zu Läufen zusammen', () => {
  it('liefert zusammenhängende Läufe mit inklusiven Indizes', () => {
    const slots: BandSlot[] = [
      { batteryKw: 6, gridKw: 0 }, // 0 solarladen
      { batteryKw: 6, gridKw: 0 }, // 1 solarladen
      { batteryKw: 0 }, // 2 ruhe
      { batteryKw: 0 }, // 3 ruhe
      { batteryKw: 0 }, // 4 ruhe
      { batteryKw: -6 }, // 5 entladen
    ];
    expect(phaseBandRuns(slots)).toEqual([
      { from: 0, to: 1, role: 'solarladen' },
      { from: 2, to: 4, role: 'ruhe' },
      { from: 5, to: 5, role: 'entladen' },
    ]);
  });

  it('macht aus einem leeren Plan keine Läufe', () => {
    expect(phaseBandRuns([])).toEqual([]);
  });

  it('deckt zusammen den ganzen Plan lückenlos ab', () => {
    const slots: BandSlot[] = [
      { batteryKw: 6, gridKw: 0 },
      { batteryKw: -6 },
      { batteryKw: -6 },
    ];
    const runs = phaseBandRuns(slots);
    expect(runs[0].from).toBe(0);
    expect(runs[runs.length - 1].to).toBe(slots.length - 1);
  });
});

describe('das Band trägt Wort UND Farbe (K10, nie Farbe allein)', () => {
  it('BAND_WORT nennt jede Phase beim Namen', () => {
    expect(BAND_WORT).toEqual({
      solarladen: 'Solar laden',
      netzladen: 'Netz laden',
      entladen: 'Entladen',
      abregeln: 'Abregeln',
      ruhe: 'Ruhe',
    });
  });

  it('bandRoleColor liest die geteilte Chart-Sprache - Rot bleibt Kosten/Warnung', () => {
    const t = chartTheme();
    expect(bandRoleColor('solarladen', t)).toBe(t.charge);
    expect(bandRoleColor('netzladen', t)).toBe(t.gridCharge);
    expect(bandRoleColor('entladen', t)).toBe(t.battDischarge);
    expect(bandRoleColor('abregeln', t)).toBe(t.pv);
    expect(bandRoleColor('ruhe', t)).toBe(t.neutral);
    // Rot (`discharge`) ist Kosten/Warnung vorbehalten - keine Phase trägt es.
    (['solarladen', 'netzladen', 'entladen', 'abregeln', 'ruhe'] as const).forEach((r) =>
      expect(bandRoleColor(r, t)).not.toBe(t.discharge),
    );
  });
});

describe('bandLegende bewirbt nur vorkommende Phasen', () => {
  it('nennt jede vorkommende Phase EINMAL in kanonischer Reihenfolge', () => {
    const slots: BandSlot[] = [
      { batteryKw: -6 }, // entladen
      { batteryKw: 6, gridKw: 0 }, // solarladen
      { batteryKw: 6, gridKw: 0 }, // solarladen (Duplikat)
      { batteryKw: 0 }, // ruhe
    ];
    // Kanonisch: solarladen · netzladen · entladen · abregeln · ruhe -
    // netzladen/abregeln kommen nicht vor und stehen deshalb NICHT drin.
    expect(bandLegende(slots)).toEqual([
      { role: 'solarladen', label: 'Solar laden' },
      { role: 'entladen', label: 'Entladen' },
      { role: 'ruhe', label: 'Ruhe' },
    ]);
  });

  it('ist leer für einen leeren Plan', () => {
    expect(bandLegende([])).toEqual([]);
  });
});

describe('bandWordRuns · das WORT nur, wo das Segment es fasst (Pixel-Gate, K10)', () => {
  const solar = (): BandSlot => ({ batteryKw: 6, gridKw: 0 });
  const ruhe = (): BandSlot => ({ batteryKw: 0 });
  const entladen = (): BandSlot => ({ batteryKw: -6 });
  const bau = (...runs: [() => BandSlot, number][]): BandSlot[] =>
    runs.flatMap(([f, n]) => Array.from({ length: n }, f));

  it('trägt ein Wort bei breiter Fläche, aber keines bei 375 px (die Regression)', () => {
    // Zwei 14-Slot-Solar-Läufe, durch Ruhe getrennt - der gemeldete Kollisionsfall.
    const slots = bau([ruhe, 20], [solar, 14], [ruhe, 14], [solar, 14], [ruhe, 34]);
    // Breit (Spiegel 1440 ohne Ladestand-Achse: 1440−38−20): jeder 14-Slot-Lauf
    // ist ~200 px und fasst „Solar laden" (~81 px).
    expect(bandWordRuns(slots, 1382).filter((r) => r.role === 'solarladen')).toHaveLength(2);
    // Schmal (Spiegel 375: 375−30−20): 14 Slots sind ~47 px < ~81 px → beide fallen weg.
    expect(bandWordRuns(slots, 325).some((r) => r.role === 'solarladen')).toBe(false);
  });

  it('misst je Wort einzeln - kurze „Ruhe" überlebt, wo längeres „Entladen" wegfällt', () => {
    // entladen(5) · solar(1, Trenner) · ruhe(5) · solar(85, füllt auf) = 96 Slots.
    const slots = bau([entladen, 5], [solar, 1], [ruhe, 5], [solar, 85]);
    const runs = bandWordRuns(slots, 768); // 96 Slots → 8 px/Slot
    // 5 Slots = 40 px: ≥ „Ruhe" (32 px), aber < „Entladen" (60 px).
    expect(runs.some((r) => r.role === 'ruhe')).toBe(true);
    expect(runs.some((r) => r.role === 'entladen')).toBe(false);
  });

  it('trägt an einer unvermessenen Fläche (Breite ≤ 0) gar kein Wort', () => {
    const slots = bau([solar, 40]);
    expect(bandWordRuns(slots, 0)).toEqual([]);
    expect(bandWordRuns(slots, -50)).toEqual([]);
  });

  it('macht aus einem leeren Plan keine Läufe', () => {
    expect(bandWordRuns([], 1382)).toEqual([]);
  });
});

describe('bandLabelWidthPx schätzt die Wortbreite je Rolle', () => {
  it('ein längeres Wort ist breiter (Zeichenzahl × Zeichenbreite + Luft)', () => {
    expect(bandLabelWidthPx('solarladen')).toBeGreaterThan(bandLabelWidthPx('ruhe'));
    expect(bandLabelWidthPx('solarladen')).toBe('Solar laden'.length * 7 + 4);
  });
});
