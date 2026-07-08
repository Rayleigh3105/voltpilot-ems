/**
 * Pure Fahrplan-slot logic (unit-tested; ScheduleChart only renders it).
 *
 * The grid-charging switch (site.netzladen_erlaubt) makes it matter WHERE a
 * charging slot's energy comes from: a slot that charges while the site is
 * net-IMPORTING is a grid-charge slot ("Laden aus dem Netz") and gets its own
 * cyan color in the chart - on an EEG site that color can never appear, so the
 * chart itself is the visible proof that only solar is stored. The kind is
 * DERIVED from the persisted plan (battery_kw > 0 while grid_kw > 0), no
 * schema addition needed: charging beyond the site's own surplus is the only
 * way a charging slot can net-import.
 */

/** Matches the chart's "hält" deadband (0.05 kW) so tiny solver noise stays idle. */
export const SLOT_DEADBAND_KW = 0.05;

export type ChargeKind = 'netzladen' | 'solarladen' | 'entladen' | 'ruhe';

/** What one plan slot does with the battery, energy-source-honest. */
export function chargeKind(batteryKw: number | null, gridKw: number | null): ChargeKind {
  // Coerce defensively (API decimals arrive as JSON numbers, but the chart
  // code wraps every value in Number() - mirror that convention here).
  const batt = batteryKw == null ? null : Number(batteryKw);
  const grid = gridKw == null ? null : Number(gridKw);
  if (batt == null || Math.abs(batt) <= SLOT_DEADBAND_KW) return 'ruhe';
  if (batt < 0) return 'entladen';
  // Charging: net import means (part of) the charge comes from the grid.
  return grid != null && grid > SLOT_DEADBAND_KW ? 'netzladen' : 'solarladen';
}

/** Whether any slot of the plan charges from the grid (drives the legend entry). */
export function hasGridCharge(
  slots: { batteryKw: number | null; gridKw: number | null }[],
): boolean {
  return slots.some((s) => chargeKind(s.batteryKw, s.gridKw) === 'netzladen');
}

// ---- Fahrplan mini preview (the Anlagen-Seite's "Fahrplan · heute" card) -------

/** The slot fields the mini-preview derivations need. */
export interface PlanSlotLike {
  start: string;
  batteryKw: number | null;
  gridKw: number | null;
}

/** The plan's slots that fall on the local calendar day of `now`. */
export function todaySlots<T extends { start: string }>(slots: T[], now: Date): T[] {
  const day = now.toDateString();
  return slots.filter((s) => new Date(s.start).toDateString() === day);
}

/**
 * Today's planned saving vs. the no-battery baseline, summed over the slots
 * with cost data. Null when no slot of today carries costs - "no plan" must
 * never render as a fake ±0,00 €.
 */
export function savingsTodayEur(
  slots: { start: string; costEur: number | null; baselineCostEur: number | null }[],
  now: Date,
): number | null {
  const priced = todaySlots(slots, now).filter(
    (s) => s.costEur != null && s.baselineCostEur != null,
  );
  if (priced.length === 0) return null;
  return priced.reduce((sum, s) => sum + ((s.baselineCostEur ?? 0) - (s.costEur ?? 0)), 0);
}

/** Below this the curtailment is solver noise, not a real feed-in cap. */
export const CURTAIL_DEADBAND_KW = 0.01;

/**
 * Today's PV curtailment result: how much energy the optimizer held back and
 * the negative-price loss that avoided (report N2, "heute X kWh abgeregelt,
 * Y € Verlust vermieden"). At negative day-ahead prices exporting COSTS money,
 * so each curtailed kWh in a negative-price slot avoids paying |price| for it.
 * Null when today has no curtailing slot - the line then stays hidden, never a
 * fake "0 kWh abgeregelt".
 */
export interface CurtailmentToday {
  /** Total curtailed energy today (kWh). */
  curtailedKwh: number;
  /** Euro loss avoided by not exporting in negative-price slots (>= 0). */
  avoidedLossEur: number;
}

export function curtailmentToday(
  slots: { start: string; curtailKw: number | null; priceEurMwh: number | null }[],
  now: Date,
  slotMinutes = 15,
): CurtailmentToday | null {
  const hours = slotMinutes / 60;
  let curtailedKwh = 0;
  let avoidedLossEur = 0;
  for (const s of todaySlots(slots, now)) {
    const kw = s.curtailKw == null ? 0 : Number(s.curtailKw);
    if (!(kw > CURTAIL_DEADBAND_KW)) continue;
    const kwh = kw * hours;
    curtailedKwh += kwh;
    const price = s.priceEurMwh == null ? 0 : Number(s.priceEurMwh);
    if (price < 0) {
      // EUR/MWh -> EUR/kWh: /1000; negative price => positive avoided loss.
      avoidedLossEur += kwh * (-price / 1000);
    }
  }
  if (curtailedKwh <= CURTAIL_DEADBAND_KW * hours) return null;
  return { curtailedKwh, avoidedLossEur };
}

/** One bar of the hourly mini chart; kw null = no plan data for that hour. */
export interface PlanHourBar {
  hour: number;
  kind: ChargeKind;
  /** Mean |battery power| of the hour's dominant direction, for bar height. */
  kw: number | null;
}

/**
 * Today's plan condensed to 24 hourly bars (the phone-calm resolution of the
 * mini preview): per hour the dominant battery direction by energy and its
 * mean power. A charging hour is 'netzladen' when most of its charge energy
 * net-imports (the chart's cyan proof carries over to the preview).
 */
export function planHourBars(slots: PlanSlotLike[], now: Date): PlanHourBar[] {
  const byHour = new Map<number, PlanSlotLike[]>();
  for (const s of todaySlots(slots, now)) {
    const h = new Date(s.start).getHours();
    const list = byHour.get(h);
    if (list) list.push(s);
    else byHour.set(h, [s]);
  }
  return Array.from({ length: 24 }, (_, hour) => {
    const list = byHour.get(hour);
    if (!list || list.length === 0) return { hour, kind: 'ruhe' as ChargeKind, kw: null };
    let charge = 0;
    let gridCharge = 0;
    let discharge = 0;
    for (const s of list) {
      const kind = chargeKind(s.batteryKw, s.gridKw);
      const kw = Math.abs(Number(s.batteryKw ?? 0));
      if (kind === 'entladen') discharge += kw;
      else if (kind === 'solarladen') charge += kw;
      else if (kind === 'netzladen') {
        charge += kw;
        gridCharge += kw;
      }
    }
    if (charge <= SLOT_DEADBAND_KW && discharge <= SLOT_DEADBAND_KW) {
      return { hour, kind: 'ruhe' as ChargeKind, kw: 0 };
    }
    if (discharge > charge) {
      return { hour, kind: 'entladen' as ChargeKind, kw: discharge / list.length };
    }
    return {
      hour,
      kind: (gridCharge > charge / 2 ? 'netzladen' : 'solarladen') as ChargeKind,
      kw: charge / list.length,
    };
  });
}

/** Plant kind steering the discharge verb (mirrors api.ts PlantKind). */
export type PlanWordingKind = 'direktvermarktung' | 'eigenverbrauch';

interface PlanRun {
  dir: 'laden' | 'entladen';
  from: Date;
  to: Date;
  energy: number;
  gridEnergy: number;
}

/**
 * ONE plain-German sentence describing today's plan (the Anlagen-Seite's
 * Fahrplan preview, captain mockup: "Mittags laden, abends verkaufen
 * (17–20 Uhr)."): the dominant charge and discharge windows by energy, worded
 * by daypart. Direktvermarktung discharges to "verkaufen", Eigenverbrauch to
 * "nutzen"; a mostly grid-fed charge window says "günstig laden". Null when
 * today has no plan slots; an all-idle day says the battery holds its charge.
 */
export function planSentence(
  slots: PlanSlotLike[],
  kind: PlanWordingKind,
  now: Date,
  slotMinutes = 15,
): string | null {
  const today = [...todaySlots(slots, now)].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  if (today.length === 0) return null;

  const runs = planRuns(today, slotMinutes);
  const charge = dominantRun(runs, 'laden');
  const discharge = dominantRun(runs, 'entladen');
  const verb = kind === 'direktvermarktung' ? 'verkaufen' : 'nutzen';

  if (charge && discharge) {
    const chargeWord = charge.gridEnergy > charge.energy / 2 ? 'günstig laden' : 'laden';
    return `${cap(daypart(midHour(charge)))} ${chargeWord}, ${daypart(midHour(discharge))} ${verb} (${hourRange(discharge)}).`;
  }
  if (charge) {
    const chargeWord = charge.gridEnergy > charge.energy / 2 ? 'günstig laden' : 'laden';
    return `${cap(daypart(midHour(charge)))} ${chargeWord} (${hourRange(charge)}).`;
  }
  if (discharge) {
    return `${cap(daypart(midHour(discharge)))} ${verb} (${hourRange(discharge)}).`;
  }
  return 'Der Speicher hält heute seine Ladung.';
}

/** Contiguous same-direction windows; gaps of up to 30 min idle are bridged. */
function planRuns(sorted: PlanSlotLike[], slotMinutes: number): PlanRun[] {
  const maxGapMs = (2 * slotMinutes + 1) * 60_000;
  const runs: PlanRun[] = [];
  let current: PlanRun | null = null;
  for (const s of sorted) {
    const k = chargeKind(s.batteryKw, s.gridKw);
    if (k === 'ruhe') continue;
    const dir = k === 'entladen' ? 'entladen' : 'laden';
    const start = new Date(s.start);
    const end = new Date(start.getTime() + slotMinutes * 60_000);
    const kw = Math.abs(Number(s.batteryKw ?? 0));
    const energy = (kw * slotMinutes) / 60;
    if (current && current.dir === dir && start.getTime() - current.to.getTime() <= maxGapMs) {
      current.to = end;
      current.energy += energy;
      if (k === 'netzladen') current.gridEnergy += energy;
    } else {
      current = {
        dir,
        from: start,
        to: end,
        energy,
        gridEnergy: k === 'netzladen' ? energy : 0,
      };
      runs.push(current);
    }
  }
  return runs;
}

function dominantRun(runs: PlanRun[], dir: PlanRun['dir']): PlanRun | null {
  return runs
    .filter((r) => r.dir === dir)
    .reduce<PlanRun | null>((best, r) => (best == null || r.energy > best.energy ? r : best), null);
}

function midHour(run: PlanRun): number {
  const mid = new Date((run.from.getTime() + run.to.getTime()) / 2);
  return mid.getHours() + mid.getMinutes() / 60;
}

/** German daypart of a local decimal hour. */
export function daypart(hour: number): string {
  if (hour < 5 || hour >= 23) return 'nachts';
  if (hour < 11) return 'morgens';
  if (hour < 15) return 'mittags';
  if (hour < 18) return 'nachmittags';
  return 'abends';
}

/** "17–20 Uhr": start hour floored, end hour ceiled to the full hour. */
function hourRange(run: PlanRun): string {
  const startH = run.from.getHours();
  const endH = run.to.getMinutes() > 0 ? run.to.getHours() + 1 : run.to.getHours();
  return `${startH}–${endH === 0 ? 24 : endH} Uhr`;
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
