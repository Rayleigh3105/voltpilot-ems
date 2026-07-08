/**
 * Pure derivation of the "Plan-traf-zu" one-liner for the Anlage page
 * (report N5, captain decision 4): "Der Fahrplan traf gestern zu 93 % zu" -
 * graduated from the `plan_accuracy` evaluation that otherwise lives siloed on
 * Prognosequalität. The full series stays there; only this single, high-trust
 * sentence comes to the Anlage page. No React, no side effects - unit-tested in
 * planAccuracy.test.ts.
 *
 * The evaluation compares, per Berlin day, what the optimizer PLANNED the day
 * would cost (plannedCostEur, ex-ante), what a no-battery baseline would have
 * cost (baselineCostEur) and what actually happened at the meter
 * (realizedCostEur). "Traf zu X %" is how close the realized cost came to the
 * plan; the optional saving is how much cheaper the realized day was than doing
 * nothing.
 */
import type { PlanAccuracyPoint } from './api';

/** Ignore days with too few comparable slots to read as a real verdict. */
const MIN_SLOTS = 8;
/** Below this euro delta the "gespart" clause is noise, not a claim. */
const SAVING_EPS = 0.005;

export interface PlanTrafZu {
  /** ISO Berlin day the verdict is about ("2026-07-07"). */
  day: string;
  /** "gestern" / "heute" / "vorgestern" / "am 5. Juli". */
  whenLabel: string;
  /** How closely the realized cost matched the plan, 0..100 (rounded). */
  accuracyPct: number;
  /** Realized advantage vs. the no-battery baseline (>0), or null. */
  savedVsBaselineEur: number | null;
}

/**
 * The most recent evaluated day's plan-vs-actual verdict, or null when no day
 * has all three costs and enough comparable slots (nothing trustworthy to
 * claim - the line is then omitted, never a fabricated "100 %").
 */
export function planTrafZu(points: PlanAccuracyPoint[], now: Date = new Date()): PlanTrafZu | null {
  const usable = points.filter(
    (p) =>
      p.plannedCostEur != null &&
      p.baselineCostEur != null &&
      p.realizedCostEur != null &&
      p.nSlots >= MIN_SLOTS,
  );
  if (usable.length === 0) return null;

  // Latest evaluated day (ISO days sort lexicographically).
  const point = usable.reduce((best, p) => (p.day > best.day ? p : best), usable[0]);
  const planned = point.plannedCostEur as number;
  const realized = point.realizedCostEur as number;
  const baseline = point.baselineCostEur as number;

  // Accuracy: 1 - |realized - planned| / a robust reference magnitude, so a
  // near-zero plan cost cannot blow the ratio up. Clamped to [0, 100].
  const denom = Math.max(Math.abs(planned), Math.abs(realized), Math.abs(baseline), 0.01);
  const accuracy = 1 - Math.abs(realized - planned) / denom;
  const accuracyPct = Math.round(Math.min(1, Math.max(0, accuracy)) * 100);

  // Advantage vs. the unregulated/no-battery day (both are signed COSTS, so
  // baseline - realized > 0 means the plan came out cheaper).
  const saved = baseline - realized;
  const savedVsBaselineEur = saved > SAVING_EPS ? saved : null;

  return { day: point.day, whenLabel: whenLabel(point.day, now), accuracyPct, savedVsBaselineEur };
}

/** The date of a moment as its Europe/Berlin ISO day. */
function berlinDay(at: Date): string {
  return at.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

/** "gestern" / "heute" / "vorgestern", else the German date ("am 5. Juli"). */
export function whenLabel(isoDay: string, now: Date): string {
  const today = berlinDay(now);
  const yesterday = berlinDay(new Date(now.getTime() - 24 * 3600_000));
  const dayBefore = berlinDay(new Date(now.getTime() - 2 * 24 * 3600_000));
  if (isoDay === today) return 'heute';
  if (isoDay === yesterday) return 'gestern';
  if (isoDay === dayBefore) return 'vorgestern';
  return `am ${new Date(`${isoDay}T12:00:00`).toLocaleDateString('de-DE', {
    day: 'numeric',
    month: 'long',
  })}`;
}
