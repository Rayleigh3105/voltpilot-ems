'use strict';

/**
 * Erzeugt steuerplan-abregelung-vectors.json: die GEMEINSAMEN Testvektoren der
 * Fronius-Abregelung (Model 123) zwischen der Docker-Box (Quelle der Wahrheit:
 * sunspec/curtail.js, sunspec/curtail-lease.js, sunspec/model-discovery.js und
 * die Knoten "PV-Abregelung / Schreibplan" und "Fronius WMaxLimPct schreiben +
 * zuruecklesen" aus flows.json) und dem Go-Zwilling in Edge Light
 * (edge-app/core/internal/steuerplan, abregel_*.go).
 *
 *   node edge-app/nodered/steuerplan-abregelung-vectors.gen.js
 *
 * Die Kette laesst die ECHTEN Knotenruempfe in einer vm laufen (feste Uhr,
 * Flow-Kontext ueber die Takte); der Ausfuehrer spricht ueber eine gestellte
 * net-Schnittstelle echte Modbus-TCP-Rahmen mit einem gestellten Fronius
 * (SunSpec-Modelle 1, 103, 120, 123). Festgehalten wird jede Operation mit der
 * Antwort, die der Knoten sah, jede Rueckmeldung vor und nach
 * vp-control-readback shape() und die Abregel-Eintraege des Flow-Kontexts.
 */

process.env.TZ = 'Europe/Berlin';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CURT = require('./sunspec/curtail.js');
const LEASE = require('./sunspec/curtail-lease.js');
const DISC = require('./sunspec/model-discovery.js');
const SHAPE = require('./vp-palette/nodes/vp-control-readback.js').shape;

const OUT = path.join(__dirname, 'steuerplan-abregelung-vectors.json');
const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const PLAN_BODY = flows.find((n) => n.id === 'sources-curtail-plan').func;
const EXEC_BODY = flows.find((n) => n.id === 'sources-curtail-exec').func;

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

const T0 = Date.UTC(2026, 10, 20, 11, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

// --- ein gestellter Fronius: SunSpec 1, 103, 120, 123 ab 40000 -----------------
function froniusRegs(o = {}) {
  const r = {};
  const put = (a, v) => { r[a] = v & 0xffff; };
  const base = o.base !== undefined ? o.base : 40000;
  put(base, 0x5375); put(base + 1, 0x6e53);
  let a = base + 2;
  const model = (id, len, fill) => { put(a, id); put(a + 1, len); for (let i = 0; i < len; i++) put(a + 2 + i, 0); if (fill) fill(a + 2); a += 2 + len; };
  model(1, 66);
  model(103, 50);
  if (o.big) model(160, 130);
  if (!o.noNameplate) model(120, 26, (b) => { put(b + 1, o.wRtg !== undefined ? o.wRtg : 27000); put(b + 2, 0); });
  if (!o.no123) model(123, 24, (b) => { put(b + 3, 10000); put(b + 5, 0); put(b + 7, 0); put(b + 21, o.sf !== undefined ? o.sf : 0xfffe); });
  put(a, 0xffff); put(a + 1, 0);
  return r;
}

// Modbus-TCP-Gegenstelle hinter einer gestellten net-Schnittstelle.
function fakeNet(dev, ops) {
  let n = 0;
  let dead = false;
  class Socket {
    constructor() { this.h = {}; }
    setNoDelay() {}
    on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); }
    emit(ev, a) { for (const fn of (this.h[ev] || [])) fn(a); }
    destroy() {}
    connect(port, ip, cb) {
      if (dev.connectFail) { ops.push({ op: 'connect', ip, port, fail: true }); setImmediate(() => this.emit('error', new Error('connect ECONNREFUSED ' + ip + ':' + port))); return; }
      ops.push({ op: 'connect', ip, port });
      setImmediate(cb);
    }
    write(buf) {
      if (dead) {
        ops.push({ op: 'dead', error: 'Cannot call write after a stream was destroyed' });
        setImmediate(() => this.emit('error', new Error('Cannot call write after a stream was destroyed')));
        return;
      }
      const tx = buf.readUInt16BE(0);
      const unit = buf[6];
      const fn = buf[7];
      const addr = buf.readUInt16BE(8);
      const fault = (dev.faults || {})[n++];
      let rec;
      let pdu;
      const regs = dev.units[unit] || null;
      if (fn === 0x03) {
        const count = buf.readUInt16BE(10);
        rec = { op: 'read', unit, addr, count };
        if (!regs) pdu = Buffer.from([0x83, 0x0b]);
        else if (fault && fault.exception) pdu = Buffer.from([0x83, fault.exception]);
        else {
          const k = fault === 'short' ? Math.max(1, count - 1) : count;
          pdu = Buffer.alloc(2 + 2 * k);
          pdu[0] = 3; pdu[1] = 2 * k;
          for (let i = 0; i < k; i++) {
            let v = regs[addr + i];
            if (v === undefined) v = 0;
            if (dev.pctRead !== undefined && unit === dev.pctUnit && addr + i === dev.pctAddr) v = dev.pctRead;
            pdu.writeUInt16BE(v & 0xffff, 2 + 2 * i);
          }
        }
      } else if (fn === 0x06) {
        const value = buf.readUInt16BE(10);
        rec = { op: 'write6', unit, addr, value };
        if (fault && fault.exception) pdu = Buffer.from([0x86, fault.exception]);
        else { if (!dev.ignoreWrites) regs[addr] = value; pdu = buf.slice(7, 12); }
      } else {
        const qty = buf.readUInt16BE(10);
        const values = [];
        for (let i = 0; i < qty; i++) values.push(buf.readUInt16BE(13 + 2 * i));
        rec = { op: 'write16', unit, addr, values };
        if (fault && fault.exception) pdu = Buffer.from([0x90, fault.exception]);
        else {
          if (!dev.ignoreWrites) values.forEach((v, i) => { regs[addr + i] = v; });
          pdu = Buffer.from([0x10, buf[8], buf[9], buf[10], buf[11]]);
        }
      }
      if (fault === 'fatal') {
        rec.fatal = true; rec.error = 'read ECONNRESET'; dead = true; ops.push(rec);
        setImmediate(() => this.emit('error', new Error('read ECONNRESET')));
        return;
      }
      const head = Buffer.alloc(7);
      head.writeUInt16BE(fault === 'txid' ? (tx + 1) & 0xffff : tx, 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(pdu.length + 1, 4);
      head[6] = unit;
      // What the node's read3/write6/write16 make of the answer.
      if (fault === 'txid') rec.error = 'Transaktions-ID';
      else if (pdu[0] & 0x80) rec.error = 'Modbus-Ausnahme 0x' + (pdu[1] || 0).toString(16);
      else if (rec.op === 'read') rec.regs = Array.from({ length: pdu[1] >> 1 }, (_, i) => pdu.readUInt16BE(2 + 2 * i));
      else rec.ok = true;
      ops.push(rec);
      setImmediate(() => this.emit('data', Buffer.concat([head, pdu])));
    }
  }
  return { Socket };
}

const busArbiter = { acquirePoll: async () => ({ release() {} }), acquireControl: async () => ({ release() {} }) };

function runPlanNode(flow, msg, nowMs) {
  const sandbox = {
    msg, node: { status() {}, warn() {}, error() {}, log() {} },
    context: { get: () => undefined, set: () => {} },
    flow: { get: (k) => flow[k], set: (k, v) => { flow[k] = v; } },
    Buffer, Math, isFinite, Number, Array, Object, JSON, String, Date: fakeDate(nowMs),
  };
  return new vm.Script('(function(){' + PLAN_BODY + '\n})()').runInContext(vm.createContext(sandbox));
}

async function runExecNode(flow, ctx, msg, nowMs, dev) {
  const ops = [];
  const sent = [];
  const sandbox = {
    msg, node: { status() {}, warn() {}, error() {}, log() {}, send: (m) => sent.push(m.payload) },
    context: { get: (k) => ctx[k], set: (k, v) => { ctx[k] = v; } },
    flow: { get: (k) => flow[k], set: (k, v) => { flow[k] = v; } },
    global: { get: (k) => (k === 'net' ? fakeNet(dev, ops) : (k === 'vpSharedBusArbiter' ? busArbiter : undefined)) },
    Buffer, Math, isFinite, Number, Array, Object, JSON, String, Promise, Map, setTimeout, clearTimeout, setImmediate,
    Date: fakeDate(nowMs),
  };
  const ret = new vm.Script('(function(){' + EXEC_BODY + '\n})()').runInContext(vm.createContext(sandbox));
  if (ret && typeof ret.then === 'function') await ret;
  return { ops, sent };
}

const KEEP = /^curtail_(disc|cmd|was|enf|obs):/;
const flowView = (flow) => Object.fromEntries(Object.keys(flow).filter((k) => KEEP.test(k) && flow[k] !== undefined).map((k) => [k, flow[k]]));

const plan = (id, unit, over = {}) => Object.assign({ id, role: 'pv-generation', adapter: 'sunspec_live',
  conn: Object.assign({ ip: '192.168.1.60', port: 502, unit_id: unit, invert_grid_sign: false, model_type: 'auto', curtail_write_fc: 0 }, over) });
const entry = (id, over = {}) => Object.assign({ id, label: 'Fronius ' + id, certified: true, capacity_kwp: 27 }, over);
const sp = (over = {}, cur = {}) => Object.assign({ battery_setpoint_kw: 0, source: 'schedule', ts: iso(T0 - 5000), control_enabled: true, pv_limit_kw: 20,
  curtail: Object.assign({ control_enabled: true, pv_uncontrolled_kw: 4, sources: [entry('fro1'), entry('fro2')] }, cur) }, over);

async function chainCase(name, c) {
  const flow = JSON.parse(JSON.stringify(c.flow));
  const flow0 = JSON.parse(JSON.stringify(flow));
  const ctx = {};
  const dev = { units: JSON.parse(JSON.stringify(c.units)) };
  let now = T0;
  const ticks = [];
  for (const t of c.ticks) {
    if (t.advance) now += t.advance;
    if (t.flow) Object.assign(flow, JSON.parse(JSON.stringify(t.flow)));
    for (const k of ['ignoreWrites', 'faults', 'connectFail', 'pctRead', 'pctUnit', 'pctAddr']) {
      if (t.device && k in t.device) dev[k] = t.device[k]; else delete dev[k];
    }
    const msg = runPlanNode(flow, { setpoint: t.setpoint }, now);
    const fleet = msg ? msg.curtailFleet : null;
    let ops = [];
    let sent = [];
    if (msg) ({ ops, sent } = await runExecNode(flow, ctx, msg, now, dev));
    ticks.push({ now, setpoint: t.setpoint, flow_delta: t.flow, fleet, ops,
      payloads: sent, shaped: sent.map((p) => SHAPE(JSON.parse(JSON.stringify(p)))),
      flow_after: JSON.parse(JSON.stringify(flowView(flow))) });
  }
  return { name, flow: flow0, ticks };
}

async function chainCases() {
  const plans = [plan('fro1', 1), plan('fro2', 2)];
  const units = { 1: froniusRegs(), 2: froniusRegs({ wRtg: 27000 }) };
  const base = { source_plans: plans, 'src_last:fro1': { pv_kw: 18, at: T0 - 2000 }, 'src_last:fro2': { pv_kw: 17, at: T0 - 2000 } };
  const cases = [];
  // Entdecken, planen, schreiben, auffrischen, beobachten, freigeben.
  cases.push(await chainCase('ablauf', { flow: base, units, ticks: [
    { setpoint: sp() }, { advance: 10000, setpoint: sp() }, { advance: 10000, setpoint: sp() },
    { advance: 25000, setpoint: sp() }, { advance: 100000, setpoint: sp(), flow: { 'src_last:fro1': { pv_kw: 15, at: T0 + 140000 } } },
    { advance: 10000, setpoint: sp({ pv_limit_kw: 10 }) },
    { advance: 10000, setpoint: sp({ pv_limit_kw: null }) }, { advance: 10000, setpoint: sp({ pv_limit_kw: null }) },
    { advance: 70000, setpoint: sp({ pv_limit_kw: null }) },
  ] }));
  // Ohne Freigabe, Not-Aus, Testlauf, veralteter Sollwert, kein Block.
  cases.push(await chainCase('tore', { flow: base, units, ticks: [
    { setpoint: sp({}, { sources: [entry('fro1', { certified: false }), entry('fro2', { certified: false })] }) },
    { advance: 10000, setpoint: sp({}, { sources: [entry('fro1', { certified: false }), entry('fro2', { certified: false })] }) },
    { advance: 70000, setpoint: sp({}, { control_enabled: false }) },
    { advance: 10000, setpoint: sp({}, { sources: [entry('fro1', { certified: false, test: { cap_kw: 12 } }), entry('fro2', { certified: false })] }) },
    { advance: 10000, setpoint: sp({}, { sources: [entry('fro1', { certified: false, test: { cap_kw: 12 } }), entry('fro2', { certified: false })] }) },
    { advance: 10000, setpoint: sp({ ts: iso(T0 - 30 * 60e3) }) },
    { advance: 10000, setpoint: sp({ curtail: undefined }) },
  ] }));
  // Der Datamanager verwirft die Begrenzung: Wiederholleiter, Abkuehlung.
  cases.push(await chainCase('verworfen', { flow: base, units, ticks: [
    { setpoint: sp() }, { advance: 10000, setpoint: sp(), device: { ignoreWrites: true } },
    { advance: 10000, setpoint: sp(), device: { ignoreWrites: true } }, { advance: 10000, setpoint: sp(), device: { ignoreWrites: true } },
    { advance: 10000, setpoint: sp(), device: { ignoreWrites: true } }, { advance: 70000, setpoint: sp(), device: { ignoreWrites: true } },
    { advance: 10000, setpoint: sp() },
  ] }));
  // Wirkung: Override erkannt, sinkende Begrenzung startet das Fenster neu.
  cases.push(await chainCase('wirkung', { flow: base, units, ticks: [
    { setpoint: sp() }, { advance: 10000, setpoint: sp() },
    { advance: 100000, setpoint: sp(), flow: { 'src_last:fro1': { pv_kw: 25, at: T0 + 109000 }, 'src_last:fro2': { pv_kw: 3, at: T0 + 109000 } } },
    { advance: 30000, setpoint: sp({ pv_limit_kw: 8 }), flow: { 'src_last:fro1': { pv_kw: 25, at: T0 + 139000 } } },
    { advance: 30000, setpoint: sp({ pv_limit_kw: 8 }), flow: { 'src_last:fro1': { pv_kw: 25, at: T0 + 100 } } },
  ] }));
  // Fehler: Gateway weg, Ausnahme beim Schreiben, Abbruch beim Ruecklesen,
  // Walk scheitert (Backoff), Modell 123 fehlt, Nennleistung fehlt, FC6.
  cases.push(await chainCase('fehler', { flow: base, units, ticks: [
    { setpoint: sp(), device: { connectFail: true } }, { advance: 10000, setpoint: sp() },
    { advance: 10000, setpoint: sp(), device: { faults: { 0: { exception: 4 } } } },
    { advance: 10000, setpoint: sp(), device: { faults: { 2: 'fatal' } } },
    { advance: 30000, setpoint: sp(), device: { faults: { 1: 'txid' } } },
    { advance: 30000, setpoint: sp(), device: { pctRead: 9999, pctUnit: 2, pctAddr: 40000 + 2 + 68 + 52 + 28 + 2 + 3 } },
  ] }));
  cases.push(await chainCase('erkennung', { flow: { source_plans: [plan('a', 3), plan('b', 4), plan('c', 5, { curtail_write_fc: 6 }), plan('d', 6, { port: 1502 })] },
    units: { 3: froniusRegs({ no123: true }), 4: froniusRegs({ noNameplate: true }), 5: froniusRegs({ sf: 0xffff }), 6: froniusRegs({ base: 50000 }) }, ticks: [
      { setpoint: sp({}, { sources: [entry('a'), entry('b', { capacity_kwp: undefined }), entry('c'), entry('d')] }) },
      { advance: 10000, setpoint: sp({}, { sources: [entry('a'), entry('b', { capacity_kwp: undefined }), entry('c'), entry('d')] }) },
      { advance: 10000, setpoint: sp({}, { sources: [entry('a'), entry('b', { capacity_kwp: undefined }), entry('c'), entry('d')] }) },
      { advance: 130000, setpoint: sp({ pv_limit_kw: null }, { sources: [entry('a'), entry('b'), entry('c'), entry('d')] }) },
    ] }));
  cases.push(await chainCase('walk_gross', { flow: { source_plans: [plan('g', 7), plan('h', 8)] },
    units: { 7: froniusRegs({ big: true }), 8: froniusRegs({ big: true }) }, ticks: [
      { setpoint: sp({}, { sources: [entry('g'), entry('h')] }), device: { faults: { 30: { exception: 2 } } } },
      { advance: 10000, setpoint: sp({}, { sources: [entry('g'), entry('h')] }) },
    ] }));
  cases.push(await chainCase('walk_fehlt', { flow: { source_plans: [plan('x', 9)] }, units: {}, ticks: [
    { setpoint: sp({}, { sources: [entry('x')] }) }, { advance: 10000, setpoint: sp({}, { sources: [entry('x')] }) },
    { advance: 130000, setpoint: sp({}, { sources: [entry('x')] }) },
  ] }));
  return cases;
}

// --- reine Modulfaelle -------------------------------------------------------
function moduleCases() {
  const split = [];
  for (const cap of [0, 5, 20, 54, 100, NaN]) {
    for (const unc of [undefined, 0, 4, 30]) {
      for (const us of [[], [{ id: 'a', ratedKw: 27 }], [{ id: 'a', ratedKw: 27 }, { id: 'b', ratedKw: 8 }], [{ id: 'a', ratedKw: 27 }, { id: 'b', ratedKw: 3 }, { id: 'c', ratedKw: 0 }]]) {
        split.push({ plantCapKw: cap, uncontrolledKw: unc, units: us, out: CURT.splitPlantCap({ plantCapKw: cap, uncontrolledKw: unc, units: us }) });
      }
    }
  }
  const enforcement = [];
  for (const a of [{}, { capKw: 10 }, { capKw: 10, activeSinceMs: T0 - 100000 }, { capKw: 10, activeSinceMs: T0 - 100000, measuredKw: 9, measuredAtMs: T0 - 1000 },
    { capKw: 10, activeSinceMs: T0 - 100000, measuredKw: 11.5, measuredAtMs: T0 - 1000 },
    { capKw: 10, activeSinceMs: T0 - 100000, measuredKw: 10.8, measuredAtMs: T0 - 1000 }, { capKw: 2, activeSinceMs: T0 - 100000, measuredKw: 2.6, measuredAtMs: T0 - 1000 },
    { capKw: 10, activeSinceMs: T0 - 10000, measuredKw: 15, measuredAtMs: T0 - 1000 }, { capKw: 10, activeSinceMs: T0 - 100000, measuredKw: 15, measuredAtMs: T0 - 70000 }]) {
    const args = Object.assign({ nowMs: T0 }, a);
    enforcement.push({ args, out: CURT.evaluateEnforcement(args) });
  }
  const rb = (role, cmd, act, match) => ({ role, commanded_raw: cmd, actual_raw: act, match });
  const readback = [[], [rb('pv_limit_pct', 7400, 7400, true), rb('pv_limit_revert_tms', 60, 60, true), rb('pv_limit_enable', 1, 1, true)],
    [rb('pv_limit_pct', 10000, 10000, true), rb('pv_limit_enable', 0, 1, false)], [rb('pv_limit_pct', 7400, 10000, false), rb('pv_limit_enable', 1, 1, true)],
    [rb('pv_limit_pct', 7400, null, false), rb('pv_limit_enable', 1, 0, false)], [rb('pv_limit_revert_tms', 60, 12000, false)], [null, { role: 5 }]]
    .map((regs) => ({ registers: regs, out: CURT.evaluateReadback({}, regs) }));
  const unit = (mode, values, extra = {}) => Object.assign({ mode, plan: { ok: true, writes: values ? [{ role: 'pv_limit_block', fc: 16, values }] : [] }, planned: [] }, extra);
  const decision = [];
  const states = [{}, { sig: 'apply|pv_limit_block=7400.0.60.0.1', wroteAt: T0 - 5000 }, { sig: 'apply|pv_limit_block=7400.0.60.0.1', wroteAt: T0 - 25000 },
    { sig: 'x', wroteAt: T0 - 1000 }, { sig: 'apply|pv_limit_block=7400.0.60.0.1', wroteAt: T0 - 1000, deviating: true, attempts: 2 },
    { sig: 'apply|pv_limit_block=7400.0.60.0.1', wroteAt: T0 - 1000, deviating: true, attempts: 3 },
    { sig: 'apply|pv_limit_block=7400.0.60.0.1', wroteAt: T0 - 1000, blockedSince: T0 - 10000 },
    { sig: 'apply|pv_limit_block=7400.0.60.0.1', wroteAt: T0 - 1000, blockedSince: T0 - 70000 }];
  for (const u of [unit('apply', [7400, 0, 60, 0, 1]), unit('apply', [7400, 0, 60, 0, 1], { calibration: true }), unit('apply', null),
    { mode: 'release', plan: { ok: true, writes: [{ role: 'pv_limit_pct', fc: 6, value: 10000 }, { role: 'pv_limit_enable', fc: 6, value: 0 }] } }]) {
    for (const st of states) {
      const d = CURT.writeDecision({ unit: u, state: st, nowMs: T0 });
      decision.push({ unit: u, state: st, decision: d, signature: CURT.commandSignature(u),
        noteWrite: CURT.noteWrite(st, d, T0), heldVerdict: CURT.noteVerdict(st, { held: true }, T0), badVerdict: CURT.noteVerdict(st, { held: false }, T0) });
    }
  }
  const lease = [];
  for (const c of [undefined, { at: T0 - 1000, disc: { ok: true } }, { at: T0 - 4000000, disc: { ok: true } }, { at: T0 - 1000, failed: true }, { at: T0 - 200000, failed: true }]) {
    lease.push({ cached: c, state: LEASE.discoveryState(c, T0) });
  }
  const observe = [undefined, 0, T0 - 59999, T0 - 60000].map((at) => ({ at, due: LEASE.observeDue(at, T0) }));
  return { split, enforcement, readback, decision, lease, observe };
}

async function build() {
  const data = { hinweis: 'Erzeugt von steuerplan-abregelung-vectors.gen.js - nicht von Hand aendern.', t0: T0,
    modul: moduleCases(), kette: await chainCases() };
  return JSON.stringify(enc(data)) + '\n';
}

if (require.main === module) {
  build().then((s) => { fs.writeFileSync(OUT, s); console.log('geschrieben: ' + OUT + ' (' + fs.statSync(OUT).size + ' Bytes)'); });
}

module.exports = { OUT, build };
