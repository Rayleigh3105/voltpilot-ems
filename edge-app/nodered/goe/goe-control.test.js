'use strict';

/**
 * Offline tests for the go-e Charger control adapter (the write/execution twin
 * of goe-api.js). Two layers:
 *   1. pure controlPlan/evalReadback mapping (charge / off / neutral / clamp /
 *      kill-switch / certification), no I/O;
 *   2. the makeExecutor(deps) HTTP set->readback loop against an in-process
 *      HTTP server (a stand-in go-e), proving a real write + readback match /
 *      mismatch and the honest error classification (unreachable / no_answer /
 *      invalid_response). No hardware, no network beyond loopback.
 *
 * Run: node --test edge-app/nodered/goe/
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const C = require('./goe-control.js');
const G = require('./goe-api.js');

// --- shared golden vectors (pinned against the Go executor twin) -------------

test('the pure mapping matches the shared golden vectors (Go twin lockstep)', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'goe-control-vectors.json'), 'utf8'));
  for (const c of vectors.cases) {
    const plan = C.controlPlan(c.config, c.command);
    assert.strictEqual(plan.mode, c.expect.mode, c.name + ' mode');
    assert.strictEqual(plan.frc, c.expect.frc, c.name + ' frc');
    assert.strictEqual(plan.amp, c.expect.amp, c.name + ' amp');
    assert.strictEqual(plan.psm, 'psm' in c.expect ? c.expect.psm : null, c.name + ' psm');
    assert.strictEqual(plan.holdCode, c.expect.hold || '', c.name + ' hold');
    assert.strictEqual(plan.controlEnabled, c.expect.control_enabled, c.name + ' control_enabled');
    assert.strictEqual(plan.writes.length, c.expect.writes_len, c.name + ' writes_len');
  }
});

// --- pure mapping: kW -> ampere (floored, guard-authoritative) --------------

test('currentForPower floors P/(phases*voltage): 11.04 kW @ 3x230V -> 16 A', () => {
  assert.strictEqual(C.currentForPower(11.04, 3, 230), 16); // 11040 / 690 = 16.0
  assert.strictEqual(C.currentForPower(3.68, 1, 230), 16); // 1-phase 3.68 kW -> 16 A
  // FLOOR, never round up (actual charge power must never exceed the setpoint).
  assert.strictEqual(C.currentForPower(11.0, 3, 230), 15); // 11000/690 = 15.94 -> 15
  assert.strictEqual(C.currentForPower(0, 3, 230), 0);
  assert.strictEqual(C.currentForPower(-5, 3, 230), 0);
  assert.strictEqual(C.currentForPower(NaN, 3, 230), 0);
});

// --- charge plan ------------------------------------------------------------

test('a charge command maps to frc=On + a clamped amp, and plans the writes', () => {
  const plan = C.controlPlan(
    { ip: '192.168.1.42', phases: 3, voltage: 230 },
    { setpoint_kw: 11.04, control_enabled: true },
  );
  assert.strictEqual(plan.mode, 'charge');
  assert.strictEqual(plan.frc, C.FRC.ON); // 2
  assert.strictEqual(plan.amp, 16);
  assert.strictEqual(plan.certified, true);
  assert.strictEqual(plan.controlEnabled, true);
  assert.deepStrictEqual(plan.writes, [
    { key: 'frc', value: 2, role: 'force_state' },
    { key: 'amp', value: 16, role: 'requested_current' },
  ]);
});

test('the requested current is clamped to the max band (never widened)', () => {
  const plan = C.controlPlan(
    { ip: '10.0.0.5', phases: 3, voltage: 230, max_current_a: 16 },
    { setpoint_kw: 22, control_enabled: true }, // 22 kW would be 31 A
  );
  assert.strictEqual(plan.amp, 16); // clamped to max 16 A
  assert.strictEqual(plan.frc, C.FRC.ON);
});

test('a 32 A capable install charges above 16 A when the band allows it', () => {
  const plan = C.controlPlan(
    { ip: '10.0.0.5', phases: 3, voltage: 230, max_current_a: 32 },
    { setpoint_kw: 15, control_enabled: true }, // 15000/690 = 21.7 -> 21 A
  );
  assert.strictEqual(plan.amp, 21);
});

// --- below-minimum / zero / off ---------------------------------------------

test('a below-minimum setpoint turns charging OFF (frc=Off), never a sub-min amp', () => {
  // 1 kW @ 3x230 -> 1.4 A, below the 6 A minimum.
  const plan = C.controlPlan(
    { ip: '192.168.1.42' },
    { setpoint_kw: 1.0, control_enabled: true },
  );
  assert.strictEqual(plan.mode, 'off');
  assert.strictEqual(plan.frc, C.FRC.OFF); // 1
  assert.strictEqual(plan.amp, null);
  assert.deepStrictEqual(plan.writes, [{ key: 'frc', value: 1, role: 'force_state' }]);
});

test('a zero setpoint turns charging OFF', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { setpoint_kw: 0, control_enabled: true });
  assert.strictEqual(plan.mode, 'off');
  assert.strictEqual(plan.frc, C.FRC.OFF);
});

test('on_off=false forces OFF regardless of a setpoint', () => {
  const plan = C.controlPlan(
    { ip: '1.2.3.4' },
    { setpoint_kw: 11, on_off: false, control_enabled: true },
  );
  assert.strictEqual(plan.mode, 'off');
  assert.strictEqual(plan.frc, C.FRC.OFF);
});

test('on_off=true with no setpoint charges at the allowed maximum current', () => {
  const plan = C.controlPlan(
    { ip: '1.2.3.4', max_current_a: 16 },
    { on_off: true, control_enabled: true },
  );
  assert.strictEqual(plan.mode, 'charge');
  assert.strictEqual(plan.amp, 16);
});

// --- fail-safe neutral on stale / loss --------------------------------------

test('a stale command yields frc=Neutral (hands control back, never a stuck current)', () => {
  const plan = C.controlPlan(
    { ip: '1.2.3.4' },
    { setpoint_kw: 11, stale: true, control_enabled: true },
  );
  assert.strictEqual(plan.mode, 'neutral');
  assert.strictEqual(plan.frc, C.FRC.NEUTRAL); // 0
  assert.strictEqual(plan.amp, null);
  assert.deepStrictEqual(plan.writes, [{ key: 'frc', value: 0, role: 'force_state' }]);
});

test('a command with nothing actionable (no setpoint, no on_off) is fail-safe neutral', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { control_enabled: true });
  assert.strictEqual(plan.mode, 'neutral');
  assert.strictEqual(plan.frc, C.FRC.NEUTRAL);
});

// --- kill-switch: control OFF by default ------------------------------------

test('control disabled (kill-switch) yields NO writes but keeps the readbacks', () => {
  const plan = C.controlPlan(
    { ip: '1.2.3.4' },
    { setpoint_kw: 11, control_enabled: false },
  );
  assert.strictEqual(plan.controlEnabled, false);
  assert.deepStrictEqual(plan.writes, []); // nothing written
  assert.ok(plan.readbacks.length >= 2, 'readbacks still run so the UI shows actual state');
  assert.match(plan.reason, /Not-Aus/);
  // the intended mapping is still computed (mode/frc) for display/tests.
  assert.strictEqual(plan.mode, 'charge');
  assert.strictEqual(plan.frc, C.FRC.ON);
});

test('a missing control_enabled defaults to OFF (fail-secure)', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { setpoint_kw: 11 });
  assert.strictEqual(plan.controlEnabled, false);
  assert.deepStrictEqual(plan.writes, []);
});

test('go-e is a CERTIFIED control family', () => {
  assert.strictEqual(C.CERTIFIED_CONTROL_FAMILIES.has('goe_http_api'), true);
});

// --- D4 phase switching (power ranges / psm) --------------------------------

test('powerRanges derives the two non-convex D4 ranges from the current band', () => {
  const r = C.powerRanges({ ip: '1.2.3.4', phase_switching: true });
  // 6..16 A @ 230 V -> 1p [1.38, 3.68], 3p [4.14, 11.04].
  assert.deepStrictEqual(r, [
    { phases: 1, min_kw: 1.38, max_kw: 3.68 },
    { phases: 3, min_kw: 4.14, max_kw: 11.04 },
  ]);
  // Without phase switching: ONE range at the configured phase count.
  const single = C.powerRanges({ ip: '1.2.3.4', phases: 3 });
  assert.deepStrictEqual(single, [{ phases: 3, min_kw: 4.14, max_kw: 11.04 }]);
});

test('desiredPhaseMode picks the range and snaps a gap wish DOWN', () => {
  const cfg = { ip: '1.2.3.4', phase_switching: true };
  assert.strictEqual(C.desiredPhaseMode(cfg, { setpoint_kw: 11 }), 3);
  assert.strictEqual(C.desiredPhaseMode(cfg, { setpoint_kw: 4.14 }), 3);
  assert.strictEqual(C.desiredPhaseMode(cfg, { setpoint_kw: 4.0 }), 1); // gap -> DOWN
  assert.strictEqual(C.desiredPhaseMode(cfg, { setpoint_kw: 2 }), 1);
  assert.strictEqual(C.desiredPhaseMode(cfg, { setpoint_kw: 1.0 }), 0); // below smallest
  assert.strictEqual(C.desiredPhaseMode(cfg, { on_off: true }), 3); // allowed maximum
  assert.strictEqual(C.desiredPhaseMode(cfg, { setpoint_kw: 11, stale: true }), 0);
  assert.strictEqual(C.desiredPhaseMode({ ip: '1.2.3.4' }, { setpoint_kw: 11 }), 0); // not switching
});

test('a paced switch holds restrict-only and names the honest reason', () => {
  const plan = C.controlPlan(
    { ip: '1.2.3.4', phase_switching: true },
    { setpoint_kw: 11, control_enabled: true, phase: { active: 1, switch_allowed: false } },
  );
  assert.strictEqual(plan.mode, 'charge');
  assert.strictEqual(plan.amp, 16); // held at the 1p max (3.68 kW), never more
  assert.strictEqual(plan.psm, null);
  assert.strictEqual(plan.holdCode, 'guard_phase_switch');
  assert.strictEqual(plan.holdReason, 'wartet - Phasenumschaltpause');
  assert.strictEqual(plan.reason, 'wartet - Phasenumschaltpause');
});

test('an allowed switch writes psm alongside frc/amp and converts for the NEW mode', () => {
  const plan = C.controlPlan(
    { ip: '1.2.3.4', phase_switching: true },
    { setpoint_kw: 11, control_enabled: true, phase: { active: 1, switch_allowed: true } },
  );
  assert.strictEqual(plan.psm, C.PSM.FORCE_3);
  assert.strictEqual(plan.amp, 15); // 11 kW @ 3x230 floored
  assert.deepStrictEqual(plan.writes.map((w) => w.key).sort(), ['amp', 'frc', 'psm']);
  const psmRb = plan.readbacks.find((rb) => rb.key === 'psm');
  assert.strictEqual(psmRb.expect, C.PSM.FORCE_3);
});

test('evalReadback asserts a written psm and surfaces the phase position', () => {
  const plan = C.controlPlan(
    { ip: '1.2.3.4', phase_switching: true },
    { setpoint_kw: 11, control_enabled: true, phase: { active: 1, switch_allowed: true } },
  );
  const ok = C.evalReadback(plan, statusEcho(2, 15, { psm: 2, pnp: 3 }));
  assert.strictEqual(ok.all_match, true);
  assert.strictEqual(ok.phase_switch_mode, 2);
  assert.strictEqual(ok.phases_in_use, 3);
  // The charger refusing the switch is a MISMATCH, never a silent success.
  const bad = C.evalReadback(plan, statusEcho(2, 15, { psm: 1, pnp: 1 }));
  assert.strictEqual(bad.all_match, false);
  const psmReg = bad.registers.find((r) => r.key === 'psm');
  assert.strictEqual(psmReg.match, false);
});

// --- idle / invalid config --------------------------------------------------

test('no ip -> idle plan (invalid), no writes/readbacks', () => {
  const plan = C.controlPlan({}, { setpoint_kw: 11, control_enabled: true });
  assert.strictEqual(plan.mode, 'idle');
  assert.deepStrictEqual(plan.writes, []);
  assert.deepStrictEqual(plan.readbacks, []);
});

// --- URLs -------------------------------------------------------------------

test('setUrl builds /api/set?frc=..&amp=.. and statusUrl the filtered /api/status', () => {
  const writes = [{ key: 'frc', value: 2 }, { key: 'amp', value: 16 }];
  assert.strictEqual(C.setUrl('192.168.1.42', 0, writes), 'http://192.168.1.42/api/set?frc=2&amp=16');
  assert.strictEqual(C.setUrl('goe.local', 8080, writes), 'http://goe.local:8080/api/set?frc=2&amp=16');
  assert.strictEqual(C.setUrl('x', 0, []), null);
  assert.strictEqual(C.statusUrl('192.168.1.42', 0), 'http://192.168.1.42/api/status?filter=frc,amp,psm,pnp,acu,car,nrg,alw');
});

test('the readback nrg total-power index matches the read driver (no drift)', () => {
  assert.strictEqual(C.NRG_TOTAL_POWER_IDX, G.NRG_TOTAL_POWER_IDX);
});

// --- evalReadback: commanded-vs-actual match --------------------------------

function statusEcho(frc, amp, extra) {
  return Object.assign(
    { frc, amp, car: 2, alw: true, acu: amp,
      nrg: [230, 230, 230, 0, amp, amp, amp, 0, 0, 0, 0, amp * 3 * 230, 0, 0, 0, 0] },
    extra || {},
  );
}

test('evalReadback confirms a matching set (all_match true) + surfaces state', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4', phases: 3, voltage: 230 }, { setpoint_kw: 11.04, control_enabled: true });
  const v = C.evalReadback(plan, statusEcho(2, 16));
  assert.strictEqual(v.all_match, true);
  assert.deepStrictEqual(v.registers.map((r) => r.key), ['frc', 'amp']);
  assert.ok(v.registers.every((r) => r.match));
  assert.strictEqual(v.car, 'charging');
  assert.strictEqual(v.charging, true);
  assert.strictEqual(v.power_kw, 11.04); // nrg[11] = 16*3*230 = 11040 W
  assert.strictEqual(v.allowed_current, 16);
  assert.strictEqual(v.allowed, true);
});

test('evalReadback flags a mismatch when the wallbox did not adopt the command', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { setpoint_kw: 11.04, control_enabled: true });
  // charger reports frc still Neutral (0) and amp 6 - it did not take the set.
  const v = C.evalReadback(plan, statusEcho(0, 6));
  assert.strictEqual(v.all_match, false);
  const frcReg = v.registers.find((r) => r.key === 'frc');
  assert.strictEqual(frcReg.commanded, 2);
  assert.strictEqual(frcReg.actual, 0);
  assert.strictEqual(frcReg.match, false);
});

test('evalReadback only asserts the keys we wrote (off writes only frc)', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { setpoint_kw: 0, control_enabled: true });
  const v = C.evalReadback(plan, statusEcho(1, 6));
  assert.strictEqual(v.all_match, true);
  assert.deepStrictEqual(v.registers.map((r) => r.key), ['frc']); // amp not asserted
});

test('evalReadback all_match is null on a readback-only (kill-switch) plan', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { setpoint_kw: 11, control_enabled: false });
  const v = C.evalReadback(plan, statusEcho(2, 16));
  assert.strictEqual(v.all_match, null); // nothing written -> nothing to match
  assert.strictEqual(v.registers.length, 0);
  assert.strictEqual(v.car, 'charging'); // state still surfaced
});

test('evalReadback treats a missing written-key field as a non-match (unconfirmed)', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { setpoint_kw: 11.04, control_enabled: true });
  const v = C.evalReadback(plan, { car: 2 }); // no frc/amp echoed
  assert.strictEqual(v.all_match, false);
  assert.strictEqual(v.power_kw, null); // absent, never fabricated 0
});

// --- makeExecutor(deps): the full set -> readback loop vs an in-process go-e -

// A minimal in-process go-e: /api/set applies frc/amp; /api/status echoes state.
function makeFakeGoe(opts) {
  opts = opts || {};
  const state = { frc: 0, amp: 6, car: 2, alw: true, acu: 16 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (opts.http500) { res.writeHead(500); res.end('nope'); return; }
    if (u.pathname === '/api/set') {
      const out = {};
      for (const [k, v] of u.searchParams) {
        if (opts.rejectKey === k) { out[k] = 'error: rejected'; continue; }
        const n = Number(v);
        if (k === 'frc') state.frc = opts.ignoreSet ? state.frc : n;
        if (k === 'amp') state.amp = opts.ignoreSet ? state.amp : n;
        out[k] = true;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    if (u.pathname === '/api/status') {
      const amp = state.amp;
      const charging = state.frc === 2;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        frc: state.frc, amp, car: charging ? 2 : 4, alw: state.alw, acu: state.acu,
        nrg: [230, 230, 230, 0, amp, amp, amp, 0, 0, 0, 0, charging ? amp * 3 * 230 : 0, 0, 0, 0, 0],
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('executor: a charge command sets frc/amp and the readback confirms it', async () => {
  const server = makeFakeGoe();
  const port = await listen(server);
  try {
    const execute = C.makeExecutor({ http, timeoutMs: 2000 });
    const res = await execute(
      { ip: '127.0.0.1', port, phases: 3, voltage: 230 },
      { setpoint_kw: 11.04, control_enabled: true },
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, true);
    assert.strictEqual(res.plan.frc, 2);
    assert.strictEqual(res.plan.amp, 16);
    assert.strictEqual(res.readback.all_match, true);
    assert.strictEqual(res.readback.charging, true);
    assert.strictEqual(res.readback.power_kw, 11.04);
  } finally {
    server.close();
  }
});

test('executor: an OFF command stops charging and reads back frc=Off', async () => {
  const server = makeFakeGoe();
  const port = await listen(server);
  try {
    const execute = C.makeExecutor({ http, timeoutMs: 2000 });
    const res = await execute({ ip: '127.0.0.1', port }, { setpoint_kw: 0, control_enabled: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.plan.mode, 'off');
    assert.strictEqual(res.readback.all_match, true);
    assert.strictEqual(res.readback.charging, false);
  } finally {
    server.close();
  }
});

test('executor: readback MISMATCH when the charger ignores the set', async () => {
  const server = makeFakeGoe({ ignoreSet: true }); // never applies frc/amp
  const port = await listen(server);
  try {
    const execute = C.makeExecutor({ http, timeoutMs: 2000 });
    const res = await execute({ ip: '127.0.0.1', port }, { setpoint_kw: 11.04, control_enabled: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, true);
    assert.strictEqual(res.readback.all_match, false); // stayed frc=0/amp=6
  } finally {
    server.close();
  }
});

test('executor: a go-e set error string on a key -> invalid_response', async () => {
  const server = makeFakeGoe({ rejectKey: 'amp' });
  const port = await listen(server);
  try {
    const execute = C.makeExecutor({ http, timeoutMs: 2000 });
    const res = await execute({ ip: '127.0.0.1', port }, { setpoint_kw: 11.04, control_enabled: true });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'invalid_response');
    assert.match(res.message, /amp/);
  } finally {
    server.close();
  }
});

test('executor: an HTTP 500 -> invalid_response', async () => {
  const server = makeFakeGoe({ http500: true });
  const port = await listen(server);
  try {
    const execute = C.makeExecutor({ http, timeoutMs: 2000 });
    const res = await execute({ ip: '127.0.0.1', port }, { setpoint_kw: 11.04, control_enabled: true });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'invalid_response');
  } finally {
    server.close();
  }
});

test('executor: an unreachable host -> unreachable (no crash)', async () => {
  const execute = C.makeExecutor({ http, timeoutMs: 1000 });
  // 127.0.0.1:1 - nothing listening -> ECONNREFUSED.
  const res = await execute({ ip: '127.0.0.1', port: 1 }, { setpoint_kw: 11.04, control_enabled: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, 'unreachable');
});

test('executor: kill-switch does the readback ONLY, never a set', async () => {
  const server = makeFakeGoe();
  const port = await listen(server);
  try {
    const execute = C.makeExecutor({ http, timeoutMs: 2000 });
    const res = await execute({ ip: '127.0.0.1', port }, { setpoint_kw: 11.04, control_enabled: false });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, false);
    assert.strictEqual(res.readback.all_match, null); // nothing written
    // the charger was never set: it stays frc=0 (not charging).
    assert.strictEqual(res.readback.charging, false);
  } finally {
    server.close();
  }
});

test('executor: an idle plan (no ip) -> invalid_request without any I/O', async () => {
  const execute = C.makeExecutor({ http, timeoutMs: 1000 });
  const res = await execute({}, { setpoint_kw: 11, control_enabled: true });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, 'invalid_request');
});

test('readbackPayload carries the v1 all_match shape the core consumes', () => {
  const plan = C.controlPlan({ ip: '1.2.3.4' }, { setpoint_kw: 11.04, control_enabled: true });
  const v = C.evalReadback(plan, statusEcho(2, 16));
  const p = C.readbackPayload('wallbox-1', '2026-07-20T10:00:00Z', plan, v);
  assert.strictEqual(p.schema_version, '1.0');
  assert.strictEqual(p.entity_id, 'wallbox-1');
  assert.strictEqual(p.all_match, true);
  assert.strictEqual(p.wrote, true);
  assert.strictEqual(p.adapter, 'goe_http_api');
});
