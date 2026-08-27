'use strict';

// The vp-measurements NODE wiring for Geraeteseite Stufe 3c: it must subscribe
// the two retained documents that carry the binding (the per-entity registry
// pin and the source list) and feed them into the plan. Driven through a tiny
// in-process RED/mqtt stand-in - no Node-RED runtime, no network, no device.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Runtime = require('./measurement-runtime');
const driver = require('./measurement-driver');
const planner = require('./measurement-planner');
const busArbiter = require('./shared-bus-arbiter');
const modbus = require('../vp-palette/lib/modbus-tcp');
const deye = require('../deye/solarman-v5');
const nodeModule = require('../vp-palette/nodes/vp-measurements');

const A = '00000000-0000-0000-0000-0000000000a1';

function harness(t) {
  const client = new EventEmitter();
  client.connected = true;
  client.subscribed = [];
  client.published = [];
  client.subscribe = (topics) => client.subscribed.push(...[].concat(topics));
  client.publish = (topic, payload) => client.published.push({ topic, payload:JSON.parse(payload) });
  const globals = { vpMeasurementRuntime:Runtime, vpMeasurementDriver:driver,
    vpMeasurementPlanner:planner, vpMeasurementModbus:modbus, vpMeasurementDeye:deye,
    vpSharedBusArbiter:busArbiter };
  const node = { warnings:[], statuses:[],
    status:(s) => node.statuses.push(s), warn:(w) => node.warnings.push(w),
    on:(event, fn) => { if (event === 'close') node.close = fn; },
    context:() => ({ global:{ get:(k) => globals[k] } }) };
  const RED = { nodes:{ createNode:() => {}, getNode:() => ({ client }),
    registerType:(_, fn) => { RED.factory = fn; } } };
  nodeModule(RED);
  RED.factory.call(node, { core:'core1' });
  // The node owns a 250 ms tick; without releasing it the runner never exits.
  if (t) t.after(() => new Promise((done) => node.close(done)));
  return { client, node };
}

const send = (client, topic, value) =>
  client.emit('message', topic, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));

const config = (selections) => ({ schema_version:'2.0', revision:3,
  catalog_version:driver.catalogDocument.catalog_version, selections });
// The source list drives an async reconcile (per-target SunSpec discovery runs
// before the re-apply), so an assertion about it must let that chain finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const status = (client) => (client.published
  .filter((m) => m.topic === 'edge/measurements/config-status').pop() || {}).payload;

test('the node subscribes the two documents that carry the binding', (t) => {
  const { client } = harness(t);
  assert.ok(client.subscribed.includes('edge/sources/config'));
  assert.ok(client.subscribed.includes('edge/entities/+/config'));
  // The pre-3c subscriptions are untouched.
  for (const topic of ['edge/measurements/config', 'edge/inverter/config', 'edge/setpoint']) {
    assert.ok(client.subscribed.includes(topic), topic);
  }
});

test('a component pinned to a reported source is accepted; an unknown one is refused', async (t) => {
  const { client } = harness(t);
  send(client, 'edge/inverter/config',
    { schema_version:'1.0', brand:'deye', family:'hybrid_1p', communication:'solarman_v5',
      connection:{ ip:'10.0.0.1', port:8899, serial:'1', mb_slave_id:1 } });
  send(client, 'edge/sources/config', { schema_version:'1.0', sources:[
    { id:'src-a', role:'pv-generation', brand:'generic_modbus', model:'m', family:'sunspec',
      communication:'modbus_tcp', connection:{ ip:'10.0.0.9', port:502, unit_id:1 } }] });
  send(client, 'edge/entities/' + A + '/config',
    { schema_version:'1.0', entity_id:A, entity_type:'producer', edge_source_id:'src-a' });
  await settle();

  send(client, 'edge/measurements/config', config([
    { point_key:'deye.hybrid_1p.battery.battery', cadence_s:30, entity_id:A },
    { point_key:'deye.hybrid_1p.battery.battery-voltage', cadence_s:30,
      entity_id:'00000000-0000-0000-0000-0000000000ff' },
  ]));
  const first = status(client);
  assert.deepEqual(first.accepted, ['deye.hybrid_1p.battery.battery']);
  assert.deepEqual(first.rejected,
    [{ point_key:'deye.hybrid_1p.battery.battery-voltage', reason:'binding_unavailable' }]);
});

test('a refusal heals itself when the missing document arrives', async (t) => {
  // The registry and the plan are two independent retained documents; whichever
  // lands second must re-apply, so a first honest refusal is never permanent.
  const { client } = harness(t);
  send(client, 'edge/inverter/config',
    { schema_version:'1.0', brand:'deye', family:'hybrid_1p', communication:'solarman_v5',
      connection:{ ip:'10.0.0.1', port:8899, serial:'1', mb_slave_id:1 } });
  send(client, 'edge/measurements/config',
    config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:30, entity_id:A }]));
  assert.deepEqual(status(client).rejected,
    [{ point_key:'deye.hybrid_1p.battery.battery', reason:'binding_unavailable' }]);

  send(client, 'edge/sources/config', { schema_version:'1.0', sources:[
    { id:'src-a', role:'pv-generation', brand:'deye', model:'m', family:'hybrid_1p',
      communication:'solarman_v5',
      connection:{ ip:'10.0.0.9', port:8899, serial:'2', mb_slave_id:1 } }] });
  send(client, 'edge/entities/' + A + '/config',
    { schema_version:'1.0', entity_id:A, entity_type:'producer', edge_source_id:'src-a' });
  await settle();
  const healed = status(client);
  assert.deepEqual(healed.accepted, ['deye.hybrid_1p.battery.battery']);
  assert.deepEqual(healed.rejected, []);
});

test('a removed component and an unusable source list never silently unbind', async (t) => {
  const { client, node } = harness(t);
  send(client, 'edge/inverter/config',
    { schema_version:'1.0', brand:'deye', family:'hybrid_1p', communication:'solarman_v5',
      connection:{ ip:'10.0.0.1', port:8899, serial:'1', mb_slave_id:1 } });
  send(client, 'edge/sources/config', { schema_version:'1.0', sources:[
    { id:'src-a', role:'pv-generation', brand:'deye', model:'m', family:'hybrid_1p',
      communication:'solarman_v5',
      connection:{ ip:'10.0.0.9', port:8899, serial:'2', mb_slave_id:1 } }] });
  send(client, 'edge/entities/' + A + '/config',
    { schema_version:'1.0', entity_id:A, entity_type:'producer', edge_source_id:'src-a' });
  send(client, 'edge/measurements/config',
    config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:30, entity_id:A }]));
  assert.deepEqual(status(client).accepted, ['deye.hybrid_1p.battery.battery']);

  // An unusable payload keeps the previous map - one malformed retained message
  // must not unbind every component of the plant.
  send(client, 'edge/sources/config', 'kaputt');
  await settle();
  assert.equal(node.warnings.length, 1);
  assert.deepEqual(status(client).accepted, ['deye.hybrid_1p.battery.battery']);

  // The core's empty payload IS "entity removed": the point loses its device
  // and must be refused, not read over the primary.
  client.emit('message', 'edge/entities/' + A + '/config', Buffer.alloc(0));
  await settle();
  assert.deepEqual(status(client).rejected,
    [{ point_key:'deye.hybrid_1p.battery.battery', reason:'binding_unavailable' }]);
});

test('a plan without any component is unchanged by what the box knows', (t) => {
  const { client } = harness(t);
  send(client, 'edge/inverter/config',
    { schema_version:'1.0', brand:'deye', family:'hybrid_1p', communication:'solarman_v5',
      connection:{ ip:'10.0.0.1', port:8899, serial:'1', mb_slave_id:1 } });
  send(client, 'edge/measurements/config',
    config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:30 }]));
  assert.deepEqual(status(client).accepted, ['deye.hybrid_1p.battery.battery']);
  assert.deepEqual(status(client).rejected, []);
});

test('a reconnect burst of entity configs produces ONE status, not one each', async (t) => {
  // Every retained document is replayed at once on (re)connect. Applying per
  // message would publish a status per component, and the core forwards each
  // one to the cloud - a status storm out of a normal reconnect.
  const { client } = harness(t);
  send(client, 'edge/inverter/config',
    { schema_version:'1.0', brand:'deye', family:'hybrid_1p', communication:'solarman_v5',
      connection:{ ip:'10.0.0.1', port:8899, serial:'1', mb_slave_id:1 } });
  send(client, 'edge/measurements/config',
    config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:30 }]));
  await settle();
  const before = client.published.filter((m) => m.topic === 'edge/measurements/config-status').length;

  for (let i = 0; i < 12; i++) {
    const id = '00000000-0000-0000-0000-00000000' + String(1000 + i);
    send(client, 'edge/entities/' + id + '/config',
      { schema_version:'1.0', entity_id:id, entity_type:'producer', edge_source_id:'src-' + i });
  }
  await settle();
  const after = client.published.filter((m) => m.topic === 'edge/measurements/config-status').length;
  assert.equal(after - before, 1, 'twelve registry descriptors must coalesce into one re-apply');
});
