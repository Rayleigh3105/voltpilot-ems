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
const vpFeed = require('../nodes/vp-feed.js');
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

  // The durchgehende Preis-Probe: the COMPILED artifact of the guided rule
  // "Wenn der Börsenpreis unter 0 ct liegt: Heizstab einschalten" (the
  // Negativpreise template's shape) runs under a real Node-RED against a real
  // broker. A fresh price below the threshold switches the rule ON; the
  // mirror's stale marker turns the condition to "does not hold" (wish false)
  // and no ON wish may ever follow from the old price again.
  it('a price change switches the compiled rule; a stale price does not', function (done) {
    const graph = {
      schema_version: '1.0',
      flow_id: 'bb1c2b3a-5d6e-4f70-8123-456789abcdbb',
      flow_version: 1,
      name: 'Negativpreise mitnehmen',
      runtime: 'edge',
      site_id: '00000000-0000-0000-0000-000000000002',
      nodes: [
        { id: 'p1', type: 'vp.price.current', type_version: '1.1.0', parameters: {} },
        { id: 's1', type: 'vp.logic.threshold', type_version: '1.1.0',
          parameters: { threshold: 0, direction: 'below', hysteresis: 0.5 } },
        { id: 'c1', type: 'vp.entity.control', type_version: '1.0.0',
          parameters: { entity_id: 'heizstab-1', command: 'on_off', ttl_s: 930 },
          claims: [{ entity_id: 'heizstab-1', commands: ['on_off'] }] },
      ],
      edges: [
        { id: 'e1', from: { node: 'p1', port: 'value' }, to: { node: 's1', port: 'input' } },
        { id: 'e2', from: { node: 's1', port: 'result' }, to: { node: 'c1', port: 'value' } },
      ],
      triggers: [{ id: 't1', kind: 'interval', every_s: 1 }],
    };
    const artifact = compile(graph, { compiledAt: '2026-11-14T12:00:00Z' });
    const flow = [
      { id: 'cfg-vp-core', type: 'vp-core', name: 'core', host: '127.0.0.1', port: String(port) },
    ].concat(artifact.bundle.nodered_flows);

    const inTenMin = new Date(Date.now() + 10 * 60000).toISOString();
    const fresh = JSON.stringify({
      schema_version: '1.0', price_ct_kwh: -1.2, unit: 'ct/kWh',
      slot_start: new Date().toISOString(), slot_end: inTenMin, valid_until: inTenMin,
      bidding_zone: 'DE-LU',
    });
    const staleMarker = JSON.stringify({ schema_version: '1.0', stale: true });

    let phase = 'warte-an';
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      cli.end(true, {}, () => done(e));
    };
    const cli = mqtt.connect('mqtt://127.0.0.1:' + port);
    cli.on('connect', function () {
      cli.subscribe('edge/entities/heizstab-1/desired', { qos: 1 }, function () {
        // The RETAINED fresh price: exactly what internal/pricefeed publishes.
        cli.publish('edge/price/current', fresh, { qos: 1, retain: true });
      });
    });
    cli.on('message', function (topic, payload) {
      if (failed || topic !== 'edge/entities/heizstab-1/desired') return;
      let m;
      try {
        m = JSON.parse(payload.toString());
      } catch (e) {
        return fail(e);
      }
      try {
        assert.deepStrictEqual(m.command.type, 'on_off');
        if (phase === 'warte-an') {
          // The fresh negative price must switch the rule ON.
          if (m.command.value !== true) return; // a leading false wish is legal
          phase = 'warte-aus';
          cli.publish('edge/price/current', staleMarker, { qos: 1, retain: true });
          return;
        }
        if (phase === 'warte-aus') {
          // An in-flight ON wish (ticked before the marker reached vp-feed) is
          // legal; the FALSE wish proves the marker was judged.
          if (m.command.value !== false) return;
          phase = 'ruhe';
          // From the judged marker on, an ON wish would be the rule switching
          // on a price that no longer exists - give it three ticks to misfire.
          setTimeout(function () {
            if (failed || phase !== 'ruhe') return;
            phase = 'fertig';
            cli.end(true, {}, () => done());
          }, 3000);
          return;
        }
        if (phase === 'ruhe' && m.command.value === true) {
          return fail(new Error('ON wish after the stale marker - the rule kept an old price'));
        }
      } catch (e) {
        fail(e);
      }
    });

    helper.load([vpCore, vpDesired, vpEntityRead, vpFeed, injectNode, functionNode], flow, function () {
      // The compiled inject re-fires every second; the retained price reaches
      // vp-feed on subscribe. Nothing to drive manually.
    });
  });
});
