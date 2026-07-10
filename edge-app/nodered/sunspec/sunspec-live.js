'use strict';

/**
 * sunspec-live - the LIVE-MEASUREMENT read path for a real SunSpec-conformant
 * inverter over Modbus TCP. It is the missing read half of the SunSpec work: the
 * sibling sunspec/model-discovery.js walks the dynamic model linked list and
 * resolves the CONTROL-side addresses (Nameplate 120 / Immediate Controls 123 /
 * Storage 124), but decodes ZERO measurements. This module adds the measurement
 * DECODE (inverter models 111/112/113 float + 101/102/103 int+SF, and a minimal
 * meter 211/212/213 decode) and the socket-driven READER that fetches the model
 * image and produces the flat edge/telemetry reading.
 *
 * It is the SunSpec analogue of deye/deye-decode.js (+ deye/solarman-v5.js): the
 * pure decoders own the field-offset arithmetic; the reader owns the socket
 * walk. The primary target is a Fronius Eco 27.0-3-S (a 3-phase PV-only string
 * inverter, SunSpec model type = float) whose Solar API does NOT work, so it must
 * be read over SunSpec Modbus TCP (port 502). See FRONIUS.md and the scout report
 * data/vp-fronius-edge-r7.
 *
 * PURITY / TESTABILITY (mirrors model-discovery.js):
 *   - The decoders take a synchronous `readBlock(addr, count) -> number[]` reader
 *     (image-backed in the offline unit tests, socket-image-backed in production),
 *     so they are deterministic and unit-tested with no hardware.
 *   - `makeSunspecReader(deps)` takes its socket dependency (`net`) + the
 *     model-discovery module injected, so the SAME code runs in a unit test (real
 *     node:net + an in-process Modbus server) and in the Node-RED flow node
 *     (global.get('net') + the embedded modules). This module `require`s NOTHING,
 *     so build-flows.js can embed it verbatim (a flow cannot `require` a repo
 *     file); flows-sync.test.js pins the embed.
 *
 * DISCOVERY IS LOAD-BEARING (report §2.1, Fronius manual): "register addresses do
 * not remain constant ... search for the model, then work with offsets." The
 * model BASE is discovered live; the FIELD offsets within a model ARE the fixed
 * SunSpec definition. Never a hard-coded absolute address.
 *
 * READ-ONLY: this module opens a socket and reads holding registers (FC3) only.
 * It NEVER writes. Control (curtailment, Model 123) is a separate, bench-gated
 * increment and lives in model-discovery.js (planned-only).
 *
 * HONESTY (report, CUSTOM-INVERTER.md): every channel is OPTIONAL. A value is
 * present only when it was actually read + is finite; a channel that could not be
 * read is ABSENT, never a fabricated 0. A W reading of exactly 0 (inverter idle /
 * night) IS a real reading and is kept.
 */

// --- numeric helpers ---------------------------------------------------------

const s16 = (v) => {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
};
const u32 = (hi, lo) => ((hi & 0xffff) * 0x10000 + (lo & 0xffff)) >>> 0;
const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

// IEEE-754 single-precision float from two big-endian 16-bit words (SunSpec is
// big-endian, most-significant word first: reg[i] = high word, reg[i+1] = low).
function f32(hi, lo) {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(hi & 0xffff, 0);
  buf.writeUInt16BE(lo & 0xffff, 2);
  return buf.readFloatBE(0);
}

// --- SunSpec measurement model field offsets (BODY-relative) -----------------
//
// Body-relative = offset from the model BODY start (discovered bodyAddr = model
// header start + 2 for the id/len header). The canonical SunSpec model
// definitions (github.com/sunspec/models) give offsets from the MODEL start
// (including the 2-word header); body-relative = that number - 2. These are the
// STANDARD, not a guessed absolute table - the base is discovered.
//
// Inverter model 111/112/113 (FLOAT), from model_113.json:
//   W@22 Hz@24 WH@32 DCW@38 St@48 Evt1@50 (model-start) -> body-relative below.
const INV_FLOAT = {
  W: 20, // float32 - AC real power (W)
  Hz: 22, // float32 - line frequency
  St: 46, // enum16  - operating state
  Evt1: 48, // bitfield32 - event flags 1
};
// Inverter model 101/102/103 (INT+SF), from model_103.json:
//   W@14 W_SF@15 Hz@16 Hz_SF@17 St@38 Evt1@40 (model-start) -> body-relative below.
const INV_INT = {
  W: 12, // int16 - AC real power, scaled by W_SF
  W_SF: 13, // sunssf (signed)
  Hz: 14, // int16, scaled by Hz_SF
  Hz_SF: 15, // sunssf
  St: 36, // enum16
  Evt1: 38, // bitfield32
};

// Inverter operating-state enum (SunSpec St, models 10X/11X). St=4 MPPT =
// producing; St=5 THROTTLED is the tell-tale that a curtailment (or the device's
// own dynamic power reduction) is active - useful for a later override check.
const INV_STATE = {
  1: 'OFF',
  2: 'SLEEPING',
  3: 'STARTING',
  4: 'MPPT',
  5: 'THROTTLED',
  6: 'SHUTTING_DOWN',
  7: 'FAULT',
  8: 'STANDBY',
};

// Which model ids are inverter measurement models, and their type.
const INVERTER_FLOAT = { 111: 'single', 112: 'split', 113: 'three' };
const INVERTER_INT_SF = { 101: 'single', 102: 'split', 103: 'three' };

// Meter measurement models (Fronius Smart Meter etc.). Kept MINIMAL + OPTIONAL:
// the captain's Eco site has NO meter, so this is scaffolding for a later
// increment (a Netz measurement point) and its exact W offset is NOT bench-
// verified here. Canonical meter model 211/212/213 (FLOAT, model_213.json) places
// the total real power W at model-start offset 28 -> body-relative 26. VERIFY on
// device before wiring a meter live (report §2.3 flags a documented-table
// disagreement on this exact register). Only total power W is decoded.
const METER_FLOAT = { 211: 'single', 212: 'split', 213: 'three' };
const MET_FLOAT = {
  W: 26, // float32 - total real power (grid), body-relative. VERIFY on device.
};

// --- pure decoders -----------------------------------------------------------

/**
 * decodeInverter - decode the inverter measurement model (float 111/112/113 or
 * int+SF 101/102/103) that discovery classified, using DISCOVERED addresses.
 * Returns { pv_power_kw, w_kw, hz, st, stLabel, evt1 } or null (idle-safe) when
 * discovery has no inverter model or the body cannot be read / W is not finite.
 *
 * pv_power_kw = max(0, W)/1000: a string inverter's AC output IS its PV
 * generation. A negative W (rare, night self-consumption) floors to 0 for the PV
 * channel while w_kw keeps the signed value for diagnostics.
 *
 *   { discovery, readBlock, modelType? }
 *     modelType - optional override hint 'float' | 'int_sf'; when absent the
 *                 walker's classification (discovery.inverter.type) is used.
 */
function decodeInverter(args) {
  args = args || {};
  const discovery = args.discovery;
  const readBlock = args.readBlock;
  if (!discovery || !discovery.ok || !discovery.inverter) return null;
  const inv = discovery.inverter;
  const m = discovery.byId && discovery.byId[inv.id];
  if (!m || typeof m.bodyAddr !== 'number') return null;

  const type = args.modelType === 'float' || args.modelType === 'int_sf' ? args.modelType : inv.type;
  const off = type === 'int_sf' ? INV_INT : INV_FLOAT;
  // Read the whole model body (len words) so every field offset is covered.
  const need = Math.max(off.Evt1 + 2, (typeof m.len === 'number' ? m.len : 0));
  const regs = safeRead(readBlock, m.bodyAddr, need);
  if (!regs) return null;

  let wWatts;
  if (type === 'int_sf') {
    const raw = s16(regs[off.W]);
    const sf = s16(regs[off.W_SF]);
    wWatts = raw * Math.pow(10, sf);
  } else {
    wWatts = f32(regs[off.W], regs[off.W + 1]);
  }
  if (!isFinite(wWatts)) return null;

  let hz = null;
  if (type === 'int_sf') {
    const raw = s16(regs[off.Hz]);
    const sf = s16(regs[off.Hz_SF]);
    const v = raw * Math.pow(10, sf);
    if (isFinite(v)) hz = round1(v);
  } else {
    const v = f32(regs[off.Hz], regs[off.Hz + 1]);
    if (isFinite(v)) hz = round1(v);
  }

  const st = regs[off.St] & 0xffff;
  const evt1 = u32(regs[off.Evt1], regs[off.Evt1 + 1]);

  return {
    pv_power_kw: round3(Math.max(0, wWatts) / 1000),
    w_kw: round3(wWatts / 1000),
    hz,
    st,
    stLabel: INV_STATE[st] || null,
    evt1,
  };
}

/**
 * decodeMeter - MINIMAL, OPTIONAL decode of a meter measurement model (float
 * 211/212/213): total real power W -> the grid channel `power_kw`. Returns
 * { power_kw } or null (idle-safe) when no meter model / unreadable. The sign is
 * firmware-dependent: SunSpec meter W vs VoltPilot's +import/-export must be
 * VERIFIED on device; `invertGridSign` is the escape hatch. Scaffolding for a
 * later increment - the captain's Eco site has no meter, so this is NOT wired
 * live and NOT bench-verified.
 *
 *   { discovery, readBlock, invertGridSign? }
 */
function decodeMeter(args) {
  args = args || {};
  const discovery = args.discovery;
  const readBlock = args.readBlock;
  if (!discovery || !discovery.ok || !Array.isArray(discovery.models)) return null;
  const m = discovery.models.find((x) => METER_FLOAT[x.id]);
  if (!m || typeof m.bodyAddr !== 'number') return null;
  const need = Math.max(MET_FLOAT.W + 2, typeof m.len === 'number' ? m.len : 0);
  const regs = safeRead(readBlock, m.bodyAddr, need);
  if (!regs) return null;
  const wWatts = f32(regs[MET_FLOAT.W], regs[MET_FLOAT.W + 1]);
  if (!isFinite(wWatts)) return null;
  const sign = args.invertGridSign ? -1 : 1;
  return { power_kw: round3((sign * wWatts) / 1000) };
}

/**
 * decodeMeasurements - the read profile: discover() a device (or take an existing
 * discovery result), decode whatever measurement models are present at this
 * (ip, unit_id), and merge into the flat edge/telemetry reading. For a PV-only
 * inverter (the Eco) that is `{ pv_power_kw }`; a meter, if present, adds
 * `power_kw`. Returns { reading, meta } or null when nothing decodable.
 *
 *   { discovery, readBlock, invertGridSign? }
 * `reading` never carries a `ts` - the caller (flow node) stamps it, mirroring
 * modbus-tcp.js / deye-decode.js.
 */
function decodeMeasurements(args) {
  args = args || {};
  const discovery = args.discovery;
  const readBlock = args.readBlock;
  if (!discovery || !discovery.ok) return null;

  const inv = decodeInverter({ discovery, readBlock, modelType: args.modelType });
  const meter = decodeMeter({ discovery, readBlock, invertGridSign: args.invertGridSign });

  const reading = {};
  const meta = { base: discovery.base };
  if (inv) {
    reading.pv_power_kw = inv.pv_power_kw;
    meta.inverterModel = discovery.inverter ? discovery.inverter.id : null;
    meta.inverterType = discovery.inverter ? discovery.inverter.type : null;
    meta.w_kw = inv.w_kw;
    meta.hz = inv.hz;
    meta.st = inv.st;
    meta.stLabel = inv.stLabel;
    meta.evt1 = inv.evt1;
  }
  if (meter) {
    reading.power_kw = meter.power_kw;
    meta.meter = true;
  }
  if (Object.keys(reading).length === 0) return null;
  return { reading, meta };
}

function safeRead(readBlock, addr, count) {
  let r;
  try {
    r = readBlock(addr, count);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(r) || r.length < count) return null;
  for (let i = 0; i < count; i++) {
    if (typeof r[i] !== 'number' || !isFinite(r[i])) return null;
  }
  return r;
}

// --- socket-driven reader ----------------------------------------------------

const FN_READ_HOLDING = 0x03;
const SID = 0x53756e53; // "SunS"
const END_MODEL_ID = 0xffff;
const COMMON_BASES = [40000, 50000, 0];
const MAX_MODELS = 256; // runaway guard (a real device has ~10)
const MAX_BODY_CHUNK = 125; // FC3 max registers per read

/**
 * makeSunspecReader - build a reader that opens ONE Modbus-TCP connection, walks
 * the SunSpec model linked list (following the real dynamic list, reading exactly
 * what exists - no over-read, no cap guessing), assembles the register image, and
 * then runs the PURE discover() + decodeMeasurements() over it. Read-only: FC3
 * only, never a write.
 *
 *   deps = { net, discovery, connectTimeoutMs?, readTimeoutMs?, bases? }
 *     net       - node:net (or global.get('net') in the flow)
 *     discovery - the sunspec/model-discovery module (injected so this module
 *                 needs no `require`, so the flow can embed it)
 *
 * Returns readSunspec(target) -> Promise<{ reading, meta } | null> where
 *   target = { ip, port, unitId, invertGridSign?, modelType? }
 * and null means unreachable / no SunSpec device / nothing decodable (idle-safe,
 * never throws).
 */
function makeSunspecReader(deps) {
  const net = deps.net;
  const discovery = deps.discovery;
  const CONNECT_TIMEOUT_MS = deps.connectTimeoutMs || 8000;
  const READ_TIMEOUT_MS = deps.readTimeoutMs || 8000;
  const BASES = Array.isArray(deps.bases) ? deps.bases : COMMON_BASES;

  return function readSunspec(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    const port = Number(target.port) > 0 ? Number(target.port) : 502;
    const unitId = Number(target.unitId) > 0 ? Number(target.unitId) : 1;
    if (!ip) return Promise.resolve(null);

    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      let settled = false;
      let acc = Buffer.alloc(0);
      let pending = null; // { resolve, reject } for the one outstanding request
      let txid = 0;

      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(readTimer);
        try { sock.destroy(); } catch (e) { /* ignore */ }
        resolve(res);
      };

      const connectTimer = setTimeout(() => done(null), CONNECT_TIMEOUT_MS);
      let readTimer = null;
      const armReadTimer = () => {
        clearTimeout(readTimer);
        readTimer = setTimeout(() => done(null), READ_TIMEOUT_MS);
      };

      sock.once('error', () => done(null));

      // One FC3 request over the open socket -> Promise<number[]>. Rejects on a
      // Modbus exception / short frame / illegal address (used to detect the end
      // of the readable image while walking).
      const readReg = (addr, count) => new Promise((res, rej) => {
        txid = (txid + 1) & 0xffff;
        const wantTxid = txid;
        const buf = Buffer.alloc(12);
        buf.writeUInt16BE(wantTxid, 0);
        buf.writeUInt16BE(0, 2);
        buf.writeUInt16BE(6, 4);
        buf[6] = unitId & 0xff;
        buf[7] = FN_READ_HOLDING;
        buf.writeUInt16BE(addr & 0xffff, 8);
        buf.writeUInt16BE(count & 0xffff, 10);
        pending = { res, rej, wantTxid, count };
        acc = Buffer.alloc(0);
        armReadTimer();
        sock.write(buf);
      });

      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        if (!pending) return;
        if (acc.length < 6) return;
        const need = 6 + acc.readUInt16BE(4);
        if (acc.length < need) return;
        const frame = acc.slice(0, need);
        acc = acc.slice(need);
        const p = pending;
        pending = null;
        clearTimeout(readTimer);
        try {
          if (frame.readUInt16BE(0) !== p.wantTxid) throw new Error('txid');
          const fn = frame[7];
          if (fn & 0x80) throw new Error('exception 0x' + (frame[8] || 0).toString(16));
          if (fn !== FN_READ_HOLDING) throw new Error('fn 0x' + fn.toString(16));
          const bc = frame[8];
          if (bc <= 0 || frame.length < 9 + bc) throw new Error('short payload');
          const regs = [];
          for (let i = 0; i < bc >> 1; i++) regs.push(frame.readUInt16BE(9 + i * 2));
          p.res(regs);
        } catch (e) {
          p.rej(e);
        }
      });

      // Read a model body (possibly > 125 regs) in <=125-reg sub-chunks.
      const readBody = async (addr, len) => {
        const out = [];
        let a = addr;
        let remaining = len;
        while (remaining > 0) {
          const n = Math.min(remaining, MAX_BODY_CHUNK);
          const part = await readReg(a, n);
          for (let i = 0; i < n; i++) out.push(part[i]);
          a += n;
          remaining -= n;
        }
        return out;
      };

      // Walk the linked list at a base, storing header + body words into `img`.
      // Returns true when a valid SunS marker was found at this base.
      const walkInto = async (base, img) => {
        let sid;
        try {
          sid = await readReg(base, 2);
        } catch (e) {
          return false;
        }
        if (u32(sid[0], sid[1]) !== SID) return false;
        img.set(base, sid[0]);
        img.set(base + 1, sid[1]);
        let addr = base + 2;
        for (let i = 0; i < MAX_MODELS; i++) {
          let hdr;
          try {
            hdr = await readReg(addr, 2);
          } catch (e) {
            break; // truncated / end of readable image - keep what we have
          }
          const id = hdr[0];
          const len = hdr[1];
          img.set(addr, id);
          img.set(addr + 1, len);
          if (id === END_MODEL_ID) break;
          if (len > 0 && len <= 8192) {
            let body;
            try {
              body = await readBody(addr + 2, len);
            } catch (e) {
              break;
            }
            for (let j = 0; j < len; j++) img.set(addr + 2 + j, body[j]);
          }
          addr += 2 + len;
        }
        return true;
      };

      sock.connect(port, ip, async () => {
        clearTimeout(connectTimer);
        try {
          const img = new Map();
          let found = false;
          for (const base of BASES) {
            if (await walkInto(base, img)) { found = true; break; }
          }
          if (!found) return done(null);
          const readBlock = (addr, count) => {
            const out = [];
            for (let i = 0; i < count; i++) {
              const w = img.get(addr + i);
              if (w === undefined) break;
              out.push(w);
            }
            return out;
          };
          const disc = discovery.discover(readBlock, { bases: BASES });
          const decoded = decodeMeasurements({
            discovery: disc,
            readBlock,
            invertGridSign: !!target.invertGridSign,
            modelType: target.modelType,
          });
          done(decoded);
        } catch (e) {
          done(null);
        }
      });
    });
  };
}

module.exports = {
  INV_FLOAT,
  INV_INT,
  INV_STATE,
  INVERTER_FLOAT,
  INVERTER_INT_SF,
  METER_FLOAT,
  MET_FLOAT,
  decodeInverter,
  decodeMeter,
  decodeMeasurements,
  makeSunspecReader,
  _helpers: { s16, u32, f32, round3, round1 },
};
