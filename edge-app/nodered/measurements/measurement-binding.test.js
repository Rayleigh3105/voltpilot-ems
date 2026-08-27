'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const binding = require('./measurement-binding');

const ENTITY = '00000000-0000-0000-0000-0000000000a1';
const modbus = { source_kind:'modbus_holding' };
const ocpp = { source_kind:'ocpp_sampled_value' };
const source = (id, ip) => ({ id, communication:'modbus_tcp', connection:{ ip, port:502 } });

test('without a component the plan belongs to the device - the pre-3c behaviour', () => {
  // An older cloud sends no entity_id at all; that plant must stay byte-identical.
  assert.deepEqual(binding.resolveTarget({ point_key:'x', cadence_s:30 }, modbus, {}),
    { key:'primary', sourceId:null });
  assert.deepEqual(binding.resolveTarget({ point_key:'x', cadence_s:30 },
    modbus, { entities:{ [ENTITY]:{ entity_type:'producer', edge_source_id:'src-a' } },
      sources:{ 'src-a':source('src-a', '10.0.0.9') } }),
    { key:'primary', sourceId:null });
});

test('a pin resolves to the source it names, and the primary is a pin like any other', () => {
  const context = {
    entities: {
      [ENTITY]: { entity_type:'producer', edge_source_id:'src-a' },
      'e-inv': { entity_type:'producer', edge_source_id:'inverter' },
    },
    sources: { 'src-a':source('src-a', '10.0.0.9') },
  };
  assert.deepEqual(binding.resolveTarget({ entity_id:ENTITY }, modbus, context),
    { key:'source:src-a', sourceId:'src-a' });
  assert.deepEqual(binding.resolveTarget({ entity_id:'e-inv' }, modbus, context),
    { key:'primary', sourceId:null });
});

test('an unresolvable binding is REFUSED, never read against the primary', () => {
  const context = {
    entities: {
      'unpinned-wallbox': { entity_type:'wallbox', edge_source_id:'' },
      'gone': { entity_type:'producer', edge_source_id:'src-removed' },
      'shelly': { entity_type:'generic-load', edge_source_id:'src-shelly' },
    },
    sources: { 'src-a':source('src-a', '10.0.0.9') },
  };
  // Unknown component: the box has no registry entry to place it with.
  assert.equal(binding.resolveTarget({ entity_id:'never-pushed' }, modbus, context).reason,
    binding.REASON_UNBOUND);
  // A pin naming a source this box does not publish - a removed source, or the
  // core-owned Shelly transport that never reaches Node-RED.
  assert.equal(binding.resolveTarget({ entity_id:'gone' }, modbus, context).reason,
    binding.REASON_UNBOUND);
  assert.equal(binding.resolveTarget({ entity_id:'shelly' }, modbus, context).reason,
    binding.REASON_UNBOUND);
  // A non-composed component without any pin.
  assert.equal(binding.resolveTarget({ entity_id:'unpinned-wallbox' }, modbus, context).reason,
    binding.REASON_UNBOUND);
  // And a refusal never carries a target the caller could read anyway.
  assert.equal(binding.resolveTarget({ entity_id:'gone' }, modbus, context).key, undefined);
});

test('a platform-composed component without a pin IS the primary inverter', () => {
  // battery-hybrid / grid-meter / house-load carry no pin because they are the
  // primary's own channels (core internal/entities/compose.go composedType).
  // This is also exactly the pre-3c behaviour, so it can never be a regression.
  const context = { entities:{}, sources:{} };
  for (const type of binding.COMPOSED_TYPES) {
    context.entities['e-' + type] = { entity_type:type, edge_source_id:'' };
    assert.deepEqual(binding.resolveTarget({ entity_id:'e-' + type }, modbus, context),
      { key:'primary', sourceId:null }, type);
  }
});

test('the composed set is in lockstep with the core it was copied from', () => {
  const compose = fs.readFileSync(
    path.resolve(__dirname, '../../core/internal/entities/compose.go'), 'utf8');
  const block = compose.slice(compose.indexOf('func composedType('));
  const body = block.slice(0, block.indexOf('\n}'));
  // The Go switch names them via constants; assert every JS type is listed as
  // its Go constant AND that the switch lists exactly as many cases - a type
  // added there without being added here is refused (honest) but loses its
  // observation, and one added here without Go would be a wrong-device read.
  const names = { 'battery-hybrid':'TypeBatteryHybrid', 'grid-meter':'TypeGridMeter',
    'house-load':'TypeHouseLoad' };
  const listed = body.slice(body.indexOf('case ') + 'case '.length)
    .split(':')[0].split(',').map((x) => x.trim());
  assert.deepEqual(listed.sort(), binding.COMPOSED_TYPES.map((t) => names[t]).sort());
});

test('an OCPP measurand has no connection, so a binding neither selects nor refuses one', () => {
  // MeterValues arrive from the core over the local bus. A charge point is a
  // real component with no pin, so refusing it would silently disable OCPP.
  const context = { entities:{ 'cp':{ entity_type:'ev-charger', edge_source_id:'' } }, sources:{} };
  assert.deepEqual(binding.resolveTarget({ entity_id:'cp' }, ocpp, context),
    { key:'ocpp', sourceId:null });
  assert.deepEqual(binding.resolveTarget({ entity_id:'never-pushed' }, ocpp, context),
    { key:'ocpp', sourceId:null });
});

test('resolveDevice throws for a bound device this box does not publish', () => {
  const devices = { inverter:{ communication:'solarman_v5', connection:{ ip:'10.0.0.1', port:8899 } },
    sources:{ 'src-a':source('src-a', '10.0.0.9') } };
  assert.equal(binding.resolveDevice({ key:'primary', sourceId:null }, devices).connection.ip, '10.0.0.1');
  assert.equal(binding.resolveDevice({ key:'source:src-a', sourceId:'src-a' }, devices).connection.ip, '10.0.0.9');
  assert.throws(() => binding.resolveDevice({ key:'source:src-x', sourceId:'src-x' }, devices),
    /gebundenes Gerät nicht verfügbar/);
  assert.throws(() => binding.resolveDevice({ key:'primary', sourceId:null }, { sources:{} }),
    /keine Geräteverbindung/);
  // A source without a usable connection is as absent as a missing one.
  assert.throws(() => binding.resolveDevice({ key:'source:src-b', sourceId:'src-b' },
    { sources:{ 'src-b':{ id:'src-b', connection:{} } } }), /gebundenes Gerät nicht verfügbar/);
});

test('parseEntityConfig reads a registry descriptor and treats a clear as removal', () => {
  const raw = Buffer.from(JSON.stringify({ schema_version:'1.0', entity_id:ENTITY,
    entity_type:'producer', edge_source_id:'src-a', capabilities:{}, guards:{} }));
  assert.deepEqual(binding.parseEntityConfig(raw),
    { entity_id:ENTITY, entity_type:'producer', edge_source_id:'src-a' });
  // An entity WITHOUT a pin is a valid descriptor, not a parse failure.
  assert.deepEqual(binding.parseEntityConfig(Buffer.from(
    JSON.stringify({ entity_id:ENTITY, entity_type:'battery-hybrid' }))),
  { entity_id:ENTITY, entity_type:'battery-hybrid', edge_source_id:'' });
  assert.equal(binding.parseEntityConfig(Buffer.alloc(0)), null); // the core's clear
  assert.equal(binding.parseEntityConfig(Buffer.from('{')), null);
  assert.equal(binding.parseEntityConfig(Buffer.from('[]')), null);
  assert.equal(binding.parseEntityConfig(Buffer.from('{"entity_type":"producer"}')), null);
});

test('sourceMap keys the retained source array and drops unusable entries', () => {
  assert.deepEqual(Object.keys(binding.sourceMap([source('src-a','10.0.0.9'), null,
    { communication:'modbus_tcp' }, { id:'', connection:{} }])), ['src-a']);
  assert.deepEqual(binding.sourceMap(null), {});
});
