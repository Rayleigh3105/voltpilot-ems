'use strict';

/**
 * The DAY BUDGET of the Deye Time-of-Use path (vp-wr-deye-tou-schreibbudget;
 * concept vp-wechselrichter-eigenregelung-k1 §6.6, test case F12; control
 * profile `deye_tou` schreibbudget.dauerspeicher_je_tag since K7).
 *
 * The ToU path (a Deye hybrid without the remote block - and the fallback when
 * the capability probe degenerates, live regression 2026-07-28) writes EEPROM
 * registers. Each register's dwell (900 s) alone still allows 96 changes per
 * register and day; the budget of a persistent lever is 20. Until now only the
 * core's native hand-overs counted against it (guards.NativeMode), never the
 * ToU path's own plan changes.
 *
 * THE UNIT is a PLAN CHANGE: one executor tick that writes at least one register
 * of the ToU plan (however many registers it touches). The release that restores
 * the installer's configuration is a plan change too.
 *
 * THE RULE mirrors the core's (a hand-over costs its entry AND its exit): a plan
 * change is admitted only while the day keeps room for itself AND the way back.
 * So the day's last room always belongs to the release - the device ends the day
 * on its OWN configuration (the installer's snapshot, or Time of Use off), never
 * on a box program nobody will change again. Then no further plan change until
 * the day turns; the reason is visible on the readback and the node.
 *
 * ⚠ ONE SOURCE, TWO RUNTIMES: the Deye executor (counts, holds) and the control
 * plan node (hands the device back once, then plans nothing) embed this file
 * VERBATIM (build-flows.js embedModule), so it requires nothing.
 */

// The Vorgabe: guards.NativeWriteBudgetPerDay and the deye_tou profile say 20.
const DEYE_TOU_PLAN_CHANGES_PER_DAY = 20;

/**
 * touBudgetLimit - the budget in force: the core's `persistent_write_budget`
 * (the control profile's statement, edge/setpoint) when it lies inside
 * (0, 20], else the Vorgabe. A profile may tighten it, never loosen it - the
 * same rule as guards.persistentWriteBudget.
 */
function touBudgetLimit(stated) {
  const n = typeof stated === 'number' ? stated : NaN;
  return (Number.isInteger(n) && n > 0 && n <= DEYE_TOU_PLAN_CHANGES_PER_DAY) ? n : DEYE_TOU_PLAN_CHANGES_PER_DAY;
}

const pad2 = (v) => (v < 10 ? '0' : '') + v;

// The box's LOCAL calendar day (like the core's day counter), as YYYY-MM-DD.
function touBudgetDay(nowMs) {
  const d = new Date(nowMs);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * touBudgetToday - the record for the day of `nowMs`. A record of another day
 * starts over; a record of TODAY whose count is not a count is read as spent
 * (fail-closed: EEPROM wear is not undone by a corrupt file).
 *   record: { day, changes, held } as stored in the durable flow context
 */
function touBudgetToday(record, nowMs) {
  const day = touBudgetDay(nowMs);
  if (!record || typeof record !== 'object' || record.day !== day) return { day, changes: 0, held: false };
  const c = record.changes;
  const changes = (typeof c === 'number' && Number.isInteger(c) && c >= 0) ? c : DEYE_TOU_PLAN_CHANGES_PER_DAY;
  return { day, changes, held: record.held === true };
}

// touBudgetAdmits - may one more plan change happen today? Only with room for
// it AND the release after it.
function touBudgetAdmits(budget, limit) {
  return budget.held !== true && budget.changes + 2 <= limit;
}

// touBudgetCounted - the record after a tick that wrote.
function touBudgetCounted(budget) {
  return { day: budget.day, changes: budget.changes + 1, held: budget.held === true };
}

// touBudgetHeld - the record after a plan change was refused: the plan node
// hands the device back once and plans nothing more today.
function touBudgetHeld(budget) {
  return { day: budget.day, changes: budget.changes, held: true };
}

// touBudgetReason - the German sentence for the node, the log and the readback.
function touBudgetReason(budget, limit) {
  return 'Tagesbudget der Zeitfenster-Steuerung erreicht (' + budget.changes + ' von ' + limit
    + ' Planwechseln im Dauerspeicher): bis Mitternacht keine weiteren Planwechsel - '
    + 'der Wechselrichter läuft in seiner eigenen Einstellung';
}

// touBudgetReport - the additive `tou_budget` block on the control readback.
function touBudgetReport(budget, limit) {
  return { day: budget.day, changes: budget.changes, limit, held: budget.held === true };
}

module.exports = {
  DEYE_TOU_PLAN_CHANGES_PER_DAY,
  touBudgetLimit,
  touBudgetDay,
  touBudgetToday,
  touBudgetAdmits,
  touBudgetCounted,
  touBudgetHeld,
  touBudgetReason,
  touBudgetReport,
};
