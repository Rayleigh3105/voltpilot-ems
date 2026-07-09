'use strict';

/**
 * flows-sync.test.js - guards that the flows.json function nodes (which carry
 * COPIES of the repo codecs, since a Node-RED flow cannot `require` a repo file)
 * stay in sync with the tested source-of-truth modules:
 *   - the "Router / Leseplan" node vs inverter-routing.route()
 *   - the "Modbus-Register -> Messwerte" node vs modbus-tcp.decodeProfile()
 *
 * It runs the inlined function bodies in a sandbox with a minimal Node-RED
 * function-node context and asserts identical results.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const routing = require('./inverter-routing');
const controlRouting = require('./inverter-control-routing');
const modbusTcp = require('./modbus-tcp');
const deyeDecode = require('./deye/deye-decode');
const sourcesRouting = require('./sources-routing');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// Run a function-node body the way Node-RED does: it may `return` a value or
// an output array. Provides node/flow/context/global stubs.
function runFunctionNode(func, { msg = {}, flow = {} } = {}) {
  const flowStore = flow;
  const ctxStore = {};
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, send() {} },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    global: { get: () => undefined },
    RED: {},
    Buffer,
    Date,
    Math,
    isFinite,
    Number,
    Array,
    Object,
    JSON,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ctx = vm.createContext(sandbox);
  const ret = script.runInContext(ctx);
  // Normalize across the vm realm (its Object/Array prototypes differ, which
  // trips deepStrictEqual) - value-compare via a JSON round-trip.
  const norm = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return { ret: norm(ret), msg: norm(sandbox.msg) };
}

test('flow router matches inverter-routing.route() for solarman_v5', () => {
  const sel = {
    schema_version: '1.0', brand: 'deye', label: 'Deye', family: 'hybrid_3p',
    communication: 'solarman_v5',
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, invert_grid_sign: true, invert_batt_sign: true, power_scale: 10 },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  // output 1 carries msg.deye
  const outMsg = ret[0];
  const expected = routing.route(routing.parseConfig(sel));
  assert.strictEqual(outMsg.deye.target, expected.target);
  assert.strictEqual(outMsg.deye.cfg.family, expected.family);
  assert.strictEqual(outMsg.deye.cfg.serial, expected.connection.serial);
  assert.strictEqual(outMsg.deye.cfg.invert_grid_sign, expected.connection.invert_grid_sign);
  assert.strictEqual(outMsg.deye.cfg.invert_batt_sign, expected.connection.invert_batt_sign);
  assert.strictEqual(outMsg.deye.cfg.power_scale, expected.connection.power_scale);
  assert.deepStrictEqual(outMsg.deye.reads, expected.reads);
});

test('flow router matches inverter-routing.route() for modbus_tcp', () => {
  const sel = {
    schema_version: '1.0', brand: 'generic_modbus', label: 'Modbus', family: 'sunspec',
    communication: 'modbus_tcp', connection: { ip: 'edge-sim', port: 502, unit_id: 1, profile: 'sunspec' },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  const outMsg = ret[1]; // output 2 carries msg.mb
  const expected = routing.route(routing.parseConfig(sel));
  assert.strictEqual(outMsg.mb.target, expected.target);
  assert.strictEqual(outMsg.mb.profile, expected.profile);
  assert.strictEqual(outMsg.mb.conn.unit_id, expected.connection.unit_id);
  assert.deepStrictEqual(outMsg.mb.read, expected.read);
});

test('flow router routes to idle (output 3) with no selection', () => {
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: {} });
  assert.strictEqual(ret[0], null);
  assert.strictEqual(ret[1], null);
  assert.ok(ret[2] && ret[2].idle);
});

// The "Deye-Register -> Messwerte" node carries a synced copy of deye-decode.js
// (the generator preserves it verbatim, so nothing else guards the sync). These
// assert the inline body matches the module - crucially incl. the SoC
// plausibility gate that drops degraded/unanswered reads (the 0/100-spike fix).
function runDeyeDecode(cfg, blocks) {
  return runFunctionNode(byId['auto-deye-decode'].func, {
    msg: { deye: { cfg, blocks } },
  });
}

test('flow Deye decoder matches deye-decode.decode() for a real hybrid_3p read', () => {
  const cfg = { family: 'hybrid_3p', power_scale: 1 };
  const regs = new Array(0x58).fill(0);
  regs[0x024c - 0x024c] = 57; // SoC 57 %
  regs[0x028d - 0x024c] = 2400; // load 2.4 kW
  regs[0x0271 - 0x024c] = 900; // grid 0.9 kW
  const blocks = [{ start: 0x024c, regs }];
  const { ret } = runDeyeDecode(cfg, blocks);
  const flowReading = ret[0].payload;
  delete flowReading.ts; // the flow stamps a live ts
  assert.deepStrictEqual(flowReading, deyeDecode.decode(blocks, cfg).reading);
  assert.strictEqual(flowReading.soc_pct, 57);
});

test('flow Deye decoder DROPS an all-zero (unanswered) hybrid_3p read, like the module', () => {
  const cfg = { family: 'hybrid_3p' };
  const blocks = [{ start: 0x024c, regs: new Array(0x58).fill(0) }];
  const { ret } = runDeyeDecode(cfg, blocks);
  assert.strictEqual(ret, null, 'flow node returns null -> no telemetry published');
  assert.strictEqual(deyeDecode.decode(blocks, cfg), null, 'module agrees');
});

test('flow Deye decoder DROPS an out-of-range SoC hybrid_3p read, like the module', () => {
  const cfg = { family: 'hybrid_3p' };
  const regs = new Array(0x58).fill(0);
  regs[0] = 1250; // garbage SoC
  regs[0x028d - 0x024c] = 3000;
  const blocks = [{ start: 0x024c, regs }];
  const { ret } = runDeyeDecode(cfg, blocks);
  assert.strictEqual(ret, null);
  assert.strictEqual(deyeDecode.decode(blocks, cfg), null);
});

// The "Steuerung / Schreibplan" node (auto-control-plan) carries a synced COPY
// of inverter-control-routing.controlRoute(). These assert the inline body's
// write plan matches the module byte-for-byte (JSON-compared) - the safety-
// critical drift guard: a divergence could silently re-enable a gated write.
function runControlPlan(sel, setpoint) {
  const { msg } = runFunctionNode(byId['auto-control-plan'].func, {
    msg: { setpoint }, flow: { inverter_config: sel },
  });
  return msg.control;
}

test('flow control planner matches controlRoute() for a certified SunSpec write', () => {
  const sel = {
    schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
    communication: 'modbus_tcp', connection: { ip: 'edge-sim', port: 502, unit_id: 1 },
  };
  const sp = { battery_setpoint_kw: -25, pv_limit_kw: 3, source: 'schedule', control_enabled: true };
  const flowPlan = runControlPlan(sel, sp);
  const modulePlan = JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, {})));
  assert.deepStrictEqual(flowPlan, modulePlan);
  assert.strictEqual(flowPlan.writes.length, 3, 'certified + enabled -> writes');
});

test('flow control planner matches controlRoute() with the kill-switch OFF (no writes)', () => {
  const sel = {
    schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
    communication: 'modbus_tcp', connection: { ip: 'edge-sim', port: 502, unit_id: 1 },
  };
  const sp = { battery_setpoint_kw: -25, source: 'schedule', control_enabled: false };
  const flowPlan = runControlPlan(sel, sp);
  assert.deepStrictEqual(flowPlan, JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, {}))));
  assert.deepStrictEqual(flowPlan.writes, [], 'kill-switch off -> no writes');
  assert.strictEqual(flowPlan.readbacks.length, 3, 'readbacks still run');
});

test('flow control planner keeps Deye read-only (uncertified) like the module', () => {
  const sel = {
    schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5',
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 },
  };
  const sp = { battery_setpoint_kw: -20, pv_limit_kw: 25, source: 'schedule', control_enabled: true };
  const flowPlan = runControlPlan(sel, sp);
  assert.deepStrictEqual(flowPlan, JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, {}))));
  assert.deepStrictEqual(flowPlan.writes, [], 'Deye never emits an executable write');
  assert.strictEqual(flowPlan.certified, false);
});

test('flow control planner matches the module for the OTHER Deye branches (hybrid_1p, string)', () => {
  const base = { schema_version: '1.0', brand: 'deye', communication: 'solarman_v5', connection: { ip: '10.1.2.3', port: 8899, serial: '2985159064', mb_slave_id: 1 } };
  // hybrid_1p (its own register block) and a charging setpoint that grid-charges.
  const sel1p = { ...base, family: 'hybrid_1p' };
  const sp1p = { battery_setpoint_kw: 6, pv_limit_kw: 4, grid_charge_allowed: true, source: 'schedule', control_enabled: true };
  assert.deepStrictEqual(runControlPlan(sel1p, sp1p), JSON.parse(JSON.stringify(controlRouting.controlRoute(sel1p, sp1p, {}))));
  // string (no battery -> the reg==null inline branch)
  const selStr = { ...base, family: 'string' };
  const spStr = { battery_setpoint_kw: 0, source: 'schedule', control_enabled: true };
  assert.deepStrictEqual(runControlPlan(selStr, spStr), JSON.parse(JSON.stringify(controlRouting.controlRoute(selStr, spStr, {}))));
});

test('flow modbus decoder matches modbus-tcp.decodeProfile() (sunspec)', () => {
  const regs = [250, 1200, 800, 500, 550, 7000, 5000, 0, 0];
  const msg = { mb: { profile: 'sunspec', regs } };
  const { ret } = runFunctionNode(byId['auto-mb-decode'].func, { msg });
  const flowReading = ret[0].payload; // output 1 payload
  const expected = modbusTcp.decodeProfile('sunspec', regs).reading;
  // the flow adds a live ts; compare the measurement fields only
  delete flowReading.ts;
  assert.deepStrictEqual(flowReading, expected);
});

// The "Quellen uebernehmen" (sources-store) node carries a synced copy of the
// modbus branch of sources-routing.planSources: given the retained source array
// it must build the same per-source read plans (id + connection + read) the
// module produces for modbus_tcp Erzeuger sources, and count/skip the rest.
test('flow sources-store matches sources-routing.planSources for modbus sources', () => {
  const payload = [
    { id: 'src-a', role: 'pv-generation', brand: 'generic_modbus', model: 'sunspec', family: 'sunspec',
      communication: 'modbus_tcp', connection: { ip: '192.168.0.70', port: 502, unit_id: 2 }, capacity_kwp: 70 },
    { id: 'src-deye', role: 'pv-generation', brand: 'deye', family: 'hybrid_3p',
      communication: 'solarman_v5', connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 } },
    { id: 'src-load', role: 'grid-meter', communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '1.2.3.4' } },
  ];
  const flow = {};
  runFunctionNode(byId['sources-store'].func, { msg: { payload }, flow });
  // Normalize across the vm realm (its Object/Array prototypes trip deepStrictEqual).
  const plans = JSON.parse(JSON.stringify(flow.source_plans));
  // Only the modbus Erzeuger source is planned (Deye deferred, grid-meter role ignored).
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-a');
  assert.equal(plans[0].conn.ip, '192.168.0.70');
  assert.equal(plans[0].conn.unit_id, 2);
  assert.deepStrictEqual(plans[0].read, { fc: 3, addr: 0, count: 9 });

  // Cross-check against the module: it recognises BOTH the modbus and the deye
  // Erzeuger source (routing), and the flow store keeps the modbus one.
  const routed = sourcesRouting.planSources(sourcesRouting.parseSourcesConfig({ schema_version: '1.0', sources: payload }));
  const modbusRouted = routed.filter((r) => r.plan.adapter === 'modbus_tcp');
  assert.equal(modbusRouted.length, 1);
  assert.equal(modbusRouted[0].id, plans[0].id);
});

// The "Erzeuger-Quellen lesen" node decodes SunSpec PV the same way the shared
// modbus decode does - the source reader only forwards PV (a source is an
// Erzeuger). We assert its inline sunspec PV decode equals modbus-tcp's.
test('flow sources-read decodes SunSpec PV consistently with modbus-tcp', () => {
  const regs = new Array(9).fill(0);
  regs[1] = 4200; // pv 42.00 kW (s16/100)
  // Drive one plan through a fake socket is out of scope here; instead assert the
  // decode constant the inline body uses matches the module's pv field.
  const expected = modbusTcp.decodeProfile('sunspec', regs).reading.pv_power_kw;
  assert.equal(expected, 42);
  // The inline decodePv uses s16(regs[1])/100 -> identical to the module's pv.
  assert.ok(byId['sources-read'].func.includes('s16(regs[1]) / 100'));
});
