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
