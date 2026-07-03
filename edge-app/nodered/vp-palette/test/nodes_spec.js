/**
 * vp-palette tests: pure shaping units plus node-red-node-test-helper runs
 * of all three nodes against an in-process MQTT broker (aedes) standing in
 * for the core agent's embedded local bus.
 */
'use strict';

const assert = require('node:assert');
const net = require('node:net');
const aedes = require('aedes');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');

const vpCore = require('../nodes/vp-core.js');
const vpTelemetrie = require('../nodes/vp-telemetrie.js');
const vpSollwert = require('../nodes/vp-sollwert.js');
const vpStatus = require('../nodes/vp-status.js');
const vpInverterConfig = require('../nodes/vp-inverter-config.js');

helper.init(require.resolve('node-red'));

describe('shaping (pure)', function () {
  it('vp-telemetrie shapes contract measurement fields and drops junk', function () {
    const shaped = vpTelemetrie.shape({
      power_kw: 1.5,
      soc_pct: 50,
      pv_power_kw: 12,
      load_kw: 8,
      grid_limit_kw: 30,
      ts: '2026-07-01T09:00:00Z',
      extra: 'ignore-me',
      nan: NaN,
    });
    assert.deepStrictEqual(shaped, {
      power_kw: 1.5,
      soc_pct: 50,
      pv_power_kw: 12,
      load_kw: 8,
      grid_limit_kw: 30,
      ts: '2026-07-01T09:00:00Z',
    });
  });

  it('vp-telemetrie accepts the classic acquisition aliases', function () {
    const shaped = vpTelemetrie.shape({ grid_kw: -2, pv_kw: 9, load_kw: 7 });
    assert.deepStrictEqual(shaped, { power_kw: -2, pv_power_kw: 9, load_kw: 7 });
  });

  it('vp-telemetrie rejects empty / non-numeric readings', function () {
    assert.strictEqual(vpTelemetrie.shape({}), null);
    assert.strictEqual(vpTelemetrie.shape(null), null);
    assert.strictEqual(vpTelemetrie.shape('12'), null);
    assert.strictEqual(vpTelemetrie.shape({ soc_pct: 'fifty' }), null);
    assert.strictEqual(vpTelemetrie.shape({ pv_power_kw: Infinity }), null);
  });

  it('vp-telemetrie drops an invalid ts but keeps the reading', function () {
    const shaped = vpTelemetrie.shape({ load_kw: 3, ts: 'gestern' });
    assert.deepStrictEqual(shaped, { load_kw: 3 });
  });

  it('vp-sollwert parses the setpoint command', function () {
    const parsed = vpSollwert.parse(Buffer.from(JSON.stringify({
      battery_setpoint_kw: -25,
      source: 'schedule',
      slot_start: '2026-07-01T09:00:00Z',
      ts: '2026-07-01T09:05:00Z',
    })));
    assert.strictEqual(parsed.payload, -25);
    assert.strictEqual(parsed.setpoint.source, 'schedule');
  });

  it('vp-sollwert rejects malformed commands', function () {
    assert.strictEqual(vpSollwert.parse(Buffer.from('kaputt')), null);
    assert.strictEqual(vpSollwert.parse(Buffer.from('{}')), null);
    assert.strictEqual(vpSollwert.parse(Buffer.from('{"battery_setpoint_kw":"viel"}')), null);
  });

  it('vp-status normalizes every accepted input form', function () {
    assert.strictEqual(vpStatus.shape(true).inverter_link, 'up');
    assert.strictEqual(vpStatus.shape(false).inverter_link, 'down');
    assert.strictEqual(vpStatus.shape('up').inverter_link, 'up');
    assert.strictEqual(vpStatus.shape({ inverter_link: 'down' }).inverter_link, 'down');
    assert.strictEqual(vpStatus.shape('kaputt'), null);
    assert.strictEqual(vpStatus.shape(42), null);
  });

  it('vp-inverter-config parses a valid retained selection', function () {
    const sel = vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0',
      brand: 'deye',
      label: 'Deye · Hybrid, 3-phasig',
      family: 'hybrid_3p',
      communication: 'solarman_v5',
      connection: { ip: '192.168.0.28', serial: '2985159064' },
      updated_at: '2026-07-03T12:00:00Z',
    })));
    assert.strictEqual(sel.family, 'hybrid_3p');
    assert.strictEqual(sel.communication, 'solarman_v5');
    assert.strictEqual(sel.connection.ip, '192.168.0.28');
  });

  it('vp-inverter-config rejects malformed / wrong-version / incomplete selections', function () {
    assert.strictEqual(vpInverterConfig.parse(Buffer.from('kaputt')), null);
    assert.strictEqual(vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '2.0', communication: 'modbus_tcp', family: 'sunspec', connection: { ip: 'x' },
    }))), null);
    assert.strictEqual(vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', communication: 'carrier-pigeon', family: 'x', connection: { ip: 'y' },
    }))), null);
    assert.strictEqual(vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', communication: 'modbus_tcp', family: 'sunspec', connection: {},
    }))), null);
  });
});

describe('nodes against a local-bus stand-in', function () {
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

  it('vp-telemetrie publishes the shaped reading on edge/telemetry', function (done) {
    const flow = coreFlow([
      { id: 't1', type: 'vp-telemetrie', core: 'core1' },
    ]);
    broker.subscribe('edge/telemetry', function (packet, cb) {
      cb();
      const m = JSON.parse(packet.payload.toString());
      try {
        assert.strictEqual(m.pv_power_kw, 12);
        assert.strictEqual(m.load_kw, 8);
        assert.strictEqual(m.ts, '2026-07-01T09:00:00Z');
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});
    helper.load([vpCore, vpTelemetrie], flow, function () {
      const t1 = helper.getNode('t1');
      // Give the node's mqtt client a moment to connect, then inject.
      setTimeout(function () {
        t1.receive({ payload: { pv_power_kw: 12, load_kw: 8, ts: '2026-07-01T09:00:00Z' } });
      }, 300);
    });
  });

  it('vp-sollwert emits the setpoint arriving on edge/setpoint', function (done) {
    const flow = coreFlow([
      { id: 's1', type: 'vp-sollwert', core: 'core1', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
    ]);
    helper.load([vpCore, vpSollwert], flow, function () {
      const h1 = helper.getNode('h1');
      h1.on('input', function (msg) {
        try {
          assert.strictEqual(msg.payload, -25);
          assert.strictEqual(msg.setpoint.source, 'schedule');
          done();
        } catch (e) {
          done(e);
        }
      });
      setTimeout(function () {
        const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
        pub.on('connect', function () {
          pub.publish('edge/setpoint', JSON.stringify({
            battery_setpoint_kw: -25,
            source: 'schedule',
            ts: new Date().toISOString(),
          }), { qos: 1, retain: true }, function () {
            pub.end();
          });
        });
      }, 300);
    });
  });

  it('VP_CORE_HOST/PORT override the flow config (host-networking mode)', function (done) {
    // The seeded flow pins host=core/port=1883; on the host network that name
    // no longer resolves, so hostnet mode points the bus via env at the core's
    // loopback mapping. The env vars MUST win over the stored config.
    process.env.VP_CORE_HOST = '127.0.0.1';
    process.env.VP_CORE_PORT = String(port);
    const flow = [
      { id: 'core1', type: 'vp-core', name: 'test-core', host: 'core', port: '1883' },
      { id: 't1', type: 'vp-telemetrie', core: 'core1' },
    ];
    broker.subscribe('edge/telemetry', function (packet, cb) {
      cb();
      const m = JSON.parse(packet.payload.toString());
      try {
        assert.strictEqual(m.load_kw, 3);
        done();
      } catch (e) {
        done(e);
      } finally {
        delete process.env.VP_CORE_HOST;
        delete process.env.VP_CORE_PORT;
      }
    }, function () {});
    helper.load([vpCore, vpTelemetrie], flow, function () {
      const t1 = helper.getNode('t1');
      setTimeout(function () {
        t1.receive({ payload: { load_kw: 3 } });
      }, 300);
    });
  });

  it('vp-inverter-config emits the retained selection from edge/inverter/config', function (done) {
    const flow = coreFlow([
      { id: 'ic1', type: 'vp-inverter-config', core: 'core1', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
    ]);
    // Publish the retained config BEFORE the node subscribes, so this also
    // proves the retain-on-(re)connect behaviour the contract relies on.
    const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
    pub.on('connect', function () {
      pub.publish('edge/inverter/config', JSON.stringify({
        schema_version: '1.0',
        brand: 'generic_modbus',
        label: 'Anderer Hersteller (Modbus / SunSpec) · SunSpec (Standard)',
        family: 'sunspec',
        communication: 'modbus_tcp',
        connection: { ip: 'edge-sim', port: 502, unit_id: 1, profile: 'sunspec' },
        updated_at: '2026-07-03T12:00:00Z',
      }), { qos: 1, retain: true }, function () {
        pub.end();
        helper.load([vpCore, vpInverterConfig], flow, function () {
          const h1 = helper.getNode('h1');
          h1.on('input', function (msg) {
            try {
              assert.strictEqual(msg.payload.communication, 'modbus_tcp');
              assert.strictEqual(msg.payload.family, 'sunspec');
              assert.strictEqual(msg.inverter.connection.ip, 'edge-sim');
              done();
            } catch (e) {
              done(e);
            }
          });
        });
      });
    });
  });

  it('vp-status publishes the retained link state on edge/status', function (done) {
    const flow = coreFlow([
      { id: 'st1', type: 'vp-status', core: 'core1' },
    ]);
    broker.subscribe('edge/status', function (packet, cb) {
      cb();
      const m = JSON.parse(packet.payload.toString());
      try {
        assert.strictEqual(m.inverter_link, 'up');
        assert.ok(m.ts);
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});
    helper.load([vpCore, vpStatus], flow, function () {
      const st1 = helper.getNode('st1');
      setTimeout(function () {
        st1.receive({ payload: true });
      }, 300);
    });
  });
});
