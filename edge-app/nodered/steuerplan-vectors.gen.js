'use strict';

/**
 * Erzeugt steuerplan-vectors.json: die GEMEINSAMEN Testvektoren zwischen der
 * Schreibseite der Docker-Box (Quelle der Wahrheit: inverter-control-routing.js
 * mit den eingebetteten Modulen deye-charge-side.js, deye-grid-target.js,
 * deye-tou-budget.js, unplanned-load-native.js, readback-verify.js, und der
 * Knoten "Steuerung / Schreibplan" aus flows.json) und ihrem Go-Zwilling in
 * Edge Light (edge-app/core/internal/steuerplan).
 *
 * Das Muster von register-write-vectors.gen.js: die erwarteten Ausgaben
 * entstehen aus dem JavaScript selbst; steuerplan-vectors.test.js rechnet sie
 * bei jedem Lauf neu.
 *
 *   node edge-app/nodered/steuerplan-vectors.gen.js
 *
 * Der Plan-Knoten laeuft als ECHTER Rumpf aus flows.json in einer vm mit
 * fester Uhr, getrennten Ablagen 'memory' und 'file' und eigenem
 * Knotenkontext; ein Fall ist eine FOLGE von Takten, damit Zustand (die
 * Uebernahme der Steuerung, die einmal geschriebene Automatik) mitgeprueft
 * wird. Zahlen ausserhalb von JSON (NaN, +-Infinity) reisen als {"$num": ...}.
 *
 * Nur Deye (solarman_v5): Fronius und das generische SunSpec-Schreiben folgen
 * in eigenen Teilstufen.
 */

process.env.TZ = 'Europe/Berlin';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = require('./inverter-control-routing.js');
const RBV = require('./readback-verify.js');
const TOUB = require('./deye-tou-budget.js');
const DCS = require('./deye-charge-side.js');
const NATIVE = require('./unplanned-load-native.js');

const OUT = path.join(__dirname, 'steuerplan-vectors.json');
const OUT_KNOTEN = path.join(__dirname, 'steuerplan-knoten-vectors.json');
const OUT_AUTOMATIK = path.join(__dirname, 'steuerplan-automatik-vectors.json');
const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const PLAN_BODY = flows.find((n) => n.id === 'auto-control-plan').func;
const RECOVER_BODY = flows.find((n) => n.id === 'auto-control-recover').func;
const CATALOG_ANCHOR = 'var nativeCatalogGeneric = __NATIVE.CERTIFIED_NATIVE_CAPABILITIES;';

// --- JSON-Kodierung ohne Verlust ----------------------------------------------
function enc(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $num: 'NaN' };
    if (v === Infinity) return { $num: 'Infinity' };
    if (v === -Infinity) return { $num: '-Infinity' };
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : enc(x)));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (v[k] === undefined || typeof v[k] === 'function') continue;
      o[k] = enc(v[k]);
    }
    return o;
  }
  return v;
}

// flowFns - die Funktionen, die der Plan-Knoten WIRKLICH ausfuehrt: seine
// eingebetteten Kopien (controlRoute, controlRelease, ...), nicht das Modul.
// Funktionsdeklarationen sind im Rumpf gehoben; der Rumpf laeuft ohne Sollwert
// bis zu seinem fruehen Ende, danach tragen die Closures alle Hilfswerte.
function flowFns() {
  let got = null;
  const sandbox = {
    __grab: (o) => { got = o; },
    msg: {}, node: { status() {}, error() {}, warn() {} },
    context: { get: () => undefined, set: () => {} }, flow: { get: () => undefined, set: () => {} },
    Buffer, Math, isFinite, Number, Array, Object, JSON, String, Date,
  };
  new vm.Script('(function(){ __grab({ controlRoute: controlRoute, controlRelease: controlRelease });\n' + PLAN_BODY + '\n})()')
    .runInContext(vm.createContext(sandbox));
  return got;
}
const FLOW = flowFns();

// --- feste Uhr fuer den Knotenrumpf ---------------------------------------------
function fakeDate(nowMs) {
  const Real = Date;
  class D extends Real {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  }
  D.parse = Real.parse;
  D.UTC = Real.UTC;
  return D;
}

const T0 = Date.UTC(2026, 10, 20, 9, 30, 0); // 20.11.2026 10:30 Berlin
const iso = (ms) => new Date(ms).toISOString();

// --- Auswahl, Faehigkeit, Sollwert ------------------------------------------
const CONN = { ip: '192.168.1.50', serial: '1234567890', mb_slave_id: 1 };
const sel = (over = {}, conn = {}) => Object.assign({
  schema_version: '1.0', brand: 'deye', label: 'Deye', model: 'sun-30k-sg01hp3', family: 'hybrid_3p',
  communication: 'solarman_v5', control_tier: 3, rated_kw: 30,
}, over, { connection: Object.assign({}, CONN, conn) });

const REMOTE_BLOCK = (() => {
  const b = new Array(22).fill(0);
  b[1] = 0xffff; b[5] = 2; // 1101 watchdog off, 1105 strategy 2
  return b;
})();
const V105_BLOCK = (() => {
  const b = new Array(22).fill(0);
  b[0] = 0; b[1] = 0xffff; b[4] = 7; b[6] = 1; b[11] = 0xfff0; // 1104 out of range, 1106 = 1, 1111 = -16
  return b;
})();
const cap = (kind) => {
  switch (kind) {
    case 'remote': return R.classifyDeyeCapability({ deviceType: 0x0006, remoteBlock: REMOTE_BLOCK });
    case 'remote_lv': return R.classifyDeyeCapability({ deviceType: 0x0005, remoteBlock: REMOTE_BLOCK });
    case 'remote_noscale': return R.classifyDeyeCapability({ deviceType: 0x1234, remoteBlock: REMOTE_BLOCK });
    case 'tou': return R.classifyDeyeCapability({ deviceType: 0x0006, remoteBlock: null });
    case 'tou_lv': return R.classifyDeyeCapability({ deviceType: 0x0500, remoteBlock: null });
    case 'tou_noscale': return R.classifyDeyeCapability({ deviceType: 0, remoteBlock: null });
    case 'v105': return R.classifyDeyeCapability({ deviceType: 0x0006, remoteBlock: V105_BLOCK });
    case 'transient': return R.classifyDeyeCapability({ deviceType: 0x0006, remoteBlock: null, error: 'Timeout', definitive: false });
    case 'zero': return R.classifyDeyeCapability({ deviceType: 0x0006, remoteBlock: new Array(22).fill(0) });
    default: return undefined;
  }
};
const sticky = (kind) => {
  switch (kind) {
    case 'remote': return R.deyeUpdateSticky(null, cap('remote'), T0 - 3600e3);
    case 'remote_bare': return { path: 'remote', since: T0 - 3600e3, contrary: 0, everRemote: true };
    case 'remote_v105': return { path: 'remote', since: T0, contrary: 0, everRemote: true, verdict: cap('v105') };
    case 'tou': return R.deyeUpdateSticky(null, cap('tou'), T0 - 3600e3);
    case 'tou_ever_remote': return { path: 'tou', since: T0, contrary: 0, everRemote: true, verdict: cap('tou') };
    case 'tou_bare': return { path: 'tou', since: T0, contrary: 1, everRemote: false };
    case 'kaputt': return { path: 'quer', since: T0 };
    default: return undefined;
  }
};
const sp = (over = {}) => Object.assign({
  battery_setpoint_kw: -1.5, source: 'schedule', slot_start: '2026-11-20T09:30:00Z', ts: iso(T0 - 5000),
  control_enabled: true, device_certified: true, soc_min_pct: 20, soc_max_pct: 95, grid_charge_allowed: false,
}, over);

// Deye-Eigenkonfiguration 0x008D..0x00B1 (37 Register) fuer die Vorbedingungen.
function ownConfig(o = {}) {
  const reg = R.DEYE_CONTROL_REG.hybrid_3p;
  const b = new Array(37).fill(0);
  const put = (addr, v) => { b[addr - reg.energyPattern] = v; };
  put(reg.energyPattern, o.pattern !== undefined ? o.pattern : 1);
  put(reg.workMode, o.workMode !== undefined ? o.workMode : 2);
  put(reg.solarSell, o.solarSell !== undefined ? o.solarSell : 1);
  put(reg.touEnable, o.tou !== undefined ? o.tou : 0x00ff);
  const times = o.times || [0, 600, 1200, 1800, 2200, 2300];
  for (let i = 0; i < 6; i++) put(reg.progTimeBase + i, times[i]);
  for (let i = 0; i < 6; i++) put(reg.progPowerBase + i, o.power !== undefined ? o.power : 5000);
  for (let i = 0; i < 6; i++) put(reg.progSocBase + i, o.soc !== undefined ? o.soc : 10);
  for (let i = 0; i < 6; i++) put(reg.progChargeBase + i, o.charge !== undefined ? o.charge : 0);
  return b;
}
const nativeCfg = (o = {}, at = T0 - 10000) => ({
  at, now_min: o.now_min !== undefined ? o.now_min : 630, tou_enable: 0x00ff, program_target_soc: 10,
  grid_charge_enable: o.charge !== undefined ? o.charge : 0, own_config: o.block === null ? undefined : ownConfig(o),
});

// --- Kataloge ------------------------------------------------------------------
const CATALOGS = {
  produktion: NATIVE.CERTIFIED_NATIVE_CAPABILITIES,
  ladeseite_netz: NATIVE.CERTIFIED_NATIVE_CAPABILITIES.concat([
    NATIVE.releaseDeyeChargeSide('grid_zero', 'self_consumption', 'Vektor-Nachweis'),
    NATIVE.releaseDeyeChargeSide('grid_zero', 'surplus_charge', 'Vektor-Nachweis'),
  ]),
  ladeseite_eigen: NATIVE.CERTIFIED_NATIVE_CAPABILITIES.concat([
    NATIVE.releaseDeyeChargeSide('own_config', 'self_consumption', 'Vektor-Nachweis'),
    NATIVE.releaseDeyeChargeSide('own_config', 'surplus_charge', 'Vektor-Nachweis'),
  ]),
  ladeseite_beide: NATIVE.CERTIFIED_NATIVE_CAPABILITIES.concat([
    NATIVE.releaseDeyeChargeSide('own_config', 'self_consumption', 'Vektor-Nachweis'),
    NATIVE.releaseDeyeChargeSide('grid_zero', 'self_consumption', 'Vektor-Nachweis'),
  ]),
  leer: [],
};

// --- der Plan-Knoten als echter Rumpf ------------------------------------------
function runPlanNode(state, msg, nowMs, catalogName) {
  const warns = [];
  const store = (name) => state.flow[name] || (state.flow[name] = {});
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn(s) { warns.push(String(s)); }, log() {}, send() {} },
    context: { get: (k) => state.ctx[k], set: (k, v) => { state.ctx[k] = v; } },
    flow: {
      get: (k, s) => store(s || 'memory')[k],
      set: (k, v, s) => { store(s || 'memory')[k] = v; },
    },
    __CATALOG: CATALOGS[catalogName || 'produktion'],
    Buffer, Math, isFinite, Number, Array, Object, JSON, String, Boolean, parseInt, parseFloat, isNaN,
    Date: fakeDate(nowMs),
  };
  const body = PLAN_BODY.replace(CATALOG_ANCHOR, 'var nativeCatalogGeneric = __CATALOG;');
  const out = new vm.Script('(function(){' + body + '\n})()').runInContext(vm.createContext(sandbox));
  return { out, warns };
}

function planCase(name, c) {
  const flow0 = JSON.parse(JSON.stringify(c.flow || {}));
  const state = { ctx: {}, flow: JSON.parse(JSON.stringify(flow0)) };
  const steps = [];
  let now = c.now || T0;
  for (const step of c.steps) {
    if (step.advance) now += step.advance;
    if (step.flow) {
      for (const s of Object.keys(step.flow)) Object.assign(state.flow[s] || (state.flow[s] = {}), step.flow[s]);
    }
    const { out, warns } = runPlanNode(state, { setpoint: step.setpoint }, now, c.catalog);
    steps.push({
      now,
      setpoint: step.setpoint,
      flow_delta: step.flow,
      control: out ? (out.control || null) : null,
      native_capabilities: out ? (out.nativeCapabilities || null) : null,
      native_refusal: out && typeof out.nativeRefusal === 'string' ? out.nativeRefusal : '',
      warns,
      ctx: {
        was_controlling: state.ctx.was_controlling === true,
        native_written: typeof state.ctx.native_written === 'string',
        native_refusal: typeof state.ctx.native_refusal === 'string' ? state.ctx.native_refusal : '',
      },
    });
  }
  return { name, catalog: c.catalog || 'produktion', flow: flow0, steps };
}

// shape - the input's form without its numbers: cases that differ only in a
// number collapse, a different word or field survives the dedupe.
function shape(v) {
  if (typeof v === 'number') return 'n';
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = shape(v[k]);
    return o;
  }
  return v;
}

// SHAPED: groups whose INPUT words steer branches (a grid-test step, an
// intent, a pilot candidate) - their cases are deduplicated by input form plus
// output, every other group by output alone.
const SHAPED = new Set(['netztest', 'automatik_pfad', 'automatik_modell', 'hybrid_1p_kappe']);

// dedupe - keeps at most `keep` cases per distinct OUTPUT: inputs that the
// original answers identically add little, and the file stays reviewable.
function dedupe(cases, outputOf, keep = 2) {
  const seen = new Map();
  return cases.filter((c) => {
    const k = JSON.stringify(enc(outputOf(c)));
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    return n < keep;
  });
}

const zielOf = (s) => s.connection.ip.trim() + ':' + (Number(s.connection.port) > 0 ? Number(s.connection.port) : 8899);
const flowFor = (s, o = {}) => {
  const z = zielOf(s);
  const memory = { inverter_config: s };
  const file = {};
  if (o.cap) memory['deye_cap:' + z] = Object.assign({}, cap(o.cap), { at: T0 - 60000 });
  if (o.sticky) file['deye_path:' + z] = sticky(o.sticky);
  if (o.nativeCfg) memory['deye_native_cfg:' + z] = o.nativeCfg;
  if (o.snapshot) file.deye_ctrl_snapshot = o.snapshot;
  if (o.touBudget) file['deye_tou_budget:' + s.connection.ip.trim() + ':' + (Number(s.connection.port) > 0 ? Number(s.connection.port) : 8899)] = o.touBudget;
  return { memory, file };
};
const SNAP = {
  family: 'hybrid_3p', connection: { ip: CONN.ip, port: 8899, serial: CONN.serial, mb_slave_id: 1, control_write_fc: 16 },
  regs: { 141: 1, 142: 2, 143: 7182, 145: 1, 148: 0, 154: 3000, 166: 15, 172: 0, 231: 330, 146: 0 },
  programTimes: [0, 600, 1200, 1800, 2200, 2300], capturedAt: T0 - 7200e3,
};

function planCases() {
  const cases = [];
  const S = sel();
  // Einzeltakte ueber ein Raster: Faehigkeit/Entscheid x Sollwert.
  const capKinds = [{}, { cap: 'remote' }, { cap: 'tou' }, { cap: 'tou_noscale' }, { cap: 'transient' }, { cap: 'v105' },
    { sticky: 'remote_bare' }, { sticky: 'tou_ever_remote' }, { cap: 'tou', sticky: 'remote' }, { cap: 'remote', sticky: 'tou_bare' }];
  const sps = [
    sp(), sp({ battery_setpoint_kw: 2.5 }), sp({ battery_setpoint_kw: 0 }), sp({ control_enabled: false }),
    sp({ device_certified: false }), sp({ device_certified: false, calibration: true, source: 'calibration' }),
    sp({ device_certified_path: 'remote' }), sp({ pv_limit_kw: 4.2 }), sp({ ts: iso(T0 - 30 * 60e3) }),
    sp({ battery_setpoint_kw: -60 }), sp({ grid_charge_allowed: true, battery_setpoint_kw: 3 }),
  ];
  for (const ck of capKinds) {
    for (const s of sps) {
      cases.push(planCase('raster', { flow: flowFor(S, ck), steps: [{ setpoint: s }] }));
    }
  }
  // Anbindungs-Varianten auf dem Fernsteuer- und dem Zeitfenster-Pfad.
  const conns = [
    { power_scale: 10 }, { power_scale: 1 }, { power_scale: '10' }, { port: 8899 }, { port: '8898' }, { port: 0 },
    { invert_control_sign: true }, { remote_mode: 'off' }, { remote_mode: false }, { control_write_fc: 6 },
    { control_write_fc: '6' }, { remote_watchdog_s: 120 }, { remote_watchdog_s: 5 }, { remote_watchdog_s: 99999 },
    { remote_battery_strategy: 5 }, { mb_slave_id: 3 }, { serial: 42 }, { ip: ' 10.0.0.9 ' },
  ];
  for (const c of conns) {
    for (const ck of [{ cap: 'remote' }, { cap: 'tou' }, { sticky: 'remote', cap: 'tou_lv' }]) {
      for (const s of [ck.cap === 'tou' ? sp() : sp({ battery_setpoint_kw: 1.25, soc_max_pct: 90.4 })]) {
        const sc = sel({}, c);
        cases.push(planCase('anbindung', { flow: flowFor(sc, ck), steps: [{ setpoint: s }] }));
      }
    }
  }
  // Familien und Nennleistung.
  for (const over of [{ family: 'hybrid_1p', rated_kw: 8, model: 'sun-8k-sg03lp1' }, { family: 'string', rated_kw: 10 },
    { family: 'micro', rated_kw: 0.8 }, { rated_kw: undefined }, { rated_kw: -3 }, { control_tier: 1 }, { control_tier: 2.7 },
    { brand: 'Deye ', model: 'SUN-30K-SG01HP3' }, { model: undefined }, { communication: 'modbus_tcp' }, { family: ' hybrid_3p ' }]) {
    for (const ck of [{ cap: 'remote' }, { cap: 'tou' }]) {
      for (const s of [sp(), sp({ battery_setpoint_kw: 2, pv_limit_kw: 3.3 }), sp({ battery_setpoint_kw: 0, pv_limit_kw: 0 })]) {
        const sc = sel(over);
        cases.push(planCase('familie', { flow: flowFor(sc, ck), steps: [{ setpoint: s }] }));
      }
    }
  }
  // Snapshot: der Zeitfenster-Pfad stellt max_sell_power zurueck.
  for (const s of [sp({ battery_setpoint_kw: 0 }), sp({ battery_setpoint_kw: 2 }), sp()]) {
    for (const sc of [S, sel({ family: 'hybrid_1p', rated_kw: 8 })]) {
      const snap = Object.assign({}, SNAP, { regs: Object.assign({}, SNAP.regs, { 245: 600, 248: 255 }) });
      cases.push(planCase('snapshot', { flow: flowFor(sc, { cap: 'tou', snapshot: snap }), steps: [{ setpoint: s }] }));
    }
  }
  // Netz-Sollwert-Test und netzseitiger Drossel-Slot.
  const gts = [
    { step: 'halten', side: 'grid', target_kw: -2 }, { step: 'neutral', side: 'battery', target_kw: 0, neutralize: true },
    { step: 'pv_kappe', side: 'grid', target_kw: -28, pv_cap_permille: 999 }, { step: 'pv_kappe', side: 'grid', target_kw: -5, pv_cap_permille: 1000 },
    { step: 'ac_probe', side: 'ac', target_kw: 1.5 }, { step: 'schritt', side: 'grid', target_kw: -50 },
    { step: 'erfunden', side: 'grid', target_kw: 0 }, { step: 'halten', side: 'quer', target_kw: 0 }, { step: 'halten', side: 'grid', target_kw: 'x' },
    { step: 'rueckkehr', side: 'battery', target_kw: 0, pv_cap_permille: 12.6 },
  ];
  for (const g of gts) {
    for (const s of [sp({ grid_test: g }), sp({ grid_test: g, device_certified: false }), sp({ grid_test: g, control_enabled: false })]) {
      cases.push(planCase('netztest', { flow: flowFor(S, { cap: 'remote' }), steps: [{ setpoint: s }] }));
    }
  }
  for (const t of [{ grid_target_kw: 0 }, { grid_target_kw: -12.3, grid_target_neutralize: true }, { grid_target_kw: 0.3 },
    { grid_target_kw: -45 }, { grid_target_kw: null }, {}]) {
    for (const sc of [S, sel({ model: 'sun-12k-sg04lp3' }), sel({ rated_kw: 12 })]) {
      for (const extra of [{}, { device_certified: false }, { control_enabled: false }]) {
        const s = sp(Object.assign({ battery_mode: 'grid_target' }, t, extra));
        cases.push(planCase('netzziel', { flow: flowFor(sc, { cap: 'remote' }), steps: [{ setpoint: s }] }));
      }
    }
    cases.push(planCase('netzziel', { flow: flowFor(S, { sticky: 'remote_v105' }), steps: [{ setpoint: sp(Object.assign({ battery_mode: 'grid_target' }, t)) }] }));
  }
  // Wechselrichter-Automatik E-down (der Pilot) und Ladeseite.
  const ownCfgs = [nativeCfg(), nativeCfg({ workMode: 0 }), nativeCfg({ workMode: 1 }), nativeCfg({ workMode: 7 }),
    nativeCfg({ pattern: 0 }), nativeCfg({ pattern: 3 }), nativeCfg({ solarSell: 0 }), nativeCfg({ tou: 0 }),
    nativeCfg({ tou: 0x00fe }), nativeCfg({ power: 0 }), nativeCfg({ soc: 25 }), nativeCfg({ soc: 140 }),
    nativeCfg({ charge: 1 }), nativeCfg({ times: [0, 600, 1200, 1800, 2200, 2400] }), nativeCfg({ times: [600, 700, 800, 900, 1000, 1100], now_min: 120 }),
    nativeCfg({ block: null }), nativeCfg({}, T0 - 400000), undefined];
  for (const nc of ownCfgs) {
    for (const s of [sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }), sp({ battery_mode: 'native', effective_floor_soc_pct: 20, grid_charge_allowed: true }),
      sp({ battery_mode: 'native' })]) {
      cases.push(planCase('automatik', { flow: flowFor(S, { cap: 'remote', nativeCfg: nc }), steps: [{ setpoint: s }] }));
    }
  }
  const win = (intent, min, max, extra = {}) => sp(Object.assign({ battery_mode: 'native_window', battery_native_intent: intent,
    battery_window_min_kw: min, battery_window_max_kw: max, battery_window_natural_min_kw: -25, battery_window_natural_max_kw: 25,
    effective_floor_soc_pct: 20 }, extra));
  const wins = [win('self_consumption', -25, 25), win('surplus_charge', 0, 25), win('surplus_charge', 0, 10), win('self_consumption', -25, 25, { grid_charge_allowed: true }),
    win('cover_load', -25, 0), win('erfunden', -1, 1), win('self_consumption', 1, 25), win('self_consumption', -25, 25, { battery_window_natural_min_kw: undefined, battery_window_natural_max_kw: undefined }),
    win('self_consumption', -25, 24.96), win('', -1, 1),
    win('self_consumption', -25, 25, { native_pilot: { candidate: 'grid_zero', intent: 'self_consumption', run: 'r1' } }),
    win('surplus_charge', 0, 25, { native_pilot: { candidate: 'own_config', intent: 'surplus_charge', run: 'r2' } }),
    win('surplus_charge', 0, 25, { native_pilot: { candidate: 'own_config', intent: 'self_consumption', run: 'r3' } }),
    win('surplus_charge', 0, 25, { native_pilot: { candidate: 'quer', intent: 'surplus_charge' } })];
  for (const catalog of ['produktion', 'ladeseite_netz', 'ladeseite_eigen', 'ladeseite_beide']) {
    for (const s of wins) {
      for (const nc of catalog === 'ladeseite_beide' ? [nativeCfg({ power: 0 })] : [nativeCfg(), nativeCfg({ charge: 1 }), undefined]) {
        cases.push(planCase('ladeseite', { catalog, flow: flowFor(S, { cap: 'remote', nativeCfg: nc }), steps: [{ setpoint: s }] }));
      }
    }
  }
  for (const ck of [{ cap: 'tou' }, { cap: 'v105' }, { cap: 'remote' }, { cap: 'remote', sticky: 'remote' }, { cap: 'tou', sticky: 'tou' }, { sticky: 'tou_bare' }]) {
    for (const c of [{}, { remote_mode: 'off' }, { control_write_fc: 6 }]) {
      cases.push(planCase('automatik_pfad', { flow: flowFor(sel({}, c), Object.assign({ nativeCfg: nativeCfg() }, ck)),
        steps: [{ setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) }] }));
    }
  }
  // Folgen: Uebernahme, Totmann, Rueckgabe, Automatik einmal, Tagesbudget.
  const remote = flowFor(S, { cap: 'remote', nativeCfg: nativeCfg() });
  cases.push(planCase('folge_totmann', { flow: remote, steps: [
    { setpoint: sp() }, { advance: 10000, setpoint: sp({ control_enabled: false }) }, { advance: 10000, setpoint: sp({ control_enabled: false }) },
    { advance: 10000, setpoint: sp() }, { advance: 10000, setpoint: sp({ ts: iso(T0 - 21 * 60e3) }) }, { advance: 10000, setpoint: sp({ ts: 'kaputt' }) },
  ] }));
  cases.push(planCase('folge_automatik', { flow: remote, steps: [
    { setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) },
    { advance: 10000, setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) },
    { advance: 10000, setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 30 }) },
    { advance: 10000, setpoint: sp() },
    { advance: 10000, setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) },
    { advance: 10000, setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20, control_enabled: false }) },
  ] }));
  cases.push(planCase('folge_netz_null', { catalog: 'ladeseite_netz', flow: remote, steps: [
    { setpoint: win('self_consumption', -25, 25) }, { advance: 10000, setpoint: win('self_consumption', -25, 25) },
    { advance: 10000, setpoint: sp() },
  ] }));
  cases.push(planCase('folge_absage', { flow: flowFor(S, { cap: 'remote' }), steps: [
    { setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) },
    { advance: 10000, setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) },
    { advance: 10000, flow: { memory: { ['deye_native_cfg:' + zielOf(S)]: nativeCfg({ workMode: 0 }, T0 + 15000) } }, setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) },
    { advance: 10000, setpoint: sp() },
  ] }));
  const touFlow = (budget) => flowFor(S, { cap: 'tou', snapshot: SNAP, touBudget: budget });
  const day = TOUB.touBudgetDay(T0);
  for (const budget of [undefined, { day, changes: 3, held: false }, { day, changes: 18, held: false }, { day, changes: 17, held: true },
    { day: '2026-11-19', changes: 20, held: true }, { day, changes: 'x' }, { day, changes: 5, held: true }]) {
    for (const extra of [{}, { persistent_write_budget: 10 }, { persistent_write_budget: 25 }]) {
      cases.push(planCase('budget', { flow: touFlow(budget), steps: [
        { setpoint: sp(extra) }, { advance: 10000, setpoint: sp(Object.assign({ battery_setpoint_kw: 2 }, extra)) },
        { advance: 10000, setpoint: sp(Object.assign({ calibration: true }, extra)) }, { advance: 10000, setpoint: sp(Object.assign({ control_enabled: false }, extra)) },
      ] }));
    }
  }
  cases.push(planCase('folge_kalibrierung', { flow: flowFor(S, { cap: 'tou', snapshot: SNAP }), steps: [
    { setpoint: sp({ device_certified: false, calibration: true, source: 'calibration' }) },
    { advance: 10000, setpoint: sp({ device_certified: false, calibration: true, source: 'calibration', control_enabled: false }) },
    { advance: 10000, setpoint: sp({ device_certified: false, calibration: true, source: 'calibration' }) },
    { advance: 10000, setpoint: sp({ device_certified: false, ts: iso(T0 - 25 * 60e3) }) },
  ] }));
  cases.push(planCase('folge_seed', { flow: flowFor(S, {}), steps: [
    { setpoint: sp({ device_certified_path: 'remote' }) }, { advance: 10000, setpoint: sp({ device_certified_path: 'remote', control_enabled: false }) },
  ] }));
  cases.push(planCase('leer', { flow: { memory: {}, file: {} }, steps: [{ setpoint: sp() }, { setpoint: null }] }));
  // Zweige, die das Raster nicht trifft.
  for (const sc of [sel({ model: 'sun-12k-sg04lp3' }), sel({ brand: undefined })]) {
    cases.push(planCase('automatik_modell', { flow: flowFor(sc, { cap: 'remote', sticky: 'remote', nativeCfg: nativeCfg() }),
      steps: [{ setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) }] }));
  }
  cases.push(planCase('automatik_katalog_leer', { catalog: 'leer', flow: flowFor(S, { cap: 'remote', nativeCfg: nativeCfg() }),
    steps: [{ setpoint: sp({ battery_mode: 'native', effective_floor_soc_pct: 20 }) }, { setpoint: win('self_consumption', -25, 25) }] }));
  const budgetKey = 'deye_tou_budget:' + CONN.ip + ':8899';
  cases.push(planCase('folge_budget_rueckgabe', { flow: touFlow({ day, changes: 2, held: false }), steps: [
    { setpoint: sp() }, { advance: 10000, flow: { file: { [budgetKey]: { day, changes: 18, held: true } } }, setpoint: sp() },
    { advance: 10000, setpoint: sp() },
  ] }));
  cases.push(planCase('folge_budget_rueckgabe', { flow: flowFor(S, { cap: 'tou', touBudget: { day, changes: 2 } }), steps: [
    { setpoint: sp() }, { advance: 10000, flow: { file: { [budgetKey]: { day, changes: 18, held: true } } }, setpoint: sp() },
  ] }));
  for (const s of [sp({ pv_limit_kw: 0.4 }), sp({ pv_limit_kw: 30 }), sp({ battery_setpoint_kw: 0, pv_limit_kw: 1 })]) {
    const sc = sel({ family: 'hybrid_1p', rated_kw: 8, model: 'sun-8k-sg03lp1' });
    cases.push(planCase('hybrid_1p_kappe', { flow: flowFor(sc, { cap: 'tou', snapshot: Object.assign({}, SNAP, { regs: { 245: 600 } }) }), steps: [{ setpoint: s }] }));
  }
  cases.push(planCase('leer', { flow: flowFor(sel({}, { ip: '' })), steps: [{ setpoint: sp() }] }));
  cases.push(planCase('leer', { flow: flowFor(S, { cap: 'remote' }), steps: [{ setpoint: sp({ battery_setpoint_kw: 'x' }) }, { setpoint: { battery_setpoint_kw: 1 } }] }));
  cases.push(planCase('kaputter_entscheid', { flow: flowFor(S, { cap: 'remote', sticky: 'kaputt' }), steps: [{ setpoint: sp() }] }));
  cases.push(planCase('nullantwort', { flow: flowFor(S, { cap: 'zero' }), steps: [{ setpoint: sp() }] }));
  return cases;
}

// --- Absturz-Wiederherstellung (der echte Rumpf) --------------------------------
function recoverCase(snap) {
  const flow = { memory: {}, file: snap === undefined ? {} : { deye_ctrl_snapshot: snap } };
  const warns = [];
  const sandbox = {
    msg: {},
    node: { status() {}, error() {}, warn(s) { warns.push(String(s)); } },
    context: { get: () => undefined, set: () => {} },
    flow: { get: (k, s) => (flow[s || 'memory'] || {})[k], set: () => {} },
    Buffer, Math, isFinite, Number, Array, Object, JSON, String, Date: fakeDate(T0),
  };
  const out = new vm.Script('(function(){' + RECOVER_BODY + '\n})()').runInContext(vm.createContext(sandbox));
  return { snapshot: snap === undefined ? null : snap, control: out ? out.control : null, warns };
}

// --- reine Modulfaelle -----------------------------------------------------------
function rueckCases() {
  const e = (role, expect, actual, tol, extra = {}) => Object.assign({ role, expect, actual, tolerance: tol }, extra);
  const lists = [
    [], [e('remote_watchdog', 60, 60, 0)], [e('remote_watchdog', 60, 51, 0)], [e('remote_watchdog', 60, 0xffff, 0)],
    [e('remote_watchdog', 60, 0, 0)], [e('remote_watchdog', 60, 0, 0), e('remote_mode', 1, 1, 0)], [e('remote_watchdog', 60, 61, 0)], [e('battery_power', 0, 0xffff, 1)],
    [e('battery_power', 33, 35, 1)], [e('battery_power', 0xffdf, 0xffe0, 1)],
    [e('remote_mode', 1, 0xffff, 0), e('battery_power', 33, 33, 1)],
    [e('remote_mode', 1, 0, 0), e('power_control_mode', 1, 0, 0), e('battery_power', 0, 0, 1)],
    [e('remote_mode', 0, 0, 0)], [e('remote_mode', 1, null, 0, { error: 'Timeout' }), e('battery_power', 5, 5, 1)],
    [e('remote_mode', 1, null, 0), e('battery_power', 5, 9, 1)], [e('pv_max_permille', 999, 1201, 0)],
    [e('battery_soc_belt', 20, 20, 0), e('battery_strategy', 5, 6, 0)], [e('energy_pattern', 1, 1, 0), e('tou_enable', 255, 255, 0)],
    [e('remote_watchdog', 60, 30, 0, { rule: 'exact' })], [e('battery_power', 10, 11, '1')], [e('tou_enable', 255, 0, 0)],
    [e('remote_mode', 1, 1, 0), e('remote_watchdog', 60, undefined, 0)],
  ];
  return lists.map((entries) => ({ entries, out: RBV.verifyCycle(entries) }));
}

function budgetCases() {
  const now = [T0, Date.UTC(2026, 10, 20, 23, 30), Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 9, 25, 1, 30)];
  const recs = [undefined, null, 'x', [], { day: '2026-11-20', changes: 4 }, { day: '2026-11-20', changes: 4, held: true },
    { day: '2026-11-20', changes: -1 }, { day: '2026-11-20', changes: 2.5 }, { day: '2026-11-19', changes: 19, held: true },
    { day: '2026-11-21', changes: 1 }, { day: '2026-03-29', changes: 0 }];
  const today = [];
  for (const n of now) for (const r of recs) today.push({ record: r, now: n, out: TOUB.touBudgetToday(r, n) });
  const limits = [undefined, null, 0, 1, 10, 20, 21, 7.5, '10', -3, NaN].map((s) => ({ stated: s, out: TOUB.touBudgetLimit(s) }));
  const ops = [];
  for (const b of [{ day: 'd', changes: 0, held: false }, { day: 'd', changes: 17, held: false }, { day: 'd', changes: 18, held: false },
    { day: 'd', changes: 3, held: true }]) {
    for (const limit of [20, 10, 2]) {
      ops.push({ budget: b, limit, admits: TOUB.touBudgetAdmits(b, limit), counted: TOUB.touBudgetCounted(b),
        held: TOUB.touBudgetHeld(b), reason: TOUB.touBudgetReason(b, limit), report: TOUB.touBudgetReport(b, limit) });
    }
  }
  return { today, limits, ops };
}

function capCases() {
  const blocks = [null, [1, 2], new Array(22).fill(0), REMOTE_BLOCK, V105_BLOCK];
  const mod = (i, v) => { const b = REMOTE_BLOCK.slice(); b[i] = v; return b; };
  blocks.push(mod(1, 60), mod(1, 9), mod(1, 18001), mod(0, 4), mod(0, 3), mod(4, 3), mod(5, 6), mod(21, 0x1234));
  const devs = [undefined, null, 0x0005, 0x0006, 0x0500, 0x0601, 0x1234];
  const out = [];
  for (const b of blocks) {
    for (const d of devs) {
      for (const extra of [{}, { error: 'Modbus-Ausnahme 0x02', definitive: true }, { error: 'Timeout', definitive: false }, { definitive: false }, { error: 'x' }]) {
        const probe = Object.assign({ deviceType: d, remoteBlock: b }, extra);
        out.push({ probe, out: R.classifyDeyeCapability(probe) });
      }
    }
  }
  return out;
}

function stickyCases() {
  const verdicts = [null, cap('remote'), cap('tou'), cap('transient'), cap('zero'), cap('v105')];
  const prevs = [null, sticky('remote'), sticky('tou'), sticky('tou_bare'), { path: 'remote', since: 5, contrary: 2, everRemote: true },
    { path: 'remote', since: 5, contrary: 'x' }, sticky('kaputt'), { path: 'tou', contrary: 2 }];
  const update = [];
  for (const p of prevs) for (const v of verdicts) update.push({ prev: p, verdict: v, now: T0, out: R.deyeUpdateSticky(p, v, T0) });
  const effective = [];
  for (const c of [null, cap('remote'), cap('tou'), cap('transient'), cap('tou_noscale'), cap('remote_noscale')]) {
    for (const s of [null, sticky('remote'), sticky('remote_bare'), sticky('tou'), sticky('tou_bare'), sticky('kaputt'), sticky('remote_v105'),
      { path: 'remote', verdict: cap('remote_lv') }, { path: 'tou', verdict: cap('tou_lv') }]) {
      effective.push({ cap: c, sticky: s, out: R.deyeEffectiveCap(c, s) });
    }
  }
  const seed = [sp({ device_certified_path: 'remote' }), sp(), sp({ device_certified: false, device_certified_path: 'remote' }), null]
    .map((s) => ({ setpoint: s, now: T0, out: R.deyeSeedStickyFromGrant(s, T0) }));
  return { update, effective, seed };
}

function miscCases() {
  const probeErrors = ['Modbus-Ausnahme 0x02', 'Modbus-Ausnahme 0x0B (Wechselrichter hat nicht geantwortet)', 'modbus-ausnahme 0x01 x',
    'Modbus-Ausnahme 0x03a', 'Timeout', '', 'Modbus-Ausnahme 0x04'].map((m) => ({ message: m, out: R.deyeProbeErrorDefinitive(m) }));
  const watchdog = [undefined, null, 10, 9.4, 60, 120.6, 18000, 18001, '300', 'x', -5].map((v) => ({ value: v, out: R.resolveDeyeRemoteWatchdog({ remote_watchdog_s: v }) }));
  const units = [];
  for (const kw of [0, 1, -1, 0.0149, -0.0151, 1.5, -1.5, 36, -36, 37, -100, 0.1 + 0.2, NaN, Infinity]) {
    for (const rated of [30, 12, 8, 0, -1]) {
      units.push({ kw, rated, remote: R.deyeRemoteSetpointUnits(kw, rated) });
    }
  }
  const displaced = [];
  for (const times of [[0, 600, 1200, 1800, 2200, 2300], [0, 0, 0, 0, 0, 0], [800, 600, 1200, 1800, 2200, 2300], [0], [0, 'x', 2359, null, 2400, 1230]]) {
    for (const nowMin of [0, 359, 360, 630, 1439]) displaced.push({ times, now_min: nowMin, out: R.deyeProgram1Displaced(times, nowMin) });
  }
  const active = [];
  for (const times of [[0, 600, 1200, 1800, 2200, 2300], [600, 700, 800, 900, 1000, 1100], [0, 0, 600, 600, 0, 0], [0, 600, 1200, 1800, 2200, 2400],
    [0, 600, 1200, 1860, 2200, 2300], [0, 600, 1200], [0, 600, 1200, 1800, 2200, -1], [0, 600, 1200, 1800, 2200, 830.5]]) {
    for (const nowMin of [0, 59, 360, 630, 1439, NaN]) active.push({ times, now_min: nowMin, out: DCS.deyeActiveProgram(times, nowMin) });
  }
  const tier = [{}, { control_tier: 3 }, { control_tier: 0 }, { control_tier: 2.9 }, { control_tier: 4 }, { control_tier: '3', communication: 'modbus_tcp' },
    { communication: 'solarman_v5' }, { communication: 'kostal_modbus' }, { communication: 'fronius_solar_api' }, { communication: 'kaco_http' }]
    .map((s) => ({ selection: s, out: R.resolveControlTier(s) }));
  const writeFc = [undefined, 6, '6', 16, 0, '16', 6.0, ' 6'].map((v) => ({ value: v, out: R.resolveDeyeWriteFc({ control_write_fc: v }) }));
  return { probeErrors, watchdog, units, displaced, active, tier, writeFc };
}

function releaseCases() {
  const out = [];
  const sels = [sel(), sel({ family: 'hybrid_1p', rated_kw: 8 }), sel({}, { remote_mode: 'off' }), sel({}, { control_write_fc: 6, port: 8898 }),
    sel({ family: 'string' }), sel({ control_tier: 1 }), sel({}, { ip: '' }), null];
  const snaps = [undefined, SNAP.regs, { 146: 255 }, { 245: 600, 248: 255, 243: 1 }];
  for (const s of sels) {
    for (const ck of [{}, { deye: cap('remote') }, { deye: cap('tou') }, { deyeSticky: sticky('remote') }, { deye: cap('transient'), deyeSticky: sticky('tou') }]) {
      for (const snap of (ck.deye || ck.deyeSticky) ? snaps.slice(0, 2) : snaps) {
        for (const o of [{}, { calibration: true }, { deviceCertified: true, controlEnabled: true }, { deviceCertified: true }]) {
          const opts = Object.assign({ snapshot: snap }, ck, o);
          out.push({ selection: s, opts: enc(opts), out: FLOW.controlRelease(s, opts) });
        }
      }
    }
  }
  return out;
}

function precondCases() {
  const reg = R.DEYE_CONTROL_REG.hybrid_3p;
  const out = [];
  const cfgs = [undefined, nativeCfg(), nativeCfg({ workMode: 0 }), nativeCfg({ workMode: 1 }), nativeCfg({ workMode: 9 }), nativeCfg({ pattern: 0 }),
    nativeCfg({ pattern: 2 }), nativeCfg({ solarSell: 0 }), nativeCfg({ tou: 0 }), nativeCfg({ tou: 'x' }), nativeCfg({ power: 0 }),
    nativeCfg({ soc: 25 }), nativeCfg({ soc: 101 }), nativeCfg({ charge: 2 }), nativeCfg({ times: [0, 600, 1200, 1800, 2200, 9999] }),
    nativeCfg({ now_min: 'x' }), nativeCfg({ block: null }), Object.assign(nativeCfg(), { own_config: [1, 2, 3] }),
    nativeCfg({ power: null }), nativeCfg({ soc: null }), nativeCfg({ workMode: null })];
  for (const intent of ['cover_load', 'surplus_charge', 'self_consumption', 'quer']) {
    for (const cfg of cfgs) {
      for (const o of [{ floorPct: 20, solarOnly: true }, { floorPct: 20, solarOnly: false }, { floorPct: undefined, solarOnly: false }, { floorPct: 12.5, solarOnly: true },
        { floorPct: 9.5, solarOnly: false }, { floorPct: 10, solarOnly: false }]) {
        out.push({ intent, cfg, floor_pct: o.floorPct, solar_only: o.solarOnly,
          own_config: DCS.deyeOwnConfigPrecondition(R.DEYE_CHARGE_SIDE_FACTS, intent, cfg, Object.assign({ reg }, o)),
          grid_zero: DCS.deyeGridZeroPrecondition(R.DEYE_CHARGE_SIDE_FACTS, cfg, o) });
      }
    }
  }
  return out;
}

function build() {
  const data = {
    hinweis: 'Erzeugt von steuerplan-vectors.gen.js - nicht von Hand aendern.',
    t0: T0,
    rueckmeldung: rueckCases(),
    budget: budgetCases(),
    faehigkeit: dedupe(capCases(), (c) => c.out),
    entscheid: stickyCases(),
    einzeln: miscCases(),
    rueckgabe: dedupe(releaseCases(), (c) => c.out),
    vorbedingung: dedupe(precondCases(), (c) => [c.intent, c.own_config, c.grid_zero], 3),
    absturz: [undefined, null, SNAP, { regs: null }, Object.assign({}, SNAP, { family: 'hybrid_1p', regs: { 243: 1, 245: 600, 248: 255 } }),
      Object.assign({}, SNAP, { connection: { ip: CONN.ip, port: 8899, serial: CONN.serial, mb_slave_id: 1, control_write_fc: 6 } }),
      Object.assign({}, SNAP, { regs: {} })].map(recoverCase),
  };
  return JSON.stringify(enc(data)) + '\n';
}

// buildKnoten - die Folgen durch den Plan-Knoten, in zwei Dateien: die
// Wechselrichter-Automatik (Native-Uebergabe, Ladeseite) und der Rest.
let knotenCache = null;
function knotenCases() {
  if (!knotenCache) {
    knotenCache = dedupe(planCases(), (c) => [SHAPED.has(c.name) ? [shape(c.flow), c.steps.map((st) => shape(st.setpoint))] : c.name,
      c.steps.map((st) => [st.control, st.native_capabilities, st.native_refusal, st.warns, st.ctx])], 1);
  }
  return knotenCache;
}
const isAutomatik = (c) => /^automatik|^ladeseite|^folge_(automatik|netz_null|absage)/.test(c.name);
function buildKnoten(automatik) {
  const data = {
    hinweis: 'Erzeugt von steuerplan-vectors.gen.js - nicht von Hand aendern.',
    t0: T0,
    plan: knotenCases().filter((c) => isAutomatik(c) === automatik),
  };
  return JSON.stringify(enc(data)) + '\n';
}

if (require.main === module) {
  fs.writeFileSync(OUT, build());
  fs.writeFileSync(OUT_KNOTEN, buildKnoten(false));
  fs.writeFileSync(OUT_AUTOMATIK, buildKnoten(true));
  for (const f of [OUT, OUT_KNOTEN, OUT_AUTOMATIK]) console.log('geschrieben: ' + f + ' (' + fs.statSync(f).size + ' Bytes)');
}

module.exports = { OUT, OUT_KNOTEN, OUT_AUTOMATIK, build, buildKnoten };
