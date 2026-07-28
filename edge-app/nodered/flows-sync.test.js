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
function runFunctionNode(func, { msg = {}, flow = {}, context = {} } = {}) {
  const flowStore = flow;
  const ctxStore = context; // shared across calls when the caller passes one in
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
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

// --- Modbus-Datenspiegel: the router's learned-block merge -------------------
//
// The mirror's auto-learn want list (flow.mirror_want, from vp-register-want)
// extends the Deye read plan by AT MOST ONE block per poll cycle - round-robin,
// appended AFTER the primary blocks, control window 1100-1121 never polled,
// size/count clamped. These pin that hard cap; with no want list the plan is
// byte-identical (the solarman_v5 sync test above proves that case).

const MIRROR_SEL = {
  schema_version: '1.0', brand: 'deye', label: 'Deye', family: 'hybrid_3p',
  communication: 'solarman_v5',
  connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 },
};

test('router merges AT MOST ONE learned block per cycle, round-robin, after the primary blocks', () => {
  const flow = {
    inverter_config: MIRROR_SEL,
    mirror_want: [{ start: 0x0060, count: 4 }, { start: 0x0100, count: 2 }],
  };
  const primary = routing.route(routing.parseConfig(MIRROR_SEL)).reads;

  // Cycle 1: primary blocks first, then EXACTLY ONE learned block.
  let { ret } = runFunctionNode(byId['auto-router'].func, { flow });
  let reads = ret[0].deye.reads;
  assert.strictEqual(reads.length, primary.length + 1, 'exactly one learned block appended');
  assert.deepStrictEqual(reads.slice(0, primary.length), primary, 'primary blocks lead, unchanged');
  assert.deepStrictEqual(reads[primary.length], { start: 0x0060, count: 4, learned: true });

  // Cycle 2 on the SAME flow context: the OTHER block (round-robin).
  ({ ret } = runFunctionNode(byId['auto-router'].func, { flow }));
  reads = ret[0].deye.reads;
  assert.deepStrictEqual(reads[primary.length], { start: 0x0100, count: 2, learned: true });

  // Cycle 3 wraps around.
  ({ ret } = runFunctionNode(byId['auto-router'].func, { flow }));
  assert.strictEqual(ret[0].deye.reads[primary.length].start, 0x0060);
});

test('router clamps learned blocks and NEVER polls the control window 1100-1121', () => {
  const flow = {
    inverter_config: MIRROR_SEL,
    // One garbage entry, one control-window block, one oversized block, plus
    // more blocks than the cap - the sanitizer must survive all of it.
    mirror_want: [
      { start: 1100, count: 4 },          // control window -> skipped
      { start: 1090, count: 40 },         // overlaps the window -> skipped
      { start: 'x', count: 2 },           // garbage -> skipped
      { start: 0x0060, count: 500 },      // oversized -> clamped to 64
    ],
  };
  const primary = routing.route(routing.parseConfig(MIRROR_SEL)).reads;
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow });
  const reads = ret[0].deye.reads;
  assert.strictEqual(reads.length, primary.length + 1);
  assert.deepStrictEqual(reads[primary.length], { start: 0x0060, count: 64, learned: true });
});

test('router with an EMPTY want list emits the byte-identical primary plan', () => {
  const flow = { inverter_config: MIRROR_SEL, mirror_want: [] };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow });
  assert.deepStrictEqual(ret[0].deye.reads, routing.route(routing.parseConfig(MIRROR_SEL)).reads);
});

test('mirror want store node keeps flow.mirror_want in sync incl. the cleared set', () => {
  const flow = {};
  runFunctionNode(byId['auto-mirror-want'].func, {
    msg: { payload: { blocks: [{ start: 0x0060, count: 4 }] } }, flow,
  });
  assert.deepStrictEqual(flow.mirror_want, [{ start: 0x0060, count: 4 }]);
  // A cleared want set (mirror disabled) empties the list and resets rotation.
  flow.mirror_want_rr = 5;
  runFunctionNode(byId['auto-mirror-want'].func, { msg: { payload: { blocks: [] } }, flow });
  assert.deepStrictEqual(flow.mirror_want, []);
  assert.strictEqual(flow.mirror_want_rr, 0);
});

test('mirror raw shaper turns the poll blocks into the edge/registers/raw payload', () => {
  const { ret } = runFunctionNode(byId['auto-mirror-raw'].func, {
    msg: {
      deye: {
        cfg: { mb_slave_id: 2 },
        blocks: [
          { start: 0x0000, regs: [6] },
          { start: 0x024c, regs: [500, 501] },
          { start: 0x0060, count: 4, learned: true, regs: [], error: 'Modbus-Ausnahme 0x2' },
        ],
      },
    },
  });
  const p = ret.payload;
  assert.strictEqual(p.unit, 2);
  assert.ok(!isNaN(Date.parse(p.ts)), 'poll timestamp stamped');
  assert.deepStrictEqual(p.blocks[0], { start: 0x0000, regs: [6] });
  assert.deepStrictEqual(p.blocks[2], { start: 0x0060, regs: [], learned: true, count: 4, error: 'Modbus-Ausnahme 0x2' });
  // No blocks -> nothing published.
  const { ret: empty } = runFunctionNode(byId['auto-mirror-raw'].func, { msg: { deye: { cfg: {}, blocks: [] } } });
  assert.strictEqual(empty, null);
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
  regs[0x024e - 0x024c] = 0xffff - 8500 + 1; // battery -8.5 kW (discharging, s16)
  regs[0x028d - 0x024c] = 2400; // load 2.4 kW
  regs[0x0271 - 0x024c] = 900; // grid 0.9 kW
  const blocks = [{ start: 0x024c, regs }];
  const { ret } = runDeyeDecode(cfg, blocks);
  const flowReading = ret[0].payload;
  delete flowReading.ts; // the flow stamps a live ts
  // The measured battery power rides along on the LOCAL bus as
  // battery_power_kw (house-load balance with a Netz meter in the core),
  // pinned against the module's calibration figure; the reading channels
  // themselves stay byte-identical to the module.
  const expected = deyeDecode.decode(blocks, cfg);
  assert.strictEqual(flowReading.battery_power_kw, expected.batt_kw);
  assert.strictEqual(flowReading.battery_power_kw, -8.5);
  delete flowReading.battery_power_kw;
  assert.deepStrictEqual(flowReading, expected.reading);
  assert.strictEqual(flowReading.soc_pct, 57);
});

// The connection-point grid register (captain's live falsification 2026-07-17):
// the inline copy must read the External CT total 0x026B/0x02C4 as power_kw -
// never the config-dependent "Grid Power" alias 0x0271 (which read −23,7 =
// exactly the Deye's own PV while the true site export was 54,2 kW) - and must
// fall back to the alias when the read block does not cover the external pair.
test('flow Deye decoder reads the External CT grid, alias only as fallback, like the module', () => {
  const cfg = { family: 'hybrid_3p', power_scale: 1 };
  const wide = new Array(0x79).fill(0);
  const put = (addr, val) => { wide[addr - 0x024c] = val & 0xffff; };
  put(0x024c, 53); // SoC
  put(0x026b, -54200); put(0x02c4, 0xffff); // External CT: −54,2 kW site export
  put(0x0271, -23700); put(0x02b2, 0xffff); // the alias: inverter-side −23,7
  put(0x028d, -30500); put(0x0293, 0xffff); // the Deye's own netted load −30,5
  put(0x02a0, 23700); // own PV 23,7 kW
  const blocks = [{ start: 0x024c, regs: wide }];
  const { ret } = runDeyeDecode(cfg, blocks);
  const flowReading = ret[0].payload;
  assert.strictEqual(flowReading.power_kw, -54.2, 'connection point, never the alias');
  const expected = deyeDecode.decode(blocks, cfg);
  assert.strictEqual(expected.reading.power_kw, -54.2, 'module agrees');

  // Old narrower block (0x024C..0x02B2): external high word missing -> alias.
  const narrow = [{ start: 0x024c, regs: wide.slice(0, 0x67) }];
  const { ret: retNarrow } = runDeyeDecode(cfg, narrow);
  assert.strictEqual(retNarrow[0].payload.power_kw, -23.7, 'flow falls back to the alias');
  assert.strictEqual(deyeDecode.decode(narrow, cfg).reading.power_kw, -23.7, 'module agrees on the fallback');
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
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, power_scale: 1 },
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
  const base = { schema_version: '1.0', brand: 'deye', communication: 'solarman_v5', connection: { ip: '10.1.2.3', port: 8899, serial: '2985159064', mb_slave_id: 1, power_scale: 1 } };
  // hybrid_1p (its own register block) and a charging setpoint that grid-charges.
  const sel1p = { ...base, family: 'hybrid_1p' };
  const sp1p = { battery_setpoint_kw: 6, pv_limit_kw: 4, grid_charge_allowed: true, source: 'schedule', control_enabled: true };
  assert.deepStrictEqual(runControlPlan(sel1p, sp1p), JSON.parse(JSON.stringify(controlRouting.controlRoute(sel1p, sp1p, {}))));
  // string (no battery -> the reg==null inline branch)
  const selStr = { ...base, family: 'string' };
  const spStr = { battery_setpoint_kw: 0, source: 'schedule', control_enabled: true };
  assert.deepStrictEqual(runControlPlan(selStr, spStr), JSON.parse(JSON.stringify(controlRouting.controlRoute(selStr, spStr, {}))));
});

// The plan node also carries a synced COPY of controlRelease() (the controller-
// owned failsafe, report §7.5). This pins the inline copy to the module: after
// HOLDING control (was_controlling primed via a normal write), a kill-off makes
// the plan node emit the module's release plan byte-for-byte.
test('flow control planner matches controlRelease() on a kill-off after controlling (SunSpec)', () => {
  const sel = { schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
    communication: 'modbus_tcp', control_tier: 1, connection: { ip: 'edge-sim', port: 502, unit_id: 1 } };
  const ctx = {}; const flow = { inverter_config: sel };
  const plan = byId['auto-control-plan'].func;
  const fresh = new Date().toISOString();
  // 1) normal write primes was_controlling
  runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -10, source: 'schedule', ts: fresh, control_enabled: true } }, flow, context: ctx });
  assert.strictEqual(ctx.was_controlling, true);
  // 2) kill-off -> the inline release plan == module controlRelease
  const { msg } = runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -10, source: 'schedule', ts: fresh, control_enabled: false } }, flow, context: ctx });
  assert.strictEqual(msg.control.mode, 'release');
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(controlRouting.controlRelease(sel, {}))));
});

// The plan node reads the DURABLE pre-control snapshot (persisted by the executor
// under flow 'file') and threads it into controlRoute (charge -> restore maxSellPower)
// AND controlRelease (restore-to-snapshot). These pin that threading to the module.
test('flow control planner threads the persisted snapshot into a Deye CHARGE restore', () => {
  const sel = { schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5',
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, power_scale: 1 } };
  const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
  const snapRegs = { [reg.maxSellPower]: 8000, [reg.solarSell]: 0, [reg.energyPattern]: 0 };
  const flow = { inverter_config: sel, deye_ctrl_snapshot: { regs: snapRegs } };
  const sp = { battery_setpoint_kw: 12, source: 'schedule', ts: new Date().toISOString(), control_enabled: true };
  const { msg } = runFunctionNode(byId['auto-control-plan'].func, { msg: { setpoint: sp }, flow, context: {} });
  const modulePlan = JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, { snapshot: snapRegs })));
  assert.deepStrictEqual(msg.control, modulePlan, 'inline plan node == module with the snapshot threaded');
  // and the snapshot actually produced the maxSellPower restore
  const ms = msg.control.planned.find((w) => w.role === 'max_sell_power');
  assert.ok(ms && ms.value === 8000 && ms.encode.kind === 'restore');
});

test('flow control planner threads the snapshot into a Deye RELEASE restore (calibration auto-revert)', () => {
  // The flow hardcodes Deye read-only, so an executable Deye release only flows during
  // a First-Light CALIBRATION (the certification-only bypass). Prime was_controlling
  // with a calibration write, then the auto-revert restores the snapshot.
  const sel = { schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5', control_tier: 3,
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, power_scale: 1 } };
  const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
  const snapRegs = {
    [reg.energyPattern]: 0, [reg.workMode]: 0, [reg.maxSellPower]: 8000, [reg.solarSell]: 0,
    [reg.progTimeBase]: 0, [reg.progPowerBase]: 0, [reg.progSocBase]: 20, [reg.progChargeBase]: 0,
    [reg.exportLimit]: 9999, [reg.touEnable]: 0,
  };
  const ctx = {}; const flow = { inverter_config: sel, deye_ctrl_snapshot: { regs: snapRegs } };
  const plan = byId['auto-control-plan'].func;
  const fresh = new Date().toISOString();
  // 1) calibration write primes was_controlling (calibration bypasses the cert gate)
  runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -0.5, source: 'calibration', ts: fresh, control_enabled: true, calibration: true } }, flow, context: ctx });
  assert.strictEqual(ctx.was_controlling, true);
  // 2) kill-off (still calibration) -> the auto-revert restores the snapshot, == module
  const { msg } = runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -0.5, source: 'calibration', ts: fresh, control_enabled: false, calibration: true } }, flow, context: ctx });
  assert.strictEqual(msg.control.mode, 'release');
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(controlRouting.controlRelease(sel, { calibration: true, snapshot: snapRegs }))));
  assert.strictEqual(msg.control.planned.find((w) => w.role === 'max_sell_power').value, 8000, 'release restored maxSellPower');
});

// --- Deye REMOTE MODE (Tier 2, registers 1100-1121) --------------------------
//
// The remote-mode adapter is the safety-critical new write path (a TRUE signed watt
// setpoint on a LIVE customer battery), so the inline plan-node copy is pinned to the
// module for BOTH directions and for the release. The capability comes from the same
// VOLATILE flow-context key the executor writes (deyeCapabilityKey).

const REMOTE_DEYE_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5', control_tier: 3,
  // rated_kw is the CATALOG nameplate the core publishes on the retained selection -
  // it is what turns kW into the 0.1 %-of-rated register.
  rated_kw: 30,
  connection: { ip: '192.168.254.210', port: 8899, serial: '1127365518', mb_slave_id: 1 },
};
// The owner's live probe of the SUN-30K-SG01HP3-EU (2026-07-27, read-only).
function ownerCap() {
  const b = new Array(22).fill(0);
  b[1] = 0xffff; b[5] = 0x0002; b[10] = 0x0320; b[15] = 0x03e8; b[16] = 0xffff;
  return controlRouting.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: b });
}

test('flow control planner matches deyeRemoteControl() for a discharge AND a charge', () => {
  const cap = ownerCap();
  const capKey = controlRouting.deyeCapabilityKey('192.168.254.210', 8899);
  for (const kw of [-1, 3]) {
    const sp = { battery_setpoint_kw: kw, source: 'calibration', calibration: true, control_enabled: true, soc_min_pct: 20, soc_max_pct: 90 };
    const { msg } = runFunctionNode(byId['auto-control-plan'].func, {
      msg: { setpoint: sp },
      flow: { inverter_config: REMOTE_DEYE_SEL, [capKey]: cap },
    });
    const modulePlan = JSON.parse(JSON.stringify(
      controlRouting.controlRoute(REMOTE_DEYE_SEL, sp, { ratedKw: 30, deye: cap }),
    ));
    assert.deepStrictEqual(msg.control, modulePlan, 'inline remote plan == module for ' + kw + ' kW');
    assert.strictEqual(msg.control.controlPath, 'remote');
    // the load-bearing order survives the inlining
    assert.strictEqual(msg.control.planned[0].role, 'remote_watchdog');
    assert.strictEqual(msg.control.planned[msg.control.planned.length - 1].role, 'remote_mode');
  }
});

// The PER-DEVICE First-Light grant (setpoint.device_certified) is what actually
// turns the Fahrplan into live writes on a released pilot, so the inline plan-node
// copy must agree with the module for BOTH the granted and the ungranted case -
// on the real (non-calibration) schedule setpoint, not just the calibration one.
test('flow control planner matches the module for a GRANTED Fahrplan setpoint (remote)', () => {
  const cap = ownerCap();
  const capKey = controlRouting.deyeCapabilityKey('192.168.254.210', 8899);
  const fresh = new Date().toISOString();
  for (const grant of [true, false]) {
    const sp = { battery_setpoint_kw: -20, source: 'schedule', slot_start: '2026-07-27T19:45:00Z',
      ts: fresh, control_enabled: true, device_certified: grant, soc_min_pct: 20, soc_max_pct: 95 };
    const { msg } = runFunctionNode(byId['auto-control-plan'].func, {
      msg: { setpoint: sp }, flow: { inverter_config: REMOTE_DEYE_SEL, [capKey]: cap }, context: {},
    });
    assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
      controlRouting.controlRoute(REMOTE_DEYE_SEL, sp, { ratedKw: 30, deye: cap }),
    )), 'inline == module for device_certified=' + grant);
    assert.strictEqual(msg.control.writes.length > 0, grant,
      grant ? 'a granted Fahrplan setpoint writes' : 'an ungranted one stays read-only');
    if (grant) {
      assert.strictEqual(msg.control.writes[0].role, 'remote_watchdog', 'watchdog first');
      assert.strictEqual(msg.control.writes[msg.control.writes.length - 1].role, 'remote_mode', 'enable last');
    }
  }
});

// The plan node threads the grant into controlRelease too, so a device it was
// allowed to DRIVE can be HANDED BACK on a kill-off. Without the threading the
// released device would control and then never release.
test('flow control planner threads device_certified into controlRelease on a kill-off', () => {
  const cap = ownerCap();
  const capKey = controlRouting.deyeCapabilityKey('192.168.254.210', 8899);
  const ctx = {}; const flow = { inverter_config: REMOTE_DEYE_SEL, [capKey]: cap };
  const plan = byId['auto-control-plan'].func;
  const fresh = new Date().toISOString();
  // 1) a GRANTED schedule write primes was_controlling (no calibration involved)
  runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -20, source: 'schedule', ts: fresh, control_enabled: true, device_certified: true, soc_min_pct: 20 } }, flow, context: ctx });
  assert.strictEqual(ctx.was_controlling, true, 'the Fahrplan really took control');
  // 2) kill-off -> an EXECUTABLE release, matching the module with the same opts
  const { msg } = runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -20, source: 'schedule', ts: fresh, control_enabled: false, device_certified: true } }, flow, context: ctx });
  assert.strictEqual(msg.control.mode, 'release');
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
    controlRouting.controlRelease(REMOTE_DEYE_SEL, { deviceCertified: true, controlEnabled: false, deye: cap }),
  )), 'the inline release copy matches the module incl. the threaded grant');
  assert.strictEqual(msg.control.writes.length, 1, 'the hand-back executes');
  assert.strictEqual(msg.control.writes[0].role, 'remote_mode');
  assert.strictEqual(msg.control.writes[0].value, 0, 'remote mode OFF');
  assert.strictEqual(ctx.was_controlling, false, 'control was handed back');
});

test('flow control planner falls back to ToU when the cached capability says ABSENT', () => {
  const absent = controlRouting.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: new Array(22).fill(0) });
  const capKey = controlRouting.deyeCapabilityKey('192.168.254.210', 8899);
  // power_scale comes from the probe's device class here (the N1 auto-detect path).
  const cap = Object.assign({}, absent, { scaleClass: 1 });
  const sp = { battery_setpoint_kw: -5, source: 'schedule', control_enabled: true };
  const { msg } = runFunctionNode(byId['auto-control-plan'].func, {
    msg: { setpoint: sp }, flow: { inverter_config: REMOTE_DEYE_SEL, [capKey]: cap },
  });
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
    controlRouting.controlRoute(REMOTE_DEYE_SEL, sp, { ratedKw: 30, deye: cap }),
  )));
  assert.strictEqual(msg.control.controlPath, 'tou');
  assert.ok(msg.control.planned.find((w) => w.role === 'tou_enable'));
});

test('flow control planner withholds the ToU plan when the HV/LV scale is unknown (N1)', () => {
  const sel = { schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5',
    connection: { ip: '10.9.9.9', port: 8899, serial: '2985159064', mb_slave_id: 1 } }; // no power_scale
  const sp = { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true };
  const { msg } = runFunctionNode(byId['auto-control-plan'].func, { msg: { setpoint: sp }, flow: { inverter_config: sel } });
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, {}))));
  assert.deepStrictEqual(msg.control.planned, [], 'nothing planned while the scale is unknown');
  assert.strictEqual(msg.control.powerScaleSuppressed, true);
});

// --- the STICKY path decision in the plan node (live regression 2026-07-28) --
//
// The plan node reads the DURABLE per-logger decision record ('file' store, key
// deye_path:<target>) and seeds it from the core's First-Light grant path - so a
// certified remote pilot plans its PROVEN path from the first post-restart tick
// and a raw contrary/failed probe verdict can never flap the executing path.

test('flow control planner reads the durable sticky decision and plans the decided path', () => {
  const sticky = { path: 'remote', since: 1, contrary: 0, everRemote: true, verdict: ownerCap(), verdictAt: 1 };
  const pathKey = 'deye_path:192.168.254.210:8899';
  // the volatile cache holds a CONTRARY definitive verdict (inside the hysteresis
  // window) - the decided path must win, byte-identical to the module.
  const contrary = controlRouting.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: new Array(22).fill(0).map((_, i) => (i === 0 ? 0x0500 : 0)) });
  const capKey = controlRouting.deyeCapabilityKey('192.168.254.210', 8899);
  const sp = { battery_setpoint_kw: -1, source: 'schedule', ts: new Date().toISOString(), control_enabled: true, device_certified: true, soc_min_pct: 20 };
  const { msg } = runFunctionNode(byId['auto-control-plan'].func, {
    msg: { setpoint: sp }, flow: { inverter_config: REMOTE_DEYE_SEL, [capKey]: contrary, [pathKey]: sticky }, context: {},
  });
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
    controlRouting.controlRoute(REMOTE_DEYE_SEL, sp, { ratedKw: 30, deye: contrary, deyeSticky: sticky }),
  )), 'inline == module with the sticky decision threaded');
  assert.strictEqual(msg.control.controlPath, 'remote', 'the decided path wins over the raw contrary verdict');
  assert.ok(msg.control.writes.length > 0, 'and keeps driving');
});

test('flow control planner seeds the sticky decision from the core grant path (fresh volume)', () => {
  // NO durable record, NO volatile cap (a fresh restart) - the setpoint's
  // device_certified_path seeds the decision, so the plan is REMOTE immediately.
  const sp = { battery_setpoint_kw: -1, source: 'schedule', ts: new Date().toISOString(), control_enabled: true, device_certified: true, device_certified_path: 'remote', soc_min_pct: 20 };
  const { msg } = runFunctionNode(byId['auto-control-plan'].func, {
    msg: { setpoint: sp }, flow: { inverter_config: REMOTE_DEYE_SEL }, context: {},
  });
  const seeded = controlRouting.deyeSeedStickyFromGrant(sp, Date.now());
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
    controlRouting.controlRoute(REMOTE_DEYE_SEL, sp, { ratedKw: 30, deyeSticky: seeded }),
  )), 'inline == module with the grant-seeded decision');
  assert.strictEqual(msg.control.controlPath, 'remote');
  assert.ok(msg.control.writes.length > 0, 'the proven path is executable from tick one');
});

test('flow control planner HOLDS a certified ToU plan while the path is unconfirmed', () => {
  // Certified (grant) but NO decision, NO verdict: the deliberate-fallback gate
  // withholds the EEPROM ToU writes with the loud blocked reason - never a guess.
  const sel = { schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5', control_tier: 3,
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, power_scale: 1 } };
  const sp = { battery_setpoint_kw: -20, source: 'schedule', ts: new Date().toISOString(), control_enabled: true, device_certified: true };
  const { msg } = runFunctionNode(byId['auto-control-plan'].func, {
    msg: { setpoint: sp }, flow: { inverter_config: sel }, context: {},
  });
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
    controlRouting.controlRoute(sel, sp, { snapshot: undefined }),
  )), 'inline == module for the unconfirmed hold');
  assert.strictEqual(msg.control.blocked, true);
  assert.strictEqual(msg.control.pathHold, 'unconfirmed');
  assert.strictEqual(msg.control.writes.length, 0);
});

test('flow control planner matches the remote controlRelease() on a kill-off', () => {
  const cap = ownerCap();
  const capKey = controlRouting.deyeCapabilityKey('192.168.254.210', 8899);
  const ctx = {}; const flow = { inverter_config: REMOTE_DEYE_SEL, [capKey]: cap };
  const plan = byId['auto-control-plan'].func;
  const fresh = new Date().toISOString();
  // 1) a calibration write primes was_controlling (Deye is uncertified)
  runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -1, source: 'calibration', ts: fresh, control_enabled: true, calibration: true, soc_min_pct: 20 } }, flow, context: ctx });
  assert.strictEqual(ctx.was_controlling, true);
  // 2) kill-off -> the inline release == the module's remote release (1100 <- 0)
  const { msg } = runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -1, source: 'calibration', ts: fresh, control_enabled: false, calibration: true } }, flow, context: ctx });
  assert.strictEqual(msg.control.mode, 'release');
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
    controlRouting.controlRelease(REMOTE_DEYE_SEL, { calibration: true, deye: cap }),
  )));
  assert.strictEqual(msg.control.writes[0].role, 'remote_mode');
  assert.strictEqual(msg.control.writes[0].value, 0);
});

// A STALE setpoint (core silent >20 min) triggers the same release after controlling.
test('flow control planner releases on a STALE setpoint after controlling', () => {
  const sel = { schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
    communication: 'modbus_tcp', control_tier: 1, connection: { ip: 'edge-sim', port: 502, unit_id: 1 } };
  const ctx = {}; const flow = { inverter_config: sel };
  const plan = byId['auto-control-plan'].func;
  runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -10, source: 'schedule', ts: new Date().toISOString(), control_enabled: true } }, flow, context: ctx });
  // control_enabled STILL true, but the ts is 30 min old -> core went silent -> release.
  const oldTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { msg } = runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -10, source: 'schedule', ts: oldTs, control_enabled: true } }, flow, context: ctx });
  assert.strictEqual(msg.control.mode, 'release', 'stale core -> hand control back');
  // The plan node threads the core's control_enabled into controlRelease, so the
  // release readback reports what the core actually set (here: still ON - the core
  // did not switch control off, it went SILENT) instead of a structural false. This
  // is the branch where the two values genuinely differ, so it pins the threading.
  assert.strictEqual(msg.control.controlEnabled, true, 'stale != switched off');
  assert.deepStrictEqual(msg.control, JSON.parse(JSON.stringify(
    controlRouting.controlRelease(sel, { controlEnabled: true }),
  )), 'the inline release copy matches the module incl. the threaded controlEnabled');
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
  const expected = modbusTcp.decodeProfile('sunspec', regs);
  // the flow adds a live ts; compare the measurement fields only
  delete flowReading.ts;
  // battery power (reg 3, + charge) rides along on the LOCAL bus as
  // battery_power_kw - pinned against the module's separate batt_kw.
  assert.strictEqual(flowReading.battery_power_kw, expected.batt_kw);
  assert.strictEqual(flowReading.battery_power_kw, 5);
  delete flowReading.battery_power_kw;
  assert.deepStrictEqual(flowReading, expected.reading);
});

// The "Quellen uebernehmen" (sources-store) node carries a synced copy of
// sources-routing.planSources: given the retained source array it must build a
// per-source read plan for every read transport in every source slot (modbus
// Erzeuger + Netz AND a Deye Erzeuger over solarman_v5), each carrying its role.
test('flow sources-store matches sources-routing.planSources for modbus + solarman sources', () => {
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
  // All three sources are planned now (the Deye executor is wired, no longer deferred).
  assert.equal(plans.length, 3);
  const byPlanId = Object.fromEntries(plans.map((p) => [p.id, p]));
  assert.equal(byPlanId['src-a'].adapter, 'modbus_tcp');
  assert.equal(byPlanId['src-a'].role, 'pv-generation');
  assert.equal(byPlanId['src-a'].conn.ip, '192.168.0.70');
  assert.equal(byPlanId['src-a'].conn.unit_id, 2);
  assert.deepStrictEqual(byPlanId['src-a'].read, { fc: 3, addr: 0, count: 9 });
  assert.equal(byPlanId['src-netz'].adapter, 'modbus_tcp');
  assert.equal(byPlanId['src-netz'].role, 'grid-meter');
  assert.equal(byPlanId['src-netz'].conn.ip, '1.2.3.4');
  // The Deye source is planned over solarman_v5, carrying the family + logger serial.
  assert.equal(byPlanId['src-deye'].adapter, 'solarman_v5');
  assert.equal(byPlanId['src-deye'].family, 'hybrid_3p');
  assert.equal(byPlanId['src-deye'].conn.serial, '2985159064');
  assert.equal(byPlanId['src-deye'].conn.port, 8899);

  // Cross-check against the module: it recognises all three sources with the same
  // adapters + ids (the store and planSources agree on what is wired).
  const routed = sourcesRouting.planSources(sourcesRouting.parseSourcesConfig({ schema_version: '1.0', sources: payload }));
  assert.deepStrictEqual(
    routed.map((r) => [r.id, r.plan.adapter]).sort(),
    plans.map((p) => [p.id, p.adapter]).sort(),
  );
});

// The "Quellen uebernehmen" node must ALSO plan a fronius_solar_api source (a
// Fronius read over its Solar API v1 HTTP endpoint), matching the module.
test('flow sources-store plans a fronius_solar_api source like the module', () => {
  const payload = [
    { id: 'src-fr', role: 'pv-generation', brand: 'fronius', model: 'fronius_solar_api', family: 'fronius_solar_api',
      communication: 'fronius_solar_api', connection: { ip: '192.168.1.50', port: 80, invert_grid_sign: false } },
  ];
  const flow = {};
  runFunctionNode(byId['sources-store'].func, { msg: { payload }, flow });
  const plans = JSON.parse(JSON.stringify(flow.source_plans));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-fr');
  assert.equal(plans[0].adapter, 'fronius_solar_api');
  assert.equal(plans[0].scheme, 'http');
  assert.equal(plans[0].url, 'http://192.168.1.50:80/solar_api/v1/GetPowerFlowRealtimeData.fcgi');

  const routed = sourcesRouting.planSources(sourcesRouting.parseSourcesConfig({ schema_version: '1.0', sources: payload }));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].plan.adapter, 'fronius_solar_api');
  assert.equal(routed[0].plan.url, plans[0].url);
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

// The "Quellen uebernehmen" node must plan a go-e (goe_http_api) CONSUMER source:
// the flow store and sources-routing.planSources agree on the adapter + the
// /api/status URL, and the plan carries role 'consumer' so the read publishes
// load_kw on the third (vp-verbraucher) output.
test('flow sources-store plans a go-e (goe_http_api) consumer source like the module', () => {
  const payload = [
    { id: 'src-goe', role: 'consumer', brand: 'go-e', model: 'goe_http_api', family: 'goe_http_api',
      communication: 'goe_http_api', connection: { ip: '192.168.1.42', port: 80 } },
  ];
  const flow = {};
  runFunctionNode(byId['sources-store'].func, { msg: { payload }, flow });
  const plans = JSON.parse(JSON.stringify(flow.source_plans));
  assert.equal(plans.length, 1, 'the go-e consumer source MUST be planned');
  assert.equal(plans[0].id, 'src-goe');
  assert.equal(plans[0].role, 'consumer');
  assert.equal(plans[0].adapter, 'goe_http_api');
  assert.equal(plans[0].conn.ip, '192.168.1.42');
  assert.equal(plans[0].conn.port, 80);
  assert.equal(plans[0].url, 'http://192.168.1.42:80/api/status?filter=nrg,car,alw,amp,wh');

  // Cross-check against the module routing: same source, same adapter + url.
  const routed = sourcesRouting.planSources(sourcesRouting.parseSourcesConfig({ schema_version: '1.0', sources: payload }));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].plan.adapter, 'goe_http_api');
  assert.equal(routed[0].plan.url, plans[0].url);
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
test('flow sources-read embeds the current SunSpec + go-e + Deye + Fronius decode sources', () => {
  const func = byId['sources-read'].func;
  for (const rel of [
    'sunspec/model-discovery.js',
    'sunspec/sunspec-live.js',
    'goe/goe-api.js',
    'deye/solarman-v5.js',
    'deye/deye-decode.js',
    'fronius/solar-api.js',
  ]) {
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
    'goe/goe-api.js',
  ];
  for (const rel of embeds) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(
      func.includes(src),
      'flows.json test-read node is out of sync with ' + rel + ' - re-run build-flows.js',
    );
  }
  // And it wires the embedded modules into makeReadOnce the intended way.
  assert.ok(func.includes('__TR.makeReadOnce({ deye: __DEYE, modbus: __MB, fronius: __FR, solarman: __SV5, sunspec: __SS, discovery: __DISC, goe: __GOE'));
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

// --- PV-Abregelung (fleet curtailment) ---------------------------------------
//
// The "PV-Abregelung / Schreibplan" node carries EMBEDDED verbatim copies of
// sunspec/model-discovery.js + sunspec/curtail.js (the executor carries the
// same pair for the discovery walk + the enforcement check). Drift guard first,
// then behavioral equality: the inlined plan node must produce byte-identical
// fleet plans to sunspec/curtail.planFleetCurtailment().

const curtailMod = require('./sunspec/curtail');
const modelDiscovery = require('./sunspec/model-discovery');

test('flow curtail plan + exec nodes embed the current model-discovery.js + curtail.js sources', () => {
  for (const nodeId of ['sources-curtail-plan', 'sources-curtail-exec']) {
    const func = byId[nodeId].func;
    for (const rel of ['sunspec/model-discovery.js', 'sunspec/curtail.js']) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      assert.ok(
        func.includes(src),
        'flows.json ' + nodeId + ' node is out of sync with ' + rel + ' - re-run build-flows.js',
      );
    }
  }
  // The exec keeps the poll-coordination + one-shot-release + dead-man shape.
  const exec = byId['sources-curtail-exec'].func;
  assert.ok(exec.includes("flow.set('curtail_want:' + ipKey, Date.now())"), 'write intent announced to the read poll');
  assert.ok(exec.includes("flow.get('src_reading:' + ipKey)"), 'waits out an in-flight poll read');
  assert.ok(exec.includes("'curtail_was:'"), 'one-shot release discipline present');
  assert.ok(exec.includes('evaluateEnforcement'), 'override detection wired');
  // And the read poll yields to the announced write + stashes last readings.
  const read = byId['sources-read'].func;
  assert.ok(read.includes("flow.get('curtail_want:' + ipKey)"), 'read poll yields to the curtail writer');
  assert.ok(read.includes("flow.set('src_last:' + plan.id"), 'read poll stashes last readings');
});

// The curtail discovery fixture (the curtail.test.js image builder): one unit
// with Common + Nameplate + int+SF inverter + Immediate Controls (SF -2).
function curtailDiscoveryFor(ratedKw) {
  const D = modelDiscovery;
  const nameplate = new Array(26).fill(0);
  nameplate[D.M120.WRtg] = Math.round(ratedKw * 100) & 0xffff;
  nameplate[D.M120.WRtg_SF] = 1;
  const controls = new Array(D.M123.LENGTH).fill(0);
  controls[D.M123.WMaxLimPct_SF] = 0xfffe;
  const img = new Map();
  img.set(40000, (D.SID >>> 16) & 0xffff);
  img.set(40001, D.SID & 0xffff);
  let addr = 40002;
  for (const m of [
    { id: 1, body: new Array(66).fill(0) },
    { id: D.MODEL.NAMEPLATE, body: nameplate },
    { id: 103, body: new Array(50).fill(0) },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controls },
  ]) {
    img.set(addr, m.id & 0xffff);
    img.set(addr + 1, m.body.length & 0xffff);
    for (let i = 0; i < m.body.length; i++) img.set(addr + 2 + i, m.body[i] & 0xffff);
    addr += 2 + m.body.length;
  }
  img.set(addr, D.END_MODEL_ID);
  img.set(addr + 1, 0);
  const reader = (a, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const w = img.get(a + i);
      if (w === undefined) break;
      out.push(w);
    }
    return out;
  };
  return D.discover(reader, { base: 40000 });
}

const CURTAIL_PLANS = [
  { id: 'src-fr1', role: 'pv-generation', adapter: 'sunspec_live', conn: { ip: '192.168.210.40', port: 502, unit_id: 1 } },
  { id: 'src-fr2', role: 'pv-generation', adapter: 'sunspec_live', conn: { ip: '192.168.210.40', port: 502, unit_id: 2 } },
];

function runCurtailPlan(sp, flowCtx) {
  const flow = Object.assign({ source_plans: CURTAIL_PLANS }, flowCtx || {});
  const { msg } = runFunctionNode(byId['sources-curtail-plan'].func, { msg: { setpoint: sp }, flow });
  return msg ? msg.curtailFleet : undefined;
}

test('flow curtail planner matches planFleetCurtailment() for the two-unit Pilsting shape', () => {
  const d1 = curtailDiscoveryFor(25);
  const d2 = curtailDiscoveryFor(30);
  const sp = {
    battery_setpoint_kw: 0, ts: new Date().toISOString(), pv_limit_kw: 30,
    curtail: {
      control_enabled: true, pv_uncontrolled_kw: 12,
      sources: [
        { id: 'src-fr1', certified: true, capacity_kwp: 25, label: 'Fronius WR 1' },
        { id: 'src-fr2', certified: false, capacity_kwp: 30, label: 'Fronius WR 2' },
      ],
    },
  };
  const flowCtx = {
    'curtail_disc:192.168.210.40:502#1': { at: Date.now(), disc: d1 },
    'curtail_disc:192.168.210.40:502#2': { at: Date.now(), disc: d2 },
    'src_last:src-fr2': { pv_kw: 8, power_kw: null, load_kw: null, at: Date.now() },
  };
  const flowFleet = runCurtailPlan(sp, flowCtx);
  const moduleFleet = JSON.parse(JSON.stringify(curtailMod.planFleetCurtailment({
    setpoint: sp, plans: CURTAIL_PLANS,
    discoveries: { '192.168.210.40:502#1': d1, '192.168.210.40:502#2': d2 },
    readings: { 'src-fr2': { pv_kw: 8, at: Date.now() } },
    nowMs: Date.now(), disc: modelDiscovery,
  })));
  assert.deepStrictEqual(flowFleet, moduleFleet);
  // Sanity on the meaning: the certified unit writes, the uncertified observes.
  const u1 = flowFleet.units.find((u) => u.sourceId === 'src-fr1');
  const u2 = flowFleet.units.find((u) => u.sourceId === 'src-fr2');
  assert.ok(u1.plan.writes.length > 0);
  assert.deepStrictEqual(u2.plan.writes, []);
});

test('flow curtail planner releases without a cap and stops on the kill-switch, like the module', () => {
  const d1 = curtailDiscoveryFor(25);
  const flowCtx = { 'curtail_disc:192.168.210.40:502#1': { at: Date.now(), disc: d1 } };
  const base = {
    battery_setpoint_kw: 0, ts: new Date().toISOString(),
    curtail: { control_enabled: true, pv_uncontrolled_kw: 0, sources: [{ id: 'src-fr1', certified: true, capacity_kwp: 25 }] },
  };
  // No pv_limit_kw -> release (Ena=0).
  const rel = runCurtailPlan(base, flowCtx);
  assert.strictEqual(rel.mode, 'release');
  const relU = rel.units.find((u) => u.sourceId === 'src-fr1');
  assert.strictEqual(relU.plan.writes.find((w) => w.role === 'pv_limit_enable').value, 0);
  // Kill-switch off -> no writes at all, module-identical.
  const off = Object.assign({}, base, {
    pv_limit_kw: 20,
    curtail: { control_enabled: false, pv_uncontrolled_kw: 0, sources: [{ id: 'src-fr1', certified: true, capacity_kwp: 25 }] },
  });
  const offFleet = runCurtailPlan(off, flowCtx);
  const offModule = JSON.parse(JSON.stringify(curtailMod.planFleetCurtailment({
    setpoint: off, plans: CURTAIL_PLANS, discoveries: { '192.168.210.40:502#1': d1 },
    readings: {}, nowMs: Date.now(), disc: modelDiscovery,
  })));
  assert.deepStrictEqual(offFleet, offModule);
  const offU = offFleet.units.find((u) => u.sourceId === 'src-fr1');
  assert.deepStrictEqual(offU.plan.writes, []);
  assert.ok(offU.plan.readbacks.length > 0, 'readbacks still run (observe-only)');
});
