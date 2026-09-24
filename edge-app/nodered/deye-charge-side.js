'use strict';

/**
 * K5 "Deye Überschuss-Übergabe" (concept vp-wechselrichter-eigenregelung-k1 §5
 * Deye row, §6.3, §6.4, §9): the CHARGE side of the Deye remote tier (registers
 * 1100-1121, PR-978 layout) - the intents surplus_charge (E-up) and
 * self_consumption (E). E-down (cover_load) is NOT here; its path is unchanged.
 *
 * ⚠ ONE SOURCE, TWO RUNTIMES. inverter-control-routing.js requires this file and
 * build-flows.js embeds it VERBATIM into the control plan node (embedModule), so
 * the shipped flow and the tested module cannot drift. It therefore requires
 * nothing: every register fact arrives as `facts` from the caller (the routing
 * module's own tables, JSON'd into the flow at build time).
 *
 * TWO CANDIDATES, each released only by its OWN certificate entry
 * (unplanned-load-native.js `candidate`), and until then only reachable through
 * the armed pilot window (`native_pilot` on edge/setpoint, core
 * internal/agent/nativepilot.go):
 *
 *   grid_zero  "netzseitig Ziel 0": 1101 watchdog, 1109 <- 0, 1104 <- 2 (grid
 *              side), 1115 <- 999, 1100 <- 1 LAST. The 1109 write stands BEFORE
 *              the side switch: in the old battery-side meaning 0 is neutral (the
 *              battery rests), in the new grid-side meaning it is the target - so
 *              no stale battery setpoint can ever be read as a grid target (k2
 *              §2.9). 1115 <- 999 because 1000 (what Herzogau reads) throttles the
 *              own PV to 0 in grid mode (k2 §1.7). RAM registers, kept alive like
 *              the ordinary remote plan (1101/1109/1100 every tick), so a dead box
 *              ends it by the device's own 60-s watchdog.
 *              ⚠ Side effect (§6.3): with the storage full or at its charge limit
 *              the device throttles its OWN PV to hold the grid at 0 - also at a
 *              positive price. The plan says so (`curtailsOwnPv`), Layer 1 states
 *              it on the proving readback (native.curtails_own_pv) and the core
 *              takes the battery back (guards.NativeOwnPvCurtailed).
 *   own_config "Eigenkonfiguration": 1100 <- 0 - the device's own Work Mode /
 *              Energy Pattern / Solar Sell / Time-of-Use configuration
 *              regulates. Same bytes as the E-down pilot. The box READS that
 *              configuration and refuses (German reason) when it is not a safe
 *              self-consumption for THIS intent (E5 A: it never writes an
 *              installer/EEPROM register - Work Mode, ToU, 0x00E7, 0x006C/0x006D).
 */

const CHARGE_INTENTS = Object.freeze({ surplus_charge: true, self_consumption: true });
const CANDIDATES = Object.freeze({ grid_zero: true, own_config: true });

// The value 1115 is written with in grid mode: never 1000 or above (that throttles
// the own PV to 0), see DEYE_PV_MAX_PERMILLE_LIMIT in the routing module.
const GRID_ZERO_PV_MAX_PERMILLE = 999;

/**
 * deyeOwnConfigBlockSpec - ONE FC3 read covering Energy Pattern .. Program 6
 * Charging (hybrid_3p: 0x008D..0x00B1, 37 registers). One transaction instead of
 * nine single reads on a logger that serves one TCP client.
 */
function deyeOwnConfigBlockSpec(reg) {
  const count = (reg.progChargeBase + 6) - reg.energyPattern;
  return { role: 'own_config', fc: 3, addr: reg.energyPattern, count };
}

/**
 * deyeChargeSideCandidates - the two candidates' plans for one selection.
 *   facts: { remote, modeOn, modeOff, gridSide, reassertS, slot, chargeDisabled,
 *            touEnableBit, workMode, energyPattern, solarSellOn }
 *   ctx:   { reg (family control map), writeFc, watchdogS }
 * Each candidate: { planned, readbacks, preconditions, precondition(opts, intent),
 *                   heartbeat, curtailsOwnPv, windowSupported }.
 */
function deyeChargeSideCandidates(facts, ctx) {
  const reg = ctx.reg;
  const fc = ctx.writeFc;
  const wd = ctx.watchdogS;
  const R = facts.remote;
  // The three single reads the E-down pilot already performs (same roles, same
  // cache keys) - grid_zero needs no more than they say.
  const legacyPre = [
    { role: 'tou_enable', fc: 3, addr: reg.touEnable },
    { role: 'program_target_soc', fc: 3, addr: reg.progSocBase + facts.slot },
    { role: 'grid_charge_enable', fc: 3, addr: reg.progChargeBase + facts.slot },
  ];
  const ram = { dwell_s: 0, min_change: 0, always: true, bench_pending: true };
  const ramCfg = { dwell_s: 0, min_change: 0, reassert_s: facts.reassertS, bench_pending: true };
  const gridPlanned = [
    Object.assign({ role: 'remote_watchdog', fc: fc, addr: R.watchdog, value: wd & 0xffff,
      encode: { kind: 'remote_watchdog_s', seconds: wd } }, ram),
    Object.assign({ role: 'grid_power', fc: fc, addr: R.constantPower, value: 0,
      encode: { kind: 'grid_power_permille', kw: 0, neutral_before_side_switch: true } }, ram),
    Object.assign({ role: 'power_control_mode', fc: fc, addr: R.powerControlMode, value: facts.gridSide,
      encode: { kind: 'remote_power_control_mode', enum: 'grid_side' } }, ramCfg),
    Object.assign({ role: 'pv_max_permille', fc: fc, addr: R.pvMaxPower, value: GRID_ZERO_PV_MAX_PERMILLE,
      encode: { kind: 'pv_max_permille', permille: GRID_ZERO_PV_MAX_PERMILLE } }, ramCfg),
    Object.assign({ role: 'remote_mode', fc: fc, addr: R.mode, value: facts.modeOn,
      encode: { kind: 'remote_mode', enum: 'on', native: true } }, ram),
  ];
  const gridReadbacks = gridPlanned.map((w) => ({
    role: w.role, fc: 3, addr: w.addr, expect: w.value & 0xffff, tolerance: w.role === 'grid_power' ? 1 : 0,
  }));
  return {
    grid_zero: {
      planned: gridPlanned,
      readbacks: gridReadbacks,
      preconditions: legacyPre,
      precondition: (o) => deyeGridZeroPrecondition(facts, o && o.deyeOwnConfig, {
        floorPct: o && o.effectiveFloorSocPct, solarOnly: o && o.solarOnlyCharge === true }),
      heartbeat: true,
      curtailsOwnPv: true,
      windowSupported: false,
    },
    own_config: {
      planned: [{ role: 'remote_mode', fc: fc, addr: R.mode, value: facts.modeOff,
        encode: { kind: 'remote_mode', enum: 'off', native: true }, dwell_s: 0, min_change: 0, bench_pending: true }],
      readbacks: [{ role: 'remote_mode', fc: 3, addr: R.mode, expect: facts.modeOff, tolerance: 0 }],
      preconditions: legacyPre.concat([deyeOwnConfigBlockSpec(reg)]),
      precondition: (o, intent) => deyeOwnConfigPrecondition(facts, intent, o && o.deyeOwnConfig, {
        floorPct: o && o.effectiveFloorSocPct, solarOnly: o && o.solarOnlyCharge === true, reg }),
      heartbeat: false,
      curtailsOwnPv: false,
      windowSupported: false,
    },
  };
}

const regVal = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);

/**
 * deyeGridZeroPrecondition - what must hold before the grid-side candidate.
 * The device's OWN configuration is its failsafe here (the 60-s watchdog drops
 * it back there), so the EEG rule is read from it exactly like on E-down; and
 * in grid mode the device ignores its own SoC limits (openems2541), so the
 * platform floor must be known - the core's reserve floor is the only floor.
 */
function deyeGridZeroPrecondition(facts, cfg, o) {
  if (!cfg || typeof cfg !== 'object') {
    return 'Die eigene Konfiguration des Wechselrichters ist nicht bekannt - es wird nicht umgeschaltet';
  }
  if (!isFinite(regVal(o && o.floorPct))) {
    return 'Die Reserve-Untergrenze der Anlage ist nicht bekannt - im netzseitigen Modus achtet der '
      + 'Wechselrichter nicht auf seine eigenen Ladegrenzen, es wird nicht umgeschaltet';
  }
  if (o && o.solarOnly === true) {
    const charge = regVal(cfg.grid_charge_enable);
    if (!isFinite(charge) || charge !== facts.chargeDisabled) {
      return 'EEG-Anlage: das Zeitfenster-Programm des Wechselrichters erlaubt das Laden aus dem Netz '
        + '- es wird nicht umgeschaltet';
    }
  }
  return null;
}

// Minutes since midnight of a Deye ToU start time (decimal HHMM), NaN when the
// register cannot be a time of day.
function hhmm(v) {
  const n = regVal(v);
  if (!isFinite(n) || n < 0) return NaN;
  const h = Math.floor(n / 100);
  const m = n % 100;
  if (h > 23 || m > 59) return NaN;
  return h * 60 + m;
}

/**
 * deyeActiveProgram - which of the six ToU programs governs at `nowMin`: the one
 * with the latest start <= now (ties -> the later program, the earlier one has no
 * duration); before every start the day wraps to the latest start. -1 = the
 * times cannot be read.
 */
function deyeActiveProgram(times, nowMin) {
  if (!Array.isArray(times) || times.length !== 6 || !isFinite(regVal(nowMin))) return -1;
  const mins = times.map(hhmm);
  if (mins.some((m) => !isFinite(m))) return -1;
  let best = -1;
  for (let i = 0; i < 6; i++) if (mins[i] <= nowMin && (best < 0 || mins[i] >= mins[best])) best = i;
  if (best >= 0) return best;
  for (let i = 0; i < 6; i++) if (best < 0 || mins[i] >= mins[best]) best = i;
  return best;
}

/**
 * deyeOwnConfigPrecondition - the EXTENDED precondition of the own_config
 * candidate (E5 A: read, never write). The decision table, top to bottom; every
 * refusal is a German sentence naming the setting the installer would look at:
 *
 *   read        the block (Energy Pattern .. Program 6) and the read time
 *   Work Mode   1 "Zero Export To Load" regulates only the load port -> refused;
 *               an unknown value -> refused
 *   Energy Pat. 0 "Battery First" charges before serving the house (the house
 *               imports meanwhile - the Herzogau symptom) -> refused
 *   Solar Sell  Work Mode 2 "Zero Export To CT" without Solar Sell throttles the
 *               PV at full storage instead of exporting -> refused
 *   active prog which ToU program governs NOW (not just Program 1)
 *   EEG         ToU on and the active program may charge from the grid -> refused
 *   E-up        must not discharge into the house: ToU off (manual: without ToU
 *               it only discharges for its own consumption) or the active
 *               program's power is 0
 *   E           must cover: ToU on, active program power > 0, its target SoC <=
 *               the platform floor - and NOT Work Mode 0 "Selling First": with ToU
 *               active the manual lets it sell battery energy into the grid
 *
 * Returns null when the device may be let go for `intent`, else the reason.
 */
function deyeOwnConfigPrecondition(facts, intent, cfg, o) {
  if (!CHARGE_INTENTS[intent]) return 'Unbekannte Absicht für die Wechselrichter-Automatik';
  if (!cfg || typeof cfg !== 'object') {
    return 'Die eigene Konfiguration des Wechselrichters ist nicht bekannt - es wird nicht umgeschaltet';
  }
  const reg = o && o.reg;
  const block = cfg.own_config;
  const spec = reg ? deyeOwnConfigBlockSpec(reg) : null;
  if (!spec || !Array.isArray(block) || block.length < spec.count) {
    return 'Die eigene Konfiguration des Wechselrichters (Arbeitsmodus, Energiemuster, Zeitfenster-Programm) '
      + 'konnte nicht gelesen werden - es wird nicht umgeschaltet';
  }
  const at = (addr) => regVal(block[addr - spec.addr]);
  const workMode = at(reg.workMode);
  const pattern = at(reg.energyPattern);
  const solarSell = at(reg.solarSell);
  const tou = at(reg.touEnable);
  const WM = facts.workMode;
  const EP = facts.energyPattern;
  if (workMode === WM.ZERO_EXPORT_TO_LOAD) {
    return 'Arbeitsmodus „Zero Export To Load“: der Wechselrichter regelt nur seinen Lastausgang, '
      + 'nicht den Netzanschluss - das ist kein Eigenverbrauch am Netzpunkt';
  }
  if (workMode !== WM.EXPORT_FIRST && workMode !== WM.ZERO_EXPORT_TO_CT) {
    return 'Der Arbeitsmodus des Wechselrichters (' + workMode + ') ist unbekannt - es wird nicht umgeschaltet';
  }
  if (pattern === EP.BATTERY_FIRST) {
    return 'Energiemuster „Battery First“: der Wechselrichter lädt den Speicher vor dem Hausverbrauch - '
      + 'das Haus bezöge dabei Strom aus dem Netz';
  }
  if (pattern !== EP.LOAD_FIRST) {
    return 'Das Energiemuster des Wechselrichters (' + pattern + ') ist unbekannt - es wird nicht umgeschaltet';
  }
  if (workMode === WM.ZERO_EXPORT_TO_CT && solarSell !== facts.solarSellOn) {
    return 'Nulleinspeisung ohne „Solar Sell“: bei vollem Speicher würde der Wechselrichter seine PV '
      + 'abregeln statt einzuspeisen';
  }
  if (!isFinite(tou)) {
    return 'Das Zeitfenster-Programm des Wechselrichters konnte nicht gelesen werden - es wird nicht umgeschaltet';
  }
  const touOn = (tou & facts.touEnableBit) !== 0;
  let prog = -1;
  if (touOn) {
    const times = [];
    for (let i = 0; i < 6; i++) times.push(at(reg.progTimeBase + i));
    prog = deyeActiveProgram(times, cfg.now_min);
    if (prog < 0) {
      return 'Welches Zeitfenster-Programm gerade gilt, konnte nicht gelesen werden - es wird nicht umgeschaltet';
    }
  }
  const progName = 'Programm ' + (prog + 1);
  const power = touOn ? at(reg.progPowerBase + prog) : NaN;
  const targetSoc = touOn ? at(reg.progSocBase + prog) : NaN;
  const charge = touOn ? at(reg.progChargeBase + prog) : NaN;
  if (touOn && o && o.solarOnly === true && charge !== facts.chargeDisabled) {
    return 'EEG-Anlage: das gerade gültige Zeitfenster-' + progName + ' erlaubt das Laden aus dem Netz '
      + '- es wird nicht umgeschaltet';
  }
  if (intent === 'surplus_charge') {
    if (!touOn) return null;
    if (!isFinite(power)) {
      return 'Die Leistung des Zeitfenster-' + progName + ' konnte nicht gelesen werden - es wird nicht umgeschaltet';
    }
    if (power > 0) {
      return 'Das gerade gültige Zeitfenster-' + progName + ' erlaubt dem Wechselrichter zu entladen - '
        + '„nur Überschuss laden“ wäre so nicht gewahrt';
    }
    return null;
  }
  // self_consumption
  if (!touOn) {
    return 'Das Zeitfenster-Programm (Time of Use) des Wechselrichters ist nicht aktiv - '
      + 'ohne es deckt er laut Handbuch nicht den Hausverbrauch aus der Batterie';
  }
  if (workMode === WM.EXPORT_FIRST) {
    return 'Arbeitsmodus „Selling First“ mit aktivem Zeitfenster-Programm: der Wechselrichter darf laut '
      + 'Handbuch auch Speicherenergie ins Netz verkaufen - das ist kein Eigenverbrauch';
  }
  if (!isFinite(power) || !(power > 0)) {
    return 'Das gerade gültige Zeitfenster-' + progName + ' hat keine Entladeleistung - '
      + 'der Wechselrichter würde den Hausverbrauch nicht aus der Batterie decken';
  }
  if (!isFinite(targetSoc) || targetSoc < 0 || targetSoc > 100) {
    return 'Das Ziel-Ladeniveau des Zeitfenster-' + progName + ' konnte nicht gelesen werden - es wird nicht umgeschaltet';
  }
  const floor = regVal(o && o.floorPct);
  if (!isFinite(floor)) {
    return 'Die Reserve-Untergrenze der Anlage ist nicht bekannt - es wird nicht umgeschaltet';
  }
  if (targetSoc > floor) {
    return 'Das Ziel-Ladeniveau des Zeitfenster-' + progName + ' (' + targetSoc + ' %) liegt über der '
      + 'Reserve-Untergrenze der Anlage (' + floor + ' %) - der Wechselrichter würde die Deckung zu früh beenden';
  }
  return null;
}

/**
 * parseNativePilot - the armed pilot window as the core publishes it
 * (`native_pilot` on edge/setpoint). Anything malformed is null - an unknown
 * candidate may not move a register - and the field only ever originates in the
 * core's operator-armed path (never a plan, never a schedule).
 */
function parseNativePilot(v) {
  if (!v || typeof v !== 'object') return null;
  const candidate = typeof v.candidate === 'string' ? v.candidate : '';
  const intent = typeof v.intent === 'string' ? v.intent : '';
  if (!CANDIDATES[candidate] || !CHARGE_INTENTS[intent]) return null;
  return { candidate, intent, run: typeof v.run === 'string' ? v.run : '' };
}

/**
 * selectDeyeChargeSide - Box ② on the Deye charge side. With a pilot: exactly
 * the chosen candidate, WITHOUT a certificate (the armed operator window IS the
 * bench, like the grid-setpoint test) but with every other gate. Without one:
 * the certified entries for this intent in catalog order; the first whose bytes
 * still match, whose window fits and whose device precondition holds wins.
 * Returns { name, cand, entry } or { refusal } (the first refusal met).
 */
function selectDeyeChargeSide(a) {
  const native = a.native;
  const tryOne = (name, entry) => {
    const cand = Object.prototype.hasOwnProperty.call(a.candidates, name) ? a.candidates[name] : null;
    if (!cand) return { refusal: 'Unbekannter Übergabe-Kandidat für die Deye-Ladeseite' };
    if (entry && !native.certificateMatchesPlan(entry, cand.planned, cand.readbacks)) {
      return { refusal: 'Prüfstand-Freigabe und Schreibplan stimmen nicht überein - Freigabe erneuern' };
    }
    if (a.windowNarrower && !(entry && entry.windowLimits === true && cand.windowSupported === true)) {
      return { refusal: 'Das Fenster ist enger als der Eigenmodus des Wechselrichters - für Grenzen im Eigenmodus gibt es keine Freigabe' };
    }
    const refusal = cand.precondition(a.precond, a.intent);
    if (refusal) return { refusal };
    return { name, cand, entry: entry || null };
  };
  if (a.pilot) {
    if (a.pilot.intent !== a.intent) {
      return { refusal: 'Pilotfenster: die Absicht des Sollwerts passt nicht zum gewählten Test' };
    }
    return tryOne(a.pilot.candidate, null);
  }
  const word = native.capabilityForIntent(a.intent);
  const entries = native.exactCapabilities(a.key, a.catalog, word)
    .filter((e) => typeof e.candidate === 'string');
  if (entries.length === 0) {
    return { refusal: 'Wechselrichter-Automatik für dieses Modell noch nicht am Prüfstand freigegeben' };
  }
  let first = null;
  for (const e of entries) {
    const r = tryOne(e.candidate, e);
    if (!r.refusal) return r;
    if (!first) first = r;
  }
  return first;
}

/**
 * deyeChargeSidePreconditions - the reads an executor must perform while a
 * charge-side intent stands: the union over the candidates that could be chosen
 * (the pilot's alone, else every certified one), deduplicated by role. Reading a
 * candidate's configuration costs one tick; not reading it is a refusal.
 */
function deyeChargeSidePreconditions(candidates, names) {
  const out = [];
  const seen = {};
  for (const n of names) {
    const c = Object.prototype.hasOwnProperty.call(candidates, n) ? candidates[n] : null;
    if (!c) continue;
    for (const p of c.preconditions) {
      if (seen[p.role]) continue;
      seen[p.role] = true;
      out.push(Object.assign({}, p));
    }
  }
  return out;
}

module.exports = {
  GRID_ZERO_PV_MAX_PERMILLE,
  deyeOwnConfigBlockSpec,
  deyeChargeSideCandidates,
  deyeGridZeroPrecondition,
  deyeOwnConfigPrecondition,
  deyeActiveProgram,
  parseNativePilot,
  selectDeyeChargeSide,
  deyeChargeSidePreconditions,
};
