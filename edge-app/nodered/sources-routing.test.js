'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sr = require('./sources-routing');

// The retained edge/sources/config the core publishes (internal/sources.BusConfig).
function config(sources) {
  return { schema_version: '1.0', sources };
}

function modbusSource(overrides = {}) {
  return Object.assign(
    {
      id: 'src-abc',
      role: 'pv-generation',
      brand: 'generic_modbus',
      model: 'sunspec',
      family: 'sunspec',
      communication: 'modbus_tcp',
      connection: { ip: '192.168.0.70', port: 502, unit_id: 1, profile: 'sunspec' },
      interval_s: 5,
      capacity_kwp: 70,
    },
    overrides,
  );
}

test('parseSourcesConfig accepts a valid modbus source', () => {
  const list = sr.parseSourcesConfig(config([modbusSource()]));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'src-abc');
  assert.equal(list[0].role, 'pv-generation');
  assert.equal(list[0].capacity_kwp, 70);
  assert.equal(list[0].selection.communication, 'modbus_tcp');
  assert.equal(list[0].selection.family, 'sunspec');
});

test('parseSourcesConfig accepts a Buffer and a JSON string', () => {
  const raw = JSON.stringify(config([modbusSource()]));
  assert.equal(sr.parseSourcesConfig(raw).length, 1);
  assert.equal(sr.parseSourcesConfig(Buffer.from(raw)).length, 1);
});

test('parseSourcesConfig drops malformed / partial entries but keeps the good ones', () => {
  const list = sr.parseSourcesConfig(
    config([
      modbusSource(),
      modbusSource({ id: '', connection: { ip: '1.2.3.4' } }), // no id -> dropped
      modbusSource({ id: 'src-noip', connection: { ip: '' } }), // no ip -> dropped by parseConfig
      null,
      42,
    ]),
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'src-abc');
});

test('parseSourcesConfig returns [] for a cleared / wrong-version / non-array config', () => {
  assert.deepEqual(sr.parseSourcesConfig(''), []);
  assert.deepEqual(sr.parseSourcesConfig('{}'), []);
  assert.deepEqual(sr.parseSourcesConfig({ schema_version: '2.0', sources: [modbusSource()] }), []);
  assert.deepEqual(sr.parseSourcesConfig({ schema_version: '1.0', sources: 'nope' }), []);
  assert.deepEqual(sr.parseSourcesConfig({ schema_version: '1.0', sources: [] }), []);
});

test('planSources returns a modbus read plan for an Erzeuger source', () => {
  const plans = sr.planSources(sr.parseSourcesConfig(config([modbusSource()])));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-abc');
  assert.equal(plans[0].capacity_kwp, 70);
  assert.equal(plans[0].plan.adapter, 'modbus_tcp');
  assert.equal(plans[0].plan.connection.ip, '192.168.0.70');
  assert.ok(plans[0].plan.read && typeof plans[0].plan.read.addr === 'number');
});

test('planSources returns a modbus read plan for a Netz (grid-meter) source, carrying the role', () => {
  const plans = sr.planSources(sr.parseSourcesConfig(config([modbusSource({ id: 'src-netz', role: 'grid-meter' })])));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-netz');
  assert.equal(plans[0].role, 'grid-meter');
  assert.equal(plans[0].plan.adapter, 'modbus_tcp');
});

test('planSources ignores an unknown role (reserved vocabulary not read yet)', () => {
  const plans = sr.planSources(sr.parseSourcesConfig(config([modbusSource({ role: 'wallbox' })])));
  assert.equal(plans.length, 0);
});

test('planSources recognises a solarman source via routing (executor deferred)', () => {
  const solar = modbusSource({
    id: 'src-deye',
    brand: 'deye',
    family: 'hybrid_3p',
    communication: 'solarman_v5',
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 },
  });
  const plans = sr.planSources(sr.parseSourcesConfig(config([solar])));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].plan.adapter, 'solarman_v5');
});
