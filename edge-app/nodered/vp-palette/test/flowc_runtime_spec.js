/**
 * flowc runtime proof: a COMPILED artifact (the flowc output, verbatim
 * bundle.nodered_flows) actually RUNS under Node-RED and emits a desired on
 * the local bus - the offline twin of the September-Gate rig's
 * "NR executes the compiled flow" leg. Loads the REAL core nodes (inject +
 * function) alongside vp-core/vp-desired, so the generated wiring and
 * template code paths are executed, not just shaped.
 */
'use strict';

const assert = require('node:assert');
const net = require('node:net');
const path = require('path');
const aedes = require('aedes');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');

const vpCore = require('../nodes/vp-core.js');
const vpDesired = require('../nodes/vp-desired.js');
const vpEntityRead = require('../nodes/vp-entity-read.js');
const injectNode = require('@node-red/nodes/core/common/20-inject.js');
const functionNode = require('@node-red/nodes/core/function/10-function.js');

const { compile } = require(path.join(__dirname, '..', '..', 'flowc', 'compile'));

helper.init(require.resolve('node-red'));

describe('flowc-compiled artifact under a real Node-RED runtime', function () {
  this.timeout(20000);

  let broker;
  let server;
  let port;

  beforeEach(function (done) {
    broker = aedes();
    server = net.createServer(broker.handle);
    server.listen(0, '127.0.0.1', function () {
      port = server.address().port;
      helper.startServer(done);
    });
  });

  afterEach(function (done) {
    helper.unload().then(function () {
      helper.stopServer(function () {
        broker.close(function () {
          server.close(done);
        });
      });
    });
  });

  it('the rig graph (Zeitplan -> Wenn/Dann -> Entität steuern) emits a compiler-stamped desired', function (done) {
    const graph = {
      schema_version: '1.0',
      flow_id: 'aa1c2b3a-5d6e-4f70-8123-456789abcdaa',
      flow_version: 1,
      name: 'Rig: Dauerentladung 7 kW',
      runtime: 'edge',
      site_id: '00000000-0000-0000-0000-000000000002',
      nodes: [
        { id: 'w1', type: 'vp.schedule.window', type_version: '1.0.0',
          parameters: { from: '00:00', to: '23:59' } },
        { id: 'i1', type: 'vp.logic.if', type_version: '1.0.0',
          parameters: { then_value: -7 } },
        { id: 'c1', type: 'vp.entity.control', type_version: '1.0.0',
          parameters: { entity_id: 'batt-main', command: 'setpoint_kw', ttl_s: 120 },
          claims: [{ entity_id: 'batt-main', commands: ['setpoint_kw'] }] },
      ],
      edges: [
        { id: 'e1', from: { node: 'w1', port: 'active' }, to: { node: 'i1', port: 'condition' } },
        // Setpoint action: the numeric Wenn/Dann value feeds the control node's
        // `setpoint` input (its `value` input is the bool Ein/Aus port - the
        // api flow-catalog is authoritative and flowc mirrors it since #519).
        { id: 'e2', from: { node: 'i1', port: 'value' }, to: { node: 'c1', port: 'setpoint' } },
      ],
      triggers: [{ id: 't1', kind: 'interval', every_s: 5 }],
    };
    const artifact = compile(graph, { compiledAt: '2026-07-18T12:00:00Z' });

    // The bundle references the template's shared vp-core config node by its
    // well-known id (the flowc compilation convention); provide it like the
    // template does, pointed at the test bus.
    const flow = [
      { id: 'cfg-vp-core', type: 'vp-core', name: 'core', host: '127.0.0.1', port: String(port) },
    ].concat(artifact.bundle.nodered_flows);

    let finished = false;
    const sub = mqtt.connect('mqtt://127.0.0.1:' + port);
    sub.on('connect', function () {
      sub.subscribe('edge/entities/batt-main/desired', { qos: 1 });
    });
    sub.on('message', function (topic, payload) {
      if (finished) return;
      finished = true;
      try {
        const m = JSON.parse(payload.toString());
        assert.strictEqual(m.schema_version, '1.0');
        assert.strictEqual(m.entity_id, 'batt-main');
        assert.strictEqual(m.priority, 'flow');
        assert.deepStrictEqual(m.command, { type: 'setpoint_kw', value: -7 });
        assert.strictEqual(m.ttl_s, 120);
        assert.deepStrictEqual(m.source, {
          kind: 'flow',
          flow_id: 'aa1c2b3a-5d6e-4f70-8123-456789abcdaa',
          flow_version: 1,
          node_id: 'c1',
        });
        sub.end(true, {}, () => done());
      } catch (e) {
        sub.end(true, {}, () => done(e));
      }
    });

    helper.load([vpCore, vpDesired, vpEntityRead, injectNode, functionNode], flow, function () {
      // Nothing to inject manually: the compiled inject node fires on its own
      // (once=true + repeat). The desired must arrive without any help.
    });
  });
});
