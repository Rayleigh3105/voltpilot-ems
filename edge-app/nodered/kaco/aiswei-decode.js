'use strict';

/**
 * aiswei-decode - the canonical, unit-tested read path for KACO's hybrid
 * **blueplanet NH3** over the AISWEI-NATIVE Modbus register map on the
 * inverter's OWN Ethernet port (TCP 502, Unit-ID 1). Source of the map:
 * AISWEI `MB001_ASW GEN-Modbus-en V2.1.x` (the OEM's own document; KACO's
 * "SunSpec Information Model Reference NX3" carries the same AISWEI document
 * code), corroborated by evcc's productive `solplanet-modbus` template, which
 * names "KACO Blueplanet Hybrid NH3, Port eth 5&6" explicitly. Scout report:
 * firstmate `data/vp-kaco-palette-y6` §2.1/§3.2.
 *
 * ⚠ WARUM ES DIESEN WEG NEBEN HTTP 8484 GIBT: der HTTP-Weg ist der Vorgabe-Weg
 * (er laeuft parallel zur KACO-Cloud). Dieser hier ist der EXPERTEN-Ausweg fuer
 * einen NH3, dessen Kommunikationseinheit die 8484-API nicht bedient - und er
 * geht ueber den EIGENEN LAN-Port des Wechselrichters, nicht ueber den Stick,
 * kostet also ebenfalls KEINE Cloud-Anbindung.
 *
 * ⚠ DIE ADRESS-KONVENTION IST DIE MODICON-SCHREIBWEISE der AISWEI-Doku und die
 * einzige Stelle, an der wir rechnen muessen:
 *
 *      3xxxx  = INPUT-Register   (FC4), Draht-Adresse = Doku-Nummer - 30001
 *      4xxxx  = HOLDING-Register (FC3), Draht-Adresse = Doku-Nummer - 40001
 *
 * Sie ist DOKUMENTIERT, aber von uns an keinem Geraet nachgemessen. Liest ein
 * NH3 hierueber Unsinn, ist das der erste Verdacht (KACO.md §9).
 *
 * NUR LESEN. Der dokumentierte Batterie-SCHREIBWEG (41104 Betriebsmodus + 41153
 * Sollwert) ist bewusst NICHT hier - er gehoert dem gesperrten Steuer-Pfad.
 *
 * Der Flow-Funktionsknoten traegt eine KOPIE dieses Moduls (ein Node-RED-Flow
 * ist selbstenthaltendes JSON); `flows-sync.test.js` nagelt sie fest.
 */

// --- Adress-Basen der Modicon-Schreibweise -----------------------------------
const INPUT_BASE = 30001;
const HOLDING_BASE = 40001;

/** Doku-Nummer -> Draht-Adresse eines Input-Registers (FC4). */
const inputAddr = (doc) => doc - INPUT_BASE;
/** Doku-Nummer -> Draht-Adresse eines Holding-Registers (FC3). */
const holdingAddr = (doc) => doc - HOLDING_BASE;

// --- Registerkarte (Doku-Nummern; AISWEI MB001 §3.3) -------------------------
const REG = {
  DEVICE_TYPE: 31001, // U16: 1 = 1-phasig, 3 = 3-phasig
  MODBUS_ADDRESS: 31002, // U16: Vorgabe 3
  SERIAL: 31003, // 16 Register ASCII
  RATED_POWER: 31028, // U16: Nennleistung
  PV_TOTAL_W: 31601, // U32: PV-Gesamtleistung (DC) in W
  E_TODAY: 31603, // U32: 0,1 kWh
  E_TOTAL: 31605, // U32: 0,1 kWh
  BATTERY_COMM: 31607, // U16
  BATTERY_STATE: 31608, // U16
  BATTERY_V: 31617, // U16
  BATTERY_A: 31618, // S16
  BATTERY_POWER_W: 31619, // S32: - laden / + entladen (siehe decode)
  SOC: 31622, // U16 x 0,01 %
  SOH: 31623, // U16
  CHARGE_LIMIT_A: 31624, // U16
  DISCHARGE_LIMIT_A: 31625, // U16
  GRID_TOTAL_W: 46434, // S32 (Holding): Gesamtleistung am Netzanschluss
};

const SOC_SCALE = 0.01;
const ENERGY_SCALE = 0.1; // 0,1 kWh

const DEFAULT_PORT = 502;
const DEFAULT_UNIT_ID = 1;

// --- Familien ----------------------------------------------------------------
const FAMILIES = {
  kaco_nh3: {
    label: 'KACO hybrid NH3 (AISWEI-Registerkarte)',
    hasBattery: true,
  },
};

/**
 * planReads - die Leseblocke EINES Poll-Zyklus. Fest je Familie (kein
 * Discovery-Walk - die Karte IST die Doku). Jeder Block liegt weit unter der
 * 125-Register-Grenze und wird EINZELN gelesen: faellt einer aus, fehlen genau
 * seine Kanaele, statt die ganze Messung zu killen.
 *
 * ⚠ Die Blocke tragen ihren FUNKTIONSCODE mit, weil diese Karte BEIDE Arten
 * mischt (Messwerte = Input/FC4, die Netzleistung des Smart Meters =
 * Holding/FC3). Ein Aufrufer, der den fc ignoriert, liest die falsche Tabelle.
 */
function planReads(cfg) {
  const family = cfg && cfg.family;
  if (!FAMILIES[family]) return [];
  return [
    // 31001..31028: Geraetetyp, Modbus-Adresse, Seriennummer, Nennleistung.
    { fc: 4, start: inputAddr(REG.DEVICE_TYPE), count: 28 },
    // 31601..31625: PV, Energie, Batterie (V/A/W), SoC, SoH, Stromgrenzen.
    { fc: 4, start: inputAddr(REG.PV_TOTAL_W), count: 25 },
    // 46434: Netzleistung des Smart Meters (S32).
    { fc: 3, start: holdingAddr(REG.GRID_TOTAL_W), count: 2 },
  ];
}

// --- numerische Helfer -------------------------------------------------------

const s16 = (v) => {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
};
const s32 = (v) => {
  v = v >>> 0;
  return v > 0x7fffffff ? v - 0x100000000 : v;
};
const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

/** Die socPlausible-Regel des Hauses (deye-decode / guards.SocPlausible). */
function socPlausible(p) {
  return typeof p === 'number' && isFinite(p) && p > 0 && p <= 100;
}

/**
 * regAt - das rohe u16 an der DRAHT-Adresse `addr` aus der Blockliste
 * `[{fc, start, regs}]`, oder null, wenn kein Block sie deckt (Block nicht
 * gelesen). `fc` waehlt die Tabelle: Input und Holding haben getrennte
 * Adressraeume, dieselbe Zahl meint dort VERSCHIEDENE Register.
 */
function regAt(blocks, fc, addr) {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (!b || !Array.isArray(b.regs)) continue;
    if (Number(b.fc) !== fc) continue;
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

/**
 * u32At / s32At - zwei Register als 32-Bit-Wert, **hohes Wort zuerst** (ABCD).
 * Das ist die Modbus-uebliche Reihenfolge und die, die evcc fuer diese Karte
 * benutzt; ein vertauschtes Wort faellt als absurd grosse Zahl auf, nie als
 * plausibler falscher Wert. AM GERAET ZU PRUEFEN.
 */
function u32At(blocks, fc, addr) {
  const hi = regAt(blocks, fc, addr);
  const lo = regAt(blocks, fc, addr + 1);
  if (hi === null || lo === null) return null;
  return hi * 0x10000 + lo;
}
function s32At(blocks, fc, addr) {
  const v = u32At(blocks, fc, addr);
  return v === null ? null : s32(v);
}

/**
 * decode - die Leseblocke zu EINER flachen edge/telemetry-Messung.
 *
 *   blocks: [{ fc, start, regs: [u16] }] (ein gescheiterter Block fehlt einfach)
 *   opts:   { invertGridSign?, invertBattSign? }
 *
 * Zurueck: { reading, battKw, meta } oder null, wenn nicht ein einziger Kanal
 * decodiert werden konnte. `reading` traegt NUR die wirklich vorhandenen
 * Kanaele (abwesend-statt-null):
 *   - pv_power_kw  aus 31601 (DC-Gesamtleistung - beim Hybriden die EINZIGE
 *                  ehrliche PV-Quelle; die AC-Leistung waere PV + Entladung)
 *   - power_kw     aus 46434 (Smart Meter), nur wenn der Block gelesen wurde
 *   - soc_pct      aus 31622, verworfen ausserhalb (0, 100]
 *
 * ⚠ VORZEICHEN DER BATTERIE, AM GERAET ZU PRUEFEN: die AISWEI-Karte
 * dokumentiert fuer den SCHREIB-Sollwert 41153 „- laden / + entladen". Wir
 * uebernehmen die Konvention fuer den GELESENEN Wert 31619 und NEGIEREN, weil
 * VoltPilot `battery_power_kw` als + Ladung / - Entladung fuehrt.
 * `invert_batt_sign` ist der Ausweg; der First-Light-Schritt beweist es.
 */
function decode(blocks, opts) {
  opts = opts || {};
  const reading = {};
  const meta = {};

  const pv = u32At(blocks, 4, inputAddr(REG.PV_TOTAL_W));
  if (pv !== null) reading.pv_power_kw = round3(pv / 1000);

  const grid = s32At(blocks, 3, holdingAddr(REG.GRID_TOTAL_W));
  if (grid !== null) {
    const sign = opts.invertGridSign ? -1 : 1;
    reading.power_kw = round3(sign * grid / 1000);
  }

  const socRaw = regAt(blocks, 4, inputAddr(REG.SOC));
  if (socRaw !== null) {
    const soc = socRaw * SOC_SCALE;
    if (socPlausible(soc)) reading.soc_pct = round1(soc);
  }

  let battKw = null;
  const pb = s32At(blocks, 4, inputAddr(REG.BATTERY_POWER_W));
  if (pb !== null) {
    const sign = opts.invertBattSign ? 1 : -1; // Vorgabe: negieren (siehe oben)
    battKw = round3(sign * pb / 1000);
  }

  const devType = regAt(blocks, 4, inputAddr(REG.DEVICE_TYPE));
  if (devType !== null) meta.device_type = devType;
  const mbAddr = regAt(blocks, 4, inputAddr(REG.MODBUS_ADDRESS));
  if (mbAddr !== null) meta.modbus_address = mbAddr;
  const rated = regAt(blocks, 4, inputAddr(REG.RATED_POWER));
  if (rated !== null) meta.rated_power = rated;
  const vb = regAt(blocks, 4, inputAddr(REG.BATTERY_V));
  if (vb !== null) meta.battery_v = vb;
  const ab = regAt(blocks, 4, inputAddr(REG.BATTERY_A));
  if (ab !== null) meta.battery_a = s16(ab);
  const soh = regAt(blocks, 4, inputAddr(REG.SOH));
  if (soh !== null) meta.soh_pct = soh;
  const bstate = regAt(blocks, 4, inputAddr(REG.BATTERY_STATE));
  if (bstate !== null) meta.battery_state = bstate;
  const eTotal = u32At(blocks, 4, inputAddr(REG.E_TOTAL));
  if (eTotal !== null) meta.energy_total_kwh = round1(eTotal * ENERGY_SCALE);

  if (Object.keys(reading).length === 0 && battKw === null) return null;
  return { reading, battKw, meta };
}

/**
 * makeAisweiReader - der Socket-Teil: EIN Modbus-TCP-Lauf ueber den Leseplan.
 *
 * Deps: { net, connectTimeoutMs?, readTimeoutMs? }
 * Target: { ip, port?, unitId?, invertGridSign?, invertBattSign? }
 *
 * Zurueck: Promise<{reading, battKw, meta} | null>. Idle-sicher: jeder Fehler
 * endet in `null`, nie in einem Wurf.
 *
 * ⚠ JEDER BLOCK TRAEGT SEINEN FUNKTIONSCODE (FC4 = Input, FC3 = Holding). Ein
 * Leser, der pauschal FC3 sendet, liest die falsche Tabelle und bekommt
 * plausibel aussehenden Unsinn - deshalb steht der fc im Plan und wird hier
 * gesendet UND in der Antwort geprueft.
 *
 * Ein einzelner abgewiesener Block laesst NUR seine Kanaele fehlen
 * (Fehler-Isolation je Block), die uebrigen werden weiter gelesen.
 */
function makeAisweiReader(deps) {
  const net = deps.net;
  const CONNECT_TIMEOUT_MS = deps.connectTimeoutMs || 8000;
  const READ_TIMEOUT_MS = deps.readTimeoutMs || 8000;

  return function readAiswei(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    const port = Number(target.port) > 0 ? Number(target.port) : DEFAULT_PORT;
    const unitId = Number(target.unitId) > 0 ? Number(target.unitId) : DEFAULT_UNIT_ID;
    if (!ip) return Promise.resolve(null);

    const plan = planReads({ family: 'kaco_nh3' });

    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      let settled = false;
      let acc = Buffer.alloc(0);
      let pending = null;
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

      const readBlock = (fc, addr, count) => new Promise((res, rej) => {
        txid = (txid + 1) & 0xffff;
        const wantTxid = txid;
        const buf = Buffer.alloc(12);
        buf.writeUInt16BE(wantTxid, 0);
        buf.writeUInt16BE(0, 2);
        buf.writeUInt16BE(6, 4);
        buf[6] = unitId & 0xff;
        buf[7] = fc & 0xff;
        buf.writeUInt16BE(addr & 0xffff, 8);
        buf.writeUInt16BE(count & 0xffff, 10);
        pending = { res, rej, wantTxid, fc };
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
          if (fn !== p.fc) throw new Error('fn 0x' + fn.toString(16));
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
            const regs = await readBlock(b.fc, b.start, b.count);
            blocks.push({ fc: b.fc, start: b.start, regs });
          } catch (e) {
            // Fehler-Isolation je Block (siehe Kopf).
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
  INPUT_BASE,
  HOLDING_BASE,
  DEFAULT_PORT,
  DEFAULT_UNIT_ID,
  SOC_SCALE,
  inputAddr,
  holdingAddr,
  planReads,
  socPlausible,
  decode,
  makeAisweiReader,
  _helpers: { s16, s32, round3, round1, regAt, u32At, s32At },
};
