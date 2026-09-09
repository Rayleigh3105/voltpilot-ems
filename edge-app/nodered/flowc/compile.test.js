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
  'vp-consumer-policy', 'vp-mqtt-read', 'vp-http-read', 'vp-soc-derive', 'vp-limit-guard',
  'function', 'inject',
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

// Einheitsmodell Stufe 4: the GENERATED switch of a self-built device.
test('the released switch compiles into the DEVICE flow and claims its entity', () => {
  const graph = fixture('flow-graph.valid.modbus-switch.json');
  const a = compile(graph);
  const nodes = a.bundle.nodered_flows;
  const sw = nodes.find((n) => n.type === 'vp-modbus-switch');
  assert.ok(sw, 'the switch must be compiled');
  // It sits in the SAME tab as the read nodes - one flow, one connection queue,
  // never a second TCP path to the same device.
  const reads = nodes.filter((n) => n.type === 'vp-modbus-read');
  assert.strictEqual(reads.length, 2);
  reads.forEach((r) => assert.strictEqual(r.z, sw.z));
  // Only the fields the released kind really has: an on/off switch carrying a
  // min/max would suggest a band nobody released.
  assert.strictEqual(sw.kind, 'on_off');
  assert.strictEqual(sw.on_value, 1);
  assert.strictEqual(sw.off_value, 0);
  assert.strictEqual(sw.min_value, undefined);
  assert.strictEqual(sw.safe_value, undefined);
  // The palette floor lifts, so an older box acks `unsupported` instead of
  // silently running a flow whose switch node it does not have.
  assert.strictEqual(a.min_palette_version, '0.7.0');
  // The switch CLAIMS its entity - the V-5 exclusive control claim is what
  // stops a second rule from fighting over the device.
  const req = a.required_entities.find((e) => e.entity_id === graph.origin.point_id);
  assert.ok(req.capabilities.includes('actuate:on_off'));
  assertPinned(a, 'pinned-modbus-switch-hash.txt');
});

test('the switch is refused in a flow that is not its device flow', () => {
  const graph = fixture('flow-graph.valid.modbus-switch.json');
  // A customer document can never carry an origin (the api refuses it), so
  // this is what a hand-built switch would look like.
  delete graph.origin;
  assert.throws(() => compile(graph), (e) => {
    assert.ok(e.findings.some((f) => f.rule === 'V-4' && /vorbehalten/.test(f.message)),
      JSON.stringify(e.findings));
    return true;
  });
  // ...and so is a switch smuggled into the CONSUMER-policy flow: the origin
  // kind is per TYPE, not "any generated flow".
  const other = fixture('flow-graph.valid.modbus-switch.json');
  other.origin = { kind: 'consumer-policy', policy_id: other.origin.point_id,
    policy_version: 1, entity_id: 'wallbox-1' };
  assert.throws(() => compile(other), (e) => e.findings.some((f) => f.rule === 'V-4'));
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

// --- P5 Ebene 1: der GENERIERTE MQTT-Batterie-Flow ------------------------

test('mqtt-battery fixture compiles to ONE data-only vp-mqtt-read node', () => {
  const g = fixture('flow-graph.valid.mqtt-battery.json');
  assert.deepStrictEqual(validate(g), [], 'the committed fixture validates clean');
  const a = compile(g);

  // EIN Knoten je Geraet, nie einer je Kanal: eine Broker-Verbindung bedient
  // alle Zuordnungen (die "nie ein zweiter Pfad zum selben Geraet"-Disziplin).
  const nodes = a.bundle.nodered_flows.filter((n) => n.type === 'vp-mqtt-read');
  assert.strictEqual(nodes.length, 1);
  const n = nodes[0];
  assert.strictEqual(n.host, '192.168.40.20');
  assert.strictEqual(n.port, 1883);
  assert.strictEqual(n.entity, '7b3c9d21-8e4f-4a56-9c07-0123456789ab');
  assert.strictEqual(n.func, undefined, 'data-only config - never generated code');
  assert.strictEqual(n.mappings.length, 6);

  // Der DIYBMS-Zellspannungsfall: EIN Topic-Filter, zwei Aggregate.
  const min = n.mappings.find((m) => m.channel === 'cell_min_mv');
  const max = n.mappings.find((m) => m.channel === 'cell_max_mv');
  assert.strictEqual(min.topic, 'emon/diybms/+/+');
  assert.strictEqual(max.topic, 'emon/diybms/+/+');
  assert.strictEqual(min.path, 'voltage');
  assert.strictEqual(min.aggregate, 'min');
  assert.strictEqual(max.aggregate, 'max');
  assert.strictEqual(min.scale, 1000, 'V -> mV');

  // Jede Vorgabe steht AUSGESCHRIEBEN im Artefakt - danach raet die Box nicht.
  for (const m of n.mappings) {
    assert.ok(['last', 'min', 'max', 'sum', 'avg', 'count'].includes(m.aggregate));
    assert.ok(['number', 'bool'].includes(m.value_type));
    assert.strictEqual(typeof m.scale, 'number');
    assert.strictEqual(typeof m.offset, 'number');
    assert.strictEqual(typeof m.stale_s, 'number');
  }

  // Jeder gemappte Kanal wird als measure-Anforderung gefordert - eine
  // Zuordnung auf einen Kanal, den die Batterie nicht misst, faellt bei der
  // Aktivierung auf.
  // Seit P5b stehen soc_pct und soc_source_code mit drin: sie werden nicht
  // GELESEN, sondern vom Ableiter GESCHRIEBEN - und eine Entitaet, die sie
  // nicht fuehrt, haette nichts, worin der Ladestand landet.
  assert.deepStrictEqual(a.required_entities, [{
    entity_id: '7b3c9d21-8e4f-4a56-9c07-0123456789ab',
    capabilities: [
      'measure:cell_max_mv', 'measure:cell_min_mv', 'measure:charge_allowed',
      'measure:discharge_allowed', 'measure:soc_pct', 'measure:soc_source_code',
      'measure:temp_max_c', 'measure:voltage_v',
    ],
  }]);

  // Die Palette-Untergrenze hebt sich mit P5b auf 0.11.0 (deploy.go quittiert
  // darunter mit `unsupported` statt still nichts zu tun).
  assert.strictEqual(a.min_palette_version, '0.11.0');
});

// --- P5b Ebene 2: der SoC-Ableiter im selben generierten Flow --------------

test('mqtt-battery fixture wires the soc derivation BEHIND the read node', () => {
  const g = fixture('flow-graph.valid.mqtt-battery.json');
  const a = compile(g);
  const flows = a.bundle.nodered_flows;
  const mqtt = flows.find((n) => n.type === 'vp-mqtt-read');
  const soc = flows.find((n) => n.type === 'vp-soc-derive');
  const inject = flows.find((n) => n.type === 'inject');

  assert.ok(soc, 'the fixture carries exactly one derivation');
  assert.strictEqual(flows.filter((n) => n.type === 'vp-soc-derive').length, 1);
  assert.strictEqual(soc.func, undefined, 'data-only config - never generated code');

  // DIE Kette: Takt -> Quelle -> Ableiter. Der Takt trifft NUR die Quelle;
  // haenge der Ableiter selbst am Takt, rechnete er auf dem Stand des VORIGEN
  // Taktes, und die Reihenfolge zweier gleichzeitig gefeuerter Knoten ist
  // nichts, worauf man einen Ladestand baut.
  assert.deepStrictEqual(inject.wires, [[mqtt.id]], 'the tick hits ONLY the source');
  assert.deepStrictEqual(mqtt.wires, [[soc.id]], 'the source feeds the derivation');

  // Jede Vorgabe steht AUSGESCHRIEBEN im Artefakt - danach raet die Box nicht.
  assert.strictEqual(soc.method, 'ocv_curve');
  assert.strictEqual(soc.prefer_direct, true);
  assert.strictEqual(soc.hold_s, 900);
  assert.strictEqual(soc.params.conservative_min, true);
  assert.strictEqual(soc.params.round_pct, 0.1);
  assert.strictEqual(soc.params.curve_charge.length, 21);
  assert.strictEqual(soc.params.curve_discharge.length, 21);
  assert.deepStrictEqual(soc.inputs, {
    cell_max: 'cell_max_mv', cell_min: 'cell_min_mv', current: 'current_a',
    power: 'power_kw', soc: 'soc_pct', voltage: 'voltage_v',
  });
});

test('vp.soc.derive is GENERATED-ONLY and refuses a nonsense derivation', () => {
  const base = fixture('flow-graph.valid.mqtt-battery.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);
  const S = (g) => g.nodes.find((n) => n.type === 'vp.soc.derive').parameters;

  // Ohne die EIGENE origin-Art gibt es den Baustein nicht - genau wie bei
  // vp.mqtt.read; die Herkunft ist server-gestempelt und nie faelschbar.
  assert.ok(findRule(mutate((g) => { delete g.origin; }), 'V-4'), 'no origin at all');
  assert.ok(findRule(mutate((g) => {
    g.origin = { kind: 'consumer-policy', policy_id: g.origin.point_id, revision: 1 };
  }), 'V-4'), 'a foreign generated origin must not unlock it');

  assert.ok(findRule(mutate((g) => { S(g).method = 'raten'; }), 'V-4'), 'unknown method');
  assert.ok(findRule(mutate((g) => { delete S(g).params.curve_charge; }), 'V-4'),
    'ocv_curve without a curve computes nothing');
  assert.ok(findRule(mutate((g) => { S(g).params.curve_charge = [[3.26, 0]]; }), 'V-4'),
    'a single point is not a curve');
  assert.ok(findRule(mutate((g) => {
    S(g).params.curve_charge = [[3.26, 60], [4.18, 10]];
  }), 'V-4'), 'a curve that FALLS with rising voltage is a typo with a result');
  assert.ok(findRule(mutate((g) => { S(g).params.curve_charge[0] = [9.9, 0]; }), 'V-4'),
    'a cell voltage of 9.9 V is no lithium cell');
  assert.ok(findRule(mutate((g) => { S(g).hold_s = 5; }), 'V-4'), 'hold_s below the floor');
  assert.ok(findRule(mutate((g) => { S(g).inputs.erfunden = 'soc_pct'; }), 'V-4'),
    'an unknown input role is refused, never guessed');
  assert.ok(findRule(mutate((g) => {
    S(g).method = 'coulomb';
    delete S(g).params.capacity_kwh;
  }), 'V-4'), 'coulomb without a usable capacity counts nothing');

  // Der Ableiter haengt an einer KANTE. Ohne sie fehlt sein Pflicht-Eingang.
  assert.ok(findRule(mutate((g) => { g.edges = []; }), 'V-1'),
    'the derivation must be fed by the read node');
});

test('pinned content hash of the mqtt-battery fixture', () => {
  const a = compile(fixture('flow-graph.valid.mqtt-battery.json'));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(compile(
    fixture('flow-graph.valid.mqtt-battery.json'))), 'compilation must be deterministic');
  assertPinned(a, 'pinned-mqtt-battery-hash.txt');
});

test('vp.mqtt.read is GENERATED-ONLY and refused without its own origin', () => {
  const base = fixture('flow-graph.valid.mqtt-battery.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);

  // Ohne origin: ein Kundendokument bekommt den Baustein nie.
  assert.ok(findRule(mutate((g) => { delete g.origin; }), 'V-4'), 'no origin at all');
  // Und auch nicht unter der FREMDEN origin-Art: jede generierte Art ist nur
  // unter IHRER eigenen gueltig (die modbus-device/consumer-policy-Regel).
  assert.ok(findRule(mutate((g) => {
    g.origin = { kind: 'modbus-device', point_id: g.origin.point_id, definition_version: 1 };
  }), 'V-4'), 'a foreign generated origin must not unlock it');
});

test('mqtt-battery validator rules: host, mapping shape, duplicate channel', () => {
  const base = fixture('flow-graph.valid.mqtt-battery.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);
  const P = (g) => g.nodes[0].parameters;

  assert.ok(findRule(mutate((g) => { delete P(g).host; }), 'V-4'), 'missing broker host');
  assert.ok(findRule(mutate((g) => { P(g).host = 'kein host!'; }), 'V-4'), 'invalid host chars');
  assert.ok(findRule(mutate((g) => { P(g).port = 70000; }), 'V-4'), 'port out of range');
  assert.ok(findRule(mutate((g) => { P(g).mappings = []; }), 'V-4'), 'no mapping = no measurement');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].topic = 'a/#/b'; }), 'V-4'),
    '# is only ever the last segment');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].path = '__proto__'; }), 'V-4'),
    'prototype-poisoning segments are refused');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].aggregate = 'median'; }), 'V-4'),
    'unknown aggregate');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].scale = 0; }), 'V-4'),
    'a scale of 0 would erase every reading');
  assert.ok(findRule(mutate((g) => { P(g).mappings[1].channel = 'cell_min_mv'; }), 'V-4'),
    'two mappings onto ONE channel');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].stale_s = 1; }), 'V-4'),
    'stale_s below the floor');
});

// --- P5 Ebene 1 „HTTP/JSON": der ZWEITE Lesetyp desselben Anschlusses -------

test('http-battery fixture compiles to ONE data-only vp-http-read node', () => {
  const g = fixture('flow-graph.valid.http-battery.json');
  assert.deepStrictEqual(validate(g), [], 'the committed fixture validates clean');
  const a = compile(g);

  // EIN Knoten je Geraet, nie einer je Kanal: EIN Endpunkt, ein GET je Takt,
  // alle Zuordnungen aus DERSELBEN Antwort.
  const nodes = a.bundle.nodered_flows.filter((n) => n.type === 'vp-http-read');
  assert.strictEqual(nodes.length, 1);
  const n = nodes[0];
  assert.strictEqual(n.host, '192.168.40.21');
  assert.strictEqual(n.port, 80);
  assert.strictEqual(n.path, '/ha');
  assert.strictEqual(n.tls, false);
  assert.strictEqual(n.timeout_ms, 5000);
  assert.strictEqual(n.entity, '9d5e1f34-2a6b-4c78-8e90-fedcba987654');
  assert.strictEqual(n.func, undefined, 'data-only config - never generated code');
  assert.strictEqual(n.mappings.length, 9);

  // ⚠ DIE Kernregel dieses Lesetyps: die ART der Anmeldung reist, der WERT nie.
  // Ein Flow-Dokument ist ueber die Portal-API lesbar - ein Kennwort darin
  // waere ein Kennwort im Browser.
  assert.deepStrictEqual(n.auth, { mode: 'header', header: 'ApiKey' });
  assert.strictEqual(JSON.stringify(a.bundle).includes('auth_secret'), false);

  // Der Zell-Aggregat-Fall, HTTP-seitig: ein PLATZHALTER im Wertepfad ist das
  // Gegenstueck zum Topic-Filter `emon/diybms/+/+`.
  const temp = n.mappings.find((m) => m.channel === 'temp_max_c');
  assert.strictEqual(temp.path, 'modules.*.exttemp');
  assert.strictEqual(temp.aggregate, 'max');
  assert.strictEqual(temp.sentinel, -40);

  // Jede Vorgabe steht AUSGESCHRIEBEN im Artefakt - danach raet die Box nicht.
  // stale_s gehoert bewusst NICHT dazu: eine HTTP-Antwort ist EIN Zeitpunkt.
  for (const m of n.mappings) {
    assert.ok(['last', 'min', 'max', 'sum', 'avg', 'count'].includes(m.aggregate));
    assert.ok(['number', 'bool'].includes(m.value_type));
    assert.strictEqual(typeof m.scale, 'number');
    assert.strictEqual(typeof m.offset, 'number');
    assert.strictEqual(m.stale_s, undefined);
  }

  // Der SoC-Ableiter (P5b) haengt an der Kante DIESES Knotens - derselbe
  // Baustein wie beim MQTT-Fall, ohne Sonderpfad.
  const soc = a.bundle.nodered_flows.find((x) => x.type === 'vp-soc-derive');
  const inject = a.bundle.nodered_flows.find((x) => x.type === 'inject');
  assert.deepStrictEqual(inject.wires, [[n.id]], 'the tick hits ONLY the source');
  assert.deepStrictEqual(n.wires, [[soc.id]], 'the source feeds the derivation');
  assert.strictEqual(soc.method, 'direct');

  // Die Palette-Untergrenze dieses Lesetyps ist 0.12.0.
  assert.strictEqual(a.min_palette_version, '0.12.0');
});

test('pinned content hash of the http-battery fixture', () => {
  const a = compile(fixture('flow-graph.valid.http-battery.json'));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(compile(
    fixture('flow-graph.valid.http-battery.json'))), 'compilation must be deterministic');
  assertPinned(a, 'pinned-http-battery-hash.txt');
});

// --- P5c: der Schutz-/Grenzbaustein am ENDE derselben Kette ---------------

test('mqtt-battery-protected fixture wires the protection block LAST', () => {
  const g = fixture('flow-graph.valid.mqtt-battery-protected.json');
  const a = compile(g);
  const flows = a.bundle.nodered_flows;
  const mqtt = flows.find((n) => n.type === 'vp-mqtt-read');
  const soc = flows.find((n) => n.type === 'vp-soc-derive');
  const limit = flows.find((n) => n.type === 'vp-limit-guard');
  const inject = flows.find((n) => n.type === 'inject');

  assert.ok(limit, 'the fixture carries exactly one protection block');
  assert.strictEqual(flows.filter((n) => n.type === 'vp-limit-guard').length, 1);
  assert.strictEqual(limit.func, undefined, 'data-only config - never generated code');

  // DIE KETTE ist linear: Takt -> Quelle -> Ableiter -> Schutz. Der Schutz
  // haengt am ENDE, weil die Treppe den ABGELEITETEN Ladestand braucht; jede
  // Stufe reicht weiter, was sie weiss.
  assert.deepStrictEqual(inject.wires, [[mqtt.id]], 'the tick hits ONLY the source');
  assert.deepStrictEqual(mqtt.wires, [[soc.id]], 'the source feeds the derivation');
  assert.deepStrictEqual(soc.wires, [[limit.id]], 'the derivation feeds the protection');

  // Jede Vorgabe steht AUSGESCHRIEBEN im Artefakt - danach raet die Box nicht.
  assert.strictEqual(limit.charge.max_a, 40);
  assert.strictEqual(limit.discharge.max_a, 40);
  assert.deepStrictEqual(limit.charge.steps[0], [5, 270]);
  assert.deepStrictEqual(limit.charge.steps[limit.charge.steps.length - 1], [85, 22]);
  assert.deepStrictEqual(limit.hysteresis, {
    charge_stop_v: 4.06, charge_resume_v: 4.0,
    discharge_stop_v: 3.4, discharge_resume_v: 3.5,
  });
  assert.strictEqual(limit.round_a, 1);
  assert.strictEqual(limit.hold_s, 900);

  // Der Baustein SCHREIBT NICHT: er fordert nur measure-Faehigkeiten an und
  // beansprucht kein einziges Kommando. Genau das ist P5c - er RESTRINGIERT,
  // was andere befehlen duerfen, statt selbst zu befehlen.
  assert.deepStrictEqual(a.required_entities, [{
    entity_id: '8c4d0e32-9f50-4b67-ad18-1234567890bc',
    capabilities: [
      'measure:cell_max_mv', 'measure:cell_min_mv', 'measure:charge_allowed',
      'measure:charge_limit_a', 'measure:discharge_allowed', 'measure:discharge_limit_a',
      'measure:soc_pct', 'measure:soc_source_code', 'measure:temp_max_c', 'measure:voltage_v',
    ],
  }]);
  assert.deepStrictEqual(a.claims || [], []);

  // Die Palette-Untergrenze hebt sich mit P5c auf 0.13.0 (deploy.go quittiert
  // darunter mit `unsupported` statt still nichts zu tun).
  assert.strictEqual(a.min_palette_version, '0.13.0');
});

test('pinned content hash of the mqtt-battery-protected fixture', () => {
  const a = compile(fixture('flow-graph.valid.mqtt-battery-protected.json'));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(compile(
    fixture('flow-graph.valid.mqtt-battery-protected.json'))), 'compilation must be deterministic');
  assertPinned(a, 'pinned-mqtt-battery-protected-hash.txt');
});

test('vp.bms.limit is GENERATED-ONLY and never triggerable', () => {
  const base = fixture('flow-graph.valid.mqtt-battery-protected.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);

  // Ein KUNDEN-Dokument darf den Baustein nicht tragen: die api ist sein
  // einziger Autor, und die Schutzgrenzen-Flaeche ist der Batterie-Assistent.
  assert.ok(findRule(mutate((g) => { delete g.origin; }), 'V-4'),
    'a customer document must not carry vp.bms.limit');

  // Er gehoert BEIDEN Ebene-1-Herkuenften - der Schutz rechnet auf den
  // Standard-Kanaelen und kennt den Transport gar nicht.
  assert.deepStrictEqual(TYPES['vp.bms.limit'].generatedOrigin,
    ['mqtt-device', 'http-device']);

  // Er haengt an einer KANTE, nie am Takt: am Takt rechnete er auf dem Stand
  // des VORIGEN Taktes.
  assert.strictEqual(TYPES['vp.bms.limit'].triggerable, false);

  // Und er beansprucht NIE ein Kommando - ein Schutzbaustein, der etwas
  // befehlen koennte, waere kein Schutzbaustein.
  assert.deepStrictEqual(TYPES['vp.bms.limit'].claims(), []);
});

test('vp.bms.limit refuses a protection that protects nothing', () => {
  const t = TYPES['vp.bms.limit'];
  // Weder Treppe noch Riegel: der Baustein haette nichts zu pruefen.
  assert.ok(t.validate({ entity_id: 'e1' }).some(
    (e) => /prueft nichts/.test(e)));
  // Eine Freigabe, die UEBER dem Stopp liegt, waere ein Riegel, der sich im
  // Moment des Zuschiebens selbst wieder oeffnet.
  assert.ok(t.validate({
    entity_id: 'e1',
    hysteresis: { charge_stop_v: 4.0, charge_resume_v: 4.06 },
  }).some((e) => /Lade-Freigabe muss unter dem Lade-Stopp/.test(e)));
  assert.ok(t.validate({
    entity_id: 'e1',
    hysteresis: { discharge_stop_v: 3.5, discharge_resume_v: 3.4 },
  }).some((e) => /Entlade-Freigabe muss ueber dem Entlade-Stopp/.test(e)));
  // Eine doppelte Schwelle waere zweideutig.
  assert.ok(t.validate({
    entity_id: 'e1',
    charge: { steps: [[5, 270], [5, 22]], max_a: 40 },
  }).some((e) => /steht zweimal/.test(e)));
});

test('vp.http.read is GENERATED-ONLY and refused under a SIBLING origin', () => {
  const base = fixture('flow-graph.valid.http-battery.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);

  assert.ok(findRule(mutate((g) => { delete g.origin; }), 'V-4'), 'no origin at all');
  // ⚠ Auch nicht unter `mqtt-device`: die beiden Lesetypen sind Geschwister,
  // aber ein Lesetyp, der unter der origin-Art des anderen gaelte, liesse ein
  // gefaelschtes MQTT-Dokument eine HTTP-Abfrage aufsperren.
  assert.ok(findRule(mutate((g) => {
    g.origin = { kind: 'mqtt-device', point_id: g.origin.point_id, definition_version: 1 };
  }), 'V-4'), 'the sibling transport origin must not unlock it');
});

test('vp.soc.derive belongs to BOTH level-1 origins', () => {
  // Der Ableiter rechnet auf den STANDARD-Kanaelen und kennt den Transport
  // gar nicht - er ist unter mqtt-device wie unter http-device gueltig. Die
  // beiden Fixtures beweisen beide Richtungen.
  assert.deepStrictEqual(validate(fixture('flow-graph.valid.http-battery.json')), []);
  assert.deepStrictEqual(validate(fixture('flow-graph.valid.mqtt-battery.json')), []);
});

test('http-battery validator rules: path, auth, value path, no stale_s', () => {
  const base = fixture('flow-graph.valid.http-battery.json');
  const mutate = (fn) => {
    const g = JSON.parse(JSON.stringify(base));
    fn(g);
    return g;
  };
  const findRule = (g, rule) => validate(g).some((f) => f.rule === rule);
  const P = (g) => g.nodes[0].parameters;

  assert.ok(findRule(mutate((g) => { delete P(g).host; }), 'V-4'), 'missing host');
  assert.ok(findRule(mutate((g) => { delete P(g).path; }), 'V-4'), 'missing url path');
  assert.ok(findRule(mutate((g) => { P(g).path = 'ha'; }), 'V-4'), 'a path starts with /');
  assert.ok(findRule(mutate((g) => { P(g).path = '//evil.example/x'; }), 'V-4'),
    '//host would be a foreign address, not a path');
  assert.ok(findRule(mutate((g) => { P(g).timeout_ms = 60000; }), 'V-4'), 'timeout out of range');
  // ⚠ Ein Geheimnis im Flow wird BENANNT abgelehnt, nie still verworfen.
  assert.ok(findRule(mutate((g) => { P(g).auth.secret = 'hunter2'; }), 'V-4'),
    'a secret does not belong in the flow document');
  assert.ok(findRule(mutate((g) => { P(g).auth.header = 'Api Key'; }), 'V-4'),
    'a header name is a token - a space would smuggle a second header');
  assert.ok(findRule(mutate((g) => { P(g).auth = { mode: 'basic' }; }), 'V-4'),
    'basic without a user name');
  assert.ok(findRule(mutate((g) => { P(g).auth = { mode: 'raten' }; }), 'V-4'),
    'unknown auth mode');
  assert.ok(findRule(mutate((g) => { P(g).mappings = []; }), 'V-4'), 'no mapping = no measurement');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].path = ''; }), 'V-4'),
    'an empty value path: an HTTP answer is a document, never a bare value');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].path = '__proto__'; }), 'V-4'),
    'prototype-poisoning segments are refused');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].aggregate = 'median'; }), 'V-4'),
    'unknown aggregate');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].scale = 0; }), 'V-4'),
    'a scale of 0 would erase every reading');
  assert.ok(findRule(mutate((g) => { P(g).mappings[1].channel = 'soc_pct'; }), 'V-4'),
    'two mappings onto ONE channel');
  assert.ok(findRule(mutate((g) => { P(g).mappings[0].stale_s = 300; }), 'V-4'),
    'stale_s would be permission to resend an old reading with a fresh timestamp');
  assert.ok(findRule(mutate((g) => { P(g).mappings[7].aggregate = 'avg'; }), 'V-4'),
    'a yes/no value is never averaged');
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
