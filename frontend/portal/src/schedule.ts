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
