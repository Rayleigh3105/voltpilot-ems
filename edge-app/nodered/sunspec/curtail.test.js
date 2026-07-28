'use strict';

/**
 * Offline tests for the fleet curtailment planner (sunspec/curtail.js): the
 * plant-cap split across two Fronius units incl. the uncontrollable Deye
 * share, the per-unit write-plan shape at DISCOVERED addresses (value +
 * revert timer before the enable), the release discipline, the two-gate
 * certification discipline (uncertified = planned-only), the bounded-test
 * bypass, and override detection by effect after the settle window.
 *
 * Run: node --test edge-app/nodered/sunspec/curtail.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const D = require('./model-discovery.js');
const C = require('./curtail.js');

// --- fixtures (the model-discovery.test.js image builder) --------------------

function buildImage(base, models) {
  const img = new Map();
  img.set(base, (D.SID >>> 16) & 0xffff);
  img.set(base + 1, D.SID & 0xffff);
  let addr = base + 2;
  for (const m of models) {
    const body = m.body || [];
    img.set(addr, m.id & 0xffff);
    img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  }
  img.set(addr, D.END_MODEL_ID);
  img.set(addr + 1, 0);
  return img;
}

function readerOver(img) {
  return (addr, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const w = img.get(addr + i);
      if (w === undefined) break;
      out.push(w);
    }
    return out;
  };
}

// A discovery fixture for one Fronius unit: Common + Nameplate(WRtg) +
// three-phase int+SF inverter + Immediate Controls (WMaxLimPct_SF = -2).
function discoveryFor(ratedKw) {
  const nameplate = new Array(26).fill(0);
  nameplate[D.M120.WRtg] = Math.round(ratedKw * 100) & 0xffff; // e.g. 2500
  nameplate[D.M120.WRtg_SF] = 1; // *10 -> W (2500 * 10 = 25000 W)
  const controls = new Array(D.M123.LENGTH).fill(0);
  controls[D.M123.WMaxLimPct_SF] = 0xfffe; // SF -2 -> register = pct * 100
  const img = buildImage(40000, [
    { id: 1, body: new Array(66).fill(0) },
    { id: D.MODEL.NAMEPLATE, body: nameplate },
    { id: 103, body: new Array(50).fill(0) },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controls },
  ]);
  return D.discover(readerOver(img), { base: 40000 });
}

// The Pilsting shape: two Fronius behind ONE IP with different unit ids.
const PLANS = [
  { id: 'src-fr1', role: 'pv-generation', adapter: 'sunspec_live', conn: { ip: '192.168.210.40', port: 502, unit_id: 1 } },
  { id: 'src-fr2', role: 'pv-generation', adapter: 'sunspec_live', conn: { ip: '192.168.210.40', port: 502, unit_id: 2 } },
];
const KEY1 = '192.168.210.40:502#1';
const KEY2 = '192.168.210.40:502#2';

const NOW = Date.parse('2026-07-28T12:00:00Z');

function setpoint(over) {
  return Object.assign({
    battery_setpoint_kw: 0,
    ts: new Date(NOW - 5000).toISOString(),
    pv_limit_kw: 30,
    curtail: {
      control_enabled: true,
      pv_uncontrolled_kw: 12, // the measured Deye share
      sources: [
        { id: 'src-fr1', certified: true, capacity_kwp: 25, label: 'Fronius WR 1' },
        { id: 'src-fr2', certified: true, capacity_kwp: 30, label: 'Fronius WR 2' },
      ],
    },
  }, over || {});
}

function fleet(over, discs) {
  return C.planFleetCurtailment({
    setpoint: setpoint(over),
    plans: PLANS,
    discoveries: discs !== undefined ? discs : { [KEY1]: discoveryFor(25), [KEY2]: discoveryFor(30) },
    readings: {},
    nowMs: NOW,
    disc: D,
  });
}

// --- the split ---------------------------------------------------------------

test('splitPlantCap subtracts the uncontrollable Deye share and splits proportional to rated', () => {
  const s = C.splitPlantCap({
    plantCapKw: 30, uncontrolledKw: 12,
    units: [{ id: 'a', ratedKw: 25 }, { id: 'b', ratedKw: 30 }],
  });
  assert.strictEqual(s.budgetKw, 18);
  // 18 * 25/55 and 18 * 30/55
  assert.ok(Math.abs(s.caps.a - 8.182) < 0.001);
  assert.ok(Math.abs(s.caps.b - 9.818) < 0.001);
  assert.ok(s.caps.a + s.caps.b <= s.budgetKw + 0.001);
});

test('splitPlantCap waterfalls a clamped unit\'s excess to the others, never above rated', () => {
  // Budget 40 over 10+30: proportional gives 10-rated unit 40/4=10 (clamped at
  // its rated 10); the remaining 30 goes to the 30-rated unit (its rated cap).
  const s = C.splitPlantCap({
    plantCapKw: 40, uncontrolledKw: 0,
    units: [{ id: 'small', ratedKw: 10 }, { id: 'big', ratedKw: 30 }],
  });
  assert.strictEqual(s.caps.small, 10);
  assert.strictEqual(s.caps.big, 30);
});

test('splitPlantCap floors the budget at 0 when the uncontrollable share overfills the cap', () => {
  const s = C.splitPlantCap({
    plantCapKw: 10, uncontrolledKw: 15,
    units: [{ id: 'a', ratedKw: 25 }],
  });
  assert.strictEqual(s.budgetKw, 0);
  assert.strictEqual(s.caps.a, 0);
});

// --- the fleet plan: write shape at discovered addresses ---------------------

test('fleet plan splits the plant cap across both units and writes at DISCOVERED addresses, value+revert before enable', () => {
  const f = fleet();
  assert.strictEqual(f.mode, 'apply');
  assert.strictEqual(f.budgetKw, 18);
  assert.strictEqual(f.units.length, 2);

  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  const u2 = f.units.find((u) => u.sourceId === 'src-fr2');
  // Rated comes from the DISCOVERED nameplate (25 / 30 kW).
  assert.strictEqual(u1.ratedKw, 25);
  assert.strictEqual(u2.ratedKw, 30);
  assert.ok(Math.abs(u1.capKw - 8.182) < 0.001);
  assert.ok(Math.abs(u2.capKw - 9.818) < 0.001);
  assert.strictEqual(u1.unitKey, KEY1);
  assert.strictEqual(u2.unitKey, KEY2);

  // Write order is safety-relevant: limit VALUE, then REVERT TIMER, then the
  // ENABLE strictly last - at the discovered Model-123 addresses.
  const d1 = discoveryFor(25);
  assert.strictEqual(u1.plan.writes.length, 3);
  assert.deepStrictEqual(u1.plan.writes.map((w) => w.role),
    ['pv_limit_pct', 'pv_limit_revert_tms', 'pv_limit_enable']);
  assert.strictEqual(u1.plan.writes[0].addr, d1.controls.wMaxLimPctAddr);
  assert.strictEqual(u1.plan.writes[1].addr, d1.controls.wMaxLimPctRvrtTmsAddr);
  assert.strictEqual(u1.plan.writes[2].addr, d1.controls.wMaxLimEnaAddr);
  // The native dead-man: 60 s revert, refreshed every setpoint tick.
  assert.strictEqual(u1.plan.writes[1].value, C.DEFAULT_RVRT_TMS);
  assert.strictEqual(u1.plan.writes[2].value, 1);
  // pct = cap/rated, register scaled by the discovered SF (-2 -> *100):
  // 8.182/25 = 32.73 % -> 3273.
  assert.strictEqual(u1.plan.writes[0].value, 3273);
  assert.strictEqual(u1.writeAllowed, true);
  // Readbacks mirror the three registers.
  assert.deepStrictEqual(u1.plan.readbacks.map((r) => r.addr),
    u1.plan.writes.map((w) => w.addr));
});

test('a unit WITHOUT a discovery gets no plan and an honest reason - never a fabricated address', () => {
  const f = fleet({}, { [KEY1]: discoveryFor(25) }); // unit 2 not discovered yet
  const u2 = f.units.find((u) => u.sourceId === 'src-fr2');
  assert.strictEqual(u2.plan.ok, false);
  assert.strictEqual(u2.plan.writes.length, 0);
  assert.strictEqual(u2.planned.length, 0);
  assert.ok(u2.reason.length > 0);
  // Unit 1 still plans (error isolation).
  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  assert.strictEqual(u1.plan.ok, true);
});

// --- release discipline ------------------------------------------------------

test('an uncurtailed slot (pv_limit_kw absent) releases: WMaxLim_Ena=0', () => {
  const f = fleet({ pv_limit_kw: undefined });
  assert.strictEqual(f.mode, 'release');
  for (const u of f.units) {
    assert.strictEqual(u.capKw, null);
    assert.strictEqual(u.mode, 'release');
    const ena = u.plan.writes.find((w) => w.role === 'pv_limit_enable');
    assert.strictEqual(ena.value, 0);
  }
});

test('a STALE setpoint (core silent > 20 min) releases instead of latching the cap', () => {
  const f = fleet({ ts: new Date(NOW - C.CURTAIL_STALE_MS - 1000).toISOString() });
  assert.strictEqual(f.mode, 'release');
  assert.ok(f.reason.indexOf('veraltet') !== -1);
});

// --- the two-gate certification discipline -----------------------------------

test('an UNCERTIFIED unit is planned-only (writes:[], bench_pending) while the certified one writes', () => {
  const f = fleet({
    curtail: {
      control_enabled: true,
      pv_uncontrolled_kw: 12,
      sources: [
        { id: 'src-fr1', certified: true, capacity_kwp: 25 },
        { id: 'src-fr2', certified: false, capacity_kwp: 30 },
      ],
    },
  });
  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  const u2 = f.units.find((u) => u.sourceId === 'src-fr2');
  assert.strictEqual(u1.writeAllowed, true);
  assert.ok(u1.plan.writes.length > 0);
  assert.strictEqual(u2.writeAllowed, false);
  assert.strictEqual(u2.plan.writes.length, 0);
  assert.ok(u2.planned.length > 0);
  assert.ok(u2.planned.every((w) => w.bench_pending === true));
  assert.ok(u2.reason.indexOf('freigegeben') !== -1);
  // Readbacks still run on the uncertified unit (show the actual state).
  assert.ok(u2.plan.readbacks.length > 0);
});

test('the kill-switch (curtail.control_enabled=false) stops EVERY write, certified or not', () => {
  const f = fleet({
    curtail: {
      control_enabled: false,
      pv_uncontrolled_kw: 12,
      sources: [
        { id: 'src-fr1', certified: true, capacity_kwp: 25 },
        { id: 'src-fr2', certified: true, capacity_kwp: 30 },
      ],
    },
  });
  for (const u of f.units) {
    assert.strictEqual(u.writeAllowed, false);
    assert.strictEqual(u.plan.writes.length, 0);
    assert.strictEqual(u.reason, 'Steuerung deaktiviert (Not-Aus)');
  }
});

test('the top-level control_enabled (primary-inverter gate) does NOT gate curtailment', () => {
  // The Deye's own certification must never decide whether a Fronius source
  // may curtail: only curtail.control_enabled (the raw kill-switch) counts.
  const f = fleet({ control_enabled: false });
  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  assert.strictEqual(u1.writeAllowed, true);
});

test('a bounded First-Light TEST writes on an uncertified unit (certification bypass, kill-switch still outer AND)', () => {
  const base = {
    curtail: {
      control_enabled: true,
      pv_uncontrolled_kw: 0,
      sources: [
        { id: 'src-fr1', certified: false, capacity_kwp: 25, test: { cap_kw: 16 } },
        { id: 'src-fr2', certified: false, capacity_kwp: 30 },
      ],
    },
  };
  const f = fleet(base);
  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  assert.strictEqual(u1.calibration, true);
  assert.strictEqual(u1.capKw, 16); // the bounded test cap, not the split
  assert.strictEqual(u1.writeAllowed, true);
  assert.ok(u1.plan.writes.length > 0);
  // Kill-switch off stops even the test.
  const off = fleet({ curtail: Object.assign({}, base.curtail, { control_enabled: false }) });
  const u1off = off.units.find((u) => u.sourceId === 'src-fr1');
  assert.strictEqual(u1off.writeAllowed, false);
  assert.strictEqual(u1off.plan.writes.length, 0);
});

test('a non-writable unit\'s MEASURED output counts as uncontrolled - the budget for the others shrinks', () => {
  const f = C.planFleetCurtailment({
    setpoint: setpoint({
      curtail: {
        control_enabled: true,
        pv_uncontrolled_kw: 12,
        sources: [
          { id: 'src-fr1', certified: true, capacity_kwp: 25 },
          { id: 'src-fr2', certified: false, capacity_kwp: 30 },
        ],
      },
    }),
    plans: PLANS,
    discoveries: { [KEY1]: discoveryFor(25), [KEY2]: discoveryFor(30) },
    readings: { 'src-fr2': { pv_kw: 8, at: NOW - 5000 } }, // WR2 measured 8 kW
    nowMs: NOW,
    disc: D,
  });
  // uncontrolled = 12 (Deye) + 8 (uncertified WR2) = 20 -> budget = 30-20 = 10,
  // all of it to the one writable unit.
  assert.strictEqual(f.uncontrolledKw, 20);
  assert.strictEqual(f.budgetKw, 10);
  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  assert.strictEqual(u1.capKw, 10);
});

test('idle without a curtail block or without Fronius sources (older core / other topology)', () => {
  const none = C.planFleetCurtailment({ setpoint: { ts: 'x' }, plans: PLANS, discoveries: {}, readings: {}, nowMs: NOW, disc: D });
  assert.strictEqual(none.active, false);
  assert.strictEqual(none.mode, 'idle');
  const noFr = C.planFleetCurtailment({
    setpoint: setpoint(), plans: [{ id: 'src-x', role: 'consumer', adapter: 'goe_http_api', conn: { ip: '1.2.3.4' } }],
    discoveries: {}, readings: {}, nowMs: NOW, disc: D,
  });
  assert.strictEqual(noFr.active, false);
});

// --- override detection by effect --------------------------------------------

test('override detection: settling first, then a measured power ABOVE cap+tolerance flags a possible override', () => {
  const base = { capKw: 10, activeSinceMs: NOW - 10000, nowMs: NOW, measuredAtMs: NOW - 2000 };
  // Within the settle window: never a verdict.
  const settling = C.evaluateEnforcement(Object.assign({}, base, { measuredKw: 25 }));
  assert.strictEqual(settling.status, 'settling');
  assert.strictEqual(settling.possibleOverride, false);

  // After the settle window: 25 kW against a 10 kW cap = possible override.
  const after = Object.assign({}, base, { activeSinceMs: NOW - C.DEFAULT_SETTLE_MS - 1000 });
  const flagged = C.evaluateEnforcement(Object.assign({}, after, { measuredKw: 25 }));
  assert.strictEqual(flagged.status, 'possible_override');
  assert.strictEqual(flagged.possibleOverride, true);
  assert.ok(flagged.reason.indexOf('NIEDRIGSTE') !== -1);

  // Within tolerance (10 % / 0.5 kW): no flag - measurement noise never cries wolf.
  const inTol = C.evaluateEnforcement(Object.assign({}, after, { measuredKw: 10.8 }));
  assert.strictEqual(inTol.status, 'ok');

  // BELOW the cap proves nothing (a passing cloud also drops power): plain ok.
  const below = C.evaluateEnforcement(Object.assign({}, after, { measuredKw: 4 }));
  assert.strictEqual(below.status, 'ok');
});

test('override detection is honest about missing/stale measurements and an inactive cap', () => {
  const inactive = C.evaluateEnforcement({ capKw: null, measuredKw: 5, activeSinceMs: NOW, nowMs: NOW });
  assert.strictEqual(inactive.status, 'inactive');
  const unknown = C.evaluateEnforcement({
    capKw: 10, activeSinceMs: NOW - 999999, nowMs: NOW,
    measuredKw: 25, measuredAtMs: NOW - C.READING_FRESH_MS - 1000,
  });
  assert.strictEqual(unknown.status, 'unknown');
  assert.strictEqual(unknown.possibleOverride, false);
});

test('unitKey is the physical ip:port#unit identity with defaults', () => {
  assert.strictEqual(C.unitKey({ ip: '192.168.210.40', port: 502, unit_id: 2 }), '192.168.210.40:502#2');
  assert.strictEqual(C.unitKey({ ip: ' 10.0.0.5 ' }), '10.0.0.5:502#1');
});
