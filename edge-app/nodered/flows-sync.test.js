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
const bus = require('./bus-arbitration');

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
  // The PRIMARY plan leads unchanged; the daily export-limit block („Grenzen &
  // Wächter" Stufe 0) is appended on a fresh flow context and carries the
  // MODULE's register facts - so this drift guard now covers the address+scale
  // twin too (a wrong address or scale here is a 10x-wrong customer number).
  assert.deepStrictEqual(outMsg.deye.reads.slice(0, expected.reads.length), expected.reads);
  const elReg = routing.exportLimitRegister(sel.family);
  assert.deepStrictEqual(outMsg.deye.reads.slice(expected.reads.length),
    [{ start: elReg.addr, count: 1, export_limit: true }]);
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

test('flow router routes to idle (the LAST output) with no selection', () => {
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: {} });
  // Der Idle-Ausgang ist immer der LETZTE; jeder Lese-Ausgang bleibt null.
  for (let i = 0; i < ret.length - 1; i++) {
    assert.strictEqual(ret[i], null, 'Ausgang ' + i);
  }
  assert.ok(ret[ret.length - 1] && ret[ret.length - 1].idle);
});

test('flow router matches inverter-routing.route() for kaco_http (App-Schnittstelle)', () => {
  const sel = {
    schema_version: '1.0', brand: 'kaco', label: 'KACO · blueplanet hybrid 10.0 NH3 M3',
    family: 'kaco_http_hybrid', communication: 'kaco_http',
    connection: { ip: '192.168.0.30', port: 8484, serial: 'B1234567890', insecure_tls: false, invert_grid_sign: false, invert_batt_sign: true },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  const outMsg = ret.find((r) => r && r.kaco);
  assert.ok(outMsg, 'der KACO-HTTP-Ausgang traegt die Nachricht');
  const expected = routing.route(routing.parseConfig(JSON.stringify(sel)));
  assert.strictEqual(outMsg.kaco.conn.ip, expected.connection.ip);
  assert.strictEqual(outMsg.kaco.conn.port, expected.connection.port);
  assert.strictEqual(outMsg.kaco.conn.serial, expected.connection.serial);
  assert.strictEqual(outMsg.kaco.conn.scheme, expected.scheme);
  assert.strictEqual(outMsg.kaco.conn.invert_batt_sign, expected.connection.invert_batt_sign);
  assert.strictEqual(outMsg.kaco.family, expected.family);
  // Die HYBRID-Familie fragt den Speicher ab, die String-Familie nicht.
  assert.strictEqual(outMsg.kaco.has_battery, expected.has_battery);
  assert.strictEqual(outMsg.kaco.has_battery, true);
});

test('flow router matches inverter-routing.route() for kaco_modbus (NH3-Registerkarte)', () => {
  const sel = {
    schema_version: '1.0', brand: 'kaco', label: 'KACO · blueplanet hybrid 10.0 NH3 M3',
    family: 'kaco_nh3', communication: 'kaco_modbus',
    connection: { ip: '192.168.0.31', port: 502, unit_id: 1, invert_grid_sign: false, invert_batt_sign: false },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  const outMsg = ret.find((r) => r && r.aiswei);
  assert.ok(outMsg, 'der NH3-Ausgang traegt die Nachricht');
  const expected = routing.route(routing.parseConfig(JSON.stringify(sel)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(outMsg.aiswei.reads)),
    JSON.parse(JSON.stringify(expected.reads)));
  // ⚠ Der FUNKTIONSCODE je Block ist die Aussage: die Karte mischt Input (FC4)
  // und Holding (FC3). Ein Plan ohne fc laese die falsche Tabelle.
  assert.deepStrictEqual(outMsg.aiswei.reads.map((r) => r.fc), [4, 4, 3]);
  assert.strictEqual(outMsg.aiswei.conn.unit_id, expected.connection.unit_id);
});

test('flow router matches inverter-routing.route() for kostal_modbus', () => {
  const sel = {
    schema_version: '1.0', brand: 'kostal', label: 'KOSTAL · PLENTICORE BI 10/26',
    family: 'kostal_plenticore', communication: 'kostal_modbus',
    connection: { ip: '192.168.0.30', port: 1502, unit_id: 71, byte_order: 'auto', invert_grid_sign: true, invert_batt_sign: true },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  const outMsg = ret[4]; // output 5 carries msg.kostal
  const expected = routing.route(routing.parseConfig(sel));
  assert.strictEqual(outMsg.kostal.target, expected.target);
  assert.strictEqual(outMsg.kostal.conn.ip, expected.connection.ip);
  assert.strictEqual(outMsg.kostal.conn.port, expected.connection.port);
  assert.strictEqual(outMsg.kostal.conn.unit_id, expected.connection.unit_id);
  assert.strictEqual(outMsg.kostal.conn.byte_order, expected.connection.byte_order);
  assert.strictEqual(outMsg.kostal.conn.invert_grid_sign, expected.connection.invert_grid_sign);
  assert.strictEqual(outMsg.kostal.conn.invert_batt_sign, expected.connection.invert_batt_sign);
  // The inline KOSTAL_READS block plan must equal the decode module's planReads
  // (one truth for the register blocks - the DEYE_READS drift-guard discipline).
  assert.deepStrictEqual(outMsg.kostal.reads, expected.reads);
  // the other branches must be null on this path.
  assert.strictEqual(ret[0], null);
  assert.strictEqual(ret[1], null);
  assert.strictEqual(ret[2], null);
  assert.strictEqual(ret[3], null);
  assert.strictEqual(ret[5], null);
});

// The "KOSTAL PLENTICORE lesen" node (auto-kostal) carries an EMBEDDED verbatim
// copy of kostal/kostal-decode.js (a Node-RED flow cannot `require` a repo
// file). Drift guard: editing the module without re-running build-flows.js
// fails here instead of shipping a stale reader.
test('flow auto-kostal embeds the current kostal/kostal-decode.js source', () => {
  const func = byId['auto-kostal'].func;
  const src = fs.readFileSync(path.join(__dirname, 'kostal/kostal-decode.js'), 'utf8');
  assert.ok(
    func.includes(src),
    'flows.json auto-kostal node is out of sync with kostal/kostal-decode.js - re-run build-flows.js',
  );
  // Same discipline as the SunSpec/sources polls: explicit timeouts, an overlap
  // guard, and non-silent failures.
  assert.ok(func.includes('__KOSTAL.makeKostalReader({ net: net, connectTimeoutMs: 8000, readTimeoutMs: 8000 })'));
  assert.ok(func.includes("context.get('k_busy_since')"), 'overlap guard (skip-if-busy) present');
  assert.ok(func.includes('warnFail('), 'failed reads are named via node.warn, never swallowed silently');
  // The measured battery power rides the LOCAL bus only, decoded per the module
  // (register sign negated there) - the node forwards battKw as battery_power_kw.
  assert.ok(func.includes('reading.battery_power_kw = out.battKw'));
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

// The DAILY export-limit read („Grenzen & Wächter" Stufe 0) also appends one
// block, and it is DUE on a fresh flow context - so the mirror tests below
// pre-stamp it as just-attempted to keep their subject isolated. Its own
// behaviour is pinned in the dedicated tests further down.
const exportLimitStamped = (extra = {}) => ({
  ['export_limit_at:' + MIRROR_SEL.connection.ip + ':' + MIRROR_SEL.connection.port]: Date.now(),
  ...extra,
});

test('router merges AT MOST ONE learned block per cycle, round-robin, after the primary blocks', () => {
  const flow = exportLimitStamped({
    inverter_config: MIRROR_SEL,
    mirror_want: [{ start: 0x0060, count: 4 }, { start: 0x0100, count: 2 }],
  });
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
  const flow = exportLimitStamped({
    inverter_config: MIRROR_SEL,
    // One garbage entry, one control-window block, one oversized block, plus
    // more blocks than the cap - the sanitizer must survive all of it.
    mirror_want: [
      { start: 1100, count: 4 },          // control window -> skipped
      { start: 1090, count: 40 },         // overlaps the window -> skipped
      { start: 'x', count: 2 },           // garbage -> skipped
      { start: 0x0060, count: 500 },      // oversized -> clamped to 64
    ],
  });
  const primary = routing.route(routing.parseConfig(MIRROR_SEL)).reads;
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow });
  const reads = ret[0].deye.reads;
  assert.strictEqual(reads.length, primary.length + 1);
  assert.deepStrictEqual(reads[primary.length], { start: 0x0060, count: 64, learned: true });
});

test('router with an EMPTY want list emits the byte-identical primary plan', () => {
  const flow = exportLimitStamped({ inverter_config: MIRROR_SEL, mirror_want: [] });
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

// The narrow "battery without a coupled BMS" opt-in (live case Muehlfeldweg 2):
// the inline copy must agree with the module on ALL THREE cases, or an opted-in
// plant would still deliver nothing while the wizard says it will.
function muehlfeldwegBlocks() {
  const regs = new Array(0x79).fill(0);
  const put = (addr, val) => { regs[addr - 0x024c] = val & 0xffff; };
  put(0x024c, 0);        // SoC: the BMS reports nothing
  put(0x024e, 0xfff4);   // battery -0,012 kW - the block is demonstrably ALIVE
  put(0x028d, 4300);     // load 4,3 kW
  put(0x02a0, 6100);     // pv 6,1 kW
  put(0x026b, 1200);     // grid 1,2 kW
  return [{ start: 0x024c, regs }];
}

test('flow Deye decoder keeps a live SoC-0 read WITHOUT soc_pct when opted in, like the module', () => {
  const cfg = { family: 'hybrid_3p', power_scale: 1, allow_missing_soc: true };
  const blocks = muehlfeldwegBlocks();
  const { ret } = runDeyeDecode(cfg, blocks);
  assert.ok(ret, 'the flow publishes the sample');
  const flowReading = ret[0].payload;
  delete flowReading.ts;
  delete flowReading.battery_power_kw;
  const expected = deyeDecode.decode(blocks, cfg);
  assert.deepStrictEqual(flowReading, expected.reading);
  assert.ok(!('soc_pct' in flowReading), 'never a fabricated 0');
});

// The SoC-from-voltage estimate. The blocks above all start at 0x024C and so
// carry NO battery voltage - they can never exercise this path, which is
// exactly why the flow copy could drift here unnoticed. These use the widened
// 0x024B block the router now plans.
function muehlfeldwegVoltageBlocks() {
  const regs = new Array(0x7a).fill(0);
  const put = (addr, val) => { regs[addr - 0x024b] = val & 0xffff; };
  put(0x024b, 6360);     // battery voltage raw -> 636,0 V on an HV pack
  put(0x024c, 0);        // SoC: the BMS reports nothing
  put(0x024e, 0xfff4);
  put(0x028d, 4300);
  put(0x02a0, 6100);
  put(0x026b, 1200);
  return [{ start: 0x0000, regs: [0x0008] }, { start: 0x024b, regs }];
}

test('flow Deye decoder ESTIMATES the SoC from the battery voltage, like the module', () => {
  const cfg = {
    family: 'hybrid_3p',
    allow_missing_soc: true,
    soc_from_voltage: { v_empty: 600, v_full: 700 },
  };
  const blocks = muehlfeldwegVoltageBlocks();
  const { ret } = runDeyeDecode(cfg, blocks);
  assert.ok(ret, 'the flow publishes the sample');
  const flowReading = ret[0].payload;
  delete flowReading.ts;
  delete flowReading.battery_power_kw;
  const expected = deyeDecode.decode(blocks, cfg);
  assert.deepStrictEqual(flowReading, expected.reading);
  assert.strictEqual(flowReading.soc_pct, 36);
  assert.strictEqual(flowReading.soc_source, 'voltage');
});

test('flow Deye decoder keeps the read WITHOUT soc_pct when no bounds are set, like the module', () => {
  const cfg = { family: 'hybrid_3p', allow_missing_soc: true };
  const blocks = muehlfeldwegVoltageBlocks();
  const { ret } = runDeyeDecode(cfg, blocks);
  const flowReading = ret[0].payload;
  delete flowReading.ts;
  delete flowReading.battery_power_kw;
  assert.deepStrictEqual(flowReading, deyeDecode.decode(blocks, cfg).reading);
  assert.ok(!('soc_pct' in flowReading), 'no bounds, no SoC - never a fabricated 0');
});

test('flow Deye decoder never estimates for no_answer / out_of_range, like the module', () => {
  const cfg = {
    family: 'hybrid_3p',
    allow_missing_soc: true,
    soc_from_voltage: { v_empty: 600, v_full: 700 },
  };
  // Empty answer: everything 0, including the voltage.
  const empty = [{ start: 0x0000, regs: [0x0008] }, { start: 0x024b, regs: new Array(0x7a).fill(0) }];
  assert.strictEqual(runDeyeDecode(cfg, empty).ret, null);
  assert.strictEqual(deyeDecode.decode(empty, cfg), null);
  // Broken frame WITH a readable-looking voltage: still a hard drop.
  const broken = muehlfeldwegVoltageBlocks();
  broken[1].regs[0x024c - 0x024b] = 1250;
  assert.strictEqual(runDeyeDecode(cfg, broken).ret, null);
  assert.strictEqual(deyeDecode.decode(broken, cfg), null);
});

test('flow Deye decoder never overwrites a REAL SoC with the estimate, like the module', () => {
  const cfg = {
    family: 'hybrid_3p',
    allow_missing_soc: true,
    soc_from_voltage: { v_empty: 600, v_full: 700 },
  };
  const blocks = muehlfeldwegVoltageBlocks();
  blocks[1].regs[0x024c - 0x024b] = 57;
  const flowReading = runDeyeDecode(cfg, blocks).ret[0].payload;
  delete flowReading.ts;
  delete flowReading.battery_power_kw;
  assert.deepStrictEqual(flowReading, deyeDecode.decode(blocks, cfg).reading);
  assert.strictEqual(flowReading.soc_pct, 57);
  assert.ok(!('soc_source' in flowReading));
});

test('flow Deye decoder clamps the estimate to [1,100] like the module (never the dropped 0)', () => {
  const cfg = {
    family: 'hybrid_3p',
    allow_missing_soc: true,
    soc_from_voltage: { v_empty: 600, v_full: 700 },
  };
  for (const [raw, want] of [[5900, 1], [7200, 100]]) {
    const blocks = muehlfeldwegVoltageBlocks();
    blocks[1].regs[0] = raw;
    const flowReading = runDeyeDecode(cfg, blocks).ret[0].payload;
    assert.strictEqual(flowReading.soc_pct, want);
    assert.strictEqual(flowReading.soc_pct, deyeDecode.decode(blocks, cfg).reading.soc_pct);
  }
});

test('flow Deye decoder ignores a nonsensical bounds pair like the module', () => {
  const cfg = {
    family: 'hybrid_3p',
    allow_missing_soc: true,
    soc_from_voltage: { v_empty: 700, v_full: 600 },
  };
  const blocks = muehlfeldwegVoltageBlocks();
  const flowReading = runDeyeDecode(cfg, blocks).ret[0].payload;
  delete flowReading.ts;
  delete flowReading.battery_power_kw;
  assert.deepStrictEqual(flowReading, deyeDecode.decode(blocks, cfg).reading);
  assert.ok(!('soc_pct' in flowReading));
});

test('flow Deye decoder still DROPS the same read without the opt-in, like the module', () => {
  const cfg = { family: 'hybrid_3p', power_scale: 1 };
  const blocks = muehlfeldwegBlocks();
  assert.strictEqual(runDeyeDecode(cfg, blocks).ret, null);
  assert.strictEqual(deyeDecode.decode(blocks, cfg), null);
});

test('flow Deye decoder DROPS the loggers all-zero answer EVEN opted in, like the module', () => {
  const cfg = { family: 'hybrid_3p', allow_missing_soc: true };
  const blocks = [{ start: 0x024c, regs: new Array(0x79).fill(0) }];
  assert.strictEqual(runDeyeDecode(cfg, blocks).ret, null, 'the July stub rule holds');
  assert.strictEqual(deyeDecode.decode(blocks, cfg), null);
});

test('flow Deye decoder DROPS an out-of-range SoC EVEN opted in, like the module', () => {
  const cfg = { family: 'hybrid_3p', allow_missing_soc: true };
  const regs = new Array(0x79).fill(0);
  regs[0] = 1250;
  regs[0x028d - 0x024c] = 3000;
  const blocks = [{ start: 0x024c, regs }];
  assert.strictEqual(runDeyeDecode(cfg, blocks).ret, null);
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

// --- KACO: die INLINE-Kopie ist mit dem Adapter identisch, und beide schweigen -
//
// Der wichtigste Vergleich ist der leere: NIRGENDS ein Schreibbefehl. Eine
// Divergenz hier koennte einen gesperrten Schreibweg still wieder oeffnen.
test('flow control planner: KACO NH3 plant genau den Satz des Adapters - und schreibt nichts', () => {
  const sel = {
    schema_version: '1.0', brand: 'kaco', family: 'kaco_nh3', communication: 'kaco_modbus',
    control_tier: 1, connection: { ip: '192.168.0.31', port: 502, unit_id: 1 },
  };
  const sp = { battery_setpoint_kw: -3, source: 'schedule', control_enabled: true, soc_min_pct: 10, soc_max_pct: 90 };
  const flowPlan = runControlPlan(sel, sp);
  assert.deepStrictEqual(flowPlan, JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, {}))));
  assert.deepStrictEqual(flowPlan.writes, [], 'KACO gibt nie einen Schreibbefehl heraus');
  assert.deepStrictEqual(flowPlan.readbacks, []);
  assert.strictEqual(flowPlan.planned.length, 5, 'der Plan ist das Bench-Artefakt');
});

test('flow control planner: die KACO-eigene Linie plant ohne Discovery KEINE Adresse', () => {
  const sel = {
    schema_version: '1.0', brand: 'kaco', family: 'sunspec_live', communication: 'sunspec_tcp',
    control_tier: 1, connection: { ip: '192.168.0.9', port: 502, unit_id: 1 },
  };
  const sp = { battery_setpoint_kw: 0, pv_limit_kw: 6, source: 'schedule', control_enabled: true };
  const flowPlan = runControlPlan(sel, sp);
  assert.deepStrictEqual(flowPlan, JSON.parse(JSON.stringify(controlRouting.controlRoute(sel, sp, {}))));
  assert.deepStrictEqual(flowPlan.writes, []);
  assert.deepStrictEqual(flowPlan.planned, [], 'nie eine erfundene Adresse');
});

test('flow control planner: die KACO App-Schnittstelle sagt „kein Steuerweg" statt „unbekannt"', () => {
  const sel = {
    schema_version: '1.0', brand: 'kaco', family: 'kaco_http_hybrid', communication: 'kaco_http',
    control_tier: 1, connection: { ip: '192.168.0.30', port: 8484 },
  };
  const sp = { battery_setpoint_kw: -3, source: 'schedule', control_enabled: true };
  // Ein idle-Plan setzt msg.control bewusst NICHT (der Knoten zeigt nur einen
  // Status) - genau wie bei jedem anderen unsteuerbaren Weg.
  assert.strictEqual(runControlPlan(sel, sp), undefined);
  // Der Grund ist die Aussage: nicht „unbekannte Kommunikationsmethode",
  // sondern der ehrliche Satz, dass es dort keinen Steuerweg gibt.
  const mod = controlRouting.controlRoute(sel, sp, {});
  assert.strictEqual(mod.adapter, 'idle');
  assert.match(mod.reason, /kein Steuerweg/);
  assert.deepStrictEqual(mod.writes, []);
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
    'kostal/kostal-decode.js',
  ];
  for (const rel of embeds) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(
      func.includes(src),
      'flows.json test-read node is out of sync with ' + rel + ' - re-run build-flows.js',
    );
  }
  // And it wires the embedded modules into makeReadOnce the intended way.
  assert.ok(func.includes('__TR.makeReadOnce({ deye: __DEYE, modbus: __MB, fronius: __FR, solarman: __SV5, sunspec: __SS, discovery: __DISC, goe: __GOE, kostal: __KOSTAL'));
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
  const embeds = {
    'sources-curtail-plan': ['sunspec/model-discovery.js', 'sunspec/curtail.js'],
    'sources-curtail-exec': ['sunspec/model-discovery.js', 'sunspec/curtail.js', 'sunspec/curtail-lease.js'],
  };
  for (const nodeId of Object.keys(embeds)) {
    const func = byId[nodeId].func;
    for (const rel of embeds[nodeId]) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      assert.ok(
        func.includes(src),
        'flows.json ' + nodeId + ' node is out of sync with ' + rel + ' - re-run build-flows.js',
      );
    }
  }
  // The exec keeps the LEASE discipline (Pilsting 2026-07-28: a priority claim
  // must never outlive its work) + one-shot-release + dead-man shape.
  const exec = byId['sources-curtail-exec'].func;
  assert.ok(exec.includes('const beat = () => flow.set(wantKey, Date.now())'), 'lease heartbeat present');
  assert.ok(exec.includes('flow.set(wantKey, 0)'), 'lease released on every exit (finally + refusal)');
  assert.ok(exec.includes('__LEASE.discoveryState'), 'failed-discovery backoff wired');
  assert.ok(exec.includes('__LEASE.observeDue'), 'observe-only ticks are throttled and claimless');
  assert.ok(exec.includes('__LEASE.opTimeoutMs(deadlineAt'), 'per-op timeouts capped to the cycle budget');
  assert.ok(exec.includes("flow.get('src_reading:' + ipKey)"), 'waits out an in-flight poll read');
  assert.ok(exec.includes("'curtail_was:'"), 'one-shot release discipline present');
  assert.ok(exec.includes('evaluateEnforcement'), 'override detection wired');
  // The First-Light hardening (live Pilsting 2026-08-06): an ACTIVE cap is
  // re-applied before the native dead-man can lift it, every readback is
  // evaluated SEMANTICALLY (Ena quirk / unread register), and a discarded
  // command is re-written boundedly and then NAMED.
  assert.ok(exec.includes('__CURT.writeDecision'), 'refresh/retry decision wired');
  assert.ok(exec.includes('__CURT.evaluateReadback'), 'semantic readback verdict wired');
  assert.ok(exec.includes('__CURT.noteWrite') && exec.includes('__CURT.noteVerdict'),
    'the bounded re-write ladder keeps its state');
  assert.ok(exec.includes("'curtail_cmd:'"), 'per-unit command state key present');
  assert.ok(exec.includes('__CURT.REJECTED_REASON'), 'a discarded command names its cause');
  assert.ok(exec.includes(': null;') && exec.includes('typeof regs[0]'),
    'an unread register stays null - never a fabricated 0');
  // And the read poll takes the BOUNDED lease decision (yield <= MAX_CLAIM_SKIPS,
  // force + warn, expire an orphaned claim), rotates fairly + stashes readings.
  const read = byId['sources-read'].func;
  const leaseSrc = fs.readFileSync(path.join(__dirname, 'sunspec/curtail-lease.js'), 'utf8');
  assert.ok(read.includes(leaseSrc), 'sources-read embeds curtail-lease.js - re-run build-flows.js');
  assert.ok(read.includes('__LEASE.pollDecision'), 'read poll takes the bounded lease decision');
  assert.ok(read.includes("ld.action === 'force'"), 'starvation fallback: a read is forced past the skip budget');
  assert.ok(read.includes("ld.action === 'expire'"), 'an orphaned claim is expired + warned');
  assert.ok(read.includes("context.set('src_rr'"), 'fairness rotation across sources');
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
  assert.strictEqual(relU.plan.writes[0].parts.find((p) => p.role === 'pv_limit_enable').value, 0);
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

// --- KOSTAL PLENTICORE Tier-2 control (external battery management) -----------
//
// The inline controlRoute/controlRelease copies must produce the module's KOSTAL
// plan byte-for-byte: a divergence here could silently re-enable a gated write or
// drop the activation gate.

const KOSTAL_SEL = {
  schema_version: '1.0', brand: 'kostal', family: 'kostal_plenticore',
  communication: 'kostal_modbus', control_tier: 2, rated_kw: 10,
  connection: { ip: '192.168.0.30', port: 1502, unit_id: 71, byte_order: 'auto' },
};

test('flow control planner matches controlRoute() for a granted KOSTAL write', () => {
  const sp = { battery_setpoint_kw: -3, source: 'schedule', control_enabled: true, device_certified: true };
  const flowPlan = runControlPlan(KOSTAL_SEL, sp);
  assert.deepStrictEqual(flowPlan, JSON.parse(JSON.stringify(controlRouting.controlRoute(KOSTAL_SEL, sp, {}))));
  assert.strictEqual(flowPlan.adapter, 'kostal_modbus');
  assert.strictEqual(flowPlan.writes.length, 1, 'the single-lever discipline: exactly one write op');
  assert.strictEqual(flowPlan.writes[0].addr, 1034);
  assert.strictEqual(flowPlan.writes[0].value, 3000, 'sign negated: -3 kW discharge -> +3000 W');
  assert.strictEqual(flowPlan.mgmt_gate.addr, 1080);
});

test('flow control planner matches controlRoute() for an UNCERTIFIED KOSTAL (planned only)', () => {
  const sp = { battery_setpoint_kw: 2, source: 'schedule', control_enabled: true };
  const flowPlan = runControlPlan(KOSTAL_SEL, sp);
  assert.deepStrictEqual(flowPlan, JSON.parse(JSON.stringify(controlRouting.controlRoute(KOSTAL_SEL, sp, {}))));
  assert.deepStrictEqual(flowPlan.writes, [], 'no bench pass -> never an executable write');
  assert.strictEqual(flowPlan.planned.length, 1);
  // A pv limit on a BI is reported dropped by BOTH copies (never silently).
  const withPv = runControlPlan(KOSTAL_SEL, Object.assign({}, sp, { pv_limit_kw: 4 }));
  assert.strictEqual(withPv.pvLimitSupported, false);
  assert.strictEqual(withPv.pvLimitDroppedKw, 4);
});

test('flow control planner matches controlRelease() on a kill-off after controlling (KOSTAL)', () => {
  const ctx = {}; const flow = { inverter_config: KOSTAL_SEL };
  const plan = byId['auto-control-plan'].func;
  const fresh = new Date().toISOString();
  runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -3, source: 'schedule', ts: fresh, control_enabled: true, device_certified: true } }, flow, context: ctx });
  assert.strictEqual(ctx.was_controlling, true);
  const { msg } = runFunctionNode(plan, { msg: { setpoint: { battery_setpoint_kw: -3, source: 'schedule', ts: fresh, control_enabled: false, device_certified: true } }, flow, context: ctx });
  assert.strictEqual(msg.control.mode, 'release');
  assert.deepStrictEqual(
    msg.control,
    JSON.parse(JSON.stringify(controlRouting.controlRelease(KOSTAL_SEL, { deviceCertified: true }))),
  );
  assert.strictEqual(msg.control.planned[0].value, 0, 'release = setpoint 0 once');
});

// The KOSTAL executor node: structural discipline (the activation gate before any
// write, FC16 float32, the ONE lever, and no forbidden register anywhere).
test('flow auto-control-exec-kostal gates on register 1080 and writes only 1034', () => {
  const func = byId['auto-control-exec-kostal'].func;
  assert.ok(func.includes("ctrl.adapter !== 'kostal_modbus'"), 'no-ops on any other adapter');
  assert.ok(func.includes('ctrl.mgmt_gate'), 'the activation gate is evaluated');
  assert.ok(func.includes('blocked: true'), 'a closed gate publishes a blocked readback with its reason');
  assert.ok(func.includes('buildWriteF32'), 'the setpoint is written as float32');
  assert.ok(func.includes('b[7] = 0x10'), 'FC16 (write multiple) - a float32 cannot ride FC6');
  // The gate is read BEFORE the write loop (order is the safety property).
  assert.ok(func.indexOf('ctrl.mgmt_gate') < func.indexOf('for (const w of (ctrl.writes'),
    'the activation gate must be checked before the first write');
  for (const forbidden of ['1038', '1040', '1042', '1044']) {
    assert.ok(!func.includes(forbidden), 'the executor must never mention register ' + forbidden);
  }
});

// --- die GERÄTE-EIGENE Einspeisegrenze („Grenzen & Wächter" Stufe 0) ---------
//
// EIN zusätzlicher FC3-Umlauf höchstens einmal am Tag, an denselben Leseplan
// angehängt (Ein-Socket-Gesetz). Was hier am meisten wert ist: dass wir das
// Register einer Familie, die WIR selbst beschreiben, nie lesen - sonst
// meldeten wir unseren eigenen Befehl als „Grenze des Geräts".

test('der Leseplan trägt die Einspeisegrenze GENAU EINMAL pro Tag', () => {
  const flow = { inverter_config: MIRROR_SEL };
  const elReg = routing.exportLimitRegister('hybrid_3p');
  const primary = routing.route(routing.parseConfig(MIRROR_SEL)).reads;

  // Erster Poll nach dem (Neu-)Start: fällig.
  let { ret } = runFunctionNode(byId['auto-router'].func, { flow });
  assert.deepStrictEqual(ret[0].deye.reads.slice(primary.length),
    [{ start: elReg.addr, count: 1, export_limit: true }]);

  // Die folgenden Polls tragen ihn NICHT - genau das ist die Lastgarantie.
  for (let i = 0; i < 5; i += 1) {
    ({ ret } = runFunctionNode(byId['auto-router'].func, { flow }));
    assert.deepStrictEqual(ret[0].deye.reads, primary, 'kein zweiter Umlauf am selben Tag');
  }

  // Einen Tag später wieder.
  flow['export_limit_at:' + MIRROR_SEL.connection.ip + ':' + MIRROR_SEL.connection.port] =
    Date.now() - routing.EXPORT_LIMIT_INTERVAL_MS - 1;
  ({ ret } = runFunctionNode(byId['auto-router'].func, { flow }));
  assert.strictEqual(ret[0].deye.reads.length, primary.length + 1);
});

test('eine Familie, deren Register WIR beschreiben, wird NIE gelesen', () => {
  // hybrid_1p: dort IST die Einspeisegrenze „Max Sell Power" (0x00F5), das
  // Register unseres eigenen Entlade-Hebels. Lesen wäre die Behauptung, unser
  // Befehl sei die Grenze des Geräts.
  const sel = {
    ...MIRROR_SEL,
    family: 'hybrid_1p',
  };
  const primary = routing.route(routing.parseConfig(sel)).reads;
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  assert.deepStrictEqual(ret[0].deye.reads, primary);
  assert.strictEqual(routing.exportLimitRegister('hybrid_1p'), null);
});

test('die Registerkarte des Flows ist die des Moduls', () => {
  // Der Router bekommt die Tabelle beim Generieren aus inverter-routing.js
  // eingesetzt - dieser Test hält fest, dass sie dort auch WIRKLICH steht.
  const func = byId['auto-router'].func;
  assert.ok(func.includes(JSON.stringify(routing.DEYE_EXPORT_LIMIT)),
    'DEYE_EXPORT_LIMIT wörtlich im Router');
  assert.ok(func.includes(String(routing.EXPORT_LIMIT_INTERVAL_MS)));
});

// The "Installateur-Register 0x00E7 lesen/schreiben" node (auto-installer-exec)
// carries a synced COPY of inverter-control-routing.installerWriteRoute(). This
// is the drift guard that matters most on this path: a divergence could widen
// the one-register allowlist or the value ceiling without anyone noticing.
//
// The body performs I/O, so it cannot simply be run - instead the copied
// PLANNER is extracted from the node source and evaluated on its own, then
// compared to the module for the same vectors.
function inlineInstallerPlanner() {
  const src = byId['auto-installer-exec'].func;
  const start = src.indexOf('const INSTALLER_WRITE_ADDR');
  const end = src.indexOf("const plan = installerWriteRoute(");
  assert.ok(start >= 0 && end > start, 'the inlined planner must be findable in the node body');
  const sandbox = { Number, isFinite, JSON, Math };
  vm.createContext(sandbox);
  new vm.Script(src.slice(start, end) + '\nthis.__route = installerWriteRoute;').runInContext(sandbox);
  return sandbox.__route;
}

test('flow installer-write planner matches installerWriteRoute() for every vector', () => {
  const route = inlineInstallerPlanner();
  const sel = {
    schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5',
    connection: { ip: '192.168.0.28', serial: '2985159064', mb_slave_id: 1 },
  };
  const vectors = [
    [sel, { mode: 'dry_run', addr: 0x00e7, value: 7000 }],
    [sel, { mode: 'apply', addr: 0x00e7, value: 7000 }],
    [sel, { mode: 'apply', addr: 0x00e7, value: 3300 }],
    [Object.assign({}, sel, { connection: Object.assign({}, sel.connection, { control_write_fc: 6 }) }), { mode: 'apply', addr: 0x00e7, value: 7000 }],
    [Object.assign({}, sel, { family: 'hybrid_1p' }), { mode: 'apply', addr: 0x00e7, value: 7000 }],
    [Object.assign({}, sel, { family: 'string' }), { mode: 'apply', addr: 0x00e7, value: 100 }],
    [Object.assign({}, sel, { communication: 'modbus_tcp' }), { mode: 'apply', addr: 0x00e7, value: 100 }],
    [sel, { mode: 'apply', addr: 0x0028, value: 100 }],
    [sel, { mode: 'apply', addr: 0x00e7, value: 0 }],
    [sel, { mode: 'apply', addr: 0x00e7, value: 7001 }],
    [null, { mode: 'apply', addr: 0x00e7, value: 7000 }],
    // Stufe 2 „Freie Register": a free address, both bounds of a register word,
    // a dry run WITHOUT a value, and the two shapes that are still refused.
    [sel, { mode: 'apply', addr: 0x1234, value: 100 }],
    [sel, { mode: 'apply', addr: 0x0000, value: 65535 }],
    [sel, { mode: 'dry_run', addr: 0x1234 }],
    [sel, { mode: 'apply', addr: 0x10000, value: 1 }],
    [sel, { mode: 'apply', addr: 0x1234, value: 65536 }],
    [Object.assign({}, sel, { family: 'hybrid_1p' }), { mode: 'apply', addr: 0x00f5, value: 7000 }],
  ];
  for (const [s, r] of vectors) {
    const inline = JSON.parse(JSON.stringify(route(s, r)));
    const module = JSON.parse(JSON.stringify(controlRouting.installerWriteRoute(s, r)));
    // The German reasons are re-spelled without umlaut escapes in the flow copy
    // (a Node-RED function body is JSON), so compare the DECISION, not the prose.
    delete inline.reason; delete module.reason;
    assert.deepStrictEqual(inline, module, JSON.stringify(r));
    assert.strictEqual(route(s, r).ok, controlRouting.installerWriteRoute(s, r).ok);
  }
});

test('flow installer-write node pins the register-word bound and the socket lock', () => {
  const src = byId['auto-installer-exec'].func;
  // Since Stufe 2 the address is FREE; what stays pinned is the bound of a
  // register word - the one thing this planner can judge without the device.
  assert.ok(src.includes('const REGISTER_WORD_MAX = 0xffff;'), 'the register-word bound is hard-coded');
  assert.strictEqual(controlRouting.REGISTER_WORD_MAX, 0xffff);
  assert.strictEqual(controlRouting.INSTALLER_WRITE_ADDR, 0x00e7);
  assert.strictEqual(controlRouting.INSTALLER_WRITE_MAX_RAW, 7000);
  // It must share the ONE socket lock of this tab - a second lock would be a
  // second TCP client on a logger that serves exactly one.
  assert.ok(src.includes("'sv5_busy:'"),
    'the installer write must use the SAME per-(host,port) lock as poll + control');
  // ⚠ AND IT MUST NOT TOUCH THE CONTROL EXECUTOR'S INTENT FLAG. Sharing
  // `sv5_write_want:` was Befund 1 of the Pilsting incident (20.08.2026): the
  // control executor clears that flag at the end of EVERY round, so a waiting
  // one-shot order lost its announced intent and the read poll stopped standing
  // down for it. Each writer owns its own key now.
  assert.ok(!src.includes("'sv5_write_want:'"),
    'the one-shot order must never write the control executor\'s intent flag');
  assert.ok(src.includes("'" + bus.KEY_ONESHOT('') + "'") && src.includes("'" + bus.KEY_GRANT('') + "'"),
    'the one-shot order reserves the bus and can be handed the socket');
  // The node must live in the SAME tab as the poll (flow context is per tab).
  assert.strictEqual(byId['auto-installer-exec'].z, byId['auto-solarman'].z);
});

// --- die WARTESCHLANGE des einen Sockets (bus-arbitration.js) ----------------
//
// Diese drei Tests sind die Wächter über der Ursache des Produktionsvorfalls
// vom 20.08.2026 (Box edge-45gz7da): ein Einmal-Lesebefehl aus dem Portal
// verhungerte am Wechselrichter-Bus, und der Kern meldete nach 30 s `timeout`.

test('die drei Knoten teilen GENAU EINE Warteschlangen-Sprache', () => {
  const one = byId['auto-installer-exec'].func;
  const ctrl = byId['auto-control-exec-deye'].func;
  const read = byId['auto-solarman'].func;
  for (const [name, src] of [['Einmal-Auftrag', one], ['Steuerung', ctrl], ['Lese-Poll', read]]) {
    assert.ok(src.includes("'" + bus.KEY_ONESHOT('') + "'"), name + ' kennt die Reservierung');
    assert.ok(src.includes("'" + bus.KEY_GRANT('') + "'"), name + ' kennt die Uebergabe');
    assert.ok(src.includes('RESERVE_TTL_MS = ' + bus.ONESHOT_RESERVE_TTL_MS),
      name + ' traegt die Reservierungs-Frist des Moduls');
    assert.ok(src.includes('GRANT_TTL_MS = ' + bus.ONESHOT_GRANT_TTL_MS),
      name + ' traegt die Uebergabe-Frist des Moduls');
  }
  // Nur wer den Socket HAELT, uebergibt ihn - der Lese-Poll und der Steuer-
  // Executor tun es, der Einmal-Auftrag reicht ihn an niemanden weiter.
  assert.ok(/flow\.set\(grantKey, \{ id: res\.id/.test(read), 'der Lese-Poll uebergibt beim Freigeben');
  assert.ok(/flow\.set\(grantKey, \{ id: r\.id/.test(ctrl), 'die Steuerung uebergibt beim Freigeben');
  // Und der Steuer-Executor faellt NICHT ueber eine laufende Uebergabe her.
  assert.ok(/gLive && \(!bs \|\| tn - bs >= STALE_MS\)/.test(ctrl),
    'die Steuerung wartet eine laufende Uebergabe ab, statt sie zu ueberholen');
});

test('die ZEITFENSTER-KETTE haelt: der Knoten kann den Kern nicht ueberleben', () => {
  // ⚠ DER BEFUND, DER DEN `timeout` ERZEUGT HAT. Der Einmal-Knoten durfte 12 s
  // auf den Socket warten UND danach 25 s am Socket verbringen - zusammen 37 s,
  // waehrend der Kern ihn nach 30 s aufgibt. Auf einer belegten Anlage meldete
  // die Cloud deshalb `timeout`, obwohl der Knoten Sekunden spaeter korrekt
  // geantwortet haette - in einen laengst vergessenen Wartenden hinein.
  const src = byId['auto-installer-exec'].func;
  const num = (re, what) => {
    const m = src.match(re);
    assert.ok(m, 'nicht gefunden im Knoten: ' + what);
    return Number(m[1]);
  };
  const acquire = num(/Number\(flow\.get\('sv5_acquire_ms'\)\) : (\d+);/, 'Warte-Budget');
  const socket = num(/finish\(new Error\('Zeitueberschreitung'\)\), (\d+)\)/, 'Socket-Budget');
  assert.strictEqual(acquire, bus.ONESHOT_ACQUIRE_MS, 'das Warte-Budget des Moduls');
  assert.strictEqual(socket, bus.ONESHOT_SOCKET_MS, 'das Socket-Budget des Moduls');

  // Die Schranke des KERNS, aus der ausgelieferten Go-Datei gelesen - die
  // beiden Haelften der Kette duerfen nicht getrennt wandern.
  const go = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'internal', 'agent', 'installerwrite.go'), 'utf8');
  const m = go.match(/installerWriteTimeout = (\d+) \* time\.Second/);
  assert.ok(m, 'installerWriteTimeout in installerwrite.go');
  const coreMs = Number(m[1]) * 1000;
  assert.strictEqual(coreMs, bus.BOX_ROUND_TRIP_MS, 'das Modul kennt die Schranke des Kerns');
  assert.ok(acquire + socket <= coreMs,
    'Warten (' + acquire + ' ms) + Arbeiten (' + socket + ' ms) muss UNTER der Schranke des '
      + 'Kerns (' + coreMs + ' ms) bleiben - sonst meldet die Cloud `timeout`, waehrend das '
      + 'Geraet noch arbeitet');
  assert.ok(bus.chainOK(), 'die Kette des Moduls ist in sich stimmig');

  // Und das Warte-Budget muss EINE volle Socket-Runde eines anderen Halters
  // ueberdauern - sonst gibt der Auftrag genau dann auf, wenn die Uebergabe
  // gleich kaeme.
  const ctrlSocket = Number(byId['auto-control-exec-deye'].func.match(/finish\(new Error\('Timeout'\)\), (\d+)\)/)[1]);
  assert.strictEqual(ctrlSocket, bus.CONTROL_SOCKET_MS, 'der Steuer-Executor deckelt sich wie notiert');
  assert.ok(acquire > ctrlSocket, 'das Warte-Budget ueberdauert eine ganze Steuerrunde');
});

test('der Lese-Poll tritt fuer eine Reservierung zurueck - aber nur GEBUNDEN', () => {
  const src = byId['auto-solarman'].func;
  assert.ok(src.includes('ONESHOT_YIELD_TICKS = ' + bus.ONESHOT_READ_YIELD_TICKS),
    'die Schranke des Moduls steht im Knoten');
  // 6 Takte x 5 s decken den ganzen Worst Case eines Einmal-Auftrags ab, also
  // wird nie mitten in einem legitimen Auftrag erzwungen - und die Schranke
  // bleibt trotzdem da, damit eine haengende Reservierung die Telemetrie nicht
  // aushungern kann.
  const pollSeconds = Number(byId['auto-poll'].repeat);
  assert.ok(bus.ONESHOT_READ_YIELD_TICKS * pollSeconds * 1000
    >= bus.ONESHOT_ACQUIRE_MS + bus.ONESHOT_SOCKET_MS,
    'der Rueckzug deckt den ganzen Worst Case des Einmal-Auftrags ab');
  assert.ok(/erzwungen/.test(src), 'das Erzwingen bleibt hoerbar');
});

// --- NATIVE SELF-REGULATION: the inline planner vs. the module ---------------
//
// The flow carries INLINE planners for the two tiers its executors can really
// execute: the generic modbus_tcp profile and the DEYE REMOTE block (the
// released pilot). The full per-tier primitive lives in
// inverter-control-routing.js. These guards keep that split honest: each inline
// copy must agree with the module on the tier it covers - down to the German
// reason of every refusal, because that is what the operator reads - and the
// pair must REFUSE, not improvise, on every tier they do not.
test('the inline native planner agrees with the module on the generic tier', () => {
  const { nativeSelfConsumption } = require('./inverter-control-routing');
  const nat = require('./unplanned-load-native');
  const sel = {
    schema_version: '1.0', brand: 'generic_modbus', model: 'sunspec-sim', family: 'sunspec',
    communication: 'modbus_tcp', control_tier: 1,
    connection: { ip: '10.0.0.9', port: 502, unit_id: 1, firmware: 'sim' },
  };
  const sp = {
    battery_setpoint_kw: -7.087, control_enabled: true, device_certified: true,
    grid_charge_allowed: true, battery_mode: 'native', pv_limit_kw: 12.5,
    ts: new Date().toISOString(), source: 'schedule',
  };
  // The SIM tab's selection is a fixed literal, so this drives the AUTO plan node
  // (which reads flow.inverter_config) with the simulator catalog swapped in - the
  // ONE substitution, asserted so a changed expression fails loudly.
  const body = byId['auto-control-plan'].func
    .replace('__NATIVE.CERTIFIED_NATIVE_CAPABILITIES', '__NATIVE.SIMULATOR_NATIVE_CAPABILITIES');
  assert.ok(body !== byId['auto-control-plan'].func, 'the catalog expression changed - update this guard');
  const inline = runFunctionNode(body, { msg: { setpoint: sp }, flow: { inverter_config: sel } }).msg.control;
  const module_ = nativeSelfConsumption(sel, {
    controlEnabled: true, deviceCertified: true, solarOnlyCharge: false,
    catalog: nat.SIMULATOR_NATIVE_CAPABILITIES, pvLimitKw: 12.5,
  });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(inline.writes.map((w) => ({ addr: w.addr, value: w.value })))),
    module_.writes.map((w) => ({ addr: w.addr, value: w.value })),
    'inline and module must plan the same bytes for the tier they share');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(inline.readbacks.map((r) => ({ addr: r.addr, expect: r.expect })))),
    module_.readbacks.map((r) => ({ addr: r.addr, expect: r.expect })),
    'and the same proof registers');
});

// The DEYE REMOTE tier is the SECOND one the flow covers (the released pilot).
// Same two guards as the generic tier: the inline copy must agree with the module
// on the bytes it plans, and on the German reason of every refusal - the reasons
// are what the operator reads, so a drift there is a drift in the product.
const DEYE_NATIVE_SEL = {
  schema_version: '1.0', brand: 'deye', model: 'sun-30k-sg01hp3', family: 'hybrid_3p',
  communication: 'solarman_v5', control_tier: 3, rated_kw: 30,
  connection: { ip: '10.0.0.8', port: 8899, serial: 2985159064, mb_slave_id: 1, power_scale: 10 },
};
// The device's own Time-of-Use configuration, as the executor caches it: armed,
// discharging down to 5 % - i.e. past a 10 % reserve floor - and not grid-charging.
// `at` is the executor's read timestamp: the plan node treats an OLD cache as
// "not read" (see the freshness note there), so every fixture carries a live one.
const DEYE_NATIVE_CFG = { at: Date.now(), tou_enable: 0x00ff, program_target_soc: 5, grid_charge_enable: 0 };
// The remote-mode capability the executor's probe classifies (PR-978 layout).
function deyeNativeSticky() {
  return { path: 'remote', since: Date.now(), contrary: 0, everRemote: true, seededFromGrant: true };
}
function deyeNativeSetpoint(extra = {}) {
  return {
    battery_setpoint_kw: -7, control_enabled: true, device_certified: true,
    device_certified_path: 'remote', grid_charge_allowed: true, battery_mode: 'native',
    effective_floor_soc_pct: 10, soc_min_pct: 5, soc_max_pct: 95,
    ts: new Date().toISOString(), source: 'schedule', ...extra,
  };
}
// Run the AUTO plan node with the Deye selection + the executor's two caches.
function deyeNativePlan(sp, opts = {}) {
  // ⚠ `'cfg' in opts`, never a default parameter: an EXPLICIT `cfg: undefined`
  // is the "nothing was read" case and must stay undefined, not fall back to a
  // healthy configuration (that silently made the refusal case plan a hand-over).
  const cfg = 'cfg' in opts ? opts.cfg : DEYE_NATIVE_CFG;
  const sel = opts.sel || DEYE_NATIVE_SEL;
  const target = sel.connection.ip + ':' + sel.connection.port;
  return runFunctionNode(byId['auto-control-plan'].func, {
    msg: { setpoint: sp },
    flow: {
      inverter_config: sel,
      ['deye_path:' + target]: deyeNativeSticky(),
      ['deye_native_cfg:' + target]: cfg,
    },
  }).msg.control;
}

test('the inline native planner agrees with the module on the DEYE remote tier', () => {
  const { nativeSelfConsumption } = require('./inverter-control-routing');
  const sp = deyeNativeSetpoint();
  const inline = deyeNativePlan(sp);
  const module_ = nativeSelfConsumption(DEYE_NATIVE_SEL, {
    controlEnabled: true, deviceCertified: true, solarOnlyCharge: false,
    deyeSticky: deyeNativeSticky(), deyeOwnConfig: DEYE_NATIVE_CFG,
    effectiveFloorSocPct: 10,
  });
  assert.strictEqual(module_.writes.length, 1, 'the module plans exactly the hand-over');
  assert.deepStrictEqual(
    inline.writes.map((w) => ({ addr: w.addr, value: w.value })),
    module_.writes.map((w) => ({ addr: w.addr, value: w.value })),
    'inline and module must plan the same bytes for the tier they share');
  assert.deepStrictEqual(
    inline.readbacks.map((r) => ({ addr: r.addr, expect: r.expect })),
    module_.readbacks.map((r) => ({ addr: r.addr, expect: r.expect })),
    'and the same proof register');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(inline.gridChargeProof)),
    JSON.parse(JSON.stringify(module_.gridChargeProof)),
    'and the same EEG proof register');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(inline.nativePreconditions)),
    JSON.parse(JSON.stringify(module_.preconditions)),
    'and the same registers to read BEFORE the hand-over');
});

test('the inline native planner refuses like the module, with the same German reason', () => {
  const { nativeSelfConsumption } = require('./inverter-control-routing');
  const both = (spExtra, opts, planOpts) => {
    const sp = deyeNativeSetpoint(spExtra);
    const inline = deyeNativePlan(sp, planOpts);
    const module_ = nativeSelfConsumption(planOpts && planOpts.sel ? planOpts.sel : DEYE_NATIVE_SEL, {
      controlEnabled: sp.control_enabled === true, deviceCertified: true,
      solarOnlyCharge: sp.grid_charge_allowed !== true,
      deyeSticky: deyeNativeSticky(),
      deyeOwnConfig: (planOpts && 'cfg' in planOpts) ? planOpts.cfg : DEYE_NATIVE_CFG,
      effectiveFloorSocPct: sp.effective_floor_soc_pct,
      ...opts,
    });
    return { inline, module_ };
  };

  // 1. The inverter's own Time-of-Use program is not armed: without it the manual
  //    is unambiguous - it will not discharge to the loads.
  let r = both({}, {}, { cfg: { ...DEYE_NATIVE_CFG, tou_enable: 0x00fe } });
  assert.match(r.module_.reason, /Time of Use/);
  assert.strictEqual(r.module_.writes.length, 0);
  // The plan node falls back to the follower, so the reason travels as the WARN;
  // what must hold here is that no native plan reached msg.control.
  assert.notStrictEqual(r.inline.mode, 'native', 'an unarmed ToU program hands nothing over');

  // 2. The program stops discharging ABOVE our reserve floor.
  r = both({ effective_floor_soc_pct: 3 }, {}, {});
  assert.match(r.module_.reason, /Reserve-Untergrenze/);
  assert.notStrictEqual(r.inline.mode, 'native');

  // 3. An EEG site whose program still permits grid charging.
  r = both({ grid_charge_allowed: false }, {}, { cfg: { ...DEYE_NATIVE_CFG, grid_charge_enable: 1 } });
  assert.match(r.module_.reason, /EEG-Anlage/);
  assert.notStrictEqual(r.inline.mode, 'native');

  // 4. Nothing read at all - the honest "not known", never an assumed zero.
  r = both({}, {}, { cfg: undefined });
  assert.match(r.module_.reason, /eigene Konfiguration/);
  assert.notStrictEqual(r.inline.mode, 'native');

  // 5. Any OTHER Deye model: the certificate is bound to the pilot alone.
  const other = { ...DEYE_NATIVE_SEL, model: 'sun-12k-sg04lp3' };
  r = both({}, {}, { sel: other });
  assert.match(r.module_.reason, /Pr\u00fcfstand/);
  assert.notStrictEqual(r.inline.mode, 'native');

  // 6. INLINE-ONLY, and deliberately so: a cache the executor stopped refreshing
  //    is not knowledge. The module receives whatever its caller hands in, so the
  //    freshness lives at the plan node's READ - which is why this case has no
  //    module twin to compare against.
  const stale = deyeNativePlan(deyeNativeSetpoint(),
    { cfg: { ...DEYE_NATIVE_CFG, at: Date.now() - 6 * 60 * 1000 } });
  assert.notStrictEqual(stale.mode, 'native', 'a stale cache hands nothing over');
  const undated = deyeNativePlan(deyeNativeSetpoint(),
    { cfg: { tou_enable: 0x00ff, program_target_soc: 5, grid_charge_enable: 0 } });
  assert.notStrictEqual(undated.mode, 'native', 'and neither does an undated one');
});

test('the inline native planner refuses every tier it does not cover', () => {
  const sp = {
    battery_setpoint_kw: -7, control_enabled: true, device_certified: true,
    grid_charge_allowed: true, battery_mode: 'native',
    ts: new Date().toISOString(), source: 'schedule',
  };
  // Fronius Model 124, KOSTAL and KACO NH3 all HAVE a primitive in the module -
  // their EXECUTORS are follow-up work, so the flow must keep the proven follower
  // rather than improvise a sequence nothing in this flow could carry out.
  const uncovered = [
    { schema_version: '1.0', brand: 'fronius', model: 'gen24', family: 'fronius_hybrid',
      communication: 'fronius_solar_api', control_tier: 1,
      connection: { ip: '10.0.0.7', control_port: 502, control_unit_id: 1 } },
    { schema_version: '1.0', brand: 'kostal', model: 'plenticore', family: 'kostal_hybrid',
      communication: 'kostal_modbus', control_tier: 2,
      connection: { ip: '10.0.0.6', port: 1502, unit_id: 71 } },
    { schema_version: '1.0', brand: 'kaco', model: 'nh3', family: 'kaco_nh3',
      communication: 'kaco_modbus', control_tier: 1,
      connection: { ip: '10.0.0.5', port: 502, unit_id: 1 } },
  ];
  for (const sel of uncovered) {
    const out = runFunctionNode(byId['auto-control-plan'].func,
      { msg: { setpoint: sp }, flow: { inverter_config: sel } }).msg.control;
    assert.notStrictEqual(out && out.mode, 'native',
      `an uncovered tier must fall back to the follower (${sel.communication})`);
  }
  // And a Deye WITHOUT the remote firmware stays on the follower too - the Deye
  // ToU path deliberately has no primitive (EEPROM latency + snapshot duty).
  const touDeye = {
    schema_version: '1.0', brand: 'deye', model: 'sun-30k-sg01hp3', family: 'hybrid_3p',
    communication: 'solarman_v5', control_tier: 3, rated_kw: 30,
    connection: { ip: '10.0.0.8', port: 8899, serial: 2985159064, power_scale: 10 },
  };
  const touOut = runFunctionNode(byId['auto-control-plan'].func, {
    msg: { setpoint: sp },
    flow: {
      inverter_config: touDeye,
      'deye_path:10.0.0.8:8899': { path: 'tou', since: Date.now(), contrary: 0, everRemote: false },
    },
  }).msg.control;
  assert.notStrictEqual(touOut && touOut.mode, 'native',
    'Deye ToU has no native primitive - the follower carries the slot');
});
