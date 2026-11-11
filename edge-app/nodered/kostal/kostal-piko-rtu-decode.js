'use strict';

/**
 * kostal-piko-rtu-decode - der dokumentierte AUSWEG neben der Web-API
 * (kostal-dxs-decode.js): Modbus RTU ueber die RS485-Schnittstelle des PIKO
 * (Weboberflaeche Kommunikation > RS485 > Protokoll "Modbus", offiziell
 * vorgesehen ab UI 06.30/FW 05.50 bzw. UI 06.51/FW 06.01 - Scout-Report
 * `data/vp-kostal-piko20-anbindung/report.md` Abschnitt 2.5/3.2) ueber einen
 * TRANSPARENTEN RS485-zu-Ethernet-Wandler, genau wie kaco-serial-decode.js es
 * fuer den Powador-Altgeraete-Weg tut.
 *
 * ⚠ DIE REGISTERKARTE IST COMMUNITY-BELEGT, NICHT OFFIZIELL. KOSTAL gibt die
 * Beschreibung "KOSTAL Modbus Interface - RS485" nur ueber den Service heraus
 * (Report 2.5, PV-Forum-Beitrag 125284 #2). Die hier verwendete Karte stammt
 * aus [DBUS] (thenebu/dbus-kostal-piko, README + dbus-kostal-piko.py:393-417),
 * laut dessen eigener Aussage "reverse-engineered and verified against the
 * Piko's HTTP API" an einem PIKO 17 (UI 06.53, FW 06.17), 19200 Baud, 8E1,
 * Funktion 03 (Read Holding Registers). Die Wortadresse ist die Register-
 * NUMMER minus eins (die dort gelesenen "30001-30056" entsprechen den
 * Modbus-Adressen 30000-30055 - siehe `connect/read_holding_registers` in
 * derselben Quelle).
 *
 * ⚠ GEGENPROBE IST EINGEBAUT, NICHT OPTIONAL. Weil die Registerkarte nur
 * community-belegt ist, vergleicht der Verbindungstest dieses Wegs die
 * RTU-AC-Leistung MIT der Web-API `kostal-dxs-decode.js`, wenn beide erreichbar
 * sind (dieselbe physische Box, zwei unabhaengige Schnittstellen - Report
 * Abschnitt "Was der Weg vor Ort verlangt"). Die Gegenprobe wohnt im
 * Node-RED-Funktionsknoten (build-flows.js), nicht hier: dieses Modul bleibt
 * abhaengigkeitsfrei und kennt nur Register -> Werte.
 *
 * KEIN Status-, KEIN Begrenzungs-Register in dieser Karte (anders als die
 * Web-API) - die Community-Quelle dokumentiert keines; ein geratenes Register
 * waere falsch, kein fehlendes Feld (Report Abschnitt 3.2 listet keine).
 *
 * Batterie (PIKO BA) und Altgeraete vor UI 06: NICHT angebunden, dieselbe
 * Begruendung wie in kostal-dxs-decode.js.
 *
 * Dieses Modul ist vollstaendig abhaengigkeitsfrei (kein `require`) wie jeder
 * andere Decoder hier (kaco-http.js, kostal-dxs-decode.js): ein Node-RED-Flow
 * ist selbstenthaltendes JSON und kann keine Repo-Datei `require`n
 * (build-flows.js embedModule() fuegt nur DIESE Datei woertlich ein - ein
 * `require('../deye/solarman-v5.js')` darin waere zur Laufzeit im Flow ein
 * `ReferenceError: require is not defined`).
 *
 * Die Modbus-RTU-Rahmenbildung (CRC16, Anfrage/Antwort fuer Funktion 03) ist
 * deshalb ABSICHTLICH eine EIGENE Kopie derselben Funktionen aus
 * `../deye/solarman-v5.js` (reines Modbus-RTU, keine Deye-Eigenschaft - siehe
 * dessen eigene Kopfzeile) statt eines Imports. Der Go-Zwilling hat dieses
 * Problem nicht (Go `import` loest zur Compile-Zeit auf, kein Embedding) und
 * nutzt dort `solarmanv5.ReadHoldingRequest`/`ParseReadResponse` direkt.
 */

/** modbusCrc16 - standard Modbus/RTU CRC16 (init 0xFFFF, poly 0xA001). Kopie von ../deye/solarman-v5.js (siehe Modulkopf, warum keine Abhaengigkeit). */
function modbusCrc16(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

/** readHoldingRegistersRequest - Modbus-RTU "read holding registers" (FC03). Kopie von ../deye/solarman-v5.js. */
function readHoldingRegistersRequest(slaveId, startReg, count) {
  const body = Buffer.alloc(6);
  body[0] = slaveId & 0xff;
  body[1] = 0x03;
  body.writeUInt16BE(startReg & 0xffff, 2);
  body.writeUInt16BE(count & 0xffff, 4);
  const crc = modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

/** parseModbusResponse - validiert eine FC03-Antwort und liefert die Register-Worte. Kopie von ../deye/solarman-v5.js. */
function parseModbusResponse(mb) {
  if (!Buffer.isBuffer(mb)) mb = Buffer.from(mb);
  if (mb.length < 5) throw new Error('Modbus-Antwort zu kurz');
  const body = mb.subarray(0, mb.length - 2);
  const crcGot = mb.readUInt16LE(mb.length - 2);
  const crcCalc = modbusCrc16(body);
  if (crcGot !== crcCalc) throw new Error('Modbus-CRC falsch');
  const fn = mb[1];
  if (fn & 0x80) throw new Error('Modbus-Ausnahme 0x' + mb[2].toString(16).padStart(2, '0'));
  if (fn !== 0x03) throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  const byteCount = mb[2];
  if (byteCount <= 0 || body.length < 3 + byteCount) throw new Error('Modbus-Nutzlast unvollstaendig');
  const regs = [];
  for (let i = 0; i < byteCount >> 1; i++) regs.push(mb.readUInt16BE(3 + i * 2));
  return regs;
}

// --- Verbindung --------------------------------------------------------------

/** 19200 Baud, 8E1 (Report 2.5/3.2, [DBUS] Bildschirmfoto). Informativ - kein Codepfad hier. */
const SERIAL_PARAMS = { baud: 19200, dataBits: 8, parity: 'even', stopBits: 1 };

/** Uebliche TCP-Server-Port eines transparenten RS485-Wandlers (wie kaco-serial-decode.js DEFAULT_PORT - dieselbe Geraeteklasse). */
const DEFAULT_PORT = 8899;

/** Modbus-Geraeteadresse: keine belegte KOSTAL-Werksvorgabe gefunden (Report); [DBUS] zeigt Adresse 3 als Feldbeispiel, nicht als Norm. 1 ist der neutrale Vorschlagswert. */
const DEFAULT_UNIT_ID = 1;
const MIN_UNIT_ID = 1;
const MAX_UNIT_ID = 247;

// --- Registerkarte (Report 3.2, Adresse = Registernummer - 1) ----------------

const REG = {
  DC1_V: 30000, DC1_A: 30001, DC1_W: 30002, // Register 30001-30003
  DC2_V: 30005, DC2_A: 30006, DC2_W: 30007, // Register 30006-30008
  DC3_V: 30010, DC3_A: 30011, DC3_W: 30012, // Register 30011-30013
  L1_V: 30015, L1_A: 30016, L1_W: 30017,    // Register 30016-30018
  L2_V: 30019, L2_A: 30020, L2_W: 30021,    // Register 30020-30022
  L3_V: 30023, L3_A: 30024, L3_W: 30025,    // Register 30024-30026
  DC_TOTAL_W: 30028,   // Register 30029
  AC_TOTAL_W: 30030,   // Register 30031 - der Vorgabe-Kanal (wie dxs 67109120)
  COS_PHI: 30032,      // Register 30033, ÷100
  FREQUENCY: 30033,    // Register 30034, ÷10 Hz
  RATED_W: 30043,      // Register 30044
  ENERGY_TOTAL_HI: 30050, ENERGY_TOTAL_LO: 30051, // Register 30051-30052, 32-Bit, hohes Wort zuerst
  OPERATING_HOURS: 30053, // Register 30054
  ENERGY_TODAY_WH: 30055, // Register 30056
  NAME_START: 30070, NAME_COUNT: 13,     // Register 30071-30083, ASCII
  SERIAL_START: 30083, SERIAL_COUNT: 13, // Register 30084-30096, ASCII
};

/** Der SCHNELLE Takt liest NUR die AC-Gesamtleistung - ein Register, dieselbe Minimalitaet wie der Web-API-Weg (kostal-dxs-decode.js FAST_IDS). */
const FAST_BLOCK = { start: REG.AC_TOTAL_W, count: 1 };

/** Der Verbindungstest liest die volle Karte in 4 Bloecken (DC/AC/Frequenz zusammenhaengend, dann Nennleistung, Energie/Stunden, Name/Seriennummer). */
const TEST_BLOCKS = [
  { start: REG.DC1_V, count: REG.FREQUENCY - REG.DC1_V + 1 }, // 30000..30033 (34 Register)
  { start: REG.RATED_W, count: 1 },
  { start: REG.ENERGY_TOTAL_HI, count: REG.ENERGY_TODAY_WH - REG.ENERGY_TOTAL_HI + 1 }, // 30050..30055 (6 Register)
  { start: REG.NAME_START, count: REG.NAME_COUNT + REG.SERIAL_COUNT }, // 30070..30095 (26 Register)
];

/**
 * Eine Familie: dieselbe dreiphasige, batterielose PIKO-10-20-Baureihe wie der
 * Web-API-Weg - ein zweiter Lesekanal desselben Geraets, kein eigenes Modell.
 */
const FAMILIES = {
  kostal_piko_rtu: {
    label: 'KOSTAL PIKO (Modbus RTU, Community-Registerkarte)',
    hasBattery: false,
    pvSource: 'ac',
  },
};

// --- Register -> Werte --------------------------------------------------------

/**
 * blockLookup - baut aus einem gelesenen Registerblock (`{start, regs}`) eine
 * `address -> word`-Funktion. Mehrere Bloecke werden der Reihe nach
 * durchsucht; eine Adresse ausserhalb jedes Blocks liefert `undefined` - nie
 * eine erfundene 0.
 */
function wordAt(blocks, address) {
  for (const b of blocks || []) {
    if (!b || !Array.isArray(b.regs)) continue;
    const i = address - b.start;
    if (i >= 0 && i < b.regs.length) return b.regs[i];
  }
  return undefined;
}

function asciiBlock(blocks, start, count) {
  const chars = [];
  for (let i = 0; i < count; i++) {
    const w = wordAt(blocks, start + i);
    if (typeof w !== 'number') return undefined;
    chars.push((w >> 8) & 0xff, w & 0xff);
  }
  // Kein Kontrollzeichen 0x00: wie ein C-String, danach schneidet trim() ab.
  const nul = chars.indexOf(0);
  const bytes = nul >= 0 ? chars.slice(0, nul) : chars;
  return Buffer.from(bytes).toString('ascii').trim();
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * decode - der SCHNELLE Takt (`FAST_BLOCK`) in die VoltPilot-Busform: nur
 * `pv_power_kw` aus Register 30031, dieselbe Minimalitaet wie beim Web-API-Weg
 * (`kostal-dxs-decode.js` `decode`). `blocks` ist eine Liste gelesener
 * `{start, regs}` (ein einziger Block fuer den schnellen Takt reicht).
 */
function decode(blocks) {
  const acW = wordAt(blocks, REG.AC_TOTAL_W);
  if (typeof acW !== 'number') return null;
  return { reading: { pv_power_kw: round3(Math.max(0, acW) / 1000) } };
}

/**
 * decodeVerbose - die volle Diagnose aus den `TEST_BLOCKS` fuer den
 * Verbindungstest - dieselbe Form wie `kostal-dxs-decode.js` `decodeVerbose`,
 * damit die Gegenprobe (build-flows.js) beide Seiten Feld fuer Feld
 * vergleichen kann. Kein `statusCode`/`statusText`/`limitationPct` - diese
 * Karte hat dafuer kein Register (siehe Modulkopf).
 */
function decodeVerbose(blocks) {
  const acW = wordAt(blocks, REG.AC_TOTAL_W);
  const dcW = wordAt(blocks, REG.DC_TOTAL_W);
  const hi = wordAt(blocks, REG.ENERGY_TOTAL_HI);
  const lo = wordAt(blocks, REG.ENERGY_TOTAL_LO);
  const daily = wordAt(blocks, REG.ENERGY_TODAY_WH);
  const str = (vA, aA, wA) => ({ vV: typeof wordAt(blocks, vA) === 'number' ? round3(wordAt(blocks, vA) / 10) : undefined,
    aA: typeof wordAt(blocks, aA) === 'number' ? round3(wordAt(blocks, aA) / 100) : undefined,
    pW: wordAt(blocks, wA) });
  const freqReg = wordAt(blocks, REG.FREQUENCY);
  const cosReg = wordAt(blocks, REG.COS_PHI);
  return {
    pvPowerKw: typeof acW === 'number' ? round3(Math.max(0, acW) / 1000) : undefined,
    acKw: typeof acW === 'number' ? round3(acW / 1000) : undefined,
    dcKw: typeof dcW === 'number' ? round3(dcW / 1000) : undefined,
    strings: [str(REG.DC1_V, REG.DC1_A, REG.DC1_W), str(REG.DC2_V, REG.DC2_A, REG.DC2_W), str(REG.DC3_V, REG.DC3_A, REG.DC3_W)],
    phases: [str(REG.L1_V, REG.L1_A, REG.L1_W), str(REG.L2_V, REG.L2_A, REG.L2_W), str(REG.L3_V, REG.L3_A, REG.L3_W)],
    frequencyHz: typeof freqReg === 'number' ? round3(freqReg / 10) : undefined,
    cosPhi: typeof cosReg === 'number' ? round3(cosReg / 100) : undefined,
    ratedW: wordAt(blocks, REG.RATED_W),
    energyTotalKwh: typeof hi === 'number' && typeof lo === 'number' ? round3(((hi << 16) | lo) / 1000) : undefined,
    energyTodayKwh: typeof daily === 'number' ? round3(daily / 1000) : undefined,
    operatingHours: wordAt(blocks, REG.OPERATING_HOURS),
    name: asciiBlock(blocks, REG.NAME_START, REG.NAME_COUNT),
    serial: asciiBlock(blocks, REG.SERIAL_START, REG.SERIAL_COUNT),
  };
}

/**
 * makeKostalRtuReader - der TCP-Teil: EIN Lesezyklus gegen den
 * RS485-zu-Ethernet-Wandler, eine ODER mehrere FC03-Anfragen ueber EINE
 * Verbindung (sequenziell, wie der Deye-Solarman-Leser seine Register-
 * Bloecke abarbeitet).
 *
 * Deps: `{ net, timeoutMs? }` - `net` ist Node's `net`-Modul (injiziert,
 * damit dieses Modul ohne echten Socket testbar bleibt). Target:
 * `{ ip, port, unitId, blocks? }` - `blocks` (eine Liste von `{start,
 * count}`) fehlt bei jedem regelmaessigen Takt (Vorgabe `[FAST_BLOCK]`); der
 * Verbindungstest ruft explizit mit `blocks: TEST_BLOCKS` auf.
 *
 * Zurueck: `Promise<{blocks: [{start, regs}]} | null>` - ein
 * Verbindungsfehler, ein Timeout oder eine kaputte/Exception-Antwort liefern
 * `null` (nie einen Wurf), dieselbe idle-sichere Form wie
 * `makeKacoSerialReader`.
 */
function makeKostalRtuReader(deps) {
  const net = deps.net;
  const TIMEOUT_MS = deps.timeoutMs || 4000;

  return function readKostalRtu(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    const port = Number(target.port) > 0 ? Number(target.port) : DEFAULT_PORT;
    const unitId = Number.isInteger(target.unitId) ? target.unitId : DEFAULT_UNIT_ID;
    const specs = Array.isArray(target.blocks) && target.blocks.length ? target.blocks : [FAST_BLOCK];
    if (!ip || unitId < MIN_UNIT_ID || unitId > MAX_UNIT_ID) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const sock = new net.Socket();
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch (e) { /* ignore */ }
        resolve(value);
      };
      sock.setTimeout(TIMEOUT_MS, () => finish(null));
      sock.on('error', () => finish(null));
      sock.on('close', () => finish(null));

      const blocks = [];
      let idx = 0;
      let acc = Buffer.alloc(0);
      const sendNext = () => {
        acc = Buffer.alloc(0);
        sock.write(readHoldingRegistersRequest(unitId, specs[idx].start, specs[idx].count));
      };
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        const spec = specs[idx];
        const want = 5 + 2 * spec.count;
        // A Modbus exception reply is exactly 5 bytes - complete on its own,
        // shorter than `want` for any block with more than one register.
        if (acc.length < 5 || (acc.length < want && !(acc[1] & 0x80))) return;
        let regs;
        try {
          regs = parseModbusResponse(acc);
        } catch (e) {
          return finish(null);
        }
        blocks.push({ start: spec.start, regs });
        idx += 1;
        if (idx < specs.length) { sendNext(); return; }
        finish({ blocks });
      });

      sock.connect(port, ip, () => { sendNext(); });
    });
  };
}

module.exports = {
  REG,
  SERIAL_PARAMS,
  DEFAULT_PORT,
  DEFAULT_UNIT_ID,
  MIN_UNIT_ID,
  MAX_UNIT_ID,
  FAMILIES,
  FAST_BLOCK,
  TEST_BLOCKS,
  wordAt,
  decode,
  decodeVerbose,
  makeKostalRtuReader,
  // Modbus-RTU-Rahmenbildung (eigene Kopie, siehe Modulkopf, warum kein require()).
  readHoldingRegistersRequest,
  parseModbusResponse,
  modbusCrc16,
};
