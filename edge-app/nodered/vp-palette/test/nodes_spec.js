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
const vpControlReadback = require('../nodes/vp-control-readback.js');
const vpSourcesConfig = require('../nodes/vp-sources-config.js');
const vpQuelle = require('../nodes/vp-quelle.js');
const vpNetz = require('../nodes/vp-netz.js');
const vpTestRequest = require('../nodes/vp-test-request.js');
const vpTestResult = require('../nodes/vp-test-result.js');

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
      schema_version: '1.0', family: 'x', connection: { ip: 'y' }, // no communication
    }))), null);
    assert.strictEqual(vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', communication: 'modbus_tcp', family: 'sunspec', connection: {},
    }))), null);
  });

  // REGRESSION (same stale-whitelist class as vp-sources-config, 2026-07-13):
  // a fronius_solar_api / fronius_sunspec PRIMARY selection was silently
  // dropped here although the auto tab's router has live branches for both.
  // Validation is structural only now: every communication passes through and
  // the router decides (unknown -> idle with a named status).
  it('vp-inverter-config passes fronius selections and unknown communications through (structural-only)', function () {
    const sunspec = vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', brand: 'fronius_sunspec', family: 'sunspec_live',
      communication: 'fronius_sunspec',
      connection: { ip: '192.168.210.40', port: 502, unit_id: 1, model_type: 'auto' },
    })));
    assert.ok(sunspec, 'fronius_sunspec must NOT be dropped');
    assert.strictEqual(sunspec.communication, 'fronius_sunspec');
    const future = vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', communication: 'some_future_transport', family: 'x', connection: { ip: 'y' },
    })));
    assert.ok(future, 'an unknown communication passes through; the router goes idle with a named status');
  });

  it('vp-control-readback shapes a readback and derives all_match / mismatch_roles', function () {
    const ok = vpControlReadback.shape({
      ts: '2026-07-08T12:00:03Z', family: 'sunspec', source: 'schedule',
      registers: [
        { role: 'battery_power', fc: 3, addr: 40, commanded_raw: 64536, actual_raw: 64536, match: true },
        { role: 'control_enable', fc: 3, addr: 41, commanded_raw: 1, actual_raw: 1, match: true },
      ],
    });
    assert.strictEqual(ok.all_match, true);
    assert.deepStrictEqual(ok.mismatch_roles, []);

    const bad = vpControlReadback.shape({
      registers: [
        { role: 'battery_power', fc: 3, addr: 40, commanded_raw: 64536, actual_raw: 1200, match: false },
        { role: 'control_enable', fc: 3, addr: 41, commanded_raw: 1, actual_raw: 1, match: true },
      ],
    });
    assert.strictEqual(bad.all_match, false);
    assert.deepStrictEqual(bad.mismatch_roles, ['battery_power']);
  });

  it('vp-control-readback rejects malformed readbacks', function () {
    assert.strictEqual(vpControlReadback.shape(null), null);
    assert.strictEqual(vpControlReadback.shape({}), null);
    assert.strictEqual(vpControlReadback.shape({ registers: 'x' }), null);
    assert.strictEqual(vpControlReadback.shape({ registers: [{ role: 'x' }] }), null);
  });

  it('vp-sources-config parses a valid retained source array', function () {
    const list = vpSourcesConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0',
      sources: [
        { id: 'src-a', role: 'pv-generation', brand: 'generic_modbus', family: 'sunspec',
          communication: 'modbus_tcp', connection: { ip: '192.168.0.70' }, capacity_kwp: 70 },
      ],
    })));
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'src-a');
    assert.strictEqual(list[0].capacity_kwp, 70);
  });

  it('vp-sources-config distinguishes a cleared config ([]) from garbage (null)', function () {
    assert.deepStrictEqual(vpSourcesConfig.parse(Buffer.from('')), []);
    assert.deepStrictEqual(vpSourcesConfig.parse(Buffer.from(JSON.stringify({ schema_version: '1.0', sources: [] }))), []);
    assert.strictEqual(vpSourcesConfig.parse(Buffer.from('kaputt')), null);
    assert.strictEqual(vpSourcesConfig.parse(Buffer.from(JSON.stringify({ schema_version: '2.0', sources: [] }))), null);
  });

  it('vp-sources-config drops entries without id / ip / family', function () {
    const list = vpSourcesConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0',
      sources: [
        { id: 'ok', role: 'pv-generation', family: 'sunspec', communication: 'modbus_tcp', connection: { ip: '1.2.3.4' } },
        { role: 'pv-generation', family: 'sunspec', communication: 'modbus_tcp', connection: { ip: '1.2.3.4' } }, // no id
        { id: 'noip', family: 'sunspec', communication: 'modbus_tcp', connection: {} },
      ],
    })));
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'ok');
  });

  // REGRESSION (real device 2026-07-13): parse() once whitelisted solarman_v5 +
  // modbus_tcp and silently dropped a fronius_sunspec Erzeuger BEFORE the flow
  // ever saw it - neither data nor a warn anywhere. Validation is STRUCTURAL
  // only now: every communication passes through; the flow's store node decides
  // readability and logs NICHT VERDRAHTET for unknown ones.
  it('vp-sources-config passes a fronius_sunspec source through (the exact core busEntry shape)', function () {
    const list = vpSourcesConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0',
      sources: [{
        id: 'src-eco', role: 'pv-generation', brand: 'fronius_sunspec', model: 'fronius-eco-27-3-s',
        family: 'sunspec_live', communication: 'fronius_sunspec',
        connection: { ip: '192.168.210.40', port: 502, unit_id: 1, model_type: 'auto', invert_grid_sign: false },
        interval_s: 5, capacity_kwp: 70,
      }],
    })));
    assert.strictEqual(list.length, 1, 'fronius_sunspec must NOT be dropped (the stale-whitelist bug)');
    assert.strictEqual(list[0].communication, 'fronius_sunspec');
    assert.strictEqual(list[0].connection.model_type, 'auto');
  });

  it('vp-sources-config is structural-only: an unknown communication passes through (the flow logs it)', function () {
    const d = vpSourcesConfig.parseDetailed(Buffer.from(JSON.stringify({
      schema_version: '1.0',
      sources: [
        { id: 'src-new', role: 'pv-generation', family: 'x', communication: 'some_future_transport', connection: { ip: '1.2.3.4' } },
        { id: 'src-nocomm', role: 'pv-generation', family: 'x', connection: { ip: '1.2.3.4' } },
      ],
    })));
    assert.strictEqual(d.list.length, 1);
    assert.strictEqual(d.list[0].id, 'src-new');
    assert.strictEqual(d.dropped.length, 1);
    assert.ok(d.dropped[0].indexOf('src-nocomm') === 0 && d.dropped[0].indexOf('communication') > 0, d.dropped[0]);
  });

  it('vp-quelle shapes a source reading (pv only) and builds a safe per-source topic', function () {
    assert.deepStrictEqual(vpQuelle.shape({ pv_power_kw: 42, load_kw: 9 }), { pv_power_kw: 42 });
    assert.deepStrictEqual(vpQuelle.shape({ pv_kw: 5 }), { pv_power_kw: 5 }); // alias
    assert.strictEqual(vpQuelle.shape({ load_kw: 3 }), null); // no PV -> nothing
    assert.strictEqual(vpQuelle.topicFor('src-a'), 'edge/sources/src-a/telemetry');
    assert.strictEqual(vpQuelle.topicFor('a/b'), null); // topic-injection guard
    assert.strictEqual(vpQuelle.topicFor(''), null);
  });

  it('vp-netz shapes a signed grid reading (power_kw only) and guards the topic', function () {
    assert.deepStrictEqual(vpNetz.shape({ power_kw: -8, pv_power_kw: 3 }), { power_kw: -8 }); // export, drops non-grid
    assert.deepStrictEqual(vpNetz.shape({ grid_kw: 12 }), { power_kw: 12 }); // alias, import
    assert.deepStrictEqual(vpNetz.shape({ power_kw: 0 }), { power_kw: 0 }); // 0 is a valid signed value
    assert.strictEqual(vpNetz.shape({ pv_power_kw: 5 }), null); // no grid -> nothing
    assert.strictEqual(vpNetz.shape({ power_kw: Infinity }), null);
    assert.strictEqual(vpNetz.topicFor('src-n'), 'edge/sources/src-n/telemetry');
    assert.strictEqual(vpNetz.topicFor('a/b'), null); // same topic-injection guard as vp-quelle
    assert.strictEqual(vpNetz.topicFor('#'), null);
  });

  it('vp-test-request parses a valid test-read request and drops unusable ones', function () {
    const ok = vpTestRequest.parse(Buffer.from(JSON.stringify({
      request_id: 'tr-1', brand: 'deye', model: 'x', family: 'hybrid_3p',
      communication: 'solarman_v5', connection: { ip: '192.168.0.28', serial: '2985159064' },
    })));
    assert.strictEqual(ok.request_id, 'tr-1');
    assert.strictEqual(vpTestRequest.parse(Buffer.from('kaputt')), null); // bad JSON
    assert.strictEqual(vpTestRequest.parse(Buffer.from(JSON.stringify({ connection: { ip: '1.2.3.4' } }))), null); // no request_id
    assert.strictEqual(vpTestRequest.parse(Buffer.from(JSON.stringify({ request_id: 'x', connection: {} }))), null); // no ip
  });

  it('vp-test-result passes through a valid result and drops one without request_id', function () {
    const ok = vpTestResult.shape({ request_id: 'tr-1', ok: true, reading: { pv_kw: 4.8 } });
    assert.strictEqual(ok.request_id, 'tr-1');
    assert.strictEqual(vpTestResult.shape(null), null);
    assert.strictEqual(vpTestResult.shape({ ok: true }), null); // no request_id
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

  it('vp-control-readback publishes the readback on edge/control/readback (not retained)', function (done) {
    const flow = coreFlow([
      { id: 'cr1', type: 'vp-control-readback', core: 'core1' },
    ]);
    broker.subscribe('edge/control/readback', function (packet, cb) {
      cb();
      const m = JSON.parse(packet.payload.toString());
      try {
        assert.strictEqual(packet.retain, false, 'readback is a live event, never retained');
        assert.strictEqual(m.all_match, true);
        assert.strictEqual(m.registers.length, 1);
        assert.strictEqual(m.registers[0].role, 'battery_power');
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});
    helper.load([vpCore, vpControlReadback], flow, function () {
      const cr1 = helper.getNode('cr1');
      setTimeout(function () {
        cr1.receive({ payload: {
          family: 'sunspec', source: 'schedule',
          registers: [{ role: 'battery_power', fc: 3, addr: 40, commanded_raw: 64536, actual_raw: 64536, match: true }],
        } });
      }, 300);
    });
  });

  it('vp-sources-config emits the retained source array from edge/sources/config', function (done) {
    const flow = coreFlow([
      { id: 'sc1', type: 'vp-sources-config', core: 'core1', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
    ]);
    const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
    pub.on('connect', function () {
      pub.publish('edge/sources/config', JSON.stringify({
        schema_version: '1.0',
        sources: [
          { id: 'src-a', role: 'pv-generation', brand: 'generic_modbus', family: 'sunspec',
            communication: 'modbus_tcp', connection: { ip: 'edge-pv', port: 502, unit_id: 1 }, capacity_kwp: 70 },
        ],
      }), { qos: 1, retain: true }, function () {
        pub.end();
        helper.load([vpCore, vpSourcesConfig], flow, function () {
          const h1 = helper.getNode('h1');
          h1.on('input', function (msg) {
            try {
              assert.strictEqual(msg.payload.length, 1);
              assert.strictEqual(msg.sources[0].id, 'src-a');
              assert.strictEqual(msg.sources[0].capacity_kwp, 70);
              done();
            } catch (e) {
              done(e);
            }
          });
        });
      });
    });
  });

  // The real-device gap the older integration test missed: it only ever
  // published a modbus_tcp source, which the stale parse() whitelist happened
  // to admit. This drives the ACTUAL node over the real bus with the retained
  // fronius_sunspec payload the core publishes (busEntry shape) and asserts it
  // reaches the flow.
  it('vp-sources-config emits a retained fronius_sunspec source from edge/sources/config', function (done) {
    const flow = coreFlow([
      { id: 'sc2', type: 'vp-sources-config', core: 'core1', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
    ]);
    const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
    pub.on('connect', function () {
      pub.publish('edge/sources/config', JSON.stringify({
        schema_version: '1.0',
        sources: [{
          id: 'src-eco', role: 'pv-generation', brand: 'fronius_sunspec', model: 'fronius-eco-27-3-s',
          family: 'sunspec_live', communication: 'fronius_sunspec',
          connection: { ip: '192.168.210.40', port: 502, unit_id: 1, model_type: 'auto', invert_grid_sign: false },
          interval_s: 5, capacity_kwp: 70,
        }],
      }), { qos: 1, retain: true }, function () {
        pub.end();
        helper.load([vpCore, vpSourcesConfig], flow, function () {
          const h1 = helper.getNode('h1');
          h1.on('input', function (msg) {
            try {
              assert.strictEqual(msg.payload.length, 1, 'the fronius_sunspec source must reach the flow (stale-whitelist regression)');
              assert.strictEqual(msg.sources[0].id, 'src-eco');
              assert.strictEqual(msg.sources[0].communication, 'fronius_sunspec');
              assert.strictEqual(msg.sources[0].connection.unit_id, 1);
              done();
            } catch (e) {
              done(e);
            }
          });
        });
      });
    });
  });

  it('vp-quelle publishes a source reading on edge/sources/<id>/telemetry', function (done) {
    const flow = coreFlow([
      { id: 'q1', type: 'vp-quelle', core: 'core1' },
    ]);
    broker.subscribe('edge/sources/src-a/telemetry', function (packet, cb) {
      cb();
      const m = JSON.parse(packet.payload.toString());
      try {
        assert.strictEqual(m.pv_power_kw, 33);
        assert.strictEqual(packet.retain, false, 'per-source telemetry is a live event, never retained');
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});
    helper.load([vpCore, vpQuelle], flow, function () {
      const q1 = helper.getNode('q1');
      setTimeout(function () {
        q1.receive({ source_id: 'src-a', payload: { pv_power_kw: 33 } });
      }, 300);
    });
  });

  it('vp-test-request emits a test-read request from edge/test-read/request', function (done) {
    const flow = coreFlow([
      { id: 'tr1', type: 'vp-test-request', core: 'core1', wires: [['h1']] },
      { id: 'h1', type: 'helper' },
    ]);
    helper.load([vpCore, vpTestRequest], flow, function () {
      const h1 = helper.getNode('h1');
      h1.on('input', function (msg) {
        try {
          assert.strictEqual(msg.request_id, 'tr-xyz');
          assert.strictEqual(msg.payload.brand, 'generic_modbus');
          done();
        } catch (e) {
          done(e);
        }
      });
      // Give the node's client a moment to subscribe, then publish (non-retained).
      const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
      pub.on('connect', function () {
        setTimeout(function () {
          pub.publish('edge/test-read/request', JSON.stringify({
            request_id: 'tr-xyz', brand: 'generic_modbus', model: 'sunspec', family: 'sunspec',
            communication: 'modbus_tcp', connection: { ip: '127.0.0.1', port: 502 },
          }), { qos: 1, retain: false }, function () { pub.end(); });
        }, 300);
      });
    });
  });

  it('vp-test-result publishes the result on edge/test-read/result (never retained)', function (done) {
    const flow = coreFlow([
      { id: 'tres1', type: 'vp-test-result', core: 'core1' },
    ]);
    broker.subscribe('edge/test-read/result', function (packet, cb) {
      cb();
      const m = JSON.parse(packet.payload.toString());
      try {
        assert.strictEqual(m.request_id, 'tr-xyz');
        assert.strictEqual(m.ok, true);
        assert.strictEqual(m.reading.pv_kw, 4.8);
        assert.strictEqual(packet.retain, false, 'a test result is a live event, never retained');
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});
    helper.load([vpCore, vpTestResult], flow, function () {
      const n = helper.getNode('tres1');
      setTimeout(function () {
        n.receive({ payload: { request_id: 'tr-xyz', ok: true, reading: { pv_kw: 4.8 } } });
      }, 300);
    });
  });
});
