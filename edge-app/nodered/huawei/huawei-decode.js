'use strict';

/**
 * huawei-decode - the canonical, unit-tested read path for the Huawei SUN2000
 * (L1/M1/MB0/MAP0) string inverter family with an attached LUNA2000 battery
 * (brand=huawei, communication=huawei_modbus): plain Modbus TCP on the
 * vendor's own server (TCP port 502). Scout report:
 * firstmate data/vp-kundenanlage-huawei-s1/report.md. Control profile (the
 * sourced register landscape this decoder draws its facts from):
 * catalog/control-profiles/profiles/huawei.json.
 *
 * SCOPE: the LUNA2000 has NO communication path of its own - it is read and
 * (eventually) controlled entirely through the inverter's storage registers,
 * so one Modbus-TCP connection to the inverter covers PV, battery SoC/power
 * and, if a Huawei Smart Power Sensor (DTSU666-H/DDSU666-H) is installed at
 * the grid connection point, the grid power too.
 *
 * Facts of the wire protocol that are load-bearing:
 *   - TCP 502. Modbus TCP must be switched on at the inverter via an
 *     installer account - without that the device does not answer at all
 *     (huawei.json `fallen`). Only ONE Modbus client may hold the connection
 *     at a time over the internal WiFi AP (it drops the FusionSolar app
 *     while attached); a Smart Dongle allows both in parallel.
 *   - Every multi-register value is BIG-ENDIAN with the HIGH WORD FIRST
 *     (huawei.json `fallen`: "Big-Endian, High-Word zuerst") - unlike KOSTAL,
 *     Huawei exposes no byte-order register, so this is fixed, never
 *     auto-detected or configurable.
 *   - PV generation MUST be read from the DC-side "Input power" (32064), NOT
 *     the AC "Active power" (32080): on a hybrid the AC side already nets out
 *     battery charge/discharge, exactly the lesson already documented for the
 *     KACO hybrid NH3 (inverter-routing.js FamKacoHTTPHybrid) - publishing
 *     32080 as PV would inflate generation by the discharge.
 *   - Register addresses and widths are corroborated across two independent
 *     community sources (an iobroker forum Modbus script + an openHAB
 *     community thread; huawei.json `quellen` cites the same class of field
 *     source as `huawei_lib`/evcc) - Sicherheit C, not a manufacturer PDF
 *     page. The battery sign convention ("positive = charging", matching
 *     VoltPilot's own + charge / - discharge) and the grid meter's sign are
 *     UNCONFIRMED on a real device (Sicherheit D) - `invert_batt_sign` /
 *     `invert_grid_sign` are the same First-Light escape hatches every other
 *     brand carries for an unverified sign, never silently assumed correct.
 *
 * Read/monitoring only: NOTHING here controls the inverter. The control path
 * (Tier-2 vendor external-EMS, registers 47075..47249) is a separate, hard-
 * locked increment - see inverter-control-routing.js huaweiControl.
 *
 * The flow's "Huawei SUN2000 lesen" function node EMBEDS this module verbatim
 * (a Node-RED flow is self-contained JSON and cannot `require` a repo file at
 * runtime; build-flows.js embeds, flows-sync.test.js pins). Dependency-free
 * (Node `Buffer` only), fully testable offline.
 */

// --- register map (decimal addresses) ---------------------------------------

const REG = {
  INPUT_POWER_W: 32064, // I32 W: PV (DC-side) input power - the Erzeugung channel
  ACTIVE_POWER_W: 32080, // I32 W: AC active power (meta only - includes battery on a hybrid)
  METER_ACTIVE_POWER_W: 37113, // I32 W: grid meter power, only meaningful with a Smart Power Sensor installed
  BATTERY_RUNNING_STATUS: 37762, // U16: battery running status (meta only)
  BATTERY_SOC_PCT_X10: 37760, // U16, x0.1 %: battery SoC
  BATTERY_CHARGE_DISCHARGE_POWER_W: 37765, // I32 W, + charging (field source)
};

const DEFAULT_PORT = 502;
const DEFAULT_UNIT_ID = 0; // factory slave id on a direct WLAN/LAN connection; a Smart Dongle commonly uses 1

// --- families ----------------------------------------------------------------
//
// One register family covers the whole SUN2000 L1/M1/MB0/MAP0 line with an
// attached LUNA2000 (huawei.json `modelle`) - mirrors the kostal-decode.FAMILIES
// shape so inverter-routing can gate on the known set.
const FAMILIES = {
  huawei_sun2000_luna: {
    label: 'Huawei SUN2000 + LUNA2000',
    hasBattery: true,
  },
};

/**
 * planReads - the FC3 read blocks one poll cycle fetches. Fixed per family (no
 * discovery walk - the map is sourced field documentation, see header). Every
 * block is well under the 125-register FC3 maximum; each is read in its own
 * request so a single refused block degrades to absent channels instead of
 * killing the whole reading (the sensor-less grid block in particular - not
 * every installation has a Smart Power Sensor).
 */
function planReads(cfg) {
  const family = cfg && cfg.family;
  if (!FAMILIES[family]) return [];
  return [
    { start: REG.INPUT_POWER_W, count: 2 }, // 32064..32065: PV input power
    { start: REG.ACTIVE_POWER_W, count: 2 }, // 32080..32081: AC active power
    { start: REG.METER_ACTIVE_POWER_W, count: 2 }, // 37113..37114: grid meter power
    { start: REG.BATTERY_SOC_PCT_X10, count: 7 }, // 37760..37766: SoC, running status, charge/discharge power (I32 at 37765/37766)
  ];
}

// --- numeric helpers ---------------------------------------------------------

const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

// The socPlausible discipline (deye-decode/guards.SocPlausible): a SoC outside
// (0, 100] is a comms artefact, never a fact - drop the channel, don't publish.
function socPlausible(p) {
  return typeof p === 'number' && isFinite(p) && p > 0 && p <= 100;
}

// regAt - the raw u16 at absolute address `addr` out of the block list
// ([{start, regs}]), or null when no block covers it (failed/absent read).
function regAt(blocks, addr) {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (!b || !Array.isArray(b.regs)) continue;
    const start = Number(b.start);
    if (!Number.isInteger(start)) continue;
    const i = addr - start;
    if (i >= 0 && i < b.regs.length) {
      const v = b.regs[i];
      return typeof v === 'number' && isFinite(v) ? v & 0xffff : null;
    }
  }
  return null;
}

// i32At - the signed 32-bit value at addr/addr+1, ALWAYS big-endian with the
// high word first (huawei.json `fallen`: "Big-Endian, High-Word zuerst") -
// unlike KOSTAL there is no byte-order register to auto-detect.
function i32At(blocks, addr) {
  const hi = regAt(blocks, addr);
  const lo = regAt(blocks, addr + 1);
  if (hi === null || lo === null) return null;
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(hi, 0);
  buf.writeUInt16BE(lo, 2);
  return buf.readInt32BE(0);
}

/**
 * decode - turn the read blocks into the flat edge/telemetry reading.
 *
 *   blocks: [{ start, regs: [u16] }] (a failed block is simply absent)
 *   opts:   { invertGridSign?, invertBattSign? }
 *
 * Returns { reading, battKw, meta } or null when not a single channel
 * decoded. `reading` carries ONLY the channels that are genuinely present
 * (absent-not-zero discipline):
 *   - pv_power_kw from 32064 (DC-side input power - see header for why NOT 32080)
 *   - power_kw    from 37113, no plausibility gate possible without a
 *                 "sensor installed" register (none documented) - an absent
 *                 read (refused block) still drops the channel, never a
 *                 fabricated 0
 *   - soc_pct     from 37760, dropped outside (0, 100]
 * `battKw` is the measured battery power in VoltPilot convention (+ charge /
 * - discharge; field source already names this orientation, Sicherheit D -
 * `invertBattSign` is the First-Light escape hatch), null when unreadable. It
 * is returned separately like the other decoders: the flow forwards it as
 * battery_power_kw on the LOCAL bus only (the core's house balance); the
 * cloud keeps deriving battery from the power balance.
 * `meta` carries diagnostic facts for test-read / the future control gate
 * (AC active power, battery running status).
 */
function decode(blocks, opts) {
  opts = opts || {};
  const reading = {};

  const pvW = i32At(blocks, REG.INPUT_POWER_W);
  if (pvW !== null) reading.pv_power_kw = round3(pvW / 1000);

  const gridW = i32At(blocks, REG.METER_ACTIVE_POWER_W);
  if (gridW !== null) {
    const sign = opts.invertGridSign ? -1 : 1;
    reading.power_kw = round3((sign * gridW) / 1000);
  }

  const socRaw = regAt(blocks, REG.BATTERY_SOC_PCT_X10);
  const socPct = socRaw !== null ? socRaw / 10 : null;
  if (socPct !== null && socPlausible(socPct)) reading.soc_pct = round1(socPct);

  // Battery power: register 37765 is I32 W, field source documents "+ charging" -
  // already VoltPilot's own convention (+ charge / - discharge), so NO negation
  // by default; invertBattSign flips it (verify on the real device, the sign is
  // Sicherheit D - unconfirmed on a real Huawei unit).
  let battKw = null;
  const battRaw = i32At(blocks, REG.BATTERY_CHARGE_DISCHARGE_POWER_W);
  if (battRaw !== null) {
    const sign = opts.invertBattSign ? -1 : 1;
    battKw = round3((sign * battRaw) / 1000);
  }

  const meta = {
    active_power_w: i32At(blocks, REG.ACTIVE_POWER_W),
    battery_running_status: regAt(blocks, REG.BATTERY_RUNNING_STATUS),
  };

  if (Object.keys(reading).length === 0 && battKw === null) return null;
  return { reading, battKw, meta };
}

/**
 * makeHuaweiReader - deps-injected socket reader (the makeKostalReader
 * pattern): ONE ordered TCP connection per poll, the planReads blocks read
 * sequentially over it, decoded per the options. Resolves
 * { reading, battKw, meta } or null (unreachable / not a single block
 * answered). A single refused block only drops its channels.
 *
 *   deps: { net, connectTimeoutMs?, readTimeoutMs? }
 *   target: { ip, port?, unitId?, invertGridSign?, invertBattSign? }
 */
function makeHuaweiReader(deps) {
  const net = deps.net;
  const CONNECT_TIMEOUT_MS = deps.connectTimeoutMs || 8000;
  const READ_TIMEOUT_MS = deps.readTimeoutMs || 8000;

  return function readHuawei(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    const port = Number(target.port) > 0 ? Number(target.port) : DEFAULT_PORT;
    const unitId = Number.isInteger(target.unitId) && target.unitId >= 0 ? Number(target.unitId) : DEFAULT_UNIT_ID;
    if (!ip) return Promise.resolve(null);

    const plan = planReads({ family: 'huawei_sun2000_luna' });

    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      let settled = false;
      let acc = Buffer.alloc(0);
      let pending = null; // the one outstanding request { res, rej, wantTxid }
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

      const readBlock = (addr, count) => new Promise((res, rej) => {
        txid = (txid + 1) & 0xffff;
        const wantTxid = txid;
        const buf = Buffer.alloc(12);
        buf.writeUInt16BE(wantTxid, 0);
        buf.writeUInt16BE(0, 2);
        buf.writeUInt16BE(6, 4);
        buf[6] = unitId & 0xff;
        buf[7] = 0x03;
        buf.writeUInt16BE(addr & 0xffff, 8);
        buf.writeUInt16BE(count & 0xffff, 10);
        pending = { res, rej, wantTxid };
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
          if (fn !== 0x03) throw new Error('fn 0x' + fn.toString(16));
          const bc = frame[8];
          if (bc <= 0 || frame.length < 9 + bc) throw new Error('short payload');
          const regs = [];
          for (let i = 0; i < bc >> 1; i++) regs.push(frame.readUInt16BE(9 + i * 2));
          p.res(regs);
        } catch (e) {
          p.rej(e);
        }
      });

      sock.connect(port, ip, async () => {
        clearTimeout(connectTimer);
        const blocks = [];
        for (const b of plan) {
          try {
            const regs = await readBlock(b.start, b.count);
            blocks.push({ start: b.start, regs });
          } catch (e) {
            // A refused/garbled block degrades to absent channels (no Smart
            // Power Sensor installed, in particular, is expected and NOT an
            // error); the remaining blocks are still read (per-block error
            // isolation).
          }
        }
        if (!blocks.length) return done(null);
        done(decode(blocks, {
          invertGridSign: !!target.invertGridSign,
          invertBattSign: !!target.invertBattSign,
        }));
      });
    });
  };
}

module.exports = {
  REG,
  FAMILIES,
  DEFAULT_PORT,
  DEFAULT_UNIT_ID,
  planReads,
  socPlausible,
  decode,
  makeHuaweiReader,
  _helpers: { round3, round1, regAt, i32At },
};
