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

// LOW-6: a pin must be COMMITTED, never self-seeded. A run that writes the pin
// it then asserts against certifies determinism, not correctness - which is
// exactly how the H3-a / H3-c / MEDIUM-5 defects sailed through review.
function assertPinned(artifact, pinName) {
  const pinFile = path.join(__dirname, pinName);
  assert.ok(fs.existsSync(pinFile),
    'pin ' + pinName + ' fehlt - bewusst erzeugen (node -e "…content_hash") und einchecken');
  const pinned = fs.readFileSync(pinFile, 'utf8').trim();
  assert.strictEqual(artifact.content_hash, pinned,
    'compiler output drifted from the committed pin (' + pinName
    + ') - a deliberate change must update the pin');
}

// Every node type the compiler may EVER emit: vp-palette nodes + the two
// generated shapes. Anything else appearing in a bundle is a compiler bug
// (and would break the "no user code paths" isolation guarantee).
const WHITELISTED_NR_TYPES = new Set([
  'tab', 'vp-entity-read', 'vp-feed', 'vp-desired', 'vp-notify', 'vp-modbus-read',
  'vp-consumer-policy', 'function', 'inject',
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
  assertPinned(a, 'pinned-hash.txt');
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
  assertPinned(a, 'pinned-peakshaving-hash.txt');
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
  assertPinned(a, 'pinned-notify-hash.txt');
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
  const andNode = fns.find((n) => /P\.ports/.test(n.func) && /every/.test(n.func));
  assert.ok(andNode, 'the Und-Baustein compiles to the discriminated every() combiner body');
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
  assertPinned(a, 'pinned-compound-hash.txt');
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
  assertPinned(a, 'pinned-price-hash.txt');
});

// MB-M1: the generic Modbus read compiles to the DATA-ONLY vp-modbus-read
// palette node (no generated code - the whitelisted-codegen stance holds),
// carries the entity mapping into required_entities, and lifts the artifact's
// palette floor to 0.3.0 so old devices degrade honestly.
test('modbus-read fixture compiles to the data-only palette node', () => {
  const graph = fixture('flow-graph.valid.modbus-read.json');
  const a = compile(graph);
  for (const n of a.bundle.nodered_flows) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected node type ' + n.type);
  }
  const mb = a.bundle.nodered_flows.find((n) => n.type === 'vp-modbus-read');
  assert.ok(mb, 'the read node compiles to vp-modbus-read');
  assert.strictEqual(mb.host, '192.168.40.17');
  assert.strictEqual(mb.port, 502);
  assert.strictEqual(mb.unit_id, 1);
  assert.strictEqual(mb.register_kind, 'input');
  assert.strictEqual(mb.address, 100);
  assert.strictEqual(mb.data_type, 'float32');
  assert.strictEqual(mb.word_order, 'big');
  assert.strictEqual(mb.scale, 0.001);
  assert.strictEqual(mb.entity, 'modbus-meter-1');
  assert.strictEqual(mb.channel, 'leistung_kw');
  assert.strictEqual(mb.func, undefined, 'data-only config - never generated code');

  // The mapping contributes the measure requirement; the control its actuate.
  assert.deepStrictEqual(a.required_entities, [
    { entity_id: 'modbus-meter-1', capabilities: ['measure:leistung_kw'] },
    { entity_id: 'wallbox-1', capabilities: ['actuate:on_off'] },
  ]);

  // The palette floor lifts to 0.3.0 (deploy.go acks `unsupported` below it).
  assert.strictEqual(a.min_palette_version, '0.3.0');

  // Wiring: read -> threshold -> control.
  const threshold = a.bundle.nodered_flows.find((n) => n.type === 'function');
  const desired = a.bundle.nodered_flows.find((n) => n.type === 'vp-desired');
  assert.deepStrictEqual(mb.wires, [[threshold.id]]);
  assert.deepStrictEqual(threshold.wires, [[desired.id]]);
});

test('pinned content hash of the modbus-read fixture', () => {
  const a = compile(fixture('flow-graph.valid.modbus-read.json'));
  assertPinned(a, 'pinned-modbus-read-hash.txt');
});

test('modbus-read validator rules: host, mapping pairing, duplicate mapping', () => {
  const base = fixture('flow-graph.valid.modbus-read.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);

  assert.deepStrictEqual(validate(base), [], 'the committed fixture validates clean');
  assert.ok(findRule(mutate((g) => { delete g.nodes[0].parameters.host; }), 'V-4'), 'missing host');
  assert.ok(findRule(mutate((g) => { g.nodes[0].parameters.host = 'kein host!'; }), 'V-4'),
    'invalid host chars');
  assert.ok(findRule(mutate((g) => { g.nodes[0].parameters.host = '-bad.example'; }), 'V-4'),
    'label may not start with a hyphen');
  assert.ok(findRule(mutate((g) => { g.nodes[0].parameters.address = 70000; }), 'V-4'),
    'address out of range');
  assert.ok(findRule(mutate((g) => { g.nodes[0].parameters.data_type = 'double'; }), 'V-4'),
    'unknown data type');
  assert.ok(findRule(mutate((g) => { delete g.nodes[0].parameters.channel; }), 'V-4'),
    'entity without channel (both-or-neither)');
  assert.ok(findRule(mutate((g) => { delete g.nodes[0].parameters.entity_id; }), 'V-4'),
    'channel without entity (both-or-neither)');
  // Unmapped is legal: the read then just feeds the flow.
  assert.deepStrictEqual(validate(mutate((g) => {
    delete g.nodes[0].parameters.entity_id;
    delete g.nodes[0].parameters.channel;
  })), []);
  // Two reads onto the SAME (entity, channel) clash (V-5).
  assert.ok(findRule(mutate((g) => {
    const dup = JSON.parse(JSON.stringify(g.nodes[0]));
    dup.id = 'mb2';
    g.nodes.push(dup);
  }), 'V-5'), 'duplicate mapping refused');
  // A second read onto a DIFFERENT channel of the same entity is fine.
  assert.ok(!findRule(mutate((g) => {
    const second = JSON.parse(JSON.stringify(g.nodes[0]));
    second.id = 'mb2';
    second.parameters.channel = 'temp_c';
    g.nodes.push(second);
  }), 'V-5'), 'distinct channels coexist');
});

// H3-a (#519): the guided builder's "Sollwert setzen" action wires
// vp.logic.if.value -> vp.entity.control.setpoint. flowc's control node used to
// declare ONLY `value: number|bool`, so every setpoint rule validated in the
// editor, simulated, reached `simuliert` - and then died at activation with
// compiler_rejected (V-3 "hat keinen Eingang setpoint" + V-1 "Pflicht-Eingang
// value ist nicht verbunden"). The input set now mirrors the api catalog.
test('guided-setpoint fixture compiles the setpoint action', () => {
  const graph = fixture('flow-graph.valid.guided-setpoint.json');
  assert.deepStrictEqual(validate(graph), [], 'the guided setpoint rule validates clean');
  const a = compile(graph);
  for (const n of a.bundle.nodered_flows) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected node type ' + n.type);
  }
  const desired = a.bundle.nodered_flows.find((n) => n.type === 'vp-desired');
  assert.strictEqual(desired.entity, 'wallbox-1');
  assert.strictEqual(desired.command, 'setpoint_kw');
  // Wiring: read -> threshold -> if -> control (all edges collapse onto the
  // vp-desired anchor, whatever graph port they targeted).
  const fns = a.bundle.nodered_flows.filter((n) => n.type === 'function');
  const ifNode = fns.find((n) => /P\.then_value/.test(n.func));
  assert.ok(ifNode, 'the Wenn/Dann value node compiles');
  assert.deepStrictEqual(ifNode.wires, [[desired.id]]);
  assert.deepStrictEqual(a.required_entities, [
    { entity_id: 'grid-meter-1', capabilities: ['measure:power_kw'] },
    { entity_id: 'wallbox-1', capabilities: ['actuate:setpoint_kw'] },
  ]);
});

test('pinned content hash of the guided-setpoint fixture', () => {
  assertPinned(compile(fixture('flow-graph.valid.guided-setpoint.json')),
    'pinned-guided-setpoint-hash.txt');
});

// A control node with NO input at all is still refused - the any-of rule
// (requires_any_input) replaces the former hard-required `value`.
test('entity.control needs at least one connected input', () => {
  const g = fixture('flow-graph.valid.guided-setpoint.json');
  g.edges = g.edges.filter((e) => e.to.node !== 'steuern1');
  assert.ok(validate(g).some((f) => f.rule === 'V-1' && /mindestens einer der Eingänge/.test(f.message)),
    'a control node fed by nothing must be refused');
});

// MEDIUM-5 (#519): the AE7 starter templates (FlowTemplates.starterFlow) and
// the documented pilot chain wire strategy.wunsch -> control.plan. flowc had
// neither the `plan` port nor the D-13 plan-fed claim suppression, so an
// auto-started flow died at activation with V-3/V-1/V-5 findings.
test('market-starter fixture compiles the pilot strategy -> control chain', () => {
  const graph = fixture('flow-graph.valid.market-starter.json');
  assert.deepStrictEqual(validate(graph), [], 'the AE7 starter template validates clean');
  const a = compile(graph);
  for (const n of a.bundle.nodered_flows) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected node type ' + n.type);
  }
  // The strategy delegates (no-op body) and the control node still materializes
  // its vp-desired publisher - the plan payload flows through it.
  const strategy = a.bundle.nodered_flows.find((n) => n.type === 'function' && /DELEGIERT/.test(n.func));
  assert.ok(strategy, 'the strategy compiles to the delegation no-op');
  const desired = a.bundle.nodered_flows.find((n) => n.type === 'vp-desired');
  assert.strictEqual(desired.entity, 'batt-main');
  assert.deepStrictEqual(strategy.wires, [[desired.id]]);
  assert.deepStrictEqual(a.required_entities, [
    { entity_id: 'batt-main', capabilities: ['actuate:setpoint_kw', 'measure:soc_pct'] },
  ]);
});

test('a plan-fed control node derives NO own claim (D-13 suppression)', () => {
  const base = fixture('flow-graph.valid.market-starter.json');
  // Stamping the un-suppressed claim onto the control node must be REFUSED -
  // otherwise the chain would V-5-conflict with the strategy's delegated claim.
  const stamped = JSON.parse(JSON.stringify(base));
  stamped.nodes.find((n) => n.id === 'ctl1').claims = [
    { entity_id: 'batt-main', commands: ['setpoint_kw'] },
  ];
  const findings = validate(stamped);
  assert.ok(findings.some((f) => f.rule === 'V-5'),
    'a hand-stamped claim on the plan-fed control node must not validate');
  // The suppression is NARROW: a control node that is not plan-fed by a
  // delegated strategy still derives (and must declare) its own claim - the
  // guided-setpoint fixture is exactly that case and validates clean.
  assert.deepStrictEqual(validate(fixture('flow-graph.valid.guided-setpoint.json')), [],
    'a control node without a delegated feeder keeps its own claim');
});

test('pinned content hash of the market-starter fixture', () => {
  assertPinned(compile(fixture('flow-graph.valid.market-starter.json')),
    'pinned-market-starter-hash.txt');
});

// H3-b (#519): two vp.schedule.window branches carry NO msg.topic, so the old
// `msg.topic || "_"` key collapsed both into ONE slot and the AND was not
// degraded but WRONG - "06:00-08:00 UND 18:00-20:00" switched the device on
// during EITHER window. The compiled bundle now carries a per-edge tag node and
// the combinator keys on it. This test RUNS the emitted bodies.
test('two-window AND is FALSE unless both branches are true', () => {
  const a = compile(fixture('flow-graph.valid.two-window-and.json'));
  const fns = a.bundle.nodered_flows.filter((n) => n.type === 'function');
  const andNode = fns.find((n) => /P\.ports/.test(n.func) && /every/.test(n.func));
  assert.ok(andNode, 'the Und-Baustein compiles to the discriminated combiner body');
  const tags = fns.filter((n) => /_vp_src/.test(n.func) && !/P\.ports/.test(n.func));
  assert.strictEqual(tags.length, 2, 'one tag node per incoming combinator edge');
  assert.deepStrictEqual(tags.map((n) => n.name).sort(), ['Zweig a', 'Zweig b']);
  // Each window feeds its OWN tag node, each tag node feeds the combinator.
  const windows = fns.filter((n) => /getHours/.test(n.func));
  assert.strictEqual(windows.length, 2);
  for (const w of windows) {
    assert.strictEqual(w.wires[0].length, 1);
    assert.ok(tags.some((t) => t.id === w.wires[0][0]), 'window wires into a tag node');
  }
  for (const t of tags) assert.deepStrictEqual(t.wires, [[andNode.id]]);

  // Run the generated code: a shared context (one function node = one context)
  // fed via the two tag bodies, exactly as Node-RED would deliver it.
  const run = (node, msg) => {
    const store = node.__ctx || (node.__ctx = {});
    const context = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
    // eslint-disable-next-line no-new-func
    return new Function('msg', 'context', node.func + '\n')(msg, context);
  };
  const tagA = tags.find((n) => n.name === 'Zweig a');
  const tagB = tags.find((n) => n.name === 'Zweig b');
  const send = (tag, active) => run(andNode, run(tag, { payload: active }));

  assert.strictEqual(send(tagA, true).payload, false, 'only branch a known -> not yet true');
  assert.strictEqual(send(tagB, false).payload, false, 'a=true, b=false -> FALSE');
  assert.strictEqual(send(tagA, true).payload, false,
    'branch a re-emitting true must NOT flip the conjunction (the H3-b symptom)');
  assert.strictEqual(send(tagB, true).payload, true, 'both true -> true');
  assert.strictEqual(send(tagA, false).payload, false, 'a goes false -> FALSE again');
  // An untagged message cannot be attributed and is dropped, never guessed.
  assert.strictEqual(run(andNode, { payload: true }), null);
});

test('pinned content hash of the two-window-and fixture', () => {
  assertPinned(compile(fixture('flow-graph.valid.two-window-and.json')),
    'pinned-two-window-hash.txt');
});

test('vp.logic.or mirrors the discriminated semantics', () => {
  const g = fixture('flow-graph.valid.two-window-and.json');
  g.nodes.find((n) => n.id === 'und1').type = 'vp.logic.or';
  const a = compile(g);
  const orNode = a.bundle.nodered_flows.find(
    (n) => n.type === 'function' && /P\.ports/.test(n.func) && /some/.test(n.func));
  assert.ok(orNode, 'the Oder-Baustein compiles to the discriminated combiner body');
  const store = {};
  const context = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('msg', 'context', orNode.func + '\n');
  assert.strictEqual(fn({ payload: false, _vp_src: 'a' }, context).payload, false);
  assert.strictEqual(fn({ payload: true, _vp_src: 'b' }, context).payload, true);
  assert.strictEqual(fn({ payload: false, _vp_src: 'b' }, context).payload, false);
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

// MEDIUM-6 (#519): the #518 guard above compared type-id SETS only, which is
// exactly why H3-a and MEDIUM-5 sailed through - both were PORT drift inside a
// type both catalogs knew. `portDrift` is the shared rule, tested in BOTH
// directions below so the guard itself is proven to bite.
//
// `trigger` is flowc-synthetic (interval / slot-boundary injects wire into it);
// the api catalog never declares it, so it is excluded from the comparison.
function portDrift(apiType, flowcType) {
  const findings = [];
  const apiIn = (apiType.inputs || []).map((p) => p.name).sort();
  const flowcIn = Object.keys(flowcType.ports.in)
    .filter((p) => p !== 'trigger' || apiIn.indexOf('trigger') >= 0).sort();
  const apiOut = (apiType.outputs || []).map((p) => p.name).sort();
  const flowcOut = Object.keys(flowcType.ports.out).sort();
  if (JSON.stringify(apiIn) !== JSON.stringify(flowcIn)) {
    findings.push(apiType.type + ': Eingänge api=' + apiIn + ' vs flowc=' + flowcIn);
  }
  if (JSON.stringify(apiOut) !== JSON.stringify(flowcOut)) {
    findings.push(apiType.type + ': Ausgänge api=' + apiOut + ' vs flowc=' + flowcOut);
  }
  const apiAny = (apiType.requires_any_input || []).slice().sort();
  const flowcAny = (flowcType.requiresAnyInput || []).slice().sort();
  if (JSON.stringify(apiAny) !== JSON.stringify(flowcAny)) {
    findings.push(apiType.type + ': requires_any_input api=' + apiAny + ' vs flowc=' + flowcAny);
  }
  return findings;
}

test('flowc and the api flow-catalog declare the same PORTS per node type', () => {
  const api = JSON.parse(fs.readFileSync(API_CATALOG, 'utf8'));
  const drift = [];
  for (const apiType of api.types) {
    const flowcType = TYPES[apiType.type];
    if (!flowcType) continue; // the set guard above reports this
    drift.push(...portDrift(apiType, flowcType));
  }
  assert.deepStrictEqual(drift, [],
    'port drift makes an editor-accepted flow compiler_reject at activation: ' + drift.join('; '));
});

test('the port-drift guard bites on a missing input (its own bug class)', () => {
  // The pre-fix shape of vp.entity.control: the editor offered plan/setpoint/
  // value, flowc knew only `value`. The guard MUST report that.
  const apiShape = {
    type: 'vp.entity.control',
    inputs: [{ name: 'value' }, { name: 'setpoint' }, { name: 'plan' }],
    outputs: [],
    requires_any_input: ['value', 'setpoint', 'plan'],
  };
  const flowcShapeBefore = {
    ports: { in: { value: { type: 'number|bool', required: true } }, out: { result: { type: 'event' } } },
  };
  const drift = portDrift(apiShape, flowcShapeBefore);
  assert.strictEqual(drift.length, 3, 'inputs, outputs and the any-of rule all drift: ' + drift);
  // ...and stays silent on the shipped shape.
  assert.deepStrictEqual(portDrift(apiShape, TYPES['vp.entity.control']), []);
});

// The other half of the #519 class: a type that COMPILES but whose compiled
// implementation is not runnable on the device. vp.price.current compiled to a
// vp-feed with feed=price_current, which the palette's FEEDS whitelist did not
// know - topicFor() returned null, the node registered NO subscribe and NO
// input handler, and the automation was silently dead forever (H3-c).
test('every feed flowc can emit exists in the vp-palette FEEDS whitelist', () => {
  const { FEEDS } = require('../vp-palette/nodes/vp-feed');
  const emitted = new Set();
  for (const [typeId, type] of Object.entries(TYPES)) {
    const probe = { id: 'probe', type: typeId, parameters: {} };
    const ctx = { tabId: 't', coreId: 'c', flowId: 'f', flowVersion: 1, nrId: (i) => i };
    let compiled;
    try {
      compiled = type.compile(ctx, probe);
    } catch (e) {
      continue; // types whose compile needs real params are covered by fixtures
    }
    for (const n of compiled) {
      if (n.type === 'vp-feed') emitted.add(n.feed);
    }
  }
  assert.ok(emitted.size > 0, 'the probe must actually reach the feed types');
  for (const feed of emitted) {
    assert.ok(Object.prototype.hasOwnProperty.call(FEEDS, feed),
      'flowc emits vp-feed feed="' + feed + '" but the palette whitelist does not know it - '
      + 'the compiled flow would deploy and then do nothing, silently');
  }
});

test('type widenings: price->timeseries and number->timeseries are legal', () => {
  // Built directly against the validator's compat rules via the market
  // fixture (price -> price) plus a synthetic number -> timeseries edge.
  const g = fixture('flow-graph.valid.market-battery.json');
  assert.deepStrictEqual(validate(g), []);
});

// ---------------------------------------------------------------------------
// vp.logic.function - the sandboxed customer code node (D-16, Portal v3 M5)
// ---------------------------------------------------------------------------

test('function-node fixture compiles into the watchdog wrapper', () => {
  const graph = fixture('flow-graph.valid.function-node.json');
  const a = compile(graph);
  const fns = a.bundle.nodered_flows.filter((n) => n.type === 'function');
  const code = fns.find((n) => /vp_fn/.test(n.func));
  assert.ok(code, 'the code node compiles to a generated function node');

  // Guard 1 - the RUNTIME watchdog: Node-RED runs a function node with a
  // `timeout` (seconds) through vm, so even an endless loop is aborted.
  assert.strictEqual(code.timeout, 0.1, 'the 100 ms limit reaches the node as 0.1 s');
  // ...plus the in-body deadline detector + honest failure states.
  assert.match(code.func, /Date\.now\(\) - t0 > P\.timeout_ms/);
  assert.match(code.func, /node\.status\(\{ fill: "red"/);
  assert.match(code.func, /node\.error\("Funktion \(Code\)/);

  // Guard 2 - NO network / no sandbox handles: every escape name is a shadowed
  // parameter of the compiled function, and only wert + msg are ever passed.
  for (const shadowed of ['net', 'http', 'https', 'require', 'global',
    'globalThis', 'process', 'flow', 'context', 'env', 'RED', 'node']) {
    assert.match(code.func, new RegExp('"' + shadowed + '"'),
      shadowed + ' must be shadowed inside the customer scope');
  }
  assert.match(code.func, /fn\(Number\(msg\.payload\), msg\)/);

  // The customer source is DATA (the P literal), never concatenated into this
  // control flow - so it cannot close the wrapper and continue outside it.
  assert.match(code.func, /^\/\/ generiert von flowc/);
  assert.ok(code.func.includes(JSON.stringify(graph.nodes[1].parameters.code)),
    'the code travels as a JSON string literal');

  // It is a plain Node-RED function node, so the palette floor does not move.
  assert.strictEqual(a.min_palette_version, '0.2.0');
  // A code node claims nothing by itself; the control node still does.
  assert.deepStrictEqual(a.required_entities, [
    { entity_id: 'grid-meter-1', capabilities: ['measure:power_kw'] },
    { entity_id: 'wallbox-1', capabilities: ['actuate:setpoint_kw'] },
  ]);
  // ...and the effect still leaves through vp-desired (guard chain downstream).
  const desired = a.bundle.nodered_flows.find((n) => n.type === 'vp-desired');
  assert.strictEqual(desired.entity, 'wallbox-1');
  assert.deepStrictEqual(code.wires, [[desired.id]]);
});

test('the compiled customer code really runs sandboxed', () => {
  const a = compile(fixture('flow-graph.valid.function-node.json'));
  const code = a.bundle.nodered_flows.find((n) => n.type === 'function' && /vp_fn/.test(n.func));
  const store = {};
  const context = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const errors = [];
  const node = { status: () => {}, error: (m) => errors.push(m) };
  // eslint-disable-next-line no-new-func
  const run = (msg) => new Function('msg', 'context', 'node', code.func + '\n')(msg, context, node);

  assert.strictEqual(run({ payload: -5 }).payload, 5, '5 kW Einspeisung -> 5 kW laden');
  assert.strictEqual(run({ payload: -0.5 }).payload, 0, 'below the minimum -> 0');
  assert.strictEqual(run({ payload: -30 }).payload, 11, 'clamped by the customer code itself');
  assert.strictEqual(errors.length, 0);

  // The shadowed handles are undefined INSIDE the customer scope: swap the
  // fixture's code for a probe and run the SAME generated wrapper.
  const escapeStore = {};
  const escapeCtx = { get: (k) => escapeStore[k], set: (k, v) => { escapeStore[k] = v; } };
  const escapeFunc = code.func.replace(
    /const P = .*;\n/,
    'const P = ' + JSON.stringify({ code: 'return typeof http === "undefined" && typeof require === "undefined" ? 1 : 0;', timeout_ms: 100 }) + ';\n');
  // eslint-disable-next-line no-new-func
  const out = new Function('msg', 'context', 'node', escapeFunc + '\n')(
    { payload: 0 }, escapeCtx, node);
  assert.strictEqual(out.payload, 1, 'network handles are not reachable from customer code');
});

test('the code node is refused in the cloud runtime and on bad params', () => {
  const graph = fixture('flow-graph.valid.function-node.json');
  const cloud = JSON.parse(JSON.stringify(graph));
  cloud.runtime = 'cloud';
  assert.ok(validate(cloud).some((f) => f.rule === 'V-8'),
    'customer code must never be offered a cloud runtime');

  const noCode = JSON.parse(JSON.stringify(graph));
  noCode.nodes[1].parameters.code = '   ';
  assert.ok(validate(noCode).some((f) => /code fehlt/.test(f.message)));

  const tooLong = JSON.parse(JSON.stringify(graph));
  tooLong.nodes[1].parameters.code = 'x'.repeat(4001);
  assert.ok(validate(tooLong).some((f) => /4000/.test(f.message)));

  const slow = JSON.parse(JSON.stringify(graph));
  slow.nodes[1].parameters.timeout_ms = 5000;
  assert.ok(validate(slow).some((f) => /timeout_ms/.test(f.message)),
    'the watchdog window is capped at 500 ms');
});

test('pinned content hash of the function-node fixture', () => {
  assertPinned(compile(fixture('flow-graph.valid.function-node.json')),
    'pinned-function-hash.txt');
});

// --- vp.consumer.reactive (D-19, Verbrauchssteuerung Inkrement 4) -----------

test('the generated consumer-reactive fixture compiles to ONE vp-consumer-policy node', () => {
  const graph = fixture('flow-graph.valid.consumer-reactive.json');
  const a1 = compile(graph);
  const a2 = compile(graph);
  assert.strictEqual(JSON.stringify(a1), JSON.stringify(a2), 'compilation must be deterministic');
  assert.strictEqual(a1.content_hash, contentHash(a1.bundle));
  assert.strictEqual(a1.min_palette_version, '0.5.0', 'the reactive runtime node ships with palette 0.5.0');

  const nodes = a1.bundle.nodered_flows;
  for (const n of nodes) {
    assert.ok(WHITELISTED_NR_TYPES.has(n.type), 'unexpected NR type ' + n.type);
  }
  const policy = nodes.find((n) => n.type === 'vp-consumer-policy');
  assert.ok(policy, 'the reactive spec lands in one vp-consumer-policy node');
  assert.strictEqual(policy.entity, 'wallbox-1');
  assert.strictEqual(policy.command, 'setpoint_kw');
  assert.strictEqual(policy.ttl_s, 45);
  assert.strictEqual(policy.renew_s, 15);
  assert.strictEqual(policy.off_delay_s, 15);
  assert.strictEqual(policy.requirements.length, 2, 'the spec travels VERBATIM');
  assert.deepStrictEqual(a1.required_entities,
    [{ entity_id: 'wallbox-1', capabilities: ['actuate:setpoint_kw'] }]);

  // The interval trigger (the TTL renewal cadence) wires into the node.
  const inject = nodes.find((n) => n.type === 'inject');
  assert.ok(inject, 'the renew cadence compiles to an interval inject');
  assert.deepStrictEqual(inject.wires, [[policy.id]]);
});

test('pinned content hash of the consumer-reactive fixture', () => {
  assertPinned(compile(fixture('flow-graph.valid.consumer-reactive.json')),
    'pinned-consumer-reactive-hash.txt');
});

test('vp.consumer.reactive is refused without the server-stamped origin (D-19)', () => {
  const graph = fixture('flow-graph.invalid.reactive-without-origin.json');
  assert.ok(validate(graph).some((f) => f.rule === 'V-4' && /origin fehlt/.test(f.message)),
    'the generated-only type never validates in a customer document');

  // A forged origin of the WRONG kind does not unlock it either.
  const wrongKind = JSON.parse(JSON.stringify(graph));
  wrongKind.origin = { kind: 'something-else' };
  assert.ok(validate(wrongKind).some((f) => /origin fehlt/.test(f.message)));

  // The valid fixture (with origin) passes.
  assert.deepStrictEqual(validate(fixture('flow-graph.valid.consumer-reactive.json')), []);
});

test('override on vp.entity.control is reserved for the generated artifact (D-19)', () => {
  const graph = fixture('flow-graph.valid.price-wallbox.json');
  const smuggled = JSON.parse(JSON.stringify(graph));
  smuggled.nodes[2].parameters.override = true;
  assert.ok(validate(smuggled).some((f) => /override ist der generierten/.test(f.message)),
    'a customer flow can never claim the D-5 override through the catalog node');

  // Even override:false is refused - the field is reserved, not just the value.
  const sneaky = JSON.parse(JSON.stringify(graph));
  sneaky.nodes[2].parameters.override = false;
  assert.ok(validate(sneaky).some((f) => /override ist der generierten/.test(f.message)));
});

test('the reactive spec validation refuses the honest error classes', () => {
  const base = () => fixture('flow-graph.valid.consumer-reactive.json');
  const withParams = (mutate) => {
    const g = base();
    mutate(g.nodes[0].parameters);
    return g;
  };

  // A renewal cadence slower than half the TTL tears the renewal chain.
  assert.ok(validate(withParams((p) => { p.renew_s = 40; }))
    .some((f) => /Erneuerungskette/.test(f.message)));

  // A local signal without a freshness window can never honestly start.
  assert.ok(validate(withParams((p) => {
    delete p.requirements[0].condition.max_age_s;
  })).some((f) => /max_age_s/.test(f.message)));

  // Windows must be chronological [from, to] pairs.
  assert.ok(validate(withParams((p) => {
    p.requirements[1].condition.any[0].windows = [
      ['2026-08-11T10:00:00Z', '2026-08-11T12:00:00Z'],
      ['2026-08-10T10:00:00Z', '2026-08-10T12:00:00Z'],
    ];
  })).some((f) => /chronologisch/.test(f.message)));

  // The target value must fit the command.
  assert.ok(validate(withParams((p) => { p.requirements[0].value = true; }))
    .some((f) => /value passt nicht/.test(f.message)));

  // Depth cap: a tower of NOTs past MAX_TREE_DEPTH is refused.
  assert.ok(validate(withParams((p) => {
    p.requirements[0].condition = { not: { not: { not: { not: { not: {
      signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
      op: 'gt', value: 80, max_age_s: 60,
    } } } } } };
  })).some((f) => /zu tief/.test(f.message)));
});
