/**
 * SoC plausibility (drop-don't-fabricate), portal side - the single source for
 * every surface that renders a live/latest battery SoC. The edge gates garbage
 * reads at the source (deye-decode.js socPlausible, edge-app/core
 * guards.SocPlausible), but the portal must not render a false spike from any
 * bad row already persisted in the DB (or published by an older edge build):
 * an out-of-range or non-finite SoC maps to null - the chart shows a GAP
 * (connectNulls stays false) and the Übersicht tile falls back to the newest
 * plausible reading. Inclusive 0 here, unlike the edge's exclusive-0 gate: a
 * persisted 0 row cannot be told apart from a genuine BMS floor after the
 * fact, and rendering 0 is honest while fabricating a spike is not.
 */
export function sanitizeSoc(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}
