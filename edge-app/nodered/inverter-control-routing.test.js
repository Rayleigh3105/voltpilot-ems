'use strict';

/**
 * Offline tests for the pure control-routing (write-plan) abstraction. No
 * hardware, no sockets: controlRoute is a pure function, so we assert the
 * WriteOp/ReadOp plan directly. Safety-critical - the tests pin the gates that
 * keep control OFF by default and read-only for uncertified models.
 *
 * Run: node --test edge-app/nodered/inverter-control-routing.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const C = require('./inverter-control-routing.js');
const sunspec = require('./sunspec/model-discovery.js');

const SUNSPEC_SEL = {
  schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
  communication: 'modbus_tcp', connection: { ip: '10.0.0.5', port: 502, unit_id: 1 },
};
const DEYE_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p',
  communication: 'solarman_v5', connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 },
};
const FRONIUS_SEL = {
  schema_version: '1.0', brand: 'fronius', family: 'fronius_solar_api',
  communication: 'fronius_solar_api', connection: { ip: '192.168.0.20', port: 80 },
};

// Build a live SunSpec model-discovery result over a minimal fixture register
// image (a Common + Nameplate(12 kW) + Immediate-Controls(SF -2) list), the way
// the flow/core would hand it to controlRoute via opts.sunspec on a real device.
function froniusDiscovery(withStorage) {
  const base = sunspec.DEFAULT_BASE;
  const img = new Map();
  img.set(base, (sunspec.SID >>> 16) & 0xffff);
  img.set(base + 1, sunspec.SID & 0xffff);
  let addr = base + 2;
  const put = (id, body) => {
    img.set(addr, id & 0xffff);
    img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  };
  const np = new Array(26).fill(0);
  np[sunspec.M120.WRtg] = 12000; np[sunspec.M120.WRtg_SF] = 0; // 12 kW
  const ctl = new Array(sunspec.M123.LENGTH).fill(0);
  ctl[sunspec.M123.WMaxLimPct_SF] = -2 & 0xffff;
  put(sunspec.MODEL.COMMON, new Array(66).fill(0));
  put(sunspec.MODEL.NAMEPLATE, np);
  put(sunspec.MODEL.IMMEDIATE_CONTROLS, ctl);
  if (withStorage) {
    const st = new Array(sunspec.M124.LENGTH).fill(0);
    st[sunspec.M124.WChaMax] = 1000; st[sunspec.M124.WChaMax_SF] = 1; // 10 kW battery
    st[sunspec.M124.InOutWRte_SF] = -2 & 0xffff;
    st[sunspec.M124.MinRsvPct_SF] = -2 & 0xffff;
    put(sunspec.MODEL.STORAGE, st);
  }
  img.set(addr, sunspec.END_MODEL_ID); img.set(addr + 1, 0);
  const read = (a, count) => {
    const out = [];
    for (let i = 0; i < count; i++) { const w = img.get(a + i); if (w === undefined) break; out.push(w); }
    return out;
  };
  return sunspec.discover(read);
}
function froniusDiscoveryWithStorage() {
  return froniusDiscovery(true);
}

const enabled = (over) => ({ battery_setpoint_kw: 0, source: 'schedule', control_enabled: true, ...over });

// --- idle / guard cases ------------------------------------------------------

test('idle when nothing is selected', () => {
  const r = C.controlRoute(null, enabled());
  assert.strictEqual(r.adapter, 'idle');
  assert.deepStrictEqual(r.writes, []);
  assert.deepStrictEqual(r.readbacks, []);
});

test('idle on a missing IP or a non-finite setpoint', () => {
  assert.strictEqual(C.controlRoute({ ...SUNSPEC_SEL, connection: { ip: '' } }, enabled()).adapter, 'idle');
  assert.strictEqual(C.controlRoute(SUNSPEC_SEL, { control_enabled: true }).adapter, 'idle');
  assert.strictEqual(C.controlRoute(SUNSPEC_SEL, enabled({ battery_setpoint_kw: NaN })).adapter, 'idle');
});

// --- SunSpec adapter (certified) ---------------------------------------------

test('SunSpec maps battery_power/control_enable/pv_limit onto regs 40/41/42', () => {
  const r = C.controlRoute(SUNSPEC_SEL, enabled({ battery_setpoint_kw: -25, pv_limit_kw: 3 }));
  assert.strictEqual(r.adapter, 'modbus_tcp');
  assert.strictEqual(r.certified, true);
  assert.strictEqual(r.controlEnabled, true);
  const byRole = Object.fromEntries(r.writes.map((w) => [w.role, w]));
  assert.strictEqual(byRole.battery_power.addr, 40);
  assert.strictEqual(byRole.battery_power.value, (-2500) & 0xffff); // int16 0.01 kW
  assert.strictEqual(byRole.control_enable.addr, 41);
  assert.strictEqual(byRole.control_enable.value, 1);
  assert.strictEqual(byRole.pv_limit.addr, 42);
  assert.strictEqual(byRole.pv_limit.value, 300); // 3 kW * 100
  // readbacks mirror the writes
  const rbByRole = Object.fromEntries(r.readbacks.map((w) => [w.role, w]));
  assert.strictEqual(rbByRole.battery_power.fc, 3);
  assert.strictEqual(rbByRole.battery_power.expect, (-2500) & 0xffff);
  assert.strictEqual(rbByRole.pv_limit.expect, 300);
});

test('SunSpec pv_limit uses the 0xFFFF sentinel when there is no cap', () => {
  const r = C.controlRoute(SUNSPEC_SEL, enabled({ battery_setpoint_kw: 5, pv_limit_kw: null }));
  const pv = r.writes.find((w) => w.role === 'pv_limit');
  assert.strictEqual(pv.value, 0xffff);
  assert.strictEqual(r.readbacks.find((w) => w.role === 'pv_limit').expect, 0xffff);
});

test('SunSpec honours invert_control_sign for the battery-power write (never hardcoded)', () => {
  const sel = { ...SUNSPEC_SEL, connection: { ...SUNSPEC_SEL.connection, invert_control_sign: true } };
  const r = C.controlRoute(sel, enabled({ battery_setpoint_kw: -10 }));
  // inverted: -10 kW written as +10 kW = +1000 raw
  assert.strictEqual(r.writes.find((w) => w.role === 'battery_power').value, 1000);
});

// --- kill-switch gate (control_enabled) --------------------------------------

test('kill-switch: control_enabled=false drops writes but KEEPS readbacks', () => {
  const r = C.controlRoute(SUNSPEC_SEL, { battery_setpoint_kw: -4, source: 'schedule', control_enabled: false });
  assert.deepStrictEqual(r.writes, [], 'no writes when control is off');
  assert.strictEqual(r.readbacks.length, 3, 'readbacks still run so the UI shows actual state');
  assert.match(r.reason, /Not-Aus|freigegeben/);
  // the intended mapping is still visible for the UI / tests
  assert.strictEqual(r.planned.find((w) => w.role === 'battery_power').value, (-400) & 0xffff);
});

test('kill-switch defaults OFF when control_enabled is absent', () => {
  const r = C.controlRoute(SUNSPEC_SEL, { battery_setpoint_kw: -4, source: 'schedule' });
  assert.deepStrictEqual(r.writes, []);
});

// --- per-family certification gate (Deye = read-only) ------------------------

test('Deye is UNCERTIFIED: never emits executable writes even when control_enabled', () => {
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20, pv_limit_kw: 2 }), { ratedKw: 50 });
  assert.strictEqual(r.adapter, 'solarman_v5');
  assert.strictEqual(r.certified, false);
  assert.deepStrictEqual(r.writes, [], 'no live write to a bench-pending address');
  assert.deepStrictEqual(r.readbacks, [], 'no fake confirmation of unproven registers');
  assert.match(r.reason, /noch nicht freigegeben/);
});

test('un-gate: Deye writes/readbacks are gated ONLY by the certification allowlist (generic gate)', () => {
  const sp = enabled({ battery_setpoint_kw: -20 });
  const off = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30 });
  assert.deepStrictEqual(off.writes, [], 'default: uncertified -> no writes');
  assert.deepStrictEqual(off.readbacks, []);
  assert.ok(off.planned.length >= 5, 'the real ToU plan is always in planned[]');
  // Certifying the family (a bench pass) is the ONLY thing that turns writes on -
  // NO code change. This IS the un-gate. Restored immediately so the production
  // default stays read-only.
  C.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
  try {
    const on = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30 });
    assert.strictEqual(on.certified, true);
    assert.strictEqual(on.writes.length, off.planned.length, 'writes == the planned ToU ops');
    assert.strictEqual(on.readbacks.length, on.writes.length, 'a readback per written register');
    assert.ok(on.writes.every((w) => w.bench_pending === undefined), 'executable writes are not bench_pending markers');
    // The kill-switch still gates independently: certified but control_enabled=false
    // writes NOTHING (two-gate discipline, identical to sunspecControl).
    const killed = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: -20, source: 'schedule', control_enabled: false }, { ratedKw: 30 });
    assert.deepStrictEqual(killed.writes, [], 'certified + kill-switch off -> still no writes');
    assert.deepStrictEqual(killed.readbacks, []);
  } finally {
    C.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
  }
  assert.deepStrictEqual(C.controlRoute(DEYE_SEL, sp, { ratedKw: 30 }).writes, [], 'production default is read-only again');
});

test('First-Light calibration bypasses ONLY the certification gate (never the kill-switch)', () => {
  // The mechanism for the very first real write to a live Deye battery, BEFORE the
  // family is certified. setpoint.calibration=true un-gates the SAME planned ToU
  // WriteOps for the uncertified family - WITHOUT touching CERTIFIED_CONTROL_FAMILIES.
  const off = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -0.5 }), { ratedKw: 30 });
  assert.deepStrictEqual(off.writes, [], 'no calibration flag -> production default read-only');

  const cal = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -0.5, calibration: true }), { ratedKw: 30 });
  assert.strictEqual(cal.adapter, 'solarman_v5');
  assert.strictEqual(cal.certified, false, 'family is still uncertified');
  assert.strictEqual(cal.calibration, true);
  assert.strictEqual(cal.writes.length, cal.planned.length, 'calibration executes the SAME planned ToU ops');
  assert.strictEqual(cal.readbacks.length, cal.writes.length, 'a readback per written register');
  // The bounded calibration write forces dwell_s=0 so the controller-owned
  // auto-revert is never blocked by the 900 s EEPROM dwell.
  assert.ok(cal.writes.every((w) => w.dwell_s === 0 && w.min_change === 0), 'calibration writes carry dwell_s=0');

  // The global kill-switch STILL wins: calibration with control_enabled=false writes nothing.
  const killed = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: -0.5, source: 'calibration', control_enabled: false, calibration: true }, { ratedKw: 30 });
  assert.deepStrictEqual(killed.writes, [], 'kill-switch off -> no calibration write');
  assert.deepStrictEqual(killed.readbacks, []);

  // The normal (non-calibration) production path is untouched: still read-only.
  assert.deepStrictEqual(C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -0.5 }), { ratedKw: 30 }).writes, []);
});

test('First-Light calibration revert hands the uncertified Deye back (controlRelease bypass)', () => {
  // controlRelease normally emits writes:[] for an uncertified Deye. During a
  // calibration test the auto-revert MUST actually disable ToU (hand back to
  // self-consumption), so opts.calibration un-gates the release too.
  const plain = C.controlRelease(DEYE_SEL, {});
  assert.deepStrictEqual(plain.writes, [], 'uncertified release is planned-only by default');

  const rel = C.controlRelease(DEYE_SEL, { calibration: true });
  assert.strictEqual(rel.mode, 'release');
  assert.strictEqual(rel.calibration, true);
  assert.strictEqual(rel.writes.length, 1, 'the neutral ToU-disable write executes during calibration');
  assert.strictEqual(rel.writes[0].role, 'tou_enable');
  assert.strictEqual(rel.writes[0].value, 0, 'ToU disabled -> self-consumption');
  assert.strictEqual(rel.writes[0].dwell_s, 0, 'revert not blocked by EEPROM dwell');
  assert.strictEqual(rel.readbacks.length, 1);
});

test('Deye hybrid_3p planned ToU mapping uses the ha-solarman deye_p3 registers', () => {
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20, pv_limit_kw: 25 }), { ratedKw: 50 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  // discharge 20 kW -> Program 1 Power 20000 W (power_scale 1), target SoC = floor.
  assert.strictEqual(p.battery_power.value, 20000);
  assert.strictEqual(p.battery_power.addr, reg.progPowerBase); // 0x009A (Program 1 Power), NOT the old 0x0F3D
  assert.strictEqual(p.battery_target_soc.addr, reg.progSocBase); // 0x00A6
  assert.strictEqual(p.battery_target_soc.encode.direction, 'discharge');
  // work-mode = Export First, ToU enabled all-week
  assert.strictEqual(p.work_mode.addr, reg.workMode); // 0x008E
  assert.strictEqual(p.work_mode.value, C.DEYE_WORK_MODE.EXPORT_FIRST);
  assert.strictEqual(p.tou_enable.addr, reg.touEnable); // 0x0092
  assert.strictEqual(p.tou_enable.value, C.DEYE_TOU_ENABLED_ALL_WEEK);
  // Program 1 start time written to 00:00 so the commanded slot is the day's BASE
  // window (report §6): without it a stale time can leave Program 1 inactive at "now".
  assert.strictEqual(p.program_time.addr, reg.progTimeBase); // 0x0094
  assert.strictEqual(p.program_time.value, 0);
  // pv_limit 25 kW -> "Grid Max Export power" 0x00E7, scale 10 -> 2500 register
  assert.strictEqual(p.pv_limit.addr, reg.exportLimit); // 0x00E7, NOT the string-only 0x0028
  assert.strictEqual(p.pv_limit.value, 2500);
  // no control register lands in the live-telemetry window (0x024C.. / 0x0F00..)
  for (const w of r.planned) assert.ok(w.addr < 0x0200, 'control reg ' + w.addr.toString(16) + ' outside telemetry block');
  // every Deye planned op is bench-pending
  assert.ok(r.planned.every((w) => w.bench_pending === true));
});

test('Deye hybrid_1p uses its own ha-solarman deye_hybrid registers (per-family)', () => {
  const sel = { ...DEYE_SEL, family: 'hybrid_1p' };
  const r = C.controlRoute(sel, enabled({ battery_setpoint_kw: -6, pv_limit_kw: 4 }), { ratedKw: 8 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  const reg = C.DEYE_CONTROL_REG.hybrid_1p;
  assert.strictEqual(p.energy_pattern.addr, reg.energyPattern); // 0x00F3
  assert.strictEqual(p.work_mode.addr, reg.workMode); // 0x00F4
  assert.strictEqual(p.solar_sell.addr, reg.solarSell); // 0x00F7
  assert.strictEqual(p.tou_enable.addr, reg.touEnable); // 0x00F8
  assert.strictEqual(p.program_time.addr, reg.progTimeBase); // 0x00FA (Program 1 base window)
  assert.strictEqual(p.battery_power.addr, reg.progPowerBase); // 0x0100
  assert.strictEqual(p.battery_power.value, 6000);
  assert.strictEqual(p.battery_target_soc.addr, reg.progSocBase); // 0x010C
  assert.strictEqual(p.grid_charge_enable.addr, reg.progChargeBase); // 0x0112
  // hybrid_1p: "Max Sell Power" (0x00F5) IS the exportLimit register, so the 6b
  // discharge lever and the curtailment cap COLLAPSE onto ONE op carrying the TIGHTER
  // (min) value - discharge 6 kW (6000) vs curtail 4 kW (4000) -> 4000. No separate
  // pv_limit op is emitted (one address is never written twice).
  assert.strictEqual(p.pv_limit, undefined, 'no separate pv_limit op on hybrid_1p (shared register)');
  assert.strictEqual(p.max_sell_power.addr, reg.maxSellPower); // 0x00F5 == exportLimit
  assert.strictEqual(p.max_sell_power.value, 4000, 'min(discharge 6000, curtail 4000)');
  assert.strictEqual(r.planned.filter((w) => w.addr === reg.maxSellPower).length, 1, 'exactly one op at 0x00F5');
});

test('Deye HV firmware power_scale=10 scales the Program-Power register (decawatt)', () => {
  const sel = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: 10 } };
  const r = C.controlRoute(sel, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  // 20 kW / 10 -> 2000 register units (matches the read-map decawatt convention)
  assert.strictEqual(p.battery_power.value, 2000);
  assert.strictEqual(p.battery_power.encode.scale, 10);
});

test('Deye pv_limit is OMITTED when there is no curtailment (contract: absent = no limit)', () => {
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -5, pv_limit_kw: null }), { ratedKw: 50 });
  assert.strictEqual(r.planned.find((w) => w.role === 'pv_limit'), undefined);
});

test('Deye grid-charge enum is EEG-gated: Disabled unless explicitly permitted', () => {
  const charge = { battery_setpoint_kw: 15, source: 'schedule', control_enabled: true };
  const eeg = C.controlRoute(DEYE_SEL, charge, { ratedKw: 50 });
  const grid = (r) => r.planned.find((w) => w.role === 'grid_charge_enable').value;
  assert.strictEqual(grid(eeg), C.DEYE_PROG_CHARGE.DISABLED, 'EEG default: no grid charge');
  const merchant = C.controlRoute(DEYE_SEL, { ...charge, grid_charge_allowed: true }, { ratedKw: 50 });
  assert.strictEqual(grid(merchant), C.DEYE_PROG_CHARGE.GRID, 'permitted + charging');
  // discharging never grid-charges even when permitted
  const dis = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: -5, source: 'schedule', control_enabled: true, grid_charge_allowed: true }, { ratedKw: 50 });
  assert.strictEqual(grid(dis), C.DEYE_PROG_CHARGE.DISABLED);
});

test('Deye string/micro (no battery) only plans the active-power limit at 0x0028', () => {
  const sel = { ...DEYE_SEL, family: 'string' };
  const r = C.controlRoute(sel, enabled({ battery_setpoint_kw: 0, pv_limit_kw: 3 }), { ratedKw: 6 });
  assert.strictEqual(r.planned.length, 1);
  assert.strictEqual(r.planned[0].role, 'pv_limit');
  assert.strictEqual(r.planned[0].addr, 0x0028); // string/micro active-power limit (correct there)
  assert.strictEqual(r.planned[0].value, 50); // 3 of 6 kW rated -> 50 %
  // no battery ToU registers for a batteryless family
  assert.strictEqual(r.planned.find((w) => w.role === 'battery_power'), undefined);
});

// --- corrected DISCHARGE synthesis (report §8): the whole point of this PR --------
//
// Strategy A (target-SoC floor + power cap + charge-off) is CORRECT for charge but
// fundamentally INCOMPLETE for discharge - a Deye ToU target-SoC is a discharge
// FLOOR not a command, and Export-First charges from surplus before exporting. To
// actually push power OUT you must ALSO set Energy-Pattern=Load-First + Solar-Sell=ON
// + the export/sell-power limit (6b), and ACTIVATE ToU strictly LAST.

test('discharge adds the missing forcing levers: Load-First + Solar-Sell + Max-Sell-Power', () => {
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  // 1) Energy-Pattern = Load First (stop prioritising battery charge from PV) - NEW
  assert.strictEqual(p.energy_pattern.addr, reg.energyPattern); // 0x008D
  assert.strictEqual(p.energy_pattern.value, C.DEYE_ENERGY_PATTERN.LOAD_FIRST);
  // 2) Work-Mode = Export First
  assert.strictEqual(p.work_mode.value, C.DEYE_WORK_MODE.EXPORT_FIRST);
  // 3) Solar-Sell = ON (enable surplus/battery export) - NEW
  assert.strictEqual(p.solar_sell.addr, reg.solarSell); // 0x0091
  assert.strictEqual(p.solar_sell.value, C.DEYE_SOLAR_SELL.ON);
  // 6b) the forcing lever: Max-Sell-Power = the discharge rate (20 kW -> 20000 W, LV) - NEW
  assert.strictEqual(p.max_sell_power.addr, reg.maxSellPower); // 0x008F (distinct from 0x00E7)
  assert.strictEqual(p.max_sell_power.value, 20000);
  assert.strictEqual(p.max_sell_power.encode.lever, 'force_discharge');
  // the existing permission levers remain: target-SoC floor + charge disabled
  assert.strictEqual(p.battery_target_soc.encode.direction, 'discharge');
  assert.strictEqual(p.grid_charge_enable.value, C.DEYE_PROG_CHARGE.DISABLED);
  // 6a (max-charge-current 0x006C) is DELIBERATELY NOT wired in this PR
  assert.strictEqual(r.planned.find((w) => w.addr === reg.maxChargeCurrent), undefined);
});

test('activation (tou_enable) is the STRICTLY LAST write op, after every config/slot register', () => {
  for (const kw of [-20, 15]) { // discharge AND charge
    const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: kw, pv_limit_kw: 3 }), { ratedKw: 50 });
    const last = r.planned[r.planned.length - 1];
    assert.strictEqual(last.role, 'tou_enable', 'tou_enable must be LAST for setpoint ' + kw);
    assert.strictEqual(last.value, C.DEYE_TOU_ENABLED_ALL_WEEK);
    // and it is the ONLY tou_enable op (never written twice)
    assert.strictEqual(r.planned.filter((w) => w.role === 'tou_enable').length, 1);
  }
});

test('CHARGE keeps Strategy A + Energy-Pattern=Battery-First, and does NOT enable Solar-Sell', () => {
  const r = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: 15, source: 'schedule', control_enabled: true, grid_charge_allowed: true }, { ratedKw: 50 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.energy_pattern.value, C.DEYE_ENERGY_PATTERN.BATTERY_FIRST, 'charge -> Battery First');
  assert.strictEqual(p.battery_target_soc.value, 100, 'charge -> target SoC 100');
  assert.strictEqual(p.battery_target_soc.encode.direction, 'charge');
  assert.strictEqual(p.grid_charge_enable.value, C.DEYE_PROG_CHARGE.GRID, 'permitted -> Grid');
  assert.strictEqual(p.solar_sell, undefined, 'a charge never enables Solar-Sell');
  // no snapshot -> no maxSellPower op on charge (the executor snapshots first, next tick restores)
  assert.strictEqual(p.max_sell_power, undefined, 'no maxSellPower restore without a snapshot');
});

test('CHARGE restores Max-Sell-Power to the captured pre-control value when a snapshot is present', () => {
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  // installer had Max-Sell-Power = 8000 before we ever controlled; a prior discharge
  // may have lowered it, so a later CHARGE must restore it, not leave the cap latched.
  const snapshot = { [reg.maxSellPower]: 8000 };
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: 15, snapshot: undefined }), { ratedKw: 50, snapshot });
  const ms = r.planned.find((w) => w.role === 'max_sell_power');
  assert.ok(ms, 'the charge plan restores maxSellPower from the snapshot');
  assert.strictEqual(ms.addr, reg.maxSellPower);
  assert.strictEqual(ms.value, 8000);
  assert.strictEqual(ms.encode.kind, 'restore');
});

// --- N1: the power scale, proven on HV (x10) and LV (x1) for 0.3 kW ---------------

test('N1: 0.3 kW discharge encodes correctly on HV (power_scale 10) and LV (power_scale 1)', () => {
  const disc = (scale) => C.controlRoute(
    { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: scale } },
    enabled({ battery_setpoint_kw: -0.3 }), { ratedKw: 30 },
  );
  const g = (r, role) => r.planned.find((w) => w.role === role).value;
  // LV (scale 1): 300 W. Program-Power AND Max-Sell-Power both x1.
  const lv = disc(1);
  assert.strictEqual(g(lv, 'battery_power'), 300, 'LV progPower 300 raw');
  assert.strictEqual(g(lv, 'max_sell_power'), 300, 'LV maxSell 300 raw');
  assert.strictEqual(lv.powerScaleConfirmed, true);
  // HV (scale 10 = decawatt): 30 raw. The N1 bug was under-scaling this 10x.
  const hv = disc(10);
  assert.strictEqual(g(hv, 'battery_power'), 30, 'HV progPower 30 raw (decawatt)');
  assert.strictEqual(g(hv, 'max_sell_power'), 30, 'HV maxSell 30 raw (decawatt)');
  assert.strictEqual(hv.powerScaleConfirmed, true);
});

test('N1: an UNSET/auto power_scale falls back to 1 but flags powerScaleConfirmed=false (never silent)', () => {
  const auto = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 }); // no power_scale
  assert.strictEqual(auto.powerScaleConfirmed, false, 'unset scale is a FALLBACK, surfaced not silent');
  assert.strictEqual(auto.planned.find((w) => w.role === 'battery_power').value, 20000, 'fallback scale 1');
  // an explicit 0 (catalog "auto") is also unconfirmed
  const zero = C.controlRoute({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: 0 } }, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 });
  assert.strictEqual(zero.powerScaleConfirmed, false);
});

// --- N2: slot-time conflict detection (report §8.9) - detect + surface, never rewrite

test('N2 helper deyeProgram1Displaced: flags a later program governing "now", ignores all-zero', () => {
  // Program 1 @ 00:00, Program 3 @ 08:00 (HHMM 800): at 12:00 (720 min) Program 3 governs.
  assert.strictEqual(C.deyeProgram1Displaced([0, 0, 800, 0, 0, 0], 720), true);
  // before Program 3 starts (06:00 = 360 min) Program 1 still governs.
  assert.strictEqual(C.deyeProgram1Displaced([0, 0, 800, 0, 0, 0], 360), false);
  // all-zero / fresh program times never trip it (no false positive).
  assert.strictEqual(C.deyeProgram1Displaced([0, 0, 0, 0, 0, 0], 720), false);
  // 08:30 encodes as HHMM 830 -> 510 minutes.
  assert.strictEqual(C.deyeHhmmToMinutes(830), 510);
});

test('N2: the plan carries the 6 program-time addresses so the executor can read + check them', () => {
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 });
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  assert.deepStrictEqual(r.snapshotPlan.programTimes, [0, 1, 2, 3, 4, 5].map((i) => reg.progTimeBase + i));
  // we only ever WRITE Program 1's own time (report §8.9: never rewrite Programs 2..6)
  const timeWrites = r.planned.filter((w) => w.role === 'program_time');
  assert.strictEqual(timeWrites.length, 1);
  assert.strictEqual(timeWrites[0].addr, reg.progTimeBase); // Program 1 only
});

// --- snapshot capture spec + restore (report §8) ---------------------------------

test('the plan carries the snapshotPlan register spec (the union to capture), tou_enable last', () => {
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 });
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  const roles = r.snapshotPlan.registers.map((s) => s.role);
  // the installer-level levers we now touch MUST be captured so release can restore them
  for (const role of ['energy_pattern', 'work_mode', 'max_sell_power', 'solar_sell', 'export_limit', 'tou_enable']) {
    assert.ok(roles.includes(role), 'snapshot captures ' + role);
  }
  assert.strictEqual(roles[roles.length - 1], 'tou_enable', 'activation restored LAST');
  // addresses are the real hybrid_3p registers
  const byRole = Object.fromEntries(r.snapshotPlan.registers.map((s) => [s.role, s.addr]));
  assert.strictEqual(byRole.energy_pattern, reg.energyPattern);
  assert.strictEqual(byRole.max_sell_power, reg.maxSellPower);
  assert.strictEqual(byRole.solar_sell, reg.solarSell);
});

test('controlRelease RESTORES the snapshot (not just touEnable=0), touEnable restored LAST', () => {
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  // a captured pre-control snapshot: installer was on self-consumption (touEnable 0),
  // Battery-First (0), Solar-Sell off (0), Max-Sell 8000, export cap 9999.
  const snapshot = {
    [reg.energyPattern]: 0, [reg.workMode]: 0, [reg.maxSellPower]: 8000, [reg.solarSell]: 0,
    [reg.progTimeBase]: 0, [reg.progPowerBase]: 0, [reg.progSocBase]: 20, [reg.progChargeBase]: 0,
    [reg.exportLimit]: 9999, [reg.touEnable]: 0,
  };
  const rel = C.controlRelease(DEYE_SEL, { snapshot });
  assert.strictEqual(rel.mode, 'release');
  const byRole = Object.fromEntries(rel.planned.map((w) => [w.role, w]));
  assert.strictEqual(byRole.max_sell_power.value, 8000, 'restore the installer Max-Sell-Power');
  assert.strictEqual(byRole.solar_sell.value, 0, 'restore Solar-Sell OFF (never leave export latched)');
  assert.strictEqual(byRole.energy_pattern.value, 0, 'restore Energy-Pattern');
  assert.strictEqual(byRole.export_limit.value, 9999, 'restore the export cap');
  assert.ok(rel.planned.every((w) => w.encode.kind === 'restore'), 'every op restores a captured value');
  assert.strictEqual(rel.planned[rel.planned.length - 1].role, 'tou_enable', 'touEnable restored LAST');
});

test('controlRelease WITHOUT a snapshot stays as before: just disable Time-of-Use', () => {
  const rel = C.controlRelease(DEYE_SEL, {});
  assert.strictEqual(rel.planned.length, 1);
  assert.strictEqual(rel.planned[0].role, 'tou_enable');
  assert.strictEqual(rel.planned[0].value, 0, 'no snapshot -> disable scheduler (self-consumption)');
});

test('controlRelease restore is idempotent + gated + calibration-bypassable', () => {
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  const snapshot = { [reg.maxSellPower]: 8000, [reg.solarSell]: 0, [reg.touEnable]: 0 };
  // uncertified default: planned-only, no executable writes
  const off = C.controlRelease(DEYE_SEL, { snapshot });
  assert.deepStrictEqual(off.writes, [], 'uncertified restore stays planned-only');
  assert.ok(off.planned.length >= 3);
  // idempotent: two identical calls produce the identical restore plan
  assert.deepStrictEqual(C.controlRelease(DEYE_SEL, { snapshot }).planned, off.planned);
  // calibration bypass makes the restore executable (dwell_s=0 so it is never blocked)
  const cal = C.controlRelease(DEYE_SEL, { snapshot, calibration: true });
  assert.strictEqual(cal.writes.length, cal.planned.length, 'calibration -> executable restore');
  assert.ok(cal.writes.every((w) => w.dwell_s === 0), 'calibration restore not blocked by dwell');
});

// --- control_write_fc: FC16 by default, FC6 as the flip-back (PR y7) -----------
//
// The live-Pilsting fix: many Deye firmwares ACCEPT an FC6 write but never answer it
// and do not change the register, so the demonstrably-working Deye integrations write
// via FC16. Every Deye WriteOp carries the resolved write function code; the executor
// dispatches on WriteOp.fc. Only the wire function changes - addr/value/order/encode
// and the two-gate certification discipline are all unchanged.

test('resolveDeyeWriteFc: FC16 by default (auto/absent/16), FC6 only on an explicit 6', () => {
  assert.strictEqual(C.resolveDeyeWriteFc({}), 16, 'absent -> FC16');
  assert.strictEqual(C.resolveDeyeWriteFc({ control_write_fc: 0 }), 16, 'auto (0) -> FC16');
  assert.strictEqual(C.resolveDeyeWriteFc({ control_write_fc: 16 }), 16, 'explicit 16 -> FC16');
  assert.strictEqual(C.resolveDeyeWriteFc({ control_write_fc: 6 }), 6, 'explicit 6 -> FC6');
  assert.strictEqual(C.resolveDeyeWriteFc({ control_write_fc: '6' }), 6, 'string "6" -> FC6');
  assert.strictEqual(C.resolveDeyeWriteFc(null), 16, 'null connection -> FC16');
});

test('Deye WriteOps carry FC16 by default (the fix), and the register mapping is unchanged', () => {
  const r = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20, pv_limit_kw: 25 }), { ratedKw: 50 });
  assert.ok(r.planned.length >= 5, 'the ToU plan is present');
  assert.ok(r.planned.every((w) => w.fc === 16), 'every Deye WriteOp is FC16 by default: ' + JSON.stringify(r.planned.map((w) => [w.role, w.fc])));
  // the readbacks are still FC3 (the read function is unchanged)
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  assert.strictEqual(r.planned.find((w) => w.role === 'battery_power').addr, reg.progPowerBase, 'register map untouched');
});

test('control_write_fc:6 flips every Deye WriteOp back to FC6; explicit 16 keeps FC16', () => {
  const fc6 = C.controlRoute(
    { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, control_write_fc: 6 } },
    enabled({ battery_setpoint_kw: -20, pv_limit_kw: 25 }), { ratedKw: 50 },
  );
  assert.ok(fc6.planned.every((w) => w.fc === 6), 'control_write_fc:6 -> every WriteOp FC6');
  const fc16 = C.controlRoute(
    { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, control_write_fc: 16 } },
    enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 },
  );
  assert.ok(fc16.planned.every((w) => w.fc === 16), 'control_write_fc:16 -> every WriteOp FC16');
  // string/micro active-power-limit write honors the switch too
  const str = C.controlRoute(
    { ...DEYE_SEL, family: 'string', connection: { ...DEYE_SEL.connection, control_write_fc: 6 } },
    enabled({ battery_setpoint_kw: 0, pv_limit_kw: 3 }), { ratedKw: 6 },
  );
  assert.strictEqual(str.planned[0].fc, 6, 'string/micro pv_limit honors control_write_fc');
});

test('controlRelease honors control_write_fc (FC16 default, FC6 flip-back)', () => {
  const def = C.controlRelease(DEYE_SEL, {});
  assert.strictEqual(def.planned[0].role, 'tou_enable');
  assert.strictEqual(def.planned[0].fc, 16, 'release defaults to FC16');
  const fc6 = C.controlRelease({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, control_write_fc: 6 } }, {});
  assert.strictEqual(fc6.planned[0].fc, 6, 'release honors control_write_fc:6');
});

// --- Fronius SunSpec curtailment adapter (UNCERTIFIED - planned only) ---------

test('Fronius is UNCERTIFIED: never emits executable writes/readbacks even when control_enabled', () => {
  const r = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 0, pv_limit_kw: 6 }), { sunspec: froniusDiscovery() });
  assert.strictEqual(r.adapter, 'fronius_sunspec');
  assert.strictEqual(r.certified, false, 'fronius must not be certified');
  assert.strictEqual(r.controlEnabled, true);
  assert.deepStrictEqual(r.writes, [], 'no live write to an uncertified inverter');
  assert.deepStrictEqual(r.readbacks, [], 'no fake confirmation of unproven registers');
  // control endpoint is the SunSpec Modbus surface (502), NOT the Solar-API port 80
  assert.strictEqual(r.connection.port, C.DEFAULT_FRONIUS_CONTROL_PORT);
});

test('Fronius planned curtailment maps pv_limit_kw -> discovered Model 123 WMaxLimPct (bench_pending)', () => {
  const disc = froniusDiscovery();
  const r = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 0, pv_limit_kw: 6 }), { sunspec: disc });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  // 6 kW cap of a 12 kW nameplate -> 50 %, register scale SF -2 -> raw 5000.
  assert.strictEqual(p.pv_limit_pct.addr, disc.controls.wMaxLimPctAddr);
  assert.strictEqual(p.pv_limit_pct.value, 5000);
  assert.strictEqual(p.pv_limit_enable.addr, disc.controls.wMaxLimEnaAddr);
  assert.strictEqual(p.pv_limit_enable.value, sunspec.WMAX_LIM_ENA.ENABLED);
  assert.strictEqual(p.pv_limit_revert_tms.addr, disc.controls.wMaxLimPctRvrtTmsAddr);
  // every Fronius planned op is bench-pending, and NONE is executable
  assert.ok(r.planned.every((w) => w.bench_pending === true));
  assert.deepStrictEqual(r.writes, []);
});

test('Fronius is IDLE-SAFE without a discovery result: no planned addresses, honest reason', () => {
  const r = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 0, pv_limit_kw: 6 }), {});
  assert.strictEqual(r.adapter, 'fronius_sunspec');
  assert.deepStrictEqual(r.writes, []);
  assert.deepStrictEqual(r.planned, [], 'no fabricated address without live model discovery');
  assert.match(r.reason, /nicht erkannt|nicht freigegeben/);
});

test('Fronius uncurtailed slot plans DISABLING the limit (Model 123 enable = 0)', () => {
  const r = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 0, pv_limit_kw: null }), { sunspec: froniusDiscovery() });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.pv_limit_enable.value, sunspec.WMAX_LIM_ENA.DISABLED);
});

// --- Fronius SunSpec STORAGE battery control (increment 2, UNCERTIFIED) --------

test('Fronius storage: a CHARGE setpoint plans Model 124 InWRte + StorCtl_Mod (bench_pending, never executable)', () => {
  const disc = froniusDiscoveryWithStorage();
  // charge 5 kW into a 10 kW WChaMax battery -> 50 %, SF -2 -> raw 5000.
  const r = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 5, soc_min_pct: 10 }), { sunspec: disc });
  assert.strictEqual(r.adapter, 'fronius_sunspec');
  assert.strictEqual(r.certified, false);
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_in_rate.addr, disc.storage.inWRteAddr);
  assert.strictEqual(p.battery_in_rate.value, 5000);
  assert.strictEqual(p.battery_out_rate.value, 0);
  assert.strictEqual(p.battery_storage_mode.addr, disc.storage.storCtlModAddr);
  assert.strictEqual(p.battery_storage_mode.value, sunspec.STORCTL_MOD.CHARGE);
  assert.strictEqual(p.battery_min_reserve.value, 1000); // soc_min 10 %, SF -2
  // grid-charge EEG-gated: not permitted -> PV (off)
  assert.strictEqual(p.battery_grid_charge.value, sunspec.CHA_GRI_SET.PV);
  // every storage op is bench_pending, and NOTHING is executable
  for (const role of ['battery_in_rate', 'battery_out_rate', 'battery_storage_mode', 'battery_min_reserve', 'battery_grid_charge', 'battery_revert_tms']) {
    assert.strictEqual(p[role].bench_pending, true, role + ' must be bench_pending');
  }
  assert.deepStrictEqual(r.writes, [], 'no live storage write to an uncertified inverter');
  assert.deepStrictEqual(r.readbacks, [], 'no fake confirmation of unproven storage registers');
});

test('Fronius storage: a DISCHARGE setpoint plans OutWRte + the discharge bit', () => {
  const disc = froniusDiscoveryWithStorage();
  const r = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: -2.5 }), { sunspec: disc });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_out_rate.addr, disc.storage.outWRteAddr);
  assert.strictEqual(p.battery_out_rate.value, 2500); // 2.5 of 10 kW = 25 %
  assert.strictEqual(p.battery_in_rate.value, 0);
  assert.strictEqual(p.battery_storage_mode.value, sunspec.STORCTL_MOD.DISCHARGE);
});

test('Fronius storage: grid-charge ChaGriSet is EEG-gated (GRID only when permitted AND charging)', () => {
  const disc = froniusDiscoveryWithStorage();
  const grid = (sp) => {
    const r = C.controlRoute(FRONIUS_SEL, sp, { sunspec: disc });
    return r.planned.find((w) => w.role === 'battery_grid_charge').value;
  };
  assert.strictEqual(grid({ battery_setpoint_kw: 5, source: 'schedule', control_enabled: true }), sunspec.CHA_GRI_SET.PV, 'EEG default: no grid charge');
  assert.strictEqual(grid({ battery_setpoint_kw: 5, source: 'schedule', control_enabled: true, grid_charge_allowed: true }), sunspec.CHA_GRI_SET.GRID, 'permitted + charging');
  assert.strictEqual(grid({ battery_setpoint_kw: -5, source: 'schedule', control_enabled: true, grid_charge_allowed: true }), sunspec.CHA_GRI_SET.PV, 'discharging never grid-charges');
});

test('Fronius storage honours invert_control_sign for the battery direction (never hardcoded)', () => {
  const sel = { ...FRONIUS_SEL, connection: { ...FRONIUS_SEL.connection, invert_control_sign: true } };
  // -5 kW inverted -> +5 kW = charge -> InWRte set, discharge idle
  const r = C.controlRoute(sel, enabled({ battery_setpoint_kw: -5 }), { sunspec: froniusDiscoveryWithStorage() });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_storage_mode.value, sunspec.STORCTL_MOD.CHARGE);
  assert.strictEqual(p.battery_in_rate.value, 5000);
});

test('Fronius storage is UNCERTIFIED: control_enabled never produces executable storage writes', () => {
  const r = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 5, pv_limit_kw: 6 }), { sunspec: froniusDiscoveryWithStorage() });
  assert.strictEqual(r.controlEnabled, true);
  assert.strictEqual(r.certified, false);
  assert.deepStrictEqual(r.writes, [], 'never a live storage write, even with the kill-switch on');
  assert.deepStrictEqual(r.readbacks, []);
  // both curtailment AND storage roles are present in the planned bench artefact
  const roles = new Set(r.planned.map((w) => w.role));
  assert.ok(roles.has('pv_limit_pct'), 'curtailment still planned');
  assert.ok(roles.has('battery_in_rate'), 'storage planned');
  assert.ok(r.planned.every((w) => w.bench_pending === true));
});

test('Fronius storage is IDLE-SAFE when Model 124 is absent (no battery / no discovery)', () => {
  // Discovery WITHOUT storage: Model 123 present -> only curtailment planned, no storage ops.
  const noStore = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 5, pv_limit_kw: 6 }), { sunspec: froniusDiscovery() });
  const roles = new Set(noStore.planned.map((w) => w.role));
  assert.ok(roles.has('pv_limit_pct'), 'curtailment still planned');
  assert.strictEqual(noStore.planned.find((w) => w.role === 'battery_in_rate'), undefined, 'no fabricated storage address without Model 124');
  // No discovery at all: nothing planned, honest reason.
  const noDisc = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 5 }), {});
  assert.deepStrictEqual(noDisc.planned, []);
  assert.deepStrictEqual(noDisc.writes, []);
  assert.match(noDisc.reason, /nicht erkannt|nicht freigegeben/);
});

test('CERTIFIED_CONTROL_FAMILIES contains sunspec but no Deye or Fronius family', () => {
  assert.ok(C.CERTIFIED_CONTROL_FAMILIES.has('sunspec'));
  for (const f of ['hybrid_3p', 'hybrid_1p', 'string', 'micro', 'fronius_solar_api']) {
    assert.ok(!C.CERTIFIED_CONTROL_FAMILIES.has(f), f + ' must stay uncertified');
  }
});

// --- control-tier dispatch (Phase A) -----------------------------------------

test('resolveControlTier prefers control_tier, else infers from communication', () => {
  // explicit wins
  assert.strictEqual(C.resolveControlTier({ communication: 'modbus_tcp', control_tier: 2 }), C.CONTROL_TIER.VENDOR_EMS);
  assert.strictEqual(C.resolveControlTier({ communication: 'solarman_v5', control_tier: 0 }), C.CONTROL_TIER.READ_ONLY);
  // inference reproduces the pre-tier dispatch when control_tier is absent
  assert.strictEqual(C.resolveControlTier({ communication: 'solarman_v5' }), C.CONTROL_TIER.TOU);
  assert.strictEqual(C.resolveControlTier({ communication: 'modbus_tcp' }), C.CONTROL_TIER.SUNSPEC);
  assert.strictEqual(C.resolveControlTier({ communication: 'fronius_solar_api' }), C.CONTROL_TIER.SUNSPEC);
  assert.strictEqual(C.resolveControlTier({ communication: 'goe_http_api' }), C.CONTROL_TIER.READ_ONLY);
  // out-of-range / garbage tiers fall back to inference
  assert.strictEqual(C.resolveControlTier({ communication: 'modbus_tcp', control_tier: 9 }), C.CONTROL_TIER.SUNSPEC);
  assert.strictEqual(C.resolveControlTier({ communication: 'solarman_v5', control_tier: 'x' }), C.CONTROL_TIER.TOU);
});

test('an explicit control_tier is byte-identical to inference for a catalogued brand', () => {
  // The core now stamps control_tier onto the selection; the plan must be IDENTICAL
  // whether the field is present (new core) or inferred (old core / hand-built).
  const sp = enabled({ battery_setpoint_kw: -25, pv_limit_kw: 3 });
  assert.deepStrictEqual(
    C.controlRoute({ ...SUNSPEC_SEL, control_tier: 1 }, sp),
    C.controlRoute(SUNSPEC_SEL, sp),
  );
  const dsp = enabled({ battery_setpoint_kw: -20, pv_limit_kw: 25 });
  assert.deepStrictEqual(
    C.controlRoute({ ...DEYE_SEL, control_tier: 3 }, dsp, { ratedKw: 50 }),
    C.controlRoute(DEYE_SEL, dsp, { ratedKw: 50 }),
  );
});

test('control_tier decouples control from the read transport (Tier-2 extension point)', () => {
  // A future Sungrow-like brand reads over modbus_tcp yet declares Tier 2. It MUST
  // land on the vendor-EMS extension point, never be misread as a Tier-1 SunSpec
  // device (which shares the modbus_tcp transport). This is the whole reason the
  // dispatch keys on the tier, not the communication.
  const sel = { schema_version: '1.0', brand: 'sungrow', family: 'sungrow_sh',
    communication: 'modbus_tcp', control_tier: 2, connection: { ip: '10.0.0.9', port: 502 } };
  const r = C.controlRoute(sel, enabled({ battery_setpoint_kw: -5 }));
  assert.strictEqual(r.adapter, 'vendor_ems', 'Tier 2 -> vendor-EMS, not the modbus SunSpec adapter');
  assert.strictEqual(r.certified, false, 'no Tier-2 vendor is certified yet');
  assert.deepStrictEqual(r.writes, [], 'the extension point never emits a live write');
  assert.deepStrictEqual(r.planned, []);
  assert.match(r.reason, /Tier-2|noch nicht implementiert/);
});

test('control_tier 0 (read-only) idles even over a controllable transport', () => {
  // A brand explicitly marked read-only must not control, even though its transport
  // (modbus_tcp) would otherwise infer Tier 1.
  const sel = { ...SUNSPEC_SEL, control_tier: 0 };
  assert.strictEqual(C.controlRoute(sel, enabled({ battery_setpoint_kw: -5 })).adapter, 'idle');
});

// --- controller-owned failsafe: controlRelease() per tier (Phase B) ----------

test('Tier-1 SunSpec release hands control back: control_enable=0, setpoint 0, cap cleared', () => {
  const r = C.controlRelease(SUNSPEC_SEL);
  assert.strictEqual(r.mode, 'release');
  assert.strictEqual(r.adapter, 'modbus_tcp');
  assert.strictEqual(r.tier, C.CONTROL_TIER.SUNSPEC);
  assert.strictEqual(r.certified, true);
  const w = Object.fromEntries(r.writes.map((x) => [x.role, x]));
  assert.strictEqual(w.control_enable.addr, 41);
  assert.strictEqual(w.control_enable.value, 0, 'control disabled -> inverter self-consumes');
  assert.strictEqual(w.battery_power.value, 0);
  assert.strictEqual(w.pv_limit.value, 0xffff, 'feed-in cap cleared');
  // readbacks mirror the release writes (the release is verified too)
  assert.strictEqual(r.readbacks.length, 3);
  assert.strictEqual(r.readbacks.find((x) => x.role === 'control_enable').expect, 0);
});

test('Tier-3 Deye release disables Time-of-Use but stays PLANNED-ONLY (uncertified)', () => {
  const r = C.controlRelease(DEYE_SEL);
  assert.strictEqual(r.mode, 'release');
  assert.strictEqual(r.adapter, 'solarman_v5');
  assert.strictEqual(r.tier, C.CONTROL_TIER.TOU);
  assert.strictEqual(r.certified, false);
  assert.deepStrictEqual(r.writes, [], 'no live release write to a bench-pending Deye');
  assert.deepStrictEqual(r.readbacks, []);
  // the intended neutral is visible for the bench: disable ToU -> self-consumption
  assert.strictEqual(r.planned.length, 1);
  assert.strictEqual(r.planned[0].role, 'tou_enable');
  assert.strictEqual(r.planned[0].addr, C.DEYE_CONTROL_REG.hybrid_3p.touEnable);
  assert.strictEqual(r.planned[0].value, 0);
  assert.strictEqual(r.planned[0].bench_pending, true);
});

test('Tier-1 Fronius release plans idling storage + disabling curtailment (bench_pending, never executable)', () => {
  const disc = froniusDiscoveryWithStorage();
  const r = C.controlRelease(FRONIUS_SEL, { sunspec: disc });
  assert.strictEqual(r.mode, 'release');
  assert.strictEqual(r.adapter, 'fronius_sunspec');
  assert.strictEqual(r.certified, false);
  assert.deepStrictEqual(r.writes, [], 'never a live Fronius release write');
  assert.deepStrictEqual(r.readbacks, []);
  const roles = new Set(r.planned.map((w) => w.role));
  assert.ok(roles.has('battery_storage_mode'), 'StorCtl_Mod=0 planned (idle storage)');
  assert.ok(roles.has('pv_limit_enable'), 'WMaxLim_Ena=0 planned (curtailment off)');
  assert.strictEqual(r.planned.find((w) => w.role === 'battery_storage_mode').value, sunspec.STORCTL_MOD.NONE);
  assert.ok(r.planned.every((w) => w.bench_pending === true));
});

test('Fronius release is IDLE-SAFE without discovery (no fabricated address)', () => {
  const r = C.controlRelease(FRONIUS_SEL, {});
  assert.deepStrictEqual(r.planned, []);
  assert.deepStrictEqual(r.writes, []);
});

test('Tier-2 release is the self-consumption extension point (never a live write)', () => {
  const sel = { schema_version: '1.0', brand: 'sungrow', family: 'sungrow_sh',
    communication: 'modbus_tcp', control_tier: 2, connection: { ip: '10.0.0.9', port: 502 } };
  const r = C.controlRelease(sel);
  assert.strictEqual(r.adapter, 'vendor_ems');
  assert.deepStrictEqual(r.writes, []);
  assert.deepStrictEqual(r.planned, []);
});

test('controlRelease idles with no selection / no IP', () => {
  assert.strictEqual(C.controlRelease(null).adapter, 'idle');
  assert.strictEqual(C.controlRelease({ ...SUNSPEC_SEL, connection: { ip: '' } }).adapter, 'idle');
});

test('setpointStale is the dead-man check: stale past 20 min, fresh within, safe on missing ts', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  assert.strictEqual(C.setpointStale('2026-07-08T11:39:00Z', now), true, '21 min old -> stale');
  assert.strictEqual(C.setpointStale('2026-07-08T11:45:00Z', now), false, '15 min old -> fresh');
  assert.strictEqual(C.setpointStale(undefined, now), false, 'missing ts never releases');
  assert.strictEqual(C.setpointStale('nonsense', now), false, 'unparseable ts never releases');
});

// --- dual-controller awareness (evcc "only controller" rule) ------------------

test('dualControllerSignal flags a POSSIBLE conflict when a commanded register is not held', () => {
  const r = C.dualControllerSignal({ family: 'hybrid_3p', certified: true, controlEnabled: true, registerCount: 5, allMatch: false, mismatchRoles: ['battery_power'] });
  assert.strictEqual(r.onlyControllerRequired, true, 'actively controlling -> the only-controller rule applies');
  assert.strictEqual(r.possibleConflict, true);
  assert.strictEqual(r.detector, 'readback_mismatch');
  assert.match(r.reason, /einzige Controller|gegensteuern/);
  assert.match(r.reason, /battery_power/);
});

test('dualControllerSignal is quiet while control holds (all registers match)', () => {
  const r = C.dualControllerSignal({ family: 'sunspec', certified: true, controlEnabled: true, registerCount: 3, allMatch: true, mismatchRoles: [] });
  assert.strictEqual(r.onlyControllerRequired, true);
  assert.strictEqual(r.possibleConflict, false, 'holding our command -> no conflict');
  assert.strictEqual(r.reason, '');
});

test('dualControllerSignal does not apply when we are not actively controlling', () => {
  // kill-switch off, or uncertified, or nothing written -> the rule is moot.
  assert.strictEqual(C.dualControllerSignal({ certified: true, controlEnabled: false, registerCount: 3, allMatch: false }).onlyControllerRequired, false);
  assert.strictEqual(C.dualControllerSignal({ certified: false, controlEnabled: true, registerCount: 3, allMatch: false }).possibleConflict, false, 'uncertified -> never a conflict claim');
  assert.strictEqual(C.dualControllerSignal({ certified: true, controlEnabled: true, registerCount: 0, allMatch: false }).detector, 'none');
});

test('dualControllerSignal applies to the Deye Tier-3 path the same as SunSpec (generic detector)', () => {
  const deye = C.dualControllerSignal({ family: 'hybrid_3p', certified: true, controlEnabled: true, registerCount: 5, allMatch: false, mismatchRoles: ['tou_enable'] });
  const sun = C.dualControllerSignal({ family: 'sunspec', certified: true, controlEnabled: true, registerCount: 3, allMatch: false, mismatchRoles: ['tou_enable'] });
  assert.strictEqual(deye.possibleConflict, true);
  assert.strictEqual(sun.possibleConflict, true);
  assert.strictEqual(deye.detector, sun.detector, 'same generic detector regardless of vendor');
});
