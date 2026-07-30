'use strict';

/**
 * readback-verify.test.js - the hold-check SEMANTICS (offline, no hardware).
 *
 * The live symptom this pins (Pilsting, 2026-07-30): the inverter demonstrably
 * followed the setpoint while the card reported "uebernimmt den Sollwert nicht"
 * every ~10 s, naming remote_watchdog / power_control_mode / battery_strategy /
 * remote_mode. The MEASURED cycles are the LIVE table below; the two mechanisms
 * behind them:
 *   - an out-of-range filler (0xFFFF on a 0..3 / 0..2 / 0..5 register) is no
 *     answer at all, and neither is a zero-answer block or a failed read;
 *   - the watchdog is a TIMER the inverter consumes: 51 s of an armed 60 s is it
 *     WORKING.
 * The honest counter-cases stay intact: a real refused write, a watchdog switched
 * off and a genuinely out-of-spec value all still yield a mismatch cycle.
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

// --- THE LIVE PROTOCOL (read-only sampling of the pilot's :8484 /api/state, ------
// 2026-07-30 09:34:36Z .. 09:36:26Z, remote path, idle setpoint 0 kW, SoC 7 %).
// Each row is ONE observed readback cycle; the `want` is what the operator must be
// told. Before this fix every "warn" row rendered "Der Wechselrichter uebernimmt
// den Sollwert nicht" while the battery was following the setpoint.
const LIVE = [
  {
    at: '09:34:36Z', want: 'unconfirmed',
    actual: { remote_watchdog: 60, power_control_mode: 1, battery_strategy: 2, battery_power: 0, remote_mode: 65535 },
    unread: ['remote_mode'],
  },
  {
    at: '09:34:46Z', want: 'held',
    actual: { remote_watchdog: 60, power_control_mode: 1, battery_strategy: 2, battery_power: 0, remote_mode: 1 },
  },
  {
    at: '09:35:06Z', want: 'held', // the watchdog is COUNTING DOWN from our armed 60
    actual: { remote_watchdog: 51, power_control_mode: 1, battery_strategy: 2, battery_power: 0, remote_mode: 1 },
  },
  {
    at: '09:36:16Z', want: 'unconfirmed',
    actual: { remote_watchdog: 60, power_control_mode: 65535, battery_strategy: 65535, battery_power: 0, remote_mode: 65535 },
    unread: ['power_control_mode', 'battery_strategy', 'remote_mode'],
  },
  {
    at: '09:36:26Z', want: 'held',
    actual: { remote_watchdog: 60, power_control_mode: 1, battery_strategy: 2, battery_power: 0, remote_mode: 1 },
  },
];

test('THE LIVE PROTOCOL: no observed cycle of the flapping plant is a refused write', () => {
  for (const row of LIVE) {
    const c = V.verifyCycle(remoteEntries(row.actual, 0));
    assert.strictEqual(c.cycle, row.want, row.at + ' -> ' + c.cycle + ' (' + c.reason + ')');
    assert.deepStrictEqual(c.mismatchRoles, [], row.at + ': nothing may be accused of refusing the setpoint');
    if (row.unread) assert.deepStrictEqual(c.unreadRoles, row.unread, row.at + ': what was unreadable is named');
  }
});

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

test('the tolerance is measured on the 16-bit RING (a signed setpoint at the zero crossing)', () => {
  // Commanded 0, read back -1 unit (0xFFFF) = ~30 W on a 30 kW inverter: inside the
  // register's 1-unit tolerance. A plain |a-b| measured 65535 and called it a
  // refused write - on every idle slot.
  assert.strictEqual(V.regDistance(0, 0xffff), 1);
  assert.strictEqual(V.regDistance(0xffff, 0), 1);
  assert.strictEqual(V.regDistance(0, 2), 2);
  assert.strictEqual(V.regDistance(0, 0x8000), 0x8000, 'the far side of the ring stays far');
  assert.strictEqual(V.verifyRegister({ role: 'battery_power', expect: 0, actual: 0xffff, tolerance: 1 }).verdict, 'held');
  assert.strictEqual(V.verifyRegister({ role: 'battery_power', expect: 0, actual: 0xfffd, tolerance: 1 }).verdict, 'mismatch',
    '-3 units against a commanded 0 is still a real deviation');
  // a signed charge setpoint away from zero is unaffected
  assert.strictEqual(V.verifyRegister({ role: 'battery_power', expect: 0xffdf, actual: 0xffde, tolerance: 1 }).verdict, 'held');
});

test('an OUT-OF-RANGE answer is UNREAD (0xFFFF cannot be a mode/strategy value)', () => {
  for (const role of ['remote_mode', 'power_control_mode', 'battery_strategy']) {
    const r = V.verifyRegister({ role: role, expect: 1, actual: 0xffff });
    assert.strictEqual(r.verdict, 'unread', role + ' 65535 is a filler, not a value');
    assert.match(r.note, /unplausibler Rueckgabewert/);
  }
  // In-range values are judged normally - the rule tolerates nothing real.
  assert.strictEqual(V.verifyRegister({ role: 'remote_mode', expect: 1, actual: 0 }).verdict, 'mismatch',
    'remote mode OFF is a REAL refusal and stays one');
  assert.strictEqual(V.verifyRegister({ role: 'battery_strategy', expect: 2, actual: 5 }).verdict, 'mismatch');
  assert.strictEqual(V.verifyRegister({ role: 'power_control_mode', expect: 1, actual: 1 }).verdict, 'held');
  // The watchdog deliberately has NO range: 0xFFFF is its documented "off" value.
  assert.strictEqual(V.verifyRegister({ role: 'remote_watchdog', expect: 60, actual: 0xffff }).verdict, 'mismatch');
  // An unlisted role keeps pure exact comparison (nothing is tolerated implicitly).
  assert.strictEqual(V.verifyRegister({ role: 'work_mode', expect: 1, actual: 0xffff }).verdict, 'mismatch');
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
