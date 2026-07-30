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
const vpVerbraucher = require('../nodes/vp-verbraucher.js');
const vpTestRequest = require('../nodes/vp-test-request.js');
const vpTestResult = require('../nodes/vp-test-result.js');
const vpRegisterRaw = require('../nodes/vp-register-raw.js');
const vpRegisterWant = require('../nodes/vp-register-want.js');

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

  it('vp-telemetrie forwards battery_power_kw only alongside real measurement channels', function () {
    // The measured battery power (+ charge / - discharge) rides along on the
    // local bus for the core's house-load balance with a Netz meter...
    const shaped = vpTelemetrie.shape({ power_kw: -43.6, pv_power_kw: 35, battery_power_kw: -8.5 });
    assert.deepStrictEqual(shaped, { power_kw: -43.6, pv_power_kw: 35, battery_power_kw: -8.5 });
    // ...but a battery-only payload is not a publishable reading,
    assert.strictEqual(vpTelemetrie.shape({ battery_power_kw: -8.5 }), null);
    // and junk stays absent, never fabricated.
    const junk = vpTelemetrie.shape({ load_kw: 3, battery_power_kw: NaN });
    assert.deepStrictEqual(junk, { load_kw: 3 });
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

  // vp-sollwert must PASS THE WHOLE COMMAND THROUGH, never a field whitelist:
  // the control gate downstream reads control_enabled AND device_certified (the
  // per-device First-Light grant) off msg.setpoint. A whitelist here would strip
  // the grant silently and the Fahrplan would go read-only again with no error
  // anywhere - the same class of bug as the unpublished invert_batt_sign.
  it('vp-sollwert passes the WHOLE command through (no field whitelist)', function () {
    const cmd = {
      battery_setpoint_kw: -20,
      source: 'schedule',
      slot_start: '2026-07-27T19:45:00Z',
      ts: '2026-07-27T19:45:03Z',
      control_enabled: true,
      device_certified: true,
      grid_charge_allowed: false,
      soc_min_pct: 20,
      soc_max_pct: 95,
    };
    const parsed = vpSollwert.parse(Buffer.from(JSON.stringify(cmd)));
    assert.deepStrictEqual(parsed.setpoint, cmd, 'every field reaches the control gate');
    assert.strictEqual(parsed.setpoint.device_certified, true);
    assert.strictEqual(parsed.setpoint.control_enabled, true);
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

  it('vp-inverter-config threads control_tier through so controlRoute can dispatch on it', function () {
    // The core stamps control_tier onto the selection; parse() must carry it (a
    // Tier-2 brand reading over modbus_tcp cannot be dispatched otherwise).
    const t2 = vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', brand: 'sungrow', family: 'sungrow_sh',
      communication: 'modbus_tcp', control_tier: 2, connection: { ip: '10.0.0.9' },
    })));
    assert.strictEqual(t2.control_tier, 2);
    // absent / out-of-range -> undefined, so controlRoute falls back to inference.
    const none = vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', family: 'sunspec', communication: 'modbus_tcp', connection: { ip: 'y' },
    })));
    assert.strictEqual(none.control_tier, undefined);
    const bad = vpInverterConfig.parse(Buffer.from(JSON.stringify({
      schema_version: '1.0', family: 'sunspec', communication: 'modbus_tcp', control_tier: 9, connection: { ip: 'y' },
    })));
    assert.strictEqual(bad.control_tier, undefined);
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

  it('vp-control-readback carries a blocked (empty-because-wrong) readback for the card (Defect 2)', function () {
    // A control plan refused for a misconfiguration (unknown nameplate/scale) is
    // published with registers:[] + blocked/reason so the core can show the CAUSE on
    // the :8484 card instead of an eternal "warte auf Rueckmeldung".
    const blocked = vpControlReadback.shape({
      ts: '2026-07-27T12:00:00Z', family: 'hybrid_3p', source: 'schedule',
      control_path: 'remote', blocked: true,
      reason: 'Fernsteuerung: Nennleistung des Modells unbekannt',
      registers: [],
    });
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.reason, 'Fernsteuerung: Nennleistung des Modells unbekannt');
    // Nothing was written, so there is NO verdict - null, not a fabricated "false"
    // (the core ignores the verdict of a blocked readback either way and shows the
    // reason instead).
    assert.strictEqual(blocked.all_match, null, 'nothing was confirmed AND nothing deviated');
    assert.strictEqual(blocked.verify, 'unconfirmed');
    assert.deepStrictEqual(blocked.registers, []);
    // A NORMAL readback is unchanged: blocked false, reason ''.
    const normal = vpControlReadback.shape({
      registers: [{ role: 'battery_power', match: true, commanded_raw: 1, actual_raw: 1 }],
    });
    assert.strictEqual(normal.blocked, false);
    assert.strictEqual(normal.reason, '');
  });

  it('vp-control-readback surfaces the dual-controller signal, matching the canonical detector', function () {
    // The canonical, unit-tested detector lives in inverter-control-routing.js; the
    // readback node surfaces it on edge/control/readback. Cross-check that shape()'s
    // dual_controller equals the module for the SAME facts (no drift), and that a
    // mismatch while actively controlling flags a possible conflict.
    const control = require('../../inverter-control-routing.js');
    const activeMismatch = {
      family: 'hybrid_3p', control_enabled: true, certified: true,
      registers: [
        { role: 'battery_power', fc: 3, addr: 154, commanded_raw: 20000, actual_raw: 0, match: false },
        { role: 'tou_enable', fc: 3, addr: 146, commanded_raw: 255, actual_raw: 255, match: true },
      ],
    };
    const shaped = vpControlReadback.shape(activeMismatch);
    assert.strictEqual(shaped.dual_controller.possible_conflict, true, 'commanded register not held -> possible conflict');
    assert.strictEqual(shaped.dual_controller.only_controller_required, true);
    const canonical = control.dualControllerSignal({
      family: 'hybrid_3p', certified: true, controlEnabled: true, registerCount: 2,
      allMatch: false, mismatchRoles: ['battery_power'],
    });
    assert.strictEqual(shaped.dual_controller.possible_conflict, canonical.possibleConflict);
    assert.strictEqual(shaped.dual_controller.only_controller_required, canonical.onlyControllerRequired);
    assert.strictEqual(shaped.dual_controller.detector, canonical.detector);
    assert.strictEqual(shaped.dual_controller.reason, canonical.reason);

    // holding our command -> quiet; kill-switch off -> the rule is moot.
    const held = vpControlReadback.shape({ ...activeMismatch, registers: [{ role: 'x', match: true, commanded_raw: 1, actual_raw: 1 }] });
    assert.strictEqual(held.dual_controller.possible_conflict, false);
    const off = vpControlReadback.shape({ ...activeMismatch, control_enabled: false });
    assert.strictEqual(off.dual_controller.only_controller_required, false, 'not controlling -> no conflict claim');
    assert.strictEqual(off.dual_controller.possible_conflict, false);
  });

  it('vp-control-readback keeps an UNREAD register out of the mismatch verdict', function () {
    // The flap fix (live Pilsting, 2026-07-30): a register the inverter never
    // answered is 'unread' - it must not be accused of deviating, and the cycle then
    // has NO verdict (all_match null, the entity/curtail convention).
    const silent = vpControlReadback.shape({
      family: 'hybrid_3p', control_enabled: true, certified: true, control_path: 'remote',
      verify: 'unconfirmed',
      registers: [
        { role: 'remote_watchdog', addr: 1101, commanded_raw: 60, actual_raw: 60, match: true, verdict: 'held' },
        { role: 'remote_mode', addr: 1100, commanded_raw: 1, actual_raw: null, match: false, verdict: 'unread' },
      ],
    });
    assert.strictEqual(silent.all_match, null);
    assert.strictEqual(silent.verify, 'unconfirmed');
    assert.deepStrictEqual(silent.mismatch_roles, []);
    assert.deepStrictEqual(silent.unread_roles, ['remote_mode']);
    assert.strictEqual(silent.dual_controller.possible_conflict, false,
      'no second controller may be blamed for a read that never arrived');

    // A REAL deviation is unchanged: verdict mismatch -> named + conflict hint.
    const real = vpControlReadback.shape({
      family: 'hybrid_3p', control_enabled: true, certified: true, verify: 'mismatch',
      registers: [{ role: 'remote_mode', addr: 1100, commanded_raw: 1, actual_raw: 0, match: false, verdict: 'mismatch' }],
    });
    assert.strictEqual(real.all_match, false);
    assert.deepStrictEqual(real.mismatch_roles, ['remote_mode']);
    assert.strictEqual(real.dual_controller.possible_conflict, true);
  });

  it('vp-control-readback passes a CURTAIL readback through with its identity intact', function () {
    // Two payload FAMILIES ride edge/control/readback. The field whitelist used to
    // drop `curtail`/`source_id`/`unit_key`/`enforcement`, so the core could not
    // route it: the curtailment state never reached Snapshot.CurtailUnits AND every
    // curtailment cycle clobbered the battery control card with pv_limit registers
    // (observed live on the pilot, 2026-07-30 09:35:48Z).
    const shaped = vpControlReadback.shape({
      ts: '2026-07-30T09:35:48.782Z', curtail: true, source_id: 'src-fronius-1',
      unit_key: '192.168.0.5:502#1', label: 'Fronius Eco 1', family: 'fronius_sunspec',
      control_enabled: true, certified: false, mode: 'release', applied: false,
      cap_kw: null, rated_kw: 27, all_match: null,
      reason: 'Abregelung für diesen Wechselrichter noch nicht freigegeben',
      enforcement: { status: 'inactive', possible_override: false, reason: '', measured_kw: 4.2 },
      registers: [
        { role: 'pv_limit_pct', addr: 40232, commanded_raw: 10000, actual_raw: 10000, match: true },
        { role: 'pv_limit_enable', addr: 40236, commanded_raw: 0, actual_raw: 1, match: false },
      ],
    });
    assert.strictEqual(shaped.curtail, true, 'the discriminator the core routes on');
    assert.strictEqual(shaped.source_id, 'src-fronius-1');
    assert.strictEqual(shaped.unit_key, '192.168.0.5:502#1');
    assert.strictEqual(shaped.applied, false);
    assert.strictEqual(shaped.rated_kw, 27);
    assert.strictEqual(shaped.enforcement.measured_kw, 4.2);
    assert.strictEqual(shaped.all_match, null, 'the curtail executor owns its own verdict semantics');
    assert.strictEqual(shaped.registers.length, 2);
    // ... and it is refused when it carries no identity (the core could not place it).
    assert.strictEqual(vpControlReadback.shape({ curtail: true, registers: [] }), null);
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

  it('vp-verbraucher shapes a consumer load reading (load_kw only) and guards the topic', function () {
    assert.deepStrictEqual(vpVerbraucher.shape({ load_kw: 11.04, pv_power_kw: 3 }), { load_kw: 11.04 }); // drops non-load
    assert.deepStrictEqual(vpVerbraucher.shape({ load: 7 }), { load_kw: 7 }); // alias
    assert.deepStrictEqual(vpVerbraucher.shape({ load_kw: 0 }), { load_kw: 0 }); // a real 0 (idle) is valid, kept
    assert.strictEqual(vpVerbraucher.shape({ power_kw: 5 }), null); // no load -> nothing
    assert.strictEqual(vpVerbraucher.shape({ load_kw: Infinity }), null);
    assert.strictEqual(vpVerbraucher.topicFor('src-w'), 'edge/sources/src-w/telemetry');
    assert.strictEqual(vpVerbraucher.topicFor('a/b'), null); // same topic-injection guard
    assert.strictEqual(vpVerbraucher.topicFor('+'), null);
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

  it('vp-register-raw shapes the poll blocks and drops unusable payloads', function () {
    const shaped = vpRegisterRaw.shape({
      ts: '2026-07-28T10:00:00Z', unit: 2,
      blocks: [
        { start: 0x024c, regs: [500, 501] },
        { start: 0x0060, count: 4, learned: true, regs: [], error: 'Modbus-Ausnahme 0x2' },
        { start: 0x0100, regs: [] }, // no data AND no error -> nothing servable, dropped
        { start: -1, regs: [1] }, // invalid start dropped
      ],
    });
    assert.strictEqual(shaped.unit, 2);
    assert.strictEqual(shaped.ts, '2026-07-28T10:00:00Z');
    assert.strictEqual(shaped.blocks.length, 2);
    assert.deepStrictEqual(shaped.blocks[0], { start: 0x024c, regs: [500, 501] });
    assert.deepStrictEqual(shaped.blocks[1], { start: 0x0060, regs: [], learned: true, count: 4, error: 'Modbus-Ausnahme 0x2' });
    // A garbage unit falls back to 1; a missing/garbage ts is stamped fresh.
    const fallback = vpRegisterRaw.shape({ unit: 999, blocks: [{ start: 0, regs: [1] }] });
    assert.strictEqual(fallback.unit, 1);
    assert.ok(!isNaN(Date.parse(fallback.ts)));
    assert.strictEqual(vpRegisterRaw.shape({ blocks: [] }), null);
    assert.strictEqual(vpRegisterRaw.shape(null), null);
  });

  it('vp-register-want parses the retained want list incl. the cleared set', function () {
    const ok = vpRegisterWant.parse(Buffer.from(JSON.stringify({
      blocks: [{ start: 0x0060, count: 4 }, { start: 'x', count: 1 }, { start: 0xffff, count: 2 }],
    })));
    // garbage + beyond-address-space entries dropped, valid one kept
    assert.deepStrictEqual(ok, { blocks: [{ start: 0x0060, count: 4 }] });
    // an empty/cleared retained payload means "no learned blocks" (mirror off)
    assert.deepStrictEqual(vpRegisterWant.parse(Buffer.alloc(0)), { blocks: [] });
    assert.deepStrictEqual(vpRegisterWant.parse(null), { blocks: [] });
    assert.strictEqual(vpRegisterWant.parse(Buffer.from('kaputt')), null);
    assert.strictEqual(vpRegisterWant.parse(Buffer.from('{"no":"blocks"}')), null);
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

  it('vp-register-raw publishes the poll blocks RETAINED on edge/registers/raw', function (done) {
    const flow = coreFlow([
      { id: 'rr1', type: 'vp-register-raw', core: 'core1' },
    ]);
    broker.subscribe('edge/registers/raw', function (packet, cb) {
      cb();
      const m = JSON.parse(packet.payload.toString());
      try {
        assert.strictEqual(packet.retain, true, 'the mirror needs the LAST blocks after a core restart');
        assert.strictEqual(m.unit, 1);
        assert.deepStrictEqual(m.blocks, [{ start: 588, regs: [500, 501] }]);
        done();
      } catch (e) {
        done(e);
      }
    }, function () {});
    helper.load([vpCore, vpRegisterRaw], flow, function () {
      const rr1 = helper.getNode('rr1');
      setTimeout(function () {
        rr1.receive({ payload: { ts: '2026-07-28T10:00:00Z', unit: 1, blocks: [{ start: 588, regs: [500, 501] }] } });
      }, 300);
    });
  });

  it('vp-register-want emits a want list already retained at connect time', function (done) {
    // Retain-on-connect: the core publishes the learned want set retained, so a
    // Node-RED that (re)joins the bus keeps polling learned blocks immediately.
    const pub = mqtt.connect('mqtt://127.0.0.1:' + port);
    pub.on('connect', function () {
      pub.publish('edge/registers/want', JSON.stringify({ blocks: [{ start: 96, count: 4 }] }), { retain: true, qos: 1 }, function () {
        pub.end();
        const flow = coreFlow([
          { id: 'rw1', type: 'vp-register-want', core: 'core1', wires: [['h1']] },
          { id: 'h1', type: 'helper' },
        ]);
        helper.load([vpCore, vpRegisterWant], flow, function () {
          const h1 = helper.getNode('h1');
          h1.on('input', function (msg) {
            try {
              assert.deepStrictEqual(msg.payload, { blocks: [{ start: 96, count: 4 }] });
              done();
            } catch (e) {
              done(e);
            }
          });
        });
      });
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
