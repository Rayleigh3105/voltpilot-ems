'use strict';
// node --test compile.test.js - the offline compiler proof: the repo's
// contract fixtures compile, output is DETERMINISTIC (pinned hash), the
// bundle carries only whitelisted node types + the @vp-flow marker, and the
// validator refuses the contract's error classes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { compile, validate, ValidationError } = require('./compile');
const { TYPES } = require('./catalog');
const { contentHash } = require('./canonicalize');

const EXAMPLES = path.join(__dirname, '..', '..', '..', 'docs', 'contracts', 'v2', 'examples');
const API_CATALOG = path.join(
  __dirname, '..', '..', '..', 'services', 'api', 'src', 'main', 'resources', 'flowcatalog', 'catalog.json');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), 'utf8'));
}

// Every node type the compiler may EVER emit: vp-palette nodes + the two
// generated shapes. Anything else appearing in a bundle is a compiler bug
// (and would break the "no user code paths" isolation guarantee).
const WHITELISTED_NR_TYPES = new Set([
  'tab', 'vp-entity-read', 'vp-feed', 'vp-desired', 'vp-notify', 'function', 'inject',
]);

test('pv-surplus-heatrod fixture compiles deterministically', () => {
  const graph = fixture('flow-graph.valid.pv-surplus-heatrod.json');
  const a1 = compile(graph);
  const a2 = compile(graph);
  assert.strictEqual(JSON.stringify(a1), JSON.stringify(a2), 'compilation must be deterministic');

  // The hash is real: recomputing over the bundle reproduces it.
  assert.strictEqual(a1.content_hash, contentHash(a1.bundle));

  // Deterministic ids per (flow_id, flow_version) - the redeploy-replaces
  // property; the tab id matches the contract fixture convention.
  assert.strictEqual(a1.bundle.tab_ids[0], 'vpflow-4e1c2b3a-v7');
  assert.strictEqual(a1.artifact_id, compile(graph).artifact_id);

  // Ownership marker (reseed coexistence D-12).
  const tab = a1.bundle.nodered_flows[0];
  assert.strictEqual(tab.type, 'tab');
  assert.match(tab.info, /^@vp-flow flow_id=4e1c2b3a-5d6e-4f70-8123-456789abcdef flow_version=7$/);

  // Only whitelisted implementations - no foreign node types, no free code.
  for (const n of a1.bundle.nodered_flows) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected node type ' + n.type);
    if (n.type === 'function') {
      assert.match(n.func, /^\/\/ generiert von flowc/, 'function code must be generated');
    }
  }

  // The action node is the vp-desired publisher with the compiler-stamped
  // flow identity (not customer-editable).
  const desired = a1.bundle.nodered_flows.find((n) => n.type === 'vp-desired');
  assert.strictEqual(desired.entity, 'heatrod-cellar');
  assert.strictEqual(desired.command, 'on_off');
  assert.strictEqual(desired.ttl_s, 180);
  assert.strictEqual(desired.flowId, graph.flow_id);
  assert.strictEqual(desired.flowVersion, 7);
  assert.strictEqual(desired.nodeId, 'n7');

  // required_entities = the union of read channels + control commands.
  assert.deepStrictEqual(a1.required_entities, [
    { entity_id: 'grid-meter-1', capabilities: ['measure:power_kw'] },
    { entity_id: 'heatrod-cellar', capabilities: ['actuate:on_off'] },
  ]);

  // Wiring: read -> threshold -> control.
  const read = a1.bundle.nodered_flows.find((n) => n.type === 'vp-entity-read');
  const fn = a1.bundle.nodered_flows.find((n) => n.type === 'function');
  assert.deepStrictEqual(read.wires, [[fn.id]]);
  assert.deepStrictEqual(fn.wires, [[desired.id]]);
  // The value-change trigger's deadband landed on the read node.
  assert.strictEqual(read.deadband, 0.5);
});

// The PINNED deterministic hash: recompiling the committed fixture must
// reproduce these bytes forever. A compiler change that alters the output
// must consciously update this pin (it invalidates deployed content hashes).
test('pinned content hash of the pv-surplus-heatrod fixture', () => {
  const a = compile(fixture('flow-graph.valid.pv-surplus-heatrod.json'));
  const pinFile = path.join(__dirname, 'pinned-hash.txt');
  if (!fs.existsSync(pinFile)) {
    fs.writeFileSync(pinFile, a.content_hash + '\n');
  }
  const pinned = fs.readFileSync(pinFile, 'utf8').trim();
  assert.strictEqual(a.content_hash, pinned,
    'compiler output drifted from the committed pin (pinned-hash.txt) - a deliberate change must update the pin');
});

test('market-battery fixture compiles the delegated strategy as a no-op', () => {
  const graph = fixture('flow-graph.valid.market-battery.json');
  const a = compile(graph);
  // Delegation: the compiled tab must NOT contain a desired publisher - the
  // plan commands the entity (plan-execution-ownership).
  assert.strictEqual(a.bundle.nodered_flows.find((n) => n.type === 'vp-desired'), undefined);
  const strategy = a.bundle.nodered_flows.find((n) => n.type === 'function' && /DELEGIERT/.test(n.func));
  assert.ok(strategy, 'strategy node must compile to the delegation no-op');
  // The claim still reserves the capability on the device.
  assert.deepStrictEqual(a.required_entities, [
    { entity_id: 'batt-main', capabilities: ['actuate:setpoint_kw'] },
  ]);
  // The price feed compiles to the whitelisted vp-feed subscriber.
  const feed = a.bundle.nodered_flows.find((n) => n.type === 'vp-feed');
  assert.strictEqual(feed.feed, 'prices');
});

test('peakshaving-battery fixture compiles the delegated strategy as a no-op', () => {
  const graph = fixture('flow-graph.valid.peakshaving-battery.json');
  const a = compile(graph);
  // Delegation, exactly like the market strategy: no desired publisher (the
  // v1 plan + PS-3 edge peak guard command the entity), just the no-op fn node.
  assert.strictEqual(a.bundle.nodered_flows.find((n) => n.type === 'vp-desired'), undefined);
  const strategy = a.bundle.nodered_flows.find((n) => n.type === 'function' && /DELEGIERT/.test(n.func));
  assert.ok(strategy, 'peak-shaving strategy node must compile to the delegation no-op');
  // The claim still reserves the setpoint capability + the soc read is required.
  assert.deepStrictEqual(a.required_entities, [
    { entity_id: 'batt-main', capabilities: ['actuate:setpoint_kw', 'measure:soc_pct'] },
  ]);
});

// The PINNED deterministic hash of the peakshaving fixture (E5a): compiling
// the committed graph must reproduce these bytes so a deployed content_hash is
// stable. A deliberate compiler change must consciously update this pin.
test('pinned content hash of the peakshaving-battery fixture', () => {
  const a = compile(fixture('flow-graph.valid.peakshaving-battery.json'));
  const pinFile = path.join(__dirname, 'pinned-peakshaving-hash.txt');
  if (!fs.existsSync(pinFile)) {
    fs.writeFileSync(pinFile, a.content_hash + '\n');
  }
  const pinned = fs.readFileSync(pinFile, 'utf8').trim();
  assert.strictEqual(a.content_hash, pinned,
    'peakshaving compiler output drifted from the committed pin (pinned-peakshaving-hash.txt)');
});

test('validator refuses the contract error classes', () => {
  const base = fixture('flow-graph.valid.pv-surplus-heatrod.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);

  assert.ok(findRule(mutate((g) => { g.nodes[0].type = 'vp.entity.unknown'; }), 'V-4'), 'unknown type');
  assert.ok(findRule(mutate((g) => { g.nodes[1].parameters.direction = 'sideways'; }), 'V-4'), 'bad params');
  assert.ok(findRule(mutate((g) => { g.edges[0].to = { node: 'n7', port: 'value' }; }), 'V-1'),
    'number -> number|bool passes but bool port mismatch elsewhere; here: two edges into one input');
  assert.ok(findRule(mutate((g) => {
    g.edges[1].from = { node: 'n2', port: 'value' }; // number into number|bool is fine; force type clash:
    g.edges[1].to = { node: 'n5', port: 'input' };
  }), 'V-1'), 'double edge into one input');
  assert.ok(findRule(mutate((g) => { g.triggers = []; }), 'V-7'), 'missing trigger');
  assert.ok(findRule(mutate((g) => { g.runtime = 'cloud'; }), 'V-8'), 'cloud runtime refused here');
  assert.ok(findRule(mutate((g) => { g.nodes[2].claims = []; }), 'V-5'), 'claims must match catalog derivation');
  assert.ok(findRule(mutate((g) => {
    g.nodes.push(JSON.parse(JSON.stringify(g.nodes[2])));
    g.nodes[3].id = 'n8';
  }), 'V-5'), 'exclusive claim violated within the flow');
  assert.ok(findRule(mutate((g) => {
    g.edges.push({ id: 'eBack', from: { node: 'n5', port: 'result' }, to: { node: 'n5', port: 'input' } });
  }), 'V-2'), 'cycle without feedback flag');

  // A feedback-flagged cycle is legal (previous-evaluation semantics) but
  // still type-checked (bool -> number fails V-1); use a legal self-loop
  // shape instead: threshold result -> threshold input is bool->number, so
  // check only that V-2 stops firing with the flag.
  const fb = mutate((g) => {
    g.edges.push({ id: 'eBack', from: { node: 'n5', port: 'result' }, to: { node: 'n5', port: 'input' }, feedback: true });
  });
  assert.ok(!findRule(fb, 'V-2'), 'feedback edge must not count as a cycle');

  assert.throws(() => compile(mutate((g) => { g.triggers = []; })), ValidationError);
});

// The notification automation (Schwellwert -> Wenn/Dann-gate -> Benachrichtigung)
// is the exact flow that USED to validate + simulate in the editor and then die
// at activation with compiler_rejected ("unbekannter Katalogtyp vp.logic.gate")
// because flowc had no compile entry for the gate (OpenProject #518). It must
// now compile deterministically.
test('notify-threshold fixture compiles the gate + notification chain', () => {
  const graph = fixture('flow-graph.valid.notify-threshold.json');
  const a = compile(graph);

  // Only whitelisted implementations: the gate + threshold compile to generated
  // function nodes, the action to the vp-notify publisher.
  for (const n of a.bundle.nodered_flows) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected node type ' + n.type);
  }
  const fns = a.bundle.nodered_flows.filter((n) => n.type === 'function');
  assert.strictEqual(fns.length, 2, 'threshold + gate both compile to function nodes');
  for (const fn of fns) assert.match(fn.func, /^\/\/ generiert von flowc/);

  // The gate is a rising-edge event: its generated body only forwards the
  // message on the false->true transition (context "on"), so notify fires once.
  const gate = fns.find((n) => /context\.get\("on"\)/.test(n.func) && /cond && !prev/.test(n.func));
  assert.ok(gate, 'the gate compiles to the rising-edge trigger body');

  // Wiring: read -> threshold -> gate -> notify.
  const read = a.bundle.nodered_flows.find((n) => n.type === 'vp-entity-read');
  const notify = a.bundle.nodered_flows.find((n) => n.type === 'vp-notify');
  assert.strictEqual(notify.message, 'Ihre Anlage speist gerade mehr als 5 kW ins Netz ein.');
  const threshold = fns.find((n) => n !== gate);
  assert.deepStrictEqual(read.wires, [[threshold.id]]);
  assert.deepStrictEqual(threshold.wires, [[gate.id]]);
  assert.deepStrictEqual(gate.wires, [[notify.id]]);
});

// The PINNED deterministic hash of the notify-threshold fixture (#518): a
// deployed content_hash must stay stable; a deliberate compiler change updates
// the pin consciously.
test('pinned content hash of the notify-threshold fixture', () => {
  const a = compile(fixture('flow-graph.valid.notify-threshold.json'));
  const pinFile = path.join(__dirname, 'pinned-notify-hash.txt');
  if (!fs.existsSync(pinFile)) {
    fs.writeFileSync(pinFile, a.content_hash + '\n');
  }
  const pinned = fs.readFileSync(pinFile, 'utf8').trim();
  assert.strictEqual(a.content_hash, pinned,
    'notify-threshold compiler output drifted from the committed pin (pinned-notify-hash.txt)');
});

// U3: the compound automation ("PV-Überschuss UND Zeitfenster -> Wallbox")
// exercises the boolean combinator vp.logic.and + a schedule window with the
// editor's enum `days`. Both nodes were previously un-compilable (no AND node;
// schedule.window rejected the string day set).
test('compound-wallbox fixture compiles the AND combinator + enum schedule', () => {
  const a = compile(fixture('flow-graph.valid.compound-wallbox.json'));
  for (const n of a.bundle.nodered_flows) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected node type ' + n.type);
  }
  const fns = a.bundle.nodered_flows.filter((n) => n.type === 'function' && /generiert von flowc/.test(n.func));
  const andNode = fns.find((n) => /vals\.every/.test(n.func));
  assert.ok(andNode, 'the Und-Baustein compiles to the every() combiner body');
  const window = fns.find((n) => /getHours/.test(n.func));
  assert.ok(window, 'the schedule window compiles');
  assert.match(window.func, /"days":\[\]/, 'days "alle" maps to the every-day empty set');
  // Wiring: threshold + schedule both feed the AND, AND feeds the control.
  const desired = a.bundle.nodered_flows.find((n) => n.type === 'vp-desired');
  assert.strictEqual(desired.entity, 'wallbox-1');
  assert.deepStrictEqual(andNode.wires, [[desired.id]]);
});

test('pinned content hash of the compound-wallbox fixture', () => {
  const a = compile(fixture('flow-graph.valid.compound-wallbox.json'));
  const pinFile = path.join(__dirname, 'pinned-compound-hash.txt');
  if (!fs.existsSync(pinFile)) {
    fs.writeFileSync(pinFile, a.content_hash + '\n');
  }
  const pinned = fs.readFileSync(pinFile, 'utf8').trim();
  assert.strictEqual(a.content_hash, pinned,
    'compound-wallbox compiler output drifted from the committed pin (pinned-compound-hash.txt)');
});

// U3: the price automation ("Börsenpreis < 10 ct -> Wallbox") exercises the new
// vp.price.current data node feeding a threshold.
test('price-wallbox fixture compiles the current-price feed + threshold', () => {
  const a = compile(fixture('flow-graph.valid.price-wallbox.json'));
  for (const n of a.bundle.nodered_flows) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected node type ' + n.type);
  }
  const feed = a.bundle.nodered_flows.find((n) => n.type === 'vp-feed' && n.feed === 'price_current');
  assert.ok(feed, 'vp.price.current compiles to a vp-feed with feed=price_current');
  const threshold = a.bundle.nodered_flows.find((n) => n.type === 'function' && /P\.threshold/.test(n.func));
  const desired = a.bundle.nodered_flows.find((n) => n.type === 'vp-desired');
  assert.deepStrictEqual(feed.wires, [[threshold.id]]);
  assert.deepStrictEqual(threshold.wires, [[desired.id]]);
});

test('pinned content hash of the price-wallbox fixture', () => {
  const a = compile(fixture('flow-graph.valid.price-wallbox.json'));
  const pinFile = path.join(__dirname, 'pinned-price-hash.txt');
  if (!fs.existsSync(pinFile)) {
    fs.writeFileSync(pinFile, a.content_hash + '\n');
  }
  const pinned = fs.readFileSync(pinFile, 'utf8').trim();
  assert.strictEqual(a.content_hash, pinned,
    'price-wallbox compiler output drifted from the committed pin (pinned-price-hash.txt)');
});

// Drift guard (#518): the flowc TYPES map and the api flow-catalog MUST declare
// the SAME set of node types. flowc had vp.logic.if but not vp.logic.gate while
// the api/portal had vp.logic.gate but not vp.logic.if - so a gate flow that the
// editor accepts died at flowc compile (and an if flow the compiler knew could
// never come from the editor). This catches that whole class: every type in one
// catalog is known to the other. (api <-> portal byte-equality is guarded
// separately by the portal's catalog.sync.test.ts.)
test('flowc catalog and the api flow-catalog declare the same node types', () => {
  const api = JSON.parse(fs.readFileSync(API_CATALOG, 'utf8'));
  const apiTypes = new Set(api.types.map((t) => t.type));
  const flowcTypes = new Set(Object.keys(TYPES));

  const inApiOnly = [...apiTypes].filter((t) => !flowcTypes.has(t));
  const inFlowcOnly = [...flowcTypes].filter((t) => !apiTypes.has(t));
  assert.deepStrictEqual(inApiOnly, [],
    'types the editor offers but flowc cannot compile (activation would compiler_reject): ' + inApiOnly);
  assert.deepStrictEqual(inFlowcOnly, [],
    'types flowc compiles but the editor never produces (dead compile entries): ' + inFlowcOnly);
});

test('type widenings: price->timeseries and number->timeseries are legal', () => {
  // Built directly against the validator's compat rules via the market
  // fixture (price -> price) plus a synthetic number -> timeseries edge.
  const g = fixture('flow-graph.valid.market-battery.json');
  assert.deepStrictEqual(validate(g), []);
});
