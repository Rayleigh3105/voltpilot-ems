'use strict';

/**
 * readback-verify.test.js - the hold-check SEMANTICS (offline, no hardware).
 *
 * The live symptom this pins (Pilsting, 2026-07-30): the inverter demonstrably
 * followed the setpoint while the card reported "uebernimmt den Sollwert nicht"
 * every ~10 s, naming remote_watchdog / power_control_mode / battery_strategy /
 * remote_mode. Both halves are covered here:
 *   - a dynamic register (the watchdog) counting down is HELD, not a mismatch;
 *   - a Solarman zero-answer is UNCONFIRMED (no verdict), not a mismatch;
 * and the honest counter-case stays intact: a real refused write still yields a
 * mismatch cycle.
 */

const test = require('node:test');
const assert = require('node:assert');

const V = require('./readback-verify');

// The remote-mode readback set of one real tick (rated 30 kW, idle setpoint):
// 1101 watchdog 60 s, 1104 battery-side 1, 1105 power strategy 2, 1109 setpoint,
// 1100 enable 1. `actual` is filled per test.
function remoteEntries(actuals, setpointRaw = 0) {
  const plan = [
    { role: 'remote_watchdog', addr: 0x044d, expect: 60, tolerance: 0 },
    { role: 'power_control_mode', addr: 0x0450, expect: 1, tolerance: 0 },
    { role: 'battery_strategy', addr: 0x0451, expect: 2, tolerance: 0 },
    { role: 'battery_power', addr: 0x0455, expect: setpointRaw & 0xffff, tolerance: 1 },
    { role: 'remote_mode', addr: 0x044c, expect: 1, tolerance: 0 },
  ];
  return plan.map((p) => ({ ...p, actual: actuals[p.role] }));
}

test('ruleForRole gives the watchdog dynamic semantics and everything else exact', () => {
  assert.strictEqual(V.ruleForRole('remote_watchdog'), 'countdown');
  assert.strictEqual(V.ruleForRole('remote_mode'), 'exact');
  assert.strictEqual(V.ruleForRole('battery_power'), 'exact');
  assert.strictEqual(V.ruleForRole('power_control_mode'), 'exact');
  assert.strictEqual(V.ruleForRole('anything_new'), 'exact');
});

// --- the dynamic (watchdog) register -----------------------------------------

test('a watchdog counting the armed value down is HELD, not a mismatch', () => {
  for (const actual of [60, 59, 42, 1]) {
    const r = V.verifyRegister({ role: 'remote_watchdog', expect: 60, actual: actual });
    assert.strictEqual(r.verdict, 'held', actual + ' s remaining of 60 s armed is the timer WORKING');
  }
  // and it says so for the technician
  assert.match(V.verifyRegister({ role: 'remote_watchdog', expect: 60, actual: 42 }).note, /laeuft ab \(42 s von 60 s\)/);
});

test('a watchdog that is OFF or EXPIRED or higher than armed is a real mismatch', () => {
  const off = V.verifyRegister({ role: 'remote_watchdog', expect: 60, actual: 0xffff });
  assert.strictEqual(off.verdict, 'mismatch');
  assert.match(off.note, /AUS/);
  const expired = V.verifyRegister({ role: 'remote_watchdog', expect: 60, actual: 0 });
  assert.strictEqual(expired.verdict, 'mismatch');
  assert.match(expired.note, /abgelaufen/);
  const higher = V.verifyRegister({ role: 'remote_watchdog', expect: 60, actual: 300 });
  assert.strictEqual(higher.verdict, 'mismatch', 'a foreign, larger value is not ours');
});

test('the exact rule still honours the per-register tolerance', () => {
  assert.strictEqual(V.verifyRegister({ role: 'battery_power', expect: 100, actual: 101, tolerance: 1 }).verdict, 'held');
  assert.strictEqual(V.verifyRegister({ role: 'battery_power', expect: 100, actual: 102, tolerance: 1 }).verdict, 'mismatch');
  assert.strictEqual(V.verifyRegister({ role: 'remote_mode', expect: 1, actual: 2 }).verdict, 'mismatch',
    'remote_mode keeps EXACT semantics - a different sub-mode is a real deviation, not tolerated silently');
});

test('a register with no value is UNREAD, never a fabricated 0', () => {
  assert.strictEqual(V.verifyRegister({ role: 'remote_mode', expect: 1, actual: null }).verdict, 'unread');
  assert.strictEqual(V.verifyRegister({ role: 'remote_mode', expect: 1 }).verdict, 'unread');
  const withReason = V.verifyRegister({ role: 'remote_mode', expect: 1, actual: undefined, error: 'Modbus-CRC falsch' });
  assert.strictEqual(withReason.verdict, 'unread');
  assert.match(withReason.note, /CRC/);
});

// --- the cycle verdict -------------------------------------------------------

test('THE LIVE SYMPTOM: an all-zero logger answer is UNCONFIRMED, not "not adopted"', () => {
  // Exactly the live shape: the logger frames a CRC-valid all-zero block, and the
  // idle setpoint (0) is the only register whose commanded value "matches" a zero.
  const c = V.verifyCycle(remoteEntries({
    remote_watchdog: 0, power_control_mode: 0, battery_strategy: 0, battery_power: 0, remote_mode: 0,
  }, 0));
  assert.strictEqual(c.cycle, 'unconfirmed');
  assert.strictEqual(c.allMatch, null, 'null = no verdict (the entity/curtail readback convention)');
  assert.deepStrictEqual(c.mismatchRoles, [], 'nothing is claimed to deviate');
  assert.deepStrictEqual(
    c.unreadRoles,
    ['remote_watchdog', 'power_control_mode', 'battery_strategy', 'battery_power', 'remote_mode'],
    'every register is unread - including the one that would have "matched" the zero',
  );
  assert.match(c.reason, /nicht geantwortet/);
  assert.ok(c.registers.every((r) => r.verdict === 'unread'));
});

test('a zero-answer is detected even when the setpoint was NOT zero', () => {
  const c = V.verifyCycle(remoteEntries({
    remote_watchdog: 0, power_control_mode: 0, battery_strategy: 0, battery_power: 0, remote_mode: 0,
  }, 0xffdf /* -33 = 1 kW charge on a 30 kW unit */));
  assert.strictEqual(c.cycle, 'unconfirmed');
  assert.strictEqual(c.allMatch, null);
});

test('a healthy cycle (watchdog counting down included) is HELD', () => {
  const c = V.verifyCycle(remoteEntries({
    remote_watchdog: 57, power_control_mode: 1, battery_strategy: 2, battery_power: 0, remote_mode: 1,
  }, 0));
  assert.strictEqual(c.cycle, 'held');
  assert.strictEqual(c.allMatch, true);
  assert.deepStrictEqual(c.mismatchRoles, []);
  assert.deepStrictEqual(c.unreadRoles, []);
  assert.strictEqual(c.reason, '');
});

test('a REAL refused write still yields a mismatch cycle naming the register', () => {
  // The inverter left remote mode: watchdog off, battery-side reverted, enable 0 -
  // the honest counter-case. Note this is NOT all-zero (1101 = 0xFFFF, 1105 = 2),
  // which is exactly why the zero-answer rule cannot swallow a genuine revert.
  const c = V.verifyCycle(remoteEntries({
    remote_watchdog: 0xffff, power_control_mode: 0, battery_strategy: 2, battery_power: 0, remote_mode: 0,
  }, 0));
  assert.strictEqual(c.cycle, 'mismatch');
  assert.strictEqual(c.allMatch, false);
  assert.deepStrictEqual(c.mismatchRoles, ['remote_watchdog', 'power_control_mode', 'remote_mode']);
  assert.match(c.reason, /haelt den geschriebenen Wert nicht/);
});

test('a real mismatch WINS over unread registers in the same cycle', () => {
  const c = V.verifyCycle(remoteEntries({
    remote_watchdog: 60, power_control_mode: 0, battery_strategy: null, battery_power: null, remote_mode: 1,
  }, 0));
  assert.strictEqual(c.cycle, 'mismatch', 'we SAW the inverter hold a different value - decisive evidence');
  assert.deepStrictEqual(c.mismatchRoles, ['power_control_mode']);
});

test('a partly unread cycle without any deviation is UNCONFIRMED and names what was missing', () => {
  const c = V.verifyCycle(remoteEntries({
    remote_watchdog: 60, power_control_mode: 1, battery_strategy: null, battery_power: 0, remote_mode: 1,
  }, 0));
  assert.strictEqual(c.cycle, 'unconfirmed');
  assert.strictEqual(c.allMatch, null);
  assert.deepStrictEqual(c.unreadRoles, ['battery_strategy']);
  assert.match(c.reason, /battery_strategy/);
});

test('a confirmed RELEASE (everything commanded 0) stays confirmed - the zero rule cannot swallow it', () => {
  const c = V.verifyCycle([{ role: 'remote_mode', addr: 0x044c, expect: 0, actual: 0, tolerance: 0 }]);
  assert.strictEqual(V.isZeroAnswer([{ role: 'remote_mode', expect: 0, actual: 0 }]), false);
  assert.strictEqual(c.cycle, 'held');
  assert.strictEqual(c.allMatch, true);
});

test('an empty readback set is unconfirmed, never a silent success', () => {
  const c = V.verifyCycle([]);
  assert.strictEqual(c.cycle, 'unconfirmed');
  assert.strictEqual(c.allMatch, null);
  assert.ok(c.reason.length > 0);
});

test('the ToU register set keeps working unchanged (exact semantics everywhere)', () => {
  const tou = [
    { role: 'work_mode', expect: 1, actual: 1, tolerance: 0 },
    { role: 'tou_enable', expect: 0xff, actual: 0xff, tolerance: 0 },
    { role: 'max_sell_power', expect: 7182, actual: 7183, tolerance: 1 },
  ];
  assert.strictEqual(V.verifyCycle(tou).cycle, 'held');
  tou[2].actual = 0; // the live max_sell_power fight: a REAL deviation, still named
  const c = V.verifyCycle(tou);
  assert.strictEqual(c.cycle, 'mismatch');
  assert.deepStrictEqual(c.mismatchRoles, ['max_sell_power']);
});
