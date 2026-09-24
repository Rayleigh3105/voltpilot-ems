'use strict';

// vp-wr-deye-tou-schreibbudget: the Deye ToU path's day budget of plan changes
// (concept §6.6, F12; profile deye_tou). The pure rule; the executor and plan
// node that embed it are driven over a whole day in deye-control.e2e.test.js.

const test = require('node:test');
const assert = require('node:assert');
const B = require('./deye-tou-budget');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('the budget is the profile statement inside (0, 20], else the Vorgabe 20', () => {
  assert.strictEqual(B.DEYE_TOU_PLAN_CHANGES_PER_DAY, 20);
  assert.strictEqual(B.touBudgetLimit(undefined), 20);
  assert.strictEqual(B.touBudgetLimit(6), 6, 'a profile may tighten it');
  assert.strictEqual(B.touBudgetLimit(40), 20, 'never loosen it');
  for (const bad of [0, -3, 2.5, NaN, '12', null]) assert.strictEqual(B.touBudgetLimit(bad), 20, String(bad));
});

test('the record belongs to the local day; another day starts over, a corrupt count is spent', () => {
  const noon = at(2026, 9, 24, 12);
  assert.deepStrictEqual(B.touBudgetToday(undefined, noon), { day: '2026-09-24', changes: 0, held: false });
  const rec = { day: '2026-09-24', changes: 7, held: true };
  assert.deepStrictEqual(B.touBudgetToday(rec, at(2026, 9, 24, 23, 59)), rec);
  assert.deepStrictEqual(B.touBudgetToday(rec, at(2026, 9, 25, 0, 0)), { day: '2026-09-25', changes: 0, held: false });
  assert.strictEqual(B.touBudgetToday({ day: '2026-09-24', changes: 'x' }, noon).changes, 20,
    'fail-closed: EEPROM wear is not undone by a corrupt file');
});

test('a plan change needs room for itself AND the way back', () => {
  const b = (changes, held = false) => ({ day: '2026-09-24', changes, held });
  assert.strictEqual(B.touBudgetAdmits(b(0), 20), true);
  assert.strictEqual(B.touBudgetAdmits(b(18), 20), true, 'the 19th change leaves the 20th for the release');
  assert.strictEqual(B.touBudgetAdmits(b(19), 20), false);
  assert.strictEqual(B.touBudgetAdmits(b(3, true), 20), false, 'held stays held for the day');
  assert.strictEqual(B.touBudgetAdmits(b(4), 6), true);
  assert.strictEqual(B.touBudgetAdmits(b(5), 6), false);
  const why = B.touBudgetReason(b(20), 20);
  assert.match(why, /Tagesbudget der Zeitfenster-Steuerung erreicht \(20 von 20 Planwechseln/);
  assert.match(why, /eigenen Einstellung/);
  assert.deepStrictEqual(B.touBudgetReport(b(20, true), 20), { day: '2026-09-24', changes: 20, limit: 20, held: true });
});

// The executor + plan node protocol as a model over one day of 96 quarter hours,
// every one of them a plan change (the worst case the 900-s dwell still allows).
test('a whole day: 19 plan changes, the release, and the 21st change is refused', () => {
  let rec;
  let writes = 0;
  let released = false;
  const log = [];
  for (let q = 0; q < 96; q++) {
    const now = at(2026, 9, 24, 0, 0) + q * 15 * 60 * 1000;
    let b = B.touBudgetToday(rec, now);
    if (b.held) {
      // plan node: hand back once, then nothing
      if (!released) { released = true; rec = B.touBudgetCounted(b); writes++; log.push('release'); }
      else log.push('blocked');
      continue;
    }
    if (B.touBudgetAdmits(b, 20)) { rec = B.touBudgetCounted(b); writes++; log.push('change'); continue; }
    rec = B.touBudgetHeld(b); log.push('held');
  }
  assert.strictEqual(log.filter((x) => x === 'change').length, 19);
  assert.strictEqual(log[19], 'held', 'the 20th wanted change is held - its room is the way back');
  assert.strictEqual(log[20], 'release');
  assert.strictEqual(writes, 20, 'never more than 20 EEPROM plan writes in the day');
  assert.ok(log.slice(21).every((x) => x === 'blocked'), 'the 21st and every later change is refused');
  assert.deepStrictEqual(B.touBudgetToday(rec, at(2026, 9, 24, 23, 59)), { day: '2026-09-24', changes: 20, held: true });
  assert.strictEqual(B.touBudgetAdmits(B.touBudgetToday(rec, at(2026, 9, 25, 0, 0)), 20), true, 'the next day starts over');
});
