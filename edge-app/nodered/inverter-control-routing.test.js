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
// A DEFINITIVE "no remote mode" verdict (the Akkudoktor LV absent signature: 1100
// reads the device's own 0x0500, out of the 0..3 mode range). Since the deliberate-
// fallback gate, a CERTIFIED device's ToU writes engage only on such a definitive
// verdict (or remote_mode='off' / a calibration test) - never on a failed probe.
const TOU_CAP = C.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: ownersRemoteBlock({ 1100: 0x0500, 1101: 0x0500 }) });
// The same definitive-absent verdict WITHOUT a scale class (unreadable block, no
// error): for tests that pin the N1 unknown-scale refusal on a certified device.
const TOU_CAP_NOSCALE = C.classifyDeyeCapability({ deviceType: null, remoteBlock: null });
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
  // The routine read-only case is LEGITIMATELY quiet - it must NOT be flagged
  // blocked, so the executor stays silent for it (Defect 2 distinguishes the two).
  assert.notStrictEqual(r.blocked, true, 'an uncertified read-only plan is quiet, not blocked');
});

// Defect 2 also on the kill-switch quiet case: a Not-Aus refusal is not "blocked".
test('kill-switch: an off (Not-Aus) plan is quiet, never flagged blocked', () => {
  const r = C.controlRoute(SUNSPEC_SEL, { battery_setpoint_kw: -4, source: 'schedule', control_enabled: false });
  assert.notStrictEqual(r.blocked, true);
});

test('un-gate: Deye writes/readbacks are gated ONLY by the certification allowlist (generic gate)', () => {
  const sp = enabled({ battery_setpoint_kw: -20 });
  const off = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30 });
  assert.deepStrictEqual(off.writes, [], 'default: uncertified -> no writes');
  assert.deepStrictEqual(off.readbacks, []);
  assert.ok(off.planned.length >= 5, 'the real ToU plan is always in planned[]');
  // Certifying the family (a bench pass) is the ONLY thing that turns writes on -
  // NO code change. This IS the un-gate. Restored immediately so the production
  // default stays read-only. The DELIBERATE-fallback gate additionally requires a
  // definitive "no remote mode" capability verdict before certified ToU writes
  // engage (deye: TOU_CAP) - a certified device never EEPROM-writes on a guess.
  C.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
  try {
    const on = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: TOU_CAP });
    assert.strictEqual(on.certified, true);
    assert.strictEqual(on.writes.length, off.planned.length, 'writes == the planned ToU ops');
    assert.strictEqual(on.readbacks.length, on.writes.length, 'a readback per written register');
    assert.ok(on.writes.every((w) => w.bench_pending === undefined), 'executable writes are not bench_pending markers');
    // The kill-switch still gates independently: certified but control_enabled=false
    // writes NOTHING (two-gate discipline, identical to sunspecControl).
    const killed = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: -20, source: 'schedule', control_enabled: false }, { ratedKw: 30, deye: TOU_CAP });
    assert.deepStrictEqual(killed.writes, [], 'certified + kill-switch off -> still no writes');
    assert.deepStrictEqual(killed.readbacks, []);
  } finally {
    C.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
  }
  assert.deepStrictEqual(C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: TOU_CAP }).writes, [], 'production default is read-only again');
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

// The release path used to carry NO controlEnabled at all, so the exec node's
// `!!ctrl.controlEnabled` stamped a hard false (`!!undefined`) on every release
// readback - a structural lie, not an observation. On the live pilot that release
// readback was the LAST one the cloud saw after each First-Light auto-revert, and
// the portal reported "Steuerung ausgeschaltet" forever. The heartbeat now sources
// the flag from the CORE (agent.controlSummary), and the readback itself must stop
// lying too: every controlRelease result carries the flag through, on every branch.
test('controlRelease carries controlEnabled through on every branch (never !!undefined)', () => {
  const branches = [
    ['idle (no selection)', null, {}],
    ['idle (no ip)', { ...DEYE_SEL, connection: {} }, {}],
    ['Deye ToU', DEYE_SEL, { calibration: true }],
    ['Deye remote', DEYE_REMOTE_SEL, { calibration: true, deye: OWNER_CAP }],
    ['SunSpec', SUNSPEC_SEL, {}],
    ['Fronius', FRONIUS_SEL, {}],
    ['vendor EMS', { ...SUNSPEC_SEL, control_tier: 2 }, {}],
  ];
  for (const [what, sel, opts] of branches) {
    const on = C.controlRelease(sel, { ...opts, controlEnabled: true });
    assert.strictEqual(on.controlEnabled, true, what + ': controlEnabled must be carried through');
    const off = C.controlRelease(sel, { ...opts, controlEnabled: false });
    assert.strictEqual(off.controlEnabled, false, what + ': an off gate stays off');
    // Absent = false (the honest default: no core setpoint drove this hand-back,
    // e.g. the crash-recovery restore) - but a REAL boolean, never undefined.
    const bare = C.controlRelease(sel, opts);
    assert.strictEqual(bare.controlEnabled, false, what + ': absent opts -> a real false');
    assert.ok('controlEnabled' in bare, what + ': the key must exist');
  }
});

// Reporting must never widen a gate: carrying controlEnabled changes the reported
// flag only - the write/readback gating stays the certification (or calibration
// bypass) decision it always was.
test('controlRelease controlEnabled does not gate the release writes', () => {
  const gatedOn = C.controlRelease(DEYE_SEL, { controlEnabled: true });
  assert.deepStrictEqual(gatedOn.writes, [], 'an uncertified family stays planned-only');
  const cal = C.controlRelease(DEYE_SEL, { calibration: true, controlEnabled: false });
  assert.strictEqual(cal.writes.length, 1, 'the calibration hand-back still executes');
});

// =============================================================================
// The PER-DEVICE First-Light grant (setpoint.device_certified) - the second half
// of the certification gate.
//
// The core holds an evidence-gated per-device release (Agent.controlCertified =
// the env family allowlist MERGED with the persisted First-Light grant) and now
// carries it on edge/setpoint. Before that, the executor ran the STATIC family
// allowlist alone, so on a RELEASED pilot the Fahrplan computed
// `controlEnabled && (false || false)` and emitted writes:[] forever - only the
// calibration bypass ever wrote. These tests pin the fix AND that it widened
// nothing else.
// =============================================================================

test('device grant: a released Deye executes the FAHRPLAN write plan (the blocker)', () => {
  // The exact live shape: a normal (NON-calibration) schedule setpoint on the
  // pilot family, with the runtime grant the core earned via First-Light. The ToU
  // path additionally needs the definitive "no remote mode" verdict (TOU_CAP) -
  // the deliberate-fallback gate never EEPROM-writes a certified device on a guess.
  const sp = { battery_setpoint_kw: -20, source: 'schedule', slot_start: '2026-07-27T19:45:00Z', control_enabled: true, device_certified: true };

  // (a) Without the grant this is byte-for-byte the old read-only behaviour.
  const noGrant = C.controlRoute(DEYE_SEL, { ...sp, device_certified: false }, { ratedKw: 30, deye: TOU_CAP });
  assert.deepStrictEqual(noGrant.writes, [], 'no grant -> no writes (unchanged)');
  assert.deepStrictEqual(noGrant.readbacks, []);
  assert.strictEqual(noGrant.certified, false);
  assert.match(noGrant.reason, /noch nicht freigegeben/);
  // An ABSENT field must behave identically (backward compatibility: an older core).
  const absent = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true }, { ratedKw: 30, deye: TOU_CAP });
  assert.deepStrictEqual(absent.writes, [], 'absent device_certified == no grant');

  // (b) With the grant the SAME plan becomes executable - and it is the real ToU
  //     plan, not a reduced one: writes == planned, one readback per register.
  const granted = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: TOU_CAP });
  assert.strictEqual(granted.certified, true, 'the runtime grant certifies THIS device');
  assert.strictEqual(granted.calibration, false, 'this is the plan path, not a calibration test');
  assert.ok(granted.writes.length >= 5, 'the Fahrplan write plan is executable');
  assert.strictEqual(granted.writes.length, granted.planned.length, 'writes == the planned ToU ops');
  assert.strictEqual(granted.readbacks.length, granted.writes.length, 'a readback per written register');
  assert.strictEqual(granted.reason, undefined, 'no gate reason when the gate is open');
  // The grant does NOT turn a plan write into a calibration write: the EEPROM
  // write-on-change cadence is untouched (dwell_s stays the optimizer cadence).
  const bp = granted.writes.find((w) => w.role === 'battery_power');
  assert.strictEqual(bp.dwell_s, 900, 'a Fahrplan write keeps the EEPROM dwell');
  // ACTIVATION IS STILL LAST (the load-bearing order is not touched by the gate).
  assert.strictEqual(granted.writes[granted.writes.length - 1].role, 'tou_enable');

  // (c) The static fleet allowlist was NOT widened by any of this.
  assert.ok(!C.CERTIFIED_CONTROL_FAMILIES.has('hybrid_3p'), 'the fleet allowlist stays {sunspec}');
});

test('device grant: REMOTE MODE - the full ordered Fahrplan plan, enable LAST', () => {
  const sp = { battery_setpoint_kw: -1, source: 'schedule', slot_start: '2026-07-27T20:00:00Z', control_enabled: true, device_certified: true, soc_min_pct: 20, soc_max_pct: 95 };
  const r = C.controlRoute(DEYE_REMOTE_SEL, sp, { ratedKw: 30, deye: OWNER_CAP });
  assert.strictEqual(r.controlPath, C.DEYE_PATH_REMOTE);
  assert.strictEqual(r.certified, true);
  assert.strictEqual(r.calibration, false, 'a normal setpoint, no calibration bypass involved');
  // The complete remote-mode write plan in the load-bearing order: the dead-man's
  // switch is armed FIRST, activation is LAST. Nothing about the order, the
  // register set or the RAM cadence is a function of HOW the gate was opened.
  assert.deepStrictEqual(r.writes.map((w) => w.role),
    ['remote_watchdog', 'power_control_mode', 'battery_strategy', 'battery_power', 'remote_mode']);
  assert.strictEqual(r.writes[0].addr, C.DEYE_REMOTE_REG.watchdog, 'watchdog 1101 first');
  assert.strictEqual(r.writes[r.writes.length - 1].addr, C.DEYE_REMOTE_REG.mode, 'enable 1100 last');
  assert.strictEqual(r.writes[r.writes.length - 1].value, 1);
  assert.ok(r.writes.every((w) => w.dwell_s === 0), 'RAM cadence: no EEPROM dwell anywhere on this path');
  assert.ok(r.writes.filter((w) => ['remote_watchdog', 'battery_power', 'remote_mode'].includes(w.role)).every((w) => w.always === true),
    'the watchdog kick / the command / the enable re-assert every tick');
  assert.strictEqual(r.readbacks.length, r.writes.length, 'a readback per commanded register');
  // -1 kW of 30 kW rated -> +33 units (our + = charge is NEGATED into the register).
  assert.strictEqual(r.writes.find((w) => w.role === 'battery_power').value, 33);

  // Byte-for-byte unchanged without the grant.
  const noGrant = C.controlRoute(DEYE_REMOTE_SEL, { ...sp, device_certified: false }, { ratedKw: 30, deye: OWNER_CAP });
  assert.deepStrictEqual(noGrant.writes, [], 'no grant -> no writes');
  assert.deepStrictEqual(noGrant.readbacks, []);
  assert.match(noGrant.reason, /noch nicht freigegeben/);
});

test('device grant: the kill-switch is STILL the outer AND (Not-Aus stops a released device dead)', () => {
  for (const [what, sel, opts, readbacksGated] of [
    ['ToU', DEYE_SEL, { ratedKw: 30 }, true],
    ['remote', DEYE_REMOTE_SEL, { ratedKw: 30, deye: OWNER_CAP }, true],
    // SunSpec deliberately KEEPS its readbacks when writes are gated, so the UI
    // still shows the inverter's ACTUAL state (module header) - unchanged here.
    ['SunSpec', SUNSPEC_SEL, {}, false],
  ]) {
    const killed = C.controlRoute(sel, { battery_setpoint_kw: -5, source: 'schedule', control_enabled: false, device_certified: true }, opts);
    assert.deepStrictEqual(killed.writes, [], what + ': kill-switch off -> no writes despite the grant');
    if (readbacksGated) assert.deepStrictEqual(killed.readbacks, [], what + ': and no readbacks');
    assert.match(killed.reason, /Not-Aus/, what + ': and it is reported as the Not-Aus, not as "not released"');
  }
});

test('device grant: a released device can also be HANDED BACK (controlRelease)', () => {
  // Load-bearing asymmetry check: whatever may be DRIVEN must be releasable, or a
  // released device would start controlling and never hand back on a kill-off.
  const plain = C.controlRelease(DEYE_SEL, {});
  assert.deepStrictEqual(plain.writes, [], 'no grant -> planned-only (unchanged)');

  const rel = C.controlRelease(DEYE_SEL, { deviceCertified: true, controlEnabled: false });
  assert.strictEqual(rel.mode, 'release');
  assert.strictEqual(rel.certified, true);
  assert.strictEqual(rel.writes.length, 1, 'the neutral ToU-disable executes');
  assert.strictEqual(rel.writes[0].role, 'tou_enable');
  assert.strictEqual(rel.writes[0].value, 0);
  // The remote path's release is the trivial 1100 <- 0.
  const remoteRel = C.controlRelease(DEYE_REMOTE_SEL, { deviceCertified: true, deye: OWNER_CAP });
  assert.strictEqual(remoteRel.controlPath, C.DEYE_PATH_REMOTE);
  assert.strictEqual(remoteRel.writes.length, 1);
  assert.strictEqual(remoteRel.writes[0].role, 'remote_mode');
  assert.strictEqual(remoteRel.writes[0].value, 0, 'remote mode OFF - control handed back');
  // controlEnabled is still only REPORTED, never a release gate (a kill-off release
  // must execute precisely when control_enabled is false).
  assert.strictEqual(remoteRel.controlEnabled, false);
});

test('device grant: only an explicit boolean true opens the gate', () => {
  // A truthy-but-not-true value must never be read as a grant (the field crosses a
  // JSON boundary, and this gate ends in a live write to a customer battery).
  for (const v of [undefined, null, false, 0, 1, 'true', 'yes', {}, []]) {
    const r = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: -5, source: 'schedule', control_enabled: true, device_certified: v }, { ratedKw: 30 });
    assert.deepStrictEqual(r.writes, [], 'device_certified=' + JSON.stringify(v) + ' must not certify');
  }
  assert.strictEqual(C.deviceGrant({ device_certified: true }), true);
  assert.strictEqual(C.deviceGrant({ device_certified: 'true' }), false);
  assert.strictEqual(C.deviceGrant(null), false);
});

test('device grant: does NOT leak to other devices or families', () => {
  // The grant lives on the SETPOINT, so it is scoped to the device the core
  // published it for. A different family reading the same allowlist is unaffected,
  // and an unrelated Fronius stays planned-only whatever the setpoint says.
  const sp = { battery_setpoint_kw: -3, source: 'schedule', control_enabled: true, device_certified: true };
  const fronius = C.controlRoute(FRONIUS_SEL, sp, {});
  assert.deepStrictEqual(fronius.writes, [], 'Fronius has no executor path - never a live write');
  assert.deepStrictEqual(fronius.readbacks, []);
  // And the module-level allowlist is untouched by any number of granted setpoints.
  C.controlRoute(DEYE_SEL, sp, { ratedKw: 30 });
  assert.deepStrictEqual([...C.CERTIFIED_CONTROL_FAMILIES], ['sunspec'], 'the fleet allowlist is never mutated');
  assert.deepStrictEqual(C.controlRoute(DEYE_SEL, { ...sp, device_certified: false }, { ratedKw: 30 }).writes, [],
    'the next ungranted device is read-only again');
});

test('device grant: an unproven register map is still refused (N1 scale + unknown nameplate)', () => {
  // The grant opens the CERTIFICATION gate only. Every other refusal that protects
  // a real inverter from a wrong write survives it.
  const noScale = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, power_scale: undefined } };
  const n1 = C.controlRoute(noScale, { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, device_certified: true }, { ratedKw: 30, deye: TOU_CAP_NOSCALE });
  assert.deepStrictEqual(n1.writes, [], 'an unconfirmed HV/LV scale still withholds the whole plan');
  assert.strictEqual(n1.powerScaleSuppressed, true);
  assert.strictEqual(n1.blocked, true);
  // Remote mode without a known nameplate cannot compute the setpoint -> refuse.
  const noRating = C.controlRoute(DEYE_REMOTE_SEL, { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, device_certified: true }, { deye: OWNER_CAP });
  assert.deepStrictEqual(noRating.writes, [], 'unknown rated power still refuses');
  assert.strictEqual(noRating.blocked, true);
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
  assert.strictEqual(auto.blocked, true, 'a scale-suppressed refusal must be flagged blocked (Defect 2)');
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
  // The limit is ONE FC16 block over the discovered Model-123 span; `parts`
  // names the five registers inside it.
  const blk = r.planned.find((w) => w.role === 'pv_limit_block');
  assert.ok(blk, 'the curtailment block is planned');
  assert.strictEqual(blk.fc, 16);
  assert.strictEqual(blk.addr, disc.controls.wMaxLimPctAddr);
  // 6 kW cap of a 12 kW nameplate -> 50 %, register scale SF -2 -> raw 5000.
  assert.deepStrictEqual(blk.values, [5000, 0, sunspec.DEFAULT_RVRT_TMS, 0, sunspec.WMAX_LIM_ENA.ENABLED]);
  const p = Object.fromEntries(blk.parts.map((w) => [w.role, w]));
  assert.strictEqual(p.pv_limit_enable.addr, disc.controls.wMaxLimEnaAddr);
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
  const blk = r.planned.find((w) => w.role === 'pv_limit_block');
  const p = Object.fromEntries(blk.parts.map((w) => [w.role, w]));
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
  assert.ok(roles.has('pv_limit_block'), 'curtailment still planned');
  assert.ok(roles.has('battery_in_rate'), 'storage planned');
  assert.ok(r.planned.every((w) => w.bench_pending === true));
});

test('Fronius storage is IDLE-SAFE when Model 124 is absent (no battery / no discovery)', () => {
  // Discovery WITHOUT storage: Model 123 present -> only curtailment planned, no storage ops.
  const noStore = C.controlRoute(FRONIUS_SEL, enabled({ battery_setpoint_kw: 5, pv_limit_kw: 6 }), { sunspec: froniusDiscovery() });
  const roles = new Set(noStore.planned.map((w) => w.role));
  assert.ok(roles.has('pv_limit_block'), 'curtailment still planned');
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
  const relBlk = r.planned.find((w) => w.role === 'pv_limit_block');
  assert.ok(relBlk, 'the curtailment release block is planned');
  assert.strictEqual(relBlk.parts.find((w) => w.role === 'pv_limit_enable').value, sunspec.WMAX_LIM_ENA.DISABLED,
    'WMaxLim_Ena=0 planned (curtailment off)');
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
  // (b) an ALL-ZERO answer is the Solarman logger's "inverter did not answer" STUB
  //     (the same well-framed zeros that fabricated soc_pct=0): it must NOT read as
  //     "present" - and since the live Pilsting path flip it must NOT read as the
  //     DEFINITIVE "Firmware ohne Fernsteuerung" either, or a restart-moment stub
  //     locks a certified remote pilot onto EEPROM ToU writes for 6 h. Transient.
  const zeros = C.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: new Array(22).fill(0) });
  assert.strictEqual(zeros.present, false, 'all-zero is not a capability');
  assert.strictEqual(zeros.definitive, false, 'all-zero is UNREACHABLE, not an answer - re-probe');
  assert.match(zeros.reason, /nicht erreichbar/);
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

test('capability: a device WE have already driven re-classifies as remote after a restart', () => {
  // The live Pilsting register state after a day of remote-mode operation and a
  // nodered restart (2026-07-28): 1100 = 0 (released), 1101 = 60 (OUR watchdog
  // value, no longer the factory 0xFFFF), 1104 = 1 (battery-side), 1105 = 2
  // (Power), 1109 = 0 (idle release). The shape discriminator MUST accept this -
  // if it required the factory signature, every once-controlled device would flip
  // to ToU on its next restart (a guaranteed fleet regression).
  const driven = C.classifyDeyeCapability({
    deviceType: 0x0008,
    remoteBlock: ownersRemoteBlock({ 1100: 0, 1101: 60, 1104: 1, 1105: 2, 1108: 47, 1109: 0 }),
  });
  assert.strictEqual(driven.present, true, 'once-driven register state is still remote-capable');
  assert.strictEqual(driven.layout, 'pr978');
  assert.strictEqual(driven.supported, true);
  assert.strictEqual(driven.watchdogRaw, 60, 'our own watchdog value is a plausible watchdog');
  assert.strictEqual(C.deyeControlPath(driven), C.DEYE_PATH_REMOTE);
  // 1100 = 1 (still enabled, e.g. a crash mid-operation) classifies the same.
  const midOp = C.classifyDeyeCapability({
    deviceType: 0x0008,
    remoteBlock: ownersRemoteBlock({ 1100: 1, 1101: 60, 1104: 1, 1105: 2 }),
  });
  assert.strictEqual(midOp.present, true);
  assert.strictEqual(midOp.supported, true);
});

test('capability: probe-error definitiveness - only illegal-request exceptions are an answer', () => {
  // 0x01/0x02/0x03 indict the REQUEST (block not implemented) -> definitive absent.
  assert.strictEqual(C.deyeProbeErrorDefinitive('Modbus-Ausnahme 0x02: unzulaessige Datenadresse (illegal data address)'), true);
  assert.strictEqual(C.deyeProbeErrorDefinitive('Modbus-Ausnahme 0x01: unzulaessige Funktion (illegal function)'), true);
  assert.strictEqual(C.deyeProbeErrorDefinitive('Modbus-Ausnahme 0x03: unzulaessiger Datenwert (illegal data value)'), true);
  // The GATEWAY exceptions say "the logger answered, the inverter did not" - the
  // live Pilsting flip: a transient 0x0B was regex-matched as "Ausnahme" and cached
  // 6 h as "Firmware ohne Fernsteuerung". NEVER definitive.
  assert.strictEqual(C.deyeProbeErrorDefinitive('Modbus-Ausnahme 0x0b: Wechselrichter hat nicht geantwortet (gateway target failed to respond)'), false);
  assert.strictEqual(C.deyeProbeErrorDefinitive('Modbus-Ausnahme 0x0a: Gateway-Pfad nicht verfuegbar (gateway path unavailable)'), false);
  assert.strictEqual(C.deyeProbeErrorDefinitive('Modbus-Ausnahme 0x06: Wechselrichter beschaeftigt (slave device busy)'), false);
  assert.strictEqual(C.deyeProbeErrorDefinitive('Timeout'), false);
  assert.strictEqual(C.deyeProbeErrorDefinitive('connect ECONNREFUSED'), false);
  assert.strictEqual(C.deyeProbeErrorDefinitive(''), false);
  assert.strictEqual(C.deyeProbeErrorDefinitive(null), false);
});

// --- the STICKY path decision (hysteresis - the per-tick flap killer) ---------

test('sticky: the first definitive verdict decides; failures are NOT evidence', () => {
  const remote = OWNER_CAP;
  const fail = C.classifyDeyeCapability({ deviceType: null, remoteBlock: null, error: 'Timeout', definitive: false });
  // undecided + failure -> still undecided (bounded retry is the executor's job)
  assert.strictEqual(C.deyeUpdateSticky(null, fail, 1000), null);
  // undecided + definitive remote -> decided immediately (commissioning = one probe)
  const d1 = C.deyeUpdateSticky(null, remote, 2000);
  assert.strictEqual(d1.path, C.DEYE_PATH_REMOTE);
  assert.strictEqual(d1.everRemote, true);
  assert.strictEqual(d1.contrary, 0);
  // decided + N failures -> the SAME record object (nothing to persist, no flap)
  let s = d1;
  for (let i = 0; i < 10; i++) s = C.deyeUpdateSticky(s, fail, 3000 + i);
  assert.strictEqual(s, d1, 'a failed probe never moves the decision');
  // an ALL-ZERO logger stub is a failure too (classified definitive:false)
  const zeros = C.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: new Array(22).fill(0) });
  assert.strictEqual(C.deyeUpdateSticky(d1, zeros, 4000), d1, 'the unreachable stub never flips the path');
});

test('sticky: a decided path flips only after N consecutive definitive contrary verdicts', () => {
  const remote = OWNER_CAP;
  const tou = TOU_CAP;
  const fail = C.classifyDeyeCapability({ deviceType: null, remoteBlock: null, error: 'Timeout', definitive: false });
  let s = C.deyeUpdateSticky(null, remote, 1);
  // two contrary verdicts do not flip (N = 3)
  s = C.deyeUpdateSticky(s, tou, 2);
  assert.strictEqual(s.path, C.DEYE_PATH_REMOTE, 'contrary 1/3 holds');
  assert.strictEqual(s.contrary, 1);
  s = C.deyeUpdateSticky(s, tou, 3);
  assert.strictEqual(s.path, C.DEYE_PATH_REMOTE, 'contrary 2/3 holds');
  // an AGREEING verdict resets the counter (the flap can never accumulate)
  s = C.deyeUpdateSticky(s, remote, 4);
  assert.strictEqual(s.contrary, 0, 'agreement resets the contrary counter');
  // a failure in between neither advances nor resets
  s = C.deyeUpdateSticky(s, tou, 5);
  s = C.deyeUpdateSticky(s, fail, 6);
  assert.strictEqual(s.contrary, 1, 'a failure freezes the counter');
  // three consecutive definitive contrary verdicts flip - and everRemote SURVIVES
  s = C.deyeUpdateSticky(s, tou, 7);
  s = C.deyeUpdateSticky(s, tou, 8);
  assert.strictEqual(s.path, C.DEYE_PATH_TOU, 'flipped after ' + C.DEYE_PATH_CONTRARY_N + ' contrary verdicts');
  assert.strictEqual(s.everRemote, true, 'the remote-proven fact survives the flip (drives the hold-off)');
  assert.strictEqual(s.contrary, 0);
});

test('sticky: deyeEffectiveCap - the decided path beats a raw per-tick verdict', () => {
  const remote = OWNER_CAP;
  const tou = TOU_CAP;
  // no decision -> raw cap passes through (legacy behaviour)
  assert.strictEqual(C.deyeEffectiveCap(remote, null), remote);
  assert.strictEqual(C.deyeEffectiveCap(null, null), null);
  // decided remote + a contrary raw tou verdict (inside the hysteresis window):
  // the plan must STAY remote - this is the per-tick flap killer.
  const sRemote = C.deyeUpdateSticky(null, remote, 1);
  const effA = C.deyeEffectiveCap(tou, sRemote);
  assert.strictEqual(C.deyeControlPath(effA), C.DEYE_PATH_REMOTE, 'sticky remote wins over a raw tou verdict');
  // decided remote + no verdict object at all (grant-seeded, fresh volume):
  // a minimal remote capability is synthesized so the dispatch still selects remote.
  const seeded = C.deyeSeedStickyFromGrant({ device_certified: true, device_certified_path: 'remote' }, 5);
  const effB = C.deyeEffectiveCap(null, seeded);
  assert.strictEqual(C.deyeControlPath(effB), C.DEYE_PATH_REMOTE);
  assert.strictEqual(effB.sticky, true);
  assert.strictEqual(effB.layout, 'pr978');
  // decided tou + a raw remote verdict (contrary, pending hysteresis) stays tou.
  const sTou = C.deyeUpdateSticky(null, tou, 1);
  assert.strictEqual(C.deyeControlPath(C.deyeEffectiveCap(remote, sTou)), C.DEYE_PATH_TOU, 'sticky tou wins until the hysteresis flips');
  // no grant / wrong path -> no seed
  assert.strictEqual(C.deyeSeedStickyFromGrant({ device_certified: true }, 1), null);
  assert.strictEqual(C.deyeSeedStickyFromGrant({ device_certified: false, device_certified_path: 'remote' }, 1), null);
  assert.strictEqual(C.deyeSeedStickyFromGrant(null, 1), null);
});

// --- the DELIBERATE-fallback gate (certified ToU never engages on a guess) ----

test('deliberate fallback: a certified device with an UNCONFIRMED path writes NOTHING', () => {
  // The restart moment: no capability verdict yet (or only failed probes). The old
  // behaviour planned the full certified ToU EEPROM write set immediately - the
  // live Pilsting regression. Now the plan is HELD, loudly, until the path is known.
  const sp = { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, device_certified: true };
  const held = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30 });
  assert.deepStrictEqual(held.writes, [], 'no writes on an unconfirmed path');
  assert.deepStrictEqual(held.readbacks, []);
  assert.strictEqual(held.blocked, true, 'surfaced, never silent');
  assert.strictEqual(held.pathHold, 'unconfirmed');
  assert.match(held.reason, /Steuerpfad noch unbestätigt/);
  assert.ok(held.capabilityProbe, 'the probe spec rides along so the executor resolves the path');
  // a FAILED probe verdict is not an answer either
  const fail = C.classifyDeyeCapability({ deviceType: null, remoteBlock: null, error: 'Timeout', definitive: false });
  const held2 = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: fail });
  assert.deepStrictEqual(held2.writes, [], 'a failed probe never engages certified ToU');
  assert.strictEqual(held2.pathHold, 'unconfirmed');
  // the ROUTINE quiet cases are untouched: uncertified stays quiet-not-blocked...
  const unc = C.controlRoute(DEYE_SEL, { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true }, { ratedKw: 30 });
  assert.notStrictEqual(unc.blocked, true, 'uncertified read-only stays quiet');
  assert.match(unc.reason, /noch nicht freigegeben/);
  // ...and a definitive tou verdict, remote_mode=off, or a calibration test engage.
  assert.ok(C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: TOU_CAP }).writes.length >= 5, 'definitive verdict -> deliberate');
  const off = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, remote_mode: 'off' } };
  assert.ok(C.controlRoute(off, sp, { ratedKw: 30 }).writes.length >= 5, 'operator remote_mode=off -> deliberate');
  assert.ok(C.controlRoute(DEYE_SEL, enabled({ battery_setpoint_kw: -0.5, calibration: true }), { ratedKw: 30 }).writes.length >= 5,
    'an operator-armed calibration test -> deliberate');
});

test('deliberate fallback: a REMOTE-PROVEN certified device never silently engages ToU', () => {
  // The Q3 decision: the First-Light grant was earned on the REMOTE path - its
  // meaning does not transfer to EEPROM ToU control. Even a DEFINITIVE "remote
  // absent" verdict (a real firmware downgrade) holds off with a loud reason; the
  // operator either forces ToU (remote_mode=off) or re-certifies.
  const sp = { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, device_certified: true, device_certified_path: 'remote' };
  // (a) via the core's grant path (fresh volume, no sticky record):
  const heldGrant = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: TOU_CAP });
  // grant-path remote + definitive tou verdict -> hold, not ToU
  assert.deepStrictEqual(heldGrant.writes, [], 'grant proves remote -> no silent ToU');
  assert.strictEqual(heldGrant.pathHold, 'remote_proven');
  assert.match(heldGrant.reason, /nicht automatisch aktiviert/);
  // (b) via the sticky everRemote fact (the device once answered remote):
  let sticky = C.deyeUpdateSticky(null, OWNER_CAP, 1);
  sticky = C.deyeUpdateSticky(sticky, TOU_CAP, 2);
  sticky = C.deyeUpdateSticky(sticky, TOU_CAP, 3);
  sticky = C.deyeUpdateSticky(sticky, TOU_CAP, 4); // flipped to tou, everRemote survives
  assert.strictEqual(sticky.path, C.DEYE_PATH_TOU);
  const spNoGrantPath = { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, device_certified: true };
  const heldSticky = C.controlRoute(DEYE_SEL, spNoGrantPath, { ratedKw: 30, deyeSticky: sticky });
  assert.deepStrictEqual(heldSticky.writes, [], 'everRemote -> no silent ToU');
  assert.strictEqual(heldSticky.pathHold, 'remote_proven');
  // (c) the operator hatch still works: remote_mode=off forces ToU deliberately.
  const off = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, remote_mode: 'off' } };
  const forced = C.controlRoute(off, sp, { ratedKw: 30, deye: TOU_CAP, deyeSticky: sticky });
  assert.ok(forced.writes.length >= 5, 'remote_mode=off is the deliberate operator decision');
  assert.strictEqual(forced.controlPath, C.DEYE_PATH_TOU);
});

test('sticky: a grant-seeded/sticky remote decision plans REMOTE across a restart', () => {
  // The recovery guarantee: after a nodered restart (volatile cache wiped) the plan
  // node seeds the decision from the core's device_certified_path (or the durable
  // record) and plans the PROVEN remote path from the first tick - no ToU detour,
  // no per-tick flap while probes are still failing.
  const sp = { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, device_certified: true, device_certified_path: 'remote', soc_min_pct: 20 };
  const seeded = C.deyeSeedStickyFromGrant(sp, 1000);
  const r = C.controlRoute(DEYE_REMOTE_SEL, sp, { ratedKw: 30, deyeSticky: seeded });
  assert.strictEqual(r.controlPath, C.DEYE_PATH_REMOTE, 'plans the proven remote path');
  assert.deepStrictEqual(r.writes.map((w) => w.role),
    ['remote_watchdog', 'power_control_mode', 'battery_strategy', 'battery_power', 'remote_mode']);
  // and the release hands back 1100 <- 0 on the same resolution
  const rel = C.controlRelease(DEYE_REMOTE_SEL, { deviceCertified: true, deyeSticky: seeded });
  assert.strictEqual(rel.controlPath, C.DEYE_PATH_REMOTE);
  assert.strictEqual(rel.writes[0].role, 'remote_mode');
  assert.strictEqual(rel.writes[0].value, 0);
});

// --- the idle-slot ToU levers (the live max_sell_power 0-vs-7182 fight) -------

test('ToU idle slot (0 kW) restores max_sell_power and never forces solar-sell', () => {
  const reg = C.DEYE_CONTROL_REG.hybrid_3p;
  const snapshot = { [reg.maxSellPower]: 7182 };
  const sp = { battery_setpoint_kw: 0, source: 'schedule', control_enabled: true, device_certified: true };
  const idle = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: TOU_CAP, snapshot });
  const roles = Object.fromEntries(idle.planned.map((w) => [w.role, w]));
  // the live fight: idle used to take the discharge branch and command
  // max_sell_power = 0, which the inverter's own solar-sell logic kept
  // restoring to the installer's 7182 - a mismatch warning every readback.
  assert.strictEqual(roles.max_sell_power.value, 7182, 'idle RESTORES the installer value from the snapshot');
  assert.strictEqual(roles.max_sell_power.encode.kind, 'restore');
  assert.strictEqual(roles.solar_sell, undefined, 'idle never forces Solar-Sell ON');
  assert.strictEqual(roles.battery_power.value, 0, 'the Program-Power cap of 0 is what keeps the battery still');
  // without a snapshot the idle slot simply omits the lever (never a fabricated 0)
  const bare = C.controlRoute(DEYE_SEL, sp, { ratedKw: 30, deye: TOU_CAP });
  assert.strictEqual(bare.planned.find((w) => w.role === 'max_sell_power'), undefined,
    'no snapshot -> the installer value is left alone');
  // a REAL discharge still forces the export lever (unchanged)
  const dis = C.controlRoute(DEYE_SEL, { ...sp, battery_setpoint_kw: -10 }, { ratedKw: 30, deye: TOU_CAP });
  const disMs = dis.planned.find((w) => w.role === 'max_sell_power');
  assert.strictEqual(disMs.value, 10000, 'discharge writes the sell-power forcing lever');
  assert.ok(dis.planned.find((w) => w.role === 'solar_sell'), 'discharge enables Solar-Sell');
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

function remotePlan(sp, opts = {}, connOverride = {}) {
  const sel = { ...DEYE_REMOTE_SEL, connection: { ...DEYE_REMOTE_SEL.connection, ...connOverride } };
  return C.controlRoute(sel, { source: 'schedule', control_enabled: true, ...sp },
    { ratedKw: 30, deye: OWNER_CAP, ...opts });
}

test('remote: the DEFAULT plan is strategy 2 (Power) - watchdog FIRST, enable LAST, NO 1108', () => {
  // THE FIX (live SUN-30K-SG01HP3-EU, 2026-07-27): even with SoC bounds present, the
  // default is strategy 2 - the signed setpoint (1109) is the ONLY thing the inverter is
  // told, no on-device 1108 target that the firmware drove toward as a TARGET (~8x over-
  // delivery on a -1 kW command). guards.Clamp remains the SoC authority.
  const r = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20, soc_max_pct: 95 });
  assert.strictEqual(r.controlPath, C.DEYE_PATH_REMOTE);
  assert.deepStrictEqual(r.planned.map((w) => w.role), [
    'remote_watchdog', 'power_control_mode', 'battery_strategy', 'battery_power', 'remote_mode',
  ]);
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  // 1) the dead-man's switch is armed BEFORE anything can move
  assert.strictEqual(p.remote_watchdog.addr, C.DEYE_REMOTE_REG.watchdog); // 0x044D / 1101
  assert.strictEqual(p.remote_watchdog.value, C.DEYE_REMOTE_WATCHDOG_DEFAULT_S);
  // 2) BATTERY-side (AC-/grid-side would throttle PV)
  assert.strictEqual(p.power_control_mode.addr, C.DEYE_REMOTE_REG.powerControlMode); // 0x0450 / 1104
  assert.strictEqual(p.power_control_mode.value, C.DEYE_POWER_CONTROL_MODE.BATTERY_SIDE);
  // 3) Power (2) by DEFAULT - and NO 1108 belt op at all
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(p.battery_soc_belt, undefined, 'strategy 2 writes NO on-device SoC target (1108)');
  // 4) the signed setpoint
  assert.strictEqual(p.battery_power.addr, C.DEYE_REMOTE_REG.constantPower); // 0x0455 / 1109
  assert.strictEqual(p.battery_power.value, 33);
  // 5) ACTIVATION last
  assert.strictEqual(r.planned[r.planned.length - 1].role, 'remote_mode');
  assert.strictEqual(p.remote_mode.addr, C.DEYE_REMOTE_REG.mode); // 0x044C / 1100
  assert.strictEqual(p.remote_mode.value, C.DEYE_REMOTE_MODE.ON);
  // FC16 (write-multiple) - the only function code this firmware answers.
  assert.ok(r.planned.every((w) => w.fc === C.DEYE_WRITE_FC_FC16));
});

test('remote: strategy 5 (opt-in) arms the 1108 belt - a DISCHARGE uses the FLOOR, order preserved', () => {
  const r = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20, soc_max_pct: 95 },
    {}, { remote_battery_strategy: 5 });
  assert.deepStrictEqual(r.planned.map((w) => w.role), [
    'remote_watchdog', 'power_control_mode', 'battery_strategy', 'battery_soc_belt',
    'battery_power', 'remote_mode',
  ]);
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  // Power+SOC + the belt SANDWICHED between the strategy and the setpoint, activation last.
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER_SOC);
  assert.strictEqual(p.battery_soc_belt.addr, C.DEYE_REMOTE_REG.constantSoc); // 0x0454 / 1108
  assert.strictEqual(p.battery_soc_belt.value, 20);
  assert.strictEqual(p.battery_soc_belt.encode.direction, 'discharge_floor');
  assert.strictEqual(r.planned[r.planned.length - 1].role, 'remote_mode');
  assert.ok(r.planned.every((w) => w.fc === C.DEYE_WRITE_FC_FC16));
});

test('remote: resolveDeyeRemoteStrategy defaults to Power (2); ONLY 5 opts into Power+SOC', () => {
  assert.strictEqual(C.resolveDeyeRemoteStrategy({}), C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(C.resolveDeyeRemoteStrategy({ remote_battery_strategy: 2 }), C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(C.resolveDeyeRemoteStrategy({ remote_battery_strategy: 0 }), C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(C.resolveDeyeRemoteStrategy({ remote_battery_strategy: 99 }), C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(C.resolveDeyeRemoteStrategy({ remote_battery_strategy: 5 }), C.DEYE_BATTERY_STRATEGY.POWER_SOC);
  assert.strictEqual(C.resolveDeyeRemoteStrategy({ remote_battery_strategy: '5' }), C.DEYE_BATTERY_STRATEGY.POWER_SOC);
});

test('remote: a CHARGE flips the sign (default strategy 2 writes NO belt)', () => {
  const r = remotePlan({ battery_setpoint_kw: 3, soc_min_pct: 20, soc_max_pct: 90 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_power.value & 0xffff, C.deyeRemoteSetpointUnits(3, 30).raw);
  assert.strictEqual(p.battery_power.encode.units, -100, 'charge 3 kW of 30 kW -> -100');
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(p.battery_soc_belt, undefined);
});

test('remote: strategy 5 (opt-in) - a CHARGE is bounded by the SoC CEILING', () => {
  const r = remotePlan({ battery_setpoint_kw: 3, soc_min_pct: 20, soc_max_pct: 90 },
    {}, { remote_battery_strategy: 5 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_power.encode.units, -100, 'charge 3 kW of 30 kW -> -100');
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER_SOC);
  assert.strictEqual(p.battery_soc_belt.value, 90);
  assert.strictEqual(p.battery_soc_belt.encode.direction, 'charge_ceiling');
});

test('remote: strategy 5 with NO belt value known falls back to Power (no 1108)', () => {
  const r = remotePlan({ battery_setpoint_kw: -1 }, {}, { remote_battery_strategy: 5 }); // no soc bounds
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(p.battery_soc_belt, undefined);
});

test('remote: NO SoC bounds -> plain Power strategy (2) and no 1108 write', () => {
  const r = remotePlan({ battery_setpoint_kw: -1 }); // no soc_min/soc_max on the setpoint
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  assert.strictEqual(p.battery_strategy.value, C.DEYE_BATTERY_STRATEGY.POWER);
  assert.strictEqual(p.battery_soc_belt, undefined);
});

test('remote: EVERY op is RAM cadence (dwell 0), and only the three LOAD-BEARING ops re-assert every tick', () => {
  const r = remotePlan({ battery_setpoint_kw: -1, soc_min_pct: 20, soc_max_pct: 90 }, {}, { remote_battery_strategy: 5 });
  const p = Object.fromEntries(r.planned.map((w) => [w.role, w]));
  for (const w of r.planned) {
    assert.strictEqual(w.dwell_s, 0, w.role + ' must not carry an EEPROM dwell');
    assert.strictEqual(w.min_change, 0, w.role);
  }
  // The three ops whose per-tick re-write is the MECHANISM (watchdog kick, the
  // command itself, and an enable that self-heals a watchdog expiry within a tick).
  for (const role of ['remote_watchdog', 'battery_power', 'remote_mode']) {
    assert.strictEqual(p[role].always, true, role + ' must be re-asserted every tick');
    assert.strictEqual(p[role].reassert_s, undefined, role + ' needs no interval - it is unconditional');
  }
  // The pure CONFIGURATION ops re-assert on an interval + on demand (the executor
  // invalidates their write cache when a readback shows them not held), so a tick
  // spends less time on the logger's single socket - which is what starved the
  // readback and produced the false "not adopted" alarms.
  for (const role of ['power_control_mode', 'battery_strategy', 'battery_soc_belt']) {
    assert.strictEqual(p[role].always, undefined, role + ' must NOT be re-written every tick');
    assert.strictEqual(p[role].reassert_s, C.DEYE_REMOTE_CFG_REASSERT_S, role + ' re-asserts on the interval');
  }
  assert.ok(C.DEYE_REMOTE_CFG_REASSERT_S >= 60, 'the interval is a drift backstop, not a per-tick write');
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
  // Defect 2: an empty plan caused by a MISCONFIGURATION is flagged blocked so the
  // executor surfaces the reason (a refusal must never be silent), unlike the
  // routine read-only/kill-switch quiet cases.
  assert.strictEqual(r.blocked, true, 'a nameplate-unknown refusal must be flagged blocked');
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

// --- KOSTAL PLENTICORE Tier-2 (external battery management) ------------------

function kostalSel(overrides = {}) {
  return Object.assign({
    schema_version: '1.0', brand: 'kostal', label: 'KOSTAL · PLENTICORE BI 10/26',
    family: 'kostal_plenticore', communication: 'kostal_modbus', control_tier: 2, rated_kw: 10,
    connection: { ip: '192.168.0.30', port: 1502, unit_id: 71, byte_order: 'auto' },
  }, overrides);
}
const kostalSp = (over = {}) => Object.assign({
  battery_setpoint_kw: -3, source: 'schedule', control_enabled: true, device_certified: true,
}, over);

test('kostal: ONE lever - register 1034 as float32 watts, sign NEGATED', () => {
  // VoltPilot -3 kW (discharge) -> Kostal register +3000 W (positive = discharge).
  const plan = C.controlRoute(kostalSel(), kostalSp(), {});
  assert.strictEqual(plan.adapter, 'kostal_modbus');
  assert.strictEqual(plan.tier, C.CONTROL_TIER.VENDOR_EMS);
  assert.strictEqual(plan.target, '192.168.0.30:1502');
  assert.strictEqual(plan.connection.unit_id, 71);
  assert.strictEqual(plan.writes.length, 1, 'exactly ONE write op - the single-lever discipline');
  const w = plan.writes[0];
  assert.strictEqual(w.addr, C.KOSTAL_REG.SETPOINT);
  assert.strictEqual(w.addr, 1034);
  assert.strictEqual(w.fc, 16);
  assert.strictEqual(w.value, 3000);
  assert.strictEqual(w.always, true, 're-assert every tick IS the watchdog kick');
  assert.strictEqual(w.dwell_s, 0);
  // Charging is negative on the register.
  const charge = C.controlRoute(kostalSel(), kostalSp({ battery_setpoint_kw: 2.5 }), {});
  assert.strictEqual(charge.writes[0].value, -2500);
  // The sign hatch flips it back.
  const inverted = C.controlRoute(
    kostalSel({ connection: { ip: '192.168.0.30', invert_control_sign: true } }), kostalSp({ battery_setpoint_kw: 2.5 }), {},
  );
  assert.strictEqual(inverted.writes[0].value, 2500);
});

test('kostal: the SoC/limit registers are NEVER written (session-persistence rule)', () => {
  for (const kw of [-5, 0, 4]) {
    const plan = C.controlRoute(kostalSel(), kostalSp({ battery_setpoint_kw: kw }), {});
    const addrs = plan.planned.map((w) => w.addr);
    assert.deepStrictEqual(addrs, [1034], 'only 1034 - never 1038/1040/1042/1044');
    for (const forbidden of [1038, 1040, 1042, 1044]) {
      assert.ok(!addrs.includes(forbidden), 'register ' + forbidden + ' must never be written');
    }
  }
  // "Hold" is simply the clamped setpoint 0 - still only the one lever.
  const hold = C.controlRoute(kostalSel(), kostalSp({ battery_setpoint_kw: 0 }), {});
  assert.strictEqual(hold.planned[0].value, 0);
});

test('kostal: the activation gate + the readback surface are always present', () => {
  const plan = C.controlRoute(kostalSel(), kostalSp(), {});
  assert.strictEqual(plan.mgmt_gate.addr, C.KOSTAL_REG.MGMT_MODE);
  assert.strictEqual(plan.mgmt_gate.addr, 1080);
  assert.strictEqual(plan.mgmt_gate.expect, C.KOSTAL_MGMT_EXTERNAL_MODBUS);
  assert.match(plan.mgmt_gate.reason, /Servicemenü/);
  const roles = plan.readbacks.map((r) => r.role);
  assert.deepStrictEqual(roles, ['battery_setpoint', 'mgmt_mode']);
  assert.strictEqual(plan.readbacks[0].count, 2, 'float32 spans two registers');
  assert.strictEqual(plan.readbacks[0].decode, 'float32');
});

test('kostal: uncertified plans but never writes; the kill-switch and First-Light behave', () => {
  // No device grant + not in the fleet allowlist -> planned only, honest reason.
  const uncertified = C.controlRoute(kostalSel(), kostalSp({ device_certified: false }), {});
  assert.deepStrictEqual(uncertified.writes, []);
  assert.strictEqual(uncertified.planned.length, 1, 'the intended mapping stays visible for the bench');
  assert.strictEqual(uncertified.certified, false);
  assert.match(uncertified.reason, /nicht freigegeben/);
  assert.ok(!C.CERTIFIED_CONTROL_FAMILIES.has('kostal_plenticore'),
    'the family must NOT be fleet-certified before the bench pass');
  // Kill-switch OFF beats a granted device.
  const killed = C.controlRoute(kostalSel(), kostalSp({ control_enabled: false }), {});
  assert.deepStrictEqual(killed.writes, []);
  assert.match(killed.reason, /Not-Aus/);
  // First-Light calibration bypasses ONLY the certification gate.
  const calib = C.controlRoute(kostalSel(), kostalSp({ device_certified: false, calibration: true }), {});
  assert.strictEqual(calib.writes.length, 1);
  const calibKilled = C.controlRoute(
    kostalSel(), kostalSp({ device_certified: false, calibration: true, control_enabled: false }), {},
  );
  assert.deepStrictEqual(calibKilled.writes, [], 'calibration never bypasses the kill-switch');
});

test('kostal: a pv limit is reported dropped (the BI has no PV), never silently ignored', () => {
  const plan = C.controlRoute(kostalSel(), kostalSp({ pv_limit_kw: 5 }), {});
  assert.strictEqual(plan.pvLimitSupported, false);
  assert.strictEqual(plan.pvLimitDroppedKw, 5);
  assert.strictEqual(plan.planned.length, 1, 'no curtailment write is invented');
  const none = C.controlRoute(kostalSel(), kostalSp(), {});
  assert.strictEqual(none.pvLimitSupported, undefined);
});

test('kostal release: setpoint 0 once, nothing to restore (the watchdog is the failsafe)', () => {
  const rel = C.controlRelease(kostalSel(), { controlEnabled: true, deviceCertified: true });
  assert.strictEqual(rel.adapter, 'kostal_modbus');
  assert.strictEqual(rel.mode, 'release');
  assert.strictEqual(rel.writes.length, 1);
  assert.strictEqual(rel.writes[0].addr, 1034);
  assert.strictEqual(rel.writes[0].value, 0);
  assert.strictEqual(rel.writes[0].fc, 16);
  // No installer state was touched, so no snapshot/restore ops exist at all.
  assert.ok(!rel.snapshotPlan, 'the single-lever path has no installer state to snapshot');
  // Uncertified: planned-only, exactly like the drive path.
  const unc = C.controlRelease(kostalSel(), { controlEnabled: true });
  assert.deepStrictEqual(unc.writes, []);
  assert.strictEqual(unc.planned.length, 1);
});

test('kostal: the tier dispatch reaches the adapter even without control_tier on the selection', () => {
  const sel = kostalSel();
  delete sel.control_tier; // an older core that did not stamp the tier
  const plan = C.controlRoute(sel, kostalSp(), {});
  assert.strictEqual(plan.adapter, 'kostal_modbus', 'communication inference must reach Tier 2');
  // A Tier-2 brand that is NOT kostal still hits the honest stub.
  const other = C.controlRoute(
    Object.assign(kostalSel(), { communication: 'modbus_tcp', control_tier: 2, family: 'sunspec' }), kostalSp(), {},
  );
  assert.strictEqual(other.adapter, 'vendor_ems');
  assert.deepStrictEqual(other.writes, []);
});

// --- the NARROW installer write: ONE register, 0x00E7 -------------------------
//
// „Grid Max Export power" is the inverter's OWN feed-in cap - the value an
// installer normally only reaches through the device menu on site. These pin
// that the route stays a ONE-REGISTER lever and refuses everything else.

const iwSel = (over) => Object.assign({
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', control_tier: 3,
  communication: 'solarman_v5',
  connection: { ip: '192.168.0.28', serial: '2985159064', mb_slave_id: 1, power_scale: 10 },
}, over || {});

test('installer write: the Herzogau case (3300 -> 7000) plans one FC16 write plus a read-back', () => {
  const dry = C.installerWriteRoute(iwSel(), { mode: 'dry_run', addr: 0x00e7, value: 7000 });
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(dry.apply, false);
  assert.ok(!dry.write, 'a dry run plans NO write at all');
  assert.deepStrictEqual(dry.read, { fc: 3, addr: 0x00e7, count: 1 });
  assert.strictEqual(dry.scale, 10);
  assert.strictEqual(dry.kw, 70);
  assert.strictEqual(dry.target, '192.168.0.28:8899');

  const apply = C.installerWriteRoute(iwSel(), { mode: 'apply', addr: 0x00e7, value: 7000 });
  assert.strictEqual(apply.apply, true);
  // FC16 by default - the measured Deye convention (resolveDeyeWriteFc): many
  // firmwares ACCEPT an FC6 frame and never apply it.
  assert.deepStrictEqual(apply.write, { fc: 16, addr: 0x00e7, value: 7000 });
  const legacy = C.installerWriteRoute(
    iwSel({ connection: { ip: '192.168.0.28', serial: '2985159064', mb_slave_id: 1, control_write_fc: 6 } }),
    { mode: 'apply', addr: 0x00e7, value: 7000 },
  );
  assert.strictEqual(legacy.write.fc, 6, 'control_write_fc: 6 flips back, exactly like the control path');
});

test('installer write: since Stufe 2 the LANE rules replace the address allowlist', () => {
  // ⚠ THE ALLOWLIST IS GONE ON PURPOSE (Konzept vp-reg-schreib-konzept-p8 §2.8
  // Stufe 2 „Freie Register"): every register word is plannable, and what still
  // refuses is what THIS planner can actually judge - the transport and the
  // bounds of a register word.
  for (const addr of [0x0000, 0x0028, 0x008f, 0x00e7, 0x00f5, 1109, 40, 0xffff]) {
    assert.strictEqual(
      C.installerWriteRoute(iwSel(), { mode: 'apply', addr, value: 100 }).ok, true, 'addr ' + addr,
    );
  }
  for (const addr of [-1, 0x10000, 1.5, NaN, undefined, 'e7']) {
    assert.strictEqual(
      C.installerWriteRoute(iwSel(), { mode: 'apply', addr, value: 100 }).ok, false, 'addr ' + addr,
    );
  }
  // A register word is 0..65535 - INCLUDING 0 and 65535, which are values here.
  // (The „0 is not a raise" rule belongs to the :8484 button's narrow scope, not
  // to a free register.)
  for (const value of [0, 1, 7000, 7001, 65535]) {
    assert.strictEqual(
      C.installerWriteRoute(iwSel(), { mode: 'apply', addr: 0x1234, value }).ok, true, 'value ' + value,
    );
  }
  for (const value of [-1, 65536, 1.5, NaN, undefined]) {
    assert.strictEqual(
      C.installerWriteRoute(iwSel(), { mode: 'apply', addr: 0x1234, value }).ok, false, 'value ' + value,
    );
  }
  // A DRY RUN needs no value at all - it writes nothing.
  assert.strictEqual(C.installerWriteRoute(iwSel(), { mode: 'dry_run', addr: 0x1234 }).ok, true);

  // ⚠ A UNIT IS ONLY EVER CLAIMED WHERE THE READ TABLE STATES ONE. A free
  // register gets NO scale and NO kW - an invented unit is exactly the mistake
  // the whole two-step flow exists to prevent.
  const free = C.installerWriteRoute(iwSel(), { mode: 'apply', addr: 0x1234, value: 100 });
  assert.ok(!('scale' in free) && !('kw' in free), 'no invented unit for an unknown register');
  const known = C.installerWriteRoute(iwSel(), { mode: 'apply', addr: 0x00e7, value: 7000 });
  assert.strictEqual(known.scale, 10);
  assert.strictEqual(known.kw, 70);
  // ⚠ hybrid_1p: there the feed-in cap IS „Max Sell Power" (0x00F5), the
  // register OUR OWN discharge lever writes - so no unit is claimed for it
  // either. That it is REFUSED while the control loop really holds it is the
  // core's self-conflict lock (internal/registerwrite.ControlOwns), judged
  // against the LIVE readback instead of a static family table.
  assert.strictEqual(
    C.DEYE_CONTROL_REG.hybrid_1p.exportLimit, C.DEYE_CONTROL_REG.hybrid_1p.maxSellPower,
    'the premise of the no-unit rule on hybrid_1p',
  );
  const onePhase = C.installerWriteRoute(iwSel({ family: 'hybrid_1p' }),
    { mode: 'apply', addr: 0x00f5, value: 7000 });
  assert.strictEqual(onePhase.ok, true);
  assert.ok(!('scale' in onePhase), 'no unit where the cap is our own control register');

  // Another transport has no path here at all - a component on plain Modbus-TCP
  // has its OWN executor (vp-register-write), which owns the other socket.
  assert.strictEqual(C.installerWriteRoute(iwSel({ communication: 'modbus_tcp' }), { mode: 'apply', addr: 0x00e7, value: 7000 }).ok, false);
  // No selection / no address.
  assert.strictEqual(C.installerWriteRoute(null, { mode: 'apply', addr: 0x00e7, value: 7000 }).ok, false);
  assert.strictEqual(C.installerWriteRoute(iwSel({ connection: { serial: 'x' } }), { mode: 'apply', addr: 0x00e7, value: 7000 }).ok, false);
});

test('installer write: every refusal names a reason, and the route is a PURE plan', () => {
  for (const bad of [
    C.installerWriteRoute(iwSel({ communication: 'modbus_tcp' }), { mode: 'apply', addr: 0x00e7, value: 7000 }),
    C.installerWriteRoute(iwSel(), { mode: 'apply', addr: 0x10000, value: 1 }),
    C.installerWriteRoute(iwSel(), { mode: 'apply', addr: 0x00e7, value: 65536 }),
    C.installerWriteRoute(null, { mode: 'apply', addr: 0x00e7, value: 7000 }),
  ]) {
    assert.ok(typeof bad.reason === 'string' && bad.reason.length > 10, 'a refusal must be explainable');
    assert.ok(!('write' in bad) && !('read' in bad), 'a refused route plans nothing');
  }
  // The register this path was built for stays EXPORTED - the flow copy, the Go
  // side and the local button's narrow ceiling are pinned against it.
  assert.strictEqual(C.INSTALLER_WRITE_ADDR, 0x00e7);
  assert.strictEqual(C.INSTALLER_WRITE_MAX_RAW, 7000);
  assert.strictEqual(C.REGISTER_WORD_MAX, 0xffff);
});

// --- KACO: VORBEREITET und GESPERRT ------------------------------------------
//
// Die Register-Lage ist fuer einmal DOKUMENTIERT (KACO beschreibt die
// Wirkleistungsbegrenzung ueber SunSpec Model 123 selbst; der NH3-Batterieweg
// ist durch evcc belegt) - gemessen hat sie an einem KACO aber niemand von uns.
// Deshalb ist die Sperre HAERTER als die Freigabeliste: `writes` bleibt leer,
// UNABHAENGIG von `certified`.

const KACO_SUNSPEC_SEL = {
  schema_version: '1.0', brand: 'kaco', family: 'sunspec_live',
  communication: 'sunspec_tcp', control_tier: 1,
  connection: { ip: '192.168.0.9', port: 502, unit_id: 1 },
};
const KACO_NH3_SEL = {
  schema_version: '1.0', brand: 'kaco', family: 'kaco_nh3',
  communication: 'kaco_modbus', control_tier: 1,
  connection: { ip: '192.168.0.31', port: 502, unit_id: 1 },
};
const KACO_SP = {
  battery_setpoint_kw: -3, pv_limit_kw: 6, control_enabled: true,
  soc_min_pct: 10, soc_max_pct: 90,
};

test('KACO SunSpec plant Model 123 an den ENTDECKTEN Adressen - und schreibt nichts', () => {
  const out = C.controlRoute(KACO_SUNSPEC_SEL, KACO_SP, { sunspec: froniusDiscovery(false) });
  assert.strictEqual(out.adapter, 'kaco_sunspec');
  assert.deepStrictEqual(out.writes, []);
  assert.deepStrictEqual(out.readbacks, []);
  assert.ok(out.planned.length > 0, 'der Plan ist das Bench-Artefakt');
  for (const w of out.planned) assert.strictEqual(w.bench_pending, true);
  // Es ist DERSELBE Model-123-Plan wie bei Fronius - geteilt, nicht nachgebaut:
  // EIN geschlossener FC16-Block ueber WMaxLimPct .. WMaxLim_Ena.
  const block = out.planned.find((w) => w.role === 'pv_limit_block');
  assert.ok(block, 'der Model-123-Block: ' + out.planned.map((w) => w.role).join(','));
  const parts = block.parts.map((p) => p.role);
  assert.ok(parts.includes('pv_limit_pct'), 'WMaxLimPct: ' + parts.join(','));
  assert.ok(parts.includes('pv_limit_enable'), 'WMaxLim_Ena: ' + parts.join(','));
  // 6 kW auf einer 12-kW-Nennleistung = 50 % bei Skalenfaktor -2.
  assert.strictEqual(block.parts[0].value, 5000);
  // ⚠ Und die Adressen sind ENTDECKT, nicht konstant: der Block liegt dort, wo
  // das Geraet sein Model 123 gemeldet hat.
  const m123 = C.controlRoute(KACO_SUNSPEC_SEL, KACO_SP, { sunspec: froniusDiscovery(false) });
  assert.strictEqual(m123.planned[0].addr, block.addr);
  assert.ok(block.addr > 40000, 'aus dem Walk, nicht aus einer Konstante');
});

test('KACO SunSpec erfindet OHNE Discovery keine einzige Adresse', () => {
  const out = C.controlRoute(KACO_SUNSPEC_SEL, KACO_SP, {});
  assert.deepStrictEqual(out.planned, []);
  assert.deepStrictEqual(out.writes, []);
  assert.match(out.reason, /nicht freigegeben/);
});

test('KACO SunSpec reicht den Schreib-Funktionscode durch (KACOs Beispiel schreibt FC6 einzeln)', () => {
  const sel = { ...KACO_SUNSPEC_SEL, connection: { ...KACO_SUNSPEC_SEL.connection, curtail_write_fc: 6 } };
  const out = C.controlRoute(sel, KACO_SP, { sunspec: froniusDiscovery(false) });
  assert.strictEqual(out.connection.curtail_write_fc, 6);
});

test('KACO NH3 plant den belegten Batterie-Sollwert - mit UMGEKEHRTEM Vorzeichen', () => {
  // VoltPilot: -3 kW = entladen. AISWEI: + = entladen -> +3000 W.
  const out = C.controlRoute(KACO_NH3_SEL, KACO_SP, {});
  assert.strictEqual(out.adapter, 'kaco_nh3');
  assert.deepStrictEqual(out.writes, []);
  assert.deepStrictEqual(out.readbacks, []);
  const by = Object.fromEntries(out.planned.map((w) => [w.role, w]));
  assert.strictEqual(by.work_mode.addr, C.KACO_NH3_CONTROL_REG.MODE);
  assert.strictEqual(by.work_mode.value, C.KACO_NH3_CONTROL_REG.MODE_CUSTOMER);
  assert.strictEqual(by.battery_power.addr, C.KACO_NH3_CONTROL_REG.POWER_W);
  assert.strictEqual(by.battery_power.value, 3000);
  assert.strictEqual(by.battery_flag.value, C.KACO_NH3_CONTROL_REG.FLAG_DISCHARGE);
  assert.strictEqual(by.battery_soc_min.value, 1000); // 10,00 % x 100
  assert.strictEqual(by.battery_soc_max.value, 9000);
  for (const w of out.planned) assert.strictEqual(w.bench_pending, true);
});

test('KACO NH3: laden ist das andere Vorzeichen und das andere Flag', () => {
  const out = C.controlRoute(KACO_NH3_SEL, { ...KACO_SP, battery_setpoint_kw: 4 }, {});
  const by = Object.fromEntries(out.planned.map((w) => [w.role, w]));
  assert.strictEqual(by.battery_power.value, -4000); // AISWEI: - = laden
  assert.strictEqual(by.battery_flag.value, C.KACO_NH3_CONTROL_REG.FLAG_CHARGE);
});

test('KACO NH3: die RUECKNAHME ist der ganze Failsafe (es gibt kein Totmann-Register)', () => {
  const rel = C.controlRelease(KACO_NH3_SEL, {});
  assert.strictEqual(rel.adapter, 'kaco_nh3');
  assert.deepStrictEqual(rel.writes, []);
  const by = Object.fromEntries(rel.planned.map((w) => [w.role, w]));
  // Zurueck auf Eigenverbrauch - NICHT nur Sollwert 0: in Modus 4 bliebe die
  // Anlage unter Fremdsteuerung stehen.
  assert.strictEqual(by.work_mode.value, C.KACO_NH3_CONTROL_REG.MODE_SELF_CONSUMPTION);
  assert.strictEqual(by.battery_power.value, 0);
  assert.strictEqual(by.battery_flag.value, C.KACO_NH3_CONTROL_REG.FLAG_STOP);
});

test('⚠ DIE SPERRE HAENGT NICHT AN DER FREIGABELISTE: auch ein Geraete-Grant schreibt nichts', () => {
  // deviceGrant() oeffnet bei Fronius/Deye den Schreibweg. Bei KACO NICHT -
  // an keinem Geraet wurde je etwas gemessen.
  const granted = {
    ...KACO_SP,
    device_certified: true,
    certified: true,
    calibration: true,
  };
  for (const sel of [KACO_SUNSPEC_SEL, KACO_NH3_SEL]) {
    const out = C.controlRoute(sel, granted, { sunspec: froniusDiscovery(true) });
    assert.deepStrictEqual(out.writes, [], sel.communication + ': kein Schreibbefehl');
    assert.deepStrictEqual(out.readbacks, [], sel.communication + ': kein Rueckleseregister');
  }
});

test('KACO App-Schnittstelle: kein Steuerweg, und das wird GESAGT statt geraten', () => {
  const sel = { ...KACO_SUNSPEC_SEL, family: 'kaco_http_hybrid', communication: 'kaco_http' };
  const out = C.controlRoute(sel, KACO_SP, {});
  assert.strictEqual(out.adapter, 'idle');
  assert.deepStrictEqual(out.writes, []);
  assert.match(out.reason, /kein Steuerweg/);
  const rel = C.controlRelease(sel, {});
  assert.strictEqual(rel.adapter, 'idle');
  assert.match(rel.reason, /kein Steuerweg/);
});

test('KACO steht in KEINER Freigabeliste', () => {
  for (const fam of ['sunspec_live', 'kaco_http', 'kaco_http_hybrid', 'kaco_nh3']) {
    assert.strictEqual(C.CERTIFIED_CONTROL_FAMILIES.has(fam), false, fam);
  }
});

// --- NATIVE SELF-REGULATION (Selbstregel-Modus) ------------------------------
//
// Per tier: the primitive is the tier's RELEASE write list plus the STATE
// readback that proves it, and it stays PLANNED-ONLY until a bench certificate
// releases it. So each case below asserts three things: the documented sequence,
// the proof register, and that nothing is executable today.

// Reuses the fixtures the setpoint-path tests already use, so the native
// primitive is judged against the SAME devices.
const nat = (sel, over = {}) =>
  C.nativeSelfConsumption(sel, { controlEnabled: true, deviceCertified: true, ...over });

test('nativ: Deye REMOTE gibt die Fernsteuerung zurueck und belegt es an 1100', () => {
  const r = nat(DEYE_REMOTE_SEL, { deye: OWNER_CAP });
  assert.strictEqual(r.supported, true);
  assert.strictEqual(r.adapter, 'solarman_v5');
  // Disabling remote mode IS the hand-over: the inverter then runs its OWN
  // configuration, which is the native self-consumption loop.
  assert.deepStrictEqual(r.planned.map((w) => [w.addr, w.value]), [[0x044c, 0]]);
  assert.deepStrictEqual(r.plannedReadbacks.map((b) => [b.addr, b.expect]), [[0x044c, 0]]);
  // 1121 stays an OBSERVATION - out of the comparison so it can never fabricate
  // or break a verdict (the same rule the setpoint path applies).
  assert.deepStrictEqual(r.observations.map((o) => o.addr), [0x0461]);
  // The EEG proof is the device's own Program-1 charging enum.
  assert.strictEqual(r.gridChargeProof.addr, 0x00ac);
  assert.strictEqual(r.gridChargeProof.expect, 0);
  // Planned only: no certificate exists for any Deye.
  assert.deepStrictEqual(r.writes, []);
  assert.match(r.reason, /Pruefstand|Prüfstand/);
});

test('nativ: Deye OHNE Fernsteuer-Firmware ist bewusst nicht unterstuetzt', () => {
  const r = nat(DEYE_SEL, { deye: TOU_CAP });
  assert.strictEqual(r.supported, false);
  assert.deepStrictEqual(r.writes, []);
  assert.match(r.reason, /10-Sekunden-Nachf/);
});

test('nativ: Fronius Model 124 = StorCtl_Mod 0, mit ChaGriSet als EEG-Beleg', () => {
  const disc = froniusDiscoveryWithStorage();
  const r = nat(FRONIUS_SEL, { sunspec: disc });
  assert.strictEqual(r.supported, true);
  assert.strictEqual(r.adapter, 'fronius_sunspec');
  // planStorage(0) IS the primitive - its own comment says "NONE = release
  // control -> the inverter self-consumes". We reuse it rather than re-deriving
  // discovered addresses.
  const modeWrite = r.planned.find((w) => w.role === 'battery_storage_mode');
  assert.ok(modeWrite, 'the storage mode must be part of the plan');
  assert.strictEqual(modeWrite.value, 0);
  assert.strictEqual(r.gridChargeProof.addr, disc.storage.chaGriSetAddr);
  assert.deepStrictEqual(r.writes, []);
});

test('nativ: Fronius ohne Discovery erfindet keine Adresse', () => {
  const r = nat(FRONIUS_SEL, {});
  assert.strictEqual(r.supported, false);
  assert.deepStrictEqual(r.writes, []);
});

test('nativ: KOSTAL gibt zurueck, indem es NICHT MEHR SCHREIBT - Beleg behavioral', () => {
  const r = nat(kostalSel());
  assert.strictEqual(r.supported, true);
  assert.strictEqual(r.adapter, 'kostal_modbus');
  // The hand-over is the ABSENCE of a write: after the webserver timeout the
  // inverter returns to its internal battery management.
  assert.deepStrictEqual(r.planned, []);
  assert.strictEqual(r.proofKind, 'behavioral');
  // 1080 reads 2 in BOTH states, so no register distinguishes them - 582 is the
  // observation the bench criterion keys on.
  assert.deepStrictEqual(r.plannedReadbacks.map((b) => b.addr), [1080]);
  assert.deepStrictEqual(r.observations.map((o) => o.addr), [582]);
  // And with no readable charge-source statement an EEG site is refused.
  assert.strictEqual(r.gridChargeProof, null);
  const eeg = nat(kostalSel(), { solarOnlyCharge: true });
  assert.deepStrictEqual(eeg.writes, []);
  assert.match(eeg.reason, /EEG/);
});

test('nativ: KACO NH3 schreibt 41104 = 2 (Eigenverbrauch) - sein einziger Failsafe', () => {
  const r = nat(KACO_NH3_SEL);
  assert.strictEqual(r.supported, true);
  assert.strictEqual(r.adapter, 'kaco_nh3');
  assert.deepStrictEqual(r.planned.map((w) => [w.addr, w.value]), [[41104, 2]]);
  assert.deepStrictEqual(r.plannedReadbacks.map((b) => [b.addr, b.expect]), [[41104, 2]]);
  assert.deepStrictEqual(r.writes, []);
});

test('nativ: ohne Batterie gibt es keine Automatik', () => {
  const kacoSunspec = {
    schema_version: '1.0', brand: 'kaco', family: 'sunspec_live',
    communication: 'sunspec_tcp', control_tier: 1, connection: { ip: '10.0.0.4', port: 502 },
  };
  assert.strictEqual(nat(kacoSunspec).supported, false);
});

test('nativ: der Not-Aus und die fehlende Freigabe halten - jede mit ihrem Grund', () => {
  const sim = {
    schema_version: '1.0', brand: 'generic_modbus', model: 'sunspec-sim', family: 'sunspec',
    communication: 'modbus_tcp', connection: { ip: '10.0.0.5', port: 502, unit_id: 1, firmware: 'sim' },
  };
  const cat = require('./unplanned-load-native').SIMULATOR_NATIVE_CAPABILITIES;
  // Kill-switch off: nothing is handed over, and the reason names the stop.
  const off = C.nativeSelfConsumption(sim, { controlEnabled: false, catalog: cat });
  assert.deepStrictEqual(off.writes, []);
  assert.match(off.reason, /Not-Aus/);
  // An uncertified FAMILY cannot hand over either (the same disjunction the
  // setpoint path uses: what may be driven may be handed over, nothing else).
  const foreign = { ...sim, family: 'hybrid_3p', communication: 'modbus_tcp' };
  const un = C.nativeSelfConsumption(foreign, { controlEnabled: true, catalog: cat });
  assert.deepStrictEqual(un.writes, []);
  assert.match(un.reason, /freigegeben/);
  // Released, and the certificate matches the shipped plan.
  const ok = C.nativeSelfConsumption(sim, { controlEnabled: true, catalog: cat });
  assert.strictEqual(ok.writes.length, 3); // the native pair + the PV cap
  assert.strictEqual(ok.certificate.simulator_only, true);
});

test('nativ: eine Freigabe, die den Schreibplan nicht mehr beschreibt, wird verweigert', () => {
  const sim = {
    schema_version: '1.0', brand: 'generic_modbus', model: 'sunspec-sim', family: 'sunspec',
    communication: 'modbus_tcp', connection: { ip: '10.0.0.5', port: 502, unit_id: 1, firmware: 'sim' },
  };
  const drifted = require('./unplanned-load-native').SIMULATOR_NATIVE_CAPABILITIES.map((c) => ({
    ...c, chargeBlockWrites: [{ addr: 41, value: 0 }], // the bench measured ONE write
  }));
  const r = C.nativeSelfConsumption(sim, { controlEnabled: true, catalog: drifted });
  assert.deepStrictEqual(r.writes, []);
  assert.match(r.reason, /stimmen nicht ueberein|Freigabe erneuern/);
});

const NATIVE = require('./unplanned-load-native');

// --- THE PILOT RELEASE (2026-08-26) ------------------------------------------
//
// Captain decision: "kein separater Pruefstand - der Deye-Pilot IST der
// Pruefstand". The certificate is released for exactly ONE (brand, model,
// probed firmware) triple; everything below pins how narrow that is and what
// still refuses at RUNTIME even with the certificate in hand.

// The pilot as the core publishes it on edge/inverter/config: `model` is the
// CATALOG MODEL ID (inverter.go deyeModels(), label "SUN-30K-SG01HP3-EU"), and
// there is deliberately NO connection.firmware - on this family the firmware
// key is the DEVICE's own answer to the capability probe.
const PILOT_SEL = {
  schema_version: '1.0', brand: 'deye', model: 'sun-30k-sg01hp3', family: 'hybrid_3p',
  communication: 'solarman_v5',
  connection: { ip: '192.168.254.210', port: 8899, serial: '1127365518', mb_slave_id: 1 },
};
// The device's own Time-of-Use configuration, read via the adapter's
// `preconditions` before the hand-over: armed, target SoC at/below the reserve
// floor, grid charging disabled.
const PILOT_OWN_CFG = { tou_enable: 0x00ff, program_target_soc: 15, grid_charge_enable: 0 };
const pilotOpts = (over = {}) => ({
  controlEnabled: true, deviceCertified: true, deye: OWNER_CAP,
  effectiveFloorSocPct: 20, deyeOwnConfig: PILOT_OWN_CFG, ...over,
});

test('Pilot-Freigabe: der Deye des Piloten gibt die Fernsteuerung wirklich ab', () => {
  const r = C.nativeSelfConsumption(PILOT_SEL, pilotOpts());
  assert.strictEqual(r.supported, true);
  // ONE write: disabling remote mode IS the hand-over.
  assert.deepStrictEqual(r.writes.map((w) => [w.addr, w.value]), [[0x044c, 0]]);
  assert.deepStrictEqual(r.readbacks.map((b) => [b.addr, b.expect]), [[0x044c, 0]]);
  // The certificate is keyed on the PROBED firmware, not a typed string.
  assert.strictEqual(r.certificate.brand, 'deye');
  assert.strictEqual(r.certificate.model, 'sun-30k-sg01hp3');
  assert.strictEqual(r.certificate.firmware, NATIVE.DEYE_REMOTE_PR978_FIRMWARE);
  assert.strictEqual(r.certificate.simulator_only, false);
  assert.notStrictEqual(r.certificate.bench_record, '');
  // The EEG proof register and the 1121 observation are unchanged.
  assert.strictEqual(r.gridChargeProof.addr, 0x00ac);
  assert.deepStrictEqual(r.observations.map((o) => o.addr), [0x0461]);
  // And it NAMES what an executor has to read before letting go.
  assert.deepStrictEqual(r.preconditions.map((p) => [p.role, p.addr]),
    [['tou_enable', 0x0092], ['program_target_soc', 0x00a6], ['grid_charge_enable', 0x00ac]]);
});

test('Pilot-Freigabe: sie gilt NUR diesem Modell und NUR mit der gesondeten Firmware', () => {
  // A sister model of the same family: same register map, but the bench result
  // belongs to one product.
  const sister = { ...PILOT_SEL, model: 'sun-50k-sg01hp3' };
  const s = C.nativeSelfConsumption(sister, pilotOpts());
  assert.deepStrictEqual(s.writes, []);
  assert.match(s.reason, /Pruefstand|Prüfstand/);

  // A legacy selection without a model id can never match an exact certificate.
  const noModel = { ...PILOT_SEL, model: undefined };
  assert.deepStrictEqual(C.nativeSelfConsumption(noModel, pilotOpts()).writes, []);

  // The SAME model whose firmware carries no remote block at all: the adapter
  // has no primitive there and says so - never a native write.
  const touOnly = C.nativeSelfConsumption(PILOT_SEL, pilotOpts({ deye: TOU_CAP }));
  assert.strictEqual(touOnly.supported, false);
  assert.deepStrictEqual(touOnly.writes, []);
  assert.match(touOnly.reason, /10-Sekunden-Nachf/);

  // And the OLDER v105_1 register layout (AC-side setpoint 1111) is present but
  // not what the adapter writes - so it never produces the firmware key either.
  const v105 = C.classifyDeyeCapability({
    deviceType: 0x0008,
    remoteBlock: (() => {
      const b = new Array(22).fill(0);
      b[1101 - 1100] = 0xffff; b[1106 - 1100] = 1; b[1111 - 1100] = 200;
      b[1104 - 1100] = 9; // out of the pr978 range, so only the v105_1 shape fits
      return b;
    })(),
  });
  assert.strictEqual(v105.layout, 'v105_1');
  const old = C.nativeSelfConsumption(PILOT_SEL, pilotOpts({ deye: v105 }));
  assert.strictEqual(old.supported, false);
  assert.deepStrictEqual(old.writes, []);

  // An operator-typed firmware string cannot stand in for the probe...
  const typed = { ...PILOT_SEL,
    connection: { ...PILOT_SEL.connection, firmware: NATIVE.DEYE_REMOTE_PR978_FIRMWARE } };
  assert.deepStrictEqual(C.nativeSelfConsumption(typed, pilotOpts({ deye: TOU_CAP })).writes, []);
  // ...and it cannot BLOCK it either: a leftover string in the stored connection
  // (an old config, a hand-edited file) is not evidence, so the PROBE wins and
  // the pilot still resolves. Without that precedence a stale field would have
  // silently kept a released device on the follower.
  const stale = { ...PILOT_SEL, connection: { ...PILOT_SEL.connection, firmware: 'V1' } };
  const r = C.nativeSelfConsumption(stale, pilotOpts());
  assert.deepStrictEqual(r.writes.map((w) => [w.addr, w.value]), [[0x044c, 0]]);
  assert.strictEqual(r.certificate.firmware, NATIVE.DEYE_REMOTE_PR978_FIRMWARE);
});

test('Pilot-Freigabe: eine REMOTE-Entscheidung mit fremder Registerlage gibt nichts frei', () => {
  // The reachable shape this guards: the sticky decision says REMOTE (seeded from
  // the core's First-Light grant, deyeSeedStickyFromGrant) while the last
  // DEFINITIVE probe classified the older v105_1 layout. deyeEffectiveCap then
  // synthesises a remote-path capability carrying THAT layout - and the adapter
  // writes only the PR-978 register set, so its firmware key must not be handed
  // out. Path alone is not enough; the LAYOUT is part of the gate.
  const v105 = C.classifyDeyeCapability({
    deviceType: 0x0008,
    remoteBlock: (() => {
      const b = new Array(22).fill(0);
      b[1101 - 1100] = 0xffff; b[1104 - 1100] = 9; b[1106 - 1100] = 1; b[1111 - 1100] = 200;
      return b;
    })(),
  });
  assert.strictEqual(v105.layout, 'v105_1');
  const sticky = { path: 'remote', since: 1, contrary: 0, everRemote: true, verdict: v105 };
  const eff = C.deyeEffectiveCap(null, sticky);
  assert.strictEqual(eff.supported, true, 'the decision really selects the remote path');
  assert.strictEqual(eff.layout, 'v105_1', 'while carrying the foreign layout');
  const r = C.nativeSelfConsumption(PILOT_SEL, pilotOpts({ deye: null, deyeSticky: sticky }));
  assert.strictEqual(r.supported, false);
  assert.deepStrictEqual(r.writes, []);
  assert.match(r.reason, /10-Sekunden-Nachf/);
});

test('Pilot-Freigabe: die eigene Konfiguration des Geraets kann sie zur Laufzeit verweigern', () => {
  // Deye manual (SUN-29.9..50K-SG01HP3-EU-BM3/BM4, 2025-08-19): without Time of
  // Use the inverter "can charge normally, but only discharge to provide the
  // inverter's self-consumption power, without discharging to power the loads" -
  // so letting go would NOT produce a covering mode, and nothing downstream
  // could tell (the device would still report the native mode correctly).
  const noTou = C.nativeSelfConsumption(PILOT_SEL,
    pilotOpts({ deyeOwnConfig: { ...PILOT_OWN_CFG, tou_enable: 0x0000 } }));
  assert.deepStrictEqual(noTou.writes, []);
  assert.match(noTou.reason, /Zeitfenster-Programm .*nicht aktiv/);

  // A target SoC ABOVE our reserve floor ends the covering early.
  const highTarget = C.nativeSelfConsumption(PILOT_SEL,
    pilotOpts({ deyeOwnConfig: { ...PILOT_OWN_CFG, program_target_soc: 40 } }));
  assert.deepStrictEqual(highTarget.writes, []);
  assert.match(highTarget.reason, /Ziel-Ladeniveau/);

  // On an EEG site the device's own charging enum must already say "not from
  // grid" BEFORE we let go - the after-proof (gridChargeProof) is not enough.
  const eeg = C.nativeSelfConsumption(PILOT_SEL, pilotOpts({
    solarOnlyCharge: true, deyeOwnConfig: { ...PILOT_OWN_CFG, grid_charge_enable: 1 },
  }));
  assert.deepStrictEqual(eeg.writes, []);
  assert.match(eeg.reason, /EEG/);
  // Same site, charging disabled -> released.
  assert.strictEqual(C.nativeSelfConsumption(PILOT_SEL,
    pilotOpts({ solarOnlyCharge: true })).writes.length, 1);

  // UNKNOWN is a refusal, never an assumption - each of these on its own.
  for (const over of [
    { deyeOwnConfig: undefined },
    { deyeOwnConfig: { ...PILOT_OWN_CFG, tou_enable: undefined } },
    { deyeOwnConfig: { ...PILOT_OWN_CFG, program_target_soc: undefined } },
    { effectiveFloorSocPct: undefined },
  ]) {
    const r = C.nativeSelfConsumption(PILOT_SEL, pilotOpts(over));
    assert.deepStrictEqual(r.writes, [], JSON.stringify(over));
    assert.ok(r.reason && r.reason.length > 0, 'a refusal always names itself');
  }
});

test('Pilot-Freigabe: Not-Aus und fehlende Geraete-Freigabe halten unveraendert', () => {
  const off = C.nativeSelfConsumption(PILOT_SEL, pilotOpts({ controlEnabled: false }));
  assert.deepStrictEqual(off.writes, []);
  assert.match(off.reason, /Not-Aus/);
  const un = C.nativeSelfConsumption(PILOT_SEL, pilotOpts({ deviceCertified: false }));
  assert.deepStrictEqual(un.writes, []);
  assert.match(un.reason, /freigegeben/);
});

test('deyeNativePrecondition ist rein und urteilt nur ueber Belegtes', () => {
  const ok = { tou_enable: 0x00ff, program_target_soc: 10, grid_charge_enable: 0 };
  assert.strictEqual(C.deyeNativePrecondition(ok, { floorPct: 20 }), null);
  // A target EQUAL to the floor is fine - the device stops exactly where we would.
  assert.strictEqual(C.deyeNativePrecondition({ ...ok, program_target_soc: 20 }, { floorPct: 20 }), null);
  // Only bit0 is the enable; the weekday bits above it must not be required.
  assert.strictEqual(C.deyeNativePrecondition({ ...ok, tou_enable: 0x0003 }, { floorPct: 20 }), null);
  assert.ok(C.deyeNativePrecondition({ ...ok, tou_enable: 0x00fe }, { floorPct: 20 }));
  // An out-of-range SoC is not a reading.
  assert.ok(C.deyeNativePrecondition({ ...ok, program_target_soc: 255 }, { floorPct: 20 }));
  // Without the EEG posture the charging enum is not judged (it is an economic
  // matter there, not a compliance one - and the plan already priced the slot).
  assert.strictEqual(
    C.deyeNativePrecondition({ ...ok, grid_charge_enable: 1 }, { floorPct: 20 }), null);

  // ⚠ An ABSENT register must not read as a real 0 (Number(null) === 0). Both
  // outcomes refuse, but only one of them tells the operator the truth.
  assert.match(C.deyeNativePrecondition({ ...ok, tou_enable: null }, { floorPct: 20 }),
    /nicht gelesen werden/);
  assert.match(C.deyeNativePrecondition({ ...ok, program_target_soc: null }, { floorPct: 20 }),
    /nicht gelesen werden/);
  assert.match(C.deyeNativePrecondition(ok, { floorPct: null }),
    /Reserve-Untergrenze der Anlage ist nicht bekannt/);
  // A floor of 0 is a real floor, not a missing one.
  assert.ok(C.deyeNativePrecondition(ok, { floorPct: 0 }).includes('0 %'));
  // On an EEG site an absent charging enum is refused, never read as Disabled.
  assert.match(
    C.deyeNativePrecondition({ ...ok, grid_charge_enable: null }, { floorPct: 20, solarOnly: true }),
    /EEG/);
});

// --- Netz-Sollwert-Test (Konzept `vp-deye-netzseitig-drossel-k2` P1) ----------
//
// Der Testpfad ist eine EIGENE Regelseite auf DERSELBEN Adresse 1109. Was hier
// gepinnt ist: die Schreibreihenfolge (Watchdog zuerst, Enable zuletzt, der
// Neutralschritt DAZWISCHEN), die zwei Vorzeichen-Konventionen, die PV-Kappe und
// dass der Test ausserhalb von 1100-1121 nichts anfasst.

const gridSp = (over) => enabled({
  device_certified: true,
  grid_test: { mode: 'grid', step: 'halten', side: 'grid', target_kw: -24.9, ...over },
});
const gridRoute = (over, opts) => C.controlRoute(DEYE_REMOTE_SEL, gridSp(over),
  { ratedKw: 30, deye: OWNER_CAP, ...opts });

test('Netz-Sollwert-Test: die REIHENFOLGE ist die Sicherheit', () => {
  // Watchdog ZUERST (der Totmann wird gespannt, bevor sich etwas bewegen kann),
  // Enable ZULETZT - dazwischen die Regelseite und der Sollwert.
  const r = gridRoute();
  assert.deepStrictEqual(r.writes.map((w) => w.role),
    ['remote_watchdog', 'power_control_mode', 'grid_power', 'remote_mode']);
  assert.strictEqual(r.writes[0].addr, 0x044d, '1101 = der Totmann');
  const last = r.writes[r.writes.length - 1];
  assert.strictEqual(last.addr, 0x044c, '1100 = der Schalter, und er kommt ZULETZT');
  assert.strictEqual(last.value, 1);

  // ⚠ Der Neutralschritt steht ZWISCHEN Watchdog und Regelseite: 1109 muss auf 0,
  // BEVOR 1104 die Bedeutung derselben Adresse wechselt.
  const n = gridRoute({ neutralize: true, step: 'halten' });
  assert.deepStrictEqual(n.writes.map((w) => w.role),
    ['remote_watchdog', 'grid_neutral', 'power_control_mode', 'grid_power', 'remote_mode']);
  const neutral = n.writes[1];
  assert.strictEqual(neutral.value, 0);
  assert.strictEqual(neutral.addr, n.writes[3].addr, 'der Neutralschritt schreibt DIESELBE Adresse 1109');

  // Der Neutralschritt wird NICHT zurueckgelesen - derselbe Takt ueberschreibt
  // ihn, ein Rueckelesen ergaebe eine garantierte Abweichung.
  assert.ok(!n.readbacks.some((rb) => rb.role === 'grid_neutral'));
  assert.deepStrictEqual(n.readbacks.map((rb) => rb.role),
    ['remote_watchdog', 'power_control_mode', 'grid_power', 'remote_mode']);
});

test('Netz-Sollwert-Test: ZWEI Vorzeichen-Konventionen auf DERSELBEN Adresse', () => {
  // ⚠ Netzseitig ist die Konvention DIREKT (- = Einspeisung, wie unsere), also
  // wird NICHT negiert: -24,9 kW von 30 kW = -830 Einheiten.
  const g = gridRoute({ side: 'grid', target_kw: -24.9 });
  const gw = g.writes.find((w) => w.role === 'grid_power');
  assert.strictEqual(gw.encode.kind, 'grid_power_permille');
  assert.strictEqual(gw.encode.units, -830);
  assert.strictEqual(gw.value, (-830) & 0xffff);

  // Batterieseitig (Neutral-/Rueckkehr-Schritt) gilt die gewohnte, NEGIERTE
  // Umrechnung und die gewohnte Rolle.
  const b = gridRoute({ side: 'battery', step: 'rueckkehr', target_kw: 0 });
  const bw = b.writes.find((w) => w.role === 'battery_power');
  assert.ok(bw, 'batterieseitig traegt der Sollwert seine gewohnte Rolle');
  assert.strictEqual(bw.encode.kind, 'remote_power_permille');
  assert.strictEqual(b.writes.find((w) => w.role === 'power_control_mode').value, 1);

  // Die AC-Seite ist ihre eigene Rolle - dieselbe DIREKTE Konvention.
  const ac = gridRoute({ side: 'ac', step: 'ac_probe', target_kw: 19 });
  const acw = ac.writes.find((w) => w.role === 'ac_power');
  assert.strictEqual(acw.encode.kind, 'ac_power_permille');
  assert.strictEqual(acw.encode.units, Math.round((19 / 30) * 1000));
  assert.strictEqual(ac.writes.find((w) => w.role === 'power_control_mode').value, 0);
});

test('Netz-Sollwert-Test: 1115 wird nur IM Band geschrieben (§1.7)', () => {
  const none = gridRoute();
  assert.ok(!none.writes.some((w) => w.role === 'pv_max_permille'),
    'ohne Anweisung wird 1115 nicht angefasst');

  const cap = gridRoute({ pv_cap_permille: 999 });
  const w = cap.writes.find((w) => w.role === 'pv_max_permille');
  assert.ok(w, 'die PV-Kappe wird geschrieben');
  assert.strictEqual(w.addr, 0x045b, '1115');
  assert.strictEqual(w.value, 999);
  // ⚠ 1000 und darueber bedeutet auf diesem Register „PV auf 0" - genau der
  // Wert, der die Anlage stillstellt. Er wird nie geschrieben.
  for (const bad of [1000, 1200, 0, -1, 65535, null, 'x']) {
    assert.ok(!gridRoute({ pv_cap_permille: bad }).writes.some((w) => w.role === 'pv_max_permille'),
      'pv_cap_permille=' + bad + ' darf 1115 nie erreichen');
  }
});

test('Netz-Sollwert-Test: eine kaputte Form faellt auf den GEWOEHNLICHEN Plan zurueck', () => {
  // Ein halb ausgefuehrter Testschritt waere schlimmer als gar keiner.
  for (const bad of [
    { step: 'quatsch' }, { side: 'quatsch' }, { target_kw: null },
    { target_kw: 'x' }, { step: undefined }, { side: undefined },
  ]) {
    const r = gridRoute(bad);
    assert.strictEqual(r.gridTest, undefined, JSON.stringify(bad) + ' darf keinen Testschritt erzeugen');
  }
  // Und ein fehlender Block laesst den Adapter voellig unveraendert.
  const plain = C.controlRoute(DEYE_REMOTE_SEL, enabled({ device_certified: true, battery_setpoint_kw: -5 }),
    { ratedKw: 30, deye: OWNER_CAP });
  assert.strictEqual(plain.gridTest, undefined);
  assert.ok(plain.writes.length > 0, 'der gewoehnliche Fernsteuerplan laeuft weiter');
});

test('Netz-Sollwert-Test: er faesst NUR 1100-1121 an und umgeht KEIN Tor', () => {
  const r = gridRoute({ neutralize: true, pv_cap_permille: 999 });
  for (const w of r.writes) {
    assert.ok(w.addr >= 0x044c && w.addr <= 0x0461,
      'Adresse ausserhalb des Fernsteuerblocks: ' + w.addr);
  }
  // Kein Installateur-Register, kein ToU-Schnappschuss - es gibt nichts
  // zurueckzustellen.
  assert.ok(!r.snapshotPlan || r.snapshotPlan.length === 0);

  // Not-Aus: geplant bleibt sichtbar, geschrieben wird NICHTS.
  const off = C.controlRoute(DEYE_REMOTE_SEL,
    { ...gridSp(), control_enabled: false }, { ratedKw: 30, deye: OWNER_CAP });
  assert.deepStrictEqual(off.writes, []);
  assert.deepStrictEqual(off.readbacks, []);
  assert.ok(off.planned.length > 0, 'der Plan bleibt lesbar');
  assert.match(off.reason, /Not-Aus/);

  // Ohne Freigabe dieses Geraets ebenso - der Testpfad umgeht die
  // Zertifizierung NICHT (anders als die First-Light-Kalibrierung).
  const un = C.controlRoute(DEYE_REMOTE_SEL,
    { ...gridSp(), device_certified: false }, { ratedKw: 30, deye: OWNER_CAP });
  assert.deepStrictEqual(un.writes, []);
  assert.match(un.reason, /freigegeben/);

  // Und die ausgelieferte Familien-Allowlist wurde durch nichts davon geweitet.
  assert.ok(!C.CERTIFIED_CONTROL_FAMILIES.has('hybrid_3p'));
  assert.ok(!C.CERTIFIED_CONTROL_FAMILIES.has('hybrid_1p'));
});

test('Netz-Sollwert-Test: ohne Nennleistung wird nichts geschrieben', () => {
  // Die Umrechnung haengt an der Nennleistung; ohne sie waere jeder Wert geraten.
  const r = C.controlRoute(DEYE_REMOTE_SEL, gridSp(), { deye: OWNER_CAP });
  assert.deepStrictEqual(r.writes, []);
  assert.ok(r.reason && r.reason.length > 0);
});

test('Netz-Sollwert-Test: das Ziel wird auf das Register-Band geklemmt', () => {
  // ±1200 Einheiten sind die Grenze des Registers - ein groesseres Ziel wird
  // GEKLEMMT und das laut vermerkt, nie ueberlaufen.
  const r = gridRoute({ target_kw: -60 });
  const w = r.writes.find((w) => w.role === 'grid_power');
  assert.strictEqual(w.encode.units, -1200);
  assert.strictEqual(w.encode.clamped, true);
  assert.strictEqual(r.setpointClamped, true);
});
