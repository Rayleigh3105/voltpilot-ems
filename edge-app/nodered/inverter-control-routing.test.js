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
// A ToU-path Deye. power_scale is EXPLICIT (LV = 1): since the N1 fix a Deye with
// an UNKNOWN HV/LV scale gets NO write plan at all (see the N1 tests below), so a
// fixture that exercises the ToU mapping must state its scale like a real device.
const DEYE_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p',
  communication: 'solarman_v5', connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, power_scale: 1 },
};
// The owner's live capability probe of the SUN-30K-SG01HP3-EU (2026-07-27,
// read-only, logger 192.168.254.210:8899): 1100=0x0000, 1101=0xFFFF (the
// documented watchdog-off default), 1104=0x0000, 1105=0x0002, 1121=0x0000 - the
// PR #978 layout, so the signed power setpoint lives at 1109.
function ownersRemoteBlock(over = {}) {
  const b = new Array(22).fill(0);
  b[1101 - 1100] = 0xffff;
  b[1105 - 1100] = 0x0002;
  b[1110 - 1100] = 0x0320;
  b[1115 - 1100] = 0x03e8;
  b[1116 - 1100] = 0xffff;
  for (const k of Object.keys(over)) b[Number(k) - 1100] = over[k];
  return b;
}
// deviceType 0x0008 = ha-solarman "HV 3-Phase Inverter 20-50kw" -> power scale 10.
const OWNER_CAP = C.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: ownersRemoteBlock() });
// A remote-capable Deye selection: same device, no explicit power_scale (the remote
// path derives its scaling from RATED POWER and never touches power_scale).
const DEYE_REMOTE_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p',
  communication: 'solarman_v5', connection: { ip: '192.168.254.210', port: 8899, serial: '1127365518', mb_slave_id: 1 },
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

test('EEPROM cadence unchanged: every new lever carries dwell_s >= 900 (write-on-change)', () => {
  // The new levers (energy_pattern, solar_sell, max_sell_power) MUST NOT increase write
  // frequency - they ride the same EEPROM write-on-change discipline as the existing ops.
  const dis = C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -20, pv_limit_kw: 3 }), { ratedKw: 50 });
  for (const w of dis.planned) {
    assert.ok(w.dwell_s >= 900, w.role + ' must keep dwell_s >= 900, got ' + w.dwell_s);
  }
  for (const role of ['energy_pattern', 'solar_sell', 'max_sell_power']) {
    assert.strictEqual(dis.planned.find((w) => w.role === role).dwell_s, 900, role + ' dwell 900');
  }
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

test('N1: an UNKNOWN HV/LV scale REFUSES the whole ToU plan (never a silent 10x write)', () => {
  // THE LIVE BUG (report §2.3): power_scale "Automatisch" fell back to 1, so an HV
  // SG01HP3 was written 10x TOO LARGE - a 0,3 kW command became a ~15 kW export
  // ceiling and the plant exported 14,6 kW. Emitting the plan MINUS the power ops
  // would be just as dangerous (ToU + Export-First + Solar-Sell armed against the
  // installer's own ceiling), so the ENTIRE plan is withheld.
  const noScale = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: undefined } };
  const auto = C.controlRoute(noScale, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 });
  assert.strictEqual(auto.powerScaleConfirmed, false, 'unknown scale is surfaced, never silent');
  assert.strictEqual(auto.powerScaleSuppressed, true);
  assert.deepStrictEqual(auto.planned, [], 'NOTHING is planned while the scale is unknown');
  assert.deepStrictEqual(auto.writes, []);
  assert.deepStrictEqual(auto.readbacks, []);
  assert.match(auto.reason, /Leistungsskalierung unbest/, 'the reason names the scale');
  // Not even a CALIBRATION write gets through - the operator must state the scale
  // (or let the device probe detect it) before any live write.
  const cal = C.controlRoute(noScale, enabled({ battery_setpoint_kw: -0.3, calibration: true }), { ratedKw: 30 });
  assert.deepStrictEqual(cal.writes, [], 'calibration cannot bypass an unknown scale');
  // an explicit 0 (catalog "auto") is equally unknown
  const zero = C.controlRoute({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: 0 } }, enabled({ battery_setpoint_kw: -20 }), { ratedKw: 50 });
  assert.strictEqual(zero.powerScaleConfirmed, false);
  assert.deepStrictEqual(zero.planned, []);
});

test('N1: the DEVICE-DETECTED LV/HV class from the probe un-blocks the plan and scales it right', () => {
  // Report §9.A.1 option (a): plumb the read path's 0x0000 auto-detect into the WRITE
  // path. The executor probes it; here it arrives as opts.deye.scaleClass.
  const noScale = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: undefined } };
  const g = (r, role) => r.planned.find((w) => w.role === role).value;
  // HV (device type 0x0008 = "HV 3-Phase Inverter 20-50kw") -> scale 10 (decawatt).
  const hvCap = C.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: null });
  assert.strictEqual(hvCap.scaleClass, 10);
  const hv = C.controlRoute(noScale, enabled({ battery_setpoint_kw: -0.3 }), { ratedKw: 30, deye: hvCap });
  assert.strictEqual(hv.powerScaleConfirmed, true, 'the device answered - confirmed');
  assert.strictEqual(g(hv, 'battery_power'), 30, 'HV 0,3 kW -> 30 raw (decawatt), NOT 300');
  assert.strictEqual(g(hv, 'max_sell_power'), 30);
  // LV (device type 0x0500) -> scale 1 (native watts).
  const lvCap = C.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: null });
  assert.strictEqual(lvCap.scaleClass, 1);
  const lv = C.controlRoute(noScale, enabled({ battery_setpoint_kw: -0.3 }), { ratedKw: 12, deye: lvCap });
  assert.strictEqual(g(lv, 'battery_power'), 300, 'LV 0,3 kW -> 300 raw (watts)');
  // The operator's EXPLICIT power_scale still wins over the detected class.
  const forced = C.controlRoute({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: 1 } },
    enabled({ battery_setpoint_kw: -0.3 }), { ratedKw: 30, deye: hvCap });
  assert.strictEqual(g(forced, 'battery_power'), 300, 'explicit config beats the probe');
  assert.strictEqual(C.resolveDeyePowerScale({ power_scale: 1 }, hvCap).source, 'config');
  assert.strictEqual(C.resolveDeyePowerScale({}, hvCap).source, 'device');
  assert.strictEqual(C.resolveDeyePowerScale({}, null).source, 'fallback');
  // An unreadable device register is NOT a class - it stays unknown (never fabricated).
  assert.strictEqual(C.classifyDeyeCapability({ deviceType: null, remoteBlock: null }).scaleClass, null);
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

// =============================================================================
// Deye REMOTE MODE (Tier 2, registers 1100-1121) - the payoff of the falsification
// pass (scout data/vp-deye-approach-w8). A TRUE signed watt setpoint replacing the
// Time-of-Use hack, armed behind the inverter's OWN watchdog, touching NO installer
// setting. PROVEN present on the owner's SUN-30K-SG01HP3-EU by a live read-only
// probe (see OWNER_CAP above).
// =============================================================================

// --- capability detection ----------------------------------------------------

test('capability: the owner\'s live 1100..1121 read classifies as PRESENT, PR #978 layout', () => {
  assert.strictEqual(OWNER_CAP.present, true);
  assert.strictEqual(OWNER_CAP.layout, 'pr978', '1101=0xFFFF + 1104 in 0..2 + 1105 in 0..5 -> setpoint at 1109');
  assert.strictEqual(OWNER_CAP.supported, true);
  assert.strictEqual(OWNER_CAP.path, C.DEYE_PATH_REMOTE);
  assert.strictEqual(OWNER_CAP.watchdogRaw, C.DEYE_REMOTE_WATCHDOG_OFF, 'the documented watchdog-off default');
  assert.strictEqual(OWNER_CAP.statusRaw, 0);
  assert.strictEqual(OWNER_CAP.scaleClass, 10, 'device 0x0008 = HV 20-50 kW -> scale 10');
  assert.strictEqual(C.deyeControlPath(OWNER_CAP), C.DEYE_PATH_REMOTE);
});

test('capability: ABSENT firmware, an all-zero block and a Modbus exception all fall back to ToU', () => {
  // (a) the Akkudoktor LV "absent" signature: 1100 reads 0x0500 (out of 0..3).
  const absent = C.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: ownersRemoteBlock({ 1100: 0x0500, 1101: 0x0500 }) });
  assert.strictEqual(absent.present, false);
  assert.strictEqual(C.deyeControlPath(absent), C.DEYE_PATH_TOU);
  // (b) an ALL-ZERO answer (a logger echoing zeros for an unimplemented range) must
  //     NOT read as "present": 1101=0 is not a valid watchdog (0xFFFF or 10..18000).
  const zeros = C.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: new Array(22).fill(0) });
  assert.strictEqual(zeros.present, false, 'all-zero is not a capability');
  assert.match(zeros.reason, /nicht vorhanden/);
  // (c) a Modbus exception / unreadable block.
  const err = C.classifyDeyeCapability({ deviceType: null, remoteBlock: null, error: 'Modbus-Ausnahme 0x02', definitive: true });
  assert.strictEqual(err.present, false);
  assert.strictEqual(err.definitive, true, 'an exception is a DEFINITIVE absent');
  assert.match(err.reason, /Modbus-Ausnahme/);
  // (d) a TRANSPORT error is not definitive - it must be re-probed sooner.
  const soft = C.classifyDeyeCapability({ deviceType: null, remoteBlock: null, error: 'Timeout', definitive: false });
  assert.strictEqual(soft.definitive, false);
  // (e) a short/truncated block is never trusted.
  assert.strictEqual(C.classifyDeyeCapability({ remoteBlock: [0, 0xffff, 0] }).present, false);
});

test('capability: the older V105.1 layout is DETECTED but NOT written (AC-side semantics)', () => {
  // 1104/1105 out of range but 1106 in 0..1 and 1111 a plausible +/-1200 value.
  const b = new Array(22).fill(0);
  b[1101 - 1100] = 60; b[1104 - 1100] = 9; b[1105 - 1100] = 9; b[1106 - 1100] = 1; b[1111 - 1100] = 0xff9c; // -100
  const cap = C.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: b });
  assert.strictEqual(cap.present, true);
  assert.strictEqual(cap.layout, 'v105_1');
  assert.strictEqual(cap.supported, false, 'we do not write an unproven AC-side setpoint');
  assert.strictEqual(C.deyeControlPath(cap), C.DEYE_PATH_TOU, 'falls back to ToU rather than guessing');
  assert.match(cap.reason, /nicht batterieseitig/);
});

test('capability: the probe spec is READS ONLY, and only for battery families', () => {
  const spec = C.deyeCapabilityProbeSpec('hybrid_3p');
  assert.deepStrictEqual(spec.reads, [
    { role: 'device_type', addr: 0x0000, count: 1 },
    { role: 'remote_block', addr: 0x044c, count: 22 },
  ]);
  assert.strictEqual(C.deyeCapabilityProbeSpec('hybrid_1p').reads.length, 2);
  assert.strictEqual(C.deyeCapabilityProbeSpec('string'), null, 'no battery -> no remote-mode probe');
  assert.strictEqual(C.deyeCapabilityProbeSpec('micro'), null);
  // every Deye plan carries it so the executor always knows what to read
  assert.ok(C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -5 }), { ratedKw: 30 }).capabilityProbe);
  assert.strictEqual(C.deyeCapabilityKey(' 192.168.254.210 ', 0), 'deye_cap:192.168.254.210:8899');
  assert.strictEqual(C.deyeCapabilityKey('10.0.0.1', 8000), 'deye_cap:10.0.0.1:8000');
});

// --- the kW <-> register conversion (a slip here is a 10x command) -----------

test('remote: the setpoint is -round(kw / ratedKw * 1000), from the CATALOG rating', () => {
  const u = (kw, rated) => C.deyeRemoteSetpointUnits(kw, rated).units;
  // The wiki's own worked example: charge 3 kW on a 20 kW inverter -> -150.
  assert.strictEqual(u(3, 20), -150);
  // The owner's 30 kW unit: 1 kW = 33 units (~30 W resolution). OUR contract is
  // + = charge, the Deye register is - = charge, so the sign FLIPS.
  assert.strictEqual(u(1, 30), -33, 'charge 1 kW -> -33');
  assert.strictEqual(u(-1, 30), 33, 'discharge 1 kW -> +33');
  assert.strictEqual(u(0, 30), 0);
  // Rated power is what makes the SAME kW a different register on a different unit.
  assert.strictEqual(u(-10, 30), 333);
  assert.strictEqual(u(-10, 12), 833);
  assert.strictEqual(u(-10, 50), 200);
  // Clamped to the documented +/-1200 (= +/-120 % of rated), both directions.
  assert.strictEqual(u(-99, 30), 1200);
  assert.strictEqual(u(99, 30), -1200);
  assert.strictEqual(C.deyeRemoteSetpointUnits(-99, 30).clamped, true);
  assert.strictEqual(C.deyeRemoteSetpointUnits(-1, 30).clamped, false);
  // Negative units encode as two's complement in the u16 register.
  assert.strictEqual(C.deyeRemoteSetpointUnits(3, 20).raw, 0xff6a);
  assert.strictEqual(C.deyeRemoteSetpointUnits(-1, 30).raw, 33);
  // No rating -> not computable (ok:false); we never guess a nameplate.
  assert.strictEqual(C.deyeRemoteSetpointUnits(-1, 0).ok, false);
  assert.strictEqual(C.deyeRemoteSetpointUnits(NaN, 30).ok, false);
});

// --- the write plan ----------------------------------------------------------

function remotePlan(sp, opts = {}) {
  return C.controlRoute(DEYE_REMOTE_SEL, { source: 'schedule', control_enabled: true, ...sp },
    { ratedKw: 30, deye: OWNER_CAP, ...opts });
}

test('remote: the write ORDER is watchdog FIRST, enable LAST', () => {
  const r = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20, soc_max_pct: 95 });
  assert.strictEqual(r.controlPath, C.DEYE_PATH_REMOTE);
  assert.deepStrictEqual(r.planned.map((w) => w.role), [
    'remote_watchdog', 'power_control_mode', 'battery_strategy', 'battery_soc_belt',
    'battery_power', 'remote_mode',
  ]);
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  // 1) the dead-man's switch is armed BEFORE anything can move
  assert.strictEqual(p.remote_watchdog.addr, C.DEYE_REMOTE_REG.watchdog); // 0x044D / 1101
  assert.strictEqual(p.remote_watchdog.value, C.DEYE_REMOTE_WATCHDOG_DEFAULT_S);
  // 2) BATTERY-side (AC-/grid-side would throttle PV)
  assert.strictEqual(p.power_control_mode.addr, C.DEYE_REMOTE_REG.powerControlMode); // 0x0450 / 1104
  assert.strictEqual(p.power_control_mode.value, C.DEYE_POWER_CONTROL_MODE.BATTERY_SIDE);
  // 3) Power+SOC because a belt is known
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER_SOC);
  // 4) the on-device SoC belt: a DISCHARGE is bounded by the floor
  assert.strictEqual(p.battery_soc_belt.addr, C.DEYE_REMOTE_REG.constantSoc); // 0x0454 / 1108
  assert.strictEqual(p.battery_soc_belt.value, 20);
  assert.strictEqual(p.battery_soc_belt.encode.direction, 'discharge_floor');
  // 5) the signed setpoint
  assert.strictEqual(p.battery_power.addr, C.DEYE_REMOTE_REG.constantPower); // 0x0455 / 1109
  assert.strictEqual(p.battery_power.value, 33);
  // 6) ACTIVATION last
  assert.strictEqual(r.planned[r.planned.length - 1].role, 'remote_mode');
  assert.strictEqual(p.remote_mode.addr, C.DEYE_REMOTE_REG.mode); // 0x044C / 1100
  assert.strictEqual(p.remote_mode.value, C.DEYE_REMOTE_MODE.ON);
  // FC16 (write-multiple) - the only function code this firmware answers.
  assert.ok(r.planned.every((w) => w.fc === C.DEYE_WRITE_FC_FC16));
});

test('remote: a CHARGE flips the sign and bounds itself with the SoC CEILING', () => {
  const r = remotePlan({ battery_setpoint_kw: 3, soc_min_pct: 20, soc_max_pct: 90 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_power.value & 0xffff, C.deyeRemoteSetpointUnits(3, 30).raw);
  assert.strictEqual(p.battery_power.encode.units, -100, 'charge 3 kW of 30 kW -> -100');
  assert.strictEqual(p.battery_soc_belt.value, 90);
  assert.strictEqual(p.battery_soc_belt.encode.direction, 'charge_ceiling');
});

test('remote: NO SoC belt -> plain Power strategy (2) and no 1108 write', () => {
  const r = remotePlan({ battery_setpoint_kw: -1 }); // no soc_min/soc_max on the setpoint
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(p.battery_soc_belt, undefined);
});

test('remote: EVERY op is RAM cadence - dwell 0, always re-asserted (the watchdog kick)', () => {
  const r = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20 });
  for (const w of r.planned) {
    assert.strictEqual(w.dwell_s, 0, w.role + ' must not carry an EEPROM dwell');
    assert.strictEqual(w.min_change, 0, w.role);
    assert.strictEqual(w.always, true, w.role + ' must be re-asserted every tick');
  }
  // and NOTHING is snapshotted: the remote path touches no installer setting.
  assert.strictEqual(r.snapshotPlan, undefined, 'no snapshot/restore on the remote path');
});

test('remote: the plan touches ONLY the 1100-1121 block - no installer register', () => {
  const r = remotePlan({ battery_setpoint_kw: -1, pv_limit_kw: 12, soc_min_pct: 20 });
  for (const w of r.planned) {
    assert.ok(w.addr >= 0x044c && w.addr <= 0x0461, 'addr 0x' + w.addr.toString(16) + ' outside the remote block');
  }
  const tou = C.DEYE_CONTROL_REG.hybrid_3p;
  for (const installer of [tou.energyPattern, tou.workMode, tou.solarSell, tou.maxSellPower, tou.touEnable, tou.exportLimit]) {
    assert.strictEqual(r.planned.find((w) => w.addr === installer), undefined, 'installer register 0x' + installer.toString(16) + ' must never be written');
  }
  // curtailment is honestly reported as unsupported here, never silently dropped
  assert.strictEqual(r.pvLimitSupported, false);
  assert.strictEqual(r.pvLimitKw, 12);
  assert.match(r.pvLimitNote, /PV-Begrenzung/);
});

test('remote: readbacks cover 1109 + 1100 (kW-decoded), and 1121 is an OBSERVATION', () => {
  const r = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20, calibration: true });
  const rb = Object.fromEntries(r.readbacks.map((o) => [o.role, o]));
  assert.strictEqual(rb.battery_power.addr, C.DEYE_REMOTE_REG.constantPower);
  assert.strictEqual(rb.battery_power.expect, 33);
  assert.strictEqual(rb.battery_power.tolerance, 1);
  assert.deepStrictEqual(rb.battery_power.decode, { kind: 'remote_power_permille', rated_kw: 30 });
  assert.strictEqual(rb.remote_mode.addr, C.DEYE_REMOTE_REG.mode);
  assert.strictEqual(rb.remote_mode.expect, 1);
  // 1121 is READ-ONLY: it is not a commanded value, so it must NEVER sit in the
  // commanded-vs-actual list (it would fabricate or break all_match).
  assert.strictEqual(rb.remote_status, undefined);
  assert.deepStrictEqual(r.observations, [{ role: 'remote_status', fc: 3, addr: C.DEYE_REMOTE_REG.status }]);
});

test('remote: the setpoint is the guard-clamped kW - the adapter never widens it', () => {
  // Whatever the core's guard chain hands us IS the command. The only extra bound is
  // the register's own +/-1200, which can only ever REDUCE the magnitude.
  for (const kw of [-30, -12.5, -0.03, 0, 0.03, 12.5, 30, 45]) {
    const r = remotePlan({ battery_setpoint_kw: kw, soc_min_pct: 10, soc_max_pct: 95 });
    const units = r.planned.find((w) => w.role === 'battery_power').encode.units;
    const want = Math.abs(Math.round(-(kw / 30) * 1000));
    assert.ok(Math.abs(units) <= Math.max(want, 0), 'never larger than the commanded magnitude for ' + kw);
    assert.ok(Math.abs(units) <= C.DEYE_REMOTE_SETPOINT_LIMIT);
    if (kw !== 0) assert.strictEqual(Math.sign(units), -Math.sign(kw), 'sign convention holds for ' + kw);
  }
});

test('remote: an unknown model rating REFUSES the plan (a wrong rating IS a scale error)', () => {
  const r = C.controlRoute(DEYE_REMOTE_SEL, { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true }, { deye: OWNER_CAP });
  assert.strictEqual(r.controlPath, C.DEYE_PATH_REMOTE);
  assert.deepStrictEqual(r.planned, []);
  assert.deepStrictEqual(r.writes, []);
  assert.match(r.reason, /Nennleistung/);
});

test('remote: the watchdog is configurable and clamped to the documented [10, 18000] s', () => {
  const wd = (v) => C.resolveDeyeRemoteWatchdog({ remote_watchdog_s: v });
  assert.strictEqual(wd(undefined), 60, 'default 60 s = ~6 setpoint ticks of slack');
  assert.strictEqual(wd(120), 120);
  assert.strictEqual(wd(10), 10);
  assert.strictEqual(wd(18000), 18000);
  assert.strictEqual(wd(5), 60, 'below the documented minimum -> default, never a too-tight watchdog');
  assert.strictEqual(wd(99999), 60);
  assert.strictEqual(wd(0xffff), 60, 'config can NEVER disable the watchdog');
  const r = remotePlan({ battery_setpoint_kw: -1 }, {});
  assert.strictEqual(r.remote.watchdog_s, 60);
  const tuned = C.controlRoute({ ...DEYE_REMOTE_SEL, connection: { ...DEYE_REMOTE_SEL.connection, remote_watchdog_s: 120 } },
    { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true }, { ratedKw: 30, deye: OWNER_CAP });
  assert.strictEqual(tuned.planned.find((w) => w.role === 'remote_watchdog').value, 120);
});

test('remote: invert_control_sign stays CONFIGURATION - it flips the register, not the code', () => {
  const flipped = C.controlRoute({ ...DEYE_REMOTE_SEL, connection: { ...DEYE_REMOTE_SEL.connection, invert_control_sign: true } },
    { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true }, { ratedKw: 30, deye: OWNER_CAP });
  assert.strictEqual(flipped.planned.find((w) => w.role === 'battery_power').encode.units, -33);
});

// --- gates -------------------------------------------------------------------

test('remote: Deye stays UNCERTIFIED - no executable write in production', () => {
  const r = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20 });
  assert.strictEqual(r.certified, false);
  assert.deepStrictEqual(r.writes, [], 'planned only until the bench pass');
  assert.deepStrictEqual(r.readbacks, []);
  assert.ok(r.planned.length > 0, 'the intended plan is still surfaced for the bench');
  assert.match(r.reason, /noch nicht freigegeben/);
  // First-Light calibration is the ONE bypass (certification only).
  const cal = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20, calibration: true });
  assert.strictEqual(cal.writes.length, cal.planned.length);
  assert.strictEqual(cal.readbacks.length, cal.writes.length);
  assert.ok(cal.writes.every((w) => w.bench_pending === undefined));
  // ...and the global kill-switch STILL wins over it.
  const killed = C.controlRoute(DEYE_REMOTE_SEL, { battery_setpoint_kw: -1, source: 'calibration', control_enabled: false, calibration: true }, { ratedKw: 30, deye: OWNER_CAP });
  assert.deepStrictEqual(killed.writes, []);
});

test('remote: no capability yet -> the legacy ToU path (byte-identical to before)', () => {
  const sp = { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true };
  const unprobed = C.controlRoute(DEYE_SEL, sp, { ratedKw: 50 });
  assert.strictEqual(unprobed.controlPath, C.DEYE_PATH_TOU);
  assert.ok(unprobed.planned.find((w) => w.role === 'tou_enable'), 'the ToU plan is what runs');
  // an ABSENT capability is the same
  const absent = C.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: new Array(22).fill(0) });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(C.controlRoute(DEYE_SEL, sp, { ratedKw: 50, deye: absent }).planned)),
    JSON.parse(JSON.stringify(unprobed.planned)),
  );
});

test('remote: the operator can force the ToU path with remote_mode: off', () => {
  const off = C.controlRoute({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, remote_mode: 'off' } },
    { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true }, { ratedKw: 50, deye: OWNER_CAP });
  assert.strictEqual(off.controlPath, C.DEYE_PATH_TOU);
  assert.ok(off.planned.find((w) => w.role === 'tou_enable'));
});

// --- release -----------------------------------------------------------------

test('remote release: 1100 <- 0 hands control back, and NOTHING is restored', () => {
  const rel = C.controlRelease(DEYE_REMOTE_SEL, { calibration: true, deye: OWNER_CAP });
  assert.strictEqual(rel.mode, 'release');
  assert.strictEqual(rel.controlPath, C.DEYE_PATH_REMOTE);
  assert.strictEqual(rel.writes.length, 1, 'one write: disable remote mode');
  assert.strictEqual(rel.writes[0].role, 'remote_mode');
  assert.strictEqual(rel.writes[0].addr, C.DEYE_REMOTE_REG.mode);
  assert.strictEqual(rel.writes[0].value, C.DEYE_REMOTE_MODE.OFF);
  assert.strictEqual(rel.writes[0].always, true, 'a hand-back is never skipped by write-on-change');
  assert.strictEqual(rel.writes[0].dwell_s, 0);
  assert.strictEqual(rel.readbacks.length, 1);
  // no ToU register is touched on the way out either
  const tou = C.DEYE_CONTROL_REG.hybrid_3p;
  assert.strictEqual(rel.planned.find((w) => w.addr === tou.touEnable), undefined);
  // uncertified + not a calibration revert -> planned only, exactly like the ToU path
  assert.deepStrictEqual(C.controlRelease(DEYE_REMOTE_SEL, { deye: OWNER_CAP }).writes, []);
});

test('remote release: a LEFTOVER ToU snapshot is still restored, AFTER remote is disabled', () => {
  // A device that was controlled over ToU before its firmware gained remote mode
  // (or before we probed) may still hold installer registers we changed. Disable
  // remote FIRST (immediate hand-back), restore the installer's values after.
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  const snapshot = { [reg.maxSellPower]: 8000, [reg.touEnable]: 0 };
  const rel = C.controlRelease(DEYE_REMOTE_SEL, { calibration: true, deye: OWNER_CAP, snapshot });
  assert.strictEqual(rel.writes[0].role, 'remote_mode', 'remote off FIRST');
  const roles = rel.writes.map((w) => w.role);
  assert.ok(roles.includes('max_sell_power'));
  assert.strictEqual(roles[roles.length - 1], 'tou_enable', 'the ToU activation is restored LAST');
});

test('remote release: with remote ABSENT the release is byte-identical to the ToU release', () => {
  const absent = C.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: new Array(22).fill(0) });
  const withCap = C.controlRelease(DEYE_SEL, { calibration: true, deye: absent });
  const without = C.controlRelease(DEYE_SEL, { calibration: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(withCap)), JSON.parse(JSON.stringify(without)));
  assert.strictEqual(withCap.writes[0].role, 'tou_enable');
});
