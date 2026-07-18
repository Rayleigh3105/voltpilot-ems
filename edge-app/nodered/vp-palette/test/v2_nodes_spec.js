/**
 * v2 flow-runtime palette nodes (E2): vp-desired (the ONLY actuation-capable
 * node - publishes desires, never commands), vp-entity-read, vp-feed and
 * vp-notify. Pure shaping units plus aedes-bus runs (the nodes_spec.js
 * harness).
 */
'use strict';

const assert = require('node:assert');
const net = require('node:net');
const aedes = require('aedes');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');

const vpCore = require('../nodes/vp-core.js');
const vpDesired = require('../nodes/vp-desired.js');
const vpEntityRead = require('../nodes/vp-entity-read.js');
const vpFeed = require('../nodes/vp-feed.js');
const vpNotify = require('../nodes/vp-notify.js');

helper.init(require.resolve('node-red'));

const CFG = {
  entity: 'heatrod-cellar',
  command: 'on_off',
  ttl_s: 180,
  override: false,
  flowId: '4e1c2b3a-5d6e-4f70-8123-456789abcdef',
  flowVersion: 7,
  nodeId: 'n7',
};

describe('v2 shaping (pure)', function () {
  it('vp-desired shapes a contract-exact desired payload', function () {
    const p = vpDesired.shape(CFG, true, '2026-07-18T10:00:00Z');
    assert.deepStrictEqual(p, {
      schema_version: '1.0',
      entity_id: 'heatrod-cellar',
      request_id: 'n7:true',
      source: { kind: 'flow', flow_id: CFG.flowId, flow_version: 7, node_id: 'n7' },
      priority: 'flow',
      command: { type: 'on_off', value: true },
      ttl_s: 180,
      issued_at: '2026-07-18T10:00:00Z',
    });
    // Priority is ALWAYS flow; override only when configured.
    const ov = vpDesired.shape(Object.assign({}, CFG, { override: true }), true, 'x');
    assert.strictEqual(ov.override, true);
    assert.strictEqual(ov.priority, 'flow');
  });

  it('vp-desired request_id is stable per value (TTL refresh) and changes with the value', function () {
    const a = vpDesired.shape(Object.assign({}, CFG, { command: 'setpoint_kw' }), 7.4);
    const b = vpDesired.shape(Object.assign({}, CFG, { command: 'setpoint_kw' }), 7.4);
    const c = vpDesired.shape(Object.assign({}, CFG, { command: 'setpoint_kw' }), -3);
    assert.strictEqual(a.request_id, b.request_id);
    assert.notStrictEqual(a.request_id, c.request_id);
  });

  it('vp-desired refuses unusable config/values (no payload, never garbage)', function () {
    assert.strictEqual(vpDesired.shape(CFG, 'ja'), null); // on_off needs bool
    assert.strictEqual(vpDesired.shape(Object.assign({}, CFG, { command: 'setpoint_kw' }), NaN), null);
    assert.strictEqual(vpDesired.shape(Object.assign({}, CFG, { command: 'limit_pct' }), 101), null);
    assert.strictEqual(vpDesired.shape(Object.assign({}, CFG, { command: 'limit_kw' }), -1), null);
    assert.strictEqual(vpDesired.shape(Object.assign({}, CFG, { ttl_s: 0 }), true), null);
    assert.strictEqual(vpDesired.shape(Object.assign({}, CFG, { ttl_s: 90000 }), true), null);
    assert.strictEqual(vpDesired.shape(Object.assign({}, CFG, { entity: 'a/b' }), true), null);
    assert.strictEqual(vpDesired.shape(Object.assign({}, CFG, { flowId: '' }), true), null);
  });

  it('vp-desired.mine matches only its own arbitration events', function () {
    const mineEvent = {
      outcome: 'clamped',
      subject: { source: { kind: 'flow', flow_id: CFG.flowId, node_id: 'n7' } },
    };
    const foreign = {
      outcome: 'accepted',
      subject: { source: { kind: 'flow', flow_id: CFG.flowId, node_id: 'nOther' } },
    };
    const plan = { outcome: 'accepted', subject: { source: { kind: 'plan-executor' } } };
    assert.strictEqual(vpDesired.mine(CFG, mineEvent), true);
    assert.strictEqual(vpDesired.mine(CFG, foreign), false);
    assert.strictEqual(vpDesired.mine(CFG, plan), false);
    assert.strictEqual(vpDesired.mine(CFG, { outcome: 'fallback' }), false);
  });

  it('vp-entity-read parses only identity-matching finite channel values', function () {
    const buf = (o) => Buffer.from(JSON.stringify(o));
    const ok = buf({ schema_version: '1.0', entity_id: 'e1', channels: { power_kw: -3.2 } });
    assert.strictEqual(vpEntityRead.parse('e1', 'power_kw', ok), -3.2);
    assert.strictEqual(vpEntityRead.parse('other', 'power_kw', ok), null, 'identity rule');
    assert.strictEqual(vpEntityRead.parse('e1', 'soc_pct', ok), null, 'absent channel stays absent');
    const junk = buf({ schema_version: '1.0', entity_id: 'e1', channels: { power_kw: 'viel' } });
    assert.strictEqual(vpEntityRead.parse('e1', 'power_kw', junk), null);
  });

  it('vp-feed resolves only whitelisted feeds', function () {
    assert.strictEqual(vpFeed.topicFor('prices'), 'edge/prices');
    assert.strictEqual(vpFeed.topicFor('pv_forecast'), 'edge/forecast/pv');
    assert.strictEqual(vpFeed.topicFor('ems/0/0/0/schedule'), null);
    assert.strictEqual(vpFeed.topicFor('__proto__'), null);
  });

  it('vp-notify bounds the message', function () {
    assert.ok(vpNotify.shape('PV-Überschuss: Heizstab an', '2026-07-18T10:00:00Z'));
    assert.strictEqual(vpNotify.shape(''), null);
    assert.strictEqual(vpNotify.shape('x'.repeat(201)), null);
  });
});

describe('v2 nodes against a local-bus stand-in', function () {
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

  function coreFlow(nodes) {
    return [
      { id: 'core1', type: 'vp-core', name: 'test-core', host: '127.0.0.1', port: String(port) },
    ].concat(nodes);
  }

  it('vp-desired publishes the desired on edge/entities/<id>/desired', function (done) {
    const flow = coreFlow([
      Object.assign({ id: 'd1', type: 'vp-desired', core: 'core1' }, CFG),
    ]);
    broker.subscribe('edge/entities/heatrod-cellar/desired', function (packet, cb) {
      cb();
      try {
        const m = JSON.parse(packet.payload.toString());
        assert.strictEqual(m.schema_version, '1.0');
        assert.strictEqual(m.entity_id, 'heatrod-cellar');
        assert.strictEqual(m.priority, 'flow');
        assert.deepStrictEqual(m.command, { type: 'on_off', value: true });
        assert.strictEqual(m.source.node_id, 'n7');
        assert.strictEqual(m.ttl_s, 180);
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});
    helper.load([vpCore, vpDesired], flow, function () {
      const d1 = helper.getNode('d1');
      setTimeout(function () {
        d1.receive({ payload: true });
      }, 300);
    });
  });

  it('vp-desired surfaces its own arbitration events on the output', function (done) {
    const flow = coreFlow([
      Object.assign({ id: 'd1', type: 'vp-desired', core: 'core1', wires: [['h1']] }, CFG),
      { id: 'h1', type: 'helper' },
    ]);
    helper.load([vpCore, vpDesired], flow, function () {
      const h1 = helper.getNode('h1');
      h1.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload.outcome, 'clamped');
          assert.strictEqual(msg.payload.subject.source.node_id, 'n7');
          done();
        } catch (e) {
          done(e);
        }
      });
      setTimeout(function () {
        const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
        pub.on('connect', function () {
          pub.publish('edge/entities/heatrod-cellar/arbitration', JSON.stringify({
            schema_version: '1.0',
            entity_id: 'heatrod-cellar',
            outcome: 'clamped',
            subject: { source: { kind: 'flow', flow_id: CFG.flowId, node_id: 'n7' } },
            reasons: [],
            holder: null,
          }), { qos: 1 }, function () {
            pub.end();
          });
        });
      }, 300);
    });
  });

  it('vp-entity-read emits the channel value and re-emits on trigger input', function (done) {
    const flow = coreFlow([
      { id: 'r1', type: 'vp-entity-read', core: 'core1', entity: 'grid-meter-1', channel: 'power_kw', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
    ]);
    helper.load([vpCore, vpEntityRead], flow, function () {
      const r1 = helper.getNode('r1');
      const h1 = helper.getNode('h1');
      const seen = [];
      h1.on('input', function (msg) {
        seen.push(msg.payload);
        if (seen.length === 1) {
          // Trigger input: re-emit the LAST value without new telemetry.
          r1.receive({});
        } else {
          try {
            assert.deepStrictEqual(seen, [-4.2, -4.2]);
            done();
          } catch (e) {
            done(e);
          }
        }
      });
      setTimeout(function () {
        const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
        pub.on('connect', function () {
          pub.publish('edge/entities/grid-meter-1/telemetry', JSON.stringify({
            schema_version: '1.0',
            entity_id: 'grid-meter-1',
            channels: { power_kw: -4.2 },
          }), { qos: 1 }, function () {
            pub.end();
          });
        });
      }, 300);
    });
  });

  it('vp-notify publishes once per rising edge', function (done) {
    const flow = coreFlow([
      { id: 'n1', type: 'vp-notify', core: 'core1', message: 'PV-Überschuss' },
    ]);
    let count = 0;
    broker.subscribe('edge/notify', function (packet, cb) {
      cb();
      count++;
    }, function () {});
    helper.load([vpCore, vpNotify], flow, function () {
      const n1 = helper.getNode('n1');
      setTimeout(function () {
        n1.receive({ payload: true });
        n1.receive({ payload: true }); // standing true: no second publish
        n1.receive({ payload: false });
        n1.receive({ payload: true }); // rising edge again
        setTimeout(function () {
          try {
            assert.strictEqual(count, 2);
            done();
          } catch (e) {
            done(e);
          }
        }, 400);
      }, 300);
    });
  });
});
