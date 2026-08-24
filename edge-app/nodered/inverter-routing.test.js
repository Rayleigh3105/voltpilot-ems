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

// A valid retained fronius_solar_api config.
function froniusConfig(overrides = {}) {
  return Object.assign(
    {
      schema_version: '1.0',
      brand: 'fronius',
      label: 'Fronius · Fronius (Solar API)',
      family: 'fronius_solar_api',
      communication: 'fronius_solar_api',
      connection: { ip: '192.168.0.20', port: 80, insecure_tls: false, invert_grid_sign: false },
      updated_at: '2026-07-09T12:00:00Z',
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
  // hybrid_3p reads the device-identity register 0x0000 (LV/HV scale class) plus
  // the 122-register measurement block starting at 0x024b - the Battery Voltage
  // (the soc_from_voltage estimate) sits one address BELOW the SoC, and the
  // block still reaches the External-CT grid pair 0x026B/0x02C4 (the connection
  // point) while staying under the 125-register fn-0x03 limit.
  assert.deepStrictEqual(r.reads, [
    { start: 0x0000, count: 0x0001 },
    { start: 0x024b, count: 0x007a },
  ]);
});

test('route: solarman_v5 defaults port, slave id and power_scale (auto=0)', () => {
  const cfg = solarmanConfig({ connection: { ip: '10.0.0.5', serial: '42' } });
  const r = routing.route(routing.parseConfig(cfg));
  assert.strictEqual(r.target, '10.0.0.5:8899');
  assert.strictEqual(r.connection.mb_slave_id, 1);
  // No power_scale set -> 0 = auto-detect the LV/HV scale from register 0x0000.
  assert.strictEqual(r.connection.power_scale, 0);
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

test('route: fronius_solar_api -> HTTP GET plan with the v1 PowerFlow url', () => {
  const r = routing.route(routing.parseConfig(froniusConfig()));
  assert.strictEqual(r.adapter, 'fronius_solar_api');
  assert.strictEqual(r.family, 'fronius_solar_api');
  assert.strictEqual(r.target, '192.168.0.20:80');
  assert.strictEqual(r.scheme, 'http');
  assert.strictEqual(r.url, 'http://192.168.0.20:80/solar_api/v1/GetPowerFlowRealtimeData.fcgi');
  assert.strictEqual(r.connection.insecure_tls, false);
  assert.strictEqual(r.connection.invert_grid_sign, false);
});

test('route: fronius defaults the port to 80', () => {
  const r = routing.route(routing.parseConfig(froniusConfig({ connection: { ip: '10.0.0.9' } })));
  assert.strictEqual(r.target, '10.0.0.9:80');
  assert.strictEqual(r.url, 'http://10.0.0.9:80/solar_api/v1/GetPowerFlowRealtimeData.fcgi');
});

test('route: fronius insecure_tls -> https scheme (GEN24 self-signed cert)', () => {
  const r = routing.route(routing.parseConfig(froniusConfig({ connection: { ip: '10.0.0.9', port: 443, insecure_tls: true } })));
  assert.strictEqual(r.scheme, 'https');
  assert.strictEqual(r.connection.insecure_tls, true);
  assert.strictEqual(r.url, 'https://10.0.0.9:443/solar_api/v1/GetPowerFlowRealtimeData.fcgi');
});

test('route: fronius carries the invert_grid_sign escape hatch', () => {
  const r = routing.route(routing.parseConfig(froniusConfig({ connection: { ip: '10.0.0.9', invert_grid_sign: true } })));
  assert.strictEqual(r.connection.invert_grid_sign, true);
});

test('route: fronius with an unknown family -> idle', () => {
  const r = routing.route({
    communication: 'fronius_solar_api',
    family: 'nonsense',
    connection: { ip: '10.0.0.9' },
  });
  assert.strictEqual(r.adapter, 'idle');
  assert.match(r.reason, /Fronius-Familie/);
});

// A valid retained fronius_sunspec config (real SunSpec over Modbus TCP).
function froniusSunspecConfig(overrides = {}) {
  return Object.assign(
    {
      schema_version: '1.0',
      brand: 'fronius_sunspec',
      label: 'Fronius (Modbus / SunSpec) · Fronius Eco 27.0-3-S',
      family: 'sunspec_live',
      communication: 'fronius_sunspec',
      connection: { ip: '192.168.210.40', port: 502, unit_id: 1, model_type: 'float', invert_grid_sign: false },
      updated_at: '2026-07-10T12:00:00Z',
    },
    overrides,
  );
}

test('route: fronius_sunspec -> sunspec_live discovery-walk plan', () => {
  const r = routing.route(routing.parseConfig(froniusSunspecConfig()));
  assert.strictEqual(r.adapter, 'sunspec_live');
  assert.strictEqual(r.profile, 'sunspec_live');
  assert.strictEqual(r.target, '192.168.210.40:502');
  assert.strictEqual(r.connection.unit_id, 1);
  assert.strictEqual(r.connection.model_type, 'float');
  assert.strictEqual(r.connection.invert_grid_sign, false);
  // No fixed register block - discovery is dynamic.
  assert.strictEqual(r.read, undefined);
});

test('route: fronius_sunspec defaults port 502, unit id 1, model_type auto', () => {
  const r = routing.route(routing.parseConfig(froniusSunspecConfig({ connection: { ip: '10.0.0.40' } })));
  assert.strictEqual(r.target, '10.0.0.40:502');
  assert.strictEqual(r.connection.unit_id, 1);
  assert.strictEqual(r.connection.model_type, 'auto');
});

test('route: fronius_sunspec carries a configured unit id + invert_grid_sign', () => {
  const r = routing.route(routing.parseConfig(froniusSunspecConfig({
    connection: { ip: '10.0.0.40', unit_id: 2, invert_grid_sign: true },
  })));
  assert.strictEqual(r.connection.unit_id, 2);
  assert.strictEqual(r.connection.invert_grid_sign, true);
});

test('parseConfig accepts the fronius_sunspec communication', () => {
  const sel = routing.parseConfig(froniusSunspecConfig());
  assert.ok(sel);
  assert.strictEqual(sel.communication, 'fronius_sunspec');
  assert.strictEqual(sel.family, 'sunspec_live');
});

test('route: null / no selection -> idle (stay idle-safe)', () => {
  assert.strictEqual(routing.route(null).adapter, 'idle');
  assert.strictEqual(routing.route(undefined).adapter, 'idle');
});

// --- KOSTAL PLENTICORE BI (kostal_modbus) ------------------------------------

const kostalDecode = require('./kostal/kostal-decode');

function kostalConfig(overrides = {}) {
  return Object.assign(
    {
      schema_version: '1.0',
      brand: 'kostal',
      label: 'KOSTAL · PLENTICORE BI 10/26',
      family: 'kostal_plenticore',
      communication: 'kostal_modbus',
      connection: { ip: '192.168.0.30', port: 1502, unit_id: 71, byte_order: 'auto' },
      updated_at: '2026-08-04T10:00:00Z',
    },
    overrides,
  );
}

test('parseConfig accepts a kostal_modbus selection', () => {
  const sel = routing.parseConfig(kostalConfig());
  assert.ok(sel);
  assert.strictEqual(sel.communication, routing.COMM_KOSTAL);
  assert.strictEqual(sel.family, 'kostal_plenticore');
});

test('route maps kostal_modbus onto the official read plan with vendor defaults 1502/71', () => {
  const plan = routing.route(routing.parseConfig(kostalConfig({
    connection: { ip: '192.168.0.30' }, // port/unit/byte order omitted -> defaults
  })));
  assert.strictEqual(plan.adapter, 'kostal_modbus');
  assert.strictEqual(plan.family, 'kostal_plenticore');
  assert.strictEqual(plan.target, '192.168.0.30:1502');
  assert.strictEqual(plan.connection.port, 1502);
  assert.strictEqual(plan.connection.unit_id, 71);
  assert.strictEqual(plan.connection.byte_order, 'auto');
  assert.strictEqual(plan.connection.invert_grid_sign, false);
  assert.strictEqual(plan.connection.invert_batt_sign, false);
  // The read plan is EXACTLY the decode module's (one truth for the blocks).
  assert.deepStrictEqual(plan.reads, kostalDecode.planReads({ family: 'kostal_plenticore' }));
});

test('route keeps explicit kostal connection values and gates unknown families idle-safe', () => {
  const plan = routing.route(routing.parseConfig(kostalConfig({
    connection: {
      ip: '10.0.0.9', port: 1503, unit_id: 3,
      byte_order: 'big', invert_grid_sign: true, invert_batt_sign: true,
    },
  })));
  assert.strictEqual(plan.target, '10.0.0.9:1503');
  assert.strictEqual(plan.connection.unit_id, 3);
  assert.strictEqual(plan.connection.byte_order, 'big');
  assert.strictEqual(plan.connection.invert_grid_sign, true);
  assert.strictEqual(plan.connection.invert_batt_sign, true);
  // Garbage byte order degrades to auto (never an unknown mode downstream).
  const auto = routing.route(routing.parseConfig(kostalConfig({
    connection: { ip: '10.0.0.9', byte_order: 'cdab' },
  })));
  assert.strictEqual(auto.connection.byte_order, 'auto');
  // Unknown family -> idle with a named reason, never a fabricated plan.
  const idle = routing.route(routing.parseConfig(kostalConfig({ family: 'hybrid_3p' })));
  assert.strictEqual(idle.adapter, 'idle');
  assert.match(idle.reason, /Kostal-Familie/);
});

// --- die GERÄTE-EIGENE Einspeisegrenze („Grenzen & Wächter" Stufe 0) ---------

test('exportLimitRegister kennt hybrid_3p und AUSDRÜCKLICH nicht hybrid_1p', () => {
  // hybrid_3p: „Grid Max Export power" 0x00E7, Skala 10 (Register = W / 10) -
  // in Herzogau live gelesen: raw 3300 = 33,0 kW.
  assert.deepStrictEqual(routing.exportLimitRegister('hybrid_3p'), { addr: 0x00e7, scale: 10 });
  // hybrid_1p: dort IST die Grenze „Max Sell Power" (0x00F5) - das Register,
  // das unser eigener Entlade-Hebel schreibt. Es zu lesen hieße, unseren
  // Befehl als „Grenze des Geräts" zu melden.
  assert.strictEqual(routing.exportLimitRegister('hybrid_1p'), null);
  for (const f of ['string', 'micro', 'sunspec', 'fronius_solar_api', 'kostal_plenticore', '']) {
    assert.strictEqual(routing.exportLimitRegister(f), null, f + ' hat kein belastbares Register');
  }
});

test('shouldReadExportLimit liest höchstens einmal am Tag - und beim Start', () => {
  const now = 1_800_000_000_000;
  // Noch nie versucht (frischer Kontext / nach einem Neustart): fällig.
  assert.strictEqual(routing.shouldReadExportLimit('hybrid_3p', undefined, now), true);
  assert.strictEqual(routing.shouldReadExportLimit('hybrid_3p', 0, now), true);
  assert.strictEqual(routing.shouldReadExportLimit('hybrid_3p', 'gestern', now), true);
  // Gerade versucht: nicht wieder.
  assert.strictEqual(routing.shouldReadExportLimit('hybrid_3p', now - 1000, now), false);
  assert.strictEqual(
    routing.shouldReadExportLimit('hybrid_3p', now - routing.EXPORT_LIMIT_INTERVAL_MS + 1, now),
    false,
  );
  // Einen Tag später wieder.
  assert.strictEqual(
    routing.shouldReadExportLimit('hybrid_3p', now - routing.EXPORT_LIMIT_INTERVAL_MS, now),
    true,
  );
  // Eine Uhr, die ZURÜCK gesprungen ist, darf das Lesen nicht einen Tag lang
  // aussperren (ein Pi ohne gepufferte Uhr springt beim ersten NTP-Abgleich).
  assert.strictEqual(routing.shouldReadExportLimit('hybrid_3p', now + 60_000, now), true);
  // Eine Familie ohne belastbares Register wird nie gelesen, egal wie alt.
  assert.strictEqual(routing.shouldReadExportLimit('hybrid_1p', undefined, now), false);
});

// --- the brand-neutral SunSpec id --------------------------------------------
//
// `sunspec_tcp` is the SAME read path as `fronius_sunspec` under an id that does
// not name a brand (the first user is KACO). The Fronius id is PERSISTED and must
// keep behaving byte-identically; the neutral one must reach the same adapter.
test('sunspec_tcp routes to the SunSpec-live adapter exactly like fronius_sunspec', () => {
  const conn = { ip: '192.168.0.9', port: 502, unit_id: 1, model_type: 'auto' };
  const kaco = routing.route(routing.parseConfig(JSON.stringify({
    schema_version: '1.0', brand: 'kaco', label: 'KACO · blueplanet 4.6 TL1',
    model: 'bp-4.6-tl1', family: 'sunspec_live', communication: 'sunspec_tcp',
    connection: conn,
  })));
  const fronius = routing.route(routing.parseConfig(JSON.stringify({
    schema_version: '1.0', brand: 'fronius', label: 'Fronius · Eco 27.0-3-S',
    model: 'fronius-eco-27-3-s', family: 'sunspec_live', communication: 'fronius_sunspec',
    connection: conn,
  })));
  assert.strictEqual(kaco.adapter, 'sunspec_live');
  assert.strictEqual(kaco.profile, routing.SUNSPEC_LIVE_PROFILE);
  // Same connection shape - Layer 1 sees ONE plan form for both ids.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(kaco)), JSON.parse(JSON.stringify(fronius)));
});

test('isSunSpecTcp names both ids and nothing else', () => {
  assert.strictEqual(routing.isSunSpecTcp('fronius_sunspec'), true);
  assert.strictEqual(routing.isSunSpecTcp('sunspec_tcp'), true);
  assert.strictEqual(routing.isSunSpecTcp('modbus_tcp'), false);
  assert.strictEqual(routing.isSunSpecTcp('kostal_modbus'), false);
  assert.strictEqual(routing.isSunSpecTcp(''), false);
});

test('an unknown communication is still refused (the alias widens nothing)', () => {
  assert.strictEqual(routing.parseConfig(JSON.stringify({
    schema_version: '1.0', family: 'sunspec_live', communication: 'sunspec_udp',
    connection: { ip: '192.168.0.9' },
  })), null);
});
