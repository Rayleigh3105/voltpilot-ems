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
const froniusSolarApi = require('./fronius/solar-api');
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

test('flow router matches inverter-routing.route() for fronius_solar_api', () => {
  const sel = {
    schema_version: '1.0', brand: 'fronius', label: 'Fronius', family: 'fronius_solar_api',
    communication: 'fronius_solar_api',
    connection: { ip: '192.168.0.20', port: 80, insecure_tls: false, invert_grid_sign: false },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  const outMsg = ret[2]; // output 3 carries msg.fronius
  const expected = routing.route(routing.parseConfig(sel));
  assert.strictEqual(outMsg.fronius.url, expected.url);
  assert.strictEqual(outMsg.fronius.target, expected.target);
  assert.strictEqual(outMsg.fronius.scheme, expected.scheme);
  assert.strictEqual(outMsg.fronius.insecure_tls, expected.connection.insecure_tls);
  assert.strictEqual(outMsg.fronius.invert_grid_sign, expected.connection.invert_grid_sign);
  // the other branches (incl. sunspec output 4 + idle output 5) must be null here.
  assert.strictEqual(ret[0], null);
  assert.strictEqual(ret[1], null);
  assert.strictEqual(ret[3], null);
  assert.strictEqual(ret[4], null);
});

test('flow router matches inverter-routing.route() for fronius_sunspec', () => {
  const sel = {
    schema_version: '1.0', brand: 'fronius_sunspec', label: 'Fronius Eco', family: 'sunspec_live',
    communication: 'fronius_sunspec',
    connection: { ip: '192.168.210.40', port: 502, unit_id: 1, model_type: 'float', invert_grid_sign: false },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  const outMsg = ret[3]; // output 4 carries msg.sunspec
  const expected = routing.route(routing.parseConfig(sel));
  assert.strictEqual(outMsg.sunspec.target, expected.target);
  assert.strictEqual(outMsg.sunspec.conn.ip, expected.connection.ip);
  assert.strictEqual(outMsg.sunspec.conn.port, expected.connection.port);
  assert.strictEqual(outMsg.sunspec.conn.unit_id, expected.connection.unit_id);
  assert.strictEqual(outMsg.sunspec.conn.model_type, expected.connection.model_type);
  assert.strictEqual(outMsg.sunspec.conn.invert_grid_sign, expected.connection.invert_grid_sign);
  // the other branches must be null on this path.
  assert.strictEqual(ret[0], null);
  assert.strictEqual(ret[1], null);
  assert.strictEqual(ret[2], null);
  assert.strictEqual(ret[4], null);
});

test('flow router routes to idle (output 5) with no selection', () => {
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: {} });
  assert.strictEqual(ret[0], null);
  assert.strictEqual(ret[1], null);
  assert.strictEqual(ret[2], null);
  assert.strictEqual(ret[3], null);
  assert.ok(ret[4] && ret[4].idle);
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

test('flow control planner keeps Fronius planned-only (uncertified) like the module', () => {
  const sel = {
    schema_version: '1.0', brand: 'fronius', family: 'fronius_solar_api',
    communication: 'fronius_solar_api', connection: { ip: '192.168.0.20', port: 80 },
  };
  const sp = { battery_setpoint_kw: 0, pv_limit_kw: 6, source: 'schedule', control_enabled: true };
  const flowPlan = runControlPlan(sel, sp);
  assert.deepStrictEqual(flowPlan, JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, {}))));
  assert.strictEqual(flowPlan.adapter, 'fronius_sunspec');
  assert.strictEqual(flowPlan.certified, false);
  assert.deepStrictEqual(flowPlan.writes, [], 'Fronius never emits an executable write');
  assert.deepStrictEqual(flowPlan.readbacks, []);
  // no discovery in-flow this increment -> no fabricated planned address
  assert.deepStrictEqual(flowPlan.planned, []);
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

// The "Fronius PowerFlow -> Messwerte" node (auto-fronius-decode) carries a
// synced COPY of fronius/solar-api.decodePowerFlow. Given a PowerFlow fixture it
// must produce the identical reading the module does - incl. the SoC drop and
// the never-fabricate-absent-fields discipline.
function runFroniusDecode(json, invertGridSign) {
  return runFunctionNode(byId['auto-fronius-decode'].func, {
    msg: { fronius: { json, invert_grid_sign: !!invertGridSign } },
  });
}

test('flow Fronius decoder matches solar-api.decodePowerFlow() for a hybrid read', () => {
  const json = {
    Head: { Status: { Code: 0 } },
    Body: { Data: { Site: { P_Grid: -500, P_PV: 3000, P_Load: -2500, P_Akku: 1000 }, Inverters: { 1: { SOC: 57.5 } } } },
  };
  const { ret } = runFroniusDecode(json, false);
  const flowReading = ret[0].payload;
  delete flowReading.ts; // the flow stamps a live ts
  assert.deepStrictEqual(flowReading, froniusSolarApi.decodePowerFlow(json).reading);
  assert.strictEqual(flowReading.soc_pct, 57.5);
  // battery power is never published as a channel.
  assert.strictEqual(flowReading.battery_kw, undefined);
});

test('flow Fronius decoder DROPS a bad-status / all-null read, like the module', () => {
  const bad = { Head: { Status: { Code: 255 } }, Body: { Data: { Site: { P_Grid: 100 } } } };
  const { ret } = runFroniusDecode(bad, false);
  assert.strictEqual(ret, null, 'flow node returns null -> no telemetry published');
  assert.strictEqual(froniusSolarApi.decodePowerFlow(bad), null, 'module agrees');
});

test('flow Fronius decoder omits SoC when there is no battery, like the module', () => {
  const noBatt = { Head: { Status: { Code: 0 } }, Body: { Data: { Site: { P_Grid: 1500, P_PV: 2000, P_Load: -3500 }, Inverters: { 1: { DT: 1 } } } } };
  const { ret } = runFroniusDecode(noBatt, false);
  const flowReading = ret[0].payload;
  delete flowReading.ts;
  assert.deepStrictEqual(flowReading, froniusSolarApi.decodePowerFlow(noBatt).reading);
  assert.strictEqual('soc_pct' in flowReading, false);
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
// it must build the same per-source read plans (id + role + connection + read)
// the module produces for modbus_tcp read-only sources, and count/skip the rest.
// Both roles (Erzeuger PV + Netz grid meter) are planned; the plan carries role.
test('flow sources-store matches sources-routing.planSources for modbus sources', () => {
  const payload = [
    { id: 'src-a', role: 'pv-generation', brand: 'generic_modbus', model: 'sunspec', family: 'sunspec',
      communication: 'modbus_tcp', connection: { ip: '192.168.0.70', port: 502, unit_id: 2 }, capacity_kwp: 70 },
    { id: 'src-deye', role: 'pv-generation', brand: 'deye', family: 'hybrid_3p',
      communication: 'solarman_v5', connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 } },
    { id: 'src-netz', role: 'grid-meter', communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '1.2.3.4' } },
  ];
  const flow = {};
  runFunctionNode(byId['sources-store'].func, { msg: { payload }, flow });
  // Normalize across the vm realm (its Object/Array prototypes trip deepStrictEqual).
  const plans = JSON.parse(JSON.stringify(flow.source_plans));
  // The two modbus sources are planned (Deye deferred); each plan carries its role.
  assert.equal(plans.length, 2);
  const byPlanId = Object.fromEntries(plans.map((p) => [p.id, p]));
  assert.equal(byPlanId['src-a'].role, 'pv-generation');
  assert.equal(byPlanId['src-a'].conn.ip, '192.168.0.70');
  assert.equal(byPlanId['src-a'].conn.unit_id, 2);
  assert.deepStrictEqual(byPlanId['src-a'].read, { fc: 3, addr: 0, count: 9 });
  assert.equal(byPlanId['src-netz'].role, 'grid-meter');
  assert.equal(byPlanId['src-netz'].conn.ip, '1.2.3.4');

  // Cross-check against the module: it recognises the modbus + deye Erzeuger and
  // the modbus Netz source; the flow store keeps the two modbus ones with role.
  const routed = sourcesRouting.planSources(sourcesRouting.parseSourcesConfig({ schema_version: '1.0', sources: payload }));
  const modbusRouted = routed.filter((r) => r.plan.adapter === 'modbus_tcp');
  assert.equal(modbusRouted.length, 2);
  assert.deepStrictEqual(
    modbusRouted.map((r) => r.id).sort(),
    plans.map((p) => p.id).sort(),
  );
});

// The "Quellen uebernehmen" node must ALSO plan a fronius_sunspec source (the
// captain's real setup: a Fronius Eco as an Erzeuger read over SunSpec-live) -
// the regression that made such a source silently deliver nothing: it routed to
// adapter sunspec_live but the store dropped it, so the ongoing poll never read
// it while "Verbindung testen" (its own full SunSpec read) worked.
test('flow sources-store plans a fronius_sunspec (SunSpec-live) Erzeuger source like the module', () => {
  const payload = [
    { id: 'src-eco', role: 'pv-generation', brand: 'fronius_sunspec', model: 'fronius-eco-27-3-s', family: 'sunspec_live',
      communication: 'fronius_sunspec', connection: { ip: '192.168.254.40', port: 502, unit_id: 2, model_type: 'float', invert_grid_sign: false }, capacity_kwp: 70 },
  ];
  const flow = {};
  runFunctionNode(byId['sources-store'].func, { msg: { payload }, flow });
  const plans = JSON.parse(JSON.stringify(flow.source_plans));
  assert.equal(plans.length, 1, 'the Fronius SunSpec source MUST be planned (was silently dropped)');
  assert.equal(plans[0].id, 'src-eco');
  assert.equal(plans[0].role, 'pv-generation');
  assert.equal(plans[0].adapter, 'sunspec_live');
  assert.equal(plans[0].conn.ip, '192.168.254.40');
  assert.equal(plans[0].conn.port, 502);
  assert.equal(plans[0].conn.unit_id, 2);
  assert.equal(plans[0].conn.model_type, 'float');
  assert.equal(plans[0].conn.invert_grid_sign, false);

  // Cross-check against the module routing: same source, same adapter + connection.
  const routed = sourcesRouting.planSources(sourcesRouting.parseSourcesConfig({ schema_version: '1.0', sources: payload }));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].plan.adapter, 'sunspec_live');
  assert.equal(routed[0].plan.connection.ip, plans[0].conn.ip);
  assert.equal(routed[0].plan.connection.port, plans[0].conn.port);
  assert.equal(routed[0].plan.connection.unit_id, plans[0].conn.unit_id);
  assert.equal(routed[0].plan.connection.model_type, plans[0].conn.model_type);
});

// A connection with no model_type hint (or an unknown one) defaults to 'auto',
// mirroring inverter-routing.route - an old core build that dropped the SunSpec
// connection fields from the retained entry still yields a working plan.
test('flow sources-store defaults a fronius_sunspec plan to model_type auto / unit 1', () => {
  const payload = [
    { id: 'src-old', role: 'pv-generation', brand: 'fronius_sunspec', family: 'sunspec_live',
      communication: 'fronius_sunspec', connection: { ip: '192.168.254.40', port: 502 } },
  ];
  const flow = {};
  runFunctionNode(byId['sources-store'].func, { msg: { payload }, flow });
  const plans = JSON.parse(JSON.stringify(flow.source_plans));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].conn.unit_id, 1);
  assert.equal(plans[0].conn.model_type, 'auto');
  assert.equal(plans[0].conn.invert_grid_sign, false);
});

// The "Quellen lesen" node carries EMBEDDED verbatim copies of the SunSpec
// discovery walk + live decode for its sunspec_live branch (the same embed the
// primary auto-sunspec node uses). Drift guard: editing either module without
// re-running build-flows.js fails here instead of shipping a stale reader.
test('flow sources-read embeds the current model-discovery.js + sunspec-live.js sources', () => {
  const func = byId['sources-read'].func;
  for (const rel of ['sunspec/model-discovery.js', 'sunspec/sunspec-live.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(
      func.includes(src),
      'flows.json sources-read node is out of sync with ' + rel + ' - re-run build-flows.js',
    );
  }
  // The read mirrors test-read.js's WORKING invocation: a FRESH reader per read
  // with explicit timeouts (the one-shot "Verbindung testen" path proven on the
  // real Fronius Eco), guarded against overlapping polls (skip-if-busy) and
  // never silent on failure (rate-limited node.warn naming the source).
  assert.ok(func.includes('__SS.makeSunspecReader({ net: net, discovery: __DISC, connectTimeoutMs: CONNECT_TIMEOUT_MS, readTimeoutMs: READ_TIMEOUT_MS })'));
  assert.ok(func.includes("context.get('src_busy_since')"), 'overlap guard (skip-if-busy) present');
  assert.ok(func.includes('warnFail('), 'failed reads are named via node.warn, never swallowed silently');
});

// The "Quellen lesen" node decodes SunSpec by role the same way the shared modbus
// decode does: an Erzeuger forwards PV (register 1), a Netz meter forwards signed
// grid (register 0). We assert both inline decode constants match modbus-tcp's.
test('flow sources-read decodes SunSpec PV + grid consistently with modbus-tcp', () => {
  const regs = new Array(9).fill(0);
  regs[0] = 65036; // grid -5.00 kW (s16/100 -> export)
  regs[1] = 4200;  // pv 42.00 kW (s16/100)
  const decoded = modbusTcp.decodeProfile('sunspec', regs).reading;
  assert.equal(decoded.pv_power_kw, 42);
  assert.equal(decoded.power_kw, -5);
  // The inline decodePv/decodeGrid use s16(regs[1])/100 and s16(regs[0])/100 ->
  // identical to the module's pv / grid fields.
  assert.ok(byId['sources-read'].func.includes('s16(regs[1]) / 100'));
  assert.ok(byId['sources-read'].func.includes('s16(regs[0]) / 100'));
});

// The "Verbindung testen (einmal lesen)" node carries EMBEDDED verbatim copies
// of test-read.js + the four decode modules (a Node-RED flow cannot `require` a
// repo file). This is the drift guard: the running flow must contain the exact
// current file contents, so editing a module without re-running build-flows.js
// fails here instead of shipping a stale test-read.
test('flow test-read embeds the current test-read.js + decode module sources', () => {
  const func = byId['test-read'].func;
  const embeds = [
    'test-read.js',
    'deye/solarman-v5.js',
    'deye/deye-decode.js',
    'modbus-tcp.js',
    'fronius/solar-api.js',
    'sunspec/model-discovery.js',
    'sunspec/sunspec-live.js',
  ];
  for (const rel of embeds) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(
      func.includes(src),
      'flows.json test-read node is out of sync with ' + rel + ' - re-run build-flows.js',
    );
  }
  // And it wires the embedded modules into makeReadOnce the intended way.
  assert.ok(func.includes('__TR.makeReadOnce({ deye: __DEYE, modbus: __MB, fronius: __FR, solarman: __SV5, sunspec: __SS, discovery: __DISC'));
});

// The "Fronius SunSpec lesen" node (auto-sunspec) carries EMBEDDED verbatim
// copies of sunspec/model-discovery.js + sunspec/sunspec-live.js (a Node-RED flow
// cannot `require` a repo file). This is the drift guard: editing either module
// without re-running build-flows.js fails here instead of shipping a stale reader.
test('flow auto-sunspec embeds the current model-discovery.js + sunspec-live.js sources', () => {
  const func = byId['auto-sunspec'].func;
  for (const rel of ['sunspec/model-discovery.js', 'sunspec/sunspec-live.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(
      func.includes(src),
      'flows.json auto-sunspec node is out of sync with ' + rel + ' - re-run build-flows.js',
    );
  }
  // Same discipline as the sources poll: explicit timeouts (the test-read.js
  // invocation shape), an overlap guard, and non-silent failures.
  assert.ok(func.includes('__SS.makeSunspecReader({ net: net, discovery: __DISC, connectTimeoutMs: 8000, readTimeoutMs: 8000 })'));
  assert.ok(func.includes("context.get('ss_busy_since')"), 'overlap guard (skip-if-busy) present');
  assert.ok(func.includes('warnFail('), 'failed reads are named via node.warn, never swallowed silently');
});
