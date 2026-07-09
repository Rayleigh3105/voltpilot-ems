'use strict';

/**
 * Offline tests for the canonical Fronius Solar API decode module. No hardware,
 * no network: recorded GetPowerFlowRealtimeData.fcgi fixtures are fed through
 * the exact decoder the flow's function node copies.
 *
 * Run: node --test edge-app/nodered/fronius/
 */

const { test } = require('node:test');
const assert = require('node:assert');

const F = require('./solar-api.js');

// --- fixtures ----------------------------------------------------------------

// A single-hybrid GEN24 with a battery, exporting PV surplus. Sign conventions
// are the ones checked against pyfronius/HA (see solar-api.js header):
//   P_Grid -500 W  -> exporting 0.5 kW  (VoltPilot power_kw = -0.5)
//   P_PV   3000 W  -> pv 3.0 kW
//   P_Load -2500 W -> load 2.5 kW  (Fronius reports load negative when consuming)
//   P_Akku 1000 W  -> battery (calibration only, NEVER published)
//   SOC    57.5 %
function hybridPowerFlow(overrides) {
  const site = Object.assign(
    { P_Grid: -500, P_PV: 3000, P_Load: -2500, P_Akku: 1000, rel_Autonomy: 100, rel_SelfConsumption: 60 },
    (overrides && overrides.site) || {},
  );
  const inv = (overrides && overrides.inverters) || { 1: { DT: 1, P: 3000, SOC: 57.5 } };
  const head = (overrides && overrides.head) || { Status: { Code: 0, Reason: '', UserMessage: '' } };
  return { Head: head, Body: { Data: { Site: site, Inverters: inv } } };
}

// A PV-only Fronius (string/Symo) with a Smart Meter but NO battery: SOC key is
// simply absent, and there is no P_Akku.
function noBatteryPowerFlow(overrides) {
  const site = Object.assign(
    { P_Grid: 1500, P_PV: 2000, P_Load: -3500, P_Akku: null },
    (overrides && overrides.site) || {},
  );
  return { Head: { Status: { Code: 0 } }, Body: { Data: { Site: site, Inverters: { 1: { DT: 1, P: 2000 } } } } };
}

// --- happy path: hybrid, all channels ---------------------------------------

test('decodePowerFlow maps a hybrid PowerFlow onto all canonical channels', () => {
  const out = F.decodePowerFlow(hybridPowerFlow());
  assert.deepStrictEqual(out.reading, {
    power_kw: -0.5, // P_Grid -500 W, exporting (sign matches VoltPilot)
    pv_power_kw: 3, // P_PV 3000 W
    load_kw: 2.5, // -P_Load = 2500 W
    soc_pct: 57.5, // Inverters["1"].SOC
  });
  // battery power is read for calibration only, returned separately, never in reading.
  assert.strictEqual(out.battKw, 1);
  assert.strictEqual(out.reading.battery_kw, undefined);
  assert.strictEqual(out.reading.batt_kw, undefined);
});

test('grid sign matches VoltPilot: positive P_Grid = import', () => {
  const out = F.decodePowerFlow(hybridPowerFlow({ site: { P_Grid: 2200, P_PV: 3000, P_Load: -2500, P_Akku: 0 } }));
  assert.strictEqual(out.reading.power_kw, 2.2); // + import, no inversion
});

test('load is negated: Fronius consumes negative, VoltPilot load_kw is non-negative', () => {
  const out = F.decodePowerFlow(hybridPowerFlow({ site: { P_Grid: 0, P_PV: 0, P_Load: -4200, P_Akku: 0 } }));
  assert.strictEqual(out.reading.load_kw, 4.2);
});

test('invertGridSign escape hatch flips only the grid sign', () => {
  const json = hybridPowerFlow({ site: { P_Grid: -500, P_PV: 3000, P_Load: -2500, P_Akku: 1000 } });
  const out = F.decodePowerFlow(json, { invertGridSign: true });
  assert.strictEqual(out.reading.power_kw, 0.5); // -(-500)/1000
  assert.strictEqual(out.reading.pv_power_kw, 3); // untouched
  assert.strictEqual(out.reading.load_kw, 2.5); // untouched
});

// --- no battery: SoC absent, never fabricated -------------------------------

test('decodePowerFlow omits soc_pct when there is no battery (SOC key absent)', () => {
  const out = F.decodePowerFlow(noBatteryPowerFlow());
  assert.strictEqual('soc_pct' in out.reading, false, 'no fabricated SoC');
  assert.strictEqual(out.reading.power_kw, 1.5);
  assert.strictEqual(out.reading.pv_power_kw, 2);
  assert.strictEqual(out.reading.load_kw, 3.5);
  assert.strictEqual(out.battKw, null); // no P_Akku
});

test('decodePowerFlow drops an implausible SoC (0 / out of range), like Deye', () => {
  // exact 0 = empty-answer signature
  let out = F.decodePowerFlow(hybridPowerFlow({ inverters: { 1: { SOC: 0 } } }));
  assert.strictEqual('soc_pct' in out.reading, false);
  // > 100 garbage
  out = F.decodePowerFlow(hybridPowerFlow({ inverters: { 1: { SOC: 150 } } }));
  assert.strictEqual('soc_pct' in out.reading, false);
  // a valid mid-range SoC is kept
  out = F.decodePowerFlow(hybridPowerFlow({ inverters: { 1: { SOC: 42 } } }));
  assert.strictEqual(out.reading.soc_pct, 42);
});

// --- absent fields: omit, never fabricate 0 ---------------------------------

test('a null P_PV (inverter asleep at night) omits pv, keeps grid+load', () => {
  const out = F.decodePowerFlow(noBatteryPowerFlow({ site: { P_Grid: 800, P_PV: null, P_Load: -800, P_Akku: null } }));
  assert.strictEqual('pv_power_kw' in out.reading, false, 'no fabricated 0 PV');
  assert.strictEqual(out.reading.power_kw, 0.8);
  assert.strictEqual(out.reading.load_kw, 0.8);
});

test('P_PV is clamped to >= 0', () => {
  const out = F.decodePowerFlow(noBatteryPowerFlow({ site: { P_Grid: 0, P_PV: -30, P_Load: -100, P_Akku: null } }));
  assert.strictEqual(out.reading.pv_power_kw, 0);
});

test('an all-null Site (asleep, no meter) decodes to null -> idle-safe', () => {
  const out = F.decodePowerFlow(noBatteryPowerFlow({ site: { P_Grid: null, P_PV: null, P_Load: null, P_Akku: null } }));
  assert.strictEqual(out, null);
});

// --- error / garbage inputs fold into null (idle, never fabricate) ----------

test('garbage / malformed inputs decode to null', () => {
  assert.strictEqual(F.decodePowerFlow(null), null);
  assert.strictEqual(F.decodePowerFlow(undefined), null);
  assert.strictEqual(F.decodePowerFlow(42), null);
  assert.strictEqual(F.decodePowerFlow('not json'), null);
  assert.strictEqual(F.decodePowerFlow({}), null); // no Body
  assert.strictEqual(F.decodePowerFlow({ Body: {} }), null); // no Data
  assert.strictEqual(F.decodePowerFlow({ Body: { Data: {} } }), null); // no Site
});

test('a Fronius internal bad status (Head.Status.Code != 0) decodes to null', () => {
  const json = hybridPowerFlow({ head: { Status: { Code: 255, Reason: 'internal error' } } });
  assert.strictEqual(F.decodePowerFlow(json), null);
});

test('a good status (Code 0) or a missing Head still decodes', () => {
  assert.ok(F.decodePowerFlow(hybridPowerFlow({ head: { Status: { Code: 0 } } })));
  // Head absent entirely -> we do not fail; the Site presence is what matters.
  const noHead = { Body: { Data: { Site: { P_Grid: 100, P_PV: 500, P_Load: -600 }, Inverters: { 1: { SOC: 33 } } } } };
  const out = F.decodePowerFlow(noHead);
  assert.strictEqual(out.reading.soc_pct, 33);
});

// --- endpoint URL: v1 only ---------------------------------------------------

test('powerFlowUrl builds the v1 GetPowerFlowRealtimeData path', () => {
  assert.strictEqual(
    F.powerFlowUrl('http', '192.168.1.50', 80),
    'http://192.168.1.50:80/solar_api/v1/GetPowerFlowRealtimeData.fcgi',
  );
  // https for the GEN24 self-signed-cert firmware
  assert.strictEqual(
    F.powerFlowUrl('https', '10.0.0.7', 443),
    'https://10.0.0.7:443/solar_api/v1/GetPowerFlowRealtimeData.fcgi',
  );
  // any non-https scheme normalizes to http
  assert.ok(F.powerFlowUrl('ftp', 'h', 1).startsWith('http://'));
});

test('FAMILIES exposes exactly the one Fronius Solar API family', () => {
  assert.deepStrictEqual(Object.keys(F.FAMILIES), ['fronius_solar_api']);
});
