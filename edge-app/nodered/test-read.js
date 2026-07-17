'use strict';

/**
 * test-read - the one-shot "Verbindung testen" read used by the :8484 web app.
 *
 * The customer/operator fills an UNSAVED inverter or source connection form and
 * clicks "Verbindung testen"; the core publishes it on edge/test-read/request,
 * Node-RED reads the device ONCE with the SAME route()+decode the self-wiring
 * poll uses, and answers on edge/test-read/result. This module is the canonical,
 * unit-tested source of truth for that one-shot read + the honest error
 * classification; the flow's "Verbindung testen (einmal lesen)" function node
 * carries a synced copy (build-flows.js embeds this module + the decode modules,
 * flows-sync.test.js pins them). It reuses the exact register maps/scaling of
 * deye-decode.js / modbus-tcp.js / fronius(solar-api).js - nothing is decoded
 * twice.
 *
 * Read-only by construction: it opens a socket / does one HTTP GET, reads, and
 * never writes anything to the device. It NEVER blocks Speichern - it is a
 * confidence check.
 *
 * `makeReadOnce(deps)` takes its dependencies injected so the same code runs in
 * a unit test (real `net`/`http` + in-process servers) and in the flow node
 * (`global.get('net')` etc. + the embedded decode modules):
 *   deps = { deye, modbus, fronius, solarman, sunspec, discovery, net, http, https }
 * (`sunspec` = sunspec/sunspec-live.js, `discovery` = sunspec/model-discovery.js,
 * both used for the real SunSpec-Modbus read path)
 * and returns `readOnce(selection, role) -> Promise<Result>` where Result is
 *   { ok:true,  reading:{ pv_kw?, load_kw?, grid_kw?, soc_pct? } }
 *   { ok:false, error_code, message? }
 * with error_code in the honest set the UI maps to German copy:
 *   invalid_request | unreachable | no_answer | invalid_response |
 *   implausible | fronius_api
 */

// Error codes (kept in sync with edge-app/core/internal/testconn + the portal).
const ERR_INVALID_REQUEST = 'invalid_request';
const ERR_UNREACHABLE = 'unreachable';
const ERR_NO_ANSWER = 'no_answer';
const ERR_INVALID_RESPONSE = 'invalid_response';
const ERR_IMPLAUSIBLE = 'implausible';
const ERR_FRONIUS_API = 'fronius_api';

const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_READ_TIMEOUT_MS = 8000;
const DEFAULT_HTTP_TIMEOUT_MS = 8000;

function num(v, d) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && isFinite(n) ? n : d;
}

// toReading maps the canonical decode output (power_kw=grid, pv_power_kw, ...)
// onto the fields the UI shows, keeping only present numbers (never a fabricated
// 0). A grid meter (role grid-meter) shows only Netzbezug.
function toReading(r, role) {
  const out = {};
  const set = (k, v) => { if (typeof v === 'number' && isFinite(v)) out[k] = v; };
  if (!r || typeof r !== 'object') return out;
  if (role === 'grid-meter') {
    set('grid_kw', r.power_kw);
    return out;
  }
  set('pv_kw', r.pv_power_kw);
  set('load_kw', r.load_kw);
  set('grid_kw', r.power_kw);
  set('soc_pct', r.soc_pct);
  return out;
}

function makeReadOnce(deps) {
  const deye = deps.deye;
  const modbus = deps.modbus;
  const fronius = deps.fronius;
  const solarman = deps.solarman;
  const sunspec = deps.sunspec;
  const discovery = deps.discovery;
  const net = deps.net;
  const http = deps.http;
  const https = deps.https;
  const CONNECT_TIMEOUT_MS = deps.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  const READ_TIMEOUT_MS = deps.readTimeoutMs || DEFAULT_READ_TIMEOUT_MS;
  const HTTP_TIMEOUT_MS = deps.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS;

  // planFor mirrors inverter-routing.route(): pick exactly one read path from a
  // (possibly unsaved) selection, reusing the register maps of the embedded
  // decode modules. Returns { adapter:'idle', reason } when unusable.
  function planFor(sel) {
    const conn = (sel && sel.connection) || {};
    const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
    if (!ip) return { adapter: 'idle', reason: 'keine IP-Adresse' };
    if (sel.communication === 'solarman_v5') {
      const reads = deye.planReads({ family: sel.family });
      if (!reads || !reads.length) return { adapter: 'idle', reason: 'unbekannte Deye-Familie: ' + sel.family };
      const serial = conn.serial;
      if (serial === undefined || serial === null || serial === '' || !(Number(serial) > 0)) {
        return { adapter: 'idle', reason: 'Datenlogger-Seriennummer fehlt' };
      }
      return {
        adapter: 'solarman_v5', ip, port: num(conn.port, 8899), family: sel.family, reads,
        serial, slaveId: num(conn.mb_slave_id, 1),
        invert_grid_sign: !!conn.invert_grid_sign, invert_batt_sign: !!conn.invert_batt_sign,
        power_scale: num(conn.power_scale, 0),
      };
    }
    if (sel.communication === 'modbus_tcp') {
      const read = modbus.profileRead(sel.family);
      if (!read) return { adapter: 'idle', reason: 'unbekanntes Modbus-Profil: ' + sel.family };
      return { adapter: 'modbus_tcp', ip, port: num(conn.port, 502), profile: sel.family, unitId: num(conn.unit_id, 1), read };
    }
    if (sel.communication === 'fronius_solar_api') {
      const insecure = !!conn.insecure_tls;
      const scheme = insecure ? 'https' : 'http';
      const port = num(conn.port, 80);
      return { adapter: 'fronius_solar_api', ip, port, scheme, insecure_tls: insecure, invert_grid_sign: !!conn.invert_grid_sign, url: fronius.powerFlowUrl(scheme, ip, port) };
    }
    if (sel.communication === 'fronius_sunspec') {
      return {
        adapter: 'sunspec_live', ip, port: num(conn.port, 502), unitId: num(conn.unit_id, 1),
        invert_grid_sign: !!conn.invert_grid_sign,
        model_type: conn.model_type === 'float' || conn.model_type === 'int_sf' ? conn.model_type : 'auto',
      };
    }
    return { adapter: 'idle', reason: 'unbekannte Kommunikationsmethode' };
  }

  // dialThenRead opens one TCP connection (classifying a connect failure as
  // unreachable) and runs `doIo(sock, resolveOk, resolveErr)`; a read that never
  // completes within READ_TIMEOUT_MS is classified no_answer.
  function dialThenRead(ip, port, doIo) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      let settled = false;
      const done = (res) => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) { /* ignore */ } resolve(res); };
      const connectTimer = setTimeout(() => done({ ok: false, error_code: ERR_UNREACHABLE }), CONNECT_TIMEOUT_MS);
      sock.once('error', () => { clearTimeout(connectTimer); done({ ok: false, error_code: ERR_UNREACHABLE }); });
      sock.connect(port, ip, () => {
        clearTimeout(connectTimer);
        // Past connect: a stall is "connected, no answer".
        const readTimer = setTimeout(() => done({ ok: false, error_code: ERR_NO_ANSWER }), READ_TIMEOUT_MS);
        const ok = (res) => { clearTimeout(readTimer); done(res); };
        try {
          doIo(sock, ok);
        } catch (e) {
          ok({ ok: false, error_code: ERR_INVALID_RESPONSE });
        }
      });
    });
  }

  function readModbus(plan, role) {
    return dialThenRead(plan.ip, plan.port, (sock, ok) => {
      let acc = Buffer.alloc(0);
      const txid = 1;
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        let need;
        try { need = modbus.expectedFrameLength(acc); } catch (e) { return ok({ ok: false, error_code: ERR_INVALID_RESPONSE }); }
        if (need === null || acc.length < need) return;
        let regs;
        try {
          regs = modbus.parseReadResponse(acc.slice(0, need), { expectTxid: txid, expectUnit: plan.unitId });
        } catch (e) {
          return ok({ ok: false, error_code: ERR_INVALID_RESPONSE });
        }
        const out = modbus.decodeProfile(plan.profile, regs);
        if (!out || !out.reading) return ok({ ok: false, error_code: ERR_INVALID_RESPONSE });
        ok({ ok: true, reading: toReading(out.reading, role) });
      });
      sock.write(modbus.buildReadRequest({ txid, unitId: plan.unitId, addr: plan.read.addr, count: plan.read.count }));
    });
  }

  function readSolarman(plan, role) {
    return dialThenRead(plan.ip, plan.port, (sock, ok) => {
      const blocks = [];
      let idx = 0;
      let acc = Buffer.alloc(0);
      let seq = 1;
      const sendNext = () => {
        acc = Buffer.alloc(0);
        const r = plan.reads[idx];
        seq = (seq + 1) & 0xffff;
        const frame = solarman.buildReadRequest({ loggerSerial: plan.serial, sequence: seq, slaveId: plan.slaveId, startReg: r.start, count: r.count });
        sock.write(frame);
      };
      const onFrame = () => {
        const r = plan.reads[idx];
        let block;
        try {
          block = solarman.registerBlock(r.start, acc, { expectLoggerSerial: plan.serial });
        } catch (e) {
          return ok({ ok: false, error_code: ERR_INVALID_RESPONSE });
        }
        blocks.push(block);
        idx += 1;
        if (idx < plan.reads.length) { sendNext(); return; }
        const out = deye.decode(blocks, {
          family: plan.family, invert_grid_sign: plan.invert_grid_sign,
          invert_batt_sign: plan.invert_batt_sign, power_scale: plan.power_scale,
        });
        if (!out || !out.reading) {
          // A battery family that decoded to nothing is almost always an
          // implausible SoC (the decode's drop-don't-fabricate gate); anything
          // else is a wrong family / malformed block.
          const battery = /^hybrid/.test(plan.family || '');
          return ok({ ok: false, error_code: battery ? ERR_IMPLAUSIBLE : ERR_INVALID_RESPONSE });
        }
        ok({ ok: true, reading: toReading(out.reading, role) });
      };
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        let need;
        try { need = solarman.expectedFrameLength(acc); } catch (e) { return ok({ ok: false, error_code: ERR_INVALID_RESPONSE }); }
        if (need === null || acc.length < need) return;
        onFrame();
      });
      sendNext();
    });
  }

  function readFronius(plan, role) {
    return new Promise((resolve) => {
      const lib = plan.scheme === 'https' ? https : http;
      let settled = false;
      const done = (res) => { if (settled) return; settled = true; resolve(res); };
      const opts = { method: 'GET', timeout: HTTP_TIMEOUT_MS };
      if (plan.scheme === 'https') opts.rejectUnauthorized = plan.insecure_tls ? false : true;
      let req;
      try {
        req = lib.request(plan.url, opts, (res) => {
          if (res.statusCode >= 400) { res.resume(); return done({ ok: false, error_code: ERR_FRONIUS_API }); }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; if (body.length > 262144) { try { req.destroy(); } catch (e) { /* ignore */ } } });
          res.on('end', () => {
            let json;
            try { json = JSON.parse(body); } catch (e) { return done({ ok: false, error_code: ERR_FRONIUS_API }); }
            const out = fronius.decodePowerFlow(json, { invertGridSign: plan.invert_grid_sign });
            if (!out || !out.reading) return done({ ok: false, error_code: ERR_FRONIUS_API });
            done({ ok: true, reading: toReading(out.reading, role) });
          });
        });
      } catch (e) {
        return done({ ok: false, error_code: ERR_FRONIUS_API });
      }
      req.on('error', () => done({ ok: false, error_code: ERR_FRONIUS_API }));
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } done({ ok: false, error_code: ERR_FRONIUS_API }); });
      req.end();
    });
  }

  // readSunSpec proves a real SunSpec-Modbus read: it first probes the TCP
  // connect (so a refused host classifies as unreachable), then runs the full
  // sunspec-live discovery walk + measurement decode. A connected host that is
  // not a decodable SunSpec device (or does not answer the walk) -> invalid
  // response. Read-only.
  function readSunSpec(plan, role) {
    return new Promise((resolve) => {
      const probe = new net.Socket();
      probe.setNoDelay(true);
      let settled = false;
      const done = (res) => { if (settled) return; settled = true; try { probe.destroy(); } catch (e) { /* ignore */ } resolve(res); };
      const t = setTimeout(() => done({ ok: false, error_code: ERR_UNREACHABLE }), CONNECT_TIMEOUT_MS);
      probe.once('error', () => { clearTimeout(t); done({ ok: false, error_code: ERR_UNREACHABLE }); });
      probe.connect(plan.port, plan.ip, () => {
        clearTimeout(t);
        try { probe.destroy(); } catch (e) { /* ignore */ }
        const read = sunspec.makeSunspecReader({ net, discovery, connectTimeoutMs: CONNECT_TIMEOUT_MS, readTimeoutMs: READ_TIMEOUT_MS });
        read({ ip: plan.ip, port: plan.port, unitId: plan.unitId, invertGridSign: plan.invert_grid_sign, modelType: plan.model_type })
          .then((out) => {
            if (out && out.reading) return done({ ok: true, reading: toReading(out.reading, role) });
            done({ ok: false, error_code: ERR_INVALID_RESPONSE });
          })
          .catch(() => done({ ok: false, error_code: ERR_INVALID_RESPONSE }));
      });
    });
  }

  return function readOnce(selection, role) {
    const plan = planFor(selection);
    if (plan.adapter === 'idle') return Promise.resolve({ ok: false, error_code: ERR_INVALID_REQUEST, message: plan.reason });
    if (plan.adapter === 'modbus_tcp') return readModbus(plan, role);
    if (plan.adapter === 'solarman_v5') return readSolarman(plan, role);
    if (plan.adapter === 'fronius_solar_api') return readFronius(plan, role);
    if (plan.adapter === 'sunspec_live') return readSunSpec(plan, role);
    return Promise.resolve({ ok: false, error_code: ERR_INVALID_REQUEST });
  };
}

// --- multi-inverter unit-ID enumeration (Fronius Datamanager) ----------------
//
// A Fronius Datamanager exposes SEVERAL inverters on ONE IP, one Modbus unit id
// per inverter (Datamanager convention: inverter number = unit id, e.g. the
// captain's site "Asbeck Büro Isaraue": two Eco 27.0-3-S as Nr 1 "ost" / Nr 2
// "west" -> unit ids 1 / 2). A source configured with the default unit_id 1
// silently reads ONLY inverter 1 - so the add/test UX probes the same address
// for FURTHER unit ids and offers to create a source per found inverter.
//
// makeProbeUnits(deps) returns probeUnits(selection) -> Promise<Result>:
//   { ok:true, found_units:[1,2] }  - every unit id (1..max) presenting a
//                                     SunSpec SID marker ("SunS") at this address
//   { ok:false, error_code, message? } - invalid form / host unreachable
//
// Bounded + read-only by construction: ONE TCP connection, one 2-register FC3
// SID read per (unit id, base), a short per-id timeout, and a hard overall
// budget after which whatever was found so far is returned (never a hang, never
// a write). A present unit answers its SID in one round trip; an absent unit on
// a Datamanager answers a fast Modbus exception (gateway target failed). Once
// any unit answered at a base, that base is locked for the rest of the scan
// (a Datamanager serves all inverters at the same base, 40000). fronius_sunspec
// only - the other transports have no unit-id fan-out worth scanning.
const PROBE_MAX_UNIT_ID = 10;
const DEFAULT_PROBE_ID_TIMEOUT_MS = 1500;
const DEFAULT_PROBE_OVERALL_MS = 12000;
const PROBE_BASES = [40000, 50000, 0];

function makeProbeUnits(deps) {
  const net = deps.net;
  const CONNECT_TIMEOUT_MS = deps.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  const PER_ID_TIMEOUT_MS = deps.probeIdTimeoutMs || DEFAULT_PROBE_ID_TIMEOUT_MS;
  const OVERALL_TIMEOUT_MS = deps.probeOverallMs || DEFAULT_PROBE_OVERALL_MS;
  const MAX_UNIT_ID = deps.probeMaxUnitId || PROBE_MAX_UNIT_ID;
  const SUNS_HI = 0x5375;
  const SUNS_LO = 0x6e53;

  return function probeUnits(selection) {
    const sel = selection || {};
    const conn = sel.connection || {};
    const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
    if (sel.communication !== 'fronius_sunspec') {
      return Promise.resolve({ ok: false, error_code: ERR_INVALID_REQUEST, message: 'Die Suche nach weiteren Wechselrichtern gibt es nur für SunSpec (Modbus TCP).' });
    }
    if (!ip) return Promise.resolve({ ok: false, error_code: ERR_INVALID_REQUEST, message: 'keine IP-Adresse' });
    const port = num(conn.port, 502);

    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      let settled = false;
      let acc = Buffer.alloc(0);
      let txid = 0;
      let pending = null; // { wantTxid, res } - res({regs}|{exception}|{timeout})
      let idTimer = null;
      const found = [];

      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(overallTimer);
        clearTimeout(idTimer);
        try { sock.destroy(); } catch (e) { /* ignore */ }
        resolve(res);
      };
      const finishOk = () => done({ ok: true, found_units: found.slice() });

      const connectTimer = setTimeout(() => done({ ok: false, error_code: ERR_UNREACHABLE }), CONNECT_TIMEOUT_MS);
      // The hard budget: a scan NEVER outlives this - return what was found.
      const overallTimer = setTimeout(finishOk, OVERALL_TIMEOUT_MS);
      sock.once('error', () => {
        if (found.length) finishOk();
        else done({ ok: false, error_code: ERR_UNREACHABLE });
      });

      // One FC3 read of the 2-register SID at `addr` for `unitId`. Resolves
      // { regs } on data, { exception:true } on a Modbus exception (absent unit,
      // fast - try the next base), { timeout:true } when the gateway stays
      // silent (skip the remaining bases for this id - more probes would only
      // burn more timeouts).
      const readSid = (unitId, addr) => new Promise((res) => {
        txid = (txid + 1) & 0xffff;
        const wantTxid = txid;
        const buf = Buffer.alloc(12);
        buf.writeUInt16BE(wantTxid, 0);
        buf.writeUInt16BE(0, 2);
        buf.writeUInt16BE(6, 4);
        buf[6] = unitId & 0xff;
        buf[7] = 0x03;
        buf.writeUInt16BE(addr & 0xffff, 8);
        buf.writeUInt16BE(2, 10);
        pending = { wantTxid, res };
        clearTimeout(idTimer);
        idTimer = setTimeout(() => {
          if (pending && pending.wantTxid === wantTxid) { pending = null; res({ timeout: true }); }
        }, PER_ID_TIMEOUT_MS);
        sock.write(buf);
      });

      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 6) {
          const need = 6 + acc.readUInt16BE(4);
          if (acc.length < need) return;
          const frame = acc.slice(0, need);
          acc = acc.slice(need);
          if (!pending) continue; // stray frame
          if (frame.readUInt16BE(0) !== pending.wantTxid) continue; // late answer to a timed-out probe - drop
          const p = pending;
          pending = null;
          clearTimeout(idTimer);
          const fn = frame[7];
          if (fn & 0x80) { p.res({ exception: true }); continue; }
          if (fn !== 0x03 || frame[8] < 4 || frame.length < 13) { p.res({ exception: true }); continue; }
          p.res({ regs: [frame.readUInt16BE(9), frame.readUInt16BE(11)] });
        }
      });

      sock.connect(port, ip, async () => {
        clearTimeout(connectTimer);
        try {
          let bases = PROBE_BASES.slice();
          for (let unitId = 1; unitId <= MAX_UNIT_ID && !settled; unitId++) {
            for (const base of bases) {
              const out = await readSid(unitId, base);
              if (settled) return;
              if (out.regs && out.regs[0] === SUNS_HI && out.regs[1] === SUNS_LO) {
                found.push(unitId);
                bases = [base]; // every inverter on a Datamanager sits at the same base
                break;
              }
              if (out.timeout) break; // silent gateway for this id - don't burn more timeouts
            }
          }
          finishOk();
        } catch (e) {
          finishOk();
        }
      });
    });
  };
}

module.exports = {
  ERR_INVALID_REQUEST,
  ERR_UNREACHABLE,
  ERR_NO_ANSWER,
  ERR_INVALID_RESPONSE,
  ERR_IMPLAUSIBLE,
  ERR_FRONIUS_API,
  PROBE_MAX_UNIT_ID,
  toReading,
  makeReadOnce,
  makeProbeUnits,
};
