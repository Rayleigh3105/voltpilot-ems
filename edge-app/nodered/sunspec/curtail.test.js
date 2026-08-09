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

function fleet(over, discs, connOver) {
  const plans = connOver
    ? PLANS.map((p) => Object.assign({}, p, { conn: Object.assign({}, p.conn, connOver) }))
    : PLANS;
  return C.planFleetCurtailment({
    setpoint: setpoint(over),
    plans: plans,
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

  // The limit leaves as ONE FC16 transaction over the discovered Model-123
  // block - the Datamanager only adopts it as a closed set (live 09.08.2026).
  const d1 = discoveryFor(25);
  assert.strictEqual(u1.plan.writes.length, 1);
  const blk = u1.plan.writes[0];
  assert.strictEqual(blk.fc, 16);
  assert.strictEqual(blk.addr, d1.controls.wMaxLimPctAddr);
  // pct = cap/rated, register scaled by the discovered SF (-2 -> *100):
  // 8.182/25 = 32.73 % -> 3273; then window 0, the 60 s native dead-man,
  // ramp 0, enable last.
  assert.deepStrictEqual(blk.values, [3273, 0, C.DEFAULT_RVRT_TMS, 0, 1]);
  assert.strictEqual(u1.writeAllowed, true);
  // The readbacks are per register and cover the three that carry meaning.
  assert.deepStrictEqual(u1.plan.readbacks.map((r) => r.addr),
    [d1.controls.wMaxLimPctAddr, d1.controls.wMaxLimPctRvrtTmsAddr, d1.controls.wMaxLimEnaAddr]);
});

test('a source may flip its curtailment write form back to the legacy FC6', () => {
  // The per-connection escape hatch rides the SOURCE config (curtail.js reads
  // conn.curtail_write_fc), because a Fronius is curtailed as an Erzeuger
  // source, not as the primary inverter.
  const f = fleet({}, undefined, { curtail_write_fc: 6 });
  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  assert.deepStrictEqual(u1.plan.writes.map((w) => w.fc), [6, 6, 6]);
  assert.deepStrictEqual(u1.plan.writes.map((w) => w.role),
    ['pv_limit_pct', 'pv_limit_revert_tms', 'pv_limit_enable']);
  // Absent = the FC16 default; the proven-broken form is never the fallback.
  assert.strictEqual(fleet().units[0].plan.writes[0].fc, 16);
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

test('a unit whose live WRtg read failed still plans from the CONFIGURED kWp (float-audit §6.1)', () => {
  // A discovery WITHOUT a readable nameplate (Model 120 absent): the resolved
  // rating falls back to the curtail-block entry's capacity_kwp - and that
  // fallback must reach planCurtailment, or the unit is classified writable,
  // joins the split, and then refuses its own plan with "Nennleistung
  // (Nameplate WRtg) unbekannt".
  const controls = new Array(D.M123.LENGTH).fill(0);
  controls[D.M123.WMaxLimPct_SF] = 0xfffe;
  const img = buildImage(40000, [
    { id: 1, body: new Array(66).fill(0) },
    { id: 103, body: new Array(50).fill(0) },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controls },
  ]);
  const dNoRtg = D.discover(readerOver(img), { base: 40000 });
  assert.ok(dNoRtg.ok && dNoRtg.controls.present, 'fixture: controls discovered');
  assert.ok(!(dNoRtg.nameplateKw > 0), 'fixture: no live nameplate rating');
  const f = fleet({}, { [KEY1]: dNoRtg, [KEY2]: discoveryFor(30) });
  const u1 = f.units.find((u) => u.sourceId === 'src-fr1');
  assert.strictEqual(u1.ratedKw, 25, 'rating falls back to the configured capacity_kwp');
  assert.strictEqual(u1.plan.ok, true, 'the fallback reaches planCurtailment - no refusal');
  assert.ok(u1.plan.writes.length > 0, 'the certified unit writes');
  const w = u1.plan.writes[0];
  assert.strictEqual(w.encode.rated_kw, 25, 'the pct conversion uses the configured kWp');
  assert.ok(Math.abs(w.encode.pct - (u1.capKw / 25) * 100) < 1e-9, 'pct = cap / configured rating');
});

// --- release discipline ------------------------------------------------------

test('an uncurtailed slot (pv_limit_kw absent) releases: WMaxLim_Ena=0', () => {
  const f = fleet({ pv_limit_kw: undefined });
  assert.strictEqual(f.mode, 'release');
  for (const u of f.units) {
    assert.strictEqual(u.capKw, null);
    assert.strictEqual(u.mode, 'release');
    const ena = u.plan.writes[0].parts.find((p) => p.role === 'pv_limit_enable');
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

// --- the REFRESH / VERIFY layer (First-Light hardening 2026-08-06) -----------

// THE chain the whole hardening rests on. Pinned here AND in the Go half
// (curtailcal TestTheRefreshRevertTTLChainHolds) - change one, change both.
test('the refresh interval sits well inside the native revert timer, which sits inside the test TTL', () => {
  assert.ok(C.REFRESH_MS * 2 <= C.DEFAULT_RVRT_TMS * 1000,
    'a MISSED refresh must still land before the inverter reverts');
  assert.ok(C.DEFAULT_RVRT_TMS * 1000 < 120000,
    'the native revert must fire INSIDE the 120 s test TTL, never define its end');
});

function unitWithWrites(over) {
  return Object.assign({
    mode: 'apply', calibration: false, planned: [],
    plan: { ok: true, writes: [
      { role: 'pv_limit_pct', value: 3273 },
      { role: 'pv_limit_revert_tms', value: 60 },
      { role: 'pv_limit_enable', value: 1 },
    ] },
  }, over || {});
}

test('commandSignature is stable for the same command and changes with the cap', () => {
  const u = unitWithWrites();
  assert.strictEqual(C.commandSignature(u), C.commandSignature(unitWithWrites()));
  const other = unitWithWrites();
  other.plan.writes[0].value = 4000;
  assert.notStrictEqual(C.commandSignature(u), C.commandSignature(other));
  // Release vs apply are different commands even with equal register values.
  const rel = unitWithWrites({ mode: 'release' });
  assert.notStrictEqual(C.commandSignature(u), C.commandSignature(rel));
  // Nothing to command -> no signature (never a fabricated identity).
  assert.strictEqual(C.commandSignature({ plan: { ok: false, writes: [] } }), null);
});

test('commandSignature folds EVERY register of a block write, not just the first', () => {
  // The block form carries `values`, not `value`. A signature that only looked
  // at the first register would read a changed revert timer or a FLIPPED ENABLE
  // as "unchanged" - so the refresh/change machinery would never re-apply it,
  // and a release could be skipped entirely.
  const blockUnit = (values) => ({
    mode: 'apply', calibration: false, planned: [],
    plan: { ok: true, writes: [{ role: 'pv_limit_block', fc: 16, addr: 40243, values: values }] },
  });
  const base = [3273, 0, 60, 0, 1];
  const sig = C.commandSignature(blockUnit(base));
  assert.strictEqual(sig, C.commandSignature(blockUnit(base.slice())), 'stable for an equal block');
  // Each position must move the signature - the cap, the timers AND the enable.
  base.forEach((_, i) => {
    const other = base.slice();
    other[i] = other[i] + 7;
    assert.notStrictEqual(sig, C.commandSignature(blockUnit(other)), 'register ' + i + ' changes the signature');
  });
  // The enable specifically: 1 -> 0 is a RELEASE and must never look identical.
  assert.notStrictEqual(sig, C.commandSignature(blockUnit([3273, 0, 60, 0, 0])));
});

// DEFECT 1 (live): the cap was written EXACTLY ONCE, so the inverter's own
// 60-s revert timer lifted it in the MIDDLE of a 120-s test.
test('an ACTIVE cap is RE-APPLIED before the native revert timer can fire', () => {
  const u = unitWithWrites();
  const t0 = 1000000;
  const first = C.writeDecision({ unit: u, state: {}, nowMs: t0 });
  assert.strictEqual(first.write, true);
  assert.strictEqual(first.kind, 'first');

  let st = C.noteWrite({}, first, t0);
  st = C.noteVerdict(st, { held: true }, t0);

  // Right after the write: verify only, do not hammer the gateway.
  const soon = C.writeDecision({ unit: u, state: st, nowMs: t0 + 5000 });
  assert.strictEqual(soon.write, false);
  assert.strictEqual(soon.kind, 'verify');

  // Past the refresh interval - and still WELL before the revert timer.
  const due = C.writeDecision({ unit: u, state: st, nowMs: t0 + C.REFRESH_MS });
  assert.strictEqual(due.write, true);
  assert.strictEqual(due.kind, 'refresh');
  assert.ok(C.REFRESH_MS < C.DEFAULT_RVRT_TMS * 1000, 'the refresh precedes the revert');

  // A CHANGED cap is applied immediately, whatever the refresh clock says.
  const changed = unitWithWrites();
  changed.plan.writes[0].value = 2593;
  const dc = C.writeDecision({ unit: changed, state: st, nowMs: t0 + 1000 });
  assert.strictEqual(dc.write, true);
  assert.strictEqual(dc.kind, 'changed');
});

test('a bounded First-Light TEST refreshes on EVERY tick - its evidence needs the register to HOLD', () => {
  const u = unitWithWrites({ calibration: true });
  const t0 = 1000000;
  let st = C.noteWrite({}, C.writeDecision({ unit: u, state: {}, nowMs: t0 }), t0);
  st = C.noteVerdict(st, { held: true }, t0);
  const next = C.writeDecision({ unit: u, state: st, nowMs: t0 + 1 });
  assert.strictEqual(next.write, true);
  assert.strictEqual(next.kind, 'refresh');
});

// DEFECT 2 (live 10:51): the Datamanager accepted the write and the register
// read 10000 for 105 s straight. No retry existed - the whole test ran into
// the void.
test('a SWALLOWED command is re-written immediately, bounded, then NAMED and cooled down', () => {
  const u = unitWithWrites();
  let now = 1000000;
  let st = C.noteWrite({}, C.writeDecision({ unit: u, state: {}, nowMs: now }), now);
  st = C.noteVerdict(st, { held: false }, now); // the register did not take it

  const seen = [];
  for (let i = 0; i < 6; i++) {
    now += 1000;
    const d = C.writeDecision({ unit: u, state: st, nowMs: now });
    seen.push(d.kind);
    if (!d.write) break;
    st = C.noteWrite(st, d, now);
    st = C.noteVerdict(st, { held: false }, now);
  }
  // Bounded: at most REWRITE_MAX_ATTEMPTS writes of the SAME command, then
  // the executor STOPS and the cooldown holds it there.
  const retries = seen.filter((k) => k === 'retry').length;
  assert.strictEqual(retries, C.REWRITE_MAX_ATTEMPTS - 1,
    'the first write plus the retries stay within the ladder: ' + JSON.stringify(seen));
  assert.strictEqual(st.attempts, C.REWRITE_MAX_ATTEMPTS);
  assert.strictEqual(seen[seen.length - 1], 'cooldown');

  // The CAUSE is named, and the executor stops writing - never a hot loop.
  const cooling = C.writeDecision({ unit: u, state: st, nowMs: now + 5000 });
  assert.strictEqual(cooling.write, false);
  assert.strictEqual(cooling.kind, 'cooldown');
  assert.strictEqual(cooling.reason, C.REJECTED_REASON);
  assert.ok(cooling.reason.includes('EVU-Editor'), 'the honest cause names the likely culprit + the lever');
  assert.ok(cooling.reason.includes('NIEDRIGSTE'), 'and why Modbus loses: ' + cooling.reason);

  // ... and after it, the whole bounded ladder starts over (never give up).
  const again = C.writeDecision({ unit: u, state: st, nowMs: now + C.REWRITE_COOLDOWN_MS + 1 });
  assert.strictEqual(again.write, true);
  assert.strictEqual(again.kind, 'changed');
});

// A readback that never ANSWERS must not re-open the ladder: without a
// verdict noteVerdict never runs, so the guard has to bound it on its own.
test('a lost readback cannot re-enter the re-write ladder for ever', () => {
  const u = unitWithWrites();
  let now = 1000000;
  let st = C.noteWrite({}, C.writeDecision({ unit: u, state: {}, nowMs: now }), now);
  st = C.noteVerdict(st, { held: false }, now);
  for (let i = 0; i < C.REWRITE_MAX_ATTEMPTS; i++) {
    now += 1000;
    const d = C.writeDecision({ unit: u, state: st, nowMs: now });
    if (!d.write) {
      assert.strictEqual(d.kind, 'exhausted');
      assert.strictEqual(d.reason, C.REJECTED_REASON);
      return;
    }
    st = C.noteWrite(st, d, now); // the readback vanished: no verdict follows
  }
  assert.fail('the ladder must run out even without a readback verdict');
});

test('a HELD readback clears the attempt ladder, so a later blip starts fresh', () => {
  const u = unitWithWrites();
  let now = 1000000;
  let st = C.noteWrite({}, C.writeDecision({ unit: u, state: {}, nowMs: now }), now);
  st = C.noteVerdict(st, { held: false }, now);
  st = C.noteWrite(st, C.writeDecision({ unit: u, state: st, nowMs: now + 100 }), now + 100);
  assert.strictEqual(st.attempts, 2);
  st = C.noteVerdict(st, { held: true }, now + 200);
  assert.strictEqual(st.attempts, 0);
  assert.strictEqual(st.deviating, false);
  assert.strictEqual(st.blockedSince, 0);
});

test('nothing to command -> no decision at all (an uncertified/gated unit never writes)', () => {
  const d = C.writeDecision({ unit: { mode: 'apply', plan: { ok: true, writes: [] }, planned: [{ role: 'x', value: 1 }] }, state: {}, nowMs: 1 });
  assert.strictEqual(d.write, false);
  assert.strictEqual(d.kind, 'none');
});

// --- readback SEMANTICS: the Ena firmware quirk ------------------------------

const REGS = (over) => Object.assign({
  pct: { role: 'pv_limit_pct', commanded_raw: 3273, actual_raw: 3273, match: true },
  rvrt: { role: 'pv_limit_revert_tms', commanded_raw: 60, actual_raw: 60, match: true },
  ena: { role: 'pv_limit_enable', commanded_raw: 0, actual_raw: 0, match: true },
}, over || {});
const asList = (r) => [r.pct, r.rvrt, r.ena];

test('DEFECT 4: a commanded Ena=0 answered with 1 is a QUIRK, not a mismatch - the pct value binds', () => {
  const r = REGS({ ena: { role: 'pv_limit_enable', commanded_raw: 0, actual_raw: 1, match: false } });
  const v = C.evaluateReadback({}, asList(r));
  assert.strictEqual(v.held, true, 'the release counts as held - WMaxLimPct=100 % throttles nothing');
  assert.deepStrictEqual(v.mismatchRoles, []);
  assert.deepStrictEqual(v.quirkRoles, ['pv_limit_enable']);
  assert.ok(v.quirkNote.includes('WMaxLimPct'), 'the note names the binding register');
});

test('the Ena tolerance is ONE-SIDED: a commanded 1 answered with 0 stays a real mismatch', () => {
  const r = REGS({ ena: { role: 'pv_limit_enable', commanded_raw: 1, actual_raw: 0, match: false } });
  const v = C.evaluateReadback({}, asList(r));
  assert.strictEqual(v.held, false, 'we asked for the cap to be ENFORCED and the device says off');
  assert.deepStrictEqual(v.mismatchRoles, ['pv_limit_enable']);
  assert.deepStrictEqual(v.quirkRoles, []);
});

test('the BINDING register never gets a pass, and an unread register confirms nothing', () => {
  const bad = REGS({ pct: { role: 'pv_limit_pct', commanded_raw: 2593, actual_raw: 10000, match: false } });
  const v = C.evaluateReadback({}, asList(bad));
  assert.strictEqual(v.held, false);
  assert.deepStrictEqual(v.mismatchRoles, ['pv_limit_pct']);

  const unread = REGS({ pct: { role: 'pv_limit_pct', commanded_raw: 2593, actual_raw: null, match: false } });
  const v2 = C.evaluateReadback({}, asList(unread));
  assert.strictEqual(v2.held, false, 'no answer is not a confirmation');
  assert.deepStrictEqual(v2.unreadRoles, ['pv_limit_pct']);
  assert.deepStrictEqual(v2.mismatchRoles, [], 'and it is not a mismatch either');

  // An EMPTY readback set proves nothing at all.
  assert.strictEqual(C.evaluateReadback({}, []).held, false);
});

test('a fully matching readback holds and reports no quirk', () => {
  const v = C.evaluateReadback({}, asList(REGS()));
  assert.strictEqual(v.held, true);
  assert.strictEqual(v.allMatch, true);
  assert.strictEqual(v.quirkNote, '');
});
