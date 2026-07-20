'use strict';

/**
 * goe-control - the WRITE/EXECUTION twin of goe-api.js: turn an arbitrated
 * CONSUMER charge command (kW) for a go-e Charger into the go-e local HTTP
 * API v2 SET operations, execute them, and read the result back to prove the
 * command landed. A go-e wallbox is a Verbraucher (consumer) entity; the E2
 * arbitration layer clamps the desired setpoint through the per-entity guard
 * band and publishes the retained edge/entities/{id}/command - THIS module is
 * the edge executor that turns that command into a physical go-e set + readback.
 *
 * WHY go-e control is a REAL (certified) path, not bench_pending like Deye/
 * Fronius: the go-e HTTP API v2 is documented, versioned and deterministic
 * (github.com/goecharger/go-eCharger-API-v2). There are no guessed firmware
 * registers - the control keys and their enums are published facts, and the
 * whole write->readback loop is provable in software against an in-process HTTP
 * server (goe-control.test.js). A wrong current merely charges a car a little
 * slower/faster; there is no battery-bank health/warranty risk like a Deye ToU
 * or Fronius storage write. So this family is CERTIFIED (CERTIFIED_CONTROL_
 * FAMILIES below) and may go live behind the core kill-switch VP_CONTROL_ENABLED
 * - with the same VERIFY-on-device honesty every vendor gets: on the very first
 * real wallbox, confirm the frc/amp semantics + phase behaviour (see the smoke
 * note in CONTROL-BENCH.md / the PR).
 *
 * The control keys, quoted from the go-e HTTP API v2 docs (apikeys-en.md):
 *   frc  R/W uint8  "forceState (Neutral=0, Off=1, On=2)"       <- the on/off lever
 *   amp  R/W uint8  "requestedCurrent in Ampere, used for       <- the current lever
 *                    display on LED ring and logic calculations"
 * Readback (status) keys, quoted:
 *   car  R  "carState ... (Unknown/Error=0, Idle=1, Charging=2, WaitCar=3,
 *            Complete=4, Error=5)"
 *   nrg  R  "energy array, U(...), I(...), P(L1,L2,L3,N,Total), pf(...)"  (P in W, v2)
 *   acu  R  "How many ampere is the car allowed to charge now?"  (info only)
 *   alw  R  "Is the car allowed to charge at all now?"           (info only)
 * The set endpoint (http-en.md): GET http://<ip>/api/set?<key>=<value>, values
 * json-encoded (integers plain), multiple keys joined with '&'; the response is
 * a json object with `true` per key on success or a string error message.
 *
 * PHASE / VOLTAGE: the kW -> ampere conversion needs the number of phases the
 * wallbox charges on and the line voltage. The v2 API does NOT expose a simple,
 * settable phase-switch key (psm/phaseSwitchMode is not in apikeys-en.md; phase
 * selection is the charger's own logic), so this module does NOT write a phase
 * mode - it takes the phase COUNT + voltage as CONFIG (from the entity driver /
 * source connection, defaults 3 phases @ 230 V) purely to convert power->current.
 * That matches the read side, where nrg[11] (~11040 W) == 16 A x 3 x 230 V.
 *
 * SAFETY (mirrors inverter-control-routing.js §6, the whole control model):
 *   - controlPlan() is a PURE function - it computes a plan, never does I/O
 *     (makeExecutor(deps) performs the HTTP set/readback), so it is fully
 *     unit-testable offline and the flow embeds a synced copy (flows-sync).
 *   - Control is OFF by default: command.control_enabled is the core kill-switch
 *     (VP_CONTROL_ENABLED) AND the family certification verdict, folded into one
 *     boolean. When false, `writes` is EMPTY - the readback still runs so the UI
 *     shows the wallbox's ACTUAL state, but nothing is written.
 *   - Guard-authoritative: the setpoint is already clamped upstream by the
 *     per-entity consumer band; this module NEVER widens it - it FLOORS the
 *     current (actual charge power <= commanded), and clamps to the go-e current
 *     band [min,max] A.
 *   - Fail-safe NEUTRAL on stale/loss: a stale/absent command yields frc=0
 *     (Neutral) - control is handed back to the wallbox's own logic, NEVER a
 *     stuck forced current. A DELIBERATE "no charging this slot" (setpoint below
 *     the minimum charge current, or on_off=false) is the distinct frc=1 (Off).
 */

// The go-e HTTP API v2 forceState (frc) enum - facts from apikeys-en.md.
const FRC = { NEUTRAL: 0, OFF: 1, ON: 2 };

// The status keys we read back after a set (payload-shrinking filter).
const READBACK_FILTER = 'frc,amp,acu,car,nrg,alw';

// Index of the TOTAL charging power in the nrg array (see goe-api.js; the
// authoritative decode lives there - this is inlined because the flow embeds
// each module standalone and cannot require a sibling at runtime). Pinned + a
// test asserts it equals goe-api's NRG_TOTAL_POWER_IDX so the two never drift.
const NRG_TOTAL_POWER_IDX = 11;

// The go-e current band. minChargingCurrent (mca) is 6 A on go-e hardware; the
// max is model/adapter dependent (ama/adi). Both are CONFIG-overridable; a
// desired current below the minimum means "do not charge" (frc=Off), never a
// sub-minimum amp write (the charger would reject it / behave oddly).
const DEFAULT_MIN_CURRENT_A = 6;
const DEFAULT_MAX_CURRENT_A = 16;
const DEFAULT_PHASES = 3;
const DEFAULT_VOLTAGE = 230;

// The per-family control CERTIFICATION allowlist (the inverter-control-routing
// precedent). go-e's HTTP API v2 is documented + deterministic + software-
// provable (no guessed registers), so it is certified - unlike the Deye/Fronius
// bench_pending families.
const CERTIFIED_CONTROL_FAMILIES = new Set(['goe_http_api']);

// Error codes shared with test-read.js / edge-app/core/internal/testconn / the
// portal, so the UI maps one honest set to German copy.
const ERR_INVALID_REQUEST = 'invalid_request';
const ERR_UNREACHABLE = 'unreachable';
const ERR_NO_ANSWER = 'no_answer';
const ERR_INVALID_RESPONSE = 'invalid_response';

const DEFAULT_HTTP_TIMEOUT_MS = 8000;

function isFiniteNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function num(v, d) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && isFinite(n) ? n : d;
}

/**
 * currentForPower - map a charge power (kW) onto a whole-ampere requested
 * current for `phases` phases at `voltage` V. FLOORED so the actual charge
 * power never exceeds the commanded setpoint (guard-authoritative). Returns 0
 * for a non-positive / non-finite power.
 *   I[A] = floor( P[W] / (phases * voltage) )   (P = 3 x 230 x 16 = 11040 W)
 */
function currentForPower(kw, phases, voltage) {
  if (!isFiniteNum(kw) || kw <= 0) return 0;
  const denom = phases * voltage;
  if (denom <= 0) return 0;
  return Math.floor((kw * 1000) / denom);
}

/** powerForCurrent - the inverse (kW), for surfacing the effective target. */
function powerForCurrent(amp, phases, voltage) {
  return Math.round(((amp * phases * voltage) / 1000) * 1000) / 1000;
}

/**
 * controlPlan - map a go-e connection config + an arbitrated consumer command
 * onto a pure WRITE PLAN + readback plan.
 *
 *   config:  { ip, port?, phases?, voltage?, min_current_a?, max_current_a? }
 *            (from the entity driver.connection; the tuning fields are optional).
 *   command: { setpoint_kw?, on_off?, control_enabled?, stale?, source? } - the
 *            arbitrated, already guard-clamped consumer command. control_enabled
 *            is the core kill-switch + the family cert verdict.
 *   opts:    reserved.
 *
 * Returns:
 *   { adapter:'goe_http_api', family:'goe_http_api', certified, controlEnabled,
 *     target, mode, frc, amp, requestedKw,
 *     writes:  [{ key, value, role }],   // EMPTY when not controlEnabled / idle
 *     readbacks:[{ key, role, expect? }],
 *     reason? }
 *
 * mode: 'charge' | 'off' | 'neutral' | 'idle'.
 */
function controlPlan(config, command, opts) {
  opts = opts || {};
  const idle = (reason) => ({
    adapter: 'goe_http_api', family: 'goe_http_api', certified: false,
    controlEnabled: false, mode: 'idle', frc: null, amp: null, requestedKw: null,
    writes: [], readbacks: [], reason,
  });

  const cfg = config || {};
  const ip = typeof cfg.ip === 'string' ? cfg.ip.trim() : '';
  if (!ip) return idle('keine IP-Adresse');
  const port = num(cfg.port, 0) > 0 ? num(cfg.port, 0) : 0;
  const target = port ? ip + ':' + port : ip;

  const certified = CERTIFIED_CONTROL_FAMILIES.has('goe_http_api');
  const controlEnabled = !!(command && command.control_enabled === true) && certified;

  const phases = num(cfg.phases, DEFAULT_PHASES) > 0 ? num(cfg.phases, DEFAULT_PHASES) : DEFAULT_PHASES;
  const voltage = num(cfg.voltage, DEFAULT_VOLTAGE) > 0 ? num(cfg.voltage, DEFAULT_VOLTAGE) : DEFAULT_VOLTAGE;
  const minA = Math.max(1, Math.round(num(cfg.min_current_a, DEFAULT_MIN_CURRENT_A)));
  const maxA = Math.max(minA, Math.round(num(cfg.max_current_a, DEFAULT_MAX_CURRENT_A)));

  // The readback plan ALWAYS runs (report §5): read every control key back so
  // the UI shows the wallbox's actual state, whether or not we wrote this tick.
  // frc/amp carry an `expect` iff we wrote them (below); car/nrg/acu/alw are
  // informational (no match assertion).
  const readbacks = [
    { key: 'frc', role: 'force_state' },
    { key: 'amp', role: 'requested_current' },
    { key: 'car', role: 'car_state' },
    { key: 'nrg', role: 'charging_power' },
    { key: 'acu', role: 'allowed_current' },
    { key: 'alw', role: 'charge_allowed' },
  ];

  // Decide the tri-state target (frc/amp) from the command.
  let mode; let frc; let amp = null; let requestedKw = null;
  const cmd = command || {};
  const hasSetpoint = isFiniteNum(cmd.setpoint_kw);
  const explicitOff = cmd.on_off === false;
  const stale = cmd.stale === true;

  if (stale || (!hasSetpoint && cmd.on_off !== true)) {
    // Fail-safe on stale/loss OR a command carrying nothing actionable: hand
    // control back to the wallbox's own logic. NEVER a stuck forced current.
    mode = 'neutral';
    frc = FRC.NEUTRAL;
  } else if (explicitOff) {
    // Deliberate "no charging this slot": explicit Off (distinct from neutral).
    mode = 'off';
    frc = FRC.OFF;
  } else {
    // Charge intent. Compute the current from the setpoint; on_off=true with no
    // setpoint means "charge at the allowed maximum" (no power was specified).
    const wishA = hasSetpoint ? currentForPower(cmd.setpoint_kw, phases, voltage) : maxA;
    if (wishA < minA) {
      // Below the minimum charge current (incl. a 0 kW setpoint) -> stop.
      mode = 'off';
      frc = FRC.OFF;
    } else {
      mode = 'charge';
      frc = FRC.ON;
      amp = Math.min(maxA, wishA);
      requestedKw = powerForCurrent(amp, phases, voltage);
    }
  }

  // The intended writes (always computed so the tests/readback see the full
  // mapping); whether they EXECUTE depends on the kill-switch gate.
  const planned = [{ key: 'frc', value: frc, role: 'force_state' }];
  if (mode === 'charge') planned.push({ key: 'amp', value: amp, role: 'requested_current' });

  // Attach the expected values to the matching readbacks (only what we wrote).
  for (const rb of readbacks) {
    if (rb.key === 'frc') rb.expect = frc;
    if (rb.key === 'amp' && mode === 'charge') rb.expect = amp;
  }

  const out = {
    adapter: 'goe_http_api', family: 'goe_http_api', target,
    certified, controlEnabled, mode, frc, amp, requestedKw,
    phases, voltage, minA, maxA,
    writes: controlEnabled ? planned : [],
    readbacks,
    planned,
  };
  if (!controlEnabled) {
    out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)' : 'Modell noch nicht freigegeben';
  }
  return out;
}

/**
 * setUrl - the go-e /api/set URL for a plan's writes. Integers are written
 * plain (valid json numbers). Returns null when there is nothing to write.
 */
function setUrl(ip, port, writes) {
  if (!Array.isArray(writes) || writes.length === 0) return null;
  const portPart = port ? ':' + port : '';
  const q = writes.map((w) => w.key + '=' + encodeURIComponent(String(w.value))).join('&');
  return 'http://' + ip + portPart + '/api/set?' + q;
}

/** statusUrl - the go-e /api/status readback URL (filtered to the control keys). */
function statusUrl(ip, port) {
  const portPart = port ? ':' + port : '';
  return 'http://' + ip + portPart + '/api/status?filter=' + READBACK_FILTER;
}

/** carLabel - honest carState label (Unknown/Error=0..Error=5). */
function carLabel(car) {
  const map = { 0: 'unknown', 1: 'idle', 2: 'charging', 3: 'waiting', 4: 'complete', 5: 'error' };
  const c = num(car, null);
  return c !== null && Object.prototype.hasOwnProperty.call(map, c) ? map[c] : 'unknown';
}

/**
 * evalReadback - given a plan and a parsed go-e /api/status response, compute
 * the commanded-vs-actual match per WRITTEN key plus the informational state.
 *
 * Returns:
 *   { registers: [{ role, key, commanded, actual, match }],
 *     all_match: boolean|null,   // null when nothing was written (readback-only)
 *     car, charging, power_kw|null, allowed_current|null, allowed|null }
 *
 * Only the keys we WROTE (plan.writes) are match-checked; a wallbox that clamps
 * amp below our request (car/adapter limit) shows in acu, not as a mismatch of
 * OUR command. A missing/non-numeric field -> match:false for a written key
 * (we could not confirm it), and absent-not-fabricated for the info fields.
 */
function evalReadback(plan, status) {
  const registers = [];
  const st = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
  const wroteKeys = new Set((plan && plan.writes ? plan.writes : []).map((w) => w.key));

  let allMatch = wroteKeys.size > 0 ? true : null;
  for (const rb of (plan && plan.readbacks ? plan.readbacks : [])) {
    if (rb.key !== 'frc' && rb.key !== 'amp') continue;
    if (!wroteKeys.has(rb.key)) continue; // only assert what we wrote
    const actual = num(st[rb.key], null);
    const match = actual !== null && actual === rb.expect;
    registers.push({ role: rb.role, key: rb.key, commanded: rb.expect, actual, match });
    if (!match) allMatch = false;
  }

  // Informational state (absent-not-fabricated).
  let powerKw = null;
  if (Array.isArray(st.nrg)) {
    const w = num(st.nrg[NRG_TOTAL_POWER_IDX], null);
    if (w !== null) powerKw = Math.round(Math.max(0, w) / 1000 * 1000) / 1000;
  }
  const car = carLabel(st.car);
  return {
    registers,
    all_match: allMatch,
    car,
    charging: car === 'charging',
    power_kw: powerKw,
    allowed_current: num(st.acu, null),
    allowed: typeof st.alw === 'boolean' ? st.alw : null,
  };
}

/**
 * readbackPayload - the edge/entities/{id}/readback message (v1 readback shape,
 * per the entity contract §4): the core's onEntityReadback consumes `all_match`.
 */
function readbackPayload(entityID, ts, plan, verdict) {
  return {
    schema_version: '1.0',
    entity_id: entityID,
    ts: ts,
    adapter: 'goe_http_api',
    mode: plan.mode,
    control_enabled: plan.controlEnabled,
    wrote: plan.writes.length > 0,
    all_match: verdict.all_match,
    registers: verdict.registers,
    car: verdict.car,
    charging: verdict.charging,
    power_kw: verdict.power_kw,
    allowed_current: verdict.allowed_current,
    allowed: verdict.allowed,
    reason: plan.reason,
  };
}

/**
 * makeExecutor(deps) - the deps-injected HTTP set+readback loop (the makeReadOnce
 * pattern from test-read.js, so the SAME code runs in a unit test with a real
 * `http` + in-process server and in the flow node with the embedded module +
 * global http). deps = { http, timeoutMs? }.
 *
 * Returns execute(config, command, opts) -> Promise<Result>:
 *   { ok:true,  wrote, plan, readback }                    // readback = evalReadback verdict
 *   { ok:false, error_code, message?, plan? }
 * error_code in { invalid_request, unreachable, no_answer, invalid_response }.
 *
 * When control is disabled (kill-switch) but the ip is valid, execute() does the
 * READBACK ONLY (no set), so the UI still shows the wallbox's actual state -
 * wrote:false, readback present. An idle plan (no ip) is invalid_request.
 */
function makeExecutor(deps) {
  const http = deps.http;
  const TIMEOUT = deps.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS;

  // httpGetJson does ONE GET and parses the json body, classifying failures the
  // honest way (mirrors test-read.js readGoe): transport/connect -> unreachable,
  // timeout -> no_answer, HTTP>=400 / non-json -> invalid_response.
  function httpGetJson(url) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => { if (settled) return; settled = true; resolve(res); };
      let req;
      try {
        req = http.request(url, { method: 'GET', timeout: TIMEOUT }, (res) => {
          if (res.statusCode >= 400) { res.resume(); return done({ ok: false, error_code: ERR_INVALID_RESPONSE }); }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; if (body.length > 262144) { try { req.destroy(); } catch (e) { /* ignore */ } } });
          res.on('end', () => {
            let json;
            try { json = JSON.parse(body); } catch (e) { return done({ ok: false, error_code: ERR_INVALID_RESPONSE }); }
            done({ ok: true, json });
          });
        });
      } catch (e) {
        return done({ ok: false, error_code: ERR_UNREACHABLE });
      }
      req.on('error', () => done({ ok: false, error_code: ERR_UNREACHABLE }));
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } done({ ok: false, error_code: ERR_NO_ANSWER }); });
      req.end();
    });
  }

  // readback does the /api/status GET and evaluates the verdict.
  function readback(config, plan) {
    const url = statusUrl(config.ip, num(config.port, 0));
    return httpGetJson(url).then((r) => {
      if (!r.ok) return { ok: false, error_code: r.error_code, plan };
      return { ok: true, wrote: plan.writes.length > 0, plan, readback: evalReadback(plan, r.json) };
    });
  }

  return function execute(config, command, opts) {
    const plan = controlPlan(config, command, opts);
    if (plan.mode === 'idle') {
      return Promise.resolve({ ok: false, error_code: ERR_INVALID_REQUEST, message: plan.reason, plan });
    }
    // Kill-switch (or command wanted no write): readback only, never a set.
    if (plan.writes.length === 0) {
      return readback(config, plan);
    }
    const url = setUrl(config.ip, num(config.port, 0), plan.writes);
    return httpGetJson(url).then((r) => {
      if (!r.ok) return { ok: false, error_code: r.error_code, plan };
      // The set response is { key: true | "error string" } per go-e docs.
      for (const w of plan.writes) {
        const v = r.json ? r.json[w.key] : undefined;
        if (typeof v === 'string') {
          return { ok: false, error_code: ERR_INVALID_RESPONSE, message: 'go-e set ' + w.key + ': ' + v, plan };
        }
      }
      // Read the result back to prove the command landed.
      return readback(config, plan);
    });
  };
}

module.exports = {
  FRC,
  READBACK_FILTER,
  NRG_TOTAL_POWER_IDX,
  DEFAULT_MIN_CURRENT_A,
  DEFAULT_MAX_CURRENT_A,
  DEFAULT_PHASES,
  DEFAULT_VOLTAGE,
  CERTIFIED_CONTROL_FAMILIES,
  currentForPower,
  powerForCurrent,
  controlPlan,
  setUrl,
  statusUrl,
  carLabel,
  evalReadback,
  readbackPayload,
  makeExecutor,
  _errs: { ERR_INVALID_REQUEST, ERR_UNREACHABLE, ERR_NO_ANSWER, ERR_INVALID_RESPONSE },
};
