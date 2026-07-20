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

test('planSources returns a goe_http_api read plan for a consumer (go-e) source', () => {
  const goe = {
    id: 'src-goe',
    role: 'consumer',
    brand: 'go-e',
    model: 'goe_http_api',
    family: 'goe_http_api',
    communication: 'goe_http_api',
    connection: { ip: '192.168.1.42', port: 80 },
    interval_s: 10,
  };
  const plans = sr.planSources(sr.parseSourcesConfig(config([goe])));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-goe');
  assert.equal(plans[0].role, 'consumer');
  assert.equal(plans[0].plan.adapter, 'goe_http_api');
  assert.equal(plans[0].plan.connection.ip, '192.168.1.42');
  assert.equal(plans[0].plan.connection.port, 80);
  assert.equal(plans[0].plan.url, 'http://192.168.1.42:80/api/status?filter=nrg,car,alw,amp,wh');
});

test('planSources returns a sunspec_live read plan for a Fronius SunSpec Erzeuger source', () => {
  const fronius = modbusSource({
    id: 'src-eco',
    brand: 'fronius_sunspec',
    model: 'fronius-eco-27-3-s',
    family: 'sunspec_live',
    communication: 'fronius_sunspec',
    connection: { ip: '192.168.254.40', port: 502, unit_id: 1, model_type: 'auto', invert_grid_sign: false },
  });
  const plans = sr.planSources(sr.parseSourcesConfig(config([fronius])));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-eco');
  assert.equal(plans[0].role, 'pv-generation');
  assert.equal(plans[0].plan.adapter, 'sunspec_live');
  assert.equal(plans[0].plan.connection.ip, '192.168.254.40');
  assert.equal(plans[0].plan.connection.unit_id, 1);
  assert.equal(plans[0].plan.connection.model_type, 'auto');
});

test('planSources returns a solarman_v5 read plan for a Deye source, carrying serial + reads', () => {
  const solar = modbusSource({
    id: 'src-deye',
    brand: 'deye',
    family: 'hybrid_3p',
    communication: 'solarman_v5',
    connection: { ip: '192.168.0.28', port: 8899, serial: '2985159064', mb_slave_id: 1 },
  });
  const plans = sr.planSources(sr.parseSourcesConfig(config([solar])));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-deye');
  assert.equal(plans[0].plan.adapter, 'solarman_v5');
  assert.equal(plans[0].plan.family, 'hybrid_3p');
  assert.equal(plans[0].plan.connection.serial, '2985159064');
  assert.ok(Array.isArray(plans[0].plan.reads) && plans[0].plan.reads.length > 0);
});

test('planSources returns a fronius_solar_api read plan for a Fronius source', () => {
  const fronius = modbusSource({
    id: 'src-fr',
    brand: 'fronius',
    model: 'fronius_solar_api',
    family: 'fronius_solar_api',
    communication: 'fronius_solar_api',
    connection: { ip: '192.168.1.50', port: 80, invert_grid_sign: false },
  });
  const plans = sr.planSources(sr.parseSourcesConfig(config([fronius])));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'src-fr');
  assert.equal(plans[0].plan.adapter, 'fronius_solar_api');
  assert.equal(plans[0].plan.connection.ip, '192.168.1.50');
  assert.equal(plans[0].plan.url, 'http://192.168.1.50:80/solar_api/v1/GetPowerFlowRealtimeData.fcgi');
});
