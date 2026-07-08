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

const SUNSPEC_SEL = {
  schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
  communication: 'modbus_tcp', connection: { ip: '10.0.0.5', port: 502, unit_id: 1 },
};
const DEYE_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p',
  communication: 'solarman_v5', connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 },
};

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
  assert.strictEqual(p.work_mode.addr, reg.workMode); // 0x00F4
  assert.strictEqual(p.tou_enable.addr, reg.touEnable); // 0x00F8
  assert.strictEqual(p.battery_power.addr, reg.progPowerBase); // 0x0100
  assert.strictEqual(p.battery_power.value, 6000);
  assert.strictEqual(p.battery_target_soc.addr, reg.progSocBase); // 0x010C
  assert.strictEqual(p.grid_charge_enable.addr, reg.progChargeBase); // 0x0112
  // 1p feed-in cap maps to Max Sell Power (0x00F5, scale 1): 4 kW -> 4000
  assert.strictEqual(p.pv_limit.addr, reg.exportLimit);
  assert.strictEqual(p.pv_limit.value, 4000);
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

test('CERTIFIED_CONTROL_FAMILIES contains sunspec but no Deye family', () => {
  assert.ok(C.CERTIFIED_CONTROL_FAMILIES.has('sunspec'));
  for (const f of ['hybrid_3p', 'hybrid_1p', 'string', 'micro']) {
    assert.ok(!C.CERTIFIED_CONTROL_FAMILIES.has(f), f + ' must stay uncertified');
  }
});
