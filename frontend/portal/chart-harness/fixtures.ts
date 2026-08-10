import type {
  History,
  HistoryBucket,
  HistoryPlanPoint,
  HistoryTotals,
  ProtocolEvent,
  SchedulePlan,
  ScheduleSlot,
  TelemetryPoint,
} from '../src/api';

/**
 * THROWAWAY fixtures for the chart harness.
 *
 * ONE physical day model feeds all three charts, so the numbers agree across
 * them (a Fahrplan slot, its Historie bucket and the live telemetry of the same
 * minute tell the same story). Everything is deterministic - the "noise" is a
 * hash, not `Math.random()`, so a re-render never reshuffles the curves.
 */

// ---- the plant ------------------------------------------------------------

const PV_PEAK_KW = 9; // ~9 kWp, bell peaking at solar noon
const CAP_KWH = 20; // household battery
const MAX_CHARGE_KW = 6;
const MAX_DISCHARGE_KW = 5;
const SOC_MIN = 20;
const SOC_MAX = 95;

/** Deterministic ±amp jitter (stable across renders, unlike Math.random). */
function noise(seed: number, amp: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amp;
}

/** Normalised gaussian: 1 at the centre. */
function bell(h: number, mu: number, sd: number): number {
  return Math.exp(-0.5 * ((h - mu) / sd) ** 2);
}

/** PV bell: zero at night, ~9 kW at noon, mild cloud jitter. */
function pvAt(h: number): number {
  if (h <= 6 || h >= 18) return 0;
  const s = Math.sin((Math.PI * (h - 6)) / 12);
  const clear = PV_PEAK_KW * Math.pow(s, 1.4);
  return Math.max(0, clear * (1 + noise(h * 7.3, 0.07)));
}

/** Household double hump: 0.4 kW base, ~2.3 kW morning, ~3 kW evening. */
function loadAt(h: number): number {
  const base =
    0.45 + 1.9 * bell(h, 7.5, 1.1) + 2.4 * bell(h, 19, 1.6) + 0.35 * bell(h, 12.5, 1.2);
  return Math.max(0.25, base + noise(h * 3.1 + 11, 0.09));
}

/** Duck curve in EUR/MWh: night trough, morning + evening peaks, midday NEGATIVE. */
function priceAt(h: number): number {
  const p =
    60 +
    55 * bell(h, 8, 2) +
    90 * bell(h, 19, 2.2) -
    130 * bell(h, 12.5, 1.0) -
    30 * bell(h, 3, 1.5);
  return round(p + noise(h * 5.7 + 3, 3), 1);
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---- one simulated day, at 1-minute resolution ----------------------------

export interface DaySample {
  /** Minutes since local midnight. */
  minute: number;
  pvKw: number;
  loadKw: number;
  /** + = charging, - = discharging (the portal's battery convention). */
  batteryKw: number;
  /** + = Bezug (import), - = Einspeisung (export). */
  gridKw: number;
  socPct: number;
}

/** Local midnight of the day we render. */
export const DAY_START = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
})();

export const NOW = new Date();

function simulateDay(): DaySample[] {
  const out: DaySample[] = [];
  let soc = SOC_MIN;
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const h = minute / 60;
    const pv = pvAt(h);
    const load = loadAt(h);
    const surplus = pv - load;

    // Headroom / reserve expressed as the kW that would fill/empty the battery
    // within this one minute - keeps SoC inside [SOC_MIN, SOC_MAX] exactly.
    const headroomKw = ((SOC_MAX - soc) / 100) * CAP_KWH * 60;
    const reserveKw = ((soc - SOC_MIN) / 100) * CAP_KWH * 60;

    let battery = 0;
    if (surplus > 0.05) {
      battery = Math.min(surplus, MAX_CHARGE_KW, headroomKw);
    } else if (surplus < -0.05 && h >= 15) {
      // Evening self-consumption: cover the deficit from the battery.
      battery = -Math.min(-surplus, MAX_DISCHARGE_KW, reserveKw);
    }

    const grid = load - pv + battery;
    soc = Math.min(SOC_MAX, Math.max(SOC_MIN, soc + ((battery / 60) / CAP_KWH) * 100));

    out.push({
      minute,
      pvKw: round(pv),
      loadKw: round(load),
      batteryKw: round(battery),
      gridKw: round(grid),
      socPct: round(soc, 1),
    });
  }
  return out;
}

export const DAY: DaySample[] = simulateDay();

function at(minute: number): DaySample {
  return DAY[Math.min(DAY.length - 1, Math.max(0, minute))];
}

function iso(minute: number): string {
  return new Date(DAY_START.getTime() + minute * 60_000).toISOString();
}

// ---- 1 · telemetry (the LAST 3 hours, ending at "now") --------------------

/**
 * The live window the TelemetryChart draws. Its x-axis is a true time axis
 * capped at `Date.now()`, so the series has to run right up to now - otherwise
 * the chart renders a gap at its right edge.
 *
 * 1-minute cadence mirrors what the API returns for a >3 h window (the backend
 * downsamples to 1-minute `time_bucket` averages).
 */
export const telemetryPoints: TelemetryPoint[] = (() => {
  const nowMinute = Math.floor((NOW.getTime() - DAY_START.getTime()) / 60_000);
  const from = Math.max(0, nowMinute - 180);
  const points: TelemetryPoint[] = [];
  for (let m = from; m <= nowMinute; m += 1) {
    const s = at(m);
    points.push({
      ts: iso(m),
      powerKw: s.gridKw,
      socPct: s.socPct,
      pvPowerKw: s.pvKw,
      loadKw: s.loadKw,
      gridLimitKw: null,
    });
  }
  return points;
})();

// ---- 2 · history (96 quarter-hour buckets of today) -----------------------

const QUARTERS = 96;

function bucketOf(index: number): HistoryBucket {
  const from = index * 15;
  const minutes = DAY.slice(from, from + 15);
  const avg = (pick: (s: DaySample) => number) =>
    minutes.reduce((sum, s) => sum + pick(s), 0) / minutes.length;

  const pv = avg((s) => s.pvKw);
  const load = avg((s) => s.loadKw);
  const gridIn = avg((s) => Math.max(s.gridKw, 0));
  const gridOut = avg((s) => Math.max(-s.gridKw, 0));
  const charge = avg((s) => Math.max(s.batteryKw, 0));
  const discharge = avg((s) => Math.max(-s.batteryKw, 0));
  const socs = minutes.map((s) => s.socPct);
  const price = priceAt((from + 7.5) / 60);
  const importKwh = round(gridIn * 0.25, 3);

  return {
    start: iso(from),
    pvKwh: round(pv * 0.25, 3),
    loadKwh: round(load * 0.25, 3),
    gridImportKwh: importKwh,
    gridExportKwh: round(gridOut * 0.25, 3),
    batteryChargeKwh: round(charge * 0.25, 3),
    batteryDischargeKwh: round(discharge * 0.25, 3),
    socMinPct: round(Math.min(...socs), 1),
    socMaxPct: round(Math.max(...socs), 1),
    socLastPct: round(socs[socs.length - 1], 1),
    priceEurMwh: price,
    // Valued at the composed supply price (spot + ~20 ct grid fees/levies).
    costEur: round(importKwh * (price / 10 + 20)) / 100,
  };
}

const buckets: HistoryBucket[] = Array.from({ length: QUARTERS }, (_, i) => bucketOf(i));

function sum(pick: (b: HistoryBucket) => number | null): number {
  return round(
    buckets.reduce((acc, b) => acc + (pick(b) ?? 0), 0),
    2,
  );
}

const consumptionKwh = sum((b) => b.loadKwh);
const pvGenerationKwh = sum((b) => b.pvKwh);
const gridImportKwh = sum((b) => b.gridImportKwh);
const gridExportKwh = sum((b) => b.gridExportKwh);

const historyTotals: HistoryTotals = {
  consumptionKwh,
  pvGenerationKwh,
  gridImportKwh,
  gridExportKwh,
  gridCostEur: sum((b) => b.costEur),
  tarifArt: 'fest',
  tarifPriced: true,
  batterySavingsPlannedEur: 3.42,
  autarkiePct: round((1 - gridImportKwh / consumptionKwh) * 100, 1),
  eigenverbrauchPct: round(((pvGenerationKwh - gridExportKwh) / pvGenerationKwh) * 100, 1),
};

const protocol: ProtocolEvent[] = [
  {
    type: 'batterie-laden',
    start: iso(9 * 60 + 30),
    end: iso(13 * 60),
    text: 'Der Speicher hat 3,5 Stunden lang Solarstrom geladen.',
    energyKwh: 14.8,
    avgPriceEurMwh: -12.4,
    avoidedCostEur: 0.18,
    peakKw: null,
  },
  {
    type: 'pv-spitze',
    start: iso(12 * 60 + 15),
    end: iso(12 * 60 + 30),
    text: 'Höchste Solarleistung des Tages.',
    energyKwh: null,
    avgPriceEurMwh: null,
    avoidedCostEur: null,
    peakKw: 8.9,
  },
  {
    type: 'preis-tief',
    start: iso(12 * 60 + 15),
    end: iso(12 * 60 + 30),
    text: 'Günstigste Viertelstunde des Tages.',
    energyKwh: null,
    avgPriceEurMwh: -57.2,
    avoidedCostEur: null,
    peakKw: null,
  },
  {
    type: 'batterie-entladen',
    start: iso(17 * 60 + 45),
    end: iso(22 * 60 + 15),
    text: 'Der Speicher hat abends den Hausverbrauch gedeckt.',
    energyKwh: 11.2,
    avgPriceEurMwh: 148.6,
    avoidedCostEur: 3.91,
    peakKw: null,
  },
  {
    type: 'preis-hoch',
    start: iso(19 * 60),
    end: iso(19 * 60 + 15),
    text: 'Teuerste Viertelstunde des Tages.',
    energyKwh: null,
    avgPriceEurMwh: 151.3,
    avoidedCostEur: null,
    peakKw: null,
  },
];

const planOverlay: HistoryPlanPoint[] = Array.from({ length: QUARTERS }, (_, i) => {
  const s = at(i * 15 + 7);
  return {
    time: iso(i * 15),
    batteryKw: s.batteryKw,
    socPct: s.socPct,
  };
});

export const history: History = {
  range: 'day',
  from: iso(0),
  to: iso(24 * 60),
  bucketMinutes: 15,
  buckets,
  totals: historyTotals,
  protocol,
  plan: planOverlay,
  coverage: {
    firstDataAt: new Date(DAY_START.getTime() - 86_400_000 * 214).toISOString(),
    lastDataAt: iso(24 * 60 - 15),
    expectedFrom: iso(0),
    expectedTo: iso(24 * 60),
    expectedBuckets: QUARTERS,
    measuredBuckets: QUARTERS,
    gaps: 0,
    resolutionMinutes: 15,
  },
  events: [
    {
      type: 'negativpreis',
      start: iso(11 * 60 + 30),
      end: iso(13 * 60 + 30),
      text: 'Der Börsenpreis lag unter null.',
    },
    {
      type: 'abregelung',
      start: iso(11 * 60 + 45),
      end: iso(13 * 60 + 15),
      text: 'Die Einspeisung war eingeplant zu drosseln.',
    },
  ],
};

// ---- 3 · schedule plan (96 slots from today 00:00) ------------------------

const PLAN_CAP_KWH = 40; // the plan drives a bigger battery than the live model

/** Planned battery power: cheap-night charge, PV charge midday, evening discharge. */
function planBatteryKw(h: number): number {
  if (h >= 2 && h < 4.25) return round(4 * bell(h, 3.1, 0.8));
  if (h >= 9.5 && h < 15.5) return round(8 * bell(h, 12.5, 2.6));
  if (h >= 17 && h < 22.5) return round(-7 * bell(h, 19.5, 2.0));
  return 0;
}

function slotRoleFor(h: number, battery: number, curtail: number): string {
  if (curtail > 0.05) return 'abregeln';
  if (battery > 0.05) return h < 6 ? 'guenstig_laden' : 'pv_speichern';
  if (battery < -0.05) return 'eigenverbrauch';
  return 'warten';
}

const slots: ScheduleSlot[] = (() => {
  const nowMinute = Math.floor((NOW.getTime() - DAY_START.getTime()) / 60_000);
  const out: ScheduleSlot[] = [];
  let soc = 21;

  for (let i = 0; i < QUARTERS; i += 1) {
    const from = i * 15;
    const h = (from + 7.5) / 60;
    const s = at(from + 7);
    const price = priceAt(h);

    const battery = planBatteryKw(h);
    // Negative prices: hold PV back instead of paying to export.
    const curtail = price < 0 ? round(Math.min(s.pvKw, 4)) : 0;
    const pvUsable = Math.max(0, s.pvKw - curtail);
    const grid = round(s.loadKw - pvUsable + battery);

    const socBefore = soc;
    soc = Math.min(95, Math.max(10, soc + ((battery * 0.25) / PLAN_CAP_KWH) * 100));

    const importCt = round(price / 10 + 20, 2);
    const exportCt = round(price / 10, 2);
    const baselineGrid = round(s.loadKw - s.pvKw);
    const cash = (g: number) =>
      round(
        (Math.max(g, 0) * 0.25 * importCt - Math.max(-g, 0) * 0.25 * exportCt) / 100,
        4,
      );

    const flags: string[] = [];
    if (curtail > 0.05) flags.push('curtailing');
    if (soc >= 94.9 && battery > 0) flags.push('soc_max');
    if (battery >= 7.8) flags.push('charge_cap');

    const past = from < nowMinute;

    out.push({
      start: iso(from),
      batteryKw: battery,
      gridKw: grid,
      socPct: round(soc, 1),
      priceEurMwh: price,
      costEur: cash(grid),
      baselineCostEur: cash(baselineGrid),
      curtailKw: curtail > 0.05 ? curtail : null,
      pvKw: s.pvKw,
      loadKw: s.loadKw,
      // Measured values only exist for slots that already happened.
      measuredPvKw: past ? round(s.pvKw * (1 + noise(from + 1, 0.08))) : null,
      measuredLoadKw: past ? round(s.loadKw * (1 + noise(from + 2, 0.11))) : null,
      slotRole: slotRoleFor(h, battery, curtail),
      slotFlags: flags.length > 0 ? flags : null,
      storedValueCtKwh: round(22 + 4 * bell(h, 19, 4), 1),
      gridValueCtKwh: exportCt,
      peakPressureEurKw: null,
      importPriceCtKwh: importCt,
      exportValueCtKwh: exportCt,
      importPriceSource: 'sammelaufschlag',
      coverLoadFromBattery: battery < -0.05 ? true : null,
      chargeFromSurplusOnly: null,
    });

    void socBefore;
  }
  return out;
})();

const savingsEur = round(
  slots.reduce((acc, s) => acc + ((s.baselineCostEur ?? 0) - (s.costEur ?? 0)), 0),
  2,
);

export const schedulePlan: SchedulePlan = {
  planId: 'a3f1c0de-0000-4000-8000-0000000000ab',
  deviceId: '00000000-0000-0000-0000-000000000003',
  generatedAt: NOW.toISOString(),
  slotMinutes: 15,
  savingsEur,
  bankedValueEur: 0.84,
  socStartPct: 21,
  socEndPct: slots[slots.length - 1].socPct,
  peakTargetKw: null,
  fallback14a: false,
  slots,
};
