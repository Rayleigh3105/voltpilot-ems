'use strict';

/**
 * sim-model.test.js - the K4b proof on the SIMULATOR (concept §8, cases F1-F4 and
 * the E~ window), run twice on the same plant and the same disturbance:
 *
 *   "Gerät regelt"   the device regulates itself inside the window of registers
 *                    43/44 (register 41 = 0), on its own meter, 1 s late;
 *   "Box-Sollwert"   the device obeys a setpoint (41 = 1) that a box loop
 *                    recomputes every 10 s from registers the device refreshes
 *                    every 10 s, and it follows a new setpoint 15 s late (the
 *                    measured Deye behaviour, h4). This is the UNDAMPED loop; the
 *                    damped box fallback (guards.FollowDamper) is proven in Go.
 *
 * Every number is printed as a test diagnostic, so the PR quotes a real run.
 * Run: node --test edge/sim/sim-model.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { R, NO_NATIVE_LIMIT, createSimModel, optionsFromEnv } = require('./sim-model');

const DT = 0.5;          // model step, s
const BOX_EVERY_S = 10;  // the box's setpoint cadence
const DEYE = { measureIntervalS: 10, followDelayS: 15, selfDeadTimeS: 1 };

const kwRaw = (kw) => Math.round(kw * 100) & 0xffff;

/** A step profile: value `a` until `at`, then `b` (or a linear ramp over `rampS`). */
function stepAt(at, a, b, rampS = 0) {
  return (t) => {
    if (t < at) return a;
    if (rampS > 0 && t < at + rampS) return a + ((b - a) * (t - at)) / rampS;
    return b;
  };
}

/**
 * run drives one plant for `seconds` and measures the TRUE grid/battery (not the
 * lagging registers - the question is what the meter at the grid point sees).
 *   path 'device': hand the device the window [lo ; hi] once, then only watch.
 *   path 'box':    41 = 1, a box loop every 10 s writes clamp(pv - load, lo, hi)
 *                  computed from the device's REGISTERS.
 */
function run({ path, window: [lo, hi], pv, load, seconds = 180, socStartPct = 50 }) {
  const m = createSimModel({ ...DEYE, pvKw: pv, loadKw: load, socStartPct, wmaxLimPct: () => 100 });
  if (path === 'device') {
    m.setRegister(R.CH_LIMIT, kwRaw(Math.max(hi, 0)));
    m.setRegister(R.DIS_LIMIT, kwRaw(Math.max(-lo, 0)));
    m.setRegister(R.ENABLE, 0);
  } else {
    m.setRegister(R.ENABLE, 1);
  }
  const trace = [];
  let nextBox = 0;
  for (let i = 0; i * DT < seconds; i++) {
    const tr = m.step(DT);
    trace.push({ t: m.time(), ...tr });
    if (path === 'box' && m.time() >= nextBox) {
      nextBox += BOX_EVERY_S;
      const meas = m.measured();
      const want = Math.max(lo, Math.min(hi, meas.pv - meas.load));
      m.setRegister(R.SETPOINT, kwRaw(want));
    }
  }
  return { trace, model: m };
}

/** Longest continuous stretch (s) after `fromS` where `pred` holds. */
function longest(trace, pred, fromS = 0) {
  let best = 0;
  let cur = 0;
  for (const p of trace) {
    if (p.t < fromS) continue;
    if (pred(p)) { cur += DT; best = Math.max(best, cur); } else { cur = 0; }
  }
  return best;
}

/** Time (s) from `fromS` until `pred` holds for good (to the end of the trace). */
function settleTime(trace, pred, fromS) {
  let last = fromS;
  for (const p of trace) {
    if (p.t < fromS) continue;
    if (!pred(p)) last = p.t;
  }
  return last - fromS;
}

// --- the model itself ------------------------------------------------------------

test('the own-mode window binds only while the device regulates itself', () => {
  const m = createSimModel({ pvKw: () => 20, loadKw: () => 5, selfDeadTimeS: 0 });
  assert.equal(m.getRegister(R.CH_LIMIT), NO_NATIVE_LIMIT, 'power-on: no limit');
  assert.equal(m.getRegister(R.DIS_LIMIT), NO_NATIVE_LIMIT);
  m.setRegister(R.ENABLE, 0);
  m.step(1);
  assert.ok(Math.abs(m.truth().batt - 15) < 1e-9, 'no window: the whole surplus');
  m.setRegister(R.CH_LIMIT, kwRaw(4.2));
  m.step(1);
  assert.ok(Math.abs(m.truth().batt - 4.2) < 1e-9, 'E~: the charge cap holds');
  assert.ok(Math.abs(m.truth().grid + 10.8) < 1e-9, 'the rest is exported');
  // Under EMS control the window does nothing - a commanded value is executed.
  m.setRegister(R.ENABLE, 1);
  m.setRegister(R.SETPOINT, kwRaw(9));
  m.step(1);
  assert.ok(Math.abs(m.truth().batt - 9) < 1e-9, 'EMS control ignores the own-mode window');
});

test('E-up [0 ; max] never discharges; a full battery stops charging', () => {
  const m = createSimModel({ pvKw: () => 2, loadKw: () => 6, selfDeadTimeS: 0 });
  m.setRegister(R.DIS_LIMIT, 0);
  m.setRegister(R.ENABLE, 0);
  m.step(1);
  assert.ok(Math.abs(m.truth().batt) < 1e-9, 'a deficit is imported, not taken from the battery');
  assert.ok(Math.abs(m.truth().grid - 4) < 1e-9);
  const full = createSimModel({ pvKw: () => 20, loadKw: () => 5, socStartPct: 100, selfDeadTimeS: 0 });
  full.setRegister(R.DIS_LIMIT, 0);
  full.setRegister(R.ENABLE, 0);
  full.step(1);
  assert.ok(Math.abs(full.truth().batt) < 1e-9, 'Speicher voll: nothing more to store');
  assert.ok(Math.abs(full.truth().grid + 15) < 1e-9, 'the surplus is exported');
});

test('the dead times: registers refresh every N s, a setpoint takes effect N s late', () => {
  const m = createSimModel({ pvKw: stepAt(3, 10, 0), loadKw: () => 5, measureIntervalS: 10, followDelayS: 15 });
  m.setRegister(R.ENABLE, 1);
  m.step(1);
  assert.equal(m.measured().pv, 10, 'first refresh');
  for (let i = 0; i < 5; i++) m.step(1);
  assert.equal(m.truth().pv, 0, 'the PV really fell');
  assert.equal(m.measured().pv, 10, 'but the registers still show the old value');
  for (let i = 0; i < 5; i++) m.step(1);
  assert.equal(m.measured().pv, 0, 'refreshed after the measurement interval');
  m.setRegister(R.SETPOINT, kwRaw(-3));
  for (let i = 0; i < 14; i++) m.step(1);
  assert.equal(m.truth().batt, 0, 'not yet: the follow time is 15 s');
  m.step(1);
  assert.equal(m.truth().batt, -3, 'now');
});

test('env: unset SIM_* keeps the pre-K4b model, set ones are read', () => {
  const d = optionsFromEnv({});
  assert.equal(d.measureIntervalS, 1);
  assert.equal(d.followDelayS, 0);
  assert.equal(d.selfDeadTimeS, 1);
  const s = optionsFromEnv({ SIM_MEASURE_INTERVAL_S: '25', SIM_FOLLOW_DELAY_S: '18', SIM_SELF_DEAD_TIME_S: '0.5' });
  assert.deepEqual([s.measureIntervalS, s.followDelayS, s.selfDeadTimeS], [25, 18, 0.5]);
});

// --- F1-F4 + E~, device vs box --------------------------------------------------

test('F1 Wolkenkante (PV -15 kW in E-up): the device imports > 1 kW for at most 5 s', (t) => {
  for (const rampS of [0, 30]) {
    const args = { window: [0, 50], pv: stepAt(60, 25, 10, rampS), load: () => 5 };
    const dev = run({ path: 'device', ...args });
    const box = run({ path: 'box', ...args });
    const devS = longest(dev.trace, (p) => p.grid > 1, 60);
    const boxS = longest(box.trace, (p) => p.grid > 1, 60);
    const devBought = dev.trace.filter((p) => p.t >= 60).reduce((a, p) => a + Math.max(0, Math.min(p.batt, p.grid)) * DT / 3600, 0);
    const boxBought = box.trace.filter((p) => p.t >= 60).reduce((a, p) => a + Math.max(0, Math.min(p.batt, p.grid)) * DT / 3600, 0);
    t.diagnostic(`F1 ramp ${rampS}s: import>1kW device ${devS}s / box ${boxS}s; `
      + `grid->battery device ${devBought.toFixed(4)} kWh / box ${boxBought.toFixed(4)} kWh`);
    assert.ok(devS <= 5, `device: ${devS} s`);
    assert.ok(dev.trace.every((p) => p.batt >= -1e-9), 'E-up never discharges');
    if (rampS === 0) assert.ok(boxS > 5, `the 15-s command path cannot: ${boxS} s`);
  }
});

test('F2 Wolkenlücke (PV +15 kW in E): the device exports > 1 kW for at most 5 s', (t) => {
  const args = { window: [-50, 50], pv: stepAt(60, 10, 25), load: () => 5, socStartPct: 50 };
  const dev = run({ path: 'device', ...args });
  const box = run({ path: 'box', ...args });
  const devS = longest(dev.trace, (p) => p.grid < -1 && p.soc < 95, 60);
  const boxS = longest(box.trace, (p) => p.grid < -1 && p.soc < 95, 60);
  t.diagnostic(`F2: export>1kW (SoC<95%) device ${devS}s / box ${boxS}s`);
  assert.ok(devS <= 5, `device: ${devS} s`);
  assert.ok(boxS > 5, `box: ${boxS} s`);
});

test('F3 Lastsprung (+10 kW in E): the device covers it within 2 s', (t) => {
  const args = { window: [-50, 50], pv: () => 3, load: stepAt(60, 5, 15) };
  const dev = run({ path: 'device', ...args });
  const box = run({ path: 'box', ...args });
  const devS = settleTime(dev.trace, (p) => Math.abs(p.grid) <= 0.2, 60);
  const boxS = settleTime(box.trace, (p) => Math.abs(p.grid) <= 0.2, 60);
  const boxPeak = longest(box.trace, (p) => p.grid > 3, 60);
  t.diagnostic(`F3: covered after device ${devS}s / box ${boxS}s (box import>3kW for ${boxPeak}s)`);
  assert.ok(devS <= 2, `device: ${devS} s`);
  assert.ok(boxS > 2, `box: ${boxS} s`);
});

test('F4 Lastabwurf (-10 kW in E-down): no battery export > 0.2 kW longer than 5 s', (t) => {
  const args = { window: [-50, 0], pv: () => 0, load: stepAt(60, 15, 5) };
  const exportFromBattery = (p) => p.grid < 0 && p.batt < 0 && Math.min(-p.grid, -p.batt) > 0.2;
  const dev = run({ path: 'device', ...args });
  const box = run({ path: 'box', ...args });
  const devS = longest(dev.trace, exportFromBattery, 60);
  const boxS = longest(box.trace, exportFromBattery, 60);
  t.diagnostic(`F4: battery export>0.2kW device ${devS}s / box ${boxS}s`);
  assert.ok(devS <= 5, `device: ${devS} s`);
  assert.ok(boxS > 5, `box: ${boxS} s`);
  assert.ok(dev.trace.every((p) => p.batt <= 1e-9), 'E-down never charges');
});

test('E~ (charge capped at 4.2 kW in E): the cap holds through a cloud gap, the deficit side stays open', (t) => {
  const dev = run({ path: 'device', window: [-50, 4.2], pv: stepAt(60, 2, 20), load: () => 6 });
  const before = dev.trace.find((p) => p.t === 50);
  const after = dev.trace[dev.trace.length - 1];
  t.diagnostic(`E~: before batt ${before.batt.toFixed(2)} kW grid ${before.grid.toFixed(2)} kW; `
    + `after batt ${after.batt.toFixed(2)} kW grid ${after.grid.toFixed(2)} kW`);
  assert.ok(Math.abs(before.batt + 4) < 1e-6, 'covers the 4-kW deficit');
  assert.ok(Math.abs(after.batt - 4.2) < 1e-6, 'charges at the cap');
  assert.ok(Math.abs(after.grid + 9.8) < 1e-6, 'and exports the rest');
  assert.ok(dev.trace.every((p) => p.batt <= 4.2 + 1e-9), 'never above the cap');
});
