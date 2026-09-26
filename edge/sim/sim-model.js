'use strict';

/**
 * The simulated inverter + battery as a PURE model: no socket, no timer, no clock
 * of its own. `sunspec-sim.js` wraps it in a Modbus TCP server and steps it once a
 * second on the wall clock; the tests step it on a clock of their own.
 *
 * Register map: see the table at the top of sunspec-sim.js. K4b (24.09.2026,
 * concept "Der Wechselrichter regelt, die Box setzt Absicht und Grenzen" §8) adds
 * two things the concept needs to be provable without hardware:
 *
 *  1. THE WINDOW OF THE DEVICE'S OWN MODE - registers 43/44, the charge/discharge
 *     power the device may use while it regulates itself (register 41 = 0):
 *       battery = clamp(pv - load, -min(MAX_DIS, 44), min(MAX_CH, 43))
 *     0xFFFF (the power-on default) = no limit. With register 41 = 1 (EMS control)
 *     they do nothing: a commanded setpoint is executed as commanded.
 *
 *  2. DEAD TIMES, each one adjustable (constructor option or SIM_* env var):
 *     - measureIntervalS  the device refreshes its measurement registers only
 *                         every N s (Deye: 5-25 s). Default 1 = the old behaviour.
 *     - followDelayS      a new SETPOINT written under EMS control takes effect
 *                         only after N s (Deye: 15-20 s). Default 0 = old behaviour.
 *     - selfDeadTimeS     the device's OWN loop: it regulates on its own meter,
 *                         which it sees N s late. Default 1 s.
 *     The difference between the last two is the whole point of the concept: a box
 *     that follows the measurement through a 15-20 s command path lags every cloud,
 *     a device regulating on its own meter does not.
 */

const R = Object.freeze({
  GRID: 0, PV: 1, LOAD: 2, BATT: 3, SOC: 4, WMAXLIM: 5, GRIDCONN: 6,
  EIMP_HI: 7, EIMP_LO: 8,
  SETPOINT: 40, ENABLE: 41, PVLIMIT: 42,
  CH_LIMIT: 43, DIS_LIMIT: 44,
});
const NO_PV_LIMIT = 0xffff;
const NO_NATIVE_LIMIT = 0xffff;
const NUM_REGS = 64;

const toU16 = (v) => v & 0xffff;
const s16ToKw = (raw) => (raw > 32767 ? raw - 65536 : raw) / 100;

const num = (v, dflt) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

/** The pre-K4b profiles: ~2 min diurnal PV and a swinging house. */
function defaultPv(peakKw) {
  return (t) => Math.max(0, peakKw * Math.sin((2 * Math.PI * (t % 120)) / 120));
}
function defaultLoad(baseKw) {
  return (t) => baseKw + 2 * Math.sin((2 * Math.PI * (t % 40)) / 40);
}

/**
 * optionsFromEnv - the SIM_* variables the container reads. Unset = the old model.
 */
function optionsFromEnv(env = process.env) {
  return {
    capacityKwh: num(env.SIM_CAPACITY_KWH, 100),
    maxChargeKw: num(env.SIM_MAX_CHARGE_KW, 50),
    maxDischargeKw: num(env.SIM_MAX_DISCHARGE_KW, 50),
    gridConnKw: num(env.SIM_GRID_CONN_KW, 50),
    pvPeakKw: num(env.SIM_PV_PEAK_KW, 25),
    loadBaseKw: num(env.SIM_LOAD_BASE_KW, 8),
    socStartPct: num(env.SIM_SOC_START, 55),
    measureIntervalS: num(env.SIM_MEASURE_INTERVAL_S, 1),
    followDelayS: num(env.SIM_FOLLOW_DELAY_S, 0),
    selfDeadTimeS: num(env.SIM_SELF_DEAD_TIME_S, 1),
  };
}

function createSimModel(opts = {}) {
  const o = {
    capacityKwh: 100, maxChargeKw: 50, maxDischargeKw: 50, gridConnKw: 50,
    pvPeakKw: 25, loadBaseKw: 8, socStartPct: 55,
    measureIntervalS: 1, followDelayS: 0, selfDeadTimeS: 1,
    startS: 0,
    ...opts,
  };
  const pvAt = typeof o.pvKw === 'function' ? o.pvKw : defaultPv(o.pvPeakKw);
  const loadAt = typeof o.loadKw === 'function' ? o.loadKw : defaultLoad(o.loadBaseKw);
  const wmaxAt = typeof o.wmaxLimPct === 'function'
    ? o.wmaxLimPct
    : (t) => (Math.floor(t / 30) % 4 === 3 ? 40 : 100); // §14a: 40 % in every 4th 30-s window

  const regs = new Uint16Array(NUM_REGS);
  regs[R.PVLIMIT] = NO_PV_LIMIT;
  regs[R.CH_LIMIT] = NO_NATIVE_LIMIT;
  regs[R.DIS_LIMIT] = NO_NATIVE_LIMIT;

  let t = o.startS;
  let soc = o.socStartPct;
  let energyImportWh = 0;
  let enabled = 0;          // 1 once the edge asserts control
  let activeKw = 0;         // the setpoint the device currently EXECUTES
  const pending = [];       // written setpoints not yet in effect: { at, kw }
  let pvLimitKw = null;
  const seen = [];          // the device's own meter, for its dead time: { t, surplus }
  let lastMeasureAt = -Infinity;
  let truth = { pv: 0, load: 0, batt: 0, grid: 0, soc };

  const limitKw = (addr, rated) => (regs[addr] === NO_NATIVE_LIMIT ? rated : Math.min(rated, regs[addr] / 100));

  // The surplus the device's own loop acts on: its meter reading selfDeadTimeS ago.
  function ownMeterSurplus() {
    const cutoff = t - o.selfDeadTimeS;
    let v = seen.length ? seen[0].surplus : 0;
    for (const e of seen) {
      if (e.t <= cutoff + 1e-9) v = e.surplus; else break;
    }
    while (seen.length > 1 && seen[1].t <= cutoff + 1e-9) seen.shift();
    return v;
  }

  function refreshRegisters() {
    regs[R.GRID] = toU16(Math.round(truth.grid * 100));
    regs[R.PV] = toU16(Math.round(truth.pv * 100));
    regs[R.LOAD] = toU16(Math.round(truth.load * 100));
    regs[R.BATT] = toU16(Math.round(truth.batt * 100));
    regs[R.SOC] = toU16(Math.round(soc * 10));
    regs[R.WMAXLIM] = toU16(Math.round(wmaxAt(t) * 100));
    regs[R.GRIDCONN] = toU16(Math.round(o.gridConnKw * 100));
    const ewh = Math.round(energyImportWh);
    regs[R.EIMP_HI] = toU16((ewh >>> 16) & 0xffff);
    regs[R.EIMP_LO] = toU16(ewh & 0xffff);
  }

  /**
   * step advances the model by dtS seconds (or to the absolute time nowS when
   * given - the server passes the wall clock so the §14a/PV profiles stay what
   * they were).
   */
  function step(dtS = 1, nowS) {
    const prev = t;
    t = Number.isFinite(nowS) ? nowS : t + dtS;
    const dt = Math.max(0, t - prev) || dtS;

    let pv = Math.max(0, pvAt(t));
    // The PV limit can only ever CAP the output (curtailment), never raise it.
    if (pvLimitKw != null) pv = Math.min(pv, pvLimitKw);
    const load = Math.max(0, loadAt(t));

    while (pending.length && pending[0].at <= t + 1e-9) activeKw = pending.shift().kw;
    seen.push({ t, surplus: pv - load });

    // WHO decides the battery power: the EMS while it asserts control (41 = 1),
    // the inverter ITSELF otherwise - inside the window of registers 43/44.
    let wanted;
    if (enabled) {
      wanted = activeKw;
    } else {
      const hi = limitKw(R.CH_LIMIT, o.maxChargeKw);
      const lo = limitKw(R.DIS_LIMIT, o.maxDischargeKw);
      wanted = Math.max(-lo, Math.min(hi, ownMeterSurplus()));
    }
    // Physics, not policy: the rated band and the SoC window hold on both paths.
    let batt = Math.max(-o.maxDischargeKw, Math.min(o.maxChargeKw, wanted));
    if (soc >= 100 && batt > 0) batt = 0;
    if (soc <= 0 && batt < 0) batt = 0;

    soc += (batt * (dt / 3600) / o.capacityKwh) * 100;
    soc = Math.max(0, Math.min(100, soc));

    const grid = load + batt - pv; // + = import
    if (grid > 0) energyImportWh += (grid * 1000 * dt) / 3600;
    truth = { pv, load, batt, grid, soc };

    if (t - lastMeasureAt >= o.measureIntervalS - 1e-9) {
      lastMeasureAt = t;
      refreshRegisters();
    }
    return truth;
  }

  /** setRegister is the Modbus FC6 write; returns a log line (or null). */
  function setRegister(addr, value) {
    if (addr < 0 || addr >= NUM_REGS) return null;
    regs[addr] = toU16(value);
    if (addr === R.SETPOINT) {
      const kw = s16ToKw(regs[addr]);
      if (o.followDelayS > 0) pending.push({ at: t + o.followDelayS, kw });
      else activeKw = kw;
      return `[sim] setpoint write: battery = ${kw.toFixed(2)} kW (reg[${R.SETPOINT}]=${regs[addr]})`
        + (o.followDelayS > 0 ? ` - effective in ${o.followDelayS} s` : '') + ` | soc=${soc.toFixed(1)}%`;
    }
    if (addr === R.ENABLE) {
      enabled = regs[addr] ? 1 : 0;
      return enabled
        ? `[sim] EMS control ENABLED (reg[${R.ENABLE}]=${regs[addr]}) - the battery follows the commanded setpoint`
        : `[sim] EMS control disabled (reg[${R.ENABLE}]=0) - SELF-CONSUMPTION: the inverter follows the house itself`;
    }
    if (addr === R.PVLIMIT) {
      pvLimitKw = regs[addr] === NO_PV_LIMIT ? null : regs[addr] / 100;
      return pvLimitKw == null
        ? `[sim] PV limit CLEARED (reg[${R.PVLIMIT}]=0xFFFF) - inverter free-runs`
        : `[sim] PV limit write: cap = ${pvLimitKw.toFixed(2)} kW (reg[${R.PVLIMIT}]=${regs[addr]}) - curtailment active`;
    }
    if (addr === R.CH_LIMIT || addr === R.DIS_LIMIT) {
      const name = addr === R.CH_LIMIT ? 'charge' : 'discharge';
      return regs[addr] === NO_NATIVE_LIMIT
        ? `[sim] own-mode ${name} limit CLEARED (reg[${addr}]=0xFFFF)`
        : `[sim] own-mode ${name} limit = ${(regs[addr] / 100).toFixed(2)} kW (reg[${addr}])`;
    }
    return null;
  }

  return {
    step,
    setRegister,
    getRegister: (addr) => (addr >= 0 && addr < NUM_REGS ? regs[addr] : 0),
    /** The PHYSICAL truth of the last step (the registers may lag behind it). */
    truth: () => ({ ...truth }),
    /** The value the device reports, i.e. what a reader of the registers sees. */
    measured: () => ({
      grid: s16ToKw(regs[R.GRID]), pv: s16ToKw(regs[R.PV]), load: s16ToKw(regs[R.LOAD]),
      batt: s16ToKw(regs[R.BATT]), soc: regs[R.SOC] / 10,
    }),
    time: () => t,
    options: () => ({ ...o }),
  };
}

module.exports = {
  R, NO_PV_LIMIT, NO_NATIVE_LIMIT, NUM_REGS,
  toU16, s16ToKw,
  createSimModel, optionsFromEnv,
};
