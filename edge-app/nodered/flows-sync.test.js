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
const modbusTcp = require('./modbus-tcp');

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
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1, invert_grid_sign: true, power_scale: 10 },
  };
  const { ret } = runFunctionNode(byId['auto-router'].func, { flow: { inverter_config: sel } });
  // output 1 carries msg.deye
  const outMsg = ret[0];
  const expected = routing.route(routing.parseConfig(sel));
  assert.strictEqual(outMsg.deye.target, expected.target);
  assert.strictEqual(outMsg.deye.cfg.family, expected.family);
  assert.strictEqual(outMsg.deye.cfg.serial, expected.connection.serial);
  assert.strictEqual(outMsg.deye.cfg.invert_grid_sign, expected.connection.invert_grid_sign);
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
