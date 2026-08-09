/**
 * vp-consumer-policy (Verbrauchssteuerung Inkrement 4, D-19): the generated
 * reactive consumer-policy runtime. Pure engine units (three-state logic,
 * freshness, hysteresis, window expiry, off-delay) plus aedes-bus runs of the
 * node (the v2_nodes_spec.js harness): a fresh availability signal publishes
 * a must_run desired with override, a stale one never starts, the trigger
 * input renews the TTL chain.
 */
'use strict';

const assert = require('node:assert');
const net = require('node:net');
const aedes = require('aedes');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');

const vpCore = require('../nodes/vp-core.js');
const vpConsumerPolicy = require('../nodes/vp-consumer-policy.js');
const { Engine, evalWindows, kleeneAll, kleeneAny, TRUE, FALSE, UNKNOWN } =
  require('../lib/reactive-eval.js');

helper.init(require.resolve('node-red'));

const T0 = Date.parse('2026-08-10T10:00:00Z');

function socSpec(offDelay) {
  return {
    command: 'on_off',
    off_delay_s: offDelay === undefined ? 0 : offDelay,
    requirements: [{
      id: 'soc-full',
      must_run: false,
      value: true,
      condition: {
        signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct',
        op: 'gt', value: 80, reset_value: 75, max_age_s: 60,
      },
    }],
  };
}

describe('reactive-eval (pure)', function () {
  it('hysteresis holds through a noisy SoC threshold instead of flapping', function () {
    const e = new Engine(socSpec());
    const at = (v, dtMs) => {
      e.updateSignal('site', 'soc_pct', v, T0 + dtMs);
      return e.evaluate(T0 + dtMs).active;
    };
    assert.strictEqual(at(79, 0), false, 'below the engage threshold: off');
    assert.strictEqual(at(81, 1000), true, 'engages above 80');
    assert.strictEqual(at(78, 2000), true, 'noise between reset and threshold HOLDS');
    assert.strictEqual(at(76, 3000), true, 'still holding above reset');
    assert.strictEqual(at(74, 4000), false, 'releases below reset_value 75');
    assert.strictEqual(at(78, 5000), false, 'dead band after release stays off');
  });

  it('a stale signal is unknown and NEVER starts', function () {
    const e = new Engine(socSpec());
    e.updateSignal('site', 'soc_pct', 95, T0);
    // 61 s later the 60-s freshness window has lapsed: unknown, not "95".
    const r = e.evaluate(T0 + 61000);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.anyUnknown, true);
  });

  it('a signal that goes stale WHILE active ends the run (after the off-delay)', function () {
    const e = new Engine(socSpec(10));
    e.updateSignal('site', 'soc_pct', 90, T0);
    assert.strictEqual(e.evaluate(T0).active, true);
    // Stale at +70 s: held through the 10-s off-delay, then honestly off.
    const held = e.evaluate(T0 + 70000);
    assert.strictEqual(held.active, true);
    assert.strictEqual(held.held, true);
    assert.strictEqual(e.evaluate(T0 + 70000 + 9000).active, true, 'still inside the delay');
    assert.strictEqual(e.evaluate(T0 + 70000 + 11000).active, false, 'delay elapsed: off');
    // And the hysteresis memory was dropped: a fresh in-dead-band value stays off.
    e.updateSignal('site', 'soc_pct', 78, T0 + 90000);
    assert.strictEqual(e.evaluate(T0 + 90000).active, false, 'stale dropped the sticky state');
  });

  it('precompiled windows: true inside, false between, UNKNOWN after the last (no restart)', function () {
    const windows = [
      ['2026-08-10T10:00:00Z', '2026-08-10T11:00:00Z'],
      ['2026-08-10T12:00:00Z', '2026-08-10T13:00:00Z'],
    ];
    assert.strictEqual(evalWindows(windows, Date.parse('2026-08-10T09:59:59Z')), FALSE);
    assert.strictEqual(evalWindows(windows, Date.parse('2026-08-10T10:30:00Z')), TRUE);
    assert.strictEqual(evalWindows(windows, Date.parse('2026-08-10T11:30:00Z')), FALSE);
    assert.strictEqual(evalWindows(windows, Date.parse('2026-08-10T12:59:59Z')), TRUE);
    assert.strictEqual(evalWindows(windows, Date.parse('2026-08-10T13:00:00Z')), UNKNOWN,
      'after the last precomputed window the cloud answer has run out');

    // An engine driven purely by an expired window never (re)starts.
    const e = new Engine({
      command: 'on_off', off_delay_s: 0,
      requirements: [{ id: 'w', must_run: true, value: true, condition: { windows } }],
    });
    const r = e.evaluate(Date.parse('2026-08-10T14:00:00Z'));
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.anyUnknown, true);
  });

  it('the off-delay debounces a flickering availability signal', function () {
    const e = new Engine({
      command: 'setpoint_kw', off_delay_s: 15,
      requirements: [{
        id: 'connected', must_run: true, value: 11,
        condition: {
          signal: 'consumer.vehicle_connected', source: 'entity',
          channel: 'vehicle_connected', op: 'eq', value: 1, max_age_s: 300,
        },
      }],
    });
    e.updateSignal('entity', 'vehicle_connected', 1, T0);
    assert.strictEqual(e.evaluate(T0).active, true);
    // Blink off for 5 s: held (the wallbox does not stop mid-blink)...
    e.updateSignal('entity', 'vehicle_connected', 0, T0 + 1000);
    const heldR = e.evaluate(T0 + 1000);
    assert.deepStrictEqual([heldR.active, heldR.held, heldR.mustRun], [true, true, true]);
    // ...and the blink ending inside the window resumes seamlessly.
    e.updateSignal('entity', 'vehicle_connected', 1, T0 + 5000);
    const resumed = e.evaluate(T0 + 5000);
    assert.deepStrictEqual([resumed.active, resumed.held], [true, false]);
    // A real disconnect ends stably after the delay.
    e.updateSignal('entity', 'vehicle_connected', 0, T0 + 10000);
    assert.strictEqual(e.evaluate(T0 + 10000).active, true, 'held');
    assert.strictEqual(e.evaluate(T0 + 26000).active, false, 'ended after 15 s');
    assert.strictEqual(e.evaluate(T0 + 60000).active, false, 'stays off');
  });

  it('merges active requirements: highest value wins, must_run from ANY active one', function () {
    const e = new Engine({
      command: 'setpoint_kw', off_delay_s: 0,
      requirements: [
        {
          id: 'a', must_run: false, value: 4.2,
          condition: { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct', op: 'gt', value: 80, max_age_s: 60 },
        },
        {
          id: 'b', must_run: true, value: 11,
          condition: { signal: 'consumer.vehicle_connected', source: 'entity', channel: 'vehicle_connected', op: 'eq', value: 1, max_age_s: 60 },
        },
      ],
    });
    e.updateSignal('site', 'soc_pct', 90, T0);
    e.updateSignal('entity', 'vehicle_connected', 1, T0);
    const r = e.evaluate(T0);
    assert.deepStrictEqual([r.active, r.value, r.mustRun], [true, 11, true]);
    assert.deepStrictEqual(r.requirementIds, ['a', 'b']);
    // Only the optional one active -> no override claim.
    e.updateSignal('entity', 'vehicle_connected', 0, T0 + 1000);
    const r2 = e.evaluate(T0 + 1000);
    assert.deepStrictEqual([r2.active, r2.value, r2.mustRun], [true, 4.2, false]);
  });

  it('Kleene logic: unknown poisons AND, TRUE wins OR', function () {
    assert.strictEqual(kleeneAll([TRUE, UNKNOWN]), UNKNOWN);
    assert.strictEqual(kleeneAll([FALSE, UNKNOWN]), FALSE);
    assert.strictEqual(kleeneAny([TRUE, UNKNOWN]), TRUE);
    assert.strictEqual(kleeneAny([FALSE, UNKNOWN]), UNKNOWN);

    // AND of a fresh local signal with an UNKNOWN (expired) window never starts.
    const e = new Engine({
      command: 'on_off', off_delay_s: 0,
      requirements: [{
        id: 'mixed', must_run: true, value: true,
        condition: {
          all: [
            { signal: 'storage.soc_pct', source: 'site', channel: 'soc_pct', op: 'gt', value: 80, max_age_s: 60 },
            { windows: [['2026-08-09T10:00:00Z', '2026-08-09T11:00:00Z']] },
          ],
        },
      }],
    });
    e.updateSignal('site', 'soc_pct', 95, T0);
    const r = e.evaluate(T0);
    assert.strictEqual(r.active, false);
    assert.strictEqual(r.anyUnknown, true);
  });

  it('site signal mapping: surplus needs BOTH pv and load, never a fabricated 0', function () {
    assert.deepStrictEqual(vpConsumerPolicy.siteSignals({ pv_power_kw: 5, load_kw: 2, soc_pct: 50, power_kw: -3 }),
      { soc_pct: 50, grid_power_kw: -3, pv_surplus_kw: 3 });
    assert.deepStrictEqual(vpConsumerPolicy.siteSignals({ pv_power_kw: 5 }), {});
    assert.deepStrictEqual(vpConsumerPolicy.siteSignals({ load_kw: 2, soc_pct: 'kaputt' }), {});
    assert.deepStrictEqual(vpConsumerPolicy.entitySignals('wb', {
      schema_version: '1.0', entity_id: 'wb', channels: { vehicle_connected: 1, power_kw: 3.6, mode: 'x' },
    }), { vehicle_connected: 1, power_kw: 3.6 });
    assert.deepStrictEqual(vpConsumerPolicy.entitySignals('wb', {
      schema_version: '1.0', entity_id: 'other', channels: { vehicle_connected: 1 },
    }), {}, 'identity rule: a foreign entity payload updates nothing');
  });
});

describe('vp-consumer-policy against a local-bus stand-in', function () {
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

  function nodeConfig(overrides) {
    return Object.assign({
      id: 'cp1',
      type: 'vp-consumer-policy',
      core: 'core1',
      entity: 'wallbox-1',
      command: 'setpoint_kw',
      ttl_s: 45,
      renew_s: 15,
      off_delay_s: 0,
      requirements: [{
        id: 'charge-when-connected',
        must_run: true,
        value: 11,
        condition: {
          signal: 'consumer.vehicle_connected', source: 'entity',
          channel: 'vehicle_connected', op: 'eq', value: 1, max_age_s: 60,
        },
      }],
      flowId: 'b58a3c21-7e90-4d12-a345-6789abcdef02',
      flowVersion: 3,
      nodeId: 'reaktiv',
    }, overrides || {});
  }

  function coreFlow(nodes) {
    return [
      { id: 'core1', type: 'vp-core', name: 'test-core', host: '127.0.0.1', port: String(port) },
    ].concat(nodes);
  }

  it('vehicle connected -> a must_run desired with override; trigger input renews it', function (done) {
    const seen = [];
    broker.subscribe('edge/entities/wallbox-1/desired', function (packet, cb) {
      cb();
      seen.push(JSON.parse(packet.payload.toString()));
      if (seen.length === 2) {
        try {
          const m = seen[0];
          assert.strictEqual(m.schema_version, '1.0');
          assert.strictEqual(m.entity_id, 'wallbox-1');
          assert.strictEqual(m.priority, 'flow');
          assert.strictEqual(m.override, true, 'must_run stamps the D-5 override');
          assert.deepStrictEqual(m.command, { type: 'setpoint_kw', value: 11 });
          assert.strictEqual(m.ttl_s, 45);
          assert.strictEqual(m.source.kind, 'flow');
          assert.strictEqual(m.source.node_id, 'reaktiv');
          // Renewal: same standing wish, same request_id (TTL refresh, §5).
          assert.strictEqual(seen[1].request_id, m.request_id);
          done();
        } catch (e) {
          done(e);
        }
      }
    }, function () {});

    helper.load([vpCore, vpConsumerPolicy], coreFlow([nodeConfig()]), function () {
      const cp1 = helper.getNode('cp1');
      setTimeout(function () {
        const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
        pub.on('connect', function () {
          pub.publish('edge/entities/wallbox-1/telemetry', JSON.stringify({
            schema_version: '1.0', entity_id: 'wallbox-1',
            channels: { vehicle_connected: 1 },
          }), { qos: 1 }, function () {
            // The compiled interval trigger renews the standing wish.
            setTimeout(function () {
              cp1.receive({});
              pub.end();
            }, 200);
          });
        });
      }, 300);
    });
  });

  it('a disconnected/absent vehicle never starts: no desired is published', function (done) {
    let published = 0;
    broker.subscribe('edge/entities/wallbox-1/desired', function (packet, cb) {
      cb();
      published++;
    }, function () {});

    helper.load([vpCore, vpConsumerPolicy], coreFlow([nodeConfig()]), function () {
      const cp1 = helper.getNode('cp1');
      setTimeout(function () {
        const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
        pub.on('connect', function () {
          // vehicle_connected: 0 -> condition false; then a trigger tick with
          // NO signal at all -> unknown. Neither may publish.
          pub.publish('edge/entities/wallbox-1/telemetry', JSON.stringify({
            schema_version: '1.0', entity_id: 'wallbox-1',
            channels: { vehicle_connected: 0 },
          }), { qos: 1 }, function () {
            cp1.receive({});
            setTimeout(function () {
              try {
                assert.strictEqual(published, 0, 'unknown/false never publishes a wish');
                pub.end();
                done();
              } catch (e) {
                done(e);
              }
            }, 400);
          });
        });
      }, 300);
    });
  });
});
