'use strict';

const test = require('node:test');
const assert = require('node:assert');

const routing = require('./inverter-routing');

// A valid retained solarman_v5 config (Deye hybrid_3p), as the core publishes.
function solarmanConfig(overrides = {}) {
  return Object.assign(
    {
      schema_version: '1.0',
      brand: 'deye',
      label: 'Deye · Hybrid, 3-phasig',
      family: 'hybrid_3p',
      communication: 'solarman_v5',
      connection: {
        ip: '192.168.0.28',
        port: 8899,
        serial: '2985159064',
        mb_slave_id: 1,
        invert_grid_sign: false,
        power_scale: 1,
      },
      updated_at: '2026-07-03T12:00:00Z',
    },
    overrides,
  );
}

// A valid retained modbus_tcp config (generic SunSpec).
function modbusConfig(overrides = {}) {
  return Object.assign(
    {
      schema_version: '1.0',
      brand: 'generic_modbus',
      label: 'Anderer Hersteller (Modbus / SunSpec) · SunSpec (Standard)',
      family: 'sunspec',
      communication: 'modbus_tcp',
      connection: { ip: 'edge-sim', port: 502, unit_id: 1, profile: 'sunspec' },
      updated_at: '2026-07-03T12:00:00Z',
    },
    overrides,
  );
}

test('parseConfig accepts a Buffer, a string and an object', () => {
  const obj = solarmanConfig();
  const fromObj = routing.parseConfig(obj);
  const fromStr = routing.parseConfig(JSON.stringify(obj));
  const fromBuf = routing.parseConfig(Buffer.from(JSON.stringify(obj)));
  assert.strictEqual(fromObj.family, 'hybrid_3p');
  assert.deepStrictEqual(fromStr, fromObj);
  assert.deepStrictEqual(fromBuf, fromObj);
});

test('parseConfig rejects malformed / wrong-version / incomplete payloads', () => {
  assert.strictEqual(routing.parseConfig('not json'), null);
  assert.strictEqual(routing.parseConfig(solarmanConfig({ schema_version: '2.0' })), null);
  assert.strictEqual(routing.parseConfig(solarmanConfig({ communication: 'carrier-pigeon' })), null);
  assert.strictEqual(routing.parseConfig(solarmanConfig({ family: '' })), null);
  assert.strictEqual(routing.parseConfig(solarmanConfig({ connection: {} })), null); // no ip
  assert.strictEqual(routing.parseConfig(null), null);
  assert.strictEqual(routing.parseConfig(42), null);
});

test('parseConfig ignores unknown future fields (forward compatible)', () => {
  const sel = routing.parseConfig(solarmanConfig({ some_future_field: 'x' }));
  assert.strictEqual(sel.family, 'hybrid_3p');
});

test('route: solarman_v5 -> Deye reader with family register plan', () => {
  const r = routing.route(routing.parseConfig(solarmanConfig()));
  assert.strictEqual(r.adapter, 'solarman_v5');
  assert.strictEqual(r.family, 'hybrid_3p');
  assert.strictEqual(r.target, '192.168.0.28:8899');
  assert.strictEqual(r.connection.serial, '2985159064');
  assert.strictEqual(r.connection.mb_slave_id, 1);
  assert.strictEqual(r.connection.power_scale, 1);
  // hybrid_3p reads one 88-register block starting at 0x024c.
  assert.deepStrictEqual(r.reads, [{ start: 0x024c, count: 0x0058 }]);
});

test('route: solarman_v5 defaults port, slave id and power_scale', () => {
  const cfg = solarmanConfig({ connection: { ip: '10.0.0.5', serial: '42' } });
  const r = routing.route(routing.parseConfig(cfg));
  assert.strictEqual(r.target, '10.0.0.5:8899');
  assert.strictEqual(r.connection.mb_slave_id, 1);
  assert.strictEqual(r.connection.power_scale, 1);
});

test('route: solarman_v5 carries invert_grid_sign and power_scale=10', () => {
  const cfg = solarmanConfig({
    connection: { ip: '10.0.0.5', serial: '42', invert_grid_sign: true, power_scale: 10 },
  });
  const r = routing.route(routing.parseConfig(cfg));
  assert.strictEqual(r.connection.invert_grid_sign, true);
  assert.strictEqual(r.connection.power_scale, 10);
});

test('route: solarman_v5 without a logger serial -> idle', () => {
  const cfg = solarmanConfig({ connection: { ip: '10.0.0.5', serial: '' } });
  const r = routing.route(routing.parseConfig(cfg));
  assert.strictEqual(r.adapter, 'idle');
  assert.match(r.reason, /Seriennummer/);
});

test('route: solarman_v5 with an unknown family -> idle', () => {
  // parseConfig accepts any non-empty family; route gates on the known set.
  const r = routing.route({
    communication: 'solarman_v5',
    family: 'nonsense',
    connection: { ip: '10.0.0.5', serial: '42' },
  });
  assert.strictEqual(r.adapter, 'idle');
  assert.match(r.reason, /Familie/);
});

test('route: modbus_tcp -> generic reader with the SunSpec profile block', () => {
  const r = routing.route(routing.parseConfig(modbusConfig()));
  assert.strictEqual(r.adapter, 'modbus_tcp');
  assert.strictEqual(r.profile, 'sunspec');
  assert.strictEqual(r.target, 'edge-sim:502');
  assert.strictEqual(r.connection.unit_id, 1);
  assert.deepStrictEqual(r.read, { fc: 0x03, addr: 0, count: 9 });
});

test('route: modbus_tcp defaults port and unit id', () => {
  const cfg = modbusConfig({ connection: { ip: '192.168.1.50', profile: 'sunspec' } });
  const r = routing.route(routing.parseConfig(cfg));
  assert.strictEqual(r.target, '192.168.1.50:502');
  assert.strictEqual(r.connection.unit_id, 1);
});

test('route: modbus_tcp with an unknown profile -> idle', () => {
  const r = routing.route({
    communication: 'modbus_tcp',
    family: 'weird-profile',
    connection: { ip: '192.168.1.50' },
  });
  assert.strictEqual(r.adapter, 'idle');
  assert.match(r.reason, /Profil/);
});

test('route: null / no selection -> idle (stay idle-safe)', () => {
  assert.strictEqual(routing.route(null).adapter, 'idle');
  assert.strictEqual(routing.route(undefined).adapter, 'idle');
});
